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

- **Listens quietly, in context.** In channels it's been added to, it
  buffers conversation into rolling turn windows and captures whole
  **episodes** — speaker-attributed transcripts — so "yeah let's do that"
  is remembered *with* the turns that give it meaning. Decision-like turns
  flush their window immediately; the rest flush when the episode goes
  quiet. It never speaks unless spoken to.
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

```bash
brew tap onesilo/tap
brew install silo-buzz
silo-buzz run
```

`run` walks the whole setup: it offers to install a
[onesilo-node](https://github.com/onesilo/onesilo-node) so conversation is
distilled on your own machine, hands off to the node's setup wizard, starts
the agent, and prints the npub to add to your channels.

```
Install onesilo-node so that memory is retained on this machine? [Y/n] y
[silo-buzz] Installing onesilo-node with Homebrew (builds from source; this can take a few minutes)…
[silo-buzz] Starting the onesilo-node setup wizard — it will ask a few questions.
   ... the node's wizard runs ...
[silo-buzz] Starting the node…
[silo-buzz] Node is up — distillation will run on this machine.

  ─────────────────────────────────────────────────────────────────
  The agent is running. One step left: let it into your workspace.
  ─────────────────────────────────────────────────────────────────

  Agent      @silo
  npub       npub1w7v9x2m...
  pubkey     7ae615cadb...
  relay      wss://onesilo.communities.buzz.xyz
```

Answering **n** runs without a node: the agent still works, but raw
transcripts are sent to your silo for distillation rather than staying on
your machine. That choice is asked rather than assumed, and if you say yes
and the install fails, `run` stops instead of quietly doing the opposite.

A node started this way lives exactly as long as `silo-buzz` — it is a
child process, not a background service. Nothing is installed into launchd
or systemd, and nothing keeps holding a tunnel open after you quit. If you
want a node that runs on its own schedule, run `onesilo-node` yourself (or
use [Silo Desktop](https://onesilo.com)); `silo-buzz run` detects one that
is already answering and leaves it alone.

Flags: `--yes` takes the recommended answer to every prompt, `--no-node`
skips the node question entirely. Setting `DISTILL_MODE` yourself disables
the question too.

The tap ([onesilo/homebrew-tap](https://github.com/onesilo/homebrew-tap)) is
live, but its formula builds from a published npm tarball, so `brew install
silo-buzz` only works once `@onesilo/buzz-silo-memory` is on the registry.
Until then, run from a checkout: `npm install && npm run cli -- run`.
(`packaging/homebrew/silo-buzz.rb` is a stale copy of the tap's formula and
cannot be installed — its `sha256` is a placeholder.)

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
at [onesilo/silo-spec](https://github.com/onesilo/silo-spec).

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

If `connect` reports that no refresh token came back, the agent will stop
working when its current access token expires — re-run `npm run connect`
against a build that requests `offline_access`. Agents paired before that
scope was requested need to re-pair once; a missing refresh token cannot be
backfilled.

### 4. Run it in your workspace

```bash
npm start          # or: silo-buzz run
```

Add the agent to your Buzz channels like any other member. `silo-buzz run`
prints its **npub** (for pasting into a client) and its **hex pubkey** (for
relay admin tooling) once it is live, along with the `buzz-admin add-member`
command a member-restricted relay needs — that one is easy to miss, because
a restricted relay does not reject the agent visibly, it just never delivers
anything to it. `npm start` logs only the first 12 characters of the pubkey —
enough to recognise the agent in the log, not enough to admit it — so use
`silo-buzz run` (or `silo-buzz connect`) when you need the real values. Pin
the identity with `AGENT_SECRET_KEY` in `.env`.

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

**Conversation-aware capture.** The agent is a *segmenter*, not a
distiller: it decides where a conversational episode begins and ends, and
One Silo's server-side pipeline does the semantic work with full turn
context. An episode flushes when a decision-like turn appears (immediately,
so it's recallable fast), when the window fills (`CAPTURE_WINDOW_TURNS`),
or when the channel goes quiet (`CAPTURE_IDLE_FLUSH_SECONDS`); the last
`CAPTURE_OVERLAP_TURNS` turns carry into the next segment so episodes that
span a flush keep their thread. Failed captures are retained and retried on
the next flush. Note the privacy posture this implies: **raw conversation
transcripts from the agent's channels are sent to your silo** (not just
distilled one-liners) — only add the agent to channels whose content
belongs in that memory. If you'd rather raw conversation never leave your
machine at all, run a onesilo-node and turn on private distillation (next
section).

## Pairing with a onesilo-node

Run an open-source [onesilo-node](https://github.com/onesilo/onesilo-node) on
the same machine and the agent composes with it out of the box — two
independent switches control where things run:

| `SILO_MODE` | `DISTILL_MODE` | Memory lives | Distillation runs | Cloud credential |
| --- | --- | --- | --- | --- |
| `mcp` *(default)* | `cloud` *(default)* | your cloud silo | One Silo | agent's own OAuth |
| `mcp` | `node` | your cloud silo | **your node** | agent's own OAuth |
| `relay` | `node` | your cloud silo, via the node | **your node** | **the node's sign-in only** |
| `node` | `node` | **your node** (SQLite, hybrid recall) | **your node** | **none** |

- **`SILO_MODE=relay`** — One Silo through a *gateway* node's MCP relay
  (`/v1/cloud/mcp`). The node holds the only cloud credential; the agent
  authenticates to the node with the node key and **never pairs** (`npm run
  connect` not needed). One connection in the dashboard: the node.
- **`SILO_MODE=node`** — memory served entirely by the node's memory API:
  SQLite with FTS5 keyword search, fused with vector recall when the node's
  compute is on. With `DISTILL_MODE=node` this is the **fully on-machine
  stack**: capture, distillation, storage, and recall never leave hardware
  you own.

Both find the node automatically: LAN APIs at `127.0.0.1:8765`, node key
from `~/.onesilo-node/node.key` or the admin API (`NODE_LAN_URL` / `NODE_KEY`
override).

**Private distillation with onesilo-node.** For workspaces that don't want raw
transcripts leaving their hardware, pair the agent with a node on the same
machine:

```bash
# once, on the same machine (downloads a local model if needed):
onesilo-node setup && onesilo-node

# then run the agent with:
DISTILL_MODE=node npm start
```

With `DISTILL_MODE=node`, each conversation segment is distilled **by the
node's local model** (via the node's admin API) into standalone memory
statements — decisions, facts, action items, preferences — and only those
statements sync to your silo. It works out of the box: the agent finds the
node at `127.0.0.1:8766` and reads the admin token `onesilo-node setup` wrote
to `~/.onesilo-node/admin.token`. If the node is down, captures buffer in the
turn window and retry until it's back — the agent **never** falls back to
shipping raw transcripts; privacy degradation is not an automatic decision.

| Path | What it is |
| --- | --- |
| `src/buzz/` | Nostr protocol surface: event parsing, agent identity, relay transport, and an in-process fake relay for demo/tests |
| `src/silo/` | The `MemoryStore` contract with two backends: One Silo via MCP (`mcp-store.ts`, `mcp-client.ts`, `oauth.ts`) and a local JSON store for offline use; `node-distill.ts` wraps either with onesilo-node private distillation |
| `src/node/` | Client for a local onesilo-node's admin API (`/v1/compute/generate`) |
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
- **Scope-aware startup.** On boot the agent calls `get_scope`, logs
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
| `SILO_MODE` | `mcp` | `mcp` (One Silo direct), `relay` (One Silo via a gateway node), `node` (node-local memory), `local` (JSON file) |
| `SILO_SERVER_URL` | `https://connect.onesilo.com` | Silo control plane (OAuth + MCP) |
| `SILO_ID` | `default` | Default memory bucket (`default` = the agent's own silo) |
| `SILO_CHANNEL_MAP` | *(empty)* | Per-channel buckets: `channel=silo_id,…` |
| `SILO_TOKEN_PATH` | `.silo/oauth.json` | Where OAuth tokens persist |
| `CAPTURE_WINDOW_TURNS` | `12` | Turns buffered before a segment flushes |
| `CAPTURE_OVERLAP_TURNS` | `2` | Turns carried into the next segment as context |
| `CAPTURE_IDLE_FLUSH_SECONDS` | `600` | Quiet time that closes an episode |
| `DISTILL_MODE` | `cloud` | `cloud` (silo distills raw segments) or `node` (a local onesilo-node distills; only statements leave the machine) |
| `NODE_URL` | `http://127.0.0.1:8766` | onesilo-node admin API (distillation, status) |
| `NODE_ADMIN_TOKEN` | *(from `~/.onesilo-node/admin.token`)* | Explicit node admin token override |
| `NODE_LAN_URL` | `http://127.0.0.1:8765` | onesilo-node LAN API (memory, `/v1/cloud` relay) |
| `NODE_KEY` | *(from `~/.onesilo-node/node.key` or admin API)* | Explicit node key override |
| `NODE_ALLOW_REMOTE` | *(unset)* | Set `1` to allow a non-loopback node URL (requires https) |
| `AGENT_SECRET_KEY_PATH` | `.silo/agent.key` | Where a freshly generated agent key is written (0600) |

## Privacy & control

- The agent only sees channels it has been added to.
- Memory lives in **your** silo, under **your** account. The
  [dashboard](https://dashboard.onesilo.com/) shows the agent as a
  connection you can inspect, limit, or revoke at any time.
- Memory-replacing writes are never auto-confirmed by the agent.
- Recall is auditable: every memory traces back to a signed Buzz event.

## Security

- **Node credentials stay local.** The node admin token and node key are
  attached only to loopback URLs; a misconfigured `NODE_URL`/`NODE_LAN_URL`
  pointing off-machine is refused unless you set `NODE_ALLOW_REMOTE=1`, and
  even then plaintext `http://` to a remote host is rejected — credentials
  never leave the machine in the clear.
- **Generated identity keys never hit logs.** A freshly minted agent key is
  written to a `0600` file (`AGENT_SECRET_KEY_PATH`), not printed to stdout,
  and loaded back automatically on the next start (env > file > generate), so
  the identity is stable without exposing the key.
- **OAuth discovery is pinned.** Discovered `authorization`/`token`/
  `registration` endpoints must be same-origin as the issuer and https, so a
  hostile discovery document can't redirect the auth code, PKCE verifier, or
  refresh token to another host.
- **Raw transcripts never leave with `DISTILL_MODE=node`.** Distillation
  runs on the local node; only distilled statements sync, and if the node is
  down captures buffer rather than fall back to shipping raw text.
- Outbound TLS uses default certificate verification (never disabled).

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
[onesilo/silo-spec](https://github.com/onesilo/silo-spec), the open
specification for the exportable `.silo` format.
