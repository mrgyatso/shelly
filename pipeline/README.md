# Agent issue pipeline

Autonomous **GitHub issue → per-issue worktree → gated staging merge → human-gated master**.

You queue feature issues and label the ones you want automated. Each eligible issue
gets a headless worker agent in its own git worktree. The worker implements + tests
the fix and opens a PR into a **staging** branch (`integration/agents`). **Nothing
reaches `master` until you verify and promote it.**

```
  ┌─ you label an issue  agent-ready
  │
  ▼
  dispatch.mjs ──(claim)──►  agent:in-progress
  │  • git worktree add  ../shelly-<num>  on  agent/<num>-<slug>  (off origin/master)
  │  • launch headless worker:  claude -p "<brief>" --permission-mode acceptEdits
  ▼
  worker agent (solve-issue discipline)
  │  • implement + test, surgically
  │  • gh pr create --base integration/agents      ◄── PR targets STAGING, never master
  │  • relabel issue  agent:needs-verify  and stop
  ▼
  consolidate.mjs ──(auto, gated on green)──►  merge PR into  integration/agents
  │
  ▼
  ── HUMAN VERIFIES integration/agents ──
  │
  ▼
  consolidate.mjs promote  ──►  opens PR  integration/agents → master
                                └─ YOU review + click merge   ◄── the only path to master
```

## Label lifecycle

| Label | Color | Meaning | Set by |
|---|---|---|---|
| `agent-ready` | green `#2ea043` | eligible for auto-dispatch | **you** (queue it) |
| `agent:in-progress` | amber `#dbab09` | a worker has claimed it (worktree + PR in flight) | `dispatch.mjs` |
| `agent:needs-verify` | orange `#d93f0b` | worker opened its staging PR; awaiting human | the worker |

Only **you** apply `agent-ready`. The scripts move a claimed issue through the rest.

## Scripts

All scripts live in `pipeline/` and are Node ESM (`.mjs`, Node ≥ 18). They shell out
to `gh` and `git`. **Every script that mutates state defaults to dry-run.**

### `setup.mjs` — one-time infrastructure (idempotent)

```sh
node pipeline/setup.mjs --dry-run   # preview
node pipeline/setup.mjs             # provision: labels + integration/agents + master protection
node pipeline/setup.mjs --unprotect # REMOVE master protection (reversal)
```

Creates the 3 labels, the `integration/agents` staging branch (off `origin/master`,
pushed), and master branch protection. Safe to re-run — each step checks first.

### `dispatch.mjs` — issue → worktree → worker

```sh
node pipeline/dispatch.mjs          # DRY-RUN (default): print planned actions, do NOTHING
node pipeline/dispatch.mjs --go     # LIVE: really dispatch
node pipeline/dispatch.mjs --max 3  # override concurrency cap (default 2)
```

For each open `agent-ready` issue (up to the concurrency cap):
1. relabels `agent-ready → agent:in-progress` (claim),
2. `git worktree add ../shelly-<num>` on `agent/<num>-<slug>` off fresh `origin/master`,
3. launches a headless worker: `claude -p "<worker prompt>" --permission-mode acceptEdits`,
   logging to `pipeline/logs/<num>.log`.

**Re-entrant** (safe to loop): considers only *open* `agent-ready` issues, skips ones
already `agent:in-progress`, existence-checks the worktree/branch before creating, and
caps in-flight work at `--max` (default 2) by counting current `agent:in-progress` issues.

The worker brief is `pipeline/worker-prompt.md` — it folds in the `solve-issue` skill,
pins the PR base to `integration/agents`, forbids touching master, forbids spawning
further workers, and authorizes the autonomous staging PR (the gated-safe step).

### `consolidate.mjs` — the gated auto-merge + human promotion

```sh
node pipeline/consolidate.mjs               # DRY-RUN: list mergeable staging PRs, merge nothing
node pipeline/consolidate.mjs --go          # merge green needs-verify PRs INTO integration/agents
node pipeline/consolidate.mjs promote                # print the human master-promotion plan
node pipeline/consolidate.mjs promote --i-verified   # open the integration/agents → master PR
```

