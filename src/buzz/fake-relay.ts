/**
 * In-process relay: same contract as WebSocketRelay, no network. Used by the
 * standalone demo and the test suite.
 */

import {
  finalizeEvent,
  type Event as NostrEvent,
  type EventTemplate,
} from "nostr-tools";
import type { BuzzRelay, EventHandler } from "./relay.js";

export class FakeRelay implements BuzzRelay {
  private handlers: EventHandler[] = [];
  public published: NostrEvent[] = [];
  /** Channels subscribed to; mirrors the real relay's bookkeeping. */
  public readonly subscribed = new Set<string>();
  /** Events queryOnce() will return, by kind. Tests set this up. */
  public stored: NostrEvent[] = [];

  constructor(private readonly agentSecretKey: Uint8Array) {}

  async connect(): Promise<void> {}

  subscribeChannels(channelIds: string[], onEvent: EventHandler): void {
    for (const id of channelIds) this.subscribed.add(id);
    this.handlers.push(onEvent);
  }

  subscribedChannels(): Set<string> {
    return new Set(this.subscribed);
  }

  unsubscribeChannels(channelIds: string[]): void {
    for (const id of channelIds) this.subscribed.delete(id);
  }

  /** Historical read over `stored`, matching only what the agent uses. */
  async queryOnce(filter: Record<string, unknown>): Promise<NostrEvent[]> {
    const kinds = filter.kinds as number[] | undefined;
    const limit = filter.limit as number | undefined;
    const matched = this.stored.filter((e) => !kinds || kinds.includes(e.kind));
    // Newest-first, like a real relay: `limit` on a REQ returns the most
    // recent events, not the oldest. Slicing from the front would make
    // "recent messages" discovery test the opposite of what it does live.
    return limit ? matched.slice(-limit) : matched;
  }

  async publish(template: EventTemplate): Promise<NostrEvent> {
    const event = finalizeEvent(template, this.agentSecretKey);
    this.published.push(event);
    this.deliver(event);
    return event;
  }

  /** Inject an event as if another member sent it through the relay. */
  deliver(event: NostrEvent): void {
    for (const h of this.handlers) h(event);
  }

  close(): void {}
}
