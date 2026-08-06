/**
 * End-to-end: a real Buzz conversation through the real agent into a real
 * onesilo-node.
 *
 * Everything in `npm test` stubs the node — `node-memory.test.ts` asserts the
 * request shapes against a fake HTTP server, which proves we send what we
 * think we send and nothing about whether the node accepts it. The two sides
 * are developed in different repos and different languages, so the contract
 * between them is exactly the seam a unit test on either side cannot cover.
 * This runs the actual `onesilo-node` binary and drives the actual agent at
 * it.
 *
 * Deliberately no LLM. Distillation is the heuristic extractor, and the node
 * runs with compute off, so the test needs no Ollama, no model download and no
 * network — which is what lets it run in CI. The LLM path is a separate
 * concern from "does memory survive the round trip".
 *
 * The Buzz relay is faked, because Buzz is a third-party service. That is the
 * one seam left unproven here.
 *
 * Assertions read memory back from the node over plain HTTP rather than
 * through the store that wrote it. A store that silently swallowed every write
 * and served a local cache would pass a self-consistent test; it fails this
 * one.
 *
 * Run: npm run e2e   (scripts/e2e.sh builds and supervises the node)
 */

import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";

import { FakeRelay } from "../src/buzz/fake-relay.js";
import { CHANNEL_TAG, KIND_CHANNEL_MESSAGE } from "../src/buzz/events.js";
import { loadIdentity } from "../src/buzz/identity.js";
import { NodeMemoryStore } from "../src/silo/node-memory.js";
import { SiloMemoryAgent } from "../src/agent.js";

const NODE_URL = process.env.NODE_URL ?? "http://127.0.0.1:8765";
const NODE_KEY = process.env.NODE_KEY ?? "";
const SILO = process.env.SILO_ID ?? "default";

if (!NODE_KEY) {
  console.error("NODE_KEY is required — scripts/e2e.sh reads it from the node's data dir");
  process.exit(2);
}

