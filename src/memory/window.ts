/**
 * Conversation-aware capture: a rolling turn buffer per channel.
 *
 * The agent's job here is not "is this line a memory?" but "where does this
 * conversational episode begin and end?". Whole segments — speaker-
 * attributed transcripts — flow to the silo, whose server-side pipeline
 * distills them with context: "yeah let's do that" is only meaningful next
 * to the turns before it.
 *
 * Flush triggers, whichever fires first:
 *  - salience: a turn that looks decision/fact-like flushes its window
 *    immediately, so important memories become recallable fast
 *  - size:     the buffer reached maxTurns
 *  - idle:     the channel went quiet for idleFlushMs (episode over)
 *  - shutdown: flushAll() on agent stop
 *
 * Overlap: the last `overlapTurns` flushed turns are retained as context for
 * the next segment (so an episode spanning two flushes keeps its thread).
 * Overlap turns never re-flush on their own — only fresh turns count toward
 * triggers — and they are marked so stores don't double-capture them.
 */

export interface Turn {
  authorPubkey: string;
  content: string;
  /** Unix seconds (Nostr created_at). */
  createdAt: number;
  eventId: string;
}

export type FlushReason = "salience" | "size" | "idle" | "shutdown";

export interface TranscriptSegment {
  channelId: string;
  reason: FlushReason;
  /** Full window: overlap context first, then fresh turns. */
  turns: Turn[];
  /** The not-yet-captured tail of `turns`. */
  fresh: Turn[];
}

export interface WindowOptions {
  /** Flush when this many fresh turns have accumulated. */
  maxTurns: number;
  /** Flushed turns carried into the next segment as context. */
  overlapTurns: number;
  /** Quiet time that closes an episode. */
  idleFlushMs: number;
}

export const DEFAULT_WINDOW_OPTIONS: WindowOptions = {
  maxTurns: 12,
  overlapTurns: 2,
  idleFlushMs: 10 * 60 * 1000,
};

interface ChannelBuffer {
  turns: Turn[];
  freshCount: number;
  lastActivityMs: number;
}

export class TurnWindowManager {
  private readonly buffers = new Map<string, ChannelBuffer>();
  private readonly opts: WindowOptions;

  constructor(
    opts: Partial<WindowOptions>,
    /** Receives each segment; must not throw (handle/restore internally). */
    private readonly onFlush: (segment: TranscriptSegment) => Promise<void>,
    /** Clock (injectable for tests). */
    private readonly now: () => number = Date.now
  ) {
    this.opts = { ...DEFAULT_WINDOW_OPTIONS, ...opts };
  }

  /**
   * Append a turn. A salient turn (or a full buffer) flushes immediately;
   * the returned promise settles when any triggered flush completes.
   */
  push(channelId: string, turn: Turn, salient: boolean): Promise<void> {
    const buf = this.buffer(channelId);
    buf.turns.push(turn);
    buf.freshCount += 1;
    // Idle is measured in observation (wall-clock) time, not the event's
    // created_at: relay replays deliver backdated events that must not look
    // instantly idle, and future-skewed clocks must not hold episodes open.
    buf.lastActivityMs = this.now();
    if (salient) return this.flush(channelId, "salience");
    if (buf.freshCount >= this.opts.maxTurns) return this.flush(channelId, "size");
    return Promise.resolve();
  }

  /** Flush every channel idle past the threshold. */
  async flushIdle(nowMs: number): Promise<void> {
    for (const [channelId, buf] of this.buffers) {
      if (buf.freshCount > 0 && nowMs - buf.lastActivityMs >= this.opts.idleFlushMs) {
        await this.flush(channelId, "idle");
      }
    }
  }

  /** Flush everything pending (shutdown path). */
  async flushAll(): Promise<void> {
    for (const channelId of this.buffers.keys()) {
      await this.flush(channelId, "shutdown");
    }
  }

  /**
   * Put a failed segment's fresh turns back so the next trigger retries
   * them (capture failures must not lose the episode). The buffer at this
   * point holds the overlap tail flush() retained — which duplicates the
   * failed segment's own tail — plus any turns that arrived while the
   * flush was in flight; rebuild it coherently instead of prepending:
   * original context, then the failed fresh turns, then the new arrivals.
   */
  restore(segment: TranscriptSegment): void {
    if (segment.fresh.length === 0) return;
    const buf = this.buffer(segment.channelId);
    const arrivedSince = buf.turns.slice(buf.turns.length - buf.freshCount);
    const context = segment.turns.slice(0, segment.turns.length - segment.fresh.length);
    buf.turns = [...context, ...segment.fresh, ...arrivedSince];
    buf.freshCount += segment.fresh.length;
  }

  /** Fresh turns currently pending per channel (for tests/introspection). */
  pending(channelId: string): number {
    return this.buffers.get(channelId)?.freshCount ?? 0;
  }

  private buffer(channelId: string): ChannelBuffer {
    let buf = this.buffers.get(channelId);
    if (!buf) {
      buf = { turns: [], freshCount: 0, lastActivityMs: 0 };
      this.buffers.set(channelId, buf);
    }
    return buf;
  }

  private async flush(channelId: string, reason: FlushReason): Promise<void> {
    const buf = this.buffers.get(channelId);
    if (!buf || buf.freshCount === 0) return; // overlap-only buffers stay put
    const turns = [...buf.turns];
    const fresh = turns.slice(turns.length - buf.freshCount);
    // Retain the tail as context for the next segment before handing off.
    buf.turns = turns.slice(Math.max(0, turns.length - this.opts.overlapTurns));
    buf.freshCount = 0;
    await this.onFlush({ channelId, reason, turns, fresh });
  }
}
