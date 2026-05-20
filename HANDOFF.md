# Handoff — Claude Code Companion

> Written 2026-05-20 on the Linux box. Target for continued production: macOS.
> Read this top to bottom once, then start at "Continue on macOS".

## 1. The vision

Claude Code generates gorgeous static HTML status docs (plans, "where we are / next steps", reviews).
They're read-only. The idea: make them **interactive and session-aware**.

Concretely, the companion should let you:

1. **Check off next-steps** — toggle a task complete; state persists.
2. **Click an item and ask a follow-up about it** — without leaving the surface, ask Claude a question
   scoped to that specific task, and get the answer in your normal Claude flow.
3. **Stay session-aware** — the surface reflects what the live Claude Code session is doing, and Claude
   can update the surface (tick a box) as it finishes work.

The mental model: a focus cockpit you keep open alongside a sea of terminals.

The first real content is the **AI-agency status board** (`prototype/status-board.html`) — the strategy,
the four demos, blockers, security flags, and a dependency-ordered next-steps timeline. That doc is the
visual template; the production app generalizes the shell so any future artifact plugs in.

## 2. The decision journey (so you don't re-litigate it)

We compared three ways to "interface with the session". Summary of why we landed where we did:

### Option A — tmux bridge (`capture-pane` read + `send-keys` write)
- **Read** the session via `tmux capture-pane -p` or control mode (`tmux -CC`, the iTerm2 protocol).
- **Write** into the live TUI via `tmux send-keys` — the *only* mechanism that can inject a **real user
  turn** into a running, even idle, session.
- **Killer drawback:** requires running Claude Code inside tmux, per-user pane wiring, terminal-only.
  Does not work in Claude Desktop / web. Not distributable.

### Option B — plain MCP server
- Bidirectional data (Claude calls tools; UI writes to the server). Clean, per-session, distributable.
- **The hard limit:** an MCP server **cannot spontaneously start a model turn.** A question dropped in
  the UI sits until Claude next calls an "inbox" tool, or is answered out-of-band via **sampling**
  (Claude Code sampling support unconfirmed — verify if you go this route). Elicitation (server→user
  input) is supported in Claude Code v2.1.76+ but is the wrong direction for "user asks the session".

### Option C — MCP Apps  ✅ CHOSEN
- The Jan-2026 standard (joint **Anthropic + OpenAI + mcp-ui community**; `@modelcontextprotocol/ext-apps`).
- An MCP **tool** declares a UI resource (`_meta.ui.resourceUri`, `ui://` scheme); the host fetches the
  HTML and renders it **in-chat in a sandboxed iframe**, wired bidirectionally over `postMessage`.
- The UI can `app.callServerTool()`, `app.updateModelContext()`, and receive tool results
  (`app.ontoolresult`). This is exactly the "interactive HTML wired to the session" we wanted — as a
  standard, not a hack.
- **Why it wins:** clean install, per-session binding, structured data, works across graphical clients,
  and there's an official `create-mcp-app` scaffolding skill.

