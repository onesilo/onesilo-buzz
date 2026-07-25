/**
 * SiloMemoryAgent — the Buzz member that gives a workspace long-term memory.
 *
 * Behavior:
 *  - Passively listens to every channel it's been added to and distills
 *    messages into memories stored in the Silo (silent — it never replies
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
import { extractMemories, explicitMemory, isQuestion } from "./memory/extractor.js";
import { formatRecall, formatRecent } from "./memory/recall.js";

export interface AgentOptions {
  /** Channels to join; [] = everything the relay lets us see. */
  channelIds?: string[];
  /** pubkey -> display name, for provenance lines in replies. */
  names?: Map<string, string>;
  log?: (line: string) => void;
}

const COMMAND = /^!(remember|recall|memories|forget)\b\s*([\s\S]*)$/;

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

  constructor(
    private readonly relay: BuzzRelay,
    private readonly store: MemoryStore,
    private readonly identity: AgentIdentity,
    private readonly options: AgentOptions = {}
  ) {
    this.names = options.names ?? new Map();
    this.log = options.log ?? (() => {});
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
    this.log(`silo-memory agent online as ${this.identity.pubkey.slice(0, 12)}… (@${this.identity.handle})`);
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
        this.handleCommand(msg, command[1]!, (command[2] ?? "").trim())
      );
      return;
    }

    if (isAddressedTo(msg, this.identity.pubkey, this.identity.handle)) {
      await this.answering(msg, () => this.handleMention(msg));
      return;
    }

    try {
      await this.ingest(msg);
    } catch (err) {
      // The capture failed, so un-mark the event: a relay redelivery is
      // this message's only retry path and must not be swallowed by dedup.
      this.seenEventIds.delete(event.id);
      throw err;
    }
  }

  /**
   * Run a command/mention handler; if the silo errors, tell the channel
   * instead of failing silently (passive ingest errors only hit the log).
   *
   * Failed commands/mentions deliberately STAY deduped: the human got an
   * explicit error reply and their retry is a new event (new id), which is
   * the interactive retry path. Un-marking would let a relay redelivery
   * re-run the command later and post an out-of-context duplicate reply.
   * Passive ingest is the opposite — no human in the loop — so only there
   * does a failure un-mark the event to make redelivery a retry.
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

  private async ingest(msg: ChannelMessage): Promise<void> {
    const memories = extractMemories(msg);
    for (const memory of memories) {
      const outcome = await this.store.remember(memory);
      if (outcome.status === "needs_confirmation") {
        // The capture was NOT applied — it would replace existing memories
        // and only the silo owner may confirm that (from the dashboard).
        this.log(
          `capture held for owner confirmation [${memory.kind}] ${memory.content}`
        );
      } else {
        this.log(`remembered [${memory.kind}] ${memory.content}`);
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
              "That would update existing memories, so I didn't apply it — the silo owner can confirm the change from the Silo dashboard."
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
      return this.handleCommand(msg, command[1]!, (command[2] ?? "").trim());
    }
    if (!query) {
      return this.reply(
        msg,
        "Hi! I give this workspace memory via Silo. Try `!recall <query>`, `!remember <text>`, or `!memories`."
      );
    }
    await this.reply(msg, await this.answer(query, msg.channelId));
    // Questions addressed to the agent are requests for memory, not memory
    // — but a mention can also carry a statement worth keeping
    // ("@silo we decided to ship Friday"). Distill the mention-stripped
    // text unless it reads as a question.
    if (!isQuestion(query)) {
      try {
        await this.ingest({ ...msg, content: query });
      } catch (err) {
        // The answer already landed — a capture failure here must not send
        // a confusing second (error) reply; it only hits the log. The event
        // deliberately STAYS marked seen: un-marking (as the passive path
        // does) would make a relay redelivery answer the mention a second
        // time, and a duplicated answer is worse than a lost side-capture —
        // the statement can always be stored explicitly with !remember.
        this.log(`mention capture failed ${msg.event.id.slice(0, 8)}: ${err}`);
      }
    }
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
