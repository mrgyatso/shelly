// The Board — Companion's home surface.
//
// A dark letterboxing STAGE holds a warm "Anthropic paper" BOARD surface that
// drills through three levels:
//
//   L0 HUB      — a full-bleed, agent-authored dashboard (home.html), or a
//                 native greeting fallback.
//   L1 SESSIONS — a light native roster of UNITS with live activity. A unit is
//                 a project (git repo) when its sessions run in one, else a bare
//                 session; two agents in one repo = one card reading "2 live".
//   L2 UNIT     — one unit's living HOME, layered: a durable agent-authored
//                 DIGEST (home.<unit_key>.html) at the top, a strip of live
//                 LANES (one per active session — its working/where/next +
//                 ✓/✎/✗ decisions + in-flight artifacts), and a readable text
//                 HISTORY of the unit's artifacts. Opening any artifact opens a
//                 true full-SURFACE reader.
//
// Real-data path (unchanged): read_all_live() → one source per live session;
// list_artifacts() → real artifacts, routed to a unit by their
// companion-meta.project basename. The bento grid, span-resize, drag-reorder,
// and per-tile live-iframe LRU of the prior Board are GONE — a pile of scaled
// previews was the wrong frame; the job is to digest the current work, with
// history a quiet layer behind it.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { handleSubmit } from "./submit";
import { loadArtifactInto } from "./artifact-view";
import { isNavigateMessage, isNewSessionMessage } from "./resize";
import { mountClawd } from "./clawd";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  initOwnedTerminals,
  spawnOwnedSession,
  reconcileBindings,
  showOwnedTerminals,
  hideOwnedTerminals,
  ownedUnits,
  ownedTabForUnit,
  endOwnedTerminalsForUnit,
  closeOwnedTerminal,
  setTerminalCollapsed,
  fitShownTerminal,
  ensureOwnedTerminal,
  endShownTerminal,
  showSessionInUnit,
} from "./owned-terminals";

interface ArtifactEntry {
  path: string;
  title: string;
  subject?: string | null;
  summary?: string | null;
  modified_ms: number;
  size_bytes: number;
  /** Raw companion-meta.project (often a path like `~/foo`); matched by basename. */
  project?: string | null;
  /** AUTHORITATIVE unit key, written at create time by the companion-hook from the
   *  writing session's live file (keyed on session_id, not the volatile cwd). When
   *  present it routes the artifact directly; project is then display-only. */
  unit_key?: string | null;
  /** The writing session's source slug — lets a ✓/✎/✗ answer go to the EXACT
   *  owned session that produced this artifact. */
  source?: string | null;
}

interface LiveSource {
  source: string;
  json: string;
}

/** A resumable, NON-live session from Claude Code's own transcripts (list_recent_sessions).
 *  Drives the roster's "Recent" band — click to `claude --resume` it in its original cwd. */
interface RecentSession {
  session_id: string;
  cwd: string;
  project: string;
  last_active_ms: number;
  size_bytes: number;
  title?: string | null;
}

interface NextItem {
  title: string;
  sub?: string;
  kind?: string;
}

interface LiveState {
  working?: string;
  where?: string[];
  next?: NextItem[];
  project?: string;
  /** File mtime, injected by read_all_live — drives liveness (LIVENESS_MS). */
  updated_ms?: number;
  /** Emitted by the companion-livepath hook: true when the session is in a git
   *  repo. Absent for pre-hook sessions → derived heuristically. */
  is_repo?: boolean;
  /** Emitted by the hook: the AUTHORITATIVE unit key (slug for a repo,
   *  slug--shortid for a bare session). The digest filename keys off this. */
  unit_key?: string;
  /** Injected by read_all_live from owned-sessions.json: the tabId of the
   *  Board-owned PTY that spawned this session (absent for external sessions).
   *  Lets the Board bind its embedded terminal to this live source. */
  companion_session?: string;
  /** Injected by read_all_live from session-dirs.json: this session's absolute
   *  project root, so "+ session in this project" knows where to spawn. */
  unit_dir?: string;
  /** Injected by read_all_live when the user has manually closed this session off
   *  the roster (see dismissed.json). Sticky override of mtime-freshness. */
  dismissed?: boolean;
  /** Injected by read_all_live from session-ids.json: the FULL Claude Code
   *  session id, so a closed Board session can be rejoined via `claude --resume`. */
  session_id?: string;
}

type StatusLevel = "wait" | "busy" | "ok" | "idle";

/** Header fields for one source — used by L1 unit cards. */
interface PaneHead {
  source: string;
  name: string;
  prov: string;
  mark: string;
  isCloud: boolean;
  level: StatusLevel;
  statusHtml: string;
}

/** Unit key for artifacts that match no single live source. */
const UNSOURCED = "__unsourced__";
/** Sentinel "unit" for the idle home — the rail (live + Recent) with NO project
 *  selected and a clawd splash, shown at startup when nothing substantive is live.
 *  Never a real source/artifact key, so it highlights no tab and owns no terminal. */
const IDLE = "__idle__";
/** Poll cadence for live-state — matches live.ts's calm cadence. */
const POLL_MS = 1200;
/** An instance whose live file hasn't been touched within this window is "stale"
 *  — it drops off the live roster into the reversible Archived toggle. */
const LIVENESS_MS = 2 * 60 * 60 * 1000;
/** An artifact modified within this window counts as in-flight / fresh. */
const FRESH_WINDOW_MS = 12 * 60 * 60 * 1000;
/** A session touched (live-file mtime ∪ transcript heartbeat) within this window is
 *  treated as STILL RUNNING, so unit-entry must not auto-resume it — that would spawn a
 *  second claude on one transcript (the duplicate's SessionEnd then DELETES the live
 *  session's file). Sessions idle past it are safely closed ⇒ resumable. Generous (15m,
 *  not the live-file cadence) because BOTH freshness signals are written per-TURN, so an
 *  agent mid-long-turn can legitimately go many minutes without touching either — the
 *  exact case that caused the bug. Erring wide is safe: the cost is only that a genuinely
 *  closed session shows read-only on entry until the window lapses (the rail still offers
 *  an explicit resume); the cost of erring narrow is a duplicate + live-file loss. */
const RESUME_LIVE_GUARD_MS = 15 * 60 * 1000;

const win = getCurrentWebviewWindow();

/** The Board's two drill-down levels. L0 Hub → L2 one unit. (The rail IS the
 *  session navigation now; the old L1 sessions roster is gone.) */
type BoardView =
  | { level: "hub" }
  | { level: "unit"; unitKey: string };

/** Back-navigation stack; the current view is its top. */
let viewStack: BoardView[] = [{ level: "hub" }];
function currentView(): BoardView {
  return viewStack[viewStack.length - 1];
}

/** Last-rendered live JSON per source, so a poll only re-renders what changed. */
const lastJsonBySource = new Map<string, string>();

/** Raw data read once in initBoard; the router re-scopes it per view. */
let allSources: LiveSource[] = [];
let allArtifacts: ArtifactEntry[] = [];
/** Resumable closed sessions (from claude's transcripts), refreshed on a slow cadence —
 *  the source for the roster's "Recent" band. */
let allRecent: RecentSession[] = [];
/** A "+ New session" terminal awaiting its first live source, so pollLive can
 *  navigate to its unit once it correlates. */
let pendingNavTab: string | null = null;
/** Whether `pendingNavTab` is a FRESH launch (true) vs a RESUME (false). On the
 *  correlate-and-re-nav, only a fresh launch skips the digest (lands terminal-focused);
 *  a resume keeps its hero — the user clicked a session that HAS context to show. */
let pendingNavFresh = false;
/** The unit of a just-launched/resumed session — `renderHero` skips the project
 *  digest for it (the user wants their new terminal, not a ~1s artifact load), so
 *  entry lands terminal-focused with no flash. Consumed on the first render. */
let freshLaunchUnit: string | null = null;

/** The reader overlay's dedicated live iframe + the path it's showing (null = closed). */
let focusFrame: HTMLIFrameElement | null = null;
let focusPath: string | null = null;
/** Artifact paths visited in this reader session, for "← Back" after jumping
 *  through the agents-need-you queue. Cleared when the reader closes. */
const readerBackStack: string[] = [];
/** Artifacts the user has already submitted from, keyed by path → the file's
 *  modified_ms at submit time. Lets the reader re-show the "submitted" overlay
 *  when you navigate back to one (otherwise the iframe reloads fresh and the
 *  state is lost). A later rewrite (new modified_ms) clears it — fresh content
 *  is fresh work, not an already-answered card. */
const submittedArtifacts = new Map<string, number>();
/** After a submit, the source (session) whose NEXT artifact should auto-open in
 *  the reader — so you flow card→card without touching the terminal. Set on
 *  submit, consumed by the next same-source artifact, cleared on manual nav or
 *  reader close. Only THIS session's artifacts auto-advance; another session's
 *  new work just raises the ambient "N agents need you" awareness (unread). */
let awaitingAdvanceSource: string | null = null;
/** Teardown for the scoped "On it" overlay's resize listener, or null when none. */
let boardSubmittedCleanup: (() => void) | null = null;

// ---- live artifact ingestion + unread ---------------------------------------
// The poll loop re-reads list_artifacts(); a new artifact is routed to its
// source (matched by companion-meta.project basename), and — if its UNIT isn't
// the one on screen — flagged UNREAD on its source (summed onto the unit card).

/** Every artifact path we've ever seen — seeded at init so existing files aren't "new". */
const knownPaths = new Set<string>();
/** Unread (arrived-while-away) artifact paths, per UNIT key (so two same-repo
 *  agents' artifacts accrue onto the one unit card, and UNSOURCED clears too). */
const unreadByUnit = new Map<string, Set<string>>();
/** Signature of the last-seen artifact set (path:mtime) — a cheap poll no-op guard. */
let lastArtifactSig = "";
/** Units whose L2 history rebuild is deferred because the reader is open. */
const pendingIngest = new Set<string>();

// DOM handles (resolved in initBoard).
let boardEl: HTMLElement;
let stageEl: HTMLElement;
let scrimEl: HTMLElement;
let hubEl: HTMLElement;
let unitEl: HTMLElement;
let digestEl: HTMLIFrameElement;
let digestPath: string | null = null; // tracks what's currently loaded in digestEl
/** Newest unseen artifact for the on-screen unit while its hero stays sticky. */
let heroPendingPath: string | null = null;
let heroNewEl: HTMLButtonElement | null = null;
let historyEl: HTMLElement;
let railEl: HTMLElement | null = null;
let railSessionsEl: HTMLElement | null = null;
let menuToggleEl: HTMLElement | null = null;
let controlsEl: HTMLElement | null = null;
let unitTitleEl: HTMLElement | null = null;
/** The unit currently shown at L2 — so the in-session rename knows its target. */
let currentUnitKey: string | null = null;
let lastRailActiveUnit: string | null = null; // tracks which unit the rail was last rendered for
/** Which recent (closed) project is expanded in the rail, or null for all collapsed. */
let expandedRecentProject: string | null = null;
/** Which LIVE (active-section) project's session dropdown is expanded, or null for
 *  all collapsed — symmetric with `expandedRecentProject`. Clicking a multi-session
 *  project tab toggles this and shows its session chooser INSTEAD of navigating; you
 *  pick a session from the dropdown, and only then does the Board move into it. */
let expandedActiveProject: string | null = null;
/** User-assigned unit display names (unit_key → name), from unit-names.json. */
const unitNames = new Map<string, string>();

export async function initBoard(): Promise<void> {
  const stage = document.getElementById("board-stage");
  const board = document.getElementById("board");
  const scrim = document.getElementById("board-scrim");
  const status = document.getElementById("board-status");
  const hub = document.getElementById("board-hub");
  const unit = document.getElementById("board-unit");
  const digest = document.getElementById("unit-digest") as HTMLIFrameElement | null;
  const history = document.getElementById("unit-history");
  // The single-artifact / other surfaces share this bundle — hide them.
  document.getElementById("frame")?.setAttribute("hidden", "");
  document.getElementById("empty")?.setAttribute("hidden", "");
  document.getElementById("controls")?.setAttribute("hidden", "");
  if (!stage || !board || !scrim || !status || !hub || !unit || !digest || !history) return;

  stageEl = stage;
  boardEl = board;
  scrimEl = scrim;
  hubEl = hub;
  unitEl = unit;
  digestEl = digest;
  historyEl = history;
  heroNewEl = document.getElementById("unit-hero-new") as HTMLButtonElement | null;
  // Mirror the focusFrame "restore-submitted" logic: when the hero digest
  // reloads after a unit re-entry, re-show the submitted overlay if the user
  // already answered this artifact and it hasn't been rewritten since.
  digest.addEventListener("load", () => {
    if (!digestPath) return;
    const stamp = submittedArtifacts.get(digestPath);
    if (stamp === undefined) return;
    const art = allArtifacts.find((a) => a.path === digestPath);
    if (art && art.modified_ms !== stamp) return; // rewritten → form re-arms
    digest.contentWindow?.postMessage(
      { source: "companion-board", kind: "restore-submitted" },
      "*",
    );
  });
  railEl = document.getElementById("unit-rail");
  railSessionsEl = document.getElementById("unit-rail-sessions");
  const terminalsSlot = document.getElementById("unit-terminals");
  if (terminalsSlot)
    initOwnedTerminals(terminalsSlot, {
      resolveDir: unitDirOf,
      statusDot: document.getElementById("unit-term-dot"),
    });
  stage.removeAttribute("hidden");

  // Dev/test hook: drive `window.__spawnOwned('<abs dir>')` from the MCP bridge to
  // spawn a Board-owned claude headlessly (the native folder picker can't be
  // driven headlessly). Harmless in production; remove before the public release.
  (window as unknown as { __spawnOwned?: (cwd: string) => Promise<string> }).__spawnOwned =
    spawnOwnedSession;

  wireControls();
  wireKeyboard();
  wireNavigate();
  wireHistoryClicks();
  wireUnitChrome();
  wireScrollGating();

  setStatus(status, "Loading…");

  // Non-destructive retention sweep before listing — archives artifacts older
  // than the retention window so the roster doesn't balloon. Best-effort.
  try {
    await invoke<number>("sweep_artifacts");
  } catch (e) {
    console.error("artifact sweep failed", e);
  }

  try {
    [allSources, allArtifacts] = await Promise.all([
      invoke<LiveSource[]>("read_all_live"),
      invoke<ArtifactEntry[]>("list_artifacts"),
    ]);
  } catch (e) {
    console.error("board load failed", e);
    setStatus(status, "Couldn't read the Board's data.");
    return;
  }
  status.setAttribute("hidden", "");

  try {
    const names = await invoke<Record<string, string>>("read_unit_names");
    for (const [k, v] of Object.entries(names)) unitNames.set(k, v);
  } catch (e) {
    console.error("read_unit_names failed", e);
  }

  for (const s of allSources) lastJsonBySource.set(s.source, s.json);
  for (const a of allArtifacts) knownPaths.add(a.path);
  lastArtifactSig = artifactSig(allArtifacts);
  window.setInterval(() => void pollLive(), POLL_MS);

  // Recent (resumable, closed) sessions change slowly — load once, then refresh on a
  // much calmer cadence than the live poll (each refresh scans transcript heads).
  void loadRecent();
  window.setInterval(() => void loadRecent(), POLL_MS * 20);

  // On relaunch, skip straight to the most recently active project when no home.html
  // has been authored — the rail shows all projects and is immediately useful without
  // an extra click through the old sessions roster.
  startupNavigate();

  // A popover row click stores a deep-link target; drain it (fresh window). An
  // already-open Board catches the same target via the `board:navigate` event.
  void listen("board:navigate", () => void applyNavTarget());
  void applyNavTarget();
}

/** "+ New session" (primary): spawn a Board-owned claude in the home dir
 *  instantly — no folder picker. Starting a session should feel effortless; the
 *  common case is "just give me a claude here." Pick a specific folder/repo via
 *  the adjacent caret (newFolderSession). Falls back to the picker if HOME can't
 *  be resolved. */
async function newHomeSession(): Promise<void> {
  let home: string | null = null;
  try {
    home = await invoke<string | null>("resolve_home_dir");
  } catch (e) {
    console.error("resolve_home_dir failed", e);
  }
  if (!home) return void newFolderSession();
  void launchSessionIn(home);
}

