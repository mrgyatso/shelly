import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { initFit, resetFit } from "./resize";

declare global {
  interface Window {
    /** Artifact path injected by the Rust window builder before this page boots. */
    __ARTIFACT_PATH__?: string;
  }
}

const frame = document.getElementById("frame") as HTMLIFrameElement;
const emptyEl = document.getElementById("empty") as HTMLElement;
const win = getCurrentWebviewWindow();
let current = "";

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
