# Buzz × One Silo — long-term memory for your Buzz workspace

**A [Buzz](https://buzz.xyz/) agent that remembers, powered by [One Silo](https://dashboard.onesilo.com/).**

Buzz is an open-source workspace where humans and AI agents work together —
every message is a cryptographically signed event, and agents join channels
the same way coworkers do. But like every chat tool, conversation scrolls
away: decisions get re-litigated, facts get re-asked, context evaporates.

This project adds a **memory agent** to your workspace: a Buzz member
with its own keypair that quietly distills your channels into durable,
searchable memory — and answers with that memory when asked, across channels
and across time.

```
#eng     <alice>  after the debate yesterday: we decided to ship the payments
                  migration on Friday, behind the flag
#eng     <bob>    I'll rotate the staging API keys before the migration runs
#eng     <alice>  !remember rollback plan: re-enable the legacy processor via
                  LaunchDarkly flag payments-v1

         ... the next day, in a different channel ...

#support <bob>    @silo what did we decide about the payments migration?
#support <silo>   Here's what I remember about "the payments migration":
                  1. [Decision] we decided to ship the payments migration on
                     Friday, behind the flag
                     — alice, 2026-07-25, event de579e4d
                  2. [Noted] rollback plan: re-enable the legacy processor via
                     LaunchDarkly flag payments-v1
                     — alice, 2026-07-25, event e5f1f682
                  3. [Action item] I'll rotate the staging API keys before the
                     migration runs
                     — bob, 2026-07-25, event e02bad11
```

Every recalled memory cites its provenance — author, date, and the signed
Buzz event it was distilled from — because in Buzz, everything is verifiable.

## What the agent does

- **Listens quietly.** In channels it's been added to, it distills messages
  into typed memories — decisions, facts, preferences, action items — with a
  salience score. Small talk is ignored. It never speaks unless spoken to.
- **Remembers on demand.** `!remember <text>` stores something verbatim.
- **Answers from memory.** `@silo <question>` or `!recall <query>` returns a
  grounded answer composed from the silo's memory. A decision made in `#eng`
  is recallable from `#support`.
- **Stays accountable.** `!memories` lists what it knows; `!forget <id>`
  deletes. When new information would *replace* existing memory, the agent
  surfaces it instead of silently overwriting — rewriting memory is the
  owner's call, not the agent's.

| Command | What it does |
| --- | --- |
| `@silo <question>` | Answer from memory (grounded, provenance-cited) |
| `!recall <query>` | Same as a mention, explicit form |
| `!remember <text>` | Store verbatim, max salience |
| `!memories` | What's stored (recent for the channel, or a silo overview) |
| `!forget <id>` | Delete a memory by id |

## Quick start

### 1. Try the demo — no account, no infrastructure

```bash
git clone https://github.com/onesilo/onesilo-buzz.git
cd onesilo-buzz
npm install
npm run demo    # scripted two-day conversation through the full agent loop
npm test        # the test suite, including an end-to-end in-process relay
```

The demo runs entirely offline against a local memory store.

### 2. Get a silo

The agent's real memory is a **silo** — a private, managed memory store
powered by One Silo, with semantic recall, entity/topic enrichment, and an
owner dashboard. Your
memory stays portable: silos export to the open `.silo` file format, specified
at [onesilo/onesilo-spec](https://github.com/onesilo/onesilo-spec).

**Sign up at [dashboard.onesilo.com](https://dashboard.onesilo.com/)** —
free to start. That's the only dashboard step: the agent registers itself
when you pair it (next step), and a dedicated silo is provisioned for it
automatically.

### 3. Pair the agent with your One Silo account

```bash
cp .env.example .env    # set BUZZ_RELAY_URL; the defaults cover the rest
npm run connect
```

`connect` prints an authorization URL. Open it, approve, done — this is
standard OAuth, the same flow ChatGPT, Claude, and Cursor use to connect to
One Silo. The agent then appears in your dashboard under
**[Connections](https://dashboard.onesilo.com/connections)** as
*Buzz Agent (@yourhandle)*, where you manage it like any connected app:
revoke access, set rate limits, require approvals, scope which silos it can
touch. Pairing is one-time; refresh tokens keep the agent running headlessly.

### 4. Run it in your workspace

```bash
npm start
```

Add the agent's pubkey to your Buzz channels like any other member (it
prints its pubkey on first boot — pin it with `AGENT_SECRET_KEY` in `.env`).

## How it works

```
┌────────────┐   WebSocket    ┌───────────────────┐    MCP over HTTPS    ┌──────────────────┐
│ Buzz relay │ ─────────────▶ │   memory agent    │ ───────────────────▶ │ One Silo         │
│  (signed   │ ◀───────────── │  ingest → distill │ ◀─────────────────── │  semantic recall │
│   events)  │  signed replies│  recall → reply   │   grounded answers   │  + enrichment    │
└────────────┘                └───────────────────┘                      └──────────────────┘
```

The agent speaks two open protocols and nothing else:

- **To Buzz: Nostr.** Channel messages are signed events (kind 9 with an
  `h` channel tag); the agent verifies every signature it reads and signs
  everything it publishes with its own keypair. NIP-42 relay auth is
  supported.
- **To One Silo: MCP + OAuth.** The agent is a standard
  [Model Context Protocol](https://modelcontextprotocol.io/) client of the
  One Silo platform — the same connection surface as every other MCP client.
  Capture goes through One Silo's ingestion pipeline (which enriches memories
  with entities, topics, and relationships), recall uses One Silo's semantic
  search, and questions are answered by the silo itself, grounded in its
  own memory. Memory-replacing writes are surfaced for owner confirmation,
  never auto-applied by the agent.

| Path | What it is |
| --- | --- |
| `src/buzz/` | Nostr protocol surface: event parsing, agent identity, relay transport, and an in-process fake relay for demo/tests |
| `src/silo/` | The `MemoryStore` contract with two backends: One Silo via MCP (`mcp-store.ts`, `mcp-client.ts`, `oauth.ts`) and a local JSON store for offline use |
| `src/memory/` | Distillation heuristics and reply formatting |
| `src/agent.ts` | The agent loop: routes events to ingest / commands / recall |
| `src/connect.ts` | One-time OAuth pairing CLI |
| `demo/` | Scripted end-to-end walkthrough |

## Memory buckets & shared memory

Memory lives in **silos**, and one agent isn't limited to one:

- **Multiple buckets per agent.** Map channels to different silos with
  `SILO_CHANNEL_MAP` (e.g. `eng=<silo-id>,support=<silo-id>`); unmapped
  channels use the default bucket (`SILO_ID`, normally the agent's own
  auto-provisioned silo). Capture and recall route per channel, so `#exec`
  can keep a separate memory from `#eng` while both are served by the same
  agent. Recall is **bucket-wide**: channels sharing a bucket share memory.
- **Shared memory across agents.** Silos are addressable by id, and a
  connection can be granted access to any number of them from the
  dashboard (**Connections → your Buzz agent → Silos**). Point two agents —
  different workspaces, different machines, different keypairs — at the
  same silo id and they read and write one shared memory, each still
  individually visible, rate-limitable, and revocable in the dashboard.
- **Scope-aware startup.** On boot the agent calls `silo_get_scope`, logs
  the silos and shapes its connection can reach, and warns about any
  configured bucket the connection hasn't been granted — so a
  misconfigured map fails loudly at startup, not silently at capture time.

## Configuration

Everything is environment-driven — see [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `BUZZ_RELAY_URL` | `ws://localhost:7777` | Your Buzz workspace relay |
| `BUZZ_CHANNEL_IDS` | *(all visible)* | Comma-separated channels to listen in |
| `AGENT_HANDLE` | `silo` | The agent's @handle |
| `AGENT_SECRET_KEY` | *(generated)* | Pin the agent's Nostr identity |
| `SILO_MODE` | `mcp` | `mcp` (One Silo platform) or `local` (JSON file) |
| `SILO_SERVER_URL` | `https://api.onesilo.com` | Silo control plane |
| `SILO_ID` | `default` | Default memory bucket (`default` = the agent's own silo) |
| `SILO_CHANNEL_MAP` | *(empty)* | Per-channel buckets: `channel=silo_id,…` |
| `SILO_TOKEN_PATH` | `.silo/oauth.json` | Where OAuth tokens persist |

## Privacy & control

- The agent only sees channels it has been added to.
- Memory lives in **your** silo, under **your** account. The
  [dashboard](https://dashboard.onesilo.com/) shows the agent as a
  connection you can inspect, limit, or revoke at any time.
- Memory-replacing writes are never auto-confirmed by the agent.
- Recall is auditable: every memory traces back to a signed Buzz event.

## Roadmap

- **Backfill & consolidation** — replay channel history on join; supersede
  stale memories ("ship Friday" → "slipped to Monday") instead of keeping
  both.
- **Memory for other agents** — expose recall to the *other* AI agents in
  your workspace, so every agent acts with shared context — not just humans
  asking `!recall`.
- **Browserless agent pairing** — a proposed OAuth extension
  (`urn:onesilo:oauth:grant-type:agent-key`) where the agent authenticates
  with its own Nostr key and the owner approves the pending connection from
  the dashboard: no browser step, and the connection is cryptographically
  bound to the same identity the agent uses in Buzz.
- **Structured provenance** — Buzz channel/author/event provenance currently
  rides as an inline trailer in captured content; a structured metadata
  passthrough is the cleaner long-term contract.
- **Protocol pinning** — Buzz's event-kind mapping lives in one file
  (`src/buzz/events.ts`) and currently assumes NIP-29-style kind-9 channel
  messages; it will be pinned against Buzz's published protocol docs.

## Status

A working prototype, developed in the open. Issues and PRs welcome.

*Buzz is a product of Block, Inc. This project is an independent
integration and is not affiliated with or endorsed by Block.*

## License

[Apache-2.0](LICENSE) — the same license as Buzz itself. See also
[onesilo/onesilo-spec](https://github.com/onesilo/onesilo-spec), the open
specification for the exportable `.silo` format.
