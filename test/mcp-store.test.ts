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

test("remember calls silo_remember on the default silo with a provenance trailer", async () => {
  const { client, calls } = fakeMcp(() => ({ payload: { status: "queued" }, isError: false }));
  await new McpSiloStore(client).remember(memory);
  assert.equal(calls[0]!.name, "silo_remember");
  assert.equal(calls[0]!.args.silo_id, "default");
  const content = calls[0]!.args.content as string;
  assert.match(content, /^we decided to ship Friday/);
  assert.match(content, /\[buzz kind=decision salience=0.9 channel=eng author=deadbeefdead event=ev1\]/);
});

test("remember surfaces requires_confirmation to the log without confirming", async () => {
  const logs: string[] = [];
  const { client, calls } = fakeMcp(() => ({
    payload: { status: "requires_confirmation", would_replace_or_update: [{ id: "m9" }] },
    isError: false,
  }));
  await new McpSiloStore(client, "default", (l) => logs.push(l)).remember(memory);
  assert.equal(calls.length, 1); // no second confirmed=true call
  assert.match(logs.join("\n"), /requires confirmation/);
});

test("recall maps silo_recall hits and recovers provenance from the trailer", async () => {
  const { client, calls } = fakeMcp(() => ({
    payload: {
      memories: [
        {
          id: "m1",
          type: "custom",
          content:
            "we decided to ship Friday\n\n[buzz kind=decision salience=0.9 channel=eng author=deadbeefdead event=ev1]",
          score: 0.87,
        },
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
});

test("ask relays the silo-composed answer", async () => {
  const { client } = fakeMcp(() => ({
    payload: { answer: "The team decided to ship on Friday." },
    isError: false,
  }));
  const answer = await new McpSiloStore(client).ask("what did we decide?");
  assert.equal(answer, "The team decided to ship on Friday.");
});

test("forget passes explicit memory_ids and maps errors to false", async () => {
  const { client, calls } = fakeMcp((name) =>
    name === "silo_forget"
      ? { payload: { deleted: [] }, isError: false }
      : { payload: {}, isError: false }
  );
  const store = new McpSiloStore(client);
  assert.equal(await store.forget("m1"), false);
  assert.deepEqual(calls[0]!.args.memory_ids, ["m1"]);
});
