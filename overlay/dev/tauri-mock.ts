/* =============================================================================
   TAURI IPC MOCK — boots the real Board bundle in a plain browser (no Tauri).

   installTauriMock() defines window.__TAURI_INTERNALS__ with a fixture-backed
   `invoke`, so `/dev/board-harness.html` can render the Board with realistic
   roster/artifact data for design work + screenshot verification. Zero effect
   on the real app: nothing imports this outside dev/.
   ============================================================================= */

export interface MockArtifact {
  path: string;
  title: string;
  subject?: string | null;
  summary?: string | null;
  modified_ms: number;
  size_bytes: number;
  project?: string | null;
  unit_key?: string | null;
  source?: string | null;
}

/** Fixture set for the public demo build (`demo.html`). Passed IN rather than
 *  imported, so the demo's inlined artifact HTML never bloats this harness. */
export interface DemoProfile {
  artifacts: MockArtifact[];
  liveSources: { source: string; json: string }[];
  /** Raw HTML for a demo artifact path, or null to fall through. */
  artifactHtml: (path: string) => string | null;
  /** Canned terminal replays, keyed by the cwd basename `spawn_pty` receives. */
  transcripts: Record<string, { text: string; delay: number }[]>;
  /** The artifact that lands only AFTER the visitor answers — the loop closing.
   *  Its `{{DECISION}}` placeholder is filled with their own compiled answer. */
  followUp: MockArtifact;
  /** The session's continuation once the answer lands, given that answer's text. */
  followUpTty: (decision: string) => { text: string; delay: number }[];
  /** The unit whose artifact carries the answerable ballot (`followUp`'s unit). */
  followUpUnit: string;
}

const now = Date.now();
const MIN = 60_000;

