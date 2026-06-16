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
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { handleSubmit } from "./submit";
import { loadArtifactInto } from "./artifact-view";
import { isNavigateMessage } from "./resize";
import { renderLiveState, type LiveState as LiveStateBody } from "./live-render";

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
  /** Emitted by the companion-livepath hook: true when the session is in a git
   *  repo. Absent for pre-hook sessions → derived heuristically. */
  is_repo?: boolean;
  /** Emitted by the hook: the AUTHORITATIVE unit key (slug for a repo,
   *  slug--shortid for a bare session). The digest filename keys off this. */
  unit_key?: string;
}

type StatusLevel = "wait" | "busy" | "ok" | "idle";

/** Header fields for one source — shared by L1 unit cards and L2 lanes. */
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
/** Poll cadence for live-state — matches live.ts's calm cadence. */
const POLL_MS = 1200;
/** An instance whose live file hasn't been touched within this window is "stale"
 *  — it drops off the live roster into the reversible Archived toggle. */
const LIVENESS_MS = 30 * 60 * 1000;
/** An artifact modified within this window counts as in-flight / fresh. */
const FRESH_WINDOW_MS = 12 * 60 * 60 * 1000;

const win = getCurrentWebviewWindow();

/** The Board's three drill-down levels. L0 Hub → L1 Sessions → L2 one unit. */
type BoardView =
  | { level: "hub" }
  | { level: "sessions" }
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

let isFullscreen = false;
/** Whether the L1 roster's stale (archived) units are revealed. */
let showArchived = false;
/** The reader overlay's dedicated live iframe + the path it's showing (null = closed). */
let focusFrame: HTMLIFrameElement | null = null;
let focusPath: string | null = null;

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
let sessionsEl: HTMLElement;
let unitEl: HTMLElement;
let digestEl: HTMLIFrameElement;
let lanesEl: HTMLElement;
let historyEl: HTMLElement;

