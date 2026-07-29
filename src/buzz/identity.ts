/**
 * Agent identity. In Buzz, agents are first-class members: they hold their own
 * Nostr keypair, sign every event they publish, and are added to channels the
 * same way a human coworker is.
 */

import { existsSync, readFileSync } from "node:fs";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
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
 * `hex` of undefined means the file is absent and the caller should
 * generate + persist a fresh key.
 *
 * Both env and file values are format-validated, and — crucially — an
 * existing-but-unusable key file (unreadable, or not a valid key) throws
 * rather than returning undefined, so the caller never overwrites a file
 * that might hold a recoverable secret. A malformed AGENT_SECRET_KEY throws
 * a clear config error instead of booting an unintended identity.
 */
export function resolveAgentSecretKeyHex(
  envHex: string | undefined,
  keyPath: string
): { hex: string | undefined; fromFile: boolean } {
  const trimmed = envHex?.trim();
  if (trimmed) {
    if (!SECRET_KEY_HEX.test(trimmed)) {
      throw new Error("AGENT_SECRET_KEY must be 64 hex characters (a 32-byte key).");
    }
    return { hex: trimmed, fromFile: false };
  }
  if (existsSync(keyPath)) {
    let stored: string;
    try {
      stored = readFileSync(keyPath, "utf8").trim();
    } catch (err) {
      // The file exists but we can't read it (e.g. permissions). Do NOT
      // fall through to generate — that would overwrite a key we might just
      // be unable to read. Surface the error so the operator can fix it.
      throw new Error(
        `Cannot read agent key file ${keyPath} (${(err as Error).message}). ` +
          `Fix its permissions or remove it to generate a fresh identity.`
      );
    }
    if (!SECRET_KEY_HEX.test(stored)) {
      throw new Error(
        `Agent key file ${keyPath} is not a valid 64-char hex key. ` +
          `Remove it to generate a fresh identity, or restore the correct key.`
      );
    }
    return { hex: stored, fromFile: true };
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

/**
 * The agent's public key in bech32 `npub` form — how Buzz and other Nostr
 * clients identify a member in their UI. Public by construction (derived
 * from the pubkey, never the secret), so it is safe to log.
 */
export function npubOf(pubkey: string): string {
  return nip19.npubEncode(pubkey);
}

export function exportSecretKeyHex(identity: AgentIdentity): string {
  return bytesToHex(identity.secretKey);
}
