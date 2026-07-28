# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Email **security@onesilo.com** with a description, the version or commit
affected, and a reproduction if you have one. We will confirm receipt and
keep you updated. If you would like credit in the release notes, say so and
tell us how you want to be named.

Please give us a reasonable window to ship a fix before disclosing
publicly.

## Scope

This repository is the Buzz memory agent. Findings in onesilo-node, the One
Silo control plane, or the iOS/Mac apps go to the same address — say which
component you are reporting on.

Things we are particularly interested in:

- **Raw transcript leakage.** With `DISTILL_MODE=node`, conversation is
  distilled locally and only the distilled statements sync to a silo. Any
  path where raw conversation reaches the cloud instead — including error
  handling, retries, or a failed node call — is a serious bug, because it
  silently defeats the reason someone chose that mode.
- **Node credential exposure.** The admin token and node key grant full
  local memory and inference access. Anything that sends them off-host,
  writes them to a log, puts them in a process argument list, or defeats
  the loopback / `https`-only checks.
- **Agent identity key exposure.** The Nostr secret key is written `0600`
  and never printed. Anything that leaks it, or that causes a fresh key to
  silently replace a stable one.
- **Cross-silo or cross-channel memory bleed.** `SILO_CHANNEL_MAP` routes
  channels to specific silos; recalling from a silo a channel was not
  granted is a bug.
- **Injection through conversation content.** Channel messages are
  untrusted input. Anything that lets message content steer the agent into
  writing to an unintended silo, calling unintended tools, or exfiltrating
  memory.

## Out of scope

- Findings that require an attacker who already has local read access to
  `.silo/` or the environment. Those files are secrets by design and are
  written `0600`.
- The agent reading every message in channels it has been added to. That
  is what it is for — the workspace controls membership.
- Denial of service by flooding a workspace you control.

## Supported versions

This is a `0.x` prototype and moves quickly. Fixes land on `main`; there
are no backported release branches. Run a recent commit.
