// Pixel-art clawd scene library for the overlay (idle surfaces).
// Mirrors the prefer-html splash helper (plugin/skills/prefer-html/SKILL.md);
// motion/keyframes adapted from marciogranzotto/clawd-tank (MIT). Re-scoped from
// the splash overlay (.cmp-submitted) to a reusable .clawd-stage wrapper so it can
// light up the L0 idle screen and other Board surfaces. Transform/opacity only,
// reduced-motion aware.

export interface ClawdScene { id: string; cap: string; behind: string; front: string; css: string; }


// Shared character rig — body, arms, nested eyes. Drawn once per mount.
export const CW_RIG =
  '<g class="cw-rig">' +
    '<g class="cw-body" fill="#d98a5c">' +
      '<rect x="3" y="13" width="1" height="2"/><rect x="5" y="13" width="1" height="2"/>' +
      '<rect x="9" y="13" width="1" height="2"/><rect x="11" y="13" width="1" height="2"/>' +
      '<rect x="2" y="6" width="11" height="7"/>' +
      '<g class="cw-arm-l"><rect x="0" y="9" width="2" height="2"/></g>' +
      '<g class="cw-arm-r"><rect x="13" y="9" width="2" height="2"/></g>' +
    '</g>' +
    '<g class="cw-eyes"><g class="cw-eyes-b" fill="#2a2018">' +
      '<rect x="4.5" y="8" width="1" height="2"/><rect x="9.5" y="8" width="1" height="2"/>' +
    '</g></g>' +
  '</g>';

// Base CSS shared by every scene (halo, canvas, shadow, prop defaults).
export const CW_BASE =
  ".clawd-stage .halo{position:absolute;top:50%;left:50%;width:200px;height:200px;transform:translate(-50%,-64%);background:radial-gradient(circle,rgba(217,138,92,.30) 0%,transparent 62%);filter:blur(6px);animation:cwHalo 4.5s ease-in-out infinite;pointer-events:none}" +
  "@keyframes cwHalo{0%,100%{opacity:.5;transform:translate(-50%,-64%) scale(1)}50%{opacity:.85;transform:translate(-50%,-64%) scale(1.08)}}" +
  ".clawd-stage .cw{width:150px;height:150px;shape-rendering:crispEdges;overflow:visible}" +
  ".clawd-stage .cw-shadow{fill:#201b15;opacity:.4}" +
  // sensible idle defaults so a scene only overrides what it animates
  ".clawd-stage .cw-eyes-b{transform-origin:7.5px 9px;animation:cwBlink 4.2s steps(1) infinite}" +
  "@keyframes cwBlink{0%,45%,55%,100%{transform:scaleY(1)}50%{transform:scaleY(.12)}}" +
  // Reduced motion: freeze every pose, but keep the floating props faintly
  // visible (they start at opacity:0 and only the animation reveals them).
  "@media (prefers-reduced-motion:reduce){.clawd-stage .cw *,.clawd-stage .halo{animation:none!important}.clawd-stage .cw-bit,.clawd-stage .cw-load,.clawd-stage .cw-str,.clawd-stage .cw-pk,.clawd-stage .cw-dust,.clawd-stage .cw-wave,.clawd-stage .cw-star,.clawd-stage .cw-q,.clawd-stage .cw-sp{opacity:.6!important}}";

