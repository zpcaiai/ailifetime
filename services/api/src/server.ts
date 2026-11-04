import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { externalBusinessEventReducerRegistry, type CapabilityRegistry } from "@ltm/capabilities";
import {
  DomainError,
  hasPermission,
  isDomainError,
  QUALITY_CONTROLS,
  listQualityRecords,
  type ActorContext,
  type ExternalBusinessEventReducerRegistry,
  type LifeTimeMachineRuntimePort,
  type JsonObject,
} from "@ltm/core";
import type { RequestAuthenticator } from "./auth.js";
import type { ProductionDomainRuntime } from "./domain-runtime.js";
import type { BrowserOidcPublicConfiguration } from "./browser-oidc.js";
import type { ClientIntegrationPorts, MediaDeletionProjection } from "./client-integrations.js";
import { TimelineDeliveryService } from "./timeline-delivery.js";
import type { TimelinePhotoQualityService } from "./timeline-photo-quality.js";
import {PhotoQualityGovernance,qualityHuman} from "./photo-quality-governance.js";
import {PhotoQualityReview} from "./photo-quality-review.js";
import type { TimelineSeedreamService } from "./timeline-seedream.js";
import { WardrobeService } from "./wardrobe.js";
import { PHOTO_PRODUCTS, PHOTO_PRICE_VERSION } from "./photo-catalog.js";
import { PhotoPurchaseService, PHOTO_PURCHASE_COLLECTION } from "./photo-purchases.js";
import { FileTimelineArtifactStore, type TimelineArtifactReader } from "./timeline-artifacts.js";
import {
  COMMANDS,
  QUERIES,
  capabilityCatalog,
  dispatchCapability,
  dispatchCommand,
  dispatchQuery,
  normalizeCapabilityBatchId,
  object,
  parseDispatchEnvelope,
  visibleCapabilityCatalog,
  visibleCapabilityPortals,
} from "./dispatch.js";

export interface ApiLogEntry {
  readonly level: "info" | "error";
  readonly event: string;
  readonly requestId: string;
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly error?: string;
  readonly durationMs?: number;
}

export interface ApiServerOptions {
  readonly runtime: LifeTimeMachineRuntimePort;
  readonly authenticator: RequestAuthenticator;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly externalBusinessEventReducerRegistry?: ExternalBusinessEventReducerRegistry;
  readonly bodyLimitBytes?: number;
  readonly staticDirectory?: string | null;
  readonly allowSandboxStepUpHeader?: boolean;
  readonly appEnvironment?: string;
  /** SHA-256 of a bearer token protecting /metrics. Required in production. */
  readonly metricsTokenSha256?: string;
  readonly clientIntegrations?: ClientIntegrationPorts;
  readonly timelineArtifacts?: TimelineArtifactReader;
  readonly photoQuality?: TimelinePhotoQualityService;
  readonly seedream?: TimelineSeedreamService;
  readonly seedreamReadiness?: () => Promise<boolean>;
  /** Production bounded-context composition; omitted only for local/test fixtures. */
  readonly domainRuntime?: ProductionDomainRuntime;
  readonly browserOidcConfiguration?: BrowserOidcPublicConfiguration;
  readonly logger?: (entry: ApiLogEntry) => void;
}

const DEFAULT_BODY_LIMIT = 256 * 1024;
const DEFAULT_STATIC_DIRECTORY = fileURLToPath(new URL("../../../apps/web/public/", import.meta.url));
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const FORBIDDEN_CONTEXT_HEADERS = [
  "x-actor-id",
  "x-actor-role",
  "x-actor-roles",
  "x-role",
  "x-tenant-id",
  "x-roles",
  "x-permissions",
  "x-guardian-verified",
  "x-operation-id",
] as const;

interface ApiMetrics {
  readonly startedAtMs: number;
  requestsTotal: number;
  activeRequests: number;
  durationTotalMs: number;
  readonly responsesByStatus: Map<number, number>;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function createApiServer(options: ApiServerOptions): Server {
  if (options.appEnvironment === "production" && options.timelineArtifacts instanceof FileTimelineArtifactStore) {
    throw new DomainError("CONFIGURATION_INVALID", "local timeline file storage cannot run in production");
  }
  const bodyLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1_024 || bodyLimit > 10 * 1024 * 1024) {
    throw new DomainError("VALIDATION_FAILED", "bodyLimitBytes must be between 1024 and 10485760");
  }
  if (options.allowSandboxStepUpHeader === true && options.appEnvironment?.toLowerCase() === "production") {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "Sandbox step-up headers are forbidden in production");
  }
  if (options.metricsTokenSha256 !== undefined && !/^[a-f0-9]{64}$/.test(options.metricsTokenSha256)) {
    throw new DomainError("CONFIGURATION_INVALID", "metricsTokenSha256 must be a lowercase SHA-256 digest");
  }
  if (options.appEnvironment?.toLowerCase() === "production" && options.metricsTokenSha256 === undefined) {
    throw new DomainError("CONFIGURATION_INVALID", "Production API requires a protected metrics bearer token digest");
  }
  const staticDirectory = options.staticDirectory === undefined ? DEFAULT_STATIC_DIRECTORY : options.staticDirectory;
  const logger = options.logger ?? (() => undefined);
  const metrics: ApiMetrics = {
    startedAtMs: Date.now(),
    requestsTotal: 0,
    activeRequests: 0,
    durationTotalMs: 0,
    responsesByStatus: new Map(),
  };

  const server = createServer((request, response) => {
    void handleRequest(options, request, response, bodyLimit, staticDirectory, logger, metrics);
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 1_000;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });
  return server;
}