/** "+ New session in a folder…" (secondary): pick a folder/repo, spawn there. */
async function newFolderSession(): Promise<void> {
  let dir: string | null = null;
  try {
    const picked = await openDialog({ directory: true, title: "Start a claude session in…" });
    dir = typeof picked === "string" ? picked : null;
  } catch (e) {
    console.error("folder picker failed", e);
    return;
  }
  if (!dir) return;
  void launchSessionIn(dir);
}

/** Spawn a Board-owned claude in `dir` and reveal it. Shows the terminal
 *  IMMEDIATELY under a provisional unit (claude's first-run trust prompt blocks
 *  SessionStart, so the user must SEE the terminal before its live file exists),
 *  then re-navigates to the real unit when it correlates (pendingNavTab, handled
 *  in pollLive) — but only when the provisional was a throwaway.
 *
 *  Provisional choice (project-units): a repo session belongs to its PROJECT unit
 *  (`unitKeyOf` → project slug). If that unit is ALREADY on the roster, launch the
 *  new session straight into it (provisional = the project key) so it joins the
 *  existing group instantly — no transient `base~N` card that flashes at the
 *  bottom (Idle band) for the ~2-4s correlation window before re-homing. With NO
 *  existing unit (first session), keep a UNIQUE `base~N` so two rapid brand-new
 *  same-repo launches can't collapse onto one card before either has a live file;
 *  reconcileBindings re-homes it to the project key once its live file appears. */
let provisionalSeq = 0;
async function launchSessionIn(dir: string): Promise<string | null> {
  const base = dir.split("/").filter(Boolean).pop() || dir;
  const existing = allSources.some((s) => unitKeyOf(s) === base);
  const provisional = existing ? base : `${base}~${++provisionalSeq}`;
  try {
    const tabId = await spawnOwnedSession(dir, provisional);
    if (!existing) {
      // A BRAND-NEW unit (first session of this project): re-nav when the throwaway
      // provisional re-homes, and land terminal-focused — there's no artifact yet, so
      // suppressing the digest just avoids an empty iframe flash.
      pendingNavTab = tabId;
      pendingNavFresh = true;
      freshLaunchUnit = provisional;
    }
    // Into an EXISTING unit, just navigate: the hero is per-SESSION (it scopes to
    // the active session's source — see activeSessionSource), so spawning a new
    // session flips the active tab and renderHero naturally lands on a blank hero
    // for it (no artifacts of its own yet) while the sibling sessions keep theirs.
    // No freshLaunchUnit hack needed — and crucially no sibling's artifact bleeds in.
    goUnit(provisional);
    return tabId;
  } catch (e) {
    console.error("spawnOwnedSession failed", e);
    return null;
  }
}

/** ms to wait after spawning a session before pre-filling a seeded quote — enough
 *  for `claude` to reach its prompt (home is typically already trusted, so no
 *  first-run gate). The paste is pre-fill only; if it lands early the user just
 *  re-pastes, so this is a soft target, not a correctness dependency. */
const SEED_PREFILL_MS = 1800;

/** "✦ Start a new session with this quote": the user highlighted text in an artifact
 *  and wants a fresh session to dig into it. Spawn a Board-owned `claude` in HOME,
 *  navigate to it, then PRE-FILL (never send) the prompt with the attributed quote so
 *  the user adds their own angle and submits. The quote is artifact-controlled, so it's
 *  ESC-stripped before it touches the PTY — same paste-escape breakout guard as
 *  submitIntoPty (see the SECURITY note in wireNavigate). No trailing CR: pre-fill only. */
async function startSessionFromQuote(quote: string, artifact?: string): Promise<void> {
  let home: string | null = null;
  try {
    home = await invoke<string | null>("resolve_home_dir");
  } catch (e) {
    console.error("resolve_home_dir failed", e);
  }
  if (!home) return;
  const tabId = await launchSessionIn(home);
  if (!tabId) return;
  const attribution = artifact ? `Re: ${artifact} — ` : "";
  const seed = `${attribution}"${quote}"\n\n`;
  const safe = seed.split("\x1b").join(""); // ESC-strip: block paste-escape breakout
  window.setTimeout(() => {
    void invoke("write_pty", { tabId, data: `\x1b[200~${safe}\x1b[201~` }).catch((e) =>
      console.error("seed pre-fill failed", e),
    );
  }, SEED_PREFILL_MS);
}

/** The "+ New session" menu: a small popover under the + giving the two ways to
 *  start — at home (~), or in a folder you pick. Click + again (or anywhere) to
 *  close. */
function toggleNewSessionMenu(anchor: HTMLElement): void {
  const existing = document.querySelector(".newsession-menu");
  if (existing) {
    closeNewSessionMenu();
    return;
  }
  const menu = document.createElement("div");
  menu.className = "newsession-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML =
    '<button class="ns-item" role="menuitem" data-ns="home">' +
    '<span class="ns-ico">⌂</span><span class="ns-tx">Start at home<small>~</small></span></button>' +
    '<button class="ns-item" role="menuitem" data-ns="folder">' +
    '<span class="ns-ico">📁</span><span class="ns-tx">Start in a folder…</span></button>';
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 7)}px`;
  menu.style.right = `${Math.round(window.innerWidth - r.right)}px`;
  // Append inside .stage — the design tokens (--card, --ink, …) hang on .stage,
  // not :root/body, so a menu on <body> renders transparent with invisible text.
  // .stage has no transform/filter, so the menu's position:fixed stays viewport-relative.
  stageEl.append(menu);
  anchor.setAttribute("aria-expanded", "true");

  menu.querySelector('[data-ns="home"]')?.addEventListener("click", () => {
    closeNewSessionMenu();
    void newHomeSession();
  });
  menu.querySelector('[data-ns="folder"]')?.addEventListener("click", () => {
    closeNewSessionMenu();
    void newFolderSession();
  });
  // Close on any outside click or Escape (next tick, so this opening click
  // doesn't immediately dismiss it).
  setTimeout(() => {
    document.addEventListener("click", closeNewSessionMenu, { once: true });
    document.addEventListener("keydown", onMenuEsc);
  }, 0);
}

function onMenuEsc(e: KeyboardEvent): void {
  if (e.key === "Escape") closeNewSessionMenu();
}

function closeNewSessionMenu(): void {
  document.querySelector(".newsession-menu")?.remove();
  document.getElementById("board-newsession")?.setAttribute("aria-expanded", "false");
  document.removeEventListener("keydown", onMenuEsc);
}

/** The 🔔 dropdown: one row per unit with unread work, click to jump to that
 *  agent. Replaces the old blunt "bell → go to sessions". */
function toggleNotifMenu(anchor: HTMLElement): void {
  if (document.querySelector(".notif-menu")) {
    closeNotifMenu();
    return;
  }
  const menu = document.createElement("div");
  menu.className = "notif-menu";
  menu.setAttribute("role", "menu");

  const entries: { unit: string; n: number }[] = [];
  for (const [unit, set] of unreadByUnit) if (set.size > 0) entries.push({ unit, n: set.size });
  entries.sort((a, b) => b.n - a.n);

  const head = document.createElement("div");
  head.className = "notif-head";
  head.textContent = entries.length ? "Needs you" : "Nothing new";
  menu.append(head);

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "notif-empty";
    empty.textContent = "No agents are waiting on you.";
    menu.append(empty);
  } else {
    const byUnit = groupSourcesByUnit();
    for (const { unit, n } of entries) {
      const row = document.createElement("button");
      row.className = "notif-item";
      row.setAttribute("role", "menuitem");
      const dot = document.createElement("span");
      dot.className = "notif-dot";
      const name = document.createElement("span");
      name.className = "notif-name";
      name.textContent = unitName(unit, byUnit.get(unit) ?? []);
      const count = document.createElement("span");
      count.className = "notif-n";
      count.textContent = n > 9 ? "9+" : String(n);
      row.append(dot, name, count);
      row.addEventListener("click", () => {
        closeNotifMenu();
        goUnit(unit);
      });
      menu.append(row);
    }
  }

  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 7)}px`;
  menu.style.right = `${Math.round(window.innerWidth - r.right)}px`;
  stageEl.append(menu);
  anchor.setAttribute("aria-expanded", "true");
  // Close on next outside click / Escape (next tick so the opening click doesn't
  // immediately dismiss it).
  setTimeout(() => {
    document.addEventListener("click", closeNotifMenu, { once: true });
    document.addEventListener("keydown", onNotifEsc);
  }, 0);
}

function onNotifEsc(e: KeyboardEvent): void {
  if (e.key === "Escape") closeNotifMenu();
}

function closeNotifMenu(): void {
  document.querySelector(".notif-menu")?.remove();
  document.getElementById("board-unread")?.setAttribute("aria-expanded", "false");
  document.removeEventListener("keydown", onNotifEsc);
}

/** Drain any pending deep-link target (Rust-side), routing to its unit (L2). */
async function applyNavTarget(): Promise<void> {
  try {
    const target = await invoke<string | null>("take_board_nav_target");
    if (target) navigateTo("session:" + target);
  } catch (e) {
    console.error("applyNavTarget failed", e);
  }
}

// ---- view router ------------------------------------------------------------

/** Show exactly one of the level containers; the rest stay hidden. */
function showLevel(level: BoardView["level"]): void {
  hubEl.toggleAttribute("hidden", level !== "hub");
  unitEl.toggleAttribute("hidden", level !== "unit");
}

/** A live source that's just the SessionStart stub — the "Session started" working
 *  line, no where/next, and no artifacts of its own. It's "live" by file mtime for
 *  the full 2h LIVENESS_MS window, but there's nothing to show: such a source must
 *  NOT hijack the launch screen (the reported "parked on a stale clipping" bug). */
function isStubSource(s: LiveSource): boolean {
  const st = parseState(s.json);
  const working = (st.working || "").trim();
  if (working !== "" && working !== SESSION_STARTED_STUB) return false;
  if ((st.where?.length ?? 0) > 0 || (st.next?.length ?? 0) > 0) return false;
  return !allArtifacts.some((a) => a.source === s.source);
}

/** Startup routing: drop straight into the most-recent SUBSTANTIVE live session
 *  (real work, not a bare stub). With none, land on the idle home (rail + clawd
 *  splash) rather than parking on a stale "Session started" stub for the full 2h
 *  liveness window. The L0 home.html dashboard stays reachable via explicit Home. */
function startupNavigate(): void {
  const now = Date.now();
  const substantive = allSources
    .filter((s) => !isDismissed(s) && isLiveSource(s, now) && !isStubSource(s))
    .sort(
      (a, b) =>
        Math.max(sourceUpdatedMs(b), sourceHeartbeatMs(b)) -
        Math.max(sourceUpdatedMs(a), sourceHeartbeatMs(a)),
    );
  if (substantive.length) { goUnit(unitKeyOf(substantive[0])); return; }
  goIdle();
}

/** Enter the idle home: the rail (live units + Recent projects) with NO project
 *  selected, a clawd splash in the hero, and no terminal. Mirrors L2's shell so the
 *  rail's right-click "New session" / resume affordances work straight from launch,
 *  but selects nothing — a stale stub can no longer claim the launch screen. */
function goIdle(): void {
  leaveUnit();
  viewStack = [{ level: "unit", unitKey: IDLE }];
  showLevel("unit");
  currentUnitKey = IDLE;
  unitEl.dataset.rail = "sessions";
  unitEl.dataset.view = "session";
  unitEl.classList.add("is-idle");
  renderUnitRail(IDLE);
  renderUnitTitle(IDLE);
  hideOwnedTerminals();
  showBlankHero(BLANK_IDLE);
  updateGlobalUnread();
}

/** The unit key of the most recently active project (live first, then closed).
 *  Used by startupNavigate and the hub fallback CTA. */
function findMostRecentActiveUnit(): string | null {
  const now = Date.now();
  const liveSorted = allSources
    .filter((s) => !isDismissed(s) && isLiveSource(s, now))
    .sort(
      (a, b) =>
        Math.max(sourceUpdatedMs(b), sourceHeartbeatMs(b)) -
        Math.max(sourceUpdatedMs(a), sourceHeartbeatMs(a)),
    );
  if (liveSorted.length) return unitKeyOf(liveSorted[0]);
  const recent = recentToShow();
  if (recent.length) {
    return projectSlug(recent[0].project) ?? recent[0].cwd.split("/").filter(Boolean).pop() ?? null;
  }
  return null;
}

/** Enter L0. Resolves home.html (Rust) → full-bleed iframe, else native fallback. */
async function goHub(): Promise<void> {
  leaveUnit();
  viewStack = [{ level: "hub" }];
  showLevel("hub");
  renderGreeting(freshCount(), allSources.length);
  await renderHub();
  updateGlobalUnread();
}

/** "Enter the roster" / sessions target. The L1 roster is gone (the rail IS the
 *  navigation), so there's no list page to land on — drop into the first live unit.
 *  Falls back to findMostRecentActiveUnit() so the button works even when the poll
 *  hasn't yet propagated freshness (e.g. immediately after Board launch). */
function goSessions(): void {
  const order = computeRoster(Date.now()).order;
  if (order.length > 0) { goUnit(order[0]); return; }
  const u = findMostRecentActiveUnit();
  if (u) goUnit(u);
}

/** Enter L2 — one unit's home. Replace rather than stack if already at a unit.
 *  Back goes unit → Hub (sessions roster is gone; the rail IS the navigation). */
function goUnit(unitKey: string): void {
  // Instant-hide the pane so the content swap doesn't flash; fades back in after load.
  if (unitEl) unitEl.classList.add("is-switching");
  leaveUnit(); // clears prior theming; renderHero re-themes if this unit authored a home
  // A unit is a TOP-LEVEL destination — the rail IS the navigation, so a unit never
  // stacks the hub beneath it. That means no back-arrow and no Esc → L0 from within
  // a unit; switching units replaces the root rather than deepening the stack. L0 is
  // reached only deliberately (startup with a home.html, or when nothing is open).
  viewStack = [{ level: "unit", unitKey }];
  showLevel("unit");
  enterUnit(unitKey);
  // Two rAFs: first lets the browser paint opacity:0, second starts the 180ms fade-in.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => unitEl?.classList.remove("is-switching")),
  );
}

// ---- L0 Hub -----------------------------------------------------------------

/**
 * Render the Hub. If an agent has authored `home.html` (resolved Rust-side, so
 * it's in asset: scope → its JS runs), load it full-bleed; otherwise the native
 * fallback. Re-resolved on each entry only — the Hub doesn't live-refresh.
 */
async function renderHub(): Promise<void> {
  const frame = document.getElementById("hub-frame") as HTMLIFrameElement | null;
  const fallback = document.getElementById("hub-fallback");
  let home: string | null = null;
  try {
    home = await invoke<string | null>("resolve_home");
  } catch {
    home = null;
  }
  if (home && frame) {
    fallback?.setAttribute("hidden", "");
    frame.removeAttribute("hidden");
    applyBar(await barSpecFor(home));
    await loadArtifactInto(home, frame).catch((e) => console.error("hub load failed", e));
  } else {
    frame?.setAttribute("hidden", "");
    applyBar(null);
    renderHubFallback();
  }
}

/** The native L0 fallback shown until an agent authors home.html. */
function renderHubFallback(): void {
  const fallback = document.getElementById("hub-fallback");
  const hello = document.getElementById("hub-hello");
  const cta = document.getElementById("hub-sessions-btn");
  const clawd = document.getElementById("hub-clawd");
  if (clawd) mountClawd(clawd); // a fresh pixel-art clawd pose greets each idle landing
  if (hello) hello.innerHTML = `${timeGreeting()}, <em>Zach.</em>`;
  if (cta) {
    const hasWork = allSources.length > 0 || recentToShow().length > 0;
    cta.textContent = hasWork ? "Open recent sessions →" : "Start a session →";
  }
  fallback?.removeAttribute("hidden");
}

// ---- unit identity ----------------------------------------------------------

/** Parse a source's live JSON, defaulting to {} on garbage. */
function parseState(json: string): LiveState {
  try {
    return JSON.parse(json) as LiveState;
  } catch {
    return {};
  }
}

/**
 * The UNIT a source belongs to. The hook-emitted `unit_key` is AUTHORITATIVE
 * (the digest filename keys off it); we derive only as a fallback for pre-hook
 * sessions: a non-repo session is its own unit (its stem), a repo session keys
 * by its project slug so two agents in one repo collapse to one unit.
 */
