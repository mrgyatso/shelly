/* =============================================================================
   DEMO BOOT — the entry `demo.html` loads instead of `/src/main.ts`.

   Installs the mocked Tauri IPC (backed by the demo profile) and only then boots
   the real Board bundle, unmodified. `main.ts` must be a DYNAMIC import: static
   imports are hoisted and would evaluate the bundle before the mock exists.
   ============================================================================= */

import { installTauriMock } from "./tauri-mock";
import {
  DEMO_ARTIFACTS,
  DEMO_FOLLOWUP,
  DEMO_LIVE_SOURCES,
  DEMO_TRANSCRIPTS,
  DEMO_UNITS,
  bindDemoSession,
  demoArtifactHtml,
  tidepoolFollowUpTty,
} from "./demo-profile";

installTauriMock({
  demo: {
    artifacts: DEMO_ARTIFACTS,
    liveSources: DEMO_LIVE_SOURCES,
    artifactHtml: demoArtifactHtml,
    transcripts: DEMO_TRANSCRIPTS,
    followUp: DEMO_FOLLOWUP,
    followUpTty: tidepoolFollowUpTty,
    followUpUnit: "tidepool",
  },
});

window.__BOARD_MODE__ = true;

/* Chromium-only: a RECYCLED sandboxed srcdoc iframe stops painting after its
   first content swap (production is WKWebView, which repaints fine). Re-inserting
   the element in place discards + recreates its browsing context — same element
   object, so board.ts's references stay valid. Reinsertion doesn't mutate
   attributes, so this never loops. Same workaround as dev/board-harness.html. */
const reviveOnSwap = (el: HTMLElement | null): void => {
  if (!el) return;
  new MutationObserver(() => {
    el.parentElement?.insertBefore(el, el.nextSibling);
  }).observe(el, { attributeFilter: ["srcdoc", "src"] });
};
reviveOnSwap(document.getElementById("unit-digest"));
reviveOnSwap(document.getElementById("hub-frame"));

/** Resolve once `el` exists in the DOM, or reject after `timeoutMs`. */
function waitFor(selector: string, timeoutMs = 10_000): Promise<Element> {
  const found = document.querySelector(selector);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      obs.disconnect();
      reject(new Error(`demo-boot: ${selector} never appeared`));
    }, timeoutMs);
    const obs = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (!el) return;
      clearTimeout(timer);
      obs.disconnect();
      resolve(el);
    });
    obs.observe(document.body, { childList: true, subtree: true });
  });
}

/** Give each demo unit a Board-OWNED terminal.
 *
 *  Ownership is an in-memory binding (tabId ↔ `companion_session`), so a mocked
 *  live file can never produce it: the Board would correctly conclude the session
 *  runs in an external terminal and render the "Start session here" CTA instead of
 *  a PTY. Spawning through the Board's own entry point — the same one that CTA
 *  calls — gives each unit a real terminal for the mock to replay into. */
async function primeDemoTerminals(): Promise<void> {
  const { spawnOwnedSession } = await import("../src/owned-terminals");
  // initOwnedTerminals() mounts its body into this slot; spawning before that
  // throws. The slot's first child is the signal that it has run.
  await waitFor("#unit-terminals > *");
  for (const { unitKey, cwd } of DEMO_UNITS) {
    const tabId = await spawnOwnedSession(cwd, unitKey).catch((e) => {
      console.error("demo-boot:", e);
      return null;
    });
    // Without this the hero can't tie the unit's artifact to the shown session,
    // and every unit lands on the blank "Clawd's on it" splash.
    if (tabId) bindDemoSession(unitKey, tabId);
  }
}

/* Dynamic, and deliberately not awaited: a top-level await would force the build
   target above the browsers this demo should reach. Ordering is already safe —
   this import is requested only after installTauriMock() has run. */
void import("../src/main").then(() => primeDemoTerminals());

