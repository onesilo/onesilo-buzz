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

/**
 * Subscription-id prefix for one-shot historical queries, so a stray frame
 * arriving after the query settled is recognisable as not a live tail.
 */
const QUERY_SUB_PREFIX = "silo-q-";

export interface BuzzRelay {
  connect(): Promise<void>;
  /**
   * Subscribe to channel messages. One subscription is opened per channel
   * id — see subscribeChannels() on the implementation for why that is
   * load-bearing rather than a style choice. An empty list opens a single
   * unscoped subscription, which reads history but receives no live
   * traffic; callers should discover channels first.
   */
  subscribeChannels(channelIds: string[], onEvent: EventHandler): void;
  /**
   * One-shot historical query: REQ, collect until EOSE, CLOSE. Buzz stores
   * channel-scoped events but excludes unscoped subscriptions from live
   * fan-out, so discovery ("which channels am I in?") has to be a
   * historical read even though message delivery is live.
   */
  queryOnce?(filter: Record<string, unknown>, timeoutMs?: number): Promise<NostrEvent[]>;
  /**
   * Channel ids currently subscribed to. Optional: a relay that cannot
   * report this simply gets re-subscribed to the same channels, which the
   * agent's event-id dedup already absorbs.
   */
  subscribedChannels?(): Set<string>;
  /** Stop delivery for these channels (the agent was removed from them). */
  unsubscribeChannels?(channelIds: string[]): void;
  /**
   * Called once the relay has accepted our NIP-42 AUTH.
   *
   * Anything the agent asked the relay *before* that point was answered by
   * an unauthenticated connection — on an auth-enforcing relay, with
   * nothing. Channel discovery is the case that matters: it runs at
   * startup, comes back empty because the relay refused it, and leaves the
   * agent subscribed to nothing in particular. Replaying the subscriptions
   * does not fix that, because the answer that was wrong was the discovery,
   * not the subscription.
   *
   * Optional: a relay without auth never calls it and needs no hook.
   */
  onAuthenticated?(fn: () => void): void;
  /** Sign with the agent identity and publish. */
  publish(template: EventTemplate): Promise<NostrEvent>;
  close(): void;
}

