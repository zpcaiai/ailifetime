import { randomUUID } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectLegalHoldCommand,
  GetObjectCommand,
  GetObjectRetentionCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { createClient } from "redis";
import {
  BrokerError,
  RotatingSecretFile,
  bounded,
  configuration,
  conflict,
  dependency,
  exactKeys,
  identifier,
  object,
  safeInteger,
  sha256,
  timestamp,
  validateMediaAssetRecord,
  validateSession,
  validation,
  type EnterpriseIdentityPort,
  type IdempotencyStore,
  type JsonValue,
  type MediaAssetRecord,
  type MediaAssetStore,
  type MultipartObjectStore,
  type SessionProjection,
  type UploadState,
  type UploadStateStore,
  type VerifiedWechatIdentity,
  type WechatCodeExchangePort,
} from "./contracts.js";

const MAX_JSON_RESPONSE_BYTES = 512 * 1024;
const IDEMPOTENCY_RUNNING_TTL_MS = 5 * 60_000;
const IDEMPOTENCY_RESULT_TTL_MS = 7 * 24 * 60 * 60_000;
const UPLOAD_STATE_TTL_MS = 25 * 60 * 60_000;
const UPLOAD_LEASE_TTL_MS = 60_000;
const UPLOAD_LEASE_RENEWAL_MS = 20_000;

interface RedisClientPort {
  readonly isReady: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: {
    readonly expiration?: { readonly type: "PX"; readonly value: number };
    readonly condition?: "NX";
  }): Promise<string | null>;
  del(key: string): Promise<number>;
  scan(cursor: string, options: { readonly MATCH: string; readonly COUNT: number }): Promise<{
    readonly cursor: string;
    readonly keys: readonly string[];
  }>;
  eval(script: string, options: { readonly keys: readonly string[]; readonly arguments: readonly string[] }): Promise<unknown>;
  ping(): Promise<string>;
  close(): Promise<void>;
}

interface StoredIdempotency {
  readonly fingerprint: string;
  readonly state: "running" | "completed";
  readonly leaseId: string;
  readonly response?: JsonValue;
}

export class RedisBrokerStore implements IdempotencyStore, UploadStateStore, MediaAssetStore {
  readonly #prefix: string;
  readonly #uploadLeaseRenewalMs: number;
  #closed = false;

