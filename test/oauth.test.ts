import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSameSecureOrigin, validateDiscoveredEndpoints } from "../src/silo/oauth.js";

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

test("treats localhost and 127.0.0.1 as equivalent loopback origins", () => {
  assert.doesNotThrow(() =>
    assertSameSecureOrigin(
      "token_endpoint",
      "http://localhost:8000",
      "http://127.0.0.1:8000/oauth/token"
    )
  );
});

test("loopback aliasing still requires a matching port", () => {
  assert.throws(
    () =>
      assertSameSecureOrigin(
        "token_endpoint",
        "http://localhost:8000",
        "http://127.0.0.1:9000/oauth/token"
      ),
    /not same-origin/
  );
});

test("rejects a different port as cross-origin", () => {
  assert.throws(
    () => assertSameSecureOrigin("token_endpoint", ISSUER, "https://api.onesilo.com:9999/token"),
    /not same-origin/
  );
});

test("discovery validation tolerates a missing (optional) registration_endpoint", () => {
  assert.doesNotThrow(() =>
    validateDiscoveredEndpoints(ISSUER, {
      authorization_endpoint: "https://api.onesilo.com/authorize",
      token_endpoint: "https://api.onesilo.com/oauth/token",
      // registration_endpoint omitted — optional in RFC 8414
    })
  );
});

test("discovery validation still rejects a cross-origin token_endpoint", () => {
  assert.throws(
    () =>
      validateDiscoveredEndpoints(ISSUER, {
        authorization_endpoint: "https://api.onesilo.com/authorize",
        token_endpoint: "https://evil.example.com/token",
      }),
    /not same-origin/
  );
});
