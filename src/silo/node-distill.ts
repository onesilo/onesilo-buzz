/**
 * Private distillation: a MemoryStore decorator that distills conversation
 * segments on a local onesilo-node before anything reaches the silo.
 *
 * With DISTILL_MODE=node the agent's transcript segments are NOT sent raw.
 * Each segment is distilled by the node's own model (onesilo-node's
 * POST /v1/compute/generate) into standalone memory statements, and only
 * those statements are written to the inner store. Raw conversation never
 * leaves machines the operator owns.
 *
 * Failure posture: if the node is unreachable or its compute is down, the
 * flush THROWS — the agent's turn window restores the segment and retries
 * on the next trigger. There is deliberately no fallback to shipping the
 * raw transcript: privacy degradation is never an automatic decision.
 */

import { createHash } from "node:crypto";
import { since } from "../log.js";
import type { TranscriptSegment, Turn } from "../memory/window.js";
import type {
  Memory,
  MemoryKind,
  MemoryQuery,
  MemoryStore,
  RememberOutcome,
  ScoredMemory,
} from "./types.js";
import type { SiloNodeClient } from "../node/client.js";

/** Upper bound on statements taken from one segment (prompt-injection cap). */
const MAX_STATEMENTS_PER_SEGMENT = 10;

const STATEMENT_KINDS = new Set(["decision", "fact", "preference", "action_item"]);

export class NodeDistillingStore implements MemoryStore {
  constructor(
    private readonly inner: MemoryStore,
    private readonly node: SiloNodeClient,
    private readonly log: (line: string) => void = () => {}
  ) {}

  /** Inner discovery first, then a loud (non-fatal) node health report. */
  async init(): Promise<void> {
    if (this.inner.init) await this.inner.init();
    if (!this.node.hasToken) {
      this.log(
        `warning: no onesilo-node admin token found — set NODE_ADMIN_TOKEN or run ` +
          `\`onesilo-node setup\` on this machine. Captures will buffer until fixed.`
      );
    }
    if (await this.node.health()) {
      this.log(`node distillation active: transcripts are distilled at ${this.node.url} ` +
        `and only distilled statements reach the silo`);
    } else {
      this.log(
        `warning: onesilo-node unreachable at ${this.node.url} — captures will buffer ` +
          `and retry until the node is up (raw transcripts are never sent)`
      );
    }
  }

  /**
   * Distill the segment locally, then remember each statement through the
   * inner store. Never calls inner.rememberTranscript — that path ships the
   * raw transcript, which is exactly what this mode exists to prevent.
   */
  async rememberTranscript(segment: TranscriptSegment): Promise<RememberOutcome> {
    // The single slowest thing the agent does: a local model, often cold,
    // with a two-minute ceiling. Bracket it so a long wait is visibly the
    // model thinking rather than the agent having stopped.
    const started = Date.now();
    this.log(
      `distilling ${segment.fresh.length} turn(s) from #${segment.channelId} on the local model…`
    );
    const { text, model } = await this.node.generate(distillPrompt(segment));
    this.log(`local model (${model}) replied in ${since(started)}`);
    const statements = parseStatements(text);
    if (statements.length === 0) {
      this.log(`node distillation (${model}): nothing durable in segment #${segment.channelId}`);
      return { status: "queued" };
    }

    // Provenance anchors to the turn that closed the episode (usually the
    // decision itself). A distilled statement can span speakers; the
    // anchor is the audit trail back into Buzz, not an authorship claim.
    //
    // A mid-segment inner.remember failure rethrows and the whole segment
    // retries (window restore). That re-sends statements stored before the
    // failure — safe because statement ids are deterministic (id-keyed
    // stores overwrite in place) and the silo's ingestion pipeline dedupes
    // identical re-captures, mirroring the redelivery posture in agent.ts.
    const anchor = segment.fresh[segment.fresh.length - 1] ?? segment.turns[segment.turns.length - 1]!;
    let held = 0;
    for (const s of statements) {
      const outcome = await this.inner.remember(toMemory(s, segment, anchor));
      if (outcome.status === "needs_confirmation") {
        held += 1;
        // A hold is not a failure and retrying cannot resolve it (the same
        // confirmation requirement would fire again) — the owner confirms
        // from the dashboard. Name the statement so the operator can act.
        this.log(
          `statement held for owner confirmation [${s.kind}] ${s.content.slice(0, 100)}`
        );
      }
    }
    this.log(
      `node distillation (${model}): ${statements.length} statement(s) from ` +
        `#${segment.channelId}${held ? ` (${held} held for owner confirmation)` : ""}`
    );
    return held === statements.length ? { status: "needs_confirmation" } : { status: "queued" };
  }

