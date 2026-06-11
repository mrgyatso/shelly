// The Board — Companion's home surface.
//
// A dark letterboxing STAGE holds a warm "Anthropic paper" BOARD surface: a
// serif greeting, minimal floating controls, and a horizontal MASONRY of
// per-agent PANES. Each connected agent (one `~/.claude/companion/live/<source>.json`)
// is one pane: a header (agent-mark chip + name + mono provenance + a status-dot
// colored by level + a 2-line mono status-line derived from its live state) over
// a hairline rule, then a BENTO GRID of that agent's artifact TILES. Artifacts
// are matched to a pane by their companion-meta.project basename == the pane's
// source slug; unmatched artifacts land in a trailing "unsourced" pane.
//
// This is a RESKIN of the prior Board that PRESERVES the real-data path:
//   - read_all_live()  → one pane per live source (working/where/next/project)
//   - list_artifacts() → real artifacts grouped into panes
//   - lazy-mount tiles: a tile's body is a single stable <iframe> that flips
//     between a cheap static `srcdoc` THUMBNAIL (inline JS blocked by the overlay
//     CSP → near-zero CPU) and, on focus/selection, a LIVE `asset:` iframe
//     (loadArtifactInto) whose JS + ✓/✎/✗ buttons run. A MAX_LIVE_TILES LRU caps
//     concurrent live tiles; off-screen thumbnails are torn down by an
//     IntersectionObserver.
//
// Layered onto that real wiring, ported from the design: bento spans
// (cspan/rspan) with span-based resize + drag-reorder, the masonry distribute(),
// an iOS-like FLIP focus/expand overlay (its OWN dedicated asset: iframe, kept
// OUT of the tile LRU so it never evicts a tile), a collapsed PILL state, a
// staggered arrival reveal for "fresh" (overnight) artifacts, spatial keyboard
// navigation, and full-screen via the existing Rust set_board_fullscreen.
//
// Deferred (noted in the handoff): the embedded-terminal tile (terminals render
// as normal artifacts for now); the Rust-side pill-as-non-activating-overlay vs
// board-as-app-window split (the pill is a visual collapse state here); fonts
// are loaded from Google Fonts in index.html (no @fontsource packages present).

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { handleSubmit } from "./submit";
import { loadArtifactInto } from "./artifact-view";
import { isNavigateMessage } from "./resize";
import {
  columnCount,
  cellPx,
  distribute,
  type PaneWeight,
  type Slot,
} from "./board-layout";

interface ArtifactEntry {
  path: string;
  title: string;
  subject?: string | null;
  summary?: string | null;
  modified_ms: number;
  size_bytes: number;
  /** Raw companion-meta.project (often a path like `~/foo`); matched by basename. */
  project?: string | null;
}

interface LiveSource {
  source: string;
  json: string;
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
}

type StatusLevel = "wait" | "busy" | "ok" | "idle";

/** A tile's bento geometry + arrival metadata, synthesized from an ArtifactEntry. */
interface TileMeta {
  path: string;
  title: string;
  tag: string;
  summary: string;
  cspan: number;
  rspan: number;
  fresh: boolean;
}

/** Everything needed to render one pane. */
interface Pane {
  source: string;
  name: string;
  prov: string;
  mark: string;
  isCloud: boolean;
  level: StatusLevel;
  statusHtml: string;
  cols: number;
  tiles: TileMeta[];
}

/** Slug used for the catch-all pane holding artifacts with no live source. */
const UNSOURCED = "__unsourced__";
/** Poll cadence for live-state headers — matches live.ts's calm cadence. */
const POLL_MS = 1200;
/** Max concurrent LIVE (asset:) tiles; the rest stay cheap metadata cards. */
const MAX_LIVE_TILES = 3;
/** Cap how many tiles an L2 session shows; the rest live in the History HUD. */
const MAX_SESSION_TILES = 12;
/** An instance whose live file hasn't been touched within this window is "stale"
 *  — it drops off the live roster into the reversible Archived toggle. Liveness
 *  is mtime-based (SessionEnd can't be trusted), so this is the source of truth. */
