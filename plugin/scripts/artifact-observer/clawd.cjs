const POSES = new Set(["thinking", "typing", "conducting", "juggling", "sweeping", "beacon", "wizard", "confused", "happy"]);

function poseName(value) {
  return POSES.has(value) ? value : "thinking";
}

const PROPS = {
  thinking: '<g class="prop bubble"><rect x="17" y="1" width="9" height="6"/><rect x="18" y="0" width="7" height="8"/><circle cx="20" cy="4" r=".8"/><circle cx="22.5" cy="4" r=".8"/><circle cx="25" cy="4" r=".8"/></g>',
  typing: '<g class="prop laptop"><rect x="5" y="17" width="20" height="8" rx="1"/><rect x="3" y="25" width="24" height="2"/></g>',
  conducting: '<g class="prop streams"><path d="M2 4 C8 -3 14 7 20 1"/><path d="M10 1 C18 8 24 -2 29 5"/></g>',
  juggling: '<g class="prop balls"><circle cx="5" cy="5" r="2"/><circle cx="15" cy="1" r="2"/><circle cx="25" cy="5" r="2"/></g>',
  sweeping: '<g class="prop broom"><path d="M25 7 L18 26"/><path d="M15 26 H23"/></g>',
  beacon: '<g class="prop waves"><circle cx="15" cy="4" r="4"/><circle cx="15" cy="4" r="8"/><circle cx="15" cy="4" r="12"/></g>',
  wizard: '<g class="prop stars"><path d="M5 4h4M7 2v4M23 3h4M25 1v4M26 12h3M27.5 10.5v3"/></g>',
  confused: '<g class="prop questions"><text x="2" y="8">?</text><text x="24" y="5">?</text></g>',
  happy: '<g class="prop confetti"><path d="M3 5l3 2M8 1v4M24 2l-3 3M28 8h-4M4 16H1"/></g>',
};

const CLAWD_CSS = `
.clawd-stage{position:relative;display:grid;place-items:center;width:142px;height:150px}.clawd-stage:after{content:"";position:absolute;left:28px;right:28px;bottom:18px;height:7px;border-radius:50%;background:#171a1f;opacity:.16;filter:blur(3px)}
.clawd{position:relative;z-index:1;width:126px;height:126px;overflow:visible;shape-rendering:crispEdges}.clawd .body{fill:#d98158}.clawd .eye{fill:#171a1f}.clawd .arm{transform-box:fill-box;transform-origin:center}.clawd .prop{fill:none;stroke:var(--accent);stroke-width:1.6;stroke-linecap:square}.clawd .bubble{fill:#fff;stroke:#171a1f}.clawd .bubble circle{fill:var(--accent);stroke:none}.clawd .laptop{fill:#d9dde5;stroke:#171a1f}.clawd .balls circle{fill:var(--accent);stroke:none}.clawd .questions{fill:var(--accent);stroke:none;font:700 9px JetBrains Mono,monospace}.clawd--thinking .rig{animation:clawd-sway 3.8s ease-in-out infinite}.clawd--thinking .arm-r{animation:clawd-tap .8s ease-in-out infinite alternate}.clawd--typing .rig{animation:clawd-type .12s steps(2) infinite alternate}.clawd--typing .arm-l,.clawd--typing .arm-r{animation:clawd-hands .18s ease-in-out infinite alternate}.clawd--conducting .arm-l{animation:clawd-left 1.5s ease-in-out infinite}.clawd--conducting .arm-r{animation:clawd-right 1.5s ease-in-out infinite}.clawd--conducting .streams{animation:clawd-fade 1.5s ease-in-out infinite}.clawd--juggling .balls circle{animation:clawd-ball 1.2s ease-in-out infinite}.clawd--juggling .balls circle:nth-child(2){animation-delay:-.4s}.clawd--juggling .balls circle:nth-child(3){animation-delay:-.8s}.clawd--sweeping .rig,.clawd--sweeping .broom{animation:clawd-sweep 1.4s ease-in-out infinite}.clawd--beacon .waves circle{transform-origin:15px 4px;animation:clawd-wave 2s ease-out infinite}.clawd--beacon .waves circle:nth-child(2){animation-delay:.5s}.clawd--beacon .waves circle:nth-child(3){animation-delay:1s}.clawd--wizard .stars{animation:clawd-stars 1.5s steps(2) infinite}.clawd--confused .rig{animation:clawd-look 4s ease-in-out infinite}.clawd--happy .rig{animation:clawd-hop 1s ease-in-out infinite}.clawd--happy .confetti{animation:clawd-stars 1s steps(2) infinite}@keyframes clawd-sway{50%{transform:rotate(3deg)}}@keyframes clawd-tap{to{transform:rotate(-28deg)}}@keyframes clawd-type{to{transform:translateY(.6px)}}@keyframes clawd-hands{to{transform:translateY(2px)}}@keyframes clawd-left{50%{transform:rotate(45deg)}}@keyframes clawd-right{50%{transform:rotate(-45deg)}}@keyframes clawd-fade{50%{opacity:.25;transform:translateY(-2px)}}@keyframes clawd-ball{50%{transform:translateY(-8px)}}@keyframes clawd-sweep{50%{transform:translateX(3px) rotate(4deg)}}@keyframes clawd-wave{0%{opacity:.7;transform:scale(.3)}100%{opacity:0;transform:scale(1.5)}}@keyframes clawd-stars{50%{opacity:.25}}@keyframes clawd-look{25%{transform:translateX(-2px) rotate(-2deg)}75%{transform:translateX(2px) rotate(2deg)}}@keyframes clawd-hop{50%{transform:translateY(-9px) scaleY(1.04)}}@media(prefers-reduced-motion:reduce){.clawd *{animation:none!important}}
`;

function renderClawd(value) {
  const pose = poseName(value);
  return `<div class="clawd-stage" aria-label="Clawd is ${pose}"><svg class="clawd clawd--${pose}" viewBox="0 0 30 32" role="img"><g class="rig"><g class="body"><rect x="7" y="10" width="16" height="14" rx="1"/><rect class="arm arm-l" x="3" y="15" width="5" height="4"/><rect class="arm arm-r" x="22" y="15" width="5" height="4"/><rect x="8" y="24" width="5" height="4"/><rect x="17" y="24" width="5" height="4"/></g><rect class="eye" x="11" y="15" width="2" height="3"/><rect class="eye" x="17" y="15" width="2" height="3"/></g>${PROPS[pose]}</svg></div>`;
}

module.exports = { CLAWD_CSS, POSES, poseName, renderClawd };
