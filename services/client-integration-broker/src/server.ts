import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  BrokerError,
  DigestBearerAuthenticator,
  bounded,
  exactKeys,
  identifier,
  normalizePrincipal,
  object,
  roles,
  safeInteger,
  sha256Digest,
  validation,
  type Principal,
} from "./contracts.js";
import { ClientIntegrationBroker } from "./broker.js";

const JSON_BODY_LIMIT = 64 * 1024;
const CHUNK_BODY_LIMIT = 5 * 1024 * 1024;
const RESPONSE_LIMIT = 512 * 1024;

export interface BrokerServerOptions {
  readonly broker: ClientIntegrationBroker;
  readonly workloadAuthenticator: DigestBearerAuthenticator;
  readonly bodyTimeoutMs?: number;
}

export function createBrokerHttpServer(options: BrokerServerOptions): Server {
  return createServer((request, response) => void handleBrokerRequest(options, request, response));
}

export async function handleBrokerRequest(
  options: BrokerServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestId = safeRequestId(request.headers["x-request-id"]) ?? `broker_${randomUUID()}`;
  response.setHeader("x-request-id", requestId);
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  try {
    const method = request.method ?? "";
    const url = new URL(request.url ?? "/", "https://broker.internal");
    if (url.search !== "") throw validation("query parameters are not supported");
    const path = url.pathname;
    if (method === "GET" && path === "/health/live") {
      sendJson(response, 200, { status: "ok", requestId });
      return;
    }
    if (method === "GET" && path === "/health/ready") {
      const readiness = await options.broker.readiness();
      sendJson(response, readiness.ready ? 200 : 503, { ...readiness, requestId });
      return;
    }
    options.workloadAuthenticator.authenticate(header(request, "authorization"));

    const mediaDownloadMatch = /^\/v1\/media\/downloads\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(path);
    if (method === "GET" && mediaDownloadMatch?.[1] !== undefined) {
      const media = await options.broker.readAuthorizedMedia(principalFromHeaders(request), mediaDownloadMatch[1]);
      response.statusCode = 200;
      response.setHeader("content-type", "image/jpeg");
      response.setHeader("content-length", String(media.bytes.byteLength));
      response.setHeader("digest", `sha-256=:${Buffer.from(media.canonicalSha256, "hex").toString("base64")}:`);
      response.setHeader("x-ltm-media-reference", media.mediaReference);
      response.setHeader("x-ltm-authorization-expires-at", media.expiresAt);
      response.end(media.bytes);
      media.bytes.fill(0);
      return;
    }
    if (method === "GET" && path === "/v1/media/lifecycle/authority") {
      sendJson(response, 200, options.broker.mediaLifecycleAuthority());
      return;
    }
    const idempotencyKey = requiredHeader(request, "idempotency-key", 200);
    const forwardedRequestId = requiredHeader(request, "x-request-id", 128);

    if (method === "POST" && path === "/v1/wechat/sessions") {
      const body = object(await readJson(request, options.bodyTimeoutMs), "request body");
      exactKeys(body, ["code", "consentVersion", "clientRequestId"], "request body");
      const result = await options.broker.createWechatSession({
        code: bounded(body.code, "code", 512),
        consentVersion: bounded(body.consentVersion, "consentVersion", 128),
        clientRequestId: identifier(body.clientRequestId, "clientRequestId"),
        idempotencyKey,
        requestId: forwardedRequestId,
      });
      sendJson(response, 200, result);
      return;
    }
    if (method === "POST" && path === "/v1/wechat/sessions/refresh") {
      assertEmpty(await readJson(request, options.bodyTimeoutMs));
      const result = await options.broker.refreshWechatSession({
        accessToken: requiredHeader(request, "x-ltm-subject-token", 8_192, 20),
        idempotencyKey,
        requestId: forwardedRequestId,
      });
      sendJson(response, 200, result);
      return;
    }
    if (method === "POST" && path === "/v1/wechat/sessions/revoke") {
      assertEmpty(await readJson(request, options.bodyTimeoutMs));
      await options.broker.revokeWechatSession({
        accessToken: requiredHeader(request, "x-ltm-subject-token", 8_192, 20),
        idempotencyKey,
        requestId: forwardedRequestId,
      });
      sendEmpty(response, 204);
      return;
    }
    if (method === "POST" && path === "/v1/media/uploads") {
      const body = object(await readJson(request, options.bodyTimeoutMs), "request body");
      exactKeys(body, ["principal", "fileSize", "fileDigest", "digestAlgorithm", "contentType", "clientRequestId"], "request body");
      const result = await options.broker.createUpload(normalizePrincipal(body.principal), {
        fileSize: safeInteger(body.fileSize, "fileSize", 1, 25 * 1024 * 1024),
        fileDigest: sha256Digest(body.fileDigest, "fileDigest"),
        digestAlgorithm: exact(body.digestAlgorithm, "sha256", "digestAlgorithm"),
        contentType: exact(body.contentType, "image/jpeg", "contentType"),
        clientRequestId: identifier(body.clientRequestId, "clientRequestId"),
        idempotencyKey,
      });
      sendJson(response, 201, result);
      return;
    }
    if (method === "POST" && path === "/v1/media/intakes/resolve") {
      const body = object(await readJson(request, options.bodyTimeoutMs), "request body");
      exactKeys(body, ["principal", "mediaReference", "participantIds"], "request body");
      if (!Array.isArray(body.participantIds) || body.participantIds.length < 1 || body.participantIds.length > 20 ||
          body.participantIds.some((value) => typeof value !== "string") || new Set(body.participantIds).size !== body.participantIds.length) {
        throw validation("participantIds must be a bounded unique identifier list");
      }
      const result = await options.broker.resolveMediaIntake(
        normalizePrincipal(body.principal),
        identifier(body.mediaReference, "mediaReference"),
        body.participantIds.map((value) => identifier(value, "participantId")),
        idempotencyKey,
      );
      sendJson(response, 200, result);
      return;
    }

    const assetDeleteMatch = /^\/v1\/media\/assets\/([A-Za-z0-9][A-Za-z0-9._:-]{0,255})\/delete$/.exec(path);
    if (method === "POST" && assetDeleteMatch?.[1] !== undefined) {
      const body = object(await readJson(request, options.bodyTimeoutMs), "request body");
      exactKeys(body, ["principal", "reason"], "request body");
      const result = await options.broker.deleteMediaAsset(
        normalizePrincipal(body.principal),
        identifier(assetDeleteMatch[1], "mediaReference"),
        bounded(body.reason, "deletion reason", 500),
        idempotencyKey,
      );
      sendJson(response, 200, result);
      return;
    }

    const legalHoldMatch = /^\/v1\/media\/assets\/([A-Za-z0-9][A-Za-z0-9._:-]{0,255})\/legal-holds$/.exec(path);
    if (method === "POST" && legalHoldMatch?.[1] !== undefined) {
      const body = object(await readJson(request, options.bodyTimeoutMs), "request body");
      const allowed = body.expiresAt === undefined ? ["principal", "reason", "authority"] : ["principal", "reason", "authority", "expiresAt"];
      exactKeys(body, allowed, "request body");
      const legalHold = await options.broker.placeMediaLegalHold(
        normalizePrincipal(body.principal),
        identifier(legalHoldMatch[1], "mediaReference"),
        {
          reason: bounded(body.reason, "legal hold reason", 500),
          authority: bounded(body.authority, "legal hold authority", 500),
          ...(body.expiresAt === undefined ? {} : { expiresAt: bounded(body.expiresAt, "legal hold expiresAt", 64) }),
          idempotencyKey,
        },
      );
      sendJson(response, 201, { legalHold });
      return;
    }

    const legalHoldReleaseMatch = /^\/v1\/media\/assets\/([A-Za-z0-9][A-Za-z0-9._:-]{0,255})\/legal-holds\/([A-Za-z0-9][A-Za-z0-9._:-]{0,255})\/release$/.exec(path);
    if (method === "POST" && legalHoldReleaseMatch?.[1] !== undefined && legalHoldReleaseMatch[2] !== undefined) {
      const body = object(await readJson(request, options.bodyTimeoutMs), "request body");
      exactKeys(body, ["principal", "reason", "authority"], "request body");
      const legalHold = await options.broker.releaseMediaLegalHold(
        normalizePrincipal(body.principal),
        identifier(legalHoldReleaseMatch[1], "mediaReference"),
        identifier(legalHoldReleaseMatch[2], "holdId"),
        {
          reason: bounded(body.reason, "legal hold release reason", 500),
          authority: bounded(body.authority, "legal hold release authority", 500),
          idempotencyKey,
        },
      );
      sendJson(response, 200, { legalHold });
      return;
    }

    const downloadAuthorizationMatch = /^\/v1\/media\/assets\/([A-Za-z0-9][A-Za-z0-9._:-]{0,255})\/download-authorizations$/.exec(path);
    if (method === "POST" && downloadAuthorizationMatch?.[1] !== undefined) {
      const body = object(await readJson(request, options.bodyTimeoutMs), "request body");
      exactKeys(body, ["principal", "audience", "purpose", "ttlSeconds"], "request body");
      const result = await options.broker.issueMediaDownloadAuthorization(
        normalizePrincipal(body.principal),
        identifier(downloadAuthorizationMatch[1], "mediaReference"),
        {
          audience: identifier(body.audience, "download audience"),
          purpose: bounded(body.purpose, "download purpose", 120),
          ttlSeconds: safeInteger(body.ttlSeconds, "download ttlSeconds", 1, 900),
        },
      );
      sendJson(response, 201, result);
      return;
    }

    if (method === "POST" && path === "/v1/media/download-authorizations/verify") {
      const body = object(await readJson(request, options.bodyTimeoutMs), "request body");
      exactKeys(body, ["principal", "token"], "request body");
      const result = await options.broker.verifyMediaDownloadAuthorization(
        normalizePrincipal(body.principal),
        bounded(body.token, "media download token", 8_192, 64),
      );
      sendJson(response, 200, result);
      return;
    }

    if (method === "POST" && path === "/v1/media/lifecycle/maintenance") {
      const body = object(await readJson(request, options.bodyTimeoutMs), "request body");
      const allowed = body.cursor === undefined ? ["principal", "limit"] : ["principal", "limit", "cursor"];
      exactKeys(body, allowed, "request body");
      const result = await options.broker.runMediaLifecycleMaintenance(normalizePrincipal(body.principal), {
        limit: safeInteger(body.limit, "maintenance limit", 1, 1_000),
        ...(body.cursor === undefined ? {} : { cursor: bounded(body.cursor, "maintenance cursor", 32) }),
      });
      sendJson(response, 200, result);
      return;
    }

    if (method === "POST" && path === "/v1/media/lifecycle/orphan-scan") {
      const body = object(await readJson(request, options.bodyTimeoutMs), "request body");
      exactKeys(body, ["principal", "maximumObjects"], "request body");
      const result = await options.broker.scanMediaOrphans(
        normalizePrincipal(body.principal),
        safeInteger(body.maximumObjects, "orphan scan maximumObjects", 1, 10_000),
      );
      sendJson(response, 200, result);
      return;
    }

    const match = /^\/v1\/media\/uploads\/([A-Za-z0-9][A-Za-z0-9._:-]{0,255})\/(chunks|complete|cancel)$/.exec(path);
    if (method === "PUT" && match?.[2] === "chunks") {
      requireContentType(request, "application/octet-stream");
      const range = contentRange(request);
      const bytes = await readBody(request, CHUNK_BODY_LIMIT, options.bodyTimeoutMs);
      if (bytes.byteLength !== range.end - range.start + 1) throw validation("chunk bytes do not match Content-Range");
      const result = await options.broker.appendUpload(principalFromHeaders(request), {
        uploadId: match[1] ?? "",
        bytes,
        ...range,
        idempotencyKey,
      });
      sendJson(response, 200, result);
      return;
    }
    if (method === "POST" && match?.[2] === "complete") {
      const body = object(await readJson(request, options.bodyTimeoutMs), "request body");
      exactKeys(body, ["principal", "fileDigest", "digestAlgorithm"], "request body");
      const result = await options.broker.completeUpload(normalizePrincipal(body.principal), {
        uploadId: match[1] ?? "",
        fileDigest: sha256Digest(body.fileDigest, "fileDigest"),
        digestAlgorithm: exact(body.digestAlgorithm, "sha256", "digestAlgorithm"),
        idempotencyKey,
      });
      sendJson(response, 200, result);
      return;
    }
    if (method === "POST" && match?.[2] === "cancel") {
      const body = object(await readJson(request, options.bodyTimeoutMs), "request body");
      exactKeys(body, ["principal"], "request body");
      await options.broker.cancelUpload(normalizePrincipal(body.principal), {
        uploadId: match[1] ?? "",
        idempotencyKey,
      });
      sendEmpty(response, 204);
      return;
    }
    sendJson(response, 404, { error: { code: "RESOURCE_NOT_FOUND", message: "route was not found" }, requestId });
  } catch (error) {
    const safe = error instanceof BrokerError
      ? error
      : new BrokerError("DEPENDENCY_UNAVAILABLE", "broker operation failed", 503, true);
    if (!response.headersSent) {
      sendJson(response, safe.status, {
        error: { code: safe.code, message: safe.message, retryable: safe.retryable },
        requestId,
      });
    } else response.destroy();
  }
}

