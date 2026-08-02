#!/usr/bin/env node
/**
 * `onesilo-buzz` — the guided way to run the memory agent.
 *
 * The flow it implements, in order:
 *
 *   1. Offer to install a onesilo-node, so distillation happens on this
 *      machine and raw transcripts never leave it.
 *   2. Install it (Homebrew) and initialize it with `onesilo-node setup -yes`
 *      (the node's non-interactive contract; its interactive setup is a
 *      control panel that runs the node itself, which this flow supervises
 *      on its own).
 *   3. Put the agent in node-distill mode when a node is actually answering.
 *   4. Start the agent.
 *   5. Print its npub and how to admit it to the relay and its channels.
 *
 * Step 3 says "actually answering" for a reason: enabling node distillation
 * against a node that is not there does not fail loudly, it buffers captures
 * forever. The node is probed, not assumed.
 *
 * The inverse — silently falling back to cloud distillation when the node is
 * missing — is deliberately *not* done. Someone who answered "yes" to
 * keeping transcripts local would have them shipped off-machine by a
 * fallback they never saw. This CLI would rather stop and say so.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig, loadDotEnv, DEFAULT_RELAY_URL } from "./config.js";
import type { Config } from "./config.js";
import { startAgent, NotPairedError } from "./boot.js";
import { SiloOAuthClient } from "./silo/oauth.js";
import { askText, askYesNo, type Answer } from "./cli/prompt.js";
import {
  detectNode,
  installNode,
  runNodeSetup,
  startNode,
  waitForNode,
  systemRunner,
  type Runner,
} from "./cli/node-setup.js";
import { buildInvite, formatInvite } from "./cli/invite.js";

const log = (line: string) => console.log(`[onesilo-buzz] ${line}`);

interface Flags {
  /** `--yes`: take the recommended answer to every prompt. */
  assumeYes: boolean;
  /** `--no-node`: skip the node entirely, distill in the cloud. */
  noNode: boolean;
}

function parseFlags(argv: string[]): Flags {
  return {
    assumeYes: argv.includes("--yes") || argv.includes("-y"),
    noNode: argv.includes("--no-node"),
  };
}

const USAGE = `onesilo-buzz — long-term memory for your Buzz workspace

Usage:
  onesilo-buzz run [--yes] [--no-node]   Set up if needed, then run the agent
  onesilo-buzz connect                   Pair with One Silo (OAuth, one-time)
  onesilo-buzz --help

Flags:
  -y, --yes     Accept the recommended answer to every prompt
      --no-node Skip the local node; distillation runs in the cloud

Environment overrides every prompt — see .env.example. Setting DISTILL_MODE
explicitly disables the node question entirely.
`;

/**
 * Decide the distill mode, possibly installing a node on the way.
 *
 * Returns the mode to run in, or null to abort. Null is used only when the
 * operator asked for local distillation and we could not deliver it —
 * continuing would quietly do the opposite of what they chose.
 */
