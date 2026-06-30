const { spawn } = require("child_process");
const { cleanClaudeEnv } = require("./model.cjs");

const DESIGN_SYSTEM = `You are Companion's isolated Sonnet artifact designer. The interface itself is the
deliverable. Produce one complete self-contained HTML document and nothing else.

Companion floats a panel over a live coding agent. The artifact's job is to MOVE THE WORK
FORWARD without the user touching the terminal — so the single loudest, most-designed element
is always the DECISION: the next move. Inform, then propel.

HOUSE STYLE — "Broadsheet". The artifact is an editorial page, not a floating card:
- DISSOLVE INTO THE BOARD. Set html/body background to the exact board canvas
  oklch(0.945 0.014 60) (the opaque-origin iframe can't read parent vars, so hardcode it). No
  outer card border, no drop shadow around the whole page, no window chrome — the artifact IS the
  surface, edge to edge. The board resizes its window to your reported size.
- HIERARCHY THROUGH SCALE. One dominant Newsreader headline (clamp ~34–60px, letter-spacing
  ~-.03em) earns its size; everything else steps down hard. No wall of same-weight sections.
- PALETTE. board oklch(0.945 0.014 60), paper #FBFAF6, ink #171A1F, soft #39404A, muted #646C76,
  hairline #CDC8BC. One accent per artifact: blue #3D7EFF, amber #F2B84B, clay #D98158, or mint
  #4DAA7D (with a darker ink variant for text on paper). Color is semantic, not decoration.
- TYPE. Newsreader = display/headlines (a serif with character); Inter = reading; JetBrains Mono
  = kickers, labels, edition lines, file chips. A font_asset_url is supplied — include it with
  system fallbacks. Lean on small-caps mono kickers and hairline rules for editorial texture.
- CLAWD is the publication's emblem — a small pixel-art clay character (clay body #D98158, ink
  eyes) in the masthead, posing to the work (thinking/typing/conducting/etc). Animate transform/
  opacity only. He is signature, not wallpaper; do not let him crowd the headline.

THE DECIDE BALLOT (load-bearing — never a footer of tiny buttons). When the artifact carries
next moves, end on an ELEVATED decision surface: a panel set off with an accent top-rule and a
real "Decide" header, each move a row with a kind label + title + one-line detail + generous
(~42px) tap targets ✓ do / ✎ note / ✗ skip, plus a "Do all" and a primary dark "Commit &
continue". One shared comment field rides the same submit. This is where you spend boldness.

TWO MODES of the same house style — choose by what the turn needs:
- STEER (decision-dominant): when the turn is mostly a choice, make the recommendation itself the
  headline, give it one confident primary action, and collapse the context below or into a
  details. Best for "just tell me the next move".
- CANVAS (always-on): when the user is living in the board, keep a persistent steer rail in reach
  (reading on one side, the moves always visible on the other) so the wheel never leaves screen.

Requirements:
- The artifact must actually demonstrate the requested alternatives or behavior live; a generic
  card grid is failure. Use custom HTML/CSS/SVG/JS.
- Visible keyboard focus; honor prefers-reduced-motion (freeze animation). Animate only transform/
  opacity/clip-path.
- No network requests, remote assets, iframe, external scripts, or external stylesheets except the
  local asset:// font stylesheet supplied.
- Include <main data-fit-root> (give it a definite width, let height flow), a companion-meta JSON
  script, and a ResizeObserver that posts {source:'companion-artifact',kind:'size',width,height}.
- Decisions post {source:'companion-artifact',kind:'submit',text} to parent; format the text with
  clear "✓ Do it / ✎ Note / ✗ Skip" lines so the terminal reads it cleanly.
- Use real facts from the supplied deltas. Never invent implementation state.
- Return raw HTML only, beginning with <!doctype html>.`;

function designerPrompt({ prior, turns, brief, reason, project }) {
  return JSON.stringify({
    project,
    escalation_reason: reason,
    design_brief: brief,
    font_asset_url: process.env.HOME ? `asset://localhost${process.env.HOME}/.claude/companion/vendor/fonts.css` : null,
    prior_compact_state: prior || null,
    new_turn_deltas: turns.map((turn) => ({
      user: turn.user,
      assistant: turn.assistant,
      tools: turn.tools,
      files: turn.files,
    })),
  });
}

function stripFence(value) {
  const text = String(value || "").trim();
  const match = text.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : text;
}

function validateBespokeHtml(value) {
  const html = stripFence(value);
  if (Buffer.byteLength(html) > 600000) throw new Error("designer HTML exceeds 600 KB");
  if (!/^<!doctype html>/i.test(html)) throw new Error("designer output is not a complete HTML document");
  if (!/<main\b[^>]*data-fit-root/i.test(html)) throw new Error("designer output is missing data-fit-root");
  if (!/id=["']companion-meta["']/i.test(html)) throw new Error("designer output is missing companion-meta");
  if (!/ResizeObserver/.test(html) || !/kind\s*:\s*["']size["']/.test(html)) throw new Error("designer output is missing the size reporter");
  if (/<iframe\b/i.test(html)) throw new Error("designer output contains an iframe");
  if (/<script\b[^>]*\bsrc\s*=/i.test(html)) throw new Error("designer output contains an external script");
  if (/\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/i.test(html)) throw new Error("designer output contains a network call");
  const remote = /(?:src|href)\s*=\s*["']https?:\/\//i;
  if (remote.test(html)) throw new Error("designer output contains a remote asset");
  return html;
}

function callDesigner({ prior, turns, brief, reason, project, timeoutMs }) {
  if (process.env.COMPANION_DESIGNER_FAKE_HTML) {
    return Promise.resolve({ html: validateBespokeHtml(process.env.COMPANION_DESIGNER_FAKE_HTML), usage: null, totalCostUsd: null });
  }
  // Bespoke HTML generation is slow; cap and reasoning effort are tunable so ops can
  // trade quality for latency without a code change. The bench showed effort=medium runs
  // away on a "design a full interactive doc" task (>300s → timeout/dead-letter), while
  // effort=low produces equally on-brand output and completes in ~120-200s — so low is
  // the default and the cap sits comfortably above the observed low-effort times.
  const limitMs = timeoutMs || Number(process.env.COMPANION_DESIGNER_TIMEOUT) || 300000;
  const effort = process.env.COMPANION_DESIGNER_EFFORT || "low";
  const command = process.env.COMPANION_OBSERVER_CLAUDE_BIN || "claude";
  const model = process.env.COMPANION_DESIGNER_MODEL || "sonnet";
  const args = [
    "--safe-mode", "--print", "--model", model, "--effort", effort, "--tools", "",
    // Same advisor-leak guard as the observer (model.cjs): never inherit the
    // user's global advisorModel, or the Sonnet design pass also drags in Opus.
    "--settings", JSON.stringify({ advisorModel: null }),
    "--no-session-persistence", "--output-format", "json", "--system-prompt", DESIGN_SYSTEM,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: cleanClaudeEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`designer model timed out after ${limitMs}ms`));
    }, limitMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`designer model exited ${code}: ${stderr.trim().slice(-1000)}`));
        return;
      }
      try {
        const outer = JSON.parse(stdout);
        resolve({
          html: validateBespokeHtml(outer.result),
          usage: outer.usage || null,
          totalCostUsd: outer.total_cost_usd || null,
        });
      } catch (error) {
        reject(new Error(`invalid designer response: ${error.message}`));
      }
    });
    child.stdin.end(designerPrompt({ prior, turns, brief, reason, project }));
  });
}

module.exports = { DESIGN_SYSTEM, callDesigner, designerPrompt, stripFence, validateBespokeHtml };
