import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DomainError } from "@ltm/core";
import { HttpResumableUploadBroker, HttpWechatIdentityBroker } from "../dist/index.js";

const directories = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop(), { recursive: true, force: true });
});

function tokenFile() {
  const directory = mkdtempSync(join(tmpdir(), "ltm-client-broker-"));
  directories.push(directory);
  const path = join(directory, "workload-token");
  writeFileSync(path, "test-workload-identity-token-0001\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mediaProjection(assetId = "media-1", participantIds = ["consumer-1"]) {
  const sourceSha256 = "1".repeat(64);
  const canonicalSha256 = "2".repeat(64);
  return {
    assetId,
    sourceSha256,
    canonicalSha256,
    lineageSha256: createHash("sha256")
      .update(`ltm-media-lineage-v1\n${sourceSha256}\n${canonicalSha256}\n`)
      .digest("hex"),
    byteLength: 2_048,
    width: 640,
    height: 480,
    faceCount: participantIds.length,
    scanEvidenceId: "scan-evidence-1",
    scannerProvider: "trusted-media-scanner",
    scanAssessedAt: new Date(Date.now() - 60_000).toISOString(),
    participantIds: [...participantIds],
    participantMappingEvidenceId: "participant-map-evidence-1",
    participantMappingProvider: "trusted-participant-mapper",
    participantMappingAssessedAt: new Date(Date.now() - 30_000).toISOString(),
    participantMapComplete: true,
    mimeType: "image/jpeg",
    metadataStripped: true,
  };
}

function deletionProjection(assetId = "media-1", tenantId = "tenant-a") {
  const now = new Date(Date.now() - 1_000).toISOString();
  const policySha256 = "3".repeat(64);
  const deletionRequestId = "delete-request-1";
  const target = {
    schemaVersion: "ltm.media-deletion-target-receipt.v1",
    targetId: "s3-primary",
    targetKind: "s3-object",
    deletionRequestId,
    tenantId,
    mediaReference: assetId,
    canonicalSha256: "2".repeat(64),
    policySha256,
    state: "deleted",
    completedAt: now,
    evidenceSha256: "4".repeat(64),
    deletedVersions: 1,
    deletedMarkers: 0,
    verifiedAbsent: true,
  };
  return {
    mediaReference: assetId,
    state: "deleted",
    auditId: "audit-delete-1",
    deletionRequestId,
    requestedAt: now,
    deletedAt: now,
    policyId: "raw-policy-v1",
    policySha256,
    classification: "raw",
    retentionDays: 365,
    retentionExpiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    encrypted: true,
    deletionTargets: [target.targetId],
    targetReceipts: [target],
  };
}

test("HTTP WeChat identity broker sends workload auth and validates the server-resolved session", async () => {
  const calls = [];
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const broker = new HttpWechatIdentityBroker({
    baseUrl: "https://identity.example.test",
    workloadTokenFile: tokenFile(),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (String(url).endsWith("/health/ready")) return jsonResponse({ ready: true });
      if (String(url).endsWith("/revoke")) return new Response(null, { status: 204 });
      return jsonResponse({ session: {
        accessToken: "broker-access-token-value-0001",
        expiresAt,
        tenantId: "tenant-a",
        actorId: "consumer-1",
        roles: ["consumer"],
        purpose: "product_operation",
      } });
    },
  });
  const created = await broker.createSession({
    code: "single-use-code",
    consentVersion: "privacy-v1",
    clientRequestId: "client-request-1",
    idempotencyKey: "identity-create-1",
    requestId: "request-identity-1",
  });
  assert.equal(created.session.tenantId, "tenant-a");
  assert.equal(calls[0].url, "https://identity.example.test/v1/wechat/sessions");
  assert.equal(calls[0].options.headers.authorization, "Bearer test-workload-identity-token-0001");
  assert.equal(calls[0].options.headers["idempotency-key"], "identity-create-1");
  assert.equal(JSON.parse(calls[0].options.body).code, "single-use-code");
  await broker.refreshSession({ accessToken: created.session.accessToken, idempotencyKey: "refresh-1", requestId: "request-refresh-1" });
  assert.equal(calls[1].options.headers["x-ltm-subject-token"], created.session.accessToken);
  await broker.revokeSession({ accessToken: created.session.accessToken, idempotencyKey: "revoke-1", requestId: "request-revoke-1" });
  assert.equal((await broker.readiness()).ready, true);
});

