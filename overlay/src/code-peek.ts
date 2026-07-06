/* Code-peek side panel — view the files in play for the current session in an
 * embedded read-only Monaco editor. "Peek and nudge," not an IDE: read a changed
 * file, (fast-follow) tweak a line. Monaco is lazy-loaded on first open so it
 * never weighs down Board boot.
 *
 * All the panel logic lives here to keep board.ts's merge surface tiny — board.ts
 * only calls initCodePeek() once and resets the open flag on unit entry. */
import type * as Monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";

interface ChangedFile {
  path: string; // repo-root-relative
  status: string; // trimmed porcelain code: M / A / D / R / ??
}

/* --- lazy Monaco loader -------------------------------------------------- */

let monacoPromise: Promise<typeof Monaco> | null = null;

/** Load Monaco (and install its worker env) exactly once, on first open.
 *
 * We use the full `monaco-editor` entry: it registers every language's Monarch
 * tokenizer, so a read-only peek gets proper syntax colours across languages. Its
 * rich language services (TS/JSON/CSS) also try to reach a language worker we
 * don't ship, which logs a harmless "Missing requestHandler" for those file types
 * — cosmetic console noise, no effect on the read-only view. (The leaner
 * `editor.api` + basic-languages path drops the noise but also dropped
 * highlighting in practice, so it isn't worth the trade for a viewer.) */
function loadMonaco(): Promise<typeof Monaco> {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      const { setupMonacoEnv } = await import("./monaco-env");
      setupMonacoEnv();
      return import("monaco-editor");
    })();
  }
  return monacoPromise;
}

/** Map a file extension to a Monaco language id for highlighting. Unknown
 *  extensions fall back to plaintext (still readable, just uncolored). */
function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    mjs: "javascript", cjs: "javascript",
    rs: "rust", py: "python", go: "go", rb: "ruby", java: "java",
    c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
    json: "json", jsonc: "json", css: "css", scss: "scss", html: "html", htm: "html",
    md: "markdown", markdown: "markdown", yaml: "yaml", yml: "yaml", toml: "ini",
    sh: "shell", bash: "shell", zsh: "shell", sql: "sql", xml: "xml", swift: "swift",
    php: "php", kt: "kotlin", kts: "kotlin",
  };
  return map[ext] ?? "plaintext";
}

/* --- editor mount -------------------------------------------------------- */

let editor: Monaco.editor.IStandaloneCodeEditor | null = null;

/** Mount (or re-use) the read-only editor in `container`, showing `value` with
 *  the language inferred from `path`. Re-uses the single model to avoid leaks. */
async function mountEditor(container: HTMLElement, value: string, path: string): Promise<void> {
  const monaco = await loadMonaco();
  const language = languageForPath(path);
  if (!editor) {
    editor = monaco.editor.create(container, {
      value,
      language,
      readOnly: true,
      theme: "vs", // light, to sit on the Board's warm paper surface
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12.5,
      lineNumbers: "on",
      renderWhitespace: "none",
      wordWrap: "off",
    });
  } else {
    const model = editor.getModel();
    if (model) {
      model.setValue(value);
      monaco.editor.setModelLanguage(model, language);
    } else {
      editor.setModel(monaco.editor.createModel(value, language));
    }
  }
}

/* --- panel state + wiring ------------------------------------------------ */

let resolveUnitDir: () => string | null = () => null;
let unitEl: HTMLElement | null = null;
let filesEl: HTMLElement | null = null;
let editorEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let toggleBtn: HTMLElement | null = null;

let currentDir: string | null = null;
let activePath: string | null = null;

function isOpen(): boolean {
  return unitEl?.dataset.code === "open";
}

/** Wire the panel once at Board init. `getUnitDir` yields the current unit's
 *  working dir (or null when there's none — e.g. the idle home). */
export function initCodePeek(getUnitDir: () => string | null): void {
  resolveUnitDir = getUnitDir;
  unitEl = document.getElementById("board-unit");
  filesEl = document.getElementById("code-files");
  editorEl = document.getElementById("code-editor");
  statusEl = document.getElementById("code-status");
  toggleBtn = document.getElementById("unit-code-toggle");

  toggleBtn?.addEventListener("click", () => (isOpen() ? close() : void open()));
  document.getElementById("code-close")?.addEventListener("click", () => close());
  filesEl?.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>(".code-file");
    if (chip?.dataset.path) void openFile(chip.dataset.path);
  });
  // Esc closes the panel when it's open (harmless alongside board.ts's own Esc).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
  });
}

/** Close the slide-over (leaves it in the DOM; CSS transforms it off-screen).
 *  Exposed so board.ts can reset it on unit entry without reaching into state. */
export function closeCodePeek(): void {
  if (unitEl) delete unitEl.dataset.code;
  toggleBtn?.classList.remove("on");
}

function close(): void {
  closeCodePeek();
}

async function open(): Promise<void> {
  if (!unitEl) return;
  unitEl.dataset.code = "open";
  toggleBtn?.classList.add("on");
  currentDir = resolveUnitDir();
  if (!currentDir) {
    renderFiles([]);
    showStatus("No folder for this session.");
    return;
  }
  await refreshFiles();
}

async function refreshFiles(): Promise<void> {
  try {
    const files = await invoke<ChangedFile[]>("list_changed_files", { unitDir: currentDir });
    renderFiles(files);
    if (files.length === 0) {
      showStatus("No changed files — nothing in play yet.");
      return;
    }
    // Keep the open file selected if it's still changed; else land on the first.
    const keep = activePath && files.some((f) => f.path === activePath) ? activePath : files[0].path;
    await openFile(keep);
  } catch (e) {
    showStatus(`Couldn't list files — ${e}`);
  }
}

/** One-char badge for a porcelain status. */
function statusBadge(status: string): string {
  if (status === "??") return "U"; // untracked (new)
  const c = status[0] ?? "";
  return c === "" ? "•" : c; // M / A / D / R …
}

function renderFiles(files: ChangedFile[]): void {
  if (!filesEl) return;
  filesEl.replaceChildren(
    ...files.map((f) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "code-file";
      chip.dataset.path = f.path;
      chip.title = f.path;
      chip.classList.toggle("on", f.path === activePath);
      const badge = document.createElement("span");
      badge.className = "cf-badge";
      badge.textContent = statusBadge(f.status);
      const name = document.createElement("span");
      name.className = "cf-name";
      name.textContent = f.path.split("/").pop() ?? f.path;
      chip.append(badge, name);
      return chip;
    }),
  );
}

function markActiveChip(path: string): void {
  filesEl?.querySelectorAll<HTMLElement>(".code-file").forEach((c) => {
    c.classList.toggle("on", c.dataset.path === path);
  });
}

async function openFile(path: string): Promise<void> {
  if (!currentDir || !editorEl) return;
  activePath = path;
  markActiveChip(path);
  try {
    const content = await invoke<string>("read_source_file", {
      unitDir: currentDir,
      relPath: path,
    });
    hideStatus();
    await mountEditor(editorEl, content, path);
  } catch (e) {
    showStatus(`Couldn't read ${path} — ${e}`);
  }
}

function showStatus(msg: string): void {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.hidden = false;
}

function hideStatus(): void {
  if (statusEl) statusEl.hidden = true;
}
