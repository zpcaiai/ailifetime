import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import jpeg from "jpeg-js";
import {
  BrokerError,
  DigestBearerAuthenticator,
  conflict,
  dependency,
  sha256,
  type EnterpriseIdentityPort,
  type IdempotencyStore,
  type JsonValue,
  type MediaAssetRecord,
  type MediaAssetStore,
  type MultipartObjectStore,
  type MediaSafetyScannerPort,
  type Principal,
  type SessionProjection,
  type UploadState,
  type UploadStateStore,
  type VerifiedWechatIdentity,
  type WechatCodeExchangePort,
} from "./contracts.js";
import { ClientIntegrationBroker } from "./broker.js";
import { FailClosedMediaSafetyScanner, JpegJsNormalizer } from "./media-security.js";
import { MediaLifecycleRegistry } from "./media-lifecycle.js";
import { createBrokerHttpServer } from "./server.js";

const NOW = new Date("2026-08-24T08:00:00.000Z");
const PRINCIPAL: Principal = {
  actorId: "actor-1",
  tenantId: "tenant-1",
  roles: ["consumer"],
  purpose: "media_upload",
};

async function validJpeg(withMetadata = false): Promise<Buffer> {
  const width = 64;
  const height = 48;
  const pixels = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 45;
    pixels[offset + 1] = 96;
    pixels[offset + 2] = 135;
    pixels[offset + 3] = 255;
  }
  const encoded = jpeg.encode({ data: pixels, width, height }, 82).data;
  pixels.fill(0);
  if (!withMetadata) return encoded;
  const exif = Buffer.from([
    0xff, 0xe1, 0x00, 0x22,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00,
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
  ]);
  return Buffer.concat([encoded.subarray(0, 2), exif, encoded.subarray(2)]);
}

