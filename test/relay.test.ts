/**
 * WebSocketRelay against a real ws server.
 *
 * These exist because the 20-minute-late-reply bug was invisible to every
 * FakeRelay test: the agent logic was correct, the *socket* was dead. Only
 * a live server that stops answering reproduces it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { WebSocketRelay } from "../src/buzz/relay.js";
import { KIND_CHANNEL_MESSAGE, CHANNEL_TAG } from "../src/buzz/events.js";
import { loadIdentity } from "../src/buzz/identity.js";

/** A ws server on an ephemeral port; `url` is ready once listening. */
async function server(opts: { autoPong?: boolean } = {}): Promise<{
  url: string;
  wss: WebSocketServer;
  sockets: WsSocket[];
  close: () => Promise<void>;
}> {
  const wss = new WebSocketServer({ port: 0, autoPong: opts.autoPong ?? true });
  const sockets: WsSocket[] = [];
  wss.on("connection", (ws) => sockets.push(ws));
  await new Promise((r) => wss.on("listening", r));
  const { port } = wss.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${port}`,
    wss,
    sockets,
    close: () => new Promise((r) => wss.close(() => r(undefined))),
  };
}

const waitFor = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("the relay pings so a proxy can't silently idle it out", async () => {
  const srv = await server();
  let pings = 0;
  srv.wss.on("connection", (ws) => ws.on("ping", () => (pings += 1)));

  const relay = new WebSocketRelay(srv.url, loadIdentity("OneSilo"), () => {}, 40);
  await relay.connect();
  try {
    await waitFor(() => pings >= 2);
    assert.ok(pings >= 2, `expected repeated pings, saw ${pings}`);
  } finally {
    relay.close();
    await srv.close();
  }
});

test("a socket that stops answering pings is torn down and reconnected", async () => {
  // The actual bug: half-open socket, no 'close', messages queue relay-side
  // for minutes. The heartbeat must notice and force a reconnect.
  // autoPong:false makes the server a peer that receives pings and never
  // answers — precisely the half-open socket a proxy leaves behind.
  const srv = await server({ autoPong: false });
  let connections = 0;
  srv.wss.on("connection", () => {
    connections += 1;
  });

  const logs: string[] = [];
  const relay = new WebSocketRelay(srv.url, loadIdentity("OneSilo"), (l) => logs.push(l), 40);
  await relay.connect();
  try {
    await waitFor(() => connections >= 2, 5000);
    assert.ok(connections >= 2, "expected the dead socket to be replaced");
    assert.match(logs.join("\n"), /stopped answering pings/);
  } finally {
    relay.close();
    await srv.close();
  }
});

test("a future-dated event cannot push the resubscribe floor past now", async () => {
  // `created_at` is whatever the publishing client stamped — a skewed clock
  // or a hostile peer can put it in the future. If that advanced the floor,
  // every later REQ would ask for events "since next Tuesday" and the agent
  // would go deaf until real time caught up. Now that the REQ floor is what
  // makes reconnect delivery work, that is a total outage, not a hiccup.
  const srv = await server();
  const reqs: Array<{ since: number }> = [];
  srv.wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as [string, string, { since: number }];
      if (msg[0] === "REQ") reqs.push(msg[2]);
    });
  });

  const relay = new WebSocketRelay(srv.url, loadIdentity("OneSilo"), () => {}, 10_000);
  await relay.connect();
  try {
    relay.subscribeChannels([], () => {});
    await waitFor(() => reqs.length >= 1);

    const future = Math.floor(Date.now() / 1000) + 3600;
    srv.sockets[0]!.send(
      JSON.stringify([
        "EVENT",
        "silo-mem-1",
        finalizeEvent(
          {
            kind: KIND_CHANNEL_MESSAGE,
            created_at: future,
            tags: [[CHANNEL_TAG, "eng"]],
            content: "posted by a clock an hour fast",
          },
          generateSecretKey()
        ),
      ])
    );

    await new Promise((r) => setTimeout(r, 50));
    srv.sockets[0]!.terminate();
    await waitFor(() => reqs.length >= 2, 5000);

    const resubSince = reqs[reqs.length - 1]!.since;
    const now = Math.floor(Date.now() / 1000);
    assert.ok(
      resubSince <= now,
      `since (${resubSince}) must never exceed now (${now}) — it was pushed into the future`
    );
    assert.ok(resubSince < future, "the future timestamp must not become the floor");
  } finally {
    relay.close();
    await srv.close();
  }
});

test("resubscribe recomputes `since` from what was seen, bounded by now", async () => {
  // The floor tracks the newest event actually seen (minus slack) rather
  // than being reused from construction, so a long-lived agent doesn't
  // replay its whole history on every reconnect. It is bounded above by
  // now — see the future-dated test — so within the 60s slack window a
  // fresh process legitimately resubscribes from its original floor. What
  // must hold either way: never backwards, never into the future.
  const srv = await server();
  const reqs: Array<{ since: number }> = [];
  srv.wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as [string, string, { since: number }];
      if (msg[0] === "REQ") reqs.push(msg[2]);
    });
  });

  const relay = new WebSocketRelay(srv.url, loadIdentity("OneSilo"), () => {}, 10_000);
  await relay.connect();
  try {
    relay.subscribeChannels([], () => {});
    await waitFor(() => reqs.length >= 1);
    const firstSince = reqs[0]!.since;

    const seenAt = Math.floor(Date.now() / 1000);
    const event = finalizeEvent(
      {
        kind: KIND_CHANNEL_MESSAGE,
        created_at: seenAt,
        tags: [[CHANNEL_TAG, "eng"]],
        content: "we decided to ship on Tuesday",
      },
      generateSecretKey()
    );
    srv.sockets[0]!.send(JSON.stringify(["EVENT", "silo-mem-1", event]));

    // Drop the socket; the client reconnects and resubscribes.
    await new Promise((r) => setTimeout(r, 50));
    srv.sockets[0]!.terminate();

    await waitFor(() => reqs.length >= 2, 5000);
    const resubSince = reqs[reqs.length - 1]!.since;
    assert.ok(
      resubSince >= firstSince,
      `since (${resubSince}) must never go backwards from the initial floor (${firstSince})`
    );
    // Slack keeps an event straddling the reconnect from being skipped.
    assert.ok(
      resubSince <= seenAt,
      "since must not overshoot the newest seen event and skip it"
    );
  } finally {
    relay.close();
    await srv.close();
  }
});

test("an auth-required relay ends up with a live subscription", async () => {
  // Reproduces the live failure: the agent opens, immediately publishes
  // and subscribes, and the relay refuses both because NIP-42 hasn't
  // happened yet — OK(false,"auth-required") for the event and
  // CLOSED(...,"auth-required") for the REQ. Ignoring the CLOSED left the
  // agent connected and permanently deaf.
  const srv = await server();
  let authed = false;
  let challenged = false;
  const reqsAfterAuth: string[] = [];
  let rejectedEvents = 0;
  let closedSubs = 0;

  srv.wss.on("connection", (ws) => {
    // Deliberately does NOT challenge on connect: the relay only demands
    // auth once the client actually tries something, which is what makes
    // the client's opening frames unauthenticated in the real world.
    const challengeOnce = () => {
      if (challenged) return;
      challenged = true;
      ws.send(JSON.stringify(["AUTH", "challenge-123"]));
    };
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as unknown[];
      const [type] = msg as [string];
      if (type === "AUTH") {
        const authEvent = msg[1] as { id: string };
        authed = true;
        ws.send(JSON.stringify(["OK", authEvent.id, true, ""]));
        return;
      }
      if (type === "EVENT") {
        const event = msg[1] as { id: string };
        if (!authed) {
          rejectedEvents += 1;
          ws.send(JSON.stringify(["OK", event.id, false, "auth-required: not authenticated"]));
          challengeOnce();
        } else {
          ws.send(JSON.stringify(["OK", event.id, true, ""]));
        }
        return;
      }
      if (type === "REQ") {
        const subId = msg[1] as string;
        if (!authed) {
          closedSubs += 1;
          ws.send(JSON.stringify(["CLOSED", subId, "auth-required: we can't serve you"]));
          challengeOnce();
        } else {
          reqsAfterAuth.push(subId);
          ws.send(JSON.stringify(["EOSE", subId]));
        }
        return;
      }
    });
  });

  const logs: string[] = [];
  const relay = new WebSocketRelay(srv.url, loadIdentity("OneSilo"), (l) => logs.push(l), 10_000);
  await relay.connect();
  try {
    // Publish + subscribe immediately, exactly as agent.start() does.
    void relay.publish({
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: "{}",
    });
    relay.subscribeChannels([], () => {});

    // Wait on the CLIENT's end state, not the server's counter: the server
    // increments reqsAfterAuth while its OK and EOSE are still on the wire,
    // so waiting on it can assert against logs the client hasn't read yet.
    await waitFor(() => logs.join("\n").includes("is live"), 5000);
    const text = logs.join("\n");
    assert.ok(reqsAfterAuth.length >= 1, "the relay should have served a REQ after auth");
    assert.match(text, /authenticated with the relay/);
    assert.match(text, /is live/, "the agent must confirm a live subscription");
    assert.ok(rejectedEvents >= 1, "the pre-auth publish should have been refused");
    assert.ok(closedSubs >= 1, "the pre-auth subscription should have been CLOSED");
    assert.match(text, /auth-required/, "the refusal must be surfaced, not swallowed");
  } finally {
    relay.close();
    await srv.close();
  }
});

test("acknowledged events are not replayed on a later auth challenge", async () => {
  // The replay buffer must hold only what's still in question. Otherwise a
  // reconnect re-sends every event of the previous connection — up to the
  // buffer cap — as soon as the new one authenticates.
  const srv = await server();
  const eventsSeen: string[] = [];
  let challenged = false;

  srv.wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as unknown[];
      const [type] = msg as [string];
      if (type === "EVENT") {
        const event = msg[1] as { id: string };
        eventsSeen.push(event.id);
        ws.send(JSON.stringify(["OK", event.id, true, ""])); // accepted
        // Challenge only after the first event is settled, so the replay
        // that follows would expose a stale buffer.
        if (!challenged) {
          challenged = true;
          setTimeout(() => ws.send(JSON.stringify(["AUTH", "challenge-xyz"])), 20);
        }
      }
      if (type === "AUTH") {
        const authEvent = msg[1] as { id: string };
        ws.send(JSON.stringify(["OK", authEvent.id, true, ""]));
      }
    });
  });

  const relay = new WebSocketRelay(srv.url, loadIdentity("OneSilo"), () => {}, 10_000);
  await relay.connect();
  try {
    const published = await relay.publish({
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: "{}",
    });
    await waitFor(() => challenged);
    await new Promise((r) => setTimeout(r, 120)); // let any replay land

    const timesSent = eventsSeen.filter((id) => id === published.id).length;
    assert.equal(timesSent, 1, "an accepted event must not be replayed after auth");
  } finally {
    relay.close();
    await srv.close();
  }
});

test("each channel gets its own #h-scoped subscription", async () => {
  // The bug this exists to prevent: Buzz keeps channel-scoped and global
  // subscriptions strictly separate for LIVE fan-out. A kinds-only REQ is
  // answered from storage, gets an EOSE, and is then excluded from the
  // live path forever — so the agent looks perfectly healthy (subscribed,
  // "is live") and never hears another word. Naming the channel in `#h`
  // is the whole difference between working and silently deaf.
  const srv = await server();
  const reqs: Array<[string, Record<string, unknown>]> = [];
  srv.wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as [string, string, Record<string, unknown>];
      if (msg[0] === "REQ") reqs.push([msg[1], msg[2]]);
    });
  });

  const relay = new WebSocketRelay(srv.url, loadIdentity("OneSilo"), () => {}, 10_000);
  await relay.connect();
  try {
    relay.subscribeChannels(["chan-a", "chan-b"], () => {});
    await waitFor(() => reqs.length >= 2);

    assert.equal(reqs.length, 2, "one subscription per channel, not one for both");
    const scopes = reqs.map(([, f]) => f["#h"]);
    assert.deepEqual(scopes, [["chan-a"], ["chan-b"]]);
    assert.notEqual(reqs[0]![0], reqs[1]![0], "each needs its own subscription id");
    assert.deepEqual(relay.subscribedChannels(), new Set(["chan-a", "chan-b"]));
  } finally {
    relay.close();
    await srv.close();
  }
});

