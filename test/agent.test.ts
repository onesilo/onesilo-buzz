/** End-to-end: scripted channel traffic through FakeRelay + LocalSiloStore. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { FakeRelay } from "../src/buzz/fake-relay.js";
import { KIND_CHANNEL_MESSAGE, KIND_METADATA, CHANNEL_TAG } from "../src/buzz/events.js";
import { loadIdentity } from "../src/buzz/identity.js";
import { LocalSiloStore } from "../src/silo/local.js";
import { SiloMemoryAgent } from "../src/agent.js";
import type { MemoryStore } from "../src/silo/types.js";

async function setup() {
  const identity = loadIdentity("silo");
  const relay = new FakeRelay(identity.secretKey);
  const store = new LocalSiloStore();
  const agent = new SiloMemoryAgent(relay, store, identity);
  await agent.start();
  // The kind 0 profile is published on start; keep it for tests that
  // assert on it, but hand back a relay whose `published` means "replies"
  // — every assertion here is about what the agent SAYS.
  const profile = relay.published.find((e) => e.kind === KIND_METADATA);
  relay.published = relay.published.filter((e) => e.kind !== KIND_METADATA);
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
  return { identity, relay, store, say, profile };
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

test("a statement in a mention is answered AND captured; a question is not captured", async () => {
  const { identity, relay, store, say } = await setup();
  say("@silo we decided to ship the payments migration on Friday", "eng", [["p", identity.pubkey]]);
  await settle();
  assert.equal(relay.published.length, 1); // answered
  assert.equal(store.size, 1); // and the decision was captured
  say("@silo what did we decide about the payments migration?", "eng", [["p", identity.pubkey]]);
  await settle();
  assert.equal(relay.published.length, 2);
  assert.equal(store.size, 1); // the question itself was not stored
});

test("a failed capture is retained in the window and retried on the next flush", async () => {
  const identity = loadIdentity("silo");
  const relay = new FakeRelay(identity.secretKey);
  let attempts = 0;
  const captured: string[] = [];
  const flaky: MemoryStore = {
    remember: async (m) => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient silo outage");
      captured.push(m.content);
      return { status: "queued" };
    },
    recall: async () => [],
    forget: async () => false,
    recent: async () => [],
  };
  const agent = new SiloMemoryAgent(relay, flaky, identity);
  await agent.start();
  const say = (content: string) =>
    agent.handleEvent(
      finalizeEvent(
        {
          kind: KIND_CHANNEL_MESSAGE,
          created_at: Math.floor(Date.now() / 1000),
          tags: [[CHANNEL_TAG, "eng"]],
          content,
        },
        generateSecretKey()
      )
    );
  // Salient → immediate flush, which fails; the turn is restored.
  await say("we decided to ship the payments migration on Friday");
  assert.equal(captured.length, 0);
  // The next salient flush retries the restored turn along with the new one.
  await say("we decided the rollback owner will be bob this week");
  assert.equal(captured.length, 2);
  assert.match(captured[0]!, /payments migration/);
});

test("a mention statement is still captured when reply delivery fails", async () => {
  const identity = loadIdentity("silo");
  const store = new LocalSiloStore();
  const logs: string[] = [];
  const deadRelay = {
    connect: async () => {},
    subscribeChannels: () => {},
    publish: async () => {
      throw new Error("relay closed");
    },
    close: () => {},
  };
  const agent = new SiloMemoryAgent(deadRelay, store, identity, {
    log: (l) => logs.push(l),
  });
  await agent.start();
  await agent.handleEvent(
    finalizeEvent(
      {
        kind: KIND_CHANNEL_MESSAGE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [[CHANNEL_TAG, "eng"]],
        content: "@silo we decided to ship the payments migration on Friday",
      },
      generateSecretKey()
    )
  );
  assert.equal(store.size, 1); // captured despite the failed reply
  assert.match(logs.join("\n"), /could not deliver reply/);
});

test("bang commands are case-insensitive", async () => {
  const { relay, store, say } = await setup();
  say("!Remember the retro moved to Mondays");
  await settle();
  assert.equal(store.size, 1);
  say("!RECALL retro schedule", "support");
  await settle();
  assert.equal(relay.published.length, 2);
  assert.match(relay.published[1]!.content, /retro moved to Mondays/);
});

test("a p tag alone does not trigger a reply (listen unless spoken to)", async () => {
  const { identity, relay, say } = await setup();
  say("heads up: deploy happening later for the payments team", "eng", [["p", identity.pubkey]]);
  await settle();
  assert.equal(relay.published.length, 0);
});

test("redelivered events are deduplicated by id", async () => {
  const { relay, store, say } = await setup();
  const userSk = generateSecretKey();
  const event = finalizeEvent(
    {
      kind: KIND_CHANNEL_MESSAGE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [[CHANNEL_TAG, "eng"]],
      content: "we decided to ship the payments migration on Friday",
    },
    userSk
  );
  relay.deliver(event);
  relay.deliver(event); // relay redelivery
  await settle();
  assert.equal(store.size, 1);
  void say; // setup() helper unused here on purpose
});

test("passive ingest logs held captures instead of claiming success", async () => {
  const identity = loadIdentity("silo");
  const relay = new FakeRelay(identity.secretKey);
  const logs: string[] = [];
  const holding: MemoryStore = {
    remember: async () => ({ status: "needs_confirmation" }),
    recall: async () => [],
    forget: async () => false,
    recent: async () => [],
  };
  const agent = new SiloMemoryAgent(relay, holding, identity, {
    log: (l) => logs.push(l),
  });
  await agent.start();
  relay.deliver(
    finalizeEvent(
      {
        kind: KIND_CHANNEL_MESSAGE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [[CHANNEL_TAG, "eng"]],
        content: "we decided to ship the payments migration on Friday",
      },
      generateSecretKey()
    )
  );
  await settle();
  assert.match(logs.join("\n"), /held for owner confirmation/);
  assert.doesNotMatch(logs.join("\n"), /^remembered/m);
});

test("a publish failure after a successful store op does not claim a silo error", async () => {
  const identity = loadIdentity("silo");
  const store = new LocalSiloStore();
  const logs: string[] = [];
  const deadRelay = {
    connect: async () => {},
    subscribeChannels: () => {},
    publish: async () => {
      throw new Error("relay outbox overflow");
    },
    close: () => {},
  };
  const agent = new SiloMemoryAgent(deadRelay, store, identity, {
    log: (l) => logs.push(l),
  });
  await agent.start();
  await agent.handleEvent(
    finalizeEvent(
      {
        kind: KIND_CHANNEL_MESSAGE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [[CHANNEL_TAG, "eng"]],
        content: "!remember the oncall doc lives in Notion",
      },
      generateSecretKey()
    )
  );
  assert.equal(store.size, 1); // the store op itself succeeded
  assert.match(logs.join("\n"), /could not deliver reply/);
  assert.doesNotMatch(logs.join("\n"), /error answering/); // no false silo error
});

test("silo errors on commands produce an apologetic reply", async () => {
  const identity = loadIdentity("silo");
  const relay = new FakeRelay(identity.secretKey);
  const failing: MemoryStore = {
    remember: async () => {
      throw new Error("mcp down");
    },
    recall: async () => {
      throw new Error("mcp down");
    },
    forget: async () => false,
    recent: async () => [],
  };
  const agent = new SiloMemoryAgent(relay, failing, identity);
  await agent.start();
  relay.published = relay.published.filter((e) => e.kind !== KIND_METADATA); // drop the profile
  relay.deliver(
    finalizeEvent(
      {
        kind: KIND_CHANNEL_MESSAGE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [[CHANNEL_TAG, "eng"]],
        content: "!recall anything",
      },
      generateSecretKey()
    )
  );
  await settle();
  assert.equal(relay.published.length, 1);
  assert.match(relay.published[0]!.content, /hit an error/);
});

test("transcript-capable stores receive whole segments with context", async () => {
  const identity = loadIdentity("silo");
  const relay = new FakeRelay(identity.secretKey);
  const segments: Array<{ turns: number; contents: string[] }> = [];
  const transcriptStore: MemoryStore = {
    remember: async () => ({ status: "queued" }),
    rememberTranscript: async (segment) => {
      segments.push({
        turns: segment.turns.length,
        contents: segment.turns.map((t) => t.content),
      });
      return { status: "queued" };
    },
    recall: async () => [],
    forget: async () => false,
    recent: async () => [],
  };
  const agent = new SiloMemoryAgent(relay, transcriptStore, identity);
  await agent.start();
  const sk = generateSecretKey();
  const say = (content: string) =>
    agent.handleEvent(
      finalizeEvent(
        {
          kind: KIND_CHANNEL_MESSAGE,
          created_at: Math.floor(Date.now() / 1000),
          tags: [[CHANNEL_TAG, "eng"]],
          content,
        },
        sk
      )
    );
  await say("should we ship the payments migration this week?"); // buffered
  await say("flag looks ready on staging honestly"); // buffered
  await say("ok we decided to ship it Friday"); // salient → flush with context
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.turns, 3); // the antecedents travel with the decision
  assert.match(segments[0]!.contents[0]!, /should we ship/);
  assert.match(segments[0]!.contents[2]!, /decided to ship it Friday/);
});

test("stop() drains queued events before the shutdown flush", async () => {
  const identity = loadIdentity("silo");
  const relay = new FakeRelay(identity.secretKey);
  const segments: Array<{ reason: string; turns: number }> = [];
  const transcriptStore: MemoryStore = {
    remember: async () => ({ status: "queued" }),
    rememberTranscript: async (segment) => {
      segments.push({ reason: segment.reason, turns: segment.turns.length });
      return { status: "queued" };
    },
    recall: async () => [],
    forget: async () => false,
    recent: async () => [],
  };
  const agent = new SiloMemoryAgent(relay, transcriptStore, identity);
  await agent.start();
  // Delivered but NOT settled: the handler is still queued when stop() runs.
  relay.deliver(
    finalizeEvent(
      {
        kind: KIND_CHANNEL_MESSAGE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [[CHANNEL_TAG, "eng"]],
        content: "just chatting about the offsite plans",
      },
      generateSecretKey()
    )
  );
  await agent.stop();
  assert.equal(segments.length, 1); // the queued turn made it into the final flush
  assert.equal(segments[0]!.reason, "shutdown");
  assert.equal(segments[0]!.turns, 1);
});

test("shutdown flush retries a transient silo error instead of dropping turns", async () => {
  const identity = loadIdentity("silo");
  const relay = new FakeRelay(identity.secretKey);
  let failures = 2;
  const captured: string[] = [];
  const flaky: MemoryStore = {
    remember: async (m) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("transient silo outage");
      }
      captured.push(m.content);
      return { status: "queued" };
    },
    recall: async () => [],
    forget: async () => false,
    recent: async () => [],
  };
  const agent = new SiloMemoryAgent(relay, flaky, identity, { shutdownRetryMs: 1 });
  await agent.start();
  relay.deliver(
    finalizeEvent(
      {
        kind: KIND_CHANNEL_MESSAGE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [[CHANNEL_TAG, "eng"]],
        content: "we decided to postpone the launch to Monday",
      },
      generateSecretKey()
    )
  );
  // The salient in-queue flush fails once; stop()'s retries land it.
  await agent.stop();
  assert.equal(captured.length, 1);
  assert.match(captured[0]!, /postpone the launch/);
});

test("shutdown names dropped turns when the silo stays down", async () => {
  const identity = loadIdentity("silo");
  const relay = new FakeRelay(identity.secretKey);
  const logs: string[] = [];
  const dead: MemoryStore = {
    remember: async () => {
      throw new Error("silo hard down");
    },
    recall: async () => [],
    forget: async () => false,
    recent: async () => [],
  };
  const agent = new SiloMemoryAgent(relay, dead, identity, {
    shutdownRetryMs: 1,
    log: (l) => logs.push(l),
  });
  await agent.start();
  relay.deliver(
    finalizeEvent(
      {
        kind: KIND_CHANNEL_MESSAGE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [[CHANNEL_TAG, "eng"]],
        content: "we decided to sunset the beta program",
      },
      generateSecretKey()
    )
  );
  await agent.stop();
  assert.match(logs.join("\n"), /dropping 1 uncaptured turn/);
});

test("mention matching does not false-positive on longer handles", async () => {
  const { relay, say } = await setup();
  say("@silos are the best way to organize memory, honestly");
  await settle();
  assert.equal(relay.published.length, 0); // @silos is not @silo
});

test("a !command after a mention runs as a command", async () => {
  const { identity, relay, store, say } = await setup();
  say("@silo !remember the retro moved to Mondays", "eng", [["p", identity.pubkey]]);
  await settle();
  assert.equal(store.size, 1);
  assert.match(relay.published[0]!.content, /I'll remember that/);
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

test("an email or hostname containing the handle is not a mention", async () => {
  const { relay, say } = await setup();
  say("ping eng@silo.example about the rollout, or bob@silo.dev");
  await settle();
  assert.equal(relay.published.length, 0); // pasted addresses must not summon the agent
});

test("the agent publishes a kind 0 profile so clients show a name", async () => {
  const { identity, profile } = await setup();
  assert.ok(profile, "expected a kind 0 metadata event on start");
  assert.equal(profile!.pubkey, identity.pubkey);
  const meta = JSON.parse(profile!.content) as { name?: string; display_name?: string };
  assert.equal(meta.name, identity.handle);
  assert.equal(meta.display_name, identity.handle);
});

test("a failed profile publish does not stop the agent", async () => {
  // A workspace that refuses metadata writes must still get a working
  // agent — unnamed is a cosmetic loss, not a functional one.
  const { FakeRelay } = await import("../src/buzz/fake-relay.js");
  const { loadIdentity } = await import("../src/buzz/identity.js");
  const { LocalSiloStore } = await import("../src/silo/local.js");
  const { SiloMemoryAgent } = await import("../src/agent.js");

  const identity = loadIdentity("OneSilo");
  const relay = new FakeRelay(identity.secretKey);
  const realPublish = relay.publish.bind(relay);
  relay.publish = async (t) => {
    if (t.kind === KIND_METADATA) throw new Error("metadata rejected");
    return realPublish(t);
  };
  const logs: string[] = [];
  const agent = new SiloMemoryAgent(relay, new LocalSiloStore(), identity, {
    log: (l) => logs.push(l),
  });
  await agent.start(); // must not throw
  assert.match(logs.join("\n"), /continuing unnamed/);
  await agent.stop();
});

test("the agent says it is thinking BEFORE the slow work finishes", async () => {
  // The whole point: on a local model a reply can take a minute, and the
  // operator needs to see that the message landed and work started. A line
  // emitted only after the answer is ready would prove nothing — so this
  // asserts the announcement while the store call is still pending.
  const identity = loadIdentity("silo");
  const relay = new FakeRelay(identity.secretKey);
  const logs: string[] = [];
  let releaseRecall!: () => void;
  const pending = new Promise<void>((r) => (releaseRecall = r));
  const slow: MemoryStore = {
    remember: async () => ({ status: "stored", id: "m1" }),
    recall: async () => {
      await pending;
      return [];
    },
    forget: async () => false,
    recent: async () => [],
  };
  const agent = new SiloMemoryAgent(relay, slow, identity, {
    log: (l) => logs.push(l),
  });
  await agent.start();

  const handling = agent.handleEvent(
    finalizeEvent(
      {
        kind: KIND_CHANNEL_MESSAGE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [[CHANNEL_TAG, "eng"]],
        content: "!recall the staging database",
      },
      generateSecretKey()
    )
  );
  await new Promise((r) => setTimeout(r, 20)); // reach the blocked recall

  const soFar = logs.join("\n");
  assert.match(soFar, /thinking about a !recall in #eng/);
  assert.match(soFar, /searching memory for: "the staging database"/);
  assert.doesNotMatch(soFar, /done in /, "the turn must not be reported finished yet");

  releaseRecall();
  await handling;
  const after = logs.join("\n");
  assert.match(after, /memory search returned 0 result\(s\) in \d/);
  assert.match(after, /done in \d/, "the finished turn must report how long it took");
  await agent.stop();
});

test("a message waiting behind a slow turn says so", async () => {
  // Handling is strictly serial, so a slow local model stalls everything
  // behind it. Without this line the queued messages look dropped.
  const identity = loadIdentity("silo");
  const relay = new FakeRelay(identity.secretKey);
  const logs: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((r) => (release = r));
  const slow: MemoryStore = {
    remember: async () => ({ status: "stored", id: "m1" }),
    recall: async () => {
      await pending;
      return [];
    },
    forget: async () => false,
    recent: async () => [],
  };
  const agent = new SiloMemoryAgent(relay, slow, identity, {
    log: (l) => logs.push(l),
  });
  await agent.start();

  const userSk = generateSecretKey();
  const send = (content: string) =>
    relay.deliver(
      finalizeEvent(
        {
          kind: KIND_CHANNEL_MESSAGE,
          created_at: Math.floor(Date.now() / 1000),
          tags: [[CHANNEL_TAG, "eng"]],
          content,
        },
        userSk
      )
    );
  send("!recall the staging database"); // blocks on `pending`
  send("!recall anything else"); // has to wait for it
  await new Promise((r) => setTimeout(r, 20));

  assert.match(logs.join("\n"), /is waiting on 1 earlier message/);
  release();
  await agent.stop();
});

test("the agent's own reply echoing back is not reported as a backlog", async () => {
  // Relays serve every event matching the filter, our own replies included,
  // and the echo lands while the turn that published it is still running.
  // Counting it would report a message waiting behind that turn when
  // nothing is actually queued.
  const { identity, relay, say } = await setup();
  const logs: string[] = [];
  const agent = new SiloMemoryAgent(relay, new LocalSiloStore(), identity, {
    log: (l) => logs.push(l),
  });
  await agent.start();
  void say; // this test drives the relay directly

  relay.deliver(
    finalizeEvent(
      {
        kind: KIND_CHANNEL_MESSAGE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [[CHANNEL_TAG, "eng"]],
        content: "!remember the oncall doc lives in Notion",
      },
      generateSecretKey()
    )
  );
  await settle();

  assert.match(logs.join("\n"), /replied in eng/); // the reply did go out…
  assert.doesNotMatch(logs.join("\n"), /is waiting on/); // …and echoed back quietly
  await agent.stop();
});
