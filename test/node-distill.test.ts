import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wrapWithNodeDistillation,
  parseStatements,
  distillPrompt,
} from "../src/silo/node-distill.js";
import { NodeUnavailableError, type SiloNodeClient } from "../src/node/client.js";
import type { TranscriptSegment, Turn } from "../src/memory/window.js";
import type { Memory, MemoryStore, RememberOutcome } from "../src/silo/types.js";
import { loadConfig } from "../src/config.js";

let seq = 0;
function turn(authorPubkey: string, content: string): Turn {
  seq += 1;
  return { authorPubkey, content, createdAt: 1_753_000_000 + seq, eventId: `ev${seq}` };
}

function segment(turns: Turn[], fresh = turns): TranscriptSegment {
  return { channelId: "eng", reason: "salience", turns, fresh };
}

interface InnerCalls {
  remembered: Memory[];
  transcripts: number;
}

function fakeInner(
  outcome: RememberOutcome = { status: "queued" }
): { store: MemoryStore; calls: InnerCalls } {
  const calls: InnerCalls = { remembered: [], transcripts: 0 };
  const store: MemoryStore = {
    remember: async (m) => {
      calls.remembered.push(m);
      return outcome;
    },
    rememberTranscript: async () => {
      calls.transcripts += 1;
      return { status: "queued" };
    },
    recall: async () => [],
    forget: async () => true,
    recent: async () => [],
    ask: async () => "inner answer",
  };
  return { store, calls };
}

function fakeNode(response: string | Error): SiloNodeClient {
  return {
    url: "http://127.0.0.1:8766",
    hasToken: true,
    health: async () => true,
    generate: async () => {
      if (response instanceof Error) throw response;
      return { text: response, model: "test-model" };
    },
  } as unknown as SiloNodeClient;
}

test("segments are distilled locally; only statements reach the inner store", async () => {
  const { store: inner, calls } = fakeInner();
  const store = wrapWithNodeDistillation(
    inner,
    fakeNode("decision: ship the payments migration Friday\naction_item: bob rotates the staging keys")
  );
  const seg = segment([
    turn("alicepk00", "should we ship this week?"),
    turn("bobpk0000", "yeah let's ship Friday, I'll rotate the keys first"),
  ]);
  const outcome = await store.rememberTranscript!(seg);
  assert.equal(outcome.status, "queued");
  assert.equal(calls.transcripts, 0); // raw transcript NEVER forwarded
  assert.equal(calls.remembered.length, 2);
  assert.equal(calls.remembered[0]!.kind, "decision");
  assert.match(calls.remembered[0]!.content, /payments migration Friday/);
  assert.equal(calls.remembered[1]!.kind, "action_item");
  // Provenance anchors to the turn that closed the episode.
  assert.equal(calls.remembered[0]!.source.eventId, seg.fresh[1]!.eventId);
  assert.equal(calls.remembered[0]!.source.channelId, "eng");
});

test("a down node throws NodeUnavailableError and nothing is sent anywhere", async () => {
  const { store: inner, calls } = fakeInner();
  const store = wrapWithNodeDistillation(
    inner,
    fakeNode(new NodeUnavailableError("connection refused"))
  );
  await assert.rejects(
    store.rememberTranscript!(segment([turn("a", "we decided to ship Friday")])),
    NodeUnavailableError
  );
  assert.equal(calls.remembered.length, 0);
  assert.equal(calls.transcripts, 0); // no raw fallback, ever
});

test("NONE means nothing durable: no writes, segment consumed", async () => {
  const { store: inner, calls } = fakeInner();
  const store = wrapWithNodeDistillation(inner, fakeNode("NONE"));
  const outcome = await store.rememberTranscript!(segment([turn("a", "lol nice")]));
  assert.equal(outcome.status, "queued");
  assert.equal(calls.remembered.length, 0);
});

