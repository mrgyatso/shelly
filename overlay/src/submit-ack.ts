/**
 * Pure logic for the artifact→overlay SUBMIT ACK and unknown-kind detection.
 * DOM-free and dependency-free so it can be unit-tested (`npm test`); resize.ts
 * and board.ts wrap these in the thin console/postMessage calls.
 *
 * Why this exists: an artifact's Submit used to be fire-and-forget. The helper
 * printed "Sent ✓" on the line after postMessage, and nothing ever contradicted
 * it — so an artifact posting a mis-spelled `kind` had every answer discarded in
 * silence while reporting success to the user. The overlay now acks the route a
 * submit actually took, and warns about any kind it doesn't recognise.
 */

/** The route a submit actually travelled, and whether it landed. */
export interface SubmitOutcome {
  ok: boolean;
  via: "terminal" | "clipboard" | "agent";
}

/** The overlay→artifact confirmation. `via` names the route that carried it. */
export interface SubmitAckMessage {
  source: "shelly-board";
  kind: "submit-ack";
  ok: boolean;
  via: SubmitOutcome["via"];
}

/**
 * Every `kind` the artifact→overlay protocol defines, across BOTH listeners
 * (initFit in resize.ts and wireNavigate in board.ts). Deliberately the union,
 * not what any one listener handles: the Board ignores `size` on purpose
 * (full-bleed surfaces must never drive a window resize), and that is not a
 * mistake worth warning about. Anything outside this set is a protocol typo.
 */
export const KNOWN_ARTIFACT_KINDS: readonly string[] = [
  "size",
  "submit",
  "copy",
  "shell",
  "navigate",
  "new-session",
  "splash-dismissed",
];

/** Build the ack an artifact's helper waits for. */
export function submitAckMessage(ok: boolean, via: SubmitOutcome["via"]): SubmitAckMessage {
  return { source: "shelly-board", kind: "submit-ack", ok, via };
}

/**
 * Return the offending kind when `d` addresses our protocol with a kind nothing
 * handles — or null when there is nothing to complain about.
 *
 * Messages in someone else's namespace stay silent: artifact authors may use
 * their own iframe-internal messaging, and that was the original reason unknown
 * kinds were dropped without comment. That reasoning only ever justified foreign
 * traffic, though. Anything claiming `source:"shelly-artifact"` is addressing
 * THIS protocol, so an unrecognised kind there is a bug worth surfacing.
 */
export function unknownArtifactKind(d: unknown): string | null {
  if (!d || typeof d !== "object") return null;
  const m = d as Record<string, unknown>;
  if (m.source !== "shelly-artifact") return null;
  if (typeof m.kind !== "string") return m.kind === undefined ? "(missing)" : String(m.kind);
  if (KNOWN_ARTIFACT_KINDS.includes(m.kind)) return null;
  return m.kind;
}

/** The warning text for an unrecognised kind. Split out so the test can assert
 *  it names the kind and says the user's answer was lost — the two things that
 *  would have made the original bug obvious in seconds. */
export function unknownKindWarning(kind: string): string {
  return (
    `[shelly] ignored artifact message with unknown kind ${JSON.stringify(kind)}. ` +
    `Expected one of: ${KNOWN_ARTIFACT_KINDS.join(", ")}. ` +
    `If this was a Submit, the artifact is mis-wired and the user's answer was DROPPED.`
  );
}
