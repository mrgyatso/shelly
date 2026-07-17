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
}

export interface ChatBarOpts {
  mount: HTMLElement;
  onSubmit: (text: string) => void;
  getContext: () => ChatBarContext;
}

/** The one bar per shell, and its context re-reader (null before init). */
let root: HTMLElement | null = null;
let apply: (() => void) | null = null;

const SEND_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';

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
      minimize();
    }
  });

  apply();
}

/** Re-read context (hub↔unit) so the collapsed pill + placeholder track the view.
 *  Called by the router on every view change; a no-op before initChatBar. */
export function syncChatBar(): void {
  apply?.();
}
