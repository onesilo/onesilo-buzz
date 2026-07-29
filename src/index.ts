/**
 * Entrypoint: connect the memory agent to a real Buzz workspace relay.
 *
 * First run: `npm run connect` to pair with the One Silo control plane (OAuth,
 * one-time human approval). Then `npm start`. For a zero-infrastructure
 * walkthrough, run `npm run demo` instead.
 */

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import {
  loadIdentity,
  exportSecretKeyHex,
  resolveAgentSecretKeyHex,
  npubOf,
} from "./buzz/identity.js";
import { WebSocketRelay } from "./buzz/relay.js";
import { LocalSiloStore } from "./silo/local.js";
import { SiloOAuthClient } from "./silo/oauth.js";
import { McpClient, nodeKeyAuth } from "./silo/mcp-client.js";
import { McpSiloStore } from "./silo/mcp-store.js";
import { NodeMemoryStore } from "./silo/node-memory.js";
import { SiloBucketRouter } from "./silo/buckets.js";
import { wrapWithNodeDistillation } from "./silo/node-distill.js";
import { SiloNodeClient, resolveNodeAdminToken, resolveNodeKey } from "./node/client.js";
import { SiloMemoryAgent } from "./agent.js";
import type { MemoryStore } from "./silo/types.js";

const log = (line: string) => console.log(`[silo-memory] ${line}`);

const config = loadConfig();

// Agent identity precedence: AGENT_SECRET_KEY env > persisted key file >
// generate a fresh one and persist it. Loading the file back is what makes
// the identity stable across restarts.
const keyPath = process.env.AGENT_SECRET_KEY_PATH ?? ".silo/agent.key";
const resolvedSecret = resolveAgentSecretKeyHex(config.agentSecretKeyHex, keyPath);
const identity = loadIdentity(config.agentHandle, resolvedSecret.hex);
if (resolvedSecret.fromFile) {
  log(`Loaded agent identity from ${keyPath}.`);
} else if (!resolvedSecret.hex) {
  // A freshly generated key is the agent's signing identity — a genuine
  // secret. Never print it to stdout, where it would be captured by log
  // aggregators/CI logs indefinitely. Persist it to a 0600 file and log
  // only the path (+ the public key, which is not sensitive). resolve only
  // returns undefined when no key file exists, so this always creates a new
  // file — writeFileSync's mode applies (it's only ignored on existing
  // files) and we never clobber an existing key.
  let persisted = false;
  try {
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, `${exportSecretKeyHex(identity)}\n`, { mode: 0o600 });
    persisted = true;
    // Best-effort tighten (in case of an unusual umask/pre-existing inode);
    // a chmod failure must NOT drop us into the reveal path — the key is
    // already safely on disk.
    try {
      chmodSync(keyPath, 0o600);
    } catch {
      /* best effort */
    }
    log(
      `Generated a new agent identity. Wrote its secret key to ${keyPath} (0600); ` +
        `it will be loaded automatically on the next start. Keep that file to ` +
        `preserve this identity.`
    );
  } catch (err) {
    // The write itself failed — the key is not on disk. Only reveal it on an
    // interactive terminal, so it still never lands in piped/aggregated logs.
    if (!persisted && process.stdout.isTTY) {
      console.log(
        `Generated a new agent keypair. To keep this identity, set AGENT_SECRET_KEY=${exportSecretKeyHex(identity)}`
      );
    } else {
      log(
        `Generated a new agent identity but could not persist it (${err}). Set ` +
          `AGENT_SECRET_KEY or AGENT_SECRET_KEY_PATH to keep a stable identity.`
      );
    }
  }
}

// The agent joins channels like any other Buzz member, which means a human
// has to add its public key to them. Print the identity in full, in both
// the hex and bech32 (npub) forms clients use, so that step doesn't require
// digging the key file out and deriving it by hand. Public keys are not
// secret — only the secret key is, and that is never printed.
log(`Agent @${identity.handle} — add this member to your Buzz channels:`);
log(`  npub: ${npubOf(identity.pubkey)}`);
log(`  hex:  ${identity.pubkey}`);

