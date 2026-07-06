/* =============================================================================
   TAURI IPC MOCK — boots the real Board bundle in a plain browser (no Tauri).

   installTauriMock() defines window.__TAURI_INTERNALS__ with a fixture-backed
   `invoke`, so `/dev/board-harness.html` can render the Board with realistic
   roster/artifact data for design work + screenshot verification. Zero effect
   on the real app: nothing imports this outside dev/.
   ============================================================================= */

interface MockArtifact {
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
  return `<!doctype html><html><head><meta charset="utf-8"></head>
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
    path: "/mock/artifacts/board-ui-audit.html",
    title: "Board UI audit — gaps vs the desktop bar",
    subject: "UI polish",
    summary: "Hierarchy, chrome density and state gaps named against Claude Desktop / Codex.",
    modified_ms: now - 6 * MIN,
    size_bytes: 14_200,
    project: "~/claude-code-companion",
    unit_key: "claude-code-companion",
    source: "claude-code-companion--e6e63a83",
  },
  {
    path: "/mock/artifacts/observer-latency.html",
    title: "Observer latency — measured, output-bound",
    subject: "observer",
    summary: "142.5s director call is slow-not-hung; visuals field dominates output tokens.",
    modified_ms: now - 95 * MIN,
    size_bytes: 11_800,
    project: "~/claude-code-companion",
    unit_key: "claude-code-companion",
    source: "claude-code-companion--e6e63a83",
  },
];

/** One more artifact lands ~6s after boot — exercises the live-ingest path
 *  (unread bell + "New artifact" pill) so those states can be screenshotted. */
const LATE_ARTIFACT: MockArtifact = {
  path: "/mock/artifacts/harness-live-ingest.html",
  title: "Harness — live ingest check",
  subject: "harness",
  summary: "This artifact arrived after boot to light the unread affordances.",
  modified_ms: now + 6_000,
  size_bytes: 9_000,
  project: "~/helpdesk-companion",
  unit_key: "helpdesk-companion",
  source: "helpdesk-companion--b41c9d22",
};

const LIVE_SOURCES = [
  {
    source: "claude-code-companion--e6e63a83",
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
      project: "claude-code-companion",
      is_repo: true,
      unit_key: "claude-code-companion",
      companion_session: "tab-mock-1",
      session_id: "e6e63a83-f93c-4af9-8016-9145042f958c",
      unit_dir: "/Users/gyatso/claude-code-companion",
      updated_ms: now - 2 * MIN,
    }),
  },
  {
    source: "helpdesk-companion--b41c9d22",
    json: JSON.stringify({
      working: "Wiring the MSP call companion transcript pane",
      where: ["Transcript pane scaffolded"],
      next: [{ title: "Pick the diarization vendor", sub: "latency vs cost", kind: "decision" }],
      project: "helpdesk-companion",
      is_repo: true,
      unit_key: "helpdesk-companion",
      session_id: "b41c9d22-0000-4000-8000-000000000001",
      unit_dir: "/Users/gyatso/helpdesk-companion",
      updated_ms: now - 9 * MIN,
    }),
  },
];

const RECENT_SESSIONS = [
  { session_id: "r1", cwd: "/Users/gyatso/job-applier-bot", project: "/Users/gyatso/job-applier-bot", last_active_ms: now - 26 * 60 * MIN, size_bytes: 84_000, title: "Build LinkedIn auto-messaging flow" },
  { session_id: "r2", cwd: "/Users/gyatso/clipping", project: "/Users/gyatso/clipping", last_active_ms: now - 49 * 60 * MIN, size_bytes: 52_000, title: "Fix clip export timestamps" },
  { session_id: "r3", cwd: "/Users/gyatso/shikari-editor", project: "/Users/gyatso/shikari-editor", last_active_ms: now - 3 * 24 * 60 * MIN, size_bytes: 61_000, title: "Timeline scrubber inertia" },
  { session_id: "r4", cwd: "/Users/gyatso/wtb", project: "/Users/gyatso/wtb", last_active_ms: now - 5 * 24 * 60 * MIN, size_bytes: 33_000, title: "Watchlist ingest dedupe" },
  { session_id: "r5", cwd: "/Users/gyatso", project: "/Users/gyatso", last_active_ms: now - 6 * 24 * 60 * MIN, size_bytes: 28_000, title: "Sort downloads folder" },
];

export function installTauriMock(): void {
  const listeners = new Map<number, (msg: unknown) => void>();
  let cbId = 1;
  let artifacts = [...ARTIFACTS];
  setTimeout(() => {
    artifacts = [...artifacts, LATE_ARTIFACT];
  }, 6_000);

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    trace_enabled: () => false,
    sweep_artifacts: () => 0,
    read_all_live: () => LIVE_SOURCES,
    list_artifacts: () => artifacts,
    read_unit_names: () => ({}),
    resolve_home_dir: () => "/Users/gyatso",
    resolve_home: () => "/Users/gyatso",
    list_recent_sessions: () => RECENT_SESSIONS,
    read_dials: () => ({ mode: "manual", quality: "pretty" }),
    set_dial: () => null,
    take_board_nav_target: () => null,
    artifact_in_scope: () => false,
    read_artifact: (args) => {
      const p = String(args.path ?? "");
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
          [["Arrived", "just now"], ["Route", "helpdesk-companion"]],
        );
      }
      return artifactHtml(
        "Board UI audit — gaps vs the desktop bar",
        "Top bar unbalanced, rail lacks structure, focus states missing. Polish pass proposed on feat/board-ui-polish.",
        [["Top bar", "restructure"], ["Rail", "rows + bottom anchor"], ["States", "focus/active pass"], ["Frame", "hairline, not 2px black"]],
      );
    },
    // PTY + session plumbing — accept and do nothing (the harness terminal stays dark).
    spawn_pty: () => null,
    write_pty: () => null,
    resize_pty: () => null,
    close_pty: () => null,
    set_unit_name: () => null,
    dismiss_session: () => null,
    launch_terminal_session: () => null,
    "plugin:event|listen": () => cbId++,
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
