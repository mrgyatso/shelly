import { App } from "@modelcontextprotocol/ext-apps";

// ── Board types (mirror of the server's board.ts) ──
interface Task { id: string; text: string; done?: boolean }
interface TaskGroup { id: string; when: string; label: string; now?: boolean; tasks: Task[]; doneCount?: number }
type Section =
  | { type: "info"; num: number; title: string; sub: string; rows: { k: string; v: string; ok: boolean }[] }
  | { type: "cards"; num: number; title: string; sub: string; cards: Record<string, string>[] }
  | { type: "blockers"; num: number; title: string; sub: string; items: { title: string; sev: string; desc: string }[] }
  | { type: "note"; num: number; title: string; sub: string; body: string }
  | { type: "tasks"; num: number; title: string; sub: string; groups: TaskGroup[] }
  | { type: "callout"; num: number; title: string; sub: string; heading: string; badge?: string; paras: string[] };
interface Board {
  id: string; eyebrow: string; title: string; lede: string;
  meta: { label: string; value: string }[]; sections: Section[];
}

const app = new App({ name: "status-board", version: "0.1.0" });
const root = document.getElementById("root")!;
const toastEl = document.getElementById("toast")!;

// ── small DOM helpers (textContent everywhere — no innerHTML, no injection) ──
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

let toastTimer: number | undefined;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 2200);
}

/** Pull the Board out of any CallToolResult (ontoolresult or callServerTool). */
function extractBoard(result: unknown): Board | null {
  const r = result as { structuredContent?: { board?: Board }; content?: { type: string; text?: string }[] };
  if (r?.structuredContent?.board) return r.structuredContent.board;
  const text = r?.content?.find((c) => c.type === "text")?.text;
  if (text) {
    try { return (JSON.parse(text) as { board?: Board }).board ?? null; } catch { /* ignore */ }
  }
  return null;
}

// ── section renderers ──
function sectionHead(num: number, title: string, sub: string): HTMLElement {
  const head = el("div", "sec-head");
  head.appendChild(el("span", "sec-num", String(num)));
  const txt = el("div");
  txt.appendChild(el("h2", undefined, title));
  txt.appendChild(el("p", "sec-sub", sub));
  head.appendChild(txt);
  return head;
}

function renderInfo(s: Extract<Section, { type: "info" }>): HTMLElement {
  const card = el("div", "card locked");
  for (const row of s.rows) {
    const r = el("div", "row");
    r.appendChild(el("div", "k", row.k));
    const v = el("div", "v");
    v.appendChild(el("span", row.ok ? "lk" : "pending", row.ok ? "✓ " : "° "));
    v.appendChild(document.createTextNode(row.v));
    r.appendChild(v);
    card.appendChild(r);
  }
  return card;
}

function renderCards(s: Extract<Section, { type: "cards" }>): HTMLElement {
  const grid = el("div", "grid g2");
  for (const c of s.cards) {
    const card = el("div", `card demo d-${c.status}`);
    const top = el("div", "top");
    const left = el("div");
    left.appendChild(el("h3", undefined, c.title));
    left.appendChild(el("div", "persona", c.persona));
    top.appendChild(left);
    top.appendChild(el("span", `pill p-${c.status}`, c.statusLabel));
    card.appendChild(top);
    card.appendChild(el("div", "mech", c.mech));
    card.appendChild(el("div", "foot", c.foot));
    grid.appendChild(card);
  }
  return grid;
}

function renderBlockers(s: Extract<Section, { type: "blockers" }>): HTMLElement {
  const box = el("div", "blockers");
  box.appendChild(el("div", "bhead", "⚠ Resolve these to unblock launch"));
  const ol = el("ol");
  for (const it of s.items) {
    const li = el("li");
    const bt = el("div", "bt");
    bt.appendChild(document.createTextNode(it.title + " "));
    bt.appendChild(el("span", `sev ${it.sev}`, it.sev === "hi" ? "High" : "Med"));
    li.appendChild(bt);
    li.appendChild(el("div", "bd", it.desc));
    ol.appendChild(li);
  }
  box.appendChild(ol);
  return box;
}

function renderNote(s: Extract<Section, { type: "note" }>): HTMLElement {
  const card = el("div", "card secnote");
  const idx = s.body.indexOf(".");
  card.appendChild(el("b", undefined, s.body.slice(0, idx + 1) + " "));
  card.appendChild(document.createTextNode(s.body.slice(idx + 1).trim()));
  return card;
}

