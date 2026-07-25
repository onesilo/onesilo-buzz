/** Environment-driven configuration. See .env.example for every variable. */

export interface Config {
  relayUrl: string;
  agentHandle: string;
  agentSecretKeyHex?: string;
  channelIds: string[];
  silo:
    | { mode: "local"; path: string }
    | { mode: "backend"; baseUrl: string; siloId: string; apiToken: string };
}

export function loadConfig(env = process.env): Config {
  const mode = env.SILO_MODE === "backend" ? "backend" : "local";
  return {
    relayUrl: env.BUZZ_RELAY_URL ?? "ws://localhost:7777",
    agentHandle: env.AGENT_HANDLE ?? "silo",
    agentSecretKeyHex: env.AGENT_SECRET_KEY,
    channelIds: (env.BUZZ_CHANNEL_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    silo:
      mode === "backend"
        ? {
            mode,
            baseUrl: required(env, "SILO_API_URL"),
            siloId: required(env, "SILO_ID"),
            apiToken: required(env, "SILO_API_TOKEN"),
          }
        : { mode, path: env.SILO_LOCAL_PATH ?? ".silo/memories.json" },
  };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required env var ${key} (SILO_MODE=backend)`);
  return value;
}