async function handleRequest(
  options: ApiServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  bodyLimit: number,
  staticDirectory: string | null,
  logger: (entry: ApiLogEntry) => void,
  metrics: ApiMetrics,
): Promise<void> {
  const requestId = requestIdFor(request);
  response.setHeader("x-request-id", requestId);
  applySecurityHeaders(response, options.browserOidcConfiguration);
  const method = request.method ?? "GET";
  let path = "/";
  const startedAt = performance.now();
  metrics.requestsTotal += 1;
  metrics.activeRequests += 1;
  let finalized = false;
  const finalize = (): void => {
    if (finalized) return;
    finalized = true;
    const durationMs = Math.max(0, performance.now() - startedAt);
    metrics.activeRequests = Math.max(0, metrics.activeRequests - 1);
    metrics.durationTotalMs += durationMs;
    metrics.responsesByStatus.set(response.statusCode, (metrics.responsesByStatus.get(response.statusCode) ?? 0) + 1);
    logger({
      level: response.statusCode >= 500 ? "error" : "info",
      event: "request.completed",
      requestId,
      method,
      path,
      status: response.statusCode,
      durationMs: Math.round(durationMs * 1_000) / 1_000,
    });
  };
  response.once("finish", finalize);
  response.once("close", finalize);
  try {
    if ((request.url?.length ?? 0) > 2_048) {
      throw new DomainError("VALIDATION_FAILED", "Request target is too long", { httpStatus: 414 });
    }
    const url = new URL(request.url ?? "/", "http://local.invalid");
    path = url.pathname;

    if (method === "GET" && path === "/health/live") {
      sendJson(response, 200, { status: "ok", requestId });
      return;
    }
    if (method === "GET" && path === "/health/ready") {
      const readiness = await options.runtime.readiness();
      const integrations = await clientIntegrationReadiness(options.clientIntegrations);
      const domain = options.domainRuntime === undefined ? { ready: true, database: "embedded", schemaVersion: null } : await options.domainRuntime.readiness();
      const generationReady = options.seedreamReadiness === undefined ? true : await options.seedreamReadiness();
      const ready = readiness.ready && integrations.every((item) => item.ready) && domain.ready && generationReady;
      sendJson(response, ready ? 200 : 503, { ...readiness, ready, integrations, domain, generationReady, requestId });
      return;
    }
    if (method === "GET" && path === "/metrics") {
      authorizeMetrics(request, options.metricsTokenSha256);
      sendText(response, 200, renderMetrics(metrics), "text/plain; version=0.0.4; charset=utf-8");
      return;
    }

    if (method === "GET" && path === "/v1/auth/browser/config") {
      if (options.browserOidcConfiguration === undefined) {
        throw new DomainError("DEPENDENCY_UNAVAILABLE", "Browser OIDC is not configured", { httpStatus: 503 });
      }
      sendJson(response, 200, options.browserOidcConfiguration);
      return;
    }

    if (method === "POST" && path === "/v1/auth/wechat/session") {
      const identity = requireWechatIdentity(options.clientIntegrations);
      const body = object(await readJsonBody(request, bodyLimit), "request body");
      assertExactKeys(body, ["code", "consentVersion", "clientRequestId"], "request body");
      const session = await identity.createSession({
        code: requestString(body.code, "code", 512),
        consentVersion: requestString(body.consentVersion, "consentVersion", 128),
        clientRequestId: requestIdentifier(body.clientRequestId, "clientRequestId"),
        idempotencyKey: requireIdempotencyKey(request),
        requestId,
      });
      sendJson(response, 200, session);
      return;
    }

    if (method === "POST" && path === "/v1/auth/session/refresh") {
      const identity = requireWechatIdentity(options.clientIntegrations);
      assertEmptyObject(await readJsonBody(request, bodyLimit), "request body");
      const session = await identity.refreshSession({
        accessToken: requireBearerToken(request),
        idempotencyKey: requireIdempotencyKey(request),
        requestId,
      });
      sendJson(response, 200, session);
      return;
    }

    if (method === "POST" && path === "/v1/auth/session/logout") {
      const identity = requireWechatIdentity(options.clientIntegrations);
      assertEmptyObject(await readJsonBody(request, bodyLimit), "request body");
      await identity.revokeSession({
        accessToken: requireBearerToken(request),
        idempotencyKey: requireIdempotencyKey(request),
        requestId,
      });
      sendJson(response, 200, { revoked: true, requestId });
      return;
    }

    if (method === "GET" && path === "/v1/session") {
      const context = await authenticate(options, request, requestId);
      sendJson(response, 200, {
        session: {
          actorId: context.actorId,
          tenantId: context.tenantId,
          roles: context.roles,
          purpose: context.purpose,
          stepUp: context.stepUp ?? false,
          guardianVerified: context.guardianVerified ?? false,
          authenticationState: "server_verified",
        },
        requestId,
      });
      return;
    }

    if (method === "GET" && path === "/v1/consent-policy/authority") {
      const context = await authenticate(options, request, requestId);
      const metadata = await options.runtime.getConsentPolicyCatalogMetadata(context);
      sendJson(response, 200, { ...metadata, requestId });
      return;
    }

    if (method === "GET" && path === "/v1/capabilities/visible") {
      const context = await authenticate(options, request, requestId);
      const capabilities = visibleCapabilityCatalog(options.capabilityRegistry, context);
      const portals = visibleCapabilityPortals(context, capabilities);
      sendJson(response, 200, {
        schemaVersion: "ltm.visible-capability-manifest.v1",
        capabilities,
        portals,
        count: capabilities.length,
        requestId,
      });
      return;
    }

    const catalog = capabilityCatalog(options.capabilityRegistry);
    if (method === "GET" && path === "/v1/photo-products") {
      sendJson(response, 200, { data: { priceVersion: PHOTO_PRICE_VERSION, products: PHOTO_PRODUCTS }, requestId }); return;
    }
    if (path === "/v1/photo-purchases" && (method === "GET" || method === "POST")) {
      const actor = await authenticate(options, request, requestId);
      if (actor.purpose !== "age_transformation") throw new DomainError("PURPOSE_REQUIRED", "photo purchase requires age_transformation purpose");
      const cursor = url.searchParams.get("cursor");
      if ((method === "POST" && url.search !== "") || [...url.searchParams.keys()].some(key => key !== "cursor") || url.searchParams.getAll("cursor").length > 1 || (cursor !== null && !/^photo-[a-f0-9]{64}$/.test(cursor))) throw new DomainError("VALIDATION_FAILED", "invalid photo purchase list cursor");
      if (method === "GET") {
        const records = await options.runtime.listRecords(actor, { collection: PHOTO_PURCHASE_COLLECTION, limit: 25, ...(cursor ? {cursor} : {}) });
        const items = records.filter(record => record.ownerActorId === actor.actorId).map(record => {
          const scope = record.data.scope as Record<string, unknown>;
          return { purchaseId: record.id, title: scope.title, sku: scope.sku, priceVersion: scope.priceVersion, amountMinor: scope.amountMinor, currency: scope.currency, seriesTitle: scope.seriesTitle ?? null, expectedCount: scope.imageCount, paymentState: record.data.paymentState, createdAt: record.createdAt,
            ...(scope.imageQuality ? {imageQuality:scope.imageQuality,imageWidth:scope.imageWidth,imageHeight:scope.imageHeight,retentionDays:scope.retentionDays} : {}) };
        });
        sendJson(response, 200, { data: { items, nextCursor: records.length === 25 ? records.at(-1)!.id : null }, requestId }); return;
      }
      const input = object(await readJsonBody(request, bodyLimit), "photo purchase");
      const data = await photoPurchases(options).create(actor, input, requireIdempotencyKey(request));
      sendJson(response, 201, { data, requestId }); return;
    }
    const photoPurchaseMatch = /^\/v1\/photo-purchases\/(photo-[a-f0-9]{64})(?:\/(checkout|confirm|fulfill))?$/.exec(path);
    if (photoPurchaseMatch && (method === "GET" || method === "POST")) {
      const actor = await authenticate(options, request, requestId), purchase = photoPurchases(options), id = photoPurchaseMatch[1]!;
      if (actor.purpose !== "age_transformation") throw new DomainError("PURPOSE_REQUIRED", "photo purchase requires age_transformation purpose");
      if (url.search !== "") throw new DomainError("VALIDATION_FAILED", "photo purchase does not accept query parameters");
      if (method === "GET" && !photoPurchaseMatch[2]) { sendJson(response, 200, { data: await purchase.get(actor, id), requestId }); return; }
      if (method === "POST" && photoPurchaseMatch[2]) {
        assertEmptyObject(await readJsonBody(request, bodyLimit), "photo purchase operation"); requireIdempotencyKey(request);
        const action = photoPurchaseMatch[2];
        const data = action === "checkout" ? await purchase.checkout(actor, id) : action === "confirm" ? await purchase.confirm(actor, id) : await purchase.fulfill(actor, id);
        sendJson(response, 200, { data, requestId }); return;
      }
    }
    const photoRetryMatch = /^\/v1\/photo-purchases\/(photo-[a-f0-9]{64})\/items\/([A-Za-z0-9._:-]{1,128})\/retry$/.exec(path);
    if (method === "POST" && photoRetryMatch) {
      const actor = await authenticate(options, request, requestId);
      if (actor.purpose !== "age_transformation") throw new DomainError("PURPOSE_REQUIRED", "photo purchase requires age_transformation purpose");
      const input = object(await readJsonBody(request, bodyLimit), "purchased item retry"); assertExactKeys(input, ["attempt"], "purchased item retry"); requireIdempotencyKey(request);
      const data = await photoPurchases(options).retry(actor, photoRetryMatch[1]!, photoRetryMatch[2]!, requestInteger(input.attempt, "attempt", 1, 3));
      sendJson(response, 200, { data, requestId }); return;
    }
    if (method === "GET" && (path === "/v1/capabilities" || path === "/v1/catalog/capabilities")) {
      sendJson(response, 200, { capabilities: catalog, count: catalog.length, requestId });
      return;
    }
    if (method === "GET" && path === "/v1/catalog") {
      sendJson(response, 200, {
        commands: COMMANDS,
        queries: QUERIES,
        capabilities: catalog,
        requestId,
      });
      return;
    }
    if (method === "GET" && path === "/v1/catalog/skills") {
      const skills = [...new Set(catalog.map((entry) => entry.skill))].sort().map((skill) => ({
        skill,
        batches: catalog.filter((entry) => entry.skill === skill).map((entry) => entry.batchId),
      }));
      sendJson(response, 200, { skills, count: skills.length, requestId });
      return;
    }

    if (method === "POST" && path === "/v1/integrations/evidence-sink/preflight") {
      const context = await authenticate(options, request, requestId);
      assertEmptyObject(await readJsonBody(request, bodyLimit), "request body");
      const permissions = ["evidence:register", "external-event:apply"] as const;
      if (!context.roles.includes("service_account") || permissions.some((permission) => !hasPermission(context, permission))) {
        throw new DomainError(
          "AUTH_FORBIDDEN",
          "Evidence sink preflight requires one service principal authorized for both sink operations",
        );
      }
      sendJson(response, 200, {
        schemaVersion: "ltm.evidence-sink-preflight.v1",
        principal: { actorId: context.actorId, tenantId: context.tenantId },
        permissions,
        requestId,
      });
      return;
    }

    // Native mobile operational telemetry is persisted through B41 after the
    // server minimizes fields and pseudonymizes the authenticated actor. The
    // caller never receives event:receive authority and cannot choose a tenant.
    if (method === "POST" && path === "/v1/mobile/telemetry") {
      const authenticated = await authenticate(options, request, requestId);
      const key = requireIdempotencyKey(request);
      const event = mobileTelemetryEvent(await readJsonBody(request, bodyLimit));
      const actorPseudonym = createHash("sha256")
        .update(`${authenticated.tenantId}\n${authenticated.actorId}`, "utf8")
        .digest("hex");
      const serviceContext: ActorContext = {
        ...authenticated,
        actorId: `mobile-telemetry:${actorPseudonym.slice(0, 32)}`,
        roles: ["service_account"],
        permissions: ["event:receive", "audit:append"],
        purpose: "product_analytics",
        operationId: operationContext(authenticated, "mobile.telemetry", key).operationId!,
      };
      const data = await options.capabilityRegistry.execute(options.runtime, "B41", {
        actor: serviceContext,
        idempotencyKey: key,
        input: {
          eventId: event.eventId,
          eventType: event.name,
          schemaVersion: "ltm.mobile.telemetry.v1",
          occurredAt: event.occurredAt,
          receivedAt: event.occurredAt,
          actorPseudonym,
          dimensions: { surface: "native_mobile", ...event.fields },
          metricNames: [event.name],
        },
      });
      sendJson(response, 200, { data, meta: { requestId, batchId: "B41" } });
      return;
    }

    if (method === "POST" && path === "/v1/wechat/payments") {
      const platform = requireWechatPlatform(options.clientIntegrations);
      const context = await authenticate(options, request, requestId);
      assertWechatPurpose(context, "commerce");
      const body = object(await readJsonBody(request, bodyLimit), "request body");
      // Price, currency, payer openid, merchant ID, notify URL, and provider
      // state are deliberately not accepted from the client. The broker resolves
      // all of them from its trusted checkout and identity stores.
      assertExactKeys(body, ["checkoutId"], "request body");
      const data = await platform.createPayment(context, {
        checkoutId: requestIdentifier(body.checkoutId, "checkoutId"),
        idempotencyKey: requireIdempotencyKey(request),
      });
      if (String(body.checkoutId).startsWith("photo-")) await photoPurchases(options).assertIntent({ ...context, purpose: "age_transformation" }, body.checkoutId as string, data);
      sendJson(response, 201, { data, meta: { requestId } });
      return;
    }

    const wechatPaymentMatch = /^\/v1\/wechat\/payments\/([A-Za-z0-9][A-Za-z0-9._:-]{7,255})$/.exec(path);
    if (method === "GET" && wechatPaymentMatch?.[1] !== undefined) {
      if (url.search !== "") throw new DomainError("VALIDATION_FAILED", "Payment status does not accept query parameters");
      const platform = requireWechatPlatform(options.clientIntegrations);
      const context = await authenticate(options, request, requestId);
      assertWechatPurpose(context, "commerce");
      const data = await platform.getPayment(context, { orderId: wechatPaymentMatch[1], requestId });
      sendJson(response, 200, { data, meta: { requestId } });
      return;
    }

    if (method === "GET" && path === "/v1/wechat/subscription-offer") {
      if (url.search !== "") throw new DomainError("VALIDATION_FAILED", "Subscription offer does not accept query parameters");
      const platform = requireWechatPlatform(options.clientIntegrations);
      const context = await authenticate(options, request, requestId);
      assertWechatPurpose(context, "notifications");
      const data = await platform.getSubscriptionOffer(context, { requestId });
      sendJson(response, 200, { data, meta: { requestId } });
      return;
    }

    if (method === "POST" && path === "/v1/wechat/subscription-authorizations") {
      const platform = requireWechatPlatform(options.clientIntegrations);
      const context = await authenticate(options, request, requestId);
      assertWechatPurpose(context, "notifications");
      const body = object(await readJsonBody(request, bodyLimit), "request body");
      assertExactKeys(body, ["offerId", "revision", "acceptedTemplateIds"], "request body");
      const data = await platform.authorizeSubscriptions(context, {
        offerId: requestIdentifier(body.offerId, "offerId"),
        revision: requestInteger(body.revision, "revision", 1, 1_000_000),
        acceptedTemplateIds: requestTemplateIds(body.acceptedTemplateIds),
        idempotencyKey: requireIdempotencyKey(request),
      });
      sendJson(response, 201, { data, meta: { requestId } });
      return;
    }

    if (method === "POST" && path === "/v1/wechat/customer-service-grants") {
      const platform = requireWechatPlatform(options.clientIntegrations);
      const context = await authenticate(options, request, requestId);
      assertWechatPurpose(context, "customer_support");
      assertEmptyObject(await readJsonBody(request, bodyLimit), "request body");
      const data = await platform.createCustomerServiceGrant(context, {
        idempotencyKey: requireIdempotencyKey(request),
      });
      sendJson(response, 201, { data, meta: { requestId } });
      return;
    }

    if (method === "POST" && path === "/v1/uploads") {
      const uploads = requireUploads(options.clientIntegrations);
      const context = await authenticate(options, request, requestId);
      const body = object(await readJsonBody(request, bodyLimit), "request body");
      assertExactKeys(body, ["fileSize", "fileDigest", "digestAlgorithm", "contentType", "clientRequestId"], "request body");
      const fileSize = requestInteger(body.fileSize, "fileSize", 1, 25 * 1024 * 1024);
      const fileDigest = requestSha256Digest(body.fileDigest, "fileDigest");
      if (body.digestAlgorithm !== "sha256") throw new DomainError("VALIDATION_FAILED", "digestAlgorithm must be sha256");
      if (body.contentType !== "image/jpeg") throw new DomainError("VALIDATION_FAILED", "contentType must be image/jpeg");
      const created = await uploads.create(context, {
        fileSize,
        fileDigest,
        digestAlgorithm: "sha256",
        contentType: "image/jpeg",
        clientRequestId: requestIdentifier(body.clientRequestId, "clientRequestId"),
        idempotencyKey: requireIdempotencyKey(request),
      });
      // The broker uses fixed five-MiB multipart parts for every non-final chunk.
      // Surface that value explicitly so clients never guess a resumability contract.
      sendJson(response, 201, { ...created, chunkBytes: 5 * 1024 * 1024 });
      return;
    }

    const uploadMatch = /^\/v1\/uploads\/([A-Za-z0-9][A-Za-z0-9._:-]{0,255})\/(chunks|complete|cancel)$/.exec(path);
    if (method === "POST" && uploadMatch?.[2] === "chunks") {
      const uploads = requireUploads(options.clientIntegrations);
      const context = await authenticate(options, request, requestId);
      const range = requireContentRange(request);
      const bytes = await readBody(request, 5 * 1024 * 1024, "application/octet-stream");
      if (bytes.byteLength !== range.end - range.start + 1 || bytes.byteLength < 1 || bytes.byteLength > 5 * 1024 * 1024) {
        throw new DomainError("VALIDATION_FAILED", "Upload chunk does not match Content-Range");
      }
      const expectedChunkSha256 = requireChunkSha256(request);
      const actualChunkSha256 = createHash("sha256").update(bytes).digest("hex");
      if (!timingSafeEqual(Buffer.from(expectedChunkSha256, "ascii"), Buffer.from(actualChunkSha256, "ascii"))) {
        throw new DomainError("VALIDATION_FAILED", "Upload chunk checksum does not match its bytes");
      }
      const result = await uploads.append(context, {
        uploadId: uploadMatch[1] ?? "",
        bytes,
        ...range,
        idempotencyKey: requireIdempotencyKey(request),
      });
      sendJson(response, 200, result);
      return;
    }
    if (method === "POST" && uploadMatch?.[2] === "complete") {
      const uploads = requireUploads(options.clientIntegrations);
      const context = await authenticate(options, request, requestId);
      const body = object(await readJsonBody(request, bodyLimit), "request body");
      assertExactKeys(body, ["fileDigest", "digestAlgorithm"], "request body");
      if (body.digestAlgorithm !== "sha256") throw new DomainError("VALIDATION_FAILED", "digestAlgorithm must be sha256");
      const result = await uploads.complete(context, {
        uploadId: uploadMatch[1] ?? "",
        fileDigest: requestSha256Digest(body.fileDigest, "fileDigest"),
        digestAlgorithm: "sha256",
        idempotencyKey: requireIdempotencyKey(request),
      });
      sendJson(response, 200, result);
      return;
    }
    if (method === "POST" && uploadMatch?.[2] === "cancel") {
      const uploads = requireUploads(options.clientIntegrations);
      const context = await authenticate(options, request, requestId);
      assertEmptyObject(await readJsonBody(request, bodyLimit), "request body");
      await uploads.cancel(context, { uploadId: uploadMatch[1] ?? "", idempotencyKey: requireIdempotencyKey(request) });
      sendJson(response, 200, { cancelled: true, requestId });
      return;
    }
    const wardrobeMatch = /^\/v1\/timelines\/([A-Za-z0-9](?:[A-Za-z0-9._:-]|%3[Aa]){0,127})\/nodes\/(\d{1,3})\/wardrobe$/.exec(path);
    if (wardrobeMatch && (method === "GET" || method === "POST")) {
      const actor = await authenticate(options, request, requestId), rootId = decodeURIComponent(wardrobeMatch[1]!), age = Number(wardrobeMatch[2]);
      if (String(age) !== wardrobeMatch[2]) throw new DomainError("VALIDATION_FAILED", "wardrobe age path must be canonical");
      if (method === "POST") requireOperatorGeneration(actor);
      const wardrobe = new WardrobeService(options.runtime, options.capabilityRegistry, options.timelineArtifacts);
      const data = method === "GET" ? await wardrobe.context(actor, rootId, age) : await wardrobe.create(operationContext(actor, "wardrobe.create", requireIdempotencyKey(request)), rootId, age, object(await readJsonBody(request, bodyLimit), "wardrobe request"), requireIdempotencyKey(request));
      sendJson(response, 200, {data, requestId}); return;
    }
    if(method==="GET"&&path==="/v1/quality/reviews"){
      const actor=await authenticate(options,request,requestId),data=await new PhotoQualityReview(options.runtime,options.timelineArtifacts).list(actor);
      response.setHeader("cache-control","private, no-store");sendJson(response,200,{data,requestId});return;
    }
    if(method==="GET"&&path==="/v1/quality/controls"){
      const actor=await authenticate(options,request,requestId);qualityHuman(options.runtime,actor,"media.quality.control");
      const rows=await listQualityRecords(options.runtime,actor,QUALITY_CONTROLS),data=rows.map(row=>({id:row.id,version:row.version,state:row.data.state,epoch:row.data.epoch,context:row.data.context,modelVersion:row.data.modelVersion,sampleCount:row.data.sampleCount,failureCount:row.data.failureCount,stopReason:row.data.stopReason??null,resumeProposal:row.data.resumeProposal??null}));
      response.setHeader("cache-control","private, no-store");sendJson(response,200,{data,requestId});return;
    }
    const qualityPreview=/^\/v1\/quality\/reviews\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/preview\/(output|reference)$/.exec(path);
    if(method==="GET"&&qualityPreview){
      const actor=await authenticate(options,request,requestId),preview=await new PhotoQualityReview(options.runtime,options.timelineArtifacts).preview(actor,qualityPreview[1]!,qualityPreview[2] as "output"|"reference");
      response.statusCode=200;response.setHeader("cache-control","private, no-store");response.setHeader("content-type",preview.asset.mimeType);response.setHeader("content-disposition","inline");response.setHeader("x-ltm-image-sha256",preview.asset.sha256);
      response.end(Buffer.from(preview.bytes));return;
    }
    const qualityAction=/^\/v1\/quality\/(reviews|controls)\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/(decisions|resume)$/.exec(path);
    if(method==="POST"&&qualityAction&&((qualityAction[1]==="reviews"&&qualityAction[3]==="decisions")||(qualityAction[1]==="controls"&&qualityAction[3]==="resume"))){
      const actor=await authenticate(options,request,requestId),input=object(await readJsonBody(request,bodyLimit),"quality operation"),key=requireIdempotencyKey(request),review=qualityAction[1]==="reviews";
      assertExactKeys(input,review?["action","decision","expectedVersion","reason","ticket"]:["action","expectedVersion","reason","ticket"],"quality operation");
      const context=operationContext(actor,review?"quality.review":"quality.resume",key);
      const result=review?await new PhotoQualityReview(options.runtime,options.timelineArtifacts).decide(context,qualityAction[2]!,input as JsonObject,key):await new PhotoQualityGovernance(options.runtime).resume(context,qualityAction[2]!,input as JsonObject,key);
      const data=review?result:{id:result.id,version:result.version,state:(result as import("@ltm/core").RecordEnvelope).data.state,epoch:(result as import("@ltm/core").RecordEnvelope).data.epoch};
      response.setHeader("cache-control","private, no-store");sendJson(response,200,{data,requestId});return;
    }
    const generationMatch = /^\/v1\/timelines\/([A-Za-z0-9](?:[A-Za-z0-9._:-]|%3[Aa]){0,127})\/generate$/.exec(path);
    if (method === "POST" && generationMatch?.[1] !== undefined) {
      const actor = await authenticate(options, request, requestId);
      if (!actor.roles.includes("service_account") || !hasPermission(actor,"media.generation.generate")) throw new DomainError("AUTH_FORBIDDEN","generation requires an authorized service account");
      if (!options.seedream) throw new DomainError("DEPENDENCY_UNAVAILABLE","Seedream Pro is not configured");
      const input = object(await readJsonBody(request,bodyLimit),"generation request");
      assertExactKeys(input,["targetAge"],"generation request");
      if (typeof input.targetAge !== "number") throw new DomainError("VALIDATION_FAILED","generation requires targetAge");
      const data = await options.seedream.generate(operationContext(actor,"seedream.generate",requireIdempotencyKey(request)),decodeURIComponent(generationMatch[1]),input.targetAge);
      sendJson(response,200,{data,requestId});return;
    }
    const photoQualityMatch = /^\/v1\/timelines\/([A-Za-z0-9](?:[A-Za-z0-9._:-]|%3[Aa]){0,127})\/quality$/.exec(path);
    if (method === "POST" && photoQualityMatch?.[1] !== undefined) {
      const actor = await authenticate(options, request, requestId);
      if (!actor.roles.includes("service_account") || !hasPermission(actor,"media.quality.evaluate")) throw new DomainError("AUTH_FORBIDDEN","photo quality requires an authorized service account");
      if (!options.photoQuality) throw new DomainError("DEPENDENCY_UNAVAILABLE","photo scoring is not configured");
      const input=object(await readJsonBody(request,bodyLimit),"photo quality request");
      assertExactKeys(input,["targetAge","asset"],"photo quality request");
      if (typeof input.targetAge!=="number") throw new DomainError("VALIDATION_FAILED","photo scoring requires targetAge");
      const data=await options.photoQuality.evaluate(operationContext(actor,"photo-quality.evaluate",requireIdempotencyKey(request)),decodeURIComponent(photoQualityMatch[1]),input.targetAge,input.asset);
      sendJson(response,200,{data,requestId});return;
    }
    const timelineMatch = /^\/v1\/timelines\/([A-Za-z0-9](?:[A-Za-z0-9._:-]|%3[Aa]){0,127})(?:\/(retry|nodes\/(\d{1,3})\/image))?$/.exec(path);
    if (timelineMatch?.[1] !== undefined && ((method === "GET" && timelineMatch[2] !== "retry") || (method === "POST" && timelineMatch[2] === "retry"))) {
      const actor = await authenticate(options, request, requestId);
      const delivery = new TimelineDeliveryService(options.runtime), commandId = decodeURIComponent(timelineMatch[1]);
      if (method === "POST") {
        const input = object(await readJsonBody(request, bodyLimit), "timeline retry");
        if (Object.keys(input).length !== 2 || Object.keys(input).some(key => !["targetAge", "attempt"].includes(key)) ||
            typeof input.targetAge !== "number" || typeof input.attempt !== "number") throw new DomainError("VALIDATION_FAILED", "retry requires only targetAge and attempt");
        const key = requireIdempotencyKey(request);
        await photoPurchases(options).authorizeRetry(actor, commandId);
        const result = await delivery.retry(operationContext(actor, "timeline.retry", key), commandId, input.targetAge, input.attempt);
        sendJson(response, 200, { data: result, requestId }); return;
      }
      const view = await delivery.get(actor, commandId);
      if (timelineMatch[3] !== undefined) {
        const age = Number(timelineMatch[3]), node = view.nodes.find(node => node.targetAge === age);
        if (String(age) !== timelineMatch[3]) throw new DomainError("VALIDATION_FAILED", "timeline age path must be canonical");
        if (node?.status !== "ready" || !node.asset) throw new DomainError("RESOURCE_NOT_FOUND", "timeline image is not publishable");
        if (!options.timelineArtifacts) throw new DomainError("DEPENDENCY_UNAVAILABLE", "timeline image reader is not configured");
        const bytes = await options.timelineArtifacts.read(node.asset, actor);
        if (bytes.byteLength !== node.asset.byteLength || createHash("sha256").update(bytes).digest("hex") !== node.asset.sha256) throw new DomainError("DEPENDENCY_UNAVAILABLE", "timeline image storage binding failed");
        const fresh = (await delivery.get(actor, commandId)).nodes.find(item => item.targetAge === age);
        if (fresh?.status !== "ready" || fresh.asset?.sha256 !== node.asset.sha256) throw new DomainError("VERSION_CONFLICT", "timeline image changed during download");
        response.statusCode = 200;
        response.setHeader("cache-control", "private, no-store");
        response.setHeader("content-type", node.asset.mimeType);
        response.setHeader("content-disposition", `attachment; filename="ai-age-${age}.${node.asset.mimeType === "image/png" ? "png" : "jpg"}"`);
        response.setHeader("x-ltm-image-sha256", node.asset.sha256);
        response.setHeader("x-ltm-ai-generated", "true");
        // Streaming avoids Vercel's buffered 4.5 MB response limit. Verify all
        // bytes, authorization and expiry before emitting the first chunk.
        response.flushHeaders();
        for (let offset = 0; offset < bytes.byteLength; offset += 64*1024) {
          if (response.destroyed) return;
          if (!response.write(bytes.subarray(offset,offset+64*1024))) {
            await new Promise<void>(resolve => {
              const done = () => { response.off("drain",done); response.off("close",done); resolve(); };
              response.once("drain",done); response.once("close",done);
            });
          }
        }
        response.end(); return;
      }
      sendJson(response, 200, { data: { ...view, mediaAvailable: options.timelineArtifacts !== undefined,
        nodes: view.nodes.map(node => ({ ...node, downloadPath: node.status === "ready" && options.timelineArtifacts ? `/v1/timelines/${commandId}/nodes/${node.targetAge}/image` : null })) }, requestId }); return;
    }
    const capabilityMatch = /^\/v1\/capabilities\/(B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7]))$/.exec(path);
    if (method === "GET" && capabilityMatch?.[1] !== undefined) {
      const definition = catalog.find((entry) => entry.batchId === capabilityMatch[1]);
      if (definition === undefined) {
        throw new DomainError("RESOURCE_NOT_FOUND", "Capability was not found");
      }
      sendJson(response, 200, { capability: definition, requestId });
      return;
    }

    if (method === "POST" && path === "/v1/commands") {
      const authenticated = await authenticate(options, request, requestId);
      const envelope = parseDispatchEnvelope(await readJsonBody(request, bodyLimit), "command");
      const key = requireIdempotencyKey(request);
      const context = operationContext(authenticated, `command:${envelope.operation}`, key);
      const data = await dispatchCommand(
        options.runtime,
        options.externalBusinessEventReducerRegistry ?? externalBusinessEventReducerRegistry,
        context,
        envelope.operation,
        envelope.input,
        key,
      );
      sendJson(response, 200, { data, meta: { requestId, command: envelope.operation } });
      return;
    }
    if (method === "POST" && path === "/v1/queries") {
      const context = await authenticate(options, request, requestId);
      const envelope = parseDispatchEnvelope(await readJsonBody(request, bodyLimit), "query");
      const data = await dispatchQuery(options.runtime, context, envelope.operation, envelope.input);
      sendJson(response, 200, { data, meta: { requestId, query: envelope.operation } });
      return;
    }
    if (method === "POST" && (path === "/v1/capabilities" || capabilityMatch?.[1] !== undefined)) {
      const authenticated = await authenticate(options, request, requestId);
      const key = requireIdempotencyKey(request);
      const body = object(await readJsonBody(request, bodyLimit), "request body");
      const batchId = normalizeCapabilityBatchId(capabilityMatch?.[1] ?? body.batchId);
      if (batchId === "B14") requireOperatorGeneration(authenticated);
      const input = body.input ?? (capabilityMatch?.[1] === undefined ? undefined : body);
      if (batchId === "B15" && options.photoQuality !== undefined && object(input ?? {},"quality input").artifactBinding !== undefined) {
        throw new DomainError("AUTH_FORBIDDEN","bound photo quality must use the configured pixel scorer endpoint");
      }
      const context = operationContext(authenticated, `capability:${batchId}`, key);
      const secured = await secureMediaCapabilityInput(
        options.runtime,
        options.clientIntegrations,
        context,
        batchId,
        input,
        key,
      );
      const data = await dispatchCapability(
        options.runtime,
        options.capabilityRegistry,
        secured.authorizedContext ?? context,
        batchId,
        secured.input,
        key,
        secured.portalAuthorization ?? "portal-manifest",
      );
      const controlledData = secured.mediaDeletion === undefined
        ? data
        : controlledMediaDeletionResult(data, secured.mediaDeletion);
      sendJson(response, 200, { data: controlledData, meta: { requestId, batchId } });
      return;
    }

    if (path.startsWith("/v1/") || path.startsWith("/health/")) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Route was not found");
    }
    if ((method === "GET" || method === "HEAD") && staticDirectory !== null) {
      const served = serveStatic(request, response, staticDirectory, path);
      if (served) return;
    }
    throw new DomainError("RESOURCE_NOT_FOUND", "Route was not found");
  } catch (error) {
    writeError(response, error, requestId, logger, method, path);
  }
}

