/**
 * Regression check pinned to the demo's answer loop.
 *
 * THE BUG THIS PINS: the recorded demo walked three sides of the loop and stopped
 * on the fourth. Clicking ✓/✎/✗ on a demo artifact DID reach the session, but the
 * mock answered "this terminal isn't wired to a model" and nothing further ever
 * happened. Meanwhile the artifact's own post-submit splash promises "the next
 * artifact lands here" — and with a static artifact set, none ever did. The reader
 * was left staring at a promise that never resolved.
 *
 * The demo exists to teach ONE thing: you answer from the Board, and the agent
 * keeps going. That is the fourth side. These checks pin it.
 *
 * THE SIGNATURE: a Companion answer arrives as a BRACKETED PASTE (\e[200~ … \e[201~)
 * — submitIntoPty's wire format, which a human keystroke can never produce. That,
 * and only that, arms the follow-up. If someone "simplifies" write_pty back to a
 * plain `data === "\r"` check, case 5 fails: a visitor typing `hello` + Enter would
 * start landing artifacts.
 *
 *   node --experimental-strip-types scripts/check-demo-loop.ts
 */

/* ---- browser shims (the mock is written against a DOM; node has none) ------- */
const g = globalThis as unknown as Record<string, unknown>;
g.window = g;
g.location = { search: "" };
g.document = { querySelector: () => null };

const { installTauriMock } = await import("../dev/tauri-mock.ts");

let failed = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}`);
  if (!cond) failed++;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ---- a minimal stand-in for the real demo profile --------------------------
   Deliberately NOT the real demo-profile.ts: that imports artifact HTML through
   Vite's `?raw`, which node cannot resolve. The shape is what matters here. */
const FOLLOWUP = {
  path: "/demo/artifacts/tidepool-shipped.html",
  title: "Your call is in",
  subject: "tidepool — your call is in",
  summary: "…",
  modified_ms: 0,
  size_bytes: 100,
  project: "~/tidepool",
  unit_key: "tidepool",
  source: "tidepool--a4f1c920",
};

installTauriMock({
  demo: {
    artifacts: [
      {
        path: "/demo/artifacts/tidepool-velocity.html",
        title: "The velocity metric is measuring nothing",
        subject: "tidepool",
        summary: "…",
        modified_ms: Date.now(),
        size_bytes: 100,
        project: "~/tidepool",
        unit_key: "tidepool",
        source: "tidepool--a4f1c920",
      },
    ],
    liveSources: [],
    artifactHtml: (p: string) =>
      p.includes("tidepool-shipped") ? "<pre>{{DECISION}}</pre>" : null,
    transcripts: { tidepool: [{ text: "boot\r\n", delay: 0 }] },
    followUp: FOLLOWUP,
    followUpTty: (decision: string) => [
      { text: `[pasted]${decision.split("\n")[0]}\r\n`, delay: 0 },
      { text: "● Got it — taking unitsSold out of the ranking path.\r\n", delay: 10 },
    ],
    followUpUnit: "tidepool",
  },
});

const tauri = (g.__TAURI_INTERNALS__ ?? {}) as {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback: (cb: (msg: unknown) => void) => number;
};

/* ---- listen to the tidepool terminal --------------------------------------- */
const TAB = "tab-tidepool";
const out: string[] = [];
const cbId = tauri.transformCallback((msg) => {
  out.push(String((msg as { payload: string }).payload));
});
await tauri.invoke("plugin:event|listen", { event: `pty-output-${TAB}`, handler: cbId });
await tauri.invoke("spawn_pty", { tabId: TAB, cwd: "/Users/dev/tidepool" });

const artifacts = async (): Promise<{ path: string }[]> =>
  (await tauri.invoke("list_artifacts")) as { path: string }[];
const hasFollowUp = async (): Promise<boolean> =>
  (await artifacts()).some((a) => a.path === FOLLOWUP.path);

/* ---- 1. the follow-up must NOT exist before the visitor answers ------------- */
check("no follow-up artifact before any answer", !(await hasFollowUp()));

/* ---- 2. a visitor TYPING must not arm it (only a real paste may) ------------ */
await tauri.invoke("write_pty", { tabId: TAB, data: "h" });
await tauri.invoke("write_pty", { tabId: TAB, data: "i" });
await tauri.invoke("write_pty", { tabId: TAB, data: "\r" });
check("typing echoes back to the terminal", out.join("").includes("hi"));
check(
  "typing + Enter still gets the honest 'not wired to a model' line",
  out.join("").includes("isn't wired to a model"),
);
check("typing + Enter does NOT land an artifact", !(await hasFollowUp()));

/* ---- 3. a real Companion answer (bracketed paste + \r) arms the loop -------- */
const ANSWER =
  "✓ Do it: Drop sales-velocity entirely and rank on followerCount delta\n✗ Skip: Pay for the vendor's paid analytics tier";
out.length = 0;
await tauri.invoke("write_pty", { tabId: TAB, data: "\x15" }); // Ctrl-U, as submitIntoPty sends
await tauri.invoke("write_pty", { tabId: TAB, data: `\x1b[200~${ANSWER}\x1b[201~` });
await tauri.invoke("write_pty", { tabId: TAB, data: "\r" });
await sleep(60);

check(
  "the session picks the answer up and works (continuation played)",
  out.join("").includes("Got it") && out.join("").includes("unitsSold"),
);
check(
  "the answer does NOT get the 'not wired to a model' brush-off",
  !out.join("").includes("isn't wired to a model"),
);

/* ---- 4. …and the follow-up artifact LANDS on the Board ---------------------- */
check("follow-up has not landed yet (a beat passes first)", !(await hasFollowUp()));
await sleep(2_800); // FOLLOWUP_BEAT_MS is 2600
check("the follow-up artifact lands after the beat", await hasFollowUp());

const landed = (await artifacts()).find((a) => a.path === FOLLOWUP.path) as unknown as {
  unit_key: string;
  source: string;
  modified_ms: number;
};
check("it routes into tidepool's unit (so the hero shows it)", landed.unit_key === "tidepool");
check(
  "it carries tidepool's source (so auto-advance carries the reader to it)",
  landed.source === "tidepool--a4f1c920",
);
check("it is stamped as the newest artifact", landed.modified_ms > FOLLOWUP.modified_ms);

/* ---- 5. the agent replies to what the visitor ACTUALLY said ----------------- */
const html = (await tauri.invoke("read_artifact", { path: FOLLOWUP.path })) as string;
check("the follow-up quotes the visitor's own answer back", html.includes("followerCount delta"));
check("no unfilled placeholder is left in the page", !html.includes("{{DECISION}}"));

console.log(failed === 0 ? "\nall good" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
