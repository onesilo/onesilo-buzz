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

test("resubscribe floors `since` at the newest seen event, not process start", async () => {
  // A reconnect that replayed from process start re-delivers everything —
  // on a long-lived agent that outgrows the dedup window, that means
  // re-answered commands. The REQ after a reconnect must move forward.
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

    // Deliver an event well in the future of the construction floor.
    const future = Math.floor(Date.now() / 1000) + 3600;
    const event = finalizeEvent(
      {
        kind: KIND_CHANNEL_MESSAGE,
        created_at: future,
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
      resubSince > firstSince,
      `resubscribe since (${resubSince}) should advance past the initial floor (${firstSince})`
    );
    // …but with slack, so an in-flight event straddling the reconnect isn't skipped.
    assert.ok(resubSince <= future, "since must not overshoot the newest seen event");
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

    await waitFor(() => reqsAfterAuth.length >= 1, 5000);
    const text = logs.join("\n");
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