  constructor(
    private readonly client: RedisClientPort,
    prefix = "ltm:client-broker:v1",
    uploadLeaseRenewalMs = UPLOAD_LEASE_RENEWAL_MS,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(prefix)) throw configuration("Redis key prefix is invalid");
    if (!Number.isSafeInteger(uploadLeaseRenewalMs) || uploadLeaseRenewalMs < 1 || uploadLeaseRenewalMs > UPLOAD_LEASE_RENEWAL_MS) {
      throw configuration("Redis upload lease renewal interval is invalid");
    }
    this.#prefix = prefix;
    this.#uploadLeaseRenewalMs = uploadLeaseRenewalMs;
  }

  static async connect(urlValue: string, allowInsecureLoopback = false, timeoutMs = 5_000): Promise<RedisBrokerStore> {
    let url: URL;
    try { url = new URL(urlValue); } catch { throw configuration("Redis URL is invalid"); }
    const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (url.password === "" ||
        (url.protocol !== "rediss:" && !(allowInsecureLoopback && loopback && url.protocol === "redis:"))) {
      throw configuration("Redis requires TLS and authenticated credentials");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) throw configuration("Redis timeout is invalid");
    const client = createClient({
      url: url.toString(),
      commandOptions: { timeout: timeoutMs },
      commandsQueueMaxLength: 1_000,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: timeoutMs,
        reconnectStrategy: (retries: number) => retries > 5 ? false : Math.min(100 * 2 ** retries, 2_000),
      },
    });
    client.on("error", () => undefined);
    try { await client.connect(); } catch {
      client.destroy();
      throw dependency("Redis broker store could not connect");
    }
    return new RedisBrokerStore(client as unknown as RedisClientPort);
  }

  async execute<T extends JsonValue>(
    operation: string,
    key: string,
    requestFingerprint: string,
    work: () => Promise<T>,
    policy?: { readonly completedTtlMs?: number | ((response: T) => number) },
  ): Promise<T> {
    identifier(operation, "idempotency operation");
    bounded(key, "idempotency key", 200);
    if (!/^[a-f0-9]{64}$/.test(requestFingerprint)) throw validation("idempotency fingerprint is invalid");
    const redisKey = `${this.#prefix}:idem:${sha256(`${operation}\n${key}`)}`;
    const leaseId = randomUUID();
    const running: StoredIdempotency = { fingerprint: requestFingerprint, state: "running", leaseId };
    let acquired: string | null;
    try {
      acquired = await this.client.set(redisKey, JSON.stringify(running), {
        expiration: { type: "PX", value: IDEMPOTENCY_RUNNING_TTL_MS },
        condition: "NX",
      });
    } catch { throw dependency("Redis idempotency store is unavailable"); }
    if (acquired !== "OK") {
      const existing = await this.#idempotency(redisKey);
      if (existing.fingerprint !== requestFingerprint) throw conflict("idempotency key was reused for a different request", true);
      if (existing.state === "completed" && existing.response !== undefined) return existing.response as T;
      throw conflict("the idempotent operation is already in progress");
    }
    try {
      const response = await work();
      const configuredTtl = typeof policy?.completedTtlMs === "function"
        ? policy.completedTtlMs(response)
        : policy?.completedTtlMs ?? IDEMPOTENCY_RESULT_TTL_MS;
      if (!Number.isSafeInteger(configuredTtl) || configuredTtl < 1 || configuredTtl > IDEMPOTENCY_RESULT_TTL_MS) {
        throw dependency("idempotency result TTL is invalid", false);
      }
      const serialized = JSON.stringify({ fingerprint: requestFingerprint, state: "completed", leaseId, response } satisfies StoredIdempotency);
      if (Buffer.byteLength(serialized) > MAX_JSON_RESPONSE_BYTES) throw dependency("idempotent response is too large", false);
      const stored = await this.client.eval(COMPLETE_IDEMPOTENCY_LUA, {
        keys: [redisKey],
        arguments: [leaseId, serialized, String(configuredTtl)],
      });
      if (Number(stored) !== 1) throw dependency("idempotency lease was lost before completion");
      return response;
    } catch (error) {
      await this.client.eval(RELEASE_IDEMPOTENCY_LUA, { keys: [redisKey], arguments: [leaseId] }).catch(() => undefined);
      throw error;
    }
  }

  async create(state: UploadState): Promise<void> {
    validateStoredUpload(state);
    try {
      const result = await this.client.set(this.#uploadKey(state.uploadId), JSON.stringify(state), {
        expiration: { type: "PX", value: UPLOAD_STATE_TTL_MS }, condition: "NX",
      });
      if (result !== "OK") throw conflict("upload already exists");
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw dependency("Redis upload state is unavailable");
    }
  }

  async get(uploadId: string): Promise<UploadState | undefined> {
    let value: string | null;
    try { value = await this.client.get(this.#uploadKey(identifier(uploadId, "uploadId"))); }
    catch { throw dependency("Redis upload state is unavailable"); }
    if (value === null) return undefined;
    try {
      const state = JSON.parse(value) as UploadState;
      validateStoredUpload(state);
      return state;
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw dependency("stored upload state is invalid", false);
    }
  }

  async compareAndSwap(uploadId: string, expectedVersion: number, state: UploadState): Promise<boolean> {
    validateStoredUpload(state);
    if (state.uploadId !== uploadId || state.version !== expectedVersion + 1) throw validation("upload CAS state is invalid");
    let result: unknown;
    try {
      result = await this.client.eval(CAS_UPLOAD_LUA, {
        keys: [this.#uploadKey(uploadId)],
        arguments: [String(expectedVersion), JSON.stringify(state), String(UPLOAD_STATE_TTL_MS)],
      });
    } catch { throw dependency("Redis upload state is unavailable"); }
    return Number(result) === 1;
  }

  async withUploadLease<T>(uploadId: string, work: () => Promise<T>): Promise<T> {
    const lockKey = `${this.#prefix}:upload-lock:${sha256(identifier(uploadId, "uploadId"))}`;
    const leaseId = randomUUID();
    let acquired: string | null;
    try {
      acquired = await this.client.set(lockKey, leaseId, {
        expiration: { type: "PX", value: UPLOAD_LEASE_TTL_MS }, condition: "NX",
      });
    } catch { throw dependency("Redis upload lease is unavailable"); }
    if (acquired !== "OK") throw conflict("upload is being changed by another request");
    let leaseLost = false;
    let renewalRunning = false;
    const renew = (): void => {
      if (renewalRunning || leaseLost) return;
      renewalRunning = true;
      void this.client.eval(RENEW_UPLOAD_LEASE_LUA, {
        keys: [lockKey], arguments: [leaseId, String(UPLOAD_LEASE_TTL_MS)],
      }).then((result) => { if (Number(result) !== 1) leaseLost = true; })
        .catch(() => { leaseLost = true; })
        .finally(() => { renewalRunning = false; });
    };
    const renewal = setInterval(renew, this.#uploadLeaseRenewalMs);
    renewal.unref();
    try {
      const result = await work();
      if (leaseLost) throw dependency("Redis upload lease was lost before completion");
      return result;
    }
    finally {
      clearInterval(renewal);
      await this.client.eval(RELEASE_UPLOAD_LEASE_LUA, { keys: [lockKey], arguments: [leaseId] }).catch(() => undefined);
    }
  }

  async createAvailableAsset(asset: MediaAssetRecord): Promise<MediaAssetRecord> {
    validateMediaAssetRecord(asset);
    if (asset.state !== "available" || asset.version !== 1 || asset.deletion !== undefined) {
      throw validation("new media asset must be an available version-one record");
    }
    let result: string | null;
    try {
      result = await this.client.set(this.#assetKey(asset.mediaReference), JSON.stringify(asset), { condition: "NX" });
    } catch { throw dependency("Redis media asset registry is unavailable"); }
    if (result === "OK") return asset;
    const existing = await this.getAsset(asset.mediaReference);
    if (existing === undefined || immutableAssetFingerprint(existing) !== immutableAssetFingerprint(asset)) {
      throw dependency("media asset registry binding conflicts with the verified upload", false);
    }
    return existing;
  }

  async getAsset(mediaReference: string): Promise<MediaAssetRecord | undefined> {
    let value: string | null;
    try { value = await this.client.get(this.#assetKey(identifier(mediaReference, "mediaReference"))); }
    catch { throw dependency("Redis media asset registry is unavailable"); }
    if (value === null) return undefined;
    try {
      const asset = JSON.parse(value) as MediaAssetRecord;
      validateMediaAssetRecord(asset);
      return asset;
    } catch (error) {
      if (error instanceof BrokerError && error.code === "DEPENDENCY_UNAVAILABLE") throw error;
      throw dependency("stored media asset is invalid", false);
    }
  }

  async listAssets(input: { readonly cursor?: string; readonly limit: number }): Promise<{
    readonly assets: readonly MediaAssetRecord[];
    readonly cursor?: string;
  }> {
    const limit = safeInteger(input.limit, "asset inventory limit", 1, 1_000);
    const cursor = input.cursor ?? "0";
    if (!/^\d{1,32}$/.test(cursor)) throw validation("asset inventory cursor is invalid");
    let result: { readonly cursor: string; readonly keys: readonly string[] };
    try {
      result = await this.client.scan(cursor, { MATCH: `${this.#prefix}:asset:*`, COUNT: limit });
    } catch { throw dependency("Redis media asset inventory is unavailable"); }
    if (!/^\d{1,32}$/.test(result.cursor) || result.keys.length > limit) throw dependency("Redis media asset inventory response is invalid", false);
    const assets: MediaAssetRecord[] = [];
    for (const key of result.keys) {
      let raw: string | null;
      try { raw = await this.client.get(key); }
      catch { throw dependency("Redis media asset inventory is unavailable"); }
      if (raw === null) continue;
      let asset: MediaAssetRecord;
      try { asset = JSON.parse(raw) as MediaAssetRecord; }
      catch { throw dependency("stored media asset is invalid", false); }
      validateMediaAssetRecord(asset);
      assets.push(asset);
    }
    return { assets, ...(result.cursor === "0" ? {} : { cursor: result.cursor }) };
  }

  async compareAndSwapAsset(mediaReference: string, expectedVersion: number, asset: MediaAssetRecord): Promise<boolean> {
    validateMediaAssetRecord(asset);
    if (asset.mediaReference !== mediaReference || asset.version !== expectedVersion + 1) {
      throw validation("media asset CAS state is invalid");
    }
    let result: unknown;
    try {
      result = await this.client.eval(CAS_ASSET_LUA, {
        keys: [this.#assetKey(mediaReference)],
        arguments: [String(expectedVersion), JSON.stringify(asset)],
      });
    } catch { throw dependency("Redis media asset registry is unavailable"); }
    return Number(result) === 1;
  }

  async withAssetLease<T>(mediaReference: string, work: () => Promise<T>): Promise<T> {
    const lockKey = `${this.#prefix}:asset-lock:${sha256(identifier(mediaReference, "mediaReference"))}`;
    const leaseId = randomUUID();
    let acquired: string | null;
    try {
      acquired = await this.client.set(lockKey, leaseId, {
        expiration: { type: "PX", value: UPLOAD_LEASE_TTL_MS }, condition: "NX",
      });
    } catch { throw dependency("Redis media asset lease is unavailable"); }
    if (acquired !== "OK") throw conflict("media asset is being changed by another request");
    let leaseLost = false;
    let renewalRunning = false;
    const renew = (): void => {
      if (renewalRunning || leaseLost) return;
      renewalRunning = true;
      void this.client.eval(RENEW_UPLOAD_LEASE_LUA, {
        keys: [lockKey], arguments: [leaseId, String(UPLOAD_LEASE_TTL_MS)],
      }).then((renewed) => { if (Number(renewed) !== 1) leaseLost = true; })
        .catch(() => { leaseLost = true; })
        .finally(() => { renewalRunning = false; });
    };
    const renewal = setInterval(renew, this.#uploadLeaseRenewalMs);
    renewal.unref();
    try {
      const result = await work();
      if (leaseLost) throw dependency("Redis media asset lease was lost before completion");
      return result;
    } finally {
      clearInterval(renewal);
      await this.client.eval(RELEASE_UPLOAD_LEASE_LUA, { keys: [lockKey], arguments: [leaseId] }).catch(() => undefined);
    }
  }

  async readiness(): Promise<boolean> {
    try { return this.client.isReady && await this.client.ping() === "PONG"; } catch { return false; }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.client.close();
  }

  async #idempotency(key: string): Promise<StoredIdempotency> {
    let value: string | null;
    try { value = await this.client.get(key); } catch { throw dependency("Redis idempotency store is unavailable"); }
    if (value === null) throw dependency("idempotency lease disappeared");
    try {
      const record = JSON.parse(value) as StoredIdempotency;
      if (!/^[a-f0-9]{64}$/.test(record.fingerprint) || !["running", "completed"].includes(record.state) ||
          typeof record.leaseId !== "string") throw new Error("invalid");
      return record;
    } catch { throw dependency("stored idempotency state is invalid", false); }
  }

  #uploadKey(uploadId: string): string { return `${this.#prefix}:upload:${sha256(uploadId)}`; }
  #assetKey(mediaReference: string): string { return `${this.#prefix}:asset:${sha256(mediaReference)}`; }
}

export class OfficialWechatCodeExchange implements WechatCodeExchangePort {
  readonly #endpoint = "https://api.weixin.qq.com/sns/jscode2session";

  constructor(
    private readonly appId: string,
    private readonly appSecret: RotatingSecretFile,
    private readonly fetchTransport: typeof fetch = fetch,
    private readonly timeoutMs = 8_000,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!/^wx[a-f0-9]{16}$/.test(appId)) throw configuration("WeChat App ID is invalid");
  }

  async exchange(codeValue: string): Promise<VerifiedWechatIdentity> {
    const code = bounded(codeValue, "WeChat login code", 512);
    const secret = this.appSecret.read();
    const url = new URL(this.#endpoint);
    url.searchParams.set("appid", this.appId);
    url.searchParams.set("secret", secret);
    url.searchParams.set("js_code", code);
    url.searchParams.set("grant_type", "authorization_code");
    const value = object(await boundedFetchJson(this.fetchTransport, url, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs), headers: { accept: "application/json" },
    }), "WeChat code exchange response");
    if (value.errcode !== undefined && value.errcode !== 0) throw validation("WeChat login code was rejected");
    const openId = identifier(value.openid, "WeChat openid");
    const sessionKey = bounded(value.session_key, "WeChat session key", 512, 16);
    const unionId = value.unionid === undefined ? undefined : identifier(value.unionid, "WeChat unionid");
    return {
      appId: this.appId,
      openId,
      ...(unionId === undefined ? {} : { unionId }),
      sessionKeySha256: sha256(sessionKey),
      verifiedAt: this.clock().toISOString(),
    };
  }

  readiness(): Promise<boolean> { return Promise.resolve(this.appSecret.ready()); }
}

export class HttpsEnterpriseIdentityProvider implements EnterpriseIdentityPort {
  readonly #origin: string;

  constructor(
    baseUrl: string,
    private readonly credential: RotatingSecretFile,
    private readonly fetchTransport: typeof fetch = fetch,
    private readonly timeoutMs = 8_000,
  ) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw configuration("enterprise IdP URL is invalid"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
      throw configuration("enterprise IdP must be a credential-free HTTPS origin");
    }
    this.#origin = url.origin;
  }

  async createSession(input: Parameters<EnterpriseIdentityPort["createSession"]>[0]): Promise<SessionProjection> {
    return this.#session("/v1/wechat/sessions", {
      verifiedWechatIdentity: input.identity,
      consentVersion: bounded(input.consentVersion, "consentVersion", 128),
      clientRequestId: identifier(input.clientRequestId, "clientRequestId"),
    }, input.idempotencyKey, input.requestId);
  }

  refreshSession(input: Parameters<EnterpriseIdentityPort["refreshSession"]>[0]): Promise<SessionProjection> {
    return this.#session("/v1/wechat/sessions/refresh", {}, input.idempotencyKey, input.requestId, input.accessToken);
  }

  async revokeSession(input: Parameters<EnterpriseIdentityPort["revokeSession"]>[0]): Promise<void> {
    const response = await this.#request("/v1/wechat/sessions/revoke", {}, input.idempotencyKey, input.requestId, input.accessToken);
    if (response.status !== 204) throw dependency("enterprise IdP returned an invalid revoke response", false);
  }

  async readiness(): Promise<boolean> {
    if (!this.credential.ready()) return false;
    try {
      const response = await this.fetchTransport(`${this.#origin}/health/ready`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept: "application/json", authorization: `Bearer ${this.credential.read()}` },
      });
      if (!response.ok) return false;
      const value = object(await boundedResponseJson(response), "IdP readiness response");
      return value.ready === true;
    } catch { return false; }
  }

  async #session(path: string, body: object, key: string, requestId: string, subjectToken?: string): Promise<SessionProjection> {
    const response = await this.#request(path, body, key, requestId, subjectToken);
    if (!response.ok) throw dependency("enterprise IdP rejected the session request", response.status >= 500);
    const value = object(await boundedResponseJson(response), "IdP session response");
    exactKeys(value, ["session"], "IdP session response");
    const session = object(value.session, "IdP session");
    exactKeys(session, ["accessToken", "expiresAt", "tenantId", "actorId", "roles", "purpose"], "IdP session");
    return validateSession(session as unknown as SessionProjection);
  }

  #request(path: string, body: object, key: string, requestId: string, subjectToken?: string): Promise<Response> {
    const serialized = JSON.stringify(body);
    if (Buffer.byteLength(serialized) > 32 * 1024) throw validation("IdP request is too large");
    return this.fetchTransport(`${this.#origin}${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${this.credential.read()}`,
        "idempotency-key": bounded(key, "idempotency key", 200),
        "x-request-id": identifier(requestId, "requestId"),
        ...(subjectToken === undefined ? {} : { "x-ltm-subject-token": bounded(subjectToken, "subject token", 8_192, 20) }),
      },
      body: serialized,
    }).catch(() => { throw dependency("enterprise IdP is unreachable"); });
  }
}

