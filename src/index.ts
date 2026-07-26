/**
 * Entrypoint: connect the memory agent to a real Buzz workspace relay.
 *
 * First run: `npm run connect` to pair with the One Silo control plane (OAuth,
 * one-time human approval). Then `npm start`. For a zero-infrastructure
 * walkthrough, run `npm run demo` instead.
 */

import { loadConfig } from "./config.js";
import { loadIdentity, exportSecretKeyHex } from "./buzz/identity.js";
import { WebSocketRelay } from "./buzz/relay.js";
import { LocalSiloStore } from "./silo/local.js";
import { SiloOAuthClient } from "./silo/oauth.js";
import { McpClient } from "./silo/mcp-client.js";
import { McpSiloStore } from "./silo/mcp-store.js";
import { SiloBucketRouter } from "./silo/buckets.js";
import { wrapWithNodeDistillation } from "./silo/node-distill.js";
import { SiloNodeClient, resolveNodeAdminToken } from "./node/client.js";
import { SiloMemoryAgent } from "./agent.js";
import type { MemoryStore } from "./silo/types.js";

const log = (line: string) => console.log(`[silo-memory] ${line}`);

const config = loadConfig();
const identity = loadIdentity(config.agentHandle, config.agentSecretKeyHex);
if (!config.agentSecretKeyHex) {
  console.log(
    `Generated a new agent keypair. To keep this identity, set AGENT_SECRET_KEY=${exportSecretKeyHex(identity)}`
  );
}

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
} else {
  store = new LocalSiloStore(config.silo.path);
}

// DISTILL_MODE=node: distill transcripts on a local silo-node so raw
// conversation never leaves this machine — only distilled statements sync.
if (config.distill.mode === "node") {
  const node = new SiloNodeClient(
    config.distill.url,
    resolveNodeAdminToken(config.distill.adminToken)
  );
  store = wrapWithNodeDistillation(store, node, log);
}

const relay = new WebSocketRelay(config.relayUrl, identity, log);
const agent = new SiloMemoryAgent(relay, store, identity, {
  channelIds: config.channelIds,
  capture: config.capture,
  log,
});

async function main() {
  // Scope discovery first: logs the connection's silos/shapes and warns on
  // buckets the connection can't reach.
  if (store.init) await store.init();
  await agent.start();
}

main().catch((err) => {
  console.error("failed to start agent:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  // Flush pending conversation buffers before going down, then close.
  void agent
    .stop()
    .catch((err) => console.error("shutdown flush failed:", err))
    .finally(() => {
      relay.close();
      process.exit(0);
    });
});
