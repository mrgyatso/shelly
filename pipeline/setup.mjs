#!/usr/bin/env node
// One-time (idempotent) infrastructure for the agent-issue pipeline:
//   1. create the 3 lifecycle labels
//   2. create + push the `integration/agents` staging branch off master
//   3. protect `master` so nothing reaches it without a PR (the human gate)
//
// Safe to re-run. Every step checks current state first. Unlike dispatch /
// consolidate, this is infra provisioning and runs for real by default — pass
// `--dry-run` to preview. Nothing here touches master's CONTENTS; protection
// only constrains how commits get IN (via PR).
//
// Usage:
//   node pipeline/setup.mjs            # provision (idempotent)
//   node pipeline/setup.mjs --dry-run  # preview only
//   node pipeline/setup.mjs --unprotect  # REMOVE master protection (reversal)

import {
  REPO,
  MASTER,
  STAGING_BRANCH,
  LABELS,
  gh,
  act,
  parseArgv,
  branchExists,
  thisWorktreeRoot,
} from "./lib.mjs";

const { flags } = parseArgv(process.argv.slice(2));
const dryRun = flags.has("dry-run");

if (flags.has("unprotect")) {
  await unprotectMaster();
  process.exit(0);
}

console.log(`\n=== Pipeline setup — repo ${REPO}${dryRun ? "  (DRY-RUN)" : ""} ===\n`);
ensureLabels();
ensureStagingBranch();
await protectMaster();
console.log("\n=== setup complete ===\n");

// ---------------------------------------------------------------------------

function ensureLabels() {
  console.log("1) Labels");
  const existing = new Set(
    gh(["label", "list", "--repo", REPO, "--json", "name"], { json: true }).map(
      (l) => l.name,
    ),
  );
  for (const key of Object.keys(LABELS)) {
    const { name, color, description } = LABELS[key];
    if (existing.has(name)) {
      console.log(`  ok   label '${name}' already exists`);
      continue;
    }
    act({
      dryRun,
      label: `create label '${name}'`,
      cmd: [
        "gh", "label", "create", name,
        "--repo", REPO,
        "--color", color,
        "--description", description,
      ],
    });
  }
}

function ensureStagingBranch() {
  console.log("\n2) Staging branch");
  if (branchExists(STAGING_BRANCH)) {
    console.log(`  ok   '${STAGING_BRANCH}' already exists (local or origin)`);
    return;
  }
  const cwd = thisWorktreeRoot();
  // Fetch fresh master, create the staging branch ref off origin/master, push it.
  // Run from this worktree (shared refs) — never touches the main working tree.
  act({ dryRun, label: "fetch origin master", cmd: ["git", "fetch", "origin", MASTER], cwd });
  act({
    dryRun,
    label: `create '${STAGING_BRANCH}' off origin/${MASTER}`,
    cmd: ["git", "branch", STAGING_BRANCH, `origin/${MASTER}`],
    cwd,
  });
  act({
    dryRun,
    label: `push '${STAGING_BRANCH}' to origin`,
    cmd: ["git", "push", "-u", "origin", STAGING_BRANCH],
    cwd,
  });
}

async function protectMaster() {
  console.log("\n3) Master branch protection (the human gate)");
  // Require a PR to land on master; enforce even for admins so the gate is real.
  // No required status checks (CI only runs on push-to-master, not on PRs).
  // `restrictions` MUST be null on a user-owned repo (push allow-lists are org-only).
  const body = {
    required_status_checks: null,
    enforce_admins: true,
    required_pull_request_reviews: {
      required_approving_review_count: 0,
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
    },
    restrictions: null,
  };

  if (dryRun) {
    console.log("  [DRY-RUN] would PUT branch protection (require PR, enforce_admins):");
    console.log("            " + JSON.stringify(body));
    console.log(`            $ gh api -X PUT repos/${REPO}/branches/${MASTER}/protection --input -`);
    return;
  }

  console.log("  [EXEC] PUT master branch protection");
  const r = gh(
    ["api", "-X", "PUT", `repos/${REPO}/branches/${MASTER}/protection`, "--input", "-"],
    { input: JSON.stringify(body) },
  );
  if (r.code === 0) {
    console.log("  ok — master now requires a PR (enforce_admins:true). Reversal:");
    console.log("       node pipeline/setup.mjs --unprotect");
  } else {
    // Do NOT fail the build — the procedural gate in the README still applies.
    console.log(`  WARN — could not set protection (exit ${r.code}):`);
    console.log("        " + (r.stderr || r.stdout).trim());
    console.log("  Falling back to the PROCEDURAL gate documented in pipeline/README.md.");
  }
}

async function unprotectMaster() {
  console.log(`\n=== Removing master protection on ${REPO} ===`);
  const r = gh([
    "api", "-X", "DELETE", `repos/${REPO}/branches/${MASTER}/protection`,
  ]);
  console.log((r.stdout || "") + (r.stderr || ""));
  console.log(r.code === 0 ? "  ok — master is now unprotected" : "  (see message above)");
}
