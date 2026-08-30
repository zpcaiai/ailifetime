import assert from "node:assert/strict";
import test from "node:test";
import {
  parseChunkAccepted,
  parseUploadCancelled,
  parseUploadCompleted,
  parseUploadCreated,
  uploadContentRange,
  uploadCreateBody,
} from "./upload-contract";

test("native upload create is the exact public API contract", () => {
  const input = {
    tenantId: "tenant-1", actorId: "actor-1", purpose: "age_transformation", sourceUri: "file:///private/photo.jpg",
    totalBytes: 3, chunkBytes: 0, wholeFileSha256: "a".repeat(64), idempotencyKey: "mobile-upload:1234567890",
  };
  assert.deepEqual(uploadCreateBody(input), {
    fileSize: 3,
    fileDigest: "a".repeat(64),
    digestAlgorithm: "sha256",
    contentType: "image/jpeg",
    clientRequestId: "mobile-upload:1234567890",
  });
  assert.deepEqual(parseUploadCreated({ uploadId: "upload-1", nextOffset: 0, chunkBytes: 5 * 1024 * 1024, expiresAt: "2030-01-01T00:00:00.000Z" }), {
    uploadId: "upload-1", nextOffset: 0, chunkBytes: 5 * 1024 * 1024, expiresAt: "2030-01-01T00:00:00.000Z",
  });
  assert.throws(() => parseUploadCreated({ uploadId: "upload-1", nextOffset: 0, expiresAt: "2030-01-01T00:00:00.000Z" }), /UPLOAD_CREATE_RESPONSE_INVALID/);
});

test("native upload chunks bind raw bytes to the exact range and checksum acknowledgement", () => {
  const bytes = new Uint8Array([97, 98, 99]);
  const input = { uploadId: "upload-1", offset: 5, totalBytes: 8, bytes, sha256: "b".repeat(64), idempotencyKey: "mobile-upload:chunk:5" };
  assert.equal(uploadContentRange(input), "bytes 5-7/8");
  assert.deepEqual(parseChunkAccepted({ nextOffset: 8 }, 8), { nextOffset: 8 });
  assert.throws(() => parseChunkAccepted({ nextOffset: 7 }, 8), /UPLOAD_CHUNK_RESPONSE_INVALID/);
});

test("media completion remains pending until the B07 server validation gate", () => {
  assert.deepEqual(parseUploadCompleted({ uploadId: "upload-1", assetId: "media-1", state: "available" }, "upload-1"), {
    assetId: "media-1", state: "server_validation_pending",
  });
  assert.throws(() => parseUploadCompleted({ uploadId: "upload-1", assetId: "media-1", state: "verified" }, "upload-1"), /UPLOAD_COMPLETE_RESPONSE_INVALID/);
  assert.doesNotThrow(() => parseUploadCancelled({ cancelled: true, requestId: "request-12345678" }));
});
