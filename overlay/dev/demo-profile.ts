/* =============================================================================
   DEMO PROFILE — the fixture set behind the public demo build (`demo.html`).

   Distinct from the verification fixtures in tauri-mock.ts: those deliberately
   exercise FAILURE states (the orphan artifact alarms the rail's warning row).
   A demo must never show a red warning, so this profile carries only the happy
   path, three authored artifacts, and canned terminal transcripts that type
   themselves out so the split view reads as a live session rather than a dead
   black box.

   EVERYTHING HERE IS INVENTED. This build is published publicly, so no real
   person, project, path, dataset or session id may appear — not in the fixtures,
   and not in the artifacts they load. See demo/artifacts/demo-*.html.

   Three units, hero first:
     1. tidepool       — a metric that measures nothing, proven by differential
     2. harbor         — a p99 regression bisected to one migration
     3. northwind-sync — the auth fork that gates every line of code
   ============================================================================= */

import tidepoolHtml from "../../demo/artifacts/demo-tidepool-velocity.html?raw";
import tidepoolShippedHtml from "../../demo/artifacts/demo-tidepool-shipped.html?raw";
import harborHtml from "../../demo/artifacts/demo-harbor-regression.html?raw";
import northwindHtml from "../../demo/artifacts/demo-northwind-auth.html?raw";
import type { MockArtifact } from "./tauri-mock";

const now = Date.now();
const MIN = 60_000;

/* --- artifacts ------------------------------------------------------------ */

const TIDEPOOL: MockArtifact = {
  path: "/demo/artifacts/tidepool-velocity.html",
  title: "The velocity metric is measuring nothing",
  subject: "tidepool — sales velocity is a constant",
  summary:
    "Differential over 5 hours: followerCount moved for 4,620 of 8,281 sellers, unitsSold for zero. Every ranking built on velocity is noise.",
  modified_ms: now - 3 * MIN,
  size_bytes: 61_400,
  project: "~/tidepool",
  unit_key: "tidepool",
  source: "tidepool--a4f1c920",
};

/** The pay-off page: the artifact that lands AFTER the visitor answers tidepool.
 *
 *  Not in DEMO_ARTIFACTS — the mock pushes it only once a decision has actually
 *  been submitted, which is what closes the loop the demo exists to teach. Its
 *  `{{DECISION}}` placeholder is filled at read time with the visitor's own
 *  compiled answer, so the agent replies to what THEY said, not to a canned pick.
 *  Same unit + source as TIDEPOOL, so the Board routes it into that session and
 *  auto-advance carries the reader to it instead of stranding them on the splash. */
export const DEMO_FOLLOWUP: MockArtifact = {
  path: "/demo/artifacts/tidepool-shipped.html",
  title: "Your call is in — the ranking is off unitsSold",
  subject: "tidepool — your call is in",
  summary:
    "Pulled unitsSold out of the ranking path, killed the nightly velocity backfill, and recorded your decision as the plan of record.",
  modified_ms: now, // overwritten at push time — it must read as the newest artifact
  size_bytes: 14_800,
  project: "~/tidepool",
  unit_key: "tidepool",
  source: "tidepool--a4f1c920",
};

const HARBOR: MockArtifact = {
  path: "/demo/artifacts/harbor-regression.html",
  title: "claim_job p99: 12ms → 840ms, bisected to one migration",
  subject: "harbor — the index stopped being used",
  summary:
    "Migration 0042 rebuilt the composite index as (tenant_id, status); every hot query filters (status, run_after). Postgres fell back to a seq scan over 4.2M rows.",
  modified_ms: now - 26 * MIN,
  size_bytes: 63_200,
  project: "~/harbor",
  unit_key: "harbor",
  source: "harbor--7c2be431",
};

const NORTHWIND: MockArtifact = {
  path: "/demo/artifacts/northwind-auth.html",
  title: "One decision gates every line of code",
  subject: "northwind-sync — the multi-tenant auth fork",
  summary:
    "No code yet, only a handoff. Delegated org-wide consent vs per-tenant app registration with certificate credentials — the credential shape leaks into every module.",
  modified_ms: now - 71 * MIN,
  size_bytes: 58_900,
  project: "~/northwind-sync",
  unit_key: "northwind-sync",
  source: "northwind-sync--0b93de57",
};

export const DEMO_ARTIFACTS: MockArtifact[] = [TIDEPOOL, HARBOR, NORTHWIND];

