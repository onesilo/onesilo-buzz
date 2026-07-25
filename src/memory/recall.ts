/**
 * Recall formatting: turn scored memories into a Buzz reply.
 *
 * Every recalled memory cites its provenance (author + Nostr event id prefix)
 * — in Buzz everything is a signed event, so recall is always auditable.
 */

import type { ScoredMemory, Memory } from "../silo/types.js";

const KIND_LABEL: Record<Memory["kind"], string> = {
  decision: "Decision",
  fact: "Fact",
  preference: "Preference",
  action_item: "Action item",
  explicit: "Noted",
};

function cite(m: Memory, names: Map<string, string>): string {
  const who = names.get(m.source.authorPubkey) ?? m.source.authorPubkey.slice(0, 8);
  const when = new Date(m.source.createdAt * 1000).toISOString().slice(0, 10);
  return `${who}, ${when}, event ${m.source.eventId.slice(0, 8)}`;
}

export function formatRecall(
  query: string,
  results: ScoredMemory[],
  names: Map<string, string> = new Map()
): string {
  if (results.length === 0) {
    return `I don't have any memories matching "${query}" yet.`;
  }
  const lines = results.map(({ memory }, i) => {
    const label = KIND_LABEL[memory.kind];
    return `${i + 1}. [${label}] ${memory.content}\n   — ${cite(memory, names)} (id ${memory.id})`;
  });
  return `Here's what I remember about "${query}":\n${lines.join("\n")}`;
}

export function formatRecent(memories: Memory[]): string {
  if (memories.length === 0) return "No memories stored yet.";
  const lines = memories.map(
    (m) => `- [${KIND_LABEL[m.kind]}] ${m.content} (id ${m.id})`
  );
  return `Recent memories:\n${lines.join("\n")}`;
}
