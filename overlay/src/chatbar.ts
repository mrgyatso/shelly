// The always-on chat bar — permanent Board-shell chrome (styled in board.css as
// `.chatbar`). A claude.ai-style composer docked bottom-center of the stage.
//
// Minimized to a small pill by default so the artifact + terminal keep the
// majority of the space; click it — or land on the idle Home — to expand into a
// composer. Typing STARTS a task (spawn a session + send the first prompt) at the
// Home, or MESSAGES the running session inside a unit. The router (board.ts) owns
// that routing via `onSubmit`; this module owns only the surface and its open/min
// state, so the bar stays decoupled from the router's internals.

export interface ChatBarContext {
  /** True only at the idle L0 Home — drives the default OPEN posture (a working
   *  unit stays minimized so the artifact + terminal keep the space). */
  atHome: boolean;
  /** What a send does right now: "launch" a fresh task, or "message" the live
   *  session in view. (A unit whose terminal the Board doesn't own is "launch" —
   *  there's no PTY to write into, so a send starts a new task instead.) */
  mode: "launch" | "message";
  /** The name of the session a "message" addresses, else null. */
  target: string | null;
  /** The tier the composer should show — the live session's in "message" mode, the
   *  launch pref in "launch" mode. Null when there is nothing honest to name (a
   *  session that hasn't taken a turn yet), which shows as "Model". */
  model: string | null;
  /** Whether a pick can do anything at all right now. False for codex, which has no
   *  model concept here — the picker hides rather than offering a dead control. */
  canPickModel: boolean;
}

/** What the composer's picker offers. These are bare `/model` aliases, which is also
 *  what pty.rs's ClaudeModel accepts — one vocabulary across both mechanisms. */
export const MODEL_CHOICES: ReadonlyArray<{ alias: string; label: string; sub: string }> = [
  { alias: "opus", label: "Opus", sub: "Deepest reasoning" },
  { alias: "sonnet", label: "Sonnet", sub: "Best for everyday coding" },
  { alias: "haiku", label: "Haiku", sub: "Fastest, cheapest" },
];

export interface ChatBarOpts {
  mount: HTMLElement;
  onSubmit: (text: string) => void;
  getContext: () => ChatBarContext;
  /** The user picked a tier. The router decides what that MEANS — switch the running
   *  session, or set what the next one launches on — because only it knows which. */
  onPickModel: (alias: string) => void;
}

/** The one bar per shell, and its context re-reader (null before init). */
let root: HTMLElement | null = null;
let apply: (() => void) | null = null;

const SEND_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';

const CARET_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6"/></svg>';

/** The label for a tier, or "Model" when there is nothing honest to name yet. */
function modelLabel(alias: string | null): string {
  if (!alias) return "Model";
  return MODEL_CHOICES.find((c) => c.alias === alias)?.label ?? alias;
}

