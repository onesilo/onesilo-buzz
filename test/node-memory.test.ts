import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { NodeMemoryStore } from "../src/silo/node-memory.js";
import { SiloBucketRouter } from "../src/silo/buckets.js";
import { McpClient, nodeKeyAuth } from "../src/silo/mcp-client.js";
import type { Memory } from "../src/silo/types.js";

/** In-memory fake of the onesilo-node memory API (per-silo id-keyed rows). */
function startFakeNodeMemory(): Promise<{
  server: Server;
  url: string;
  rows: Map<string, Map<string, { content: string; metadata?: Record<string, unknown> }>>;
  seenKeys: string[];
}> {
  const rows = new Map<string, Map<string, { content: string; metadata?: Record<string, unknown> }>>();
  const seenKeys: string[] = [];
  let nextId = 0;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let bodyText = "";
      req.on("data", (c) => (bodyText += c));
      req.on("end", () => {
        seenKeys.push(String(req.headers["x-silo-node-key"] ?? ""));
        const reply = (status: number, body: unknown) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };
        const url = req.url ?? "";
        const remember = url.match(/^\/v1\/memory\/([^/]+)\/remember$/);
        const recall = url.match(/^\/v1\/memory\/([^/]+)\/recall$/);
        const del = url.match(/^\/v1\/memory\/([^/]+)\/([^/]+)$/);
        if (req.method === "GET" && url === "/v1/memory/silos") {
          return reply(200, [...rows.entries()].map(([silo_id, m]) => ({ silo_id, count: m.size })));
        }
        if (req.method === "POST" && remember) {
          const silo = rows.get(remember[1]!) ?? new Map();
          rows.set(remember[1]!, silo);
          const id = `node-${++nextId}`;
          const body = JSON.parse(bodyText) as { content: string; metadata?: Record<string, unknown> };
          silo.set(id, body);
          return reply(200, { id });
        }
        if (req.method === "POST" && recall) {
          const silo = rows.get(recall[1]!) ?? new Map();
          const { query } = JSON.parse(bodyText) as { query: string };
          const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
          const results = [...silo.entries()]
            .filter(([, row]) => tokens.some((t) => row.content.toLowerCase().includes(t)))
            .map(([id, row]) => ({ id, content: row.content, score: 0.5, metadata: row.metadata }));
          return reply(200, { results });
        }
        if (req.method === "DELETE" && del) {
          const silo = rows.get(del[1]!);
          if (!silo?.delete(del[2]!)) return reply(404, { error: "memory not found" });
          return reply(200, { deleted: true });
        }
        reply(404, { error: "not found" });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, rows, seenKeys });
    });
  });
}

let seq = 0;
function memoryOf(content: string, channel = "eng"): Memory {
  seq += 1;
  return {
    id: `det-${seq}`,
    kind: "decision",
    content,
    raw: content,
    source: {
      eventId: `ev${seq}`,
      authorPubkey: "alicepubkey1234",
      channelId: channel,
      createdAt: 1_753_000_000 + seq,
    },
    salience: 0.9,
    tags: [],
  };
}

test("remember stores with trailer+metadata, recall round-trips provenance", async () => {
  const { server, url, rows, seenKeys } = await startFakeNodeMemory();
  try {
    const store = new NodeMemoryStore(url, () => "the-node-key");
    const outcome = await store.remember(memoryOf("we decided to ship Friday"));
    assert.equal(outcome.status, "stored");

    const stored = [...rows.get("default")!.values()][0]!;
    assert.match(stored.content, /we decided to ship Friday/);
    assert.match(stored.content, /\[buzz kind=decision .* channel=eng .*\]/);
    assert.equal((stored.metadata as { channel?: string }).channel, "eng");
    assert.ok(seenKeys.every((k) => k === "the-node-key"));

    const results = await store.recall({ text: "ship Friday" });
    assert.equal(results.length, 1);
    const m = results[0]!.memory;
    assert.equal(m.content, "we decided to ship Friday"); // trailer stripped
    assert.equal(m.kind, "decision");
    assert.equal(m.source.channelId, "eng");
    assert.match(m.id, /^node-/); // the node's id — what forget expects
  } finally {
    server.close();
  }
});

test("re-remembering the same deterministic id skips the duplicate insert", async () => {
  const { server, url, rows } = await startFakeNodeMemory();
  try {
    const store = new NodeMemoryStore(url, () => "k");
    const memory = memoryOf("we decided to adopt pnpm workspaces");
    await store.remember(memory);
    await store.remember(memory); // retry (window restore / distill re-run)
    assert.equal(rows.get("default")!.size, 1);
  } finally {
    server.close();
  }
});

test("buckets route per channel and forget sweeps them", async () => {
  const { server, url, rows } = await startFakeNodeMemory();
  try {
    const router = SiloBucketRouter.fromEnv("default", "eng=silo-eng");
    const store = new NodeMemoryStore(url, () => "k", router);
    await store.remember(memoryOf("engineering decision here", "eng"));
    await store.remember(memoryOf("support noted a refund policy", "support"));
    assert.equal(rows.get("silo-eng")!.size, 1);
    assert.equal(rows.get("default")!.size, 1);

    // Forget issued from #support must still find the id in silo-eng.
    const engId = [...rows.get("silo-eng")!.keys()][0]!;
    assert.equal(await store.forget(engId, "support"), true);
    assert.equal(rows.get("silo-eng")!.size, 0);
    assert.equal(await store.forget("nope", "eng"), false);
  } finally {
    server.close();
  }
});

test("recent returns newest-first for the channel", async () => {
  const { server, url } = await startFakeNodeMemory();
  try {
    const store = new NodeMemoryStore(url, () => "k");
    await store.remember(memoryOf("older decision about deploys", "eng"));
    await store.remember(memoryOf("newer decision about rollbacks", "eng"));
    await store.remember(memoryOf("unrelated support note", "support"));
    const recent = await store.recent("eng", 5);
    assert.equal(recent.length, 2);
    assert.match(recent[0]!.content, /newer decision/);
    assert.ok(recent.every((m) => m.source.channelId === "eng"));
  } finally {
    server.close();
  }
});

test("nodeKeyAuth sends the node key and never an OAuth header; 401 does not loop", async () => {
  const seen: Array<{ auth?: string; key?: string }> = [];
  const server = createServer((req, res) => {
    seen.push({
      auth: req.headers.authorization as string | undefined,
      key: req.headers["x-silo-node-key"] as string | undefined,
    });
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "bad key" }));
  });
  const url: string = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  try {
    const client = new McpClient(`${url}/v1/cloud/mcp`, nodeKeyAuth(() => "wrong-key"));
    await assert.rejects(client.callTool("silo_recall", {}), /401/);
    assert.equal(seen.length, 1); // no reauthorize loop for node keys
    assert.equal(seen[0]!.key, "wrong-key");
    assert.equal(seen[0]!.auth, undefined);
  } finally {
    server.close();
  }
});
