# Companion Artifact Protocol — Spec

**Status:** proposal for owner review. Nothing here is built yet.
**Decision being formalized:** separate the *contract* (a 2-message protocol) from the
*implementation* (the ~150-line helper). Ship the helper as a **host-injected default**,
with a bespoke opt-out. This kills the "dead button" failure class (~50% of artifacts ship
broken interactivity today because the LLM pastes the helper wrong, or CSP/sandbox blocks it).

---

## 0. Why today is fragile (grounding)

Every interactive artifact must physically inline the unified helper from
`plugin/skills/prefer-html/SKILL.md:111-285` (ambient comments + ✓/✎/✗ review form +
submit), pasted verbatim by the model. That helper is **not load-bearing** — it is just a
generator of two `postMessage` calls. What the overlay actually listens for is tiny:

- a **size** report (`overlay/src/resize.ts:35-40`, listener `:197-205`)
- a **submit** payload (`overlay/src/resize.ts:42-46`, handled in `overlay/src/submit.ts`)

If those two messages arrive, the artifact works. If the helper is mis-pasted, the buttons
are dead. The fix is to stop trusting the model to carry the implementation and instead have
the **host inject one canonical helper into the HTML bytes** before the sandboxed iframe
parses them.

---

## 1. The 2-message protocol (the entire host↔artifact contract)

Both messages are `window.postMessage(payload, "*")` from the artifact iframe up to the
overlay parent. The overlay's single listener is `initFit()` in
`overlay/src/resize.ts:197-205`.

| Direction | `kind` | Payload | When fired | Host action |
|---|---|---|---|---|
| artifact → host | `"size"` | `{ source:"companion-artifact", kind:"size", w:number, h:number }` | On `load` and on every `ResizeObserver` callback of `[data-fit-root]` (SKILL.md:367-378). **Mandatory** — the iframe is sandboxed `allow-scripts` *without* `allow-same-origin`, so it is opaque-origin and the parent **cannot measure it** (resize.ts:6-10). | `fit()` clamps to monitor work area and animates the window (resize.ts:157-175). |
| artifact → host | `"submit"` | `{ source:"companion-artifact", kind:"submit", text:string }` | On the user's Submit / "Do all" click, after the helper compiles comments + decisions into prose. | `handleSubmit(text)` appends the artifact's own file path and writes to the system clipboard, then shows a toast (submit.ts:11-25). |

**Validation, not origin.** Messages are matched by structural type-guards
(`isFitMessage` resize.ts:53-62, `isSubmitMessage` :64-72): `source === "companion-artifact"`
plus the right `kind` and field types. There is **deliberately no `e.origin` check** — a
sandboxed iframe has an opaque (`"null"`) origin, so an origin check is impossible and
unnecessary (the iframe can only reach *its* parent).

**Extensible by construction.** The listener is an `if / else if` on the two type-guards;
**unknown kinds fall through and are silently dropped** (resize.ts:198-204, and the doc
comment at :187-196). Artifact authors may use their own internal `postMessage` traffic
without the overlay mistaking it for protocol — and future kinds (e.g. `"return"`,
`"copy"`) can be added without breaking existing artifacts.

**Submit return-path caveat (see §4).** Today `submit` terminates at the local clipboard
(submit.ts:19). A remote/async agent has no terminal to ⌘V into; §4 defines the hub return
mechanism for that case.

---

## 2. Two tiers

### Tier 1 — default (~90% of artifacts)

The artifact uses the standard DOM markers and **ships no helper JS at all**:

- `data-fit-root` — the sized wrapper
- `data-companion-commentable` / `data-companion-block` — ambient-comment regions
- `data-companion-item` + `data-item-label` — review rows
- `data-companion-submit` — the submit button
- `companion-meta` — the metadata block (subject/summary/files/project/branch/created)

The **host injects the one canonical helper** (the unified script currently at
SKILL.md:111-285, plus the size-reporter at SKILL.md:367-378). Because there is exactly one
implementation and the model never hand-copies it, the dead-button class is eliminated. The
SKILL.md template for Tier 1 collapses to *markers + content* — no `<script>` blocks.

### Tier 2 — bespoke (opt-out)

The artifact sets `data-companion-custom` on `<html>` (or `<body>`) and ships **its own JS**,
building any UI it wants — a dashboard, a data viz, a custom editor. The host injects **only
the universal size-reporter** (so the window still fits). The single requirement to talk back
to the overlay is to **speak the 2 messages** of §1 — i.e. `postMessage` a `size` and
(optionally) a `submit`. Nothing else is imposed.

