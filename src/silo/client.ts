/**
 * Adapter to the real Silo backend (recap-silo-backend). These APIs exist
 * today — this file targets them directly:
 *
 *  Writes (REST, silo_content router):
 *    POST   /api/v1/share/silos/{silo_id}/memories
 *    GET    /api/v1/share/silos/{silo_id}/memories        -> { memories: [...] }
 *    DELETE /api/v1/share/silos/{silo_id}/memories/{id}   -> { deleted: id }
 *  Every mutation triggers a Pinecone re-index of the silo namespace
 *  server-side, so stored memories become semantically recallable.
 *
 *  Recall (MCP gateway, Streamable HTTP at /mcp):
 *    tools/call silo_recall { silo_id, query, max_results }
 *  Returns the hydrated "mini-silo": matched memories with scores (plus
 *  connected entities/topics/refs, which this prototype doesn't use yet).
 *
 * Backend memory shape: { id, type, content, created_at, updated_at,
 * metadata } where `type` is a lowercase slug — our kinds (decision, fact,
 * preference, action_item, explicit) are valid types as-is. Buzz provenance
 * (channel, author pubkey, source event id, salience, tags, raw text)
 * round-trips through `metadata`.
 */

import type {
  Memory,
  MemoryKind,
  MemoryQuery,
  MemoryStore,
  ScoredMemory,
} from "./types.js";

export interface SiloBackendConfig {
  baseUrl: string; // e.g. https://api.onesilo.com
  siloId: string; // the cloud silo acting as this workspace's memory
  apiToken: string; // Clerk bearer token (or MCP connection token) for the agent
}

const KINDS: MemoryKind[] = ["decision", "fact", "preference", "action_item", "explicit"];

interface BackendMemory {
  id: string;
  type: string;
  content: string;
  created_at?: string;
  metadata?: Record<string, unknown>;
}

export class SiloBackendStore implements MemoryStore {
  constructor(private readonly config: SiloBackendConfig) {}

  private get restBase(): string {
    return `${this.config.baseUrl}/api/v1/share/silos/${this.config.siloId}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  private async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.restBase}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Silo backend ${method} ${path} -> ${res.status}`);
    }
    return (await res.json()) as T;
  }

  async remember(memory: Memory): Promise<void> {
    await this.rest("POST", "/memories", {
      id: memory.id,
      type: memory.kind,
      content: memory.content,
      created_at: new Date(memory.source.createdAt * 1000).toISOString(),
      metadata: {
        raw: memory.raw,
        salience: memory.salience,
        tags: memory.tags,
        buzz_channel_id: memory.source.channelId,
        buzz_event_id: memory.source.eventId,
        buzz_author_pubkey: memory.source.authorPubkey,
      },
    });
  }

  /**
   * Semantic recall via the MCP gateway's `silo_recall` tool, then hydrate
   * Buzz provenance by joining against the REST memory list (the mini-silo
   * response carries content + score but not our metadata).
   */
  async recall(query: MemoryQuery): Promise<ScoredMemory[]> {
    const limit = query.limit ?? 5;
    const res = await fetch(`${this.config.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...this.headers(), Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "silo_recall",
          arguments: {
            silo_id: this.config.siloId,
            query: query.text,
            // over-fetch when channel-filtering, since we filter client-side
            max_results: Math.min(25, query.channelId ? limit * 3 : limit),
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`silo_recall -> ${res.status}`);
    const matched = extractRecallMemories(await parseMcpBody(res));

    const { memories } = await this.rest<{ memories: BackendMemory[] }>("GET", "/memories");
    const byId = new Map(memories.map((m) => [m.id, m]));

    const out: ScoredMemory[] = [];
    for (const hit of matched) {
      const full = byId.get(hit.id);
      const memory = toMemory(full ?? hit);
      if (query.channelId && memory.source.channelId !== query.channelId) continue;
      out.push({ memory, score: hit.score ?? 0 });
      if (out.length >= limit) break;
    }
    return out;
  }

  async forget(memoryId: string): Promise<boolean> {
    try {
      await this.rest("DELETE", `/memories/${memoryId}`);
      return true;
    } catch (err) {
      if (String(err).includes("404")) return false;
      throw err;
    }
  }

  async recent(channelId: string | undefined, limit: number): Promise<Memory[]> {
    const { memories } = await this.rest<{ memories: BackendMemory[] }>("GET", "/memories");
    return memories
      .map(toMemory)
      .filter((m) => !channelId || m.source.channelId === channelId)
      .sort((a, b) => b.source.createdAt - a.source.createdAt)
      .slice(0, limit);
  }
}

interface RecallHit extends BackendMemory {
  score?: number;
}

/** The gateway may answer plain JSON or a single-event SSE stream. */
async function parseMcpBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    return JSON.parse(data);
  }
  return JSON.parse(text);
}

/** Pull the matched-memories list out of the silo_recall mini-silo result. */
function extractRecallMemories(rpc: unknown): RecallHit[] {
  const result = (rpc as { result?: Record<string, unknown> }).result ?? {};
  const structured = result["structuredContent"] as Record<string, unknown> | undefined;
  let payload: Record<string, unknown> | undefined = structured;
  if (!payload) {
    const content = result["content"] as Array<{ type: string; text?: string }> | undefined;
    const textBlock = content?.find((c) => c.type === "text" && c.text);
    if (textBlock?.text) {
      try {
        payload = JSON.parse(textBlock.text) as Record<string, unknown>;
      } catch {
        payload = undefined;
      }
    }
  }
  const memories = (payload?.["memories"] ?? []) as RecallHit[];
  return memories.filter((m) => m && typeof m.id === "string");
}

function toMemory(backend: BackendMemory): Memory {
  const meta = backend.metadata ?? {};
  const createdAt = backend.created_at
    ? Math.floor(Date.parse(backend.created_at) / 1000)
    : Math.floor(Date.now() / 1000);
  return {
    id: backend.id,
    kind: KINDS.includes(backend.type as MemoryKind) ? (backend.type as MemoryKind) : "fact",
    content: backend.content,
    raw: typeof meta["raw"] === "string" ? (meta["raw"] as string) : backend.content,
    source: {
      eventId: (meta["buzz_event_id"] as string) ?? "",
      authorPubkey: (meta["buzz_author_pubkey"] as string) ?? "",
      channelId: (meta["buzz_channel_id"] as string) ?? "",
      createdAt,
    },
    salience: typeof meta["salience"] === "number" ? (meta["salience"] as number) : 0.5,
    tags: Array.isArray(meta["tags"]) ? (meta["tags"] as string[]) : [],
  };
}
