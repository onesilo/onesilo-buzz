import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { parseChannelMessage, KIND_CHANNEL_MESSAGE, CHANNEL_TAG, type ChannelMessage } from "../src/buzz/events.js";
import { extractMemories, explicitMemory } from "../src/memory/extractor.js";

const sk = generateSecretKey();

function msg(content: string, channelId = "eng"): ChannelMessage {
  const event = finalizeEvent(
    {
      kind: KIND_CHANNEL_MESSAGE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [[CHANNEL_TAG, channelId]],
      content,
    },
    sk
  );
  const parsed = parseChannelMessage(event);
  assert.ok(parsed);
  return parsed;
}

test("extracts decisions with high salience", () => {
  const out = extractMemories(msg("we decided to ship the payments migration on Friday"));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, "decision");
  assert.ok(out[0]!.salience >= 0.8);
  assert.equal(out[0]!.source.channelId, "eng");
});

test("extracts action items from commitments", () => {
  const out = extractMemories(msg("I'll rotate the staging API keys tomorrow"));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, "action_item");
});

test("skips chatter and short messages", () => {
  assert.equal(extractMemories(msg("lol ok")).length, 0);
  assert.equal(extractMemories(msg("morning! standup in 5")).length, 0);
});

test("broad fact pattern requires substance", () => {
  assert.equal(extractMemories(msg("that is fine with me tbh")).length, 0);
  const out = extractMemories(msg("the staging database runs on postgres 16 behind the new pgbouncer"));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.kind, "fact");
});

test("explicit memories store verbatim with max salience", () => {
  const m = explicitMemory(msg("!remember rollback = flag payments-v1"), "rollback = flag payments-v1");
  assert.equal(m.kind, "explicit");
  assert.equal(m.salience, 1.0);
  assert.equal(m.content, "rollback = flag payments-v1");
});

test("extraction is deterministic per event (stable ids)", () => {
  const m = msg("we decided to use bun for the build tooling");
  const [a] = extractMemories(m);
  const [b] = extractMemories(m);
  assert.equal(a!.id, b!.id);
});
