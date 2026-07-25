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
npm run connect        # one-time OAuth pairing with the Silo control plane
npm start
```

Add the agent's pubkey to your channels like any coworker.

## The agent is a standard Silo MCP client

In `mcp` mode (the default) the agent talks to the Silo control plane
exactly like ChatGPT/Claude/Cursor do — **MCP is OAuth**:

1. `npm run connect` discovers the OAuth server (RFC 8414), registers via
   DCR with `client_name: "Buzz Agent (@handle)"` and
   `client_uri: "https://buzz.xyz"`, and runs authorization_code + PKCE.
   The agent prints the authorize URL; its human sponsor approves once in
   a browser (loopback redirect catches the code). Refresh tokens keep the
   agent alive headlessly from then on.
2. The backend creates an **McpConnection** for the OAuth client — so the
   Buzz agent shows up in the Silo dashboard's **Connections** page like
   any other client, with the owner's full management surface: revoke,
   rate limits, per-silo access grants, approval requirements, PII scrub,
   injection detection, step-up auth.
3. Every connection auto-provisions a **default cloud silo**; the agent
   targets `silo_id: "default"`, so a freshly paired agent has a working,
   dashboard-visible memory with zero silo configuration.
4. Memory flows through the existing tool surface only:
   `silo_remember` (capture → async ingestion + enrichment: entity dedupe,
   topics, relationships), `silo_recall` (Pinecone-backed semantic recall),
   `silo_ask` (silo-composed grounded answers, relayed verbatim to Buzz),
   `silo_forget`, `silo_search_memories`, `silo_get_context`.
   `silo_remember`'s `requires_confirmation` responses (content that would
   replace existing memories) are logged and **not** auto-confirmed —
   replacing memory is the owner's call.

### Proposed: an agent-native OAuth grant

The one seam left: authorization_code needs a human in a browser once per
pairing. Buzz agents already hold a cryptographic identity (their Nostr
keypair), which suggests a first-class agent grant on the existing OAuth
server:

- **`urn:onesilo:oauth:grant-type:agent-key`** — DCR includes
  `software_id: "buzz-agent"` and the agent's Nostr pubkey (npub). The
  token endpoint accepts a challenge signed with the agent's key instead
  of an authorization code; the connection starts in a `pending` state and
  the owner approves it from the dashboard's Connections page ("Pending
  agents"), reusing the existing step-up/challenge machinery
  (`/api/v1/connect/challenges`). Approval binds the npub to the
  connection, so the dashboard can display and verify *which* agent
  identity holds the connection — the same signature-based identity model
  Buzz itself uses. Until that lands, `npm run connect` covers pairing.

## Architecture

| Path | What it is |
| --- | --- |
| `src/buzz/` | Buzz protocol surface: event kinds & parsing (`events.ts`), agent keypair (`identity.ts`), relay transport with NIP-42 auth (`relay.ts`), in-process fake for demo/tests (`fake-relay.ts`) |
| `src/silo/` | The memory contract (`types.ts` — `MemoryStore`) and two implementations: `local.ts` (JSON + lexical ranking, standalone) and `mcp-store.ts` (the existing `silo_*` MCP tool surface) via `mcp-client.ts` (Streamable HTTP MCP client) + `oauth.ts` (OAuth 2.1: discovery, DCR, PKCE, refresh) |
| `src/connect.ts` | One-time OAuth pairing CLI (`npm run connect`) |
| `src/memory/` | Distillation heuristics (`extractor.ts`) and recall/reply formatting (`recall.ts`) |
| `src/agent.ts` | The agent: routes relay events to ingest / commands / mention-recall |
| `demo/demo.ts` | Scripted end-to-end walkthrough |

## Assumptions (prototype)

Buzz's protocol surface is isolated in `src/buzz/events.ts` so each of these
is a one-file change once pinned against the published Buzz docs:

1. **Channel messages are kind `9`** with the channel id in an `h` tag
   (NIP-29-style group chat); threaded replies use `e` tags; mentions use
   `p` tags. Relays may require NIP-42 auth (handled).
2. **Silo integration uses only existing control-plane surface** (see "The
   agent is a standard Silo MCP client" above): OAuth 2.1 + `/mcp` +
   `silo_*` tools, nothing bespoke. Assumed: Buzz provenance rides as an
   inline `[buzz kind=… channel=… author=… event=…]` trailer in
   `silo_remember` content and is parsed back out of recalled memories —
   a structured `metadata` passthrough on `silo_remember` would be the
   cleaner long-term contract. Fully-autonomous (no-browser) pairing needs
   the proposed agent-key grant.
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
- **Structured provenance** — a `metadata` passthrough on `silo_remember`
  so Buzz channel/author/event provenance stops riding as an inline text
  trailer.
- **Agent-key grant** — implement the proposed
  `urn:onesilo:oauth:grant-type:agent-key` so agents pair without a
  browser, with owner approval in the dashboard.