function unitKeyOf(s: LiveSource): string {
  // A session belongs to its PROJECT, keyed by the project directory (the source's
  // `project` basename, NOT the stored unit_key — so plugin-cache drift in unit_key
  // can't split one project across units). This now applies to NON-repo dirs too: a
  // second `claude` opened in the same folder (e.g. `clipping`) must land in the
  // EXISTING unit, not clone a fresh tab per session. The stored non-repo unit_key
  // carries a per-session `--<shortid>` that used to split them; per-session identity
  // now lives in the rail's session switcher, not the unit key.
  return sourceProjectKey(s);
}

/** The absolute project dir for a unit — the `unit_dir` of any live source that
 *  belongs to it (all sessions in a repo unit share the same root). null when no
 *  source carries it (e.g. a pre-hook session), which disables "+ session". */
function unitDirOf(unitKey: string): string | null {
  for (const s of allSources) {
    if (unitKeyOf(s) !== unitKey) continue;
    const dir = parseState(s.json).unit_dir;
    if (dir) return dir;
  }
  return null;
}

/** unitKeyOf for a source slug (looks it up); falls back to the slug itself. */
function unitKeyOfSlug(slug: string): string {
  if (slug === UNSOURCED) return UNSOURCED;
  const s = allSources.find((x) => x.source === slug);
  return s ? unitKeyOf(s) : slug;
}

/** Bucket every live source by its unit. */
function groupSourcesByUnit(): Map<string, LiveSource[]> {
  const m = new Map<string, LiveSource[]>();
  for (const s of allSources) {
    const k = unitKeyOf(s);
    (m.get(k) ?? m.set(k, []).get(k)!).push(s);
  }
  return m;
}

/**
 * The UNIT an artifact belongs to — the single routing authority. An artifact
 * carries only a `project`. For a repo the unit key IS the project slug, so two
 * agents in one repo share one unit and the artifact lands there (no ambiguity).
 * Falls back to the unique non-repo instance's unit, else UNSOURCED.
 */
function unitForArtifact(a: ArtifactEntry): string {
  // Prefer the live SOURCE that wrote it: unitKeyOf derives the project unit, so an
  // artifact follows its session's unit even when the stored unit_key is stale
  // (plugin-cache drift split one repo across two keys). Falls through to the stored
  // key when the writing source is gone (closed session) — already project-correct.
  if (a.source) {
    const src = allSources.find((s) => s.source === a.source);
    if (src) return unitKeyOf(src);
  }
  // Authoritative for closed sessions: the hook stamped the writing session's unit
  // key at create time. Strip any non-repo `--<shortid>` discriminator (baseProjectOf)
  // so it matches the project-grouped unit key the rail now uses — a closed non-repo
  // session's artifact routes to its merged project unit, not an orphan. Repo keys are
  // bare slugs (no `--`), so baseProjectOf is a no-op there. Immune to the project-slug
  // ambiguity below and a volatile cwd.
  if (a.unit_key) return baseProjectOf(a.unit_key);
  // Fallback for un-indexed artifacts (hub/offsite/cron, or pre-hook): match by
  // the model-stamped project. Display-only metadata, kept only as a fallback.
  const key = projectSlug(a.project);
  if (!key) return UNSOURCED;
  // A repo unit's key === its project slug (the hook sets unit_key = slug). If any
  // live source maps to that unit, the artifact belongs to it — even with several.
  if (allSources.some((s) => unitKeyOf(s) === key)) return key;
  // Otherwise route to the unique source of this project (a bare session → its
  // own unit); ambiguous with no repo unit ⇒ Unsourced.
  const matches = allSources.filter((s) => sourceProjectKey(s) === key);
  return matches.length === 1 ? unitKeyOf(matches[0]) : UNSOURCED;
}

/** Bucket every artifact by its unit. Newest-first within each unit. */
function groupArtifactsByUnit(): Map<string, ArtifactEntry[]> {
  const m = new Map<string, ArtifactEntry[]>();
  for (const art of allArtifacts) {
    const k = unitForArtifact(art);
    (m.get(k) ?? m.set(k, []).get(k)!).push(art);
  }
  for (const list of m.values()) list.sort((a, b) => b.modified_ms - a.modified_ms);
  return m;
}

/** The SOURCE slug of the session currently shown in `unitKey`'s terminal — the
 *  active owned tab's live source. The hero scopes to this so it follows the active
 *  SESSION, not the unit: switching sessions swaps the artifact, and a session with
 *  no artifacts of its own shows a blank hero instead of a sibling's work. Returns
 *  null when that session isn't live yet (a just-launched tab, before its live file
 *  appears) or the unit has no owned terminal — either way the active session owns
 *  no artifacts, which is exactly the blank-hero state a fresh session should land on. */
function activeSessionSource(unitKey: string): string | null {
  const tab = ownedTabForUnit(unitKey);
  if (tab) {
    // A terminal IS bound this run: scope the hero to ITS session. A fresh session with
    // no live source yet ⇒ null ⇒ blank hero, never a sibling's artifact (the original
    // per-session-scoping intent — see renderHero).
    const src = allSources.find((s) => parseState(s.json).companion_session === tab);
    return src ? src.source : null;
  }
  // No owned terminal in THIS overlay instance — e.g. after an overlay restart, when the
  // in-memory `terminals` map is empty even though the session's artifacts persist on disk.
  // Fall back to the source that wrote the unit's most recent artifact so the hero shows
  // the freshest work instead of going blank. Only reachable when NO terminal is bound, so
  // it can't reintroduce the sibling-artifact bleed the scoping above prevents.
  const arts = groupArtifactsByUnit().get(unitKey) ?? [];
  const freshest = arts.reduce<ArtifactEntry | null>(
    (best, a) => (best === null || a.modified_ms > best.modified_ms ? a : best),
    null,
  );
  return freshest?.source ?? null;
}

/** A display name for a unit — the project name of its freshest source. */
function unitName(unitKey: string, sources: LiveSource[]): string {
  if (unitKey === UNSOURCED) return "Unsourced";
  const custom = unitNames.get(unitKey);
  if (custom) return custom; // user-assigned name wins over the folder/slug label
  const fresh = sources[0];
  return fresh ? (parseState(fresh.json).project || unitKey) : unitKey;
}


// ---- Recent sessions (resumable, from claude's transcripts) ------------------

/** Refresh the resumable-sessions list; re-render the roster if it's on screen. */
async function loadRecent(): Promise<void> {
  try {
    allRecent = await invoke<RecentSession[]>("list_recent_sessions", { limit: 40 });
  } catch (e) {
    console.error("list_recent_sessions failed", e);
    return;
  }
  rebuildHeartbeats();
  const v = currentView();
  if (v.level === "unit") renderUnitRail(v.unitKey);
}

/** Transcript-mtime heartbeat by session shortid (first 8 of the session_id),
 *  rebuilt whenever `allRecent` refreshes. Claude Code rewrites a session's
 *  transcript every turn — a FREE liveness signal needing no agent live.json
 *  rewrite — so a long-running session stays on the roster even after its live
 *  file goes stale. See `isLiveSource`. */
let heartbeatByShortId = new Map<string, number>();
/** First-prompt transcript title by session shortid — the STABLE identity a live
 *  session's rail row is labelled with (its volatile `working` line is the stub
 *  "Session started" until its agent writes real state). Rebuilt with the recents. */
let titleByShortId = new Map<string, string>();
function rebuildHeartbeats(): void {
  const m = new Map<string, number>();
  const t = new Map<string, string>();
  for (const r of allRecent) {
    const sid = r.session_id.slice(0, 8);
    if (r.last_active_ms > (m.get(sid) ?? 0)) m.set(sid, r.last_active_ms);
    if (r.title && !t.has(sid)) t.set(sid, r.title);
  }
  heartbeatByShortId = m;
  titleByShortId = t;
}

/** session_ids that are currently LIVE (owned sessions inject session_id into their live
 *  file) — excluded from Recent so a running session never also shows as "resumable". */
function liveSessionIds(): Set<string> {
  const set = new Set<string>();
  for (const s of allSources) {
    const st = parseState(s.json);
    // A closed-out (dismissed) session is no longer live — it belongs in Recent as
    // a rejoinable session, so don't let its lingering session_id exclude it there.
    if (st.dismissed === true) continue;
    if (st.session_id) set.add(st.session_id);
  }
  return set;
}

/** Empty/ghost transcripts (a session that registered but never did real work) are below
 *  this size — kept out of Recent so the band is only genuinely resumable work. */
const RECENT_MIN_BYTES = 1500;
const RECENT_MAX_ROWS = 8;

/** The resumable, non-live sessions to surface (newest-first from Rust, deduped + capped). */
function recentToShow(): RecentSession[] {
  const live = liveSessionIds();
  return allRecent
    .filter((r) => r.cwd && r.size_bytes >= RECENT_MIN_BYTES && !live.has(r.session_id))
    .slice(0, RECENT_MAX_ROWS);
}

/** Resume a closed session: spawn `claude --resume <id>` in its original cwd. Joins
 *  the project unit directly when it's already on the roster (no bottom-of-roster
 *  flash); otherwise a unique provisional that correlation re-homes — same rule as
 *  launchSessionIn. */
async function resumeRecentSession(rs: RecentSession): Promise<void> {
  const base = projectSlug(rs.project) || rs.cwd.split("/").filter(Boolean).pop() || "session";
  const existing = allSources.some((s) => unitKeyOf(s) === base);
  const provisional = existing ? base : `${base}~${++provisionalSeq}`;
  try {
    const tabId = await spawnOwnedSession(rs.cwd, provisional, rs.session_id);
    if (!existing) {
      pendingNavTab = tabId;
      pendingNavFresh = false; // a resume: keep the hero on the re-nav (don't skip the digest)
    }
    goUnit(provisional);
  } catch (e) {
    console.error("resume session failed", rs.session_id, e);
  }
}

type Band = "needs" | "run" | "idle";

interface Roster {
  byUnit: Map<string, LiveSource[]>;
  artsByUnit: Map<string, ArtifactEntry[]>;
  needs: string[];
  running: string[];
  idle: string[];
  /** needs ++ running ++ idle — priority order, shared by the roster + rail. */
  order: string[];
  bandOf: Map<string, Band>;
  liveCount: number;
}

/** The live roster, computed once and shared by the L1 Status Board and the L2
 *  rail: units with ≥1 live source plus Board-owned terminals (a session you
 *  launched here stays reachable even after its live file is gone). A unit you
 *  explicitly closed stays gone even if its owned terminal lingers. Classified
 *  by what you owe each: decision/blocked → needs; active agent → run; quiet
 *  owned terminal → idle. */
// ---- manual session order (drag-to-reorder, persisted) ---------------------

/** localStorage key holding the user's manual unit order (array of unit_keys).
 *  Board-local persistence, like the rail-collapse flag — survives relaunch. */
const ORDER_KEY = "companion:sessionOrder";

function loadOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
/** Sort `units` by the saved manual order; units with no saved position keep their
 *  incoming (default) order, after the placed ones (stable). */
function applyManualOrder(units: string[]): string[] {
  const order = loadOrder();
  const pos = (u: string): number => {
    const i = order.indexOf(u);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return units
    .map((u, i) => [u, i] as const)
    .sort((a, b) => pos(a[0]) - pos(b[0]) || a[1] - b[1])
    .map(([u]) => u);
}

function computeRoster(now: number): Roster {
  const byUnit = groupSourcesByUnit();
  const artsByUnit = groupArtifactsByUnit();

  const live = new Set<string>();
  for (const [unit, sources] of byUnit) {
    if (sources.some((s) => isLiveSource(s, now))) live.add(unit);
  }
  for (const ou of ownedUnits()) {
    const srcs = byUnit.get(ou) ?? [];
    if (srcs.length > 0 && srcs.every(isDismissed)) continue;
    if (!byUnit.has(ou)) byUnit.set(ou, []);
    live.add(ou);
  }

  const needs: string[] = [];
  const running: string[] = [];
  const idle: string[] = [];
  const bandOf = new Map<string, Band>();
  let liveCount = 0;
  for (const unit of live) {
    const sources = byUnit.get(unit) ?? [];
    const liveN = sources.filter((s) => isLiveSource(s, now)).length;
    liveCount += liveN;
    const band: Band = unitNeedsYou(sources, now) ? "needs" : liveN > 0 ? "run" : "idle";
    bandOf.set(unit, band);
    (band === "needs" ? needs : band === "run" ? running : idle).push(unit);
  }

  // Keep the per-band lists (still used for the dot colours via bandOf), but the rail
  // ORDER is now purely most-recent-first across all live units — the freshest project
  // is always on top, regardless of status. (Supersedes the old band-grouped order.)
  const oNeeds = applyManualOrder(needs);
  const oRunning = applyManualOrder(running);
  const oIdle = applyManualOrder(idle);
  const recencyOf = (unit: string): number => {
    const srcs = byUnit.get(unit) ?? [];
    // No live file yet → just-launched/owned, treat as freshest so it lands on top.
    if (srcs.length === 0) return now;
    return Math.max(...srcs.map((s) => Math.max(sourceUpdatedMs(s), sourceHeartbeatMs(s))));
  };
  const order = [...live].sort((a, b) => recencyOf(b) - recencyOf(a));
  return {
    byUnit,
    artsByUnit,
    needs: oNeeds,
    running: oRunning,
    idle: oIdle,
    order,
    bandOf,
    liveCount,
  };
}

/** Render the Sessions face of the unified rail — browser-style vertical tabs, one
 *  per live unit, in priority order. Clicking a tab swaps the pane to that session;
 *  the shell stays put. The frame itself is always present (it also hosts the ☰
 *  menu), so a single live session just shows its one tab. */
function renderUnitRail(activeUnitKey: string | null): void {
  if (!railSessionsEl) return;
  const now = Date.now();
  const { order, byUnit, bandOf } = computeRoster(now);
  const prevActiveUnit = lastRailActiveUnit;
  const unitChanged = activeUnitKey !== prevActiveUnit;
  lastRailActiveUnit = activeUnitKey;

  // On a project switch, grab the OUTGOING project's session group so it can animate
  // closed after the rebuild (replaceChildren would otherwise drop it instantly).
  const exitingGroup =
    unitChanged && prevActiveUnit
      ? (railSessionsEl.querySelector(".unit-subtab-group") as HTMLElement | null)
      : null;

  const nodes: HTMLElement[] = [];
  let newGroup: HTMLElement | null = null;

  for (const unit of order) {
    const sources = byUnit.get(unit) ?? [];
    const isActive = unit === activeUnitKey;
    const isExpanded = expandedActiveProject === unit;
    // A project's sessions are its LIVE ones plus its resumable (closed) siblings —
    // fold them together so a sibling doesn't vanish the moment one session goes live.
    // Computed for EVERY live project (not just the active one) so the chevron is
    // accurate before you've entered it: any multi-session project is a dropdown.
    const siblings = recentSiblingsFor(projectGroupKeyOf(unit, sources));
    const hasDrawer = sources.length + siblings.length > 1;
    nodes.push(buildRailTab(unit, sources, bandOf.get(unit) ?? "idle", isActive, hasDrawer, isExpanded));
    // Click a multi-session project to expand its session chooser inline (this does
    // NOT navigate — picking a session does); mirrors the Recent-project expander.
    // .opening adds the drop-in animation on a unit switch.
    if (hasDrawer && isExpanded) {
      const shownTab = ownedTabForUnit(unit);
      const group = document.createElement("div");
      group.className = "unit-subtab-group";
      const inner = document.createElement("div");
      inner.className = "unit-subtab-group-inner";
      for (const s of railSessionOrder(sources)) inner.appendChild(buildRailSessionRow(unit, s, shownTab));
      for (const rs of siblings) inner.appendChild(buildRecentSessionRow(rs));
      group.appendChild(inner);
      nodes.push(group);
      newGroup = group;
    }
  }

  // Recent (closed) projects — below live units, expand to session list on click.
  // Exclude by BASE project key: a project resumed under a provisional `~n` unit must
  // drop out of Recent immediately (not 5s later when correlation re-homes it), and
  // its siblings now live in the active unit's switcher above.
  const recentGroups = groupRecentByProject(new Set(order.map((u) => projectGroupKeyOf(u, byUnit.get(u)))));
  if (recentGroups.size > 0) {
    const divider = document.createElement("div");
    divider.className = "rail-section-head";
    divider.textContent = "Recent";
    nodes.push(divider);
    // Most-recent-first across projects too — each group's sessions are already sorted,
    // so its [0] is the project's freshest; order the projects by that.
    const recentByRecency = [...recentGroups.entries()].sort(
      (a, b) => (b[1][0]?.last_active_ms ?? 0) - (a[1][0]?.last_active_ms ?? 0),
    );
    for (const [projectKey, sessions] of recentByRecency) {
      const isExpanded = expandedRecentProject === projectKey;
      nodes.push(buildRecentProjectTab(projectKey, sessions, isExpanded));
      if (isExpanded) {
        const group = document.createElement("div");
        group.className = "unit-subtab-group";
        const inner = document.createElement("div");
        inner.className = "unit-subtab-group-inner";
        for (const rs of sessions.slice(0, 6)) inner.appendChild(buildRecentSessionRow(rs));
        group.appendChild(inner);
        nodes.push(group);
      }
    }
  }

  railSessionsEl.replaceChildren(...nodes);

  // Animate the incoming group's drop-down — a CSS keyframe (no rAF, runs even when
  // the Board isn't the key window). Only on a project switch, not on every poll.
  if (unitChanged && newGroup) newGroup.classList.add("opening");

  // Re-attach the outgoing group under its (still-present) project tab and play the
  // close keyframe, then remove — old sessions slide up as the new ones slide down.
  if (exitingGroup) {
    const oldTab = Array.from(railSessionsEl.querySelectorAll(".unit-tab")).find(
      (t) => (t as HTMLElement).dataset.unit === prevActiveUnit,
    ) as HTMLElement | undefined;
    if (oldTab) {
      exitingGroup.style.pointerEvents = "none"; // inert while collapsing
      exitingGroup.classList.remove("opening");
      exitingGroup.classList.add("closing");
      oldTab.insertAdjacentElement("afterend", exitingGroup);
      setTimeout(() => exitingGroup.remove(), 220);
    }
  }

}

/** Sessions of a project, most-recent first (matches resume-on-entry order). */
function railSessionOrder(sources: LiveSource[]): LiveSource[] {
  return [...sources].sort((a, b) => sourceUpdatedMs(b) - sourceUpdatedMs(a));
}

/** The SessionStart hook seeds (and re-seeds on every resume) a session's `working`
 *  line as this stub — so it can't be the switcher label, or every fresh/just-
 *  resumed session reads identically. */
const SESSION_STARTED_STUB = "Session started";

/** A STABLE, identifying label for a session sub-row. A switcher wants identity,
 *  not the volatile `working` line (the poll repaints the rail every turn). Prefer
 *  the session's first-prompt transcript title; fall back to a genuine working line;
 *  else it's a brand-new session with no identity yet. */
function sessionLabel(s: LiveSource): string {
  const title = titleByShortId.get(shortIdOfSource(s.source));
  const working = (parseState(s.json).working || "").trim();
  const raw = title || (working && working !== SESSION_STARTED_STUB ? working : "");
  const oneLine = raw.split("\n", 1)[0].trim();
  return oneLine ? clip(oneLine, 28) : "New session";
}

/** One session sub-row under the active project tab. Active = its bound terminal is
 *  the one currently shown. Click switches/resumes it (see switchToSession). */
function buildRailSessionRow(unitKey: string, s: LiveSource, shownTab: string | null): HTMLElement {
  const st = parseState(s.json);
  const tabId = st.companion_session ?? null;
  const active = tabId !== null && tabId === shownTab;
  const row = document.createElement("button");
  row.className = "unit-subtab" + (active ? " active" : "");
  row.dataset.session = s.source;
  row.title = `${sessionLabel(s)} — ${st.working || "session"}`;

  const dot = document.createElement("span");
  // `is-live`, NOT a bare `live` — `.live` is the live-pane container selector in
  // styles.css (position:absolute; inset:0; …) and would pull this 5px dot out of
  // flow, misaligning live rows against their closed siblings.
  dot.className = "unit-subtab-dot" + (isLiveSource(s, Date.now()) ? " is-live" : "");
  const name = document.createElement("span");
  name.className = "unit-subtab-name";
  name.textContent = sessionLabel(s);
  const time = document.createElement("span");
  time.className = "unit-subtab-time";
  time.textContent = relTimeShort(Math.max(sourceUpdatedMs(s), sourceHeartbeatMs(s)));
  row.append(dot, name, time);

  // Always clickable: even a session marked "active" here may belong to a project
  // you're not currently viewing (its dropdown was opened cross-unit) — pickSession
  // no-ops only when it's already the shown session of the current unit.
  row.addEventListener("click", () => pickSession(unitKey, s));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showRailSessionMenu(e, unitKey, s);
  });
  return row;
}