  // --- passthrough: everything below is the inner store's behavior ---

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

// Optional methods must only exist when the inner store has them, so the
// agent's feature detection (`store.ask ? ... : fallback`) stays accurate.
// Wire them per-instance instead of on the prototype.
export function wrapWithNodeDistillation(
  inner: MemoryStore,
  node: SiloNodeClient,
  log: (line: string) => void = () => {}
): MemoryStore {
  const store = new NodeDistillingStore(inner, node, log);
  if (inner.ask) {
    store.ask = (question, channelId) => inner.ask!(question, channelId);
  }
  if (inner.overview) {
    store.overview = (channelId) => inner.overview!(channelId);
  }
  return store;
}

/**
 * The distillation prompt: transcript in, one memory statement per line
 * out. Overlap turns (already captured by the previous segment) are
 * presented as a separate context block the model must not extract from —
 * they exist only to resolve references in the new turns.
 */
export function distillPrompt(segment: TranscriptSegment): string {
  const fmt = (t: Turn) => `[${t.authorPubkey.slice(0, 8)}] ${t.content}`;
  const contextCount = segment.turns.length - segment.fresh.length;
  const context = segment.turns.slice(0, contextCount).map(fmt).join("\n");
  const fresh = segment.fresh.map(fmt).join("\n");
  const transcript = context
    ? `Earlier context, ALREADY captured — do NOT extract memories from these ` +
      `lines, they only resolve references:\n${context}\n\n` +
      `New conversation (extract from these lines only):\n${fresh}`
    : `Transcript:\n${fresh}`;
  return (
    `You are a memory distiller for a team workspace. Read the conversation ` +
    `transcript and extract the durable memories worth keeping long-term: ` +
    `decisions, facts, action items, and preferences.\n\n` +
    `Rules:\n` +
    `- Output one memory per line as "<kind>: <statement>" where <kind> is ` +
    `decision, fact, action_item, or preference.\n` +
    `- Each statement must stand alone: resolve pronouns like "it"/"that" ` +
    `from the surrounding turns, and name who when it matters.\n` +
    `- Only keep what a teammate would want recalled weeks later. Skip ` +
    `chit-chat, questions, and process noise.\n` +
    `- No commentary, no numbering, nothing but the lines.\n` +
    `- If nothing is worth remembering, output exactly: NONE\n\n` +
    `Channel: #${segment.channelId}\n${transcript}`
  );
}

interface Statement {
  kind: MemoryKind;
  content: string;
}

/**
 * Parse model output into statements. Tolerates bullets/numbering; lines
 * without a recognized kind prefix are kept as facts. "NONE" (alone) means
 * nothing durable.
 */
export function parseStatements(text: string): Statement[] {
  const statements: Statement[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim().replace(/^[-*•]+\s*|^\d+[.)]\s*/, "");
    if (!line || line.toUpperCase() === "NONE") continue;
    const tagged = line.match(/^(decision|fact|preference|action_item)\s*:\s*(.+)$/i);
    const kind = tagged ? (tagged[1]!.toLowerCase() as MemoryKind) : "fact";
    const content = (tagged ? tagged[2]! : line).trim();
    if (!content || !STATEMENT_KINDS.has(kind)) continue;
    statements.push({ kind, content });
    if (statements.length >= MAX_STATEMENTS_PER_SEGMENT) break;
  }
  return statements;
}

function toMemory(s: Statement, segment: TranscriptSegment, anchor: Turn): Memory {
  return {
    // Deterministic CONTENT-derived id (bucket-scoped). Three things depend
    // on it: id-keyed stores must not clobber sibling statements from one
    // segment; a segment retried after a partial failure must overwrite its
    // already-stored statements instead of duplicating them; and a statement
    // the model re-extracts from overlap context in a later segment must
    // land on the same id as the original, not create a duplicate.
    id: createHash("sha256")
      .update(`${segment.channelId}:${s.kind}:${s.content}`)
      .digest("hex")
      .slice(0, 16),
    kind: s.kind,
    content: s.content,
    raw: s.content, // the distilled statement IS the payload; raw stays local
    source: {
      eventId: anchor.eventId,
      authorPubkey: anchor.authorPubkey,
      channelId: segment.channelId,
      createdAt: anchor.createdAt,
    },
    salience: 0.9, // a model chose to keep it; well above heuristic captures
    tags: [],
  };
}
