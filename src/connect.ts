/**
 * One-time pairing CLI: registers the Buzz agent as an OAuth client on the
 * One Silo control plane and runs the authorization_code + PKCE flow. Prints the
 * authorize URL for the agent's human sponsor; once approved, the connection
 * (and its auto-provisioned default silo) appears in the One Silo dashboard.
 *
 *   npm run connect
 */

import { loadConfig, loadDotEnv } from "./config.js";
import { SiloOAuthClient } from "./silo/oauth.js";

loadDotEnv();
const config = loadConfig();
if (config.silo.mode !== "mcp") {
  // Name the mode that's actually set: relay/node modes authenticate with
  // the node key and never pair, local needs no credentials at all.
  console.error(
    `SILO_MODE=${config.silo.mode} needs no pairing. Set SILO_MODE=mcp (default) to connect.`
  );
  process.exit(1);
}

let oauth: SiloOAuthClient;
try {
  oauth = new SiloOAuthClient({
    serverUrl: config.silo.serverUrl,
    agentHandle: config.agentHandle,
    tokenPath: config.silo.tokenPath,
    callbackPort: config.silo.callbackPort,
  });
} catch (err) {
  // Corrupt credential file: instructions, not a module-level stack.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

oauth.pair().catch((err) => {
  console.error("pairing failed:", err);
  process.exit(1);
});
