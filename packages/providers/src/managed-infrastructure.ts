import { createHash, randomUUID } from "node:crypto";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";
import {
  PutObjectCommand,
  S3Client,
  type PutObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { createClient } from "redis";
import type { SecretReference } from "./external-evidence-adapters.js";
import {
  ProductionIntegrationError,
  sha256,
  type EvidenceArtifactStore,
  type EvidenceEnvelopeStore,
  type ReplayStore,
  type SecretResolver,
} from "./production-common.js";

interface SecretsManagerCommandClient {
  send(command: GetSecretValueCommand): Promise<GetSecretValueCommandOutput>;
}

interface S3CommandClient {
  send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
}

export interface RedisSetClient {
  readonly isReady: boolean;
  set(
    key: string,
    value: string,
    options: { readonly expiration: { readonly type: "PX"; readonly value: number }; readonly condition: "NX" },
  ): Promise<string | null>;
  close(): Promise<void>;
}

interface RedisCallbackStateClient {
  readonly isReady: boolean;
  eval(script: string, options: { readonly keys: readonly string[]; readonly arguments: readonly string[] }): Promise<unknown>;
  close(): Promise<void>;
}

interface RedisEnvelopeClient {
  readonly isReady: boolean;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options: { readonly expiration: { readonly type: "PX"; readonly value: number }; readonly condition: "NX" },
  ): Promise<string | null>;
  close(): Promise<void>;
}

export interface RedisEvidenceEnvelopeStoreOptions {
  readonly keyPrefix?: string;
  readonly clock?: () => Date;
}

/** Stores the first signed envelope for a scope before it can escape the attestor. */
export class RedisEvidenceEnvelopeStore implements EvidenceEnvelopeStore {
  readonly #prefix: string;
  readonly #clock: () => Date;

  constructor(
    private readonly client: RedisEnvelopeClient,
    options: RedisEvidenceEnvelopeStoreOptions = {},
  ) {
    this.#prefix = options.keyPrefix ?? "ltm:evidence-envelope:v1";
    this.#clock = options.clock ?? (() => new Date());
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(this.#prefix)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "evidence envelope Redis key prefix is invalid");
    }
  }

  static async connect(
    urlValue: string,
    options: RedisEvidenceEnvelopeStoreOptions & { readonly allowInsecureLocalhost?: boolean } = {},
  ): Promise<RedisEvidenceEnvelopeStore> {
    const client = await connectRedis(urlValue, options.allowInsecureLocalhost === true);
    return new RedisEvidenceEnvelopeStore(client as unknown as RedisEnvelopeClient, options);
  }