export class AwsS3MultipartObjectStore implements MultipartObjectStore {
  readonly #client: S3Client;
  readonly #timeoutMs: number;

  constructor(
    readonly bucket: string,
    readonly kmsKeyId: string,
    region: string,
    client?: S3Client,
    timeoutMs = 8_000,
  ) {
    if (!/^(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) || bucket.includes("..")) throw configuration("S3 bucket is invalid");
    if (kmsKeyId.trim() === "" || kmsKeyId.length > 2_048) throw configuration("S3 KMS key ID is invalid");
    if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) throw configuration("AWS region is invalid");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000) throw configuration("S3 timeout is invalid");
    this.#timeoutMs = timeoutMs;
    this.#client = client ?? new S3Client({
      region,
      maxAttempts: 2,
      requestHandler: new NodeHttpHandler({ connectionTimeout: timeoutMs, requestTimeout: timeoutMs }),
    });
  }

  async create(input: { readonly objectKey: string; readonly contentType: "image/jpeg" }): Promise<string> {
    let output;
    try {
      output = await this.#client.send(new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: objectKey(input.objectKey),
        ContentType: input.contentType,
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: this.kmsKeyId,
        ChecksumAlgorithm: "SHA256",
      }), this.#requestOptions());
    } catch { throw dependency("S3 multipart creation failed"); }
    return identifier(output.UploadId, "S3 multipart upload ID");
  }

  async putPart(input: Parameters<MultipartObjectStore["putPart"]>[0]): Promise<{ etag: string; sha256Base64?: string }> {
    let output;
    try {
      output = await this.#client.send(new UploadPartCommand({
        Bucket: this.bucket,
        Key: objectKey(input.objectKey),
        UploadId: bounded(input.providerUploadId, "S3 multipart upload ID", 1_024),
        PartNumber: input.partNumber,
        Body: input.bytes,
        ContentLength: input.bytes.byteLength,
        ChecksumSHA256: bounded(input.sha256Base64, "part checksum", 128),
      }), this.#requestOptions());
    } catch { throw dependency("S3 multipart part upload failed"); }
    const etag = bounded(output.ETag, "S3 part ETag", 256);
    return { etag, ...(output.ChecksumSHA256 === undefined ? {} : { sha256Base64: output.ChecksumSHA256 }) };
  }

  async complete(input: Parameters<MultipartObjectStore["complete"]>[0]): Promise<void> {
    try {
      await this.#client.send(new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: objectKey(input.objectKey),
        UploadId: bounded(input.providerUploadId, "S3 multipart upload ID", 1_024),
        MultipartUpload: {
          Parts: input.parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
            ChecksumSHA256: Buffer.from(part.sha256, "hex").toString("base64"),
          })),
        },
      }), this.#requestOptions());
    } catch (error) {
      if (!awsErrorNamed(error, "NoSuchUpload")) throw dependency("S3 multipart completion failed");
      try {
        const head = await this.#client.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey(input.objectKey) }),
          this.#requestOptions(),
        );
        if (head.ServerSideEncryption !== "aws:kms") throw new Error("unexpected encryption");
      }
      catch { throw dependency("S3 multipart completion state is uncertain"); }
    }
  }

  async read(input: { readonly objectKey: string; readonly maximumBytes: number }): Promise<AsyncIterable<Uint8Array>> {
    let output;
    try {
      output = await this.#client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: objectKey(input.objectKey) }),
        this.#requestOptions(),
      );
    }
    catch { throw dependency("S3 media read failed"); }
    if (output.ContentLength !== undefined && output.ContentLength > input.maximumBytes) throw dependency("S3 object exceeds declared size", false);
    const body = output.Body;
    if (body === undefined || !(Symbol.asyncIterator in body)) throw dependency("S3 object body is unavailable");
    return body as AsyncIterable<Uint8Array>;
  }

  async replace(input: Parameters<MultipartObjectStore["replace"]>[0]): Promise<void> {
    const expectedChecksum = bounded(input.sha256Base64, "canonical object checksum", 128);
    try {
      const output = await this.#client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey(input.objectKey),
        Body: input.bytes,
        ContentLength: input.bytes.byteLength,
        ContentType: "image/jpeg",
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: this.kmsKeyId,
        ChecksumSHA256: expectedChecksum,
      }), this.#requestOptions());
      if (output.ChecksumSHA256 !== undefined && output.ChecksumSHA256 !== expectedChecksum) {
        throw new Error("checksum mismatch");
      }
    } catch (error) {
      try {
        const head = await this.#client.send(new HeadObjectCommand({
          Bucket: this.bucket,
          Key: objectKey(input.objectKey),
          ChecksumMode: "ENABLED",
        }), this.#requestOptions());
        if (head.ServerSideEncryption !== "aws:kms" || head.ContentLength !== input.bytes.byteLength ||
            head.ChecksumSHA256 !== expectedChecksum) throw new Error("canonical replacement is uncertain");
        return;
      } catch {
        if (error instanceof BrokerError) throw error;
        throw dependency("S3 canonical media replacement failed");
      }
    }
  }

  async abort(input: Parameters<MultipartObjectStore["abort"]>[0]): Promise<void> {
    try {
      await this.#client.send(new AbortMultipartUploadCommand({
        Bucket: this.bucket, Key: objectKey(input.objectKey), UploadId: bounded(input.providerUploadId, "S3 multipart upload ID", 1_024),
      }), this.#requestOptions());
    } catch (error) {
      if (!awsErrorNamed(error, "NoSuchUpload")) throw dependency("S3 multipart abort failed");
    }
  }

  async delete(input: { readonly objectKey: string }): Promise<void> {
    try {
      await this.#client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey(input.objectKey) }),
        this.#requestOptions(),
      );
    }
    catch { throw dependency("S3 media deletion failed"); }
  }

  async deleteVerified(input: Parameters<MultipartObjectStore["deleteVerified"]>[0]): Promise<{
    state: "deleted" | "held";
    deletedVersions: number;
    deletedMarkers: number;
    verifiedAbsent: boolean;
    evidenceSha256: string;
    hold?: { readonly reason: "legal-hold" | "retention"; readonly expiresAt?: string };
  }> {
    const locator = deletionLocator(input);
    const inventory = await this.#versionInventory(locator, input.maximumObjects);
    for (const version of inventory.versions) {
      const hold = await this.#objectLock(locator, version.key, version.versionId);
      if (hold !== undefined) {
        return {
          state: "held",
          deletedVersions: 0,
          deletedMarkers: 0,
          verifiedAbsent: false,
          evidenceSha256: sha256(JSON.stringify({ locator, version, hold })),
          hold,
        };
      }
    }
    let deletedVersions = 0;
    let deletedMarkers = 0;
    for (const version of inventory.versions) {
      await this.#deleteVersion(version.key, version.versionId);
      deletedVersions += 1;
    }
    for (const marker of inventory.markers) {
      await this.#deleteVersion(marker.key, marker.versionId);
      deletedMarkers += 1;
    }
    // An unversioned current object may not appear in ListObjectVersions.
    for (const key of inventory.currentKeys) {
      if (!inventory.versions.some((entry) => entry.key === key)) {
        const hold = await this.#objectLock(locator, key, undefined);
        if (hold !== undefined) {
          return {
            state: "held",
            deletedVersions,
            deletedMarkers,
            verifiedAbsent: false,
            evidenceSha256: sha256(JSON.stringify({ locator, key, hold, deletedVersions, deletedMarkers })),
            hold,
          };
        }
        await this.#deleteVersion(key, undefined);
        deletedVersions += 1;
      }
    }
    const verification = await this.verifyAbsent(input);
    if (!verification.absent) throw dependency("S3 deletion verification found a surviving version or delete marker");
    return {
      state: "deleted",
      deletedVersions,
      deletedMarkers,
      verifiedAbsent: true,
      evidenceSha256: sha256(JSON.stringify({
        locator,
        deletedVersions,
        deletedMarkers,
        verification: verification.evidenceSha256,
      })),
    };
  }

  async verifyAbsent(input: Parameters<MultipartObjectStore["verifyAbsent"]>[0]): Promise<{
    absent: boolean;
    objectCount: number;
    evidenceSha256: string;
  }> {
    const locator = deletionLocator(input);
    const inventory = await this.#versionInventory(locator, input.maximumObjects);
    const objectCount = inventory.versions.length + inventory.markers.length + inventory.currentKeys.length;
    const absent = objectCount === 0;
    return {
      absent,
      objectCount,
      evidenceSha256: sha256(JSON.stringify({ locator, absent, objectCount, inventory })),
    };
  }

  async listObjectKeys(input: Parameters<MultipartObjectStore["listObjectKeys"]>[0]): Promise<readonly string[]> {
    const prefix = objectPrefix(input.prefix);
    const maximum = safeInteger(input.maximumObjects, "maximumObjects", 1, 10_000);
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      let output;
      try {
        output = await this.#client.send(new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: Math.min(1_000, maximum - keys.length + 1),
          ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
        }), this.#requestOptions());
      } catch { throw dependency("S3 object inventory failed"); }
      for (const item of output.Contents ?? []) {
        if (item.Key !== undefined) keys.push(objectKey(item.Key));
        if (keys.length > maximum) throw dependency("S3 object inventory exceeded its fail-closed bound", false);
      }
      continuationToken = output.IsTruncated === true ? output.NextContinuationToken : undefined;
      if (output.IsTruncated === true && continuationToken === undefined) throw dependency("S3 object inventory pagination is invalid", false);
    } while (continuationToken !== undefined);
    return keys;
  }

  async readiness(): Promise<boolean> {
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.bucket }), this.#requestOptions());
      return true;
    } catch { return false; }
  }

  #requestOptions(): { readonly abortSignal: AbortSignal } {
    return { abortSignal: AbortSignal.timeout(this.#timeoutMs) };
  }

  async #versionInventory(
    locator: { readonly objectKey?: string; readonly prefix?: string },
    maximum: number,
  ): Promise<{
    readonly versions: readonly { readonly key: string; readonly versionId?: string }[];
    readonly markers: readonly { readonly key: string; readonly versionId?: string }[];
    readonly currentKeys: readonly string[];
  }> {
    const prefix = locator.objectKey ?? locator.prefix ?? "";
    const versions: Array<{ key: string; versionId?: string }> = [];
    const markers: Array<{ key: string; versionId?: string }> = [];
    let observedEntries = 0;
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    const paginationStates = new Set<string>();
    do {
      let output;
      try {
        output = await this.#client.send(new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: Math.min(1_000, maximum - observedEntries + 1),
          ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
          ...(versionIdMarker === undefined ? {} : { VersionIdMarker: versionIdMarker }),
        }), this.#requestOptions());
      } catch { throw dependency("S3 version inventory failed"); }
      observedEntries += (output.Versions?.length ?? 0) + (output.DeleteMarkers?.length ?? 0);
      if (observedEntries > maximum) throw dependency("S3 version inventory exceeded its fail-closed bound", false);
      for (const item of output.Versions ?? []) {
        if (item.Key === undefined || (locator.objectKey !== undefined && item.Key !== locator.objectKey)) continue;
        versions.push({ key: objectKey(item.Key), ...(item.VersionId === undefined ? {} : { versionId: bounded(item.VersionId, "S3 version ID", 1_024) }) });
      }
      for (const item of output.DeleteMarkers ?? []) {
        if (item.Key === undefined || (locator.objectKey !== undefined && item.Key !== locator.objectKey)) continue;
        markers.push({ key: objectKey(item.Key), ...(item.VersionId === undefined ? {} : { versionId: bounded(item.VersionId, "S3 version ID", 1_024) }) });
      }
      keyMarker = output.IsTruncated === true ? output.NextKeyMarker : undefined;
      versionIdMarker = output.IsTruncated === true ? output.NextVersionIdMarker : undefined;
      if (output.IsTruncated === true && keyMarker === undefined) throw dependency("S3 version inventory pagination is invalid", false);
      if (keyMarker !== undefined) {
        const paginationState = `${keyMarker}\n${versionIdMarker ?? ""}`;
        if (paginationStates.has(paginationState)) throw dependency("S3 version inventory pagination did not advance", false);
        paginationStates.add(paginationState);
      }
    } while (keyMarker !== undefined);
    const currentKeys = await this.listObjectKeys({ prefix, maximumObjects: maximum });
    const filteredCurrentKeys = locator.objectKey === undefined
      ? currentKeys
      : currentKeys.filter((key) => key === locator.objectKey);
    if (versions.length + markers.length + filteredCurrentKeys.length > maximum * 3) {
      throw dependency("S3 deletion inventory exceeded its fail-closed bound", false);
    }
    return { versions, markers, currentKeys: filteredCurrentKeys };
  }

  async #objectLock(
    locator: { readonly objectKey?: string; readonly prefix?: string },
    key: string,
    versionId: string | undefined,
  ): Promise<{ readonly reason: "legal-hold" | "retention"; readonly expiresAt?: string } | undefined> {
    let legalHold;
    try {
      legalHold = await this.#client.send(new GetObjectLegalHoldCommand({
        Bucket: this.bucket, Key: key, ...(versionId === undefined ? {} : { VersionId: versionId }),
      }), this.#requestOptions());
    } catch (error) {
      if (!awsObjectLockNotConfigured(error)) throw dependency("S3 Object Lock verification failed");
    }
    if (legalHold?.LegalHold?.Status === "ON") return { reason: "legal-hold" };
    let retention;
    try {
      retention = await this.#client.send(new GetObjectRetentionCommand({
        Bucket: this.bucket, Key: key, ...(versionId === undefined ? {} : { VersionId: versionId }),
      }), this.#requestOptions());
    } catch (error) {
      if (!awsObjectLockNotConfigured(error)) throw dependency("S3 Object Lock verification failed");
    }
    const retainUntil = retention?.Retention?.RetainUntilDate;
    if (retainUntil !== undefined && retainUntil.getTime() > Date.now()) {
      return { reason: "retention", expiresAt: retainUntil.toISOString() };
    }
    if (locator.objectKey === undefined && !key.startsWith(locator.prefix ?? "")) throw dependency("S3 Object Lock result escaped its prefix", false);
    return undefined;
  }

  async #deleteVersion(key: string, versionId: string | undefined): Promise<void> {
    try {
      await this.#client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: objectKey(key),
        ...(versionId === undefined ? {} : { VersionId: versionId }),
      }), this.#requestOptions());
    } catch { throw dependency("S3 version deletion failed"); }
  }
}

