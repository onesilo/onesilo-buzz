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
  /** Filters by subscription id, replayed after NIP-42 auth completes. */
  private subscriptions = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly url: string,
    private readonly identity: AgentIdentity
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on("open", () => resolve());
      ws.on("error", (err) => reject(err));
      ws.on("message", (data) => this.onMessage(String(data)));
    });
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
      // A relay that enforces auth-before-subscribe drops REQs sent before
      // the challenge completed. Replaying every subscription is safe: a
      // REQ with an existing sub id simply replaces that subscription.
      for (const [subId, filter] of this.subscriptions) {
        this.ws?.send(JSON.stringify(["REQ", subId, filter]));
      }
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
    if (!this.ws) throw new Error("relay not connected");
    const event = finalizeEvent(template, this.identity.secretKey);
    this.ws.send(JSON.stringify(["EVENT", event]));
    return Promise.resolve(event);
  }

  close(): void {
    this.ws?.close();
  }
}
