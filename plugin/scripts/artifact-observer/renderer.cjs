const { slug } = require("./lib.cjs");
const { CLAWD_CSS, poseName, renderClawd } = require("./clawd.cjs");
const { RENDERERS, esc, renderVisual } = require("./components.cjs");

const FAMILIES = new Set(["answer", "brief", "comparison", "timeline", "gallery", "metrics", "decision"]);
const ACCENTS = new Set(["blue", "amber", "clay", "mint", "violet"]);
const PRESENTATIONS = new Set(["routine", "composed", "bespoke"]);

function safeJson(value) {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
}

function stringList(value, max = 8) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()).slice(0, max) : [];
}

function normalizeItem(item) {
  return {
    label: String((item && item.label) || "").slice(0, 120),
    value: String((item && item.value) || "").slice(0, 120),
    detail: String((item && item.detail) || "").slice(0, 500),
    status: ["neutral", "good", "warn", "bad", "active"].includes(item && item.status) ? item.status : "neutral",
  };
}

function normalizeState(raw, fallback = {}) {
  const next = Array.isArray(raw && raw.next_steps) ? raw.next_steps : [];
  const visuals = Array.isArray(raw && raw.visuals) ? raw.visuals : [];
  return {
    should_write: Boolean(raw && raw.should_write),
    presentation: PRESENTATIONS.has(raw && raw.presentation) ? raw.presentation : "routine",
    family: FAMILIES.has(raw && raw.family) ? raw.family : "answer",
    clawd_pose: poseName(raw && raw.clawd_pose),
    accent: ACCENTS.has(raw && raw.accent) ? raw.accent : "blue",
    escalation_reason: String((raw && raw.escalation_reason) || "").slice(0, 300),
    bespoke_brief: String((raw && raw.bespoke_brief) || "").slice(0, 1000),
    title: String((raw && raw.title) || fallback.title || "Session update").slice(0, 120),
    summary: String((raw && raw.summary) || "").slice(0, 600),
    working: String((raw && raw.working) || "").slice(0, 300),
    changes: stringList(raw && raw.changes),
    decisions: stringList(raw && raw.decisions),
    blockers: stringList(raw && raw.blockers, 6),
    next_steps: next.slice(0, 8).map((item) => ({
      title: String((item && item.title) || "Next step").slice(0, 160),
      detail: String((item && item.detail) || "").slice(0, 400),
      kind: ["todo", "decision", "blocked"].includes(item && item.kind) ? item.kind : "todo",
    })),
    files: stringList(raw && raw.files, 20),
    visuals: visuals.slice(0, 4).map((visual) => ({
      type: Object.prototype.hasOwnProperty.call(RENDERERS, visual && visual.type) ? visual.type : "checklist",
      title: String((visual && visual.title) || "Details").slice(0, 160),
      note: String((visual && visual.note) || "").slice(0, 400),
      items: (Array.isArray(visual && visual.items) ? visual.items : []).slice(0, 12).map(normalizeItem),
    })).filter((visual) => visual.items.length),
  };
}

function evidenceBlock(title, items, tone = "") {
  if (!items.length) return "";
  return `<section class="evidence ${tone}"><h3>${esc(title)}</h3><ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></section>`;
}

function nextSteps(state) {
  if (!state.next_steps.length) return "";
  return `<section class="next"><header><span>Steer the work</span><h2>Next moves</h2></header><div class="steps">${state.next_steps.map((item, index) => `<article class="step" data-step="${index}"><div class="step-copy"><span class="kind">${esc(item.kind)}</span><h3>${esc(item.title)}</h3><p>${esc(item.detail)}</p></div><div class="choices" aria-label="Choose what to do"><button type="button" data-choice="do" aria-label="Do it">✓</button><button type="button" data-choice="note" aria-label="Add note">✎</button><button type="button" data-choice="skip" aria-label="Skip">×</button></div></article>`).join("")}</div><label class="comment"><span>Anything to add?</span><textarea id="comment" placeholder="Give the agent context…"></textarea></label><button id="submit" type="button">Send choices</button></section>`;
}

