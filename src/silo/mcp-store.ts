/**
 * MemoryStore backed by the Silo control plane's existing MCP tool surface —
 * the agent is a standard MCP client (see mcp-client.ts / oauth.ts), so this
 * store uses only tools every other MCP client already uses:
 *
 *   silo_remember        capture (async ingestion + enrichment pipeline)
 *   silo_recall          Pinecone-backed semantic recall (scored memories)
 *   silo_ask             silo-composed, grounded answer (relayed verbatim)
 *   silo_forget          delete by memory id
 *   silo_search_memories deterministic scan (recent/list fallback)
 *   silo_get_context     silo overview (backs !memories)
 *
 * silo_id is the reserved alias "default": every MCP connection gets an
 * auto-provisioned default cloud silo, so a freshly paired Buzz agent has a
 * working memory with zero silo configuration — and the silo (plus the
 * connection) is visible/manageable in the Silo dashboard.
 */

import type { McpClient } from "./mcp-client.js";
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

export class McpSiloStore implements MemoryStore {
  constructor(
    private readonly mcp: McpClient,
    private readonly siloId: string = "default",
    private readonly log: (line: string) => void = () => {}
  ) {}

  /**
   * Capture via silo_remember. Provenance travels inline as a trailer the
   * ingestion pipeline keeps with the memory (full author pubkey + unix
   * timestamp, so recalled memories keep their audit trail). Additive
   * captures queue immediately; a requires_confirmation response (the new
   * content would replace existing memories) is surfaced and NOT
   * auto-confirmed — replacing the silo's memory is the owner's call, not
   * the agent's.
   */
  async remember(memory: Memory): Promise<RememberOutcome> {
    const content =
      `${memory.content}\n\n` +
      `[buzz kind=${memory.kind} salience=${memory.salience} ` +
      `channel=${memory.source.channelId} author=${memory.source.authorPubkey} ` +
      `event=${memory.source.eventId} ts=${memory.source.createdAt}]`;
    const { payload, isError } = await this.mcp.callTool("silo_remember", {
      silo_id: this.siloId,
      content,
    });
    if (isError) throw new Error(`silo_remember failed: ${describe(payload)}`);
    const status = (payload as { status?: string })?.status;
    if (status === "requires_confirmation") {
      this.log(
        `silo_remember requires confirmation (would replace existing memories) — skipped: ${memory.content}`
      );
      return { status: "needs_confirmation" };
    }
    return { status: "queued" };
  }

  async recall(query: MemoryQuery): Promise<ScoredMemory[]> {
    const limit = query.limit ?? 5;
    const { payload, isError } = await this.mcp.callTool("silo_recall", {
      silo_id: this.siloId,
      query: query.text,
      // Channel filtering is client-side and best-effort: fetch the tool's
      // maximum, but if every top semantic match lives in other channels
      // the requested channel can still come back empty. A server-side
      // channel filter on silo_recall is the real fix (see README roadmap).
      max_results: query.channelId ? 25 : Math.min(25, limit),
    });
    if (isError) throw new Error(`silo_recall failed: ${describe(payload)}`);
    const hits = ((payload as { memories?: RecallHit[] })?.memories ?? []).filter(
      (h) => typeof h?.content === "string"
    );
    const out: ScoredMemory[] = [];
    for (const h of hits) {
      const memory = toMemory(h);
      if (query.channelId && memory.source.channelId !== query.channelId) continue;
      out.push({ memory, score: h.score ?? 0 });
      if (out.length >= limit) break;
    }
    return out;
  }

  async ask(question: string): Promise<string> {
    const { payload, isError } = await this.mcp.callTool("silo_ask", {
      silo_id: this.siloId,
      question,
    });
    if (isError) throw new Error(`silo_ask failed: ${describe(payload)}`);
    if (typeof payload === "string") return payload;
    const answer = (payload as { answer?: string; response?: string }) ?? {};
    return answer.answer ?? answer.response ?? JSON.stringify(payload);
  }

  async overview(): Promise<string> {
    const { payload, isError } = await this.mcp.callTool("silo_get_context", {
      silo_id: this.siloId,
    });
    if (isError) throw new Error(`silo_get_context failed: ${describe(payload)}`);
    return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  }

  async forget(memoryId: string): Promise<boolean> {
    const { payload, isError } = await this.mcp.callTool("silo_forget", {
      silo_id: this.siloId,
      memory_ids: [memoryId],
    });
    // A tool error is a failure, not "no such memory" — throw so the agent
    // apologizes instead of claiming the id doesn't exist.
    if (isError) throw new Error(`silo_forget failed: ${describe(payload)}`);
    // Only report success on confirmed deletion — an unexpected payload
    // shape must not read as "forgotten".
    const deleted = (payload as { deleted?: unknown[] })?.deleted;
    return Array.isArray(deleted) && deleted.length > 0;
  }

  /** Deterministic scan; used only when overview() isn't the better fit. */
  async recent(channelId: string | undefined, limit: number): Promise<Memory[]> {
    const { payload, isError } = await this.mcp.callTool("silo_search_memories", {
      silo_id: this.siloId,
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