test("all statements held -> needs_confirmation surfaces to the agent", async () => {
  const { store: inner } = fakeInner({ status: "needs_confirmation" });
  const store = wrapWithNodeDistillation(inner, fakeNode("fact: the deploy window moved"));
  const outcome = await store.rememberTranscript!(segment([turn("a", "deploy window moved")]));
  assert.equal(outcome.status, "needs_confirmation");
});

test("optional inner methods are only exposed when the inner store has them", async () => {
  const { store: withAsk } = fakeInner();
  const wrapped = wrapWithNodeDistillation(withAsk, fakeNode("NONE"));
  assert.ok(wrapped.ask);
  assert.equal(await wrapped.ask!("q"), "inner answer");
  assert.equal(wrapped.overview, undefined); // inner has no overview

  const bare: MemoryStore = {
    remember: async () => ({ status: "queued" }),
    recall: async () => [],
    forget: async () => false,
    recent: async () => [],
  };
  const wrappedBare = wrapWithNodeDistillation(bare, fakeNode("NONE"));
  assert.equal(wrappedBare.ask, undefined);
});

test("sibling statements get distinct deterministic ids (no local clobbering)", async () => {
  const { LocalSiloStore } = await import("../src/silo/local.js");
  const local = new LocalSiloStore();
  const store = wrapWithNodeDistillation(
    local,
    fakeNode("decision: ship Friday\naction_item: bob rotates the keys\nfact: staging runs postgres 16")
  );
  await store.rememberTranscript!(segment([turn("a", "we decided a bunch of things")]));
  assert.equal(local.size, 3); // three statements, three entries — not one
  const contents = (await local.recent(undefined, 10)).map((m) => m.content).sort();
  assert.deepEqual(contents, [
    "bob rotates the keys",
    "ship Friday",
    "staging runs postgres 16",
  ]);
});

test("a retried segment overwrites its statements instead of duplicating", async () => {
  const { LocalSiloStore } = await import("../src/silo/local.js");
  const local = new LocalSiloStore();
  // First attempt fails after the first statement lands; the agent's window
  // restores the segment and the next flush retries the whole thing.
  let failOnce = true;
  const flaky: MemoryStore = {
    remember: async (m) => {
      const outcome = await local.remember(m);
      if (failOnce) {
        failOnce = false;
        throw new Error("transient silo outage");
      }
      return outcome;
    },
    recall: async () => [],
    forget: async () => false,
    recent: async () => [],
  };
  const store = wrapWithNodeDistillation(
    flaky,
    fakeNode("decision: ship Friday\nfact: staging runs postgres 16")
  );
  const seg = segment([turn("a", "we decided to ship Friday on pg16")]);
  await assert.rejects(store.rememberTranscript!(seg));
  assert.equal(local.size, 1); // first statement stored before the failure
  await store.rememberTranscript!(seg); // retry re-sends both
  assert.equal(local.size, 2); // deterministic ids: overwrite, not duplicate
});

test("parseStatements tolerates bullets, numbering, and junk kinds", () => {
  const statements = parseStatements(
    [
      "- decision: ship Friday",
      "2) action_item: bob rotates keys",
      "preference: alice prefers squash merges",
      "opinion: this line has an unknown tag", // kept as a fact (whole line)
      "",
      "NONE", // ignored inside other content
    ].join("\n")
  );
  assert.deepEqual(
    statements.map((s) => s.kind),
    ["decision", "action_item", "preference", "fact"]
  );
  assert.equal(statements[3]!.content, "opinion: this line has an unknown tag");
  assert.deepEqual(parseStatements("NONE"), []);
  assert.deepEqual(parseStatements("  \n\n"), []);
});

test("parseStatements caps runaway output", () => {
  const lines = Array.from({ length: 50 }, (_, i) => `fact: fact number ${i}`).join("\n");
  assert.equal(parseStatements(lines).length, 10);
});

