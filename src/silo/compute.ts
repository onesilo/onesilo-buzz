/**
 * CloudComputeClient — the control plane's OpenAI-compatible compute
 * endpoint (POST /v1/chat/completions), reached with the same McpAuth the
 * MCP store uses (OAuth bearer from pairing, or a node key via relay).
 *
 * Governance is entirely server-side: the connection's model policy is
 * enforced at execution, usage counts against the owner's plan in
 * interactions, and gate refusals come back as OpenAI-style errors.
 */

import { normalizeAuth, type McpAuth, type OAuthLike } from "./mcp-client.js";

export class ComputeGateError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class CloudComputeClient {
  private model: string | null = null;

  private readonly auth: McpAuth;

  constructor(
    private readonly serverUrl: string,
    auth: OAuthLike | McpAuth,
    private readonly log: (line: string) => void = () => {}
  ) {
    this.auth = normalizeAuth(auth);
  }

  /** One-shot prompt → text on the connection's resolved model. */
  async generate(prompt: string): Promise<{ text: string; model: string }> {
    const model = await this.resolveModel();
    const body = {
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    };
    const res = await this.post("/v1/chat/completions", body);
    const text: string = res?.choices?.[0]?.message?.content ?? "";
    return { text, model: String(res?.model ?? model) };
  }

  /** First model the connection resolves to; cached for the process. */
  private async resolveModel(): Promise<string> {
    if (this.model) return this.model;
    const res = await this.request("GET", "/v1/models", undefined);
    const first = res?.data?.[0]?.id;
    if (!first) {
      throw new Error(
        "compute: the control plane returned no usable models for this connection"
      );
    }
    this.model = String(first);
    this.log(`compute model resolved: ${this.model}`);
    return this.model;
  }

  private post(path: string, body: unknown): Promise<any> {
    return this.request("POST", path, body);
  }

  /** Same 401 posture as the MCP client: one reauthorize + retry. */
  private async request(
    method: string,
    path: string,
    body: unknown,
    retried = false
  ): Promise<any> {
    const headers: Record<string, string> = {
      ...(await this.auth.headers()),
      "content-type": "application/json",
    };
    const res = await fetch(`${this.serverUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !retried && (await this.auth.reauthorize())) {
      return this.request(method, path, body, true);
    }
    if (res.status === 402 || res.status === 429) {
      const payload: any = await res.json().catch(() => ({}));
      const msg =
        payload?.error?.message ?? "compute gated by the owner's plan";
      throw new ComputeGateError(String(msg), res.status);
    }
    if (!res.ok) {
      throw new Error(`compute ${method} ${path}: HTTP ${res.status}`);
    }
    return res.json();
  }
}
