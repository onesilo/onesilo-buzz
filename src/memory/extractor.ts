/**
 * Turns raw Buzz channel messages into memory candidates.
 *
 * The prototype uses transparent heuristics so the demo is deterministic and
 * dependency-free. In production this becomes a call into the Silo backend's
 * LLM layer (which already does multi-provider routing) with a distillation
 * prompt; the interface stays the same, so only `extractMemories` changes.
 */

import { createHash } from "node:crypto";
import type { ChannelMessage } from "../buzz/events.js";
import type { Memory, MemoryKind } from "../silo/types.js";
import { tokenize } from "../silo/local.js";

interface Pattern {
  kind: MemoryKind;
  regex: RegExp;
  salience: number;
}

/** Ordered: first match wins, so put the most specific signals first. */
const PATTERNS: Pattern[] = [
  { kind: "decision", regex: /\b(we (decided|agreed|are going with)|decision:|let'?s go with|we'?ll (use|ship|go with))\b/i, salience: 0.9 },
  { kind: "action_item", regex: /\b(i('| wi)ll|action item:|todo:)|@\w+\s+(will|to)\b/i, salience: 0.7 },
  { kind: "preference", regex: /\b(i (prefer|like|hate|always|never)|please (always|never|don'?t))\b/i, salience: 0.6 },
  { kind: "fact", regex: /\b(is|are|runs on|lives in|deadline|due|password is|url is|repo is|uses)\b/i, salience: 0.4 },
];

const MIN_TOKENS = 4; // skip "ok", "lol", emoji-only, etc.
const FACT_MIN_TOKENS = 7; // the "fact" pattern is broad; demand more substance

/**
 * Question detection without a trailing "?" is heuristic. Unambiguous
 * signals only:
 *  - WH-openers ("what did we decide…")
 *  - aux + pronoun inversion ("can you…", "did anyone…") — a bare modal
 *    ("will ship Friday") is an elliptical statement and stays capturable
 *  - explicit recall phrasings ("remind me…", "does anyone know…")
 */
const WH_INTERROGATIVE = /^(what|who|whom|whose|when|where|why|how|which)\b/i;
const AUX_INTERROGATIVE =
  /^(can|could|would|will|shall|should|do|does|did|is|are|was|were|has|have|had)\s+(you|we|i|anyone|someone|somebody|they|he|she|it)\b/i;
const RECALL_REQUEST = /\b(remind me|do you know|does anyone know|any idea)\b/i;

/** Questions are requests for memory, not memory — don't distill them. */
export function isQuestion(text: string): boolean {
  const t = text.trim();
  return (
    /\?\s*$/.test(t) ||
    WH_INTERROGATIVE.test(t) ||
    AUX_INTERROGATIVE.test(t) ||
    RECALL_REQUEST.test(t)
  );
}

export function memoryId(eventId: string, suffix = "0"): string {
  return createHash("sha256").update(`${eventId}:${suffix}`).digest("hex").slice(0, 16);
}

function baseMemory(
  msg: ChannelMessage,
  kind: MemoryKind,
  content: string,
  salience: number
): Memory {
  return {
    id: memoryId(msg.event.id, kind),
    kind,
    content,
    raw: msg.content,
    source: {
      eventId: msg.event.id,
      authorPubkey: msg.authorPubkey,
      channelId: msg.channelId,
      createdAt: msg.createdAt,
    },
    salience,
    tags: tokenize(content).slice(0, 8),
  };
}

/**
 * Explicit "!remember <text>" always wins and stores verbatim.
 * Otherwise the first matching pattern produces one candidate memory.
 */
export function extractMemories(msg: ChannelMessage): Memory[] {
  const text = msg.content.trim();
  const tokens = tokenize(text);
  if (tokens.length < MIN_TOKENS) return [];
  // Questions are recall requests, not memory — a long "what/why/how …?"
  // can otherwise trip the broad fact pattern.
  if (isQuestion(text)) return [];

  for (const p of PATTERNS) {
    if (!p.regex.test(text)) continue;
    if (p.kind === "fact" && tokens.length < FACT_MIN_TOKENS) return [];
    return [baseMemory(msg, p.kind, text, p.salience)];
  }
  return [];
}

export function explicitMemory(msg: ChannelMessage, text: string): Memory {
  const m = baseMemory(msg, "explicit", text.trim(), 1.0);
  return m;
}