function rendererCss() {
  return `
:root{color-scheme:light;--bone:#f2efe8;--paper:#fbfaf6;--ink:#171a1f;--muted:#68707c;--line:#cdd2d8;--blue:#3d7eff;--amber:#f2b84b;--clay:#d98158;--mint:#4daa7d;--violet:#8c6ee8;--accent:var(--blue);--accent-soft:#dce7ff}*{box-sizing:border-box}html{scrollbar-width:none}html::-webkit-scrollbar{display:none}html,body{margin:0;background:transparent;color:var(--ink)}body{padding:18px;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.accent-amber{--accent:var(--amber);--accent-soft:#fff0c8}.accent-clay{--accent:var(--clay);--accent-soft:#f7dfd3}.accent-mint{--accent:var(--mint);--accent-soft:#dcefe6}.accent-violet{--accent:var(--violet);--accent-soft:#e9e2ff}.workbench{width:min(1040px,calc(100vw - 36px));margin:auto;display:grid;grid-template-columns:178px minmax(0,1fr);min-height:500px;border:1px solid #aeb5bd;background:var(--bone);box-shadow:10px 12px 0 #171a1f18,0 26px 70px #171a1f20;overflow:hidden}.margin{position:relative;padding:26px 18px 22px;border-right:1px solid #aeb5bd;background-color:#e5e8ed;background-image:linear-gradient(#c7cdd555 1px,transparent 1px),linear-gradient(90deg,#c7cdd555 1px,transparent 1px);background-size:18px 18px;display:flex;flex-direction:column;align-items:center}.margin:before{content:"";position:absolute;top:0;left:0;right:0;height:6px;background:var(--accent)}.margin-label{align-self:stretch;margin-top:auto;padding-top:20px;border-top:1px solid #929ba6;font:700 10px/1.45 "JetBrains Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.08em}.margin-label b{display:block;margin-top:4px;font-size:12px;text-transform:none;letter-spacing:0;word-break:break-word}.sheet{min-width:0;background:var(--paper)}.hero{padding:46px 52px 34px;border-bottom:1px solid var(--line);position:relative}.hero:after{content:"";position:absolute;right:0;bottom:-1px;width:34%;border-bottom:4px solid var(--accent)}.eyebrow{display:flex;gap:10px;align-items:center;font:700 10px/1 "JetBrains Mono",ui-monospace,monospace;text-transform:uppercase;letter-spacing:.11em;color:var(--muted)}.eyebrow i{width:8px;height:8px;background:var(--accent);transform:rotate(45deg)}h1{max-width:850px;margin:14px 0 14px;font:600 clamp(36px,6vw,68px)/.97 Newsreader,Georgia,serif;letter-spacing:-.035em}.summary{max-width:68ch;font-size:17px;line-height:1.58;color:#424954}.working{display:inline-flex;margin-top:20px;padding:8px 11px;border-left:4px solid var(--accent);background:var(--accent-soft);font:650 13px/1.4 Inter,sans-serif}.visuals{display:grid;gap:1px;background:var(--line);border-bottom:1px solid var(--line)}.visual{padding:30px 34px;background:var(--paper);min-width:0}.family-comparison .visuals,.family-gallery .visuals,.family-metrics .visuals{grid-template-columns:repeat(2,minmax(0,1fr))}.family-comparison .visual-comparison,.family-gallery .visual-option_gallery,.family-metrics .visual-metric_strip{grid-column:1/-1}.viz-head{display:flex;align-items:baseline;justify-content:space-between;gap:20px;margin-bottom:18px}.viz-head h2,.next h2{margin:0;font:600 24px/1 Newsreader,Georgia,serif}.viz-head p{max-width:55ch;margin:0;color:var(--muted);font-size:12px;line-height:1.45}.metric-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));border:1px solid var(--line)}.metric{padding:18px;border-right:1px solid var(--line)}.metric:last-child{border:0}.metric strong{display:block;font:650 30px/1 Newsreader,serif}.metric span{display:block;margin-top:8px;font-weight:700}.metric small{display:block;margin-top:4px;color:var(--muted)}.bars{display:grid;gap:12px}.bar-row{display:grid;grid-template-columns:minmax(80px,150px) 1fr auto;gap:12px;align-items:center}.bar-label{font-size:12px}.bar-track{height:13px;background:#e1e5ea;overflow:hidden}.bar-track i{display:block;width:var(--bar);height:100%;background:var(--accent);transition:width .7s cubic-bezier(.2,.7,.2,1)}.bar-row strong{font:700 11px "JetBrains Mono",monospace}.line-wrap{border-left:1px solid var(--line);border-bottom:1px solid var(--line);padding:10px}.line-chart{width:100%;height:170px;overflow:visible}.line-chart polyline{fill:none;stroke:var(--accent);stroke-width:2;vector-effect:non-scaling-stroke}.line-chart .axis{stroke:var(--line);stroke-width:1}.line-labels{display:flex;justify-content:space-between;gap:8px}.line-labels span{font-size:10px;color:var(--muted)}.line-labels b{display:block;color:var(--ink)}.timeline{list-style:none;margin:0;padding:0 0 0 16px;border-left:2px solid var(--line)}.timeline li{position:relative;display:grid;grid-template-columns:90px 1fr;gap:16px;padding:0 0 22px 16px}.timeline li:before{content:"";position:absolute;left:-22px;top:2px;width:10px;height:10px;background:var(--paper);border:3px solid var(--accent)}.timeline .time{font:700 10px "JetBrains Mono",monospace;color:var(--muted)}.timeline strong{font-size:14px}.timeline p,.comparison p,.before-after p{margin:4px 0 0;color:var(--muted);font-size:12px;line-height:1.45}.comparison{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));border:1px solid var(--line)}.comparison article{padding:20px;border-right:1px solid var(--line)}.comparison article:last-child{border:0}.compare-top{display:flex;justify-content:space-between;gap:10px}.compare-top h3{margin:0;font-size:15px}.compare-top b{color:var(--accent);font:700 11px "JetBrains Mono",monospace}.option-gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.option{position:relative;min-height:145px;padding:18px;text-align:left;border:1px solid var(--line);background:#fff;color:var(--ink);cursor:pointer;transition:.15s}.option:hover,.option:focus-visible{transform:translateY(-3px);border-color:var(--accent);outline:3px solid var(--accent-soft)}.option.selected{background:var(--accent-soft);border-color:var(--accent)}.option-no{display:block;font:700 10px "JetBrains Mono",monospace;color:var(--accent)}.option strong,.option b,.option small{display:block}.option strong{margin-top:22px;font-size:16px}.option b{margin-top:5px;color:var(--accent)}.option small{margin-top:8px;color:var(--muted);line-height:1.4}.before-after{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--line)}.before-after article{padding:22px}.before-after article+article{border-left:1px solid var(--line);background:var(--accent-soft)}.before-after span{font:700 10px "JetBrains Mono",monospace;text-transform:uppercase}.before-after h3{margin:15px 0 4px}.checklist{display:grid;gap:1px;background:var(--line);border:1px solid var(--line)}.checklist label{display:flex;gap:12px;padding:13px;background:var(--paper)}.checklist input{accent-color:var(--accent)}.checklist strong,.checklist small{display:block}.checklist small{margin-top:3px;color:var(--muted)}.code-diff{margin:0;padding:18px;background:#171a1f;color:#e9edf2;overflow:auto;font:12px/1.65 "JetBrains Mono",monospace}.code-diff span{display:block}.code-diff .status-good{color:#91e0b9}.code-diff .status-bad{color:#ff9b92}.code-diff i{color:#8f9bab}.evidence-wrap{padding:0 34px 30px}.evidence-toggle{width:100%;padding:18px 0;border:0;border-bottom:1px solid var(--line);background:transparent;text-align:left;font:700 11px "JetBrains Mono",monospace;text-transform:uppercase;letter-spacing:.08em;cursor:pointer}.evidence-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border:1px solid var(--line);margin-top:18px}.evidence{padding:20px;background:var(--paper)}.evidence.alert{background:#fff1eb}.evidence h3{margin:0 0 10px;font-size:13px}.evidence ul{margin:0;padding-left:17px}.evidence li{margin:7px 0;font-size:12px;line-height:1.45}.next{padding:34px;border-top:1px solid var(--line);background:#eef1f5}.next>header span{font:700 10px "JetBrains Mono",monospace;text-transform:uppercase;color:var(--accent)}.next>header h2{margin-top:7px}.steps{display:grid;gap:7px;margin-top:18px}.step{display:flex;justify-content:space-between;align-items:center;gap:18px;padding:15px;background:#fff;border:1px solid var(--line)}.kind{font:700 9px "JetBrains Mono",monospace;text-transform:uppercase;color:var(--accent)}.step h3{margin:3px 0;font-size:14px}.step p{margin:0;color:var(--muted);font-size:12px}.choices{display:flex;gap:4px}.choices button{width:34px;height:34px;border:1px solid var(--line);background:#fff;cursor:pointer}.choices button:hover,.choices button:focus-visible{border-color:var(--accent);outline:2px solid var(--accent-soft)}.choices button.active{background:var(--accent);border-color:var(--accent);color:#fff}.comment{display:block;margin-top:14px}.comment span{display:block;margin-bottom:5px;font-size:11px;font-weight:700}.comment textarea{width:100%;min-height:65px;padding:11px;border:1px solid var(--line);background:#fff;font:inherit;resize:vertical}#submit{margin-top:9px;padding:11px 16px;border:0;background:var(--ink);color:#fff;font-weight:700;cursor:pointer}#submit:hover,#submit:focus-visible{background:var(--accent);outline:3px solid var(--accent-soft)}.status-good{--status:#4daa7d}.status-warn{--status:#f2b84b}.status-bad{--status:#d75d55}@media(max-width:760px){body{padding:0}.workbench{width:100%;grid-template-columns:1fr;box-shadow:none}.margin{min-height:160px;border-right:0;border-bottom:1px solid #aeb5bd;flex-direction:row;justify-content:space-between}.margin-label{margin:0;width:45%}.hero{padding:32px 24px}.visuals,.family-comparison .visuals,.family-gallery .visuals,.family-metrics .visuals{grid-template-columns:1fr}.visual,.next{padding:24px}.evidence-wrap{padding:0 24px 24px}.evidence-grid{grid-template-columns:1fr}.bar-row{grid-template-columns:90px 1fr}.bar-row strong{display:none}}${CLAWD_CSS}`;
}

