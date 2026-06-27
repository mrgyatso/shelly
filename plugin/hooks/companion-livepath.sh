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
live_dir="${HOME}/.claude/companion/live"

shortid=$(printf '%.8s' "$session_id" | tr -c 'A-Za-z0-9' '-')
[ -n "$shortid" ] || shortid="nosessid"

# IDENTITY IS FROZEN PER SESSION (session_id is the stable key, NOT the cwd).
# SessionStart fires again on compact/resume, and the cwd may have moved across a
# repo boundary since the session began (e.g. launched from $HOME, then cd'd into a
# repo). Re-deriving the slug from the now-current cwd is exactly what FORKED one
# session into two roster units (slug changed -> a second live file was born). So:
# if this session_id ALREADY has a live file (matched by its --<shortid> suffix),
# REUSE that file's frozen identity verbatim. Only derive fresh on a true first
# start. The slug stays where the session started; it never follows the cwd.
existing=""
for f in "$live_dir"/*--"$shortid".json; do
  [ -f "$f" ] || continue   # POSIX glob stays literal on no-match; -f filters it
  existing="$f"
  break                     # one file per session going forward; first match wins
done

if [ -n "$existing" ]; then
  live_path="$existing"
  stem=$(basename "$existing" .json)
  slug=${stem%--$shortid}
  # Freeze project / is_repo / unit_key from the existing file's JSON (the values
  # chosen at first start); fall back to the slug when the file is unreadable.
  meta=$(LIVE="$existing" node -e 'try{var j=JSON.parse(require("fs").readFileSync(process.env.LIVE,"utf8"))||{};process.stdout.write((j.project||"")+"\t"+(j.is_repo?"1":"0")+"\t"+(j.unit_key||""));}catch(e){process.stdout.write("\t\t");}' 2>/dev/null)
  project=$(printf '%s' "$meta" | cut -f1)
  is_repo=$(printf '%s' "$meta" | cut -f2)
  unit_key=$(printf '%s' "$meta" | cut -f3)
  [ -n "$project" ] || project="$slug"
  [ -n "$is_repo" ] || is_repo=0
  [ -n "$unit_key" ] || unit_key="$slug"
else
  gitroot=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$gitroot" ]; then is_repo=1; root="$gitroot"; else is_repo=0; root="$cwd"; fi
  project=$(basename "$root" 2>/dev/null)
  [ -n "$project" ] || project="session"
  slug=$(printf '%s' "$project" | tr -c 'A-Za-z0-9._-' '-' | sed 's/-\{1,\}/-/g; s/^-//; s/-$//')
  [ -n "$slug" ] || slug="session"
  # Unit identity: a session belongs to its PROJECT DIRECTORY (unit_key = slug),
  # repo or not — so every session that STARTS in one folder shares one unit (home,
  # artifacts, rail group) and the rail switches between that folder's sessions.
  unit_key="$slug"
  live_path="${live_dir}/${slug}--${shortid}.json"
fi

printf '%s\t%s\t%s\t%s\t%s\n' "$live_path" "$project" "$shortid" "$is_repo" "$unit_key"