/** Raw HTML for the demo artifacts, inlined at build time (`?raw`). */
export function demoArtifactHtml(path: string): string | null {
  if (path.includes("tidepool-shipped")) return tidepoolShippedHtml;
  if (path.includes("tidepool-velocity")) return tidepoolHtml;
  if (path.includes("harbor-regression")) return harborHtml;
  if (path.includes("northwind-auth")) return northwindHtml;
  return null;
}

/* --- live sessions (which units exist, and their order) -------------------- */
// The rail orders units by their freshest source, so tidepool's updated_ms keeps
// the hero artifact under the visitor's cursor the moment they open Sessions.

export const DEMO_LIVE_SOURCES = [
  {
    source: "tidepool--a4f1c920",
    json: JSON.stringify({
      working: "Proving whether sales velocity moves at all",
      where: [
        "Snapshotted the same 8,281 sellers five hours apart",
        "followerCount moved for 4,620 of them; unitsSold for none",
        "The accumulator is healthy — 12,397 sellers indexed",
      ],
      next: [
        { title: "Pick the replacement signal", sub: "follower delta, listing delta, or the paid tier", kind: "decision" },
        { title: "Pull velocity out of the ranking", sub: "it has been a constant the whole time", kind: "todo" },
      ],
      project: "tidepool",
      is_repo: true,
      unit_key: "tidepool",
      shelly_session: "demo-tidepool",
      session_id: "a4f1c920-1d3e-4a77-9c02-6b1f4e8d5a31",
      unit_dir: "/Users/dev/tidepool",
      updated_ms: now - 3 * MIN,
    }),
  },
  {
    source: "harbor--7c2be431",
    json: JSON.stringify({
      working: "Landing the partial index on claim_job",
      where: [
        "p99 went 12ms → 840ms overnight with flat throughput",
        "Bisected to migration 0042 — the composite index was rebuilt",
        "EXPLAIN confirms a sequential scan over 4.2M rows",
      ],
      next: [
        { title: "Ship the partial index CONCURRENTLY", sub: "~40x smaller; pending is under 1% of rows", kind: "decision" },
        { title: "Assert the query plan in a test", sub: "so a migration can't silently drop it again", kind: "todo" },
      ],
      project: "harbor",
      is_repo: true,
      unit_key: "harbor",
      shelly_session: "demo-harbor",
      session_id: "7c2be431-88a5-4f10-b6d9-2e07c5a91b64",
      unit_dir: "/Users/dev/harbor",
      updated_ms: now - 26 * MIN,
    }),
  },
  {
    source: "northwind-sync--0b93de57",
    json: JSON.stringify({
      working: "Reading the handoff before writing any code",
      where: [
        "375-line handoff, no code committed yet",
        "Nothing in the repo decides the multi-tenant auth model",
        "Credential shape reaches the tenant store, the worker, every module",
      ],
      next: [
        { title: "Choose the auth model", sub: "delegated consent vs per-tenant app registration", kind: "decision" },
        { title: "Scaffold the provisioning flow", sub: "blocked until the fork is settled", kind: "blocked" },
      ],
      project: "northwind-sync",
      is_repo: true,
      unit_key: "northwind-sync",
      shelly_session: "demo-northwind",
      session_id: "0b93de57-6c41-4e29-8a15-93f2d0c7e4b8",
      unit_dir: "/Users/dev/northwind-sync",
      updated_ms: now - 71 * MIN,
    }),
  },
];

/* --- canned terminal transcripts ------------------------------------------ */

/** One printed chunk and the pause before the next. Keyed by the cwd basename
 *  that `spawn_pty` receives, so each unit's terminal replays its own session. */
export interface TranscriptChunk {
  text: string;
  /** Pause in ms BEFORE printing this chunk. */
  delay: number;
}

const DIM = "\x1b[2m";
const OFF = "\x1b[0m";
const CLAY = "\x1b[38;5;173m"; // the Shelly's terracotta
const GREEN = "\x1b[38;5;71m";
const RED = "\x1b[38;5;167m";
const BOLD = "\x1b[1m";

/** A Claude Code turn: the `●` action bullets and `⎿` result gutters. */
const bullet = (s: string) => `\r\n${CLAY}●${OFF} ${s}\r\n`;
const result = (s: string) => `  ${DIM}⎿  ${s}${OFF}\r\n`;
const prompt = (s: string) => `${BOLD}>${OFF} ${s}\r\n`;

