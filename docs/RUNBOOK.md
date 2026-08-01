# Runbook: adding the One Silo agent to a Buzz workspace

Operational, end-to-end steps for standing up the `onesilo-buzz` memory
agent: install → pair with One Silo → choose a deployment shape (with or
without a `onesilo-node`) → connect to your relay — self-hosted or hosted —
→ admit the agent → verify → keep it running.

The [README](../README.md) explains what the agent *is*; this document is
the checklist for getting one *live*.

---

## 0. The shape of what you're deploying

- The agent is an ordinary **Buzz member**: it holds its own Nostr keypair,
  connects to your workspace relay over WebSocket, and is added to channels
  the way a person is. There is nothing to install on the relay itself.
- Memory lives in **One Silo** (or fully on-machine — your choice in step 3).
- Optionally, a **onesilo-node** on the same machine distills transcripts
  locally so raw conversation never leaves it.

Three memberships must line up, and each failure looks different:

| Missing | Symptom |
|---|---|
| One Silo pairing | agent exits: `Not paired with One Silo yet` |
| Relay membership | agent runs but never sees anything (silent hang) |
| Channel membership | agent sees nothing from that channel |

---

## 1. Install the agent

Requires Node.js ≥ 22 (Homebrew brings its own).

**Homebrew (macOS / Linux):**

```bash
brew tap onesilo/tap
brew trust --formula onesilo/tap/onesilo-buzz   # required: brew refuses untrusted taps
brew install onesilo-buzz
```

**npm:**

```bash
npm install -g @onesilo/buzz
```

Verify: `onesilo-buzz --version`.

**Pick a working directory and stay in it.** The agent writes its state
relative to the current directory — `.silo/agent.key` (its identity),
`.silo/oauth.json` (One Silo credential), `.env` if you use one. Running it
from a different directory later means a *new identity* that your workspace
has never admitted. A dedicated directory such as `~/buzz-agent` is the
easy way to make every run the same run:

```bash
mkdir -p ~/buzz-agent && cd ~/buzz-agent
```

## 2. Pair with One Silo (one-time)

Skip this only for the zero-infrastructure demo (`SILO_MODE=local`) or the
gateway-relay shape (D below) — every other shape needs it.

```bash
cd ~/buzz-agent
onesilo-buzz connect
```

This runs a browser OAuth flow against `connect.onesilo.com` and stores a
refreshable credential at `.silo/oauth.json` (0600). The agent appears in
your One Silo dashboard as a revocable connection named after its handle
("Buzz Agent (@silo)").

> **Port clash:** the OAuth callback listens on **8765** by default — the
> same port as a local onesilo-node's LAN API. If a node is already running
> on this machine, pair with
> `SILO_OAUTH_CALLBACK_PORT=8770 onesilo-buzz connect` (any free port).

## 3. Choose a deployment shape (optional node)

The node question is a privacy decision: **where do raw transcripts get
distilled into memories?**

| Shape | `SILO_MODE` | `DISTILL_MODE` | Raw transcripts | Needs |
|---|---|---|---|---|
| **A. Cloud only** | `mcp` | `cloud` | sent to your silo, distilled server-side | One Silo pairing |
| **B. Local distillation** *(recommended)* | `mcp` | `node` | never leave the machine; only distilled statements sync | pairing + a local node |
| **C. Fully on-machine** | `node` | `node` | never leave; memory also stays in the node's local store | a local node only |
| **D. Gateway relay** | `relay` | either | per `DISTILL_MODE` | a gateway-mode node; the node holds the only cloud credential, the agent never pairs itself |

**The guided path does this for you.** `onesilo-buzz run` probes for a node
at `http://127.0.0.1:8766`; if none is there it offers to install one
(Homebrew: `onesilo/tap/onesilo-node` — run
`brew trust --formula onesilo/tap/onesilo-node` first), hands off to
`onesilo-node setup`, and picks `DISTILL_MODE=node` only once the node
actually answers. To skip the question entirely:

- `onesilo-buzz run --no-node` → shape A, or
- set `DISTILL_MODE` explicitly in the environment — an explicit setting is
  never second-guessed.

**Deliberate non-behavior to know about:** if you chose node distillation
and the node goes away, captures **buffer and retry — the agent never falls
back to shipping raw transcripts to the cloud**. A stopped node therefore
looks like "memory stopped updating", not an error in the channel. Check
node health first (step 7).

