import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSameSecureOrigin,
  validateDiscoveredEndpoints,
  buildAuthorizeUrl,
} from "../src/silo/oauth.js";

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

test("the authorize request asks for offline_access", () => {
  // Without this the control plane issues no refresh token
  // (app/services/oauth_server.py: `if "offline_access" in scope`) and the
  // agent silently stops working when its access token expires. Pairing
  // still succeeds without it, so nothing else catches the omission.
  const url = buildAuthorizeUrl("https://connect.onesilo.com/oauth/authorize", {
    clientId: "client-123",
    redirectUri: "http://127.0.0.1:8765/callback",
    codeChallenge: "challenge",
    state: "state",
  });
  assert.equal(url.searchParams.get("scope"), "offline_access");
});

test("the authorize request carries PKCE and the loopback redirect", () => {
  const url = buildAuthorizeUrl("https://connect.onesilo.com/oauth/authorize", {
    clientId: "client-123",
    redirectUri: "http://127.0.0.1:8765/callback",
    codeChallenge: "the-challenge",
    state: "the-state",
  });
  assert.equal(url.origin + url.pathname, "https://connect.onesilo.com/oauth/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "client-123");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:8765/callback");
  assert.equal(url.searchParams.get("code_challenge"), "the-challenge");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "the-state");
});

test("a corrupt token file names the file and the fix, not a JSON stack", async () => {
  const { SiloOAuthClient } = await import("../src/silo/oauth.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "buzz-oauth-corrupt-"));
  const tokenPath = join(dir, "oauth.json");
  writeFileSync(tokenPath, "{ not json");
  try {
    assert.throws(
      () =>
        new SiloOAuthClient({
          serverUrl: "https://connect.onesilo.com",
          agentHandle: "OneSilo",
          tokenPath,
        }),
      (err: Error) =>
        err.message.includes(tokenPath) && err.message.includes("onesilo-buzz connect")
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
