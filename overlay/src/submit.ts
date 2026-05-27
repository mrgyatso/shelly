import { writeText } from "@tauri-apps/plugin-clipboard-manager";

// Interactive review artifacts post compiled-prose feedback up to the overlay
// via `postMessage({source:"companion-artifact", kind:"submit", text})`. The
// overlay writes that text to the system clipboard and shows a corner toast so
// the user knows to paste in their terminal.

const TOAST_VISIBLE_MS = 1500;
let toastTimer = 0;

export async function handleSubmit(text: string): Promise<void> {
  try {
    await writeText(text);
    showCopiedToast();
  } catch (e) {
    // Clipboard plugin failure shouldn't crash the overlay; log and move on.
    console.error("clipboard write failed", e);
  }
}

function showCopiedToast(): void {
  const el = document.getElementById("copied-toast");
  if (!el) return;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.remove("visible");
  }, TOAST_VISIBLE_MS);
}