// Node key for the LAN APIs (memory, cloud relay): env/file first; if
// neither exists, main() backfills it from the admin API before startup.
const nodeKeyRef = { value: resolveNodeKey(config.node.key) };
const nodeAdmin = new SiloNodeClient(
  config.node.adminUrl,
  resolveNodeAdminToken(config.node.adminToken)
);

let store: MemoryStore;
if (config.silo.mode === "mcp") {
  const oauth = new SiloOAuthClient({
    serverUrl: config.silo.serverUrl,
    agentHandle: config.agentHandle,
    tokenPath: config.silo.tokenPath,
    callbackPort: config.silo.callbackPort,
  });
  if (!oauth.isPaired) {
    console.error("Not paired with One Silo yet. Run: npm run connect");
    process.exit(1);
  }
  if (!oauth.canRefresh) {
    log(
      "warning: paired without a refresh token — the agent will stop working " +
        "when the current access token expires. Re-run `npm run connect` to fix."
    );
  }
  const mcp = new McpClient(`${config.silo.serverUrl}/mcp`, oauth);
  const router = SiloBucketRouter.fromEnv(config.silo.siloId, config.silo.channelMap);
  store = new McpSiloStore(mcp, router, log);
} else if (config.silo.mode === "relay") {
  // One Silo through the gateway node's MCP relay: the node holds the only
  // cloud credential; this agent never pairs and never sees a cloud token.
  const mcp = new McpClient(
    `${config.node.lanUrl}/v1/cloud/mcp`,
    nodeKeyAuth(() => nodeKeyRef.value)
  );
  const router = SiloBucketRouter.fromEnv(config.silo.siloId, config.silo.channelMap);
  store = new McpSiloStore(mcp, router, log);
  log(`relay mode: One Silo via the gateway node at ${config.node.lanUrl} (node-key auth)`);
} else if (config.silo.mode === "node") {
  // Memory homed on the node: fully on-machine with DISTILL_MODE=node.
  const router = SiloBucketRouter.fromEnv(config.silo.siloId, config.silo.channelMap);
  store = new NodeMemoryStore(config.node.lanUrl, () => nodeKeyRef.value, router, log);
} else {
  store = new LocalSiloStore(config.silo.path);
}

// DISTILL_MODE=node: distill transcripts on a local onesilo-node so raw
// conversation never leaves this machine — only distilled statements sync.
if (config.distill === "node") {
  store = wrapWithNodeDistillation(store, nodeAdmin, log);
}

const relay = new WebSocketRelay(config.relayUrl, identity, log);
const agent = new SiloMemoryAgent(relay, store, identity, {
  channelIds: config.channelIds,
  capture: config.capture,
  log,
});

async function main() {
  // Node-key backfill: when ~/.onesilo-node/node.key isn't readable (or NODE_KEY
  // unset), the admin API is the documented way to read it.
  const needsNodeKey = config.silo.mode === "relay" || config.silo.mode === "node";
  if (needsNodeKey && !nodeKeyRef.value) {
    try {
      nodeKeyRef.value = await nodeAdmin.nodeKey();
      if (nodeKeyRef.value) log("node key loaded from the admin API");
    } catch (err) {
      log(`warning: could not read the node key from the admin API (${err})`);
    }
  }
  // Scope discovery first: logs the connection's silos/shapes and warns on
  // buckets the connection can't reach.
  if (store.init) await store.init();
  await agent.start();
}

main().catch((err) => {
  console.error("failed to start agent:", err);
  process.exit(1);
});

// Graceful shutdown on both Ctrl-C and supervisor stops (Docker/Kubernetes/
// systemd send SIGTERM): flush pending conversation buffers, then close.
// A second signal during the flush must not restart it.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received — flushing pending captures`);
  // Stop intake FIRST: events delivered during the final flush would land
  // in the window after it and be dropped silently on exit. Closing the
  // relay before stop() means already-queued command replies may fail
  // delivery (logged, capture still happens) — during shutdown, capture
  // integrity outranks replies.
  relay.close();
  void agent
    .stop()
    .catch((err) => console.error("shutdown flush failed:", err))
    .finally(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
