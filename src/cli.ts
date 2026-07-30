#!/usr/bin/env node
/**
 * `onesilo-buzz` — the guided way to run the memory agent.
 *
 * The flow it implements, in order:
 *
 *   1. Offer to install a onesilo-node, so distillation happens on this
 *      machine and raw transcripts never leave it.
 *   2. Install it (Homebrew) and hand off to the node's own setup wizard.
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

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { startAgent, NotPairedError } from "./boot.js";
import { askYesNo, type Answer } from "./cli/prompt.js";
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
  if (flags.noNode) {
    if (process.env.DISTILL_MODE && process.env.DISTILL_MODE !== "cloud") {
      log(
        `--no-node overrides DISTILL_MODE=${process.env.DISTILL_MODE} — distilling in the cloud.`
      );
    }
    return "cloud";
  }

  // An explicit DISTILL_MODE is an operator decision already made. Asking
  // again would be noise, and overriding it would be worse.
  if (process.env.DISTILL_MODE) {
    log(`DISTILL_MODE=${process.env.DISTILL_MODE} is set — leaving it alone.`);
    return config.distill;
  }

  const state = await detectNode(config.node.adminUrl, runner);
  if (state.kind === "running") {
    log(`Found a onesilo-node answering at ${config.node.adminUrl} — distilling locally.`);
    return "node";
  }

  const answer = await askQuestion(state.kind, flags);
  if (answer === "no") {
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
  log("Node is up — distillation will run on this machine.");
  return "node";
}

/** The question, phrased for what is actually on the machine. */
function askQuestion(kind: "installed" | "absent", flags: Flags): Promise<Answer> {
  const question =
    kind === "installed"
      ? "A onesilo-node is installed but not running. Set it up and use it so memory is retained on this machine?"
      : "Install onesilo-node so that memory is retained on this machine?";
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

async function runCommand(argv: string[], runner: Runner = systemRunner): Promise<number> {
  const flags = parseFlags(argv);
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

export { runCommand, resolveDistillMode, parseFlags };
