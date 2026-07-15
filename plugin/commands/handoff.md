---
description: Write a handoff for this session and launch it in a fresh Claude/Codex agent
argument-hint: "[--dir <folder>] [--agent claude|codex] [what the next session should focus on]"
---

Write a handoff document for the current conversation, then launch it in a fresh agent via
the Companion overlay. This closes the loop from "write a handoff" to "the handoff is running
in a new session" — no copy-paste, no manual `cd` + relaunch.

## 1. Write the handoff file

Compose a concise handoff so a fresh agent can continue this work, and save it to the
Companion handoffs dir (durable, no wiki-confirmation needed):

```
~/.claude/companion/handoffs/<YYYYMMDD-HHMMSS>-<short-slug>.md
```

- `mkdir -p ~/.claude/companion/handoffs` first.
- `<short-slug>` is a 2–4 word kebab-case summary of this session's focus.
- Write it with the **Write** tool to an **absolute** path (expand `~` to `$HOME`).

Cover, tightly: the **goal / north-star**, **current state**, **what's done**, **what's
next**, the **key files/paths** (by absolute path — don't re-paste their contents), and any
**open loops or gotchas**. If arguments include free text (beyond the flags below), treat it
as a description of what the next session should focus on and tailor the doc to it. Redact
secrets — never echo API keys, tokens, or passwords.

## 2. Launch it in a fresh agent

Read the flags from the command arguments:

- `--dir <folder>` — where to start the new session. **Default to the current working
  directory** (`pwd`) when not given.
- `--agent claude|codex` — which agent CLI. **Omit when not given** — the Board will ask.

Then run, via the **Bash** tool (this returns immediately; the overlay does the rest):

```bash
companion handoff "<absolute-handoff-path>" --dir "<dir>" [--agent <agent>]
```

The Companion overlay spawns a fresh session in `<dir>`, then auto-sends
`Read the handoff at <path> and pick up the work.` into it — so the new agent starts
immediately. If `--agent` was omitted, the Board first shows a small picker to confirm the
folder and choose Claude vs Codex.

If the `companion` command is not found, the overlay/CLI isn't installed: tell the user to
install with `brew install --cask mrgyatso/tap/claude-code-companion`, then the file you wrote
is still a valid handoff they can open manually.

## 3. Report

Print the absolute path of the handoff you wrote and the exact `companion handoff …` command
you ran, so the user can find or re-run it.
