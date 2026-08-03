import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, configWarnings } from "../src/config.js";

// A minimal env that loads cleanly; individual tests override the node URLs.
function baseEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { SILO_MODE: "node", ...over } as NodeJS.ProcessEnv;
}

test("defaults are loopback and load without error", () => {
  const cfg = loadConfig(baseEnv());
  assert.equal(cfg.node.adminUrl, "http://127.0.0.1:8766");
  assert.equal(cfg.node.lanUrl, "http://127.0.0.1:8765");
});

test("localhost node URLs over http are allowed", () => {
  const cfg = loadConfig(
    baseEnv({ NODE_URL: "http://localhost:9000", NODE_LAN_URL: "http://localhost:9001" })
  );
  assert.equal(cfg.node.adminUrl, "http://localhost:9000");
});

test("a non-loopback node URL is rejected without opt-in", () => {
  assert.throws(
    () => loadConfig(baseEnv({ NODE_URL: "http://evil.example.com:8766" })),
    /non-loopback host/
  );
});

test("a non-loopback LAN URL is rejected without opt-in", () => {
  assert.throws(
    () => loadConfig(baseEnv({ NODE_LAN_URL: "https://evil.example.com" })),
    /non-loopback host/
  );
});

test("NODE_ALLOW_REMOTE permits a remote node only over https", () => {
  const cfg = loadConfig(
    baseEnv({ NODE_URL: "https://node.internal:8766", NODE_ALLOW_REMOTE: "1" })
  );
  assert.equal(cfg.node.adminUrl, "https://node.internal:8766");
});

test("NODE_ALLOW_REMOTE still rejects plaintext http to a remote host", () => {
  assert.throws(
    () => loadConfig(baseEnv({ NODE_URL: "http://node.internal:8766", NODE_ALLOW_REMOTE: "1" })),
    /plaintext/
  );
});

test("mcp mode defaults to the control plane, not the data plane", () => {
  // The OAuth discovery document mints its issuer and endpoints from the
  // control-plane origin, and src/silo/oauth.ts requires the discovered
  // endpoints to be same-origin as the URL discovery was fetched from.
  // Defaulting to the data plane (api.onesilo.com) therefore makes
  // `npm run connect` fail on every fresh checkout.
  const cfg = loadConfig({ SILO_MODE: "mcp" } as NodeJS.ProcessEnv);
  assert.equal(cfg.silo.mode, "mcp");
  assert.equal(
    cfg.silo.mode === "mcp" ? cfg.silo.serverUrl : undefined,
    "https://connect.onesilo.com"
  );
});

test("SILO_SERVER_URL overrides the control-plane default", () => {
  const cfg = loadConfig({
    SILO_MODE: "mcp",
    SILO_SERVER_URL: "https://connect.staging.onesilo.com",
  } as NodeJS.ProcessEnv);
  assert.equal(
    cfg.silo.mode === "mcp" ? cfg.silo.serverUrl : undefined,
    "https://connect.staging.onesilo.com"
  );
});

