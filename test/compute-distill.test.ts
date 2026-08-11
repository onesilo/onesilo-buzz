import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapWithComputeDistillation } from "../src/silo/compute-distill.js";
import { ComputeGateError } from "../src/silo/compute.js";
import type { MemoryStore, RememberOutcome } from "../src/silo/types.js";
import type { TranscriptSegment } from "../src/memory/window.js";

const turn = (content: string) => ({
  authorPubkey: "aabbccdd",
  content,
  createdAt: 1,
  eventId: "e1",
});

const segment: TranscriptSegment = {
  channelId: "chan",
  turns: [turn("we decided to ship tuesday")],
  fresh: [turn("we decided to ship tuesday")],
} as any;

function innerStore(outcome: RememberOutcome = { status: "queued" }) {
  const remembered: any[] = [];
  const store: MemoryStore = {
    remember: async (m) => {
      remembered.push(m);
      return outcome;
    },
    recall: async () => [],
    forget: async () => true,
    recent: async () => [],
  } as any;
  return { store, remembered };
}

test("distills via compute and stores only statements", async () => {
  const { store, remembered } = innerStore();
  const wrapped = wrapWithComputeDistillation(store, {
    generate: async () => ({
      text: "decision: ship tuesday\nfact: budget is 5k",
      model: "gpt-test",
    }),
  } as any);
  const outcome = await wrapped.rememberTranscript!(segment);
  assert.equal(outcome.status, "queued");
  assert.equal(remembered.length, 2);
  assert.match(remembered[0].content, /ship tuesday/i);
});

test("gate errors buffer the segment instead of throwing", async () => {
  const { store, remembered } = innerStore();
  const wrapped = wrapWithComputeDistillation(store, {
    generate: async () => {
      throw new ComputeGateError("out of chats", 402);
    },
  } as any);
  const outcome = await wrapped.rememberTranscript!(segment);
  assert.equal(outcome.status, "queued");
  assert.equal(remembered.length, 0);
});

test("optional methods forward only when the inner store has them", async () => {
  const { store } = innerStore();
  const wrapped = wrapWithComputeDistillation(store, { generate: async () => ({ text: "", model: "m" }) } as any);
  assert.equal(wrapped.ask, undefined);
  const withAsk = innerStore().store;
  (withAsk as any).ask = async () => "answer";
  const wrapped2 = wrapWithComputeDistillation(withAsk, { generate: async () => ({ text: "", model: "m" }) } as any);
  assert.equal(await wrapped2.ask!("q"), "answer");
});
