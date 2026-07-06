function esc(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function itemsOf(visual) {
  return Array.isArray(visual && visual.items) ? visual.items.slice(0, 12) : [];
}

function numberOf(value) {
  const match = String(value || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function header(visual) {
  return `<header class="viz-head"><h2>${esc(visual.title)}</h2>${visual.note ? `<p>${esc(visual.note)}</p>` : ""}</header>`;
}

function metricStrip(visual) {
  return `${header(visual)}<div class="metric-strip">${itemsOf(visual).map((item) => `<div class="metric status-${esc(item.status)}"><strong>${esc(item.value)}</strong><span>${esc(item.label)}</span><small>${esc(item.detail)}</small></div>`).join("")}</div>`;
}

function barChart(visual) {
  const items = itemsOf(visual);
  const max = Math.max(1, ...items.map((item) => Math.abs(numberOf(item.value))));
  return `${header(visual)}<div class="bars" role="img" aria-label="${esc(visual.title)}">${items.map((item) => `<div class="bar-row"><span class="bar-label">${esc(item.label)}</span><span class="bar-track"><i style="--bar:${Math.max(2, Math.round(Math.abs(numberOf(item.value)) / max * 100))}%"></i></span><strong>${esc(item.value)}</strong></div>`).join("")}</div>`;
}

function lineChart(visual) {
  const items = itemsOf(visual);
  const nums = items.map((item) => numberOf(item.value));
  const min = Math.min(...nums, 0);
  const max = Math.max(...nums, 1);
  const span = max - min || 1;
  const points = nums.map((value, index) => `${items.length === 1 ? 50 : index / (items.length - 1) * 100},${46 - (value - min) / span * 40}`).join(" ");
  return `${header(visual)}<div class="line-wrap"><svg class="line-chart" viewBox="0 0 100 52" preserveAspectRatio="none" role="img"><path d="M0 47H100" class="axis"/><polyline points="${points}"/></svg><div class="line-labels">${items.map((item) => `<span><b>${esc(item.value)}</b>${esc(item.label)}</span>`).join("")}</div></div>`;
}

function timeline(visual) {
  return `${header(visual)}<ol class="timeline">${itemsOf(visual).map((item) => `<li class="status-${esc(item.status)}"><span class="time">${esc(item.value)}</span><div><strong>${esc(item.label)}</strong><p>${esc(item.detail)}</p></div></li>`).join("")}</ol>`;
}

function comparison(visual) {
  return `${header(visual)}<div class="comparison">${itemsOf(visual).map((item) => `<article class="status-${esc(item.status)}"><div class="compare-top"><h3>${esc(item.label)}</h3><b>${esc(item.value)}</b></div><p>${esc(item.detail)}</p></article>`).join("")}</div>`;
}

function optionGallery(visual) {
  return `${header(visual)}<div class="option-gallery">${itemsOf(visual).map((item, index) => `<button type="button" class="option status-${esc(item.status)}" data-option="${esc(item.label)}"><span class="option-no">${String(index + 1).padStart(2, "0")}</span><strong>${esc(item.label)}</strong><b>${esc(item.value)}</b><small>${esc(item.detail)}</small></button>`).join("")}</div>`;
}

function beforeAfter(visual) {
  const items = itemsOf(visual).slice(0, 2);
  return `${header(visual)}<div class="before-after">${items.map((item, index) => `<article><span>${index === 0 ? "Before" : "After"}</span><h3>${esc(item.label)}</h3><strong>${esc(item.value)}</strong><p>${esc(item.detail)}</p></article>`).join("")}</div>`;
}

function checklist(visual) {
  return `${header(visual)}<div class="checklist">${itemsOf(visual).map((item) => `<label class="status-${esc(item.status)}"><input type="checkbox" ${item.status === "good" ? "checked" : ""}><span><strong>${esc(item.label)}</strong><small>${esc(item.detail || item.value)}</small></span></label>`).join("")}</div>`;
}

function codeDiff(visual) {
  return `${header(visual)}<pre class="code-diff">${itemsOf(visual).map((item) => `<span class="status-${esc(item.status)}"><b>${esc(item.value || "·")}</b> ${esc(item.label)}${item.detail ? `  <i>${esc(item.detail)}</i>` : ""}</span>`).join("\n")}</pre>`;
}

const RENDERERS = {
  metric_strip: metricStrip,
  bar_chart: barChart,
  line_chart: lineChart,
  timeline,
  comparison,
  option_gallery: optionGallery,
  before_after: beforeAfter,
  checklist,
  code_diff: codeDiff,
};

function renderVisual(visual) {
  const render = RENDERERS[visual && visual.type];
  if (!render || !itemsOf(visual).length) return "";
  return `<section class="visual visual-${esc(visual.type)}">${render(visual)}</section>`;
}

module.exports = { RENDERERS, esc, numberOf, renderVisual };
