// Status-board UI. Renders board content from the server, persists checkbox
// toggles via set_task_status, and raises per-task follow-ups to the model.
import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";

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
type Payload = { board: Board; statuses: Record<string, boolean>; questions: unknown[] };

const $ = (id: string) => document.getElementById(id)!;
const app = new App({ name: "Status Board", version: "0.1.0" });

let board: Board | null = null;

function payloadFrom(result: any): Payload | null {
  // Accept either a CallToolResult ({content}) or a tool-result notification ({result:{content}}).
  const content = result?.content ?? result?.result?.content;
  const text = content?.find((c: any) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as Payload;
  } catch {
    return null;
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

function renderHeader(b: Board) {
  $("h-title").textContent = b.title;
  $("h-sub").textContent = b.subtitle;
  $("h-meta").innerHTML = b.meta
    .map((m) => `<span class="chip">${esc(m.label)} <b>${esc(m.value)}</b></span>`)
    .join("");
}

function renderTasks(b: Board, statuses: Record<string, boolean>) {
  const root = $("tasks-root");
  root.innerHTML = b.groups
    .map((g) => {
      const tasks = g.items
        .map((it) => {
          const done = !!statuses[it.id];
          return `
          <div class="task ${done ? "done" : ""}" data-id="${it.id}">
            <input type="checkbox" ${done ? "checked" : ""} aria-label="toggle ${esc(it.text)}" />
            <span class="txt">${esc(it.text)}</span>
            <button class="ask" type="button">Ask</button>
          </div>`;
        })
        .join("");
      return `
        <div class="tstep ${g.current ? "now" : ""}">
          <span class="twin">${esc(g.phase)}</span>
          <div class="tlabel">${esc(g.label)}</div>
          ${tasks}
        </div>`;
    })
    .join("");

  root.querySelectorAll<HTMLElement>(".task").forEach((row) => {
    const id = row.dataset.id!;
    const cb = row.querySelector<HTMLInputElement>("input")!;
    cb.addEventListener("change", () => void toggle(id, cb.checked));
    row.querySelector<HTMLButtonElement>(".ask")!.addEventListener("click", () => void ask(id));
  });
}

function renderCallout(b: Board) {
  if (!b.callout) return;
  $("callout-section").hidden = false;
  $("callout-root").innerHTML =
    `<h3>${esc(b.callout.title)} <span class="tag">${esc(b.callout.tag)}</span></h3>` +
    b.callout.lines.map((l) => `<p>${esc(l)}</p>`).join("");
}

function renderProgress(b: Board, statuses: Record<string, boolean>) {
  const all = b.groups.flatMap((g) => g.items);
  const done = all.filter((it) => statuses[it.id]).length;
  const pct = all.length ? Math.round((done / all.length) * 100) : 0;
  ($("bar-fill") as HTMLElement).style.width = `${pct}%`;
  $("bar-pct").textContent = `${pct}% · ${done}/${all.length}`;
}

function render(p: Payload) {
  board = p.board;
  renderHeader(p.board);
  renderTasks(p.board, p.statuses);
  renderCallout(p.board);
  renderProgress(p.board, p.statuses);
  $("foot").textContent = `Live · last updated ${p.board.updated}`;
}

async function toggle(id: string, done: boolean) {
  const result = await app.callServerTool({ name: "set_task_status", arguments: { id, done } });
  const p = payloadFrom(result);
  if (p) render(p);
}

async function ask(taskId: string) {
  const text = board?.groups.flatMap((g) => g.items).find((it) => it.id === taskId)?.text ?? taskId;
  const question = window.prompt(`Ask Claude about:\n\n"${text}"`);
  if (!question) return;

  await app.callServerTool({ name: "record_question", arguments: { taskId, question } });

  // Send the follow-up to the model as a real user message in the conversation.
  try {
    await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: `About "${text}": ${question}` }],
    });
    toast("Question sent to Claude");
  } catch {
    toast("Question saved");
  }
}

app.ontoolresult = (params: any) => {
  const p = payloadFrom(params);
  if (p) render(p);
};

async function main() {
  await app.connect(new PostMessageTransport(window.parent));
  // Proactively fetch state in case the host hasn't pushed an initial tool result.
  try {
    const p = payloadFrom(await app.callServerTool({ name: "get_board", arguments: {} }));
    if (p) render(p);
  } catch {
    $("foot").textContent = "Waiting for host…";
  }
}

void main();
