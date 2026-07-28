<!--
Describe *why*, not just what. See CONTRIBUTING.md.
Security issue? Do not open a PR — email security@onesilo.com.
-->

## What and why

<!-- What changes, and what problem it solves. -->

## Checks

- [ ] `npm run lint && npm test` pass
- [ ] New behavior has tests (prefer the fake relay over anything networked)
- [ ] No new dependency, or the PR explains why one is warranted
- [ ] A new or changed setting appears in **both** `src/config.ts` and
      `.env.example`

## Privacy and credentials

Tick what applies, or delete the section.

- [ ] With `DISTILL_MODE=node`, no path sends raw transcripts to the cloud —
      including on error, retry, or an unreachable node
- [ ] Node credentials stay loopback-only unless `NODE_ALLOW_REMOTE=1` and
      an `https://` URL are both set
- [ ] No secret can reach a log, an error message, or a process argument
- [ ] Memory reads and writes stay within the silo the channel is mapped to

## Cross-repository contracts

<!-- If this changes something shared with onesilo-node or the One Silo
     control plane, link the change it tracks. Delete if not applicable. -->
