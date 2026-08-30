import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, parseCanonicalJson } from "./canonical-json";

test("canonical JSON fixes key order and rejects alternate wire forms", () => {
  assert.equal(canonicalJson({ z: 1, a: [true, "x"] }), '{"a":[true,"x"],"z":1}');
  assert.deepEqual(parseCanonicalJson('{"a":[true,"x"],"z":1}'), { a: [true, "x"], z: 1 });
  for (const value of ['{ "a":1}', '{"z":1,"a":2}', '{"a":1.0}', '{"a":"\\u0078"}']) {
    assert.throws(() => parseCanonicalJson(value), /NONCANONICAL/);
  }
});

test("canonical JSON rejects non-finite and non-data values", () => {
  assert.throws(() => canonicalJson(Number.NaN), /NUMBER_INVALID/);
  assert.throws(() => canonicalJson(new Date()), /VALUE_INVALID/);
});
