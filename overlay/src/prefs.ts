/** Board-level preferences that aren't tied to a single session — persisted in
 *  localStorage, the same way the new-session agent pick is (see board.ts).
 *
 *  Codex approval preset: how a Companion-spawned `codex` session launches.
 *    "off"  → Codex's default — asks before edits/commands.
 *    "auto" → edits & runs in the workspace without asking
 *             (`-a on-request -s workspace-write`); still prompts for network / outside.
 *    "full" → full access, no sandbox or prompts
 *             (`--dangerously-bypass-approvals-and-sandbox`, i.e. `--yolo`).
 *  Read at spawn time (terminal.ts) and applied only to the codex agent; Claude is
 *  never affected. Applies to NEW sessions — a running tab keeps how it started. */

export type CodexApproval = "off" | "auto" | "full";

const CODEX_APPROVAL_KEY = "companion.codexApproval";

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
