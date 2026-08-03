/**
 * SiloMemoryAgent — the Buzz member that gives a workspace long-term memory.
 *
 * Behavior:
 *  - Passively listens to every channel it's been added to and distills
 *    messages into memories stored in the silo (silent — it never replies
 *    unless spoken to).
 *  - Commands (anywhere in a channel it can see):
 *      !remember <text>   store verbatim, confirm in-thread
 *      !recall <query>    answer with ranked memories + provenance
 *      !memories          list recent memories for the channel
 *      !forget <id>       delete a memory by id
 *  - @mention with a question -> treated as !recall.
 */

import type { Event as NostrEvent } from "nostr-tools";
import type { BuzzRelay } from "./buzz/relay.js";
import {
  parseChannelMessage,
  isAddressedTo,
  stripMention,
  buildProfile,
  buildReply,
  KIND_CHANNEL_MESSAGE,
  KIND_MEMBER_LIST,
  CHANNEL_TAG,
  type ChannelMessage,
} from "./buzz/events.js";
import type { AgentIdentity } from "./buzz/identity.js";
import { since, preview } from "./log.js";
import type { MemoryStore } from "./silo/types.js";
import {
  extractMemories,
  explicitMemory,
  isQuestion,
  isSalient,
} from "./memory/extractor.js";
import { formatRecall, formatRecent } from "./memory/recall.js";
import {
  TurnWindowManager,
  type TranscriptSegment,
  type Turn,
  type WindowOptions,
} from "./memory/window.js";

export interface AgentOptions {
  /** Channels to join; [] = everything the relay lets us see. */
  channelIds?: string[];
  /** pubkey -> display name, for provenance lines in replies. */
  names?: Map<string, string>;
  /** Avatar URL for the kind 0 profile; omitted when empty. */
  pictureUrl?: string;
  /** Conversation-capture tuning: window size, overlap, idle flush. */
  capture?: Partial<WindowOptions>;
  /** Pause between shutdown flush retries (test seam). */
  shutdownRetryMs?: number;
  log?: (line: string) => void;
}

/** Shutdown flush retry budget: attempts and pacing. */
const SHUTDOWN_FLUSH_ATTEMPTS = 3;
const SHUTDOWN_FLUSH_RETRY_MS = 2_000;

/**
 * How often to look for channels the agent has been added to. Being added
 * is not something the agent can observe — the membership event belongs to
 * a channel it isn't in yet — so the only way to notice is to ask again.
 * Message delivery is live once subscribed; this only paces "welcome to a
 * new channel", where 30s is imperceptible.
 */
const CHANNEL_SYNC_MS = 30_000;

/** Recent messages scanned when member lists aren't available. */
const DISCOVERY_MESSAGE_LIMIT = 200;

const COMMAND = /^!(remember|recall|memories|forget)\b\s*([\s\S]*)$/i;

const SEEN_EVENTS_MAX = 2000;

/** A reply that failed to reach the relay — distinct from a silo failure. */
class DeliveryError extends Error {
  constructor(cause: unknown) {
    super(`reply delivery failed: ${cause}`);
  }
}

export class SiloMemoryAgent {
  private readonly names: Map<string, string>;
  private readonly log: (line: string) => void;
  /** Serializes event handling so replies can't outrun earlier captures. */
  private queue: Promise<void> = Promise.resolve();
  /**
   * Events accepted but not yet handled. Only used for logging: because the
   * queue is strictly serial, one slow local-model call stalls every message
   * behind it, and without this the agent just looks unresponsive.
   */
  private queued = 0;
  /**
   * Bounded FIFO dedup of relay redeliveries by event id. Eviction reopens
   * a window for very old redeliveries, but memory ids are deterministic
   * per event, so re-capture is idempotent for id-keyed stores, and the
   * silo's ingestion/enrichment pipeline dedupes the rest; live-tail
   * subscriptions make redeliveries older than the window rare.
   */
  private readonly seenEventIds = new Set<string>();
  /** Rolling per-channel turn buffers; segments flush to the store. */
  private readonly window: TurnWindowManager;
  private idleTimer?: NodeJS.Timeout;
  private channelSyncTimer?: NodeJS.Timeout;
  /** Whether any subscription has been opened (guards the fallback). */
  private subscriptionOpened = false;

