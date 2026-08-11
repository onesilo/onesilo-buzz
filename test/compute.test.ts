import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudComputeClient, ComputeGateError } from "../src/silo/compute.js";
import type { McpAuth } from "../src/silo/mcp-client.js";

const auth = (reauth = async () => false): McpAuth => ({
  headers: async () => ({ authorization: "Bearer t1" }),
  reauthorize: reauth,
});

function fakeFetch(handler: (url: string, init: any) => any) {
  const calls: Array<{ url: string; init: any }> = [];
  (globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}

const json = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
});

test("generate resolves a model once then completes", async () => {
  const calls = fakeFetch((url) => {
    if (url.endsWith("/v1/models")) {
      return json(200, { data: [{ id: "gpt-test" }] });
    }
    return json(200, {
      model: "gpt-test",
      choices: [{ message: { content: "fact: water is wet" } }],
    });
  });
  const c = new CloudComputeClient("https://cp", auth());
  const out = await c.generate("distill this");
  assert.equal(out.text, "fact: water is wet");
  assert.equal(out.model, "gpt-test");
  await c.generate("again");
  // model discovery cached: models called once, completions twice.
  const modelCalls = calls.filter((c) => c.url.endsWith("/v1/models"));
  assert.equal(modelCalls.length, 1);
});

test("401 triggers one reauthorize retry", async () => {
  let first = true;
  let reauthed = 0;
  fakeFetch((url) => {
    if (url.endsWith("/v1/models")) return json(200, { data: [{ id: "m" }] });
    if (first) {
      first = false;
      return json(401, {});
    }
    return json(200, { choices: [{ message: { content: "ok" } }] });
  });
  const c = new CloudComputeClient(
    "https://cp",
    auth(async () => {
      reauthed += 1;
      return true;
    })
  );
  const out = await c.generate("p");
  assert.equal(out.text, "ok");
  assert.equal(reauthed, 1);
});

test("402 surfaces as ComputeGateError", async () => {
  fakeFetch((url) => {
    if (url.endsWith("/v1/models")) return json(200, { data: [{ id: "m" }] });
    return json(402, { error: { message: "Out of premium chats" } });
  });
  const c = new CloudComputeClient("https://cp", auth());
  await assert.rejects(
    () => c.generate("p"),
    (e: any) => e instanceof ComputeGateError && e.status === 402
  );
});