test("loadDotEnv loads .env from a working directory; exported vars win", async () => {
  const { loadDotEnv } = await import("../src/config.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "buzz-dotenv-"));
  const envPath = join(dir, ".env");
  writeFileSync(
    envPath,
    "BUZZ_TEST_DOTENV_ONLY=from_file\nBUZZ_TEST_DOTENV_BOTH=from_file\n"
  );
  const prevOnly = process.env.BUZZ_TEST_DOTENV_ONLY;
  const prevBoth = process.env.BUZZ_TEST_DOTENV_BOTH;
  delete process.env.BUZZ_TEST_DOTENV_ONLY; // must be unset for the fill-in assertion
  process.env.BUZZ_TEST_DOTENV_BOTH = "from_shell";
  try {
    loadDotEnv(envPath);
    // The file fills in what the shell didn't set…
    assert.equal(process.env.BUZZ_TEST_DOTENV_ONLY, "from_file");
    // …and never overrides what it did (same precedence as node --env-file).
    assert.equal(process.env.BUZZ_TEST_DOTENV_BOTH, "from_shell");
  } finally {
    // Restore, don't blindly delete — the runner's environment may have
    // set these, and clobbering them would leak state into later tests.
    if (prevOnly === undefined) delete process.env.BUZZ_TEST_DOTENV_ONLY;
    else process.env.BUZZ_TEST_DOTENV_ONLY = prevOnly;
    if (prevBoth === undefined) delete process.env.BUZZ_TEST_DOTENV_BOTH;
    else process.env.BUZZ_TEST_DOTENV_BOTH = prevBoth;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDotEnv is a no-op when the file is absent", async () => {
  const { loadDotEnv } = await import("../src/config.js");
  loadDotEnv("/nonexistent/definitely-not-here/.env"); // must not throw
});

test("the default agent handle is OneSilo", () => {
  const cfg = loadConfig({} as NodeJS.ProcessEnv);
  assert.equal(cfg.agentHandle, "OneSilo");
  const overridden = loadConfig({ AGENT_HANDLE: "silo" } as NodeJS.ProcessEnv);
  assert.equal(overridden.agentHandle, "silo");
});

test("node storage implies node distillation, on every entry point", async () => {
  // The trap this closes: DISTILL_MODE defaulted to "cloud" globally, and
  // only `onesilo-buzz run` corrected it. `npm start` with SILO_MODE=node
  // therefore fell back to the agent's keyword heuristics — one turn at a
  // time, no cross-turn context — while a model sat idle on the node.
  const cfg = loadConfig({ SILO_MODE: "node" } as NodeJS.ProcessEnv);
  assert.equal(cfg.distill, "node");
  assert.equal(cfg.memoryMode, "local");
});

test("an explicit DISTILL_MODE still wins over the derived default", () => {
  // It is a legal thing to want, and the config layer is not the place to
  // refuse it — configWarnings() says what it costs instead.
  const cfg = loadConfig({
    SILO_MODE: "node",
    DISTILL_MODE: "cloud",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.distill, "cloud");
  const warnings = configWarnings(cfg, {
    SILO_MODE: "node",
    DISTILL_MODE: "cloud",
  } as NodeJS.ProcessEnv);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /keyword heuristics/);
});

test("a coherent node setup produces no warnings", () => {
  const env = { SILO_MODE: "node" } as NodeJS.ProcessEnv;
  assert.deepEqual(configWarnings(loadConfig(env), env), []);
});

test("MEMORY_MODE expands to the underlying storage and distillation", () => {
  const local = loadConfig({ MEMORY_MODE: "local" } as NodeJS.ProcessEnv);
  assert.equal(local.silo.mode, "node");
  assert.equal(local.distill, "node");

  const hybrid = loadConfig({ MEMORY_MODE: "hybrid" } as NodeJS.ProcessEnv);
  assert.equal(hybrid.silo.mode, "mcp");
  assert.equal(hybrid.distill, "node");

  const cloud = loadConfig({ MEMORY_MODE: "cloud" } as NodeJS.ProcessEnv);
  assert.equal(cloud.silo.mode, "mcp");
  assert.equal(cloud.distill, "cloud");
});

test("the tier is named after where the config landed, not what was asked", () => {
  // Someone who set SILO_MODE/DISTILL_MODE directly — which is most people
  // with an existing .env — should still be told which tier that is.
  assert.equal(
    loadConfig({ SILO_MODE: "mcp", DISTILL_MODE: "node" } as NodeJS.ProcessEnv).memoryMode,
    "hybrid"
  );
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).memoryMode, "cloud");
  assert.equal(
    loadConfig({ SILO_MODE: "local" } as NodeJS.ProcessEnv).memoryMode,
    "local",
    "the on-disk demo store never reaches the control plane either"
  );
});

test("the old variables still win over MEMORY_MODE", () => {
  // They were the interface first and they are sitting in people's .env
  // files; a new knob must not silently override what they already set.
  const cfg = loadConfig({
    MEMORY_MODE: "cloud",
    SILO_MODE: "node",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.silo.mode, "node");
  assert.equal(cfg.memoryMode, "local");
});

test("an unknown MEMORY_MODE is refused rather than silently ignored", () => {
  // Falling back to the default would put memory somewhere the operator
  // did not choose — the one thing this setting exists to control.
  assert.throws(
    () => loadConfig({ MEMORY_MODE: "offline" } as NodeJS.ProcessEnv),
    /must be one of local, hybrid, cloud/
  );
});
