/**
 * Memory model shared by every Silo store implementation.
 *
 * A "memory" is a distilled, durable fact extracted from Buzz conversation —
 * not a raw chat log line. Raw provenance (event id, channel, author) is kept
 * so every recalled memory can be traced back to the signed Nostr event it
 * came from.
 */

export type MemoryKind =
  | "decision" // "we decided to ship on Friday"
  | "fact" // "the staging DB is postgres 16"
  | "preference" // "alice prefers squash merges"
  | "action_item" // "bob will rotate the API keys"
  | "explicit"; // user said "!remember ..."

export interface MemorySource {
  /** Nostr event id of the message this memory was distilled from. */
  eventId: string;
  /** Nostr pubkey (hex) of the author. */
  authorPubkey: string;
  /** Buzz channel id (the `h` tag). */
  channelId: string;
  /** Unix seconds. */
  createdAt: number;
}

export interface Memory {
  id: string;
  kind: MemoryKind;
  /** The distilled statement, e.g. "Team decided to ship v2 on Friday". */
  content: string;
  /** Verbatim message text the memory was extracted from. */
  raw: string;
  source: MemorySource;
  /** 0..1, how strongly the extractor believes this is worth keeping. */
  salience: number;
  tags: string[];
}

export interface MemoryQuery {
  text: string;
  /** Restrict recall to one channel; omit for silo-wide recall. */
  channelId?: string;
  limit?: number;
}

export interface ScoredMemory {
  memory: Memory;
  score: number;
}

/**
 * The contract every Silo backend fulfils. Two implementations ship in this
 * prototype: `LocalSiloStore` (standalone demo, JSON on disk) and
 * `SiloBackendStore` (HTTP adapter to the real recap-silo-backend).
 */
export interface MemoryStore {
  remember(memory: Memory): Promise<void>;
  recall(query: MemoryQuery): Promise<ScoredMemory[]>;
  forget(memoryId: string): Promise<boolean>;
  /** Most recent memories, newest first. */
  recent(channelId: string | undefined, limit: number): Promise<Memory[]>;
}