> The size-reporter is the one thing Tier 2 cannot easily opt out of without breaking
> windowing — see Open Question Q4 on whether to *always* inject it regardless of tier.

---

## 3. Host injection at the serve/load boundary (the crux)

The artifact runs in a **sandboxed `allow-scripts`, no-`allow-same-origin` iframe**
(main.ts:31-38). The parent **cannot reach into it at runtime** (opaque origin, no shared
DOM). Therefore injection must happen in the **HTML bytes, before the iframe parses them.**
There are two serve boundaries: the local auto-pop path and the hub path.

### 3a. Local auto-pop path (the trap — read carefully)

**There is no single byte-processing chokepoint today, and the one function that reads bytes
feeds the branch that cannot run them.** Two facts from the code:

1. **The common (asset:) branch never reads bytes in app code.** When
   `artifact_in_scope` is true — and it is for the common case, since `assetProtocol.scope`
   includes `$HOME/**` (tauri.conf.json:18-28) — `loadArtifact` sets
   `frame.src = convertFileSrc(path)` (main.ts:62-67) and **Tauri's built-in asset protocol
   streams the file straight off disk.** `read_artifact` (artifact.rs:68-83) is invoked
   **only** on the `else` / srcdoc branch (main.ts:68-71). Splicing the helper into
   `read_artifact` would touch only the rare out-of-scope case.

2. **The srcdoc branch can't execute injected JS anyway.** `tauri.conf.json:17` sets
   `script-src 'self'`, and `about:srcdoc` **inherits** the overlay's CSP (the comment at
   main.ts:37-38 says exactly this). So even if you splice the helper into the srcdoc bytes,
   it is dead — inline JS will not run.

Conclusion: the naive "splice in `read_artifact`" is wrong on both counts. Two real options:

#### Option A (recommended) — custom URI-scheme handler that *both* branches route through

Register a custom async URI scheme (e.g. `companion-artifact://`) on the Tauri builder. The
builder chain lives in `overlay/src-tauri/src/lib.rs:65` (`tauri::Builder::default()`,
running through `.run(` at lib.rs:291); add
`.register_asynchronous_uri_scheme_protocol("companion-artifact", …)` to that chain. The
handler:

1. resolves the artifact path from the request URL,
2. reads the bytes (reusing the logic in `artifact.rs:read_artifact`),
3. runs the **idempotent splice** of §5 (insert the helper `<script>` immediately before
   `</body>`, or append if absent),
4. returns the response with a **permissive `Content-Security-Policy` header on the artifact
   response itself** (e.g. `script-src 'unsafe-inline'`) so the injected inline JS runs —
   this is the response's own CSP, independent of the overlay window's `script-src 'self'`.

The frontend change lands in `main.ts:62-72`: replace the `convertFileSrc(path)` /
`srcdoc` fork with a single `frame.src = "companion-artifact://localhost/?path=" +
encodeURIComponent(path) + "&_=" + Date.now()`. This **collapses the asset:/srcdoc fork into
one hook** *and* fixes the "srcdoc can't run JS" problem, because the artifact now loads as a
real document served by our scheme with its own CSP — not via `about:srcdoc`.

**Parent-window CSP wiring (do not miss):** the overlay window's `frame-src` must permit the
new scheme or the iframe loads as a blank panel. tauri.conf.json:17 currently has
`frame-src 'self' asset: http://asset.localhost`; add `companion-artifact:` (and/or
`http://companion-artifact.localhost`, depending on how Tauri normalizes the custom scheme on
this platform) to it.

- **Pros:** one chokepoint for *all* artifacts (in-scope and out-of-scope); fixes the dead
  out-of-scope/srcdoc branch as a bonus; the helper is never in the file on disk.
- **Cons:** new scheme handler + capability wiring; the artifact's own inline JS (Tier 2)
  now also runs under the response CSP we choose — pick it deliberately (Q1).

#### Option B — processed temp copy

In Rust, read the artifact bytes, run the §5 splice, write the processed copy to `$TEMP`
(already inside `assetProtocol.scope`, tauri.conf.json:23), and point the iframe at the temp
file via the existing `asset:` path. Smaller change to the load path; no new scheme.

- **Pros:** minimal frontend change; reuses the working asset: branch.
- **Cons:** leaves a temp-file lifecycle to manage (creation, cache-busting, cleanup on
  close/refresh); two files on disk per artifact; does not fix the out-of-scope/srcdoc case.