test("distillPrompt carries speaker-attributed turns and the channel", () => {
  const prompt = distillPrompt(
    segment([turn("alicepk0extra", "we decided to ship Friday")])
  );
  assert.match(prompt, /Channel: #eng/);
  assert.match(prompt, /\[alicepk0\] we decided to ship Friday/);
  assert.match(prompt, /output exactly: NONE/);
});

test("distillPrompt separates already-captured overlap from new turns", () => {
  const ctx = turn("alicepk0", "we decided to ship Friday");
  const fresh = turn("bobpk000", "and I'll rotate the keys before that");
  const prompt = distillPrompt(segment([ctx, fresh], [fresh]));
  assert.match(prompt, /ALREADY captured — do NOT extract/);
  // The context line appears before the new-conversation block; the fresh
  // line after it.
  const contextIdx = prompt.indexOf("we decided to ship Friday");
  const newBlockIdx = prompt.indexOf("New conversation");
  const freshIdx = prompt.indexOf("rotate the keys");
  assert.ok(contextIdx < newBlockIdx && newBlockIdx < freshIdx);
});

test("a statement re-extracted from overlap context dedupes by content id", async () => {
  const { LocalSiloStore } = await import("../src/silo/local.js");
  const local = new LocalSiloStore();
  const store = wrapWithNodeDistillation(local, fakeNode("decision: ship Friday"));
  const decided = turn("alicepk0", "we decided to ship Friday");
  await store.rememberTranscript!(segment([decided]));
  assert.equal(local.size, 1);
  // The next segment carries `decided` as overlap; a leaky model extracts
  // the same statement again. Content-derived ids land it on the same entry.
  const followUp = turn("bobpk000", "sounds good, moving on");
  await store.rememberTranscript!(segment([decided, followUp], [followUp]));
  assert.equal(local.size, 1); // no duplicate
});

test("node/distill/silo-mode config parsing with out-of-the-box defaults", () => {
  const defaults = loadConfig({});
  assert.equal(defaults.distill, "cloud");
  assert.equal(defaults.silo.mode, "mcp");
  assert.deepEqual(defaults.node, {
    adminUrl: "http://127.0.0.1:8766",
    adminToken: undefined,
    lanUrl: "http://127.0.0.1:8765",
    key: undefined,
  });

  assert.equal(loadConfig({ DISTILL_MODE: "node" }).distill, "node");

  const relay = loadConfig({ SILO_MODE: "relay", SILO_ID: "shared-silo" });
  assert.deepEqual(relay.silo, { mode: "relay", siloId: "shared-silo", channelMap: "" });

  const node = loadConfig({
    SILO_MODE: "node",
    NODE_LAN_URL: "http://127.0.0.1:9999",
    NODE_KEY: "k",
  });
  assert.deepEqual(node.silo, { mode: "node", siloId: "default", channelMap: "" });
  assert.equal(node.node.lanUrl, "http://127.0.0.1:9999");
  assert.equal(node.node.key, "k");

  // Unknown modes fall back to mcp instead of crashing.
  assert.equal(loadConfig({ SILO_MODE: "banana" }).silo.mode, "mcp");
});

test("the local model call is announced before it starts and timed when it ends", async () => {
  // Distillation is the slowest thing the agent does — a cold local model
  // under a two-minute ceiling. The operator has to be able to tell "the
  // model is thinking" from "the agent is wedged", so the announcement must
  // precede the call, not summarize it afterwards.
  const { store: inner } = fakeInner();
  const logs: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((r) => (release = r));
  const slowNode = {
    url: "http://127.0.0.1:8766",
    hasToken: true,
    health: async () => true,
    generate: async () => {
      await pending;
      return { text: "decision: ship on Friday", model: "llama3.2" };
    },
  } as unknown as SiloNodeClient;

  const store = wrapWithNodeDistillation(inner, slowNode, (l) => logs.push(l));
  const flushing = store.rememberTranscript!(
    segment([turn("alicepk00", "let's ship Friday")])
  );
  await new Promise((r) => setTimeout(r, 20));

  assert.match(logs.join("\n"), /distilling 1 turn\(s\) from #eng on the local model/);
  assert.doesNotMatch(logs.join("\n"), /replied in/, "must not claim a reply yet");

  release();
  await flushing;
  assert.match(logs.join("\n"), /local model \(llama3\.2\) replied in \d/);
});