function principalFromHeaders(request: IncomingMessage): Principal {
  const rawRoles = requiredHeader(request, "x-ltm-roles", 1_024).split(",");
  return {
    actorId: identifier(requiredHeader(request, "x-ltm-actor-id", 128), "actorId"),
    tenantId: identifier(requiredHeader(request, "x-ltm-tenant-id", 128), "tenantId"),
    roles: roles(rawRoles),
    purpose: bounded(requiredHeader(request, "x-ltm-purpose", 120), "purpose", 120),
  };
}

function contentRange(request: IncomingMessage): { readonly start: number; readonly end: number; readonly total: number } {
  const value = header(request, "content-range") ?? "";
  const match = /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) throw validation("Content-Range is invalid");
  const start = safeInteger(Number(match[1]), "range start", 0, 25 * 1024 * 1024 - 1);
  const end = safeInteger(Number(match[2]), "range end", start, 25 * 1024 * 1024 - 1);
  const total = safeInteger(Number(match[3]), "range total", 1, 25 * 1024 * 1024);
  if (end >= total) throw validation("Content-Range is outside upload bounds");
  return { start, end, total };
}

async function readJson(request: IncomingMessage, timeoutMs = 10_000): Promise<unknown> {
  requireContentType(request, "application/json");
  const raw = await readBody(request, JSON_BODY_LIMIT, timeoutMs);
  try { return JSON.parse(raw.toString("utf8")) as unknown; }
  catch { throw validation("request body must be valid JSON"); }
}

