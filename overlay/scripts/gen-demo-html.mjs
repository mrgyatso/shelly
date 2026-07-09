/* =============================================================================
   Generate `demo.html` from `index.html`.

   The demo IS the real shell — so we derive it rather than copy it, and the only
   structural change is swapping the bundle entry for the mock-installing one.
   Every substitution asserts its anchor, so a drifting index.html fails the build
   loudly instead of silently shipping a stale demo.
   ============================================================================= */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The two places a demo visitor should be able to go next. */
const GITHUB_URL = "https://github.com/mrgyatso/claude-code-companion";
const PORTFOLIO_URL = "https://aletheia.dev";
const PORTFOLIO_LABEL = "aletheia.dev";

/** Replace `find` in `src` exactly once, or die naming the anchor. */
function swap(src, find, replace, label) {
  const hits = src.split(find).length - 1;
  if (hits !== 1) {
    throw new Error(
      `gen-demo-html: expected exactly 1 "${label}" anchor in index.html, found ${hits}.\n` +
        `index.html changed — update scripts/gen-demo-html.mjs to match.`,
    );
  }
  return src.replace(find, replace);
}

let html = readFileSync(resolve(root, "index.html"), "utf8");

html = swap(
  html,
  '<script type="module" src="/src/main.ts" defer></script>',
  '<script type="module" src="/dev/demo-boot.ts"></script>',
  "bundle entry",
);

html = swap(html, "<title>Companion Overlay</title>", "<title>Companion — recorded demo</title>", "title");

// The real window is transparent + rounded; in a browser give the page the same
// dark letterboxing the stage sits on, so the rounded corners read like the app.
// Inline SVG favicon: no extra request, and no 404 on a public link.
const FAVICON =
  `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>` +
  `<rect width='100' height='100' rx='22' fill='%23cc785c'/>` +
  `<text x='50' y='72' font-size='64' font-family='Georgia,serif' fill='%23fdf7ef' text-anchor='middle'>C</text></svg>`;

const DEMO_HEAD = `
    <meta name="description" content="Companion turns Claude Code's output into artifacts you can act on. A recorded, clickable demo of the Board." />
    <link rel="icon" href="${FAVICON}" />
    <style>
      html, body { background: #3a3632 !important; }

      /* The Board is a desktop surface. Rather than let a phone render it badly,
         say so — a broken first impression is worse than an honest one. */
      #demo-narrow { display: none; }
      @media (max-width: 900px) {
        #board-stage, .dragbar, .controls { display: none !important; }
        #demo-narrow {
          display: grid; place-content: center; gap: 14px;
          position: fixed; inset: 0; padding: 32px; text-align: center;
          background: #3a3632; color: #e8e2d9;
          font-family: Georgia, "Times New Roman", serif;
        }
        #demo-narrow b { font-size: 21px; font-weight: 500; letter-spacing: -0.01em; }
        #demo-narrow span {
          font-family: ui-monospace, Menlo, monospace; font-size: 12px;
          line-height: 1.65; color: #a49b8e; max-width: 34ch; margin: 0 auto;
        }
      }

      /* Unobtrusive, dismissible: visitors should know nothing here calls a model. */
      #demo-badge {
        position: fixed; left: 16px; bottom: 14px; z-index: 9999;
        display: flex; align-items: center; gap: 9px;
        padding: 7px 10px 7px 12px; border-radius: 999px;
        background: rgba(20, 17, 14, 0.72); border: 1px solid rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(8px);
        font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: #b9b0a4;
      }
      #demo-badge b { color: #e0d7ca; font-weight: 500; }
      #demo-badge button {
        all: unset; cursor: pointer; padding: 0 3px; color: #7d7568; line-height: 1;
      }
      #demo-badge button:hover { color: #e0d7ca; }
      @media (max-width: 900px) { #demo-badge { display: none; } }

      /* The two places a visitor should be able to go next: the source, and the
         person who built it. Mirrors the demo pill, opposite corner. */
      #demo-links {
        position: fixed; right: 16px; bottom: 14px; z-index: 9999;
        display: flex; align-items: center; gap: 4px;
        padding: 5px; border-radius: 999px;
        background: rgba(20, 17, 14, 0.72); border: 1px solid rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(8px);
      }
      #demo-links a {
        display: inline-flex; align-items: center; gap: 7px;
        padding: 7px 13px; border-radius: 999px; text-decoration: none;
        font-family: ui-monospace, Menlo, monospace; font-size: 11.5px;
        color: #cdc4b7; transition: background 140ms ease, color 140ms ease;
      }
      #demo-links a:hover { background: rgba(255, 255, 255, 0.1); color: #fff; }
      #demo-links a.primary { background: #cc785c; color: #fff; }
      #demo-links a.primary:hover { background: #d98a70; color: #fff; }
      #demo-links svg { width: 15px; height: 15px; flex: 0 0 auto; }
      #demo-links .sep { width: 1px; height: 17px; background: rgba(255, 255, 255, 0.14); }
      @media (max-width: 900px) { #demo-links { display: none; } }
    </style>`;

html = swap(html, "  </head>", `${DEMO_HEAD}\n  </head>`, "head close");

const DEMO_BODY = `
    <div id="demo-narrow">
      <b>Companion is a desktop surface.</b>
      <span>This demo needs a wider screen. Open it on a laptop to click through the board.</span>
    </div>
    <div id="demo-badge">
      <b>Recorded demo</b> <span>— not connected to a model</span>
      <button type="button" title="Dismiss" onclick="this.parentElement.remove()">✕</button>
    </div>
    <div id="demo-links">
      <a class="primary" href="${GITHUB_URL}" target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 012-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        <span>Source on GitHub</span>
      </a>
      <span class="sep"></span>
      <a href="${PORTFOLIO_URL}" target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.6"/><path d="M1.6 8h12.8M8 1.4a10 10 0 010 13.2M8 1.4a10 10 0 000 13.2"/></svg>
        <span>${PORTFOLIO_LABEL}</span>
      </a>
    </div>
  </body>`;

html = swap(html, "  </body>", DEMO_BODY, "body close");

writeFileSync(resolve(root, "demo.html"), html);
console.log("gen-demo-html: wrote demo.html");
