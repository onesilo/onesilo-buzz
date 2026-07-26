/**
 * MemoryStore backed by the One Silo control plane's existing MCP tool surface —
 * the agent is a standard MCP client (see mcp-client.ts / oauth.ts), so this
 * store uses only tools every other MCP client already uses:
 *
 *   get_scope       discovery: silos + granted shapes this connection
 *                        can reach (run once at startup via init())
 *   silo_remember        capture (async ingestion + enrichment pipeline)
 *   silo_recall          Pinecone-backed semantic recall (scored memories)
 *   silo_ask             silo-composed, grounded answer (relayed verbatim)
 *   silo_forget          delete by memory id
 *   silo_search_memories deterministic scan (recent/list fallback)
 *   silo_get_context     silo overview (backs !memories)
 *
 * Memory buckets: every operation routes through a SiloBucketRouter mapping
 * the interaction's Buzz channel to a silo id. The default bucket is the
 * reserved alias "default" (the connection's auto-provisioned silo), so a
 * freshly paired agent works with zero configuration; channels can be mapped
 * to other silos the connection has been granted (SILO_CHANNEL_MAP), and
 * multiple agents pointed at the same silo id share one memory.
 */

import type { McpClient } from "./mcp-client.js";
import type { TranscriptSegment } from "../memory/window.js";
import { SiloBucketRouter } from "./buckets.js";
import type {
  Memory,
  MemoryKind,
  MemoryQuery,
  MemoryStore,
  RememberOutcome,
  ScoredMemory,
} from "./types.js";

const KINDS: MemoryKind[] = ["decision", "fact", "preference", "action_item", "explicit"];

interface RecallHit {
  id?: string;
  type?: string;
  content?: string;
  score?: number;
}

interface ScopeSilo {
  id?: string;
  silo_id?: string;
  /** get_scope names this field `name`; older shapes used `title`. */
  name?: string;
  title?: string;
  is_default?: boolean;
}

export class McpSiloStore implements MemoryStore {
  constructor(
    private readonly mcp: McpClient,
    private readonly router: SiloBucketRouter = new SiloBucketRouter(),
    private readonly log: (line: string) => void = () => {}
  ) {}

  /**
   * Discover what this connection can reach (get_scope) and sanity-
   * check the bucket configuration against it. Non-fatal: an unknown bucket
   * is logged loudly but the agent still starts (grants may be added from
   * the dashboard afterwards).
   */
  async init(): Promise<void> {
    const { payload, isError } = await this.mcp.callTool("get_scope", {});
    if (isError) {
      this.log(`get_scope failed (continuing): ${describe(payload)}`);
      return;
    }
    const scope = (payload ?? {}) as {
      silos?: ScopeSilo[];
      default_silo_id?: string;
      available_shapes?: Array<{ shape?: string }>;
    };
    const silos = scope.silos ?? [];
    const siloIds = new Set(
      silos.map((s) => String(s.id ?? s.silo_id ?? "")).filter(Boolean)
    );
    const shapes = (scope.available_shapes ?? [])
      .map((s) => s.shape)
      .filter(Boolean);
    this.log(
      `scope: ${silos.length} silo(s) [${silos
        .map((s) => `${s.name ?? s.title ?? s.id ?? s.silo_id}${s.is_default ? "*" : ""}`)
        .join(", ")}], shapes: ${shapes.join(", ") || "(none reported)"}`
    );
    for (const bucket of this.router.buckets) {
      if (bucket === "default") continue; // reserved alias, always valid
      if (!siloIds.has(bucket)) {
        this.log(
          `warning: configured bucket "${bucket}" is not in this connection's ` +
            `scope — grant the silo to this connection in the One Silo dashboard ` +
            `(Connections → Buzz Agent → Silos) or fix SILO_CHANNEL_MAP/SILO_ID.`
        );
      }
    }
  }

  /**
   * Capture via silo_remember into the channel's bucket. Provenance travels
   * inline as a trailer the ingestion pipeline keeps with the memory (full
   * author pubkey + unix timestamp, so recalled memories keep their audit
   * trail). Additive captures queue immediately; a requires_confirmation
   * response (the new content would replace existing memories) is surfaced
   * and NOT auto-confirmed — replacing the silo's memory is the owner's
   * call, not the agent's.
   */
  async remember(memory: Memory): Promise<RememberOutcome> {
    const content =
      `${memory.content}\n\n` +
      `[buzz kind=${memory.kind} salience=${memory.salience} ` +
      `channel=${memory.source.channelId} author=${memory.source.authorPubkey} ` +
      `event=${memory.source.eventId} ts=${memory.source.createdAt}]`;
    const { payload, isError } = await this.mcp.callTool("silo_remember", {
      silo_id: this.router.resolve(memory.source.channelId),
      content,
    });
    if (isError) throw new Error(`silo_remember failed: ${describe(payload)}`);
    return interpretRememberPayload(payload, (line) => this.log(line), memory.content);
  }