const LIVENESS_MS = 30 * 60 * 1000;
/** An artifact modified within this window counts as "arrived overnight" (fresh). */
const FRESH_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Default bento span for a real artifact (the demo's hero tiles are 2×2). */
const DEFAULT_CSPAN = 2;
const DEFAULT_RSPAN = 2;
/** A pane's bento width in columns. */
const PANE_COLS = 2;

const win = getCurrentWebviewWindow();

/** The Board's three drill-down levels. L0 Hub → L1 Sessions → L2 one session. */
type BoardView =
  | { level: "hub" }
  | { level: "sessions" }
  | { level: "session"; source: string };

/** Back-navigation stack; the current view is its top. */
let viewStack: BoardView[] = [{ level: "hub" }];
function currentView(): BoardView {
  return viewStack[viewStack.length - 1];
}

/** Last-rendered live JSON per source, so a poll only re-renders what changed. */
const lastJsonBySource = new Map<string, string>();
/** Currently-live tiles in focus order (front = least-recently-focused = LRU). */
const liveTiles: HTMLElement[] = [];
/** Per-tile bento spans, keyed by artifact path (resize mutates this). */
const spans = new Map<string, { c: number; r: number }>();
/** The single L2 pane currently mounted (null at L0/L1). */
let panes: Pane[] = [];

/** Raw data read once in initBoard; the router re-scopes it per view. */
let allSources: LiveSource[] = [];
let allArtifacts: ArtifactEntry[] = [];

let isFullscreen = false;
/** Whether the L1 roster's stale (archived) instances are revealed. */
let showArchived = false;
let numCols = 4;
let selected: string | null = null;
/** The focus/expand overlay's dedicated live iframe (outside the tile LRU). */
let focusFrame: HTMLIFrameElement | null = null;
let focusPath: string | null = null;
let arrivalPlayed = false;

// ---- live artifact ingestion + unread ---------------------------------------
// The poll loop re-reads list_artifacts(); a new artifact is routed to its
// session (matched by companion-meta.project basename), shown live if that
// session is on screen, or flagged UNREAD on its card + a global Board badge.

/** Every artifact path we've ever seen — seeded at init so existing files aren't "new". */
const knownPaths = new Set<string>();
/** Unread (arrived-while-away) artifact paths, per source slug. */
const unreadBySource = new Map<string, Set<string>>();
/** Signature of the last-seen artifact set (path:mtime) — a cheap poll no-op guard. */
let lastArtifactSig = "";
/** Sources whose L2 rebuild is deferred because the focus overlay is open. */
const pendingIngest = new Set<string>();

// DOM handles (resolved in initBoard).
let panesEl: HTMLElement;
let boardEl: HTMLElement;
let stageEl: HTMLElement;
let scrimEl: HTMLElement;
let hubEl: HTMLElement;
let sessionsEl: HTMLElement;
let scrollEl: HTMLElement;

export async function initBoard(): Promise<void> {
  const stage = document.getElementById("board-stage");
  const board = document.getElementById("board");
  const panesRoot = document.getElementById("board-panes");
  const scroll = document.getElementById("board-scroll");
  const scrim = document.getElementById("board-scrim");
  const status = document.getElementById("board-status");
  const hub = document.getElementById("board-hub");
  const sessions = document.getElementById("board-sessions");
  // The single-artifact / other surfaces share this bundle — hide them.
  document.getElementById("frame")?.setAttribute("hidden", "");
  document.getElementById("empty")?.setAttribute("hidden", "");
  document.getElementById("controls")?.setAttribute("hidden", "");
  if (!stage || !board || !panesRoot || !scroll || !scrim || !status || !hub || !sessions) return;

  stageEl = stage;
  boardEl = board;
  panesEl = panesRoot;
  scrimEl = scrim;
  hubEl = hub;
  sessionsEl = sessions;
  scrollEl = scroll;
  stage.removeAttribute("hidden");

  wireControls();
  wireKeyboard();
  wireNavigate();
  wireScrollGating();
  startClock();
  observeResize();

  setStatus(status, "Loading…");

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

  // Seed each header with the live state we just read, then keep all levels
  // current with one poll loop (it branches on the current view).
  for (const s of allSources) lastJsonBySource.set(s.source, s.json);
  // Seed the artifact baseline so only files written AFTER open count as new.
  for (const a of allArtifacts) knownPaths.add(a.path);
  lastArtifactSig = artifactSig(allArtifacts);
  window.setInterval(() => void pollLive(), POLL_MS);

  // Land on L0 (the Hub) — agent-authored home.html if present, else native.
  await goHub();
}

// ---- view router ------------------------------------------------------------

/** Show exactly one of the three level containers; the rest stay hidden. */
function showLevel(level: BoardView["level"]): void {
  hubEl.toggleAttribute("hidden", level !== "hub");
  sessionsEl.toggleAttribute("hidden", level !== "sessions");
  scrollEl.toggleAttribute("hidden", level !== "session");
  // Back button: shown at any level below the Hub.
  document.getElementById("board-back")?.toggleAttribute("hidden", level === "hub");
}

/** Enter L0. Resolves home.html (Rust) → full-bleed iframe, else native fallback. */
async function goHub(): Promise<void> {
  leaveSession();
  viewStack = [{ level: "hub" }];
  showLevel("hub");
  renderGreeting(freshCount(), allSources.length);
  await renderHub();
  // Once the dashboard iframe is loaded, hand it the current unread counts.
  updateGlobalUnread();
}

/** Enter L1 — the native, light Sessions picker. */
function goSessions(): void {
  leaveSession();
  applyBar(null); // native chrome for native views; clear any L0 theming
  if (currentView().level !== "sessions") viewStack.push({ level: "sessions" });
  showLevel("sessions");
  renderSessions();
}

/** Enter L2 — one session's bento board, scoped to `source`. If we're already at
 *  a session (e.g. an artifact-navigate from one session to another), replace it
 *  rather than stacking duplicates, so back-nav stays one level up. */
function goSession(source: string): void {
  leaveSession();
  applyBar(null); // native chrome for native views; clear any L0 theming
  if (currentView().level === "session") viewStack.pop();
  viewStack.push({ level: "session", source });
  showLevel("session");
  enterSession(source);
}

/** Pop one level: Session → Sessions → Hub. */
function goBack(): void {
  if (viewStack.length <= 1) return;
  viewStack.pop();
  const v = currentView();
  if (v.level === "hub") void goHub();
  else if (v.level === "sessions") {
    // Already on the stack; re-render without re-pushing.
    leaveSession();
    showLevel("sessions");
    renderSessions();
  }
}

// ---- L0 Hub -----------------------------------------------------------------

/**
 * Render the Hub. If an agent has authored `home.html` (resolved Rust-side, so
 * it's the one in the artifacts dir → in asset: scope → its JS runs), load it
 * full-bleed; otherwise show the native fallback. Re-resolved on each entry only
 * (R2): the Hub doesn't live-refresh while displayed.
 */
async function renderHub(): Promise<void> {
  const frame = document.getElementById("hub-frame") as HTMLIFrameElement | null;
  const fallback = document.getElementById("hub-fallback");
  let home: string | null = null;
  try {
    home = await invoke<string | null>("resolve_home");
  } catch {
    home = null; // resolve_home unavailable (pre-Phase-2) → native fallback.
  }
  if (home && frame) {
    fallback?.setAttribute("hidden", "");
    frame.removeAttribute("hidden");
    // Theme the top bar from home.html's `companion-bar` block (if present).
    let spec: BarSpec | null = null;
    try {
      const html = await invoke<string>("read_artifact", { path: home });
      spec = parseBarSpec(html);
    } catch {
      spec = null;
    }
    applyBar(spec);
    // Full-bleed: load the authored dashboard; never feed it to fit()/resize.
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
  if (hello) hello.innerHTML = `${timeGreeting()}, <em>there.</em>`;
  if (cta) {
    const n = allSources.length;
    cta.textContent = n ? `View ${n} session${n === 1 ? "" : "s"} →` : "View sessions →";
  }
  fallback?.removeAttribute("hidden");
}

// ---- L1 Sessions picker -----------------------------------------------------

/** Render the light native picker: one status-only card per LIVE instance, with
 *  stale instances tucked behind a reversible "Archived" toggle. No iframes. */
function renderSessions(): void {
  const grid = document.getElementById("board-sessions-grid");
  const sub = document.getElementById("sessions-sub");
  if (!grid) return;
  const grouped = groupArtifacts();
  const now = Date.now();

  const live: LiveSource[] = [];
  const stale: LiveSource[] = [];
  for (const s of allSources) (isLiveSource(s, now) ? live : stale).push(s);

  const cards: HTMLElement[] = [];
  for (const s of live) {
    cards.push(buildSessionCard(s.source, grouped.get(s.source)?.length ?? 0));
  }
  const unsourced = grouped.get(UNSOURCED)?.length ?? 0;
  if (unsourced) cards.push(buildSessionCard(UNSOURCED, unsourced));

  // Stale instances aren't deleted (disk cleanup is the 7-day SessionStart prune)
  // — they collapse behind a one-click toggle so the roster shows only live work.
  if (stale.length) {
    cards.push(buildArchivedToggle(stale.length));
    if (showArchived) {
      for (const s of stale) {
        const card = buildSessionCard(s.source, grouped.get(s.source)?.length ?? 0);
        card.classList.add("archived");
        cards.push(card);
      }
    }
  }

  if (sub) {
    const n = live.length;
    sub.textContent = `${n} live agent${n === 1 ? "" : "s"} · ${allArtifacts.length} artifact${allArtifacts.length === 1 ? "" : "s"}`;
  }
  grid.replaceChildren(...cards);
}

/** The "Archived (N)" pill that reveals/hides stale instances on the roster. */
function buildArchivedToggle(n: number): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "session-archived-toggle";
  btn.textContent = showArchived ? `Hide archived (${n})` : `Archived (${n})`;
  btn.addEventListener("click", () => {
    showArchived = !showArchived;
    renderSessions();
  });
  return btn;
}

/** One Session picker card — reuses the L2 header model (mark/name/prov/status). */
function buildSessionCard(source: string, count: number): HTMLElement {
  const pane = buildSessionPane(source, []); // header fields only; tiles unused here

  const card = document.createElement("button");
  card.className = "session-card";
  card.dataset.source = source;

  const unread = unreadCount(source);
  if (unread > 0) {
    const badge = document.createElement("span");
    badge.className = "session-unread";
    badge.textContent = unread > 9 ? "9+" : String(unread);
    badge.title = `${unread} new artifact${unread === 1 ? "" : "s"} since you last looked`;
    card.append(badge);
  }

  const idRow = document.createElement("div");
  idRow.className = "pane-id";
  const mark = document.createElement("span");
  mark.className = "agent-mark" + (pane.isCloud ? " cloud" : "");
  mark.textContent = pane.mark;
  const who = document.createElement("div");
  who.className = "who";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = pane.name;
  const prov = document.createElement("div");
  prov.className = "prov";
  prov.textContent = pane.prov;
  who.append(name, prov);
  idRow.append(mark, who);

  // Instance disambiguator: two agents in one repo share a project name, so a
  // small #shortid chip tells the cards apart (the working line is the primary
  // signal). UNSOURCED has no instance, so no chip.
  const sid = source === UNSOURCED ? "" : shortIdOf(source);
  if (sid) {
    const chip = document.createElement("span");
    chip.className = "session-id-chip";
    chip.textContent = `#${sid}`;
    chip.title = `instance ${sid}`;
    idRow.append(chip);
  }

  card.append(idRow);
  // The Unsourced card has no live state — its only fact is the artifact count
  // (shown in the foot), so skip the status row (which would otherwise echo a
  // redundant "N artifacts with no live agent" derived from an empty list).
  if (source !== UNSOURCED) {
    const statusRow = document.createElement("div");
    statusRow.className = "pane-status";
    const dot = document.createElement("span");
    dot.className = "status-dot " + pane.level;
    dot.id = `session-dot-${source}`;
    const stext = document.createElement("span");
    stext.className = "status-text";
    stext.id = `session-status-${source}`;
    stext.innerHTML = pane.statusHtml;
    statusRow.append(dot, stext);
    card.append(statusRow);
  }

  const foot = document.createElement("div");
  foot.className = "session-foot";
  foot.textContent = `${count} artifact${count === 1 ? "" : "s"}`;
  card.append(foot);
  card.addEventListener("click", () => goSession(source));
  return card;
}

// ---- L2 Session detail (lifecycle) ------------------------------------------

/** Enter L2: build the single scoped pane, seed spans, observe, render. */
function enterSession(source: string): void {
  // Viewing a session clears its unread (the user is now seeing its artifacts).
  clearUnread(source);
  pendingIngest.delete(source);
  updateGlobalUnread();
  const grouped = groupArtifacts();
  const scoped = (grouped.get(source) ?? []).slice(0, MAX_SESSION_TILES);
  const pane = buildSessionPane(source, scoped);
  panes = [pane];
  spans.clear();
  for (const t of pane.tiles) spans.set(t.path, { c: t.cspan, r: t.rspan });

  selected = null;
  focusPath = null;
  arrivalPlayed = false;

  numCols = columnCount(boardEl.clientWidth || 1000);
  renderPanes();
  // A "View all in History →" affordance for sessions with more than the cap.
  renderViewAll(grouped.get(source)?.length ?? 0);
  scheduleArrival();
}

/** Tear down all L2 state when leaving a session (Trap 1 + 2): demote live
 *  tiles, drop the observer, clear panes/selection/focus. */
function leaveSession(): void {
  closeFocus();
  for (const tile of liveTiles.slice()) demoteTile(tile);
  liveTiles.length = 0;
  panesEl.replaceChildren();
  document.getElementById("board-viewall")?.remove();
  panes = [];
  selected = null;
  focusPath = null;
}

/** Insert/remove the "View all N in History →" link when a session is capped. */
function renderViewAll(total: number): void {
  document.getElementById("board-viewall")?.remove();
  if (total <= MAX_SESSION_TILES) return;
  const link = document.createElement("button");
  link.id = "board-viewall";
  link.className = "view-all";
  link.textContent = `View all ${total} in History →`;
  link.addEventListener("click", () => {
    invoke("open_history").catch((e) => console.error("open_history failed", e));
  });
  scrollEl.append(link);
}

// ---- data → panes -----------------------------------------------------------

/**
 * Group every artifact by its owning source slug (or UNSOURCED). Both the L1
 * Sessions picker (card counts) and the L2 session detail (tile scope) read from
 * THIS one function, so a card's count and its session always agree (Trap 4).
 * Newest-first within each group.
 */
function groupArtifacts(): Map<string, ArtifactEntry[]> {
  const grouped = new Map<string, ArtifactEntry[]>();
  for (const s of allSources) grouped.set(s.source, []);
  grouped.set(UNSOURCED, []);
  for (const art of allArtifacts) {
    grouped.get(sourceForArtifact(art))?.push(art);
  }
  for (const list of grouped.values()) list.sort((a, b) => b.modified_ms - a.modified_ms);
  return grouped;
}

/** Total fresh (overnight) artifacts across all sources — for the L0 greeting. */
function freshCount(): number {
  const now = Date.now();
  return allArtifacts.filter((a) => now - a.modified_ms < FRESH_WINDOW_MS).length;
}

/** Build the single L2 pane for `source` (the Unsourced pane has no live state). */
function buildSessionPane(source: string, artifacts: ArtifactEntry[]): Pane {
  if (source === UNSOURCED) {
    return {
      source: UNSOURCED,
      name: "Unsourced",
      prov: "ARTIFACTS · NO LIVE SOURCE",
      mark: "·",
      isCloud: false,
      level: "idle",
      statusHtml: `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} with no live agent`,
      cols: PANE_COLS,
      tiles: artifacts.map(toTile),
    };
  }
  const json = allSources.find((s) => s.source === source)?.json ?? "{}";
  return makePane(source, json, artifacts);
}

function makePane(source: string, json: string, artifacts: ArtifactEntry[]): Pane {
  let state: LiveState = {};
  try {
    state = JSON.parse(json) as LiveState;
  } catch {
    /* leave defaults */
  }
  const top = state.next?.[0];
  const level = levelFromKind(top?.kind);
  // Status line: prefer `working`, else the top `next` title; honor **bold** runs.
  const text = state.working || top?.title || "Idle";
  const name = state.project || source;
  const prov = provLine(state, source);
  return {
    source,
    name,
    prov,
    mark: markFor(name),
    isCloud: prov.startsWith("CLOUD"),
    level,
    statusHtml: boldRuns(text),
    cols: PANE_COLS,
    tiles: artifacts.map(toTile),
  };
}

/** A real ArtifactEntry → the design's tile shape (synthesizing bento fields). */
function toTile(art: ArtifactEntry): TileMeta {
  return {
    path: art.path,
    title: art.title,
    tag: art.subject || art.title || "artifact",
    summary: art.summary || "",
    cspan: DEFAULT_CSPAN,
    rspan: DEFAULT_RSPAN,
    fresh: Date.now() - art.modified_ms < FRESH_WINDOW_MS,
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

/** First initial/glyph for an agent mark. */
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

/** A source stem is `<slug>--<shortid>` (the live file basename). The slug
 *  sanitizer collapses runs of `-`, so a slug never contains `--`; split on the
 *  FIRST `--` to recover the per-instance shortid. */
function shortIdOf(source: string): string {
  const i = source.indexOf("--");
  return i >= 0 ? source.slice(i + 2) : "";
}

/** The project-match key for a source — the basename of its live `project`
 *  field, falling back to the stem's slug prefix. Artifacts carry only a project
 *  (not the instance id), so two instances of one repo share a key; routing
 *  treats that as ambiguous (see sourceForArtifact). */
function sourceProjectKey(s: LiveSource): string {
  let project: string | undefined;
  try {
    project = (JSON.parse(s.json) as LiveState).project ?? undefined;
  } catch {
    /* fall back to the stem */
  }
  const fromJson = projectSlug(project);
  if (fromJson) return fromJson;
  const i = s.source.indexOf("--");
  return i >= 0 ? s.source.slice(0, i) : s.source;
}

/** File mtime injected by read_all_live; 0 if unparseable. */
function sourceUpdatedMs(s: LiveSource): number {
  try {
    return (JSON.parse(s.json) as LiveState).updated_ms ?? 0;
  } catch {
    return 0;
  }
}

/** A source is LIVE if its file was touched within LIVENESS_MS; else it's stale
 *  (archived). Computed fresh on each renderSessions, so it's correct on entry. */
function isLiveSource(s: LiveSource, now: number): boolean {
  const u = sourceUpdatedMs(s);
  return u > 0 && now - u < LIVENESS_MS;
}

/** Escape, then turn **runs** into <b> (used in the mono status line). */
function boldRuns(text: string): string {
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

// ---- greeting + clock -------------------------------------------------------

function renderGreeting(fresh: number, agents: number): void {
  const hello = document.getElementById("board-hello");
  const sub = document.getElementById("board-sub");
  if (hello) {
    // The greeting name has no real source on the Board yet — a static italic
    // accent (the design's signature `.hello em` in clay) stands in until a
    // user identity is wired through (noted in handoff).
    hello.innerHTML = `${timeGreeting()}, <em>there.</em>`;
  }
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

function startClock(): void {
  const el = document.getElementById("board-clock");
  if (!el) return;
  const tick = () => {
    el.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  };
  tick();
  window.setInterval(tick, 30_000);
}

// ---- agent-composed bar (L0) ------------------------------------------------
// home.html may carry a `companion-bar` JSON block that themes the Board's top
// bar and fills its left/center/right slots, so the bar matches that day's
// dashboard. The mandatory control cluster (back/fullscreen/collapse/close)
// always renders regardless — agents compose CONTENT, never the controls.

interface BarItem {
  type: "title" | "clock" | "text" | "badge" | "link";
  text?: string;
  tone?: "accent" | "default";
  to?: string; // for link → a navigate target (e.g. "sessions", "session:x")
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

/** Extract the `companion-bar` JSON block from raw home.html, or null. */
function parseBarSpec(html: string): BarSpec | null {
  const m = html.match(
    /<script[^>]*id=["']companion-bar["'][^>]*>([\s\S]*?)<\/script>/i,
  );
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
      return e; // filled by the bar clock ticker
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
    return;
  }

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

  // Live clock for any `clock` items.
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
  else if (to.startsWith("session:")) {
    const slug = to.slice("session:".length);
    if (slug === UNSOURCED || allSources.some((s) => s.source === slug)) goSession(slug);
  } else if (to.startsWith("artifact:")) {
    void navigateToArtifact(to.slice("artifact:".length));
  }
}

// ---- render panes (masonry) -------------------------------------------------

function renderPanes(): void {
  // A re-render discards every existing tile element (replaceChildren below), so
  // drop the LRU refs the old tiles held — liveTiles[] would otherwise count
  // detached phantoms against the cap. Trade-off: a promoted (live) tile reverts
  // to its metadata card across a reorder/resize re-lay — rare for an overlay,
  // and far cheaper than leaking the prior set.
  liveTiles.length = 0;

  const weights: PaneWeight[] = panes.map((p) => ({
    source: p.source,
    cols: p.cols,
    area: p.tiles.reduce((s, t) => {
      const sp = spans.get(t.path);
      return s + (sp ? sp.c * sp.r : t.cspan * t.rspan);
    }, 0),
  }));
  const cols = distribute(weights, numCols);
  const bySource = new Map(panes.map((p) => [p.source, p]));

  const frag = document.createDocumentFragment();
  for (const col of cols) {
    const colEl = document.createElement("div");
    colEl.className = "masonry-col";
    for (const slot of col) {
      const el = renderSlot(slot, bySource);
      if (el) colEl.appendChild(el);
    }
    frag.appendChild(colEl);
  }
  panesEl.replaceChildren(frag);
}

function renderSlot(slot: Slot, bySource: Map<string, Pane>): HTMLElement | null {
  // The Board now scopes L2 to a single session, so the "Awaiting agent" empty
  // slot the roster used (distribute() always appends one) no longer applies —
  // drop it rather than paint a stray "Idle slot" card next to the tiles.
  if (slot.type === "empty") return null;
  const pane = bySource.get(slot.source);
  if (!pane) return null;
  return renderPane(pane);
}

function renderPane(pane: Pane): HTMLElement {
  const el = document.createElement("div");
  el.className = "pane";
  el.style.width = `calc(var(--u) * ${pane.cols} + var(--gap) * ${pane.cols - 1})`;

  const head = document.createElement("div");
  head.className = "pane-head";

  const idRow = document.createElement("div");
  idRow.className = "pane-id";
  const mark = document.createElement("span");
  mark.className = "agent-mark" + (pane.isCloud ? " cloud" : "");
  mark.textContent = pane.mark;
  const who = document.createElement("div");
  who.className = "who";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = pane.name;
  const prov = document.createElement("div");
  prov.className = "prov";
  prov.textContent = pane.prov;
  who.append(name, prov);
  idRow.append(mark, who);

  const statusRow = document.createElement("div");
  statusRow.className = "pane-status";
  const dot = document.createElement("span");
  dot.className = "status-dot " + pane.level;
  const stext = document.createElement("span");
  stext.className = "status-text";
  stext.id = `pane-status-${pane.source}`;
  stext.innerHTML = pane.statusHtml;
  statusRow.append(dot, stext);

  head.append(idRow, statusRow);

  const rule = document.createElement("div");
  rule.className = "pane-head-rule";

  const body = document.createElement("div");
  body.className = "pane-body";
  body.style.setProperty("--cols", String(pane.cols));
  if (pane.tiles.length === 0) {
    const none = document.createElement("div");
    none.className = "pane-empty";
    none.textContent = "No artifacts";
    body.append(none);
  } else {
    for (const t of pane.tiles) body.appendChild(buildTile(t, pane));
  }

  el.append(head, rule, body);
  return el;
}

// ---- tile (bento cell: metadata card by default ⇄ live iframe on select) -----
//
// PERF: a tile defaults to a lightweight metadata CARD (title + summary, no
// iframe parse/layout/paint). The live `asset:` iframe is mounted only on
// select/focus (promoteTile), capped by MAX_LIVE_TILES. This removes the
// per-visible-tile full-document cost that made scrolling churn — the only
// off-screen work is now plain DOM. The iframe element is kept in every tile
// (resize/reorder/FLIP query `.art-frame`); `.is-live` reveals it over the card.

function buildTile(meta: TileMeta, pane: Pane): HTMLElement {
  const tile = document.createElement("div");
  tile.className = "artifact" + (meta.fresh ? " fresh" : "");
  tile.dataset.path = meta.path;
  tile.dataset.aid = meta.path;
  if (meta.fresh) tile.dataset.fresh = "1";
  const sp = spans.get(meta.path) ?? { c: meta.cspan, r: meta.rspan };
  tile.style.setProperty("--cspan", String(sp.c));
  tile.style.setProperty("--rspan", String(sp.r));

  const inner = document.createElement("div");
  inner.className = "art-inner";
  const iframe = document.createElement("iframe");
  iframe.className = "art-frame";
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.tabIndex = -1;
  inner.append(iframe);

  // The default-visible cheap layer (hidden by CSS once the tile is .is-live).
  const card = document.createElement("div");
  card.className = "art-card";
  const cTitle = document.createElement("div");
  cTitle.className = "ac-title";
  cTitle.textContent = meta.title;
  card.append(cTitle);
  if (meta.summary) {
    const cSum = document.createElement("div");
    cSum.className = "ac-sum";
    cSum.textContent = meta.summary;
    card.append(cSum);
  }

  const tag = document.createElement("span");
  tag.className = "art-tag";
  tag.textContent = `${pane.mark} · ${meta.tag}`;

  const drag = document.createElement("div");
  drag.className = "drag-h";
  drag.title = "Drag to rearrange";
  drag.innerHTML =
    `<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="5" cy="4" r="1.3"/><circle cx="11" cy="4" r="1.3"/><circle cx="5" cy="8" r="1.3"/><circle cx="11" cy="8" r="1.3"/><circle cx="5" cy="12" r="1.3"/><circle cx="11" cy="12" r="1.3"/></svg>`;

  const handle = document.createElement("div");
  handle.className = "resize-h";
  handle.title = "Drag to resize";

  tile.append(inner, card, tag, drag, handle);
  wireResize(tile, iframe, handle, pane.cols);
  wireReorder(tile, drag, pane);

  tile.addEventListener("click", () => { selectTile(meta.path); });
  tile.addEventListener("dblclick", () => { void expand(meta.path); });

  return tile;
}

/** Promote a tile to a LIVE `asset:` iframe (its JS runs, ✓/✎/✗ work). LRU-capped. */
async function promoteTile(tile: HTMLElement): Promise<void> {
  const iframe = tile.querySelector(".art-frame") as HTMLIFrameElement | null;
  if (!iframe) return;
  const existing = liveTiles.indexOf(tile);
  if (existing !== -1) liveTiles.splice(existing, 1);
  while (liveTiles.length >= MAX_LIVE_TILES) {
    const lru = liveTiles.shift();
    if (lru) demoteTile(lru);
  }
  liveTiles.push(tile);
  tile.classList.add("is-live");
  iframe.style.width = "";
  iframe.style.height = "";
  iframe.style.transform = "";
  const path = tile.dataset.path;
  if (!path) return;
  await loadArtifactInto(path, iframe).catch((e) => console.error("loadArtifactInto failed", path, e));
}

function demoteTile(tile: HTMLElement): void {
  tile.classList.remove("is-live");
  const iframe = tile.querySelector(".art-frame") as HTMLIFrameElement | null;
  if (!iframe) return;
  // Drop the live document; the cheap metadata card shows through again.
  iframe.removeAttribute("src");
  iframe.removeAttribute("srcdoc");
}

/** Select a tile (clay ring) and promote it to live so it's interactive. */
function selectTile(path: string): void {
  selected = path;
  for (const el of panesEl.querySelectorAll<HTMLElement>(".artifact.selected")) el.classList.remove("selected");
  const tile = panesEl.querySelector(`[data-aid="${cssEsc(path)}"]`) as HTMLElement | null;
  if (!tile) return;
  tile.classList.add("selected");
  if (!tile.classList.contains("is-live")) void promoteTile(tile);
}

// ---- span resize (bento, not pixels) ----------------------------------------

function wireResize(tile: HTMLElement, iframe: HTMLIFrameElement, handle: HTMLElement, maxCols: number): void {
  handle.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const path = tile.dataset.path;
    if (!path) return;
    const startW = tile.offsetWidth;
    const startH = tile.offsetHeight;
    const sx = e.clientX;
    const sy = e.clientY;
    const cell = cellPx();
    iframe.style.pointerEvents = "none";
    document.body.style.userSelect = "none";
    handle.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      const c = Math.max(1, Math.min(maxCols, Math.round((startW + (ev.clientX - sx)) / cell)));
      const r = Math.max(1, Math.min(4, Math.round((startH + (ev.clientY - sy)) / cell)));
      const cur = spans.get(path);
      if (cur && cur.c === c && cur.r === r) return;
      spans.set(path, { c, r });
      tile.style.setProperty("--cspan", String(c));
      tile.style.setProperty("--rspan", String(r));
    };
    const up = (ev: PointerEvent) => {
      iframe.style.pointerEvents = "";
      document.body.style.userSelect = "";
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}

// ---- drag-reorder within a pane ---------------------------------------------

function wireReorder(tile: HTMLElement, grip: HTMLElement, pane: Pane): void {
  grip.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const path = tile.dataset.path;
    if (!path) return;
    selectTile(path);
    const startX = e.clientX;
    const startY = e.clientY;
    let dropPath: string | null = null;
    tile.classList.add("dragging");
    grip.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      tile.style.transform = `translate(${ev.clientX - startX}px, ${ev.clientY - startY}px)`;
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.("[data-aid]") as HTMLElement | null;
      const overPath = under?.dataset.aid;
      const valid = overPath && overPath !== path && pane.tiles.some((t) => t.path === overPath) ? overPath : null;
      if (valid === dropPath) return;
      for (const el of panesEl.querySelectorAll(".drop-target")) el.classList.remove("drop-target");
      dropPath = valid ?? null;
      if (dropPath) under?.classList.add("drop-target");
    };
    const up = (ev: PointerEvent) => {
      grip.releasePointerCapture(ev.pointerId);
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      tile.classList.remove("dragging");
      tile.style.transform = "";
      for (const el of panesEl.querySelectorAll(".drop-target")) el.classList.remove("drop-target");
      if (dropPath) {
        const from = pane.tiles.findIndex((t) => t.path === path);
        const to = pane.tiles.findIndex((t) => t.path === dropPath);
        if (from !== -1 && to !== -1) {
          const [moved] = pane.tiles.splice(from, 1);
          pane.tiles.splice(to, 0, moved);
          renderPanes(); // re-lay the bento with the new order
        }
      }
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
}

// ---- focus / expand (FLIP, dedicated iframe) --------------------------------

async function expand(path: string): Promise<void> {
  const tile = panesEl.querySelector(`[data-aid="${cssEsc(path)}"]`) as HTMLElement | null;
  if (!tile || focusPath) return;
  const nb = tile.getBoundingClientRect();
  const bb = boardEl.getBoundingClientRect();
  const sp = spans.get(path) ?? { c: DEFAULT_CSPAN, r: DEFAULT_RSPAN };

  // target geometry (centered) in board coords
  const maxW = Math.min(bb.width * 0.62, 760);
  const aspect = sp.c / sp.r;
  let tw = maxW;
  let th = tw / (aspect * 1.15);
  const maxH = bb.height * 0.78;
  if (th > maxH) { th = maxH; tw = th * aspect * 1.15; }
  const tl = (bb.width - tw) / 2;
  const tt = (bb.height - th) / 2;
  const from = { x: nb.left - bb.left, y: nb.top - bb.top, w: nb.width, h: nb.height };

  focusPath = path;
  tile.style.visibility = "hidden";

  // Build the focus card with its OWN live iframe (kept out of the tile LRU so
  // it never evicts a tile; the source tile keeps its own iframe state intact).
  const card = document.createElement("div");
  card.className = "focus-card shown";
  card.style.left = `${tl}px`;
  card.style.top = `${tt}px`;
  card.style.width = `${tw}px`;
  card.style.height = `${th}px`;
  card.style.transformOrigin = "top left";

  const inner = document.createElement("div");
  inner.className = "art-inner";
  focusFrame = document.createElement("iframe");
  focusFrame.className = "art-frame";
  focusFrame.setAttribute("sandbox", "allow-scripts");
  focusFrame.setAttribute("referrerpolicy", "no-referrer");
  inner.append(focusFrame);

  const head = document.createElement("div");
  head.className = "focus-head";
  const pane = panes.find((p) => p.tiles.some((t) => t.path === path));
  head.innerHTML = `
    <span class="agent-mark${pane?.isCloud ? " cloud" : ""}">${pane?.mark ?? "·"}</span>
    <div class="pane-id"><div class="who"><div class="name">${escapeHtml(pane?.name ?? "")}</div><div class="prov">${escapeHtml(pane?.prov ?? "")}</div></div></div>`;
  const close = document.createElement("button");
  close.className = "focus-close";
  close.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
  close.addEventListener("click", closeFocus);
  head.append(close);

  card.append(inner, head);
  card.dataset.focusCard = "1";
  boardEl.append(card);
  scrimEl.classList.add("on");

  await loadArtifactInto(path, focusFrame).catch((e) => console.error("focus load failed", path, e));

  // FLIP: animate from the tile's rect to the resting (expanded) rect.
  if (document.visibilityState === "visible" && !prefersReducedMotion()) {
    const dx = from.x - tl;
    const dy = from.y - tt;
    const sxs = from.w / tw;
    const sys = from.h / th;
    card.animate(
      [
        { transform: `translate(${dx}px,${dy}px) scale(${sxs},${sys})`, transformOrigin: "top left" },
        { transform: "none", transformOrigin: "top left" },
      ],
      { duration: 460, easing: "cubic-bezier(0.22,1,0.36,1)" },
    );
  }
}

function closeFocus(): void {
  const card = boardEl.querySelector("[data-focus-card]") as HTMLElement | null;
  const path = focusPath;
  const tile = path ? (panesEl.querySelector(`[data-aid="${cssEsc(path)}"]`) as HTMLElement | null) : null;
  scrimEl.classList.remove("on");

  const finish = () => {
    card?.remove();
    focusFrame = null;
    focusPath = null;
    if (tile) tile.style.visibility = "visible";
    // Flush any session rebuild we deferred while the overlay was open.
    if (pendingIngest.size) {
      const v = currentView();
      const due = v.level === "session" && pendingIngest.has(v.source) ? v.source : null;
      pendingIngest.clear();
      if (due) ingestIntoSession(due);
    }
  };

  if (!card || document.visibilityState !== "visible" || prefersReducedMotion()) {
    finish();
    return;
  }
  card.classList.remove("shown");
  if (tile) {
    const nb = tile.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const dx = nb.left - cr.left;
    const dy = nb.top - cr.top;
    const sxs = nb.width / cr.width;
    const sys = nb.height / cr.height;
    const anim = card.animate(
      [
        { transform: "none", transformOrigin: "top left" },
        { transform: `translate(${dx}px,${dy}px) scale(${sxs},${sys})`, transformOrigin: "top left" },
      ],
      { duration: 360, easing: "cubic-bezier(0.4,0,0.2,1)", fill: "forwards" },
    );
    anim.onfinish = finish;
    window.setTimeout(finish, 440);
  } else {
    finish();
  }
}

// ---- arrival reveal ---------------------------------------------------------

function playArrival(): void {
  if (prefersReducedMotion()) return;
  const nodes = [...panesEl.querySelectorAll<HTMLElement>('[data-fresh="1"]')];
  nodes.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return ra.top - rb.top || ra.left - rb.left;
  });
  nodes.forEach((el, i) => {
    el.animate(
      [
        { opacity: 0, transform: "translateY(16px) scale(0.985)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 660, delay: i * 95, easing: "cubic-bezier(0.22,1,0.36,1)", fill: "both" },
    );
  });
}

function scheduleArrival(): void {
  const run = () => {
    if (arrivalPlayed) return;
    if (document.visibilityState !== "visible") return;
    arrivalPlayed = true;
    requestAnimationFrame(() => requestAnimationFrame(playArrival));
    document.removeEventListener("visibilitychange", run);
  };
  run();
  if (!arrivalPlayed) document.addEventListener("visibilitychange", run);
}

function replayArrival(): void {
  arrivalPlayed = true;
  requestAnimationFrame(() => requestAnimationFrame(playArrival));
}

// ---- live-state polling (headers only) --------------------------------------

async function pollLive(): Promise<void> {
  let sources: LiveSource[] = [];
  try {
    sources = await invoke<LiveSource[]>("read_all_live");
  } catch (e) {
    console.error("read_all_live failed", e);
    return;
  }
  // Keep the cached source list current so re-entering L1 reflects fresh state.
  allSources = sources;
  const view = currentView();
  for (const s of sources) {
    if (lastJsonBySource.get(s.source) === s.json) continue;
    lastJsonBySource.set(s.source, s.json);
    if (view.level === "session") updateHeader(s.source, s.json);
    else if (view.level === "sessions") updateSessionCard(s.source, s.json);
    // L0 Hub: no live-refresh of the dashboard (R2 — re-resolves on entry only).
  }

  // Live artifact ingestion: re-read the artifact set and act only when it
  // actually changed (the common case is an unchanged signature → cheap no-op).
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

// ---- live artifact ingestion ------------------------------------------------

/** A cheap fingerprint of the artifact set — path + mtime, so a rewrite (same
 *  path, new mtime) registers as a change too. */
function artifactSig(arts: ArtifactEntry[]): string {
  return arts.map((a) => `${a.path}:${a.modified_ms}`).join("|");
}

/** The source an artifact belongs to (its live instance, else UNSOURCED). The
 *  single routing authority — groupArtifacts() and navigateToArtifact() both call
 *  it, so routing always agrees. An artifact is tagged only with a `project`, not
 *  an instance id, so it routes to the UNIQUE live instance of that project; if
 *  two instances of one repo are live, that's ambiguous → UNSOURCED. (Precise
 *  per-instance routing waits for the living-hub phase, where each instance
 *  authors one hub stamped with its id.) */
function sourceForArtifact(a: ArtifactEntry): string {
  const key = projectSlug(a.project);
  if (!key) return UNSOURCED;
  const matches = allSources.filter((s) => sourceProjectKey(s) === key);
  return matches.length === 1 ? matches[0].source : UNSOURCED;
}

function addUnread(source: string, path: string): void {
  let set = unreadBySource.get(source);
  if (!set) {
    set = new Set();
    unreadBySource.set(source, set);
  }
  set.add(path);
}
function unreadCount(source: string): number {
  return unreadBySource.get(source)?.size ?? 0;
}
function clearUnread(source: string): void {
  unreadBySource.delete(source);
}
function totalUnread(): number {
  let n = 0;
  for (const set of unreadBySource.values()) n += set.size;
  return n;
}

/**
 * Reconcile a fresh artifact list against what we've seen: route NEW artifacts
 * to their session (unread unless that session is on screen), prune deleted
 * ones, then refresh whatever level is showing.
 */
function ingestArtifacts(artifacts: ArtifactEntry[]): void {
  const present = new Set(artifacts.map((a) => a.path));
  const newOnes = artifacts.filter((a) => !knownPaths.has(a.path));
  allArtifacts = artifacts;
  for (const a of artifacts) knownPaths.add(a.path);

  // Drop deleted artifacts from the known + unread sets so a stale badge can't
  // outlive its file.
  for (const p of [...knownPaths]) if (!present.has(p)) knownPaths.delete(p);
  for (const [src, set] of unreadBySource) {
    for (const p of [...set]) if (!present.has(p)) set.delete(p);
    if (set.size === 0) unreadBySource.delete(src);
  }

  const view = currentView();
  const viewing = view.level === "session" ? view.source : null;
  for (const a of newOnes) {
    const src = sourceForArtifact(a);
    // An artifact for the session you're looking at ingests live (already "read");
    // any other session's gets flagged unread.
    if (src !== viewing) addUnread(src, a.path);
  }

  if (view.level === "sessions") renderSessions();
  else if (view.level === "session") ingestIntoSession(view.source);
  updateGlobalUnread();
}

/** Refresh the on-screen L2 session IF its membership changed — preserving
 *  scroll + selection, deferring while the focus overlay is open, and animating
 *  only the newly-arrived tiles. A pure rewrite (same membership) is left alone
 *  so streaming work never yanks the surface out from under the reader. */
function ingestIntoSession(source: string): void {
  const scoped = (groupArtifacts().get(source) ?? []).slice(0, MAX_SESSION_TILES);
  const nextPaths = scoped.map((a) => a.path);
  const curPaths = (panes[0]?.tiles ?? []).map((t) => t.path);
  if (sameSet(nextPaths, curPaths)) return; // membership unchanged → no tear-down

  // A rebuild discards every tile element, which would strand the FLIP overlay's
  // target. Defer until closeFocus() flushes it.
  if (focusPath !== null) {
    pendingIngest.add(source);
    return;
  }
  const arrivals = new Set(nextPaths.filter((p) => !curPaths.includes(p)));
  rebuildSession(source, scoped, arrivals);
}

/** Re-lay the L2 pane for `source`, keeping the reader in place. */
function rebuildSession(source: string, scoped: ArtifactEntry[], arrivals: Set<string>): void {
  const keepScroll = scrollEl.scrollTop;
  const keepSelected = selected;
  const pane = buildSessionPane(source, scoped);
  panes = [pane];
  for (const t of pane.tiles) if (!spans.has(t.path)) spans.set(t.path, { c: t.cspan, r: t.rspan });
  numCols = columnCount(boardEl.clientWidth || 1000);
  renderPanes();
  renderViewAll(groupArtifacts().get(source)?.length ?? 0);
  scrollEl.scrollTop = keepScroll;
  if (keepSelected && pane.tiles.some((t) => t.path === keepSelected)) selectTile(keepSelected);
  if (arrivals.size) playArrivalFor(arrivals);
}

/** Order-independent set equality for two path lists. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  for (const x of b) if (!s.has(x)) return false;
  return true;
}

/** Stagger-reveal just the named tiles (used when artifacts ingest mid-session). */
function playArrivalFor(paths: Set<string>): void {
  if (prefersReducedMotion()) return;
  const nodes = [...paths]
    .map((p) => panesEl.querySelector<HTMLElement>(`[data-aid="${cssEsc(p)}"]`))
    .filter((n): n is HTMLElement => n !== null);
  nodes.forEach((el, i) => {
    el.animate(
      [
        { opacity: 0, transform: "translateY(16px) scale(0.985)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 660, delay: i * 95, easing: "cubic-bezier(0.22,1,0.36,1)", fill: "both" },
    );
  });
}

/** Sync the global Board unread badge + notify a cooperative L0 dashboard. */
function updateGlobalUnread(): void {
  const total = totalUnread();
  const btn = document.getElementById("board-unread");
  const count = document.getElementById("board-unread-count");
  if (btn) btn.toggleAttribute("hidden", total === 0);
  if (count) count.textContent = total > 99 ? "99+" : String(total);
  postUnreadToHub();
}

/** Post unread counts into the full-bleed home.html iframe (L0 only). A
 *  cooperative dashboard can render them; others simply ignore the message. */
function postUnreadToHub(): void {
  if (currentView().level !== "hub") return;
  const frame = document.getElementById("hub-frame") as HTMLIFrameElement | null;
  if (!frame || frame.hasAttribute("hidden") || !frame.contentWindow) return;
  const counts: Record<string, number> = {};
  for (const [src, set] of unreadBySource) counts[src] = set.size;
  frame.contentWindow.postMessage(
    { source: "companion", kind: "unread", total: totalUnread(), counts },
    "*",
  );
}

/** Live-update an L1 Sessions card's status dot + line (no `pane-status-` ids here). */
function updateSessionCard(source: string, json: string): void {
  const dot = document.getElementById(`session-dot-${source}`);
  const stext = document.getElementById(`session-status-${source}`);
  if (!dot && !stext) return;
  let state: LiveState = {};
  try {
    state = JSON.parse(json) as LiveState;
  } catch {
    return;
  }
  const top = state.next?.[0];
  if (dot) dot.className = "status-dot " + levelFromKind(top?.kind);
  if (stext) stext.innerHTML = boldRuns(state.working || top?.title || "Idle");
}

/** Re-render a pane's status dot + line in place (the bento tiles are untouched). */
function updateHeader(source: string, json: string): void {
  const pane = panes.find((p) => p.source === source);
  if (!pane) return; // appeared mid-session — dynamic add is deferred
  let state: LiveState = {};
  try {
    state = JSON.parse(json) as LiveState;
  } catch {
    return;
  }
  const top = state.next?.[0];
  pane.level = levelFromKind(top?.kind);
  pane.statusHtml = boldRuns(state.working || top?.title || "Idle");

  const stext = document.getElementById(`pane-status-${source}`);
  if (stext) {
    stext.classList.add("fading");
    window.setTimeout(() => {
      stext.innerHTML = pane.statusHtml;
      stext.classList.remove("fading");
      const dot = stext.previousElementSibling;
      if (dot) dot.className = "status-dot " + pane.level;
    }, 120);
  }
}

// ---- pill (collapsed state) -------------------------------------------------

function showPill(): void {
  const pill = document.getElementById("board-pill");
  if (!pill) return;
  closeFocus();
  boardEl.setAttribute("hidden", "");
  pill.removeAttribute("hidden");

  // Summarize ALL agents (allSources), not the single mounted L2 pane — the pill
  // is an at-a-glance roster, reachable from any level (Hub/Sessions/Session).
  const summary = allSources.map(sourceSummary);
  const line1 = document.getElementById("pill-line1");
  const line2 = document.getElementById("pill-line2");
  const orbs = document.getElementById("pill-orbs");
  const waiting = summary.find((s) => s.level === "wait");
  if (line1) {
    line1.innerHTML = waiting
      ? `${escapeHtml(waiting.name)} <b>needs your review</b>`
      : "All agents nominal";
  }
  const fresh = freshCount();
  if (line2) {
    line2.textContent = `${summary.length} agents · ${fresh} new · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  }
  if (orbs) {
    orbs.replaceChildren();
    for (const s of summary) {
      const orb = document.createElement("span");
      orb.className = "pill-orb";
      orb.style.background = orbColor(s.level);
      orbs.append(orb);
    }
  }
}

/** Name + status level for one live source (for the pill roster). */
function sourceSummary(s: LiveSource): { name: string; level: StatusLevel } {
  let state: LiveState = {};
  try {
    state = JSON.parse(s.json) as LiveState;
  } catch {
    /* defaults */
  }
  return {
    name: state.project || s.source,
    level: levelFromKind(state.next?.[0]?.kind),
  };
}

function hidePill(): void {
  document.getElementById("board-pill")?.setAttribute("hidden", "");
  boardEl.removeAttribute("hidden");
}

function orbColor(level: StatusLevel): string {
  switch (level) {
    case "wait":
      return "var(--accent)";
    case "busy":
      return "var(--busy)";
    case "ok":
      return "var(--ok)";
    default:
      return "var(--idle)";
  }
}

// ---- controls + keyboard + resize -------------------------------------------

function wireControls(): void {
  document.getElementById("board-close")?.addEventListener("click", () => {
    win.hide().catch((e) => console.error("board hide failed", e));
  });
  document.getElementById("board-replay")?.addEventListener("click", () => {
    hidePill();
    replayArrival();
  });
  document.getElementById("board-collapse")?.addEventListener("click", showPill);
  document.getElementById("board-pill")?.addEventListener("click", hidePill);
  document.getElementById("board-fullscreen")?.addEventListener("click", toggleFullscreen);
  document.getElementById("board-back")?.addEventListener("click", goBack);
  document.getElementById("board-unread")?.addEventListener("click", goSessions);
  document.getElementById("hub-sessions-btn")?.addEventListener("click", goSessions);
  scrimEl?.addEventListener("click", closeFocus);
}

/**
 * Listen for messages from artifact/Hub iframes inside the Board. Its OWN listener
 * — NOT initFit (which resizes the window; the Hub is full-bleed and must never
 * drive a resize). Handles `navigate` (drill the Board) and `submit` (an artifact's
 * ✓/✎/✗ review → clipboard, so the user can respond from inside the Board); `size`
 * is ignored. Payloads are UNTRUSTED: `session:<slug>` must be a known live source;
 * `artifact:<path>` must pass `artifact_in_scope` before we drill to it.
 */
function wireNavigate(): void {
  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data;
    if (isNavigateMessage(d)) {
      navigateTo(d.to);
      return;
    }
    // An artifact opened in the Board (its focus view, or a live tile) posts its
    // compiled review here. Route it to the clipboard, tagged with the focused
    // artifact's path, so a Board artifact is actually answerable (⌘V to paste).
    if (
      d &&
      d.source === "companion-artifact" &&
      d.kind === "submit" &&
      typeof d.text === "string"
    ) {
      void handleSubmit(d.text, focusPath ?? undefined);
    }
  });
}

/** Validate an artifact path is in scope, then drill to its session with it
 *  focused (R3 — keep navigation inside the Board; no floating panel). */
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
  const source = art ? sourceForArtifact(art) : UNSOURCED;
  goSession(source);
  // Focus the requested tile once the session has laid out.
  requestAnimationFrame(() => {
    if (panes.some((p) => p.tiles.some((t) => t.path === path))) selectTile(path);
  });
}

function toggleFullscreen(): void {
  invoke<boolean>("set_board_fullscreen", { on: !isFullscreen })
    .then((on) => {
      isFullscreen = on;
      stageEl.classList.toggle("fullscreen", on);
      // Re-measure the column count for the new surface size (L2 only).
      window.setTimeout(() => {
        if (currentView().level !== "session") return;
        numCols = columnCount(boardEl.clientWidth || 1000);
        renderPanes();
      }, 60);
    })
    .catch((e) => console.error("set_board_fullscreen failed", e));
}

function wireKeyboard(): void {
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    const pillShown = !document.getElementById("board-pill")?.hasAttribute("hidden");
    if (pillShown) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        hidePill();
      }
      return;
    }
    if (focusPath) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeFocus();
      }
      return;
    }
    // ESC precedence (R/plan): focus open (above) → tile selected → level-up.
    if (e.key === "Escape") {
      e.preventDefault();
      if (selected) clearSelection();
      else goBack();
      return;
    }
    // The remaining keys are L2-only (spatial tile nav / expand / fullscreen).
    if (currentView().level !== "session") return;
    switch (e.key) {
      case "ArrowRight":
      case "Tab":
        e.preventDefault();
        spatialMove(e.shiftKey ? "left" : "right");
        break;
      case "ArrowLeft":
        e.preventDefault();
        spatialMove("left");
        break;
      case "ArrowDown":
        e.preventDefault();
        spatialMove("down");
        break;
      case "ArrowUp":
        e.preventDefault();
        spatialMove("up");
        break;
      case "Enter":
        if (selected) {
          e.preventDefault();
          void expand(selected);
        }
        break;
      case "f":
      case "F":
        toggleFullscreen();
        break;
      default:
        break;
    }
  });
}

type Dir = "left" | "right" | "up" | "down";

function spatialMove(dir: Dir): void {
  const nodes = [...panesEl.querySelectorAll<HTMLElement>("[data-aid]")];
  if (!nodes.length) return;
  const rects = nodes.map((n) => {
    const r = n.getBoundingClientRect();
    return { id: n.dataset.aid as string, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  });
  if (!selected) {
    selectTile(rects[0].id);
    return;
  }
  const cur = rects.find((x) => x.id === selected);
  if (!cur) {
    selectTile(rects[0].id);
    return;
  }
  let best: { id: string } | null = null;
  let bestScore = Infinity;
  for (const cand of rects) {
    if (cand.id === selected) continue;
    const dx = cand.cx - cur.cx;
    const dy = cand.cy - cur.cy;
    const ok = dir === "right" ? dx > 8 : dir === "left" ? dx < -8 : dir === "down" ? dy > 8 : dy < -8;
    if (!ok) continue;
    const along = dir === "left" || dir === "right" ? Math.abs(dx) : Math.abs(dy);
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = along + across * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  if (best) {
    selectTile(best.id);
    const el = panesEl.querySelector(`[data-aid="${cssEsc(best.id)}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
}

function clearSelection(): void {
  selected = null;
  for (const el of panesEl.querySelectorAll<HTMLElement>(".artifact.selected")) el.classList.remove("selected");
}

/** Add `.is-scrolling` to the board while the L2 list scrolls, so CSS can pause
 *  the repaint-heavy paper-tex blend + status-dot pulse (cleared after idle). */
function wireScrollGating(): void {
  let timer = 0;
  scrollEl.addEventListener(
    "scroll",
    () => {
      boardEl.classList.add("is-scrolling");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => boardEl.classList.remove("is-scrolling"), 140);
    },
    { passive: true },
  );
}

function observeResize(): void {
  const ro = new ResizeObserver(() => {
    if (currentView().level !== "session") return;
    const n = columnCount(boardEl.clientWidth || 1000);
    if (n === numCols) return;
    numCols = n;
    renderPanes();
  });
  ro.observe(boardEl);
}

// ---- small utils ------------------------------------------------------------

function setStatus(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.removeAttribute("hidden");
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Escape a path for use inside a CSS attribute selector. */
function cssEsc(s: string): string {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}
