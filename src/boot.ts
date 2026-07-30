/**
 * Agent bootstrap: identity, memory store, relay, and signal handling.
 *
 * Extracted from `index.ts` so the `onesilo-buzz` CLI and `npm start` start the
 * *same* agent rather than two implementations that drift. `index.ts` is now
 * a thin wrapper; everything that decides how the agent is wired lives here.
 *
 * Nothing in this module reads argv or prompts. It takes an already-resolved
 * Config and does what it says — which is what lets the CLI make its own
 * decisions (install a node, pick a distill mode) before calling in.
 */

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.js";
import { loadIdentity, exportSecretKeyHex, resolveAgentSecretKeyHex } from "./buzz/identity.js";
import type { AgentIdentity } from "./buzz/identity.js";
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

export type Logger = (line: string) => void;

export interface BootOptions {
  config: Config;
  log: Logger;
  /**
   * Called once the agent is live, with its identity. The CLI uses this to
   * print the npub and the join instructions *after* startup succeeds —
   * telling someone to add a pubkey to a channel is premature if the agent
   * could not connect in the first place.
   */
  onStarted?: (identity: AgentIdentity) => void;
}

export interface RunningAgent {
  identity: AgentIdentity;
  /** Flush pending captures and close the relay. Idempotent. */
  shutdown: (signal: string) => Promise<void>;
}

/**
 * Resolve the agent's signing identity, persisting a freshly generated key.
 *
 * Precedence: AGENT_SECRET_KEY env > persisted key file > generate and
 * persist. Loading the file back is what makes the identity stable across
 * restarts — and stability matters more here than usual, because the pubkey
 * is what an operator adds to Buzz channels and to the relay's member list.
 */
function resolveIdentity(config: Config, log: Logger): AgentIdentity {
  const keyPath = process.env.AGENT_SECRET_KEY_PATH ?? ".silo/agent.key";
  const resolved = resolveAgentSecretKeyHex(config.agentSecretKeyHex, keyPath);
  const identity = loadIdentity(config.agentHandle, resolved.hex);
  if (resolved.fromFile) {
    log(`Loaded agent identity from ${keyPath} (pubkey ${identity.pubkey.slice(0, 12)}…).`);
    return identity;
  }
  if (resolved.hex) return identity; // came from env; nothing to persist

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
      `Generated a new agent identity (pubkey ${identity.pubkey.slice(0, 12)}…). ` +
        `Wrote its secret key to ${keyPath} (0600); it will be loaded automatically ` +
        `on the next start. Keep that file to preserve this identity.`
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
  return identity;
}

/**
 * Build the memory store for the configured SILO_MODE.
 *
 * Throws (rather than returning a degraded store) when `mcp` mode is not
 * paired: starting anyway would buffer captures against a store that can
 * never accept them.
 */
function buildStore(
  config: Config,
  nodeKeyRef: { value: string },
  log: Logger
): MemoryStore {
  if (config.silo.mode === "mcp") {
    const oauth = new SiloOAuthClient({
      serverUrl: config.silo.serverUrl,
      agentHandle: config.agentHandle,
      tokenPath: config.silo.tokenPath,
      callbackPort: config.silo.callbackPort,
    });
    if (!oauth.isPaired) {
      throw new NotPairedError();
    }
    if (!oauth.canRefresh) {
      log(
        "warning: paired without a refresh token — the agent will stop working " +
          "when the current access token expires. Re-run `onesilo-buzz connect` to fix."
      );
    }
    const mcp = new McpClient(`${config.silo.serverUrl}/mcp`, oauth);
    const router = SiloBucketRouter.fromEnv(config.silo.siloId, config.silo.channelMap);
    return new McpSiloStore(mcp, router, log);
  }
  if (config.silo.mode === "relay") {
    // One Silo through the gateway node's MCP relay: the node holds the only
    // cloud credential; this agent never pairs and never sees a cloud token.
    const mcp = new McpClient(
      `${config.node.lanUrl}/v1/cloud/mcp`,
      nodeKeyAuth(() => nodeKeyRef.value)
    );
    const router = SiloBucketRouter.fromEnv(config.silo.siloId, config.silo.channelMap);
    log(`relay mode: One Silo via the gateway node at ${config.node.lanUrl} (node-key auth)`);
    return new McpSiloStore(mcp, router, log);
  }
  if (config.silo.mode === "node") {
    // Memory homed on the node: fully on-machine with DISTILL_MODE=node.
    const router = SiloBucketRouter.fromEnv(config.silo.siloId, config.silo.channelMap);
    return new NodeMemoryStore(config.node.lanUrl, () => nodeKeyRef.value, router, log);
  }
  return new LocalSiloStore(config.silo.path);
}

/** SILO_MODE=mcp with no completed OAuth pairing. */
export class NotPairedError extends Error {
  constructor() {
    super("Not paired with One Silo yet. Run: onesilo-buzz connect");
    this.name = "NotPairedError";
  }
}

/**
 * Wire up and start the agent. Resolves once it is connected and listening.
 *
 * Registers SIGINT/SIGTERM handlers that flush pending conversation buffers
 * before exit — captures in flight are the one thing a restart cannot
 * reconstruct, since the relay does not replay what it already delivered.
 */
export async function startAgent(opts: BootOptions): Promise<RunningAgent> {
  const { config, log } = opts;

  const identity = resolveIdentity(config, log);

  // Node key for the LAN APIs (memory, cloud relay): env/file first; if
  // neither exists, we backfill it from the admin API before startup.
  const nodeKeyRef = { value: resolveNodeKey(config.node.key) };
  const nodeAdmin = new SiloNodeClient(
    config.node.adminUrl,
    resolveNodeAdminToken(config.node.adminToken)
  );

  let store = buildStore(config, nodeKeyRef, log);

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

  // Graceful shutdown on both Ctrl-C and supervisor stops (Docker/Kubernetes/
  // systemd send SIGTERM): flush pending conversation buffers, then close.
  // A second signal during the flush must not restart it.
  //
  // Registered BEFORE startup, not after. Scope discovery and the relay
  // connect can take seconds against a slow silo, and a signal arriving in
  // that window used to hit Node's default disposition — the process died
  // outright and anything already buffered went with it. `startup` is what
  // makes early registration safe: the handler waits for an in-flight start
  // instead of racing relay.close() against relay.connect().
  let shuttingDown = false;
  let startup: Promise<void> | null = null;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received — flushing pending captures`);
    if (startup) {
      // A startup that is itself failing still needs tearing down, so the
      // rejection is swallowed here — boot's caller already sees it.
      await startup.catch(() => {});
    }
    // Stop intake FIRST: events delivered during the final flush would land
    // in the window after it and be dropped silently on exit. Closing the
    // relay before stop() means already-queued command replies may fail
    // delivery (logged, capture still happens) — during shutdown, capture
    // integrity outranks replies.
    relay.close();
    try {
      await agent.stop();
    } catch (err) {
      console.error("shutdown flush failed:", err);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));

  // Scope discovery first: logs the connection's silos/shapes and warns on
  // buckets the connection can't reach.
  startup = (async () => {
    if (store.init) await store.init();
    await agent.start();
  })();
  await startup;

  // A signal during startup means the handler is already flushing and about
  // to exit; announcing the agent as online on the way out is just noise.
  if (!shuttingDown) opts.onStarted?.(identity);
  return { identity, shutdown };
}
