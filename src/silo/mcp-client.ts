/**
 * Minimal MCP client over Streamable HTTP — the same transport the Silo
 * control plane serves at /mcp for ChatGPT, Claude Desktop, and Cursor.
 *
 * Handles: initialize / notifications/initialized handshake, Mcp-Session-Id
 * propagation, JSON and single-event SSE response bodies, and one automatic
 * OAuth refresh + retry on 401.
 */

import type { SiloOAuthClient } from "./oauth.js";

const PROTOCOL_VERSION = "2025-06-18";

export interface ToolResult {
  /** Parsed structuredContent if present, else JSON-parsed first text block, else raw text. */
  payload: unknown;
  isError: boolean;
}

export class McpClient {
  private sessionId?: string;
  private initialized = false;
  private rpcId = 0;

  constructor(
    /** Full MCP endpoint URL, e.g. https://api.onesilo.com/mcp */
    private readonly url: string,
    private readonly oauth: SiloOAuthClient,
    private readonly clientInfo = { name: "buzz-silo-memory", version: "0.1.0" }
  ) {}

  private async post(body: unknown, retryOn401 = true): Promise<{ rpc: unknown; res: Response }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.oauth.accessToken()}`,
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body) });

    if (res.status === 401 && retryOn401) {
      await this.oauth.refresh();
      return this.post(body, false);
    }
    if (!res.ok && res.status !== 202) {
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
    const error = (rpc as { error?: { message?: string } })?.error;
    if (error) throw new Error(`MCP initialize failed: ${error.message}`);
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.initialized = true;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    await this.initialize();
    const { rpc } = await this.post({
      jsonrpc: "2.0",
      id: ++this.rpcId,
      method: "tools/call",
      params: { name, arguments: args },
    });
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