export async function initBoard(): Promise<void> {
  const stage = document.getElementById("board-stage");
  const board = document.getElementById("board");
  const scrim = document.getElementById("board-scrim");
  const status = document.getElementById("board-status");
  const hub = document.getElementById("board-hub");
  const sessions = document.getElementById("board-sessions");
  const unit = document.getElementById("board-unit");
  const digest = document.getElementById("unit-digest") as HTMLIFrameElement | null;
  const lanes = document.getElementById("unit-lanes");
  const history = document.getElementById("unit-history");
  // The single-artifact / other surfaces share this bundle — hide them.
  document.getElementById("frame")?.setAttribute("hidden", "");
  document.getElementById("empty")?.setAttribute("hidden", "");
  document.getElementById("controls")?.setAttribute("hidden", "");
  if (!stage || !board || !scrim || !status || !hub || !sessions || !unit || !digest || !lanes || !history) return;

  stageEl = stage;
  boardEl = board;
  scrimEl = scrim;
  hubEl = hub;
  sessionsEl = sessions;
  unitEl = unit;
  digestEl = digest;
  lanesEl = lanes;
  historyEl = history;
  stage.removeAttribute("hidden");

  wireControls();
  wireKeyboard();
  wireNavigate();
  wireLaneActions();
  wireHistoryClicks();
  wireScrollGating();
  startClock();

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

  for (const s of allSources) lastJsonBySource.set(s.source, s.json);
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
  unitEl.toggleAttribute("hidden", level !== "unit");
  document.getElementById("board-back")?.toggleAttribute("hidden", level === "hub");
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

/** Enter L1 — the native Sessions picker, grouped by unit. */
function goSessions(): void {
  leaveUnit(); // also clears any L2 digest bar theming
  if (currentView().level !== "sessions") viewStack.push({ level: "sessions" });
  showLevel("sessions");
  renderUnits();
}

/** Enter L2 — one unit's home. Replace rather than stack if already at a unit
 *  (e.g. an artifact-navigate across units), so back-nav stays one level up. */
function goUnit(unitKey: string): void {
  leaveUnit(); // clears prior theming; renderDigest re-themes if this unit authored a home
  if (currentView().level === "unit") viewStack.pop();
  viewStack.push({ level: "unit", unitKey });
  showLevel("unit");
  enterUnit(unitKey);
}

/** Pop one level: Unit → Sessions → Hub. */
function goBack(): void {
  if (viewStack.length <= 1) return;
  viewStack.pop();
  const v = currentView();
  if (v.level === "hub") void goHub();
  else if (v.level === "sessions") {
    leaveUnit();
    showLevel("sessions");
    renderUnits();
  }
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
  if (hello) hello.innerHTML = `${timeGreeting()}, <em>there.</em>`;
  if (cta) {
    const n = allSources.length;
    cta.textContent = n ? `View ${n} session${n === 1 ? "" : "s"} →` : "View sessions →";
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
  const st = parseState(s.json);
  if (st.unit_key) return st.unit_key;
  if (st.is_repo === false) return s.source;
  return sourceProjectKey(s);
}

/** unitKeyOf for a source slug (looks it up); falls back to the slug itself. */
function unitKeyOfSlug(slug: string): string {
  if (slug === UNSOURCED) return UNSOURCED;
  const s = allSources.find((x) => x.source === slug);
  return s ? unitKeyOf(s) : slug;
}

/** All live sources belonging to a unit, freshest first. */
function sourcesInUnit(unitKey: string): LiveSource[] {
  return allSources
    .filter((s) => unitKeyOf(s) === unitKey)
    .sort((a, b) => sourceUpdatedMs(b) - sourceUpdatedMs(a));
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
 * The UNIT an artifact belongs to. Unlike sourceForArtifact (which can't pick
 * between two same-repo instances and so returns UNSOURCED), a unit CAN claim an
 * ambiguous artifact: for a repo the unit key IS the project slug, so two agents
 * in one repo share one unit and the artifact lands there. Falls back to the
 * unique non-repo instance's unit, else UNSOURCED. This is what makes the
 * "≥2 live in one repo → all artifacts dumped in Unsourced" bug go away.
 */
function unitForArtifact(a: ArtifactEntry): string {
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

/** A display name for a unit — the project name of its freshest source. */
function unitName(unitKey: string, sources: LiveSource[]): string {
  if (unitKey === UNSOURCED) return "Unsourced";
  const fresh = sources[0];
  return fresh ? (parseState(fresh.json).project || unitKey) : unitKey;
}

// ---- L1 Sessions picker (units) ---------------------------------------------

/** Render the roster: one card per unit with live activity; stale units behind a
 *  reversible "Archived" toggle. No iframes. */
function renderUnits(): void {
  const grid = document.getElementById("board-sessions-grid");
  const sub = document.getElementById("sessions-sub");
  if (!grid) return;
  const now = Date.now();
  const byUnit = groupSourcesByUnit();
  const artsByUnit = groupArtifactsByUnit();

  const liveUnits: string[] = [];
  const staleUnits: string[] = [];
  for (const [unit, sources] of byUnit) {
    (sources.some((s) => isLiveSource(s, now)) ? liveUnits : staleUnits).push(unit);
  }

  const cards: HTMLElement[] = [];
  let liveCount = 0;
  for (const unit of liveUnits) {
    const sources = byUnit.get(unit) ?? [];
    liveCount += sources.filter((s) => isLiveSource(s, now)).length;
    cards.push(buildUnitCard(unit, sources, artsByUnit.get(unit)?.length ?? 0, now));
  }

  // Artifacts with no live source form their own "Unsourced" unit card.
  const unsourced = artsByUnit.get(UNSOURCED)?.length ?? 0;
  if (unsourced) cards.push(buildUnitCard(UNSOURCED, [], unsourced, now));

  if (staleUnits.length) {
    cards.push(buildArchivedToggle(staleUnits.length));
    if (showArchived) {
      for (const unit of staleUnits) {
        const card = buildUnitCard(unit, byUnit.get(unit) ?? [], artsByUnit.get(unit)?.length ?? 0, now);
        card.classList.add("archived");
        cards.push(card);
      }
    }
  }

  if (sub) {
    const u = liveUnits.length;
    sub.textContent = `${u} live unit${u === 1 ? "" : "s"} · ${liveCount} agent${liveCount === 1 ? "" : "s"} · ${allArtifacts.length} artifact${allArtifacts.length === 1 ? "" : "s"}`;
  }
  grid.replaceChildren(...cards);
}

/** The "Archived (N)" pill that reveals/hides stale units on the roster. */
function buildArchivedToggle(n: number): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "session-archived-toggle";
  btn.textContent = showArchived ? `Hide archived (${n})` : `Archived (${n})`;
  btn.addEventListener("click", () => {
    showArchived = !showArchived;
    renderUnits();
  });
  return btn;
}

/** One unit card — header from the freshest source, a "N live" chip when more
 *  than one agent runs in the unit, unread summed across its sources. */
function buildUnitCard(unitKey: string, sources: LiveSource[], artCount: number, now: number): HTMLElement {
  const liveN = sources.filter((s) => isLiveSource(s, now)).length;
  const head = sources[0] ? makeHead(sources[0]) : unsourcedHead(artCount);

  const card = document.createElement("button");
  card.className = "session-card";
  card.dataset.unit = unitKey;

  const unread = unreadCount(unitKey);
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
  mark.className = "agent-mark" + (head.isCloud ? " cloud" : "");
  mark.textContent = head.mark;
  const who = document.createElement("div");
  who.className = "who";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = unitName(unitKey, sources);
  const prov = document.createElement("div");
  prov.className = "prov";
  prov.textContent = head.prov;
  who.append(name, prov);
  idRow.append(mark, who);

  // "N live" chip replaces the per-instance #shortid chip — a unit can hold
  // several agents, and the count is the fact that matters at the roster.
  if (liveN > 1) {
    const chip = document.createElement("span");
    chip.className = "session-live-chip";
    chip.textContent = `${liveN} live`;
    chip.title = `${liveN} agents active in this unit`;
    idRow.append(chip);
  }
  card.append(idRow);

  if (unitKey !== UNSOURCED) {
    const statusRow = document.createElement("div");
    statusRow.className = "pane-status";
    const dot = document.createElement("span");
    dot.className = "status-dot " + head.level;
    const stext = document.createElement("span");
    stext.className = "status-text";
    stext.innerHTML = head.statusHtml;
    statusRow.append(dot, stext);
    card.append(statusRow);
  }

  const foot = document.createElement("div");
  foot.className = "session-foot";
  foot.textContent = `${artCount} artifact${artCount === 1 ? "" : "s"}`;
  card.append(foot);
  card.addEventListener("click", () => goUnit(unitKey));
  return card;
}

// ---- L2 unit home (digest + lanes + history) --------------------------------

/** Enter L2: clear the unit's unread, resolve its digest, render lanes + history. */
function enterUnit(unitKey: string): void {
  clearUnread(unitKey);
  pendingIngest.delete(unitKey);
  updateGlobalUnread();
  focusPath = null;
  void renderDigest(unitKey);
  renderLanes(unitKey);
  renderHistory(unitKey);
}

/** Tear down L2 state when leaving a unit. Clears any L2 digest bar theming so a
 *  themed unit can't leak its bar onto the native L1/L0 chrome (renderDigest /
 *  renderHub re-apply when they're entered). */
function leaveUnit(): void {
  closeFocus();
  lanesEl?.replaceChildren();
  historyEl?.replaceChildren();
  digestEl?.setAttribute("hidden", "");
  applyBar(null);
  focusPath = null;
}

/**
 * The unit's DIGEST — a durable, agent-authored `home.<unit_key>.html`. Loaded
 * full-WIDTH at the top of the unit home (NOT full-viewport; lanes + history sit
 * below it). Absent ⇒ the iframe is hidden and lanes + history carry the unit
 * entirely. Progressive enhancement, exactly like the L0 Hub.
 */
async function renderDigest(unitKey: string): Promise<void> {
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
    applyBar(await barSpecFor(home));
    await loadArtifactInto(home, digestEl).catch((e) => console.error("digest load failed", e));
  } else {
    digestEl.setAttribute("hidden", "");
    applyBar(null);
  }
}

/** Render the live LANES — one per source in the unit, freshest first. */
function renderLanes(unitKey: string): void {
  const sources = sourcesInUnit(unitKey);
  lanesEl.replaceChildren(...sources.map(buildLane));
  lanesEl.toggleAttribute("hidden", sources.length === 0);
}

/** Replace a single lane in place (a source's live state changed). */
function rebuildLane(source: string): void {
  const s = allSources.find((x) => x.source === source);
  if (!s) return;
  const old = lanesEl.querySelector(`.lane[data-source="${cssEsc(source)}"]`);
  if (old) old.replaceWith(buildLane(s));
}

/** One lane: header + live working/where/next (✓/✎/✗) + the source's in-flight
 *  (fresh) artifacts as clickable rows + a submit footer when decisions exist. */
function buildLane(s: LiveSource): HTMLElement {
  const head = makeHead(s);
  const state = parseState(s.json);

  const lane = document.createElement("div");
  lane.className = "lane";
  lane.dataset.source = s.source;
  lane.dataset.working = state.working || "Live";

  // Header (reuses the L1/pane header model: mark + name/prov + status dot/line).
  const idRow = document.createElement("div");
  idRow.className = "pane-id";
  const mark = document.createElement("span");
  mark.className = "agent-mark" + (head.isCloud ? " cloud" : "");
  mark.textContent = head.mark;
  const who = document.createElement("div");
  who.className = "who";
  const name = document.createElement("div");
  name.className = "name";
  name.textContent = head.name;
  const prov = document.createElement("div");
  prov.className = "prov";
  prov.textContent = head.prov;
  who.append(name, prov);
  idRow.append(mark, who);

  const statusRow = document.createElement("div");
  statusRow.className = "pane-status";
  const dot = document.createElement("span");
  dot.className = "status-dot " + head.level;
  const stext = document.createElement("span");
  stext.className = "status-text";
  stext.innerHTML = head.statusHtml;
  statusRow.append(dot, stext);

  const headEl = document.createElement("div");
  headEl.className = "lane-head";
  headEl.append(idRow, statusRow);

  const rule = document.createElement("div");
  rule.className = "lane-rule";

  const body = document.createElement("div");
  body.className = "lane-body";
  body.appendChild(renderLiveState(state as LiveStateBody));

  lane.append(headEl, rule, body);

  // In-flight artifacts (fresh, authored by this source) as quiet rows.
  const now = Date.now();
  const inflight = allArtifacts
    .filter((a) => sourceForArtifact(a) === s.source && now - a.modified_ms < FRESH_WINDOW_MS)
    .sort((a, b) => b.modified_ms - a.modified_ms);
  if (inflight.length) {
    const arts = document.createElement("div");
    arts.className = "lane-arts";
    for (const a of inflight) arts.appendChild(buildArtRow(a, true));
    lane.append(arts);
  }

  // Submit footer only when there are decisions to make.
  if ((state.next?.length ?? 0) > 0) {
    const foot = document.createElement("div");
    foot.className = "lane-foot";
    const count = document.createElement("span");
    count.className = "lane-count";
    count.textContent = "nothing marked";
    const doall = document.createElement("button");
    doall.className = "lane-doall";
    doall.textContent = "Do all";
    const submit = document.createElement("button");
    submit.className = "lane-submit";
    submit.textContent = "Submit → ⌘V";
    foot.append(count, doall, submit);
    lane.append(foot);
  }
  return lane;
}

/** A clickable artifact row (lane in-flight rows + history rows share this). */
function buildArtRow(a: ArtifactEntry, inflight: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = inflight ? "art-row inflight" : "art-row";
  row.dataset.artPath = a.path;

  if (!inflight && Date.now() - a.modified_ms < FRESH_WINDOW_MS) {
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
    for (const a of arts) frag.append(buildArtRow(a, false));
  }
  historyEl.replaceChildren(frag);
}

// ---- lane decisions (scoped to a single lane) -------------------------------

/** One delegated listener for all lanes (lanes are rebuilt; this survives). */
function wireLaneActions(): void {
  lanesEl.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const lane = t.closest(".lane") as HTMLElement | null;
    if (!lane) return;

    const artRow = t.closest("[data-art-path]") as HTMLElement | null;
    if (artRow?.dataset.artPath) {
      void openReader(artRow.dataset.artPath);
      return;
    }
    const actBtn = t.closest("[data-action]") as HTMLElement | null;
    if (actBtn) {
      const card = actBtn.closest(".live-item") as HTMLElement | null;
      if (card) toggleLaneItem(card, actBtn.dataset.action as string, lane);
      return;
    }
    if (t.closest(".lane-doall")) {
      lane.querySelectorAll<HTMLElement>(".live-item").forEach((card) => {
        card.dataset.state = "approve";
        const ta = card.querySelector(".live-comment") as HTMLElement | null;
        if (ta) ta.hidden = true;
      });
      refreshLane(lane);
      return;
    }
    if (t.closest(".lane-submit")) void laneSubmit(lane);
  });
}