function validateStoredUpload(state: UploadState): void {
  const partsValid = Array.isArray(state.parts) && state.parts.length <= 10_000 && state.parts.every((part, index) => {
    const previousEnd = index === 0 ? -1 : state.parts[index - 1]?.end ?? -1;
    const size = part.end - part.start + 1;
    return part.partNumber === index + 1 && part.start === previousEnd + 1 && Number.isSafeInteger(part.start) &&
      Number.isSafeInteger(part.end) && part.end >= part.start && part.end < state.fileSize && size <= 5 * 1024 * 1024 &&
      (part.end + 1 === state.fileSize || size === 5 * 1024 * 1024) && /^[a-f0-9]{64}$/.test(part.sha256) &&
      typeof part.etag === "string" && part.etag.length >= 1 && part.etag.length <= 256 && !/[\u0000-\u001f\u007f]/.test(part.etag);
  });
  const projectedOffset = state.parts.length === 0 ? 0 : (state.parts[state.parts.length - 1]?.end ?? -1) + 1;
  const completed = ["completing", "verifying", "normalizing", "available"].includes(state.state);
  const canonical = state.state === "normalizing" || state.state === "available";
  const canonicalValid = canonical
    ? /^[a-f0-9]{64}$/.test(state.sourceSha256 ?? "") && /^[a-f0-9]{64}$/.test(state.canonicalSha256 ?? "") &&
      /^[a-f0-9]{64}$/.test(state.lineageSha256 ?? "") &&
      state.lineageSha256 === sha256(`ltm-media-lineage-v1\n${state.sourceSha256 ?? ""}\n${state.canonicalSha256 ?? ""}\n`) &&
      Number.isSafeInteger(state.canonicalByteLength) &&
      (state.canonicalByteLength ?? 0) > 0 && (state.canonicalByteLength ?? 0) <= 25 * 1024 * 1024 &&
      Number.isSafeInteger(state.width) && (state.width ?? 0) > 0 && (state.width ?? 0) <= 8_192 &&
      Number.isSafeInteger(state.height) && (state.height ?? 0) > 0 && (state.height ?? 0) <= 8_192 &&
      state.metadataStripped === true && validSafetyEvidence(
        state.safetyEvidence,
        state.canonicalSha256 ?? "",
        state.tenantId,
        state.actorId,
        state.mediaReference,
      )
    : state.sourceSha256 === undefined && state.canonicalSha256 === undefined && state.lineageSha256 === undefined &&
      state.canonicalByteLength === undefined && state.width === undefined &&
      state.height === undefined && state.metadataStripped === undefined && state.safetyEvidence === undefined;
  if (state.schemaVersion !== "ltm.resumable-upload.v4" || !Number.isSafeInteger(state.version) || state.version < 1 ||
      !Number.isSafeInteger(state.fileSize) || state.fileSize < 1 || state.fileSize > 25 * 1024 * 1024 ||
      !Number.isSafeInteger(state.nextOffset) || state.nextOffset !== projectedOffset || state.nextOffset > state.fileSize ||
      !["uploading", "completing", "verifying", "normalizing", "available", "cancelled", "failed"].includes(state.state) ||
      completed && state.nextOffset !== state.fileSize || !partsValid || state.contentType !== "image/jpeg" ||
      !canonicalValid ||
      !/^[a-f0-9]{64}$/.test(state.expectedSha256) || !/^[a-f0-9]{64}$/.test(state.principalSha256) ||
      !/^[a-z0-9][A-Za-z0-9/_.-]{0,1023}$/.test(state.objectKey) || state.objectKey.includes("..") ||
      typeof state.providerUploadId !== "string" || state.providerUploadId.length < 1 || state.providerUploadId.length > 1_024 ||
      (state.state === "failed"
        ? !["DIGEST_MISMATCH", "INVALID_MEDIA", "SAFETY_REJECTED", "CANONICAL_MISMATCH"].includes(state.failureCode ?? "")
        : state.failureCode !== undefined)) {
    throw dependency("stored upload state is invalid", false);
  }
  identifier(state.uploadId, "stored uploadId");
  identifier(state.mediaReference, "stored mediaReference");
  identifier(state.tenantId, "stored tenantId");
  identifier(state.actorId, "stored actorId");
  identifier(state.clientRequestId, "stored clientRequestId");
  timestamp(state.createdAt, "stored createdAt");
  timestamp(state.expiresAt, "stored expiresAt");
}