async function resolveDistillMode(
  config: Config,
  flags: Flags,
  runner: Runner
): Promise<"cloud" | "node" | null> {
  // `--no-node` is checked first, before DISTILL_MODE. Both are explicit
  // operator decisions, but a flag typed on this invocation is more immediate
  // than an environment variable that is usually sitting in a .env file from
  // some earlier session -- so the flag wins, which is the ordinary
  // convention. Checking DISTILL_MODE first meant `DISTILL_MODE=node
  // onesilo-buzz run --no-node` ran node distillation anyway, silently doing the
  // opposite of the flag's documented meaning.
  // SILO_MODE=node stores MEMORY on the node — the node isn't a
  // distillation nicety there, it's the database. Every "continue without
  // a node" path below is therefore closed when nodeMemory is set:
  // proceeding would wire NodeMemoryStore against nothing and the agent
  // would look healthy while every memory operation fails.
  const nodeMemory = config.silo.mode === "node";

  if (flags.noNode) {
    if (nodeMemory) {
      console.error(
        "SILO_MODE=node keeps memory on a local onesilo-node — --no-node contradicts it.\n" +
          "Drop --no-node, or change SILO_MODE in .env."
      );
      return null;
    }
    if (process.env.DISTILL_MODE && process.env.DISTILL_MODE !== "cloud") {
      log(
        `--no-node overrides DISTILL_MODE=${process.env.DISTILL_MODE} — distilling in the cloud.`
      );
    }
    return "cloud";
  }

  // An explicit DISTILL_MODE is an operator decision already made. Asking
  // again would be noise, and overriding it would be worse. With node
  // memory the setting is honored too — but only after the node itself is
  // ensured below.
  if (process.env.DISTILL_MODE && !nodeMemory) {
    log(`DISTILL_MODE=${process.env.DISTILL_MODE} is set — leaving it alone.`);
    return config.distill;
  }

  const distillDecision = (): "cloud" | "node" => {
    if (process.env.DISTILL_MODE) {
      log(`DISTILL_MODE=${process.env.DISTILL_MODE} is set — leaving it alone.`);
      return config.distill;
    }
    return "node";
  };

  const state = await detectNode(config.node.adminUrl, runner);
  if (state.kind === "running") {
    log(`Found a onesilo-node answering at ${config.node.adminUrl}.`);
    return distillDecision();
  }

  const answer = await askQuestion(state.kind, flags, nodeMemory);
  if (answer === "no") {
    if (nodeMemory) {
      console.error(
        "SILO_MODE=node needs a running onesilo-node — it is where memory lives.\n" +
          "Start one and re-run, or change SILO_MODE in .env to use One Silo instead."
      );
      return null;
    }
    log(
      "Continuing without a node. Raw conversation transcripts will be sent to " +
        "your silo for distillation — only add the agent to channels whose " +
        "content belongs there."
    );
    return "cloud";
  }

  if (state.kind === "absent") {
    const installed = await installNode(log, runner);
    if (!installed.ok) return abort(installed.detail);
  }

  const setup = await runNodeSetup(log, runner);
  if (!setup.ok) return abort(setup.detail);

  // `setup` configures a node but does not leave one running, so start it
  // and keep it for the life of this process.
  log("Starting the node…");
  startNode(log);
  if (!(await waitForNode(config.node.adminUrl))) {
    return abort(
      `The node was set up but is not answering at ${config.node.adminUrl}.\n` +
        "Run it in another terminal to see why, then re-run `onesilo-buzz run`:\n" +
        "  onesilo-node"
    );
  }
  log("Node is up.");
  return distillDecision();
}

/** The question, phrased for what is actually on the machine and at stake. */
function askQuestion(
  kind: "installed" | "absent",
  flags: Flags,
  nodeMemory: boolean
): Promise<Answer> {
  const why = nodeMemory
    ? "memory lives on it (SILO_MODE=node)"
    : "memory is retained on this machine";
  const question =
    kind === "installed"
      ? `A onesilo-node is installed but not running. Set it up and use it so ${why}?`
      : `Install onesilo-node so that ${why}?`;
  return askYesNo(question, {
    default: "yes",
    forced: flags.assumeYes ? "yes" : undefined,
  });
}

function abort(detail?: string): null {
  if (detail) console.error(`\n${detail}\n`);
  console.error(
    "Stopping rather than falling back to cloud distillation — you asked for " +
      "transcripts to stay on this machine, and silently doing the opposite " +
      "would be worse than not starting.\n" +
      "To run in the cloud instead: onesilo-buzz run --no-node"
  );
  return null;
}

/**
 * First-run community question: with no BUZZ_RELAY_URL anywhere (shell or
 * .env), ask whether this agent joins a hosted community, and only then
 * for its URL — a wrong relay presents as "agent runs, nothing happens",
 * the worst kind of failure to debug. Answering no (or giving no URL)
 * keeps the localhost dev relay. The URL is persisted to .env in the
 * working directory so it's asked exactly once.
 */