/** Toggle a lane item's ✓/✎/✗ state (mirrors live.ts; scoped to its lane). */
function toggleLaneItem(card: HTMLElement, action: string, lane: HTMLElement): void {
  const ta = card.querySelector(".live-comment") as HTMLTextAreaElement | null;
  if (card.dataset.state === action) {
    delete card.dataset.state;
    if (ta) ta.hidden = true;
  } else {
    card.dataset.state = action;
    if (ta) {
      ta.hidden = action !== "comment";
      if (action === "comment") setTimeout(() => ta.focus(), 0);
    }
  }
  refreshLane(lane);
}

/** Update a lane's marked-count label + submit-ready state. */
function refreshLane(lane: HTMLElement): void {
  const n = lane.querySelectorAll(".live-item[data-state]").length;
  const count = lane.querySelector(".lane-count");
  if (count) count.textContent = n ? `${n} decision${n === 1 ? "" : "s"}` : "nothing marked";
  lane.querySelector(".lane-submit")?.classList.toggle("ready", n > 0);
}

/** Compile a lane's marked decisions to clipboard prose (live.ts's format). */
async function laneSubmit(lane: HTMLElement): Promise<void> {
  const items = Array.from(lane.querySelectorAll<HTMLElement>(".live-item[data-state]"));
  if (!items.length) return;
  const verb: Record<string, string> = { approve: "✓ Do it:", reject: "✗ Skip:", comment: "✎ Note:" };
  const lines = ["[Companion live]", `Re: ${lane.dataset.working || "Live"}`, "", "— Decisions —", ""];
  for (const card of items) {
    const state = card.dataset.state as string;
    lines.push(`${verb[state]} ${card.dataset.label || "(unlabeled)"}`);
    if (state === "comment") {
      const ta = card.querySelector(".live-comment") as HTMLTextAreaElement | null;
      if (ta && ta.value.trim()) ta.value.trim().split("\n").forEach((l) => lines.push(`    ${l}`));
    }
  }
  await handleSubmit(lines.join("\n"));
}