function renderCallout(s: Extract<Section, { type: "callout" }>): HTMLElement {
  const box = el("div", "callout");
  const h = el("h3");
  h.appendChild(document.createTextNode(s.heading + " "));
  if (s.badge) h.appendChild(el("span", "new", s.badge));
  box.appendChild(h);
  for (const p of s.paras) box.appendChild(el("p", undefined, p));
  return box;
}

function renderTasks(s: Extract<Section, { type: "tasks" }>): HTMLElement {
  const card = el("div", "card");
  card.setAttribute("style", "padding:26px 26px 26px 22px");
  const tl = el("div", "timeline");
  for (const g of s.groups) {
    const step = el("div", g.now ? "tstep now" : "tstep");
    step.appendChild(el("span", "twin", g.when));
    const label = el("div", "tlabel");
    label.appendChild(document.createTextNode(g.label));
    label.appendChild(el("span", "tcount", `${g.doneCount ?? 0}/${g.tasks.length}`));
    step.appendChild(label);

    const ul = el("ul", "tasks");
    for (const t of g.tasks) {
      const li = el("li", t.done ? "done" : undefined);

      const cb = el("input", "cbox") as HTMLInputElement;
      cb.type = "checkbox";
      cb.checked = !!t.done;
      cb.addEventListener("change", () => toggleTask(t.id, cb.checked));

      const text = el("span", "ttext", t.text);
      text.addEventListener("click", () => { cb.checked = !cb.checked; toggleTask(t.id, cb.checked); });

      const ask = el("button", "ask", "Ask");
      ask.addEventListener("click", () => askAbout(t));

      li.appendChild(cb);
      li.appendChild(text);
      li.appendChild(ask);
      ul.appendChild(li);
    }
    step.appendChild(ul);
    tl.appendChild(step);
  }
  card.appendChild(tl);
  return card;
}

function render(board: Board) {
  root.replaceChildren();

  const hero = el("header", "hero");
  const hw = el("div", "wrap");
  hw.appendChild(el("p", "eyebrow", board.eyebrow));
  hw.appendChild(el("h1", undefined, board.title));
  hw.appendChild(el("p", "lede", board.lede));
  const meta = el("div", "meta");
  for (const m of board.meta) {
    const chip = el("span", "chip");
    chip.appendChild(document.createTextNode(m.label + " "));
    chip.appendChild(el("b", undefined, m.value));
    meta.appendChild(chip);
  }
  hw.appendChild(meta);
  hero.appendChild(hw);
  root.appendChild(hero);

  const body = el("div", "wrap");
  for (const s of board.sections) {
    const sec = el("section");
    sec.appendChild(sectionHead(s.num, s.title, s.sub));
    if (s.type === "info") sec.appendChild(renderInfo(s));
    else if (s.type === "cards") sec.appendChild(renderCards(s));
    else if (s.type === "blockers") sec.appendChild(renderBlockers(s));
    else if (s.type === "note") sec.appendChild(renderNote(s));
    else if (s.type === "tasks") sec.appendChild(renderTasks(s));
    else if (s.type === "callout") sec.appendChild(renderCallout(s));
    body.appendChild(sec);
  }
  root.appendChild(body);
}

// ── actions wired to the session ──
async function toggleTask(taskId: string, done: boolean) {
  try {
    const res = await app.callServerTool({ name: "set_task_status", arguments: { taskId, done } });
    const board = extractBoard(res);
    if (board) render(board);
    toast(done ? "Marked done" : "Marked not done");
  } catch (e) {
    toast("Could not update task");
    console.error(e);
  }
}

async function askAbout(task: Task) {
  try {
    await app.sendMessage({
      content: [{
        type: "text",
        text: `About this next-step on the status board: "${task.text}". ` +
          `What's the best way to approach it, and is there anything I should watch out for?`,
      }],
    });
    toast("Asked Claude about this item");
  } catch (e) {
    toast("Could not send to chat");
    console.error(e);
  }
}

// ── boot ──
app.ontoolresult = (params) => {
  const board = extractBoard(params);
  if (board) render(board);
};

async function boot() {
  await app.connect();
  // Reliable initial paint even if the show-tool result arrived before connect.
  try {
    const res = await app.callServerTool({ name: "get_board", arguments: {} });
    const board = extractBoard(res);
    if (board) render(board);
  } catch (e) {
    console.error("initial get_board failed", e);
  }
}

boot();
