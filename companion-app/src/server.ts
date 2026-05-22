#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { getBoard, setTaskStatus, isKnownTask, taskSummary } from "./board.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UI_HTML_PATH = resolve(ROOT, "ui-dist", "index.html");
const UI_RESOURCE_URI = "ui://status-board/index.html";

/** Read the vite-bundled single-file UI fresh each time so dev rebuilds show up without a restart. */
function readUiHtml(): string {
  try {
    return readFileSync(UI_HTML_PATH, "utf-8");
  } catch {
    return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:24px">
      <h2>UI not built</h2><p>Run <code>npm run build</code> in companion-app, then reopen the board.</p></body>`;
  }
}

/** A short human-readable progress line for the model's text channel. */
function progressLine(): string {
  const tasks = taskSummary();
  const done = tasks.filter((t) => t.done).length;
  return `${done}/${tasks.length} next-step tasks complete.`;
}

const server = new McpServer({ name: "claude-code-companion", version: "0.1.0" });

// ── show_status_board ── the UI-bearing entry tool. Calling it renders the board.
registerAppTool(
  server,
  "show_status_board",
  {
    title: "Show status board",
    description:
      "Open the interactive status board (the AI agency 'where we are / next steps' cockpit). " +
      "Renders checkable next-steps, demo/blocker context, and per-item ask buttons.",
    _meta: { ui: { resourceUri: UI_RESOURCE_URI } },
  },
  async () => {
    const board = getBoard();
    return {
      content: [{ type: "text", text: JSON.stringify({ board }) }],
    };
  },
);

// ── the UI resource itself ──
registerAppResource(
  server,
  "Status Board",
  UI_RESOURCE_URI,
  { description: "Interactive Claude Code companion status board." },
  async () => ({
    contents: [{ uri: UI_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: readUiHtml() }],
  }),
);

// ── get_board ── data tool: current board + state. Called by the UI on load and
// usable by the model to read progress. No UI metadata, so it never spawns a view.
server.registerTool(
  "get_board",
  {
    title: "Get board state",
    description: "Return the current status board JSON including each next-step task's done state.",
  },
  async () => {
    const board = getBoard();
    return {
      content: [{ type: "text", text: JSON.stringify({ board, summary: progressLine() }) }],
    };
  },
);

// ── set_task_status ── data tool: toggle one next-step task. Called by the UI on
// checkbox toggle, and by the model to tick a box as it finishes work.
server.registerTool(
  "set_task_status",
  {
    title: "Set task status",
    description:
      "Mark a next-step task done or not-done by its id. Persists across sessions and updates the board.",
    inputSchema: { taskId: z.string(), done: z.boolean() },
  },
  async ({ taskId, done }) => {
    if (!isKnownTask(taskId)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown task id: ${taskId}` }],
      };
    }
    const board = setTaskStatus(taskId, done);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ board, summary: progressLine(), updated: { taskId, done } }),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