async function authenticate(
  options: ApiServerOptions,
  request: IncomingMessage,
  requestId: string,
): Promise<ActorContext> {
  for (const header of FORBIDDEN_CONTEXT_HEADERS) {
    if (request.headers[header] !== undefined) {
      throw new DomainError("AUTH_FORBIDDEN", `${header} is server-resolved and must not be client supplied`);
    }
  }
  const sandboxStepUp = request.headers["x-ltm-step-up"];
  if (sandboxStepUp !== undefined && options.allowSandboxStepUpHeader !== true) {
    throw new DomainError("AUTH_FORBIDDEN", "x-ltm-step-up is disabled outside explicit local sandbox mode");
  }
  if (sandboxStepUp !== undefined && sandboxStepUp !== "true") {
    throw new DomainError("VALIDATION_FAILED", "x-ltm-step-up must be true when supplied");
  }
  const authenticated = await options.authenticator.authenticate({
    authorization: headerValue(request, "authorization"),
    purpose: headerValue(request, "x-purpose"),
    requestId,
  });
  return {
    ...authenticated,
    requestId,
    ...(sandboxStepUp === "true" ? { stepUp: true } : {}),
  };
}

async function clientIntegrationReadiness(
  ports: ClientIntegrationPorts | undefined,
): Promise<readonly { readonly ready: boolean; readonly dependency: string }[]> {
  const checks: Array<Promise<{ readonly ready: boolean; readonly dependency: string }>> = [];
  if (ports?.wechatIdentity !== undefined) checks.push(ports.wechatIdentity.readiness());
  if (ports?.wechatPlatform !== undefined) checks.push(ports.wechatPlatform.readiness());
  if (ports?.resumableUploads !== undefined) checks.push(ports.resumableUploads.readiness());
  return Promise.all(checks);
}

