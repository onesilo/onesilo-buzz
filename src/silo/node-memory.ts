/**
 * MemoryStore backed by a local onesilo-node's memory API (SILO_MODE=node):
 * silos homed on hardware the operator owns, SQLite + FTS5 keyword search,
 * fused with vector recall when the node's compute capability is on.
 *
 *   POST   /v1/memory/{silo_id}/remember   {content, metadata?} -> {id}
 *   POST   /v1/memory/{silo_id}/recall     {query, limit?}      -> {results}
 *   DELETE /v1/memory/{silo_id}/{memory_id}                     -> {deleted}
 *
 * Served on the node's LAN port, authenticated with X-Silo-Node-Key.
 * Combined with DISTILL_MODE=node this is the fully-local stack: capture,
 * distillation, storage, and recall all happen on-machine — nothing ever
 * reaches the One Silo control plane.
 *
 * Buzz provenance rides in structured metadata (round-tripped verbatim by
 * the node) plus an inline trailer in content, so exported .silo files
 * keep their audit trail and FTS5 can match on channel/kind tokens.
 */

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

interface NodeRecallResult {
  id?: string;
  content?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export class NodeMemoryStore implements MemoryStore {
  constructor(
    /** Node LAN base URL, e.g. http://127.0.0.1:8765 */
    private readonly baseUrl: string,
    /** X-Silo-Node-Key, resolved per request so rotation needs no restart. */
    private readonly nodeKey: () => string,
    private readonly router: SiloBucketRouter = new SiloBucketRouter(),
    private readonly log: (line: string) => void = () => {}
  ) {}

  /** Loud reachability report; non-fatal (captures buffer and retry). */
  async init(): Promise<void> {
    if (!this.nodeKey()) {
      this.log(
        `warning: no node key found — set NODE_KEY or check ~/.onesilo-node/node.key; ` +
          `memory calls will fail until fixed`
      );
    }
    try {
      const res = await this.request("GET", "/v1/memory/silos");
      const silos = (res as Array<{ silo_id?: string; count?: number }>) ?? [];
      this.log(
        `node memory at ${this.baseUrl}: ${silos.length} silo(s)` +
          (silos.length ? ` [${silos.map((s) => `${s.silo_id}(${s.count})`).join(", ")}]` : "")
      );
    } catch (err) {
      this.log(
        `warning: onesilo-node memory unreachable at ${this.baseUrl} (${err}) — ` +
          `captures will fail until the node is up (enable capabilities.memory)`
      );
    }
  }

  async remember(memory: Memory): Promise<RememberOutcome> {
    const siloId = this.router.resolve(memory.source.channelId);
    // The node assigns its own ids and does not dedupe inserts; our
    // deterministic id travels in metadata so a retried capture (window
    // restore, distillation re-run) can find its earlier self and skip.
    const existing = await this.findByBuzzId(siloId, memory);
    if (existing) return { status: "stored", id: existing };

    const content =
      `${memory.content}\n\n` +
      `[buzz kind=${memory.kind} salience=${memory.salience} ` +
      `channel=${memory.source.channelId} author=${memory.source.authorPubkey} ` +
      `event=${memory.source.eventId} ts=${memory.source.createdAt}]`;
    const body = (await this.request(
      "POST",
      `/v1/memory/${encodeURIComponent(siloId)}/remember`,
      {
        content,
        metadata: {
          buzz: true,
          id: memory.id,
          kind: memory.kind,
          salience: memory.salience,
          channel: memory.source.channelId,
          author: memory.source.authorPubkey,
          event: memory.source.eventId,
          ts: memory.source.createdAt,
        },
      }
    )) as { id?: string };
    return typeof body.id === "string" && body.id
      ? { status: "stored", id: body.id }
      : { status: "queued" };
  }

  /**
   * Dedupe probe: recall by the memory's own words and match on the buzz
   * metadata id. A failing probe must not block capture (worst case is a
   * duplicate, never a loss) — errors resolve to "not found".
   */
  private async findByBuzzId(siloId: string, memory: Memory): Promise<string | undefined> {
    try {
      const body = (await this.request(
        "POST",
        `/v1/memory/${encodeURIComponent(siloId)}/recall`,
        { query: memory.content.slice(0, 200), limit: 5 }
      )) as { results?: NodeRecallResult[] };
      return (body.results ?? []).find(
        (r) => (r.metadata as { id?: string } | undefined)?.id === memory.id
      )?.id;
    } catch {
      return undefined;
    }
  }

  async recall(query: MemoryQuery): Promise<ScoredMemory[]> {
    const limit = query.limit ?? 5;
    const body = (await this.request(
      "POST",
      `/v1/memory/${encodeURIComponent(this.router.resolve(query.channelId))}/recall`,
      { query: query.text, limit: Math.min(25, limit) }
    )) as { results?: NodeRecallResult[] };
    return (body.results ?? [])
      .filter((r) => typeof r?.content === "string")
      .slice(0, limit)
      .map((r) => ({ memory: toMemory(r), score: r.score ?? 0 }));
  }

  /**
   * Delete by id, sweeping every configured bucket like the MCP store — a
   * memory surfaced by cross-bucket recall must stay deletable from any
   * channel.
   */
  async forget(memoryId: string, channelId?: string): Promise<boolean> {
    const primary = this.router.resolve(channelId);
    const buckets = [primary, ...this.router.buckets.filter((b) => b !== primary)];
    let lastError: Error | undefined;
    for (const siloId of buckets) {
      try {
        await this.request(
          "DELETE",
          `/v1/memory/${encodeURIComponent(siloId)}/${encodeURIComponent(memoryId)}`
        );
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("(404)")) continue; // not in this bucket
        lastError = err instanceof Error ? err : new Error(message);
        this.log(`node forget error in bucket ${siloId} (continuing): ${message}`);
      }
    }
    if (lastError) throw lastError;
    return false;
  }

