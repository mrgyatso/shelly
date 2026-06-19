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
# UNIT identity (for the Board's per-session home): every session is its OWN unit,
# so its artifacts, board, and home are NEVER shared with another session — even two
# sessions in the same repo. The Board is session-first. is_repo is still reported
# (the Board uses it for worktree-isolation decisions + display), but it no longer
# collapses sessions:
#   is_repo  = 1 when the session runs inside a git repo, else 0
#   unit_key = <slug>--<shortid>  ALWAYS (unique per session)
# Two agents in one repo are two distinct units, each with its own artifact space;
# use a git worktree when they must not edit the same files.

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

# Per-session identity: each session is its own unit (never shared across sessions
# in one repo). is_repo stays reported above for worktree/display, but unit_key is
# always slug--shortid so a 2nd session in the same repo never collapses onto the 1st.
unit_key="${slug}--${shortid}"

live_path="${HOME}/.claude/companion/live/${slug}--${shortid}.json"
printf '%s\t%s\t%s\t%s\t%s\n' "$live_path" "$project" "$shortid" "$is_repo" "$unit_key"
