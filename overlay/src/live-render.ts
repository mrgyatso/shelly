// The working/where/next renderer, extracted from live.ts so the Board's L2 unit
// lanes can render the same surface without duplicating it. PURE: it builds a
// DocumentFragment from a parsed live state and nothing else — no polling, no
// clipboard, no module-global side effects. live.ts imports renderLiveState for
// its body (it keeps its own footer/decision wiring), and board.ts imports it
// (plus nextCard helpers indirectly) to render each lane's body.

export interface NextItem {
  title: string;
  sub?: string;
  /** Free-form tag shown as a chip, e.g. "decision" | "todo" | "blocked". */
  kind?: string;
}

export interface LiveState {
  working?: string;
  where?: string[];
  next?: NextItem[];
  /** Display name of the session/project this surface reflects (cwd basename). */
  project?: string;
}

export type Action = "approve" | "comment" | "reject";

/** Build the working/where/next body for a live state, as a DocumentFragment.
 *  The `next` items are interactive `.live-item` cards (✓/✎/✗ + a hidden note
 *  textarea); the CALLER wires the click handling + submit (live.ts has its own
 *  singleton footer; board.ts delegates per-lane). */
export function renderLiveState(state: LiveState): DocumentFragment {
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

  return frag;
}

export function sectionLabel(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "live-section";
  el.textContent = text;
  return el;
}

export function nextCard(item: NextItem): HTMLElement {
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

export function actBtn(action: Action, glyph: string, label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `live-act act-${action}`;
  b.dataset.action = action;
  b.title = label;
  b.textContent = glyph;
  return b;
}