function validSafetyEvidence(
  value: UploadState["safetyEvidence"],
  canonicalSha256: string,
  tenantId: string,
  actorId: string,
  mediaReference: string,
): boolean {
  if (value === undefined) return false;
  return ["ltm.media-safety-evidence.v2", "ltm.media-safety-evidence.v3"].includes(value.version) &&
    validMediaSafetyAuthority(value) && value.canonicalSha256 === canonicalSha256 &&
    value.tenantId === tenantId && value.actorId === actorId && value.mediaReference === mediaReference &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.requestNonce) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.tenantId) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.actorId) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.mediaReference) &&
    value.malwareState === "clean" && value.contentPolicyState === "allowed" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.evidenceId) &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.provider) &&
    Number.isSafeInteger(value.faceCount) && value.faceCount >= 1 && value.faceCount <= 20 &&
    Array.isArray(value.faceSubjectReferences) && value.faceSubjectReferences.length === value.faceCount &&
    new Set(value.faceSubjectReferences).size === value.faceSubjectReferences.length &&
    value.faceSubjectReferences.every((reference) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(reference)) &&
    Number.isFinite(Date.parse(value.assessedAt));
}

function validMediaSafetyAuthority(value: NonNullable<UploadState["safetyEvidence"]>): boolean {
  if (value.version === "ltm.media-safety-evidence.v2") return value.policySha256 === undefined && value.signature === undefined;
  return value.environment !== undefined && ["test", "development", "staging", "production"].includes(value.environment) &&
    typeof value.policySha256 === "string" && /^[a-f0-9]{64}$/.test(value.policySha256) &&
    typeof value.policyId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.policyId) &&
    typeof value.modelVersion === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.modelVersion) &&
    typeof value.keyId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.keyId) &&
    typeof value.signature === "string" && /^[A-Za-z0-9_-]{80,256}$/.test(value.signature);
}

