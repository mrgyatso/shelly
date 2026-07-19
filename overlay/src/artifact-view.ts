// Shared artifact loader for tiles on the Board.
//
// Loads an artifact into a caller-supplied iframe via the `asset:` protocol
// (convertFileSrc), so the artifact renders as a real-origin document with its
// own (absent) CSP and its inline/module scripts run — which is what makes its
// ✓/✎/✗ + Submit buttons live. The iframe sandbox (`allow-scripts`, no
// `allow-same-origin`) still isolates it in an opaque origin: it can't touch the
// overlay's IPC or storage.
//
// All Shelly artifacts live under `~/.shelly/**`, which is in the
// asset-protocol scope (tauri.conf.json), so for real artifacts the in-scope
// branch always wins → tiles load via `asset://`, never `srcdoc`. The `srcdoc`
// fallback covers only out-of-scope paths (static content renders; inline JS
// won't, because `about:srcdoc` inherits the overlay's `script-src 'self'`).
//
// This mirrors the single-panel loader in `main.ts` deliberately rather than
// sharing it: P0 keeps the existing floating-panel path untouched (no regression
// risk). P1 converges the two.

import { invoke, convertFileSrc } from "@tauri-apps/api/core";

/**
 * Load `path` into `iframe`. Resolves once the load has been kicked off (the
 * actual render happens asynchronously inside the iframe). Throws if the path
 * can't be classified or read.
 */
export async function loadArtifactInto(path: string, iframe: HTMLIFrameElement): Promise<void> {
  if (!path) return;
  const inScope = await invoke<boolean>("artifact_in_scope", { path });
  if (inScope) {
    iframe.removeAttribute("srcdoc");
    // Cache-bust so re-opening the same path (e.g. Claude rewrote the file)
    // forces a reload instead of reusing the identical asset URL.
    iframe.src = `${convertFileSrc(path)}?_=${Date.now()}`;
  } else {
    const html = await invoke<string>("read_artifact", { path });
    iframe.removeAttribute("src");
    iframe.srcdoc = html;
  }
}
