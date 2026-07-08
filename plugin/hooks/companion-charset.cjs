#!/usr/bin/env node
// companion-charset.cjs — guarantee an artifact carries the `<meta charset="utf-8">` label.
//
// WHY this exists: artifact tiles render in a WebView over the `asset://` protocol, whose
// response carries no charset. With no `<meta charset>` in the file either, the WebView
// falls back to a legacy 8-bit encoding (Windows-1252) and mis-decodes valid UTF-8 — every
// em-dash / curly-quote becomes mojibake (`â€"`). The file is CORRECT UTF-8; only the decode
// LABEL is missing. The deterministic renderer that authored artifacts before 0.4.5 always
// wrote the label; inline agent-authoring can forget it, so this is the write-time safety net
// (called from companion-index.cjs on every artifact `Write|Edit`). Deterministic, like the
// old renderer — not left to guidance, which is probabilistic.
//
// Idempotent: a no-op when the label is already present. Standards-mode safe: inserts inside
// an existing `<head>` when there is one, else after a leading `<!doctype>`, else prepends a
// minimal `<!doctype html>` + meta so the label lands in the first bytes without forcing
// quirks mode. Pure string→string; the caller owns file I/O and fail-safety.

const META = '<meta charset="utf-8" />';

function ensureArtifactCharset(html) {
  if (typeof html !== "string" || html.length === 0) return html;
  if (/<meta\s+charset/i.test(html)) return html; // already labeled → no-op

  const head = html.match(/<head[^>]*>/i);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + "\n  " + META + html.slice(at);
  }

  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) {
    const at = doctype.index + doctype[0].length;
    return html.slice(0, at) + "\n" + META + html.slice(at);
  }

  return "<!doctype html>\n" + META + "\n" + html;
}

module.exports = { ensureArtifactCharset };