/** A believable observer-rendered artifact page (board-shade bg, status card). */
function artifactHtml(title: string, summary: string, items: [string, string][]): string {
  const rows = items
    .map(
      ([k, v]) => `
      <div style="display:flex;justify-content:space-between;gap:16px;padding:10px 0;
                  border-top:1px solid rgba(40,30,20,.08);font-size:13px;">
        <span style="color:#6b6660;">${k}</span><b style="color:#211d1a;">${v}</b>
      </div>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8">
  <style>html{scrollbar-width:none}html::-webkit-scrollbar{display:none}</style></head>
  <body style="margin:0;background:oklch(0.945 0.014 60);font-family:-apple-system,system-ui,sans-serif;">
    <div style="max-width:660px;margin:0 auto;padding:28px 32px;">
      <div style="font:600 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;
                  text-transform:uppercase;color:#b0552f;margin-bottom:10px;">Status — this turn</div>
      <div style="font-family:Georgia,serif;font-size:26px;letter-spacing:-.01em;color:#211d1a;">${title}</div>
      <p style="font-size:13.5px;line-height:1.55;color:#55504a;margin:10px 0 18px;">${summary}</p>
      <div style="background:oklch(0.988 0.007 60);border:1px solid rgba(40,30,20,.09);
                  border-radius:12px;padding:6px 18px;">${rows}</div>
    </div>
  </body></html>`;
}

const ARTIFACTS: MockArtifact[] = [
  {
    path: "/mock/artifacts/shell-slate.html",
    title: "Curated shell — slate",
    subject: "shell repaint",
    summary: "Declares the slate shell; the Board repaints its whole surface to match on open.",
    modified_ms: now - 1 * MIN,
    size_bytes: 3_200,
    project: "~/shelly",
    unit_key: "shelly",
    source: "shelly--3f8c1d04",
  },
  {
    path: "/mock/artifacts/board-ui-audit.html",
    title: "Board UI audit — gaps vs the desktop bar",
    subject: "UI polish",
    summary: "Hierarchy, chrome density and state gaps named against Claude Desktop / Codex.",
    modified_ms: now - 6 * MIN,
    size_bytes: 14_200,
    project: "~/shelly",
    unit_key: "shelly",
    source: "shelly--3f8c1d04",
  },
  {
    path: "/mock/artifacts/observer-latency.html",
    title: "Observer latency — measured, output-bound",
    subject: "observer",
    summary: "142.5s director call is slow-not-hung; visuals field dominates output tokens.",
    modified_ms: now - 95 * MIN,
    size_bytes: 11_800,
    project: "~/shelly",
    unit_key: "shelly",
    source: "shelly--3f8c1d04",
  },
];

// ---- Rewrite-under-the-reader scenario (the 2026-07-11 silence bug) ----------
// At ~10s the agent RE-AUTHORS an artifact already on screen: same path, newer
// mtime. The Board must OFFER the new content — "↻ Updated · Refresh" in the reader
// nav if it is open there, the advance pill on the hero — and must never reload the
// frame by itself (that would wipe a comment being typed). Open the reader on "Board
// UI audit" within the first 10s to watch the affordance appear.
const REWRITTEN_PATH = "/mock/artifacts/board-ui-audit.html";
const REWRITE_AT_MS = 10_000;

/** One more artifact lands ~6s after boot — exercises the live-ingest path
 *  (unread bell + "New artifact" pill) so those states can be screenshotted.
 *  Routed to unit 1 so lantern stays artifact-less (its blank hero
 *  "Crab's on it" composition needs a unit with no artifacts). */
const LATE_ARTIFACT: MockArtifact = {
  path: "/mock/artifacts/harness-live-ingest.html",
  title: "Harness — live ingest check",
  subject: "harness",
  summary: "This artifact arrived after boot to light the unread affordances.",
  modified_ms: now + 6_000,
  size_bytes: 9_000,
  project: "~/shelly",
  unit_key: "shelly",
  source: "shelly--3f8c1d04",
};

// ---- Identity-race scenarios (Phase 4 verification) --------------------------
// RACE_RESOLVED replays THE surfacing-lag race deterministically: the artifact
// file appears (watcher wake) ~3s in with NO identity — the hook hasn't stamped
// yet. The Board must HOLD it (never route by its project slug). ~6s in, the
// stamp + artifact.routed event land; the Board must route it to unit 1 exactly
// once. RACE_ORPHAN never gets identity: after the 10s grace it must alarm the
// rail's warning row and land under Unsourced — loudly, not silently.
const RACE_APPEAR_MS = 3_000;
const RACE_STAMP_MS = 6_000;
const ORPHAN_APPEAR_MS = 4_000;
const RACE_SID = "3f8c1d04-7b62-4e51-9a3d-1c5e802b6af7";
const RACE_RESOLVED_BARE: MockArtifact = {
  path: "/mock/artifacts/race-resolved.html",
  title: "Race — identity arrives late",
  subject: "identity",
  summary: "Appeared before its index stamp; must be held, then routed once.",
  modified_ms: now + RACE_APPEAR_MS,
  size_bytes: 7_000,
  // project deliberately set: the OLD slug-fallback would have routed this
  // immediately (and the race made that a coin flip). Strict routing must ignore it.
  project: "~/shelly",
  unit_key: null,
  source: null,
};
const RACE_RESOLVED_STAMPED: MockArtifact = {
  ...RACE_RESOLVED_BARE,
  unit_key: "shelly",
  source: "shelly--3f8c1d04",
  ...({ session_id: RACE_SID } as object),
};
const RACE_ORPHAN: MockArtifact = {
  path: "/mock/artifacts/race-orphan.html",
  title: "Race — identity never arrives",
  subject: "identity",
  summary: "No stamp ever lands; must alarm the warning row, never route silently.",
  modified_ms: now + ORPHAN_APPEAR_MS,
  size_bytes: 7_000,
  project: "~/lantern",
  unit_key: null,
  source: null,
};

// ---- Agent-hub scenario (connected agents + remote artifacts) ----------------
// HERMES is a fully-connected agent: registered on the hub, fresh heartbeat, one
// pulled artifact (a morning brief with review controls whose Submit must round-
// trip to hub_post_inbox — recorded on window.__inboxPosts, never a local PTY).
// SCOUT is registered but has produced nothing yet — it must still appear in the
// Agent Hub room (connecting is enough to exist).
const HUB_AGENTS = [
  {
    id: "hermes",
    name: "Hermes",
    emoji: "🪽",
    tagline: "Morning briefs, task triage, EOD filing",
    capabilities: ["morning-brief", "tasks", "calendar"],
    wake: null,
    registered_ms: now - 14 * 24 * 60 * MIN,
    updated_ms: now - 3 * MIN,
    last_seen_ms: now - 3 * MIN,
    working: "Compiling your morning brief",
    artifact_count: 1,
  },
  {
    id: "scout",
    name: "Scout",
    emoji: "🔭",
    tagline: "PR triage on new pull requests",
    capabilities: ["pr-triage"],
    wake: null,
    registered_ms: now - 2 * 24 * 60 * MIN,
    updated_ms: now - 5 * 60 * MIN,
    last_seen_ms: now - 5 * 60 * MIN,
    working: null,
    artifact_count: 0,
  },
];

const REMOTE_ARTIFACT: MockArtifact = {
  path: "/mock/remote/hermes-morning-brief.html",
  title: "Morning brief — Mon Jul 6",
  subject: "Morning briefing",
  summary: "Today's plan: one build move first, two fixed commitments, three must-dos.",
  modified_ms: now - 12 * MIN,
  size_bytes: 18_400,
  project: "hermes",
  unit_key: "__cloud__:hermes",
  source: null,
};

/** The remote morning brief: review controls whose Submit fires the standard
 *  shelly-artifact postMessage — the Board must route it to hub_post_inbox. */
function morningBriefHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
  <style>html{scrollbar-width:none}html::-webkit-scrollbar{display:none}</style></head>
  <body style="margin:0;background:oklch(0.945 0.014 60);font-family:-apple-system,system-ui,sans-serif;">
    <div style="max-width:680px;margin:0 auto;padding:30px 34px;">
      <div style="font:600 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;
                  text-transform:uppercase;color:#b0552f;">🪽 Hermes — morning brief</div>
      <div style="font-family:Georgia,serif;font-size:27px;color:#211d1a;margin-top:8px;">
        One build move first, then the calls.</div>
      <p style="font-size:13.5px;line-height:1.6;color:#55504a;margin:12px 0 20px;">
        No calendar commitments before 1pm. The top task on the board is a meta-smell; the most
        believable first move is landing the partial index on <code>harbor</code>.</p>
      <div style="background:oklch(0.988 0.007 60);border:1px solid rgba(40,30,20,.09);
                  border-radius:12px;padding:14px 18px;font-size:13px;color:#3a352f;">
        <label style="display:block;padding:6px 0;"><input type="checkbox" checked> Ship the harbor partial index</label>
        <label style="display:block;padding:6px 0;"><input type="checkbox"> Re-run the tidepool differential</label>
        <label style="display:block;padding:6px 0;"><input type="checkbox"> 4pm — northwind design review</label>
      </div>
      <button id="brief-submit" style="margin-top:18px;padding:10px 22px;border-radius:10px;
              border:1px solid rgba(40,30,20,.15);background:#cc785c;color:#fff;
              font-size:13px;cursor:pointer;">Submit to Hermes</button>
    </div>
    <script>
      document.getElementById("brief-submit").addEventListener("click", () => {
        parent.postMessage({ source: "shelly-artifact", kind: "submit",
          text: "\\u2713 do: ship agent-hub reply path\\n\\u2717 skip: meta-smells until EOD\\n\\u270e note: prep the demo call at 3:30" }, "*");
      });
    </script>
  </body></html>`;
}

/** A curated-shell artifact: on load it posts BOTH its size and a `kind:"shell"`
 *  message, so the Board repaints its whole surface to `bg`/`ink` via the
 *  expanding-circle reveal. Open it in the reader (or as the hero) to watch the
 *  chrome + backdrop flow to the shell. `bg`/`ink` are a curated pair (slate). */
function shellDemoHtml(): string {
  const bg = "#E7ECF1";
  const ink = "#1B2530";
  return `<!doctype html><html><head><meta charset="utf-8">
  <style>html{scrollbar-width:none}html::-webkit-scrollbar{display:none}
    body{margin:0;background:${bg};color:${ink};
      font-family:-apple-system,system-ui,sans-serif;}</style></head>
  <body>
    <div data-fit-root style="max-width:640px;margin:0 auto;padding:44px 34px;">
      <div style="font:600 10px/1 ui-monospace,Menlo,monospace;letter-spacing:.12em;
                  text-transform:uppercase;opacity:.6;">Curated shell — slate</div>
      <div style="font-family:Georgia,serif;font-size:28px;margin-top:10px;">
        The whole surface is this color.</div>
      <p style="font-size:14px;line-height:1.6;opacity:.8;margin:14px 0 0;">
        This artifact declared <code>${bg}</code>. The Board's stage, board and the
        chrome around this panel all repainted to match — one continuous surface,
        revealed with an expanding circle from here.</p>
    </div>
    <script>
      (function () {
        var post = function () {
          parent.postMessage({ source: "shelly-artifact", kind: "shell",
            bg: "${bg}", ink: "${ink}" }, "*");
          var el = document.querySelector("[data-fit-root]") || document.body;
          parent.postMessage({ source: "shelly-artifact", kind: "size",
            w: Math.ceil(el.scrollWidth), h: Math.ceil(el.scrollHeight) }, "*");
        };
        addEventListener("load", post); post();
      })();
    </script>
  </body></html>`;
}

const LIVE_SOURCES = [
  {
    source: "shelly--3f8c1d04",
    json: JSON.stringify({
      working: "Polishing the Board chrome — hierarchy, rail, states",
      where: [
        "Audited the current shell against Claude Desktop and Codex",
        "Worktree feat/board-ui-polish carries the pass",
        "Browser harness renders the real bundle with fixture data",
      ],
      next: [
        { title: "Approve the top-bar restructure", sub: "greeting lockup + machined controls", kind: "decision" },
        { title: "Rail bottom anchor", sub: "settings row pinned like Codex", kind: "todo" },
      ],
      project: "shelly",
      is_repo: true,
      unit_key: "shelly",
      shelly_session: "tab-mock-1",
      session_id: "3f8c1d04-7b62-4e51-9a3d-1c5e802b6af7",
      unit_dir: "/Users/dev/shelly",
      updated_ms: now - 2 * MIN,
    }),
  },
  {
    source: "lantern--9d47a2e6",
    json: JSON.stringify({
      working: "Wiring the transcript pane",
      where: ["Transcript pane scaffolded"],
      next: [{ title: "Pick the diarization vendor", sub: "latency vs cost", kind: "decision" }],
      project: "lantern",
      is_repo: true,
      unit_key: "lantern",
      session_id: "9d47a2e6-0000-4000-8000-000000000001",
      unit_dir: "/Users/dev/lantern",
      updated_ms: now - 9 * MIN,
    }),
  },
  {
    // A SECOND live lantern session, so one project in the harness has a session DRAWER
    // (>1 session) and no Board-owned terminal. Without this every harness project is
    // single-session, and the rail's whole chooser — open-on-entry, tab toggle,
    // click-away dismiss — has no fixture to exercise it.
    //
    // Harness-only: the public demo build reads DEMO_LIVE_SOURCES in demo-profile.ts,
    // not this array, so adding a session here can't change what the demo shows.
    source: "lantern--9d47a2e7",
    json: JSON.stringify({
      working: "Second lantern session, external terminal",
      where: ["Running outside the Board"],
      next: [{ title: "Confirm the ingest backfill", sub: "external session", kind: "todo" }],
      project: "lantern",
      is_repo: true,
      unit_key: "lantern",
      session_id: "9d47a2e7-0000-4000-8000-000000000002",
      unit_dir: "/Users/dev/lantern",
      updated_ms: now - 4 * MIN,
    }),
  },
];

// Fixtures are shared with the PUBLIC demo build — keep every name, path and id
// invented. No real project names, no real home directory.
const RECENT_SESSIONS = [
  { session_id: "r1", cwd: "/Users/dev/lantern", project: "/Users/dev/lantern", last_active_ms: now - 26 * 60 * MIN, size_bytes: 84_000, title: "Rate-limit the ingest worker" },
  { session_id: "r2", cwd: "/Users/dev/orchard", project: "/Users/dev/orchard", last_active_ms: now - 49 * 60 * MIN, size_bytes: 52_000, title: "Fix export timestamps" },
  { session_id: "r3", cwd: "/Users/dev/sundial", project: "/Users/dev/sundial", last_active_ms: now - 3 * 24 * 60 * MIN, size_bytes: 61_000, title: "Timeline scrubber inertia" },
  { session_id: "r4", cwd: "/Users/dev/foundry", project: "/Users/dev/foundry", last_active_ms: now - 5 * 24 * 60 * MIN, size_bytes: 33_000, title: "Watchlist ingest dedupe" },
  { session_id: "r5", cwd: "/Users/dev/kiln", project: "/Users/dev/kiln", last_active_ms: now - 6 * 24 * 60 * MIN, size_bytes: 28_000, title: "Cache the manifest build" },
];

/* --- code-peek fixtures -------------------------------------------------- */

/** The "files in play" the code panel lists (session_files) — the files the mocked
 *  session has written, most recent first. */
const TOUCHED_FILES = [
  { path: "/Users/dev/lantern/src/retry.ts", rel: "src/retry.ts", status: "??" },
  { path: "/Users/dev/lantern/src/queue.ts", rel: "src/queue.ts", status: "M" },
  { path: "/Users/dev/lantern/src/queue.test.ts", rel: "src/queue.test.ts", status: "M" },
];

/** A file long enough to scroll, so the harness exercises the same editor the real
 *  panel does. Anything the fixtures don't name falls through to a short stub. */
const QUEUE_TS = `import { backoff } from "./retry";

export interface Job {
  id: string;
  attempts: number;
  payload: unknown;
}

/** A bounded FIFO with at-most-\`maxAttempts\` redelivery. */
export class Queue {
  private jobs: Job[] = [];

  constructor(
    private readonly capacity: number,
    private readonly maxAttempts = 3,
  ) {}

  get size(): number {
    return this.jobs.length;
  }

  push(job: Job): boolean {
    if (this.jobs.length >= this.capacity) return false;
    this.jobs.push(job);
    return true;
  }

  pop(): Job | undefined {
    return this.jobs.shift();
  }

  /** Re-enqueue a failed job after its backoff, or drop it once spent. */
  retry(job: Job): boolean {
    if (job.attempts + 1 >= this.maxAttempts) return false;
    const next = { ...job, attempts: job.attempts + 1 };
    setTimeout(() => this.push(next), backoff(next.attempts));
    return true;
  }
}
`;

/** The same file before the session touched it — the diff editor's left-hand side.
 *  `retry()` is what this mocked session is in the middle of adding. */
const QUEUE_TS_HEAD = QUEUE_TS.replace(
  /\n  \/\*\* Re-enqueue[\s\S]*?\n  }\n/,
  "",
).replace('import { backoff } from "./retry";\n\n', "");

/** Fixture bodies for `read_touched_file`: [current, at-HEAD]. A `null` HEAD is a
 *  file the session created, which the diff renders wholly as an addition. */
const SOURCES: Record<string, [string, string | null]> = {
  "/Users/dev/lantern/src/queue.ts": [QUEUE_TS, QUEUE_TS_HEAD],
  "/Users/dev/lantern/src/retry.ts": [
    `/** Exponential backoff, capped at 30s, with ±20% jitter. */
export function backoff(attempt: number): number {
  const base = Math.min(30_000, 2 ** attempt * 250);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}
`,
    null, // new file
  ],
};

function fileViewFor(path: string): { content: string; original: string | null; deleted: boolean } {
  const [content, original] = SOURCES[path] ?? [`// ${path}\n`, null];
  return { content, original, deleted: false };
}