  constructor(
    private readonly relay: BuzzRelay,
    private readonly store: MemoryStore,
    private readonly identity: AgentIdentity,
    private readonly options: AgentOptions = {}
  ) {
    this.names = options.names ?? new Map();
    this.log = options.log ?? (() => {});
    this.window = new TurnWindowManager(options.capture ?? {}, (segment) =>
      this.flushSegment(segment)
    );
  }

  /**
   * Channels the agent is a member of, in whatever order the relay
   * answered — nothing downstream depends on the ordering.
   *
   * Buzz keeps channel-scoped events out of live fan-out for unscoped
   * subscriptions, so the agent has to name each channel in its REQ — and
   * therefore has to find out which channels it is in. Buzz's own guidance
   * is that "clients discover groups via historical REQ queries", so this
   * is a read, not a subscription.
   *
   * Primary source is the relay-signed member list (kind 39002): its `d`
   * tag is the channel id and its `p` tags are the members, which answers
   * "am I in it?" definitively. Where that returns nothing — a relay that
   * doesn't publish member lists, or one that withholds them from agents —
   * fall back to the channels of recent messages, which is what the agent
   * could observe anyway.
   */
  private async discoverChannels(): Promise<string[]> {
    const found = new Set<string>();
    const query = this.relay.queryOnce?.bind(this.relay);
    if (!query) return [];
    try {
      const lists = await query({ kinds: [KIND_MEMBER_LIST] });
      for (const list of lists) {
        const channelId = list.tags.find((t) => t[0] === "d")?.[1];
        if (!channelId) continue;
        const members = list.tags.filter((t) => t[0] === "p").map((t) => t[1]);
        if (members.includes(this.identity.pubkey)) found.add(channelId);
      }
    } catch (err) {
      this.log(`channel discovery via member lists failed: ${err}`);
    }
    // Channels visible in traffic. Used as the whole answer when member
    // lists gave nothing, and otherwise only to report a discrepancy —
    // NOT unioned in. Buzz's open channels are readable by non-members, so
    // this source cannot tell "I was added to it" from "I can see it", and
    // capturing a channel the agent was never added to would break the one
    // promise it makes about its own scope.
    const seenInTraffic = new Set<string>();
    try {
      const recent = await query({
        kinds: [KIND_CHANNEL_MESSAGE],
        limit: DISCOVERY_MESSAGE_LIMIT,
      });
      for (const event of recent) {
        const channelId = event.tags.find((t) => t[0] === CHANNEL_TAG)?.[1];
        if (channelId) seenInTraffic.add(channelId);
      }
    } catch (err) {
      this.log(`channel discovery via recent messages failed: ${err}`);
    }

    if (found.size > 0) {
      // A member list that came back short (a relay's default limit, partial
      // indexing) would leave the agent quietly deaf in the channels it
      // missed. It can't be fixed by trusting traffic instead, but it can be
      // made loud rather than silent.
      const missing = [...seenInTraffic].filter((id) => !found.has(id));
      if (missing.length > 0) {
        this.log(
          `saw traffic in ${missing.length} channel(s) no member list covers ` +
            `(${missing.map((c) => `#${c.slice(0, 8)}`).join(", ")}) — not listening ` +
            `there. If the agent belongs in one, set BUZZ_CHANNEL_IDS.`
        );
      }
      return [...found];
    }
    return [...seenInTraffic];
  }