// ---- history clicks ---------------------------------------------------------

function wireHistoryClicks(): void {
  historyEl.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest("[data-art-path]") as HTMLElement | null;
    if (row?.dataset.artPath) void openReader(row.dataset.artPath);
  });
}

// ---- data → header ----------------------------------------------------------

/** The source an artifact belongs to (its live instance, else UNSOURCED). The
 *  single routing authority. An artifact carries only a `project`, so it routes
 *  to the UNIQUE live instance of that project; if two instances of one repo are
 *  live, that's ambiguous → UNSOURCED. (Unit-level history reunites them.) */
function sourceForArtifact(a: ArtifactEntry): string {
  const key = projectSlug(a.project);
  if (!key) return UNSOURCED;
  const matches = allSources.filter((s) => sourceProjectKey(s) === key);
  return matches.length === 1 ? matches[0].source : UNSOURCED;
}

/** Total fresh (in-flight) artifacts across all sources — for the L0 greeting. */
function freshCount(): number {
  const now = Date.now();
  return allArtifacts.filter((a) => now - a.modified_ms < FRESH_WINDOW_MS).length;
}

/** Header fields for an UNSOURCED unit (no live state). */
function unsourcedHead(count: number): PaneHead {
  return {
    source: UNSOURCED,
    name: "Unsourced",
    prov: "ARTIFACTS · NO LIVE SOURCE",
    mark: "·",
    isCloud: false,
    level: "idle",
    statusHtml: `${count} artifact${count === 1 ? "" : "s"} with no live agent`,
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

/** A source is LIVE if its file was touched within LIVENESS_MS; else stale. */
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

// ---- greeting + clock -------------------------------------------------------

function renderGreeting(fresh: number, agents: number): void {
  const hello = document.getElementById("board-hello");
  const sub = document.getElementById("board-sub");
  if (hello) hello.innerHTML = `${timeGreeting()}, <em>there.</em>`;
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
 * `focusPath`. Open-by-path, so lanes, history, and navigate links all reuse it.
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
  inner.append(focusFrame);

  const close = document.createElement("button");
  close.className = "reader-close";
  close.title = "Close (esc)";
  close.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
  close.addEventListener("click", closeFocus);

  card.append(inner, close);
  boardEl.append(card);
  scrimEl.classList.add("on");
  requestAnimationFrame(() => card.classList.add("shown"));

  await loadArtifactInto(path, focusFrame).catch((e) => console.error("reader load failed", path, e));
}

/** Close the reader; flush any unit history rebuild deferred while it was open. */
function closeFocus(): void {
  const card = boardEl.querySelector("[data-reader]") as HTMLElement | null;
  scrimEl.classList.remove("on");
  card?.remove();
  focusFrame = null;
  focusPath = null;
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
  const view = currentView();
  const changed: string[] = [];
  for (const s of sources) {
    if (lastJsonBySource.get(s.source) === s.json) continue;
    lastJsonBySource.set(s.source, s.json);
    changed.push(s.source);
  }
  if (changed.length) {
    if (view.level === "sessions") renderUnits();
    else if (view.level === "unit") {
      for (const src of changed) {
        if (unitKeyOfSlug(src) === view.unitKey) rebuildLane(src);
      }
    }
    // L0 Hub: no live-refresh (re-resolves on entry only).
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

  const view = currentView();
  const viewingUnit = view.level === "unit" ? view.unitKey : null;
  for (const a of newOnes) {
    const unit = unitForArtifact(a);
    if (unit !== viewingUnit) addUnread(unit, a.path);
  }

  if (view.level === "sessions") renderUnits();
  else if (view.level === "unit") ingestIntoUnit(view.unitKey);
  updateGlobalUnread();
}

/** Refresh the on-screen unit's HISTORY when its artifact set changed. Lanes'
 *  in-flight rows refresh on the next live-state tick (rebuildLane), so a rebuild
 *  here would needlessly drop any in-progress lane marks — history-only. Deferred
 *  while the reader overlay is open. */
function ingestIntoUnit(unitKey: string): void {
  if (focusPath !== null) {
    pendingIngest.add(unitKey);
    return;
  }
  const keep = unitEl.scrollTop;
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

// ---- pill (collapsed state) -------------------------------------------------

function showPill(): void {
  const pill = document.getElementById("board-pill");
  if (!pill) return;
  closeFocus();
  boardEl.setAttribute("hidden", "");
  pill.removeAttribute("hidden");

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

function sourceSummary(s: LiveSource): { name: string; level: StatusLevel } {
  const state = parseState(s.json);
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

// ---- controls + keyboard ----------------------------------------------------

function wireControls(): void {
  document.getElementById("board-close")?.addEventListener("click", () => {
    win.hide().catch((e) => console.error("board hide failed", e));
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

function toggleFullscreen(): void {
  invoke<boolean>("set_board_fullscreen", { on: !isFullscreen })
    .then((on) => {
      isFullscreen = on;
      stageEl.classList.toggle("fullscreen", on);
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
    if (e.key === "Escape") {
      e.preventDefault();
      goBack();
      return;
    }
    if ((e.key === "f" || e.key === "F") && currentView().level !== "hub") {
      toggleFullscreen();
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
  sessionsEl.addEventListener("scroll", onScroll, { passive: true });
}

// ---- small utils ------------------------------------------------------------

function setStatus(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.removeAttribute("hidden");
}

/** Escape a path for use inside a CSS attribute selector. */
function cssEsc(s: string): string {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}
