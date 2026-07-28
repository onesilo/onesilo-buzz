/**
 * Client for a local onesilo-node (https://github.com/onesilo/onesilo-node).
 *
 * The node's admin API serves POST /v1/compute/generate: one-shot text
 * generation on the node's own Ollama-backed model. The agent uses it to
 * distill conversation transcripts **on hardware the operator owns**, so
 * raw conversation never reaches the One Silo control plane — only the
 * distilled memory statements do.
 *
 * Out-of-the-box pairing: the node's admin API listens on 127.0.0.1:8766
 * and `onesilo-node setup` writes its token to ~/.onesilo-node/admin.token, so an
 * agent running on the same machine needs zero configuration.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The node is unreachable or its compute capability is down (connection
 * refused / 503). Retryable: captures should buffer and try again — never
 * fall back to shipping raw transcripts.
 */
export class NodeUnavailableError extends Error {
  constructor(detail: string) {
    super(`onesilo-node unavailable: ${detail}`);
  }
}

export interface NodeGenerateResult {
  text: string;
  model: string;
}

/** Where `onesilo-node setup` persists the admin token. */
export const DEFAULT_NODE_TOKEN_PATH = join(homedir(), ".onesilo-node", "admin.token");

/** Where the node generates its memory/relay API key on first start. */
export const DEFAULT_NODE_KEY_PATH = join(homedir(), ".onesilo-node", "node.key");

/**
 * Resolve the node admin token: explicit env value first, then the token
 * file the setup wizard writes. "" when neither exists (calls will 401
 * with a pointed error message).
 */
export function resolveNodeAdminToken(
  explicit: string | undefined,
  tokenPath: string = DEFAULT_NODE_TOKEN_PATH
): string {
  if (explicit && explicit.trim()) return explicit.trim();
  try {
    return readFileSync(tokenPath, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Resolve the node key (X-Silo-Node-Key, authenticates the node's LAN APIs:
 * memory and the cloud relay): explicit env value first, then the key file
 * the node writes on first start. "" when neither exists — callers may then
 * fall back to reading it from the admin API (SiloNodeClient.nodeKey).
 */
export function resolveNodeKey(
  explicit: string | undefined,
  keyPath: string = DEFAULT_NODE_KEY_PATH
): string {
  if (explicit && explicit.trim()) return explicit.trim();
  try {
    return readFileSync(keyPath, "utf8").trim();
  } catch {
    return "";
  }
}

export class SiloNodeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly adminToken: string,
    /** Local models can be slow on first load; be generous. */
    private readonly timeoutMs = 120_000
  ) {}

  get url(): string {
    return this.baseUrl;
  }

  get hasToken(): boolean {
    return this.adminToken !== "";
  }

  /** Liveness probe (GET /healthz, no auth). */
  async health(): Promise<boolean> {
    try {
      const res = await this.fetch("/healthz", { method: "GET" }, 3_000);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * The node key from admin GET /v1/status (the documented way to read it).
   * Fallback for when ~/.onesilo-node/node.key isn't readable directly.
   */
  async nodeKey(): Promise<string> {
    const res = await this.fetch(
      "/v1/status",
      { method: "GET", headers: { Authorization: `Bearer ${this.adminToken}` } },
      5_000
    );
    if (!res.ok) {
      throw new Error(`onesilo-node status failed (${res.status}): ${await errorDetail(res)}`);
    }
    const body = (await res.json()) as { node_key?: string };
    return body.node_key ?? "";
  }

  /** One-shot completion on the node's local model. */
  async generate(prompt: string, temperature = 0.2): Promise<NodeGenerateResult> {
    let res: Response;
    try {
      res = await this.fetch("/v1/compute/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.adminToken}`,
        },
        body: JSON.stringify({ prompt, temperature }),
      });
    } catch (err) {
      throw new NodeUnavailableError(`${this.baseUrl} unreachable (${err})`);
    }
    if (res.status === 503) {
      const detail = await errorDetail(res);
      throw new NodeUnavailableError(`compute not ready at ${this.baseUrl}: ${detail}`);
    }
    if (res.status === 401) {
      throw new Error(
        `onesilo-node rejected the admin token (401). Set NODE_ADMIN_TOKEN or run ` +
          `\`onesilo-node setup\` so ${DEFAULT_NODE_TOKEN_PATH} exists.`
      );
    }
    if (!res.ok) {
      throw new Error(`onesilo-node generate failed (${res.status}): ${await errorDetail(res)}`);
    }
    const body = (await res.json()) as { text?: string; model?: string };
    if (typeof body.text !== "string") {
      throw new Error("onesilo-node generate returned no text");
    }
    return { text: body.text, model: body.model ?? "unknown" };
  }

  private async fetch(path: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? res.statusText;
  } catch {
    return res.statusText;
  }
}