async function ensureRelayUrl(flags: Flags): Promise<void> {
  if (process.env.BUZZ_RELAY_URL) return;
  if (flags.assumeYes || !process.stdin.isTTY) return; // scripted/headless runs configure via env

  const hosted = await askYesNo("Connect to a hosted community?", { default: "yes" });
  if (hosted === "no") {
    // An explicit "no" is a decision too — persist it, or every future
    // run re-asks a question that was already answered.
    process.env.BUZZ_RELAY_URL = DEFAULT_RELAY_URL;
    persistEnvVar("BUZZ_RELAY_URL", DEFAULT_RELAY_URL);
    log(`saved BUZZ_RELAY_URL=${DEFAULT_RELAY_URL} (local dev relay) to .env — future runs won't ask.`);
    return;
  }

  const entered = await askText(
    "Community URL (e.g. company.communities.buzz.xyz)",
    { default: "" }
  );
  if (!entered) {
    process.env.BUZZ_RELAY_URL = DEFAULT_RELAY_URL;
    persistEnvVar("BUZZ_RELAY_URL", DEFAULT_RELAY_URL);
    log(`no community URL given — saved the local dev relay (${DEFAULT_RELAY_URL}) to .env.`);
    return;
  }
  const url = normalizeRelayUrl(entered);
  if (!url) {
    // A garbled URL is a typo, not a decision: use the dev relay for this
    // run only and DON'T persist, so the next run asks again.
    log(
      `"${entered}" doesn't look like a community URL — using the local dev relay for this run; will ask again next time.`
    );
    return;
  }
  process.env.BUZZ_RELAY_URL = url;
  persistEnvVar("BUZZ_RELAY_URL", url);
  log(`saved BUZZ_RELAY_URL=${url} to .env — future runs won't ask.`);
}

/**
 * People paste community addresses in every shape — bare hostname,
 * https:// from the browser bar (often with a path/query), or a real
 * wss:// URL. Normalize to the WebSocket form: an explicit ws:// or
 * wss:// URL passes through unchanged (someone typing that knows their
 * endpoint, path included); everything else reduces to wss://<host[:port]>
 * — hosted communities are TLS and serve the relay at the origin, so a
 * browser path would only break the connection. Returns null when the
 * input has no usable host (a scheme with nothing behind it, bare
 * slashes) — a nonsense endpoint must not be persisted as the relay.
 */
