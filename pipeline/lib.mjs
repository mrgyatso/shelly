// Shared helpers for the agent-issue pipeline (dispatch / consolidate / setup).
//
// Design notes:
//  - Everything shells out to `gh` and `git`; we parse `--json` output natively.
//  - Scripts default to DRY-RUN. Real side effects run only under an explicit
//    `--go` (dispatch/consolidate merge) or `--i-verified` (promote) flag.
//  - `act()` is the single choke point for side effects: in dry-run it prints
//    the exact command it WOULD run and executes nothing; in real mode it runs
//    it and prints the result. This makes the dry-run guarantee auditable.

import { spawnSync, spawn } from "node:child_process";
import { existsSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REPO = "mrgyatso/shelly";
export const MASTER = "master";
export const STAGING_BRANCH = "integration/agents";

// Label lifecycle: agent-ready -> agent:in-progress -> agent:needs-verify
export const LABELS = {
  ready: {
    name: "agent-ready",
    color: "2ea043", // green — "go": eligible for auto-dispatch
    description: "Eligible for autonomous agent dispatch",
  },
  inProgress: {
    name: "agent:in-progress",
    color: "dbab09", // amber — a worker has claimed it
    description: "A worker agent has claimed this issue (worktree + PR in flight)",
  },
  needsVerify: {
    name: "agent:needs-verify",
    color: "d93f0b", // orange — needs a human before it can reach master
    description: "Worker opened a PR into integration/agents; awaiting human verify",
  },
};

// Max worker agents in flight at once (issues currently agent:in-progress).
export const DEFAULT_MAX_CONCURRENT = 2;

// Directory (inside this repo checkout) where per-issue worker logs land.
const __dirname = dirname(fileURLToPath(import.meta.url));
export const PIPELINE_DIR = __dirname;
export const LOGS_DIR = join(PIPELINE_DIR, "logs");
export const WORKER_PROMPT_PATH = join(PIPELINE_DIR, "worker-prompt.md");

// ---------------------------------------------------------------------------
// Repo geometry — derive the MAIN worktree (never hardcode a user path).
// The shared .git lives at `<main-repo>/.git`; git-common-dir points at it.
// New per-issue worktrees are created as siblings of the main checkout.
// ---------------------------------------------------------------------------

export function mainRepoRoot() {
  const commonDir = git(["rev-parse", "--git-common-dir"]).stdout.trim();
  // commonDir is e.g. /Users/x/shelly/.git  (or a bare path)
  return resolve(dirname(commonDir));
}

// The worktree this script is invoked from (this pipeline branch's checkout).
// Git ref ops (branch/fetch/push/worktree-add) run here — worktrees share the
// object store + refs, so this is equivalent to running in the main checkout
// but never touches the main working tree (where other agents may be active).
export function thisWorktreeRoot() {
  return git(["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function worktreeParent() {
  return dirname(mainRepoRoot());
}

export function worktreePathFor(num) {
  return join(worktreeParent(), `shelly-${num}`);
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

// Run a command synchronously, capturing output. Never throws on non-zero;
// callers decide how to react. `cwd` optional.
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd: opts.cwd,
    input: opts.input,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: r.status ?? (r.error ? 1 : 0),
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error,
  };
}

export function git(args, opts = {}) {
  return run("git", args, opts);
}

// `gh` wrapper. When {json:true}, parse stdout as JSON (returns [] on failure).
export function gh(args, opts = {}) {
  const r = run("gh", args, { cwd: opts.cwd, input: opts.input });
  if (opts.json) {
    if (r.code !== 0) {
      throw new Error(`gh ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
    }
    try {
      return JSON.parse(r.stdout || "null");
    } catch (e) {
      throw new Error(`gh ${args.join(" ")} returned non-JSON:\n${r.stdout}`);
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// Dry-run choke point
// ---------------------------------------------------------------------------

// Execute a side-effecting command, or print what it WOULD do in dry-run.
//   act({ dryRun, label, cmd:["gh",...], cwd })
// Returns the run() result in real mode, or a synthetic {dryRun:true} in dry.
export function act({ dryRun, label, cmd, cwd }) {
  const printable = cmd.map(quoteArg).join(" ");
  if (dryRun) {
    console.log(`  [DRY-RUN] would ${label}`);
    console.log(`            $ ${printable}${cwd ? `   (cwd: ${cwd})` : ""}`);
    return { dryRun: true, code: 0, stdout: "", stderr: "" };
  }
  console.log(`  [EXEC] ${label}`);
  console.log(`         $ ${printable}${cwd ? `   (cwd: ${cwd})` : ""}`);
  const [bin, ...rest] = cmd;
  const r = run(bin, rest, { cwd });
  if (r.code !== 0) {
    console.log(`         ! exit ${r.code}: ${(r.stderr || r.stdout).trim()}`);
  }
  return r;
}

function quoteArg(a) {
  return /[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a;
}

// ---------------------------------------------------------------------------
// Detached worker launch (real mode only) — never called in dry-run.
// ---------------------------------------------------------------------------

export function launchWorker({ cwd, promptText, logPath }) {
  const out = openSync(logPath, "a");
  const child = spawn(
    "claude",
    ["-p", promptText, "--permission-mode", "acceptEdits"],
    { cwd, detached: true, stdio: ["ignore", out, out] },
  );
  child.unref();
  return child.pid;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

// Minimal flag parser: returns { flags:Set, options:Map, positionals:[] }.
export function parseArgv(argv) {
  const flags = new Set();
  const options = new Map();
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        options.set(a.slice(2, eq), a.slice(eq + 1));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        // treat `--max 3` as an option, but keep bare flags as flags
        const key = a.slice(2);
        if (key === "max") options.set(key, argv[++i]);
        else flags.add(key);
      } else {
        flags.add(a.slice(2));
      }
    } else {
      positionals.push(a);
    }
  }
  return { flags, options, positionals };
}

export function worktreeExists(path) {
  if (existsSync(path)) return true;
  const list = git(["worktree", "list", "--porcelain"]).stdout;
  return list.split("\n").some((l) => l === `worktree ${path}`);
}

export function branchExists(branch) {
  // local or remote-tracking
  const local = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (local.code === 0) return true;
  const remote = git([
    "ls-remote",
    "--heads",
    "origin",
    branch,
  ]).stdout.trim();
  return remote.length > 0;
}