// Each scene: id, caption, behind/front prop SVG, and scoped CSS.
export const CW_SCENES = [
  { id:"typing", cap:"Claude’s heads-down in the code",
    behind:'<g fill="#40c4ff"><rect class="cw-bit" x="-2" y="12" width="1.4" height="1.4"/><rect class="cw-bit b2" x="6" y="11" width="1.4" height="1.4"/><rect class="cw-bit b3" x="13" y="12" width="1.4" height="1.4"/><rect class="cw-bit b4" x="3" y="10" width="1.4" height="1.4"/></g>',
    front:'<g transform="translate(2.5 10.5)"><rect x="-0.5" y="4.6" width="11" height="1" fill="#546e7a"/><rect x="0" y="0" width="10" height="4.8" fill="#78909c"/><rect x="4.5" y="2" width="1" height="1" fill="#fff"/></g>',
    css:
      ".clawd-stage .cw--typing .cw-rig{transform-origin:7.5px 15px;animation:cwJitter .09s steps(2) infinite alternate}" +
      "@keyframes cwJitter{from{transform:translateY(0)}to{transform:translateY(.5px)}}" +
      ".clawd-stage .cw--typing .cw-arm-l{transform-origin:2px 10px;animation:cwTypeL .16s ease-in-out infinite}" +
      ".clawd-stage .cw--typing .cw-arm-r{transform-origin:13px 10px;animation:cwTypeR .13s ease-in-out infinite}" +
      "@keyframes cwTypeL{0%,100%{transform:rotate(58deg)}50%{transform:rotate(90deg)}}" +
      "@keyframes cwTypeR{0%,100%{transform:rotate(-58deg)}50%{transform:rotate(-90deg)}}" +
      ".clawd-stage .cw--typing .cw-eyes{animation:cwRead 1.2s steps(1) infinite}" +
      "@keyframes cwRead{0%,32%{transform:translateX(-1.2px)}33%,66%{transform:translateX(0)}67%,100%{transform:translateX(1.2px)}}" +
      ".clawd-stage .cw--typing .cw-eyes-b{animation:none}" +
      ".clawd-stage .cw--typing .cw-bit{opacity:0;animation:cwBit 1s linear infinite}" +
      ".clawd-stage .cw--typing .cw-bit.b2{animation-delay:.33s}.clawd-stage .cw--typing .cw-bit.b3{animation-delay:.66s}.clawd-stage .cw--typing .cw-bit.b4{animation-delay:.85s}" +
      "@keyframes cwBit{0%{opacity:0;transform:translateY(0) scale(.5)}25%{opacity:.85}100%{opacity:0;transform:translateY(-13px) scale(1.15)}}" },

  { id:"thinking", cap:"Claude’s turning it over",
    behind:'<g transform="translate(7 -10)"><g fill="#fff" opacity="0.95"><rect x="2" y="1" width="8" height="6"/><rect x="1" y="2" width="10" height="4"/><rect x="3" y="0" width="6" height="8"/><rect x="2" y="7" width="2" height="2"/><rect x="1" y="9" width="1" height="1"/></g><g fill="#0082fc"><rect class="cw-load" x="2.5" y="3" width="1.2" height="1.2"/><rect class="cw-load l2" x="5.4" y="3" width="1.2" height="1.2"/><rect class="cw-load l3" x="8.3" y="3" width="1.2" height="1.2"/></g></g>',
    front:"",
    css:
      ".clawd-stage .cw--thinking .cw-rig{transform-origin:7.5px 15px;animation:cwSway 4s ease-in-out infinite}" +
      "@keyframes cwSway{0%,100%{transform:rotate(0deg)}25%{transform:rotate(-3deg)}75%{transform:rotate(3deg)}}" +
      ".clawd-stage .cw--thinking .cw-arm-r{transform-origin:14px 10px;animation:cwTap .8s ease-in-out infinite alternate}" +
      "@keyframes cwTap{0%{transform:rotate(-122deg)}100%{transform:rotate(-145deg)}}" +
      ".clawd-stage .cw--thinking .cw-load{opacity:.15;animation:cwLoad 2s infinite}" +
      ".clawd-stage .cw--thinking .cw-load.l2{animation-delay:.25s}.clawd-stage .cw--thinking .cw-load.l3{animation-delay:.5s}" +
      "@keyframes cwLoad{0%,18%{opacity:.15}40%,80%{opacity:1}100%{opacity:.15}}" },

  { id:"conducting", cap:"Claude’s orchestrating the next move",
    behind:'<g><rect class="cw-str" x="0" y="0" width="1.5" height="1.5" fill="#0082fc"/><rect class="cw-str s2" x="0" y="0" width="1.5" height="1.5" fill="#ffc107"/><rect class="cw-str s3" x="0" y="0" width="1.5" height="1.5" fill="#ff5252"/><rect class="cw-str s4" x="0" y="0" width="1.5" height="1.5" fill="#4caf50"/><rect class="cw-str s5" x="0" y="0" width="1.5" height="1.5" fill="#9c27b0"/></g>',
    front:"",
    css:
      ".clawd-stage .cw--conducting .cw-rig{transform-origin:7.5px 15px;animation:cwBob 2s ease-in-out infinite}" +
      "@keyframes cwBob{0%,100%{transform:translateY(0) scaleY(1)}50%{transform:translateY(1.5px) scaleY(.98)}}" +
      ".clawd-stage .cw--conducting .cw-arm-l{transform-origin:1px 10px;animation:cwCondL 2s ease-in-out infinite}" +
      ".clawd-stage .cw--conducting .cw-arm-r{transform-origin:14px 10px;animation:cwCondR 2s ease-in-out infinite}" +
      "@keyframes cwCondL{0%,100%{transform:rotate(15deg)}50%{transform:rotate(85deg)}}" +
      "@keyframes cwCondR{0%,100%{transform:rotate(-85deg)}50%{transform:rotate(-15deg)}}" +
      ".clawd-stage .cw--conducting .cw-str{opacity:0;animation:cwStream 2s linear infinite}" +
      ".clawd-stage .cw--conducting .cw-str.s2{animation-delay:.4s}.clawd-stage .cw--conducting .cw-str.s3{animation-delay:.8s}.clawd-stage .cw--conducting .cw-str.s4{animation-delay:1.2s}.clawd-stage .cw--conducting .cw-str.s5{animation-delay:1.6s}" +
      "@keyframes cwStream{0%{opacity:0;transform:translate(-2px,6px) scale(0)}15%{opacity:1;transform:translate(0,1px) scale(1)}50%{opacity:1;transform:translate(7.5px,-3px) scale(1.5)}85%{opacity:1;transform:translate(15px,1px) scale(1)}100%{opacity:0;transform:translate(17px,6px) scale(0)}}" },

  { id:"juggling", cap:"Claude’s juggling a few threads",
    behind:"",
    front:'<g><rect class="cw-pk" x="-1" y="-1" width="2" height="2" fill="#ff5252"/><rect class="cw-pk p2" x="-1" y="-1" width="2" height="2" fill="#ffc107"/><rect class="cw-pk p3" x="-1" y="-1" width="2" height="2" fill="#4caf50"/></g>',
    css:
      ".clawd-stage .cw--juggling .cw-rig{transform-origin:7.5px 15px;animation:cwRock .6s ease-in-out infinite alternate}" +
      "@keyframes cwRock{0%{transform:rotate(-5deg)}100%{transform:rotate(5deg)}}" +
      ".clawd-stage .cw--juggling .cw-arm-l{transform-origin:1px 10px;animation:cwJugL .6s ease-in-out infinite alternate}" +
      ".clawd-stage .cw--juggling .cw-arm-r{transform-origin:14px 10px;animation:cwJugR .6s ease-in-out infinite alternate}" +
      "@keyframes cwJugL{0%{transform:rotate(60deg)}100%{transform:rotate(10deg)}}" +
      "@keyframes cwJugR{0%{transform:rotate(-10deg)}100%{transform:rotate(-60deg)}}" +
      ".clawd-stage .cw--juggling .cw-eyes{animation:cwDart 1.2s infinite}" +
      "@keyframes cwDart{0%,100%{transform:translate(-2px,-2px)}25%{transform:translate(0,-3px)}50%{transform:translate(2px,-2px)}75%{transform:translate(0,0)}}" +
      ".clawd-stage .cw--juggling .cw-eyes-b{animation:none}" +
      ".clawd-stage .cw--juggling .cw-pk{animation:cwJuggle 1.2s linear infinite}" +
      ".clawd-stage .cw--juggling .cw-pk.p2{animation-delay:-.4s}.clawd-stage .cw--juggling .cw-pk.p3{animation-delay:-.8s}" +
      "@keyframes cwJuggle{0%{transform:translate(0,9px) rotate(0deg)}25%{transform:translate(8px,0) rotate(90deg)}50%{transform:translate(15px,9px) rotate(180deg)}75%{transform:translate(8px,4px) rotate(270deg)}100%{transform:translate(0,9px) rotate(360deg)}}" },

  { id:"sweeping", cap:"Claude’s sweeping up the details",
    behind:'<g class="cw-dust" fill="#9e9e9e"><rect x="0" y="0" width="1.5" height="1.5"/></g><g class="cw-dust d2" fill="#b0bec5"><rect x="0" y="0" width="1" height="1"/></g>',
    front:'<g class="cw-broom"><rect x="13.5" y="4" width="1" height="10" fill="#795548"/><rect x="12" y="14" width="4" height="2" fill="#ffc107"/></g>',
    css:
      ".clawd-stage .cw--sweeping .cw-rig{transform-origin:7.5px 15px;animation:cwLean 1.5s ease-in-out infinite}" +
      "@keyframes cwLean{0%,100%{transform:rotate(5deg) translate(1px,0)}50%{transform:rotate(13deg) translate(3px,1px)}}" +
      ".clawd-stage .cw--sweeping .cw-arm-l{transform-origin:1px 10px;transform:translate(6px,1px) rotate(-15deg)}" +
      ".clawd-stage .cw--sweeping .cw-arm-r{transform-origin:14px 10px;animation:cwSwArm 1.5s ease-in-out infinite}" +
      "@keyframes cwSwArm{0%,100%{transform:rotate(0deg)}50%{transform:rotate(-20deg)}}" +
      ".clawd-stage .cw--sweeping .cw-broom{transform-origin:13.5px 14px;animation:cwBroom 1.5s ease-in-out infinite}" +
      "@keyframes cwBroom{0%,100%{transform:rotate(10deg)}50%{transform:rotate(30deg) translate(2px,-1px)}}" +
      ".clawd-stage .cw--sweeping .cw-dust{opacity:0;animation:cwDust 1.5s ease-out infinite}" +
      ".clawd-stage .cw--sweeping .cw-dust.d2{animation-delay:.3s}" +
      "@keyframes cwDust{0%,40%{transform:translate(17px,14px) scale(0);opacity:0}50%{transform:translate(19px,14px) scale(1);opacity:1}100%{transform:translate(25px,14px) scale(.5);opacity:0}}" },

  { id:"beacon", cap:"Claude’s directing the subagents",
    behind:'<g fill="none"><circle class="cw-wave" cx="7.5" cy="5" r="3" stroke="#0082fc" stroke-width="0.6"/><circle class="cw-wave w2" cx="7.5" cy="5" r="3" stroke="#ffc107" stroke-width="0.6"/><circle class="cw-wave w3" cx="7.5" cy="5" r="3" stroke="#ff5252" stroke-width="0.6"/></g>',
    front:'<g><rect x="7" y="2" width="1" height="4" fill="#78909c"/><circle class="cw-ant" cx="7.5" cy="1.5" r="1" fill="#ff5252"/></g>',
    css:
      ".clawd-stage .cw--beacon .cw-rig{transform-origin:7.5px 15px;animation:cwBeac 1.5s ease-in-out infinite}" +
      "@keyframes cwBeac{0%,100%{transform:translateY(0)}50%{transform:translateY(.5px)}}" +
      ".clawd-stage .cw--beacon .cw-arm-l{transform-origin:1px 10px;transform:rotate(15deg)}" +
      ".clawd-stage .cw--beacon .cw-arm-r{transform-origin:14px 10px;transform:rotate(-15deg)}" +
      ".clawd-stage .cw--beacon .cw-wave{transform-origin:7.5px 5px;opacity:0;animation:cwWave 2s ease-out infinite}" +
      ".clawd-stage .cw--beacon .cw-wave.w2{animation-delay:.5s}.clawd-stage .cw--beacon .cw-wave.w3{animation-delay:1s}" +
      "@keyframes cwWave{0%{transform:scale(.4);opacity:0}10%{opacity:.7}100%{transform:scale(2.6);opacity:0}}" +
      ".clawd-stage .cw--beacon .cw-ant{animation:cwAnt .8s ease-in-out infinite alternate}" +
      "@keyframes cwAnt{0%{opacity:.4}100%{opacity:1}}" },

  { id:"wizard", cap:"Claude’s working some magic",
    behind:'<g class="cw-stars"><polygon class="cw-star" points="14,-6 14.5,-5.5 15,-5.5 14.6,-5.1 14.8,-4.5 14,-4.9 13.2,-4.5 13.4,-5.1 13,-5.5 13.5,-5.5" fill="#ffd700"/><polygon class="cw-star sb" points="4,-4 4.5,-3.5 5,-3.5 4.6,-3.1 4.8,-2.5 4,-2.9 3.2,-2.5 3.4,-3.1 3,-3.5 3.5,-3.5" fill="#40c4ff"/><polygon class="cw-star sc" points="19,0 19.5,.5 20,.5 19.6,.9 19.8,1.5 19,1.1 18.2,1.5 18.4,.9 18,.5 18.5,.5" fill="#b388ff"/></g>',
    front:'<g class="cw-wand"><rect x="13.5" y="4" width="1" height="6" fill="#8d6e63"/><rect x="13.5" y="4" width="1" height="1" fill="#ffd700"/></g><g transform="translate(7.5 6)"><polygon points="-4,0 4,0 0,-6" fill="#673ab7"/><rect x="-5" y="0" width="10" height="1" fill="#512da8"/></g>',
    css:
      ".clawd-stage .cw--wizard .cw-rig{transform-origin:7.5px 15px;animation:cwFloat 3s ease-in-out infinite}" +
      "@keyframes cwFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}" +
      ".clawd-stage .cw--wizard .cw-arm-l{transform-origin:1px 10px;animation:cwWizL 3s ease-in-out infinite}" +
      "@keyframes cwWizL{0%,100%{transform:rotate(20deg)}50%{transform:rotate(120deg)}}" +
      ".clawd-stage .cw--wizard .cw-arm-r{transform-origin:13px 10px;animation:cwWizR 3s ease-in-out infinite}" +
      ".clawd-stage .cw--wizard .cw-wand{transform-origin:14px 10px;animation:cwWizR 3s ease-in-out infinite}" +
      "@keyframes cwWizR{0%,100%{transform:rotate(-20deg)}50%{transform:rotate(-120deg)}}" +
      ".clawd-stage .cw--wizard .cw-star{opacity:0;animation:cwSparkle 2s ease-out infinite}" +
      ".clawd-stage .cw--wizard .cw-star.sb{animation-delay:.6s}.clawd-stage .cw--wizard .cw-star.sc{animation-delay:1.2s}" +
      "@keyframes cwSparkle{0%{opacity:0;transform:translateY(4px) scale(0) rotate(0)}20%{opacity:1}100%{opacity:0;transform:translateY(-13px) scale(1.4) rotate(180deg)}}" },

  { id:"confused", cap:"Claude’s puzzling it out",
    behind:'<g class="cw-q" fill="#40c4ff"><rect x="1" y="0" width="2" height="1"/><rect x="0" y="1" width="1" height="1"/><rect x="3" y="1" width="1" height="2"/><rect x="2" y="3" width="1" height="1"/><rect x="1" y="4" width="1" height="1"/><rect x="1" y="6" width="1" height="1"/></g><g class="cw-q q2" fill="#ffc107" transform="translate(10 0)"><rect x="1" y="0" width="2" height="1"/><rect x="0" y="1" width="1" height="1"/><rect x="3" y="1" width="1" height="2"/><rect x="2" y="3" width="1" height="1"/><rect x="1" y="4" width="1" height="1"/><rect x="1" y="6" width="1" height="1"/></g>',
    front:"",
    css:
      ".clawd-stage .cw--confused .cw-rig{transform-origin:7.5px 15px;animation:cwLook 6s ease-in-out infinite}" +
      "@keyframes cwLook{0%,10%{transform:translate(0,0)}15%,35%{transform:translate(-2px,0) rotate(-2deg)}40%,45%{transform:translate(0,0)}50%,70%{transform:translate(2px,0) rotate(2deg)}75%,100%{transform:translate(0,0)}}" +
      ".clawd-stage .cw--confused .cw-arm-l{transform-origin:1px 10px;transform:translate(0,-2px) rotate(18deg)}" +
      ".clawd-stage .cw--confused .cw-eyes{animation:cwLookEye 6s ease-in-out infinite}" +
      "@keyframes cwLookEye{0%,10%{transform:translate(0,0)}15%,35%{transform:translate(-2px,0)}40%,45%{transform:translate(0,0)}50%,70%{transform:translate(2px,0)}75%,100%{transform:translate(0,0)}}" +
      ".clawd-stage .cw--confused .cw-q{opacity:0;animation:cwQL 6s ease-in-out infinite}" +
      ".clawd-stage .cw--confused .cw-q.q2{animation:cwQR 6s ease-in-out infinite}" +
      "@keyframes cwQL{0%,15%{opacity:0;transform:translate(-6px,6px) scale(.5)}20%,30%{opacity:1;transform:translate(-8px,-2px) scale(1)}35%,100%{opacity:0;transform:translate(-8px,-8px) scale(1.2)}}" +
      "@keyframes cwQR{0%,50%{opacity:0;transform:translate(16px,6px) scale(.5)}55%,65%{opacity:1;transform:translate(18px,-2px) scale(1)}70%,100%{opacity:0;transform:translate(18px,-8px) scale(1.2)}}" },

  { id:"happy", cap:"Claude’s pretty pleased with that",
    behind:'<g class="cw-sp" fill="#ffd700"><rect x="-4" y="-2" width="1.4" height="1.4"/></g><g class="cw-sp sp2" fill="#ffa000"><rect x="18" y="-4" width="1.4" height="1.4"/></g><g class="cw-sp sp3" fill="#fff59d"><rect x="19" y="9" width="1.4" height="1.4"/></g><g class="cw-sp sp4" fill="#ffc107"><rect x="-5" y="11" width="1.4" height="1.4"/></g><g class="cw-sp sp5" fill="#fff59d"><rect x="7" y="-8" width="1.4" height="1.4"/></g>',
    front:"",
    css:
      ".clawd-stage .cw--happy .cw-rig{transform-origin:7.5px 15px;animation:cwBounce 1s ease-in-out infinite}" +
      "@keyframes cwBounce{0%,15%,100%{transform:translateY(0) scaleY(1)}20%{transform:translateY(0) scaleY(.85)}40%{transform:translateY(-9px) scaleY(1.05)}50%{transform:translateY(-11px) scaleY(1)}60%{transform:translateY(-9px) scaleY(1.05)}80%{transform:translateY(0) scaleY(.85)}85%{transform:translateY(0) scaleY(1)}}" +
      ".clawd-stage .cw--happy .cw-arm-l{transform-origin:2px 10px;animation:cwHapL .15s ease-in-out infinite alternate}" +
      ".clawd-stage .cw--happy .cw-arm-r{transform-origin:13px 10px;animation:cwHapR .15s ease-in-out infinite alternate}" +
      "@keyframes cwHapL{0%{transform:rotate(45deg)}100%{transform:rotate(85deg)}}" +
      "@keyframes cwHapR{0%{transform:rotate(-45deg)}100%{transform:rotate(-85deg)}}" +
      ".clawd-stage .cw--happy .cw-sp{opacity:0;animation:cwSpark 1.5s step-end infinite}" +
      ".clawd-stage .cw--happy .cw-sp.sp2{animation-delay:.3s}.clawd-stage .cw--happy .cw-sp.sp3{animation-delay:.6s}.clawd-stage .cw--happy .cw-sp.sp4{animation-delay:.9s}.clawd-stage .cw--happy .cw-sp.sp5{animation-delay:1.2s}" +
      "@keyframes cwSpark{0%{opacity:0}12%{opacity:1}30%{opacity:0}100%{opacity:0}}" },
];

