import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { initFit, resetFit } from "./resize";
import { IS_LINUX } from "./platform";

declare global {
  interface Window {
    /** Artifact path injected by the Rust window builder before this page boots. */
    __ARTIFACT_PATH__?: string;
    /** Set on the history HUD window so the same bundle renders the grid instead. */
    __HISTORY_MODE__?: boolean;
    /** Set on the live surface window so the same bundle renders the live pane. */
    __LIVE_MODE__?: boolean;
    /** Set on the board window so the same bundle renders the grid of tiles. */
    __BOARD_MODE__?: boolean;
    /** Set on the menu-bar popover window so the same bundle renders the roster. */
    __POPOVER_MODE__?: boolean;
  }
}

const frame = document.getElementById("frame") as HTMLIFrameElement;
const emptyEl = document.getElementById("empty") as HTMLElement;
const win = getCurrentWebviewWindow();
let current = "";

/** If the iframe hasn't fired `load` within this window, surface an error
 *  instead of leaving a blank panel (bad path / asset-protocol failure). */
const LOAD_TIMEOUT_MS = 2500;
let loadTimer = 0;

function basename(p: string): string {
  return p.split("/").pop() || p;
}

// Render an artifact. Primary path: the `asset:` protocol (convertFileSrc), so
// the artifact loads as a real-origin document with its own (absent) CSP and its
// inline/module scripts run. The iframe sandbox (`allow-scripts`, no
// `allow-same-origin`) still isolates it in an opaque origin — it can't touch the
// overlay's IPC or storage. Paths outside the asset-protocol scope can't be
// served by `asset:`, so they fall back to reading the bytes in Rust and
// injecting via `srcdoc` (static content renders; inline JS won't, because
// `about:srcdoc` inherits the overlay's `script-src 'self'`).
async function loadArtifact(path: string): Promise<void> {
  if (!path) return;
  current = path;
  resetFit();
  try {
    // Load guard: confirm the iframe actually rendered something. `load` fires on
    // success; if it doesn't within LOAD_TIMEOUT_MS we show an error rather than a
    // silent blank panel. Registered before src/srcdoc so we never miss the event.
    let loaded = false;
    clearTimeout(loadTimer);
    frame.onload = () => {
      loaded = true;
      frame.hidden = false;
      emptyEl.hidden = true;
    };
    loadTimer = window.setTimeout(() => {
      if (!loaded && current === path) {
        emptyEl.textContent = `Could not load ${basename(path)}`;
        emptyEl.hidden = false;
        frame.hidden = true;
      }
    }, LOAD_TIMEOUT_MS);

    const inScope = await invoke<boolean>("artifact_in_scope", { path });
    if (inScope) {
      frame.removeAttribute("srcdoc");
      // Cache-bust so re-opening the same path (e.g. Claude rewrote the file)
      // forces a reload instead of reusing the identical asset URL.
      frame.src = `${convertFileSrc(path)}?_=${Date.now()}`;
    } else {
      const html = await invoke<string>("read_artifact", { path });
      frame.removeAttribute("src");
      frame.srcdoc = html;
    }
    frame.hidden = false;
    emptyEl.hidden = true;
  } catch (e) {
    emptyEl.textContent = `Could not read ${basename(path)}`;
    emptyEl.hidden = false;
    frame.hidden = true;
    console.error("loadArtifact failed", e);
  }
}

// The history HUD reuses this same bundle. When flagged, render the grid and
// skip all the single-artifact wiring below (fit-reporter, controls, listeners).
// Dynamic import keeps the HUD code out of the artifact panels' boot path.
// DEV marker — only the `tauri dev` instance (Vite dev server) sets this; the
// release build is production Vite (false). Lets you tell the dev Board apart from
// your stable one when both are open. Fixed, click-through, ignored in release.
if (import.meta.env.DEV) {
  const badge = document.createElement("div");
  badge.textContent = "DEV";
  badge.style.cssText =
    "position:fixed;top:6px;right:8px;z-index:2147483647;pointer-events:none;" +
    "font:700 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;" +
    "color:#fff;background:#b0552f;padding:3px 7px;border-radius:6px;" +
    "box-shadow:0 2px 8px rgba(0,0,0,.35);";
  addEventListener("DOMContentLoaded", () => document.body.appendChild(badge));
  if (document.body) document.body.appendChild(badge);
}

// Stamp the platform on the root element so CSS can gate on it. Every window
// boots through here, so one line covers the Board and the History HUD — the
// two that wear a native titlebar on Linux and must drop their in-page shell.
if (IS_LINUX) document.documentElement.classList.add("linux");

if (window.__LIVE_MODE__) {
  void import("./live").then((m) => m.initLive());
} else if (window.__HISTORY_MODE__) {
  void import("./history").then((m) => m.initHistory());
} else if (window.__BOARD_MODE__) {
  void import("./board").then((m) => m.initBoard());
} else if (window.__POPOVER_MODE__) {
  void import("./popover").then((m) => m.initPopover());
} else {
  document.getElementById("refresh")?.addEventListener("click", () => {
    if (current) void loadArtifact(current);
  });
  document.getElementById("external")?.addEventListener("click", () => {
    if (current) openPath(current).catch((e) => console.error("openPath failed", e));
  });
  document.getElementById("hide")?.addEventListener("click", () => {
    win.close().catch((e) => console.error("close failed", e));
  });

  // Resize the window to fit each artifact's reported content size.
  initFit();

  // Same-path re-open (e.g. Claude rewrote the file): the Rust side emits this to
  // the existing window so it reloads in place instead of spawning a duplicate.
  void win.listen<string>("open-artifact", (event) => {
    void loadArtifact(event.payload);
  });

  // This window is dedicated to one artifact; its path is injected before boot.
  if (window.__ARTIFACT_PATH__) void loadArtifact(window.__ARTIFACT_PATH__);
}
