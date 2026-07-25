import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TurnWindowManager,
  type TranscriptSegment,
  type Turn,
} from "../src/memory/window.js";

let seq = 0;
function turn(content: string, createdAt = 1_753_000_000 + seq): Turn {
  seq += 1;
  return { authorPubkey: `pk${seq}`, content, createdAt, eventId: `ev${seq}` };
}

function manager(opts: { maxTurns: number; overlapTurns: number; idleFlushMs: number }) {
  const flushed: TranscriptSegment[] = [];
  const m = new TurnWindowManager(opts, async (segment) => {
    flushed.push(segment);
  });
  return { m, flushed };
}

test("size flush with overlap carried into the next segment", async () => {
  const { m, flushed } = manager({ maxTurns: 3, overlapTurns: 1, idleFlushMs: 60_000 });
  await m.push("eng", turn("a"), false);
  await m.push("eng", turn("b"), false);
  await m.push("eng", turn("c"), false); // size flush
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]!.reason, "size");
  assert.deepEqual(flushed[0]!.turns.map((t) => t.content), ["a", "b", "c"]);
  assert.deepEqual(flushed[0]!.fresh.map((t) => t.content), ["a", "b", "c"]);

  await m.push("eng", turn("d"), false);
  await m.push("eng", turn("e"), false);
  await m.push("eng", turn("f"), false); // second size flush
  assert.equal(flushed.length, 2);
  // "c" rides along as overlap context; only d/e/f are fresh.
  assert.deepEqual(flushed[1]!.turns.map((t) => t.content), ["c", "d", "e", "f"]);
  assert.deepEqual(flushed[1]!.fresh.map((t) => t.content), ["d", "e", "f"]);
});

test("a salient turn flushes immediately with its preceding context", async () => {
  const { m, flushed } = manager({ maxTurns: 10, overlapTurns: 2, idleFlushMs: 60_000 });
  await m.push("eng", turn("should we ship this week?"), false);
  await m.push("eng", turn("flag's ready, I'd say Friday"), false);
  await m.push("eng", turn("yeah we decided to ship Friday"), true);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]!.reason, "salience");
  assert.equal(flushed[0]!.turns.length, 3); // context travels with the decision
});

test("idle flush closes an episode; overlap-only buffers stay put", async () => {
  const { m, flushed } = manager({ maxTurns: 10, overlapTurns: 2, idleFlushMs: 5_000 });
  const t = turn("some chatter about the offsite", 1_753_000_000);
  await m.push("eng", t, false);
  await m.flushIdle(1_753_000_000 * 1000 + 1_000); // not idle yet
  assert.equal(flushed.length, 0);
  await m.flushIdle(1_753_000_000 * 1000 + 6_000);
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]!.reason, "idle");
  // The retained overlap has no fresh turns — idle must not re-flush it.
  await m.flushIdle(1_753_000_000 * 1000 + 60_000);
  assert.equal(flushed.length, 1);
});

test("restore puts failed turns back for the next flush", async () => {
  const flushed: TranscriptSegment[] = [];
  let failFirst = true;
  const m = new TurnWindowManager(
    { maxTurns: 10, overlapTurns: 0, idleFlushMs: 60_000 },
    async (segment) => {
      if (failFirst) {
        failFirst = false;
        m.restore(segment.channelId, segment.fresh);
        return;
      }
      flushed.push(segment);
    }
  );
  await m.push("eng", turn("we decided to use bun for tooling"), true); // fails, restored
  assert.equal(m.pending("eng"), 1);
  await m.push("eng", turn("and we decided on pnpm workspaces"), true); // retries both
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0]!.fresh.length, 2);
  assert.equal(m.pending("eng"), 0);
});

test("flushAll drains every channel on shutdown", async () => {
  const { m, flushed } = manager({ maxTurns: 10, overlapTurns: 0, idleFlushMs: 60_000 });
  await m.push("eng", turn("pending eng chatter for the demo"), false);
  await m.push("support", turn("pending support chatter as well"), false);
  await m.flushAll();
  assert.equal(flushed.length, 2);
  assert.ok(flushed.every((s) => s.reason === "shutdown"));
});