**Where the splice helper lives in code (both options):** a single Rust function, e.g.
`inject_helper(html: &str) -> String`, called from the scheme handler (A) or before the temp
write (B). It implements §5's detection + splice.

### 3b. Hub path (mechanical, easy)

`GET /api/artifacts/<slug>` is served by `get_artifact` in `hub/src/main.rs:130-135`, which
already reads the **full bytes** via `data::read_artifact` (`hub/src/data.rs:223-227`) and
returns them as `text/html; charset=utf-8`. **Splice the helper before `</body>` right
there**, in `get_artifact`, before building the response — same idempotent
`inject_helper(...)` from §5. No CSP concern on the hub: the bytes are served as a top-level
document over HTTP to the hub's same-origin web UI / the overlay's pull loop, which then
re-writes them locally (see §5's double-injection note).

---

## 4. Async-remote return path for `submit`

A finished remote agent (a cron/morning-brief on the VPS) has **no terminal to ⌘V into** —
the local clipboard endpoint (submit.ts:19) is useless to it. Define a hub return channel,
fitted to the existing axum router and bearer auth.

### Route shape

Add to the **authed** router in `hub/src/main.rs:54-58` (it inherits the bearer gate from
the `auth` middleware at main.rs:89-101 for free):

```
POST /api/return        body: { "artifact": "<slug>", "source": "<who>", "text": "<payload>" }
GET  /api/return?artifact=<slug>      → newest return(s) for that slug, or {} 
```

### Storage

Add `returns_dir` to `Config` (`hub/src/config.rs`), default `data_dir.join("returns")`
(i.e. `~/.claude/companion/returns/`). Persist each POST as a JSON file keyed by
`<slug>__<epoch_ms>.json` (reuse `safe_slug` from data.rs:45-57 to keep slugs filesystem-safe
— same guard already used for artifacts). `GET /api/return` reads them newest-first (mirror
`newest_json` data.rs:71-87).

### Who POSTs (the design choice — pin it, don't leave implicit)

The artifact iframe is sandboxed and **does not know the hub URL or token**, so the *artifact*
cannot POST. Two realistic callers:

1. **The hub's own same-origin web UI.** The injected helper running inside the hub-served
   page (3b) is same-origin with the hub, so its Submit handler can `fetch("/api/return", …)`
   with the bearer token the web UI already holds. This is the primary path for "user reacts
   to a remote agent's artifact in the browser."
2. **The local overlay, opportunistically.** When a hub is configured, the overlay holds the
   token in `HubConfig` (hub.rs:27-37). `handleSubmit` (submit.ts) could *also* POST the
   compiled text to `{hub}/api/return` alongside the clipboard write — so feedback the user
   gives locally still reaches the remote agent.

### How the agent's next run reads it

The remote agent's **next scheduled run** calls `GET /api/return?artifact=<slug>` (bearer
token) and ingests any pending feedback before doing its work — closing the loop without a
live terminal. (The existing pull loop, hub.rs:161-226, already proves the offsite→hub→client
pattern; this is the reverse direction over the same auth.)

---

## 5. Migration & backward-compat (idempotent injection)

~91 existing artifacts **already inline the helper**. Injection must be **additive / no-op**
when the artifact already defines the handlers, or we get a double helper → double submit →
**racing clipboard writes** (the exact hazard submit.ts and SKILL.md:271-281 already fight,
where a path-less copy can win the race).

### Detection rule (must be byte-scannable)

We cannot detect a live JS listener by reading bytes. Use a **whitespace-tolerant sentinel
scan** in `inject_helper(html)`. A fixed substring is the wrong primitive: the legacy
artifacts were hand-pasted by an LLM and are **not byte-identical** — the object is written
`kind: "submit"` (with a space) in most, `kind:"submit"` in a few, and sometimes spread
across lines. Match on a regex, not a literal:

```
inject the full Tier-1 submit helper  ⇔  the bytes match NEITHER:
    - /data-companion-custom/                  (Tier-2 opt-out marker)
    - /kind\s*:\s*["']submit["']/              (an inlined helper already posts submit)
```

**`data-companion-submit` MUST NOT influence the skip decision.** Tier-1 new artifacts
legitimately carry the submit *button marker* with no helper *code*; keying on the marker
would wrongly skip them and leave their buttons dead. Only helper-code presence
(`kind:"submit"` regex) and the explicit `data-companion-custom` opt-out gate injection.

