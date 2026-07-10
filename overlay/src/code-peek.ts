/* Code-peek side panel — view the files THIS SESSION has written, in an embedded
 * read-only Monaco diff editor: the full file, scrollable, with the session's
 * changes marked against git HEAD. "Peek and nudge," not an IDE.
 *
 * Two things the first cut got wrong, both fixed here:
 *   - The list came from `git status` on the unit's frozen `unit_dir`, so an agent
 *     working in a worktree (or anywhere outside its launch root) listed nothing,
 *     while files it never opened sat at the top. It now comes from the session's
 *     own transcript — see code_peek.rs.
 *   - It was fetched once, on open. A file written while the panel was open never
 *     appeared. It now refreshes on a poll, and the active file re-reads with it.
 *
 * Monaco is lazy-loaded on first open so it never weighs down Board boot. All the
 * panel logic lives here to keep board.ts's merge surface tiny — board.ts only
 * calls initCodePeek() once and resets the open flag on unit entry. */
import type * as Monaco from "monaco-editor";
import { invoke } from "@tauri-apps/api/core";

/** A file the session wrote. `path` is absolute and round-trips to the backend's
 *  scope guard; `rel` is repo-relative and for display only. */
interface TouchedFile {
  path: string;
  rel: string;
  status: string; // porcelain code: M / A / D / R / ?? / "" (clean, or no repo)
}

/** A file's text now, and at HEAD — `original` is null for a file git has never
 *  seen, which Monaco then renders wholly as an addition. */
interface FileView {
  content: string;
  original: string | null;
  deleted: boolean;
}

/** How often the open panel re-reads the session's files. Fast enough that a write
 *  lands while the user is still watching for it; slow enough that the transcript
 *  scan (incremental) and one `git status` per repo stay noise. */
const REFRESH_MS = 1500;

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

let diffEditor: Monaco.editor.IStandaloneDiffEditor | null = null;
let originalModel: Monaco.editor.ITextModel | null = null;
let modifiedModel: Monaco.editor.ITextModel | null = null;

/** Mount (or re-use) the read-only diff editor, showing `view` for `path`.
 *
 * Inline, not side-by-side: the drawer is narrow, and inline reads as "the whole
 * file, with the changed lines lit up" — which is what a peek wants. The two models
 * are reused across files so we don't leak one per open, and `setValue` is skipped
 * when the text is unchanged so a poll never yanks the user's scroll position. */
async function mountEditor(container: HTMLElement, view: FileView, path: string): Promise<void> {
  const monaco = await loadMonaco();
  const language = languageForPath(path);
  const original = view.original ?? "";

  if (!diffEditor) {
    originalModel = monaco.editor.createModel(original, language);
    modifiedModel = monaco.editor.createModel(view.content, language);
    diffEditor = monaco.editor.createDiffEditor(container, {
      readOnly: true,
      originalEditable: false,
      renderSideBySide: false,
      theme: "vs", // light, to sit on the Board's warm paper surface
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 12.5,
      lineNumbers: "on",
      renderWhitespace: "none",
      wordWrap: "off",
      // The panel's job is "show me the file, and what changed in it". Folding the
      // untouched regions away would leave a new file as one green block with no
      // surrounding code to read it against.
      hideUnchangedRegions: { enabled: false },
    });
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    return;
  }
  if (!originalModel || !modifiedModel) return;
  if (originalModel.getValue() !== original) originalModel.setValue(original);
  if (modifiedModel.getValue() !== view.content) modifiedModel.setValue(view.content);
  monaco.editor.setModelLanguage(originalModel, language);
  monaco.editor.setModelLanguage(modifiedModel, language);
}

/* --- panel state + wiring ------------------------------------------------ */

let resolveSessionId: () => string | null = () => null;
let unitEl: HTMLElement | null = null;
let filesEl: HTMLElement | null = null;
let editorEl: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let toggleBtn: HTMLElement | null = null;

let currentSessionId: string | null = null;
let activePath: string | null = null;
/** The refresh loop — live only while the panel is open. */
let timer: number | null = null;
/** Signature of the last-rendered file list, so a poll only re-renders on change. */
let lastListSig = "";

