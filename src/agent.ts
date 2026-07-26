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
  buildReply,
  type ChannelMessage,
} from "./buzz/events.js";
import type { AgentIdentity } from "./buzz/identity.js";
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
  /** Conversation-capture tuning: window size, overlap, idle flush. */
  capture?: Partial<WindowOptions>;
  log?: (line: string) => void;
}

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

  async start(): Promise<void> {
    await this.relay.connect();
    this.relay.subscribeChannels(this.options.channelIds ?? [], (event) => {
      // Events are processed strictly in arrival order: a !recall must see
      // the memories of every message delivered before it, and a redelivered
      // event must not be captured twice.
      this.queue = this.queue.then(() =>
        this.handleEvent(event).catch((err) =>
          this.log(`error handling event ${event.id.slice(0, 8)}: ${err}`)
        )
      );
    });
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
    // Drain queued event handling before the final flush: turns still in
    // the queue at shutdown must land in the buffers first, and a flush
    // must never interleave with an in-flight handler.
    this.queue = this.queue.then(() => this.window.flushAll());
    await this.queue;
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
      await this.answering(msg, () =>
        this.handleCommand(msg, command[1]!.toLowerCase(), (command[2] ?? "").trim())
      );
      return;
    }

    if (isAddressedTo(msg, this.identity.pubkey, this.identity.handle)) {
      await this.answering(msg, () => this.handleMention(msg));
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
    try {
      if (this.store.rememberTranscript) {
        const outcome = await this.store.rememberTranscript(segment);
        if (outcome.status === "needs_confirmation") {
          this.log(
            `segment capture held for owner confirmation (#${segment.channelId}, ${segment.fresh.length} turns)`
          );
        } else {
          this.log(
            `captured segment #${segment.channelId} (${segment.fresh.length} fresh turns, reason=${segment.reason})`
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
        `segment capture failed #${segment.channelId} (${segment.fresh.length} turns retained for retry): ${err}`
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
    handler: () => Promise<void>
  ): Promise<void> {
    try {
      await handler();
    } catch (err) {
      if (err instanceof DeliveryError) {
        // The silo work succeeded; only the reply couldn't reach the relay.
        // An apology would be wrong ("silo error") and undeliverable anyway.
        this.log(`could not deliver reply ${msg.event.id.slice(0, 8)}: ${err.message}`);
        return;
      }
      this.log(`error answering ${msg.event.id.slice(0, 8)}: ${err}`);
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
    if (this.store.ask) {
      return this.store.ask(query, channelId);
    }
    const results = await this.store.recall({ text: query, channelId, limit: 5 });
    return formatRecall(query, results, this.names);
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
