---
description: "Where are we? — an orientation briefing on the current project: what it is, what we last did, what the next objective was, and what to pick up now"
argument-hint: "[project name or path — defaults to the current directory]"
---

The user has come back to a project and needs to get their bearings. Produce a **short,
beautiful orientation briefing** as a Shelly artifact that answers, in order: *what is this
project · what did we last do · what was the next objective · what's the overall state · what
should we do next.*

Optimise for **re-entry**, not for completeness. The reader has forgotten the details and
wants to be productive within thirty seconds of reading. Cut anything that doesn't help them
take the next action.

## 1 · Scope it

Default to the **current working directory**. If arguments name a project or path, resolve to
that instead (`~/<name>`, a wiki entity slug, or a literal path). If the argument matches
nothing, say so and fall back to cwd rather than guessing.

Derive the **project slug** from the repo/directory basename — you'll need it to find wiki and
Shelly state.

## 2 · Gather state (parallel, degrade gracefully)

Read what exists; **skip silently what doesn't**. Not every project has a wiki page or a
handoff. Never block on a missing source, and never invent one.

**Identity — "what is this?"**
- `README.md` (the lede), `CLAUDE.md`, `package.json`/`pyproject.toml`/`Cargo.toml` description.

**Code ground-truth**
- `git status -sb` — branch, ahead/behind, dirty files
- `git log --oneline -20`
- `git log --oneline @{u}..HEAD` — unpushed work (a classic forgotten loop)
- `git log -1 --format='%h %s (%cr)'` — how *cold* is this project?

**Intent — what we said we were doing**
- claude-mem: `timeline` / `observation_search` scoped to this project — the decisions (⚖),
  features (◆), bugfixes (●), and discoveries (○) of the last few sessions.
- Latest handoff — `ls -t ~/wiki/entities/<slug>/handoffs/` and `ls -t ~/.shelly/handoffs/`.
  **`ls -t` it; never chase a path from memory**, those go stale.
- Any in-repo `HANDOFF*.md`, `TODO.md`, `PLAN*.md`, `DECISIONS*.md` at the repo root.

**Durable state**
- `~/wiki/entities/<slug>/` — the *Current state*, *Next / roadmap*, *Open questions*, and
  *Decisions log* sections. Read them; don't paraphrase from memory.
- The prior digest at `~/.shelly/artifacts/home.<unit_key>.html`, if one exists. **Read-only —
  this command never writes the home digest.** It is a source of prior context here, nothing more;
  the only file this command writes is its own dated briefing (§5).

## 3 · Reconcile before you write

Sources will disagree — that disagreement is often the single most useful thing in the
briefing. Resolve it explicitly:

- **Git is ground truth for what the code is.** A wiki page claiming a feature is "planned"
  loses to a commit that shipped it.
- **Handoffs and claude-mem are ground truth for intent** — what we *meant* to do next.
- **The wiki is ground truth for decisions** — why we chose what we chose.

When a source is clearly stale (wiki `updated:` predates the last commit by weeks, a handoff
describes work that's since landed), **say so in the briefing** rather than quietly picking a
winner. "The wiki still lists X as next, but X shipped in `a1b2c3d` — the wiki is behind" is
exactly the kind of line that saves the user twenty minutes.

If the project is genuinely **cold** (no commits in weeks, no recent observations), lead with
that. Re-entry after a long gap is a different problem than re-entry after lunch, and the
briefing should feel different.

## 4 · What the briefing must answer

Five things, in this order. Keep each one tight.

1. **What this is** — two sentences, maximum. Written for someone who forgot. Name the actual
   purpose, not the tech stack.
2. **What we last did** — the last *session's* real work, not merely the last commit subject.
   Synthesise commits + observations into "we were migrating the summariser off OpenRouter and
   finished it," not a changelog dump. Cap at ~5 lines.
3. **What the next objective was** — what we said we'd do next, and *who said it* (handoff /
   wiki roadmap / a decision in memory). If nothing ever said, admit it plainly — that's a
   finding, not a gap to paper over.
4. **Overall state** — one honest health read: *shipping · mid-refactor · blocked · parked ·
   cold*. Include the loose ends that actually block progress: unpushed commits, a dirty tree,
   a failing check, an unanswered open question. Skip the tour of everything that's fine.
5. **What to pick up next** — 3–5 concrete, ranked moves. **Recommend one and say why.** Each
   must be a real action ("push the 4 unpushed commits, then rotate the exposed key"), never a
   vague direction ("continue improving the bot").

## 5 · Render it

Write a self-contained artifact to
`${SHELLY_ARTIFACTS_DIR:-~/.shelly/artifacts}/where-<slug>-<YYYYMMDD>.html`. The date keeps
each re-entry as its own card, so an older briefing stays one flip back instead of being
destroyed under the user.

**Load the `prefer-html` skill before writing** — it owns the mechanics and the house style.

- **Pattern:** default to a **single-scroll editorial briefing** in the Broadsheet house style.
  The five answers are one narrative about one subject, so resist the sidebar. Reach for the
  **blob canvas** only when the project has genuinely fractured into independent workstreams,
  and for a **compact pill** when the honest answer is one line ("clean tree, nothing pending,
  last touched yesterday").
- **Lead with the decision, not the recap.** The loudest thing on the page is *what to do next*
  — the "what we last did" section exists only to justify it. If the recap is longer than the
  recommendation, you've written a transcript. Cut it.
- Wrap the content blocks in `data-shelly-commentable` so the user can 💬 any line they don't
  remember, and end on a **Next steps ballot** (✓ do it / ✎ note / ✗ skip, plus **Do all**)
  carrying the ranked moves from §4.5 as individual items. Keep `data-shelly-commentable` off
  the ballot page.
- Every question you raise gets wired as its **own clickable item**. A question left as prose
  is a bug.
- Include the required plumbing — `<meta charset>`, the `data-fit-root` wrapper, root
  scrollbar-hide, the `shelly-meta` block, and the size-report snippet. Set `shelly-meta`'s
  `subject` to the project name and `summary` to the one-line state read.

## 6 · Report

Tell the user the path you wrote and give them the one-line state read in the terminal too, so
they get the answer even without looking at the Board. If nothing pops, point them at
`/shelly:doctor`.

## Don'ts

- Don't dump the wiki page or the commit log into the artifact. This is a briefing.
- Don't fabricate a next objective to fill the section. "We never wrote down what was next" is
  a legitimate — and actionable — finding.
- Don't editorialise about code quality. Orientation only; `/code-review` is a different verb.
- Don't ask the user which project unless the argument is genuinely ambiguous. Resolve and go.
