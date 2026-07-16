import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { PASTE_KEY } from "./platform";

// Interactive review artifacts post compiled-prose feedback up to the overlay
// via `postMessage({source:"companion-artifact", kind:"submit", text})`. The
// overlay writes that text to the system clipboard and shows a corner toast so
// the user knows to paste in their terminal.

const TOAST_VISIBLE_MS = 1500;
let toastTimer = 0;

export async function handleSubmit(text: string, artifactPath?: string): Promise<void> {
  try {
    // Append the artifact's own file path so pasted feedback is self-identifying
    // — the agent can Read that file for full context even for an old artifact
    // re-opened from history. A standalone panel knows its path via the injected
    // __ARTIFACT_PATH__; the Board passes the focused artifact's path explicitly
    // (its iframes are sandboxed and can't see their own path).
    const path = artifactPath ?? window.__ARTIFACT_PATH__;
    const payload = path ? `${text}\n\n— Companion artifact: ${path} —` : text;
    await writeText(payload);
    showCopiedToast();
  } catch (e) {
    // Clipboard plugin failure shouldn't crash the overlay; log and move on.
    console.error("clipboard write failed", e);
  }
}

// An artifact Copy button (prefer-html's data-copy helper) bridges here via
// `postMessage({source:"companion-artifact", kind:"copy", text})` because the
// sandboxed opaque-origin iframe can't reach the clipboard itself on WebKitGTK.
// Write it silently: the artifact's own button renders the "Copied ✓" state, so
// a second overlay toast would be redundant.
export async function copyToClipboard(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch (e) {
    console.error("clipboard write failed", e);
  }
}

function showCopiedToast(): void {
  const el = document.getElementById("copied-toast");
  if (!el) return;
  // The static index.html label says ⌘V; correct it for non-mac platforms.
  const kbd = el.querySelector("kbd");
  if (kbd) kbd.textContent = PASTE_KEY;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.remove("visible");
  }, TOAST_VISIBLE_MS);
}
