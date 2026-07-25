/** End-to-end: scripted channel traffic through FakeRelay + LocalSiloStore. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { FakeRelay } from "../src/buzz/fake-relay.js";
import { KIND_CHANNEL_MESSAGE, CHANNEL_TAG } from "../src/buzz/events.js";
import { loadIdentity } from "../src/buzz/identity.js";
import { LocalSiloStore } from "../src/silo/local.js";
import { SiloMemoryAgent } from "../src/agent.js";

async function setup() {
  const identity = loadIdentity("silo");
  const relay = new FakeRelay(identity.secretKey);
  const store = new LocalSiloStore();
  const agent = new SiloMemoryAgent(relay, store, identity);
  await agent.start();
  const userSk = generateSecretKey();
  const say = (content: string, channelId = "eng", extraTags: string[][] = []) =>
    relay.deliver(
      finalizeEvent(
        {
          kind: KIND_CHANNEL_MESSAGE,
          created_at: Math.floor(Date.now() / 1000),
          tags: [[CHANNEL_TAG, channelId], ...extraTags],
          content,
        },
        userSk
      )
    );
  return { identity, relay, store, say };
}

// FakeRelay delivery is synchronous but agent handlers are async; drain them.
const settle = () => new Promise((r) => setTimeout(r, 20));

test("passively ingests decisions without replying", async () => {
  const { relay, store, say } = await setup();
  say("we decided to ship the payments migration on Friday");
  await settle();
  assert.equal(store.size, 1);
  assert.equal(relay.published.length, 0);
});

test("!recall answers with stored memories and provenance", async () => {
  const { relay, say } = await setup();
  say("we decided to ship the payments migration on Friday");
  await settle();
  say("!recall payments migration", "support"); // cross-channel recall
  await settle();
  assert.equal(relay.published.length, 1);
  const reply = relay.published[0]!;
  assert.match(reply.content, /payments migration/);
  assert.match(reply.content, /event /); // provenance cite
  assert.equal(reply.tags.find((t) => t[0] === CHANNEL_TAG)?.[1], "support");
});

test("@mention is treated as recall", async () => {
  const { identity, relay, say } = await setup();
  say("we decided to use postgres 16 for the staging database");
  await settle();
  say("@silo what did we decide for the staging database?", "eng", [["p", identity.pubkey]]);
  await settle();
  assert.equal(relay.published.length, 1);
  assert.match(relay.published[0]!.content, /postgres 16/);
});

test("!remember stores verbatim and !forget removes it", async () => {
  const { relay, store, say } = await setup();
  say("!remember the oncall handoff doc lives in Notion");
  await settle();
  assert.equal(store.size, 1);
  const confirmation = relay.published[0]!.content;
  const id = confirmation.match(/id (\w+)/)?.[1];
  assert.ok(id);
  say(`!forget ${id}`);
  await settle();
  assert.equal(store.size, 0);
  assert.match(relay.published.at(-1)!.content, /Forgotten/);
});

test("ignores its own published events", async () => {
  const { relay, store, say } = await setup();
  say("!remember we decided the retro is on Mondays");
  await settle();
  // The confirmation reply ("Got it — I'll remember that…") matches the
  // action-item pattern; it must not be re-ingested when the agent hears
  // its own event echoed back from the relay.
  assert.equal(store.size, 1);
});