export function installTauriMock(opts: { demo?: DemoProfile } = {}): void {
  const listeners = new Map<number, (msg: unknown) => void>();
  // event name -> transformCallback id, so the mock can push events (pty output)
  // back into the bundle the same way the Rust side does.
  const eventHandlers = new Map<string, number>();
  const emit = (event: string, payload: unknown): void => {
    const id = eventHandlers.get(event);
    if (id !== undefined) listeners.get(id)?.({ event, id, payload });
  };
  let cbId = 1;
  const demo = opts.demo ?? null;
  // ?idle=1 boots the Board with nothing live and nothing recent-fresh — the
  // idle-home hero (crab splash, no project selected) for screenshots.
  const idle = new URLSearchParams(location.search).has("idle");
  const liveSources = idle ? [] : demo ? demo.liveSources : LIVE_SOURCES;
  // The artifact set is a pure function of elapsed time, so a reload replays the
  // whole scenario and the timeline is deterministic for scripted verification.
  // The demo's round trip. `answered` is set the moment a Shelly answer is
  // pasted into the session (see write_pty); FOLLOWUP_BEAT_MS later the follow-up
  // artifact starts appearing in list_artifacts, so the Board ingests it exactly
  // as it would a real one — new artifact, unread pip, auto-advance. Without this
  // the post-submit splash promises "the next artifact lands here" and none ever
  // does, and the reader is stranded on it.
  const FOLLOWUP_BEAT_MS = 2_600;
  let answered: { at: number; decision: string } | null = null;
  /** tabId -> unit key (the cwd basename), stamped at spawn_pty. */
  const tabUnit = new Map<string, string>();
  /** tabId -> the answer text pasted into it, awaiting the \r that submits it. */
  const pastedAnswer = new Map<string, string>();

  /** Type a canned transcript into a terminal, honouring each chunk's lead-in pause. */
  const playChunks = (tabId: string, chunks: { text: string; delay: number }[]): void => {
    let at = 0;
    for (const c of chunks) {
      at += c.delay;
      setTimeout(() => emit(`pty-output-${tabId}`, c.text), at);
    }
  };

  const escapeHtml = (s: string): string =>
    s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

  const artifactsNow = (): MockArtifact[] => {
    if (idle) return [];
    // The demo never replays the identity-race fixtures: RACE_ORPHAN exists to
    // alarm the rail's warning row, and a red alarm is not a demo.
    if (demo) {
      const out = [...demo.artifacts, REMOTE_ARTIFACT];
      if (answered && Date.now() - answered.at >= FOLLOWUP_BEAT_MS) {
        // Stamp it as the newest artifact so it sorts to the hero and reads as
        // "just landed" rather than inheriting the profile's boot timestamp.
        out.push({ ...demo.followUp, modified_ms: answered.at + FOLLOWUP_BEAT_MS });
      }
      return out;
    }
    const t = Date.now() - now;
    // Same path, newer mtime — an in-place rewrite, not a new artifact.
    const out: MockArtifact[] = ARTIFACTS.map((a) =>
      a.path === REWRITTEN_PATH && t >= REWRITE_AT_MS
        ? {
            ...a,
            modified_ms: now + REWRITE_AT_MS,
            summary: "REWRITTEN in place — the agent replaced this while you were reading it.",
          }
        : a,
    );
    out.push(REMOTE_ARTIFACT);
    if (t >= 6_000) out.push(LATE_ARTIFACT);
    if (t >= RACE_APPEAR_MS) out.push(t >= RACE_STAMP_MS ? RACE_RESOLVED_STAMPED : RACE_RESOLVED_BARE);
    if (t >= ORPHAN_APPEAR_MS) out.push(RACE_ORPHAN);
    return out;
  };

  // Tab ids whose canned transcript has already played — the Board remounts
  // terminals on navigation, and a replay-on-remount would look like a glitch.
  const replayed = new Set<string>();

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    trace_enabled: () => false,
    sweep_artifacts: () => 0,
    read_all_live: () => liveSources,
    list_artifacts: () => artifactsNow(),
    // The demo timeline has no half-written drafts — every artifact it replays is
    // already sealed — so nothing is ever pending here. Present so the harness answers
    // the call at all: an unmocked command rejects, and the poll that reads this runs
    // beside list_artifacts on every tick.
    list_pending_artifacts: () => [],
    // Event tail (Phase 3/4): the artifact.routed event for RACE_RESOLVED becomes
    // readable at the stamp time — the identity the Board must wait for. `from` is
    // treated as an index (the real command uses byte offsets; same contract shape).
    poll_events: (args) => {
      const from = Number((args as { from?: number }).from ?? 0);
      const ready =
        idle || demo || Date.now() - now < RACE_STAMP_MS
          ? []
          : [
              {
                evt: "artifact.routed",
                path: RACE_RESOLVED_BARE.path,
                session_id: RACE_SID,
                unit_key: "shelly",
                ts_ms: now + RACE_STAMP_MS,
              },
            ];
      return { events: ready.slice(from), next: Math.max(from, ready.length) };
    },
    read_unit_names: () => ({}),
    resolve_home_dir: () => "/Users/dev",
    // No agent-authored home.html in the harness → the native L0 fallback (crab +
    // the two home doors) renders, which is exactly what the door tests need.
    resolve_home: () => null,
    list_recent_sessions: () => RECENT_SESSIONS,
    // Usage meter. The real command reads Claude Code's transcript, which the harness
    // has none of — so serve a fixed reading, pitched into the `warn` band so the
    // meter's non-ambient treatment is visible on sight rather than only under load.
    session_usage: (args) =>
      String(args.sessionId ?? "")
        ? { contextTokens: 742_000, outputTokens: 96_400, model: "claude-opus-4-8", limit: 1_000_000 }
        : null,
    // Account rate-limit pill. The real command calls Anthropic's OAuth usage
    // endpoint; the harness serves a fixed reading in the `warn` band so the
    // pill's non-ambient treatment is visible on sight.
    rate_limit_usage: () => ({
      fiveHour: { utilization: 72.0, resetsAt: new Date(Date.now() + 90 * 60 * 1000).toISOString() },
      sevenDay: { utilization: 18.0, resetsAt: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString() },
    }),
    // Agent hub: the connected-agents registry + the reply inbox. Posts are
    // recorded on window.__inboxPosts so scripted verification can assert the
    // remote submit round-trip (and that it never touched a PTY).
    hub_agents: () => (idle ? "" : JSON.stringify(HUB_AGENTS)),
    hub_post_inbox: (args) => {
      const w = window as unknown as { __inboxPosts?: unknown[] };
      (w.__inboxPosts ??= []).push(args);
      return JSON.stringify({
        envelope: { id: `${Date.now()}-mock`, agent: args.agent, payload: args.payload },
        delivery: "woken",
      });
    },
    take_board_nav_target: () => null,
    artifact_in_scope: () => false,
    read_artifact: (args) => {
      const p = String(args.path ?? "");
      const demoHtml = demo?.artifactHtml(p);
      // The follow-up quotes the visitor's OWN answer back at them, so the agent
      // is replying to what they actually said rather than to a canned pick.
      if (demoHtml) {
        return answered ? demoHtml.split("{{DECISION}}").join(escapeHtml(answered.decision)) : demoHtml;
      }
      if (p.includes("hermes-morning-brief")) return morningBriefHtml();
      if (p.includes("shell-slate")) return shellDemoHtml();
      if (p.includes("observer-latency")) {
        return artifactHtml(
          "Observer latency — measured, output-bound",
          "The director call is slow-not-hung: 142.5s wall, dominated by output tokens in the visuals field.",
          [["Wall clock", "142.5s"], ["Bottleneck", "output tokens"], ["Fix", "trim visuals field"]],
        );
      }
      if (p.includes("harness-live-ingest")) {
        return artifactHtml(
          "Harness — live ingest check",
          "This artifact arrived after boot to exercise unread affordances.",
          [["Arrived", "just now"], ["Route", "lantern"]],
        );
      }
      if (p.includes("race-resolved")) {
        return artifactHtml(
          "Race — identity arrives late",
          "This artifact appeared before its index stamp. The Board held it, then routed it exactly once when the artifact.routed event landed.",
          [["Held", "~3s"], ["Routed by", "event"], ["Reroutes", "0"]],
        );
      }
      if (p.includes("race-orphan")) {
        return artifactHtml(
          "Race — identity never arrives",
          "No stamp ever landed for this artifact. It alarmed the rail's warning row and was collected under Unsourced.",
          [["Grace", "10s"], ["Outcome", "fail-loud"], ["Bucket", "Unsourced"]],
        );
      }
      return artifactHtml(
        "Board UI audit — gaps vs the desktop bar",
        "Top bar unbalanced, rail lacks structure, focus states missing. Polish pass proposed on feat/board-ui-polish.",
        [["Top bar", "restructure"], ["Rail", "rows + bottom anchor"], ["States", "focus/active pass"], ["Frame", "hairline, not 2px black"]],
      );
    },
    // Code-peek fixtures — the session's written files + read-back for the panel.
    session_files: () => TOUCHED_FILES,
    read_touched_file: (args) => fileViewFor(String(args.path ?? "")),
    // PTY + session plumbing. Without a demo profile the harness terminal stays
    // dark (nothing to replay). With one, each unit's terminal types out its own
    // recorded session, so the split view reads as live rather than broken.
    spawn_pty: (args) => {
      if (!demo) return null;
      const tabId = String(args.tabId ?? "");
      const cwd = String(args.cwd ?? "");
      const key = cwd.split("/").filter(Boolean).pop() ?? "";
      tabUnit.set(tabId, key); // so write_pty knows which session an answer landed in
      const chunks = demo.transcripts[key];
      if (!chunks || replayed.has(tabId)) return null;
      replayed.add(tabId);

      const play = (): void => playChunks(tabId, chunks);

      // Terminals are spawned for every unit up front, but a unit's mount stays
      // hidden until the visitor opens it. Hold the replay until then, so the
      // transcript types out on arrival instead of finishing off-screen.
      const mount = document.querySelector(`[data-tab="${tabId}"]`);
      if (!mount) {
        play();
        return null;
      }
      const io = new IntersectionObserver((entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        play();
      });
      io.observe(mount);
      return null;
    },
    // Two very different things arrive here, and the demo must tell them apart.
    //
    //  1. A SHELLY ANSWER. submitIntoPty() sends Ctrl-U, then the compiled
    //     decisions as a BRACKETED PASTE (\e[200~ … \e[201~), then a delayed \r.
    //     A human typing can never produce that escape, so it is an exact signal.
    //     This is the round trip the whole demo exists to show: the session picks
    //     the answer up, does the work, and writes the follow-up artifact.
    //  2. A VISITOR TYPING. Echo it so the box feels alive, and on Enter say
    //     plainly why nothing happens — there is no model behind this terminal.
    write_pty: (args) => {
      // Record every write so scripted checks can assert what the Board typed into a
      // session (the Compact button's `/compact` submit, above all).
      const w = window as unknown as { __ptyWrites?: unknown[] };
      (w.__ptyWrites ??= []).push(args);
      if (!demo) return null;
      const tabId = String(args.tabId ?? "");
      const data = String(args.data ?? "");

      const paste = /\x1b\[200~([\s\S]*?)\x1b\[201~/.exec(data);
      if (paste && tabUnit.get(tabId) === demo.followUpUnit) {
        pastedAnswer.set(tabId, paste[1]);
        return null; // the \r that follows is what fires the continuation
      }

      if (data === "\r") {
        const decision = pastedAnswer.get(tabId);
        if (decision !== undefined && !answered) {
          pastedAnswer.delete(tabId);
          answered = { at: Date.now(), decision };
          playChunks(tabId, demo.followUpTty(decision));
          return null;
        }
        emit(
          `pty-output-${tabId}`,
          "\r\n\x1b[2m  This is a recorded demo — the terminal isn't wired to a model here.\r\n" +
            "  In the app, this is a real Claude Code session.\x1b[0m\r\n\r\n\x1b[2m> \x1b[0m",
        );
      } else if (data >= " " && data <= "~") {
        emit(`pty-output-${tabId}`, data);
      }
      return null;
    },
    resize_pty: () => null,
    close_pty: () => null,
    set_unit_name: () => null,
    dismiss_session: () => null,
    launch_terminal_session: () => null,
    // Remember which transformCallback serves which event, so `emit` can deliver
    // pty output the way the Rust side does. Returns an event id, as Tauri does.
    "plugin:event|listen": (args) => {
      const event = String(args.event ?? "");
      const handler = Number(args.handler);
      if (event && Number.isFinite(handler)) eventHandlers.set(event, handler);
      return cbId++;
    },
    "plugin:event|unlisten": () => null,
  };

  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "board_main" },
      currentWebview: { label: "board_main" },
    },
    transformCallback(cb: (msg: unknown) => void): number {
      const id = cbId++;
      listeners.set(id, cb);
      return id;
    },
    unregisterCallback(id: number): void {
      listeners.delete(id);
    },
    convertFileSrc(path: string): string {
      return `asset://localhost/${encodeURIComponent(path)}`;
    },
    async invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
      const h = handlers[cmd];
      if (h) return h(args);
      console.warn("[tauri-mock] unhandled invoke:", cmd, args);
      return null;
    },
  };
}
