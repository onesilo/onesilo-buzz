import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SiloNodeClient,
  NodeUnavailableError,
  resolveNodeAdminToken,
} from "../src/node/client.js";

function startFakeNode(
  handler: (req: { method: string; url: string; auth: string; body: string }) => {
    status: number;
    body: unknown;
  }
): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const out = handler({
          method: req.method ?? "",
          url: req.url ?? "",
          auth: req.headers.authorization ?? "",
          body,
        });
        res.writeHead(out.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out.body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

test("generate sends the admin token and parses the response", async () => {
  const seen: { auth?: string; body?: unknown } = {};
  const { server, url } = await startFakeNode((req) => {
    if (req.url === "/v1/compute/generate") {
      seen.auth = req.auth;
      seen.body = JSON.parse(req.body);
      return { status: 200, body: { text: "decision: ship Friday", model: "llama3.2:3b" } };
    }
    return { status: 404, body: { error: "not found" } };
  });
  try {
    const client = new SiloNodeClient(url, "tok-123");
    const result = await client.generate("distill this", 0.1);
    assert.equal(result.text, "decision: ship Friday");
    assert.equal(result.model, "llama3.2:3b");
    assert.equal(seen.auth, "Bearer tok-123");
    assert.deepEqual(seen.body, { prompt: "distill this", temperature: 0.1 });
  } finally {
    server.close();
  }
});

test("503 (compute down) maps to NodeUnavailableError", async () => {
  const { server, url } = await startFakeNode(() => ({
    status: 503,
    body: { error: "compute capability not running" },
  }));
  try {
    const client = new SiloNodeClient(url, "tok");
    await assert.rejects(client.generate("p"), NodeUnavailableError);
  } finally {
    server.close();
  }
});

test("connection refused maps to NodeUnavailableError", async () => {
  const client = new SiloNodeClient("http://127.0.0.1:1", "tok");
  await assert.rejects(client.generate("p"), NodeUnavailableError);
  assert.equal(await client.health(), false);
});

test("401 is a configuration error, not an unavailability", async () => {
  const { server, url } = await startFakeNode(() => ({
    status: 401,
    body: { error: "missing or invalid token" },
  }));
  try {
    const client = new SiloNodeClient(url, "wrong");
    await assert.rejects(client.generate("p"), (err: Error) => {
      assert.ok(!(err instanceof NodeUnavailableError));
      assert.match(err.message, /NODE_ADMIN_TOKEN|onesilo-node setup/);
      return true;
    });
  } finally {
    server.close();
  }
});

test("health() is true against a live node", async () => {
  const { server, url } = await startFakeNode((req) =>
    req.url === "/healthz" ? { status: 200, body: { ok: true } } : { status: 404, body: {} }
  );
  try {
    assert.equal(await new SiloNodeClient(url, "").health(), true);
  } finally {
    server.close();
  }
});

test("resolveNodeAdminToken: env wins, file fallback, empty otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "node-token-"));
  const tokenPath = join(dir, "admin.token");
  writeFileSync(tokenPath, "file-token\n");
  assert.equal(resolveNodeAdminToken("env-token", tokenPath), "env-token");
  assert.equal(resolveNodeAdminToken(undefined, tokenPath), "file-token");
  assert.equal(resolveNodeAdminToken("  ", tokenPath), "file-token");
  assert.equal(resolveNodeAdminToken(undefined, join(dir, "missing")), "");
});
