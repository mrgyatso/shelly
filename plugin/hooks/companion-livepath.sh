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
# UNIT identity (for the Board's per-unit home): a unit is the PROJECT DIRECTORY,
# so sessions in one folder (repo or not) share a project home/artifacts/rail
# group, with the rail switching between the folder's sessions. is_repo is still
# reported (worktree-isolation decisions + display):
#   is_repo  = 1 when the session runs inside a git repo, else 0
#   unit_key = <slug>  always (the project dir — sessions in it share one unit)
# Two agents in one folder share a unit; use a git worktree when they must not edit
# the same files.

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

# Unit identity: a session belongs to its PROJECT DIRECTORY (unit_key = slug),
# repo or not — so every session in one folder shares one unit (home, artifacts,
# rail group) and the rail switches between that folder's sessions. (Non-repo dirs
# used to be keyed per-session as slug--shortid, which cloned a fresh unit per new
# session in the same folder; the Board now groups non-repo dirs by slug too, so we
# stamp the bare slug to match — keeping the home path + closed-session fallbacks
# right.) The Board derives this from the source regardless; the stamp is the
# authoritative copy for closed sessions and the per-unit home filename.
unit_key="$slug"

live_path="${HOME}/.claude/companion/live/${slug}--${shortid}.json"
printf '%s\t%s\t%s\t%s\t%s\n' "$live_path" "$project" "$shortid" "$is_repo" "$unit_key"
