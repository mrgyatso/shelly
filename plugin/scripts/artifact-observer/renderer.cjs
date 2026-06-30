const { slug } = require("./lib.cjs");
const { CLAWD_CSS, poseName } = require("./clawd.cjs");
const { RENDERERS, esc } = require("./components.cjs");
const { assemble } = require("./blocks.cjs");

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

function rendererCss() {
  return `
:root{color-scheme:light;--board:oklch(0.945 0.014 60);--paper:#fbfaf6;--ink:#171a1f;--soft:#39404a;--muted:#646c76;--faint:#8c939d;--line:#cdc8bc;--hair:rgba(23,26,31,.10);--rule:#171a1f;--blue:#3d7eff;--amber:#f2b84b;--clay:#d98158;--mint:#4daa7d;--violet:#8c6ee8;--accent:var(--blue);--accent-ink:#1f57cf;--accent-wash:#e8eeff}
*{box-sizing:border-box}html{scrollbar-width:none;background:var(--board)}html::-webkit-scrollbar{display:none}html,body{margin:0;background:var(--board);color:var(--ink)}
body{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.accent-amber{--accent:var(--amber);--accent-ink:#9a7a1d;--accent-wash:#fff0c8}.accent-clay{--accent:var(--clay);--accent-ink:#b0552f;--accent-wash:#f7dfd3}.accent-mint{--accent:var(--mint);--accent-ink:#2f7d57;--accent-wash:#dcefe6}.accent-violet{--accent:var(--violet);--accent-ink:#6244c0;--accent-wash:#e9e2ff}
.paper{width:min(1000px,100%);margin:0 auto;padding:30px 52px 34px;min-width:0}
/* masthead — Clawd as the publication emblem */
.plate{display:flex;align-items:center;justify-content:space-between;gap:18px;padding-bottom:11px;border-bottom:3px double var(--rule)}
.brand{display:flex;align-items:center;gap:9px}
.plate .clawd-stage{width:52px;height:52px;flex:0 0 auto}.plate .clawd-stage:after{display:none}.plate .clawd{width:46px;height:46px}
.word{display:flex;flex-direction:column;line-height:1}.word b{font:600 21px/1 Newsreader,Georgia,serif;letter-spacing:-.01em}.word span{margin-top:3px;font:600 9px/1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.09em;text-transform:uppercase;color:var(--faint)}
.ed{text-align:right;font:650 10px/1.5 "JetBrains Mono",monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--accent-ink)}.ed span{display:block;color:var(--faint)}
/* lead — kicker + dominant headline + standfirst */
.lead{padding:28px 0 22px;border-bottom:1px solid var(--line)}
.kicker{display:flex;align-items:center;gap:9px;font:650 11px/1 "JetBrains Mono",monospace;letter-spacing:.15em;text-transform:uppercase;color:var(--accent-ink)}.kicker:before{content:"";width:24px;height:2px;background:var(--accent)}
h1{margin:14px 0 0;font:560 clamp(34px,5.2vw,58px)/1.0 Newsreader,Georgia,serif;letter-spacing:-.03em;max-width:19ch}
.summary{margin:16px 0 0;max-width:64ch;font-size:17px;line-height:1.6;color:var(--soft)}
.working{display:inline-flex;align-items:center;margin-top:18px;padding:9px 13px;border-left:3px solid var(--accent);background:var(--accent-wash);border-radius:0 8px 8px 0;font:600 13px/1.4 Inter,sans-serif;color:var(--ink)}
.touches{margin-top:18px;display:flex;flex-wrap:wrap;gap:7px;align-items:center}.touches .tl{font:650 9px/1 "JetBrains Mono",monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);margin-right:2px}.touches code{font:550 11px/1 "JetBrains Mono",monospace;color:var(--soft);background:var(--paper);border:1px solid var(--hair);border-radius:6px;padding:5px 8px}
/* visuals — restyled into the editorial body */
.visuals{display:grid;gap:22px;padding:24px 0}
.visual{min-width:0}
.family-comparison .visuals,.family-gallery .visuals,.family-metrics .visuals{grid-template-columns:repeat(2,minmax(0,1fr))}
.family-comparison .visual-comparison,.family-gallery .visual-option_gallery,.family-metrics .visual-metric_strip{grid-column:1/-1}
.viz-head{display:flex;align-items:baseline;justify-content:space-between;gap:20px;margin-bottom:16px}
.viz-head h2{margin:0;font:600 22px/1.05 Newsreader,Georgia,serif;letter-spacing:-.01em}.viz-head p{max-width:52ch;margin:0;color:var(--muted);font-size:12px;line-height:1.45}
.metric-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--paper)}
.metric{padding:18px 20px;border-right:1px solid var(--line);position:relative}.metric:last-child{border-right:0}.metric:before{content:"";position:absolute;left:0;top:14px;bottom:14px;width:3px;background:var(--status,var(--accent));opacity:.0}.metric.status-good:before,.metric.status-warn:before,.metric.status-bad:before,.metric.status-active:before{opacity:1}.metric strong{display:block;font:600 30px/1 Newsreader,serif;letter-spacing:-.01em}.metric span{display:block;margin-top:8px;font-weight:650;font-size:13px}.metric small{display:block;margin-top:4px;color:var(--muted);font-size:11.5px}
.bars{display:grid;gap:12px}.bar-row{display:grid;grid-template-columns:minmax(80px,150px) 1fr auto;gap:12px;align-items:center}.bar-label{font-size:12px;color:var(--soft)}.bar-track{height:12px;background:#e6e1d6;border-radius:6px;overflow:hidden}.bar-track i{display:block;width:var(--bar);height:100%;background:var(--accent);border-radius:6px;transition:width .7s cubic-bezier(.2,.7,.2,1)}.bar-row strong{font:650 11px "JetBrains Mono",monospace}
.line-wrap{border:1px solid var(--line);border-radius:12px;padding:14px;background:var(--paper)}.line-chart{width:100%;height:170px;overflow:visible}.line-chart polyline{fill:none;stroke:var(--accent);stroke-width:2;vector-effect:non-scaling-stroke}.line-chart .axis{stroke:var(--line);stroke-width:1}.line-labels{display:flex;justify-content:space-between;gap:8px;margin-top:8px}.line-labels span{font-size:10px;color:var(--muted)}.line-labels b{display:block;color:var(--ink)}
.timeline{list-style:none;margin:0;padding:0 0 0 16px;border-left:2px solid var(--line)}.timeline li{position:relative;display:grid;grid-template-columns:88px 1fr;gap:16px;padding:0 0 22px 16px}.timeline li:before{content:"";position:absolute;left:-23px;top:2px;width:10px;height:10px;border-radius:50%;background:var(--board);border:3px solid var(--accent)}.timeline .time{font:650 10px "JetBrains Mono",monospace;color:var(--muted)}.timeline strong{font-size:14px}.timeline p,.comparison p,.before-after p{margin:4px 0 0;color:var(--muted);font-size:12px;line-height:1.45}
.comparison{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--paper)}.comparison article{padding:18px 20px;border-right:1px solid var(--line)}.comparison article:last-child{border:0}.compare-top{display:flex;justify-content:space-between;gap:10px;align-items:baseline}.compare-top h3{margin:0;font-size:15px}.compare-top b{color:var(--accent-ink);font:650 11px "JetBrains Mono",monospace}
.option-gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.option{position:relative;min-height:142px;padding:18px;text-align:left;border:1px solid var(--line);border-radius:13px;background:#fff;color:var(--ink);cursor:pointer;transition:transform .14s,border-color .14s,box-shadow .14s}.option:hover,.option:focus-visible{transform:translateY(-3px);border-color:var(--accent);outline:none;box-shadow:0 12px 26px -16px rgba(23,26,31,.4)}.option.selected{background:var(--accent-wash);border-color:var(--accent)}.option-no{display:block;font:650 10px "JetBrains Mono",monospace;color:var(--accent-ink)}.option strong,.option b,.option small{display:block}.option strong{margin-top:20px;font-size:16px}.option b{margin-top:5px;color:var(--accent-ink)}.option small{margin-top:8px;color:var(--muted);line-height:1.4}
.before-after{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--line);border-radius:12px;overflow:hidden}.before-after article{padding:20px 22px;background:var(--paper)}.before-after article+article{border-left:1px solid var(--line);background:var(--accent-wash)}.before-after span{font:650 10px "JetBrains Mono",monospace;text-transform:uppercase;color:var(--faint)}.before-after h3{margin:13px 0 4px}.before-after strong{font:600 18px/1 Newsreader,serif}
.checklist{display:grid;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:12px;overflow:hidden}.checklist label{display:flex;gap:12px;padding:13px 15px;background:var(--paper)}.checklist input{accent-color:var(--accent);margin-top:2px}.checklist strong,.checklist small{display:block}.checklist small{margin-top:3px;color:var(--muted)}
.code-diff{margin:0;padding:18px;background:#15171c;color:#e9edf2;border-radius:12px;overflow:auto;font:12px/1.65 "JetBrains Mono",monospace}.code-diff span{display:block}.code-diff .status-good{color:#91e0b9}.code-diff .status-bad{color:#ff9b92}.code-diff i{color:#8f9bab}
/* evidence — quiet, collapsible work log */
.evidence-wrap{padding:6px 0 4px}.evidence-toggle{width:100%;padding:16px 0;border:0;border-top:1px solid var(--line);background:transparent;text-align:left;font:650 11px/1 "JetBrains Mono",monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--faint);cursor:pointer;list-style:none}.evidence-toggle::-webkit-details-marker{display:none}.evidence-toggle:before{content:"▸ ";color:var(--accent-ink)}details[open]>.evidence-toggle:before{content:"▾ "}
.evidence-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:16px 0 4px}.evidence{padding:16px 18px;background:var(--paper);border:1px solid var(--hair);border-radius:11px}.evidence.alert{background:#fff1eb;border-color:#f3d6c9}.evidence h3{margin:0 0 9px;font-size:12px;font:650 10px/1 "JetBrains Mono",monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--faint)}.evidence.alert h3{color:#b0552f}.evidence ul{margin:0;padding-left:16px}.evidence li{margin:7px 0;font-size:12.5px;line-height:1.5;color:var(--soft)}
/* the Decide ballot — the load-bearing surface */
.ballot{margin:26px 0 0;border:1px solid var(--line);border-top:4px solid var(--accent);background:var(--paper);border-radius:0 0 5px 5px;box-shadow:0 16px 40px -24px rgba(23,26,31,.42)}
.ballot-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:20px 26px 14px;border-bottom:1px solid var(--line)}.ballot-head h2{margin:0;font:600 25px/1 Newsreader,serif}.ballot-head .sub{font:650 10px/1 "JetBrains Mono",monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--accent-ink)}
.steps{display:grid}.step{display:flex;align-items:center;gap:20px;padding:15px 26px;border-bottom:1px solid #eae6dd}.step:last-child{border-bottom:0}.step .meta{flex:1;min-width:0}.kind{font:650 9px/1 "JetBrains Mono",monospace;letter-spacing:.09em;text-transform:uppercase;color:var(--faint)}.step.k-decision .kind{color:var(--accent-ink)}.step.k-blocked .kind{color:#b0552f}.step h3{margin:5px 0 3px;font-size:16px;font-weight:650}.step p{margin:0;color:var(--muted);font-size:12.5px;line-height:1.5}
.acts{display:flex;gap:6px;flex:0 0 auto}.acts button{appearance:none;cursor:pointer;width:42px;height:42px;border-radius:11px;border:1.5px solid var(--line);background:#fff;font-size:17px;color:var(--muted);transition:transform .12s,border-color .12s,background .12s,color .12s}.acts button:hover,.acts button:focus-visible{transform:translateY(-2px);border-color:var(--ink);color:var(--ink);outline:none}.acts .do.active{background:var(--mint);border-color:var(--mint);color:#fff}.acts .note.active{background:var(--amber);border-color:var(--amber);color:#3a2a06}.acts .skip.active{background:#d75d55;border-color:#d75d55;color:#fff}
.comment{display:block;padding:14px 26px 0}.comment span{display:block;margin-bottom:6px;font:650 10px/1 "JetBrains Mono",monospace;text-transform:uppercase;letter-spacing:.08em;color:var(--faint)}.comment textarea{width:100%;min-height:54px;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:#fff;font:13px/1.5 Inter,sans-serif;color:var(--ink);resize:vertical;outline:none}.comment textarea:focus{border-color:var(--accent)}
.ballot-foot{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 26px;margin-top:14px;background:#f3efe6;border-top:1px solid var(--line)}.tally{font:600 13px/1.3 Inter,sans-serif;color:var(--muted)}.tally b{color:var(--ink)}.foot-btns{display:flex;gap:9px}
.doall{appearance:none;cursor:pointer;border:1.5px solid var(--line);background:#fff;color:var(--soft);font:650 13px/1 Inter,sans-serif;padding:13px 18px;border-radius:11px;transition:.12s}.doall:hover,.doall:focus-visible{border-color:var(--ink);color:var(--ink);outline:none}
.commit{appearance:none;cursor:pointer;border:0;background:var(--ink);color:#fff;font:650 14px/1 Inter,sans-serif;padding:14px 24px;border-radius:11px;box-shadow:0 10px 22px -12px rgba(23,26,31,.6);transition:transform .14s,background .14s}.commit:hover,.commit:focus-visible{transform:translateY(-2px);background:var(--accent);outline:none}.commit.ready{background:var(--accent)}
.status-good{--status:#4daa7d}.status-warn{--status:#f2b84b}.status-bad{--status:#d75d55}.status-active{--status:var(--blue)}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media(max-width:720px){.paper{padding:22px 20px}.visuals,.family-comparison .visuals,.family-gallery .visuals,.family-metrics .visuals{grid-template-columns:1fr}.evidence-grid{grid-template-columns:1fr}.bar-row{grid-template-columns:90px 1fr}.bar-row strong{display:none}.step{flex-direction:column;align-items:flex-start;gap:12px}.ballot-foot{flex-direction:column;align-items:stretch}.foot-btns{display:grid;grid-template-columns:1fr 1fr}}
${CLAWD_CSS}`;
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
  const edition = new Date().toISOString().slice(0, 10);
  // Assemble the layout from the block kit (blocks.cjs). Today every artifact uses the
  // "broadsheet" preset; a later phase lets the director supply a custom block array.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(state.title)}</title>${fontUrl ? `<link rel="stylesheet" href="${esc(fontUrl)}">` : ""}<script type="application/json" id="companion-meta">${safeJson(meta)}</script><style>${rendererCss()}</style></head><body><main class="paper family-${esc(state.family)} accent-${esc(state.accent)}" data-fit-root>${assemble("broadsheet", state, { job, edition })}</main><script>
(function(){
document.querySelectorAll('[data-option]').forEach(function(btn){btn.addEventListener('click',function(){document.querySelectorAll('[data-option]').forEach(function(b){b.classList.remove('selected')});btn.classList.add('selected');refresh()})});
document.querySelectorAll('.step').forEach(function(row){row.querySelectorAll('[data-choice]').forEach(function(btn){btn.addEventListener('click',function(){var on=btn.classList.contains('active');row.querySelectorAll('[data-choice]').forEach(function(b){b.classList.remove('active')});if(!on)btn.classList.add('active');refresh()})})});
var doall=document.getElementById('doall');if(doall)doall.addEventListener('click',function(){document.querySelectorAll('.step').forEach(function(row){row.querySelectorAll('[data-choice]').forEach(function(b){b.classList.remove('active')});var d=row.querySelector('[data-choice="do"]');if(d)d.classList.add('active')});refresh()});
var commentEl=document.getElementById('comment');if(commentEl)commentEl.addEventListener('input',refresh);
var submit=document.getElementById('submit');var tally=document.getElementById('tally');
function marked(){return document.querySelectorAll('.step .acts [data-choice].active').length}
function refresh(){var m=marked();var fc=commentEl&&commentEl.value.trim()?1:0;if(tally)tally.innerHTML=(m||fc)?('<b>'+m+'</b> of '+document.querySelectorAll('.step').length+' marked'+(fc?' · note added':'')):'Nothing marked yet';if(submit)submit.classList.toggle('ready',(m+fc)>0)}
if(submit)submit.addEventListener('click',function(){var lines=['[Companion observer feedback]','Re: '+${subjectJs},''];var selected=document.querySelector('[data-option].selected');if(selected)lines.push('Selected: '+selected.dataset.option,'');var verb={do:'\\u2713 Do it:',note:'\\u270e Note:',skip:'\\u2717 Skip:'};var rows=[];document.querySelectorAll('.step').forEach(function(row){var chosen=row.querySelector('[data-choice].active');if(chosen)rows.push(verb[chosen.dataset.choice]+' '+row.querySelector('h3').textContent)});if(rows.length){lines.push('\\u2014 Decisions \\u2014');lines.push.apply(lines,rows);lines.push('')}var comment=commentEl?commentEl.value.trim():'';if(comment)lines.push('\\u2014 Note \\u2014',comment);try{parent.postMessage({source:'companion-artifact',kind:'submit',text:lines.join('\\n')},'*')}catch(e){}submit.textContent='Sent \\u2713'});
var root=document.querySelector('[data-fit-root]');function post(){try{parent.postMessage({source:'companion-artifact',kind:'size',width:Math.ceil(root.scrollWidth),height:Math.ceil(root.scrollHeight)},'*')}catch(e){}}if(window.ResizeObserver)new ResizeObserver(post).observe(root);addEventListener('load',post);post();
})();
</script></body></html>`;
}

function artifactFilename(job) {
  return `observer-${slug(job.unitKey || job.project)}-${slug(job.shortid || job.sessionId.slice(0, 8))}.html`;
}

function bespokeFilename(job, at = Date.now()) {
  return `bespoke-${slug(job.unitKey || job.project)}-${at}-${slug(job.shortid || job.sessionId.slice(0, 8))}.html`;
}

module.exports = { ACCENTS, FAMILIES, PRESENTATIONS, artifactFilename, bespokeFilename, normalizeState, renderArtifact, rendererCss };
