import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { normalizeVerifiedBusinessEvent, type VerifiedBusinessEvent } from "@ltm/core";
import {
  ProductionIntegrationError,
  assertSignedCapabilityEvidence,
  type CallbackDeliveryLease,
  type CallbackDeliveryStateStore,
  type SignedCapabilityEvidence,
} from "@ltm/providers";

export interface GatewayCallbackRequest {
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly requestId: string;
}

export type GatewayCallbackResult =
  | { readonly disposition: "ignored"; readonly providerEventId: string }
  | {
      /** Signed provider evidence that is registered for a later evidence-gated capability mutation. */
      readonly disposition: "evidence";
      readonly providerEventId: string;
      readonly evidence: SignedCapabilityEvidence;
      readonly receipt: Readonly<Record<string, unknown>>;
    }
  | {
      readonly disposition: "attested";
      readonly providerEventId: string;
      readonly evidence: SignedCapabilityEvidence;
      readonly businessEvent: VerifiedBusinessEvent;
      readonly receipt: Readonly<Record<string, unknown>>;
    };

export interface GatewayCallbackHandler {
  readonly maximumBodyBytes?: number;
  process(request: GatewayCallbackRequest): Promise<GatewayCallbackResult>;
}

export interface EvidenceOutput {
  publish(input: {
    readonly requestId: string;
    readonly providerEventId: string;
    readonly evidence: SignedCapabilityEvidence;
    readonly receipt: Readonly<Record<string, unknown>>;
    readonly businessEvent?: VerifiedBusinessEvent;
  }): Promise<void>;
}

export interface ReadinessResult {
  readonly ready: boolean;
  readonly checks: Readonly<Record<string, boolean>>;
}

export interface IntegrationGatewayOptions {
  readonly tenantId: string;
  readonly routes: ReadonlyMap<string, GatewayCallbackHandler>;
  readonly evidenceOutput: EvidenceOutput;
  readonly callbackState: CallbackDeliveryStateStore;
  readonly bodyLimitBytes: number;
  readonly readiness: () => Promise<ReadinessResult>;
  readonly logger?: (entry: Readonly<Record<string, unknown>>) => void;
  readonly clock?: () => Date;
}

/** Creates a callback-only HTTP server. It never parses and reserializes a signed request body. */
export function createIntegrationGatewayServer(options: IntegrationGatewayOptions): Server {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(options.tenantId)) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", "gateway tenantId is invalid");
  }
  if (!Number.isSafeInteger(options.bodyLimitBytes) || options.bodyLimitBytes < 1_024 || options.bodyLimitBytes > 10_485_760) {
    throw new ProductionIntegrationError("CONFIGURATION_INVALID", "gateway body limit must be between one KiB and ten MiB");
  }
  for (const path of options.routes.keys()) {
    if (!/^\/v1\/callbacks\/(?:apple|google-play|wechat-pay|partners\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.test(path)) {
      throw new ProductionIntegrationError("CONFIGURATION_INVALID", "gateway callback route is invalid");
    }
  }
  return createServer((request, response) => {
    void handleRequest(options, request, response);
  });
}

