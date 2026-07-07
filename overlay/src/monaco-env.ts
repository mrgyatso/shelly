/* Monaco web-worker wiring for Vite.
 *
 * Monaco wants a worker per language for IntelliSense, but the code-peek panel is
 * READ-ONLY: syntax highlighting runs on the main thread via Monaco's Monarch
 * tokenizers, so we never need the language workers (ts/json/css/html). We return
 * the single base editor worker for every request — enough to satisfy Monaco
 * without pulling multiple MB of language-service workers into the bundle.
 *
 * `?worker` is Vite's suffix for "bundle this as a Web Worker entry"; the emitted
 * worker is served same-origin, which the overlay CSP (`worker-src`/`default-src
 * 'self'` + `blob:`) allows inside the Tauri webview. */
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: () => Worker };
  }
}

let installed = false;

/** Idempotently install the Monaco worker factory. Must run before the first
 *  editor is created. */
export function setupMonacoEnv(): void {
  if (installed) return;
  self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
  installed = true;
}