  /**
   * Subscribe to any channel we aren't already tailing. Run on start and on
   * a timer: being added to a new channel is an event the agent cannot see
   * (it isn't in a channel it hasn't joined), so the only way to notice is
   * to look again.
   */
  private async syncChannelSubscriptions(): Promise<void> {
    const configured = this.options.channelIds ?? [];
    const channels = configured.length > 0 ? configured : await this.discoverChannels();
    const already = this.relay.subscribedChannels?.() ?? new Set<string>();
    const fresh = channels.filter((id) => !already.has(id));

    // Stop listening to channels the agent has been removed from. Guarded on
    // a non-empty result: a relay hiccup or a failed query returns nothing,
    // and treating that as "removed from everything" would take the agent
    // offline until the next sweep. Only a positive answer about current
    // membership is allowed to revoke.
    if (channels.length > 0 && this.relay.unsubscribeChannels) {
      const current = new Set(channels);
      const gone = [...already].filter((id) => !current.has(id));
      if (gone.length > 0) {
        this.relay.unsubscribeChannels(gone);
        this.log(
          `no longer in ${gone.length} channel(s): ${gone.map((c) => `#${c.slice(0, 8)}`).join(", ")} — stopped listening`
        );
      }
    }

    if (fresh.length === 0) {
      // Nothing new. On the very first sweep with nothing found, still open
      // the unscoped subscription: it is the correct "everything visible"
      // behavior on relays that fan out globally (self-hosted, the
      // in-process demo relay), and on Buzz-style relays it still supplies
      // history across reconnects. Hard-coding one relay's fan-out rule as
      // "never subscribe globally" would break every other one.
      if (!this.subscriptionOpened) {
        this.subscriptionOpened = true;
        this.relay.subscribeChannels([], (event) => this.enqueue(event));
      }
      return;
    }

    this.subscriptionOpened = true;
    this.relay.subscribeChannels(fresh, (event) => this.enqueue(event));
    this.log(
      `listening to ${fresh.length} channel(s): ${fresh.map((c) => `#${c.slice(0, 8)}`).join(", ")}`
    );
  }

  /** Queue an event for strictly-ordered handling. */
  private enqueue(event: NostrEvent): void {
    // Our own replies come back on our own subscription — the relay
    // serves every event matching the filter, ours included. handleEvent
    // drops them anyway, but dropping them here keeps them out of the
    // backlog count: a reply published mid-turn echoes back while that
    // turn is still running, which would otherwise report a message
    // waiting behind it that does not exist.
    if (event.pubkey === this.identity.pubkey) return;
    this.queued += 1;
    if (this.queued > 1) {
      // Serial handling means the wait is real, not a relay delay — say so
      // rather than letting the agent look asleep.
      this.log(
        `${event.id.slice(0, 8)} is waiting on ${this.queued - 1} earlier message(s)`
      );
    }
    this.queue = this.queue
      .then(() =>
        this.handleEvent(event).catch((err) =>
          this.log(`error handling event ${event.id.slice(0, 8)}: ${err}`)
        )
      )
      .finally(() => {
        this.queued -= 1;
      });
  }

  /** Run one channel-sync sweep now (tests; the timer does this on its own). */
  syncForTest(): Promise<void> {
    return this.syncChannelSubscriptions();
  }

  async start(): Promise<void> {
    await this.relay.connect();
    // Announce who we are before subscribing: without a kind 0 the client
    // has no name for this pubkey and shows raw hex everywhere the agent
    // appears. Non-fatal — a workspace that rejects profile writes should
    // still get a working agent, just an unnamed one.
    try {
      await this.relay.publish(
        buildProfile(this.identity.handle, this.options.pictureUrl)
      );
      this.log(`published profile as @${this.identity.handle}`);
    } catch (err) {
      this.log(`could not publish the agent profile (continuing unnamed): ${err}`);
    }
    // Events are processed strictly in arrival order: a !recall must see
    // the memories of every message delivered before it, and a redelivered
    // event must not be captured twice. See enqueue().
    await this.syncChannelSubscriptions();
    if ((this.relay.subscribedChannels?.().size ?? 0) === 0 && this.relay.queryOnce) {
      // Worth saying plainly: on Buzz this state receives nothing live, and
      // "connected, subscribed, silent" is the single most confusing thing
      // this agent can do.
      this.log(
        `not in any channel yet — add @${this.identity.handle} to one and it will ` +
          `start listening within ${Math.round(CHANNEL_SYNC_MS / 1000)}s`
      );
    }
    this.channelSyncTimer = setInterval(() => {
      void this.syncChannelSubscriptions().catch((err) =>
        this.log(`channel sync failed: ${err}`)
      );
    }, CHANNEL_SYNC_MS);
    this.channelSyncTimer.unref?.();
    // Idle episodes flush on a timer; chained onto the queue so flushes
    // never interleave with in-flight event handling.
    this.idleTimer = setInterval(() => {
      this.queue = this.queue.then(() => this.window.flushIdle(Date.now()));
    }, 30_000);
    this.idleTimer.unref?.();
    this.log(`silo-memory agent online as ${this.identity.pubkey.slice(0, 12)}… (@${this.identity.handle})`);
  }