  /**
   * Capture a conversation segment as a speaker-attributed transcript.
   * silo_remember is designed for raw conversation input — the server-side
   * pipeline distills it WITH turn context ("yeah let's do that" next to
   * its antecedent) and runs enrichment (entities, topics, relationships).
   */
  async rememberTranscript(segment: TranscriptSegment): Promise<RememberOutcome> {
    const first = segment.turns[0]!;
    const last = segment.turns[segment.turns.length - 1]!;
    // Overlap turns were already captured by the previous segment; mark
    // them so the server-side distiller treats them as reference context,
    // not content to re-capture.
    const freshIds = new Set(segment.fresh.map((t) => t.eventId));
    const lines = segment.turns
      .map(
        (t) =>
          `${freshIds.has(t.eventId) ? "" : "(context, already captured) "}` +
          `[${t.authorPubkey.slice(0, 8)}] ${t.content}`
      )
      .join("\n");
    const content =
      `Buzz conversation transcript (channel ${segment.channelId}):\n${lines}\n\n` +
      `[buzz transcript channel=${segment.channelId} ` +
      `events=${first.eventId.slice(0, 12)}..${last.eventId.slice(0, 12)} ` +
      `from=${first.createdAt} to=${last.createdAt} turns=${segment.turns.length} ` +
      `context=${segment.turns.length - segment.fresh.length}]`;
    const { payload, isError } = await this.mcp.callTool("silo_remember", {
      silo_id: this.router.resolve(segment.channelId),
      content,
    });
    if (isError) throw new Error(`silo_remember failed: ${describe(payload)}`);
    return interpretRememberPayload(payload, (line) => this.log(line), content);
  }

  /**
   * Semantic recall from the channel's bucket. Recall is bucket-wide by
   * design: channels sharing a bucket share memory.
   */
  async recall(query: MemoryQuery): Promise<ScoredMemory[]> {
    const limit = query.limit ?? 5;
    const { payload, isError } = await this.mcp.callTool("silo_recall", {
      silo_id: this.router.resolve(query.channelId),
      query: query.text,
      max_results: Math.min(25, limit),
    });
    if (isError) throw new Error(`silo_recall failed: ${describe(payload)}`);
    // Memory-scope recall returns a mini-silo envelope with the matched
    // memories under `context.memories`; tolerate a flat `memories` list
    // too (the silo_search_memories shape).
    const body = (payload ?? {}) as {
      context?: { memories?: RecallHit[] };
      memories?: RecallHit[];
    };
    const hits = (body.context?.memories ?? body.memories ?? []).filter(
      (h) => typeof h?.content === "string"
    );
    return hits.slice(0, limit).map((h) => ({ memory: toMemory(h), score: h.score ?? 0 }));
  }

  async ask(question: string, channelId?: string): Promise<string> {
    const { payload, isError } = await this.mcp.callTool("silo_ask", {
      silo_id: this.router.resolve(channelId),
      question,
    });
    if (isError) throw new Error(`silo_ask failed: ${describe(payload)}`);
    if (typeof payload === "string") return payload;
    const answer = (payload as { answer?: string; response?: string }) ?? {};
    return answer.answer ?? answer.response ?? JSON.stringify(payload);
  }

  async overview(channelId?: string): Promise<string> {
    const { payload, isError } = await this.mcp.callTool("silo_get_context", {
      silo_id: this.router.resolve(channelId),
    });
    if (isError) throw new Error(`silo_get_context failed: ${describe(payload)}`);
    return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  }

