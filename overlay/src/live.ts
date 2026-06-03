// The always-on "live" surface: a single persistent pane reflecting the current
// state of the work — what we're on (`working`), where we are (`where`), and the
// next decisions (`next`) — read from the active per-session file under
// ~/.claude/companion/live/ (newest-wins; see live.rs). Each session writes its
// own file, and a `project` label tells the user whose work the pane reflects.
// The agent rewrites its file each turn; this shell polls `read_live` and
// re-renders in place behind a soft cross-fade, so updates never pop a new
// window. Loaded lazily by main.ts only on the `live_main` window
// (window.__LIVE_MODE__).
//
// This is the ephemeral "where are we" tier — substantive turns still snapshot a
// full artifact into the history HUD separately. The `next` items are
// interactive: mark each ✓ do / ✎ note / ✗ skip and Submit to batch the
// decisions to the clipboard, the same one-paste loop as review artifacts.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

interface NextItem {
  title: string;
  sub?: string;
  /** Free-form tag shown as a chip, e.g. "decision" | "todo" | "blocked". */
  kind?: string;
}

interface LiveState {
  working?: string;
  where?: string[];
  next?: NextItem[];
  /** Display name of the session/project this surface reflects (cwd basename). */
  project?: string;
}

type Action = "approve" | "comment" | "reject";

/** How often to re-read the live file. It's tiny; a calm cadence is plenty. */
const POLL_MS = 1200;
/** Cross-fade duration for a content swap. Matches the CSS opacity transition. */
const FADE_MS = 180;

const win = getCurrentWebviewWindow();
let lastRaw = "";
let currentWorking = "";

export function initLive(): void {
  const root = document.getElementById("live");
  const frame = document.getElementById("frame");
  const empty = document.getElementById("empty");
  if (!root) return;

  frame?.setAttribute("hidden", "");
  empty?.setAttribute("hidden", "");
  root.removeAttribute("hidden");

  document.getElementById("live-close")?.addEventListener("click", () => {
    win.hide().catch((e) => console.error("hide failed", e));
  });

  wireFooter();

  void tick();
  window.setInterval(() => void tick(), POLL_MS);
}

async function tick(): Promise<void> {
  let raw = "";
  try {
    raw = await invoke<string>("read_live");
  } catch (e) {
    console.error("read_live failed", e);
    return;
  }
  if (raw === lastRaw) return; // unchanged — leave the pane (and any in-progress marks) untouched
  lastRaw = raw;
  render(raw);
}

/** Set the header project label (quiet — hidden when empty via :empty CSS). */
function setProject(name: string): void {
  const el = document.getElementById("live-project");
  if (el) el.textContent = name;
}

/** Swap the body content behind a soft opacity cross-fade, then run `after`
 *  (footer toggle + count) once the new content is in place. */
function swapBody(content: Node | string, after?: () => void): void {
  const body = document.getElementById("live-body");
  if (!body) return;
  body.classList.add("fading");
  window.setTimeout(() => {
    if (typeof content === "string") body.innerHTML = content;
    else body.replaceChildren(content);
    after?.();
    body.classList.remove("fading");
  }, FADE_MS);
}

function render(raw: string): void {
  const foot = document.getElementById("live-foot");
  const hideFoot = () => foot?.setAttribute("hidden", "");

  if (!raw.trim()) {
    setProject("");
    swapBody(`<div class="live-idle">Nothing on the surface yet.</div>`, hideFoot);
    return;
  }

  let state: LiveState;
  try {
    state = JSON.parse(raw) as LiveState;
  } catch {
    swapBody(`<div class="live-idle">live state didn't parse.</div>`, hideFoot);
    return;
  }

  setProject(state.project || "");
  currentWorking = state.working || "Live";
  const frag = document.createDocumentFragment();

  if (state.working) {
    const h = document.createElement("h1");
    h.className = "live-working";
    h.textContent = state.working;
    frag.appendChild(h);
  }

  if (state.where?.length) {
    frag.appendChild(sectionLabel("Where we are"));
    const ul = document.createElement("ul");
    ul.className = "live-where";
    for (const line of state.where) {
      const li = document.createElement("li");
      li.textContent = line;
      ul.appendChild(li);
    }
    frag.appendChild(ul);
  }

  const next = state.next ?? [];
  if (next.length) {
    frag.appendChild(sectionLabel("Next"));
    const list = document.createElement("div");
    list.className = "live-next";
    next.forEach((item) => list.appendChild(nextCard(item)));
    frag.appendChild(list);
  }

  swapBody(frag, () => {
    // Footer (the submit bar) only when there are decisions to make.
    if (next.length) foot?.removeAttribute("hidden");
    else hideFoot();
    refresh();
  });
}

