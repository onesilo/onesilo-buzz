/**
 * One-time pairing CLI: registers the Buzz agent as an OAuth client on the
 * One Silo control plane and runs the authorization_code + PKCE flow. Prints the
 * authorize URL for the agent's human sponsor; once approved, the connection
 * (and its auto-provisioned default silo) appears in the One Silo dashboard.
 *
 *   npm run connect
 */

import { loadConfig } from "./config.js";
import { SiloOAuthClient } from "./silo/oauth.js";

const config = loadConfig();
if (config.silo.mode !== "mcp") {
  console.error("SILO_MODE=local needs no pairing. Set SILO_MODE=mcp (default) to connect.");
  process.exit(1);
}

const oauth = new SiloOAuthClient({
  serverUrl: config.silo.serverUrl,
  agentHandle: config.agentHandle,
  tokenPath: config.silo.tokenPath,
  callbackPort: config.silo.callbackPort,
});

oauth.pair().catch((err) => {
  console.error("pairing failed:", err);
  process.exit(1);
});
