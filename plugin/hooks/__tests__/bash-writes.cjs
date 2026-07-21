#!/usr/bin/env node
// Regression suite for artifacts written by Claude Code's Bash tool.
//
// THE BUG THIS LOCKS DOWN: the PostToolUse matcher listed Codex's shell tool names
// (shell/exec_command/…) but not Claude Code's, which is literally named "Bash". An
// artifact built with `cat parts > out.html` therefore never reached the hook at all —
// no index entry, no artifact.routed event, and the Board showed it unrouted. The
// extractor could already recover a path from command text; only the gate was shut.
//
// The second half guards the fix's own hazard: once shell payloads are indexed, a
// command that merely READS an artifact carries the same path text as one that wrote
// it, so a mention must not be allowed to re-route another session's artifact.
// SANDBOXED: temp dirs only; never touches live ~/.shelly or ~/.claude state.

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOKS = path.join(__dirname, "..");
const { classifyPaths, extractPaths } = require(path.join(HOOKS, "shelly-artifact-paths.cjs"));

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

// ---- Case 1: the matcher actually admits every tool that can write a file ----
// This is the assertion whose absence let the bug ship: the matcher was reviewed as a
// list of names, and nobody checked it against the name Claude Code really sends.
console.log("### PostToolUse matcher covers every write-capable tool");
{
  const cfg = JSON.parse(fs.readFileSync(path.join(HOOKS, "hooks.json"), "utf8"));
  const post = cfg.hooks.PostToolUse[0].matcher;
  const re = new RegExp(post);

  // Claude Code's own tool names — Bash is the one that regressed.
  for (const tool of ["Write", "Edit", "Bash"]) {
    ok(re.test(tool), `matcher admits Claude's ${tool}`);
  }
  // Codex CLI's tool names.
  for (const tool of ["apply_patch", "shell", "shell_command", "unified_exec", "exec_command"]) {
    ok(re.test(tool), `matcher admits Codex's ${tool}`);
  }
  ok(!re.test("WebFetch"), "matcher does not admit a tool that cannot write files");
}

// ---- Case 2: a Bash-written artifact is recovered from the command text ----
console.log("\n### Bash write → path recovered, tagged scan");
{
  const A = "/home/u/.shelly/artifacts";
  const fresh = () => true; // freshness is Case 3's subject

  // The exact command shape that produced the unrouted artifact.
  const payload = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: `cat "$SP/body.html" "$SP/helper.html" > ${A}/sso-freeze.html` },
  });
  const got = classifyPaths(payload, A, { isFresh: fresh });
  ok(got.length === 1 && got[0].path === A + "/sso-freeze.html", "redirect-to-file write recovered");
  ok(got[0].origin === "scan", "command-text path is tagged scan, not exact");

  // A Write payload still takes the exact fast path (and needs no freshness proof).
  const w = classifyPaths(JSON.stringify({ tool_name: "Write", tool_input: { file_path: A + "/p.html" } }), A);
  ok(w.length === 1 && w[0].origin === "exact", "Write file_path is tagged exact");

  // Heredoc + node/python writers land in the same command string.
  const heredoc = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: `node -e 'require("fs").writeFileSync("${A}/gen.html", h)'` },
  });
  ok(
    classifyPaths(heredoc, A, { isFresh: fresh }).some((e) => e.path === A + "/gen.html"),
    "node -e writer inside a Bash command recovered",
  );
}

// ---- Case 3: a mention is not a write ----
console.log("\n### freshness gate separates a write from a read");
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "shelly-bash-"));
  const A = path.join(sandbox, "artifacts");
  fs.mkdirSync(A);
  const target = path.join(A, "read-me.html");
  fs.writeFileSync(target, "<!doctype html><p>hi</p>");

  const readCmd = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: `grep -n "blob-head" ${target}` },
  });

  // Just written → a command naming it is plausibly the writer.
  ok(classifyPaths(readCmd, A).length === 1, "path written moments ago passes the freshness gate");

  // Backdate it an hour: the same text is now unambiguously a read of an older file.
  const old = Date.now() / 1000 - 3600;
  fs.utimesSync(target, old, old);
  ok(classifyPaths(readCmd, A).length === 0, "grep of an hour-old artifact is dropped, not indexed");

  // A path nothing ever wrote is dropped too.
  const ghost = JSON.stringify({
    tool_name: "Bash",
    tool_input: { command: `ls ${path.join(A, "never-existed.html")}` },
  });
  ok(classifyPaths(ghost, A).length === 0, "mention of a nonexistent artifact is dropped");

  // An exact Write is trusted regardless of mtime — the field only exists on a writer.
  const staleWrite = JSON.stringify({ tool_name: "Write", tool_input: { file_path: target } });
  ok(classifyPaths(staleWrite, A).length === 1, "exact file_path bypasses the freshness gate");

  fs.rmSync(sandbox, { recursive: true, force: true });
}

