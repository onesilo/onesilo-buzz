import type { TranscriptSegment } from "../memory/window.js";

/**
 * Memory model shared by every silo store implementation.
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
  /**
   * The channel the query comes from. Selects the memory bucket (silo) the
   * store routes to; recall is bucket-wide — channels sharing a bucket
   * share memory, which is the product behavior ("decided in #eng,
   * recallable in #support").
   */
  channelId?: string;
  limit?: number;
}

export interface ScoredMemory {
  memory: Memory;
  score: number;
}

/**
 * The contract every silo backend fulfils. Two implementations ship in this
 * prototype: `LocalSiloStore` (standalone demo, JSON on disk) and
 * `SiloBackendStore` (HTTP adapter to the real recap-silo-backend).
 */
/**
 * Honest capture outcome. "stored" means persisted now under `id`;
 * "queued" means accepted for async ingestion (the backend assigns its own
 * ids later); "needs_confirmation" means the write would replace existing
 * memories and was NOT applied — the silo owner must confirm.
 */
export type RememberOutcome =
  | { status: "stored"; id: string }
  | { status: "queued" }
  | { status: "needs_confirmation" };

export interface MemoryStore {
  /** Capture; bucket-routed by memory.source.channelId. */
  remember(memory: Memory): Promise<RememberOutcome>;
  recall(query: MemoryQuery): Promise<ScoredMemory[]>;
  /** Delete by id; channelId selects the bucket to delete from. */
  forget(memoryId: string, channelId?: string): Promise<boolean>;
  /** Most recent memories for a channel, newest first. */
  recent(channelId: string | undefined, limit: number): Promise<Memory[]>;
  /**
   * Silo-composed answer to a question (the backend's `silo_ask`): a
   * finished, grounded reply meant to be relayed verbatim; channelId
   * selects the bucket. Stores that can't compose answers omit this and
   * the agent falls back to recall + local formatting.
   */
  ask?(question: string, channelId?: string): Promise<string>;
  /** A silo-composed overview of the channel's bucket (used by !memories). */
  overview?(channelId?: string): Promise<string>;
  /**
   * Optional startup hook: discover what the connection can reach
   * (silo_get_scope — silos, granted shapes) and validate configuration.
   */
  init?(): Promise<void>;
  /**
   * Capture a whole conversation segment (speaker-attributed transcript)
   * for server-side distillation with turn context. Stores without this
   * fall back to per-turn heuristic extraction of the segment's fresh
   * turns.
   */
  rememberTranscript?(segment: TranscriptSegment): Promise<RememberOutcome>;
}
