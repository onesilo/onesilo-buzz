import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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

test("a corrupt key file is ignored (regenerate rather than crash)", () => {
  const dir = mkdtempSync(join(tmpdir(), "id-"));
  const path = join(dir, "agent.key");
  writeFileSync(path, "not-a-valid-hex-key");
  const r = resolveAgentSecretKeyHex(undefined, path);
  assert.equal(r.hex, undefined);
});
