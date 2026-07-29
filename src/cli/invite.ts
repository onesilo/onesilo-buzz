/**
 * What to print once the agent is live: who it is, and how to let it in.
 *
 * In Buzz an agent is a member, not an integration — it holds its own
 * keypair and is added to channels the way a coworker is. So the last step
 * of starting one is never automatic: a human has to admit it. This module
 * produces that hand-off text.
 *
 * Two distinct things have to happen, and conflating them is the usual
 * source of "it's running but nothing happens":
 *
 *   1. **Relay membership.** A restricted relay refuses events from
 *      non-members, so the agent connects, subscribes, and silently receives
 *      nothing. The relay operator adds the pubkey.
 *   2. **Channel membership.** Even on a relay that admits it, the agent
 *      only sees channels it has been added to.
 *
 * The npub form is what people paste into Buzz clients; the hex form is what
 * relay admin tooling takes. Printing both removes a conversion step that is
 * easy to get wrong and produces a confusing failure when it is.
 */

import { nip19 } from "nostr-tools";

export interface AgentInvite {
  /** Bech32 `npub1…` — the form used in Buzz clients and by humans. */
  npub: string;
  /** 64-char hex — the form relay admin tooling and NIP filters take. */
  pubkey: string;
  handle: string;
  relayUrl: string;
}

export function buildInvite(args: {
  pubkey: string;
  handle: string;
  relayUrl: string;
}): AgentInvite {
  return {
    npub: nip19.npubEncode(args.pubkey),
    pubkey: args.pubkey,
    handle: args.handle,
    relayUrl: args.relayUrl,
  };
}

/**
 * The block printed after a successful start.
 *
 * Deliberately plain text with no ANSI colour: this gets pasted into
 * issues, chat, and terminals that do not render escapes, and a pubkey
 * wrapped in colour codes is a pubkey someone will paste wrong.
 */
export function formatInvite(invite: AgentInvite): string {
  const { npub, pubkey, handle, relayUrl } = invite;
  return [
    "",
    "  ─────────────────────────────────────────────────────────────────",
    "  The agent is running. One step left: let it into your workspace.",
    "  ─────────────────────────────────────────────────────────────────",
    "",
    `  Agent      @${handle}`,
    `  npub       ${npub}`,
    `  pubkey     ${pubkey}`,
    `  relay      ${relayUrl}`,
    "",
    "  1. Admit it to the relay (only if the relay is member-restricted).",
    "     A restricted relay drops events from non-members, so the agent",
    "     connects and subscribes but never receives anything — it looks",
    "     like a silent hang rather than a refusal. On a self-hosted relay:",
    "",
    `       buzz-admin add-member ${pubkey}`,
    "",
    "     On a hosted relay you do not administer, send that pubkey to",
    "     whoever runs it and ask them to add it.",
    "",
    "  2. Add it to the channels it should remember, the same way you would",
    "     add a person — paste the npub above:",
    "",
    `       ${npub}`,
    "",
    `  Then say "@${handle} what do you remember?" in one of those channels.`,
    "",
  ].join("\n");
}

/**
 * The line shown when the relay is restricted and nothing is arriving.
 *
 * Kept next to the invite text on purpose: it is the same problem surfacing
 * later, and the fix is the same command.
 */
export function formatRestrictedHint(invite: AgentInvite): string {
  return (
    `The relay refused the agent as a non-member. Add its pubkey and restart:\n` +
    `  buzz-admin add-member ${invite.pubkey}`
  );
}