function renderArtifact(state, job) {
  const subjectJs = JSON.stringify(state.title);
  const fontUrl = process.env.HOME ? `asset://localhost${process.env.HOME}/.claude/companion/vendor/fonts.css` : "";
  const meta = {
    subject: state.title,
    summary: state.summary,
    files: state.files,
    project: job.project,
    created: new Date().toISOString(),
    observer: { model: process.env.COMPANION_OBSERVER_MODEL || "haiku", session_id: job.sessionId, family: state.family },
  };
  const visuals = state.visuals.map(renderVisual).filter(Boolean).join("");
  const evidence = [evidenceBlock("What changed", state.changes), evidenceBlock("Decisions", state.decisions), evidenceBlock("Blockers", state.blockers, "alert")].filter(Boolean).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(state.title)}</title>${fontUrl ? `<link rel="stylesheet" href="${esc(fontUrl)}">` : ""}<script type="application/json" id="companion-meta">${safeJson(meta)}</script><style>${rendererCss()}</style></head><body><main class="workbench family-${esc(state.family)} accent-${esc(state.accent)}" data-fit-root><aside class="margin">${renderClawd(state.clawd_pose)}<div class="margin-label">Companion · ${esc(state.family)}<b>${esc(job.project)}</b></div></aside><article class="sheet"><header class="hero"><div class="eyebrow"><i></i>${esc(state.presentation)} · ${esc(state.clawd_pose)}</div><h1>${esc(state.title)}</h1><div class="summary">${esc(state.summary)}</div>${state.working ? `<div class="working">${esc(state.working)}</div>` : ""}</header>${visuals ? `<div class="visuals">${visuals}</div>` : ""}${evidence ? `<details class="evidence-wrap"><summary class="evidence-toggle">Evidence and work log</summary><div class="evidence-grid">${evidence}</div></details>` : ""}${nextSteps(state)}</article></main><script>