function requireWechatIdentity(ports: ClientIntegrationPorts | undefined) {
  if (ports?.wechatIdentity === undefined) {
    throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", "WeChat identity integration is not configured");
  }
  return ports.wechatIdentity;
}

function requireWechatPlatform(ports: ClientIntegrationPorts | undefined) {
  if (ports?.wechatPlatform === undefined) {
    throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", "WeChat commerce and messaging integration is not configured");
  }
  return ports.wechatPlatform;
}

function assertWechatPurpose(
  context: ActorContext,
  expected: "commerce" | "notifications" | "customer_support",
): void {
  if (context.purpose !== expected) {
    throw new DomainError("AUTH_FORBIDDEN", `WeChat operation requires ${expected} purpose`);
  }
}

function requireUploads(ports: ClientIntegrationPorts | undefined) {
  if (ports?.resumableUploads === undefined) {
    throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", "Resumable upload integration is not configured");
  }
  return ports.resumableUploads;
}

async function secureMediaCapabilityInput(
  runtime: LifeTimeMachineRuntimePort,
  ports: ClientIntegrationPorts | undefined,
  context: ActorContext,
  batchId: unknown,
  input: unknown,
  idempotencyKey: string,
): Promise<{
  readonly input: unknown;
  readonly mediaDeletion?: MediaDeletionProjection;
  readonly authorizedContext?: ActorContext;
  readonly portalAuthorization?: "b05-data-erasure";
}> {
  if (batchId === "B05") {
    const request = object(input, "B05 request body");
    assertExactKeys(request, ["assetId", "reason"], "B05 request body");
    const assetId = requestIdentifier(request.assetId, "assetId");
    const reason = requestString(request.reason, "reason", 500);
    const roles = new Set(context.roles);
    const privileged = roles.has("platform_admin") || roles.has("privacy_officer");
    const dataSubject = roles.has("consumer") || roles.has("guardian") || roles.has("household_admin");
    const purposeAllowed = privileged
      ? ["product_operation", "privacy_compliance", "data_deletion"].includes(context.purpose)
      : ["data_deletion", "privacy_request", "product_operation"].includes(context.purpose);
    if (context.stepUp !== true || (!privileged && !dataSubject) || !purposeAllowed) {
      throw new DomainError("AUTH_FORBIDDEN", "B05 deletion requires step-up data-subject or privacy authority");
    }
    const authorizedContext: ActorContext = {
      ...context,
      permissions: [...new Set([...(context.permissions ?? []), "media.lifecycle.manage"])],
    };
    // This local authority decision is complete before the irreversible broker
    // side effect. The broker independently proves ownership/privacy role and
    // derives every lifecycle policy field and target from its signed registry.
    runtime.authorize(authorizedContext, "media.lifecycle.manage", { tenantId: context.tenantId, sensitive: true });
    const mediaDeletion = await requireUploads(ports).deleteAsset(context, {
      assetId,
      reason,
      idempotencyKey,
    });
    return {
      input: {
        assetId,
        classification: mediaDeletion.classification,
        retentionDays: mediaDeletion.retentionDays,
        encrypted: true,
        deletionTargets: mediaDeletion.deletionTargets,
      },
      mediaDeletion,
      authorizedContext,
      portalAuthorization: "b05-data-erasure",
    };
  }
  if (batchId !== "B07") return { input };
  const request = object(input, "B07 request body");
  assertExactKeys(request, ["assetId", "participantIds"], "B07 request body");
  if (!Array.isArray(request.participantIds) || request.participantIds.length < 1 || request.participantIds.length > 20 ||
      request.participantIds.some((value) => typeof value !== "string") || new Set(request.participantIds).size !== request.participantIds.length) {
    throw new DomainError("VALIDATION_FAILED", "B07 participantIds must be a bounded unique identifier list");
  }
  const participantIds = request.participantIds.map((value) => requestIdentifier(value, "participantId"));
  const assetId = requestIdentifier(request.assetId, "assetId");
  await runtime.assertConsent(context, {
    participantIds,
    purpose: "age_transformation",
    scope: { resource: `media.asset:${assetId}`, action: "ingest" },
  });
  const intake = await requireUploads(ports).resolveIntake(context, {
    assetId,
    participantIds,
    idempotencyKey,
  });
  return {
    input: {
      assetId: intake.assetId,
      participantIds,
      mimeType: intake.mimeType,
      byteLength: intake.byteLength,
      faceCount: intake.faceCount,
      magicVerified: true,
      malwareState: "clean",
      metadataStripped: intake.metadataStripped,
      sourceSha256: intake.sourceSha256,
      canonicalSha256: intake.canonicalSha256,
      lineageSha256: intake.lineageSha256,
      scanEvidenceId: intake.scanEvidenceId,
      scannerProvider: intake.scannerProvider,
      scanAssessedAt: intake.scanAssessedAt,
      participantMappingEvidenceId: intake.participantMappingEvidenceId,
      participantMappingProvider: intake.participantMappingProvider,
      participantMappingAssessedAt: intake.participantMappingAssessedAt,
      participantMapComplete: intake.participantMapComplete,
      qualityDimensions: { width: intake.width, height: intake.height },
    },
  };
}