- **Legacy artifacts:** every submit-capable one matches `/kind\s*:\s*["']submit["']/` →
  matches the skip condition → **full helper not injected** → no double submit. ✔
- **New Tier-1 artifacts:** carry the button marker but **no** helper code (no `kind:"submit"`
  regex hit) and no `data-companion-custom` → helper **is** injected.
- **Tier-2 artifacts:** carry `data-companion-custom` → full helper skipped; only the
  size-reporter is injected (§2), itself guarded the same way (skip if `/kind\s*:\s*["']size["']/`
  already present).

**Verification step (run before trusting the rule).** Confirm the regex actually covers the
on-disk corpus:

```
grep -rlE 'kind\s*:\s*["'\'']submit["'\'']' ~/.claude/companion/artifacts/ | wc -l
```

Empirically (run 2026-06-10 against the live artifacts dir, 24 files): the
whitespace-tolerant regex matches **18/18** submit-capable artifacts, whereas the naive
no-space literal `kind:"submit"` matches only **3/18** — i.e. a fixed literal would
double-inject 15 of 18 and reintroduce the racing-clipboard bug this section exists to
prevent. The regex is load-bearing; do not regress it to a substring.

### Asymmetry to exploit

- A **double `size` report is benign** — `fit()` has an echo guard that ignores reports
  resolving to ~the same size (resize.ts:161-169). So a stray duplicate size-reporter is
  harmless.
- A **double `submit` is the harmful one** — two compiled payloads race the clipboard. The
  detection rule above must be airtight specifically for the submit helper.

### Double-injection across the two hooks (the §3↔§5 bridge)

Hub-pulled artifacts are written to `~/.claude/companion/remote/` (hub.rs:209) and **then
opened via the local path** (hub.rs:218 → `open_artifact_window`). `remote/` is under
`$HOME/.claude/companion/**` → **in asset scope** → it hits the **local** injection (§3a)
*after* already having been injected by the **hub** (§3b). This is precisely *why* the splice
is idempotent: the local pass scans bytes that already contain `kind:"submit"` (just injected
by the hub) and **skips**. The idempotency rule is not an afterthought — it is the mechanism
that makes the two-hook design safe.

---

## 6. Open questions / risks (owner to decide)

1. **Local injection: Option A (custom scheme) vs Option B (temp copy).** A is the cleaner
   end-state (one chokepoint, fixes the dead srcdoc branch) but more wiring + forces a
   deliberate response-CSP choice that also governs Tier-2's own inline JS. B is smaller but
   leaves a temp-file lifecycle and doesn't fix out-of-scope artifacts. **Recommend A.**

2. **Standalone-browser artifacts lose injected interactivity.** When a Tier-1 artifact is
   opened directly in a browser (not via the overlay or hub), nothing injects the helper — so
   its buttons are dead *there*. Today's inline helper "just works" in a browser. Decide:
   accept this (Companion artifacts are overlay-first), or keep a minimal inline fallback for
   Tier-1, or have the SKILL emit the helper only when the author marks "must work standalone."

3. **Response CSP for the injected scheme (Option A).** What exactly should the artifact
   response's `Content-Security-Policy` be? Loose enough that injected + Tier-2 inline JS runs,
   tight enough to keep the sandbox meaningful (artifacts are still origin-less and IPC-less,
   but a permissive `connect-src` could let a hostile artifact phone home). Pin the header.

4. **Always inject the size-reporter, even for Tier-2?** A Tier-2 artifact that forgets to
   report size leaves the window stuck at the fallback dimensions (resize.ts:22-26, 182-185).
   Always-injecting the size-reporter guarantees windowing but risks a double `size` report if
   Tier-2 also reports — benign per §5's echo guard, but worth an explicit yes/no.

5. **Helper versioning.** Once the helper is host-injected, its version is the *overlay's*
   version, not the artifact's. A new overlay can fix every old Tier-1 artifact for free
   (upside) — but a behavior change could alter how an *old* artifact submits. Decide whether
   injected-helper changes need a compatibility note / version stamp in the payload.

6. **Where does `inject_helper` source the canonical helper text?** Embedded as a Rust
   `const` string in both binaries (overlay + hub), or a shared file? Duplication mirrors the
   existing deliberate hub/overlay logic duplication (data.rs:1-8 notes this is intentional to
   keep the hub Tauri-free), so a `const` in each is consistent — but the helper then has two
   copies to keep in sync. Decide the single source of truth.
