import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalSiloStore } from "../src/silo/local.js";
import type { Memory } from "../src/silo/types.js";

let seq = 0;
function mem(content: string, channelId = "eng", overrides: Partial<Memory> = {}): Memory {
  seq += 1;
  return {
    id: `m${seq}`,
    kind: "fact",
    content,
    raw: content,
    source: {
      eventId: `e${seq}`,
      authorPubkey: "pk",
      channelId,
      createdAt: Math.floor(Date.now() / 1000),
    },
    salience: 0.5,
    tags: [],
    ...overrides,
  };
}

test("recall ranks by token overlap", async () => {
  const store = new LocalSiloStore();
  await store.remember(mem("the payments migration ships Friday"));
  await store.remember(mem("lunch is at noon"));
  const results = await store.recall({ text: "when does the payments migration ship?" });
  assert.ok(results.length >= 1);
  assert.match(results[0]!.memory.content, /payments migration/);
  assert.ok(!results.some((r) => /lunch/.test(r.memory.content)));
});

test("recall is bucket-wide: channels share memory within the store", async () => {
  const store = new LocalSiloStore();
  await store.remember(mem("deploy freeze on Friday", "eng"));
  await store.remember(mem("freeze the marketing budget", "marketing"));
  // channelId selects the bucket (a single bucket here), never narrows
  // recall — a decision in #eng is recallable from #support.
  const fromSupport = await store.recall({ text: "freeze", channelId: "support" });
  assert.equal(fromSupport.length, 2);
});

test("salience boosts ranking between equal matches", async () => {
  const store = new LocalSiloStore();
  await store.remember(mem("rollback uses the legacy flag", "eng", { id: "low", salience: 0.1 }));
  await store.remember(mem("rollback uses the legacy flag", "eng", { id: "high", salience: 1.0 }));
  const results = await store.recall({ text: "rollback legacy flag" });
  assert.equal(results[0]!.memory.id, "high");
});

test("forget removes a memory", async () => {
  const store = new LocalSiloStore();
  const m = mem("temporary note about the offsite");
  await store.remember(m);
  assert.equal(await store.forget(m.id), true);
  assert.equal(await store.forget(m.id), false);
  assert.equal((await store.recall({ text: "offsite note" })).length, 0);
});

test("recent returns newest first, filtered by channel", async () => {
  const store = new LocalSiloStore();
  const a = mem("older", "eng");
  a.source.createdAt -= 100;
  await store.remember(a);
  await store.remember(mem("newer", "eng"));
  await store.remember(mem("other channel", "support"));
  const recent = await store.recent("eng", 10);
  assert.deepEqual(recent.map((m) => m.content), ["newer", "older"]);
});
