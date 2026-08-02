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

/**
 * Slack subtracted from the newest-seen timestamp when resubscribing, so a
 * reconnect can't skip an event that was in flight or slightly out of
 * order. Redelivery inside this window is absorbed by the agent's event-id
 * dedup; a gap would be silent data loss, so err toward redelivery.
 */
const RESUBSCRIBE_SLACK_SECONDS = 60;

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
  /**
   * Channel ids by subscription id, replayed after reconnect / NIP-42 auth.
   * Stored as ids rather than built filters so `since` is recomputed at
   * (re)subscribe time — see filterFor().
   */
  private subscriptions = new Map<string, string[]>();
  private closed = false;
  private reconnectDelayMs = 1000;
  private reconnectTimer?: NodeJS.Timeout;

  /**
   * Liveness heartbeat.
   *
   * Hosted relays sit behind proxies that silently drop idle WebSockets
   * (Cloudflare's is ~100s). Nothing in the protocol tells us: the socket
   * stays "open", no 'close' fires, and we sit there receiving nothing
   * while the relay queues our messages — until some lower layer finally
   * times out, minutes later, and the reconnect delivers the whole backlog
   * at once. That is exactly the "the agent replied 20 minutes later"
   * failure, and it is invisible from the agent's side without this.
   *
   * So: ping on an interval, and if a ping goes unanswered by the time the
   * next one is due, treat the socket as dead and terminate it — which
   * fires 'close' and runs the normal reconnect path. Detection is bounded
   * at 2× the interval.
   */
  private heartbeatTimer?: NodeJS.Timeout;
  private awaitingPong = false;
  /** Newest created_at we've been delivered; floors `since` on resubscribe. */
  private latestSeenAt = 0;

  /**
   * NIP-42 state, per connection.
   *
   * The agent opens a socket and immediately publishes its profile and
   * subscribes — but a relay that enforces auth only challenges us *after*
   * the socket is open, so those first frames are unauthenticated and get
   * refused: an `OK … false "auth-required: …"` for the event, and a
   * `CLOSED <sub> "auth-required: …"` for the subscription. The CLOSED is
   * the dangerous one — ignoring it leaves the agent connected, healthy
   * looking, and subscribed to absolutely nothing.
   *
   * So: remember what we sent, and once the relay confirms our AUTH, put
   * it all back.
   */
  private authEventId?: string;
  private authenticated = false;
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

  /**
   * Live-tail floor, stamped at construction rather than subscribe time:
   * startup work between construction and the first REQ (OAuth checks,
   * get_scope) must not open a gap of missed messages.
   */
  private readonly sinceFloor = Math.floor(Date.now() / 1000);

  constructor(
    private readonly url: string,
    private readonly identity: AgentIdentity,
    private readonly log: (line: string) => void = () => {},
    /** Heartbeat pacing; overridable so tests don't wait 30s. */
    private readonly pingIntervalMs = 30_000
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
    // Auth is per-connection: a reconnect starts unauthenticated.
    this.authenticated = false;
    this.authEventId = undefined;
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
      this.startHeartbeat(ws);
      for (const [subId, channelIds] of this.subscriptions) {
        ws.send(JSON.stringify(["REQ", subId, this.filterFor(channelIds)]));
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
    ws.on("pong", () => {
      this.awaitingPong = false;
    });
    ws.on("close", () => {
      if (this.ws === ws) this.stopHeartbeat();
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

  /** Ping on an interval; an unanswered ping means the socket is dead. */
  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.awaitingPong = false;
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      if (this.awaitingPong) {
        this.log("relay stopped answering pings — reconnecting");
        this.stopHeartbeat();
        // terminate(), not close(): a half-open socket will never complete
        // a closing handshake, and close() would hang waiting for it.
        ws.terminate();
        return;
      }
      this.awaitingPong = true;
      ws.ping();
    }, this.pingIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.awaitingPong = false;
  }

  /**
   * The REQ filter, with `since` computed now rather than reused.
   *
   * A reconnect that replayed the construction-time floor would re-deliver
   * every event since the process started — on a long-lived agent that
   * outgrows the dedup window, meaning re-answered commands and duplicate
   * captures. Floor at the newest event we've actually seen instead, minus
   * a slack window so an out-of-order or clock-skewed event straddling the
   * reconnect isn't skipped.
   */
  private filterFor(channelIds: string[]): Record<string, unknown> {
    const since = Math.max(
      this.sinceFloor,
      this.latestSeenAt > 0 ? this.latestSeenAt - RESUBSCRIBE_SLACK_SECONDS : 0
    );
    const filter: Record<string, unknown> = {
      kinds: [KIND_CHANNEL_MESSAGE],
      since,
    };
    if (channelIds.length > 0) filter[`#${CHANNEL_TAG}`] = channelIds;
    return filter;
  }

  private onMessage(raw: string): void {
    if (this.closed) return; // no dispatch after shutdown was requested
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
      if (event.created_at > this.latestSeenAt) this.latestSeenAt = event.created_at;
      this.handlers.get(subId)?.(event);
    } else if (type === "OK") {
      // NIP-01 write acknowledgement. publish() resolves on socket write
      // (see its doc); a rejection surfaces here for the operator. Gating
      // publish() on OK (with timeouts for relays that omit it) is roadmap.
      const [eventId, accepted, reason] = rest as [string, boolean, string?];
      if (eventId === this.authEventId) {
        // The one OK that decides whether this agent can work at all.
        if (accepted) {
          this.authenticated = true;
          this.log("authenticated with the relay (NIP-42)");
          this.replayAfterAuth();
        } else {
          this.log(
            `relay REJECTED our authentication: ${reason ?? "no reason given"} — ` +
              `it will not deliver messages to this agent. Check that this pubkey ` +
              `is a member of the workspace.`
          );
        }
        return;
      }
      if (!accepted) {
        const detail = reason ?? "no reason given";
        this.log(
          `relay rejected event ${String(eventId).slice(0, 8)}: ${detail}` +
            (detail.startsWith("auth-required") ? " (will retry after auth)" : "")
        );
      }
    } else if (type === "CLOSED") {
      // A rejected subscription. Ignoring this was how the agent ended up
      // connected but deaf: the relay refuses the pre-auth REQ, says so
      // here, and nothing ever re-established it.
      const [subId, reason] = rest as [string, string?];
      const detail = reason ?? "no reason given";
      this.log(`relay closed subscription ${subId}: ${detail}`);
      if (detail.startsWith("auth-required")) {
        // Re-issue now if we're already authenticated; otherwise the
        // post-auth replay covers it.
        if (this.authenticated) this.resubscribeAll();
      }
    } else if (type === "EOSE") {
      // End of stored events: the subscription is live. Worth saying —
      // it's the only positive confirmation the agent is actually
      // listening, and its absence is what "nothing happens" looks like.
      const [subId] = rest as [string];
      this.log(`subscription ${subId} is live`);
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
      this.authEventId = auth.id;
      this.log("relay requested authentication (NIP-42) — responding");
      this.ws?.send(JSON.stringify(["AUTH", auth]));
      // Replay immediately as well as on the auth OK: relays are
      // inconsistent about acknowledging the AUTH event, and a relay that
      // processes frames in order will handle these after it. Both paths
      // are idempotent — a REQ with an existing sub id replaces that
      // subscription, and relays deduplicate EVENTs by id.
      this.replayAfterAuth();
    }
  }

  /** Re-issue every subscription on the current socket. */
  private resubscribeAll(): void {
    for (const [subId, channelIds] of this.subscriptions) {
      this.ws?.send(JSON.stringify(["REQ", subId, this.filterFor(channelIds)]));
    }
  }

  /**
   * Put back everything the relay may have refused while we were
   * unauthenticated: subscriptions first (so we don't miss events our own
   * republished writes provoke), then recently sent events.
   */
  private replayAfterAuth(): void {
    this.resubscribeAll();
    for (const event of this.recentlySent) {
      this.ws?.send(JSON.stringify(["EVENT", event]));
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
    // Live tail only (backfill is a deliberate non-goal). The floor is
    // computed per (re)subscribe by filterFor().
    this.subscriptions.set(subId, channelIds);
    this.ws.send(JSON.stringify(["REQ", subId, this.filterFor(channelIds)]));
  }

  /**
   * Resolution means "written to an open socket (or queued and flushed)".
   * Relay-side acceptance is a separate NIP-01 OK frame: rejections are
   * logged in onMessage rather than failing this promise, because relays
   * may ack late or not at all — full OK-gated delivery is roadmap.
   */
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
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const pending = this.outbox;
    this.outbox = [];
    for (const p of pending) {
      p.reject(new Error("relay closed before the event was delivered"));
    }
    this.ws?.close();
  }
}
