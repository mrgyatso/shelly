// Menu-bar popover — the lightweight roster glance summoned from the status item.
//
// Reuses the shared index.html bundle (window.__POPOVER_MODE__). Renders one row
// per live agent: who needs you, what each is doing, click to open the Board.
// Refreshes on the `popover:refresh` event the Rust side emits on every show.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface LiveSource {
  source: string;
  json: string;
}

interface ParsedState {
  working?: string;
  project?: string;
  next?: { title?: string; kind?: string }[];
  updated_ms?: number;
}

/** A source counts as live while its state file was touched this recently. */
const LIVENESS_MS = 30 * 60 * 1000;

let rootEl: HTMLElement;

export function initPopover(): void {
  const root = document.getElementById("popover");
  if (!root) return;
  rootEl = root;
  // This window only renders the popover — hide the single-artifact chrome.
  for (const id of ["empty", "frame", "controls", "copied-toast"]) {
    document.getElementById(id)?.setAttribute("hidden", "");
  }
  root.removeAttribute("hidden");

  void render();
  // The Rust side emits this on every show (the window persists hidden between
  // opens), so the roster is fresh each time without a persistent poll.
  void listen("popover:refresh", () => void render());
}

function parse(json: string): ParsedState {
  try {
    return JSON.parse(json) as ParsedState;
  } catch {
    return {};
  }
}

function isLive(s: ParsedState, now: number): boolean {
  return s.updated_ms == null || now - s.updated_ms < LIVENESS_MS;
}

function needsYou(s: ParsedState): boolean {
  const kind = s.next?.[0]?.kind;
  return kind === "decision" || kind === "blocked";
}

async function render(): Promise<void> {
  let sources: LiveSource[];
  try {
    sources = await invoke<LiveSource[]>("read_all_live");
  } catch (e) {
    console.error("read_all_live failed", e);
    return;
  }

  const now = Date.now();
  const live = sources
    .map((s) => ({ source: s.source, state: parse(s.json) }))
    .filter((x) => isLive(x.state, now))
    .sort((a, b) => {
      // Needs-you first, then freshest.
      const na = needsYou(a.state) ? 1 : 0;
      const nb = needsYou(b.state) ? 1 : 0;
      if (na !== nb) return nb - na;
      return (b.state.updated_ms ?? 0) - (a.state.updated_ms ?? 0);
    });

  const waiting = live.filter((x) => needsYou(x.state)).length;

  const frag = document.createDocumentFragment();

  const head = document.createElement("div");
  head.className = "pop-head";
  const title = document.createElement("div");
  title.className = "pop-title" + (waiting > 0 ? " waiting" : "");
  title.textContent = waiting > 0 ? `${waiting} need${waiting === 1 ? "s" : ""} you` : "All clear";
  const sub = document.createElement("div");
  sub.className = "pop-sub";
  sub.textContent = `${live.length} agent${live.length === 1 ? "" : "s"} live`;
  head.append(title, sub);
  frag.append(head);

  const list = document.createElement("div");
  list.className = "pop-list";
  if (live.length === 0) {
    const empty = document.createElement("div");
    empty.className = "pop-empty";
    empty.textContent = "No agents connected.";
    list.append(empty);
  } else {
    for (const { source, state } of live) list.append(buildRow(source, state));
  }
  frag.append(list);

  const foot = document.createElement("button");
  foot.className = "pop-open";
  foot.innerHTML = `<span>Open Board</span><span class="pop-arrow">→</span>`;
  foot.addEventListener("click", () => void openBoard());
  frag.append(foot);

  rootEl.replaceChildren(frag);
}

function buildRow(source: string, state: ParsedState): HTMLElement {
  const row = document.createElement("button");
  row.className = "pop-row" + (needsYou(state) ? " needs" : "");
  // Deep-link: land on this session's unit (L2), not the Hub.
  row.addEventListener("click", () => void openBoard(source));

  const dot = document.createElement("span");
  dot.className = "pop-dot";

  const main = document.createElement("div");
  main.className = "pop-row-main";
  const name = document.createElement("div");
  name.className = "pop-name";
  name.textContent = state.project || source;
  const status = document.createElement("div");
  status.className = "pop-status";
  status.textContent = state.working || state.next?.[0]?.title || "working…";
  main.append(name, status);

  row.append(dot, main);
  return row;
}

async function openBoard(target?: string): Promise<void> {
  try {
    await invoke("show_board", target ? { target } : {});
  } catch (e) {
    console.error("show_board failed", e);
  }
  // The Board taking focus would blur-dismiss us anyway; hide immediately so it
  // feels instant.
  try {
    await getCurrentWindow().hide();
  } catch {
    /* ignore */
  }
}
