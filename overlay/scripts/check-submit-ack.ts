/**
 * Unit checks for the SUBMIT ACK + unknown-kind logic (src/submit-ack.ts).
 *
 * Regression guard for a real bug: an artifact posted `kind:"feedback"` instead
 * of `kind:"submit"`, so the overlay's type guard rejected it and the message was
 * discarded — while the artifact's button printed "sent ✓" unconditionally,
 * because nothing ever acked. Every answer the user marked was lost, silently.
 * These checks pin both halves of the fix: unknown kinds are surfaced, and the
 * ack describes the route a submit ACTUALLY took.
 *
 * DOM-free; run with `npm test` (node --experimental-strip-types).
 */

import {
  KNOWN_ARTIFACT_KINDS,
  submitAckMessage,
  unknownArtifactKind,
  unknownKindWarning,
} from "../src/submit-ack.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log("  ok  " + msg);
  } else {
    fail++;
    console.log("  FAIL " + msg);
  }
}

console.log("\n### the bug that started it: kind:'feedback' must not pass silently");
{
  const theRealBug = { source: "shelly-artifact", kind: "feedback", text: "✓ Do it: …" };
  ok(unknownArtifactKind(theRealBug) === "feedback", "kind:'feedback' is reported as unknown");
  const warning = unknownKindWarning("feedback");
  ok(warning.includes('"feedback"'), "the warning names the offending kind");
  ok(warning.includes("submit"), "the warning lists the kind it should have been");
  ok(warning.includes("DROPPED"), "the warning says the user's answer was lost, not just 'ignored'");
}

console.log("\n### known kinds stay silent");
{
  for (const kind of KNOWN_ARTIFACT_KINDS) {
    ok(
      unknownArtifactKind({ source: "shelly-artifact", kind }) === null,
      `kind:'${kind}' is recognised (no warning)`,
    );
  }
  ok(
    unknownArtifactKind({ source: "shelly-artifact", kind: "size", w: 900, h: 600 }) === null,
    "the Board ignoring 'size' is by design, never a warning",
  );
}

console.log("\n### foreign namespaces are still none of our business");
{
  ok(unknownArtifactKind({ source: "my-own-widget", kind: "whatever" }) === null, "a foreign source is ignored");
  ok(unknownArtifactKind({ source: "shelly-board", kind: "submit-ack" }) === null, "our own ack back is not flagged");
  ok(unknownArtifactKind({ kind: "submit" }) === null, "a message with no source is ignored");
  ok(unknownArtifactKind("just a string") === null, "a non-object is ignored");
  ok(unknownArtifactKind(null) === null, "null is ignored");
  ok(unknownArtifactKind(undefined) === null, "undefined is ignored");
  ok(unknownArtifactKind(42) === null, "a number is ignored");
}

console.log("\n### malformed kinds in OUR namespace are still surfaced");
{
  ok(unknownArtifactKind({ source: "shelly-artifact" }) === "(missing)", "a missing kind is reported");
  ok(unknownArtifactKind({ source: "shelly-artifact", kind: 7 }) === "7", "a non-string kind is reported");
  ok(unknownArtifactKind({ source: "shelly-artifact", kind: "Submit" }) === "Submit", "kinds are case-sensitive");
  ok(unknownArtifactKind({ source: "shelly-artifact", kind: "submit " }) === "submit ", "a stray space is not forgiven");
}

console.log("\n### the ack tells the truth about the route taken");
{
  const sent = submitAckMessage(true, "terminal");
  ok(sent.source === "shelly-board", "ack is in the board namespace (artifacts must not forge it)");
  ok(sent.kind === "submit-ack", "ack kind is 'submit-ack'");
  ok(sent.ok === true && sent.via === "terminal", "a PTY write acks ok via terminal");

  ok(submitAckMessage(true, "clipboard").via === "clipboard", "a clipboard fallback acks via clipboard, not terminal");
  ok(submitAckMessage(true, "agent").via === "agent", "a hub delivery acks via agent");

  const failed = submitAckMessage(false, "clipboard");
  ok(failed.ok === false, "a failed clipboard write acks ok:false — the artifact must not claim success");
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