function controlledMediaDeletionResult(data: unknown, deletion: MediaDeletionProjection): Record<string, unknown> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", "B05 returned an invalid controlled result");
  }
  return { ...(data as Record<string, unknown>), mediaDeletion: deletion };
}

function requireBearerToken(request: IncomingMessage): string {
  const match = /^Bearer ([^\s]+)$/i.exec(headerValue(request, "authorization") ?? "");
  if (match?.[1] === undefined || match[1].length < 20 || match[1].length > 8_192) {
    throw new DomainError("AUTH_UNAUTHENTICATED", "A valid bearer token is required");
  }
  return match[1];
}

function requestString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DomainError("VALIDATION_FAILED", `${label} is invalid`);
  }
  return value;
}

function requestIdentifier(value: unknown, label: string): string {
  const result = requestString(value, label, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(result)) {
    throw new DomainError("VALIDATION_FAILED", `${label} is invalid`);
  }
  return result;
}

function requestInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function requestSha256Digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be a lowercase sha256 digest`);
  }
  return value;
}

function requestTemplateIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length ||
      value.some((entry) => typeof entry !== "string" || !/^[A-Za-z0-9_-]{20,80}$/.test(entry))) {
    throw new DomainError("VALIDATION_FAILED", "acceptedTemplateIds must be a bounded unique WeChat template list");
  }
  return [...value] as string[];
}

function mobileTelemetryEvent(value: unknown): {
  readonly eventId: string;
  readonly name: string;
  readonly occurredAt: string;
  readonly fields: Record<string, string | number | boolean>;
} {
  const body = object(value, "mobile telemetry body");
  assertExactKeys(body, ["eventId", "name", "occurredAt", "fields"], "mobile telemetry body");
  const eventId = requestIdentifier(body.eventId, "eventId");
  const name = requestString(body.name, "name", 128);
  if (!/^[A-Za-z][A-Za-z0-9._:-]{1,127}$/.test(name)) throw new DomainError("VALIDATION_FAILED", "mobile telemetry name is invalid");
  const occurredAtRaw = requestString(body.occurredAt, "occurredAt", 64);
  const occurredAtMs = Date.parse(occurredAtRaw);
  const now = Date.now();
  if (!Number.isFinite(occurredAtMs) || occurredAtMs > now + 60_000 || occurredAtMs < now - 7 * 24 * 60 * 60_000) {
    throw new DomainError("VALIDATION_FAILED", "mobile telemetry time is outside the accepted window");
  }
  const fields = object(body.fields, "mobile telemetry fields");
  const allowed = new Set(["platform", "appVersion", "networkType", "status", "errorCode", "durationMs", "bytes", "attempt", "screen", "operation"]);
  if (Object.keys(fields).length < 1 || Object.keys(fields).length > allowed.size || Object.keys(fields).some((field) => !allowed.has(field))) {
    throw new DomainError("VALIDATION_FAILED", "mobile telemetry fields are not allowlisted");
  }
  const normalized: Record<string, string | number | boolean> = {};
  for (const [field, raw] of Object.entries(fields)) {
    if ((typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") ||
        typeof raw === "string" && (raw.length > 128 || /https?:|file:|content:|bearer|token/i.test(raw)) ||
        typeof raw === "number" && !Number.isFinite(raw)) {
      throw new DomainError("VALIDATION_FAILED", `mobile telemetry field ${field} is unsafe`);
    }
    normalized[field] = raw;
  }
  return { eventId, name, occurredAt: new Date(occurredAtMs).toISOString(), fields: normalized };
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const fields = Object.keys(value);
  if (fields.length !== expected.length || fields.some((field) => !expected.includes(field))) {
    throw new DomainError("VALIDATION_FAILED", `${label} contains unsupported or missing fields`);
  }
}

function assertEmptyObject(value: unknown, label: string): void {
  const body = object(value, label);
  if (Object.keys(body).length !== 0) throw new DomainError("VALIDATION_FAILED", `${label} must be empty`);
}

function requireContentRange(request: IncomingMessage): { readonly start: number; readonly end: number; readonly total: number } {
  const match = /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(headerValue(request, "content-range") ?? "");
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new DomainError("VALIDATION_FAILED", "A valid Content-Range header is required");
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start > end || end >= total || total > 25 * 1024 * 1024) {
    throw new DomainError("VALIDATION_FAILED", "Content-Range is outside upload bounds");
  }
  return { start, end, total };
}

function requireChunkSha256(request: IncomingMessage): string {
  const value = headerValue(request, "x-chunk-sha256") ?? "";
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new DomainError("VALIDATION_FAILED", "A lowercase SHA-256 X-Chunk-Sha256 header is required");
  }
  return value;
}

function requireIdempotencyKey(request: IncomingMessage): string {
  const value = headerValue(request, "idempotency-key")?.trim() ?? "";
  if (value.length === 0 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DomainError("VALIDATION_FAILED", "A valid Idempotency-Key header is required");
  }
  return value;
}

function operationContext(context: ActorContext, operation: string, idempotencyKeyValue: string): ActorContext {
  const operationId = createHash("sha256")
    .update(`${context.tenantId}\n${context.actorId}\n${operation}\n${idempotencyKeyValue}`, "utf8")
    .digest("hex");
  return { ...context, operationId };
}

function authorizeMetrics(request: IncomingMessage, tokenSha256: string | undefined): void {
  if (tokenSha256 === undefined) return;
  const match = /^Bearer ([^\s]+)$/i.exec(headerValue(request, "authorization") ?? "");
  if (match?.[1] === undefined) {
    throw new DomainError("AUTH_UNAUTHENTICATED", "A metrics bearer token is required");
  }
  const presented = Buffer.from(createHash("sha256").update(match[1], "utf8").digest("hex"), "ascii");
  const expected = Buffer.from(tokenSha256, "ascii");
  if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) {
    throw new DomainError("AUTH_UNAUTHENTICATED", "Metrics bearer token is invalid");
  }
}

function renderMetrics(metrics: ApiMetrics): string {
  const lines = [
    "# HELP ltm_api_uptime_seconds Process uptime for this API server.",
    "# TYPE ltm_api_uptime_seconds gauge",
    `ltm_api_uptime_seconds ${Math.max(0, (Date.now() - metrics.startedAtMs) / 1_000).toFixed(3)}`,
    "# HELP ltm_api_requests_total HTTP requests received.",
    "# TYPE ltm_api_requests_total counter",
    `ltm_api_requests_total ${metrics.requestsTotal}`,
    "# HELP ltm_api_active_requests Requests currently being handled.",
    "# TYPE ltm_api_active_requests gauge",
    `ltm_api_active_requests ${metrics.activeRequests}`,
    "# HELP ltm_api_request_duration_milliseconds_total Aggregate request duration.",
    "# TYPE ltm_api_request_duration_milliseconds_total counter",
    `ltm_api_request_duration_milliseconds_total ${metrics.durationTotalMs.toFixed(3)}`,
    "# HELP ltm_api_responses_total HTTP responses by status code.",
    "# TYPE ltm_api_responses_total counter",
  ];
  for (const [status, count] of [...metrics.responsesByStatus].sort(([left], [right]) => left - right)) {
    lines.push(`ltm_api_responses_total{status="${status}"} ${count}`);
  }
  return `${lines.join("\n")}\n`;
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const bytes = await readBody(request, limit, "application/json");
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new DomainError("VALIDATION_FAILED", "Request body contains invalid JSON", { httpStatus: 400 });
  }
}

async function readBody(request: IncomingMessage, limit: number, requiredContentType: string): Promise<Buffer> {
  const contentType = headerValue(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== requiredContentType) {
    throw new DomainError("VALIDATION_FAILED", `Content-Type must be ${requiredContentType}`, { httpStatus: 415 });
  }
  const contentLength = headerValue(request, "content-length");
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new DomainError("VALIDATION_FAILED", "Content-Length is invalid", { httpStatus: 400 });
    }
    if (parsed > limit) {
      request.resume();
      throw new DomainError("VALIDATION_FAILED", "Request body exceeds the configured limit", { httpStatus: 413 });
    }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > limit) {
      throw new DomainError("VALIDATION_FAILED", "Request body exceeds the configured limit", { httpStatus: 413 });
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    throw new DomainError("VALIDATION_FAILED", "A JSON request body is required", { httpStatus: 400 });
  }
  return Buffer.concat(chunks);
}

function requestIdFor(request: IncomingMessage): string {
  const candidate = headerValue(request, "x-request-id")?.trim();
  return candidate !== undefined && REQUEST_ID.test(candidate) ? candidate : randomUUID();
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function applySecurityHeaders(response: ServerResponse, browserOidc?: BrowserOidcPublicConfiguration): void {
  const tokenOrigin = browserOidc === undefined ? "" : ` ${new URL(browserOidc.tokenEndpoint).origin}`;
  response.setHeader("content-security-policy", `default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'${tokenOrigin}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`);
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", body.byteLength);
  response.end(body);
}