  /** Flush pending conversation buffers and stop timers (shutdown path). */
  async stop(): Promise<void> {
    if (this.idleTimer) clearInterval(this.idleTimer);
    if (this.channelSyncTimer) clearInterval(this.channelSyncTimer);
    // Drain queued event handling before the final flush: turns still in
    // the queue at shutdown must land in the buffers first, and a flush
    // must never interleave with an in-flight handler.
    this.queue = this.queue.then(() => this.finalFlush());
    await this.queue;
  }

  /**
   * Shutdown flush with bounded retry: a transient silo error at exit
   * restores turns to the window, and without a retry they'd be silently
   * lost when the process exits. After the last attempt, say exactly what
   * is being dropped instead of pretending the flush succeeded.
   */
  private async finalFlush(): Promise<void> {
    const attempts = SHUTDOWN_FLUSH_ATTEMPTS;
    const retryMs = this.options.shutdownRetryMs ?? SHUTDOWN_FLUSH_RETRY_MS;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.window.flushAll();
      const left = this.window.pendingTotal();
      if (left === 0) return;
      if (attempt < attempts) {
        this.log(`shutdown flush left ${left} turns pending; retrying in ${retryMs}ms`);
        await new Promise((r) => setTimeout(r, retryMs));
      } else {
        this.log(`shutdown: dropping ${left} uncaptured turns after ${attempts} flush attempts`);
      }
    }
  }

  async handleEvent(event: NostrEvent): Promise<void> {
    if (event.pubkey === this.identity.pubkey) return; // never eat our own replies
    if (this.seenEventIds.has(event.id)) return;
    const msg = parseChannelMessage(event);
    if (!msg) return; // not marked seen: re-parsing a redelivery is cheap
    this.seenEventIds.add(event.id);
    if (this.seenEventIds.size > SEEN_EVENTS_MAX) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest) this.seenEventIds.delete(oldest);
    }

    const command = msg.content.trim().match(COMMAND);
    if (command) {
      await this.answering(msg, `!${command[1]!.toLowerCase()}`, () =>
        this.handleCommand(msg, command[1]!.toLowerCase(), (command[2] ?? "").trim())
      );
      return;
    }

    if (isAddressedTo(msg, this.identity.pubkey, this.identity.handle)) {
      await this.answering(msg, "mention", () => this.handleMention(msg));
      return;
    }

    // Passive path: append to the channel's turn window. Salient turns
    // flush their window immediately; the rest wait for the size/idle
    // trigger so whole episodes reach the silo with context. Capture
    // failures are retried by the window itself (restore + next flush),
    // so the event stays deduped.
    await this.window.push(msg.channelId, turnOf(msg), isSalient(msg.content));
  }

  /**
   * Deliver a flushed segment to the store. Preferred path: whole-transcript
   * capture (rememberTranscript) so the silo's server-side pipeline distills
   * with turn context. Fallback for stores without it: per-turn heuristic
   * extraction of the fresh turns only (overlap is context, never
   * re-captured). Failures restore the fresh turns for the next flush.
   */
  private async flushSegment(segment: TranscriptSegment): Promise<void> {
    const started = Date.now();
    try {
      if (this.store.rememberTranscript) {
        this.log(
          `capturing ${segment.fresh.length} turn(s) from #${segment.channelId} (${segment.reason})…`
        );
        const outcome = await this.store.rememberTranscript(segment);
        if (outcome.status === "needs_confirmation") {
          this.log(
            `segment capture held for owner confirmation (#${segment.channelId}, ${segment.fresh.length} turns, ${since(started)})`
          );
        } else {
          this.log(
            `captured segment #${segment.channelId} (${segment.fresh.length} fresh turns, reason=${segment.reason}) in ${since(started)}`
          );
        }
        return;
      }
      for (const turn of segment.fresh) {
        for (const memory of extractMemories(channelMessageOf(segment.channelId, turn))) {
          const outcome = await this.store.remember(memory);
          if (outcome.status === "needs_confirmation") {
            this.log(`capture held for owner confirmation [${memory.kind}] ${memory.content}`);
          } else {
            this.log(`remembered [${memory.kind}] ${memory.content}`);
          }
        }
      }
    } catch (err) {
      this.window.restore(segment);
      this.log(
        `segment capture failed #${segment.channelId} after ${since(started)} ` +
          `(${segment.fresh.length} turns retained for retry): ${err}`
      );
    }
  }

  /**
   * Run a command/mention handler; if the silo errors, tell the channel
   * instead of failing silently (passive capture errors only hit the log).
   *
   * Failed commands/mentions deliberately STAY deduped: the human got an
   * explicit error reply and their retry is a new event (new id), which is
   * the interactive retry path. Un-marking would let a relay redelivery
   * re-run the command later and post an out-of-context duplicate reply.
   * Passive capture failures retry via the turn window (restore + next
   * flush) rather than via redelivery.
   */
  private async answering(
    msg: ChannelMessage,
    kind: string,
    handler: () => Promise<void>
  ): Promise<void> {
    const id = msg.event.id.slice(0, 8);
    const started = Date.now();
    // Announce the start, not just the finish. Everything downstream of here
    // can take tens of seconds on a local model, and a silent agent is
    // indistinguishable from a dead one — which is exactly the confusion
    // this line exists to remove.
    this.log(
      `${id} thinking about a ${kind} in #${msg.channelId} from ${this.who(msg.authorPubkey)}: "${preview(msg.content)}"`
    );
    try {
      await handler();
      this.log(`${id} done in ${since(started)}`);
    } catch (err) {
      if (err instanceof DeliveryError) {
        // The silo work succeeded; only the reply couldn't reach the relay.
        // An apology would be wrong ("silo error") and undeliverable anyway.
        this.log(`could not deliver reply ${id} after ${since(started)}: ${err.message}`);
        return;
      }
      this.log(`error answering ${id} after ${since(started)}: ${err}`);
      try {
        await this.reply(
          msg,
          "Sorry — I hit an error talking to the silo. Please try again in a moment."
        );
      } catch (replyErr) {
        // Relay down too — nothing left to do but record both failures.
        this.log(`failed to deliver error reply ${msg.event.id.slice(0, 8)}: ${replyErr}`);
      }
    }
  }

  private async handleCommand(
    msg: ChannelMessage,
    command: string,
    arg: string
  ): Promise<void> {
    switch (command) {
      case "remember": {
        if (!arg) return this.reply(msg, "Usage: !remember <what to remember>");
        const outcome = await this.store.remember(explicitMemory(msg, arg));
        switch (outcome.status) {
          case "stored":
            return this.reply(msg, `Got it — I'll remember that. (id ${outcome.id})`);
          case "queued":
            return this.reply(
              msg,
              "Got it — capturing that to the silo now; it'll be recallable shortly."
            );
          case "needs_confirmation":
            return this.reply(
              msg,
              "That would update existing memories, so I didn't apply it — the silo owner can confirm the change from the One Silo dashboard."
            );
        }
        return;
      }
      case "recall": {
        if (!arg) return this.reply(msg, "Usage: !recall <query>");
        return this.reply(msg, await this.answer(arg, msg.channelId));
      }
      case "memories": {
        // Channel-scoped recent list first; if the store has nothing for
        // this channel but can compose a silo-wide overview, use that.
        const recent = await this.store.recent(msg.channelId, 10);
        if (recent.length === 0 && this.store.overview) {
          return this.reply(msg, await this.store.overview(msg.channelId));
        }
        return this.reply(msg, formatRecent(recent));
      }
      case "forget": {
        if (!arg) return this.reply(msg, "Usage: !forget <memory id>");
        const removed = await this.store.forget(arg, msg.channelId);
        return this.reply(
          msg,
          removed ? `Forgotten (id ${arg}).` : `No memory with id ${arg}.`
        );
      }
    }
  }

  private async handleMention(msg: ChannelMessage): Promise<void> {
    // Strip the mention; if what's left is a !command, run it as one.
    const query = stripMention(msg.content, this.identity.handle);
    const command = query.match(COMMAND);
    if (command) {
      return this.handleCommand(msg, command[1]!.toLowerCase(), (command[2] ?? "").trim());
    }
    if (!query) {
      return this.reply(
        msg,
        "Hi! I give this workspace memory, powered by One Silo. Try `!recall <query>`, `!remember <text>`, or `!memories`."
      );
    }
    const response = await this.answer(query, msg.channelId);
    // Reply first (latency), but hold any delivery failure so the
    // side-capture below runs regardless — a statement worth keeping must
    // not be lost just because the reply couldn't reach the relay.
    let deliveryFailure: unknown;
    try {
      await this.reply(msg, response);
    } catch (err) {
      deliveryFailure = err;
    }
    // Questions addressed to the agent are requests for memory, not memory
    // — but a mention can also carry a statement worth keeping
    // ("@silo we decided to ship Friday"). Push the mention-stripped text
    // into the channel's turn window as salient, so it flushes now WITH the
    // surrounding conversation as context. Capture failures are retried by
    // the window (restore + next flush); the event stays marked seen so a
    // redelivery can't answer the mention twice.
    if (!isQuestion(query)) {
      await this.window.push(
        msg.channelId,
        { ...turnOf(msg), content: query },
        true
      );
    }
    if (deliveryFailure) throw deliveryFailure; // answering() logs DeliveryError
  }

  /**
   * Answer a question from memory. When the store can compose a grounded
   * answer itself (silo_ask), relay it verbatim — the silo's voice is the
   * product. Otherwise recall raw memories and format locally.
   */
  private async answer(query: string, channelId?: string): Promise<string> {
    // Timed separately from the enclosing turn: when a reply is slow this is
    // almost always where the time went, and knowing whether it was the silo
    // or everything else is the difference between a config problem and a
    // model-too-big-for-this-machine problem.
    const started = Date.now();
    if (this.store.ask) {
      this.log(`asking the silo: "${preview(query)}"`);
      const answer = await this.store.ask(query, channelId);
      this.log(`silo answered in ${since(started)}`);
      return answer;
    }
    this.log(`searching memory for: "${preview(query)}"`);
    const results = await this.store.recall({ text: query, channelId, limit: 5 });
    this.log(`memory search returned ${results.length} result(s) in ${since(started)}`);
    return formatRecall(query, results, this.names);
  }

  /** Display name for logs, falling back to a short pubkey. */
  private who(pubkey: string): string {
    const name = this.names.get(pubkey);
    return name ? `@${name}` : pubkey.slice(0, 8);
  }

  private async reply(to: ChannelMessage, content: string): Promise<void> {
    try {
      await this.relay.publish(buildReply(to, content));
    } catch (err) {
      throw new DeliveryError(err);
    }
    this.log(`replied in ${to.channelId}: ${content.split("\n")[0]}`);
  }
}

function turnOf(msg: ChannelMessage): Turn {
  return {
    authorPubkey: msg.authorPubkey,
    content: msg.content,
    createdAt: msg.createdAt,
    eventId: msg.event.id,
  };
}

/** Minimal ChannelMessage for the per-turn extraction fallback. */
function channelMessageOf(channelId: string, turn: Turn): ChannelMessage {
  return {
    event: { id: turn.eventId } as NostrEvent,
    channelId,
    authorPubkey: turn.authorPubkey,
    content: turn.content,
    createdAt: turn.createdAt,
    mentionedPubkeys: [],
  };
}
