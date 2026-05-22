// Smoke test: spawn the stdio server, run the MCP handshake, and exercise the tools.
// Usage: node scripts/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(ROOT, "dist", "server.js")],
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => `${t.name}${t._meta?.["ui/resourceUri"] ? " [ui]" : ""}`).join(", "));

const resources = await client.listResources();
console.log("resources:", resources.resources.map((r) => `${r.name} (${r.uri})`).join(", "));

const show = await client.callTool({ name: "show_status_board", arguments: {} });
const showBoard = JSON.parse(show.content[0].text).board;
console.log("show_status_board → board id:", showBoard.id, "| sections:", showBoard.sections.length);

const res = await client.readResource({ uri: "ui://status-board/index.html" });
console.log("resource mimeType:", res.contents[0].mimeType, "| html bytes:", res.contents[0].text.length);

const before = JSON.parse((await client.callTool({ name: "get_board", arguments: {} })).content[0].text);
console.log("get_board summary:", before.summary);

const setRes = await client.callTool({ name: "set_task_status", arguments: { taskId: "credits-topup", done: true } });
console.log("set_task_status →", JSON.parse(setRes.content[0].text).summary);

const bad = await client.callTool({ name: "set_task_status", arguments: { taskId: "nope", done: true } });
console.log("unknown task isError:", bad.isError, "|", bad.content[0].text);

// reset it back so repeated runs are clean
await client.callTool({ name: "set_task_status", arguments: { taskId: "credits-topup", done: false } });

await client.close();
console.log("OK");
