/** Environment-driven configuration. See .env.example for every variable. */

import { existsSync } from "node:fs";

/**
 * Load `.env` from the working directory into process.env.
 *
 * Every entrypoint calls this before loadConfig(). It exists because the
 * documented flow (`cp .env.example .env`) shipped for months with nothing
 * actually reading the file — settings landed in the defaults silently.
 * Node's built-in loader keeps the right precedence: a variable already
 * exported in the shell wins over the file, same as `node --env-file`.
 * Idempotent, so the CLI and a dynamically imported entrypoint (connect)
 * can both call it.
 */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch {
    // Unreadable or malformed file: exported variables still apply, and
    // failing to boot over an optional file would be worse than ignoring it.
  }
}

export interface Config {
  relayUrl: string;
  agentHandle: string;
  /** Avatar URL published in the kind 0 profile (NIP-01 `picture`). */
  agentPictureUrl: string;
  agentSecretKeyHex?: string;
  channelIds: string[];
  /** Conversation-capture tuning (turn window size, overlap, idle flush). */
  capture: {
    maxTurns: number;
    overlapTurns: number;
    idleFlushMs: number;
  };
  /**
   * A local onesilo-node's endpoints and credentials, shared by every
   * node-facing feature (DISTILL_MODE=node, SILO_MODE=relay|node).
   * Defaults match `onesilo-node setup` on the same machine.
   */
  node: {
    /** Admin API origin (compute/generate, status). */
    adminUrl: string;
    /** Explicit admin token; empty = read ~/.onesilo-node/admin.token. */
    adminToken?: string;
    /** LAN API origin (memory API, /v1/cloud relay). */
    lanUrl: string;
    /** Explicit node key; empty = read ~/.onesilo-node/node.key. */
    key?: string;
  };
  /**
   * Where transcript distillation happens. "cloud": segments go to the silo
   * raw and One Silo's pipeline distills them. "node": a local onesilo-node
   * distills first and only distilled statements leave the machine.
   */
  distill: "cloud" | "node";
  silo:
    | { mode: "local"; path: string }
    | {
        mode: "mcp";
        /** Control-plane origin, e.g. https://connect.onesilo.com */
        serverUrl: string;
        /** Default memory bucket; "default" = the connection's auto-provisioned silo. */
        siloId: string;
        /** Raw "channel=silo_id,..." map for per-channel memory buckets. */
        channelMap: string;
        tokenPath: string;
        callbackPort: number;
      }
    | {
        /**
         * One Silo through a gateway onesilo-node's /v1/cloud/mcp relay: the
         * node holds the only cloud credential; the agent authenticates to
         * the node with the node key and never pairs itself.
         */
        mode: "relay";
        siloId: string;
        channelMap: string;
      }
    | {
        /**
         * Memory served entirely by a local onesilo-node's memory API — the
         * fully on-machine stack when combined with DISTILL_MODE=node.
         */
        mode: "node";
        siloId: string;
        channelMap: string;
      };
}

/** The dev default; a real workspace sets BUZZ_RELAY_URL (the CLI asks). */
export const DEFAULT_RELAY_URL = "ws://localhost:7777";

const SILO_MODES = new Set(["mcp", "local", "relay", "node"]);

export function loadConfig(env = process.env): Config {
  const mode = SILO_MODES.has(env.SILO_MODE ?? "")
    ? (env.SILO_MODE as "mcp" | "local" | "relay" | "node")
    : "mcp";
  return {
    relayUrl: env.BUZZ_RELAY_URL ?? DEFAULT_RELAY_URL,
    agentHandle: env.AGENT_HANDLE ?? "OneSilo",
    // Defaults to the One Silo mark already served from the marketing site.
    // Set AGENT_PICTURE_URL to rebrand, or to "" to publish no avatar.
    agentPictureUrl:
      env.AGENT_PICTURE_URL ?? "https://onesilo.com/apple-touch-icon.png",
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
    node: (() => {
      const adminUrl = env.NODE_URL ?? "http://127.0.0.1:8766";
      const lanUrl = env.NODE_LAN_URL ?? "http://127.0.0.1:8765";
      // The node admin token and node key are high-value secrets (the admin
      // token can read the node key and drive local compute). The whole
      // design assumes the node is on this machine, so refuse to attach
      // those credentials to a non-loopback host unless the operator
      // explicitly opts in — and even then require https so they never go
      // out in cleartext. Guards against a misconfigured NODE_URL silently
      // exfiltrating credentials.
      const allowRemote = env.NODE_ALLOW_REMOTE === "1";
      assertNodeUrlSafe("NODE_URL", adminUrl, allowRemote);
      assertNodeUrlSafe("NODE_LAN_URL", lanUrl, allowRemote);
      return {
        adminUrl,
        adminToken: env.NODE_ADMIN_TOKEN,
        lanUrl,
        key: env.NODE_KEY,
      };
    })(),
    distill: env.DISTILL_MODE === "node" ? "node" : "cloud",
    silo: siloConfig(mode, env),
  };
}

function siloConfig(
  mode: "mcp" | "local" | "relay" | "node",
  env: NodeJS.ProcessEnv
): Config["silo"] {
  switch (mode) {
    case "mcp":
      return {
        mode,
        // The control plane, not the data plane. OAuth discovery and the MCP
        // endpoint are both served here, and the discovery document's issuer
        // and endpoints are minted from this origin — pointing at the data
        // plane (api.onesilo.com) makes the same-origin check in
        // silo/oauth.ts reject the discovered endpoints.
        serverUrl: env.SILO_SERVER_URL ?? "https://connect.onesilo.com",
        siloId: env.SILO_ID ?? "default",
        channelMap: env.SILO_CHANNEL_MAP ?? "",
        tokenPath: env.SILO_TOKEN_PATH ?? ".silo/oauth.json",
        callbackPort: parsePort(env.SILO_OAUTH_CALLBACK_PORT, 8765),
      };
    case "relay":
    case "node":
      return {
        mode,
        siloId: env.SILO_ID ?? "default",
        channelMap: env.SILO_CHANNEL_MAP ?? "",
      };
    case "local":
      return { mode, path: env.SILO_LOCAL_PATH ?? ".silo/memories.json" };
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Reject a node URL that would send the admin token / node key somewhere
 * unsafe. Loopback hosts are always fine (http included). A non-loopback
 * host is refused unless NODE_ALLOW_REMOTE=1, and even then must be https
 * so credentials are never sent in cleartext.
 */
function assertNodeUrlSafe(name: string, raw: string, allowRemote: boolean): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL: ${raw}`);
  }
  const host = url.hostname;
  if (LOOPBACK_HOSTS.has(host)) return;
  if (!allowRemote) {
    throw new Error(
      `${name}=${raw} points at a non-loopback host. The node admin token / node key ` +
        `must not be sent off this machine. Set NODE_ALLOW_REMOTE=1 (and use https://) ` +
        `only if you intend to reach a remote node over a trusted channel.`
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `${name}=${raw} is a remote host over plaintext ${url.protocol}. ` +
        `Use https:// so the node credentials aren't exposed on the wire.`
    );
  }
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
