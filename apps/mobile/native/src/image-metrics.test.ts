import assert from "node:assert/strict";
import { test } from "node:test";
import { measureRgbaQuality } from "./image-metrics";

test("pixel quality detects flat and high-frequency images without retaining source data", () => {
  const flat = new Uint8Array(5 * 5 * 4).fill(100);
  for (let index = 3; index < flat.length; index += 4) flat[index] = 255;
  const flatResult = measureRgbaQuality(flat, 5, 5);
  assert.ok(flatResult.meanLuminance > 99 && flatResult.meanLuminance < 101);
  assert.equal(flatResult.laplacianVariance, 0);
  const edge = new Uint8Array(5 * 5 * 4);
  for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1) {
    const value = (x + y) % 2 === 0 ? 0 : 255;
    const offset = (y * 5 + x) * 4;
    edge[offset] = edge[offset + 1] = edge[offset + 2] = value;
    edge[offset + 3] = 255;
  }
  assert.ok(measureRgbaQuality(edge, 5, 5).laplacianVariance > 1_000);
});

test("pixel quality rejects dimension and byte-count ambiguity", () => {
  assert.throws(() => measureRgbaQuality(new Uint8Array(3), 5, 5), /RGBA_IMAGE_INVALID/);
  assert.throws(() => measureRgbaQuality(new Uint8Array(16), 2, 2), /RGBA_IMAGE_INVALID/);
});
