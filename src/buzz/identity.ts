/**
 * Agent identity. In Buzz, agents are first-class members: they hold their own
 * Nostr keypair, sign every event they publish, and are added to channels the
 * same way a human coworker is.
 */

import { existsSync, readFileSync } from "node:fs";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export interface AgentIdentity {
  secretKey: Uint8Array;
  pubkey: string;
  /** Human-facing handle used for @mentions, e.g. "silo". */
  handle: string;
}

/** A Nostr secret key is 32 bytes — 64 hex chars. */
const SECRET_KEY_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * Resolve the agent's secret key hex with precedence env > persisted file >
 * none. `fromFile` distinguishes a loaded key from an env-provided one; a
 * `hex` of undefined means the caller should generate and persist a fresh
 * key. An explicit env value is returned as-is (loadIdentity validates it),
 * so a malformed AGENT_SECRET_KEY surfaces as an error rather than being
 * silently replaced.
 */
export function resolveAgentSecretKeyHex(
  envHex: string | undefined,
  keyPath: string
): { hex: string | undefined; fromFile: boolean } {
  const trimmed = envHex?.trim();
  if (trimmed) return { hex: trimmed, fromFile: false };
  if (existsSync(keyPath)) {
    try {
      const stored = readFileSync(keyPath, "utf8").trim();
      if (SECRET_KEY_HEX.test(stored)) return { hex: stored, fromFile: true };
    } catch {
      // Unreadable/corrupt — fall through to generate a fresh identity.
    }
  }
  return { hex: undefined, fromFile: false };
}

export function loadIdentity(
  handle: string,
  secretKeyHex?: string
): AgentIdentity {
  const secretKey = secretKeyHex
    ? hexToBytes(secretKeyHex)
    : generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey), handle };
}

export function exportSecretKeyHex(identity: AgentIdentity): string {
  return bytesToHex(identity.secretKey);
}
