/**
 * Relay transport. Buzz workspaces run a single relay that is the source of
 * truth: clients connect over WebSocket, the relay enforces auth (NIP-42),
 * verifies signatures, persists, and fans out to subscribers.
 *
 * `BuzzRelay` is the minimal surface the agent needs; `WebSocketRelay` is the
 * real transport and `demo/demo.ts` provides an in-process fake for the
 * standalone demo and tests.
 */

import WebSocket from "ws";
import {
  finalizeEvent,
  verifyEvent,
  type Event as NostrEvent,
  type EventTemplate,
} from "nostr-tools";
import type { AgentIdentity } from "./identity.js";
import { KIND_CHANNEL_MESSAGE, CHANNEL_TAG } from "./events.js";

export type EventHandler = (event: NostrEvent) => void;

export interface BuzzRelay {
  connect(): Promise<void>;
  /** Subscribe to channel messages in the given channels ([] = all visible). */
  subscribeChannels(channelIds: string[], onEvent: EventHandler): void;
  /** Sign with the agent identity and publish. */
  publish(template: EventTemplate): Promise<NostrEvent>;
  close(): void;
}

export class WebSocketRelay implements BuzzRelay {
  private ws?: WebSocket;
  private subSeq = 0;
  private handlers = new Map<string, EventHandler>();
  /** Filters by subscription id, replayed after reconnect / NIP-42 auth. */
  private subscriptions = new Map<string, Record<string, unknown>>();
  private closed = false;
  private reconnectDelayMs = 1000;
  private reconnectTimer?: NodeJS.Timeout;
  /** Signed events waiting for the socket to (re)open; FIFO, bounded. */
  private outbox: Array<{
    event: NostrEvent;
    resolve: (event: NostrEvent) => void;
    reject: (err: Error) => void;
  }> = [];
  private static readonly OUTBOX_MAX = 1000;
  /**
   * Ring buffer of recently sent events, re-sent after a NIP-42 AUTH
   * exchange: a relay that enforces auth-before-publish drops EVENTs sent
   * in the window between socket-open and auth completion. Re-sending is
   * safe — relays deduplicate by event id. Sized to OUTBOX_MAX so a full
   * outbox flush is always replayable — a smaller ring would silently
   * lose the earliest events of a large post-reconnect burst.
   */
  private recentlySent: NostrEvent[] = [];
  private static readonly RECENT_MAX = WebSocketRelay.OUTBOX_MAX;

  constructor(
    private readonly url: string,
    private readonly identity: AgentIdentity
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => this.open(resolve, reject));
  }

  /**
   * Open (or re-open) the socket. The initial connect() rejects on failure;
   * once connected, a dropped socket reconnects with capped exponential
   * backoff and replays all subscriptions — overlap with already-seen
   * events is handled by the agent's event-id dedup.
   */
  private open(onOpen?: () => void, onFail?: (err: Error) => void): void {
    if (this.closed) return;
    // Drop any prior socket first: a slow, still-connecting one must not
    // come up later and replay subscriptions/outbox on stale state.
    const prior = this.ws;
    if (prior) {
      prior.removeAllListeners();
      prior.terminate();
    }
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let opened = false;
    ws.on("open", () => {
      if (this.closed) {
        // close() ran while this socket was still connecting — shut it
        // down instead of subscribing past shutdown.
        ws.close();
        return;
      }
      if (this.ws !== ws) return; // superseded by a newer socket
      opened = true;
      this.reconnectDelayMs = 1000;
      for (const [subId, filter] of this.subscriptions) {
        ws.send(JSON.stringify(["REQ", subId, filter]));
      }
      // Flush replies that were published while disconnected.
      const pending = this.outbox;
      this.outbox = [];
      for (const p of pending) {
        this.sendEvent(ws, p.event);
        p.resolve(p.event);
      }
      onOpen?.();
    });
    ws.on("error", (err) => {
      if (!opened) onFail?.(err as Error);
    });
    ws.on("close", () => {
      // A close before open settles the initial connect() promise — whether
      // the connect failed or close() was called mid-handshake, the caller
      // must not be left awaiting forever. (Extra settles are no-ops.)
      if (!opened && onFail) {
        onFail(new Error("relay connection closed before it opened"));
        return;
      }
      if (this.closed || this.ws !== ws) return;
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(delay * 2, 30_000);
      this.reconnectTimer = setTimeout(() => this.open(), delay);
    });
    ws.on("message", (data) => this.onMessage(String(data)));
  }

  private onMessage(raw: string): void {
    let msg: unknown[];
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const [type, ...rest] = msg;
    if (type === "EVENT") {
      const [subId, event] = rest as [string, NostrEvent];
      if (!verifyEvent(event)) return; // never trust unsigned/forged input
      this.handlers.get(subId)?.(event);
    } else if (type === "AUTH") {
      // NIP-42: relay challenges us; sign kind 22242 with our agent key.
      const [challenge] = rest as [string];
      const auth = finalizeEvent(
        {
          kind: 22242,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["relay", this.url],
            ["challenge", challenge],
          ],
          content: "",
        },
        this.identity.secretKey
      );
      this.ws?.send(JSON.stringify(["AUTH", auth]));
      // A relay that enforces auth-before-subscribe/publish drops REQs and
      // EVENTs sent before the challenge completed. Replaying both is
      // safe: a REQ with an existing sub id replaces that subscription,
      // and relays deduplicate EVENTs by id.
      for (const [subId, filter] of this.subscriptions) {
        this.ws?.send(JSON.stringify(["REQ", subId, filter]));
      }
      for (const event of this.recentlySent) {
        this.ws?.send(JSON.stringify(["EVENT", event]));
      }
    }
  }

  private sendEvent(ws: WebSocket, event: NostrEvent): void {
    ws.send(JSON.stringify(["EVENT", event]));
    this.recentlySent.push(event);
    if (this.recentlySent.length > WebSocketRelay.RECENT_MAX) {
      this.recentlySent.shift();
    }
  }

  subscribeChannels(channelIds: string[], onEvent: EventHandler): void {
    if (!this.ws) throw new Error("relay not connected");
    const subId = `silo-mem-${++this.subSeq}`;
    this.handlers.set(subId, onEvent);
    const filter: Record<string, unknown> = {
      kinds: [KIND_CHANNEL_MESSAGE],
      // live tail only; backfill is a deliberate non-goal for the prototype
      since: Math.floor(Date.now() / 1000),
    };
    if (channelIds.length > 0) filter[`#${CHANNEL_TAG}`] = channelIds;
    this.subscriptions.set(subId, filter);
    this.ws.send(JSON.stringify(["REQ", subId, filter]));
  }

  publish(template: EventTemplate): Promise<NostrEvent> {
    if (this.closed) return Promise.reject(new Error("relay closed"));
    const event = finalizeEvent(template, this.identity.secretKey);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendEvent(this.ws, event);
      return Promise.resolve(event);
    }
    // Mid-reconnect: hold the signed event and settle the promise only when
    // it actually flushes — callers must not believe a queued event was
    // delivered if the relay shuts down first.
    return new Promise((resolve, reject) => {
      this.outbox.push({ event, resolve, reject });
      if (this.outbox.length > WebSocketRelay.OUTBOX_MAX) {
        this.outbox
          .shift()
          ?.reject(new Error("relay outbox overflow — event dropped"));
      }
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const pending = this.outbox;
    this.outbox = [];
    for (const p of pending) {
      p.reject(new Error("relay closed before the event was delivered"));
    }
    this.ws?.close();
  }
}
