// One embedded `claude` terminal bound to a PTY keyed by `tabId`.
//
// The Rust engine (src-tauri/src/pty.rs) spawns the real `claude` CLI in a PTY
// — the only ToS-compliant way to use the user's OAuth subscription — and
// streams its output as `pty-output-<tabId>` events. This module wires that to
// an xterm.js terminal. It is framework-free and owns NO layout/visibility
// state: the manager (owned-terminals.ts) decides which terminals are shown and
// calls fit()/focus()/dispose() on the returned handle.
//
// Ported from the `wip/workspace-tabbed-terminal` branch's `workspace.ts`
// `createTerminal` seam, with the workspace-global collapse/active state replaced
// by a generic "is this mount actually laid out?" guard.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

const win = getCurrentWebviewWindow();

/** Debounce for the resize → fit → SIGWINCH chain. */
const RESIZE_DEBOUNCE_MS = 150;

/** A warm dark inset terminal sitting in the paper chrome — claude's ANSI output
 *  reads best on a dark background, so the terminal is a "sunken" panel rather
 *  than paper-white. Cursor picks up the clay accent. */
const TERMINAL_THEME = {
  background: "#1d1b19",
  foreground: "#e9e4da",
  cursor: "#cc785c",
  cursorAccent: "#1d1b19",
  selectionBackground: "rgba(204, 120, 92, 0.30)",
};

/** Handle the manager uses to drive one terminal. */
export interface TerminalHandle {
  readonly tabId: string;
  focus(): void;
  fit(): void;
  dispose(): void;
}

export interface CreateTerminalOptions {
  /** Directory to spawn `claude` in (a unit's project dir). Defaults to HOME. */
  cwd?: string;
  /** Full session id to rejoin via `claude --resume <id>` (reopening a closed
   *  Board session). Omit for a fresh session. */
  resume?: string;
  /** Called when the PTY exits (the child died or was killed). */
  onExit?: () => void;
  /** Called when output arrives while the terminal is hidden — for an activity
   *  pulse on a collapsed/background panel. */
  onActivity?: () => void;
}

/** True when the element is actually laid out (visible, non-zero box). xterm's
 *  `fit()` against a 0×0 element reflows `claude` to ~5 cols, so we must never
 *  fit while hidden — this replaces the old workspace `railCollapsed` guard. */
function isLaidOut(el: HTMLElement): boolean {
  return el.offsetParent !== null && el.clientWidth > 0 && el.clientHeight > 0;
}

export async function createTerminal(
  tabId: string,
  mount: HTMLElement,
  opts: CreateTerminalOptions = {},
): Promise<TerminalHandle> {
  const term = new Terminal({
    fontFamily: '"SF Mono", ui-monospace, "Menlo", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    theme: TERMINAL_THEME,
    allowProposedApi: true,
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(mount);

  // GPU renderer. The default DOM renderer repaints terminal rows as DOM nodes
  // on every write/keystroke — on the translucent overlay window that compositing
  // is heavy enough to starve input during `claude`'s boot output storm. WebGL
  // offloads to the GPU and fixes the dropped-keystroke stutter. Loaded lazily on
  // first real layout: acquiring a WebGL context against a hidden 0×0 mount can
  // come up degraded, so we wait until the terminal is actually shown. A context
  // loss disposes the addon and xterm silently falls back to the DOM renderer.
  let webglTried = false;
  const ensureWebgl = () => {
    if (webglTried || !isLaidOut(mount)) return;
    webglTried = true;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // No GPU context available; stay on the DOM renderer.
    }
  };

  const fit = () => {
    if (!isLaidOut(mount)) return; // never fit a hidden / zero-size terminal
    ensureWebgl();
    try {
      fitAddon.fit();
    } catch {
      // Not laid out yet; a later fit catches it.
    }
  };

  // PTY → terminal. `app.emit` broadcasts to every window, so the per-tab event
  // name is what keeps one session's output out of another's.
  const unlistenOutput = await win.listen<string>(`pty-output-${tabId}`, (e) => {
    term.write(e.payload);
    if (!isLaidOut(mount)) opts.onActivity?.();
  });
  const unlistenExit = await win.listen<string>(`pty-exit-${tabId}`, () => {
    // The PTY only reaches EOF when the whole shell session ends — Ctrl-C'ing out
    // of `claude` drops into a live shell (see pty.rs), it doesn't end the PTY.
    term.write("\r\n\x1b[2m— session ended —\x1b[0m\r\n");
    opts.onExit?.();
  });

  // terminal → PTY (raw keystrokes).
  term.onData((data) => {
    void invoke("write_pty", { tabId, data }).catch(() => {});
  });

  // File drag-drop: Tauri v2 emits dropped file paths via a window-level event
  // (File.prototype.path from v1 is gone). Only respond when this terminal's
  // mount is actually visible — prevents background terminals from stealing drops.
  // Suppress the browser's default "navigate to file" behaviour over the canvas.
  mount.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); }, { capture: true, passive: false });
  const unlistenDrop = await win.onDragDropEvent((e) => {
    if (e.payload.type !== "drop") return;
    if (!isLaidOut(mount)) return;
    const paths: string[] = e.payload.paths;
    if (!paths.length) return;
    const data = paths.map((p) => JSON.stringify(p)).join(" ");
    void invoke("write_pty", { tabId, data }).catch(() => {});
    term.focus();
  });

  // resize → fit → SIGWINCH, debounced. ResizeObserver also catches layout
  // changes (show/hide, the panel expanding), not just window resizes. Frozen
  // while hidden: never fit/SIGWINCH against a 0-box.
  let resizeTimer = 0;
  const onResize = () => {
    if (!isLaidOut(mount)) return;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      fit();
      void invoke("resize_pty", { tabId, rows: term.rows, cols: term.cols }).catch(() => {});
    }, RESIZE_DEBOUNCE_MS);
  };
  const ro = new ResizeObserver(onResize);
  ro.observe(mount);

  // Spawn the PTY. If the mount is already visible, fit first and spawn at the
  // real geometry; otherwise spawn at xterm's default 80×24 (which the grid also
  // uses, so the two agree) and let the first post-show fit() reflow it.
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  let rows = 24;
  let cols = 80;
  if (isLaidOut(mount)) {
    fit();
    rows = term.rows;
    cols = term.cols;
  }
  try {
    await invoke("spawn_pty", { tabId, rows, cols, cwd: opts.cwd ?? null, resume: opts.resume ?? null });
  } catch (e) {
    term.write(`\r\n\x1b[31m${String(e)}\x1b[0m\r\n`);
  }

  return {
    tabId,
    focus: () => term.focus(),
    fit,
    dispose: () => {
      ro.disconnect();
      clearTimeout(resizeTimer);
      unlistenOutput();
      unlistenExit();
      unlistenDrop();
      void invoke("close_pty", { tabId }).catch(() => {});
      term.dispose();
    },
  };
}