async function handleRequest(
  options: IntegrationGatewayOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestId = randomUUID();
  response.setHeader("x-request-id", requestId);
  response.setHeader("cache-control", "no-store");
  response.setHeader("strict-transport-security", "max-age=63072000; includeSubDomains");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  try {
    const target = request.url === undefined ? undefined : new URL(request.url, "http://gateway.invalid");
    if (target === undefined || target.search !== "" || target.hash !== "") {
      writeJson(response, 400, { code: "INVALID_REQUEST" });
      return;
    }
    if (request.method === "GET" && target.pathname === "/health/live") {
      writeJson(response, 200, { status: "live" });
      return;
    }
    if (request.method === "GET" && target.pathname === "/health/ready") {
      const result = await options.readiness();
      writeJson(response, result.ready ? 200 : 503, { status: result.ready ? "ready" : "not_ready", checks: result.checks });
      return;
    }
    const handler = options.routes.get(target.pathname);
    if (handler === undefined) {
      writeJson(response, 404, { code: "NOT_FOUND" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      writeJson(response, 405, { code: "METHOD_NOT_ALLOWED" });
      return;
    }
    const contentType = singleHeader(request, "content-type");
    if (contentType === undefined) throw new GatewayHttpError(400, "MISSING_HEADER");
    requireJsonContentType(contentType);
    const contentEncoding = singleHeader(request, "content-encoding", true);
    if (contentEncoding !== undefined && contentEncoding.toLowerCase() !== "identity") {
      throw new GatewayHttpError(415, "UNSUPPORTED_CONTENT_ENCODING");
    }
    const rawBody = await readRawBody(request, Math.min(options.bodyLimitBytes, handler.maximumBodyBytes ?? options.bodyLimitBytes));
    const result = await processCallbackDelivery(
      options,
      target.pathname,
      handler,
      rawBody,
      normalizedHeaders(request),
      requestId,
    );
    response.statusCode = 204;
    response.end();
    options.logger?.({ level: "info", event: "callback.accepted", requestId, path: target.pathname, disposition: result.disposition });
  } catch (error) {
    const mapped = mapError(error);
    options.logger?.({
      level: mapped.status >= 500 ? "error" : "warn",
      event: "callback.rejected",
      requestId,
      status: mapped.status,
      code: mapped.code,
    });
    writeJson(response, mapped.status, { code: mapped.code });
  }
}

async function processCallbackDelivery(
  options: IntegrationGatewayOptions,
  path: string,
  handler: GatewayCallbackHandler,
  rawBody: Uint8Array,
  headers: Readonly<Record<string, string>>,
  requestId: string,
  allowExpiredReprocess = true,
): Promise<GatewayCallbackResult> {
  const fingerprint = createHash("sha256").update(rawBody).digest("hex");
  const route = path.slice("/v1/callbacks/".length).replaceAll("/", ":");
  const begin = await options.callbackState.begin(`${options.tenantId}:${route}`, fingerprint);
  if (begin.state === "completed") {
    return { disposition: "ignored", providerEventId: `completed:${fingerprint.slice(0, 24)}` };
  }
  if (begin.state === "busy") {
    throw new ProductionIntegrationError("PROVIDER_REJECTED", "callback delivery is already in progress", true);
  }
  if (begin.state === "deliver") {
    let cached: DeliverableGatewayCallbackResult;
    try {
      cached = decodeCachedResult(begin.payload, options.clock?.() ?? new Date());
    } catch (error) {
      await bestEffort(() => options.callbackState.abandon(begin.lease));
      if (error instanceof CachedEvidenceExpiredError && allowExpiredReprocess) {
        return processCallbackDelivery(options, path, handler, rawBody, headers, requestId, false);
      }
      throw error;
    }
    return deliver(options, requestId, begin.lease, begin.payload, cached);
  }
  let result: GatewayCallbackResult;
  try {
    result = await handler.process({ rawBody, headers, requestId });
  } catch (error) {
    await bestEffort(() => options.callbackState.abandon(begin.lease));
    throw error;
  }
  if (result.disposition === "ignored") {
    await options.callbackState.complete(begin.lease);
    return result;
  }
  const payload = encodeCachedResult(result);
  try {
    await options.callbackState.stageForDelivery(begin.lease, payload);
  } catch (error) {
    await bestEffort(() => options.callbackState.abandon(begin.lease));
    throw error;
  }
  return deliver(options, requestId, begin.lease, payload, result);
}

async function deliver(
  options: IntegrationGatewayOptions,
  requestId: string,
  lease: CallbackDeliveryLease,
  payload: Uint8Array,
  result: DeliverableGatewayCallbackResult,
): Promise<GatewayCallbackResult> {
  try {
    await options.evidenceOutput.publish({
      requestId,
      providerEventId: result.providerEventId,
      evidence: result.evidence,
      receipt: result.receipt,
      ...(result.disposition === "attested" ? { businessEvent: result.businessEvent } : {}),
    });
  } catch (error) {
    await bestEffort(() => options.callbackState.releaseForRetry(lease, payload));
    throw error;
  }
  await options.callbackState.complete(lease);
  return result;
}

type DeliverableGatewayCallbackResult = Exclude<GatewayCallbackResult, { disposition: "ignored" }>;

function encodeCachedResult(result: DeliverableGatewayCallbackResult): Buffer {
  const payload = Buffer.from(JSON.stringify(result), "utf8");
  if (payload.byteLength === 0 || payload.byteLength > 1_048_576) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "verified callback result exceeds the durable cache limit");
  }
  return payload;
}

