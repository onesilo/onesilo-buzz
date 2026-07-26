import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentSecretKeyHex } from "../src/buzz/identity.js";

const VALID = "a".repeat(64); // 64 hex chars

test("env value takes precedence over a persisted file", () => {
  const dir = mkdtempSync(join(tmpdir(), "id-"));
  const path = join(dir, "agent.key");
  writeFileSync(path, "b".repeat(64));
  const r = resolveAgentSecretKeyHex(VALID, path);
  assert.equal(r.hex, VALID);
  assert.equal(r.fromFile, false);
});

test("a persisted file is loaded when env is unset (the stable-identity path)", () => {
  const dir = mkdtempSync(join(tmpdir(), "id-"));
  const path = join(dir, "agent.key");
  writeFileSync(path, VALID + "\n");
  const r = resolveAgentSecretKeyHex(undefined, path);
  assert.equal(r.hex, VALID);
  assert.equal(r.fromFile, true);
});

test("no env and no file → undefined (caller generates + persists)", () => {
  const dir = mkdtempSync(join(tmpdir(), "id-"));
  const r = resolveAgentSecretKeyHex(undefined, join(dir, "missing.key"));
  assert.equal(r.hex, undefined);
  assert.equal(r.fromFile, false);
});

test("an existing but invalid key file throws (never silently overwritten)", () => {
  const dir = mkdtempSync(join(tmpdir(), "id-"));
  const path = join(dir, "agent.key");
  writeFileSync(path, "not-a-valid-hex-key");
  assert.throws(() => resolveAgentSecretKeyHex(undefined, path), /not a valid 64-char hex key/);
});

test("an unreadable key file throws rather than being overwritten", () => {
  // A directory at the key path makes readFileSync fail (EISDIR), standing
  // in for a permission failure — the resolver must throw, not regenerate.
  const dir = mkdtempSync(join(tmpdir(), "id-"));
  const path = join(dir, "agent.key");
  mkdirSync(path);
  assert.throws(() => resolveAgentSecretKeyHex(undefined, path), /Cannot read agent key file/);
});

test("a malformed AGENT_SECRET_KEY env throws a clear error", () => {
  assert.throws(() => resolveAgentSecretKeyHex("too-short", "/nonexistent"), /64 hex characters/);
});
