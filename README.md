# Claude Code Companion

An interactive, **session-aware companion** for Claude Code: turn the beautiful static status docs
Claude generates into living surfaces — checkable next-steps, click-an-item-to-ask-a-follow-up, and a
UI that reflects and drives the live session. The cockpit you keep open in a sea of terminals.

## Status

**Early seed.** What exists today:

- `prototype/status-board.html` — a polished static HTML status board (the AI-agency "where we are /
  next steps" doc). This is the **visual prototype** the production app is modeled on.
- `HANDOFF.md` — the full context, the architecture decision, and the production build plan.

What does **not** exist yet: the app/server code. That is the production work, to continue on macOS.

## Chosen architecture: MCP Apps

After comparing **tmux send-keys**, **plain MCP**, and **MCP Apps**, we chose **MCP Apps** — the
Jan-2026 joint Anthropic / OpenAI / mcp-ui standard where an MCP server serves interactive HTML that
renders in-chat in a graphical Claude client, wired bidirectionally to tools.

Read **[HANDOFF.md](./HANDOFF.md)** for the why, the build steps, and how to continue.

## Quick continue (macOS)

```bash
git clone https://github.com/<owner>/claude-code-companion.git
cd claude-code-companion
# then follow HANDOFF.md → "Continue on macOS"
```