async function readBody(request: IncomingMessage, maximum: number, timeoutMs = 10_000): Promise<Buffer> {
  const lengthValue = header(request, "content-length");
  if (lengthValue !== undefined && (!/^\d+$/.test(lengthValue) || Number(lengthValue) > maximum)) throw validation("request body is too large");
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => request.destroy(new Error("body timeout")), timeoutMs);
  try {
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += bytes.byteLength;
      if (size > maximum) throw validation("request body is too large");
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof BrokerError) throw error;
    throw validation("request body could not be read");
  } finally { clearTimeout(timer); }
  return Buffer.concat(chunks, size);
}

function requireContentType(request: IncomingMessage, expected: string): void {
  const value = (header(request, "content-type") ?? "").toLowerCase();
  if (value !== expected && !value.startsWith(`${expected};`)) throw validation(`content-type must be ${expected}`);
}

function requiredHeader(request: IncomingMessage, name: string, maximum: number, minimum = 1): string {
  return bounded(header(request, name), name, maximum, minimum);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) throw validation(`${name} must be supplied once`);
  return value;
}

function safeRequestId(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  try { return identifier(value, "requestId"); } catch { return undefined; }
}

function exact<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw validation(`${label} must be ${expected}`);
  return expected;
}

function assertEmpty(value: unknown): void {
  const body = object(value, "request body");
  if (Object.keys(body).length !== 0) throw validation("request body must be empty");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > RESPONSE_LIMIT) throw new BrokerError("DEPENDENCY_UNAVAILABLE", "broker response is too large", 503, false);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", String(body.byteLength));
  response.end(body);
}

function sendEmpty(response: ServerResponse, status: number): void {
  response.statusCode = status;
  response.setHeader("content-length", "0");
  response.end();
}