function sendText(response: ServerResponse, status: number, value: string, contentType: string): void {
  const body = Buffer.from(value, "utf8");
  response.statusCode = status;
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", contentType);
  response.setHeader("content-length", body.byteLength);
  response.end(body);
}

function writeError(
  response: ServerResponse,
  error: unknown,
  requestId: string,
  logger: (entry: ApiLogEntry) => void,
  method: string,
  path: string,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (isDomainError(error)) {
    if (error.httpStatus === 401) response.setHeader("www-authenticate", "Bearer");
    sendJson(response, error.httpStatus, {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      },
      requestId,
    });
    logger({ level: "info", event: "request.rejected", requestId, method, path, status: error.httpStatus });
    return;
  }
  logger({
    level: "error",
    event: "request.failed",
    requestId,
    method,
    path,
    status: 500,
    error: error instanceof Error ? error.name : "UnknownError",
  });
  sendJson(response, 500, {
    error: { code: "INTERNAL_ERROR", message: "Internal server error", retryable: false, details: {} },
    requestId,
  });
}

function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  directory: string,
  path: string,
): boolean {
  if (!existsSync(directory)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new DomainError("VALIDATION_FAILED", "Request path is invalid", { httpStatus: 400 });
  }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment.startsWith(".") || segment === ".." || segment.includes("\0"))) {
    throw new DomainError("AUTH_FORBIDDEN", "Static path is not allowed");
  }
  const base = realpathSync(directory);
  const requested = resolve(base, `.${decoded === "/" ? "/index.html" : decoded}`);
  let candidate = requested;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    if (request.headers.accept?.includes("text/html") && extname(decoded) === "") {
      candidate = resolve(base, "index.html");
    } else {
      return false;
    }
  }
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return false;
  const realCandidate = realpathSync(candidate);
  if (realCandidate !== base && !realCandidate.startsWith(`${base}${sep}`)) {
    throw new DomainError("AUTH_FORBIDDEN", "Static path escapes the configured directory");
  }
  const body = readFileSync(realCandidate);
  response.statusCode = 200;
  response.setHeader("content-type", MIME_TYPES[extname(realCandidate).toLowerCase()] ?? "application/octet-stream");
  response.setHeader("content-length", body.byteLength);
  response.setHeader(
    "cache-control",
    isContentHashedAsset(realCandidate) ? "public, max-age=31536000, immutable" : "no-cache",
  );
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}

function isContentHashedAsset(path: string): boolean {
  const filename = path.split(sep).at(-1) ?? "";
  return /-[a-f0-9]{8,64}\.[A-Za-z0-9]+$/i.test(filename) || /\.[a-f0-9]{8,64}\.[A-Za-z0-9]+$/i.test(filename);
}

function photoPurchases(options: ApiServerOptions): PhotoPurchaseService {
  const platform = options.clientIntegrations?.wechatPlatform;
  const payments = platform?.preparePhotoCheckout ? {
    preparePhotoCheckout: platform.preparePhotoCheckout.bind(platform), getPayment: platform.getPayment.bind(platform),
  } : undefined;
  return new PhotoPurchaseService(options.runtime, options.capabilityRegistry, options.timelineArtifacts, payments);
}

function requireOperatorGeneration(actor: ActorContext): void {
  if (!actor.roles.some(role => ["platform_admin", "service_account", "studio_operator"].includes(role))) {
    throw new DomainError("AUTH_FORBIDDEN", "consumer generation requires a server-verified paid photo purchase");
  }
}
