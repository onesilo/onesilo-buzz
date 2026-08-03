import { test } from "node:test";
import assert from "node:assert/strict";
import { since, preview } from "../src/log.js";

test("since reports sub-second work in ms and longer work in seconds", () => {
  // The unit switch matters: "412ms" and "0.4s" read very differently when
  // you are scanning a console for the call that took a minute.
  assert.equal(since(1_000, 1_412), "412ms");
  assert.equal(since(1_000, 1_999), "999ms");
  assert.equal(since(1_000, 2_000), "1.0s");
  assert.equal(since(1_000, 76_400), "75.4s");
});

test("since never reports negative elapsed time", () => {
  // System clock adjustments must not produce "-3.0s" in the log.
  assert.equal(since(5_000, 1_000), "0ms");
});

test("preview collapses whitespace so one message cannot flood the console", () => {
  assert.equal(preview("  we decided\n\n to ship   Friday "), "we decided to ship Friday");
});

test("preview clips long messages to the requested width", () => {
  const clipped = preview("x".repeat(500));
  assert.equal(clipped.length, 80);
  assert.ok(clipped.endsWith("…"));
  assert.equal(preview("abcdef", 4), "abc…");
});
