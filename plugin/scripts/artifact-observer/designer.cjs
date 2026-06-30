const { spawn } = require("child_process");
const { cleanClaudeEnv } = require("./model.cjs");

const DESIGN_SYSTEM = `You are Companion's isolated Sonnet artifact designer. The interface itself
is the deliverable. Produce one complete self-contained HTML document and nothing else.

Companion is a workbench for steering active agents. It is warm but not generic: bone #F2EFE8,
ink #171A1F, electric blue #3D7EFF, amber #F2B84B, clay #D98158, mint #4DAA7D. Use Newsreader
for restrained display type, Inter for reading, and JetBrains Mono for machine labels. A local
font_asset_url is supplied in the prompt; include it with system-font fallbacks. The signature
is Clawd, a small pixel-art clay character who should interact with the primary visualization when
appropriate. Spend boldness on one memorable interaction; keep the rest disciplined.

Requirements:
- The artifact must actually demonstrate the requested alternatives or behavior live.
- Use custom HTML/CSS/SVG/JS when needed; a generic card grid is failure.
- Add visible keyboard focus and prefers-reduced-motion handling.
- No network requests, remote assets, iframe, external scripts, or external stylesheets except the
  local asset:// font stylesheet above.
- Include <main data-fit-root>, a companion-meta JSON script, and a ResizeObserver that posts
  {source:'companion-artifact',kind:'size',width,height} to parent.
- Interactive decisions post {source:'companion-artifact',kind:'submit',text} to parent.
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

function callDesigner({ prior, turns, brief, reason, project, timeoutMs = 180000 }) {
  if (process.env.COMPANION_DESIGNER_FAKE_HTML) {
    return Promise.resolve({ html: validateBespokeHtml(process.env.COMPANION_DESIGNER_FAKE_HTML), usage: null, totalCostUsd: null });
  }
  const command = process.env.COMPANION_OBSERVER_CLAUDE_BIN || "claude";
  const model = process.env.COMPANION_DESIGNER_MODEL || "sonnet";
  const args = [
    "--safe-mode", "--print", "--model", model, "--effort", "medium", "--tools", "",
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
      reject(new Error(`designer model timed out after ${timeoutMs}ms`));
    }, timeoutMs);
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
