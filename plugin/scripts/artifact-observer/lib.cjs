const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function stripPrivate(value) {
  return String(value || "")
    .replace(/<private>[\s\S]*?<\/private>/gi, "[private content omitted]")
    .replace(/<claude-mem-context>[\s\S]*?<\/claude-mem-context>/gi, "")
    .trim();
}

function textFromContent(content) {
  if (typeof content === "string") return stripPrivate(content);
  if (!Array.isArray(content)) return "";
  return stripPrivate(
    content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n"),
  );
}

function toolPath(block) {
  const input = block && block.input;
  if (!input || typeof input !== "object") return "";
  return String(input.file_path || input.path || input.notebook_path || "");
}

function extractCurrentTurn(transcriptPath, artifactsDir) {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const assistantParts = [];
  const tools = [];
  const files = new Set();
  let user = "";
  let wroteArtifact = false;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch (_) {
      continue;
    }
    const message = entry.message || entry;
    const role = message.role || entry.type;
    const content = message.content;

    if (role === "assistant") {
      const text = textFromContent(content);
      if (text) assistantParts.unshift(text);
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || block.type !== "tool_use") continue;
          const file = toolPath(block);
          tools.unshift({ name: String(block.name || "tool"), file });
          if (file) files.add(file);
          if (
            file &&
            path.resolve(file).startsWith(path.resolve(artifactsDir) + path.sep) &&
            /\.html?$/i.test(file)
          ) {
            wroteArtifact = true;
          }
        }
      }
    }

    if (role === "user") {
      const isToolResult =
        Array.isArray(content) && content.some((block) => block && block.type === "tool_result");
      if (!isToolResult) {
        user = textFromContent(content);
        break;
      }
    }
  }

  const assistant = stripPrivate(assistantParts.join("\n\n"));
  return {
    user: user.slice(0, 6000),
    assistant: assistant.slice(0, 14000),
    tools: tools.slice(-40),
    files: [...files].slice(0, 40),
    wroteArtifact,
  };
}

function isSubstantive(turn) {
  if (!turn) return false;
  const mutating = turn.tools.some((tool) => /^(Write|Edit|MultiEdit|NotebookEdit|Bash)$/i.test(tool.name));
  return Boolean(
    mutating ||
    turn.tools.length >= 3 ||
    turn.assistant.length >= 600 ||
    (turn.tools.length >= 2 && turn.assistant.length >= 250),
  );
}

function turnHash(turn) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      user: turn.user,
      assistant: turn.assistant,
      tools: turn.tools,
      files: turn.files,
    }))
    .digest("hex");
}

function detectVisualIntent(turn) {
  const text = String((turn && turn.user) || "").toLowerCase();
  const rules = [
    [/(?:mock\s?up|wireframe|prototype)\b/, "requested a mockup or prototype"],
    [/\b(?:interactive|clickable|live)\s+(?:preview|demo|experience|version)/, "requested a live interactive preview"],
    [/\b(?:animate|animation|motion study|animated)\b/, "animation is central to the request"],
    [/\b(?:mascot|pose|character)\s+(?:options|variants|concepts|designs)/, "requested visual character variants"],
    [/\b(?:design|visual|ui|layout)\s+(?:options|variants|directions|concepts)/, "requested visual design alternatives"],
    [/\bwhat (?:would|will|does).{0,80}\blook like\b/, "asked what the result would look like"],
    [/\bshow me\b.{0,80}\b(?:options|variants|versions|designs|screens|layouts|preview)\b/, "asked to see visual alternatives"],
    [/\b(?:gallery|storyboard|simulator|playground)\b/, "requested a visual exploration surface"],
    [/\b(?:five|six|seven|eight|nine|ten|\d+)\s+(?:visual\s+)?(?:options|variants|designs|mockups|poses)\b/, "requested multiple visual variants"],
  ];
  for (const [pattern, reason] of rules) if (pattern.test(text)) return reason;
  return null;
}

function safeId(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
}

function slug(value) {
  return String(value || "session")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "session";
}

function atomicWrite(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

function atomicJson(file, value) {
  atomicWrite(file, JSON.stringify(value, null, 2));
}

module.exports = {
  atomicJson,
  atomicWrite,
  detectVisualIntent,
  extractCurrentTurn,
  isSubstantive,
  safeId,
  slug,
  stripPrivate,
  turnHash,
};