/** Total memories the node holds, straight from its own accounting. */
async function nodeSiloCounts(): Promise<Array<{ silo_id?: string; count?: number }>> {
  const res = await fetch(`${NODE_URL}/v1/memory/silos`, {
    headers: { "X-Silo-Node-Key": NODE_KEY },
  });
  if (!res.ok) throw new Error(`node silos failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as Array<{ silo_id?: string; count?: number }>;
}

/** Read the node's memory directly, bypassing everything under test. */
async function nodeRecall(query: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${NODE_URL}/v1/memory/${encodeURIComponent(SILO)}/recall`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Silo-Node-Key": NODE_KEY },
    body: JSON.stringify({ query, limit }),
  });
  if (!res.ok) throw new Error(`node recall failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { results?: Array<Record<string, unknown>> };
  return body.results ?? [];
}

function member(name: string) {
  const secretKey = generateSecretKey();
  return { name, secretKey, pubkey: getPublicKey(secretKey) };
}

const checks: Array<{ name: string; run: () => void | Promise<void> }> = [];
function check(name: string, run: () => void | Promise<void>) {
  checks.push({ name, run });
}

async function main() {
  const alice = member("alice");
  const bob = member("bob");
  const identity = loadIdentity("silo-e2e");

  const relay = new FakeRelay(identity.secretKey);
  const store = new NodeMemoryStore(NODE_URL, () => NODE_KEY, undefined, (l) =>
    console.log(`  [store] ${l}`)
  );

  // init() is where the store reports reachability. If the node were down it
  // logs a warning and carries on, so assert on a real call instead.
  await store.init();

  const replies: Array<{ channel: string; content: string }> = [];
  relay.subscribeChannels([], (event) => {
    if (event.pubkey !== identity.pubkey) return;
    const channel = event.tags.find((t) => t[0] === CHANNEL_TAG)?.[1] ?? "?";
    replies.push({ channel, content: event.content });
    console.log(`\n#${channel} <silo> ${event.content}`);
  });

  const agent = new SiloMemoryAgent(relay, store, identity, {
    names: new Map([
      [alice.pubkey, "alice"],
      [bob.pubkey, "bob"],
      [identity.pubkey, "silo"],
    ]),
    log: (line) => console.log(`  [agent] ${line}`),
  });
  await agent.start();

  const say = async (
    from: ReturnType<typeof member>,
    channelId: string,
    content: string,
    extraTags: string[][] = []
  ) => {
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
    // Capture is async and writes over HTTP to the node; give the round trip
    // room. A bare setTimeout is crude, but the alternative is reaching into
    // the agent's internals, and this is the integration boundary on purpose.
    await new Promise((r) => setTimeout(r, 250));
  };

  console.log("\n=== #eng: passive capture ===");
  await say(alice, "eng", "morning all");
  await say(
    alice,
    "eng",
    "we decided to ship the payments migration on Friday, behind the flag"
  );
  await say(bob, "eng", "!remember rollback plan: re-enable the legacy processor via flag payments-v1");

  console.log("\n=== #support: recall across channels ===");
  const beforeMention = replies.length;
  // The handle comes from the identity rather than being written out: the
  // agent decides a message is for it by matching @handle in the *text*, not
  // by the `p` tag, so a hardcoded "@silo" here would silently stop being a
  // mention the moment the handle changed — and would look like a recall bug.
  await say(
    bob,
    "support",
    `@${identity.handle} what did we decide about the payments migration?`,
    [["p", identity.pubkey]]
  );

  // ---- assertions, all read back from the node itself ----

  check("the decision reached the node", async () => {
    const hits = await nodeRecall("payments migration Friday");
    const found = hits.some((h) => String(h.content ?? "").toLowerCase().includes("payments migration"));
    assert.ok(found, `node holds no memory of the decision. recall returned: ${JSON.stringify(hits)}`);
  });

  check("!remember reached the node", async () => {
    const hits = await nodeRecall("rollback plan legacy processor");
    const found = hits.some((h) => String(h.content ?? "").toLowerCase().includes("rollback plan"));
    assert.ok(found, `explicit !remember not stored. recall returned: ${JSON.stringify(hits)}`);
  });

  check("chatter is not stored", async () => {
    const hits = await nodeRecall("morning all");
    const found = hits.some((h) => String(h.content ?? "").toLowerCase().trim() === "morning all");
    assert.ok(!found, "a greeting was captured; the salience filter is not doing its job");
  });

  check("memories carry provenance back to the Buzz event", async () => {
    const hits = await nodeRecall("payments migration Friday");
    const withMeta = hits.find((h) => h.metadata && Object.keys(h.metadata as object).length > 0);
    assert.ok(withMeta, `no memory carried metadata: ${JSON.stringify(hits)}`);
    const meta = JSON.stringify(withMeta!.metadata);
    assert.ok(
      /event|buzz|channel/i.test(meta),
      `metadata has no link back to the source event: ${meta}`
    );
  });

  check("the agent answered the @mention", () => {
    const answered = replies.slice(beforeMention);
    assert.ok(answered.length > 0, "agent published no reply to the @mention");
    assert.ok(
      answered.some((r) => /payments|migration|friday/i.test(r.content)),
      `reply did not surface the remembered decision: ${JSON.stringify(answered)}`
    );
  });

  check("the reply went back to the asking channel", () => {
    const answered = replies.slice(beforeMention);
    assert.ok(
      answered.some((r) => r.channel === "support"),
      `reply landed in the wrong channel: ${JSON.stringify(answered)}`
    );
  });

  console.log("\n=== results ===");
  let failed = 0;
  for (const c of checks) {
    try {
      await c.run();
      console.log(`  PASS  ${c.name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${c.name}`);
      console.log(`        ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const counts = await nodeSiloCounts();
  console.log(
    `\nnode holds ${counts.map((s) => `${s.silo_id}=${s.count}`).join(", ") || "nothing"}`
  );
  console.log(failed === 0 ? "\nE2E PASSED" : `\nE2E FAILED (${failed}/${checks.length})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nE2E ERRORED:", err);
  process.exit(1);
});