  async getOrStore(scope: string, candidate: Uint8Array, expiresAt: Date): Promise<Uint8Array> {
    if (!this.client.isReady) throw unavailableCallbackState();
    if (scope.length === 0 || scope.length > 512 || candidate.byteLength === 0 || candidate.byteLength > 1_048_576) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "durable evidence scope or envelope size is invalid");
    }
    const ttl = Math.ceil(expiresAt.getTime() - this.#clock().getTime());
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 24 * 60 * 60_000) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "durable evidence envelope TTL is invalid");
    }
    const key = `${this.#prefix}:${createHash("sha256").update(scope, "utf8").digest("hex")}`;
    const encoded = Buffer.from(candidate).toString("base64url");
    let value: string | null;
    try {
      const stored = await this.client.set(key, encoded, {
        expiration: { type: "PX", value: ttl },
        condition: "NX",
      });
      value = stored === "OK" ? encoded : await this.client.get(key);
    } catch {
      throw unavailableCallbackState();
    }
    if (value === null) throw unavailableCallbackState();
    return decodeStatePayload(value);
  }

  isReady(): boolean {
    return this.client.isReady;
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

export interface CallbackDeliveryLease {
  readonly key: string;
  readonly leaseId: string;
}

export type CallbackDeliveryBegin =
  | { readonly state: "process"; readonly lease: CallbackDeliveryLease }
  | { readonly state: "deliver"; readonly lease: CallbackDeliveryLease; readonly payload: Uint8Array }
  | { readonly state: "busy" }
  | { readonly state: "completed" };

export interface CallbackDeliveryStateStore {
  begin(namespace: string, fingerprint: string): Promise<CallbackDeliveryBegin>;
  stageForDelivery(lease: CallbackDeliveryLease, payload: Uint8Array): Promise<void>;
  releaseForRetry(lease: CallbackDeliveryLease, payload: Uint8Array): Promise<void>;
  complete(lease: CallbackDeliveryLease): Promise<void>;
  abandon(lease: CallbackDeliveryLease): Promise<void>;
  isReady(): boolean;
  close(): Promise<void>;
}

export interface RedisCallbackDeliveryStateStoreOptions {
  readonly keyPrefix?: string;
  readonly leaseMs?: number;
  readonly retentionMs?: number;
  readonly clock?: () => Date;
}

/** Durable lease/cache state machine for retryable callback-to-evidence delivery. */
export class RedisCallbackDeliveryStateStore implements CallbackDeliveryStateStore {
  readonly #prefix: string;
  readonly #leaseMs: number;
  readonly #retentionMs: number;
  readonly #clock: () => Date;

  constructor(
    private readonly client: RedisCallbackStateClient,
    options: RedisCallbackDeliveryStateStoreOptions = {},
  ) {
    this.#prefix = options.keyPrefix ?? "ltm:callback-delivery:v1";
    this.#leaseMs = options.leaseMs ?? 60_000;
    this.#retentionMs = options.retentionMs ?? 7 * 24 * 60 * 60_000;
    this.#clock = options.clock ?? (() => new Date());
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(this.#prefix)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "callback delivery Redis key prefix is invalid");
    }
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 5_000 || this.#leaseMs > 15 * 60_000) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "callback delivery lease must be between five seconds and 15 minutes");
    }
    if (!Number.isSafeInteger(this.#retentionMs) || this.#retentionMs < 60_000 || this.#retentionMs > 7 * 24 * 60 * 60_000) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "callback delivery retention must be between one minute and seven days");
    }
  }

  static async connect(urlValue: string, options: RedisCallbackDeliveryStateStoreOptions & { readonly allowInsecureLocalhost?: boolean } = {}): Promise<RedisCallbackDeliveryStateStore> {
    const client = await connectRedis(urlValue, options.allowInsecureLocalhost === true);
    return new RedisCallbackDeliveryStateStore(client, options);
  }

  async begin(namespace: string, fingerprint: string): Promise<CallbackDeliveryBegin> {
    if (!this.client.isReady) throw unavailableCallbackState();
    if (namespace.length === 0 || namespace.length > 512 || /[\u0000-\u001f\u007f]/.test(namespace)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "callback namespace is invalid");
    }
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "callback fingerprint must be SHA-256");
    }
    const key = `${this.#prefix}:${createHash("sha256").update(`${namespace}\n${fingerprint}`).digest("hex")}`;
    const leaseId = randomUUID();
    const now = this.#clock().getTime();
    const result = await evalState(this.client, BEGIN_CALLBACK_LUA, [key], [
      leaseId,
      String(now),
      String(now + this.#leaseMs),
      String(this.#retentionMs),
    ]);
    const code = stringResult(result[0]);
    if (code === "process") return { state: "process", lease: { key, leaseId } };
    if (code === "deliver") {
      const encoded = stringResult(result[1]);
      const payload = decodeStatePayload(encoded);
      return { state: "deliver", lease: { key, leaseId }, payload };
    }
    if (code === "completed") return { state: "completed" };
    if (code === "busy") return { state: "busy" };
    throw unavailableCallbackState();
  }

  async stageForDelivery(lease: CallbackDeliveryLease, payload: Uint8Array): Promise<void> {
    await this.#transition(STAGE_CALLBACK_LUA, lease, payload);
  }

  async releaseForRetry(lease: CallbackDeliveryLease, payload: Uint8Array): Promise<void> {
    await this.#transition(RETRY_CALLBACK_LUA, lease, payload);
  }

  async complete(lease: CallbackDeliveryLease): Promise<void> {
    await this.#transition(COMPLETE_CALLBACK_LUA, lease);
  }

  async abandon(lease: CallbackDeliveryLease): Promise<void> {
    await this.#transition(ABANDON_CALLBACK_LUA, lease);
  }

  isReady(): boolean {
    return this.client.isReady;
  }

  close(): Promise<void> {
    return this.client.close();
  }

  async #transition(script: string, lease: CallbackDeliveryLease, payload?: Uint8Array): Promise<void> {
    if (!this.client.isReady) throw unavailableCallbackState();
    if (!lease.key.startsWith(`${this.#prefix}:`) || !/^[0-9a-f-]{36}$/.test(lease.leaseId)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "callback delivery lease is invalid");
    }
    const encoded = payload === undefined ? "" : encodeStatePayload(payload);
    const result = await evalState(this.client, script, [lease.key], [
      lease.leaseId,
      encoded,
      String(this.#retentionMs),
      String(this.#clock().getTime() + this.#leaseMs),
    ]);
    if (stringResult(result[0]) !== "ok") {
      throw new ProductionIntegrationError("PROVIDER_REJECTED", "callback delivery lease was lost", true);
    }
  }
}

