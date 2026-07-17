/** Board-level preferences that aren't tied to a single session — persisted in
 *  localStorage, the same way the new-session agent pick is (see board.ts).
 *
 *  Codex approval preset: how a Shelly-spawned `codex` session launches.
 *    "off"  → Codex's default — asks before edits/commands.
 *    "auto" → edits & runs in the workspace without asking
 *             (`-a on-request -s workspace-write`); still prompts for network / outside.
 *    "full" → full access, no sandbox or prompts
 *             (`--dangerously-bypass-approvals-and-sandbox`, i.e. `--yolo`).
 *  Read at spawn time (terminal.ts) and applied only to the codex agent; Claude is
 *  never affected. Applies to NEW sessions — a running tab keeps how it started. */

export type CodexApproval = "off" | "auto" | "full";

const CODEX_APPROVAL_KEY = "shelly.codexApproval";

export function getCodexApproval(): CodexApproval {
  try {
    const v = localStorage.getItem(CODEX_APPROVAL_KEY);
    return v === "auto" || v === "full" ? v : "off";
  } catch {
    return "off";
  }
}

export function setCodexApproval(mode: CodexApproval): void {
  try {
    localStorage.setItem(CODEX_APPROVAL_KEY, mode);
  } catch {
    /* storage disabled (private mode) — falls back to the session default */
  }
}

/** Which model a NEW claude session launches on, from the composer's picker.
 *  "default" sends no flag at all, leaving whatever the CLI itself defaults to —
 *  that is deliberately distinct from naming a tier, so the Board never overrides a
 *  choice the user made outside it just by being installed.
 *
 *  Read at spawn time (terminal.ts) and applied only to claude, and only to a fresh
 *  launch — a resume rejoins a session that already has a model (see pty.rs). A
 *  running tab keeps how it started; switching THAT is `/model` into its own PTY. */
export type LaunchModel = "default" | "opus" | "sonnet" | "haiku";

const LAUNCH_MODEL_KEY = "companion.launchModel";

export function getLaunchModel(): LaunchModel {
  try {
    const v = localStorage.getItem(LAUNCH_MODEL_KEY);
    return v === "opus" || v === "sonnet" || v === "haiku" ? v : "default";
  } catch {
    return "default";
  }
}

export function setLaunchModel(model: LaunchModel): void {
  try {
    localStorage.setItem(LAUNCH_MODEL_KEY, model);
  } catch {
    /* storage disabled (private mode) — falls back to the CLI default */
  }
}