/** Pick a session from a project's rail dropdown: swap to that session but KEEP the
 *  chooser open, so you can rip through a project's sessions without re-opening the
 *  dropdown each time. Within the current unit it's a plain session swap; from a
 *  project you're NOT in, set the chosen session active FIRST, then navigate — so
 *  enterUnit lands directly on it (one hero render, no race with enterUnit's own
 *  resolve). For a live session showSessionInUnit reuses the existing terminal (no
 *  double-spawn). */
function pickSession(unitKey: string, s: LiveSource): void {
  // Keep this project's chooser expanded across the swap (don't collapse to null).
  expandedActiveProject = unitKey;
  if (currentUnitKey === unitKey) {
    switchToSession(unitKey, s); // re-renders the rail with the chooser still open
    return;
  }
  const st = parseState(s.json);
  void showSessionInUnit(unitKey, st.companion_session ?? null, st.session_id ?? null).then(() => {
    goUnit(unitKey); // enterUnit collapses the chooser on a fresh entry…
    expandedActiveProject = unitKey; // …so re-open it after landing and repaint the rail
    renderUnitRail(unitKey);
  });
}

/** The bare PROJECT-GROUP key for a unit key — the SAME key the Recent band groups
 *  by (see recentProjectKey), so an active unit can match its own recent siblings.
 *  Strips the provisional suffix (`~<n>`, minted by resumeRecentSession/launchSessionIn
 *  before correlation re-homes the unit) AND a non-repo unit's `--<shortid>`
 *  discriminator (8 chars, livepath.sh) — so `clipping--06327f95` reduces to `clipping`
 *  and folds in its closed siblings. Repo unit keys are already bare slugs (no `~`, no
 *  `--<shortid>`; slugs never contain `--`), so they pass through untouched. */
function baseProjectOf(unitKey: string): string {
  return unitKey.replace(/~\d+$/, "").replace(/--[A-Za-z0-9-]{8}$/, "");
}

/** The project-group key for a (possibly provisional) unit: prefer its live source's
 *  project basename — the robust, format-independent match against recentProjectKey —
 *  and fall back to baseProjectOf when the unit has no live source yet (the brief
 *  provisional window after a launch/resume, before its live file appears). */
function projectGroupKeyOf(unitKey: string, sources?: LiveSource[]): string {
  return sources && sources[0] ? sourceProjectKey(sources[0]) : baseProjectOf(unitKey);
}

/** The project key a RecentSession groups under — mirrors the repo-slug rule used by
 *  the rail's live units and resumeRecentSession's base. */
function recentProjectKey(rs: RecentSession): string {
  return projectSlug(rs.project) ?? rs.cwd.split("/").filter(Boolean).pop() ?? "session";
}

/** Whether a RecentSession is genuinely resumable: real cwd, substantial transcript,
 *  not already running live. Shared by the Recent band and the active-unit sibling fold
 *  so the two stay in lockstep — a just-resumed session won't double-count. */
function isResumableRecent(rs: RecentSession, live: Set<string>): boolean {
  return !!rs.cwd && rs.size_bytes >= RECENT_MIN_BYTES && !live.has(rs.session_id);
}

/** A project's resumable (closed) sessions, matched by its project-group key so they
 *  fold into the active unit's session switcher even during the provisional resume
 *  window. Sorted newest-first by last-active (so the rail's right-aligned times read
 *  top-to-bottom most-recent-first), capped — same dedup as the Recent band. */
function recentSiblingsFor(groupKey: string): RecentSession[] {
  const live = liveSessionIds();
  return allRecent
    .filter((rs) => isResumableRecent(rs, live) && recentProjectKey(rs) === groupKey)
    .sort((a, b) => b.last_active_ms - a.last_active_ms)
    .slice(0, 6);
}

/** Collect recent (closed) sessions grouped by project slug, excluding live units. */
function groupRecentByProject(excludeUnits: Set<string>): Map<string, RecentSession[]> {
  const live = liveSessionIds();
  const groups = new Map<string, RecentSession[]>();
  for (const rs of allRecent) {
    if (!isResumableRecent(rs, live)) continue;
    const key = recentProjectKey(rs);
    if (excludeUnits.has(key)) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(rs);
  }
  // Most-recent-first within each project, so the rail's session times descend.
  for (const list of groups.values()) list.sort((a, b) => b.last_active_ms - a.last_active_ms);
  return groups;
}

/** Rail tab for a recent (closed) project — expands/collapses session list on click,
 *  does NOT navigate the main pane. */
function buildRecentProjectTab(projectKey: string, sessions: RecentSession[], expanded: boolean): HTMLElement {
  const tab = document.createElement("button");
  tab.className = "unit-tab recent-project" + (expanded ? " expanded" : "");
  tab.dataset.unit = projectKey;
  tab.title = `${projectKey} — ${sessions.length} recent session${sessions.length === 1 ? "" : "s"}`;

  const dot = document.createElement("span");
  dot.className = "unit-tab-dot idle";
  const mark = document.createElement("span");
  mark.className = "unit-tab-mark";
  mark.textContent = markFor(projectKey);
  const nameEl = document.createElement("span");
  nameEl.className = "unit-tab-name";
  nameEl.textContent = projectKey;
  const chevron = document.createElement("span");
  chevron.className = "unit-tab-chevron";
  chevron.textContent = expanded ? "▾" : "▸";
  tab.append(dot, mark, nameEl, chevron);

  tab.addEventListener("click", () => {
    expandedRecentProject = expanded ? null : projectKey;
    renderUnitRail(currentUnitKey);
  });
  tab.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showRecentProjectMenu(e, sessions);
  });
  return tab;
}

/** One recent (closed) session sub-row. Click resumes it. */
function buildRecentSessionRow(rs: RecentSession): HTMLElement {
  const row = document.createElement("button");
  row.className = "unit-subtab";
  row.title = `Resume — ${rs.cwd}`;

  const dot = document.createElement("span");
  dot.className = "unit-subtab-dot";
  const name = document.createElement("span");
  name.className = "unit-subtab-name";
  // With a title, the name carries identity and the time column shows recency; with
  // none, fall the time INTO the name (no duplicate column) — same as before.
  name.textContent = rs.title || relTime(rs.last_active_ms);
  row.append(dot, name);
  if (rs.title) {
    const time = document.createElement("span");
    time.className = "unit-subtab-time";
    time.textContent = relTimeShort(rs.last_active_ms);
    row.append(time);
  }

  row.addEventListener("click", () => void resumeRecentSession(rs));
  return row;
}

/** Switch the active project's shown terminal to a specific session, resuming it by
 *  id if the Board owns it but its terminal is gone. External sessions (no id) just
 *  leave the hero/state visible — never a duplicate spawn. */
function switchToSession(unitKey: string, s: LiveSource): void {
  const st = parseState(s.json);
  void showSessionInUnit(unitKey, st.companion_session ?? null, st.session_id ?? null).then(() => {
    if (currentUnitKey === unitKey) {
      renderUnitRail(unitKey);
      // The hero follows the now-active session. A click is the ONLY sanctioned
      // hero reload while a unit is live (the poll never reloads it — see the
      // sticky-hero note on ingestIntoUnit), so this can't wipe a comment the user
      // was mid-typing: they chose to move to another session.
      void renderHero(unitKey);
    }
  });
}


/** One rail tab: a state dot, the unit's mark, its name, an unread badge. A
 *  multi-session project owns a session-chooser drawer: clicking it toggles that
 *  drawer (chevron reflects state) and does NOT navigate — you pick a session to
 *  move in (same affordance as a recent project). A single-session project has
 *  nothing to choose, so clicking it drills straight in. */
function buildRailTab(
  unitKey: string,
  sources: LiveSource[],
  band: Band,
  active: boolean,
  hasDrawer = false,
  expanded = false,
): HTMLElement {
  const head = sources[0] ? makeHead(sources[0]) : ownedHead();
  const name = unitName(unitKey, sources);
  const tab = document.createElement("button");
  tab.className = "unit-tab" + (active ? " active" : "");
  tab.dataset.unit = unitKey;
  const work = sources[0]
    ? parseState(sources[0].json).working || parseState(sources[0].json).next?.[0]?.title || "Idle"
    : "Launched from the Board";
  tab.title = `${name} — ${work}`;

  const dot = document.createElement("span");
  dot.className = `unit-tab-dot ${band}`;
  const mark = document.createElement("span");
  mark.className = "unit-tab-mark" + (head.isCloud ? " cloud" : "");
  mark.textContent = head.mark;
  const nameEl = document.createElement("span");
  nameEl.className = "unit-tab-name";
  nameEl.textContent = name;
  tab.append(dot, mark, nameEl);

  const unread = unreadCount(unitKey);
  if (unread > 0) {
    const badge = document.createElement("span");
    badge.className = "unit-tab-unread";
    badge.textContent = unread > 9 ? "9+" : String(unread);
    tab.append(badge);
  }

  if (hasDrawer) {
    tab.classList.toggle("expanded", expanded);
    const chevron = document.createElement("span");
    chevron.className = "unit-tab-chevron";
    chevron.textContent = expanded ? "▾" : "▸";
    chevron.title = expanded ? "Hide sessions" : "Show sessions";
    // The chevron toggles THIS project's session switcher inline WITHOUT navigating
    // (collapsing any other open one). stopPropagation keeps the tab-body click below
    // from also firing — so you can peek at the sessions without leaving where you are.
    chevron.addEventListener("click", (e) => {
      e.stopPropagation();
      expandedActiveProject = expanded ? null : unitKey;
      renderUnitRail(currentUnitKey);
    });
    tab.append(chevron);
  }
  // Active multi-session: clicking the tab body toggles the session drawer so you can
  // pick a session (same as the chevron — the whole tab is the affordance). Active
  // single-session: no-op (already there). Inactive: navigate into the freshest session.
  if (active && hasDrawer) {
    tab.addEventListener("click", () => {
      expandedActiveProject = expanded ? null : unitKey;
      renderUnitRail(currentUnitKey);
    });
  } else if (!active) {
    tab.addEventListener("click", () => goUnit(unitKey));
  }
  tab.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showUnitMenu(e, unitKey, sources);
  });
  return tab;
}

/** The freshest live source blocked on you (top next-step is a decision/blocked),
 *  or null. Drives both the band split and the row's decision chip, so the chip
 *  always names the source that actually needs you (not just sources[0]). Note
 *  levelFromKind maps "decision"→idle, so we read the raw kind here. */
function blockingNextOf(sources: LiveSource[], now: number): NextItem | null {
  for (const s of sources) {
    if (!isLiveSource(s, now)) continue;
    const top = parseState(s.json).next?.[0];
    const kind = (top?.kind || "").toLowerCase();
    if (top && (kind === "decision" || kind === "blocked")) return top;
  }
  return null;
}

function unitNeedsYou(sources: LiveSource[], now: number): boolean {
  return blockingNextOf(sources, now) !== null;
}

/** Right-click context menu for a session card: open it, or close it out (end its
 *  Board-launched terminal + drop it to Recent, where it stays one click from a
 *  `claude --resume`). One menu at a time; dismissed on any outside click, Esc, or
 *  scroll. The hover ✕ does the same close; this is the discoverable right-click. */
interface CtxItem { label: string; fn: () => void; danger?: boolean; }

/** Open a small right-click context menu at the event position. Closes on pick,
 *  outside-click, Esc, or scroll. Shared by the rail's unit / session / recent-
 *  project menus so the scaffolding lives in one place. No-op on empty items. */