/** Real AWS Secrets Manager resolver; only secret-manager: references are accepted. */
export class AwsSecretsManagerResolver implements SecretResolver {
  constructor(private readonly client: SecretsManagerCommandClient = new SecretsManagerClient({})) {}

  async resolve(reference: SecretReference): Promise<Uint8Array> {
    if (!reference.startsWith("secret-manager:")) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "AWS resolver accepts only secret-manager references");
    }
    const secretId = reference.slice("secret-manager:".length);
    if (secretId.length === 0 || secretId.length > 2_048 || /[\u0000-\u001f\u007f]/.test(secretId)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "AWS secret identifier is invalid");
    }
    let result: GetSecretValueCommandOutput;
    try {
      result = await this.client.send(new GetSecretValueCommand({ SecretId: secretId }));
    } catch {
      throw new ProductionIntegrationError("CREDENTIAL_UNAVAILABLE", "managed secret could not be resolved", true);
    }
    const value = result.SecretBinary === undefined
      ? result.SecretString === undefined ? undefined : Buffer.from(result.SecretString, "utf8")
      : Buffer.from(result.SecretBinary);
    if (value === undefined || value.byteLength === 0 || value.byteLength > 1_048_576) {
      throw new ProductionIntegrationError("CREDENTIAL_UNAVAILABLE", "managed secret returned an invalid value");
    }
    return value;
  }
}

export interface S3EvidenceArtifactStoreOptions {
  readonly bucket: string;
  readonly keyPrefix: string;
  readonly kmsKeyId: string;
  readonly retentionDays: Readonly<Record<"financial" | "release" | "operational", number>>;
  readonly objectLockMode?: "COMPLIANCE" | "GOVERNANCE";
  readonly clock?: () => Date;
}

/** S3 artifact retention with KMS encryption, SHA-256 checksums, and Object Lock. */
export class S3EvidenceArtifactStore implements EvidenceArtifactStore {
  readonly #clock: () => Date;

  constructor(
    private readonly options: S3EvidenceArtifactStoreOptions,
    private readonly client: S3CommandClient = new S3Client({}),
  ) {
    if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "S3 evidence bucket name is invalid");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,255}\/?$/.test(options.keyPrefix) || options.keyPrefix.includes("..")) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "S3 evidence key prefix is invalid");
    }
    if (options.kmsKeyId.trim().length < 8 || options.kmsKeyId.length > 2_048) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "S3 evidence KMS key ID is invalid");
    }
    for (const value of Object.values(options.retentionDays)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 3_650) {
        throw new ProductionIntegrationError("CONFIGURATION_INVALID", "S3 evidence retention must be between one day and ten years");
      }
    }
    this.#clock = options.clock ?? (() => new Date());
  }

  async put(input: Parameters<EvidenceArtifactStore["put"]>[0]): Promise<{ uri: string; sha256: string }> {
    const actualSha256 = sha256(input.artifact);
    if (input.sha256 !== actualSha256) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "artifact digest does not match before S3 upload");
    }
    const checksum = createHash("sha256").update(input.artifact).digest("base64");
    const key = [
      this.options.keyPrefix.replace(/\/$/, ""),
      input.retentionClass,
      opaqueSegment(input.tenantId),
      opaqueSegment(input.provider),
      opaqueSegment(input.subjectId),
      `${input.sha256}.bin`,
    ].filter(Boolean).join("/");
    const retainUntil = new Date(this.#clock().getTime() + this.options.retentionDays[input.retentionClass] * 24 * 60 * 60_000);
    let result: PutObjectCommandOutput;
    try {
      result = await this.client.send(new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: input.artifact,
        ContentLength: input.artifact.byteLength,
        ContentType: "application/octet-stream",
        ChecksumAlgorithm: "SHA256",
        ChecksumSHA256: checksum,
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: this.options.kmsKeyId,
        BucketKeyEnabled: true,
        ObjectLockMode: this.options.objectLockMode ?? "COMPLIANCE",
        ObjectLockRetainUntilDate: retainUntil,
        Metadata: {
          "ltm-sha256": input.sha256,
          "ltm-retention-class": input.retentionClass,
        },
      }));
    } catch {
      throw new ProductionIntegrationError("PROVIDER_REJECTED", "evidence artifact could not be stored", true);
    }
    if (result.ChecksumSHA256 !== checksum) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "S3 did not confirm the requested SHA-256 checksum");
    }
    return { uri: `s3://${this.options.bucket}/${key}#sha256=${input.sha256}`, sha256: input.sha256 };
  }
}

