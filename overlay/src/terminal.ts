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
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { getCodexApproval } from "./prefs";
import { IS_MAC } from "./platform";

const win = getCurrentWebviewWindow();

/** Debounce for the resize → fit → SIGWINCH chain. */
const RESIZE_DEBOUNCE_MS = 150;

/** How long a *hidden* terminal pools PTY output before writing it to xterm.
 *  Nobody is watching it, so the only thing this cadence owes anyone is that the
 *  bytes are all there, in order, by the time the terminal is shown. A visible
 *  terminal flushes every frame instead. */
const HIDDEN_FLUSH_MS = 500;

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
  /** Which agent CLI to embed: "claude" (default) or "codex". A resume must carry
   *  the session's own provider — the id only exists in that CLI's transcripts. */
  agent?: string;
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

  // Copy / paste. Every other keystroke goes straight to the PTY (term.onData),
  // so a bare Ctrl-C is SIGINT — not copy — and there is otherwise NO way to get
  // text out of the terminal. Wire the platform's clipboard chords explicitly
  // through Tauri's clipboard (the overlay's WebKitGTK webview can't be trusted
  // to expose navigator.clipboard from this context): ⌘C/⌘V on macOS,
  // Ctrl+Shift+C / Ctrl+Shift+V elsewhere — the standard terminal convention that
  // deliberately leaves bare Ctrl-C free for SIGINT. Handling the chord (even with
  // no selection) also stops the modified key from leaking to the PTY as a stray
  // sequence. `term.paste` respects bracketed-paste mode, unlike a raw write.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const chord = IS_MAC ? e.metaKey && !e.shiftKey : e.ctrlKey && e.shiftKey;
    if (!chord) return true;
    if (e.code === "KeyC") {
      const sel = term.getSelection();
      if (sel) void writeText(sel).catch(() => {});
      e.preventDefault();
      return false;
    }
    if (e.code === "KeyV") {
      void readText().then((t) => { if (t) term.paste(t); }).catch(() => {});
      e.preventDefault();
      return false;
    }
    return true;
  });

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

  // Pooled `term.write`. A Board runs every parked session's terminal at once
  // (owned-terminals keeps them alive, hidden, until exit), and each one used to
  // parse + render its `claude`'s output the instant it arrived — on the webview's
  // single main thread, the same thread that dispatches the user's keystrokes.
  // With 7 live sessions that thread sat pinned and input queued behind it.
  //
  // So pool the bytes and pick the cadence by whether anyone can actually see them:
  // a visible terminal flushes once a frame, a hidden one lazily. Nothing is ever
  // dropped — a terminal's screen is a *stateful* byte stream (cursor moves, colour,
  // alternate-screen), so discarding or truncating any of it corrupts the state that
  // follows. Every byte still reaches xterm, in order; only the cadence changes.
  // Measured on WebKitGTK at 7 sessions / 359 KB/s: 102% → 34% of a core.
  let pending = "";
  let flushRaf = 0;
  let flushTimer = 0;

  const flush = () => {
    flushRaf = 0;
    clearTimeout(flushTimer);
    flushTimer = 0;
    if (!pending) return;
    const data = pending;
    pending = "";
    term.write(data);
  };

  const scheduleFlush = () => {
    if (isLaidOut(mount)) {
      if (!flushRaf) flushRaf = requestAnimationFrame(flush);
    } else if (!flushTimer) {
      flushTimer = window.setTimeout(flush, HIDDEN_FLUSH_MS);
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
    // Just shown: don't make the user wait out a hidden terminal's lazy timer to
    // see the output that arrived while it was parked.
    flush();
  };

  // PTY → terminal. `app.emit` broadcasts to every window, so the per-tab event
  // name is what keeps one session's output out of another's.
  const unlistenOutput = await win.listen<string>(`pty-output-${tabId}`, (e) => {
    pending += e.payload;
    scheduleFlush();
    if (!isLaidOut(mount)) opts.onActivity?.();
  });
  const unlistenExit = await win.listen<string>(`pty-exit-${tabId}`, () => {
    // The PTY only reaches EOF when the whole shell session ends — Ctrl-C'ing out
    // of `claude` drops into a live shell (see pty.rs), it doesn't end the PTY.
    flush(); // the session's last words land before its epitaph
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
    // The Codex approval preset is a Board-wide pref, read fresh at spawn and applied
    // only to codex tabs (null for claude keeps the payload clean and the Rust side a no-op).
    const codexApproval = (opts.agent ?? null) === "codex" ? getCodexApproval() : null;
    await invoke("spawn_pty", { tabId, rows, cols, cwd: opts.cwd ?? null, resume: opts.resume ?? null, agent: opts.agent ?? null, codexApproval });
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
      cancelAnimationFrame(flushRaf);
      clearTimeout(flushTimer);
      unlistenOutput();
      unlistenExit();
      unlistenDrop();
      void invoke("close_pty", { tabId }).catch(() => {});
      term.dispose();
    },
  };
}
