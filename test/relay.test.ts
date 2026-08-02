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
