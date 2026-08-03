/**
 * Getting a onesilo-node onto this machine, if the operator wants one.
 *
 * Why the CLI offers this at all: without a node, raw conversation
 * transcripts leave the machine for One Silo's distillation pipeline. With
 * one, distillation happens locally and only distilled statements sync. That
 * is a privacy decision, so it is asked rather than assumed — and asked
 * *before* the agent starts capturing anything.
 *
 * Why Homebrew: the node deliberately publishes no loose binaries (an
 * unsigned tarball would be Gatekeeper-blocked on macOS). A Homebrew formula
 * that builds from source sidesteps that entirely — locally compiled
 * binaries carry no quarantine attribute — so it is the one package-manager
 * path that does not require becoming an Apple-notarized distributor.
 * `go install` and Docker remain the documented alternatives, and this
 * module names them when brew is unavailable rather than dead-ending.
 */

import { spawn } from "node:child_process";
import { SiloNodeClient, resolveNodeAdminToken } from "../node/client.js";

export type NodeState =
  /** A node is answering on the admin API — nothing to install or set up. */
  | { kind: "running" }
  /** The binary exists but no node is answering; it needs setup and/or a start. */
  | { kind: "installed" }
  /** No binary and nothing listening. */
  | { kind: "absent" };

export interface Runner {
  /** Resolves with the exit code; never rejects on a non-zero exit. */
  run(command: string, args: string[]): Promise<number>;
  /** True when `command` resolves on PATH. */
  which(command: string): Promise<boolean>;
}

