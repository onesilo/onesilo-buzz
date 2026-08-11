/**
 * DISTILL_MODE=compute — the middle privacy posture (Agent Smith SILO-122):
 * transcripts pass through the control plane's governed compute endpoint to
 * be distilled, but only the distilled statements are stored in the silo.
 * Raw conversation is never persisted server-side (unlike DISTILL_MODE=
 * cloud, where the silo ingests the transcript) and no local model is
 * required (unlike DISTILL_MODE=node).
 *
 * Same decorator shape as node-distill: intercept rememberTranscript,
 * generate, store statements through the inner store, honest outcomes.
 */

import type { TranscriptSegment, Turn } from "../memory/window.js";
import type {
  Memory,
  MemoryQuery,
  MemoryStore,
  RememberOutcome,
  ScoredMemory,
} from "./types.js";
import type { CloudComputeClient } from "./compute.js";
import { ComputeGateError } from "./compute.js";
import { distillPrompt, parseStatements, toMemory } from "./node-distill.js";

export class ComputeDistillingStore implements MemoryStore {
  constructor(
    private readonly inner: MemoryStore,
    private readonly compute: CloudComputeClient,
    private readonly log: (line: string) => void = () => {}
  ) {}

  async init(): Promise<void> {
    if (this.inner.init) await this.inner.init();
    this.log(
      "compute distillation active: transcripts are distilled by the " +
        "control plane's compute endpoint; only distilled statements are stored"
    );
  }

  async rememberTranscript(segment: TranscriptSegment): Promise<RememberOutcome> {
    let text: string;
    let model: string;
    try {
      ({ text, model } = await this.compute.generate(distillPrompt(segment)));
    } catch (err) {
      // Rethrow so the TurnWindowManager restores the segment and retries
      // on a later flush — returning "queued" here would silently DROP it
      // (restore only happens on thrown errors; see agent.flushSegment).
      // For a plan gate that later flush is after the owner acts (upgrade
      // or period reset); the raw transcript never leaves the buffer.
      if (err instanceof ComputeGateError) {
        this.log(`compute gated (${err.status}); segment buffered: ${err.message}`);
      } else {
        this.log(`compute unreachable; segment buffered (${err})`);
      }
      throw err;
    }

    const statements = parseStatements(text);
    if (statements.length === 0) {
      this.log(`compute distillation (${model}): nothing durable in segment #${segment.channelId}`);
      return { status: "queued" };
    }

    const anchor: Turn =
      segment.fresh[segment.fresh.length - 1] ?? segment.turns[segment.turns.length - 1]!;
    let held = 0;
    for (const s of statements) {
      const outcome = await this.inner.remember(toMemory(s, segment, anchor));
      if (outcome.status === "needs_confirmation") {
        held += 1;
        this.log(
          `statement held for owner confirmation [${s.kind}] ${s.content.slice(0, 100)}`
        );
      }
    }
    this.log(
      `compute distillation (${model}): ${statements.length} statement(s) from ` +
        `#${segment.channelId}${held ? ` (${held} held for owner confirmation)` : ""}`
    );
    return held === statements.length ? { status: "needs_confirmation" } : { status: "queued" };
  }

  // --- passthrough ---

  remember(memory: Memory): Promise<RememberOutcome> {
    return this.inner.remember(memory);
  }

  recall(query: MemoryQuery): Promise<ScoredMemory[]> {
    return this.inner.recall(query);
  }

  forget(memoryId: string, channelId?: string): Promise<boolean> {
    return this.inner.forget(memoryId, channelId);
  }

  recent(channelId: string | undefined, limit: number): Promise<Memory[]> {
    return this.inner.recent(channelId, limit);
  }

  ask?: (question: string, channelId?: string) => Promise<string>;
  overview?: (channelId?: string) => Promise<string>;
}

export function wrapWithComputeDistillation(
  inner: MemoryStore,
  compute: CloudComputeClient,
  log: (line: string) => void = () => {}
): MemoryStore {
  const store = new ComputeDistillingStore(inner, compute, log);
  if (inner.ask) {
    store.ask = (question, channelId) => inner.ask!(question, channelId);
  }
  if (inner.overview) {
    store.overview = (channelId) => inner.overview!(channelId);
  }
  return store;
}