  /**
   * Delete by id. Tries the channel's bucket first, then every other
   * configured bucket — a memory id shown by cross-bucket recall must stay
   * deletable even when !forget is issued from a channel mapped elsewhere.
   */
  async forget(memoryId: string, channelId?: string): Promise<boolean> {
    const primary = this.router.resolve(channelId);
    const buckets = [primary, ...this.router.buckets.filter((b) => b !== primary)];
    let lastError: Error | undefined;
    for (const siloId of buckets) {
      try {
        if (await this.forgetIn(siloId, memoryId)) return true;
      } catch (err) {
        // One bucket erroring must not stop the sweep — the id may live in
        // a later bucket.
        lastError = err instanceof Error ? err : new Error(String(err));
        this.log(`silo_forget error in bucket ${siloId} (continuing): ${lastError.message}`);
      }
    }
    // Nothing deleted: if a bucket errored we can't honestly say "no such
    // memory" — surface the failure so the agent apologizes instead.
    if (lastError) throw lastError;
    return false;
  }

  private async forgetIn(siloId: string, memoryId: string): Promise<boolean> {
    const { payload, isError } = await this.mcp.callTool("silo_forget", {
      silo_id: siloId,
      memory_ids: [memoryId],
    });
    // A tool error is a failure, not "no such memory" — throw so the agent
    // apologizes instead of claiming the id doesn't exist.
    if (isError) throw new Error(`silo_forget failed: ${describe(payload)}`);
    // Only report success on confirmed deletion — an unexpected payload
    // shape must not read as "forgotten". The real response is
    // {status: "forgotten", deleted_memory_ids: [...]}; tolerate the older
    // {deleted: [...]} shape too.
    const body = (payload ?? {}) as {
      status?: string;
      deleted_memory_ids?: unknown[];
      deleted?: unknown[];
    };
    const deleted = body.deleted_memory_ids ?? body.deleted;
    return Array.isArray(deleted) && deleted.length > 0;
  }

  /** Deterministic scan; used only when overview() isn't the better fit. */
  async recent(channelId: string | undefined, limit: number): Promise<Memory[]> {
    const { payload, isError } = await this.mcp.callTool("silo_search_memories", {
      silo_id: this.router.resolve(channelId),
      query: channelId ? `channel=${channelId}` : "[buzz",
    });
    if (isError) throw new Error(`silo_search_memories failed: ${describe(payload)}`);
    const hits = ((payload as { memories?: RecallHit[] })?.memories ?? []).filter(
      (h) => typeof h?.content === "string"
    );
    return hits
      .map(toMemory)
      // The substring query pre-filters, but verify against the parsed
      // trailer so cross-channel matches never leak into !memories.
      .filter((m) => !channelId || m.source.channelId === channelId)
      .sort((a, b) => b.source.createdAt - a.source.createdAt)
      .slice(0, limit);
  }
}

function describe(payload: unknown): string {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

/** Shared silo_remember response handling for single memories + transcripts. */
function interpretRememberPayload(
  payload: unknown,
  log: (line: string) => void,
  captured: string
): RememberOutcome {
  const body = (payload ?? {}) as { status?: string; id?: string; memory_id?: string };
  if (body.status === "requires_confirmation") {
    log(
      `silo_remember requires confirmation (would replace existing memories) — skipped: ${captured.slice(0, 120)}`
    );
    return { status: "needs_confirmation" };
  }
  // Some capture paths apply synchronously and return the stored id —
  // pass it through so !remember can confirm with a real, forgettable id.
  const storedId = body.id ?? body.memory_id;
  if (body.status === "stored" && typeof storedId === "string" && storedId) {
    return { status: "stored", id: storedId };
  }
  return { status: "queued" };
}

/**
 * Map a backend memory to the local model. Buzz provenance is recovered from
 * the inline trailer when present (round-trip of remember()'s format).
 * Anchored to the END of the content: remember() always appends the real
 * trailer last, so a forged `[buzz …]` earlier in user-authored text can't
 * spoof channel/author/event provenance.
 */
function toMemory(hit: RecallHit): Memory {
  const content = hit.content ?? "";
  const trailer = content.match(
    /\[buzz kind=(\S+) salience=([\d.]+) channel=(\S+) author=(\S+) event=(\S+) ts=(\d+)\]\s*$/
  );
  const body = trailer ? content.slice(0, trailer.index).trim() : content;
  const kind = trailer?.[1] ?? hit.type ?? "fact";
  return {
    id: hit.id ?? "",
    kind: KINDS.includes(kind as MemoryKind) ? (kind as MemoryKind) : "fact",
    content: body,
    raw: body,
    source: {
      eventId: trailer?.[5] ?? "",
      authorPubkey: trailer?.[4] ?? "",
      channelId: trailer?.[3] ?? "",
      createdAt: trailer ? Number(trailer[6]) : 0,
    },
    salience: trailer ? Number(trailer[2]) : 0.5,
    tags: [],
  };
}