function immutableAssetFingerprint(asset: MediaAssetRecord): string {
  return sha256(JSON.stringify({
    schemaVersion: asset.schemaVersion,
    mediaReference: asset.mediaReference,
    uploadId: asset.uploadId,
    tenantId: asset.tenantId,
    ownerActorId: asset.ownerActorId,
    ownerPrincipalSha256: asset.ownerPrincipalSha256,
    objectKey: asset.objectKey,
    sourceSha256: asset.sourceSha256,
    canonicalSha256: asset.canonicalSha256,
    lineageSha256: asset.lineageSha256,
    byteLength: asset.byteLength,
    width: asset.width,
    height: asset.height,
    metadataStripped: asset.metadataStripped,
    safetyEvidence: asset.safetyEvidence,
    lifecycle: asset.lifecycle,
    createdAt: asset.createdAt,
  }));
}

async function boundedFetchJson(fetchTransport: typeof fetch, url: URL, init: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetchTransport(url, init); }
  catch { throw dependency("WeChat code exchange is unreachable"); }
  if (!response.ok) throw dependency("WeChat code exchange failed", response.status >= 500);
  return boundedResponseJson(response);
}

async function boundedResponseJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_RESPONSE_BYTES)) throw dependency("dependency response is too large", false);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_JSON_RESPONSE_BYTES) throw dependency("dependency response size is invalid", false);
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown; }
  catch { throw dependency("dependency returned invalid JSON", false); }
}