function decodeCachedResult(payload: Uint8Array, now: Date): DeliverableGatewayCallbackResult {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
  } catch {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "cached callback result is invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "cached callback result must be an object");
  }
  const record = value as Record<string, unknown>;
  if ((record.disposition !== "attested" && record.disposition !== "evidence") ||
      typeof record.providerEventId !== "string" ||
      record.providerEventId.length === 0 || record.providerEventId.length > 256 ||
      record.receipt === null || typeof record.receipt !== "object" || Array.isArray(record.receipt) ||
      record.evidence === null || typeof record.evidence !== "object" || Array.isArray(record.evidence)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "cached callback result fields are invalid");
  }
  const evidence = record.evidence as Record<string, unknown>;
  if (typeof evidence.expiresAt === "string") {
    const expiresAt = Date.parse(evidence.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
      throw new CachedEvidenceExpiredError();
    }
  }
  try {
    assertSignedCapabilityEvidence(record.evidence as SignedCapabilityEvidence, now);
    if (record.disposition === "evidence") {
      const directEvidence = record.evidence as SignedCapabilityEvidence;
      if (Object.prototype.hasOwnProperty.call(record, "businessEvent") ||
          directEvidence.canonicalClaimsSha256 !== undefined || directEvidence.businessEventSha256 !== undefined) {
        throw new Error("direct evidence cache contains a business-event projection");
      }
      return record as unknown as DeliverableGatewayCallbackResult;
    }
    if (record.businessEvent === null || typeof record.businessEvent !== "object" || Array.isArray(record.businessEvent)) {
      throw new Error("cached business event is missing");
    }
    const businessEvent = normalizeVerifiedBusinessEvent(record.businessEvent as VerifiedBusinessEvent);
    const evidence = record.evidence as SignedCapabilityEvidence;
    if (evidence.evidenceId !== businessEvent.evidenceId || evidence.scope !== businessEvent.evidenceScope ||
        evidence.tenantId !== businessEvent.tenantId || evidence.provider !== businessEvent.provider ||
        evidence.artifactSha256 !== businessEvent.artifactSha256 ||
        evidence.canonicalClaimsSha256 !== businessEvent.canonicalClaimsSha256 ||
        evidence.businessEventSha256 !== businessEvent.businessEventSha256) {
      throw new Error("cached evidence and event binding mismatch");
    }
  } catch {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "cached callback evidence is invalid");
  }
  return record as unknown as DeliverableGatewayCallbackResult;
}

class CachedEvidenceExpiredError extends ProductionIntegrationError {
  constructor() {
    super("PROVIDER_REJECTED", "cached callback evidence expired before delivery", true);
    this.name = "CachedEvidenceExpiredError";
  }
}

async function bestEffort(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {
    // Preserve the original provider/sink error; the lease TTL remains the recovery path.
  }
}

class GatewayHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function mapError(error: unknown): { status: number; code: string } {
  if (error instanceof GatewayHttpError) return error;
  if (error instanceof ProductionIntegrationError) {
    switch (error.code) {
      case "PROVIDER_SIGNATURE_INVALID": return { status: 401, code: error.code };
      case "PROVIDER_REPLAY_DETECTED": return { status: 409, code: error.code };
      case "PROVIDER_RESPONSE_INVALID":
      case "PROVIDER_REJECTED": return error.retryable
        ? { status: 503, code: "PROVIDER_UNAVAILABLE" }
        : { status: 400, code: error.code };
      case "PROVIDER_TIMEOUT":
      case "CREDENTIAL_UNAVAILABLE": return { status: 503, code: error.code };
      case "CONFIGURATION_INVALID": return { status: 503, code: error.code };
    }
  }
  return { status: 500, code: "INTERNAL_ERROR" };
}

async function readRawBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const declared = singleHeader(request, "content-length", true);
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    throw new GatewayHttpError(413, "BODY_TOO_LARGE");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += bytes.byteLength;
    if (length > maximum) throw new GatewayHttpError(413, "BODY_TOO_LARGE");
    chunks.push(bytes);
  }
  if (length === 0) throw new GatewayHttpError(400, "EMPTY_BODY");
  return Buffer.concat(chunks, length);
}

function requireJsonContentType(value: string): void {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value)) {
    throw new GatewayHttpError(415, "UNSUPPORTED_MEDIA_TYPE");
  }
}

function normalizedHeaders(request: IncomingMessage): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) throw new GatewayHttpError(400, "DUPLICATE_HEADER");
    result[name.toLowerCase()] = value;
  }
  return result;
}

function singleHeader(request: IncomingMessage, name: string, optional = false): string | undefined {
  const value = request.headers[name];
  if (value === undefined) {
    if (optional) return undefined;
    throw new GatewayHttpError(400, "MISSING_HEADER");
  }
  if (Array.isArray(value) || value.length === 0 || value.length > 8_192 || /[\u0000\r\n]/.test(value)) {
    throw new GatewayHttpError(400, "INVALID_HEADER");
  }
  return value;
}

function writeJson(response: ServerResponse, status: number, payload: Readonly<Record<string, unknown>>): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", String(body.byteLength));
  response.end(body);
}