function isOpen(): boolean {
  return unitEl?.dataset.code === "open";
}

/** Wire the panel once at Board init. `getSessionId` yields the id of the unit's
 *  active session (or null when there's none — e.g. the idle home). */
export function initCodePeek(getSessionId: () => string | null): void {
  resolveSessionId = getSessionId;
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

/** Close the slide-over (leaves it in the DOM; CSS transforms it off-screen) and
 *  stop the refresh loop. Exposed so board.ts can reset it on unit entry without
 *  reaching into state. */
export function closeCodePeek(): void {
  if (unitEl) delete unitEl.dataset.code;
  toggleBtn?.classList.remove("on");
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  // The next unit's files have nothing to do with this one's.
  currentSessionId = null;
  activePath = null;
  lastListSig = "";
}

function close(): void {
  closeCodePeek();
}

async function open(): Promise<void> {
  if (!unitEl) return;
  unitEl.dataset.code = "open";
  toggleBtn?.classList.add("on");
  await refreshFiles();
  // Keep the panel honest while it's open — watching the agent work is the point.
  // Started unconditionally: a unit whose session isn't live YET must not be stuck
  // on the empty state forever. Cleared by closeCodePeek().
  if (timer === null) timer = window.setInterval(() => void refreshFiles(), REFRESH_MS);
}

/** Re-read the session's files, and the open one's contents with them. A failure on
 *  the poll path stays quiet once something is on screen: a transient error must not
 *  stomp the file the user is reading. */
async function refreshFiles(): Promise<void> {
  // Re-resolve every tick rather than latching on open. The unit's active session can
  // change under an open panel — the rail's session switcher doesn't re-enter the unit
  // — and a just-spawned session has no id at all until its live file appears. Latching
  // would leave the drawer showing a sibling session's files, or a permanent empty state.
  const sessionId = resolveSessionId();
  if (sessionId !== currentSessionId) {
    currentSessionId = sessionId;
    activePath = null;
    lastListSig = "";
    renderFiles([]);
  }
  if (!sessionId) {
    showStatus("No session here yet.");
    return;
  }
  let files: TouchedFile[];
  try {
    files = await invoke<TouchedFile[]>("session_files", { sessionId });
  } catch (e) {
    if (!lastListSig) showStatus(`Couldn't list files — ${e}`);
    return;
  }
  // The await let the user close the panel, or switch units, out from under us.
  if (!isOpen() || currentSessionId !== sessionId) return;

  const sig = files.map((f) => `${f.path}:${f.status}`).join("\n");
  if (sig !== lastListSig) {
    lastListSig = sig;
    renderFiles(files);
  }
  if (files.length === 0) {
    activePath = null;
    showStatus("No files written yet — nothing in play.");
    return;
  }
  // Keep the open file selected if the session still owns it; else land on the most
  // recently written one.
  const keep = activePath && files.some((f) => f.path === activePath) ? activePath : files[0].path;
  await openFile(keep);
}

/** One-char badge for a porcelain status. */
function statusBadge(status: string): string {
  if (status === "??") return "U"; // untracked (new)
  const c = status[0] ?? "";
  return c === "" ? "•" : c; // M / A / D / R …
}

function renderFiles(files: TouchedFile[]): void {
  if (!filesEl) return;
  filesEl.replaceChildren(
    ...files.map((f) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "code-file";
      chip.dataset.path = f.path;
      chip.title = f.rel;
      chip.classList.toggle("on", f.path === activePath);
      const badge = document.createElement("span");
      badge.className = "cf-badge";
      badge.textContent = statusBadge(f.status);
      const name = document.createElement("span");
      name.className = "cf-name";
      name.textContent = f.rel.split("/").pop() ?? f.rel;
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
  if (!currentSessionId || !editorEl) return;
  const sessionId = currentSessionId;
  activePath = path;
  markActiveChip(path);
  try {
    const view = await invoke<FileView>("read_touched_file", { sessionId, path });
    // Another poll (or a click) may have moved on while this read was in flight.
    if (!isOpen() || currentSessionId !== sessionId || activePath !== path) return;
    hideStatus();
    await mountEditor(editorEl, view, path);
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