  /**
   * Recent memories via keyword recall: every buzz capture carries "buzz"
   * and its channel in the trailer, so FTS5 matches all of them; order by
   * the metadata timestamp. (The node has no list endpoint yet.)
   */
  async recent(channelId: string | undefined, limit: number): Promise<Memory[]> {
    const results = await this.recall({
      text: channelId ? `buzz ${channelId}` : "buzz",
      channelId,
      limit: Math.max(limit * 2, 10),
    });
    return results
      .map((r) => r.memory)
      .filter((m) => !channelId || m.source.channelId === channelId)
      .sort((a, b) => b.source.createdAt - a.source.createdAt)
      .slice(0, limit);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          "X-Silo-Node-Key": this.nodeKey(),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(`onesilo-node memory unreachable at ${this.baseUrl}: ${err}`);
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        detail = ((await res.json()) as { error?: string }).error ?? detail;
      } catch {
        // non-JSON error body
      }
      throw new Error(`onesilo-node memory ${method} ${path} (${res.status}): ${detail}`);
    }
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }
}

/** Rebuild the Memory from structured metadata (trailer as fallback). */
function toMemory(hit: NodeRecallResult): Memory {
  const meta = (hit.metadata ?? {}) as {
    id?: string;
    kind?: string;
    salience?: number;
    channel?: string;
    author?: string;
    event?: string;
    ts?: number;
  };
  const content = hit.content ?? "";
  const trailer = content.match(
    /\[buzz kind=(\S+) salience=([\d.]+) channel=(\S+) author=(\S+) event=(\S+) ts=(\d+)\]\s*$/
  );
  const body = trailer ? content.slice(0, trailer.index).trim() : content;
  const kind = meta.kind ?? trailer?.[1] ?? "fact";
  return {
    // Identity is the NODE's id: it's what DELETE (forget) expects, and
    // it's the id users see in !memories / !recall citations.
    id: hit.id ?? "",
    kind: KINDS.includes(kind as MemoryKind) ? (kind as MemoryKind) : "fact",
    content: body,
    raw: body,
    source: {
      eventId: meta.event ?? trailer?.[5] ?? "",
      authorPubkey: meta.author ?? trailer?.[4] ?? "",
      channelId: meta.channel ?? trailer?.[3] ?? "",
      createdAt: meta.ts ?? (trailer ? Number(trailer[6]) : 0),
    },
    salience: meta.salience ?? (trailer ? Number(trailer[2]) : 0.5),
    tags: [],
  };
}
