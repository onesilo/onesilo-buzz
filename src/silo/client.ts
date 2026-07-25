/**
 * HTTP adapter to the real Silo backend (recap-silo-backend).
 *
 * ASSUMED API (prototype): the backend exposes a memory surface per silo.
 * These routes don't exist yet — they are the contract this prototype
 * proposes, shaped to match the backend's existing conventions
 * (router/service/schema per domain, `page`/`page_size`, bearer auth):
 *
 *   POST   /api/v1/silos/{silo_id}/memories            body: Memory
 *   POST   /api/v1/silos/{silo_id}/memories/search     body: { query, channel_id?, limit }
 *   DELETE /api/v1/silos/{silo_id}/memories/{memory_id}
 *   GET    /api/v1/silos/{silo_id}/memories?channel_id=&page_size=
 *
 * Search on the backend would use the existing embedding/ingestion pipeline
 * rather than the lexical scoring the local store uses.
 */

import type {
  Memory,
  MemoryQuery,
  MemoryStore,
  ScoredMemory,
} from "./types.js";

export interface SiloBackendConfig {
  baseUrl: string; // e.g. https://api.onesilo.com
  siloId: string; // the silo acting as this workspace's memory
  apiToken: string; // service token for the agent
}

export class SiloBackendStore implements MemoryStore {
  constructor(private readonly config: SiloBackendConfig) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(
      `${this.config.baseUrl}/api/v1/silos/${this.config.siloId}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }
    );
    if (!res.ok) {
      throw new Error(`Silo backend ${method} ${path} -> ${res.status}`);
    }
    return (await res.json()) as T;
  }

  async remember(memory: Memory): Promise<void> {
    await this.request("POST", "/memories", memory);
  }

  async recall(query: MemoryQuery): Promise<ScoredMemory[]> {
    return this.request("POST", "/memories/search", {
      query: query.text,
      channel_id: query.channelId,
      limit: query.limit ?? 5,
    });
  }

  async forget(memoryId: string): Promise<boolean> {
    await this.request("DELETE", `/memories/${memoryId}`);
    return true;
  }

  async recent(
    channelId: string | undefined,
    limit: number
  ): Promise<Memory[]> {
    const params = new URLSearchParams({ page_size: String(limit) });
    if (channelId) params.set("channel_id", channelId);
    return this.request("GET", `/memories?${params}`);
  }
}
