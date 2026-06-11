#!/usr/bin/env sh
# companion-livepath.sh — shared derivation of a Companion per-INSTANCE live path.
#
# Usage:  companion-livepath.sh <cwd> <session_id>
# Output: one TAB-separated line:
#   <live_path>\t<project>\t<shortid>\t<is_repo>\t<unit_key>
#
# Instance identity: the live file is keyed by <slug>--<shortid>, where
#   slug    = the git-root (or cwd) basename, sanitized to a filename-safe token
#   shortid = the first 8 chars of the Claude Code session_id
# session_id is stable for a session's lifetime and unique across concurrent
# sessions, so two agents in the SAME repo no longer collide on one file
# (the old <slug>.json scheme was newest-wins). resume/--continue keep the same
# session_id -> same file; /clear gives a new id -> a new instance, which is
# correct. The slug sanitizer collapses runs of '-', so a slug never contains
# '--'; the frontend splits the stem on the first '--' to recover shortid.
#
# UNIT identity (for the Board's per-unit home): the Board groups by UNIT, where
#   is_repo  = 1 when the session runs inside a git repo, else 0
#   unit_key = <slug>            when is_repo=1 (the project — many sessions share it)
#            = <slug>--<shortid> when is_repo=0 (a bare session is its own unit)
# so two agents in one repo collapse to one project home, while two unrelated
# non-repo sessions stay distinct.

cwd="${1:-$(pwd)}"
session_id="$2"

gitroot=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
if [ -n "$gitroot" ]; then is_repo=1; root="$gitroot"; else is_repo=0; root="$cwd"; fi
project=$(basename "$root" 2>/dev/null)
[ -n "$project" ] || project="session"
slug=$(printf '%s' "$project" | tr -c 'A-Za-z0-9._-' '-' | sed 's/-\{1,\}/-/g; s/^-//; s/-$//')
[ -n "$slug" ] || slug="session"

shortid=$(printf '%.8s' "$session_id" | tr -c 'A-Za-z0-9' '-')
[ -n "$shortid" ] || shortid="nosessid"

if [ "$is_repo" = "1" ]; then unit_key="$slug"; else unit_key="${slug}--${shortid}"; fi

live_path="${HOME}/.claude/companion/live/${slug}--${shortid}.json"
printf '%s\t%s\t%s\t%s\t%s\n' "$live_path" "$project" "$shortid" "$is_repo" "$unit_key"