export function normalizeRelayUrl(input: string): string | null {
  const s = input.trim().replace(/\/+$/, "");
  const explicitWs = /^wss?:\/\//i.test(s);
  const candidate = explicitWs ? s : `wss://${s.replace(/^https?:\/\//i, "")}`;
  try {
    const u = new URL(candidate);
    // Scheme-only input ("http://", "wss:", …) leaves the scheme word
    // itself parsing as the "hostname". None of those are hosts.
    if (!u.hostname || /^(https?|wss?)$/i.test(u.hostname)) return null;
    return explicitWs ? candidate : `wss://${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Pairing check, BEFORE any node install/setup/start: SILO_MODE=mcp (the
 * default) stores memory in One Silo and cannot run unpaired. Discovering
 * that after minutes of node bootstrap — and then exiting, taking the
 * supervised node down too — was the original first-run experience, and it
 * was terrible. Interactive runs can pair right here, or switch to
 * node-local memory instead; non-interactive runs fail fast with the fix.
 */
async function ensurePairedOrRerouted(config: Config, flags: Flags): Promise<boolean> {
  if (config.silo.mode !== "mcp") return true;
  let oauth: SiloOAuthClient;
  try {
    oauth = new SiloOAuthClient({
      serverUrl: config.silo.serverUrl,
      agentHandle: config.agentHandle,
      tokenPath: config.silo.tokenPath,
      callbackPort: config.silo.callbackPort,
    });
  } catch (err) {
    // A corrupt credential file must produce instructions, not a stack.
    console.error(err instanceof Error ? err.message : String(err));
    return false;
  }
  if (oauth.isPaired) return true;

  if (!process.stdin.isTTY) {
    console.error(
      "Not paired with One Silo yet (SILO_MODE=mcp stores memory in your silo).\n" +
        "  Pair:                onesilo-buzz connect\n" +
        "  Or keep memory local: set SILO_MODE=node in .env (needs a onesilo-node)"
    );
    return false;
  }

  log("The agent needs a memory home. SILO_MODE=mcp (the default) uses your One Silo account.");
  const pair = await askYesNo(
    "Pair with One Silo now (opens your browser; one-time)?",
    { default: "yes", forced: flags.assumeYes ? "yes" : undefined }
  );
  if (pair === "yes") {
    try {
      await oauth.pair((line) => console.log(line));
      return true;
    } catch (err) {
      // Most likely: callback port in use (a running node holds 8765) or
      // no browser completion. Say what happened and stop before any node
      // work — same failure, minus the wasted setup.
      console.error(`pairing failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  const useNode = await askYesNo(
    "Keep memory on a local onesilo-node instead (nothing stored in the cloud)?",
    { default: "yes" }
  );
  if (useNode === "yes") {
    process.env.SILO_MODE = "node";
    persistEnvVar("SILO_MODE", "node");
    log("saved SILO_MODE=node to .env — memory will live on this machine's node.");
    return true;
  }
  console.error("No memory home chosen — run `onesilo-buzz connect` or set SILO_MODE, then re-run.");
  return false;
}

/**
 * Set NAME=value in ./.env (created if missing). Every existing
 * definition of NAME is removed first — a hand-edited file can carry
 * duplicates, and replacing only the first would leave a survivor that
 * still wins at load time.
 */
function persistEnvVar(name: string, value: string): void {
  const path = ".env";
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const kept = existing.split("\n").filter((line) => !line.startsWith(`${name}=`));
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  kept.push(`${name}=${value}`);
  writeFileSync(path, kept.join("\n") + "\n");
}

async function runCommand(argv: string[], runner: Runner = systemRunner): Promise<number> {
  const flags = parseFlags(argv);

  await ensureRelayUrl(flags);
  if (!(await ensurePairedOrRerouted(loadConfig(), flags))) return 1;
  // Both steps above may have changed process.env (relay URL, SILO_MODE) —
  // read the config after them, not before.
  const config = loadConfig();

  const distill = await resolveDistillMode(config, flags, runner);
  if (distill === null) return 1;

  // config is env-derived and frozen at load; re-read it so the store wiring
  // in boot.ts sees the mode we just settled on.
  process.env.DISTILL_MODE = distill;
  const finalConfig = loadConfig();

  try {
    await startAgent({
      config: finalConfig,
      log,
      onStarted: (identity) => {
        console.log(
          formatInvite(
            buildInvite({
              pubkey: identity.pubkey,
              handle: identity.handle,
              relayUrl: finalConfig.relayUrl,
            })
          )
        );
      },
    });
  } catch (err) {
    if (err instanceof NotPairedError) {
      console.error(
        "Not paired with One Silo yet — the agent needs somewhere to put memory.\n" +
          "  onesilo-buzz connect"
      );
      return 1;
    }
    console.error("failed to start agent:", err);
    return 1;
  }

  // startAgent resolves once connected; the process stays alive on the relay
  // socket and its signal handlers.
  return 0;
}

async function main(): Promise<void> {
  loadDotEnv();
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "run": {
      const code = await runCommand(rest);
      if (code !== 0) process.exit(code);
      return;
    }
    case "connect": {
      // The pairing flow is its own module with its own output; importing it
      // runs it, matching `npm run connect`.
      await import("./connect.js");
      return;
    }
    case "--help":
    case "-h":
    case "help":
    case undefined:
      console.log(USAGE);
      return;
    case "--version":
    case "-v": {
      const { version } = await import("./version.js");
      console.log(version);
      return;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(USAGE);
      process.exit(2);
  }
}

// Only run when invoked as the program, not when imported. Tests import
// `runCommand` directly; without this guard, importing the module would
// execute `main()` against the test runner's own argv.
//
// The comparison is wrapped because this runs at module scope, where a throw
// is uncatchable by whoever imported us — it would take down the importer
// rather than this guard. `pathToFileURL` resolves a relative argv[1] against
// the cwd, so it can fail when there is no usable cwd (the directory was
// deleted under a running shell). Treating that as "not invoked directly" is
// the safe reading: the only cost is a no-op import, whereas guessing the
// other way runs `main()` inside a test process.
// argv[1] must be resolved through symlinks before comparing. Both npm's
// global install and Homebrew put a *symlink* in bin/ pointing at this file,
// so argv[1] is e.g. /opt/homebrew/bin/onesilo-buzz while import.meta.url is
// the real path Node resolved the module to. Comparing them raw made every
// installed invocation a silent no-op: main() never ran and the process
// exited 0 with no output. Running from a checkout worked, which is why the
// tests did not see it.
export function isEntrypoint(moduleUrl: string, entry: string | undefined): boolean {
  if (entry === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

function isInvokedDirectly(): boolean {
  return isEntrypoint(import.meta.url, process.argv[1]);
}

if (isInvokedDirectly()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { runCommand, resolveDistillMode, parseFlags, persistEnvVar };
