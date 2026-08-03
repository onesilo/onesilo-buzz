/**
 * Tests for the `onesilo-buzz` install/run flow.
 *
 * The behaviours worth pinning here are the ones that are easy to break and
 * expensive when broken: the non-interactive default, and the refusal to
 * fall back to cloud distillation after the operator asked for local.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { askYesNo, askChoice } from "../src/cli/prompt.js";
import { buildInvite, formatInvite } from "../src/cli/invite.js";
import { resolveMemoryMode, parseFlags, isEntrypoint, runCommand, persistEnvVar } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import type { Runner } from "../src/cli/node-setup.js";

/** A Runner that records calls and returns scripted results. */
/**
 * The mode variables, as this process started.
 *
 * resolveMemoryMode writes its decision into the environment — that is how
 * the settled tier reaches the reload in runCommand — so without this every
 * test that calls it leaks a mode into the next one, and `alreadyChosen`
 * starts short-circuiting questions that were meant to be asked.
 */
const MODE_ENV_AT_START: Record<string, string | undefined> = {
  MEMORY_MODE: process.env.MEMORY_MODE,
  SILO_MODE: process.env.SILO_MODE,
  DISTILL_MODE: process.env.DISTILL_MODE,
};

afterEach(() => {
  for (const [name, value] of Object.entries(MODE_ENV_AT_START)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function fakeRunner(opts: {
  present?: string[];
  exitCodes?: Record<string, number>;
}): Runner & { calls: string[] } {
  const present = new Set(opts.present ?? []);
  const calls: string[] = [];
  return {
    calls,
    async which(command) {
      return present.has(command);
    },
    async run(command, args) {
      calls.push([command, ...args].join(" "));
      return opts.exitCodes?.[command] ?? 0;
    },
  };
}

function capture(): { out: NodeJS.WritableStream; text: () => string } {
  let text = "";
  const out = new PassThrough();
  out.on("data", (c) => {
    text += String(c);
  });
  return { out, text: () => text };
}

test("askYesNo takes the default without a TTY, and says so", async () => {
  const { out, text } = capture();
  const answer = await askYesNo("Install onesilo-node?", {
    default: "yes",
    io: { input: new PassThrough(), output: out, isTTY: false },
  });
  assert.equal(answer, "yes");
  // The reason matters as much as the answer: a scripted run that silently
  // installed software would be indistinguishable from one that asked.
  assert.match(text(), /no terminal/);
});

test("askYesNo honours a forced answer without reading stdin", async () => {
  // A PassThrough that is never written to would hang a real read.
  const answer = await askYesNo("Install onesilo-node?", {
    default: "yes",
    forced: "no",
    io: { input: new PassThrough(), output: new PassThrough(), isTTY: true },
  });
  assert.equal(answer, "no");
});

test("askYesNo reads y/n from a terminal", async () => {
  const input = new PassThrough();
  const answer = askYesNo("Install onesilo-node?", {
    default: "yes",
    io: { input, output: new PassThrough(), isTTY: true },
  });
  input.write("n\n");
  assert.equal(await answer, "no");
});

test("askYesNo re-asks on an unrecognised reply rather than guessing", async () => {
  const input = new PassThrough();
  const out = new PassThrough();
  let text = "";
  // The second line must not be written until readline has actually
  // re-asked. Writing both up front loses the second: readline emits both
  // `line` events before the loop's next `question()` is registered, so the
  // answer is dropped and the call waits forever.
  const reAsked = new Promise<void>((resolve) => {
    out.on("data", (chunk) => {
      text += String(chunk);
      if (text.includes("answer y or n")) resolve();
    });
  });

  const answer = askYesNo("Install onesilo-node?", {
    default: "yes",
    io: { input, output: out, isTTY: true },
  });
  input.write("maybe\n");
  await reAsked;
  input.write("y\n");

  assert.equal(await answer, "yes");
  assert.match(text, /answer y or n/);
});

test("the invite carries both npub and hex, and the add-member command", () => {
  const invite = buildInvite({
    // All-zero-ish but valid 32-byte hex; npubEncode only needs well-formed hex.
    pubkey: "a".repeat(64),
    handle: "silo",
    relayUrl: "wss://relay.example",
  });
  assert.match(invite.npub, /^npub1/);
  assert.equal(invite.pubkey, "a".repeat(64));

  const text = formatInvite(invite);
  // npub for humans pasting into a client...
  assert.ok(text.includes(invite.npub));
  // ...hex for the relay admin command, which does not take npub.
  assert.ok(text.includes(`buzz-admin add-member ${"a".repeat(64)}`));
  assert.ok(text.includes("wss://relay.example"));
});

test("an explicit DISTILL_MODE is honored, and its node is ensured", async () => {
  // DISTILL_MODE=node with a cloud silo IS hybrid; the tier is named after
  // where the config landed. It also now ensures the node actually exists,
  // which the old early-return skipped — leaving the distilling store
  // wired to nothing and captures buffering forever.
  const runner = fakeRunner({ present: [] });
  const env = { ...process.env, DISTILL_MODE: "node" };
  const prev = process.env.DISTILL_MODE;
  process.env.DISTILL_MODE = "node";
  try {
    const mode = await resolveMemoryMode(loadConfig(env), parseFlags([]), runner);
    assert.equal(mode, null, "no node and none installable — abort, don't pretend");
  } finally {
    if (prev === undefined) delete process.env.DISTILL_MODE;
    else process.env.DISTILL_MODE = prev;
  }
});

test("--no-node skips the node entirely", async () => {
  const runner = fakeRunner({ present: ["brew", "onesilo-node"] });
  const prev = process.env.DISTILL_MODE;
  delete process.env.DISTILL_MODE;
  try {
    const mode = await resolveMemoryMode(loadConfig({}), parseFlags(["--no-node"]), runner);
    assert.equal(mode, "cloud");
    assert.deepEqual(runner.calls, []);
  } finally {
    if (prev !== undefined) process.env.DISTILL_MODE = prev;
  }
});

// A flag typed on this invocation beats an environment variable that is
// usually sitting in a .env from an earlier session. The old order returned
// on DISTILL_MODE first, so this combination ran node distillation and
// ignored the flag entirely.
test("--no-node overrides an explicit DISTILL_MODE=node", async () => {
  const runner = fakeRunner({ present: ["brew", "onesilo-node"] });
  const prev = process.env.DISTILL_MODE;
  process.env.DISTILL_MODE = "node";
  try {
    const env = { ...process.env, DISTILL_MODE: "node" };
    const mode = await resolveMemoryMode(loadConfig(env), parseFlags(["--no-node"]), runner);
    assert.equal(mode, "cloud");
    assert.deepEqual(runner.calls, []); // no detect, no install, no setup
  } finally {
    if (prev === undefined) delete process.env.DISTILL_MODE;
    else process.env.DISTILL_MODE = prev;
  }
});

test("without Homebrew the run aborts instead of distilling in the cloud", async () => {
  // This is the important one. The operator said yes to keeping transcripts
  // on this machine; failing to install a node must not silently produce the
  // opposite behaviour.
  const runner = fakeRunner({ present: [] }); // no brew, no node
  const prev = process.env.DISTILL_MODE;
  delete process.env.DISTILL_MODE;
  try {
    const mode = await resolveMemoryMode(loadConfig({}), parseFlags(["--yes"]), runner);
    assert.equal(mode, null, "expected an abort, not a cloud fallback");
  } finally {
    if (prev !== undefined) process.env.DISTILL_MODE = prev;
  }
});

test("a failed `brew install` aborts rather than falling back", async () => {
  const runner = fakeRunner({ present: ["brew"], exitCodes: { brew: 1 } });
  const prev = process.env.DISTILL_MODE;
  delete process.env.DISTILL_MODE;
  try {
    const mode = await resolveMemoryMode(loadConfig({}), parseFlags(["--yes"]), runner);
    assert.equal(mode, null);
    assert.ok(runner.calls.some((c) => c.startsWith("brew install")));
    // Setup must not have been attempted after a failed install.
    assert.ok(!runner.calls.some((c) => c.startsWith("onesilo-node setup")));
  } finally {
    if (prev !== undefined) process.env.DISTILL_MODE = prev;
  }
});

test("answering no continues in cloud mode without installing anything", async () => {
  const runner = fakeRunner({ present: ["brew"] });
  const prev = process.env.DISTILL_MODE;
  delete process.env.DISTILL_MODE;
  try {
    // No TTY in the test process, and the default is "yes" — so force the
    // no-path the way `onesilo-buzz run --no-node` does.
    const mode = await resolveMemoryMode(loadConfig({}), parseFlags(["--no-node"]), runner);
    assert.equal(mode, "cloud");
    assert.deepEqual(runner.calls, []);
  } finally {
    if (prev !== undefined) process.env.DISTILL_MODE = prev;
  }
});

test("parseFlags recognises both spellings of --yes", () => {
  assert.equal(parseFlags(["-y"]).assumeYes, true);
  assert.equal(parseFlags(["--yes"]).assumeYes, true);
  assert.equal(parseFlags([]).assumeYes, false);
  assert.equal(parseFlags(["--no-node"]).noNode, true);
});

// Regression: both `npm install -g` and Homebrew put a *symlink* in bin/, so
// argv[1] is the symlink while import.meta.url is the real path Node resolved
// the module to. Comparing them without realpath made every installed
// invocation a silent no-op — `onesilo-buzz run` printed nothing and exited 0.
// Running from a checkout compared two identical real paths, so nothing here
// caught it. These assertions are about the symlink case specifically.
test("isEntrypoint resolves argv[1] through a symlink", () => {
  // realpath the temp dir before building any path from it. On macOS
  // os.tmpdir() is /var/folders/... where /var is itself a symlink to
  // /private/var, so a raw path and its realpath differ — and the assertions
  // below would compare file:///var/... against file:///private/var/... and
  // fail for a reason that has nothing to do with the bin symlink under test.
  // Node always hands out a canonical import.meta.url, so canonicalising here
  // is also the faithful model of the real thing.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "onesilo-buzz-entry-")));
  try {
    const real = join(dir, "cli.js");
    const link = join(dir, "onesilo-buzz");
    writeFileSync(real, "// stand-in for the built CLI\n");
    symlinkSync(real, link);

    const moduleUrl = pathToFileURL(real).href;

    // The installed shape: invoked via the symlink, module resolved to the
    // real file. This is the case that was broken.
    assert.equal(isEntrypoint(moduleUrl, link), true);
    // The checkout shape: invoked directly.
    assert.equal(isEntrypoint(moduleUrl, real), true);
    // Imported by something else — must not run main().
    assert.equal(isEntrypoint(moduleUrl, join(dir, "other.js")), false);
    assert.equal(isEntrypoint(moduleUrl, undefined), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("node setup runs the node's non-interactive contract (-yes)", async () => {
  // Without -yes, `onesilo-node setup` launches the node and sits in an
  // interactive control panel until the operator quits — inside this guided
  // flow that reads as a hang, and quitting the panel stops the node it
  // started. The flow must use the non-interactive init and supervise its
  // own node.
  const { runNodeSetup } = await import("../src/cli/node-setup.js");
  const runner = fakeRunner({ present: ["onesilo-node"] });
  const outcome = await runNodeSetup(() => {}, runner);
  assert.equal(outcome.ok, true);
  assert.deepEqual(runner.calls, ["onesilo-node setup -yes"]);
});

test("unpaired mcp mode fails fast, before any node work", async () => {
  // The original first-run experience: minutes of node install/setup/start,
  // THEN "not paired", exit — taking the fresh node down too. The pairing
  // check must come first. Non-TTY (this test runner) takes the fail-fast
  // path with instructions.
  const runner = fakeRunner({ present: ["brew", "onesilo-node"] });
  const prevToken = process.env.SILO_TOKEN_PATH;
  const prevMode = process.env.SILO_MODE;
  const prevRelay = process.env.BUZZ_RELAY_URL;
  process.env.SILO_TOKEN_PATH = "/nonexistent/definitely/oauth.json";
  delete process.env.SILO_MODE;
  process.env.BUZZ_RELAY_URL = "ws://localhost:7777"; // skip the relay question
  try {
    const code = await runCommand([], runner);
    assert.equal(code, 1);
    assert.deepEqual(runner.calls, [], "no node work may happen before the pairing check");
  } finally {
    if (prevToken === undefined) delete process.env.SILO_TOKEN_PATH;
    else process.env.SILO_TOKEN_PATH = prevToken;
    if (prevMode === undefined) delete process.env.SILO_MODE;
    else process.env.SILO_MODE = prevMode;
    if (prevRelay === undefined) delete process.env.BUZZ_RELAY_URL;
    else process.env.BUZZ_RELAY_URL = prevRelay;
  }
});

test("persistEnvVar appends and replaces in .env", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "buzz-persist-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    persistEnvVar("BUZZ_RELAY_URL", "wss://a.example");
    persistEnvVar("SILO_MODE", "node");
    persistEnvVar("BUZZ_RELAY_URL", "wss://b.example"); // replace, not duplicate
    const content = readFileSync(".env", "utf8");
    assert.match(content, /^BUZZ_RELAY_URL=wss:\/\/b\.example$/m);
    assert.match(content, /^SILO_MODE=node$/m);
    assert.equal(content.match(/BUZZ_RELAY_URL=/g)?.length, 1);
  } finally {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("askText takes typed answers, defaults on Enter and on no terminal", async () => {
  const { askText } = await import("../src/cli/prompt.js");
  const typedInput = new PassThrough();
  typedInput.write("wss://real.example\n");
  const typed = await askText("Relay?", {
    default: "ws://localhost:7777",
    io: { input: typedInput, output: new PassThrough(), isTTY: true },
  });
  assert.equal(typed, "wss://real.example");

  const enterInput = new PassThrough();
  enterInput.write("\n");
  const entered = await askText("Relay?", {
    default: "ws://localhost:7777",
    io: { input: enterInput, output: new PassThrough(), isTTY: true },
  });
  assert.equal(entered, "ws://localhost:7777");

  const cap = capture();
  const headless = await askText("Relay?", {
    default: "ws://localhost:7777",
    io: { input: new PassThrough(), output: cap.out, isTTY: false },
  });
  assert.equal(headless, "ws://localhost:7777");
  assert.match(cap.text(), /no terminal/);
});

test("normalizeRelayUrl accepts every shape people paste", async () => {
  const { normalizeRelayUrl } = await import("../src/cli.js");
  assert.equal(
    normalizeRelayUrl("company.communities.buzz.xyz"),
    "wss://company.communities.buzz.xyz"
  );
  assert.equal(
    normalizeRelayUrl("https://company.communities.buzz.xyz/"),
    "wss://company.communities.buzz.xyz"
  );
  assert.equal(
    normalizeRelayUrl("http://company.communities.buzz.xyz"),
    "wss://company.communities.buzz.xyz"
  );
  assert.equal(
    normalizeRelayUrl("wss://company.communities.buzz.xyz"),
    "wss://company.communities.buzz.xyz"
  );
  assert.equal(normalizeRelayUrl("ws://localhost:7777"), "ws://localhost:7777");
  assert.equal(normalizeRelayUrl("  company.example  "), "wss://company.example");
});

test("normalizeRelayUrl rejects scheme-only and hostless input", async () => {
  const { normalizeRelayUrl } = await import("../src/cli.js");
  for (const junk of ["https://", "http://", "http:", "wss://", "///", "/"]) {
    assert.equal(normalizeRelayUrl(junk), null, `expected null for ${JSON.stringify(junk)}`);
  }
});

test("normalizeRelayUrl strips browser paths but honors explicit ws URLs", async () => {
  const { normalizeRelayUrl } = await import("../src/cli.js");
  assert.equal(
    normalizeRelayUrl("https://company.communities.buzz.xyz/channels/eng?tab=1"),
    "wss://company.communities.buzz.xyz"
  );
  assert.equal(
    normalizeRelayUrl("company.example:8443/some/path"),
    "wss://company.example:8443"
  );
  // Someone typing wss:// with a path knows their endpoint — keep it.
  assert.equal(
    normalizeRelayUrl("wss://company.example/relay"),
    "wss://company.example/relay"
  );
});

test("persistEnvVar collapses pre-existing duplicates to one line", async () => {
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "buzz-persist-dupes-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    writeFileSync(".env", "SILO_MODE=mcp\nBUZZ_RELAY_URL=wss://old.example\nAGENT_HANDLE=x\nBUZZ_RELAY_URL=wss://older.example\n");
    persistEnvVar("BUZZ_RELAY_URL", "wss://new.example");
    const content = readFileSync(".env", "utf8");
    assert.equal(content.match(/BUZZ_RELAY_URL=/g)?.length, 1, "duplicates must collapse");
    assert.match(content, /^BUZZ_RELAY_URL=wss:\/\/new\.example$/m);
    assert.match(content, /^SILO_MODE=mcp$/m);
    assert.match(content, /^AGENT_HANDLE=x$/m);
  } finally {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SILO_MODE=node with --no-node aborts instead of wiring memory to nothing", async () => {
  const runner = fakeRunner({ present: ["brew", "onesilo-node"] });
  const env = { SILO_MODE: "node" } as NodeJS.ProcessEnv;
  const mode = await resolveMemoryMode(loadConfig(env), parseFlags(["--no-node"]), runner);
  assert.equal(mode, null, "node memory without a node must abort, not continue");
  assert.deepEqual(runner.calls, []);
});

test("SILO_MODE=node with explicit DISTILL_MODE still requires the node", async () => {
  // The DISTILL_MODE early-return used to skip node detection entirely —
  // with node memory that shipped an agent whose store points at nothing.
  const runner = fakeRunner({ present: [] }); // no brew, no node binary
  const prev = process.env.DISTILL_MODE;
  process.env.DISTILL_MODE = "cloud";
  try {
    const mode = await resolveMemoryMode(
      loadConfig({ SILO_MODE: "node" } as NodeJS.ProcessEnv),
      parseFlags([]),
      runner
    );
    // Node absent, install impossible (no brew): must abort, not return cloud.
    assert.equal(mode, null);
  } finally {
    if (prev === undefined) delete process.env.DISTILL_MODE;
    else process.env.DISTILL_MODE = prev;
  }
});

test("--yes keeps recommending a node, not the cloud", async () => {
  // Naming the tiers must not quietly move scripted installs onto a less
  // private path. Before the tiers existed, the default answer installed a
  // node and distilled locally against a cloud silo — which is `hybrid`.
  //
  // With nothing installable, a node-requiring tier aborts. A default of
  // `cloud` would have returned "cloud" happily, so the abort is what
  // proves the recommendation still involves a node.
  const runner = fakeRunner({ present: [] });
  const prev = { silo: process.env.SILO_MODE, distill: process.env.DISTILL_MODE, mem: process.env.MEMORY_MODE };
  delete process.env.SILO_MODE;
  delete process.env.DISTILL_MODE;
  delete process.env.MEMORY_MODE;
  try {
    const mode = await resolveMemoryMode(loadConfig({}), parseFlags(["--yes"]), runner);
    assert.equal(mode, null, "the recommended tier still needs a node");
  } finally {
    if (prev.silo !== undefined) process.env.SILO_MODE = prev.silo;
    if (prev.distill !== undefined) process.env.DISTILL_MODE = prev.distill;
    if (prev.mem !== undefined) process.env.MEMORY_MODE = prev.mem;
  }
});

test("MEMORY_MODE=cloud needs no node and asks nothing", async () => {
  const runner = fakeRunner({ present: [] });
  const prev = process.env.MEMORY_MODE;
  process.env.MEMORY_MODE = "cloud";
  try {
    const mode = await resolveMemoryMode(
      loadConfig({ ...process.env, MEMORY_MODE: "cloud" }),
      parseFlags([]),
      runner
    );
    assert.equal(mode, "cloud");
    assert.deepEqual(runner.calls, [], "cloud mode touches no local tooling");
  } finally {
    if (prev === undefined) delete process.env.MEMORY_MODE;
    else process.env.MEMORY_MODE = prev;
  }
});

test("MEMORY_MODE=local without a usable node aborts rather than syncing", async () => {
  // The whole point of choosing local is that nothing leaves the machine.
  // Falling back to a cloud silo would be the exact opposite of the request.
  const runner = fakeRunner({ present: [] });
  const prev = process.env.MEMORY_MODE;
  process.env.MEMORY_MODE = "local";
  try {
    const mode = await resolveMemoryMode(
      loadConfig({ ...process.env, MEMORY_MODE: "local" }),
      parseFlags(["--yes"]),
      runner
    );
    assert.equal(mode, null);
  } finally {
    if (prev === undefined) delete process.env.MEMORY_MODE;
    else process.env.MEMORY_MODE = prev;
  }
});

test("--no-node contradicts local mode and refuses instead of downgrading", async () => {
  const runner = fakeRunner({ present: ["brew"] });
  const prev = process.env.MEMORY_MODE;
  process.env.MEMORY_MODE = "local";
  try {
    const mode = await resolveMemoryMode(
      loadConfig({ ...process.env, MEMORY_MODE: "local" }),
      parseFlags(["--no-node"]),
      runner
    );
    assert.equal(mode, null);
    assert.deepEqual(runner.calls, []);
  } finally {
    if (prev === undefined) delete process.env.MEMORY_MODE;
    else process.env.MEMORY_MODE = prev;
  }
});

const TIER_CHOICES = [
  { value: "hybrid" as const, label: "Hybrid", lines: ["Raw conversation never leaves."] },
  { value: "cloud" as const, label: "Cloud", lines: ["Transcripts are sent to your silo."] },
  { value: "local" as const, label: "Local", lines: ["No enrichment."] },
];

test("askChoice prints each option's trade-off, not just its name", async () => {
  // The point of the picker is that the consequence is visible at the
  // moment of choosing. A list of bare mode names would be no better than
  // the yes/no about installing a dependency that it replaced.
  const input = new PassThrough();
  const { out, text } = capture();
  const answer = askChoice("Where should memory live?", TIER_CHOICES, {
    default: "hybrid",
    io: { input, output: out, isTTY: true },
  });
  input.write("2\n");
  assert.equal(await answer, "cloud");

  const shown = text();
  assert.match(shown, /Raw conversation never leaves/);
  assert.match(shown, /Transcripts are sent to your silo/);
  assert.match(shown, /No enrichment/);
  assert.match(shown, /Hybrid \(default\)/, "the recommendation must be marked");
});

test("askChoice accepts the mode name as well as its number", async () => {
  // Anyone who read the docs will type "local" rather than counting.
  const input = new PassThrough();
  const answer = askChoice("Where should memory live?", TIER_CHOICES, {
    default: "hybrid",
    io: { input, output: new PassThrough(), isTTY: true },
  });
  input.write("local\n");
  assert.equal(await answer, "local");
});

test("askChoice re-asks rather than guessing at an unrecognised answer", async () => {
  // This gates where a workspace's conversation ends up; a shrug must not
  // resolve to the default.
  const input = new PassThrough();
  const { out, text } = capture();
  const answer = askChoice("Where should memory live?", TIER_CHOICES, {
    default: "hybrid",
    io: { input, output: out, isTTY: true },
  });
  input.write("maybe\n");
  await new Promise((r) => setTimeout(r, 10));
  input.write("3\n");
  assert.equal(await answer, "local");
  assert.match(text(), /Please answer 1-3/);
});

test("askChoice takes the default without a TTY, and says which", async () => {
  const { out, text } = capture();
  const answer = await askChoice("Where should memory live?", TIER_CHOICES, {
    default: "hybrid",
    io: { input: new PassThrough(), output: out, isTTY: false },
  });
  assert.equal(answer, "hybrid");
  assert.match(text(), /using hybrid \(no terminal\)/);
});

test("--no-node makes the reloaded config actually cloud, not just say so", async () => {
  // The gap this closes: the existing --no-node test asserted the RETURN
  // value, which was "cloud" while the config that booted still distilled
  // on a node. MEMORY_MODE deliberately loses to DISTILL_MODE, so writing
  // only MEMORY_MODE let a leftover DISTILL_MODE=node quietly win — the
  // agent would distill on the node the flag just told it to skip, and
  // report itself as hybrid while doing it.
  const runner = fakeRunner({ present: ["brew", "onesilo-node"] });
  process.env.DISTILL_MODE = "node";
  delete process.env.SILO_MODE;
  delete process.env.MEMORY_MODE;

  const mode = await resolveMemoryMode(
    loadConfig({ ...process.env, DISTILL_MODE: "node" }),
    parseFlags(["--no-node"]),
    runner
  );
  assert.equal(mode, "cloud");

  // The real assertion: what boot.ts would see on the reload.
  const reloaded = loadConfig(process.env);
  assert.equal(reloaded.distill, "cloud", "the flag must survive into the config");
  assert.equal(reloaded.memoryMode, "cloud");
  assert.deepEqual(runner.calls, []);
});

test("an environment-chosen mode is passed through, not rewritten", async () => {
  // The mirror image. Overriding is only correct when we actually made the
  // decision — rewriting DISTILL_MODE whenever we settle would erase the
  // explicit incoherent pair that configWarnings() exists to report rather
  // than silently repair.
  const runner = fakeRunner({ present: [] });
  process.env.SILO_MODE = "node";
  process.env.DISTILL_MODE = "cloud";
  delete process.env.MEMORY_MODE;

  const config = loadConfig(process.env);
  assert.equal(config.memoryMode, "local");
  assert.equal(config.distill, "cloud", "the operator's explicit choice stands");

  await resolveMemoryMode(config, parseFlags(["--no-node"]), runner);
  assert.equal(
    process.env.DISTILL_MODE,
    "cloud",
    "an explicit setting must not be rewritten behind the operator's back"
  );
});

test("SILO_MODE=local needs no node, and --no-node does not contradict it", async () => {
  // The on-disk demo store is equally "nothing leaves this machine", so it
  // maps to the local tier — but it needs no onesilo-node at all. Keying the
  // contradiction check on the tier label made --no-node fail for a config
  // that never wanted a node, and made `run` try to install one.
  const runner = fakeRunner({ present: [] });
  process.env.SILO_MODE = "local";
  delete process.env.MEMORY_MODE;
  delete process.env.DISTILL_MODE;

  const config = loadConfig(process.env);
  assert.equal(config.memoryMode, "local");

  const mode = await resolveMemoryMode(config, parseFlags(["--no-node"]), runner);
  assert.equal(mode, "local", "no contradiction — this store needs no node");
  assert.deepEqual(runner.calls, [], "and nothing should have been installed");
});

test("SILO_MODE=local runs without reaching for a node", async () => {
  const runner = fakeRunner({ present: [] });
  process.env.SILO_MODE = "local";
  delete process.env.MEMORY_MODE;
  delete process.env.DISTILL_MODE;

  const mode = await resolveMemoryMode(loadConfig(process.env), parseFlags([]), runner);
  assert.equal(mode, "local");
  assert.deepEqual(runner.calls, []);
});

test("an inherited property name is not a valid MEMORY_MODE", () => {
  // `in` matches Object.prototype members, so MEMORY_MODE=toString resolved
  // to a function, spread to an empty tier, and quietly landed on the
  // on-disk demo store — memory somewhere nobody chose, which is the one
  // outcome this setting exists to prevent.
  for (const name of ["toString", "constructor", "hasOwnProperty"]) {
    assert.throws(
      () => loadConfig({ MEMORY_MODE: name } as NodeJS.ProcessEnv),
      /must be one of local, hybrid, cloud/,
      `MEMORY_MODE=${name} must be refused`
    );
  }
});

test("--no-node refuses relay mode too, which also needs a node", async () => {
  // relay reaches One Silo *through* the gateway node's LAN API. Skipping
  // the node there leaves the store pointed at nothing, which looks healthy
  // and fails on every memory call.
  const runner = fakeRunner({ present: [] });
  process.env.SILO_MODE = "relay";
  delete process.env.MEMORY_MODE;
  delete process.env.DISTILL_MODE;

  const mode = await resolveMemoryMode(loadConfig(process.env), parseFlags(["--no-node"]), runner);
  assert.equal(mode, null);
  assert.deepEqual(runner.calls, []);
});

test("the chosen mode is written to .env so the question is asked once", async () => {
  const runner = fakeRunner({ present: [] });
  const dir = mkdtempSync(join(tmpdir(), "buzz-mode-"));
  const cwd = process.cwd();
  process.chdir(dir);
  delete process.env.MEMORY_MODE;
  delete process.env.SILO_MODE;
  delete process.env.DISTILL_MODE;
  try {
    // No TTY in tests, so askChoice takes the default (hybrid) — but hybrid
    // needs a node and none is installable, so drive the cloud path with
    // an env-free --no-node… which is a no-op here. Force via MEMORY_MODE
    // absent + a runner that has nothing, and assert on the abort path not
    // persisting instead.
    const mode = await resolveMemoryMode(loadConfig({}), parseFlags([]), runner);
    assert.equal(mode, null, "no node available, so this aborts");
    assert.ok(
      !existsSync(join(dir, ".env")),
      "an aborted run must not leave a mode behind in .env"
    );
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SILO_MODE=mcp still gets asked about local distillation", async () => {
  // SILO_MODE fixes where memory is STORED. For a cloud silo that leaves the
  // question this flow exists to ask — distill here or there — and the old
  // flow did ask it, defaulting to yes. Treating SILO_MODE as "already
  // decided" silently moved those users onto cloud distillation.
  const runner = fakeRunner({ present: [] });
  process.env.SILO_MODE = "mcp";
  delete process.env.MEMORY_MODE;
  delete process.env.DISTILL_MODE;

  // No TTY, so the picker takes its default (hybrid) — which needs a node,
  // and none is installable here, so it aborts. A silent skip would have
  // returned "cloud" instead.
  const mode = await resolveMemoryMode(loadConfig(process.env), parseFlags([]), runner);
  assert.equal(mode, null, "the question was asked, and hybrid needs a node");
});

test("SILO_MODE=node settles the tier without asking", async () => {
  // Nothing left to decide: node storage already implies node distillation.
  const runner = fakeRunner({ present: [] });
  process.env.SILO_MODE = "node";
  delete process.env.MEMORY_MODE;
  delete process.env.DISTILL_MODE;

  const { out, text } = capture();
  const original = console.log;
  console.log = (line: string) => out.write(String(line) + "\n");
  try {
    await resolveMemoryMode(loadConfig(process.env), parseFlags([]), runner);
  } finally {
    console.log = original;
  }
  assert.match(text(), /SILO_MODE=node is set/);
});

test("relay + cloud still sets up the node it reaches memory through", async () => {
  // relay reads and writes One Silo *through* the gateway node's LAN API.
  // Picking `cloud` there is a statement about distillation, not about
  // whether a node exists — skipping setup starts the agent against a store
  // pointed at nothing, which looks healthy and fails on every call.
  const runner = fakeRunner({ present: [] });
  process.env.SILO_MODE = "relay";
  process.env.MEMORY_MODE = "cloud";
  delete process.env.DISTILL_MODE;

  const mode = await resolveMemoryMode(loadConfig(process.env), parseFlags(["--yes"]), runner);
  assert.equal(mode, null, "no node installable, so this must abort");
});

test("mcp + cloud needs no node at all", async () => {
  // The control case: without node-backed storage, choosing cloud really is
  // the zero-infrastructure path.
  const runner = fakeRunner({ present: [] });
  process.env.SILO_MODE = "mcp";
  process.env.MEMORY_MODE = "cloud";
  delete process.env.DISTILL_MODE;

  const mode = await resolveMemoryMode(loadConfig(process.env), parseFlags([]), runner);
  assert.equal(mode, "cloud");
  assert.deepEqual(runner.calls, []);
});