/** Spawns real processes, inheriting stdio so wizards stay interactive. */
export const systemRunner: Runner = {
  run(command, args) {
    return new Promise((resolve) => {
      const child = spawn(command, args, { stdio: "inherit" });
      // An ENOENT (command vanished between `which` and here) is a failure,
      // not a crash — report it as a non-zero exit like any other.
      child.on("error", () => resolve(127));
      child.on("close", (code) => resolve(code ?? 1));
    });
  },
  which(command) {
    return new Promise((resolve) => {
      // The command name travels as a positional parameter, not string
      // concatenation into a shell line — that keeps shell metacharacters
      // inert and avoids Node's DEP0190 warning (args + shell:true).
      const child = spawn("/bin/sh", ["-c", 'command -v -- "$1"', "sh", command], {
        stdio: "ignore",
      });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
  },
};

/**
 * What is already on this machine.
 *
 * A live node outranks an installed binary: the operator may be running it
 * from a checkout, from Docker, or under Silo Desktop, none of which put
 * `onesilo-node` on PATH. Probing the admin API first means those setups are
 * detected as working instead of being offered a redundant install.
 */
export async function detectNode(
  adminUrl: string,
  runner: Runner = systemRunner
): Promise<NodeState> {
  const client = new SiloNodeClient(adminUrl, resolveNodeAdminToken(undefined));
  if (await client.health()) return { kind: "running" };
  if (await runner.which("onesilo-node")) return { kind: "installed" };
  return { kind: "absent" };
}

export interface InstallOutcome {
  ok: boolean;
  /** Shown to the operator when `ok` is false — always actionable. */
  detail?: string;
}

/**
 * `brew install` the node, or explain why that is not possible here.
 *
 * Returns rather than throws on every failure path: not getting a node is a
 * degraded outcome, not a fatal one, and the caller decides whether to
 * continue in cloud-distill mode.
 */
export async function installNode(
  log: (line: string) => void,
  runner: Runner = systemRunner
): Promise<InstallOutcome> {
  if (!(await runner.which("brew"))) {
    return {
      ok: false,
      detail:
        "Homebrew is not installed. Install the node another way and re-run:\n" +
        "  go install github.com/onesilo/onesilo-node/cmd/onesilo-node@latest\n" +
        "  (or Docker: https://github.com/onesilo/onesilo-node#which-way-to-run-it)",
    };
  }

  log("Installing onesilo-node with Homebrew (builds from source; this can take a few minutes)…");
  const code = await runner.run("brew", ["install", FORMULA]);
  if (code !== 0) {
    return {
      ok: false,
      detail:
        `\`brew install ${FORMULA}\` exited ${code}. If the tap is missing:\n` +
        "  brew tap onesilo/tap\n" +
        "Or install without Homebrew:\n" +
        "  go install github.com/onesilo/onesilo-node/cmd/onesilo-node@latest",
    };
  }
  return { ok: true };
}

/**
 * The tapped formula name.
 *
 * Fully qualified on purpose: a bare `onesilo-node` would resolve against
 * homebrew-core, which does not carry this formula, so the error would be
 * "no available formula" rather than anything about a missing tap. `brew
 * install` auto-taps `onesilo/tap` when given this form.
 */
const FORMULA = "onesilo/tap/onesilo-node";

/**
 * Initialize the node's config with its own setup command, non-interactively.
 *
 * `-yes` matters: `onesilo-node setup` without it launches the node and
 * drops into an interactive control panel that runs until the operator
 * quits — inside this guided flow that reads as a hang, and quitting the
 * panel stops the node it started. `-yes` is the node's non-interactive
 * contract (initialize the config with defaults, download Ollama and the
 * models if missing, exit without starting the node), which is exactly the
 * hand-off this flow needs before starting its own supervised node. The
 * operator already consented to the install in the question that got us
 * here. Shelling out rather than reimplementing is the point: there is
 * exactly one description of how a node is configured, and it lives in the
 * node.
 *
 * `-serve=agents` is the other half of the contract. The node this flow
 * provisions exists to serve one agent on this machine; it should not
 * advertise itself over Bonjour or accept connections from the local
 * network, and nobody is at the keyboard to notice if it does. Recent nodes
 * already default to that under `-yes`, but stating it means a change to
 * that default cannot silently widen a node installed on someone's behalf.
 */
const SETUP_ARGS = ["setup", "-yes", "-serve=agents"];

export async function runNodeSetup(
  log: (line: string) => void,
  runner: Runner = systemRunner
): Promise<InstallOutcome> {
  log(
    "Initializing the node for local agents only (first run downloads Ollama and a local model — this can take a while)…"
  );
  let args = SETUP_ARGS;
  let code = await runner.run("onesilo-node", args);
  if (code === FLAG_PARSE_EXIT) {
    // A node predating `-serve` rejects the flag before doing any work. Its
    // `-yes` defaults are loopback-only anyway, so retrying without it is
    // the same outcome, not a weaker one.
    args = ["setup", "-yes"];
    code = await runner.run("onesilo-node", args);
  }
  if (code !== 0) {
    return {
      ok: false,
      detail:
        `\`onesilo-node ${args.join(" ")}\` exited ${code}. Run the node's interactive setup to see what failed:\n` +
        "  onesilo-node setup",
    };
  }
  return { ok: true };
}

/** Go's `flag` package exits 2 on an unrecognized flag. */
const FLAG_PARSE_EXIT = 2;

/** A node process this CLI started and is responsible for stopping. */
export interface SupervisedNode {
  stop(): void;
}

/**
 * Start a node in the background, owned by this process.
 *
 * `setup` configures a node; it does not leave one running, so without this
 * the guided flow dead-ends one step from working. The node is started as a
 * child rather than a launchd/systemd service on purpose: a background
 * service the operator never asked for would outlive the agent, survive
 * reboots, and hold a Cloudflare tunnel open — decisions that belong to
 * whoever runs the machine, which is why the Homebrew formula ships no
 * `service` block either. This node lives exactly as long as `onesilo-buzz`.
 *
 * Output is prefixed rather than inherited so node logs stay
 * distinguishable from agent logs in a single terminal.
 */
export function startNode(log: (line: string) => void): SupervisedNode {
  const child = spawn("onesilo-node", [], { stdio: ["ignore", "pipe", "pipe"] });

  const relay = (stream: NodeJS.ReadableStream | null) => {
    stream?.on("data", (chunk: Buffer) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) log(`[onesilo-node] ${line}`);
      }
    });
  };
  relay(child.stdout);
  relay(child.stderr);

  child.on("error", (err) => log(`[onesilo-node] failed to start: ${err.message}`));

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    // SIGTERM, not SIGKILL: the node flushes and closes its tunnel cleanly.
    child.kill("SIGTERM");
  };
  // Covers the paths that do not run our own signal handlers — a thrown
  // exception, an explicit process.exit. Without it a crashed agent would
  // orphan the node it started.
  process.once("exit", stop);
  return { stop };
}

/**
 * Wait for the node to answer.
 *
 * Polls rather than assuming, so the caller can distinguish "up" from
 * "configured but not listening" instead of enabling node distillation
 * against something that is not there.
 */
export async function waitForNode(
  adminUrl: string,
  timeoutMs = 15_000,
  intervalMs = 1_000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<boolean> {
  const client = new SiloNodeClient(adminUrl, resolveNodeAdminToken(undefined));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await client.health()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