function objectKey(value: string): string {
  if (!/^[a-z0-9][A-Za-z0-9/_.-]{0,1023}$/.test(value) || value.includes("..") || value.startsWith("/") || value.endsWith("/")) {
    throw validation("S3 object key is invalid");
  }
  return value;
}

function objectPrefix(value: string): string {
  if (!/^[a-z0-9][A-Za-z0-9/_.-]{0,1023}$/.test(value) || value.includes("..") || value.startsWith("/")) {
    throw validation("S3 object prefix is invalid");
  }
  return value;
}

function deletionLocator(input: {
  readonly objectKey?: string;
  readonly prefix?: string;
  readonly maximumObjects: number;
}): { readonly objectKey?: string; readonly prefix?: string } {
  safeInteger(input.maximumObjects, "maximumObjects", 1, 10_000);
  if ((input.objectKey === undefined) === (input.prefix === undefined)) throw validation("exactly one S3 deletion locator is required");
  return input.objectKey === undefined ? { prefix: objectPrefix(input.prefix ?? "") } : { objectKey: objectKey(input.objectKey) };
}

function awsErrorNamed(error: unknown, name: string): boolean {
  return error !== null && typeof error === "object" && "name" in error && (error as { readonly name?: unknown }).name === name;
}

function awsObjectLockNotConfigured(error: unknown): boolean {
  return awsErrorNamed(error, "ObjectLockConfigurationNotFoundError") ||
    awsErrorNamed(error, "NoSuchObjectLockConfiguration") ||
    (awsErrorNamed(error, "InvalidRequest") && errorMessage(error) !== undefined &&
      /(?:object lock (?:configuration|is not enabled)|bucket is missing object lock)/i.test(errorMessage(error) ?? ""));
}

function errorMessage(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("message" in error)) return undefined;
  return typeof (error as { readonly message?: unknown }).message === "string"
    ? (error as { readonly message: string }).message
    : undefined;
}

const COMPLETE_IDEMPOTENCY_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local value = cjson.decode(current)
if value.leaseId ~= ARGV[1] or value.state ~= 'running' then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

const RELEASE_IDEMPOTENCY_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local value = cjson.decode(current)
if value.leaseId ~= ARGV[1] or value.state ~= 'running' then return 0 end
return redis.call('DEL', KEYS[1])
`;

const CAS_UPLOAD_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local value = cjson.decode(current)
if tonumber(value.version) ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`;

const CAS_ASSET_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local value = cjson.decode(current)
if tonumber(value.version) ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

const RELEASE_UPLOAD_LEASE_LUA = `
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

const RENEW_UPLOAD_LEASE_LUA = `
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then return 0 end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`;
