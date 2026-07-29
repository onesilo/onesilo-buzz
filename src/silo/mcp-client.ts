/**
 * Minimal MCP client over Streamable HTTP — the same transport the One Silo
 * control plane serves at /mcp for ChatGPT, Claude Desktop, and Cursor.
 *
 * Handles: initialize / notifications/initialized handshake, Mcp-Session-Id
 * propagation, JSON and single-event SSE response bodies, and one automatic
 * OAuth refresh + retry on 401.
 */

const PROTOCOL_VERSION = "2025-06-18";

export interface ToolResult {
  /** Parsed structuredContent if present, else JSON-parsed first text block, else raw text. */
  payload: unknown;
  isError: boolean;
}

/** The OAuth surface McpClient historically consumed (SiloOAuthClient). */
export interface OAuthLike {
  ensureAccessToken(): Promise<string>;
  refresh(): Promise<unknown>;
}

/**
 * Pluggable request auth: the cloud MCP endpoint wants an OAuth bearer
 * token; a gateway onesilo-node's relay (/v1/cloud/mcp) wants the node key.
 */
export interface McpAuth {
  headers(): Promise<Record<string, string>>;
  /** Attempt 401 recovery; true = retry the request once. */
  reauthorize(): Promise<boolean>;
}

/** Node-key auth for a gateway node's MCP relay. Resolved per request. */
export function nodeKeyAuth(key: () => string): McpAuth {
  return {
    headers: async () => ({ "X-Silo-Node-Key": key() }),
    // A rejected node key won't heal by retrying — fail loudly instead.
    reauthorize: async () => false,
  };
}

function normalizeAuth(auth: OAuthLike | McpAuth): McpAuth {
  if ("ensureAccessToken" in auth) {
    return {
      headers: async () => ({ Authorization: `Bearer ${await auth.ensureAccessToken()}` }),
      reauthorize: async () => {
        await auth.refresh();
        return true;
      },
    };
  }
  return auth;
}

export class McpClient {
  private readonly auth: McpAuth;
  private sessionId?: string;
  private initialized = false;
  private rpcId = 0;

  constructor(
    /** Full MCP endpoint URL, e.g. https://connect.onesilo.com/mcp */
    private readonly url: string,
    auth: OAuthLike | McpAuth,
    private readonly clientInfo = { name: "buzz-silo-memory", version: "0.1.0" }
  ) {
    this.auth = normalizeAuth(auth);
  }

  private async post(body: unknown, retryOn401 = true): Promise<{ rpc: unknown; res: Response }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(await this.auth.headers()),
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body) });

    if (res.status === 401 && retryOn401 && (await this.auth.reauthorize())) {
      return this.post(body, false);
    }
    if (!res.ok && res.status !== 202) {
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        // Auth or session is dead (404 = expired session per Streamable
        // HTTP; 401 here means the refresh retry failed too). Drop the
        // session so the next call re-initializes instead of failing
        // forever on stale state.
        this.sessionId = undefined;
        this.initialized = false;
      }
      throw new Error(`MCP ${this.url} -> ${res.status}`);
    }
    const newSession = res.headers.get("mcp-session-id");
    if (newSession) this.sessionId = newSession;

    if (res.status === 202 || res.headers.get("content-length") === "0") {
      return { rpc: undefined, res };
    }
    return { rpc: await parseBody(res), res };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const { rpc } = await this.post({
        jsonrpc: "2.0",
        id: ++this.rpcId,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: this.clientInfo,
        },
      });
      if (rpc === undefined) {
        throw new Error("MCP initialize returned an empty response");
      }
      const error = (rpc as { error?: { message?: string } })?.error;
      if (error) throw new Error(`MCP initialize failed: ${error.message}`);
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
      this.initialized = true;
    } catch (err) {
      // A partial handshake must not leave a half-open session behind —
      // the server may already have issued an Mcp-Session-Id.
      this.sessionId = undefined;
      this.initialized = false;
      throw err;
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    await this.initialize();
    const { rpc } = await this.post({
      jsonrpc: "2.0",
      id: ++this.rpcId,
      method: "tools/call",
      params: { name, arguments: args },
    });
    if (rpc === undefined) {
      // 202/empty bodies are valid for notifications, never for tools/call
      // — treating one as success would fake a successful capture.
      throw new Error(`${name} returned an empty response`);
    }
    const error = (rpc as { error?: { message?: string } })?.error;
    if (error) throw new Error(`${name} failed: ${error.message}`);
    const result = ((rpc as { result?: Record<string, unknown> })?.result ?? {}) as Record<string, unknown>;
    return { payload: extractPayload(result), isError: Boolean(result["isError"]) };
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    // Streamable HTTP: the response to a POSTed request is delivered as one
    // (or more) SSE message events; the last data payload carries the result.
    const datas = text
      .split(/\n\n/)
      .map((chunk) =>
        chunk
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("")
      )
      .filter(Boolean);
    return datas.length ? JSON.parse(datas[datas.length - 1]!) : undefined;
  }
  return JSON.parse(text);
}

function extractPayload(result: Record<string, unknown>): unknown {
  if (result["structuredContent"] !== undefined) return result["structuredContent"];
  const content = result["content"] as Array<{ type: string; text?: string }> | undefined;
  const textBlock = content?.find((c) => c.type === "text" && typeof c.text === "string");
  if (!textBlock?.text) return result;
  try {
    return JSON.parse(textBlock.text);
  } catch {
    return textBlock.text;
  }
}