export class WebSocketRelay implements BuzzRelay {
  private ws?: WebSocket;
  private subSeq = 0;
  private handlers = new Map<string, EventHandler>();
  /** EOSE callbacks for one-shot queries; live tails have none. */
  private eoseHandlers = new Map<string, () => void>();
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
  private authListeners: Array<() => void> = [];
  /** Signed events waiting for the socket to (re)open; FIFO, bounded. */
  private outbox: Array<{
    event: NostrEvent;
    resolve: (event: NostrEvent) => void;
    reject: (err: Error) => void;
  }> = [];
  private static readonly OUTBOX_MAX = 1000;
  /**
   * Events sent but not yet acknowledged by the relay, re-sent after a
   * NIP-42 AUTH exchange: a relay that enforces auth-before-publish drops
   * EVENTs sent between socket-open and auth completion.
   *
   * Entries are dropped once the relay settles them — accepted (delivered)
   * or refused for anything other than auth (replaying won't help). So
   * this holds only what is genuinely still in question, which keeps the
   * post-auth replay small and stops a reconnect from re-sending a
   * thousand already-delivered events. Bounded anyway, since a relay that
   * never sends OK would otherwise grow it forever.
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
   * Register a callback for "the relay has accepted our AUTH".
   *
   * Fires on every successful auth, not just the first: a reconnect
   * re-authenticates, and the same reasoning applies each time.
   */
  onAuthenticated(fn: () => void): void {
    this.authListeners.push(fn);
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
      // Only a live tail advances the resubscribe floor. One-shot discovery
      // queries return history — recent messages from every channel, member
      // lists — and letting those set the floor would mean a channel
      // subscribed straight after discovery starts from "now" and silently
      // skips everything between process start and that point.
      //
      // created_at is also attacker- and clock-controlled: it is whatever
      // the publishing client stamped. Letting it push the floor into the
      // future would make every later REQ ask for events "since next
      // Tuesday" — one skewed message and the agent goes deaf until real
      // time catches up. Never advance the floor past now.
      if (this.subscriptions.has(subId)) {
        const now = Math.floor(Date.now() / 1000);
        const seenAt = Math.min(event.created_at, now);
        if (seenAt > this.latestSeenAt) this.latestSeenAt = seenAt;
      }
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
      const detail = reason ?? "no reason given";
      const retryable = !accepted && detail.startsWith("auth-required");
      if (!retryable) {
        // Settled: either delivered, or refused for a reason re-sending
        // cannot fix. Either way it must not ride along on the next
        // auth replay.
        this.recentlySent = this.recentlySent.filter((e) => e.id !== eventId);
      }
      if (!accepted) {
        this.log(
          `relay rejected event ${String(eventId).slice(0, 8)}: ${detail}` +
            (retryable ? " (will retry after auth)" : "")
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
      // A one-shot query is never "live". Keyed off the id prefix rather
      // than the handler map, because a query that already timed out has
      // dropped its handler — and a late EOSE arriving afterwards would
      // otherwise be announced as a live tail that does not exist.
      if (subId.startsWith(QUERY_SUB_PREFIX)) {
        this.eoseHandlers.get(subId)?.();
        return;
      }
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
    // Re-issuing the subscriptions is not enough. Whatever the agent
    // *asked* pre-auth was answered by an unauthenticated connection, and
    // on this relay that means "nothing" — so channel discovery concluded
    // the agent is in no channels and subscribed accordingly. Replaying
    // that subscription faithfully replays the wrong answer.
    for (const fn of this.authListeners) {
      try {
        fn();
      } catch (err) {
        this.log(`post-auth listener failed: ${err}`);
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

  /**
   * One subscription per channel, each carrying its own `#h`.
   *
   * This is the difference between an agent that works and one that
   * silently never hears anything. Buzz keeps channel-scoped and global
   * subscriptions strictly separate for live fan-out: a kinds-only
   * subscription is served from storage and then excluded from the live
   * path forever. The symptom is maximally misleading — the REQ is
   * accepted, history arrives, EOSE says "live", and nothing follows.
   *
   * An empty list still opens the unscoped subscription, which is honest
   * about what it can do: history on (re)connect, no live traffic. Callers
   * that want messages must discover channels first.
   */
  subscribeChannels(channelIds: string[], onEvent: EventHandler): void {
    if (!this.ws) throw new Error("relay not connected");
    const scopes = channelIds.length > 0 ? channelIds.map((id) => [id]) : [[]];
    for (const scope of scopes) {
      const subId = `silo-mem-${++this.subSeq}`;
      this.handlers.set(subId, onEvent);
      // Live tail only (backfill is a deliberate non-goal). The floor is
      // computed per (re)subscribe by filterFor().
      this.subscriptions.set(subId, scope);
      this.ws.send(JSON.stringify(["REQ", subId, this.filterFor(scope)]));
    }
  }

  /**
   * Drop the subscriptions for these channels, telling the relay to stop.
   *
   * Being removed from a channel has to actually stop delivery: leaving the
   * REQ open would keep capturing conversation from a channel the agent was
   * deliberately taken out of, which is the one thing a memory agent must
   * never do.
   */
  unsubscribeChannels(channelIds: string[]): void {
    const dropping = new Set(channelIds);
    for (const [subId, scope] of [...this.subscriptions]) {
      if (scope.length === 0 || !scope.every((id) => dropping.has(id))) continue;
      this.subscriptions.delete(subId);
      this.handlers.delete(subId);
      try {
        this.ws?.send(JSON.stringify(["CLOSE", subId]));
      } catch {
        // Socket already gone; a reconnect won't replay it either, since
        // it's out of `subscriptions` now.
      }
    }
  }

  /**
   * Newest `created_at` delivered on a live tail — the value that floors
   * `since` on resubscribe. Exposed because "what does this agent think
   * the current moment is?" is the state that decides whether a reconnect
   * replays too much or skips real messages.
   */
  get newestSeenAt(): number {
    return this.latestSeenAt;
  }

  /** Channel ids currently subscribed to (used to spot new ones). */
  subscribedChannels(): Set<string> {
    const ids = new Set<string>();
    for (const scope of this.subscriptions.values()) {
      for (const id of scope) ids.add(id);
    }
    return ids;
  }

  async queryOnce(
    filter: Record<string, unknown>,
    timeoutMs = 10_000
  ): Promise<NostrEvent[]> {
    const ws = this.ws;
    if (!ws) throw new Error("relay not connected");
    const subId = `${QUERY_SUB_PREFIX}${++this.subSeq}`;
    const events: NostrEvent[] = [];
    return new Promise((resolve) => {
      // Resolve on EOSE, or on the timeout with whatever arrived. A
      // discovery query that hangs must not wedge startup — an empty
      // result degrades to "no channels found", which is recoverable on
      // the next sweep, whereas a never-settling promise is not.
      const finish = () => {
        clearTimeout(timer);
        this.handlers.delete(subId);
        this.eoseHandlers.delete(subId);
        try {
          ws.send(JSON.stringify(["CLOSE", subId]));
        } catch {
          // Socket already gone; the relay drops the subscription anyway.
        }
        resolve(events);
      };
      const timer = setTimeout(finish, timeoutMs);
      this.handlers.set(subId, (event) => events.push(event));
      this.eoseHandlers.set(subId, finish);
      ws.send(JSON.stringify(["REQ", subId, filter]));
    });
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