**Remote node (advanced):** the node's admin token and node key are local
secrets, so `NODE_URL`/`NODE_LAN_URL` must be loopback by default. To use a
node on another machine you must set `NODE_ALLOW_REMOTE=1` *and* use
`https://` URLs (e.g. the node's managed-tunnel hostname), and provide
`NODE_ADMIN_TOKEN`/`NODE_KEY` explicitly since `~/.onesilo-node/*` files
aren't on this machine. Plaintext remote URLs are refused at startup.

## 4. Point the agent at your relay

Configuration is environment-driven; a `.env` in the working directory
works, as does exporting variables. Minimum:

```bash
# self-hosted Buzz relay
BUZZ_RELAY_URL=wss://relay.your-workspace.example

# agent identity
AGENT_HANDLE=silo          # what people will @mention
```

**Hosted relay (a Buzz community someone else operates, e.g. a
Block-hosted community):** nothing about the agent changes — hosted
communities authenticate members by pubkey, so a self-hosted agent process
connects from your machine like any other member. You need two things from
the community:

1. the relay's `wss://` URL → set it as `BUZZ_RELAY_URL`;
2. a member slot: after step 5 prints the agent's key, the community
   owner adds it as a member (see step 6).

Optional scoping: `BUZZ_CHANNEL_IDS=eng,support` restricts listening to
specific channels; empty means every channel the agent has been added to.
Per-channel memory buckets go in `SILO_CHANNEL_MAP` (see `.env.example`).

## 5. First run

```bash
cd ~/buzz-agent
onesilo-buzz run          # add --yes to accept every recommended answer
```

On first boot the agent generates its keypair and stores the secret at
`.silo/agent.key` (0600, never printed). Once connected it prints an invite
block:

```
  Agent      @silo
  npub       npub1…            ← paste into Buzz clients
  pubkey     3f9a…             ← the form relay admin tooling takes
  relay      wss://…
```

That identity is stable across restarts as long as the working directory
(or an explicit `AGENT_SECRET_KEY`) is preserved. **Back up
`.silo/agent.key`** — losing it means a new identity and re-admission.

## 6. Admit the agent (the human step)

Nothing here is automatic, by design — a human lets an agent in.

1. **Relay membership** (member-restricted relays only, which includes
   hosted communities):
   - self-hosted: `buzz-admin add-member <pubkey>` on the relay host;
   - hosted: send the `pubkey`/`npub` from the invite block to whoever
     owns the community and have them add it as a member.
2. **Channel membership:** in the Buzz client, add the agent to each
   channel it should remember — paste the `npub` exactly as you'd add a
   person.

A restricted relay **drops events from non-members silently**: the agent
connects, subscribes, and receives nothing. If the agent is "running but
nothing happens", this is the first thing to check — it is membership, not
a crash.

## 7. Verify

In a channel the agent was added to:

```
@silo what do you remember?
```

A reply proves relay + channel membership and the memory path end to end.
Then check the pieces that fail quietly:

- `!remember <fact>` in a channel → should be acknowledged and recalled
  later;
- node shapes (B/C/D): confirm the node is healthy —
  `curl -s -H "Authorization: Bearer $(cat ~/.onesilo-node/admin.token)" http://127.0.0.1:8766/v1/status | jq`
- shape A/B: the memories appear in your silo in the One Silo dashboard.

## 8. Keep it running

The agent is a single long-lived process; the node (if any) is a second
one. For an always-on deployment run each under a supervisor:

**systemd (Linux):** `~/.config/systemd/user/onesilo-buzz.service`

```ini
[Unit]
Description=One Silo Buzz agent
After=network-online.target

[Service]
WorkingDirectory=%h/buzz-agent
ExecStart=/usr/bin/env onesilo-buzz run --yes
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now onesilo-buzz
loginctl enable-linger $USER      # keep it alive after logout
```

**macOS:** `brew services start onesilo-node` covers the node; run the
agent under `launchd` the same way (a `launchd` plist with
`WorkingDirectory` set to the agent directory), or in a `tmux` session for
low-ceremony setups.

`WorkingDirectory` is the load-bearing line — it is what keeps the
identity, credential, and `.env` from step 1 in play.

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Not paired with One Silo yet` | no `.silo/oauth.json` in the working directory | `onesilo-buzz connect` from the same directory |
| Runs, but no replies, no captures | not a relay member (silent drop) or not in the channel | step 6; hosted: confirm the owner added the pubkey |
| Replies in one channel, deaf in another | channel membership, or `BUZZ_CHANNEL_IDS` excludes it | add to channel / widen the variable |
| `onesilo-buzz connect` fails to open callback | port 8765 taken (usually the node's LAN API) | `SILO_OAUTH_CALLBACK_PORT=8770 onesilo-buzz connect` |
| Memory stopped updating (node shapes) | node down — captures buffer, never fall back to cloud | start the node; buffered captures flush on recovery |
| Startup refuses `NODE_URL` | non-loopback node URL without the explicit opt-in | keep the node local, or `NODE_ALLOW_REMOTE=1` + `https://` |
| New/unknown identity after a move | ran from a different directory → fresh `.silo/agent.key` | run from the original directory or set `AGENT_SECRET_KEY` |
| `brew install` refuses the formula | tap not trusted | `brew trust --formula onesilo/tap/onesilo-buzz` (and `…/onesilo-node`) |
