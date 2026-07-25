/**
 * Agent identity. In Buzz, agents are first-class members: they hold their own
 * Nostr keypair, sign every event they publish, and are added to channels the
 * same way a human coworker is.
 */

import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export interface AgentIdentity {
  secretKey: Uint8Array;
  pubkey: string;
  /** Human-facing handle used for @mentions, e.g. "silo". */
  handle: string;
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
