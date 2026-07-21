#!/usr/bin/env node
// Unit tests for the ARTIFACT SEAL — the turn-boundary stamp that tells the Board an
// artifact has stopped being written and may finally be shown.
//
// The bug this pins: `routeArtifact` re-stamps the index on EVERY write, so an agent
// authoring one artifact (Write, then edits, then a rewrite) used to publish revision 1
// immediately and then nag an "Updated" affordance for each write after it. The seal is
// what separates "still authoring" from "done": stamped by the Stop hook, read by the
// Rust listing (see is_settled in history.rs, tested there).
//
// SANDBOXED: every index file is written under a throwaway tmp dir via the `opts.home` /
// `opts.indexPath` injection both modules accept, so this never touches live ~/.shelly.

const fs = require("fs");
const os = require("os");
const path = require("path");

const identity = require("../shelly-identity.cjs");
const gate = require("../shelly-artifact-gate.cjs");

let pass = 0,
  fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    console.log("  ✗ FAIL: " + msg);
  }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "shelly-seal-"));
const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER = "99999999-8888-7777-6666-555555555555";

let n = 0;
/** A fresh index file per case, so cases can't leak into each other. */
function makeIndex(entries) {
  const p = path.join(sandbox, `index-${n++}.json`);
  fs.writeFileSync(p, JSON.stringify(entries));
  return p;
}
function read(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

console.log("\nsealArtifacts");

// The core contract: the session's own artifact gets a seal stamp.
{
  const p = makeIndex({
    "/a/plan.html": { unit_key: "u", session_id: SID, shortid: SID.slice(0, 8), ts: 1000 },
  });
  const count = identity.sealArtifacts(SID, { indexPath: p });
  const e = read(p)["/a/plan.html"];
  ok(count === 1, "seals the session's own artifact");
  ok(typeof e.sealed_ms === "number" && e.sealed_ms > 0, "stamps a numeric sealed_ms");
  ok(e.unit_key === "u" && e.ts === 1000, "preserves the existing entry fields");
}

// A sibling session's artifact is NOT this session's to seal — sealing it would publish
// a document that session is still mid-write on.
{
  const p = makeIndex({
    "/a/mine.html": { unit_key: "u", session_id: SID, ts: 1000 },
    "/a/theirs.html": { unit_key: "u", session_id: OTHER, ts: 1000 },
  });
  const count = identity.sealArtifacts(SID, { indexPath: p });
  const idx = read(p);
  ok(count === 1, "seals only its own entry when a sibling's is present");
  ok(idx["/a/theirs.html"].sealed_ms === undefined, "leaves a sibling session's artifact unsealed");
}

// Older entries predate `session_id` and carry only a shortid — the gate matches on
// either, so the seal must too or those artifacts are never released.
{
  const p = makeIndex({ "/a/legacy.html": { unit_key: "u", shortid: SID.slice(0, 8), ts: 1000 } });
  ok(identity.sealArtifacts(SID, { indexPath: p }) === 1, "matches a legacy entry by shortid");
}

// Idempotence: Stop fires once per turn, so a long session seals repeatedly. The FIRST
// seal time must survive — re-stamping would keep resetting the artifact's age and, with
// it, the Rust backstop that depends on it.
{
  const p = makeIndex({ "/a/plan.html": { unit_key: "u", session_id: SID, ts: 1000 } });
  identity.sealArtifacts(SID, { indexPath: p });
  const first = read(p)["/a/plan.html"].sealed_ms;
  const again = identity.sealArtifacts(SID, { indexPath: p });
  ok(again === 0, "re-sealing reports nothing newly sealed");
  ok(read(p)["/a/plan.html"].sealed_ms === first, "an already-sealed entry keeps its first stamp");
}

// THE INTERRUPTED-TURN ORPHAN. A turn the user ESCs never reaches Stop, so its artifact
// stays unsealed. Because the sweep is per-SESSION rather than per-turn, the next Stop
// adopts it — without this the artifact would hang unseen until the Rust backstop.
{
  const p = makeIndex({
    "/a/orphan.html": { unit_key: "u", session_id: SID, ts: 1000 },
    "/a/fresh.html": { unit_key: "u", session_id: SID, ts: 9000 },
  });
  ok(identity.sealArtifacts(SID, { indexPath: p }) === 2, "a later Stop sweeps up an earlier turn's orphan");
}

// Fail-safe paths: never throw, and never write garbage.
{
  ok(identity.sealArtifacts(SID, { indexPath: path.join(sandbox, "nope.json") }) === 0, "missing index → 0, no throw");
  const bad = path.join(sandbox, "corrupt.json");
  fs.writeFileSync(bad, "{not json");
  ok(identity.sealArtifacts(SID, { indexPath: bad }) === 0, "corrupt index → 0, no throw");
  ok(identity.sealArtifacts("", { indexPath: makeIndex({}) }) === 0, "empty session id → 0");
}

console.log("\nsealIfDone (the Stop-hook gate)");

// A finished turn seals.
{
  const p = makeIndex({ "/a/plan.html": { unit_key: "u", session_id: SID, ts: 1000 } });
  const count = gate.sealIfDone({ session_id: SID }, { block: false }, { indexPath: p });
  ok(count === 1, "an unblocked Stop seals the turn's artifacts");
}

// THE LOAD-BEARING GATE. When the hook BLOCKS it is handing the turn back — the agent is
// about to write again (sharpest in the responder-less case, where it must rewrite the
// artifact to add a ballot). Sealing there would publish the half-finished revision and
// then charge the user an "Updated" nag for the fix: the exact churn this feature removes.
{
  const p = makeIndex({ "/a/plan.html": { unit_key: "u", session_id: SID, ts: 1000 } });
  const count = gate.sealIfDone({ session_id: SID }, { block: true, reason: "…" }, { indexPath: p });
  ok(count === 0, "a BLOCKED Stop seals nothing — the turn is not over");
  ok(read(p)["/a/plan.html"].sealed_ms === undefined, "the artifact stays withheld while the agent rewrites it");
}

// Never let a seal failure affect the turn.
{
  ok(gate.sealIfDone(null, { block: false }) === 0, "no input → 0, no throw");
  ok(gate.sealIfDone({}, { block: false }) === 0, "no session_id → 0, no throw");
  ok(gate.sealIfDone({ session_id: SID }, null) === 0, "no decision → 0, no throw");
}

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
