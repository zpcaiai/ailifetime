import assert from "node:assert/strict";
import test from "node:test";

test("browser bundle has the required web platform", () => {
  assert.equal(typeof URL, "function");
  assert.equal(typeof crypto.randomUUID, "function");
});
