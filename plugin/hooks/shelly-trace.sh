# shelly-trace.sh — sourced by the Shelly shell hooks. Defines trace().
#
# Usage (in a hook):
#   CMP_HOOK_DIR=$(cd "$(dirname "$0")" && pwd)
#   . "$CMP_HOOK_DIR/shelly-trace.sh"
#   trace hook fire "corr=$fp" "sid=$sid"
#
# trace() is a CHEAP no-op (an env test + one file stat, no node spawn) whenever
# the harness is off, so it is safe to leave in the hot path of every PostToolUse /
# SessionStart hook — which fire on every tool call in every session. A node spawn
# (for the ms clock + JSON encode) happens ONLY when tracing is enabled.
#
# Enabled iff SHELLY_TRACE=1 OR the flag file ~/.shelly/logs/trace.on
# exists — the same condition every other layer checks. `touch` it to turn on.
#
# LOG STRUCTURED FIELDS ONLY — never the raw hook stdin (it carries the whole
# artifact HTML) or env (secrets). Paths, ids, units, decision branches only.

_CMP_TRACE_CJS="${CMP_HOOK_DIR:-$(CDPATH= cd "$(dirname "$0")" 2>/dev/null && pwd)}/shelly-trace.cjs"
_CMP_TRACE_FLAG="${HOME}/.shelly/logs/trace.on"

shelly_trace_on() {
  [ "$SHELLY_TRACE" = "1" ] && return 0
  [ -f "$_CMP_TRACE_FLAG" ] && return 0
  return 1
}

# trace <layer> <evt> [k=v ...] — append one NDJSON event (only when enabled).
trace() {
  shelly_trace_on || return 0
  node "$_CMP_TRACE_CJS" "$@" 2>/dev/null || true
}
