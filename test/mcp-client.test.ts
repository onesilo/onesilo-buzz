import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { McpClient } from "../src/silo/mcp-client.js";
import type { SiloOAuthClient } from "../src/silo/oauth.js";

const URL_ = "https://api.onesilo.test/mcp";

function fakeOauth(
  tokens: string[],
  startWithoutAccessToken = false
): SiloOAuthClient & { refreshes: number } {
  let i = startWithoutAccessToken ? -1 : 0;
  const o = {
    refreshes: 0,
    accessToken: () => {
      if (i < 0) throw new Error("no access token");
      return tokens[Math.min(i, tokens.length - 1)]!;
    },
    refresh: async () => {
      o.refreshes += 1;
      i += 1;
    },
    ensureAccessToken: async () => {
      if (i < 0) await o.refresh();
      return o.accessToken();
    },
  };
  return o as unknown as SiloOAuthClient & { refreshes: number };
}

interface Recorded {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(respond: (req: Recorded, n: number) => Response) {
  const calls: Recorded[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const req: Recorded = {
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ])
      ),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    };
    calls.push(req);
    return respond(req, calls.length);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(rpc: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(rpc), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("initialize handshake captures session id and reuses it for tools/call", async () => {
  const calls = stubFetch((req) => {
    if (req.body.method === "initialize") {
      return jsonResponse(
        { jsonrpc: "2.0", id: req.body.id, result: { protocolVersion: "2025-06-18" } },
        { "mcp-session-id": "sess-1" }
      );
    }
    if (req.body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    return jsonResponse({
      jsonrpc: "2.0",
      id: req.body.id,
      result: { structuredContent: { ok: true } },
    });
  });

  const client = new McpClient(URL_, fakeOauth(["tok"]));
  const result = await client.callTool("silo_recall", { silo_id: "default", query: "x" });

  assert.deepEqual(result.payload, { ok: true });
  assert.equal(calls.length, 3); // initialize, initialized, tools/call
  assert.equal(calls[1]!.headers["mcp-session-id"], "sess-1");
  assert.equal(calls[2]!.headers["mcp-session-id"], "sess-1");
  assert.equal(calls[2]!.headers["authorization"], "Bearer tok");
});

test("401 triggers one refresh and a retry with the new token", async () => {
  const oauth = fakeOauth(["stale", "fresh"]);
  const calls = stubFetch((req) => {
    if (req.headers["authorization"] === "Bearer stale") {
      return new Response("unauthorized", { status: 401 });
    }
    if (req.body.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: req.body.id, result: {} });
    }
    if (req.body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    return jsonResponse({ jsonrpc: "2.0", id: req.body.id, result: { structuredContent: {} } });
  });

  const client = new McpClient(URL_, oauth);
  await client.callTool("silo_recall", { silo_id: "default", query: "x" });
  assert.equal(oauth.refreshes, 1);
  assert.ok(calls.some((c) => c.headers["authorization"] === "Bearer fresh"));
});

test("bootstraps via refresh when only a refresh token is stored", async () => {
  const oauth = fakeOauth(["fresh"], true); // no access token until refresh
  stubFetch((req) => {
    if (req.body.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: req.body.id, result: {} });
    }
    if (req.body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    return jsonResponse({ jsonrpc: "2.0", id: req.body.id, result: { structuredContent: {} } });
  });
  const client = new McpClient(URL_, oauth);
  await client.callTool("silo_recall", { silo_id: "default", query: "x" });
  assert.equal(oauth.refreshes, 1);
});

test("an empty tools/call response is an error, not a silent success", async () => {
  stubFetch((req) => {
    if (req.body.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: req.body.id, result: {} });
    }
    return new Response(null, { status: 202 }); // empty body for tools/call
  });
  const client = new McpClient(URL_, fakeOauth(["tok"]));
  await assert.rejects(
    () => client.callTool("silo_remember", { silo_id: "default", content: "x" }),
    /empty response/
  );
});

test("parses single-event SSE response bodies", async () => {
  stubFetch((req) => {
    if (req.body.method === "initialize") {
      return jsonResponse({ jsonrpc: "2.0", id: req.body.id, result: {} });
    }
    if (req.body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    const rpc = JSON.stringify({
      jsonrpc: "2.0",
      id: req.body.id,
      result: { content: [{ type: "text", text: JSON.stringify({ answer: "42" }) }] },
    });
    return new Response(`event: message\ndata: ${rpc}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });

  const client = new McpClient(URL_, fakeOauth(["tok"]));
  const result = await client.callTool("silo_ask", { silo_id: "default", question: "?" });
  assert.deepEqual(result.payload, { answer: "42" });
});
