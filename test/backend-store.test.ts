/**
 * SiloBackendStore against a stubbed fetch: verifies the wire format of the
 * real backend contract (REST memory CRUD + MCP silo_recall) and the
 * provenance round-trip through memory metadata.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SiloBackendStore } from "../src/silo/client.js";
import type { Memory } from "../src/silo/types.js";

const config = {
  baseUrl: "https://api.onesilo.test",
  siloId: "silo-1",
  apiToken: "tok",
};

const REST = `${config.baseUrl}/api/v1/share/silos/${config.siloId}`;

interface Recorded {
  url: string;
  method: string;
  body?: unknown;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(routes: Record<string, (req: Recorded) => { status?: number; json: unknown }>) {
  const calls: Recorded[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const req: Recorded = {
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(req);
    const key = `${req.method} ${url}`;
    const route = Object.entries(routes).find(([k]) => key.startsWith(k));
    if (!route) return new Response("not found", { status: 404 });
    const { status = 200, json } = route[1](req);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const memory: Memory = {
  id: "abc123",
  kind: "decision",
  content: "we decided to ship Friday",
  raw: "after debate: we decided to ship Friday",
  source: { eventId: "ev1", authorPubkey: "pk1", channelId: "eng", createdAt: 1_753_000_000 },
  salience: 0.9,
  tags: ["decided", "ship", "friday"],
};

test("remember POSTs the backend memory shape with provenance metadata", async () => {
  const calls = stubFetch({
    [`POST ${REST}/memories`]: (req) => ({ status: 201, json: req.body }),
  });
  await new SiloBackendStore(config).remember(memory);
  assert.equal(calls.length, 1);
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body.type, "decision");
  assert.equal(body.content, memory.content);
  const meta = body.metadata as Record<string, unknown>;
  assert.equal(meta.buzz_channel_id, "eng");
  assert.equal(meta.buzz_event_id, "ev1");
  assert.equal(meta.salience, 0.9);
});

test("recall calls MCP silo_recall and hydrates provenance from REST", async () => {
  stubFetch({
    [`POST ${config.baseUrl}/mcp`]: (req) => {
      const params = (req.body as { params: { name: string; arguments: Record<string, unknown> } }).params;
      assert.equal(params.name, "silo_recall");
      assert.equal(params.arguments.silo_id, config.siloId);
      assert.equal(params.arguments.query, "ship date");
      return {
        json: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            structuredContent: {
              memories: [{ id: "abc123", type: "decision", content: memory.content, score: 0.87 }],
            },
          },
        },
      };
    },
    [`GET ${REST}/memories`]: () => ({
      json: {
        memories: [
          {
            id: "abc123",
            type: "decision",
            content: memory.content,
            created_at: "2025-07-20T08:26:40.000Z",
            metadata: {
              raw: memory.raw,
              salience: 0.9,
              tags: memory.tags,
              buzz_channel_id: "eng",
              buzz_event_id: "ev1",
              buzz_author_pubkey: "pk1",
            },
          },
        ],
      },
    }),
  });
  const results = await new SiloBackendStore(config).recall({ text: "ship date" });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.score, 0.87);
  assert.equal(results[0]!.memory.source.channelId, "eng");
  assert.equal(results[0]!.memory.source.authorPubkey, "pk1");
  assert.equal(results[0]!.memory.kind, "decision");
});

test("forget maps backend 404 to false", async () => {
  stubFetch({
    [`DELETE ${REST}/memories/gone`]: () => ({ status: 404, json: { detail: "memory not found" } }),
    [`DELETE ${REST}/memories/abc123`]: () => ({ json: { deleted: "abc123" } }),
  });
  const store = new SiloBackendStore(config);
  assert.equal(await store.forget("abc123"), true);
  assert.equal(await store.forget("gone"), false);
});
