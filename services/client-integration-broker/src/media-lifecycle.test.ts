import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { BrokerError, sha256, type MediaAssetRecord, type MultipartObjectStore, type Principal } from "./contracts.js";
import {
  MediaDownloadAuthorizer,
  loadSignedMediaLifecycleRegistry,
} from "./media-lifecycle.js";

function secureFile(context: TestContext, directory: string, name: string, value: string): string {
  const path = join(directory, name);
  writeFileSync(path, value, { mode: 0o400 });
  chmodSync(path, 0o400);
  context.after(() => rmSync(path, { force: true }));
  return path;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

test("signed lifecycle catalog is digest-bound and closes classification to server-owned deletion targets", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ltm-media-lifecycle-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const catalogKeys = generateKeyPairSync("ed25519");
  const receiptKeys = generateKeyPairSync("ed25519");
  const trustKey = secureFile(context, directory, "catalog.pub", catalogKeys.publicKey.export({ type: "spki", format: "pem" }).toString());
  const receiptKey = secureFile(context, directory, "receipt.pub", receiptKeys.publicKey.export({ type: "spki", format: "pem" }).toString());
  const credentialFile = secureFile(context, directory, "remote.token", "remote-deletion-workload-token-value-123456789\n");
  const now = new Date();
  const unsigned = {
    schemaVersion: "ltm.media-lifecycle-policy-catalog.v1",
    catalogId: "production-media-policy-1",
    issuer: "ltm-privacy-policy-authority",
    environment: "production",
    keyId: "media-policy-key-1",
    issuedAt: new Date(now.getTime() - 60_000).toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
    policies: [{
      policyId: "raw-policy-1",
      classification: "raw",
      retentionDays: 30,
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
        receiptPublicKeyFile: receiptKey,
      },
    ],
  };
  const signature = sign(null, Buffer.from(canonical(unsigned)), catalogKeys.privateKey).toString("base64url");
  const catalogFile = secureFile(context, directory, "catalog.json", JSON.stringify({ ...unsigned, signature }));
  let remoteRequest: Record<string, unknown> | undefined;
  const registry = loadSignedMediaLifecycleRegistry({
    catalogFile,
    trustPublicKeyFile: trustKey,
    expectedKeyId: "media-policy-key-1",
    expectedIssuer: "ltm-privacy-policy-authority",
    expectedEnvironment: "production",
    targetSecretRoot: directory,
    now,
    fetch: (async (_url, init) => {
      remoteRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const signedReceipt = {
        schemaVersion: "ltm.media-deletion-receipt.v1",
        receiptId: "remote-receipt-1",
        requestNonce: remoteRequest.requestNonce,
        targetId: remoteRequest.targetId,
        deletionRequestId: remoteRequest.deletionRequestId,
        tenantId: remoteRequest.tenantId,
        mediaReference: remoteRequest.mediaReference,
        canonicalSha256: remoteRequest.canonicalSha256,
        policySha256: remoteRequest.policySha256,
        state: "deleted",
        completedAt: new Date().toISOString(),
        evidenceSha256: "e".repeat(64),
      };
      return new Response(JSON.stringify({
        ...signedReceipt,
        signature: sign(null, Buffer.from(canonical(signedReceipt)), receiptKeys.privateKey).toString("base64url"),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  const binding = registry.bindAsset({
    objectKey: "media/v1/tenant-1/canonical.jpeg",
    createdAt: now.toISOString(),
    now,
  });
  assert.equal(binding.classification, "raw");
  assert.equal(binding.retentionDays, 30);
  assert.deepEqual(binding.deletionTargets, [
    { targetId: "s3-primary", kind: "s3-object", locator: "media/v1/tenant-1/canonical.jpeg" },
    { targetId: "s3-derived", kind: "s3-prefix", locator: "media/v1/tenant-1/canonical.jpeg.derived/" },
    { targetId: "remote-backup", kind: "https", locator: "https://backup.example.test/v1/media/delete" },
  ]);
  assert.match(binding.policySha256, /^[a-f0-9]{64}$/);

  const remote = binding.deletionTargets[2];
  assert.ok(remote);
  const receipt = await registry.executeDeletion({} as MultipartObjectStore, {
    deletionRequestId: "delete-request-1",
    tenantId: "tenant-1",
    mediaReference: "media-1",
    canonicalSha256: "c".repeat(64),
    policySha256: binding.policySha256,
    target: remote,
  });
  assert.equal(receipt.targetId, "remote-backup");
  assert.equal(receipt.providerReceiptId, "remote-receipt-1");
  assert.equal(remoteRequest?.policySha256, binding.policySha256);

  assert.throws(
    () => loadSignedMediaLifecycleRegistry({
      catalogFile,
      trustPublicKeyFile: trustKey,
      expectedKeyId: "media-policy-key-1",
      expectedIssuer: "ltm-privacy-policy-authority",
      expectedEnvironment: "production",
      targetSecretRoot: join(directory, "different-secret-root"),
      now,
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "CONFIGURATION_INVALID",
  );

  chmodSync(catalogFile, 0o600);
  writeFileSync(catalogFile, JSON.stringify({ ...unsigned, policies: [{ ...unsigned.policies[0], retentionDays: 0 }], signature }));
  chmodSync(catalogFile, 0o400);
  assert.throws(
    () => loadSignedMediaLifecycleRegistry({
      catalogFile,
      trustPublicKeyFile: trustKey,
      expectedKeyId: "media-policy-key-1",
      expectedIssuer: "ltm-privacy-policy-authority",
      expectedEnvironment: "production",
      targetSecretRoot: directory,
      now,
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "CONFIGURATION_INVALID",
  );
});

test("download authorization is short-lived and cryptographically bound to audience, purpose, asset, tenant, and digest", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "ltm-media-download-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const privateKeyFile = secureFile(context, directory, "download.key", keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const publicKeyFile = secureFile(context, directory, "download.pub", keys.publicKey.export({ type: "spki", format: "pem" }).toString());
  const authorizer = new MediaDownloadAuthorizer({
    privateKeyFile,
    publicKeyFile,
    baseUrl: "https://media.example.test",
    issuer: "ltm-media-broker",
    maximumTtlSeconds: 300,
  });
  const now = new Date();
  const asset = {
    state: "available",
    tenantId: "tenant-1",
    mediaReference: "media-1",
    canonicalSha256: sha256("canonical-media"),
  } as MediaAssetRecord;
  const principal: Principal = {
    actorId: "actor-1",
    tenantId: "tenant-1",
    roles: ["consumer"],
    purpose: "memorial_view",
  };
  const issued = authorizer.issue(asset, principal, { audience: "actor-1", purpose: "memorial_view", ttlSeconds: 60, now });
  assert.match(issued.downloadUrl, /^https:\/\/media\.example\.test\/v1\/media\/downloads\//);
  const claims = authorizer.verify(issued.token, principal, asset, new Date(now.getTime() + 30_000));
  assert.equal(claims.mediaReference, "media-1");
  assert.equal(claims.audience, "actor-1");
  assert.throws(
    () => authorizer.verify(issued.token, { ...principal, actorId: "actor-2" }, asset, new Date(now.getTime() + 30_000)),
    (error: unknown) => error instanceof BrokerError && error.code === "AUTH_UNAUTHENTICATED",
  );
  assert.throws(
    () => authorizer.verify(issued.token, principal, asset, new Date(now.getTime() + 61_000)),
    (error: unknown) => error instanceof BrokerError && error.code === "AUTH_UNAUTHENTICATED",
  );
});