// ---- Case 4: extractPaths stays pure for its existing callers ----
console.log("\n### extractPaths back-compat");
{
  const A = "/home/u/.shelly/artifacts";
  const got = extractPaths(JSON.stringify({ tool_input: { command: "mv /tmp/x.html " + A + "/moved.html" } }), A);
  ok(
    got.length === 1 && got[0] === A + "/moved.html",
    "extractPaths still returns plain strings with no fs/clock dependency",
  );
}

// ---- Case 5: end-to-end through the real shell hook ----
// Unit coverage can't see the shell: shelly-hook now splits an "<origin>\tpath" line,
// so the tab handling and the ORIGIN handoff to shelly-index.cjs need the real script.
console.log("\n### shelly-hook end-to-end (Bash payload)");
{
  const { execFileSync } = require("child_process");
  const SHELLY_HOOK = path.join(HOOKS, "shelly-hook");

  const mkHome = (tag) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "shelly-e2e-" + tag + "-"));
    fs.mkdirSync(path.join(home, ".shelly", "artifacts"), { recursive: true });
    // The sandbox session has no SHELLY_SESSION (it wasn't spawned by the Board), so
    // opt it past the external-terminals gate or the hook exits before indexing —
    // which would make every assertion below pass vacuously.
    fs.writeFileSync(path.join(home, ".shelly", "external-terminals"), "on");
    // The hook bails without a `shelly` CLI on PATH (harmless-without-the-app seam).
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "shelly"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return { home, bin, artifacts: path.join(home, ".shelly", "artifacts") };
  };
  const fire = (home, bin, payload) => {
    const env = { ...process.env, HOME: home, PATH: bin + ":" + process.env.PATH };
    delete env.SHELLY_SESSION;
    delete env.SHELLY_ARTIFACTS_DIR;
    execFileSync("sh", [SHELLY_HOOK], { input: payload, env, encoding: "utf8" });
  };
  const readIdx = (home) => {
    const p = path.join(home, ".shelly", "artifact-index.json");
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  };

  // 5a — the exact failure: `cat parts > artifact.html` must land in the index.
  {
    const { home, bin, artifacts } = mkHome("write");
    const fp = path.join(artifacts, "bash-built.html");
    fs.writeFileSync(fp, '<!doctype html><html><head><meta charset="utf-8"></head><body>x</body></html>');
    fire(
      home,
      bin,
      JSON.stringify({
        session_id: "bash-writer-1",
        cwd: fs.mkdtempSync(path.join(os.tmpdir(), "shelly-proj-")),
        tool_name: "Bash",
        tool_input: { command: `cat "$SP/body.html" > ${fp}` },
      }),
    );
    const entry = readIdx(home)[fp];
    ok(!!entry, "Bash-written artifact gains an index entry");
    ok(entry && entry.session_id === "bash-writer-1", "entry keyed to the writing session");
    fs.rmSync(home, { recursive: true, force: true });
  }

  // 5b — the fix's own hazard: grepping someone else's artifact must not steal it.
  {
    const { home, bin, artifacts } = mkHome("read");
    const fp = path.join(artifacts, "owned-by-someone-else.html");
    fs.writeFileSync(fp, '<!doctype html><html><head><meta charset="utf-8"></head><body>x</body></html>');
    const idxPath = path.join(home, ".shelly", "artifact-index.json");
    fs.writeFileSync(
      idxPath,
      JSON.stringify({ [fp]: { unit_key: "__home__", shortid: "owner123", source: "gyatso--owner123", ts: Date.now(), session_id: "owner-session" } }),
    );
    fire(
      home,
      bin,
      JSON.stringify({
        session_id: "nosy-reader",
        cwd: fs.mkdtempSync(path.join(os.tmpdir(), "shelly-proj-")),
        tool_name: "Bash",
        tool_input: { command: `grep -n "blob-head" ${fp}` },
      }),
    );
    const entry = readIdx(home)[fp];
    ok(entry && entry.session_id === "owner-session", "a read by another session leaves the owner's entry intact");
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