test("HTTP upload broker forwards only server-resolved principal headers and exact bytes", async () => {
  const calls = [];
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const resolvedProjection = mediaProjection();
  const broker = new HttpResumableUploadBroker({
    baseUrl: "https://media.example.test",
    workloadTokenFile: tokenFile(),
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (String(url).endsWith("/chunks")) return jsonResponse({ nextOffset: 3 });
      if (String(url).endsWith("/complete")) return jsonResponse({ uploadId: "upload-1", mediaReference: "media-1", state: "available" });
      if (String(url).endsWith("/v1/media/intakes/resolve")) return jsonResponse(resolvedProjection);
      if (String(url).endsWith("/v1/media/assets/media-1/delete")) return jsonResponse(deletionProjection());
      if (String(url).endsWith("/cancel")) return new Response(null, { status: 204 });
      return jsonResponse({ uploadId: "upload-1", nextOffset: 0, expiresAt });
    },
  });
  const context = { actorId: "consumer-1", tenantId: "tenant-a", roles: ["consumer"], purpose: "product_operation", requestId: "request-1" };
  await broker.create(context, {
    fileSize: 3, fileDigest: "a".repeat(64), digestAlgorithm: "sha256", contentType: "image/jpeg",
    clientRequestId: "client-upload-1", idempotencyKey: "create-1",
  });
  await broker.append(context, {
    uploadId: "upload-1", bytes: Buffer.from("abc"), start: 0, end: 2, total: 3, idempotencyKey: "chunk-1",
  });
  assert.equal(calls[1].url, "https://media.example.test/v1/media/uploads/upload-1/chunks");
  assert.equal(calls[1].options.headers["x-ltm-tenant-id"], "tenant-a");
  assert.equal(calls[1].options.headers["content-range"], "bytes 0-2/3");
  assert.equal(Buffer.from(calls[1].options.body).toString("utf8"), "abc");
  assert.deepEqual(await broker.complete(context, {
    uploadId: "upload-1", fileDigest: "a".repeat(64), digestAlgorithm: "sha256", idempotencyKey: "complete-1",
  }), { uploadId: "upload-1", assetId: "media-1", state: "available" });
  const intake = await broker.resolveIntake(context, {
    assetId: "media-1", participantIds: ["consumer-1"], idempotencyKey: "resolve-intake-1",
  });
  assert.deepEqual(intake, resolvedProjection);
  assert.equal(calls[3].url, "https://media.example.test/v1/media/intakes/resolve");
  assert.equal(calls[3].options.headers["idempotency-key"], "resolve-intake-1");
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    principal: {
      tenantId: "tenant-a",
      actorId: "consumer-1",
      roles: ["consumer"],
      purpose: "product_operation",
    },
    mediaReference: "media-1",
    participantIds: ["consumer-1"],
  });
  const adminContext = {
    actorId: "admin-1",
    tenantId: "tenant-a",
    roles: ["platform_admin"],
    purpose: "product_operation",
    requestId: "request-delete-1",
  };
  const deletion = await broker.deleteAsset(adminContext, {
    assetId: "media-1",
    reason: "B05 immediate retention",
    idempotencyKey: "delete-1",
  });
  assert.equal(deletion.mediaReference, "media-1");
  assert.equal(deletion.state, "deleted");
  assert.equal(calls[4].url, "https://media.example.test/v1/media/assets/media-1/delete");
  assert.equal(calls[4].options.headers["idempotency-key"], "delete-1");
  assert.deepEqual(JSON.parse(calls[4].options.body), {
    principal: {
      actorId: "admin-1",
      tenantId: "tenant-a",
      roles: ["platform_admin"],
      purpose: "product_operation",
    },
    reason: "B05 immediate retention",
  });
  await broker.cancel(context, { uploadId: "upload-1", idempotencyKey: "cancel-1" });
});