const TIDEPOOL_TTY: TranscriptChunk[] = [
  { text: `${DIM}claude-code v2.1.4 · ~/tidepool${OFF}\r\n\r\n`, delay: 400 },
  { text: prompt("The sales-velocity ranking looks wrong — sellers with obviously"), delay: 700 },
  { text: `  dead stores are ranking above active ones. Can you check?\r\n`, delay: 300 },
  { text: bullet("Velocity is derived from unitsSold. Let me diff two snapshots of\r\n  the same seller set rather than trust one reading."), delay: 1200 },
  { text: bullet("Read(tidepool/store.py)"), delay: 800 },
  { text: result("214 lines"), delay: 500 },
  { text: bullet("Bash(python -m tidepool.snapshot --since 5h)"), delay: 800 },
  { text: result("8,281 sellers present in both snapshots"), delay: 700 },
  { text: bullet("Bash(python -m tidepool.diff --field followerCount)"), delay: 800 },
  { text: result(`4,620 sellers changed`), delay: 700 },
  { text: bullet("Bash(python -m tidepool.diff --field unitsSold)"), delay: 800 },
  { text: `  ${DIM}⎿  ${OFF}${RED}0 sellers changed${OFF}\r\n`, delay: 900 },
  {
    text: `\r\n${CLAY}●${OFF} There it is. followerCount moves, unitsSold never does — upstream\r\n  returns it frozen. Velocity has been a constant the whole time.\r\n`,
    delay: 1300,
  },
  { text: bullet("Write(~/.shelly/artifacts/tidepool-velocity.html)"), delay: 1000 },
  { text: result("Wrote 61.4 KB"), delay: 600 },
  {
    text: `\r\n  Every ranking built on velocity is noise. Three ways out are on the\r\n  board — ${GREEN}pick one and I'll wire it${OFF}.\r\n\r\n`,
    delay: 900,
  },
  { text: `${DIM}> ${OFF}`, delay: 400 },
];

const HARBOR_TTY: TranscriptChunk[] = [
  { text: `${DIM}claude-code v2.1.4 · ~/harbor${OFF}\r\n\r\n`, delay: 400 },
  { text: prompt("claim_job got slow overnight — p99 is around 800ms now."), delay: 700 },
  { text: `  Traffic looks flat. What happened?\r\n`, delay: 300 },
  { text: bullet("Flat traffic with a 70× latency jump is a plan change, not load.\r\n  Let me look at what the planner is actually doing."), delay: 1200 },
  { text: bullet(`Bash(psql -c "EXPLAIN ANALYZE SELECT … WHERE status='pending'")`), delay: 1000 },
  { text: `  ${DIM}⎿  ${OFF}${RED}Seq Scan on jobs${OFF}${DIM}  (cost=0.00..91442.00 rows=1 width=284)${OFF}\r\n`, delay: 900 },
  { text: bullet("Bash(git log --oneline -- migrations/ | head -3)"), delay: 800 },
  { text: result("0042_add_tenant_id.sql   (last night, 23:14)"), delay: 600 },
  { text: bullet("Read(migrations/0042_add_tenant_id.sql)"), delay: 800 },
  { text: result("18 lines"), delay: 500 },
  {
    text: `\r\n${CLAY}●${OFF} Found it. 0042 rebuilt the index as (tenant_id, status), but every hot\r\n  query filters (status, run_after) and never touches tenant_id. Postgres\r\n  dropped the index and went sequential over 4.2M rows.\r\n`,
    delay: 1400,
  },
  { text: bullet("Write(~/.shelly/artifacts/harbor-regression.html)"), delay: 1000 },
  { text: result("Wrote 63.2 KB"), delay: 600 },
  {
    text: `\r\n  Fix is a partial index on (status, run_after) WHERE status='pending' —\r\n  about ${GREEN}40× smaller${OFF} and safe to build CONCURRENTLY. It's on the board.\r\n\r\n`,
    delay: 900,
  },
  { text: `${DIM}> ${OFF}`, delay: 400 },
];

const NORTHWIND_TTY: TranscriptChunk[] = [
  { text: `${DIM}claude-code v2.1.4 · ~/northwind-sync${OFF}\r\n\r\n`, delay: 400 },
  { text: prompt("I wrote up the handoff but haven't written any code yet."), delay: 700 },
  { text: `  Where should I start?\r\n`, delay: 300 },
  { text: bullet("Let me read the handoff before suggesting a first file."), delay: 1000 },
  { text: bullet("Read(HANDOFF.md)"), delay: 800 },
  { text: result("375 lines · no code committed"), delay: 600 },
  { text: bullet('Grep("app registration|consent|certificate", .)'), delay: 800 },
  { text: result("0 matches — the auth model was never decided"), delay: 800 },
  {
    text: `\r\n${CLAY}●${OFF} Start nowhere until this is settled. The credential shape isn't a\r\n  detail you can defer — it reaches the tenant store, the sync worker,\r\n  and every integration module you're about to write.\r\n`,
    delay: 1400,
  },
  { text: bullet("Write(~/.shelly/artifacts/northwind-auth.html)"), delay: 1000 },
  { text: result("Wrote 58.9 KB"), delay: 600 },
  {
    text: `\r\n  Delegated consent vs per-tenant app registration, with the blast radius\r\n  of each. I'd take per-tenant — ${GREEN}decide on the board and I'll scaffold it${OFF}.\r\n\r\n`,
    delay: 900,
  },
  { text: `${DIM}> ${OFF}`, delay: 400 },
];