- **merge** (automatable): folds open PRs that target `integration/agents`, carry the
  `agent:needs-verify` label, are **mergeable**, and have **no failing check** into
  `integration/agents`. Pending checks → skipped this pass. It never touches master, and
  merging into staging does **not** close the issues or reach master.
- **promote** (human-only): because master is PR-protected, promotion *opens a PR*
  `integration/agents → master`; the final merge is your click. Without `--i-verified`
  it only prints the exact commands. **This script never merges master itself.**

> **What "green" means here.** The only CI (`cask-smoketest.yml`) runs on *push to
> master* and `workflow_dispatch` — **not** on PRs and **not** on `integration/agents`.
> So staging PRs usually have **no checks at all**, which counts as consolidatable
> (mergeable + nothing failing). Do not add a required-named-check filter that would
> never match. If you later add PR-triggered CI, `statusCheckRollup` will pick it up.

## Master branch protection (the human gate)

`setup.mjs` sets, via `gh api PUT .../branches/master/protection`:

- `enforce_admins: true` — **even admins** (the automation runs as you, an admin) must
  go through a PR. Without this the gate is theater: an admin can still push master.
- `required_pull_request_reviews.required_approving_review_count: 0` — a PR is *required*
  (no direct pushes) but a second approver is **not**, so a solo operator can't deadlock.
- `required_status_checks: null` — CI doesn't run on PRs here (see above).
- `restrictions: null` — push allow-lists are **org-only**; this repo is user-owned, so
  a non-null value would 422.

**Blast radius:** this locks `master` for *all* contributors and other agents — direct
`git push origin master` is now rejected; everything lands via PR. That is the intended
gate. Remove it any time:

```sh
node pipeline/setup.mjs --unprotect
# or:  gh api -X DELETE repos/mrgyatso/shelly/branches/master/protection
```

If the `gh api` PUT is ever rejected (plan/permission change), setup does **not** fail —
it warns and falls back to the *procedural* gate: **only ever reach master via
`consolidate.mjs promote` + a human merge; never `git push origin master`.**

## Standing watcher (build-ready, OFF by default)

A watcher just runs `dispatch.mjs --go` on an interval. **It is not enabled** — turning
it on starts continuous unattended agent spawning. Two ways to enable, both deliberate:

**Option A — launchd (survives logout).** Template: `pipeline/com.shelly.agent-dispatch.plist`
(fix the two absolute paths inside first).

```sh
cp pipeline/com.shelly.agent-dispatch.plist ~/Library/LaunchAgents/
launchctl load  ~/Library/LaunchAgents/com.shelly.agent-dispatch.plist   # ENABLE
launchctl unload ~/Library/LaunchAgents/com.shelly.agent-dispatch.plist  # DISABLE
```

**Option B — a `/loop` in a Claude session** (ephemeral, dies with the session):

```
/loop 5m node pipeline/dispatch.mjs --go
```

## First real run (do this once before enabling the watcher)

`--permission-mode acceptEdits` auto-accepts file edits but **may still prompt on
Bash/`gh`/`git`** in a headless `-p` run — which would hang a worker. This can't be
validated dry, so verify it live once:

1. Label one small, well-scoped issue `agent-ready`.
2. `node pipeline/dispatch.mjs --go`
3. `tail -f pipeline/logs/<num>.log` — confirm the worker runs commands without stalling
   on a permission prompt, opens a PR into `integration/agents`, and relabels
   `agent:needs-verify`. If it stalls, widen the worker's permissions (e.g. an
   `allowedTools`/settings allowlist for `gh`/`git`, or `--dangerously-skip-permissions`
   in a sandboxed environment only) and retry.
4. `node pipeline/consolidate.mjs` (dry) → `--go` once you've eyeballed the PR.

## What stays gated behind a human "go"

Nothing autonomous is running yet. These require a deliberate human action:

- **Activating the standing watcher** — `launchctl load …` (Option A) or `/loop` (B).
- **The first real dispatch** — `dispatch.mjs --go` (default is dry-run).
- **Consolidating into staging** — `consolidate.mjs --go` (default is dry-run).
- **Promoting to master** — `consolidate.mjs promote` prints the plan; `--i-verified`
  opens the PR; **you** merge it. Master is never mutated by any script.
