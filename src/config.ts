/** Environment-driven configuration. See .env.example for every variable. */

export interface Config {
  relayUrl: string;
  agentHandle: string;
  agentSecretKeyHex?: string;
  channelIds: string[];
  silo:
    | { mode: "local"; path: string }
    | {
        mode: "mcp";
        /** Control-plane origin, e.g. https://api.onesilo.com */
        serverUrl: string;
        /** Cloud silo to use; "default" = the connection's auto-provisioned silo. */
        siloId: string;
        tokenPath: string;
        callbackPort: number;
      };
}

export function loadConfig(env = process.env): Config {
  const mode = env.SILO_MODE === "local" ? "local" : "mcp";
  return {
    relayUrl: env.BUZZ_RELAY_URL ?? "ws://localhost:7777",
    agentHandle: env.AGENT_HANDLE ?? "silo",
    agentSecretKeyHex: env.AGENT_SECRET_KEY,
    channelIds: (env.BUZZ_CHANNEL_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    silo:
      mode === "mcp"
        ? {
            mode,
            serverUrl: env.SILO_SERVER_URL ?? "https://api.onesilo.com",
            siloId: env.SILO_ID ?? "default",
            tokenPath: env.SILO_TOKEN_PATH ?? ".silo/oauth.json",
            callbackPort: parsePort(env.SILO_OAUTH_CALLBACK_PORT, 8765),
          }
        : { mode, path: env.SILO_LOCAL_PATH ?? ".silo/memories.json" },
  };
}

/** Tolerates empty/garbage values (e.g. a blanked-out .env line). */
function parsePort(value: string | undefined, fallback: number): number {
  const port = parseInt(value ?? "", 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}
