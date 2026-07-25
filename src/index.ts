/**
 * Entrypoint: connect the Silo Memory agent to a real Buzz workspace relay.
 *
 * First run: `npm run connect` to pair with the Silo control plane (OAuth,
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
    console.error("Not paired with Silo yet. Run: npm run connect");
    process.exit(1);
  }
  const mcp = new McpClient(`${config.silo.serverUrl}/mcp`, oauth);
  store = new McpSiloStore(mcp, config.silo.siloId, log);
} else {
  store = new LocalSiloStore(config.silo.path);
}

const relay = new WebSocketRelay(config.relayUrl, identity);
const agent = new SiloMemoryAgent(relay, store, identity, {
  channelIds: config.channelIds,
  log,
});

agent.start().catch((err) => {
  console.error("failed to start agent:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  relay.close();
  process.exit(0);
});
