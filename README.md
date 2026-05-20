# Claude Code Companion

An interactive, **session-aware companion** for Claude Code: turn the beautiful static status docs
Claude generates into living surfaces — checkable next-steps, click-an-item-to-ask-a-follow-up, and a
UI that reflects and drives the live session. The cockpit you keep open in a sea of terminals.

## Status

**Working scaffold.** What exists today:

- `companion-app/` — a working MCP App: 4-tool MCP server + a self-contained UI built from the
  prototype. `npm run typecheck` clean, `npm run build` produces a 260KB single-file `dist/mcp-app.html`,
  and the server passed an end-to-end smoke test (tools list, board payload with the UI `_meta`,
  checkbox toggle + persistence, follow-up queue). Not yet rendered in a real graphical client.
- `prototype/status-board.html` — the polished static board the UI look is modeled on.
- `HANDOFF.md` — full context, the architecture decision, the published-API gotchas, and how to run it.

What's left: render it in a graphical Claude client (claude.ai web on the Mac, or the offline
`basic-host`), then optionally add the live session-transcript feed.

## Chosen architecture: MCP Apps

After comparing **tmux send-keys**, **plain MCP**, and **MCP Apps**, we chose **MCP Apps** — the
Jan-2026 joint Anthropic / OpenAI / mcp-ui standard where an MCP server serves interactive HTML that
renders in-chat in a graphical Claude client, wired bidirectionally to tools.

Read **[HANDOFF.md](./HANDOFF.md)** for the why, the build steps, and how to continue.

## Quick continue (macOS)

```bash
git clone https://github.com/mrgyatso/claude-code-companion.git
cd claude-code-companion/companion-app
npm install && npm run build && PORT=3009 npm run serve
# then render it (HANDOFF.md → "Continue on macOS")
```