test("an unscoped subscription is still available, and says nothing about #h", async () => {
  // Relays that fan out globally (self-hosted, the in-process demo relay)
  // are a legitimate deployment. Hard-coding one relay's fan-out rule as
  // "never subscribe globally" would break them.
  const srv = await server();
  const filters: Array<Record<string, unknown>> = [];
  srv.wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as [string, string, Record<string, unknown>];
      if (msg[0] === "REQ") filters.push(msg[2]);
    });
  });

  const relay = new WebSocketRelay(srv.url, loadIdentity("OneSilo"), () => {}, 10_000);
  await relay.connect();
  try {
    relay.subscribeChannels([], () => {});
    await waitFor(() => filters.length >= 1);
    assert.equal(filters.length, 1);
    assert.ok(!("#h" in filters[0]!), "an unscoped filter must not carry an empty #h");
    assert.deepEqual(filters[0]!.kinds, [KIND_CHANNEL_MESSAGE]);
  } finally {
    relay.close();
    await srv.close();
  }
});

test("queryOnce collects until EOSE and then closes the subscription", async () => {
  // Channel discovery is a historical read, because Buzz's own guidance is
  // that clients discover groups that way. It must settle on EOSE and not
  // leave a subscription behind on every sweep.
  const srv = await server();
  const closes: string[] = [];
  srv.wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as [string, string, Record<string, unknown>];
      if (msg[0] === "CLOSE") closes.push(msg[1]);
      if (msg[0] !== "REQ") return;
      const subId = msg[1];
      for (const content of ["one", "two"]) {
        ws.send(
          JSON.stringify([
            "EVENT",
            subId,
            finalizeEvent(
              {
                kind: KIND_CHANNEL_MESSAGE,
                created_at: Math.floor(Date.now() / 1000),
                tags: [[CHANNEL_TAG, "eng"]],
                content,
              },
              generateSecretKey()
            ),
          ])
        );
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });

  const relay = new WebSocketRelay(srv.url, loadIdentity("OneSilo"), () => {}, 10_000);
  await relay.connect();
  try {
    const events = await relay.queryOnce({ kinds: [KIND_CHANNEL_MESSAGE] });
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.content), ["one", "two"]);
    await waitFor(() => closes.length >= 1);
  } finally {
    relay.close();
    await srv.close();
  }
});

test("queryOnce settles on timeout rather than hanging startup", async () => {
  // A relay that accepts the REQ and never sends EOSE must not wedge the
  // agent's startup — an empty discovery result is recoverable on the next
  // sweep, a never-settling promise is not.
  const srv = await server();
  srv.wss.on("connection", (ws) => ws.on("message", () => {})); // deliberate silence

  const relay = new WebSocketRelay(srv.url, loadIdentity("OneSilo"), () => {}, 10_000);
  await relay.connect();
  try {
    const events = await relay.queryOnce({ kinds: [KIND_CHANNEL_MESSAGE] }, 200);
    assert.deepEqual(events, []);
  } finally {
    relay.close();
    await srv.close();
  }
});
