/**
 * Unit checks for the curated SHELL REPAINT pure logic (src/shell-repaint.ts):
 * curated-set validation (incl. case-insensitivity + off-palette rejection),
 * ink fallback, and the same-color / reset transition rules. DOM-free; run with
 * `npm test` (node --experimental-strip-types).
 */

import {
  resolveShell,
  isShellMessage,
  nextShellAction,
  APP_SHADE,
  type ShellColors,
  type ShellState,
} from "../src/shell-repaint.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log("  ok  " + msg);
  } else {
    fail++;
    console.log("  FAIL " + msg);
  }
}

console.log("\n### curated-set validation");
{
  const paper = resolveShell("#FBFAF6");
  ok(paper?.bg === "#FBFAF6" && paper?.ink === "#171A1F", "paper resolves to its curated pair");

  const slate = resolveShell("#E7ECF1");
  ok(slate?.bg === "#E7ECF1" && slate?.ink === "#1B2530", "slate resolves to its curated pair");

  ok(resolveShell("#E6F1EA")?.ink === "#16281F", "mint has its curated ink");
  ok(resolveShell("#F3E7DF")?.ink === "#2A1C14", "clay has its curated ink");
  ok(resolveShell("#14181D")?.ink === "#E8EDF3", "ink shell is dark bg with light ink");
}

console.log("\n### case-insensitivity");
{
  ok(resolveShell("#e7ecf1")?.bg === "#E7ECF1", "lowercase bg still resolves (canonical case returned)");
  ok(resolveShell("#e6F1eA")?.bg === "#E6F1EA", "mixed case bg resolves");
  ok(resolveShell("  #FBFAF6  ")?.bg === "#FBFAF6", "surrounding whitespace is trimmed");
}

console.log("\n### off-palette + junk rejection");
{
  ok(resolveShell("#FFFFFF") === null, "a valid but off-palette color is ignored");
  ok(resolveShell("#123456") === null, "arbitrary hex is ignored");
  ok(resolveShell("red") === null, "named colors are ignored");
  ok(resolveShell("") === null, "empty string is ignored");
  ok(resolveShell(undefined) === null, "undefined is ignored");
  ok(resolveShell(42) === null, "non-string is ignored");
  ok(resolveShell("#E7ECF1; background:url(x)") === null, "an injection-y string is ignored (never interpreted)");
}

console.log("\n### ink fallback — message ink is never trusted");
{
  // resolveShell ignores any caller-supplied ink; the curated ink always wins,
  // which IS the "ink missing/wrong → curated ink" rule.
  const s = resolveShell("#E7ECF1");
  ok(s?.ink === "#1B2530", "a curated bg always yields the curated ink regardless of any provided ink");
}

console.log("\n### message type guard");
{
  ok(isShellMessage({ source: "shelly-artifact", kind: "shell", bg: "#E7ECF1" }), "well-formed shell message accepted");
  ok(isShellMessage({ source: "shelly-artifact", kind: "shell", bg: "#E7ECF1", ink: "#1B2530" }), "ink is optional");
  ok(!isShellMessage({ source: "shelly-artifact", kind: "size", w: 1, h: 1 }), "a size message is not a shell message");
  ok(!isShellMessage({ source: "evil", kind: "shell", bg: "#E7ECF1" }), "wrong source rejected");
  ok(!isShellMessage({ source: "shelly-artifact", kind: "shell" }), "missing bg rejected");
  ok(!isShellMessage(null), "null rejected");
  ok(!isShellMessage("shell"), "string rejected");
}

console.log("\n### transition rules — same-color no-op + reset");
{
  const slate: ShellColors = { bg: "#E7ECF1", ink: "#1B2530" };
  const mint: ShellColors = { bg: "#E6F1EA", ink: "#16281F" };
  const DEFAULT: ShellState = null;

  // default → shell: animate, commit the shell state.
  const a = nextShellAction(DEFAULT, slate);
  ok(a !== null && a.state === "#E7ECF1" && a.colors === slate, "default → slate transitions");

  // consecutive SAME shell: no-op (do not re-animate).
  ok(nextShellAction("#E7ECF1", slate) === null, "slate → slate is a no-op");

  // shell → different shell: animate.
  const b = nextShellAction("#E7ECF1", mint);
  ok(b !== null && b.state === "#E6F1EA", "slate → mint transitions");

  // shell → default (reset): animate back to app shade, state becomes null.
  const c = nextShellAction("#E7ECF1", null);
  ok(c !== null && c.state === null && c.colors === null, "slate → default (reset) transitions");

  // default → default: no-op (a plain artifact after a plain artifact).
  ok(nextShellAction(DEFAULT, null) === null, "default → default is a no-op");
}

console.log("\n### constants");
{
  ok(APP_SHADE === "oklch(0.945 0.014 60)", "app shade matches the Board default surface token");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
