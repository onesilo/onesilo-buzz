/**
 * Standalone Silo store: JSON persistence + lexical ranking. Exists so the
 * prototype runs end-to-end with zero infrastructure. The real deployment
 * swaps in `SiloBackendStore` (same interface) — see client.ts.
 *
 * Ranking is deliberately simple: token-overlap TF scoring with a recency
 * decay and a salience boost. Good enough to demo recall quality on a
 * conversation-sized corpus; the real backend brings embeddings.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Memory,
  MemoryQuery,
  MemoryStore,
  ScoredMemory,
} from "./types.js";

const STOPWORDS = new Set(
  "a an and are as at be but by for from had has have i in is it its me my of on or our so that the their there they this to was we what when where which who will with you your".split(
    " "
  )
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export class LocalSiloStore implements MemoryStore {
  private memories = new Map<string, Memory>();

  /** @param path Optional JSON file for persistence across runs. */
  constructor(private readonly path?: string) {
    if (path && existsSync(path)) {
      const items = JSON.parse(readFileSync(path, "utf8")) as Memory[];
      for (const m of items) this.memories.set(m.id, m);
    }
  }

  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify([...this.memories.values()], null, 2));
  }

  async remember(memory: Memory): Promise<void> {
    this.memories.set(memory.id, memory);
    this.persist();
  }

  async recall(query: MemoryQuery): Promise<ScoredMemory[]> {
    const qTokens = tokenize(query.text);
    if (qTokens.length === 0) return [];
    const now = Math.floor(Date.now() / 1000);
    const scored: ScoredMemory[] = [];
    for (const memory of this.memories.values()) {
      if (query.channelId && memory.source.channelId !== query.channelId) {
        continue;
      }
      const mTokens = new Set([
        ...tokenize(memory.content),
        ...memory.tags.map((t) => t.toLowerCase()),
      ]);
      const overlap = qTokens.filter((t) => mTokens.has(t)).length;
      if (overlap === 0) continue;
      const matchRatio = overlap / qTokens.length;
      const ageDays = Math.max(0, now - memory.source.createdAt) / 86_400;
      const recency = 1 / (1 + ageDays / 30); // half-weight after ~a month
      const score = matchRatio * (0.7 + 0.3 * memory.salience) * (0.6 + 0.4 * recency);
      scored.push({ memory, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, query.limit ?? 5);
  }

  async forget(memoryId: string): Promise<boolean> {
    const existed = this.memories.delete(memoryId);
    if (existed) this.persist();
    return existed;
  }

  async recent(
    channelId: string | undefined,
    limit: number
  ): Promise<Memory[]> {
    return [...this.memories.values()]
      .filter((m) => !channelId || m.source.channelId === channelId)
      .sort((a, b) => b.source.createdAt - a.source.createdAt)
      .slice(0, limit);
  }

  get size(): number {
    return this.memories.size;
  }
}
