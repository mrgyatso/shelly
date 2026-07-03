#!/usr/bin/env node
// Dispatcher: turn `agent-ready` issues into per-issue worktrees + headless
// worker agents that open PRs into the `integration/agents` staging branch.
//
//   node pipeline/dispatch.mjs            # DRY-RUN (default): print planned actions, do nothing
//   node pipeline/dispatch.mjs --go       # really dispatch
//   node pipeline/dispatch.mjs --max 3    # override concurrency cap (default 2)
//
// SAFETY: dry-run is the default and executes NOTHING — no relabel, no worktree,
// no worker. A real run requires the explicit `--go` flag.
//
// RE-ENTRANT by design (the standing watcher calls this on a loop):
//   - only OPEN issues labeled `agent-ready` are considered
//   - issues already `agent:in-progress` are skipped
//   - capacity = MAX_CONCURRENT minus issues currently in-progress
//   - worktree/branch creation is existence-checked first (no double-create)

import { readFileSync } from "node:fs";
import {
  REPO, MASTER, STAGING_BRANCH, LABELS, DEFAULT_MAX_CONCURRENT,
  LOGS_DIR, WORKER_PROMPT_PATH,
  gh, act, parseArgv, slugify,
  thisWorktreeRoot, worktreePathFor, worktreeExists, branchExists, launchWorker,
} from "./lib.mjs";
import { join } from "node:path";

const { flags, options } = parseArgv(process.argv.slice(2));
const dryRun = !flags.has("go"); // dry-run unless --go
const maxConcurrent = Number(options.get("max") ?? DEFAULT_MAX_CONCURRENT);

console.log(`\n=== Dispatch — repo ${REPO}${dryRun ? "  (DRY-RUN — no actions executed)" : "  (LIVE — --go)"} ===`);
console.log(`    staging base: ${STAGING_BRANCH}   |   max concurrent: ${maxConcurrent}\n`);

// 1) Eligible = OPEN issues labeled agent-ready
const eligible = gh([
  "issue", "list", "--repo", REPO, "--state", "open",
  "--label", LABELS.ready.name,
  "--json", "number,title,labels",
], { json: true });

// 2) Current in-flight = OPEN issues labeled agent:in-progress
const inFlight = gh([
  "issue", "list", "--repo", REPO, "--state", "open",
  "--label", LABELS.inProgress.name,
  "--json", "number",
], { json: true });

console.log(`Found ${eligible.length} agent-ready issue(s); ${inFlight.length} already in-flight.`);

let capacity = maxConcurrent - inFlight.length;
if (capacity <= 0) {
  console.log(`At capacity (${inFlight.length}/${maxConcurrent} in flight). Nothing to dispatch.\n`);
  process.exit(0);
}
if (eligible.length === 0) {
  console.log("No agent-ready issues. Nothing to do.\n");
  process.exit(0);
}

const promptTemplate = readFileSync(WORKER_PROMPT_PATH, "utf8");
const gitCwd = thisWorktreeRoot(); // shared refs; never touches the main working tree
let dispatched = 0;

for (const issue of eligible) {
  if (capacity <= 0) {
    console.log(`\nCapacity reached (${maxConcurrent}). Remaining issues wait for the next pass.`);
    break;
  }
  const labelNames = (issue.labels || []).map((l) => l.name);
  if (labelNames.includes(LABELS.inProgress.name)) {
    console.log(`\n#${issue.number}: already in-progress — skip.`);
    continue;
  }

  const slug = slugify(issue.title);
  const branch = `agent/${issue.number}-${slug}`;
  const wtPath = worktreePathFor(issue.number);
  const logPath = join(LOGS_DIR, `${issue.number}.log`);

  console.log(`\n#${issue.number} — "${issue.title}"`);
  console.log(`    branch:   ${branch}`);
  console.log(`    worktree: ${wtPath}`);
  console.log(`    log:      ${logPath}`);

  // a) claim: relabel ready -> in-progress
  act({
    dryRun,
    label: `claim #${issue.number}: ${LABELS.ready.name} -> ${LABELS.inProgress.name}`,
    cmd: [
      "gh", "issue", "edit", String(issue.number), "--repo", REPO,
      "--remove-label", LABELS.ready.name,
      "--add-label", LABELS.inProgress.name,
    ],
  });

  // b) worktree off fresh origin/master (existence-checked)
  if (worktreeExists(wtPath) || branchExists(branch)) {
    console.log(`    [SKIP create] worktree or branch already exists — reusing.`);
  } else {
    act({ dryRun, label: "fetch origin master", cmd: ["git", "fetch", "origin", MASTER], cwd: gitCwd });
    act({
      dryRun,
      label: `add worktree on new branch ${branch}`,
      cmd: ["git", "worktree", "add", "-b", branch, wtPath, `origin/${MASTER}`],
      cwd: gitCwd,
    });
  }

  // c) launch headless worker (real mode only)
  const promptText = promptTemplate
    .replaceAll("{{REPO}}", REPO)
    .replaceAll("{{NUM}}", String(issue.number))
    .replaceAll("{{TITLE}}", issue.title)
    .replaceAll("{{BRANCH}}", branch)
    .replaceAll("{{WORKTREE}}", wtPath)
    .replaceAll("{{BASE}}", STAGING_BRANCH);

  if (dryRun) {
    console.log(`  [DRY-RUN] would launch worker`);
    console.log(`            $ claude -p "<worker prompt for #${issue.number}, base ${STAGING_BRANCH}>" --permission-mode acceptEdits`);
    console.log(`            (cwd: ${wtPath}, log -> ${logPath})`);
  } else {
    const pid = launchWorker({ cwd: wtPath, promptText, logPath });
    console.log(`  [EXEC] launched worker pid ${pid} (cwd: ${wtPath}, log -> ${logPath})`);
  }

  capacity--;
  dispatched++;
}

console.log(
  `\n=== ${dryRun ? "DRY-RUN complete — nothing was executed" : `dispatched ${dispatched} worker(s)`} ===\n`,
);
