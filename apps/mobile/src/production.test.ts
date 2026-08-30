import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCaptureQuality,
  evaluateReleaseGate,
  ResumableUploadCoordinator,
  RevocableOfflineCache,
  safeOperationalEvent,
  validatePinningPolicy,
  validatePushPayload,
  validateRemoteConfig,
  type CipherPort,
  type NamespacedCacheStore,
  type UploadSessionState,
} from "./production.js";

class MemoryStore implements NamespacedCacheStore {
  readonly values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
  async keys(prefix: string) { return [...this.values.keys()].filter((key) => key.startsWith(prefix)); }
}

class AuthenticatedCipher implements CipherPort {
  async seal(plaintext: Uint8Array, associatedData: Uint8Array) {
    return Buffer.concat([Buffer.from(associatedData), Buffer.from("|"), Buffer.from(plaintext)]).toString("base64url");
  }
  async open(sealed: string, associatedData: Uint8Array) {
    const decoded = Buffer.from(sealed, "base64url");
    const prefix = Buffer.concat([Buffer.from(associatedData), Buffer.from("|")]);
    if (!decoded.subarray(0, prefix.length).equals(prefix)) throw new Error("authentication mismatch");
    return decoded.subarray(prefix.length);
  }
}

const now = new Date("2026-08-28T00:00:00.000Z");
const binding = { tenantId: "tenant-1", actorId: "actor-1", purpose: "age_transformation", consentRevision: 4, revocationRevision: 2 } as const;

test("encrypted offline cache is principal/purpose/revision bound and remotely revocable", async () => {
  const store = new MemoryStore();
  const cache = new RevocableOfflineCache(store, new AuthenticatedCipher(), { clock: () => now });
  await assert.rejects(cache.put({ key: "thumb-1", kind: "thumbnail", value: "cipher-input", expiresAt: "2026-08-29T00:00:00.000Z", consentRevision: 4 }), /server-verified/);
  await cache.activate(binding);
  await cache.put({ key: "thumb-1", kind: "thumbnail", value: "base64-thumbnail", expiresAt: "2026-08-29T00:00:00.000Z", consentRevision: 4 });
  assert.equal((await cache.get("thumb-1"))?.value, "base64-thumbnail");
  await cache.applyRemoteRevocation({ tenantId: "tenant-1", actorId: "actor-1", revision: 3, keys: ["thumb-1"] });
  assert.equal(await cache.get("thumb-1"), null);
  await assert.rejects(cache.applyRemoteRevocation({ tenantId: "tenant-1", actorId: "actor-1", revision: 3, clearAll: true }), /stale/);
});

test("offline cache fails authentication after account or consent binding changes", async () => {
  const store = new MemoryStore();
  const cache = new RevocableOfflineCache(store, new AuthenticatedCipher(), { clock: () => now });
  await cache.activate(binding);
  await cache.put({ key: "meta-1", kind: "metadata", value: "minimal", expiresAt: "2026-08-29T00:00:00.000Z", consentRevision: 4 });
  await cache.activate({ ...binding, actorId: "actor-2" });
  assert.equal(await cache.get("meta-1"), null);
  assert.equal(store.values.size, 0);
});