export interface RedisReplayStoreOptions {
  readonly keyPrefix?: string;
  readonly clock?: () => Date;
}

/** Distributed atomic replay protection backed by Redis SET NX PX. */
export class RedisReplayStore implements ReplayStore {
  readonly #prefix: string;
  readonly #clock: () => Date;

  constructor(
    private readonly client: RedisSetClient,
    options: RedisReplayStoreOptions = {},
  ) {
    this.#prefix = options.keyPrefix ?? "ltm:replay:v1";
    if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(this.#prefix)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Redis replay key prefix is invalid");
    }
    this.#clock = options.clock ?? (() => new Date());
  }

  static async connect(
    urlValue: string,
    options: RedisReplayStoreOptions & { readonly allowInsecureLocalhost?: boolean } = {},
  ): Promise<RedisReplayStore> {
    let url: URL;
    try {
      url = new URL(urlValue);
    } catch {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Redis URL is invalid");
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (url.protocol !== "rediss:" && !(options.allowInsecureLocalhost === true && local && url.protocol === "redis:")) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "production Redis replay storage requires TLS");
    }
    const client = createClient({
      url: url.toString(),
      socket: {
        connectTimeout: 5_000,
        reconnectStrategy: (retries) => retries > 5 ? false : Math.min(100 * 2 ** retries, 2_000),
      },
    });
    client.on("error", () => undefined);
    try {
      await client.connect();
    } catch {
      client.destroy();
      throw new ProductionIntegrationError("CREDENTIAL_UNAVAILABLE", "Redis replay store could not connect", true);
    }
    return new RedisReplayStore(client, options);
  }

  async claimOnce(namespace: string, value: string, expiresAt: Date): Promise<boolean> {
    if (!this.client.isReady) {
      throw new ProductionIntegrationError("PROVIDER_REJECTED", "Redis replay store is not ready", true);
    }
    const ttl = Math.ceil(expiresAt.getTime() - this.#clock().getTime());
    if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 7 * 24 * 60 * 60_000) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Redis replay TTL must be between one second and seven days");
    }
    const digest = createHash("sha256").update(`${namespace}\n${value}`, "utf8").digest("hex");
    let result: string | null;
    try {
      result = await this.client.set(`${this.#prefix}:${digest}`, "1", {
        expiration: { type: "PX", value: ttl },
        condition: "NX",
      });
    } catch {
      throw new ProductionIntegrationError("PROVIDER_REJECTED", "Redis replay claim failed", true);
    }
    return result === "OK";
  }

  isReady(): boolean {
    return this.client.isReady;
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

function opaqueSegment(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

async function connectRedis(urlValue: string, allowInsecureLocalhost: boolean): Promise<RedisCallbackStateClient> {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", "Redis URL is invalid");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "rediss:" && !(allowInsecureLocalhost && local && url.protocol === "redis:")) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", "production Redis callback storage requires TLS");
  }
  const client = createClient({
    url: url.toString(),
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: (retries) => retries > 5 ? false : Math.min(100 * 2 ** retries, 2_000),
    },
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
  } catch {
    client.destroy();
    throw new ProductionIntegrationError("CREDENTIAL_UNAVAILABLE", "Redis callback delivery store could not connect", true);
  }
  return client as unknown as RedisCallbackStateClient;
}

