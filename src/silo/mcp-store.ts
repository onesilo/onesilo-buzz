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
   * ingestion pipeline keeps with the memory. Additive captures queue
   * immediately; a requires_confirmation response (the new content would
   * replace existing memories) is surfaced to the log and NOT auto-confirmed
   * — replacing the silo's memory is the owner's call, not the agent's.
   */
  async remember(memory: Memory): Promise<void> {
    const content =
      `${memory.content}\n\n` +
      `[buzz kind=${memory.kind} salience=${memory.salience} ` +
      `channel=${memory.source.channelId} author=${memory.source.authorPubkey.slice(0, 12)} ` +
      `event=${memory.source.eventId}]`;
    const { payload } = await this.mcp.callTool("silo_remember", {
      silo_id: this.siloId,
      content,
    });
    const status = (payload as { status?: string })?.status;
    if (status === "requires_confirmation") {
      this.log(
        `silo_remember requires confirmation (would replace existing memories) — skipped: ${memory.content}`
      );
    }
  }

  async recall(query: MemoryQuery): Promise<ScoredMemory[]> {
    const { payload } = await this.mcp.callTool("silo_recall", {
      silo_id: this.siloId,
      query: query.text,
      max_results: Math.min(25, query.limit ?? 5),
    });
    const hits = ((payload as { memories?: RecallHit[] })?.memories ?? []).filter(
      (h) => typeof h?.content === "string"
    );
    return hits.map((h) => ({ memory: toMemory(h), score: h.score ?? 0 }));
  }

  async ask(question: string): Promise<string> {
    const { payload } = await this.mcp.callTool("silo_ask", {
      silo_id: this.siloId,
      question,
    });
    if (typeof payload === "string") return payload;
    const answer = (payload as { answer?: string; response?: string }) ?? {};
    return answer.answer ?? answer.response ?? JSON.stringify(payload);
  }

  async overview(): Promise<string> {
    const { payload } = await this.mcp.callTool("silo_get_context", {
      silo_id: this.siloId,
    });
    return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  }

  async forget(memoryId: string): Promise<boolean> {
    const { payload, isError } = await this.mcp.callTool("silo_forget", {
      silo_id: this.siloId,
      memory_ids: [memoryId],
    });
    if (isError) return false;
    const deleted = (payload as { deleted?: unknown[] })?.deleted;
    return Array.isArray(deleted) ? deleted.length > 0 : true;
  }

  /** Deterministic scan; used only when overview() isn't the better fit. */
  async recent(channelId: string | undefined, limit: number): Promise<Memory[]> {
    const { payload } = await this.mcp.callTool("silo_search_memories", {
      silo_id: this.siloId,
      query: channelId ? `channel=${channelId}` : "[buzz",
    });
    const hits = ((payload as { memories?: RecallHit[] })?.memories ?? []).filter(
      (h) => typeof h?.content === "string"
    );
    return hits.slice(0, limit).map(toMemory);
  }
}

/**
 * Map a backend memory to the local model. Buzz provenance is recovered from
 * the inline trailer when present (round-trip of remember()'s format).
 */
function toMemory(hit: RecallHit): Memory {
  const content = hit.content ?? "";
  const trailer = content.match(
    /\[buzz kind=(\S+) salience=([\d.]+) channel=(\S+) author=(\S+) event=(\S+)\]/
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
      createdAt: 0,
    },
    salience: trailer ? Number(trailer[2]) : 0.5,
    tags: [],
  };
}
