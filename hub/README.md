# Shelly Hub — connect your agents

A small self-hosted HTTP server that lets **remote autonomous agents** (Hermes
crons, OpenClaw-style gateways, bare scripts — anything that can write a file or
POST JSON) surface their work on the Shelly Board and **receive your replies
back**. Self-hosted by design: no accounts, no central service, one shared
bearer token. Run it wherever your agents live (a VPS, a home server) and point
the overlay at it.

```
agent writes artifact ──► hub serves it ──► overlay pulls ──► Board renders it
you reply on the Board ──► overlay POSTs ──► hub inbox ──► agent is woken/queued
```

## Run it

```sh
cargo build --release
SHELLY_HUB_BIND=<tailscale-ip> ./target/release/shelly-hub
```

First run generates + persists a token (`~/.shelly/hub-token`, 0600)
and prints the pairing line. On the Mac: `shelly hub set <url> <token>`
(or write `~/.shelly/hub.json`). Binding a tailnet IP is the intended
security posture — the hub retries the bind for ~5 minutes so it survives
racing tailscale0 at boot.

Env knobs: `SHELLY_HUB_BIND`, `SHELLY_HUB_PORT` (8787),
`SHELLY_HUB_TOKEN`, `SHELLY_HUB_DATA_DIR` (`~/.shelly`),
`SHELLY_HUB_WEBUI_DIR`.

## The agent contract

An agent's **id** is one slug used in three places — that's the whole identity
scheme (no second derivation):

1. its live file: `live/<id>.json`
2. its artifacts' metadata: `shelly-meta.project == "<id>"`
3. its registry card: `agents/<id>.json`

### 1. Publish work

Write the same Shelly surfaces a local agent writes, under the hub's data
dir (`~/.shelly/` on the hub machine):

- **Live state** — `live/<id>.json`:
  `{"working":"…","where":["…"],"next":[{"title":"…","sub":"…","kind":"todo|decision|blocked"}],"project":"<id>"}`
- **Artifacts** — `artifacts/<slug>.html`, self-contained, with a
  `shelly-meta` block in `<head>` carrying `"project":"<id>"` and one
  `data-fit-root` wrapper with a definite width (see the prefer-html skill for
  the size-reporter snippet).

Co-located agents just write files. Remote agents can `GET/PUT` the same shapes
over the token-gated API.

### 2. Register (one PUT — this is "connecting")

```sh
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  $HUB/api/agents/<id> -d '{
    "name": "Hermes", "emoji": "🪽",
    "tagline": "Morning briefs, task triage",
    "capabilities": ["morning-brief"],
    "wake": ["/home/me/.shelly/bin/hermes-wake.sh"]
  }'
```

A registered agent appears on the Board's **Agent Hub** room immediately — its
own unit with name, emoji, liveness (from the live file + artifact mtimes), and
its current `working` line — even before its first artifact.

### 3. Receive replies

When you answer an agent's artifact on the Board (✓ do / ✎ note / ✗ skip +
Submit), the overlay POSTs the compiled reply to `POST /api/inbox/<id>`. The
hub **stores the envelope first** (`inbox/<id>/<ts>.json`), then:

- **wake set** → spawns your `wake` argv detached, with the envelope path
  appended. Your script processes it and deletes the file to ack (a failed wake
  leaves it queued — a reply can never be lost).
- **no wake** → the envelope queues; read `inbox/<id>/` at the start of your
  next scheduled run (or poll `GET /api/inbox/<id>` + `DELETE
  /api/inbox/<id>/<envelope-id>` from another machine).

Envelope shape:

```json
{ "id": "…", "agent": "<id>", "received_ms": 0,
  "payload": { "kind": "artifact-reply", "artifact": "<file>", "title": "…",
               "text": "✓ do: …\n✎ note: …", "sent_ms": 0 } }
```

**Trust note:** the `wake` argv is arbitrary command execution on the hub
machine, settable by anyone holding the bearer token. That is the hub's
existing trust boundary (the token already gates everything); don't share the
token with agents you wouldn't hand a shell.

## API

| Route | Method | What |
|---|---|---|
| `/api/health` | GET | unauthenticated reachability probe |
| `/api/live[?project=<id>]` | GET | newest (or named) live state |
| `/api/artifacts` / `/api/artifacts/:slug` | GET | manifest / raw HTML |
| `/api/agents` / `/api/agents/:id` | GET | registry merged with liveness |
| `/api/agents/:id` | PUT | register / update an agent |
| `/api/inbox/:agent` | POST | queue a reply envelope (+ wake) |
| `/api/inbox/:agent` | GET | pending envelopes, oldest first |
| `/api/inbox/:agent/:id` | DELETE | ack one envelope |
| `/api/routines` / `/api/routines/:id` | GET/PUT | file-backed checkoff state |

Everything but `/api/health` requires `Authorization: Bearer <token>`.
