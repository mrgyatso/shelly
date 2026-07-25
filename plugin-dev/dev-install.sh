#!/usr/bin/env bash
# dev-install.sh — run the plugin straight out of THIS working tree, live.
#
#   bash plugin-dev/dev-install.sh           # switch to the branch plugin
#   bash plugin-dev/dev-install.sh --sync    # push your latest edits into it  ← the dev loop
#   bash plugin-dev/dev-install.sh --status  # what is active right now
#   bash plugin-dev/dev-install.sh --off     # switch back to the released one
#
# After either switch: START A NEW `claude` SESSION. Sessions load their plugin at startup,
# so anything already running is untouched — which is deliberate, and means you can flip this
# without disturbing work in flight.
#
# ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────────────────
# Testing a plugin change used to mean hand-editing ~/.claude/plugins/installed_plugins.json
# and copying directories into a version-keyed cache. That is (a) fiddly, (b) something a
# coding agent is rightly blocked from doing, since it rewrites the harness's own config, and
# (c) wrong twice over, because of two traps that cost real time:
#
#   TRAP 1 — the marketplace NAME is a global key.
#     `claude plugin marketplace add <this-repo>` overwrites the existing `shelly` entry and
#     silently repoints your REAL plugin source at a feature branch. `--scope project` does
#     NOT save you: it writes a project declaration AND still clobbers the global one.
#     Fixed here by giving this marketplace a different name (`shelly-dev`), so the branch
#     installs as `shelly@shelly-dev` ALONGSIDE `shelly@shelly` and the two never collide.
#     The release is then just disabled, with a native verb, and re-enabled on the way out.
#
#   TRAP 2 — `claude plugin update` is VERSION-GATED.
#     Edit a hook, run update, and it answers "already at the latest version (0.10.0)" and
#     copies NOTHING. A naive dev loop therefore needs a version bump per iteration, which is
#     the single biggest reason this has always felt like a struggle. `--sync` sidesteps it by
#     re-copying the tree directly over the install path, so the loop is:
#
#         edit → bash plugin-dev/dev-install.sh --sync → start a new claude session
#
#     (A symlink from the install path to the worktree WOULD be live with no sync step, and it
#     works — the hooks resolve through it fine. It was the first thing tried here and it is
#     not safe: Claude Code owns that cache directory and sweeps it, and the link was gone
#     within a minute. A plain copy survives, so a copy is what this uses.)
#
# Everything below uses documented `claude plugin` verbs plus one directory copy. No editing
# of installed_plugins.json, which is both fragile and something an agent is rightly blocked
# from doing — that block is what prompted this script.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # <repo>/plugin-dev
REPO="$(cd "$HERE/.." && pwd)"
DEV_MARKET="shelly-dev"
REL_ID="shelly@shelly"
DEV_ID="shelly@shelly-dev"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  \033[2m·\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mdev-install.sh: %s\033[0m\n' "$*" >&2; exit 1; }

plugin_version() {  # <repo>/plugin/.claude-plugin/plugin.json → version
  python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" \
    "$REPO/plugin/.claude-plugin/plugin.json"
}

installed_path() {  # $1 = plugin id → its installPath, or empty
  python3 - "$1" <<'PY'
import json, pathlib, sys
p = pathlib.Path.home() / ".claude/plugins/installed_plugins.json"
try:
    d = json.loads(p.read_text())
except Exception:
    raise SystemExit(0)
e = d.get("plugins", {}).get(sys.argv[1])
print(e[0]["installPath"] if e else "")
PY
}

# ------------------------------------------------------------------ status
if [ "${1:-}" = "--status" ]; then
  bold "Plugin status"
  claude plugin list 2>/dev/null | grep -A3 -i "shelly" || info "no shelly plugin installed"
  dev_path="$(installed_path "$DEV_ID")"
  if [ -n "$dev_path" ] && [ -d "$dev_path" ]; then
    # Is the installed copy in step with the worktree? Compare the hook tree, since that is
    # what actually runs. `diff -rq` is enough and needs nothing installed.
    if diff -rq -x __tests__ "$REPO/plugin/hooks" "$dev_path/hooks" >/dev/null 2>&1; then
      ok "installed copy is IN SYNC with $REPO/plugin"
    else
      warn "installed copy is STALE — run: bash plugin-dev/dev-install.sh --sync"
      diff -rq -x __tests__ "$REPO/plugin/hooks" "$dev_path/hooks" 2>/dev/null | head -8 | sed 's/^/      /'
    fi
  fi
  exit 0
fi

# ------------------------------------------------------------------ sync (the dev loop)
if [ "${1:-}" = "--sync" ]; then
  dev_path="$(installed_path "$DEV_ID")"
  [ -n "$dev_path" ] || die "$DEV_ID is not installed — run this script with no arguments first"
  bold "Pushing $REPO/plugin into the dev install"
  rm -rf "$dev_path"
  mkdir -p "$dev_path"
  cp -R "$REPO/plugin/." "$dev_path/"
  rm -rf "$dev_path/hooks/__tests__"   # not part of the shipped surface
  [ -f "$dev_path/hooks/frame/frame-core.html" ] || die "frame asset missing after sync"
  ok "synced → $dev_path"
  # Single-quoted deliberately: backticks inside a double-quoted string are command
  # substitution, so the friendly version of this line actually RAN `claude plugin update`.
  info 'claude plugin update cannot do this: it is version-gated and would no-op (TRAP 2).'
  bold "Start a NEW claude session to pick it up."
  exit 0
fi

# ------------------------------------------------------------------ off
if [ "${1:-}" = "--off" ]; then
  bold "Switching back to the released plugin"
  claude plugin enable "$REL_ID" >/dev/null 2>&1 && ok "re-enabled $REL_ID" \
    || warn "could not enable $REL_ID (already enabled?)"
  claude plugin uninstall "$DEV_ID" >/dev/null 2>&1 && ok "uninstalled $DEV_ID" \
    || warn "could not uninstall $DEV_ID (not installed?)"
  claude plugin marketplace remove "$DEV_MARKET" >/dev/null 2>&1 && ok "removed the $DEV_MARKET marketplace" \
    || warn "could not remove the $DEV_MARKET marketplace"
  bold "Start a NEW claude session to pick it up."
  exit 0
fi

# ------------------------------------------------------------------ on
VERSION="$(plugin_version)"

bold "1 · Is this tree green?"
info "the point of checking first is that a broken plugin breaks every new session"
( cd "$REPO/overlay" && npx tsc --noEmit ) || die "tsc failed — not switching"
( cd "$REPO/overlay" && npm run --silent lint ) || die "eslint failed — not switching"
( cd "$REPO/overlay" && npm test >/tmp/shelly-dev-suite.log 2>&1 ) \
  || { tail -25 /tmp/shelly-dev-suite.log; die "test suite failed — not switching"; }
ok "suite green (full log: /tmp/shelly-dev-suite.log)"

bold "2 · Registering the dev marketplace"
# A DIFFERENT name from the real one — see TRAP 1. This cannot touch `shelly`.
claude plugin validate "$HERE" >/dev/null || die "the dev marketplace manifest is invalid"
claude plugin marketplace add "$HERE" >/dev/null
ok "$DEV_MARKET → $HERE"
info "your real 'shelly' marketplace is untouched:"
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / ".claude/plugins/known_marketplaces.json"
d = json.loads(p.read_text())
src = d.get("shelly", {}).get("source", {})
print("      shelly →", src.get("path") or src.get("repo") or src)
PY

bold "3 · Installing the branch alongside the release"
claude plugin install "$DEV_ID" >/dev/null
claude plugin disable "$REL_ID" >/dev/null 2>&1 || true
ok "installed $DEV_ID (v$VERSION), disabled $REL_ID"

bold "4 · Syncing this tree into it"
DEV_PATH="$(installed_path "$DEV_ID")"
[ -n "$DEV_PATH" ] || die "could not read the dev install path back"
rm -rf "$DEV_PATH"
mkdir -p "$DEV_PATH"
cp -R "$REPO/plugin/." "$DEV_PATH/"
rm -rf "$DEV_PATH/hooks/__tests__"
[ -f "$DEV_PATH/hooks/frame/frame-core.html" ] || die "frame asset missing after sync"
ok "synced → $DEV_PATH"

cat <<EOF

$(bold "Active: the plugin from $REPO")
  THE DEV LOOP, after any edit under plugin/:

      bash plugin-dev/dev-install.sh --sync     &&  start a new claude session

  Running sessions keep the plugin they loaded, so this never disturbs work in flight.

  bash plugin-dev/dev-install.sh --status    in sync? what is active?
  bash plugin-dev/dev-install.sh --off       back to the released plugin
EOF
