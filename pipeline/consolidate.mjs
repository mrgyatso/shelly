#!/usr/bin/env node
// Consolidation: the gated auto-merge.
//
//   node pipeline/consolidate.mjs              # DRY-RUN: list mergeable staging PRs, merge nothing
//   node pipeline/consolidate.mjs --go         # merge green needs-verify PRs INTO integration/agents
//   node pipeline/consolidate.mjs promote      # print the human-gated master promotion plan
//   node pipeline/consolidate.mjs promote --i-verified   # open the integration/agents -> master PR
//
// Two clearly-separated steps:
//   1. merge  (automatable) — fold green `agent:needs-verify` PRs that target
//      integration/agents INTO integration/agents. Never touches master.
//   2. promote (human-only) — get integration/agents onto master. Because master
//      is PR-protected, this OPENS a PR integration/agents -> master and hands the
//      final merge click to the human. It NEVER merges master itself.
//
// "Consolidatable" = the PR is mergeable AND has no FAILING check. (CI here only
// runs on push-to-master, so staging PRs usually have no checks at all — that's
// eligible, not a blocker. Pending checks -> skip this pass.)

import {
  REPO, MASTER, STAGING_BRANCH, LABELS,
  gh, act, parseArgv,
} from "./lib.mjs";

const { flags, positionals } = parseArgv(process.argv.slice(2));
const subcommand = positionals[0] ?? "merge";

if (subcommand === "promote") {
  promote({ verified: flags.has("i-verified") });
} else {
  mergeStaging({ dryRun: !flags.has("go") });
}

// ---------------------------------------------------------------------------
// Step 1 — merge green needs-verify PRs into integration/agents
// ---------------------------------------------------------------------------
function mergeStaging({ dryRun }) {
  console.log(`\n=== Consolidate into ${STAGING_BRANCH}${dryRun ? "  (DRY-RUN)" : "  (LIVE — --go)"} ===\n`);

  // All open PRs whose base is the staging branch.
  const prs = gh([
    "pr", "list", "--repo", REPO,
    "--base", STAGING_BRANCH, "--state", "open",
    "--json", "number,title,labels,mergeable,mergeStateStatus,statusCheckRollup,headRefName",
  ], { json: true });

  if (prs.length === 0) {
    console.log(`No open PRs targeting ${STAGING_BRANCH}. Nothing to consolidate.\n`);
    return;
  }

  for (const pr of prs) {
    const labels = (pr.labels || []).map((l) => l.name);
    const hasNeedsVerify = labels.includes(LABELS.needsVerify.name);
    const checks = pr.statusCheckRollup || [];
    const failing = checks.filter((c) =>
      ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(
        c.conclusion || c.state,
      ),
    );
    const pending = checks.filter((c) =>
      ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED"].includes(c.status || c.state),
    );
    const mergeable = pr.mergeable === "MERGEABLE";

    console.log(`PR #${pr.number} — "${pr.title}"  [${pr.headRefName}]`);
    console.log(`    needs-verify:${hasNeedsVerify}  mergeable:${pr.mergeable}  state:${pr.mergeStateStatus}  checks:${checks.length} (fail:${failing.length} pending:${pending.length})`);

    const reasons = [];
    if (!hasNeedsVerify) reasons.push(`missing '${LABELS.needsVerify.name}' label`);
    if (!mergeable) reasons.push(`not mergeable (${pr.mergeable})`);
    if (failing.length) reasons.push(`${failing.length} failing check(s)`);
    if (pending.length) reasons.push(`${pending.length} pending check(s) — wait`);

    if (reasons.length) {
      console.log(`    SKIP: ${reasons.join("; ")}\n`);
      continue;
    }

    act({
      dryRun,
      label: `merge PR #${pr.number} into ${STAGING_BRANCH}`,
      cmd: ["gh", "pr", "merge", String(pr.number), "--repo", REPO, "--merge"],
    });
    console.log();
  }

  console.log(`=== ${dryRun ? "DRY-RUN complete — nothing merged" : "consolidation pass complete"} ===`);
  console.log(`Note: merging into ${STAGING_BRANCH} does NOT close the issues or reach master.`);
  console.log(`When you've verified staging, run:  node pipeline/consolidate.mjs promote\n`);
}

// ---------------------------------------------------------------------------
// Step 2 — human-gated promotion to master
// ---------------------------------------------------------------------------
function promote({ verified }) {
  console.log(`\n=== Promote ${STAGING_BRANCH} -> ${MASTER}  (HUMAN-GATED) ===\n`);
  console.log(`master is PR-protected. Promotion = open a PR ${STAGING_BRANCH} -> ${MASTER},`);
  console.log(`then a human reviews and clicks merge. This script NEVER merges master.\n`);

  const title = `chore: promote ${STAGING_BRANCH} to ${MASTER}`;
  const body = `Consolidated agent work verified on ${STAGING_BRANCH}. Promoting to ${MASTER}.`;

  if (!verified) {
    console.log("No action taken (need --i-verified). Exact commands for the human:\n");
    console.log(`  # 1. open the promotion PR`);
    console.log(`  gh pr create --repo ${REPO} --base ${MASTER} --head ${STAGING_BRANCH} \\`);
    console.log(`    --title ${JSON.stringify(title)} --body ${JSON.stringify(body)}`);
    console.log(`\n  # 2. after reviewing the PR on GitHub, YOU merge it:`);
    console.log(`  gh pr merge <PR#> --repo ${REPO} --merge\n`);
    return;
  }

  console.log("--i-verified given: opening the promotion PR (still NOT merging master).\n");
  const r = gh([
    "pr", "create", "--repo", REPO,
    "--base", MASTER, "--head", STAGING_BRANCH,
    "--title", title, "--body", body,
  ]);
  console.log((r.stdout || "").trim() || (r.stderr || "").trim());
  console.log(`\nReview the PR above, then MERGE IT YOURSELF (the final human action):`);
  console.log(`  gh pr merge <PR#> --repo ${REPO} --merge\n`);
}