### The catch that forces the Mac
- **MCP Apps do NOT render in the terminal CLI** (can't render an iframe). Supported hosts: claude.ai
  web, Claude Desktop, VS Code Copilot, Goose, Postman, MCPJam.
- **No Claude Desktop on Linux.** So real use = **claude.ai web** (or Claude Desktop on the Mac).
- Net: develop/see it on the Mac. Offline iteration is possible anywhere via the `basic-host` renderer.

## 3. What's in this repo

```
claude-code-companion/
├── README.md                     # overview + status
├── HANDOFF.md                    # this file
├── .gitignore                    # node + companion-app/state.json
├── prototype/
│   └── status-board.html         # the static visual prototype (reference look)
└── companion-app/                # WORKING MCP App scaffold (built + smoke-tested on Linux)
    ├── package.json              # build: vite singlefile; serve: tsx server.ts
    ├── tsconfig.json
    ├── vite.config.ts            # vite-plugin-singlefile (bundles UI to one HTML)
    ├── board.json                # board content + tasks (the agency next-steps)
    ├── server.ts                 # MCP server: 4 tools + ui:// resource, StreamableHTTP /mcp
    ├── mcp-app.html              # UI shell + styles (from the prototype look)
    └── src/mcp-app.ts            # UI logic (App class, checkboxes, ask-back)
```

`companion-app/` is a **working scaffold**: `npm run typecheck` clean, `npm run build` produces a
260KB self-contained `dist/mcp-app.html`, and the MCP server passed an end-to-end smoke test (lists 4
tools; `show_status_board` returns the board payload with `_meta["ui/resourceUri"]`; `set_task_status`
toggles + persists; `record_question` queues). What's left is rendering it in a real graphical client.

## 4. Production build plan (MCP Apps)

### 4.0 IMPORTANT: published `ext-apps@0.1.0` differs from the build-guide docs
The `companion-app/` code already accounts for this; note it before changing things:
- **No `@modelcontextprotocol/ext-apps/server` export.** There are no `registerAppTool` /
  `registerAppResource` helpers. Register tools/resources **directly on the MCP SDK** (`McpServer`),
  and set the MCP Apps metadata by hand:
  - UI-bearing tool result carries `_meta["ui/resourceUri"] = "ui://..."`
  - the UI resource is served with `mimeType: "text/html;profile=mcp-app"`
- **Ask-back uses `app.sendMessage({ role: "user", content: [{ type:"text", text }] })`** — this sends
  a real user message to the model. (The docs' `updateModelContext` is not how 0.1.0 does it.)
- **UI connects with a transport:** `await app.connect(new PostMessageTransport(window.parent))`.
- `callServerTool({ name, arguments })` and the `ontoolresult` setter work as expected.

### 4.1 Scaffold (already done; or regenerate via the skill)
`companion-app/` is already scaffolded and working. If you'd rather regenerate from the official skill:

```
/plugin marketplace add modelcontextprotocol/ext-apps
/plugin install mcp-apps@modelcontextprotocol-ext-apps
```

### 4.2 Manual structure (if you prefer to understand it)
```
companion-app/
├── package.json        # "type":"module"; build: INPUT=mcp-app.html vite build; serve: npx tsx server.ts
├── tsconfig.json       # ES2022 / ESNext / bundler
├── vite.config.ts      # vite-plugin-singlefile (bundle UI+assets into one HTML)
├── server.ts           # MCP server: registerAppTool + registerAppResource, StreamableHTTP transport
├── mcp-app.html        # UI entry (adapt prototype/status-board.html)
└── src/mcp-app.ts      # UI logic using the App class
```

Dependencies:
```bash
npm install @modelcontextprotocol/ext-apps @modelcontextprotocol/sdk
npm install -D typescript vite vite-plugin-singlefile express cors @types/express @types/cors tsx
```

### 4.3 Server (the shape)
- `registerAppTool(server, "show_status_board", { ..., _meta: { ui: { resourceUri } } }, handler)`
  where `resourceUri = "ui://status-board/mcp-app.html"`.
- `registerAppResource(...)` serves the vite-bundled single-file HTML.
- Expose over `StreamableHTTPServerTransport` on an Express `/mcp` route.
- **Port:** the docs example uses 3001 — on the old Linux box codeviz owns 3001; pick a free port
  (e.g. **3009**) to avoid collisions. On the Mac, 3001 is probably free, but keep it configurable.

Tools to expose (so Claude can read + drive the board):
- `show_status_board` — UI-bearing tool; returns current board state.
- `get_board_state` / `set_task_status(id, status)` — checkbox state, persisted to a local `state.json`
  (shared by UI and model so both stay in sync — better than browser-only localStorage).
- The board content (sections, tasks) lives in a JSON the server loads, so future artifacts reuse the shell.

### 4.4 UI (the shape)
- Adapt `prototype/status-board.html` into `mcp-app.html` + `src/mcp-app.ts`.
- `const app = new App({...}); app.connect();`
- `app.ontoolresult = (r) => renderBoard(r)` to paint initial state.
- Checkbox toggle → `app.callServerTool({ name: "set_task_status", arguments: {...} })`.
- **Ask-back:** per-item "Ask about this" composes a contextual question and calls
  `app.updateModelContext({...})` (and/or surfaces the prompt) so Claude answers in the same chat.
  Note: exact turn-triggering is governed by the host; treat "user is in an active chat" as the model.

### 4.5 Test
- **Offline dev (no plan, no internet):** the `basic-host` renderer in the ext-apps repo —
  `git clone https://github.com/modelcontextprotocol/ext-apps.git`,
  `cd ext-apps/examples/basic-host && npm install`,
  `SERVERS='["http://localhost:3009/mcp"]' npm start`, open `http://localhost:8080`.
- **Real client (claude.ai web / Claude Desktop on Mac):** tunnel the local server —
  `npx cloudflared tunnel --url http://localhost:3009` — then add the generated HTTPS URL as a
  **custom connector** (Settings → Connectors → Add custom connector). **Requires a paid Claude plan
  (Pro/Max/Team).**

## 5. Continue on macOS

Prereqs on the Mac: Node 18+ (20/22 ideal), `git`, `gh` (optional), a paid Claude plan for the
custom-connector test path.

```bash
git clone https://github.com/mrgyatso/claude-code-companion.git
cd claude-code-companion

# see the target look
open prototype/status-board.html

# run the working scaffold
cd companion-app
npm install
npm run build           # bundles UI -> dist/mcp-app.html
PORT=3009 npm run serve # MCP server on http://localhost:3009/mcp

# in another terminal, render it in the offline test host:
git clone https://github.com/modelcontextprotocol/ext-apps.git
cd ext-apps/examples/basic-host && npm install
SERVERS='["http://localhost:3009/mcp"]' npm start   # open http://localhost:8080

# then for a real client: npx cloudflared tunnel --url http://localhost:3009
#   add the HTTPS URL as a custom connector in claude.ai (paid plan), call "show status board"
```

First milestone on the Mac: see `show_status_board` render in `basic-host`, toggle a checkbox, click
**Ask** on a task and confirm the question lands in the conversation (that exercises `sendMessage`).
Then wire the live session-transcript feed if you want the read-side mirror (tail the session JSONL).

## 6. Open questions / decisions deferred
- Confirm whether this Claude Code/clients build supports MCP **sampling** (affects out-of-band ask-back).
- Decide board content source: hardcoded JSON vs generated per-artifact by Claude.
- Generalize the shell now vs after the agency board works end-to-end (recommend: make it work first).
- Naming: repo is `claude-code-companion`; rename if a better product name lands.

## 7. Notes
- GitHub: `gh` on the Linux box is authenticated as account `zach-fau`; repos resolve under `mrgyatso`
  (account rename). Confirm the final repo URL printed at creation time.
- The prototype was authored to a personal house style (navy/coral, no em-dashes). Keep that voice.
- Source of the agency content this board summarizes: the personal wiki at `~/wiki/` (not in this repo).
