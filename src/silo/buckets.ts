/**
 * Memory-bucket routing: which silo backs which Buzz channel.
 *
 * A connection on the Silo control plane can hold access grants to any
 * number of silos (managed from the dashboard's Connections page), and every
 * silo_* tool takes a silo_id — so one Buzz agent can spread its channels
 * across multiple memory buckets, and multiple Buzz agents pointed at the
 * same silo id share one memory.
 *
 * Routing is per interaction channel: a channel not in the map uses the
 * default bucket ("default" = the connection's auto-provisioned silo).
 */

export class SiloBucketRouter {
  constructor(
    private readonly defaultSiloId: string = "default",
    private readonly channelMap: Map<string, string> = new Map()
  ) {}

  /** Silo id for an interaction in the given channel. */
  resolve(channelId?: string): string {
    if (channelId) {
      const mapped = this.channelMap.get(channelId);
      if (mapped) return mapped;
    }
    return this.defaultSiloId;
  }

  /** Every distinct silo id this router can address. */
  get buckets(): string[] {
    return [...new Set([this.defaultSiloId, ...this.channelMap.values()])];
  }

  /**
   * Parse "channel=silo_id,channel2=silo_id2" (the SILO_CHANNEL_MAP env
   * format). Malformed entries are skipped.
   */
  static fromEnv(defaultSiloId: string, spec: string | undefined): SiloBucketRouter {
    const map = new Map<string, string>();
    for (const entry of (spec ?? "").split(",")) {
      // Split on the FIRST "=" only, so a silo id containing "=" survives.
      const idx = entry.indexOf("=");
      if (idx <= 0) continue;
      const channel = entry.slice(0, idx).trim();
      const silo = entry.slice(idx + 1).trim();
      if (channel && silo) map.set(channel, silo);
    }
    return new SiloBucketRouter(defaultSiloId, map);
  }
}