function openCtxMenu(e: MouseEvent, items: CtxItem[]): void {
  if (items.length === 0) return;
  document.querySelector(".ctx-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";

  const close = (): void => {
    menu.remove();
    document.removeEventListener("mousedown", onDoc, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", close, true);
  };
  const onDoc = (ev: MouseEvent): void => {
    if (!menu.contains(ev.target as Node)) close();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") close();
  };

  for (const { label, fn, danger } of items) {
    const it = document.createElement("button");
    it.className = "ctx-item" + (danger ? " danger" : "");
    it.textContent = label;
    it.addEventListener("click", (ev) => {
      ev.stopPropagation();
      close();
      fn();
    });
    menu.append(it);
  }

  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  // Mount inside .stage so it inherits the board's warm design tokens (it's
  // position:fixed, so the parent doesn't affect where it lands).
  (document.querySelector(".stage") ?? document.body).append(menu);
  // Clamp to the viewport so a card near the edge doesn't push the menu off-screen.
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = `${window.innerWidth - r.width - 8}px`;
  if (r.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - r.height - 8}px`;

  setTimeout(() => {
    document.addEventListener("mousedown", onDoc, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
  }, 0);
}

function showUnitMenu(e: MouseEvent, unitKey: string, sources: LiveSource[]): void {
  const dir = unitDirOf(unitKey);
  openCtxMenu(e, [
    { label: "Open", fn: () => goUnit(unitKey) },
    ...(dir ? [{ label: "New session here", fn: () => void launchSessionIn(dir) }] : []),
    { label: "Close out", fn: () => void closeUnit(unitKey, sources), danger: true },
  ]);
}

/** Truncate a chip label so a long next-step can't blow out the row width. */
function clip(s: string, n = 46): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** Inline-edit a unit's display name. The editor is a floating input positioned
 *  over the card's name (NOT nested in the card <button>, which would swallow
 *  focus/keys); Enter saves, Esc cancels, blur saves. Persists to unit-names.json
 *  via `set_unit_name` (blank clears the override) and re-renders the roster. */
function startRename(unitKey: string, anchorEl: HTMLElement, onSaved?: () => void): void {
  if (document.querySelector(".name-edit")) return; // one editor at a time
  const rect = anchorEl.getBoundingClientRect();
  const input = document.createElement("input");
  input.className = "name-edit";
  input.value = unitNames.get(unitKey) ?? anchorEl.textContent ?? "";
  input.setAttribute("aria-label", "Session name");
  input.style.left = `${Math.round(rect.left)}px`;
  input.style.top = `${Math.round(rect.top)}px`;
  input.style.minWidth = `${Math.max(Math.round(rect.width), 150)}px`;
  // Append inside .stage so the input inherits the design tokens (they hang on
  // .stage, not :root/body — on <body> the input would render transparent).
  stageEl.append(input);

  let done = false;
  const finish = (save: boolean): void => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    input.remove();
    if (save) {
      if (v) unitNames.set(unitKey, v);
      else unitNames.delete(unitKey);
      void invoke("set_unit_name", { unitKey, name: v }).catch((e) =>
        console.error("set_unit_name failed", e),
      );
      renderUnitRail(currentUnitKey); // refresh the rail's tab labels
      onSaved?.(); // let the caller refresh any other surface (e.g. the L2 title)
    }
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

/** Close a unit off the live roster. Ends any Board-launched terminal in it (so
 *  its `claude` can't keep running) and dismisses every source so it drops to
 *  Archived everywhere (Board, popover, tray). A Board session stays rejoinable
 *  via its preserved session id; an external one is just hidden, restorable. */
async function closeUnit(unitKey: string, sources: LiveSource[]): Promise<void> {
  endOwnedTerminalsForUnit(unitKey);
  await Promise.all(
    sources.map((s) =>
      invoke("dismiss_session", { source: s.source }).catch((e) =>
        console.error("dismiss_session failed", s.source, e),
      ),
    ),
  );
  // Reflect the dismiss locally so the roster updates before the next poll.
  for (const s of sources) {
    const st = parseState(s.json);
    st.dismissed = true;
    s.json = JSON.stringify(st);
  }
  renderUnitRail(currentUnitKey);
}

/** Close a single session off the roster, leaving other sessions in its unit intact.
 *  Ends the Board-owned terminal for this specific session (if any), dismisses its
 *  source, and navigates back if this was the unit's last live session. */
async function closeSession(unitKey: string, s: LiveSource): Promise<void> {
  const st = parseState(s.json);
  const tabId = st.companion_session;
  if (tabId) closeOwnedTerminal(tabId);
  await invoke("dismiss_session", { source: s.source }).catch((e) =>
    console.error("dismiss_session failed", s.source, e),
  );
  st.dismissed = true;
  s.json = JSON.stringify(st);
  const remaining = (groupSourcesByUnit().get(unitKey) ?? []).filter(
    (src) => src.source !== s.source && !isDismissed(src),
  );
  if (remaining.length === 0) {
    void goHub();
  } else {
    if (currentUnitKey === unitKey) renderUnitRail(unitKey);
  }
}

/** Context menu for a session sub-row in the rail: switch to it or close just this session. */
function showRailSessionMenu(e: MouseEvent, unitKey: string, s: LiveSource): void {
  openCtxMenu(e, [
    { label: "Switch to", fn: () => switchToSession(unitKey, s) },
    { label: "Close session", fn: () => void closeSession(unitKey, s), danger: true },
  ]);
}

/** Context menu for a recent (closed) PROJECT tab: start a fresh session in its
 *  directory without first clicking into it — the common "just give me a claude in
 *  my last project" path, reachable right from the idle launch screen. */
function showRecentProjectMenu(e: MouseEvent, sessions: RecentSession[]): void {
  const dir = sessions.find((s) => s.cwd)?.cwd;
  if (!dir) return;
  openCtxMenu(e, [{ label: "New session here", fn: () => void launchSessionIn(dir) }]);
}

// ---- L2 unit home (hero + history) ------------------------------------------

/** Enter L2: clear the unit's unread, render its hero surface + history. */
function enterUnit(unitKey: string): void {
  clearUnread(unitKey);
  pendingIngest.delete(unitKey);
  updateGlobalUnread();
  expandedActiveProject = null; // a fresh entry collapses any chooser — click a tab to reveal (like Recent)
  focusPath = null;
  currentUnitKey = unitKey;
  // Always land on the Sessions face / Session view / split surfaces on entry.
  unitEl.dataset.rail = "sessions";
  unitEl.dataset.view = "session";
  unitEl.dataset.focus = "split";
  renderUnitRail(unitKey);
  renderUnitTitle(unitKey);
  void renderHero(unitKey);
  renderHistory(unitKey);
  // Reveal this unit's Board-owned terminal. A unit is one specific session, so
  // entry never FRESH-spawns: an existing Board terminal shows immediately; a
  // Board-launched session whose terminal is gone (e.g. after a Board restart) is
  // RESUMED (same id ⇒ same unit ⇒ reusable); an external session has no terminal
  // the Board can attach to, so it shows its hero + history only.
  void ensureAndShowTerminal(unitKey);
}

/** Reveal the unit's terminal. Resume a Board-launched session if its terminal is
 *  missing in THIS process; never fresh-spawn (that would clone — see
 *  ensureOwnedTerminal) and never spawn for an external session (no resume id). */
async function ensureAndShowTerminal(unitKey: string): Promise<void> {
  if (!ownedTabForUnit(unitKey)) {
    const resumeId = resumableSessionFor(unitKey);
    if (resumeId) await ensureOwnedTerminal(unitKey, resumeId);
    // No resume id ⇒ external session running in the user's own terminal: the
    // Board can't attach to a PTY it doesn't own, so it shows the unit's state
    // only and NEVER spawns a duplicate claude (the hook's documented intent).
  }
  if (currentUnitKey === unitKey) showOwnedTerminals(unitKey);
}

/** The resumable Claude session id for a unit, or null. Present only for sessions
 *  the Board launched (session-ids.json is hook-guarded on COMPANION_SESSION), so
 *  this cleanly gates resume-on-entry: Board-launched ⇒ resume; external ⇒ never. */
function resumableSessionFor(unitKey: string): string | null {
  // Project-units: a unit can hold several sessions — consider the MOST-RECENT one for
  // resume on entry (by updated_ms ∪ heartbeat). Resuming by its id keeps the id ⇒ it
  // binds back to this same unit ⇒ no clone. (Per-session switching lives in the rail.)
  const now = Date.now();
  let best: { id: string; ms: number } | null = null;
  for (const s of allSources) {
    if (unitKeyOf(s) !== unitKey) continue;
    const id = parseState(s.json).session_id;
    if (!id) continue;
    const ms = Math.max(sourceUpdatedMs(s), sourceHeartbeatMs(s));
    if (!best || ms > best.ms) best = { id, ms };
  }
  if (!best) return null;
  // Don't auto-resume a session that's STILL RUNNING. A fresh live-file / transcript
  // heartbeat means a claude is actively writing this session — in the user's own
  // terminal, or another overlay instance that owns its PTY. Resuming would spawn a
  // SECOND claude on one transcript (corruption). Show the unit's hero read-only instead
  // (renderHero falls back to the freshest artifact); the rail still offers an explicit
  // resume if the terminal is genuinely gone. Only auto-resume a session idle past the
  // guard window — that's safely closed, not live.
  if (now - best.ms < RESUME_LIVE_GUARD_MS) return null;
  return best.id;
}

/** Tear down L2 state when leaving a unit. Clears any L2 hero bar theming so a
 *  themed unit can't leak its bar onto the native L1/L0 chrome (renderHero /
 *  renderHub re-apply when they're entered). */
function leaveUnit(): void {
  currentUnitKey = null;
  closeFocus();
  hideHeroNewPill();
  dismissBoardSubmitted(); // never leave the "On it" splash mounted across nav
  if (unitEl) {
    unitEl.dataset.rail = "sessions";
    unitEl.dataset.view = "session";
    unitEl.dataset.focus = "split";
    unitEl.classList.remove("no-hero");
    unitEl.classList.remove("blank-hero");
    unitEl.classList.remove("is-idle");
    unitEl.classList.remove("has-sessions");
  }
  historyEl?.replaceChildren();
  digestEl?.setAttribute("hidden", "");
  digestPath = null;
  applyBar(null);
  focusPath = null;
  // Hide (NEVER dispose) the owned terminals — their PTYs must stay alive across
  // navigation. The mounts persist in #unit-terminals; only visibility changes.
  hideOwnedTerminals();
}

/**
 * The unit's HERO — its lead surface, shown large at the top of the unit home
 * (history sits below). Prefers the durable, agent-authored digest
 * `home.<unit_key>.html`; absent ⇒ falls back to the unit's most recent
 * artifact, so opening a unit always lands on its latest work at full size.
 * An empty unit (no digest, no artifacts) ⇒ the iframe is hidden and history
 * carries its empty state. Progressive enhancement, exactly like the L0 Hub.
 */
async function renderHero(unitKey: string): Promise<void> {
  hideHeroNewPill(); // entry/refresh lands on the newest → any pending is moot
  // A just-launched/resumed session lands on its TERMINAL — skip the project digest
  // so there's no ~1s iframe load + blank-then-paint flash. Synchronous (no await
  // before the return) so focus flips split→terminal in one tick. Cleared on consume,
  // so a later NORMAL entry to the same unit re-resolves the hero as usual.
  if (freshLaunchUnit === unitKey) {
    freshLaunchUnit = null;
    digestPath = null;
    applyBar(null);
    digestEl.setAttribute("hidden", "");
    // A fresh session with no artifact of its own → show the waiting clawd band; a
    // resumed session that already has artifacts lands on its terminal (skip the digest
    // iframe load flash, as before). The band is native DOM, so it adds no flash.
    const flSrc = activeSessionSource(unitKey);
    const flHasArt = flSrc
      ? (groupArtifactsByUnit().get(unitKey) ?? []).some((a) => a.source === flSrc)
      : false;
    if (flHasArt) syncSurfaceStrip(false);
    else showBlankHero();
    return;
  }
  let home: string | null = null;
  if (unitKey !== UNSOURCED) {
    try {
      home = await invoke<string | null>("resolve_unit_home", { unitKey });
    } catch {
      home = null;
    }
  }
  // A late resolve from a unit we've since left must not paint here.
  const v = currentView();
  if (v.level !== "unit" || v.unitKey !== unitKey) return;

  if (home) {
    digestEl.removeAttribute("hidden");
    syncSurfaceStrip(true);
    applyBar(await barSpecFor(home));
    digestPath = home;
    await loadArtifactInto(home, digestEl).catch((e) => console.error("hero digest load failed", e));
    return;
  }

  // No digest — lead with the ACTIVE SESSION's most recent artifact. The hero
  // follows the session shown in the terminal (matched by source slug), not the
  // unit: a session just launched into an existing project has no artifacts of its
  // own → blank hero, never a sibling session's last artifact (the reported bug).
  applyBar(null);
  const src = activeSessionSource(unitKey);
  const arts = src
    ? (groupArtifactsByUnit().get(unitKey) ?? []).filter((a) => a.source === src)
    : [];
  const latest = arts.reduce<ArtifactEntry | null>(
    (best, a) => (best === null || a.modified_ms > best.modified_ms ? a : best),
    null,
  );
  if (latest) {
    digestEl.removeAttribute("hidden");
    syncSurfaceStrip(true);
    digestPath = latest.path;
    await loadArtifactInto(latest.path, digestEl).catch((e) =>
      console.error("hero artifact load failed", e),
    );
  } else {
    // The active session owns no artifact (and there's no unit home): blank the hero.
    // Reset digestPath HERE (not at the top of the function — that would expose a
    // transient null across the resolve_unit_home await for a concurrent poll to act
    // on). Without this, switching from a session WITH an artifact to a blank one
    // leaves digestPath pointing at the prior session's artifact, so the new session's
    // first artifact would mis-route to the "new artifact" pill instead of auto-lighting,
    // and maybeLightBlankHero (which guards on digestPath === null) would never fire.
    showBlankHero();
  }
}

/** Re-resolve a BLANK hero once the active session gains a paint-worthy artifact
 *  THROUGH A PATH THAT FIRES NO ARTIFACT-INGEST — chiefly a resumed session whose
 *  artifacts already existed on disk (so the set never "changes") and, for a repo,
 *  binds straight to its provisional unit (so there's no re-nav to repaint either).
 *  Cheap-guarded so the poll only pays the renderHero invoke when there's actually
 *  something to show; honours the sticky-hero rule by acting ONLY while the hero is
 *  blank (digestPath === null), so a genuinely-new session with no artifacts stays
 *  blank and nothing the user is reading gets reloaded. */
function maybeLightBlankHero(unitKey: string): void {
  if (digestPath !== null) return;
  const src = activeSessionSource(unitKey);
  if (!src) return;
  if (allArtifacts.some((a) => a.source === src && unitForArtifact(a) === unitKey)) {
    void renderHero(unitKey);
  }
}

/** Reveal the "new artifact → view" pill over the sticky hero. `path` is the
 *  newest unseen artifact for the on-screen unit; clicking advances the hero to it.
 *  Passive by design — the poll never reloads the hero itself (see ingestIntoUnit),
 *  so a newer artifact for the unit you're already in can't silently vanish into
 *  history. */
function showHeroNewPill(path: string): void {
  heroPendingPath = path;
  heroNewEl?.removeAttribute("hidden");
}

function hideHeroNewPill(): void {
  heroPendingPath = null;
  heroNewEl?.setAttribute("hidden", "");
}

/** User-initiated hero advance: load the pending artifact into the hero. This is
 *  the ONLY sanctioned hero reload while a unit is live (a click, not the poll), so
 *  it can't wipe a comment the user was mid-typing — they chose to move on. Mirrors
 *  renderHero's plain-artifact branch. */
async function viewHeroPending(): Promise<void> {
  const path = heroPendingPath;
  hideHeroNewPill();
  if (!path || currentView().level !== "unit") return;
  digestEl.removeAttribute("hidden");
  syncSurfaceStrip(true);
  applyBar(null);
  digestPath = path;
  markArtifactRead(path);
  await loadArtifactInto(path, digestEl).catch((e) =>
    console.error("hero advance load failed", path, e),
  );
  updateGlobalUnread();
}

/** A clickable artifact row — the history list. */
function buildArtRow(a: ArtifactEntry): HTMLElement {
  const row = document.createElement("div");
  row.className = "art-row";
  row.dataset.artPath = a.path;

  if (Date.now() - a.modified_ms < FRESH_WINDOW_MS) {
    const d = document.createElement("span");
    d.className = "art-row-dot";
    row.append(d);
  }

  const main = document.createElement("div");
  main.className = "art-row-main";
  const title = document.createElement("div");
  title.className = "art-row-title";
  title.textContent = a.title || "artifact";
  main.append(title);
  const sub = a.subject || a.summary;
  if (sub) {
    const subEl = document.createElement("div");
    subEl.className = "art-row-sub";
    subEl.textContent = sub;
    main.append(subEl);
  }
  row.append(main);

  const time = document.createElement("span");
  time.className = "art-row-time";
  time.textContent = relTime(a.modified_ms);
  row.append(time);
  return row;
}

/** Render the HISTORY — the unit's artifacts as a readable text list (no iframes). */
function renderHistory(unitKey: string): void {
  const arts = groupArtifactsByUnit().get(unitKey) ?? [];
  const frag = document.createDocumentFragment();
  const head = document.createElement("div");
  head.className = "history-head";
  head.textContent = arts.length
    ? `History · ${arts.length} artifact${arts.length === 1 ? "" : "s"}`
    : "History";
  frag.append(head);
  if (arts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "No artifacts yet — they'll appear here as agents author them.";
    frag.append(empty);
  } else {
    for (const a of arts) frag.append(buildArtRow(a));
  }
  historyEl.replaceChildren(frag);
}

// ---- history clicks ---------------------------------------------------------

function wireHistoryClicks(): void {
  historyEl.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest("[data-art-path]") as HTMLElement | null;
    if (row?.dataset.artPath) void openReader(row.dataset.artPath);
  });
}

// ---- L2 chrome: the unified rail (sessions ⇄ menu) + hero collapse ----------

/** Flip the rail between its Sessions face and its Menu face. Returning to the
 *  Sessions face also restores the main pane to the session (the tabs imply you
 *  are looking at a session, not at History/Settings). */
function setRailMode(mode: "sessions" | "menu"): void {
  if (!unitEl) return;
  unitEl.dataset.rail = mode;
  if (mode === "sessions") unitEl.dataset.view = "session";
}

/** Swap the main pane to a nav destination. History/Settings keep the Menu face
 *  open so the user can hop between destinations; "session" is the Sessions home. */
function setUnitView(view: "session" | "history" | "settings"): void {
  if (!unitEl) return;
  unitEl.dataset.view = view;
  if (view !== "session") unitEl.dataset.rail = "menu";
  if (view === "history" && currentUnitKey) renderHistory(currentUnitKey);
}

/** Wire the ☰ menu toggle, the Sessions/History/Settings nav, and the floating
 *  surface controls (resize the stacked artifact + terminal, plus end the session). */
function wireUnitChrome(): void {
  menuToggleEl = document.getElementById("unit-menu-toggle");
  controlsEl = document.getElementById("unit-surface-controls");

  // ☰ flips the rail's two faces. In Menu mode the nav rows take over.
  menuToggleEl?.addEventListener("click", () =>
    setRailMode(unitEl.dataset.rail === "menu" ? "sessions" : "menu"),
  );

  // Menu nav: each destination takes over the main pane.
  railEl?.addEventListener("click", (e) => {
    const nav = (e.target as HTMLElement).closest<HTMLElement>(".rail-nav");
    const dest = nav?.dataset.dest;
    if (dest === "sessions") setRailMode("sessions");
    else if (dest === "history") setUnitView("history");
    else if (dest === "settings") setUnitView("settings");
  });

  // Floating controls: resize (⬒/⊟/⬓) + ✕ end session.
  controlsEl?.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const f = t.closest<HTMLElement>(".surface-focus")?.dataset.focus;
    if (f === "split" || f === "artifact" || f === "terminal") { setFocus(f); return; }
    if (t.closest("#unit-term-close")) endSession();
  });
  // Each tucked surface restores on click via its warm pill.
  document.getElementById("unit-artifact-pill")?.addEventListener("click", () => setFocus("split"));
  document.getElementById("unit-terminal-pill")?.addEventListener("click", () => setFocus("split"));
  heroNewEl?.addEventListener("click", () => void viewHeroPending());

  // The in-session title doubles as a rename affordance — rename without leaving
  // the unit. onSaved re-renders the title in place (startRename refreshes the
  // rail tabs, but not this toolbar title, so the caller patches it).
  unitTitleEl = document.getElementById("unit-title");
  unitTitleEl?.addEventListener("click", () => {
    if (!currentUnitKey || currentUnitKey === UNSOURCED || currentUnitKey === IDLE) return;
    const nameEl = unitTitleEl?.querySelector(".unit-title-name") as HTMLElement | null;
    if (nameEl) startRename(currentUnitKey, nameEl, () => renderUnitTitle(currentUnitKey!));
  });

  // Collapse / expand the left rail to reclaim space, via a SINGLE toolbar toggle: the
  // rail folds away when collapsed, so the control must live outside it (« hides, »
  // shows — same spot in both states). Persisted so it survives reloads.
  const railToggle = document.getElementById("unit-rail-toggle");
  const paintRailToggle = (c: boolean): void => {
    if (!railToggle) return;
    railToggle.textContent = c ? "»" : "«";
    const label = c ? "Show sidebar" : "Hide sidebar";
    railToggle.title = label;
    railToggle.setAttribute("aria-label", label);
  };
  const setRailCollapsed = (c: boolean): void => {
    if (!unitEl) return;
    if (c) unitEl.dataset.railCollapsed = "1";
    else delete unitEl.dataset.railCollapsed;
    paintRailToggle(c);
    try {
      localStorage.setItem("companion:railCollapsed", c ? "1" : "0");
    } catch {
      /* non-fatal */
    }
    fitShownTerminal(); // the pane just grew/shrank — refit the terminal to it
  };
  railToggle?.addEventListener("click", () => setRailCollapsed(unitEl?.dataset.railCollapsed !== "1"));
  try {
    const collapsed = localStorage.getItem("companion:railCollapsed") === "1";
    if (unitEl) {
      if (collapsed) unitEl.dataset.railCollapsed = "1";
      else delete unitEl.dataset.railCollapsed;
    }
    paintRailToggle(collapsed); // restore glyph without refitting at wiring time
  } catch {
    /* non-fatal */
  }
}

/** Paint the L2 toolbar title with the unit's display name (custom override or
 *  project/slug). Hidden for the Unsourced bucket (nothing to rename). */
function renderUnitTitle(unitKey: string): void {
  if (!unitTitleEl) return;
  if (unitKey === UNSOURCED || unitKey === IDLE) {
    unitTitleEl.hidden = true;
    return;
  }
  const sources = groupSourcesByUnit().get(unitKey) ?? [];
  const nameEl = unitTitleEl.querySelector(".unit-title-name") as HTMLElement | null;
  if (nameEl) nameEl.textContent = unitName(unitKey, sources);
  unitTitleEl.hidden = false;
}

/** Size the two stacked surfaces. "split" shares the pane; "artifact" grows the
 *  hero and tucks the terminal to its warm bar; "terminal" grows the terminal and
 *  tucks the artifact to its pill. The terminal collapse reuses its own refit. */
function setFocus(state: "split" | "artifact" | "terminal"): void {
  if (!unitEl) return;
  unitEl.dataset.focus = state;
  setTerminalCollapsed(state === "artifact");
  // Expanding the terminal (split / focus-terminal) can grow its box without a
  // collapse toggle — fit promptly rather than waiting on the debounced observer.
  if (state !== "artifact") fitShownTerminal();
}

/** End the current unit's shown terminal (the floating ✕). If nothing's left to
 *  show here, leave to the roster — a unit with no session has nothing to stay for
 *  (re-entering a unit that still exists in the roster will auto-start a fresh one). */
function endSession(): void {
  if (!currentUnitKey) return;
  const leaving = currentUnitKey;
  endShownTerminal();
  // Nothing left to show here → hop to the next live unit; fall to the hub only if
  // no unit remains.
  if (!ownedTabForUnit(leaving)) {
    const next = computeRoster(Date.now()).order.find((u) => u !== leaving);
    if (next) goUnit(next);
    else void goHub();
  }
}

/** Reflect whether there's a hero to size against: with no hero the strip + pill
 *  hide and the terminal owns the pane; with one, reset to the split default. */
function syncSurfaceStrip(hasHero: boolean): void {
  if (!unitEl) return;
  unitEl.classList.toggle("no-hero", !hasHero);
  if (hasHero) unitEl.classList.remove("blank-hero"); // an artifact arrived → drop the waiting band
  setFocus(hasHero ? "split" : "terminal");
}

/** Copy for the waiting-clawd band. Default = a session waiting for its FIRST
 *  artifact (terminal below). BLANK_IDLE = the idle home, where nothing's running. */
const BLANK_FIRST = {
  title: "Clawd's on it.",
  sub: "Your first artifact will land right here — the terminal's below while it works.",
};
const BLANK_IDLE = {
  title: "Nothing running right now.",
  sub: "Pick a project from the rail, or start a new session to begin.",
};

/** A session with no artifact yet: seat a fresh pixel-art clawd in the hero slot (the
 *  splash, for the FIRST artifact) with the terminal below — instead of a blank void.
 *  Native DOM (no iframe), so there's no load flash. Cleared by syncSurfaceStrip(true)
 *  the moment a real artifact lands, and by leaveUnit on exit. The idle home reuses it
 *  with BLANK_IDLE copy (no terminal, nothing working). */
function showBlankHero(copy: { title: string; sub: string } = BLANK_FIRST): void {
  digestPath = null;
  digestEl.setAttribute("hidden", "");
  hideHeroNewPill();
  if (unitEl) {
    unitEl.classList.remove("no-hero");
    unitEl.classList.add("blank-hero");
  }
  const blank = document.getElementById("unit-blank-clawd");
  if (blank) mountClawd(blank);
  const t = document.querySelector("#unit-blank .blank-t");
  const s = document.querySelector("#unit-blank .blank-s");
  if (t) t.textContent = copy.title;
  if (s) s.textContent = copy.sub;
  setFocus("split");
}

// ---- data → header ----------------------------------------------------------

/** Total fresh (in-flight) artifacts across all sources — for the L0 greeting. */
function freshCount(): number {
  const now = Date.now();
  return allArtifacts.filter((a) => now - a.modified_ms < FRESH_WINDOW_MS).length;
}

/** Head for a Board-owned unit whose agent live file is gone (the session ended
 *  but its terminal is still here). Reads as a terminal, not an orphan. */
function ownedHead(): PaneHead {
  return {
    source: "",
    name: "claude session",
    prov: "BOARD TERMINAL",
    mark: "›",
    isCloud: false,
    level: "ok",
    statusHtml: "Launched from the Board",
  };
}

/** Build the header fields for a live source. */
function makeHead(s: LiveSource): PaneHead {
  const state = parseState(s.json);
  const top = state.next?.[0];
  const level = levelFromKind(top?.kind);
  const text = state.working || top?.title || "Idle";
  const name = state.project || s.source;
  const prov = provLine(state, s.source);
  return {
    source: s.source,
    name,
    prov,
    mark: markFor(name),
    isCloud: prov.startsWith("CLOUD"),
    level,
    statusHtml: boldRuns(text),
  };
}

/** Top `next.kind` → status level (blocked⇒wait, todo/in-progress⇒busy, done/ok⇒ok). */
function levelFromKind(kind?: string): StatusLevel {
  switch ((kind || "").toLowerCase()) {
    case "blocked":
      return "wait";
    case "todo":
    case "in-progress":
    case "in_progress":
      return "busy";
    case "done":
    case "ok":
      return "ok";
    default:
      return "idle";
  }
}

/** A provenance line: LOCAL for ~/-rooted projects, else CLOUD · <source>. */
function provLine(state: LiveState, source: string): string {
  const where = state.where?.[0];
  if (state.project && (state.project.startsWith("~") || state.project.startsWith("/"))) {
    return `LOCAL · ${shorten(state.project)}`;
  }
  if (where) return `LOCAL · ${shorten(where)}`;
  return `CLOUD · ${source}`;
}

function shorten(p: string): string {
  return p.length > 22 ? "…" + p.slice(-21) : p;
}

function markFor(name: string): string {
  const first = name.trim()[0];
  return first ? first.toUpperCase() : "·";
}

/** `~/claude-code-companion` → `claude-code-companion`; `hermes` → `hermes`. */
function projectSlug(project?: string | null): string | null {
  if (!project) return null;
  const trimmed = project.replace(/\/+$/, "");
  const base = trimmed.split("/").pop() || trimmed;
  return base || null;
}

/** The project-match key for a source — the basename of its live `project`
 *  field, falling back to the stem's slug prefix. */
function sourceProjectKey(s: LiveSource): string {
  const fromJson = projectSlug(parseState(s.json).project ?? undefined);
  if (fromJson) return fromJson;
  const i = s.source.indexOf("--");
  return i >= 0 ? s.source.slice(0, i) : s.source;
}

/** File mtime injected by read_all_live; 0 if unparseable. */
function sourceUpdatedMs(s: LiveSource): number {
  return parseState(s.json).updated_ms ?? 0;
}

/** The shortid half of a source stem (`<slug>--<shortid>`). */
function shortIdOfSource(source: string): string {
  const i = source.indexOf("--");
  return i >= 0 ? source.slice(i + 2) : "";
}

/** This source's transcript-mtime heartbeat (0 if its session has no scanned
 *  transcript yet) — the free, agent-independent liveness signal. */
function sourceHeartbeatMs(s: LiveSource): number {
  return heartbeatByShortId.get(shortIdOfSource(s.source)) ?? 0;
}

/** A source the user has manually closed off the roster (sticky; see dismissed.json). */
function isDismissed(s: LiveSource): boolean {
  return parseState(s.json).dismissed === true;
}

/** A source is LIVE if it was touched within LIVENESS_MS and isn't manually
 *  dismissed; else stale. "Touched" = the NEWER of its live-file mtime and its
 *  transcript heartbeat, so an active session stays live with no per-turn live.json
 *  rewrite (the transcript is written every turn for free). The dismiss flag
 *  overrides freshness so a closed (but still-writing) session stays archived. */
function isLiveSource(s: LiveSource, now: number): boolean {
  if (isDismissed(s)) return false;
  const u = Math.max(sourceUpdatedMs(s), sourceHeartbeatMs(s));
  return u > 0 && now - u < LIVENESS_MS;
}

/** Escape, then turn **runs** into <b> (used in the mono status line). */
function boldRuns(text: string): string {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

/** A coarse relative time: "just now" / "5m ago" / "3h ago" / "2d ago". */
function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  const m = Math.floor(d / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/** Compact recency for the rail's right-aligned session timestamps ("now", "5m",
 *  "3h", "2d", "1w") — tight enough to sit beside an ellipsized title. 0 → "". */
function relTimeShort(ms: number): string {
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 60_000) return "now";
  const m = Math.floor(d / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

// ---- greeting + clock -------------------------------------------------------

function renderGreeting(fresh: number, agents: number): void {
  const hello = document.getElementById("board-hello");
  const sub = document.getElementById("board-sub");
  if (hello) hello.innerHTML = `${timeGreeting()}, <em>Zach.</em>`;
  if (sub) {
    sub.innerHTML = agents === 0
      ? "No agents running"
      : `<b>${fresh}</b> new · <b>${agents}</b> ${agents === 1 ? "agent" : "agents"} active`;
  }
  const count = document.getElementById("board-count");
  if (count) count.textContent = `${agents} ${agents === 1 ? "agent" : "agents"}`;
}

function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// ---- agent-composed bar (L0 hub + L2 digest) --------------------------------
// home.html (and home.<unit>.html) may carry a `companion-bar` JSON block that
// themes the top bar and fills its left/center/right slots. The mandatory
// control cluster always renders — agents compose CONTENT, never the controls.

interface BarItem {
  type: "title" | "clock" | "text" | "badge" | "link";
  text?: string;
  tone?: "accent" | "default";
  to?: string;
}
interface BarSpec {
  bg?: string;
  fg?: string;
  accent?: string;
  font?: "Newsreader" | "Inter" | "JetBrains Mono" | string;
  left?: BarItem[];
  center?: BarItem[];
  right?: BarItem[];
}

const FONT_STACK: Record<string, string> = {
  Newsreader: "'Newsreader', Georgia, serif",
  Inter: "'Inter', system-ui, sans-serif",
  "JetBrains Mono": "'JetBrains Mono', ui-monospace, monospace",
};

/** Read an artifact's `companion-bar` spec (or null on any failure). */
async function barSpecFor(path: string): Promise<BarSpec | null> {
  try {
    return parseBarSpec(await invoke<string>("read_artifact", { path }));
  } catch {
    return null;
  }
}

function parseBarSpec(html: string): BarSpec | null {
  const m = html.match(/<script[^>]*id=["']companion-bar["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim()) as BarSpec;
  } catch {
    return null;
  }
}

function barItemEl(item: BarItem): HTMLElement | null {
  switch (item.type) {
    case "title": {
      const e = document.createElement("div");
      e.className = "bar-item-title";
      e.textContent = item.text || "";
      return e;
    }
    case "clock": {
      const e = document.createElement("span");
      e.className = "bar-item-clock";
      return e;
    }
    case "text": {
      const e = document.createElement("span");
      e.className = "bar-item-text";
      e.textContent = item.text || "";
      return e;
    }
    case "badge": {
      const e = document.createElement("span");
      e.className = "bar-item-badge" + (item.tone === "accent" ? " accent" : "");
      e.textContent = item.text || "";
      return e;
    }
    case "link": {
      const e = document.createElement("button");
      e.className = "bar-item-link";
      e.textContent = item.text || "";
      if (item.to) e.addEventListener("click", () => navigateTo(item.to as string));
      return e;
    }
    default:
      return null;
  }
}

let barClockTimer: number | null = null;

/** Theme + fill the top bar from a spec, or restore the native greeting (null). */
function applyBar(spec: BarSpec | null): void {
  const top = document.querySelector(".board-top") as HTMLElement | null;
  const custom = document.getElementById("board-bar-custom");
  const greeting = top?.querySelector(".greeting") as HTMLElement | null;
  if (!top || !custom) return;

  if (barClockTimer !== null) {
    window.clearInterval(barClockTimer);
    barClockTimer = null;
  }

  if (!spec) {
    top.classList.remove("themed");
    top.style.removeProperty("--bar-bg");
    top.style.removeProperty("--bar-fg");
    top.style.removeProperty("--bar-accent");
    top.style.removeProperty("--bar-font");
    custom.setAttribute("hidden", "");
    greeting?.removeAttribute("hidden"); // native greeting owns the bar again
    return;
  }

  // An agent-composed bar takes over the top region — hide the native greeting
  // so its title doesn't duplicate / collide with the agent's.
  greeting?.setAttribute("hidden", "");

  top.classList.add("themed");
  if (spec.bg) top.style.setProperty("--bar-bg", spec.bg);
  if (spec.fg) top.style.setProperty("--bar-fg", spec.fg);
  if (spec.accent) top.style.setProperty("--bar-accent", spec.accent);
  if (spec.font) top.style.setProperty("--bar-font", FONT_STACK[spec.font] || spec.font);

  const fill = (sel: string, items?: BarItem[]) => {
    const zone = custom.querySelector(sel) as HTMLElement | null;
    if (!zone) return;
    zone.replaceChildren();
    (items || []).forEach((it) => {
      const el = barItemEl(it);
      if (el) zone.appendChild(el);
    });
  };
  fill(".bar-left", spec.left);
  fill(".bar-center", spec.center);
  fill(".bar-right", spec.right);
  custom.removeAttribute("hidden");

  const clocks = custom.querySelectorAll<HTMLElement>(".bar-item-clock");
  if (clocks.length) {
    const tick = () => {
      const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      clocks.forEach((c) => (c.textContent = t));
    };
    tick();
    barClockTimer = window.setInterval(tick, 30_000);
  }
}

/** Route a navigate target string (shared by bar links + postMessage). */
function navigateTo(to: string): void {
  if (to === "hub") void goHub();
  else if (to === "sessions") goSessions();
  else if (to.startsWith("unit:")) {
    const key = to.slice("unit:".length);
    goUnit(key);
  } else if (to.startsWith("session:")) {
    // Back-compat alias: route a session slug to its unit.
    goUnit(unitKeyOfSlug(to.slice("session:".length)));
  } else if (to.startsWith("artifact:")) {
    void navigateToArtifact(to.slice("artifact:".length));
  }
}

// ---- reader (full-surface artifact view) ------------------------------------

/**
 * Open an artifact full-SURFACE over the Board — the fix for "can't open an
 * artifact fully." A scrim + an inset:0 card with its OWN live iframe (kept out
 * of any pooling) whose JS + ✓/✎/✗ run; submit routes through wireNavigate via
 * `focusPath`. Open-by-path, so history and navigate links all reuse it.
 */
async function openReader(path: string): Promise<void> {
  if (focusPath) return;
  focusPath = path;

  const card = document.createElement("div");
  card.className = "reader";
  card.dataset.reader = "1";

  const inner = document.createElement("div");
  inner.className = "reader-inner";
  focusFrame = document.createElement("iframe");
  focusFrame.className = "reader-frame";
  focusFrame.setAttribute("sandbox", "allow-scripts");
  focusFrame.setAttribute("referrerpolicy", "no-referrer");
  // After each (re)load, if the artifact now showing was already submitted (and
  // hasn't been rewritten since), tell its helper to restore the "submitted"
  // overlay. The frame is reused across jump/back, so one persistent listener
  // covers every reader navigation.
  focusFrame.addEventListener("load", () => {
    if (!focusPath || !focusFrame) return;
    const stamp = submittedArtifacts.get(focusPath);
    if (stamp === undefined) return;
    const art = allArtifacts.find((a) => a.path === focusPath);
    if (art && art.modified_ms !== stamp) return; // rewritten since → re-armed
    focusFrame.contentWindow?.postMessage(
      { source: "companion-board", kind: "restore-submitted" },
      "*",
    );
  });
  inner.append(focusFrame);

  // A draggable strip across the top of the reader. The reader is full-bleed
  // (inset:0, z-index above the board's own top bar), so without this the
  // window's only drag region is buried under the artifact iframe — you can
  // scroll/highlight the artifact but can't reposition the window. The close ×
  // and nav float above this strip, so only the bare center-top is the handle.
  const drag = document.createElement("div");
  drag.className = "reader-dragbar";
  drag.setAttribute("data-tauri-drag-region", "");

  const close = document.createElement("button");
  close.className = "reader-close";
  close.title = "Close (esc)";
  close.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
  close.addEventListener("click", closeFocus);

  card.append(inner, drag, close);
  boardEl.append(card);
  scrimEl.classList.add("on");
  requestAnimationFrame(() => card.classList.add("shown"));
  renderReaderNav();

  await loadArtifactInto(path, focusFrame).catch((e) => console.error("reader load failed", path, e));
}

/** The agents-need-you queue: one entry per source (agent) that has an unread
 *  artifact OTHER than the one on screen, represented by its freshest such
 *  artifact. Count = distinct agents, so "N agents need you" reads true even when
 *  one agent dropped several artifacts. Freshest agent first. */
function agentQueue(): { source: string; path: string }[] {
  const unread = new Set<string>();
  for (const set of unreadByUnit.values()) for (const p of set) unread.add(p);
  const freshestBySource = new Map<string, ArtifactEntry>();
  for (const a of allArtifacts) {
    if (!unread.has(a.path) || a.path === focusPath) continue;
    const src = a.source ?? a.path; // unsourced artifact = its own "agent"
    const cur = freshestBySource.get(src);
    if (!cur || a.modified_ms > cur.modified_ms) freshestBySource.set(src, a);
  }
  return [...freshestBySource.values()]
    .sort((x, y) => y.modified_ms - x.modified_ms)
    .map((a) => ({ source: a.source ?? a.path, path: a.path }));
}

/** Mark a single artifact read (it's now on the reader) without clearing the rest
 *  of its unit's unread — surgical, so jumping to one agent leaves the others queued. */
function markArtifactRead(path: string): void {
  for (const [unit, set] of unreadByUnit) {
    if (set.delete(path)) {
      if (set.size === 0) unreadByUnit.delete(unit);
      break;
    }
  }
  updateGlobalUnread();
}

/** Build/refresh the reader's top-left nav: "← Back" (when the stack is non-empty)
 *  and "N agents need you · Next →" (when other agents have unread work). Called on
 *  open, on every jump/back, and from updateGlobalUnread so the count stays live as
 *  artifacts arrive while the reader is open. */
function renderReaderNav(): void {
  const card = boardEl.querySelector("[data-reader]") as HTMLElement | null;
  if (!card) return;
  let nav = card.querySelector(".reader-nav") as HTMLElement | null;
  if (!nav) {
    nav = document.createElement("div");
    nav.className = "reader-nav";
    card.append(nav);
  }
  const q = agentQueue();
  nav.replaceChildren();
  if (readerBackStack.length) {
    const back = document.createElement("button");
    back.className = "reader-back";
    back.textContent = "← Back";
    back.addEventListener("click", () => void readerBack());
    nav.append(back);
  }
  if (q.length) {
    const next = document.createElement("button");
    next.className = "reader-next";
    next.textContent =
      q.length === 1 ? "1 agent needs you · Next →" : `${q.length} agents need you · Next →`;
    next.addEventListener("click", () => void readerJumpNext());
    nav.append(next);
  }
  nav.toggleAttribute("hidden", nav.childElementCount === 0);
}

/** Jump the reader to the next agent's freshest unread artifact, pushing the
 *  current one onto the back-stack and marking the target read (so that agent
 *  drops out of the queue → submit-then-Next walks agent to agent). */
async function readerJumpNext(): Promise<void> {
  const q = agentQueue();
  if (!q.length || !focusFrame) return;
  awaitingAdvanceSource = null; // manual nav cancels a pending auto-advance
  const next = q[0].path;
  if (focusPath) readerBackStack.push(focusPath);
  focusPath = next;
  markArtifactRead(next); // also refreshes the nav via updateGlobalUnread
  renderReaderNav();
  await loadArtifactInto(next, focusFrame).catch((e) => console.error("reader jump failed", next, e));
}

/** Return to the previously-viewed artifact in the reader. */
async function readerBack(): Promise<void> {
  const prev = readerBackStack.pop();
  if (prev === undefined || !focusFrame) return;
  awaitingAdvanceSource = null; // manual nav cancels a pending auto-advance
  focusPath = prev;
  renderReaderNav();
  await loadArtifactInto(prev, focusFrame).catch((e) => console.error("reader back failed", prev, e));
}

/** Close the reader; flush any unit history rebuild deferred while it was open. */
function closeFocus(): void {
  const card = boardEl.querySelector("[data-reader]") as HTMLElement | null;
  scrimEl.classList.remove("on");
  card?.remove();
  focusFrame = null;
  focusPath = null;
  awaitingAdvanceSource = null;
  readerBackStack.length = 0;
  if (pendingIngest.size) {
    const v = currentView();
    const due = v.level === "unit" && pendingIngest.has(v.unitKey) ? v.unitKey : null;
    pendingIngest.clear();
    if (due) ingestIntoUnit(due);
  }
}

// ---- live polling -----------------------------------------------------------

async function pollLive(): Promise<void> {
  let sources: LiveSource[] = [];
  try {
    sources = await invoke<LiveSource[]>("read_all_live");
  } catch (e) {
    console.error("read_all_live failed", e);
    return;
  }
  allSources = sources;

  // Correlate Board-owned terminals to the live sources their spawned claude
  // produced: companion_session (a tabId, injected by read_all_live) → unit_key.
  // TIE-BREAK: a single tabId can be claimed by MORE THAN ONE slug in
  // owned-sessions.json — e.g. a 2nd claude started in the same PTY inherits the
  // same COMPANION_SESSION, and the first never pruned its entry (no SessionEnd).
  // Plain last-writer-wins would bind the terminal to whichever source iterated
  // last (often the stale one), splitting the live session from its artifacts.
  // Instead bind each tabId to its FRESHEST source (max updated_ms), so a stale
  // claimant can never win regardless of order.
  const sessionToUnit = new Map<string, string>();
  const sessionFreshness = new Map<string, number>();
  for (const s of sources) {
    const cs = parseState(s.json).companion_session;
    if (!cs) continue;
    const u = sourceUpdatedMs(s);
    const prior = sessionFreshness.get(cs);
    if (prior === undefined || u > prior) {
      sessionFreshness.set(cs, u);
      sessionToUnit.set(cs, unitKeyOf(s));
    }
  }
  const newlyBound = reconcileBindings(sessionToUnit);
  if (newlyBound.length) {
    const v = currentView();
    // A globally-launched ("+ New session") terminal: jump to its unit the moment
    // it goes live, so the user lands on the session they just opened.
    const pend = pendingNavTab && newlyBound.find((b) => b.tabId === pendingNavTab);
    if (pend) {
      pendingNavTab = null;
      // Fresh launch ⇒ skip the digest flash and land terminal-focused. Resume ⇒ leave
      // freshLaunchUnit clear so renderHero keeps the hero (the session has context to show).
      if (pendingNavFresh) freshLaunchUnit = pend.unitKey;
      goUnit(pend.unitKey);
    } else if (v.level === "unit") {
      // A binding adopted while viewing a unit: reveal it in place.
      showOwnedTerminals(v.unitKey);
    }
  }

  const view = currentView();
  const changed: string[] = [];
  for (const s of sources) {
    if (lastJsonBySource.get(s.source) === s.json) continue;
    lastJsonBySource.set(s.source, s.json);
    changed.push(s.source);
  }
  if (changed.length) {
    // L1 refreshes its unit cards' live status. L2's hero + history are
    // artifact-driven, but its rail mirrors live state — refresh it so a session
    // appearing/quieting updates the switcher in place. The L0 Hub re-resolves
    // on entry only.
    if (view.level === "unit") {
      renderUnitRail(view.unitKey);
      // The active session may have just come live (e.g. a resumed session whose
      // artifacts already existed on disk). If its hero is still blank, light it up.
      maybeLightBlankHero(view.unitKey);
    }
  }

  // Live artifact ingestion — act only when the set actually changed.
  let artifacts: ArtifactEntry[];
  try {
    artifacts = await invoke<ArtifactEntry[]>("list_artifacts");
  } catch (e) {
    console.error("list_artifacts failed", e);
    return;
  }
  const sig = artifactSig(artifacts);
  if (sig !== lastArtifactSig) {
    lastArtifactSig = sig;
    ingestArtifacts(artifacts);
  }
}

/** A cheap fingerprint of the artifact set — path + mtime. */
function artifactSig(arts: ArtifactEntry[]): string {
  return arts.map((a) => `${a.path}:${a.modified_ms}`).join("|");
}

function addUnread(unitKey: string, path: string): void {
  let set = unreadByUnit.get(unitKey);
  if (!set) {
    set = new Set();
    unreadByUnit.set(unitKey, set);
  }
  set.add(path);
}
function unreadCount(unitKey: string): number {
  return unreadByUnit.get(unitKey)?.size ?? 0;
}
function clearUnread(unitKey: string): void {
  unreadByUnit.delete(unitKey);
}
function totalUnread(): number {
  let n = 0;
  for (const set of unreadByUnit.values()) n += set.size;
  return n;
}

/**
 * Reconcile a fresh artifact list: route NEW artifacts to their unit (unread
 * unless that unit is on screen), prune deleted ones, then refresh the level.
 */
function ingestArtifacts(artifacts: ArtifactEntry[]): void {
  const present = new Set(artifacts.map((a) => a.path));
  const newOnes = artifacts.filter((a) => !knownPaths.has(a.path));
  allArtifacts = artifacts;
  for (const a of artifacts) knownPaths.add(a.path);

  for (const p of [...knownPaths]) if (!present.has(p)) knownPaths.delete(p);
  for (const [unit, set] of unreadByUnit) {
    for (const p of [...set]) if (!present.has(p)) set.delete(p);
    if (set.size === 0) unreadByUnit.delete(unit);
  }
  if (heroPendingPath !== null && !present.has(heroPendingPath)) hideHeroNewPill();

  const view = currentView();
  const viewingUnit = view.level === "unit" ? view.unitKey : null;
  let heroNewCandidate: ArtifactEntry | null = null;
  for (const a of newOnes) {
    const unit = unitForArtifact(a);
    if (unit !== viewingUnit) {
      addUnread(unit, a.path);
    } else if (a.source && a.source !== activeSessionSource(unit)) {
      // Same unit on screen, but produced by a SIBLING session (not the one whose
      // hero is shown). The hero is per-session, so this isn't its hero to advance —
      // surface it as ambient unread, exactly as a different unit's artifact would be.
      addUnread(unit, a.path);
    } else if (digestPath !== null && a.path !== digestPath) {
      // The active session's hero is populated + sticky. Rather than let a newer
      // artifact drop silently into history (the reported bug), surface the freshest
      // one as a click-to-advance pill on the hero.
      if (!heroNewCandidate || a.modified_ms > heroNewCandidate.modified_ms) heroNewCandidate = a;
    }
  }
  if (heroNewCandidate) showHeroNewPill(heroNewCandidate.path);

  maybeAutoAdvance(newOnes);

  if (view.level === "unit") ingestIntoUnit(view.unitKey);
  updateGlobalUnread();
}

/** Same-session auto-advance: after a submit, when this session's NEXT artifact
 *  arrives, replace the waiting scene with it — in the reader if one is open,
 *  else in the hero slot. Either way the "On it" splash is dismissed. Another
 *  session's new artifact is intentionally ignored here (it surfaces as ambient
 *  unread instead). The freshest matching new artifact wins. */
function maybeAutoAdvance(newOnes: ArtifactEntry[]): void {
  if (awaitingAdvanceSource === null) return;
  const next = newOnes
    .filter(
      (a) =>
        a.source === awaitingAdvanceSource && a.path !== focusPath && a.path !== digestPath,
    )
    .sort((x, y) => y.modified_ms - x.modified_ms)[0];
  if (!next) return;

  // Reader open → slide the reader to the next artifact.
  if (focusPath !== null && focusFrame) {
    awaitingAdvanceSource = null;
    dismissBoardSubmitted();
    readerBackStack.push(focusPath);
    focusPath = next.path;
    markArtifactRead(next.path);
    renderReaderNav();
    void loadArtifactInto(next.path, focusFrame).catch((e) =>
      console.error("auto-advance failed", next.path, e),
    );
    return;
  }

  // Hero waiting (no reader) → load the next artifact into the slot in place.
  // Guard on the unit matching the one on screen AND the artifact's session still
  // being the active one, so a stale pending advance can't load session A's artifact
  // into a different unit's hero, nor into a sibling session's hero if the user
  // switched away after submitting (it stays ambient unread instead).
  const v = currentView();
  if (
    v.level === "unit" &&
    unitForArtifact(next) === v.unitKey &&
    next.source === activeSessionSource(v.unitKey)
  ) {
    awaitingAdvanceSource = null;
    dismissBoardSubmitted();
    hideHeroNewPill();
    digestPath = next.path;
    markArtifactRead(next.path);
    void loadArtifactInto(next.path, digestEl).catch((e) =>
      console.error("hero auto-advance failed", next.path, e),
    );
    updateGlobalUnread();
  }
}

/** Refresh the on-screen unit's HISTORY when its artifact set changed. The HERO
 *  is deliberately STICKY: once a lead surface is shown, a live poll must NOT
 *  reload it. `loadArtifactInto` cache-busts the iframe `src` on every load, so
 *  reloading tears down the document — wiping any comment the user is mid-typing
 *  and bouncing focus to the terminal. New artifacts still surface as unread +
 *  history rows, and the hero re-resolves on re-entry (enterUnit). The lone
 *  exception: an empty unit with no hero yet (`digestPath === null`) paints its
 *  first artifact, so a unit lights up live the moment its first work lands.
 *  Preserves scroll. Deferred entirely while the reader overlay is open. */
function ingestIntoUnit(unitKey: string): void {
  if (focusPath !== null) {
    pendingIngest.add(unitKey);
    return;
  }
  const keep = unitEl.scrollTop;
  if (digestPath === null) void renderHero(unitKey); // empty unit → light up its first artifact
  renderHistory(unitKey);
  unitEl.scrollTop = keep;
}

/** Sync the global Board unread badge + notify a cooperative L0 dashboard. */
function updateGlobalUnread(): void {
  const total = totalUnread();
  const btn = document.getElementById("board-unread");
  const count = document.getElementById("board-unread-count");
  if (btn) btn.toggleAttribute("hidden", total === 0);
  if (count) count.textContent = total > 99 ? "99+" : String(total);
  // Keep the reader's "N agents need you" pill live as artifacts arrive mid-read
  // (ingestArtifacts still routes unread while the reader defers its unit rebuild).
  if (focusPath !== null) renderReaderNav();
  postUnreadToHub();
}

/** Post unread counts into the full-bleed home.html iframe (L0 only). */
function postUnreadToHub(): void {
  if (currentView().level !== "hub") return;
  const frame = document.getElementById("hub-frame") as HTMLIFrameElement | null;
  if (!frame || frame.hasAttribute("hidden") || !frame.contentWindow) return;
  const counts: Record<string, number> = {};
  for (const [unit, set] of unreadByUnit) counts[unit] = set.size;
  frame.contentWindow.postMessage(
    { source: "companion", kind: "unread", total: totalUnread(), counts },
    "*",
  );
}

// ---- controls + keyboard ----------------------------------------------------

function wireControls(): void {
  document.getElementById("board-close")?.addEventListener("click", () => {
    win.hide().catch((e) => console.error("board hide failed", e));
  });
  // Collapse = hide to the menu bar (the status item is the ambient presence now).
  document.getElementById("board-collapse")?.addEventListener("click", () => {
    win.hide().catch((e) => console.error("board hide failed", e));
  });
  document.getElementById("board-newsession")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleNewSessionMenu(e.currentTarget as HTMLElement);
  });
  document.getElementById("board-unread")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleNotifMenu(e.currentTarget as HTMLElement);
  });
  document.getElementById("hub-sessions-btn")?.addEventListener("click", () => {
    const u = findMostRecentActiveUnit();
    if (u) goUnit(u); else void newHomeSession();
  });
  scrimEl?.addEventListener("click", closeFocus);
}

/**
 * Listen for messages from artifact/Hub/digest iframes. Its OWN listener — NOT
 * initFit (which resizes the window; full-bleed surfaces must never drive a
 * resize). Handles `navigate` (drill the Board) and `submit` (an artifact's
 * ✓/✎/✗ review → clipboard, tagged with the open reader's path). UNTRUSTED.
 */
function wireNavigate(): void {
  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data;
    if (isNavigateMessage(d)) {
      navigateTo(d.to);
      return;
    }
    if (isNewSessionMessage(d)) {
      // Highlight → "✦ New session with this quote". Untrusted artifact text, but
      // lower-risk than submit: it pre-fills (never auto-Enters) a FRESH session, so
      // nothing runs without the user typing + submitting. ESC-stripped at the PTY.
      // (Same trust-gate caveat as submit applies before rendering 3rd-party artifacts:
      // a hostile artifact could spam-spawn; gate the new-session channel too.)
      void startSessionFromQuote(d.quote, d.artifact);
      return;
    }
    if (d && d.source === "companion-artifact" && d.kind === "splash-dismissed") {
      // The user clicked "View last artifact" on the waiting splash — they're back on
      // the prior artifact, not waiting. Disarm auto-advance so the NEXT artifact
      // surfaces as a click-to-view pill instead of yanking them off what they're
      // reading. (Old artifacts never send this, so they keep the always-advance
      // behavior — backward-compatible.)
      awaitingAdvanceSource = null;
      return;
    }
    if (
      d &&
      d.source === "companion-artifact" &&
      d.kind === "submit" &&
      typeof d.text === "string"
    ) {
      // Route the compiled ✓/✎/✗ answer STRAIGHT into a session's terminal
      // (no clipboard, no ⌘V): prefer the exact owning session of the open
      // artifact, else any owned terminal in the unit on screen. Only when there
      // is genuinely no Board terminal to receive it (an external session running
      // outside the Board) do we fall back to the clipboard.
      // Remember this artifact was answered, stamped with its current mtime, so
      // navigating back to it re-shows the "submitted" overlay instead of the
      // pristine form. A later rewrite changes the mtime and re-arms the card.
      if (focusPath) {
        const art = allArtifacts.find((a) => a.path === focusPath);
        submittedArtifacts.set(focusPath, art?.modified_ms ?? 0);
        // Arm same-session auto-advance: this session's next artifact will
        // replace the waiting scene in the reader (no click, no terminal).
        awaitingAdvanceSource = art?.source ?? null;
      } else if (digestPath) {
        // Hero submit (no reader): arm same-slot auto-advance so this session's
        // next artifact replaces the waiting scene in the hero, in place.
        const art = allArtifacts.find((a) => a.path === digestPath);
        submittedArtifacts.set(digestPath, art?.modified_ms ?? 0);
        awaitingAdvanceSource = art?.source ?? null;
      }
      // Fallback arm: a transient per-session hero blank can leave BOTH focusPath and
      // digestPath null at submit time, so the branches above no-op and the next
      // artifact mis-shows the click-to-view pill instead of auto-loading. Arm from the
      // active session so the waiting splash still advances to its own next artifact.
      if (awaitingAdvanceSource === null) {
        const sv = currentView();
        if (sv.level === "unit") awaitingAdvanceSource = activeSessionSource(sv.unitKey);
      }
      // SECURITY — submit→PTY trust gate (PLANNED; see codebase-audit.html). `d.text`
      // arrived via an artifact's postMessage, which carries NO proof of a real user
      // click: a hostile or auto-loaded artifact's JS can fire `kind:"submit"`
      // unprompted, and the branch below pastes it + presses Enter into the live
      // `claude` session. Today every rendered artifact is FIRST-PARTY (authored by
      // the user's own agent), so auto-send reflects the user's intent and the
      // ESC-strip in submitIntoPty() blocks the breakout. BEFORE we start rendering
      // artifacts we did NOT author (hub-pulled / shared), GATE this: route a
      // non-first-party artifact's submit through the clipboard fallback (handleSubmit)
      // or a Board-side confirm instead of auto-Enter — detect via the artifact's
      // source/path (hub artifacts land under the `remote/` dir).
      const v = currentView();
      const unitTab = v.level === "unit" ? ownedTabForUnit(v.unitKey) : null;
      const tabId = (focusPath ? ownedTabForArtifact(focusPath) : null) ?? unitTab;
      if (tabId) {
        const tag = focusPath ? `\n\n— Companion artifact: ${focusPath} —` : "";
        void submitIntoPty(tabId, `${d.text}${tag}`).catch((e) => {
          console.error("submit into PTY failed; clipboard fallback", e);
          void handleSubmit(d.text, focusPath ?? undefined);
        });
      } else {
        void handleSubmit(d.text, focusPath ?? undefined);
      }
      // The artifact's OWN in-page splash (the prefer-html helper's
      // __cmpShowSubmitted, fired from its doSubmit) is the single "On it"
      // confirmation. The Board used to render a second splash on top of the
      // iframe — but dismissing it only revealed the in-page one underneath, so the
      // user had to dismiss twice (the double-splash bug). nav-back still re-shows
      // the in-page splash via restore-submitted; auto-advance clears it on reload.
    }
  });
}

/** Remove any "On it" splash the Board installed and its listener. The Board no
 *  longer renders its own splash (the artifact's in-page one is canonical), so this
 *  is now a defensive no-op kept on the nav / auto-advance paths. Safe to call when
 *  none is showing. */
function dismissBoardSubmitted(): void {
  boardSubmittedCleanup?.();
  boardSubmittedCleanup = null;
  document.querySelector(".board-submitted")?.remove();
}

/** Submit a compiled artifact answer into a Board-owned PTY and AUTO-SEND it.
 *  Sent in THREE writes: first Ctrl-U to clear the prompt (so an artifact send never
 *  MERGES with whatever the user had half-typed — without this, the paste appends to
 *  the existing buffer and the Enter submits the concatenation as one line, e.g. a
 *  stray `/checkpoint` swallowing the answer as args → "Args from unknown skill");
 *  then the bracketed-paste body (so internal newlines don't submit early); then —
 *  as a SEPARATE, slightly-delayed write — the carriage return. A CR riding in the
 *  same buffer as the paste-end marker gets swallowed by Claude's TUI (the turn lands
 *  in the prompt unsent); a distinct, delayed Enter reliably commits it.
 *
 *  SECURITY: `text` is artifact-controlled (a sandboxed iframe posts it, and — once
 *  hub rendering lands — an artifact can be pulled from a remote hub), so we strip
 *  ESC (0x1B) before wrapping it. Terminal escape sequences all begin with ESC, so
 *  this neutralises a payload that smuggles its own `\x1b[201~` to END the bracketed
 *  paste early and inject newline-terminated commands into the live `claude` session
 *  (the breakout), plus any cursor/title (OSC) escape. Lossless: compiled feedback
 *  prose never contains a raw ESC. Scoped to THIS paste path ONLY — raw keystrokes
 *  (the terminal's own `write_pty`) stay verbatim so the real ESC key still works.
 *  (Stripped here, not in Rust, because this path builds the paste in JS to keep the
 *  Ctrl-U-clear + separate delayed-Enter that a single Rust write can't reproduce.) */
async function submitIntoPty(tabId: string, text: string): Promise<void> {
  const safe = text.split("\x1b").join(""); // strip ESC: block paste-escape breakout (see above)
  await invoke("write_pty", { tabId, data: "\x15" }); // Ctrl-U: kill line, clear any typed-but-unsent input
  await invoke("write_pty", { tabId, data: `\x1b[200~${safe}\x1b[201~` });
  await new Promise((r) => setTimeout(r, 90));
  await invoke("write_pty", { tabId, data: "\r" });
}

/** The Board-owned PTY tabId that produced `path`, or null when the artifact came
 *  from an external session. Resolves artifact → its source slug → that live
 *  source's companion_session (the owning tabId). */
function ownedTabForArtifact(path: string): string | null {
  const art = allArtifacts.find((a) => a.path === path);
  if (!art?.source) return null;
  const src = allSources.find((s) => s.source === art.source);
  return src ? parseState(src.json).companion_session ?? null : null;
}

/** Validate an artifact path is in scope, then open it in the reader (drilling
 *  to its unit first so the back button lands somewhere sensible). */
async function navigateToArtifact(path: string): Promise<void> {
  let ok = false;
  try {
    ok = await invoke<boolean>("artifact_in_scope", { path });
  } catch {
    ok = false;
  }
  if (!ok) {
    console.warn("navigate: artifact rejected (out of scope)", path);
    return;
  }
  const art = allArtifacts.find((a) => a.path === path);
  if (art) {
    const unit = unitForArtifact(art);
    const v = currentView();
    if (!(v.level === "unit" && v.unitKey === unit)) goUnit(unit);
  }
  requestAnimationFrame(() => void openReader(path));
}

/** True when the keydown came from somewhere the user is typing — the embedded
 *  terminal, a text input, or a contentEditable. The Backspace back-nav guard must
 *  stand down there, else Backspace clears in-progress work instead of editing. */
function isTypingContext(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.closest("#unit-terminals")) return true; // the live claude TUI
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

function wireKeyboard(): void {
  // No navigation shortcuts: the Board is driven by its on-screen controls only
  // (Esc / F were legacy and have been removed). The one keydown we still handle
  // is a protective guard, not a navigation aid.
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    const typing = isTypingContext(e.target);
    // Backspace with nothing focused triggers the webview's back-navigation,
    // which reloads the surface and wipes any open artifact's answers. Swallow it
    // outside typing contexts (where it's just normal editing).
    if (e.key === "Backspace" && !typing) {
      e.preventDefault();
    }
  });
}

/** Add `.is-scrolling` while a native list scrolls, so CSS can pause the
 *  repaint-heavy paper-tex blend + status-dot pulse (cleared after idle). */
function wireScrollGating(): void {
  let timer = 0;
  const onScroll = () => {
    boardEl.classList.add("is-scrolling");
    window.clearTimeout(timer);
    timer = window.setTimeout(() => boardEl.classList.remove("is-scrolling"), 140);
  };
  unitEl.addEventListener("scroll", onScroll, { passive: true });
}

// ---- small utils ------------------------------------------------------------

function setStatus(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.removeAttribute("hidden");
}

/** Escape a path for use inside a CSS attribute selector. */
