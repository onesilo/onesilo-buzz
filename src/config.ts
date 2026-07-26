/** Environment-driven configuration. See .env.example for every variable. */

export interface Config {
  relayUrl: string;
  agentHandle: string;
  agentSecretKeyHex?: string;
  channelIds: string[];
  /** Conversation-capture tuning (turn window size, overlap, idle flush). */
  capture: {
    maxTurns: number;
    overlapTurns: number;
    idleFlushMs: number;
  };
  /**
   * Where transcript distillation happens. "cloud": segments go to the silo
   * raw and One Silo's pipeline distills them. "node": a local silo-node
   * distills first and only distilled statements leave the machine.
   */
  distill:
    | { mode: "cloud" }
    | {
        mode: "node";
        /** silo-node admin API origin. */
        url: string;
        /** Explicit admin token; empty = read ~/.silo-node/admin.token. */
        adminToken?: string;
      };
  silo:
    | { mode: "local"; path: string }
    | {
        mode: "mcp";
        /** Control-plane origin, e.g. https://api.onesilo.com */
        serverUrl: string;
        /** Default memory bucket; "default" = the connection's auto-provisioned silo. */
        siloId: string;
        /** Raw "channel=silo_id,..." map for per-channel memory buckets. */
        channelMap: string;
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
    capture: {
      maxTurns: parseCount(env.CAPTURE_WINDOW_TURNS, 12),
      overlapTurns: parseCount(env.CAPTURE_OVERLAP_TURNS, 2, 0),
      idleFlushMs: parseCount(env.CAPTURE_IDLE_FLUSH_SECONDS, 600) * 1000,
    },
    distill:
      env.DISTILL_MODE === "node"
        ? {
            mode: "node",
            url: env.NODE_URL ?? "http://127.0.0.1:8766",
            adminToken: env.NODE_ADMIN_TOKEN,
          }
        : { mode: "cloud" },
    silo:
      mode === "mcp"
        ? {
            mode,
            serverUrl: env.SILO_SERVER_URL ?? "https://api.onesilo.com",
            siloId: env.SILO_ID ?? "default",
            channelMap: env.SILO_CHANNEL_MAP ?? "",
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

/** Non-negative integer env parse with a fallback (min defaults to 1). */
function parseCount(value: string | undefined, fallback: number, min = 1): number {
  const n = parseInt(value ?? "", 10);
  return Number.isInteger(n) && n >= min ? n : fallback;
}
