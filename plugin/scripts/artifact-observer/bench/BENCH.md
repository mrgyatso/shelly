# Haiku-vs-Sonnet bench — artifact authoring

**Question (from the feel session):** the handoff leaned "pretty-first" (route authoring through
Sonnet). But the new Broadsheet template is genuinely beautiful even when fed by a cheap model — so
does Sonnet still beat a well-harnessed Haiku by *enough* to justify the cost? Bench both before
locking the default.

## Method

`bench.cjs` runs the real observer pipeline on 2 representative turns:
- **Turn A** — a bug fix (diagnosis + tool calls + files) → expect routine/composed.
- **Turn B** — a strategy question (a decision the user must make) → expect decision.

For each turn: the **director** at `haiku` (fast) and at `sonnet` (pretty / scope=director), both
feeding the **same local Broadsheet renderer**; plus the **Sonnet designer** on Turn B (pretty /
scope=all, bespoke HTML). We capture `total_cost_usd`, wall latency, and the rendered output.

This isolates the variable: directors share the template, so **any quality difference is judgment
and copy, not visuals.** The designer run shows the bespoke-HTML ceiling (and its cost).

## What the rendered output shows (qualitative)

The screenshots live in `out/bench/`. Both models render through the identical template, so both
are **visually first-rate** — the template equalizes feel. The differences are content:

| | Haiku (fast) | Sonnet (pretty) |
|---|---|---|
| **Headline** | Accurate, plain ("…lag fixed and deployed") | Sharper, quantified ("…~640ms race eliminated") |
| **Visual selection** | Turn A: none (brief). Turn B: comparison ✓ | Turn A: a useful **fix checklist**. Turn B: comparison **with per-axis "wins" verdicts** |
| **next_steps** | Sensible, sometimes thinner (1 generic todo on A) | Richer + a real decision (A: verify + trace-flag decision); on B independently proposed a **hybrid routing rule** |
| **Feel** | Identical (same template) | Identical (same template) |

**Headline finding: Haiku on Broadsheet is good, not embarrassing.** It picks reasonable families,
often selects a fitting visual, and writes propulsive next_steps. Sonnet is consistently a notch
sharper — better component choices, tighter copy, more creative moves — but the delta is *modest*
and entirely in judgment, never in look.

## Cost & latency (measured)

| stage | model | latency | cost/turn |
|---|---|---|---|
| director · Turn A (bugfix) | haiku | 14.2 s | **$0.011** |
| director · Turn A (bugfix) | sonnet | 17.9 s | $0.034 |
| director · Turn B (decision) | haiku | 21.5 s | **$0.013** |
| director · Turn B (decision) | sonnet | 20.7 s | $0.022 |
| designer · Turn B (bespoke, scope=all) | sonnet | **timed out > 180 s** | — (failed) |

Reading the numbers:
- **Cost:** the Sonnet director is **~2–3× Haiku** ($0.022–0.034 vs $0.011–0.013) — not the 15–20×
  the per-token price ratio implies, because these small calls are dominated by shared prompt-cache
  creation, which is similar for both. Still real money at always-on volume, but not extreme.
- **Latency:** effectively a **wash** at the director level (~14–22 s, dominated by CLI cold-start +
  cache creation); Sonnet was even slightly faster than Haiku on Turn B. Latency does not separate
  the two.
- **Designer / scope=all — the effort finding.** The full bespoke HTML generation **timed out at
  the production 180 s cap, and again at 300 s** on a richer brief. Cause isolated: it's
  `--effort medium`, whose extended thinking runs away on a "design a full interactive doc" task.
  At **`--effort low` the same task completes (~116 s simple / ~200 s for a 3-variant brief,
  ~$0.23–0.34) and the rendered output is first-rate** — fully realized variants, on-brand,
  honest fixture data, ends in a Decide ballot. So `low` is now the designer default (was the
  hard-coded `medium`), with the cap raised to 300 s; both stay env-configurable
  (`COMPANION_DESIGNER_EFFORT`, `COMPANION_DESIGNER_TIMEOUT`). Either way this is the decisive
  reason **scope=all is a reserved tier, never the default**: even at its best it's a ~2-minute,
  ~$0.23+ full HTML generation per turn vs the director's ~15 s / ~$0.01–0.03.

## Recommendation

1. **Default `fast` (Haiku director + local Broadsheet renderer).** The template carries the feel;
   Haiku's content is good enough that most turns are indistinguishable to the user, at a fraction
   of the cost/latency. This is a defensible, reversible default. *(Note: this refines the handoff's
   pretty-first lean — which was explicitly conditional on this bench. The template work flipped it.)*
2. **Ship `pretty` as a one-flag upgrade** (`/companion:quality pretty`) — raises the director to
   Sonnet for users who want the sharper judgment on every turn, still through the local template
   (scope=director), so it stays fast and cheap relative to full bespoke.
3. **`scope=all` (everything through the Sonnet designer) is the premium tier**, not the default:
   highest visual ceiling but a full HTML generation per turn (slowest, priciest). Reserve it for
   the genuinely visual-deliverable turns the director already escalates to bespoke.
4. **Best long-term: a hybrid route** (which Sonnet itself proposed in the bench): send
   `presentation=bespoke` and `family=decision` turns to Sonnet, route routine/answer turns to
   Haiku. Captures Sonnet's edge exactly where judgment matters, at Haiku cost elsewhere. Candidate
   follow-up, not part of this session's dial.