test("broker configuration and malformed dependency responses fail closed", async () => {
  assert.throws(
    () => new HttpWechatIdentityBroker({ baseUrl: "http://identity.example.test", workloadTokenFile: tokenFile() }),
    (error) => error instanceof DomainError && error.code === "CONFIGURATION_INVALID",
  );
  const broker = new HttpWechatIdentityBroker({
    baseUrl: "https://identity.example.test",
    workloadTokenFile: tokenFile(),
    fetch: async () => jsonResponse({ session: { accessToken: "attacker-token" } }),
  });
  await assert.rejects(
    broker.createSession({ code: "code", consentVersion: "v1", clientRequestId: "request-1", idempotencyKey: "idem-1", requestId: "request-1" }),
    (error) => error instanceof DomainError && error.code === "EXTERNAL_ADAPTER_UNAVAILABLE",
  );

  const duplicateRoleBroker = new HttpWechatIdentityBroker({
    baseUrl: "https://identity.example.test",
    workloadTokenFile: tokenFile(),
    fetch: async () => jsonResponse({ session: {
      accessToken: "broker-access-token-value-0001",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      tenantId: "tenant-a",
      actorId: "consumer-1",
      roles: ["consumer", "consumer"],
      purpose: "product_operation",
    } }),
  });
  await assert.rejects(
    duplicateRoleBroker.createSession({ code: "code", consentVersion: "v1", clientRequestId: "request-2", idempotencyKey: "idem-2", requestId: "request-2" }),
    (error) => error instanceof DomainError && error.code === "EXTERNAL_ADAPTER_UNAVAILABLE",
  );

  const openMediaResponseBroker = new HttpResumableUploadBroker({
    baseUrl: "https://media.example.test",
    workloadTokenFile: tokenFile(),
    fetch: async () => jsonResponse({ ...mediaProjection(), callerControlledSafetyOverride: true }),
  });
  await assert.rejects(
    openMediaResponseBroker.resolveIntake(
      { actorId: "consumer-1", tenantId: "tenant-a", roles: ["consumer"], purpose: "age_transformation", requestId: "request-media-1" },
      { assetId: "media-1", participantIds: ["consumer-1"], idempotencyKey: "resolve-media-open-response-1" },
    ),
    (error) => error instanceof DomainError && error.code === "EXTERNAL_ADAPTER_UNAVAILABLE",
  );

  const wrongLineageBroker = new HttpResumableUploadBroker({
    baseUrl: "https://media.example.test",
    workloadTokenFile: tokenFile(),
    fetch: async () => jsonResponse({ ...mediaProjection(), lineageSha256: "0".repeat(64) }),
  });
  await assert.rejects(
    wrongLineageBroker.resolveIntake(
      { actorId: "consumer-1", tenantId: "tenant-a", roles: ["consumer"], purpose: "age_transformation", requestId: "request-media-2" },
      { assetId: "media-1", participantIds: ["consumer-1"], idempotencyKey: "resolve-media-wrong-lineage-1" },
    ),
    (error) => error instanceof DomainError && error.code === "EXTERNAL_ADAPTER_UNAVAILABLE",
  );

  const wrongDeletionBindingBroker = new HttpResumableUploadBroker({
    baseUrl: "https://media.example.test",
    workloadTokenFile: tokenFile(),
    fetch: async () => jsonResponse({ ...deletionProjection("media-attacker"), auditId: "audit-attacker" }),
  });
  await assert.rejects(
    wrongDeletionBindingBroker.deleteAsset(
      { actorId: "admin-1", tenantId: "tenant-a", roles: ["platform_admin"], purpose: "product_operation", requestId: "request-delete-2" },
      { assetId: "media-1", reason: "B05 immediate retention", idempotencyKey: "delete-wrong-binding-1" },
    ),
    (error) => error instanceof DomainError && error.code === "EXTERNAL_ADAPTER_UNAVAILABLE",
  );

  const incompleteReceipt = deletionProjection();
  const wrongReceiptBindingBroker = new HttpResumableUploadBroker({
    baseUrl: "https://media.example.test",
    workloadTokenFile: tokenFile(),
    fetch: async () => jsonResponse({
      ...incompleteReceipt,
      targetReceipts: [{ ...incompleteReceipt.targetReceipts[0], policySha256: "f".repeat(64) }],
    }),
  });
  await assert.rejects(
    wrongReceiptBindingBroker.deleteAsset(
      { actorId: "admin-1", tenantId: "tenant-a", roles: ["platform_admin"], purpose: "product_operation", requestId: "request-delete-3" },
      { assetId: "media-1", reason: "B05 receipt binding", idempotencyKey: "delete-wrong-receipt-binding-1" },
    ),
    (error) => error instanceof DomainError && error.code === "EXTERNAL_ADAPTER_UNAVAILABLE",
  );

  const weakS3Receipt = deletionProjection();
  const weakS3ReceiptBroker = new HttpResumableUploadBroker({
    baseUrl: "https://media.example.test",
    workloadTokenFile: tokenFile(),
    fetch: async () => {
      const { verifiedAbsent: _verifiedAbsent, ...receipt } = weakS3Receipt.targetReceipts[0];
      return jsonResponse({ ...weakS3Receipt, targetReceipts: [receipt] });
    },
  });
  await assert.rejects(
    weakS3ReceiptBroker.deleteAsset(
      { actorId: "admin-1", tenantId: "tenant-a", roles: ["platform_admin"], purpose: "product_operation", requestId: "request-delete-4" },
      { assetId: "media-1", reason: "B05 S3 proof binding", idempotencyKey: "delete-weak-s3-receipt-1" },
    ),
    (error) => error instanceof DomainError && error.code === "EXTERNAL_ADAPTER_UNAVAILABLE",
  );

  const splitDigest = deletionProjection();
  const splitDigestBroker = new HttpResumableUploadBroker({
    baseUrl: "https://media.example.test",
    workloadTokenFile: tokenFile(),
    fetch: async () => jsonResponse({
      ...splitDigest,
      deletionTargets: ["s3-primary", "s3-derived"],
      targetReceipts: [
        splitDigest.targetReceipts[0],
        {
          ...splitDigest.targetReceipts[0],
          targetId: "s3-derived",
          targetKind: "s3-prefix",
          canonicalSha256: "9".repeat(64),
        },
      ],
    }),
  });
  await assert.rejects(
    splitDigestBroker.deleteAsset(
      { actorId: "admin-1", tenantId: "tenant-a", roles: ["platform_admin"], purpose: "product_operation", requestId: "request-delete-5" },
      { assetId: "media-1", reason: "B05 canonical proof binding", idempotencyKey: "delete-split-canonical-1" },
    ),
    (error) => error instanceof DomainError && error.code === "EXTERNAL_ADAPTER_UNAVAILABLE",
  );
});
