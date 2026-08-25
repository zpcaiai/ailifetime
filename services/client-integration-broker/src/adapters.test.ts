import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { S3Client } from "@aws-sdk/client-s3";
import {
  AwsS3MultipartObjectStore,
  HttpsEnterpriseIdentityProvider,
  OfficialWechatCodeExchange,
  RedisBrokerStore,
} from "./adapters.js";
import { BrokerError, RotatingSecretFile, sha256, type JsonValue, type MediaAssetRecord } from "./contracts.js";

function secretFixture(context: TestContext, value: string): string {
  const directory = mkdtempSync(join(tmpdir(), "ltm-client-broker-secret-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "secret");
  writeFileSync(path, `${value}\n`, { mode: 0o400 });
  chmodSync(path, 0o400);
  return path;
}

test("official WeChat adapter calls only jscode2session and returns a one-way session-key binding", async (context) => {
  const appSecret = "wechat-app-secret-value-123456789";
  const sessionKey = "wechat-session-key-value-123456789";
  const secretPath = secretFixture(context, appSecret);
  let observedUrl: URL | undefined;
  const transport = (async (input: string | URL | Request) => {
    observedUrl = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    return new Response(JSON.stringify({ openid: "openid-verified", unionid: "unionid-verified", session_key: sessionKey }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const exchange = new OfficialWechatCodeExchange(
    "wx0123456789abcdef",
    new RotatingSecretFile(secretPath, 16, 512),
    transport,
    1_000,
    () => new Date("2026-08-24T08:00:00.000Z"),
  );
  const identity = await exchange.exchange("one-time-jscode");
  assert.equal(observedUrl?.origin, "https://api.weixin.qq.com");
  assert.equal(observedUrl?.pathname, "/sns/jscode2session");
  assert.equal(observedUrl?.searchParams.get("appid"), "wx0123456789abcdef");
  assert.equal(observedUrl?.searchParams.get("secret"), appSecret);
  assert.equal(observedUrl?.searchParams.get("js_code"), "one-time-jscode");
  assert.equal(observedUrl?.searchParams.get("grant_type"), "authorization_code");
  assert.equal(identity.sessionKeySha256, sha256(sessionKey));
  assert.equal(JSON.stringify(identity).includes(sessionKey), false);
  assert.equal(identity.verifiedAt, "2026-08-24T08:00:00.000Z");
  assert.equal(await exchange.readiness(), true);
});

test("enterprise IdP receives verified identity and remains the sole session and revocation authority", async (context) => {
  const credential = "enterprise-idp-workload-token-123456789";
  const credentialPath = secretFixture(context, credential);
  const session = {
    accessToken: "enterprise-issued-session-token-123456789",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    tenantId: "enterprise-tenant",
    actorId: "enterprise-actor",
    roles: ["consumer"] as const,
    purpose: "client_session",
  };
  const requests: Array<{ url: URL; init?: RequestInit }> = [];
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    requests.push({ url, ...(init === undefined ? {} : { init }) });
    if (url.pathname === "/health/ready") return new Response(JSON.stringify({ ready: true }), { status: 200 });
    if (url.pathname.endsWith("/revoke")) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ session }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const idp = new HttpsEnterpriseIdentityProvider(
    "https://identity.example.com",
    new RotatingSecretFile(credentialPath),
    transport,
    1_000,
  );
  const identity = {
    appId: "wx0123456789abcdef",
    openId: "openid-verified",
    sessionKeySha256: sha256("server-only-session-key"),
    verifiedAt: new Date().toISOString(),
  };
  assert.deepEqual(await idp.createSession({
    identity,
    consentVersion: "privacy-v3",
    clientRequestId: "client-request-1",
    idempotencyKey: "idp-create-key",
    requestId: "request-1",
  }), session);
  assert.deepEqual(await idp.refreshSession({
    accessToken: session.accessToken,
    idempotencyKey: "idp-refresh-key",
    requestId: "request-2",
  }), session);
  await idp.revokeSession({ accessToken: session.accessToken, idempotencyKey: "idp-revoke-key", requestId: "request-3" });
  assert.equal(await idp.readiness(), true);
  const create = requests.find((request) => request.url.pathname === "/v1/wechat/sessions");
  assert.ok(create);
  assert.equal(new Headers(create.init?.headers).get("authorization"), `Bearer ${credential}`);
  assert.equal(new Headers(create.init?.headers).get("idempotency-key"), "idp-create-key");
  assert.deepEqual(JSON.parse(String(create.init?.body)), {
    verifiedWechatIdentity: identity,
    consentVersion: "privacy-v3",
    clientRequestId: "client-request-1",
  });
  const refresh = requests.find((request) => request.url.pathname.endsWith("/refresh"));
  assert.equal(new Headers(refresh?.init?.headers).get("x-ltm-subject-token"), session.accessToken);
});

test("unsafe secret projections fail closed", (context) => {
  const path = secretFixture(context, "secret-projection-value-123456789");
  chmodSync(path, 0o666);
  const secret = new RotatingSecretFile(path);
  assert.equal(secret.ready(), false);
  assert.throws(() => secret.read(), (error: unknown) => error instanceof BrokerError && error.code === "DEPENDENCY_UNAVAILABLE");
});

class FakeRedis {
  readonly values = new Map<string, string>();
  readonly setOptions = new Map<string, { readonly expiration?: { readonly type: "PX"; readonly value: number }; readonly condition?: "NX" } | undefined>();
  isReady = true;
  lastCompletedTtl = 0;

  get(key: string): Promise<string | null> { return Promise.resolve(this.values.get(key) ?? null); }
  set(key: string, value: string, options?: { readonly expiration?: { readonly type: "PX"; readonly value: number }; readonly condition?: "NX" }): Promise<string | null> {
    if (options?.condition === "NX" && this.values.has(key)) return Promise.resolve(null);
    this.values.set(key, value);
    this.setOptions.set(key, options);
    return Promise.resolve("OK");
  }
  del(key: string): Promise<number> { return Promise.resolve(this.values.delete(key) ? 1 : 0); }
  scan(cursor: string, options: { readonly MATCH: string; readonly COUNT: number }): Promise<{
    readonly cursor: string;
    readonly keys: readonly string[];
  }> {
    const prefix = options.MATCH.endsWith("*") ? options.MATCH.slice(0, -1) : options.MATCH;
    const keys = [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = Number(cursor);
    const page = keys.slice(start, start + options.COUNT);
    const next = start + page.length;
    return Promise.resolve({ cursor: next < keys.length ? String(next) : "0", keys: page });
  }
  eval(script: string, options: { readonly keys: readonly string[]; readonly arguments: readonly string[] }): Promise<unknown> {
    const key = options.keys[0] ?? "";
    const current = this.values.get(key);
    if (script.includes("tonumber(value.version)")) {
      if (current === undefined || JSON.parse(current).version !== Number(options.arguments[0])) return Promise.resolve(0);
      this.values.set(key, options.arguments[1] ?? "");
      return Promise.resolve(1);
    }
    if (script.includes("PEXPIRE")) return Promise.resolve(current === options.arguments[0] ? 1 : 0);
    if (script.includes("ARGV[3]")) {
      if (current === undefined || JSON.parse(current).leaseId !== options.arguments[0]) return Promise.resolve(0);
      this.values.set(key, options.arguments[1] ?? "");
      this.lastCompletedTtl = Number(options.arguments[2]);
      return Promise.resolve(1);
    }
    if (current === undefined) return Promise.resolve(0);
    const parsed = current.startsWith("{") ? JSON.parse(current) as { leaseId?: string; state?: string } : undefined;
    const matches = parsed === undefined ? current === options.arguments[0] : parsed.leaseId === options.arguments[0];
    if (!matches) return Promise.resolve(0);
    this.values.delete(key);
    return Promise.resolve(1);
  }
  ping(): Promise<string> { return Promise.resolve("PONG"); }
  close(): Promise<void> { return Promise.resolve(); }
}

test("Redis idempotency applies per-operation result TTL and rejects key rebinding", async () => {
  const redis = new FakeRedis();
  const store = new RedisBrokerStore(redis as never);
  let calls = 0;
  const work = async (): Promise<JsonValue> => { calls += 1; return { session: { accessToken: "credential" } }; };
  const fingerprint = sha256("request-a");
  const first = await store.execute("wechat-session.create", "key-a", fingerprint, work, { completedTtlMs: 12_345 });
  const replay = await store.execute("wechat-session.create", "key-a", fingerprint, work, { completedTtlMs: 12_345 });
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
  assert.equal(redis.lastCompletedTtl, 12_345);
  await assert.rejects(
    store.execute("wechat-session.create", "key-a", sha256("request-b"), work),
    (error: unknown) => error instanceof BrokerError && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

test("Redis upload work fails closed if its owner-token lease disappears", async () => {
  const redis = new FakeRedis();
  const store = new RedisBrokerStore(redis as never, "ltm:test:broker", 5);
  await assert.rejects(
    store.withUploadLease("upload-lease-test", async () => {
      redis.values.clear();
      await new Promise((resolve) => setTimeout(resolve, 25));
      return "must-not-succeed";
    }),
    (error: unknown) => error instanceof BrokerError && error.code === "DEPENDENCY_UNAVAILABLE",
  );
});

test("Redis media asset registry is non-expiring and preserves a durable deletion tombstone", async () => {
  const redis = new FakeRedis();
  const prefix = "ltm:test:durable-assets";
  const store = new RedisBrokerStore(redis as never, prefix);
  const sourceSha256 = sha256("source");
  const canonicalSha256 = sha256("canonical");
  const now = "2026-08-24T08:00:00.000Z";
  const asset: MediaAssetRecord = {
    schemaVersion: "ltm.media-asset.v1",
    mediaReference: "media-durable-1",
    uploadId: "upload-durable-1",
    tenantId: "tenant-1",
    ownerActorId: "actor-1",
    ownerPrincipalSha256: sha256("principal"),
    objectKey: "media/v1/tenant-1/canonical.jpeg",
    sourceSha256,
    canonicalSha256,
    lineageSha256: sha256(`ltm-media-lineage-v1\n${sourceSha256}\n${canonicalSha256}\n`),
    byteLength: 1_024,
    width: 64,
    height: 48,
    metadataStripped: true,
    safetyEvidence: {
      version: "ltm.media-safety-evidence.v2",
      requestNonce: "scan_nonce_durable_1",
      evidenceId: "scan-durable-1",
      provider: "scanner-1",
      tenantId: "tenant-1",
      actorId: "actor-1",
      mediaReference: "media-durable-1",
      canonicalSha256,
      malwareState: "clean",
      contentPolicyState: "allowed",
      faceCount: 1,
      faceSubjectReferences: ["face-1"],
      assessedAt: now,
    },
    state: "available",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  assert.deepEqual(await store.createAvailableAsset(asset), asset);
  const assetKey = `${prefix}:asset:${sha256(asset.mediaReference)}`;
  assert.deepEqual(redis.setOptions.get(assetKey), { condition: "NX" });
  assert.equal(redis.setOptions.get(assetKey)?.expiration, undefined);
  const pending: MediaAssetRecord = {
    ...asset,
    state: "deletion_pending",
    version: 2,
    deletion: {
      deletionRequestId: "delete-durable-1",
      auditId: "audit-durable-1",
      requestedByActorId: "admin-1",
      reason: "retention expired",
      requestedAt: now,
    },
  };
  assert.equal(await store.compareAndSwapAsset(asset.mediaReference, 1, pending), true);
  assert.deepEqual(await store.getAsset(asset.mediaReference), pending);
  assert.equal(redis.values.has(assetKey), true);
});

class FakeS3 {
  readonly commands: Array<{ readonly name: string; readonly input: Record<string, unknown> }> = [];
  async send(command: { readonly constructor: { readonly name: string }; readonly input: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const name = command.constructor.name;
    this.commands.push({ name, input: command.input });
    if (name === "CreateMultipartUploadCommand") return { UploadId: "provider-upload-1" };
    if (name === "UploadPartCommand") return { ETag: "etag-1", ChecksumSHA256: command.input.ChecksumSHA256 };
    if (name === "GetObjectCommand") {
      return {
        ContentLength: 4,
        Body: (async function* (): AsyncIterable<Uint8Array> { yield Buffer.from("jpeg"); })(),
      };
    }
    return {};
  }
}

test("AWS adapter binds KMS encryption, multipart checksums, and completion parts", async () => {
  const fake = new FakeS3();
  const objects = new AwsS3MultipartObjectStore(
    "ltm-production-media",
    "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
    "us-east-1",
    fake as unknown as S3Client,
  );
  const uploadId = await objects.create({ objectKey: "media/v1/tenant/media.jpeg", contentType: "image/jpeg" });
  const bytes = Buffer.from("jpeg");
  const checksum = Buffer.from(sha256(bytes), "hex").toString("base64");
  const part = await objects.putPart({
    objectKey: "media/v1/tenant/media.jpeg", providerUploadId: uploadId, partNumber: 1, bytes, sha256Base64: checksum,
  });
  await objects.complete({
    objectKey: "media/v1/tenant/media.jpeg",
    providerUploadId: uploadId,
    parts: [{ partNumber: 1, etag: part.etag, sha256: sha256(bytes) }],
  });
  const body = await objects.read({ objectKey: "media/v1/tenant/media.jpeg", maximumBytes: 4 });
  const received: Buffer[] = [];
  for await (const chunk of body) received.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(received).toString("utf8"), "jpeg");
  await objects.replace({
    objectKey: "media/v1/tenant/media.jpeg",
    bytes,
    sha256Base64: checksum,
  });
  await objects.delete({ objectKey: "media/v1/tenant/media.jpeg" });
  await objects.abort({ objectKey: "media/v1/tenant/media.jpeg", providerUploadId: uploadId });
  assert.equal(await objects.readiness(), true);
  const create = fake.commands.find((command) => command.name === "CreateMultipartUploadCommand");
  assert.equal(create?.input.ServerSideEncryption, "aws:kms");
  assert.equal(create?.input.ChecksumAlgorithm, "SHA256");
  assert.match(String(create?.input.SSEKMSKeyId), /^arn:aws:kms:/);
  const upload = fake.commands.find((command) => command.name === "UploadPartCommand");
  assert.equal(upload?.input.ChecksumSHA256, checksum);
  const complete = fake.commands.find((command) => command.name === "CompleteMultipartUploadCommand");
  assert.deepEqual((complete?.input.MultipartUpload as { Parts: unknown[] }).Parts, [{
    PartNumber: 1,
    ETag: "etag-1",
    ChecksumSHA256: checksum,
  }]);
  const replacement = fake.commands.find((command) => command.name === "PutObjectCommand");
  assert.equal(replacement?.input.ContentType, "image/jpeg");
  assert.equal(replacement?.input.ServerSideEncryption, "aws:kms");
  assert.equal(replacement?.input.ChecksumSHA256, checksum);
  assert.match(String(replacement?.input.SSEKMSKeyId), /^arn:aws:kms:/);
});

test("AWS verified deletion removes every exact version and delete marker only after Object Lock checks", async () => {
  class VersionedS3 {
    readonly commands: Array<{ readonly name: string; readonly input: Record<string, unknown> }> = [];
    versionInventories = 0;
    objectInventories = 0;
    legalHold = false;
    retentionError: Error | undefined;
    async send(command: { readonly constructor: { readonly name: string }; readonly input: Record<string, unknown> }): Promise<Record<string, unknown>> {
      const name = command.constructor.name;
      this.commands.push({ name, input: command.input });
      if (name === "ListObjectVersionsCommand") {
        this.versionInventories += 1;
        if (this.versionInventories > 1) return {};
        return {
          Versions: [
            { Key: "media/v1/tenant/media.jpeg", VersionId: "version-2" },
            { Key: "media/v1/tenant/media.jpeg", VersionId: "version-1" },
          ],
          DeleteMarkers: [{ Key: "media/v1/tenant/media.jpeg", VersionId: "marker-1" }],
        };
      }
      if (name === "ListObjectsV2Command") {
        this.objectInventories += 1;
        return this.objectInventories > 1 ? {} : { Contents: [{ Key: "media/v1/tenant/media.jpeg" }] };
      }
      if (name === "GetObjectLegalHoldCommand") return { LegalHold: { Status: this.legalHold ? "ON" : "OFF" } };
      if (name === "GetObjectRetentionCommand") {
        if (this.retentionError !== undefined) throw this.retentionError;
        return {};
      }
      return {};
    }
  }
  const fake = new VersionedS3();
  const objects = new AwsS3MultipartObjectStore(
    "ltm-production-media",
    "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
    "us-east-1",
    fake as unknown as S3Client,
  );
  const receipt = await objects.deleteVerified({ objectKey: "media/v1/tenant/media.jpeg", maximumObjects: 10 });
  assert.deepEqual(receipt, {
    state: "deleted",
    deletedVersions: 2,
    deletedMarkers: 1,
    verifiedAbsent: true,
    evidenceSha256: receipt.evidenceSha256,
  });
  assert.match(receipt.evidenceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    fake.commands.filter((command) => command.name === "DeleteObjectCommand").map((command) => command.input.VersionId),
    ["version-2", "version-1", "marker-1"],
  );
  assert.equal(fake.commands.filter((command) => command.name === "GetObjectLegalHoldCommand").length, 2);
  assert.equal(fake.commands.filter((command) => command.name === "GetObjectRetentionCommand").length, 2);

  const heldFake = new VersionedS3();
  heldFake.legalHold = true;
  const heldObjects = new AwsS3MultipartObjectStore(
    "ltm-production-media",
    "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
    "us-east-1",
    heldFake as unknown as S3Client,
  );
  const held = await heldObjects.deleteVerified({ objectKey: "media/v1/tenant/media.jpeg", maximumObjects: 10 });
  assert.equal(held.state, "held");
  assert.equal(held.hold?.reason, "legal-hold");
  assert.equal(heldFake.commands.some((command) => command.name === "GetObjectRetentionCommand"), false);
  assert.equal(heldFake.commands.some((command) => command.name === "DeleteObjectCommand"), false);

  const ambiguousFake = new VersionedS3();
  ambiguousFake.retentionError = Object.assign(new Error("request could not be evaluated"), { name: "InvalidRequest" });
  const ambiguousObjects = new AwsS3MultipartObjectStore(
    "ltm-production-media",
    "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
    "us-east-1",
    ambiguousFake as unknown as S3Client,
  );
  await assert.rejects(
    ambiguousObjects.deleteVerified({ objectKey: "media/v1/tenant/media.jpeg", maximumObjects: 10 }),
    (error: unknown) => error instanceof BrokerError && error.code === "DEPENDENCY_UNAVAILABLE",
  );
  assert.equal(ambiguousFake.commands.some((command) => command.name === "DeleteObjectCommand"), false);

  const unconfiguredFake = new VersionedS3();
  unconfiguredFake.retentionError = Object.assign(new Error("Bucket is missing Object Lock Configuration"), { name: "InvalidRequest" });
  const unconfiguredObjects = new AwsS3MultipartObjectStore(
    "ltm-production-media",
    "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
    "us-east-1",
    unconfiguredFake as unknown as S3Client,
  );
  assert.equal(
    (await unconfiguredObjects.deleteVerified({ objectKey: "media/v1/tenant/media.jpeg", maximumObjects: 10 })).state,
    "deleted",
  );
});

test("AWS exact-object deletion bounds every enumerated prefix sibling, not only accepted versions", async () => {
  class PrefixFloodS3 {
    readonly commands: Array<{ readonly name: string }> = [];
    async send(command: { readonly constructor: { readonly name: string } }): Promise<Record<string, unknown>> {
      const name = command.constructor.name;
      this.commands.push({ name });
      if (name === "ListObjectVersionsCommand") {
        return {
          Versions: Array.from({ length: 11 }, (_, index) => ({
            Key: `media/v1/tenant/media.jpeg.derived/${index}.jpeg`,
            VersionId: `version-${index}`,
          })),
        };
      }
      return {};
    }
  }
  const fake = new PrefixFloodS3();
  const objects = new AwsS3MultipartObjectStore(
    "ltm-production-media",
    "arn:aws:kms:us-east-1:111122223333:key/00000000-0000-0000-0000-000000000001",
    "us-east-1",
    fake as unknown as S3Client,
  );
  await assert.rejects(
    objects.deleteVerified({ objectKey: "media/v1/tenant/media.jpeg", maximumObjects: 10 }),
    (error: unknown) => error instanceof BrokerError && error.code === "DEPENDENCY_UNAVAILABLE" && error.retryable === false,
  );
  assert.equal(fake.commands.some((command) => command.name === "DeleteObjectCommand"), false);
});
