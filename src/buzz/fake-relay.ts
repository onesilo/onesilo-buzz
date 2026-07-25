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

  constructor(private readonly agentSecretKey: Uint8Array) {}

  async connect(): Promise<void> {}

  subscribeChannels(_channelIds: string[], onEvent: EventHandler): void {
    this.handlers.push(onEvent);
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
