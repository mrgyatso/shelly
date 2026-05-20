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
├── .gitignore                    # node
└── prototype/
    └── status-board.html         # the static visual prototype (becomes the MCP App UI basis)
```

No server/app code yet — that's the production work below.

## 4. Production build plan (MCP Apps)

### 4.1 Scaffold (fastest path)
The official skill scaffolds server + UI + config. In Claude Code on the Mac:

```
/plugin marketplace add modelcontextprotocol/ext-apps
/plugin install mcp-apps@modelcontextprotocol-ext-apps
```

Then: "Create an MCP App that renders a status board with checkable tasks and a per-item ask button."

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
git clone https://github.com/<owner>/claude-code-companion.git
cd claude-code-companion

# open the prototype to see the target look
open prototype/status-board.html

# scaffold the MCP App (see §4.1) or create companion-app/ manually (see §4.2)
# build the UI from prototype/status-board.html, wire the tools, then:
#   cd companion-app && npm install && npm run build && npm run serve
# test offline with basic-host (§4.5), then tunnel + custom connector for claude.ai
```

Suggested first commit on the Mac: scaffold `companion-app/` and get `show_status_board` rendering the
prototype in `basic-host`. Then layer `set_task_status` persistence, then the ask-back.

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
