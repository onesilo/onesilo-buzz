import { test } from "node:test";
import assert from "node:assert/strict";
import { McpSiloStore } from "../src/silo/mcp-store.js";
import type { McpClient, ToolResult } from "../src/silo/mcp-client.js";
import type { Memory } from "../src/silo/types.js";

interface Call {
  name: string;
  args: Record<string, unknown>;
}

function fakeMcp(respond: (name: string, args: Record<string, unknown>) => ToolResult) {
  const calls: Call[] = [];
  const client = {
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return respond(name, args);
    },
  } as unknown as McpClient;
  return { client, calls };
}

const memory: Memory = {
  id: "abc123",
  kind: "decision",
  content: "we decided to ship Friday",
  raw: "after debate: we decided to ship Friday",
  source: { eventId: "ev1", authorPubkey: "deadbeefdeadbeef", channelId: "eng", createdAt: 1_753_000_000 },
  salience: 0.9,
  tags: [],
};

test("remember calls silo_remember with a full-fidelity provenance trailer", async () => {
  const { client, calls } = fakeMcp(() => ({ payload: { status: "queued" }, isError: false }));
  const outcome = await new McpSiloStore(client).remember(memory);
  assert.deepEqual(outcome, { status: "queued" });
  assert.equal(calls[0]!.name, "silo_remember");
  assert.equal(calls[0]!.args.silo_id, "default");
  const content = calls[0]!.args.content as string;
  assert.match(content, /^we decided to ship Friday/);
  assert.match(
    content,
    /\[buzz kind=decision salience=0.9 channel=eng author=deadbeefdeadbeef event=ev1 ts=1753000000\]/
  );
});

test("remember reports requires_confirmation without confirming", async () => {
  const logs: string[] = [];
  const { client, calls } = fakeMcp(() => ({
    payload: { status: "requires_confirmation", would_replace_or_update: [{ id: "m9" }] },
    isError: false,
  }));
  const outcome = await new McpSiloStore(client, "default", (l) => logs.push(l)).remember(memory);
  assert.deepEqual(outcome, { status: "needs_confirmation" });
  assert.equal(calls.length, 1); // no second confirmed=true call
  assert.match(logs.join("\n"), /requires confirmation/);
});

const trailered = (channel: string, text: string) =>
  `${text}\n\n[buzz kind=decision salience=0.9 channel=${channel} author=deadbeefdeadbeef event=ev1 ts=1753000000]`;

test("recall maps silo_recall hits and recovers provenance from the trailer", async () => {
  const { client, calls } = fakeMcp(() => ({
    payload: {
      memories: [
        { id: "m1", type: "custom", content: trailered("eng", "we decided to ship Friday"), score: 0.87 },
      ],
    },
    isError: false,
  }));
  const results = await new McpSiloStore(client).recall({ text: "ship date", limit: 3 });
  assert.equal(calls[0]!.name, "silo_recall");
  assert.equal(calls[0]!.args.max_results, 3);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.score, 0.87);
  assert.equal(results[0]!.memory.kind, "decision");
  assert.equal(results[0]!.memory.content, "we decided to ship Friday");
  assert.equal(results[0]!.memory.source.channelId, "eng");
  assert.equal(results[0]!.memory.source.eventId, "ev1");
  assert.equal(results[0]!.memory.source.authorPubkey, "deadbeefdeadbeef");
  assert.equal(results[0]!.memory.source.createdAt, 1_753_000_000);
});

test("recall honors the channelId filter (client-side, with over-fetch)", async () => {
  const { client, calls } = fakeMcp(() => ({
    payload: {
      memories: [
        { id: "m1", content: trailered("eng", "eng memory"), score: 0.9 },
        { id: "m2", content: trailered("support", "support memory"), score: 0.8 },
      ],
    },
    isError: false,
  }));
  const results = await new McpSiloStore(client).recall({
    text: "memory",
    channelId: "support",
    limit: 5,
  });
  assert.equal(calls[0]!.args.max_results, 15); // limit * 3 over-fetch
  assert.equal(results.length, 1);
  assert.equal(results[0]!.memory.source.channelId, "support");
});

test("ask relays the silo-composed answer", async () => {
  const { client } = fakeMcp(() => ({
    payload: { answer: "The team decided to ship on Friday." },
    isError: false,
  }));
  const answer = await new McpSiloStore(client).ask("what did we decide?");
  assert.equal(answer, "The team decided to ship on Friday.");
});

test("forget only reports success on a confirmed deletion", async () => {
  const respond = (payload: unknown) => {
    const { client } = fakeMcp(() => ({ payload, isError: false }));
    return new McpSiloStore(client);
  };
  assert.equal(await respond({ deleted: ["m1"] }).forget("m1"), true);
  assert.equal(await respond({ deleted: [] }).forget("m1"), false);
  assert.equal(await respond({ status: "ok" }).forget("m1"), false); // no deleted array
  const { client, calls } = fakeMcp(() => ({ payload: { deleted: ["m1"] }, isError: false }));
  await new McpSiloStore(client).forget("m1");
  assert.deepEqual(calls[0]!.args.memory_ids, ["m1"]);
});