/** Keyed by cwd basename (`spawn_pty` passes the unit dir). */
export const DEMO_TRANSCRIPTS: Record<string, TranscriptChunk[]> = {
  tidepool: TIDEPOOL_TTY,
  harbor: HARBOR_TTY,
  "northwind-sync": NORTHWIND_TTY,
};

/** What tidepool's session does once the visitor ANSWERS its artifact.
 *
 *  The demo's whole argument is the round trip, and it was previously cut one
 *  step short: the answer reached the terminal and the session said "not wired to
 *  a model". Now the paste lands, the agent picks it up, does the work, and writes
 *  the follow-up artifact — which the mock then serves. The terminal is the SEAM,
 *  not the payoff; the payoff is the page that lands on the Board.
 *
 *  `decision` is the visitor's own compiled answer, echoed so the paste reads as
 *  theirs. Only its first line is shown — the full text is quoted in the artifact. */
export function tidepoolFollowUpTty(decision: string): TranscriptChunk[] {
  const headline = (decision.split("\n").find((l) => /^[✓✗✎]/.test(l.trim())) ?? "your decision").trim();
  return [
    { text: `${DIM}[pasted ${decision.split("\n").length} lines from Shelly]${OFF}\r\n`, delay: 260 },
    { text: `${BOLD}>${OFF} ${DIM}${headline}${OFF}\r\n`, delay: 420 },
    { text: bullet("Got it — that settles the signal question. Taking unitsSold out of\r\n  the ranking path now."), delay: 1100 },
    { text: bullet("Edit(tidepool/ranking.py)"), delay: 900 },
    { text: result(`${GREEN}velocity_score no longer feeds rank()${OFF}`), delay: 700 },
    { text: bullet("Edit(tidepool/metrics/velocity.py)"), delay: 850 },
    { text: result(`${GREEN}nightly backfill disabled — 40m/night of compute on a constant${OFF}`), delay: 800 },
    { text: bullet("Write(docs/adr/0007-ranking-signal.md)"), delay: 900 },
    { text: result("recorded your call + the 5h differential"), delay: 650 },
    { text: bullet("Write(~/.shelly/artifacts/tidepool-shipped.html)"), delay: 950 },
    { text: result("Wrote 14.8 KB"), delay: 600 },
    {
      text: `\r\n${DIM}  The follow-up is on the Board — that's the loop closing.${OFF}\r\n\r\n${DIM}> ${OFF}`,
      delay: 900,
    },
  ];
}

/** The units whose terminals the demo spawns as Board-owned at boot. A live file
 *  alone can't make a session Board-owned — that binding is in-memory — so
 *  without this the Board correctly renders "this session lives outside the
 *  Board" and never spawns a PTY to replay into. */
export const DEMO_UNITS: { unitKey: string; cwd: string }[] = [
  { unitKey: "tidepool", cwd: "/Users/dev/tidepool" },
  { unitKey: "harbor", cwd: "/Users/dev/harbor" },
  { unitKey: "northwind-sync", cwd: "/Users/dev/northwind-sync" },
];

/** Point a unit's live source at the terminal the Board just spawned for it.
 *
 *  The hero scopes to the ACTIVE SESSION, not the unit: it finds the live source
 *  whose `shelly_session` equals the shown tabId, and shows a blank "Crab's on
 *  it" splash when there is none. Real sessions get that field stamped by the
 *  SessionStart hook; the demo stamps it here, after the spawn hands back a tabId.
 *  Mutates in place — the mock hands `read_all_live` this same array every poll. */
export function bindDemoSession(unitKey: string, tabId: string): void {
  const src = DEMO_LIVE_SOURCES.find((s) => JSON.parse(s.json).unit_key === unitKey);
  if (!src) return;
  src.json = JSON.stringify({ ...JSON.parse(src.json), shelly_session: tabId });
}
