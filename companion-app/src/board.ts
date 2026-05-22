import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// dist/board.js lives one level under the project root, where board.json and
// the persisted state.json also live.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOARD_PATH = resolve(ROOT, "board.json");
const STATE_PATH = resolve(ROOT, "state.json");

export interface Task {
  id: string;
  text: string;
  done?: boolean; // populated from state at read time
}

export interface TaskGroup {
  id: string;
  when: string;
  label: string;
  now?: boolean;
  tasks: Task[];
  doneCount?: number; // populated at read time
}

export type Section =
  | { type: "info"; num: number; title: string; sub: string; rows: { k: string; v: string; ok: boolean }[] }
  | { type: "cards"; num: number; title: string; sub: string; cards: Record<string, string>[] }
  | { type: "blockers"; num: number; title: string; sub: string; items: { title: string; sev: string; desc: string }[] }
  | { type: "note"; num: number; title: string; sub: string; body: string }
  | { type: "tasks"; num: number; title: string; sub: string; groups: TaskGroup[] }
  | { type: "callout"; num: number; title: string; sub: string; heading: string; badge?: string; paras: string[] };

export interface Board {
  id: string;
  eyebrow: string;
  title: string;
  lede: string;
  meta: { label: string; value: string }[];
  sections: Section[];
}

/** taskId -> done */
type State = Record<string, boolean>;

function loadState(): State {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8")) as State;
  } catch {
    return {};
  }
}

function saveState(state: State): void {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/** Load board.json and merge the persisted checkbox state into its tasks. */
export function getBoard(): Board {
  const board = JSON.parse(readFileSync(BOARD_PATH, "utf-8")) as Board;
  const state = loadState();
  for (const section of board.sections) {
    if (section.type !== "tasks") continue;
    for (const group of section.groups) {
      let done = 0;
      for (const task of group.tasks) {
        task.done = state[task.id] ?? false;
        if (task.done) done++;
      }
      group.doneCount = done;
    }
  }
  return board;
}

/** Returns true if the task id exists in board.json. */
export function isKnownTask(id: string): boolean {
  const board = JSON.parse(readFileSync(BOARD_PATH, "utf-8")) as Board;
  return board.sections.some(
    (s) => s.type === "tasks" && s.groups.some((g) => g.tasks.some((t) => t.id === id)),
  );
}

/** Persist a single task's done flag and return the freshly-merged board. */
export function setTaskStatus(id: string, done: boolean): Board {
  const state = loadState();
  state[id] = done;
  saveState(state);
  return getBoard();
}

/** Flat list of every task with its current done state (handy for the model). */
export function taskSummary(): { id: string; text: string; done: boolean; group: string }[] {
  const board = getBoard();
  const out: { id: string; text: string; done: boolean; group: string }[] = [];
  for (const section of board.sections) {
    if (section.type !== "tasks") continue;
    for (const group of section.groups) {
      for (const task of group.tasks) {
        out.push({ id: task.id, text: task.text, done: !!task.done, group: group.label });
      }
    }
  }
  return out;
}
