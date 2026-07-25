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
  buildReply,
  type ChannelMessage,
} from "./buzz/events.js";
import type { AgentIdentity } from "./buzz/identity.js";
import type { MemoryStore } from "./silo/types.js";
import { extractMemories, explicitMemory } from "./memory/extractor.js";
import { formatRecall, formatRecent } from "./memory/recall.js";

export interface AgentOptions {
  /** Channels to join; [] = everything the relay lets us see. */
  channelIds?: string[];
  /** pubkey -> display name, for provenance lines in replies. */
  names?: Map<string, string>;
  log?: (line: string) => void;
}

const COMMAND = /^!(remember|recall|memories|forget)\b\s*([\s\S]*)$/;

export class SiloMemoryAgent {
  private readonly names: Map<string, string>;
  private readonly log: (line: string) => void;

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
      void this.handleEvent(event).catch((err) =>
        this.log(`error handling event ${event.id.slice(0, 8)}: ${err}`)
      );
    });
    this.log(`silo-memory agent online as ${this.identity.pubkey.slice(0, 12)}… (@${this.identity.handle})`);
  }

  async handleEvent(event: NostrEvent): Promise<void> {
    if (event.pubkey === this.identity.pubkey) return; // never eat our own replies
    const msg = parseChannelMessage(event);
    if (!msg) return;

    const command = msg.content.trim().match(COMMAND);
    if (command) {
      await this.handleCommand(msg, command[1]!, (command[2] ?? "").trim());
      return;
    }

    if (isAddressedTo(msg, this.identity.pubkey, this.identity.handle)) {
      await this.handleMention(msg);
      return;
    }

    await this.ingest(msg);
  }

  private async ingest(msg: ChannelMessage): Promise<void> {
    const memories = extractMemories(msg);
    for (const memory of memories) {
      await this.store.remember(memory);
      this.log(`remembered [${memory.kind}] ${memory.content}`);
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
        const memory = explicitMemory(msg, arg);
        await this.store.remember(memory);
        return this.reply(msg, `Got it — I'll remember that. (id ${memory.id})`);
      }
      case "recall": {
        if (!arg) return this.reply(msg, "Usage: !recall <query>");
        const results = await this.store.recall({
          text: arg,
          channelId: undefined, // silo-wide recall: memory crosses channels
          limit: 5,
        });
        return this.reply(msg, formatRecall(arg, results, this.names));
      }
      case "memories": {
        const recent = await this.store.recent(msg.channelId, 10);
        return this.reply(msg, formatRecent(recent));
      }
      case "forget": {
        if (!arg) return this.reply(msg, "Usage: !forget <memory id>");
        const removed = await this.store.forget(arg);
        return this.reply(
          msg,
          removed ? `Forgotten (id ${arg}).` : `No memory with id ${arg}.`
        );
      }
    }
  }

  private async handleMention(msg: ChannelMessage): Promise<void> {
    // Strip the mention and treat the rest as a recall query.
    const query = msg.content
      .replace(new RegExp(`@${this.identity.handle}`, "ig"), "")
      .trim();
    if (!query) {
      return this.reply(
        msg,
        "Hi! I give this workspace memory via Silo. Try `!recall <query>`, `!remember <text>`, or `!memories`."
      );
    }
    const results = await this.store.recall({ text: query, limit: 5 });
    await this.reply(msg, formatRecall(query, results, this.names));
    // A question addressed to us is often worth remembering too.
    await this.ingest(msg);
  }

  private async reply(to: ChannelMessage, content: string): Promise<void> {
    await this.relay.publish(buildReply(to, content));
    this.log(`replied in ${to.channelId}: ${content.split("\n")[0]}`);
  }
}
