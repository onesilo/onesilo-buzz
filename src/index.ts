/**
 * Entrypoint: connect the Silo Memory agent to a real Buzz workspace relay.
 * For a zero-infrastructure walkthrough, run `npm run demo` instead.
 */

import { loadConfig } from "./config.js";
import { loadIdentity, exportSecretKeyHex } from "./buzz/identity.js";
import { WebSocketRelay } from "./buzz/relay.js";
import { LocalSiloStore } from "./silo/local.js";
import { SiloBackendStore } from "./silo/client.js";
import { SiloMemoryAgent } from "./agent.js";
import type { MemoryStore } from "./silo/types.js";

const config = loadConfig();
const identity = loadIdentity(config.agentHandle, config.agentSecretKeyHex);
if (!config.agentSecretKeyHex) {
  console.log(
    `Generated a new agent keypair. To keep this identity, set AGENT_SECRET_KEY=${exportSecretKeyHex(identity)}`
  );
}

const store: MemoryStore =
  config.silo.mode === "backend"
    ? new SiloBackendStore(config.silo)
    : new LocalSiloStore(config.silo.path);

const relay = new WebSocketRelay(config.relayUrl, identity);
const agent = new SiloMemoryAgent(relay, store, identity, {
  channelIds: config.channelIds,
  log: (line) => console.log(`[silo-memory] ${line}`),
});

agent.start().catch((err) => {
  console.error("failed to start agent:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  relay.close();
  process.exit(0);
});
