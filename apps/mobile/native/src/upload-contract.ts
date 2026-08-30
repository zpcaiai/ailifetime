import type { ResumableUploadApi } from "../../src/production";

type CreateInput = Parameters<ResumableUploadApi["create"]>[0];
type ChunkInput = Parameters<ResumableUploadApi["putChunk"]>[0];

export function uploadCreateBody(input: CreateInput): Readonly<Record<string, unknown>> {
  return Object.freeze({
    fileSize: input.totalBytes,
    fileDigest: sha256(input.wholeFileSha256),
    digestAlgorithm: "sha256",
    contentType: "image/jpeg",
    clientRequestId: identifier(input.idempotencyKey, "UPLOAD_CLIENT_REQUEST_ID_INVALID"),
  });
}

export function uploadContentRange(input: ChunkInput): string {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.totalBytes) ||
      input.totalBytes < 1 || input.totalBytes > 25 * 1024 * 1024 || !(input.bytes instanceof Uint8Array) ||
      input.bytes.byteLength < 1 || input.bytes.byteLength > 5 * 1024 * 1024 || input.offset + input.bytes.byteLength > input.totalBytes) {
    throw new Error("UPLOAD_CHUNK_RANGE_INVALID");
  }
  return `bytes ${input.offset}-${input.offset + input.bytes.byteLength - 1}/${input.totalBytes}`;
}

export function parseUploadCreated(value: unknown): Awaited<ReturnType<ResumableUploadApi["create"]>> {
  const result = exact(value, ["chunkBytes", "expiresAt", "nextOffset", "uploadId"], "UPLOAD_CREATE_RESPONSE_INVALID");
  if (!identifierValue(result.uploadId) || result.nextOffset !== 0 || result.chunkBytes !== 5 * 1024 * 1024 ||
      typeof result.expiresAt !== "string" || !Number.isFinite(Date.parse(result.expiresAt))) {
    throw new Error("UPLOAD_CREATE_RESPONSE_INVALID");
  }
  return { uploadId: result.uploadId, nextOffset: 0, chunkBytes: result.chunkBytes, expiresAt: new Date(result.expiresAt).toISOString() };
}

export function parseChunkAccepted(value: unknown, expectedNextOffset: number): { readonly nextOffset: number } {
  const result = exact(value, ["nextOffset"], "UPLOAD_CHUNK_RESPONSE_INVALID");
  if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset !== expectedNextOffset) throw new Error("UPLOAD_CHUNK_RESPONSE_INVALID");
  return { nextOffset: result.nextOffset };
}

export function parseUploadCompleted(value: unknown, uploadId: string): Awaited<ReturnType<ResumableUploadApi["complete"]>> {
  const result = exact(value, ["assetId", "state", "uploadId"], "UPLOAD_COMPLETE_RESPONSE_INVALID");
  if (result.uploadId !== uploadId || !identifierValue(result.assetId) || result.state !== "available") throw new Error("UPLOAD_COMPLETE_RESPONSE_INVALID");
  // "available" is only the media-broker state. B07 still performs the server-side
  // canonicalization, malware, face-participant, and consent intake gate.
  return { assetId: result.assetId, state: "server_validation_pending" };
}

export function parseUploadCancelled(value: unknown): void {
  const result = exact(value, ["cancelled", "requestId"], "UPLOAD_CANCEL_RESPONSE_INVALID");
  if (result.cancelled !== true || !identifierValue(result.requestId)) throw new Error("UPLOAD_CANCEL_RESPONSE_INVALID");
}

function exact(value: unknown, keys: readonly string[], code: string): Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new Error(code);
  }
  return value as Record<string, any>;
}

function identifier(value: unknown, code: string): string {
  if (!identifierValue(value)) throw new Error(code);
  return value;
}

function identifierValue(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function sha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("UPLOAD_FILE_SHA256_INVALID");
  return value;
}
