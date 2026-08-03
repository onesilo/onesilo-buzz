/**
 * Buzz-on-Nostr protocol surface used by this agent.
 *
 * Buzz models every action as a signed Nostr event with a `kind` integer
 * (NIP-01 wire format; the workspace relay is the single source of truth).
 *
 * ASSUMPTIONS (documented, isolated here so they are one-file swappable when
 * we pin them against the published Buzz protocol docs):
 *  - Channel chat messages are NIP-29-style group chat: kind 9, with the
 *    channel id carried in an `h` tag.
 *  - Threaded replies reference the parent via an `e` tag (kind 1111 NIP-22
 *    comments exist in Buzz for forum surfaces; chat replies stay kind 9).
 *  - Mentions are `p` tags containing the mentioned pubkey (plus a plain-text
 *    @name in content, which we also match case-insensitively).
 *  - The relay may require NIP-42 AUTH; the relay client handles that.
 */

import type { Event as NostrEvent, EventTemplate } from "nostr-tools";

export const KIND_CHANNEL_MESSAGE = 9;

/**
 * NIP-01 kind 0 (`set_metadata`) — the only way a Nostr client learns a
 * pubkey's name. Without one, Buzz has nothing to show and falls back to
 * the raw hex key, so the agent appears in the member list as
 * "c1afa654…a77a" rather than "@OneSilo".
 */
export const KIND_METADATA = 0;

/**
 * NIP-29 kind 39002 — the relay-signed member list for a channel. Its `d`
 * tag is the channel id and its `p` tags are the members, which is how the
 * agent answers "which channels am I in?" without being able to see a
 * membership event for a channel it hasn't joined.
 */
export const KIND_MEMBER_LIST = 39002;

export const CHANNEL_TAG = "h";

export interface ChannelMessage {
  event: NostrEvent;
  channelId: string;
  authorPubkey: string;
  content: string;
  createdAt: number;
  /** Parent event id when the message is a threaded reply. */
  replyTo?: string;
  mentionedPubkeys: string[];
}

export function parseChannelMessage(event: NostrEvent): ChannelMessage | null {
  if (event.kind !== KIND_CHANNEL_MESSAGE) return null;
  const channelId = event.tags.find((t) => t[0] === CHANNEL_TAG)?.[1];
  if (!channelId) return null;
  return {
    event,
    channelId,
    authorPubkey: event.pubkey,
    content: event.content,
    createdAt: event.created_at,
    replyTo: event.tags.find((t) => t[0] === "e")?.[1],
    mentionedPubkeys: event.tags
      .filter((t) => t[0] === "p" && typeof t[1] === "string")
      .map((t) => t[1] as string),
  };
}

/**
 * Word-boundary mention matcher: "@silo" must not match "@silos".
 * (Trailing `-` and `_` count as handle characters, so "@silo-bot" is a
 * different handle too.)
 *
 * The lookbehind guards the other side: an email address or hostname whose
 * domain part happens to be the handle ("eng@silo.example",
 * "bob@silo.dev") is not a mention — without it, pasting such an address
 * made the agent answer uninvited. A mention's `@` starts a token, so any
 * preceding word/host character disqualifies the match.
 */
function mentionPattern(handle: string, flags = "i"): RegExp {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w.-])@${escaped}(?![\\w-])`, flags);
}

/**
 * A message is addressed to the agent only when the text actually mentions
 * its @handle. A bare `p` tag is a notification (replies and announcements
 * routinely tag people without speaking to them) — treating it as a direct
 * question would break the agent's listen-unless-spoken-to contract, so
 * `pubkey` is intentionally not consulted for addressing.
 */
export function isAddressedTo(
  msg: ChannelMessage,
  _pubkey: string,
  handle: string
): boolean {
  return mentionPattern(handle).test(msg.content);
}

/** Remove @handle mentions from a message, for treating the rest as a query. */
export function stripMention(content: string, handle: string): string {
  return content.replace(mentionPattern(handle, "gi"), "").trim();
}

/**
 * The agent's profile event. Kind 0 is replaceable, so publishing it on
 * every start is idempotent and keeps the displayed name in step with
 * AGENT_HANDLE if it changes.
 *
 * Deliberately no `bot: true` (NIP-24): in Buzz an agent is a member, not
 * a bot, and clients that dim or filter bots would hide it.
 */
export function buildProfile(handle: string, pictureUrl?: string): EventTemplate {
  return {
    kind: KIND_METADATA,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({
      name: handle,
      display_name: handle,
      // NIP-01 calls this `picture`; Buzz syncs it into its users table as
      // `avatar`. Omitted entirely rather than sent empty when unset — a
      // blank string is a broken image, which looks worse than the
      // initial-letter placeholder a client falls back to.
      ...(pictureUrl ? { picture: pictureUrl } : {}),
      about:
        "Long-term memory for this workspace, powered by One Silo. " +
        `Ask "@${handle} what do you remember?", or !remember something.`,
    }),
  };
}

/** Build an unsigned reply in the same channel (and thread, if any). */
export function buildReply(
  to: ChannelMessage,
  content: string
): EventTemplate {
  const tags: string[][] = [
    [CHANNEL_TAG, to.channelId],
    ["e", to.event.id, "", "reply"],
    ["p", to.authorPubkey],
  ];
  return {
    kind: KIND_CHANNEL_MESSAGE,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content,
  };
}