function containsExif(bytes: Uint8Array): boolean {
  return Buffer.from(bytes).includes(Buffer.from("Exif\0\0"));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

class MemoryStore implements IdempotencyStore, UploadStateStore, MediaAssetStore {
  readonly uploads = new Map<string, UploadState>();
  readonly assets = new Map<string, MediaAssetRecord>();
  readonly completedTtls = new Map<string, number>();
  readonly #idempotency = new Map<string, { fingerprint: string; state: "running" | "completed"; response?: JsonValue }>();
  readonly #uploadLeases = new Set<string>();
  readonly #assetLeases = new Set<string>();

  async execute<T extends JsonValue>(
    operation: string,
    key: string,
    fingerprint: string,
    work: () => Promise<T>,
    policy?: { readonly completedTtlMs?: number | ((response: T) => number) },
  ): Promise<T> {
    const mapKey = `${operation}:${key}`;
    const existing = this.#idempotency.get(mapKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw conflict("idempotency key mismatch", true);
      if (existing.state === "completed" && existing.response !== undefined) return existing.response as T;
      throw conflict("idempotency request is running");
    }
    this.#idempotency.set(mapKey, { fingerprint, state: "running" });
    try {
      const response = await work();
      const ttl = typeof policy?.completedTtlMs === "function"
        ? policy.completedTtlMs(response)
        : policy?.completedTtlMs ?? 7 * 24 * 60 * 60_000;
      this.completedTtls.set(operation, ttl);
      this.#idempotency.set(mapKey, { fingerprint, state: "completed", response });
      return response;
    } catch (error) {
      this.#idempotency.delete(mapKey);
      throw error;
    }
  }

  async create(state: UploadState): Promise<void> {
    if (this.uploads.has(state.uploadId)) throw conflict("upload exists");
    this.uploads.set(state.uploadId, state);
  }

  get(uploadId: string): Promise<UploadState | undefined> { return Promise.resolve(this.uploads.get(uploadId)); }

  compareAndSwap(uploadId: string, expectedVersion: number, state: UploadState): Promise<boolean> {
    if (this.uploads.get(uploadId)?.version !== expectedVersion) return Promise.resolve(false);
    this.uploads.set(uploadId, state);
    return Promise.resolve(true);
  }

  async withUploadLease<T>(uploadId: string, work: () => Promise<T>): Promise<T> {
    if (this.#uploadLeases.has(uploadId)) throw conflict("upload lease held");
    this.#uploadLeases.add(uploadId);
    try { return await work(); }
    finally { this.#uploadLeases.delete(uploadId); }
  }

  createAvailableAsset(asset: MediaAssetRecord): Promise<MediaAssetRecord> {
    const existing = this.assets.get(asset.mediaReference);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(asset)) throw conflict("asset binding changed");
      return Promise.resolve(existing);
    }
    this.assets.set(asset.mediaReference, asset);
    return Promise.resolve(asset);
  }

  getAsset(mediaReference: string): Promise<MediaAssetRecord | undefined> {
    return Promise.resolve(this.assets.get(mediaReference));
  }

  compareAndSwapAsset(mediaReference: string, expectedVersion: number, asset: MediaAssetRecord): Promise<boolean> {
    if (this.assets.get(mediaReference)?.version !== expectedVersion) return Promise.resolve(false);
    this.assets.set(mediaReference, asset);
    return Promise.resolve(true);
  }

  async withAssetLease<T>(mediaReference: string, work: () => Promise<T>): Promise<T> {
    if (this.#assetLeases.has(mediaReference)) throw conflict("asset lease held");
    this.#assetLeases.add(mediaReference);
    try { return await work(); }
    finally { this.#assetLeases.delete(mediaReference); }
  }

  listAssets(input: { readonly cursor?: string; readonly limit: number }): Promise<{
    readonly assets: readonly MediaAssetRecord[];
    readonly cursor?: string;
  }> {
    const start = Number(input.cursor ?? "0");
    const values = [...this.assets.values()].sort((left, right) => left.mediaReference.localeCompare(right.mediaReference));
    const assets = values.slice(start, start + input.limit);
    const next = start + assets.length;
    return Promise.resolve({ assets, ...(next < values.length ? { cursor: String(next) } : {}) });
  }

  readiness(): Promise<boolean> { return Promise.resolve(true); }
  close(): Promise<void> { return Promise.resolve(); }
}

class FakeObjects implements MultipartObjectStore {
  readonly multipart = new Map<string, { objectKey: string; parts: Map<number, Buffer> }>();
  readonly objects = new Map<string, Buffer>();
  readonly deleted = new Set<string>();
  readonly aborted = new Set<string>();
  deleteVerifiedCalls = 0;
  lastObjectKey = "";
  loseNextCompleteResponse = false;
  loseNextDeleteResponse = false;
  #putGate: Promise<void> | undefined;
  #putStarted: (() => void) | undefined;

  blockNextPut(): { readonly started: Promise<void>; readonly release: () => void } {
    let release = (): void => undefined;
    let started = (): void => undefined;
    this.#putGate = new Promise<void>((resolve) => { release = resolve; });
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    this.#putStarted = started;
    return { started: startedPromise, release };
  }

  create(input: { readonly objectKey: string }): Promise<string> {
    const id = `provider-${this.multipart.size + 1}`;
    this.lastObjectKey = input.objectKey;
    this.multipart.set(id, { objectKey: input.objectKey, parts: new Map() });
    return Promise.resolve(id);
  }

  async putPart(input: Parameters<MultipartObjectStore["putPart"]>[0]): Promise<{ etag: string; sha256Base64: string }> {
    this.#putStarted?.();
    this.#putStarted = undefined;
    if (this.#putGate !== undefined) {
      const gate = this.#putGate;
      this.#putGate = undefined;
      await gate;
    }
    const upload = this.multipart.get(input.providerUploadId);
    if (upload === undefined || upload.objectKey !== input.objectKey) throw dependency("multipart missing");
    upload.parts.set(input.partNumber, Buffer.from(input.bytes));
    return { etag: `etag-${input.partNumber}`, sha256Base64: input.sha256Base64 };
  }

  async complete(input: Parameters<MultipartObjectStore["complete"]>[0]): Promise<void> {
    if (this.objects.has(input.objectKey)) return;
    const upload = this.multipart.get(input.providerUploadId);
    if (upload === undefined) throw dependency("multipart missing");
    const bytes = Buffer.concat(input.parts.map((part) => upload.parts.get(part.partNumber) ?? Buffer.alloc(0)));
    this.objects.set(input.objectKey, bytes);
    this.multipart.delete(input.providerUploadId);
    if (this.loseNextCompleteResponse) {
      this.loseNextCompleteResponse = false;
      throw dependency("simulated lost S3 complete response");
    }
  }

  read(input: { readonly objectKey: string }): Promise<AsyncIterable<Uint8Array>> {
    const value = this.objects.get(input.objectKey);
    if (value === undefined) throw dependency("object missing");
    return Promise.resolve((async function* (): AsyncIterable<Uint8Array> { yield value; })());
  }

  replace(input: Parameters<MultipartObjectStore["replace"]>[0]): Promise<void> {
    this.objects.set(input.objectKey, Buffer.from(input.bytes));
    return Promise.resolve();
  }

  abort(input: Parameters<MultipartObjectStore["abort"]>[0]): Promise<void> {
    this.multipart.delete(input.providerUploadId);
    this.aborted.add(input.objectKey);
    return Promise.resolve();
  }

  delete(input: { readonly objectKey: string }): Promise<void> {
    this.objects.delete(input.objectKey);
    this.deleted.add(input.objectKey);
    if (this.loseNextDeleteResponse) {
      this.loseNextDeleteResponse = false;
      return Promise.reject(dependency("simulated lost S3 delete response"));
    }
    return Promise.resolve();
  }

  async deleteVerified(input: Parameters<MultipartObjectStore["deleteVerified"]>[0]): Promise<{
    state: "deleted";
    deletedVersions: number;
    deletedMarkers: number;
    verifiedAbsent: true;
    evidenceSha256: string;
  }> {
    this.deleteVerifiedCalls += 1;
    const keys = input.objectKey === undefined
      ? [...this.objects.keys()].filter((key) => key.startsWith(input.prefix ?? ""))
      : [input.objectKey];
    for (const key of keys) {
      this.objects.delete(key);
      this.deleted.add(key);
    }
    if (this.loseNextDeleteResponse) {
      this.loseNextDeleteResponse = false;
      throw dependency("simulated lost S3 delete response");
    }
    return {
      state: "deleted",
      deletedVersions: keys.length,
      deletedMarkers: 0,
      verifiedAbsent: true,
      evidenceSha256: sha256(JSON.stringify({ keys: [...keys].sort(), absent: true })),
    };
  }

  verifyAbsent(input: Parameters<MultipartObjectStore["verifyAbsent"]>[0]): Promise<{
    absent: boolean;
    objectCount: number;
    evidenceSha256: string;
  }> {
    const keys = input.objectKey === undefined
      ? [...this.objects.keys()].filter((key) => key.startsWith(input.prefix ?? ""))
      : [...this.objects.keys()].filter((key) => key === input.objectKey);
    return Promise.resolve({ absent: keys.length === 0, objectCount: keys.length, evidenceSha256: sha256(JSON.stringify(keys.sort())) });
  }

  listObjectKeys(input: Parameters<MultipartObjectStore["listObjectKeys"]>[0]): Promise<readonly string[]> {
    return Promise.resolve([...this.objects.keys()].filter((key) => key.startsWith(input.prefix)).slice(0, input.maximumObjects));
  }

  readiness(): Promise<boolean> { return Promise.resolve(true); }
}

class FakeWechat implements WechatCodeExchangePort {
  calls = 0;
  exchange(code: string): Promise<VerifiedWechatIdentity> {
    this.calls += 1;
    assert.equal(code, "wechat-code");
    return Promise.resolve({
      appId: "wx0123456789abcdef",
      openId: "openid-1",
      sessionKeySha256: sha256("server-only-session-key"),
      verifiedAt: NOW.toISOString(),
    });
  }
  readiness(): Promise<boolean> { return Promise.resolve(true); }
}

class FakeIdentity implements EnterpriseIdentityPort {
  readonly session: SessionProjection = {
    accessToken: "idp-issued-access-token-value-123456789",
    expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    tenantId: "idp-tenant",
    actorId: "idp-actor",
    roles: ["consumer"],
    purpose: "idp-authorized-purpose",
  };
  createCalls = 0;
  refreshCalls = 0;
  revokeCalls = 0;
  createSession(input: Parameters<EnterpriseIdentityPort["createSession"]>[0]): Promise<SessionProjection> {
    this.createCalls += 1;
    assert.equal(input.identity.openId, "openid-1");
    return Promise.resolve(this.session);
  }
  refreshSession(): Promise<SessionProjection> { this.refreshCalls += 1; return Promise.resolve(this.session); }
  revokeSession(): Promise<void> { this.revokeCalls += 1; return Promise.resolve(); }
  readiness(): Promise<boolean> { return Promise.resolve(true); }
}

class FakeSafetyScanner implements MediaSafetyScannerPort {
  mappingCalls = 0;
  scanCalls = 0;
  failNextScan = false;
  failNextMapping = false;

  constructor(
    readonly mappingAssessedAt = NOW.toISOString(),
    readonly faceSubjectReferences: readonly string[] = ["face-subject-1"],
  ) {}

  scan(input: Parameters<MediaSafetyScannerPort["scan"]>[0]): Promise<import("./contracts.js").MediaSafetyEvidence> {
    this.scanCalls += 1;
    if (this.failNextScan) {
      this.failNextScan = false;
      return Promise.reject(dependency("simulated scanner dependency failure"));
    }
    return Promise.resolve({
      version: "ltm.media-safety-evidence.v2" as const,
      requestNonce: "scan_test_nonce_1",
      evidenceId: "scan-evidence-1",
      provider: "test-media-safety",
      tenantId: input.tenantId,
      actorId: input.actorId,
      mediaReference: input.mediaReference,
      canonicalSha256: input.canonicalSha256,
      malwareState: "clean" as const,
      contentPolicyState: "allowed" as const,
      faceCount: this.faceSubjectReferences.length,
      faceSubjectReferences: this.faceSubjectReferences,
      assessedAt: NOW.toISOString(),
    });
  }
  approveParticipants(input: Parameters<MediaSafetyScannerPort["approveParticipants"]>[0]) {
    this.mappingCalls += 1;
    if (this.failNextMapping) {
      this.failNextMapping = false;
      return Promise.reject(dependency("simulated participant mapping dependency failure"));
    }
    return Promise.resolve({
      version: "ltm.media-participant-mapping.v2" as const,
      requestNonce: "mapping_test_nonce_1",
      evidenceId: "participant-mapping-1",
      provider: "test-identity-review",
      tenantId: input.tenantId,
      actorId: input.actorId,
      mediaReference: input.mediaReference,
      canonicalSha256: input.canonicalSha256,
      scanEvidenceId: input.scanEvidence.evidenceId,
      participantIds: input.participantIds,
      faceSubjectReferences: input.scanEvidence.faceSubjectReferences,
      state: "approved" as const,
      assessedAt: this.mappingAssessedAt,
    });
  }
  readiness() { return Promise.resolve(true); }
}

function fixture(
  safetyScanner: MediaSafetyScannerPort = new FakeSafetyScanner(),
  options: {
    readonly clock?: () => Date;
    readonly lifecycleRegistry?: import("./media-lifecycle.js").MediaLifecycleRegistry;
  } = {},
): {
  readonly broker: ClientIntegrationBroker;
  readonly store: MemoryStore;
  readonly objects: FakeObjects;
  readonly identity: FakeIdentity;
  readonly wechat: FakeWechat;
} {
  const store = new MemoryStore();
  const objects = new FakeObjects();
  const identity = new FakeIdentity();
  const wechat = new FakeWechat();
  return {
    broker: new ClientIntegrationBroker({
      uploads: store,
      assets: store,
      idempotency: store,
      objects,
      jpegNormalizer: new JpegJsNormalizer(),
      safetyScanner,
      ...(options.lifecycleRegistry === undefined ? {} : { lifecycleRegistry: options.lifecycleRegistry }),
      identity,
      wechat,
      clock: options.clock ?? (() => new Date(NOW)),
    }),
    store,
    objects,
    identity,
    wechat,
  };
}

test("WeChat sessions are entirely projected by the enterprise IdP and cached no longer than five minutes", async () => {
  const { broker, store, identity, wechat } = fixture();
  const request = {
    code: "wechat-code",
    consentVersion: "privacy-v3",
    clientRequestId: "client-request-1",
    idempotencyKey: "session-key-1",
    requestId: "request-1",
  };
  const first = await broker.createWechatSession(request);
  const replay = await broker.createWechatSession(request);
  assert.deepEqual(first, { session: identity.session });
  assert.deepEqual(replay, first);
  assert.equal(wechat.calls, 1);
  assert.equal(identity.createCalls, 1);
  assert.equal(store.completedTtls.get("wechat-session.create"), 5 * 60_000);
});

test("multipart upload binds principal and offset and returns only an opaque media reference", async () => {
  const scanner = new FakeSafetyScanner();
  const { broker, store, objects } = fixture(scanner);
  const bytes = await validJpeg(true);
  assert.equal(containsExif(bytes), true);
  const fileDigest = createHash("sha256").update(bytes).digest("hex");
  const created = await broker.createUpload(PRINCIPAL, {
    fileSize: bytes.byteLength,
    fileDigest,
    digestAlgorithm: "sha256",
    contentType: "image/jpeg",
    clientRequestId: "media-request-1",
    idempotencyKey: "create-key-1",
  });
  await assert.rejects(
    broker.appendUpload({ ...PRINCIPAL, tenantId: "tenant-2" }, {
      uploadId: created.uploadId, bytes, start: 0, end: bytes.byteLength - 1, total: bytes.byteLength, idempotencyKey: "wrong-tenant-key",
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "RESOURCE_NOT_FOUND",
  );
  assert.deepEqual(await broker.appendUpload(PRINCIPAL, {
    uploadId: created.uploadId, bytes, start: 0, end: bytes.byteLength - 1, total: bytes.byteLength, idempotencyKey: "append-key-1",
  }), { nextOffset: bytes.byteLength });
  const completed = await broker.completeUpload(PRINCIPAL, {
    uploadId: created.uploadId, fileDigest, digestAlgorithm: "sha256", idempotencyKey: "complete-key-1",
  });
  assert.equal(completed.state, "available");
  assert.match(completed.mediaReference, /^media_/);
  assert.equal(completed.mediaReference.includes(objects.lastObjectKey), false);
  assert.equal(Object.hasOwn(completed, "objectKey"), false);
  const state = store.uploads.get(created.uploadId);
  assert.ok(state);
  const canonical = objects.objects.get(state.objectKey);
  assert.ok(canonical);
  const canonicalMetadata = jpeg.decode(canonical, { useTArray: true, tolerantDecoding: false });
  assert.equal(canonicalMetadata.width, 48);
  assert.equal(canonicalMetadata.height, 64);
  assert.equal(containsExif(canonical), false);
  assert.equal(state.sourceSha256, sha256(bytes));
  assert.equal(state.canonicalSha256, sha256(canonical));
  assert.equal(state.lineageSha256, sha256(`ltm-media-lineage-v1\n${state.sourceSha256}\n${state.canonicalSha256}\n`));
  const intake = await broker.resolveMediaIntake(PRINCIPAL, completed.mediaReference, ["participant-1"], "resolve-intake-1");
  assert.deepEqual(
    await broker.resolveMediaIntake(PRINCIPAL, completed.mediaReference, ["participant-1"], "resolve-intake-1"),
    intake,
  );
  assert.equal(scanner.mappingCalls, 1);
  const intakeOperation = [...store.completedTtls.entries()].find(([operation]) => operation.startsWith("media-intake.resolve."));
  assert.equal(intakeOperation?.[1], 10 * 60_000);
  assert.deepEqual(Object.keys(intake).sort(), [
    "assetId", "byteLength", "canonicalSha256", "faceCount", "height", "lineageSha256", "metadataStripped",
    "mimeType", "participantIds", "participantMapComplete", "participantMappingAssessedAt",
    "participantMappingEvidenceId", "participantMappingProvider", "scanAssessedAt", "scanEvidenceId",
    "scannerProvider", "sourceSha256", "width",
  ].sort());
  assert.equal(intake.participantMapComplete, true);
  assert.deepEqual(intake.participantIds, ["participant-1"]);
  await assert.rejects(
    broker.resolveMediaIntake(
      { ...PRINCIPAL, tenantId: "tenant-2" }, completed.mediaReference, ["participant-1"], "resolve-wrong-tenant",
    ),
    (error: unknown) => error instanceof BrokerError && error.code === "RESOURCE_NOT_FOUND",
  );
  await assert.rejects(
    broker.resolveMediaIntake(
      { ...PRINCIPAL, actorId: "actor-2" }, completed.mediaReference, ["participant-1"], "resolve-wrong-actor",
    ),
    (error: unknown) => error instanceof BrokerError && error.code === "RESOURCE_NOT_FOUND",
  );
});

test("per-upload lease rejects concurrent same-offset writers before another S3 part can overwrite", async () => {
  const { broker, objects } = fixture();
  const bytes = Buffer.from("part", "utf8");
  const created = await broker.createUpload(PRINCIPAL, {
    fileSize: bytes.byteLength,
    fileDigest: createHash("sha256").update(bytes).digest("hex"),
    digestAlgorithm: "sha256",
    contentType: "image/jpeg",
    clientRequestId: "concurrency-request",
    idempotencyKey: "concurrency-create",
  });
  const gate = objects.blockNextPut();
  const first = broker.appendUpload(PRINCIPAL, {
    uploadId: created.uploadId, bytes, start: 0, end: 3, total: 4, idempotencyKey: "writer-a",
  });
  await gate.started;
  await assert.rejects(
    broker.appendUpload(PRINCIPAL, {
      uploadId: created.uploadId, bytes: Buffer.from("evil"), start: 0, end: 3, total: 4, idempotencyKey: "writer-b",
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "VERSION_CONFLICT",
  );
  gate.release();
  assert.deepEqual(await first, { nextOffset: 4 });
});

test("completion resumes after S3 committed the object but its first response was lost", async () => {
  const { broker, store, objects } = fixture();
  const bytes = await validJpeg();
  const fileDigest = createHash("sha256").update(bytes).digest("hex");
  const created = await broker.createUpload(PRINCIPAL, {
    fileSize: bytes.byteLength, fileDigest, digestAlgorithm: "sha256", contentType: "image/jpeg",
    clientRequestId: "recover-create", idempotencyKey: "recover-create-key",
  });
  await broker.appendUpload(PRINCIPAL, {
    uploadId: created.uploadId, bytes, start: 0, end: bytes.byteLength - 1, total: bytes.byteLength, idempotencyKey: "recover-part-key",
  });
  objects.loseNextCompleteResponse = true;
  await assert.rejects(
    broker.completeUpload(PRINCIPAL, { uploadId: created.uploadId, fileDigest, digestAlgorithm: "sha256", idempotencyKey: "recover-complete-a" }),
    (error: unknown) => error instanceof BrokerError && error.code === "DEPENDENCY_UNAVAILABLE",
  );
  assert.equal(store.uploads.get(created.uploadId)?.state, "completing");
  const recovered = await broker.completeUpload(PRINCIPAL, {
    uploadId: created.uploadId, fileDigest, digestAlgorithm: "sha256", idempotencyKey: "recover-complete-b",
  });
  assert.equal(recovered.state, "available");
  assert.equal(store.uploads.get(created.uploadId)?.state, "available");
});

test("scanner dependency failures preserve the object and allow the same idempotency key to recover", async () => {
  const scanner = new FakeSafetyScanner();
  const { broker, store, objects } = fixture(scanner);
  const bytes = await validJpeg();
  const fileDigest = sha256(bytes);
  const created = await broker.createUpload(PRINCIPAL, {
    fileSize: bytes.byteLength,
    fileDigest,
    digestAlgorithm: "sha256",
    contentType: "image/jpeg",
    clientRequestId: "scanner-retry-create",
    idempotencyKey: "scanner-retry-create-key",
  });
  await broker.appendUpload(PRINCIPAL, {
    uploadId: created.uploadId,
    bytes,
    start: 0,
    end: bytes.byteLength - 1,
    total: bytes.byteLength,
    idempotencyKey: "scanner-retry-part-key",
  });
  const key = "scanner-retry-complete-key";
  scanner.failNextScan = true;
  await assert.rejects(
    broker.completeUpload(PRINCIPAL, { uploadId: created.uploadId, fileDigest, digestAlgorithm: "sha256", idempotencyKey: key }),
    (error: unknown) => error instanceof BrokerError && error.code === "DEPENDENCY_UNAVAILABLE" && error.retryable,
  );
  const verifying = store.uploads.get(created.uploadId);
  assert.equal(verifying?.state, "verifying");
  assert.ok(verifying);
  assert.equal(objects.objects.has(verifying.objectKey), true);
  assert.equal(objects.deleted.has(verifying.objectKey), false);
  const recovered = await broker.completeUpload(PRINCIPAL, {
    uploadId: created.uploadId,
    fileDigest,
    digestAlgorithm: "sha256",
    idempotencyKey: key,
  });
  assert.equal(recovered.state, "available");
  assert.equal(scanner.scanCalls, 2);
});

test("principal roles are fingerprinted as a set while additions and removals remain bound", async () => {
  const { broker } = fixture();
  const bytes = await validJpeg();
  const fileDigest = sha256(bytes);
  const original = { ...PRINCIPAL, roles: ["consumer", "guardian", "consumer"] };
  const created = await broker.createUpload(original, {
    fileSize: bytes.byteLength,
    fileDigest,
    digestAlgorithm: "sha256",
    contentType: "image/jpeg",
    clientRequestId: "roles-create",
    idempotencyKey: "roles-create-key",
  });
  await assert.rejects(
    broker.appendUpload({ ...original, roles: ["consumer"] }, {
      uploadId: created.uploadId,
      bytes,
      start: 0,
      end: bytes.byteLength - 1,
      total: bytes.byteLength,
      idempotencyKey: "roles-removed-key",
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "RESOURCE_NOT_FOUND",
  );
  await broker.appendUpload({ ...original, roles: ["guardian", "consumer"] }, {
    uploadId: created.uploadId,
    bytes,
    start: 0,
    end: bytes.byteLength - 1,
    total: bytes.byteLength,
    idempotencyKey: "roles-reordered-key",
  });
  await assert.rejects(
    broker.completeUpload({ ...original, roles: ["guardian", "consumer", "moderator"] }, {
      uploadId: created.uploadId,
      fileDigest,
      digestAlgorithm: "sha256",
      idempotencyKey: "roles-added-key",
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "RESOURCE_NOT_FOUND",
  );
  assert.equal((await broker.completeUpload({ ...original, roles: ["consumer", "guardian"] }, {
    uploadId: created.uploadId,
    fileDigest,
    digestAlgorithm: "sha256",
    idempotencyKey: "roles-complete-key",
  })).state, "available");
});

test("durable asset registry survives upload-state expiry and deletion removes the object and revokes cached intake", async () => {
  const { broker, store, objects } = fixture();
  const bytes = await validJpeg();
  const fileDigest = sha256(bytes);
  const created = await broker.createUpload(PRINCIPAL, {
    fileSize: bytes.byteLength,
    fileDigest,
    digestAlgorithm: "sha256",
    contentType: "image/jpeg",
    clientRequestId: "asset-registry-create",
    idempotencyKey: "asset-registry-create-key",
  });
  await broker.appendUpload(PRINCIPAL, {
    uploadId: created.uploadId,
    bytes,
    start: 0,
    end: bytes.byteLength - 1,
    total: bytes.byteLength,
    idempotencyKey: "asset-registry-part-key",
  });
  const completed = await broker.completeUpload(PRINCIPAL, {
    uploadId: created.uploadId,
    fileDigest,
    digestAlgorithm: "sha256",
    idempotencyKey: "asset-registry-complete-key",
  });
  const asset = store.assets.get(completed.mediaReference);
  assert.ok(asset);
  assert.equal(objects.objects.has(asset.objectKey), true);
  const cachedIntakeKey = "asset-registry-intake-cached";
  await broker.resolveMediaIntake(PRINCIPAL, completed.mediaReference, ["participant-1"], cachedIntakeKey);
  store.uploads.delete(created.uploadId); // models expiry of the 25-hour resumable-upload namespace
  assert.equal(
    (await broker.resolveMediaIntake(PRINCIPAL, completed.mediaReference, ["participant-1"], "asset-registry-after-ttl")).assetId,
    completed.mediaReference,
  );
  const admin: Principal = { ...PRINCIPAL, actorId: "admin-1", roles: ["platform_admin"], purpose: "product_operation" };
  await assert.rejects(
    broker.deleteMediaAsset({ ...admin, tenantId: "tenant-2" }, completed.mediaReference, "wrong tenant", "wrong-tenant-delete"),
    (error: unknown) => error instanceof BrokerError && error.code === "RESOURCE_NOT_FOUND",
  );
  assert.equal(objects.objects.has(asset.objectKey), true);
  const receipt = await broker.deleteMediaAsset(admin, completed.mediaReference, "B05 retention expired", "asset-delete-key");
  assert.equal(receipt.state, "deleted");
  assert.deepEqual(receipt.deletionTargets, ["s3-primary", "s3-derived"]);
  assert.equal(receipt.targetReceipts.length, 2);
  assert.equal(receipt.targetReceipts.every((target) => target.state === "deleted" && target.policySha256 === receipt.policySha256), true);
  assert.equal(objects.objects.has(asset.objectKey), false);
  assert.equal(objects.deleted.has(asset.objectKey), true);
  assert.equal(store.assets.get(completed.mediaReference)?.state, "deleted");
  assert.equal(store.assets.get(completed.mediaReference)?.deletion?.auditId, receipt.auditId);
  await assert.rejects(
    broker.resolveMediaIntake(PRINCIPAL, completed.mediaReference, ["participant-1"], cachedIntakeKey),
    (error: unknown) => error instanceof BrokerError && error.code === "RESOURCE_NOT_FOUND",
  );
  assert.deepEqual(
    await broker.deleteMediaAsset(admin, completed.mediaReference, "B05 retention expired", "asset-delete-key"),
    receipt,
  );
});

test("media deletion resumes from its durable pending record after an S3 response is lost", async () => {
  const { broker, store, objects } = fixture();
  const bytes = await validJpeg();
  const fileDigest = sha256(bytes);
  const created = await broker.createUpload(PRINCIPAL, {
    fileSize: bytes.byteLength,
    fileDigest,
    digestAlgorithm: "sha256",
    contentType: "image/jpeg",
    clientRequestId: "delete-recovery-create",
    idempotencyKey: "delete-recovery-create-key",
  });
  await broker.appendUpload(PRINCIPAL, {
    uploadId: created.uploadId,
    bytes,
    start: 0,
    end: bytes.byteLength - 1,
    total: bytes.byteLength,
    idempotencyKey: "delete-recovery-part-key",
  });
  const completed = await broker.completeUpload(PRINCIPAL, {
    uploadId: created.uploadId,
    fileDigest,
    digestAlgorithm: "sha256",
    idempotencyKey: "delete-recovery-complete-key",
  });
  const admin: Principal = { ...PRINCIPAL, actorId: "admin-1", roles: ["platform_admin"], purpose: "product_operation" };
  const key = "delete-recovery-key";
  objects.loseNextDeleteResponse = true;
  await assert.rejects(
    broker.deleteMediaAsset(admin, completed.mediaReference, "B05 retry test", key),
    (error: unknown) => error instanceof BrokerError && error.code === "DEPENDENCY_UNAVAILABLE" && error.retryable,
  );
  const pending = store.assets.get(completed.mediaReference);
  assert.equal(pending?.state, "deletion_pending");
  assert.ok(pending?.deletion?.auditId);
  assert.equal(pending?.deletion?.attempts?.length, 1);
  assert.equal(pending?.deletion?.alert?.code, "TARGET_PENDING");
  assert.ok(pending?.deletion?.nextRetryAt);
  assert.equal(objects.objects.has(pending?.objectKey ?? ""), false);
  const recovered = await broker.deleteMediaAsset(admin, completed.mediaReference, "B05 retry test", key);
  assert.equal(recovered.state, "deleted");
  assert.equal(recovered.auditId, pending?.deletion?.auditId);
  assert.equal(store.assets.get(completed.mediaReference)?.state, "deleted");
});

test("maintenance CAS-quarantines a resurrected tombstone and honors nextRetryAt before reconciliation", async () => {
  let clock = new Date(NOW);
  const { broker, store, objects } = fixture(new FakeSafetyScanner(), { clock: () => new Date(clock) });
  const bytes = await validJpeg();
  const fileDigest = sha256(bytes);
  const created = await broker.createUpload(PRINCIPAL, {
    fileSize: bytes.byteLength,
    fileDigest,
    digestAlgorithm: "sha256",
    contentType: "image/jpeg",
    clientRequestId: "resurrection-create",
    idempotencyKey: "resurrection-create-key",
  });
  await broker.appendUpload(PRINCIPAL, {
    uploadId: created.uploadId,
    bytes,
    start: 0,
    end: bytes.byteLength - 1,
    total: bytes.byteLength,
    idempotencyKey: "resurrection-part-key",
  });
  const completed = await broker.completeUpload(PRINCIPAL, {
    uploadId: created.uploadId,
    fileDigest,
    digestAlgorithm: "sha256",
    idempotencyKey: "resurrection-complete-key",
  });
  const stored = store.assets.get(completed.mediaReference);
  assert.ok(stored);
  const canonical = Buffer.from(objects.objects.get(stored.objectKey) ?? Buffer.alloc(0));
  const admin: Principal = { ...PRINCIPAL, actorId: "admin-1", roles: ["platform_admin"], purpose: "product_operation" };
  await broker.deleteMediaAsset(admin, completed.mediaReference, "initial deletion", "resurrection-delete-key");
  assert.equal(store.assets.get(completed.mediaReference)?.state, "deleted");

  objects.objects.set(stored.objectKey, canonical);
  objects.loseNextDeleteResponse = true;
  const beforeQuarantine = objects.deleteVerifiedCalls;
  const maintenance: Principal = {
    actorId: "media-maintenance-1",
    tenantId: PRINCIPAL.tenantId,
    roles: ["service_account"],
    purpose: "privacy_compliance",
  };
  const detected = await broker.runMediaLifecycleMaintenance(maintenance, { limit: 100 });
  assert.equal(detected.resurrectionDetected, 1);
  assert.equal(detected.pending, 1);
  assert.equal(objects.deleteVerifiedCalls, beforeQuarantine + 1);
  const quarantined = store.assets.get(completed.mediaReference);
  assert.equal(quarantined?.state, "deletion_pending");
  assert.equal(quarantined?.deletion?.targetReceipts?.length, 1);
  assert.equal(quarantined?.deletion?.alert?.code, "TARGET_PENDING");
  assert.ok(Date.parse(quarantined?.deletion?.nextRetryAt ?? "") > clock.getTime());

  await broker.runMediaLifecycleMaintenance(maintenance, { limit: 100 });
  assert.equal(objects.deleteVerifiedCalls, beforeQuarantine + 1);
  assert.equal(store.assets.get(completed.mediaReference)?.state, "deletion_pending");

  clock = new Date(Date.parse(quarantined?.deletion?.nextRetryAt ?? "") + 1);
  const reconciled = await broker.runMediaLifecycleMaintenance(maintenance, { limit: 100 });
  assert.equal(reconciled.reconciled, 1);
  assert.equal(store.assets.get(completed.mediaReference)?.state, "deleted");
  assert.equal(store.assets.get(completed.mediaReference)?.deletion?.targetReceipts?.length, 2);
});

test("remote backup revalidation failure durably reopens the tombstone and retries only after its deadline", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ltm-remote-revalidation-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const receiptKeys = generateKeyPairSync("ed25519");
  const credentialFile = join(directory, "remote.token");
  const receiptPublicKeyFile = join(directory, "remote.pub");
  writeFileSync(credentialFile, "remote-workload-token-value-123456789\n", { mode: 0o400 });
  writeFileSync(receiptPublicKeyFile, receiptKeys.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o400 });
  chmodSync(credentialFile, 0o400);
  chmodSync(receiptPublicKeyFile, 0o400);
  let remoteUnavailable = false;
  let remoteCalls = 0;
  const lifecycleRegistry = new MediaLifecycleRegistry({
    catalogSha256: "a".repeat(64),
    targetSecretRoot: directory,
    catalog: {
      schemaVersion: "ltm.media-lifecycle-policy-catalog.v1",
      catalogId: "test-remote-lifecycle",
      issuer: "test-policy-authority",
      environment: "test",
      keyId: "test-policy-key",
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      policies: [{
        policyId: "test-raw-remote",
        classification: "raw",
        retentionDays: 365,
        subjectDeletionAllowed: true,
        legalHoldMode: "allowed",
        deletionTargetIds: ["s3-primary", "s3-derived", "remote-backup"],
      }],
      targets: [
        { targetId: "s3-primary", kind: "s3-object" },
        { targetId: "s3-derived", kind: "s3-prefix" },
        {
          targetId: "remote-backup",
          kind: "https",
          endpoint: "https://backup.example.test/v1/media/delete",
          credentialFile,
          receiptPublicKeyFile,
        },
      ],
      signature: "test-constructor-does-not-consume-signature",
    },
    fetch: (async (_url, init) => {
      remoteCalls += 1;
      if (remoteUnavailable) return new Response("unavailable", { status: 503 });
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const signedReceipt = {
        schemaVersion: "ltm.media-deletion-receipt.v1",
        receiptId: `remote-receipt-${remoteCalls}`,
        requestNonce: request.requestNonce,
        targetId: request.targetId,
        deletionRequestId: request.deletionRequestId,
        tenantId: request.tenantId,
        mediaReference: request.mediaReference,
        canonicalSha256: request.canonicalSha256,
        policySha256: request.policySha256,
        state: "deleted",
        completedAt: new Date().toISOString(),
        evidenceSha256: sha256(`remote-evidence-${remoteCalls}`),
      };
      return new Response(JSON.stringify({
        ...signedReceipt,
        signature: sign(null, Buffer.from(canonicalJson(signedReceipt)), receiptKeys.privateKey).toString("base64url"),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  let clock = new Date(NOW);
  const { broker, store } = fixture(new FakeSafetyScanner(), {
    lifecycleRegistry,
    clock: () => new Date(clock),
  });
  const bytes = await validJpeg();
  const fileDigest = sha256(bytes);
  const created = await broker.createUpload(PRINCIPAL, {
    fileSize: bytes.byteLength,
    fileDigest,
    digestAlgorithm: "sha256",
    contentType: "image/jpeg",
    clientRequestId: "remote-revalidation-create",
    idempotencyKey: "remote-revalidation-create-key",
  });
  await broker.appendUpload(PRINCIPAL, {
    uploadId: created.uploadId,
    bytes,
    start: 0,
    end: bytes.byteLength - 1,
    total: bytes.byteLength,
    idempotencyKey: "remote-revalidation-part-key",
  });
  const completed = await broker.completeUpload(PRINCIPAL, {
    uploadId: created.uploadId,
    fileDigest,
    digestAlgorithm: "sha256",
    idempotencyKey: "remote-revalidation-complete-key",
  });
  const admin: Principal = { ...PRINCIPAL, actorId: "admin-1", roles: ["platform_admin"], purpose: "product_operation" };
  await broker.deleteMediaAsset(admin, completed.mediaReference, "delete every copy", "remote-revalidation-delete-key");
  assert.equal(store.assets.get(completed.mediaReference)?.deletion?.targetReceipts?.length, 3);
  const maintenance: Principal = {
    actorId: "media-maintenance-1",
    tenantId: PRINCIPAL.tenantId,
    roles: ["service_account"],
    purpose: "privacy_compliance",
  };
  remoteUnavailable = true;
  const callsBeforeFailure = remoteCalls;
  const failed = await broker.runMediaLifecycleMaintenance(maintenance, { limit: 100 });
  assert.equal(failed.pending, 1);
  assert.equal(remoteCalls, callsBeforeFailure + 1);
  const quarantined = store.assets.get(completed.mediaReference);
  assert.equal(quarantined?.state, "deletion_pending");
  assert.equal(quarantined?.deletion?.targetReceipts?.length, 2);
  assert.equal(quarantined?.deletion?.alert?.targetId, "remote-backup");
  assert.equal(quarantined?.deletion?.alert?.code, "TARGET_PENDING");

  await broker.runMediaLifecycleMaintenance(maintenance, { limit: 100 });
  assert.equal(remoteCalls, callsBeforeFailure + 1);
  remoteUnavailable = false;
  clock = new Date(Date.parse(quarantined?.deletion?.nextRetryAt ?? "") + 1);
  const recovered = await broker.runMediaLifecycleMaintenance(maintenance, { limit: 100 });
  assert.equal(recovered.reconciled, 1);
  assert.equal(store.assets.get(completed.mediaReference)?.state, "deleted");
  assert.equal(store.assets.get(completed.mediaReference)?.deletion?.targetReceipts?.length, 3);
});

test("data subjects can erase their own asset while privacy legal holds require reason, authority, and explicit release", async () => {
  const { broker, store } = fixture();
  const bytes = await validJpeg();
  const fileDigest = sha256(bytes);
  const created = await broker.createUpload(PRINCIPAL, {
    fileSize: bytes.byteLength,
    fileDigest,
    digestAlgorithm: "sha256",
    contentType: "image/jpeg",
    clientRequestId: "legal-hold-create",
    idempotencyKey: "legal-hold-create-key",
  });
  await broker.appendUpload(PRINCIPAL, {
    uploadId: created.uploadId,
    bytes,
    start: 0,
    end: bytes.byteLength - 1,
    total: bytes.byteLength,
    idempotencyKey: "legal-hold-part-key",
  });
  const completed = await broker.completeUpload(PRINCIPAL, {
    uploadId: created.uploadId,
    fileDigest,
    digestAlgorithm: "sha256",
    idempotencyKey: "legal-hold-complete-key",
  });
  const officer: Principal = {
    actorId: "privacy-1",
    tenantId: PRINCIPAL.tenantId,
    roles: ["privacy_officer"],
    purpose: "privacy_compliance",
  };
  const hold = await broker.placeMediaLegalHold(officer, completed.mediaReference, {
    reason: "regulatory investigation case 42",
    authority: "privacy-office-warrant-42",
    expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
    idempotencyKey: "legal-hold-place-key",
  });
  assert.equal(hold?.reason, "regulatory investigation case 42");
  assert.equal(hold?.authority, "privacy-office-warrant-42");
  const subject: Principal = { ...PRINCIPAL, purpose: "data_deletion" };
  await assert.rejects(
    broker.deleteMediaAsset(subject, completed.mediaReference, "data subject request", "held-delete-key"),
    (error: unknown) => error instanceof BrokerError && error.code === "LEGAL_HOLD_ACTIVE",
  );
  assert.equal(store.assets.get(completed.mediaReference)?.state, "available");
  const released = await broker.releaseMediaLegalHold(officer, completed.mediaReference, hold?.holdId ?? "missing", {
    reason: "investigation closed",
    authority: "privacy-office-release-42",
    idempotencyKey: "legal-hold-release-key",
  });
  assert.equal(released?.releaseReason, "investigation closed");
  assert.equal(released?.releaseAuthority, "privacy-office-release-42");
  const receipt = await broker.deleteMediaAsset(subject, completed.mediaReference, "data subject request", "subject-delete-key");
  assert.equal(receipt.state, "deleted");
  assert.equal(receipt.targetReceipts.length, 2);
  assert.equal(store.assets.get(completed.mediaReference)?.deletion?.requestedByActorId, PRINCIPAL.actorId);
});

test("whole-object SHA-256 mismatch deletes the KMS object and records a terminal failure", async () => {
  const { broker, store, objects } = fixture();
  const bytes = await validJpeg();
  const declaredDigest = createHash("sha256").update(bytes).digest("hex");
  const created = await broker.createUpload(PRINCIPAL, {
    fileSize: bytes.byteLength, fileDigest: declaredDigest, digestAlgorithm: "sha256", contentType: "image/jpeg",
    clientRequestId: "mismatch-create", idempotencyKey: "mismatch-create-key",
  });
  await broker.appendUpload(PRINCIPAL, {
    uploadId: created.uploadId, bytes, start: 0, end: bytes.byteLength - 1, total: bytes.byteLength, idempotencyKey: "mismatch-part-key",
  });
  const state = store.uploads.get(created.uploadId);
  assert.ok(state);
  const upload = objects.multipart.get(state.providerUploadId);
  assert.ok(upload);
  upload.parts.set(1, Buffer.alloc(bytes.byteLength, 0xab));
  await assert.rejects(
    broker.completeUpload(PRINCIPAL, {
      uploadId: created.uploadId, fileDigest: declaredDigest, digestAlgorithm: "sha256", idempotencyKey: "mismatch-complete-key",
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "DIGEST_MISMATCH",
  );
  assert.equal(objects.deleted.has(state.objectKey), true);
  assert.equal(store.uploads.get(created.uploadId)?.state, "failed");
});

test("JPEG magic without a fully decodable JPEG structure is terminally rejected", async () => {
  const { broker, store, objects } = fixture();
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const fileDigest = createHash("sha256").update(bytes).digest("hex");
  const created = await broker.createUpload(PRINCIPAL, {
    fileSize: bytes.byteLength, fileDigest, digestAlgorithm: "sha256", contentType: "image/jpeg",
    clientRequestId: "fake-jpeg-create", idempotencyKey: "fake-jpeg-create-key",
  });
  await broker.appendUpload(PRINCIPAL, {
    uploadId: created.uploadId, bytes, start: 0, end: bytes.byteLength - 1, total: bytes.byteLength,
    idempotencyKey: "fake-jpeg-part-key",
  });
  const objectKey = store.uploads.get(created.uploadId)?.objectKey;
  assert.ok(objectKey);
  await assert.rejects(
    broker.completeUpload(PRINCIPAL, {
      uploadId: created.uploadId, fileDigest, digestAlgorithm: "sha256", idempotencyKey: "fake-jpeg-complete-key",
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "INVALID_MEDIA",
  );
  assert.equal(store.uploads.get(created.uploadId)?.state, "failed");
  assert.equal(objects.deleted.has(objectKey), true);
});

test("unconfigured external media scanning fails closed and keeps a retryable verification state", async () => {
  const { broker, store } = fixture(new FailClosedMediaSafetyScanner());
  const bytes = await validJpeg();
  const fileDigest = createHash("sha256").update(bytes).digest("hex");
  const created = await broker.createUpload(PRINCIPAL, {
    fileSize: bytes.byteLength, fileDigest, digestAlgorithm: "sha256", contentType: "image/jpeg",
    clientRequestId: "unconfigured-create", idempotencyKey: "unconfigured-create-key",
  });
  await broker.appendUpload(PRINCIPAL, {
    uploadId: created.uploadId, bytes, start: 0, end: bytes.byteLength - 1, total: bytes.byteLength,
    idempotencyKey: "unconfigured-part-key",
  });
  await assert.rejects(
    broker.completeUpload(PRINCIPAL, {
      uploadId: created.uploadId, fileDigest, digestAlgorithm: "sha256", idempotencyKey: "unconfigured-complete-key",
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "NOT_CONFIGURED",
  );
  assert.equal(store.uploads.get(created.uploadId)?.state, "verifying");
  assert.deepEqual(await broker.readiness(), {
    ready: false,
    checks: {
      redis: true,
      mediaAssetRegistry: true,
      s3: true,
      idp: true,
      wechatAppSecret: true,
      mediaSafetyScanner: false,
    },
  });
});

test("malformed scanner evidence cannot become safety evidence or delete the object", async () => {
  class MissingSubjectScanner extends FakeSafetyScanner {
    override scan(input: Parameters<MediaSafetyScannerPort["scan"]>[0]) {
      return Promise.resolve({
        version: "ltm.media-safety-evidence.v2" as const,
        requestNonce: "scan_test_nonce_missing_subjects",
        evidenceId: "scan-without-subjects",
        provider: "unsafe-test-scanner",
        tenantId: input.tenantId,
        actorId: input.actorId,
        mediaReference: input.mediaReference,
        canonicalSha256: input.canonicalSha256,
        malwareState: "clean" as const,
        contentPolicyState: "allowed" as const,
        faceCount: 1,
        faceSubjectReferences: [],
        assessedAt: NOW.toISOString(),
      });
    }
  }
  const { broker, store, objects } = fixture(new MissingSubjectScanner());
  const bytes = await validJpeg();
  const fileDigest = createHash("sha256").update(bytes).digest("hex");
  const created = await broker.createUpload(PRINCIPAL, {
    fileSize: bytes.byteLength, fileDigest, digestAlgorithm: "sha256", contentType: "image/jpeg",
    clientRequestId: "face-only-create", idempotencyKey: "face-only-create-key",
  });
  await broker.appendUpload(PRINCIPAL, {
    uploadId: created.uploadId, bytes, start: 0, end: bytes.byteLength - 1, total: bytes.byteLength,
    idempotencyKey: "face-only-part-key",
  });
  await assert.rejects(
    broker.completeUpload(PRINCIPAL, {
      uploadId: created.uploadId, fileDigest, digestAlgorithm: "sha256", idempotencyKey: "face-only-complete-key",
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "DEPENDENCY_UNAVAILABLE" && !error.retryable,
  );
  const state = store.uploads.get(created.uploadId);
  assert.equal(state?.state, "verifying");
  assert.ok(state);
  assert.equal(objects.objects.has(state.objectKey), true);
  assert.equal(objects.deleted.has(state.objectKey), false);
});

test("an explicit scanner safety rejection is terminal and deletes the object", async () => {
  class ExplicitSafetyRejectionScanner extends FakeSafetyScanner {
    override scan(): ReturnType<MediaSafetyScannerPort["scan"]> {
      return Promise.reject(new BrokerError("SAFETY_REJECTED", "explicit scanner HTTP 422", 422, false));
    }
  }
  const { broker, store, objects } = fixture(new ExplicitSafetyRejectionScanner());
  const bytes = await validJpeg();
  const fileDigest = sha256(bytes);
  const created = await broker.createUpload(PRINCIPAL, {
    fileSize: bytes.byteLength,
    fileDigest,
    digestAlgorithm: "sha256",
    contentType: "image/jpeg",
    clientRequestId: "explicit-safety-create",
    idempotencyKey: "explicit-safety-create-key",
  });
  await broker.appendUpload(PRINCIPAL, {
    uploadId: created.uploadId,
    bytes,
    start: 0,
    end: bytes.byteLength - 1,
    total: bytes.byteLength,
    idempotencyKey: "explicit-safety-part-key",
  });
  const objectKey = store.uploads.get(created.uploadId)?.objectKey;
  assert.ok(objectKey);
  await assert.rejects(
    broker.completeUpload(PRINCIPAL, {
      uploadId: created.uploadId,
      fileDigest,
      digestAlgorithm: "sha256",
      idempotencyKey: "explicit-safety-complete-key",
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "SAFETY_REJECTED",
  );
  assert.equal(store.uploads.get(created.uploadId)?.state, "failed");
  assert.equal(objects.deleted.has(objectKey), true);
  assert.equal(objects.objects.has(objectKey), false);
});

test("HTTP media intake resolution retries failures, replays once, and rejects ordered-input rebinding", async (context) => {
  const mappingAssessedAt = new Date(NOW.getTime() - 14 * 60_000).toISOString();
  const scanner = new FakeSafetyScanner(mappingAssessedAt, ["face-subject-1", "face-subject-2"]);
  const { broker, store, objects } = fixture(scanner);
  const bytes = await validJpeg();
  const fileDigest = createHash("sha256").update(bytes).digest("hex");
  const created = await broker.createUpload(PRINCIPAL, {
    fileSize: bytes.byteLength,
    fileDigest,
    digestAlgorithm: "sha256",
    contentType: "image/jpeg",
    clientRequestId: "http-intake-create",
    idempotencyKey: "http-intake-create-key",
  });
  await broker.appendUpload(PRINCIPAL, {
    uploadId: created.uploadId,
    bytes,
    start: 0,
    end: bytes.byteLength - 1,
    total: bytes.byteLength,
    idempotencyKey: "http-intake-part-key",
  });
  const completed = await broker.completeUpload(PRINCIPAL, {
    uploadId: created.uploadId,
    fileDigest,
    digestAlgorithm: "sha256",
    idempotencyKey: "http-intake-complete-key",
  });

  const token = "broker-workload-token-value-123456789";
  const server = createBrokerHttpServer({
    broker,
    workloadAuthenticator: new DigestBearerAuthenticator([sha256(token)]),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind a TCP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const resolve = (participantIds: readonly string[]) => fetch(`${origin}/v1/media/intakes/resolve`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "http-resolve-key",
      "x-request-id": "http-resolve-request",
    },
    body: JSON.stringify({ principal: PRINCIPAL, mediaReference: completed.mediaReference, participantIds }),
  });

  scanner.failNextMapping = true;
  const failed = await resolve(["participant-1", "participant-2"]);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json() as { error: { code: string } }).error.code, "DEPENDENCY_UNAVAILABLE");
  const succeeded = await resolve(["participant-1", "participant-2"]);
  assert.equal(succeeded.status, 200);
  const projection = await succeeded.json();
  const replayed = await resolve(["participant-1", "participant-2"]);
  assert.equal(replayed.status, 200);
  assert.deepEqual(await replayed.json(), projection);
  assert.equal(scanner.mappingCalls, 2);
  const intakeOperation = [...store.completedTtls.entries()].find(([operation]) => operation.startsWith("media-intake.resolve."));
  assert.equal(intakeOperation?.[1], 60_000);

  const rebound = await resolve(["participant-2", "participant-1"]);
  assert.equal(rebound.status, 409);
  assert.equal((await rebound.json() as { error: { code: string } }).error.code, "IDEMPOTENCY_CONFLICT");
  assert.equal(scanner.mappingCalls, 2);

  const asset = store.assets.get(completed.mediaReference);
  assert.ok(asset);
  const deleteRequest = (principal: Principal, key: string) => fetch(
    `${origin}/v1/media/assets/${completed.mediaReference}/delete`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key,
        "x-request-id": `request-${key}`,
      },
      body: JSON.stringify({ principal, reason: "B05 immediate retention" }),
    },
  );
  const ownerDelete = await deleteRequest(PRINCIPAL, "http-delete-owner");
  assert.equal(ownerDelete.status, 404);
  const deleted = await deleteRequest(
    { ...PRINCIPAL, actorId: "admin-1", roles: ["platform_admin"], purpose: "product_operation" },
    "http-delete-admin",
  );
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json() as { state: string }).state, "deleted");
  assert.equal(objects.objects.has(asset.objectKey), false);
  assert.equal(store.assets.get(completed.mediaReference)?.state, "deleted");
});

test("HTTP wire contract enforces workload bearer digest and never authenticates a client locally", async (context) => {
  const { broker, identity } = fixture();
  const token = "broker-workload-token-value-123456789";
  const server = createBrokerHttpServer({
    broker,
    workloadAuthenticator: new DigestBearerAuthenticator([sha256(token)]),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server did not bind a TCP address");
  const origin = `http://127.0.0.1:${address.port}`;
  const headers = {
    "content-type": "application/json",
    "idempotency-key": "http-session-key",
    "x-request-id": "http-request-1",
  };
  const unauthorized = await fetch(`${origin}/v1/wechat/sessions`, {
    method: "POST", headers, body: JSON.stringify({ code: "wechat-code", consentVersion: "privacy-v3", clientRequestId: "http-client-1" }),
  });
  assert.equal(unauthorized.status, 401);
  const authorized = await fetch(`${origin}/v1/wechat/sessions`, {
    method: "POST",
    headers: { ...headers, authorization: `Bearer ${token}` },
    body: JSON.stringify({ code: "wechat-code", consentVersion: "privacy-v3", clientRequestId: "http-client-1" }),
  });
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { session: identity.session });

  const weakDigest = await fetch(`${origin}/v1/media/uploads`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "http-upload-weak-digest", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      principal: PRINCIPAL,
      fileSize: 3,
      fileDigest: "a".repeat(64),
      digestAlgorithm: "sha1",
      contentType: "image/jpeg",
      clientRequestId: "http-upload-weak-digest",
    }),
  });
  assert.equal(weakDigest.status, 400);
  assert.equal((await weakDigest.json() as { error: { code: string } }).error.code, "VALIDATION_FAILED");

  const truncatedDigest = await fetch(`${origin}/v1/media/uploads`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "http-upload-truncated-digest", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      principal: PRINCIPAL,
      fileSize: 3,
      fileDigest: "a".repeat(40),
      digestAlgorithm: "sha256",
      contentType: "image/jpeg",
      clientRequestId: "http-upload-truncated-digest",
    }),
  });
  assert.equal(truncatedDigest.status, 400);
  assert.equal((await truncatedDigest.json() as { error: { code: string } }).error.code, "VALIDATION_FAILED");
});