document.querySelectorAll('[data-option]').forEach(function(btn){btn.addEventListener('click',function(){document.querySelectorAll('[data-option]').forEach(function(b){b.classList.remove('selected')});btn.classList.add('selected')})});
document.querySelectorAll('[data-choice]').forEach(function(btn){btn.addEventListener('click',function(){var row=btn.closest('.step');row.querySelectorAll('[data-choice]').forEach(function(b){b.classList.remove('active')});btn.classList.add('active')})});
var submit=document.getElementById('submit');if(submit)submit.addEventListener('click',function(){var lines=['[Companion observer feedback]','Artifact: '+${subjectJs}];var selected=document.querySelector('[data-option].selected');if(selected)lines.push('Selected: '+selected.dataset.option);document.querySelectorAll('.step').forEach(function(row){var chosen=row.querySelector('[data-choice].active');if(chosen)lines.push('- '+chosen.dataset.choice+': '+row.querySelector('h3').textContent)});var comment=document.getElementById('comment').value.trim();if(comment)lines.push('Comment: '+comment);try{parent.postMessage({source:'companion-artifact',kind:'submit',text:lines.join('\\n')},'*')}catch(e){}});
(function(){var root=document.querySelector('[data-fit-root]');function post(){try{parent.postMessage({source:'companion-artifact',kind:'size',width:Math.ceil(root.getBoundingClientRect().width+36),height:Math.ceil(root.getBoundingClientRect().height+36)},'*')}catch(e){}}new ResizeObserver(post).observe(root);post()})();
</script></body></html>`;
}

function artifactFilename(job) {
  return `observer-${slug(job.unitKey || job.project)}-${slug(job.shortid || job.sessionId.slice(0, 8))}.html`;
}

function bespokeFilename(job, at = Date.now()) {
  return `bespoke-${slug(job.unitKey || job.project)}-${at}-${slug(job.shortid || job.sessionId.slice(0, 8))}.html`;
}

module.exports = { ACCENTS, FAMILIES, PRESENTATIONS, artifactFilename, bespokeFilename, normalizeState, renderArtifact, rendererCss };
