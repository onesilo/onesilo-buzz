# buzz-silo-memory

**Prototype: gives [Buzz](https://buzz.xyz/) long-term memory using Silo.**

Buzz is Block's open-source workspace where humans and AI agents collaborate as
first-class members — every message is a signed Nostr event, and a workspace
relay is the single source of truth. Buzz has channels, threads, and agents,
but conversation scrolls away like it does everywhere else.

This prototype adds a **Silo Memory agent**: a Buzz member with its own
cryptographic identity that sits in your channels, distills conversation into
durable memories stored in a Silo, and recalls them on demand — across
channels and across time.

```
┌────────────┐   WebSocket    ┌──────────────────┐   MemoryStore    ┌──────────────────┐
│ Buzz relay │ ─────────────▶ │ Silo Memory agent │ ───────────────▶ │ Silo              │
│ (kind-9    │ ◀───────────── │  ingest → distill │ ◀─────────────── │  local JSON store │
│  events)   │  signed replies│  recall → reply   │   ranked recall  │  or Silo backend  │
└────────────┘                └──────────────────┘                  └──────────────────┘
```

## What it does

- **Passive distillation** — listens to every channel it's added to and turns
  messages into typed memories (`decision`, `fact`, `preference`,
  `action_item`) with a salience score. Chatter is skipped. It never replies
  unless spoken to.
- **Explicit memory** — `!remember <text>` stores verbatim with max salience.
- **Recall** — `!recall <query>`, or just `@silo <question>`. Answers are
  ranked (match × salience × recency) and every memory cites its provenance:
  author, date, and the Nostr event id it was distilled from — recall is
  auditable because everything in Buzz is signed.
- **Cross-channel memory** — a decision made in `#eng` is recallable from
  `#support`. Housekeeping: `!memories` (recent, per-channel), `!forget <id>`.

## Try it (zero infrastructure)

```bash
npm install
npm run demo    # scripted two-day Buzz conversation through the full agent loop
npm test        # unit + end-to-end tests (node:test, in-process fake relay)
```

## Run against a real workspace

```bash
cp .env.example .env   # set BUZZ_RELAY_URL, optionally pin AGENT_SECRET_KEY
npm start
```

Add the agent's pubkey to your channels like any coworker. With
`SILO_MODE=backend`, memories flow to the real Silo backend instead of the
local JSON store (see below).

## Architecture

| Path | What it is |
| --- | --- |
| `src/buzz/` | Buzz protocol surface: event kinds & parsing (`events.ts`), agent keypair (`identity.ts`), relay transport with NIP-42 auth (`relay.ts`), in-process fake for demo/tests (`fake-relay.ts`) |
| `src/silo/` | The memory contract (`types.ts` — `MemoryStore`) and two implementations: `local.ts` (JSON + lexical ranking, standalone) and `client.ts` (adapter to recap-silo-backend: REST memory CRUD + MCP `silo_recall`) |
| `src/memory/` | Distillation heuristics (`extractor.ts`) and recall/reply formatting (`recall.ts`) |
| `src/agent.ts` | The agent: routes relay events to ingest / commands / mention-recall |
| `demo/demo.ts` | Scripted end-to-end walkthrough |

## Assumptions (prototype)

Buzz's protocol surface is isolated in `src/buzz/events.ts` so each of these
is a one-file change once pinned against the published Buzz docs:

1. **Channel messages are kind `9`** with the channel id in an `h` tag
   (NIP-29-style group chat); threaded replies use `e` tags; mentions use
   `p` tags. Relays may require NIP-42 auth (handled).
2. **The Silo backend memory API is real and `src/silo/client.ts` targets
   it directly**: memory CRUD via
   `POST/GET/DELETE /api/v1/share/silos/{silo_id}/memories` (each mutation
   triggers a server-side Pinecone re-index), and semantic recall via the
   MCP gateway (`tools/call silo_recall` at `/mcp`), which returns scored
   memory matches from the silo's vector namespace. Buzz provenance
   (channel, author pubkey, source event id, salience) round-trips through
   the memory `metadata` field. Assumed here: the agent authenticates with
   a bearer token that passes the backend's Clerk auth (a service identity
   for the agent is an open item), and recall hydrates provenance by
   joining `silo_recall` hits against the REST memory list. Richer
   integration is available and unused so far: `silo_remember` (async
   ingestion + conflict confirmation), `silo_ask` (silo-composed answers),
   entity/topic/relationship graphs, and the per-silo MCP mount
   (`/api/v1/silos/{id}/mcp`).
3. **Distillation is heuristic** (regex patterns + salience) so the demo is
   deterministic and offline. Production swaps `extractMemories` for a call
   into the Silo backend's multi-provider LLM layer; nothing else changes.
4. **Live tail only** — no backfill of channel history on join, and no
   dedup/consolidation of contradictory memories yet (see below).

## Where this goes next

- **Backfill & consolidation** — replay channel history on join; supersede
  stale memories ("ship Friday" → "slipped to Monday") instead of storing both.
- **Memory for *other* agents** — the bigger prize: expose recall through the
  buzz-acp agent harness so every agent in the workspace gets Silo-backed
  context injected before it acts, not just humans asking `!recall`.
- **Real Silo semantics** — embeddings-based recall via the backend ingestion
  pipeline, per-silo permissions mapped to channel membership, encryption at
  rest.
