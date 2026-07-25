/**
 * Standalone demo: a scripted Buzz conversation flowing through the
 * memory agent, with an in-process fake relay and the local silo store.
 *
 *   npm run demo
 *
 * Shows: passive distillation of decisions/facts/action items, explicit
 * !remember, @mention recall with provenance, and cross-channel memory.
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { FakeRelay } from "../src/buzz/fake-relay.js";
import { KIND_CHANNEL_MESSAGE, CHANNEL_TAG } from "../src/buzz/events.js";
import { loadIdentity } from "../src/buzz/identity.js";
import { LocalSiloStore } from "../src/silo/local.js";
import { SiloMemoryAgent } from "../src/agent.js";

interface Member {
  name: string;
  secretKey: Uint8Array;
  pubkey: string;
}

function member(name: string): Member {
  const secretKey = generateSecretKey();
  return { name, secretKey, pubkey: getPublicKey(secretKey) };
}

async function say(
  relay: FakeRelay,
  from: Member,
  channelId: string,
  content: string,
  extraTags: string[][] = []
): Promise<void> {
  const event = finalizeEvent(
    {
      kind: KIND_CHANNEL_MESSAGE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [[CHANNEL_TAG, channelId], ...extraTags],
      content,
    },
    from.secretKey
  );
  console.log(`\n#${channelId} <${from.name}> ${content}`);
  relay.deliver(event);
  // Handlers are async; let each message settle so output reads in order.
  await new Promise((r) => setTimeout(r, 25));
}

async function main() {
  const alice = member("alice");
  const bob = member("bob");

  const identity = loadIdentity("silo");
  const relay = new FakeRelay(identity.secretKey);
  const store = new LocalSiloStore(); // in-memory for the demo
  const names = new Map([
    [alice.pubkey, "alice"],
    [bob.pubkey, "bob"],
    [identity.pubkey, "silo"],
  ]);

  const agent = new SiloMemoryAgent(relay, store, identity, {
    names,
    log: (line) => console.log(`  [agent] ${line}`)
  });
  await agent.start();

  // Print agent replies as they land in the channel.
  relay.subscribeChannels([], (event) => {
    if (event.pubkey === identity.pubkey) {
      const channel = event.tags.find((t) => t[0] === CHANNEL_TAG)?.[1];
      console.log(`\n#${channel} <silo> ${event.content}`);
    }
  });

  console.log("=== day 1: #eng plans the launch ===");
  await say(relay, alice, "eng", "morning! standup in 5");
  await say(relay, alice, "eng", "after the debate yesterday: we decided to ship the payments migration on Friday, behind the flag");
  await say(relay, bob, "eng", "cool. I'll rotate the staging API keys before the migration runs");
  await say(relay, bob, "eng", "fyi the staging database runs on postgres 16 now, the old replica is gone");
  await say(relay, alice, "eng", "!remember rollback plan: re-enable the legacy processor via LaunchDarkly flag payments-v1");

  console.log("\n=== day 2: #support asks, memory crosses channels ===");
  await say(relay, bob, "support", "@silo what did we decide about the payments migration?", [["p", identity.pubkey]]);
  await say(relay, alice, "support", "!recall rollback plan");
  await say(relay, bob, "eng", "!memories");

  console.log(`\n=== silo now holds ${store.size} memories ===`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