function sectionLabel(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "live-section";
  el.textContent = text;
  return el;
}

function nextCard(item: NextItem): HTMLElement {
  const card = document.createElement("div");
  card.className = "live-item";
  card.dataset.label = item.title;

  const row = document.createElement("div");
  row.className = "live-item-row";

  const main = document.createElement("div");
  main.className = "live-item-main";
  const title = document.createElement("div");
  title.className = "live-item-title";
  title.textContent = item.title;
  main.appendChild(title);
  if (item.sub) {
    const sub = document.createElement("div");
    sub.className = "live-item-sub";
    sub.textContent = item.sub;
    main.appendChild(sub);
  }
  row.appendChild(main);

  if (item.kind) {
    const chip = document.createElement("span");
    chip.className = "live-chip";
    chip.textContent = item.kind;
    main.appendChild(chip);
  }

  const actions = document.createElement("div");
  actions.className = "live-actions";
  actions.append(
    actBtn("approve", "✓", "Do it"),
    actBtn("comment", "✎", "Note"),
    actBtn("reject", "✗", "Skip"),
  );
  row.appendChild(actions);
  card.appendChild(row);

  const ta = document.createElement("textarea");
  ta.className = "live-comment";
  ta.placeholder = "What to clarify, or a note…";
  ta.hidden = true;
  card.appendChild(ta);

  return card;
}

function actBtn(action: Action, glyph: string, label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `live-act act-${action}`;
  b.dataset.action = action;
  b.title = label;
  b.textContent = glyph;
  return b;
}

// ---- decisions: state lives on the DOM (data-state per card) ----------------

function wireFooter(): void {
  const body = document.getElementById("live-body");
  body?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
    if (!btn) return;
    const card = btn.closest(".live-item") as HTMLElement | null;
    if (card) setState(card, btn.dataset.action as Action);
  });

  document.getElementById("live-doall")?.addEventListener("click", () => {
    document.querySelectorAll<HTMLElement>(".live-item").forEach((card) => {
      card.dataset.state = "approve";
      const ta = card.querySelector(".live-comment") as HTMLElement | null;
      if (ta) ta.hidden = true;
    });
    refresh();
  });

  document.getElementById("live-submit")?.addEventListener("click", () => void submit());
}

function setState(card: HTMLElement, action: Action): void {
  const ta = card.querySelector(".live-comment") as HTMLTextAreaElement | null;
  if (card.dataset.state === action) {
    delete card.dataset.state;
    if (ta) ta.hidden = true;
  } else {
    card.dataset.state = action;
    if (ta) {
      ta.hidden = action !== "comment";
      if (action === "comment") setTimeout(() => ta.focus(), 0);
    }
  }
  refresh();
}

function marked(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".live-item[data-state]"));
}

function refresh(): void {
  const count = document.getElementById("live-count");
  const submitBtn = document.getElementById("live-submit");
  const n = marked().length;
  if (count) count.textContent = n ? `${n} decision${n !== 1 ? "s" : ""}` : "nothing marked yet";
  submitBtn?.classList.toggle("ready", n > 0);
}

async function submit(): Promise<void> {
  const items = marked();
  const submitBtn = document.getElementById("live-submit");
  if (!items.length) {
    flash(submitBtn, "Mark an item first");
    return;
  }
  const verb: Record<Action, string> = { approve: "✓ Do it:", reject: "✗ Skip:", comment: "✎ Note:" };
  const lines = ["[Companion live]", `Re: ${currentWorking}`, "", "— Decisions —", ""];
  for (const card of items) {
    const state = card.dataset.state as Action;
    lines.push(`${verb[state]} ${card.dataset.label || "(unlabeled)"}`);
    if (state === "comment") {
      const ta = card.querySelector(".live-comment") as HTMLTextAreaElement | null;
      if (ta && ta.value.trim()) ta.value.trim().split("\n").forEach((l) => lines.push(`    ${l}`));
    }
  }
  try {
    await writeText(lines.join("\n"));
    flash(submitBtn, "Copied ✓ — ⌘V to paste");
  } catch (e) {
    console.error("clipboard write failed", e);
    flash(submitBtn, "Copy failed");
  }
}

function flash(btn: HTMLElement | null, msg: string): void {
  if (!btn) return;
  const prev = btn.dataset.label || btn.textContent || "Submit → ⌘V";
  btn.dataset.label = prev;
  btn.textContent = msg;
  window.clearTimeout(Number(btn.dataset.t));
  btn.dataset.t = String(window.setTimeout(() => { btn.textContent = btn.dataset.label || prev; }, 2000));
}