export function initChatBar(opts: ChatBarOpts): void {
  if (root) return; // idempotent — exactly one bar per shell

  const bar = document.createElement("div");
  bar.className = "chatbar";
  bar.dataset.state = "min"; // min | open
  bar.innerHTML =
    '<button class="chatbar-pill" type="button" aria-label="Open the composer">' +
      '<span class="chatbar-pill-mark" aria-hidden="true">✳</span>' +
      '<span class="chatbar-pill-label">Message the task…</span>' +
    "</button>" +
    '<div class="chatbar-composer" role="group" aria-label="Message composer">' +
      '<textarea class="chatbar-input" rows="1" placeholder="How can I help you today?" ' +
        'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>' +
      '<div class="chatbar-row">' +
        // The model sits with the composer because it is a property of what you are
        // about to send — the same reason claude.ai puts it there.
        '<div class="chatbar-model">' +
          '<button class="cb-model-face" type="button" aria-haspopup="menu" aria-expanded="false">' +
            '<span class="cb-model-name"></span>' +
            '<span class="cb-model-caret" aria-hidden="true">' + CARET_ICON + "</span>" +
          "</button>" +
          '<div class="cb-model-menu" role="menu" hidden></div>' +
        "</div>" +
        '<span class="chatbar-ctx"></span>' +
        '<button class="chatbar-send" type="button" aria-label="Send" disabled>' + SEND_ICON + "</button>" +
      "</div>" +
    "</div>";
  opts.mount.append(bar);
  root = bar;

  const pill = bar.querySelector(".chatbar-pill") as HTMLButtonElement;
  const label = bar.querySelector(".chatbar-pill-label") as HTMLElement;
  const input = bar.querySelector(".chatbar-input") as HTMLTextAreaElement;
  const send = bar.querySelector(".chatbar-send") as HTMLButtonElement;
  const ctx = bar.querySelector(".chatbar-ctx") as HTMLElement;
  const modelWrap = bar.querySelector(".chatbar-model") as HTMLElement;
  const modelFace = bar.querySelector(".cb-model-face") as HTMLButtonElement;
  const modelName = bar.querySelector(".cb-model-name") as HTMLElement;
  const modelMenu = bar.querySelector(".cb-model-menu") as HTMLElement;

  // The menu is static — only the checked row moves. Build it once.
  for (const c of MODEL_CHOICES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cb-model-opt";
    b.role = "menuitemradio";
    b.dataset.alias = c.alias;
    b.innerHTML =
      '<span class="cb-model-tick" aria-hidden="true"></span>' +
      '<span class="cb-model-main"><span class="cb-model-t"></span><span class="cb-model-s"></span></span>';
    (b.querySelector(".cb-model-t") as HTMLElement).textContent = c.label;
    (b.querySelector(".cb-model-s") as HTMLElement).textContent = c.sub;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      closeModelMenu();
      // Paint the pick at once; the next apply() reconciles it against reality.
      modelName.textContent = modelLabel(c.alias);
      paintModelMenu(c.alias);
      opts.onPickModel(c.alias);
      input.focus();
    });
    modelMenu.append(b);
  }

  function paintModelMenu(alias: string | null): void {
    for (const el of Array.from(modelMenu.querySelectorAll<HTMLElement>(".cb-model-opt"))) {
      const on = el.dataset.alias === alias;
      el.setAttribute("aria-checked", on ? "true" : "false");
      el.classList.toggle("on", on);
    }
  }
  function closeModelMenu(): void {
    if (modelMenu.hidden) return;
    modelMenu.hidden = true;
    modelFace.setAttribute("aria-expanded", "false");
  }
  modelFace.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = modelMenu.hidden;
    modelMenu.hidden = !willOpen;
    modelFace.setAttribute("aria-expanded", willOpen ? "true" : "false");
  });
  modelMenu.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", closeModelMenu);

  // Remember an explicit collapse so a re-sync at the Home doesn't re-open a bar
  // the user just dismissed. Cleared when they open it again.
  let userMinimized = false;

  const grow = (): void => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 168) + "px";
  };
  const refreshSend = (): void => {
    send.disabled = input.value.trim().length === 0;
  };

  apply = (): void => {
    const c = opts.getContext();
    if (c.mode === "message") {
      input.placeholder = "Message the task…";
      label.textContent = "Message the task…";
      ctx.textContent = c.target ? "→ " + c.target : "This session";
    } else {
      input.placeholder = c.atHome ? "How can I help you today?" : "Start a task…";
      label.textContent = "Start a task…";
      ctx.textContent = "New session · home";
    }
    // A pick means different things per mode (switch this session vs. set what the
    // next one starts on), but it reads the same either way: the model this send
    // will use. The router owns the difference; the surface just names the tier.
    modelWrap.hidden = !c.canPickModel;
    if (c.canPickModel) {
      modelName.textContent = modelLabel(c.model);
      modelFace.title =
        c.mode === "message"
          ? "Switch this session's model"
          : "The model a new session starts on";
      paintModelMenu(c.model);
    } else {
      closeModelMenu();
    }
    // Default posture: the idle Home invites you in (open); a working unit stays
    // out of the way (min) — unless the user has explicitly set it either way.
    if (!userMinimized) bar.dataset.state = c.atHome ? "open" : "min";
  };

  const open = (): void => {
    userMinimized = false;
    apply?.();
    bar.dataset.state = "open";
    requestAnimationFrame(() => input.focus());
  };
  const minimize = (): void => {
    userMinimized = true;
    closeModelMenu(); // never leave a menu floating over a collapsed bar
    bar.dataset.state = "min";
  };

  const submit = (): void => {
    const text = input.value.trim();
    if (!text) return;
    opts.onSubmit(text);
    input.value = "";
    grow();
    refreshSend();
    minimize(); // the work now shows in the artifact/terminal — tuck away
    const prev = label.textContent;
    label.textContent = "Sent ✓";
    bar.classList.add("chatbar-sent");
    window.setTimeout(() => {
      label.textContent = prev;
      bar.classList.remove("chatbar-sent");
    }, 1400);
  };

  pill.addEventListener("click", open);
  send.addEventListener("click", submit);
  input.addEventListener("input", () => {
    grow();
    refreshSend();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Esc backs out one layer at a time: the menu first, the bar only once the
      // menu is already closed. Collapsing the whole composer because a dropdown
      // was open would throw away what the user had typed.
      if (!modelMenu.hidden) closeModelMenu();
      else minimize();
    }
  });

  apply();
}

/** Re-read context (hub↔unit) so the collapsed pill + placeholder track the view.
 *  Called by the router on every view change; a no-op before initChatBar. */
export function syncChatBar(): void {
  apply?.();
}