test("capture policy covers HEIC normalization, explainable quality, multi-person selection and authorization", () => {
  const accepted = assessCaptureQuality({
    mimeType: "image/heic", width: 3024, height: 4032, byteLength: 2_000_000, laplacianVariance: 180,
    meanLuminance: 128, orientationNormalized: true, metadataStripped: true,
    faces: [{ id: "face-1", yawDegrees: 2, pitchDegrees: 1, rollDegrees: 0, occlusionRatio: 0.05, frameAreaRatio: 0.2 }],
    selectedFaceIds: ["face-1"], disclosureAccepted: true, retentionAccepted: true,
    authorizationReferences: ["consent-reference-1"],
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.serverRecheckRequired, true);
  const denied = assessCaptureQuality({
    mimeType: "image/jpeg", width: 600, height: 600, byteLength: 1_000, laplacianVariance: 2,
    meanLuminance: 10, orientationNormalized: false, metadataStripped: false,
    faces: [
      { id: "face-1", yawDegrees: 50, pitchDegrees: 0, rollDegrees: 0, occlusionRatio: 0.8, frameAreaRatio: 0.01 },
      { id: "face-2", yawDegrees: 0, pitchDegrees: 0, rollDegrees: 0, occlusionRatio: 0, frameAreaRatio: 0.2 },
    ], selectedFaceIds: [], disclosureAccepted: false, retentionAccepted: false, authorizationReferences: [],
  });
  assert.equal(denied.accepted, false);
  assert.ok(denied.reasons.includes("MULTI_FACE_SELECTION_REQUIRED"));
  assert.ok(denied.reasons.includes("METADATA_NOT_STRIPPED"));
});

function uploadHarness(network = { connected: true, metered: false }) {
  const states = new Map<string, UploadSessionState>();
  const uploaded: number[] = [];
  const removed: string[] = [];
  const cancelled: string[] = [];
  const coordinator = new ResumableUploadCoordinator({
    create: async () => ({ uploadId: "upload-1", nextOffset: 0, chunkBytes: 64 * 1_024, expiresAt: "2026-08-29T00:00:00.000Z" }),
    putChunk: async ({ offset, bytes }) => { uploaded.push(offset); return { nextOffset: offset + bytes.byteLength }; },
    complete: async () => ({ assetId: "asset-1", state: "server_validation_pending" }),
    cancel: async ({ reason }) => { cancelled.push(reason); },
  }, {
    load: async (id) => states.get(id) ?? null,
    save: async (state) => { states.set(state.uploadId, structuredClone(state)); },
    delete: async (id) => { states.delete(id); },
  }, {
    read: async (_uri, _offset, length) => new Uint8Array(length).fill(7),
    remove: async (uri) => { removed.push(uri); },
  }, { sha256: async () => "a".repeat(64) }, { current: async () => network }, () => now);
  return { coordinator, states, uploaded, removed, cancelled };
}

test("resumable upload persists exact offsets, honors background budget and completes from saved state", async () => {
  const harness = uploadHarness();
  await harness.coordinator.create({ binding, sourceUri: "file:///private/cache/photo.jpg", totalBytes: 150_000, wholeFileSha256: "b".repeat(64), idempotencyKey: "upload-idem-1" });
  assert.deepEqual(await harness.coordinator.resume("upload-1", binding, { maxChunks: 1 }), { state: "suspended", reason: "budget", nextOffset: 65_536 });
  assert.equal(harness.states.get("upload-1")?.nextOffset, 65_536);
  assert.deepEqual(await harness.coordinator.resume("upload-1", binding), { state: "server_validation_pending", assetId: "asset-1" });
  assert.deepEqual(harness.uploaded, [0, 65_536, 131_072]);
  assert.equal(harness.states.size, 0);
  assert.deepEqual(harness.removed, ["file:///private/cache/photo.jpg"]);
});

test("upload suspends on network policy and purges when account binding changes", async () => {
  const network = { connected: true, metered: true };
  const harness = uploadHarness(network);
  await harness.coordinator.create({ binding, sourceUri: "content://media/photo.jpg", totalBytes: 70_000, wholeFileSha256: "c".repeat(64), idempotencyKey: "upload-idem-2" });
  assert.deepEqual(await harness.coordinator.resume("upload-1", binding, { lowDataMode: true }), { state: "suspended", reason: "metered", nextOffset: 0 });
  await assert.rejects(harness.coordinator.resume("upload-1", { ...binding, actorId: "actor-2" }), /principal changed/);
  assert.deepEqual(harness.cancelled, ["authorization_changed"]);
  assert.equal(harness.states.size, 0);
});

test("remote config and push navigation fail closed for old versions, unknown fields and PII", () => {
  const config = validateRemoteConfig({
    schemaVersion: "ltm.mobile.remote-config.v1", revision: 3, minimumAppVersion: "2.0.0", latestAppVersion: "2.4.0",
    expiresAt: "2026-08-29T00:00:00.000Z", routes: { library: { path: "/library", minimumVersion: "2.0.0", enabled: true } },
    features: { resumableUpload: true },
  }, "2.1.0", now);
  assert.equal(config.routes.library?.path, "/library");
  assert.throws(() => validateRemoteConfig({ ...config, minimumAppVersion: "3.0.0" }, "2.1.0", now), /no longer authorized/);
  const push = validatePushPayload({
    schemaVersion: "ltm.mobile.push.v1", navigationReference: "x".repeat(40),
    issuedAt: "2026-08-28T00:00:00.000Z", expiresAt: "2026-08-28T01:00:00.000Z",
  }, now);
  assert.equal(push.navigationReference.length, 40);
  assert.throws(() => validatePushPayload({ ...push, childName: "Alice" }, now), /only an opaque/);
});

test("pin rotation, telemetry minimization and store release evidence are fail closed", () => {
  assert.doesNotThrow(() => validatePinningPolicy({
    host: "api.product.com", primaryPins: [`${"A".repeat(43)}=`], backupPins: [`${"B".repeat(43)}=`],
    validFrom: "2026-08-27T00:00:00.000Z", validUntil: "2026-09-28T00:00:00.000Z",
  }, now));
  assert.throws(() => safeOperationalEvent("upload.failed", { originalUrl: "file:///private/photo.jpg" }), /not allowlisted/);
  assert.deepEqual(safeOperationalEvent("upload.failed", { errorCode: "NETWORK_TIMEOUT", attempt: 2 }), {
    name: "upload.failed", fields: { errorCode: "NETWORK_TIMEOUT", attempt: 2 },
  });
  const pending = evaluateReleaseGate({
    flavor: "production", applicationId: "com.ailifetime.mobile", expectedApplicationId: "com.ailifetime.mobile",
    checks: { unit: true, integration: true, device: true, visual: true, accessibility: true, security: true, privacy: true, iap: true, coldStart: true },
    crashFreeRate: 0.999, anrRate: 0.001, coldStartP95Ms: 1_900,
  });
  assert.equal(pending.codeReady, false);
  assert.deepEqual(pending.blockers, ["STORE_PROVIDER_EVIDENCE_PENDING"]);
  assert.equal(pending.externalCertification, "NOT_CERTIFIED");
});