// Assemble the full stylesheet (base + every scene) once.
export const CW_CSS = CW_BASE + CW_SCENES.map(function (s) { return s.css; }).join("");

// Build one scene's SVG: shadow + behind props + shared rig + front props.
export function cwSceneSVG(scene: ClawdScene): string {
  return '<svg class="cw cw--' + scene.id + '" viewBox="-7 -12 30 30" aria-hidden="true">' +
    '<rect class="cw-shadow" x="3" y="15" width="9" height="1"/>' +
    scene.behind + CW_RIG + scene.front +
    '</svg>';
}

// Inject the library CSS once, then mount a scene (random unless pinned).
let clawdCssInjected = false;
function ensureClawdCss(): void {
  if (clawdCssInjected) return;
  const st = document.createElement("style");
  st.id = "clawd-css";
  st.textContent = CW_CSS;
  document.head.appendChild(st);
  clawdCssInjected = true;
}

/** Render one scene wrapped in its .clawd-stage scope (string form). */
export function clawdStageHTML(sceneId?: string): string {
  const s = sceneId
    ? (CW_SCENES.find((x) => x.id === sceneId) ?? CW_SCENES[0])
    : CW_SCENES[Math.floor(Math.random() * CW_SCENES.length)];
  return `<div class="clawd-stage">${cwSceneSVG(s)}</div>`;
}

/** Mount a fresh clawd into `el`. A new random pose each call keeps idle surfaces
 *  feeling alive without any timer (re-entering the surface re-rolls). */
export function mountClawd(el: HTMLElement, sceneId?: string): void {
  ensureClawdCss();
  el.innerHTML = clawdStageHTML(sceneId);
}