async function evalState(
  client: RedisCallbackStateClient,
  script: string,
  keys: readonly string[],
  args: readonly string[],
): Promise<readonly unknown[]> {
  let result: unknown;
  try {
    result = await client.eval(script, { keys, arguments: args });
  } catch {
    throw unavailableCallbackState();
  }
  if (!Array.isArray(result)) throw unavailableCallbackState();
  return result;
}

function unavailableCallbackState(): ProductionIntegrationError {
  return new ProductionIntegrationError("PROVIDER_REJECTED", "callback delivery state store is unavailable", true);
}

function stringResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  throw unavailableCallbackState();
}

function encodeStatePayload(payload: Uint8Array): string {
  if (payload.byteLength === 0 || payload.byteLength > 1_048_576) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "cached callback result size is invalid");
  }
  return Buffer.from(payload).toString("base64url");
}

function decodeStatePayload(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{2,1398102}$/.test(value)) throw unavailableCallbackState();
  const payload = Buffer.from(value, "base64url");
  if (payload.byteLength === 0 || payload.byteLength > 1_048_576 || payload.toString("base64url") !== value) {
    throw unavailableCallbackState();
  }
  return payload;
}

const BEGIN_CALLBACK_LUA = `
local key = KEYS[1]
local lease = ARGV[1]
local now = tonumber(ARGV[2])
local expires = ARGV[3]
local ttl = ARGV[4]
local current = redis.call('GET', key)
if not current then
  redis.call('SET', key, 'P|' .. lease .. '|' .. expires, 'PX', ttl)
  return {'process', ''}
end
if current == 'C' then return {'completed', ''} end
if string.sub(current, 1, 2) == 'R|' then
  local payload = string.sub(current, 3)
  redis.call('SET', key, 'D|' .. lease .. '|' .. expires .. '|' .. payload, 'PX', ttl)
  return {'deliver', payload}
end
local please, pexpires = string.match(current, '^P|([^|]+)|(%d+)$')
local dlease, dexpires, payload = string.match(current, '^D|([^|]+)|(%d+)|(.+)$')
if please and tonumber(pexpires) <= now then
  redis.call('SET', key, 'P|' .. lease .. '|' .. expires, 'PX', ttl)
  return {'process', ''}
end
if dlease and tonumber(dexpires) <= now then
  if payload and payload ~= '' then
    redis.call('SET', key, 'D|' .. lease .. '|' .. expires .. '|' .. payload, 'PX', ttl)
    return {'deliver', payload}
  end
end
return {'busy', ''}
`;

const STAGE_CALLBACK_LUA = `
local current = redis.call('GET', KEYS[1])
local prefix = 'P|' .. ARGV[1] .. '|'
if current and string.sub(current, 1, string.len(prefix)) == prefix then
  redis.call('SET', KEYS[1], 'D|' .. ARGV[1] .. '|' .. ARGV[4] .. '|' .. ARGV[2], 'PX', ARGV[3])
  return {'ok'}
end
return {'lost'}
`;

const RETRY_CALLBACK_LUA = `
local current = redis.call('GET', KEYS[1])
local prefix = 'D|' .. ARGV[1] .. '|'
if current and string.sub(current, 1, string.len(prefix)) == prefix then
  redis.call('SET', KEYS[1], 'R|' .. ARGV[2], 'PX', ARGV[3])
  return {'ok'}
end
return {'lost'}
`;

const COMPLETE_CALLBACK_LUA = `
local current = redis.call('GET', KEYS[1])
local p = 'P|' .. ARGV[1] .. '|'
local d = 'D|' .. ARGV[1] .. '|'
if current and (string.sub(current, 1, string.len(p)) == p or string.sub(current, 1, string.len(d)) == d) then
  redis.call('SET', KEYS[1], 'C', 'PX', ARGV[3])
  return {'ok'}
end
return {'lost'}
`;

const ABANDON_CALLBACK_LUA = `
local current = redis.call('GET', KEYS[1])
local p = 'P|' .. ARGV[1] .. '|'
local d = 'D|' .. ARGV[1] .. '|'
if current and (string.sub(current, 1, string.len(p)) == p or string.sub(current, 1, string.len(d)) == d) then
  redis.call('DEL', KEYS[1])
  return {'ok'}
end
return {'lost'}
`;
