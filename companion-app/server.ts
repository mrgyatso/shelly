// MCP App server: serves an interactive, session-aware status board.
//
// Targets @modelcontextprotocol/ext-apps@0.1.0, which does NOT ship server
// helpers — so we register tools/resources directly on the MCP SDK and set the
// MCP Apps metadata by hand:
//   - UI-bearing tool results carry _meta["ui/resourceUri"] = "ui://..."
//   - the UI resource is served with mimeType "text/html;profile=mcp-app"
//
// Task status + follow-up questions persist to state.json so the UI and the
// model stay in sync across reloads.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";

// MCP Apps constants (mirrors ext-apps exports; redeclared to avoid pulling the
// browser-side App module into the server bundle).
const RESOURCE_URI_META_KEY = "ui/resourceUri";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

const PORT = Number(process.env.PORT ?? 3009);
const DIR = import.meta.dirname;
const BOARD_PATH = path.join(DIR, "board.json");
const STATE_PATH = path.join(DIR, "state.json");
const UI_PATH = path.join(DIR, "dist", "mcp-app.html");

const resourceUri = "ui://status-board/mcp-app.html";

type Item = { id: string; text: string };
type Group = { id: string; phase: string; label: string; current?: boolean; items: Item[] };
type Board = {
  title: string;
  updated: string;
  subtitle: string;
  meta: { label: string; value: string }[];
  groups: Group[];
  callout: { tag: string; title: string; lines: string[] };
};
type Question = { id: string; taskId: string; question: string; at: string };
type State = { statuses: Record<string, boolean>; questions: Question[] };

async function readJson<T>(p: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(p, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

const loadBoard = () => readJson<Board>(BOARD_PATH, {} as Board);
const loadState = () => readJson<State>(STATE_PATH, { statuses: {}, questions: [] });
const saveState = (s: State) => fs.writeFile(STATE_PATH, JSON.stringify(s, null, 2), "utf-8");

// The single payload the UI renders from: board content + current task statuses.
async function boardPayload() {
  const [board, state] = await Promise.all([loadBoard(), loadState()]);
  return { board, statuses: state.statuses, questions: state.questions };
}

const asResult = (data: unknown, meta?: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  ...(meta ? { _meta: meta } : {}),
});

const server = new McpServer({ name: "Claude Code Companion", version: "0.1.0" });

// UI-bearing tool: rendering this in a graphical client shows the board.
// The host renders the ui:// resource named in the result's _meta.
server.registerTool(
  "show_status_board",
  {
    title: "Show Status Board",
    description:
      "Display the interactive AI-agency status board (checkable next-steps + per-item follow-up).",
    inputSchema: {},
    _meta: { [RESOURCE_URI_META_KEY]: resourceUri },
  },
  async () => asResult(await boardPayload(), { [RESOURCE_URI_META_KEY]: resourceUri }),
);

// Read board state (for the model, e.g. to report progress).
server.registerTool(
  "get_board",
  {
    title: "Get Board State",
    description: "Return board content, current task statuses, and queued follow-up questions.",
    inputSchema: {},
  },
  async () => asResult(await boardPayload()),
);

// Toggle a task. Called by the UI checkbox and usable by the model as it works.
server.registerTool(
  "set_task_status",
  {
    title: "Set Task Status",
    description: "Mark a task done or not-done by its id. Persists across reloads.",
    inputSchema: { id: z.string(), done: z.boolean() },
  },
  async ({ id, done }) => {
    const state = await loadState();
    state.statuses[id] = done;
    await saveState(state);
    return asResult(await boardPayload());
  },
);

// Record a follow-up question raised from the UI for a specific task.
server.registerTool(
  "record_question",
  {
    title: "Record Follow-up Question",
    description:
      "Queue a follow-up question scoped to a task id. The UI calls this when the user asks about an item.",
    inputSchema: { taskId: z.string(), question: z.string() },
  },
  async ({ taskId, question }) => {
    const state = await loadState();
    state.questions.push({
      id: `q_${Date.now()}`,
      taskId,
      question,
      at: new Date().toISOString(),
    });
    await saveState(state);
    return asResult(await boardPayload());
  },
);

// Serve the vite-bundled single-file UI as the ui:// resource.
server.registerResource(
  "status-board-ui",
  resourceUri,
  { mimeType: RESOURCE_MIME_TYPE },
  async () => {
    const html = await fs.readFile(UI_PATH, "utf-8");
    return { contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }] };
  },
);

const app = express();
app.use(cors());
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`Companion MCP server on http://localhost:${PORT}/mcp`);
});
