# Contributing

Thanks for helping build the Buzz × One Silo memory agent. This covers the
layout, the rules that keep it safe, and how to get a change merged.

## Getting started

```bash
git clone https://github.com/onesilo/onesilo-buzz
cd onesilo-buzz
npm install
npm run lint && npm test
```

Node 22 or newer (`engines.node` in `package.json` sets the floor). The
test suite needs no network, no account, and no running node — the Buzz
relay is faked in `src/buzz/fake-relay.ts`.

```bash
npm run demo    # end-to-end against the fake relay and a JSON store
npm start       # run the agent against a real workspace
npm run connect # OAuth pairing with One Silo (SILO_MODE=mcp)
```

## Layout

```
src/index.ts        entrypoint: wiring, mode selection, node-key backfill
src/agent.ts        the agent loop — mention handling, capture, recall
src/config.ts       typed config from environment, with defaults
src/connect.ts      one-shot OAuth pairing flow
src/buzz/           workspace transport: relay client, events, identity
src/memory/         extraction, recall, and the capture window
src/silo/           memory backends (see below) + OAuth + shared types
src/node/           client for a local onesilo-node's admin API
demo/               runnable end-to-end demo against the fake relay
test/               node:test suites; no network, no fixtures on disk
```

### Memory backends

`SILO_MODE` selects one implementation of the store interface in
`src/silo/types.ts`. A new backend implements that interface and nothing
else changes:

| Mode | File | Backing |
|---|---|---|
| `mcp` | `mcp-store.ts`, `mcp-client.ts` | One Silo control plane over MCP |
| `relay` | `mcp-store.ts` | a gateway onesilo-node's `/v1/cloud/mcp` |
| `node` | `node-memory.ts` | a local onesilo-node's memory API |
| `local` | `local.ts` | JSON file, for demo and development |

`DISTILL_MODE` is orthogonal: `cloud` sends transcript segments to One Silo
for server-side distillation, `node` distills locally first
(`node-distill.ts`) so raw conversation never leaves the machine.

## Rules

- **Raw transcripts must not leak past a failed distillation.** With
  `DISTILL_MODE=node`, if the node is unreachable the capture buffers and
  retries. It must never fall back to sending raw conversation to the
  cloud — that would silently undo the reason someone chose node mode.
- **Node credentials are loopback-only by default.** The admin token and
  node key are high-value local secrets. Reaching a node on another host
  requires both `NODE_ALLOW_REMOTE=1` and an `https://` URL; plaintext is
  refused. Do not relax this.
- **Secrets never reach logs.** The agent's Nostr secret key is written to
  a `0600` file and never printed. Keep it that way for any new credential.
- **Keep the dependency list short.** Currently `@noble/hashes`,
  `nostr-tools`, and `ws`. Anything else needs a case in the PR.
- **The config surface is `src/config.ts` and `.env.example` together.** A
  new setting that appears in one but not the other is a bug — `.env.example`
  is the user-facing documentation for every knob.

## Making changes

1. Branch from `main`.
2. `npm run lint && npm test` must pass. New behavior needs tests; prefer
   the fake relay over anything that touches the network.
3. Keep commits focused, with imperative subjects ("Add recall backoff",
   not "Added…").
4. Open a PR describing *why*, not just *what*. If a change alters a
   contract shared with onesilo-node or the One Silo control plane, link
   the change it tracks.

## Reporting security issues

Do not open a public issue for a vulnerability — see
[SECURITY.md](SECURITY.md).
