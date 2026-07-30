/**
 * Tests for the `onesilo-buzz` install/run flow.
 *
 * The behaviours worth pinning here are the ones that are easy to break and
 * expensive when broken: the non-interactive default, and the refusal to
 * fall back to cloud distillation after the operator asked for local.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { askYesNo } from "../src/cli/prompt.js";
import { buildInvite, formatInvite } from "../src/cli/invite.js";
import { resolveDistillMode, parseFlags, isEntrypoint } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import type { Runner } from "../src/cli/node-setup.js";

/** A Runner that records calls and returns scripted results. */
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

test("an explicit DISTILL_MODE is left alone and asks nothing", async () => {
  const runner = fakeRunner({ present: [] });
  const env = { ...process.env, DISTILL_MODE: "node" };
  const prev = process.env.DISTILL_MODE;
  process.env.DISTILL_MODE = "node";
  try {
    const mode = await resolveDistillMode(loadConfig(env), parseFlags([]), runner);
    assert.equal(mode, "node");
    assert.deepEqual(runner.calls, []); // nothing installed, nothing set up
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
    const mode = await resolveDistillMode(loadConfig({}), parseFlags(["--no-node"]), runner);
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
    const mode = await resolveDistillMode(loadConfig(env), parseFlags(["--no-node"]), runner);
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
    const mode = await resolveDistillMode(loadConfig({}), parseFlags(["--yes"]), runner);
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
    const mode = await resolveDistillMode(loadConfig({}), parseFlags(["--yes"]), runner);
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
    const mode = await resolveDistillMode(loadConfig({}), parseFlags(["--no-node"]), runner);
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
  const dir = mkdtempSync(join(tmpdir(), "onesilo-buzz-entry-"));
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
