import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSameSecureOrigin } from "../src/silo/oauth.js";

const ISSUER = "https://api.onesilo.com";

test("accepts a same-origin https endpoint", () => {
  assert.doesNotThrow(() =>
    assertSameSecureOrigin("token_endpoint", ISSUER, "https://api.onesilo.com/oauth/token")
  );
});

test("rejects a cross-origin endpoint (the exfiltration case)", () => {
  assert.throws(
    () => assertSameSecureOrigin("token_endpoint", ISSUER, "https://evil.example.com/token"),
    /not same-origin/
  );
});

test("rejects a plaintext http endpoint for an https issuer", () => {
  assert.throws(
    () => assertSameSecureOrigin("token_endpoint", ISSUER, "http://api.onesilo.com/token"),
    /must be https/
  );
});

test("tolerates loopback http for a loopback issuer (dev)", () => {
  assert.doesNotThrow(() =>
    assertSameSecureOrigin(
      "token_endpoint",
      "http://localhost:8000",
      "http://localhost:8000/oauth/token"
    )
  );
});

test("rejects a different port as cross-origin", () => {
  assert.throws(
    () => assertSameSecureOrigin("token_endpoint", ISSUER, "https://api.onesilo.com:9999/token"),
    /not same-origin/
  );
});
