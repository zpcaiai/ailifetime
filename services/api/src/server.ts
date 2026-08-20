import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityRegistry } from "@ltm/capabilities";
import { DomainError, isDomainError, type ActorContext, type LifeTimeMachineRuntime } from "@ltm/core";
import type { RequestAuthenticator } from "./auth.js";
import {
  COMMANDS,
  QUERIES,
  capabilityCatalog,
  dispatchCapability,
  dispatchCommand,
  dispatchQuery,
  object,
  parseDispatchEnvelope,
} from "./dispatch.js";

export interface ApiLogEntry {
  readonly level: "info" | "error";
  readonly event: string;
  readonly requestId: string;
  readonly method?: string;
  readonly path?: string;
  readonly status?: number;
  readonly error?: string;
}

export interface ApiServerOptions {
  readonly runtime: LifeTimeMachineRuntime;
  readonly authenticator: RequestAuthenticator;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly bodyLimitBytes?: number;
  readonly staticDirectory?: string | null;
  readonly allowSandboxStepUpHeader?: boolean;
  readonly appEnvironment?: string;
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
] as const;

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
  const bodyLimit = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT;
  if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1_024 || bodyLimit > 10 * 1024 * 1024) {
    throw new DomainError("VALIDATION_FAILED", "bodyLimitBytes must be between 1024 and 10485760");
  }
  if (options.allowSandboxStepUpHeader === true && options.appEnvironment?.toLowerCase() === "production") {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "Sandbox step-up headers are forbidden in production");
  }
  const staticDirectory = options.staticDirectory === undefined ? DEFAULT_STATIC_DIRECTORY : options.staticDirectory;
  const logger = options.logger ?? (() => undefined);

  const server = createServer((request, response) => {
    void handleRequest(options, request, response, bodyLimit, staticDirectory, logger);
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
): Promise<void> {
  const requestId = requestIdFor(request);
  response.setHeader("x-request-id", requestId);
  applySecurityHeaders(response);
  const method = request.method ?? "GET";
  let path = "/";
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
      const readiness = options.runtime.readiness();
      sendJson(response, readiness.ready ? 200 : 503, { ...readiness, requestId });
      return;
    }

    const catalog = capabilityCatalog(options.capabilityRegistry);
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
      const context = await authenticate(options, request, requestId);
      const envelope = parseDispatchEnvelope(await readJsonBody(request, bodyLimit), "command");
      const key = requireIdempotencyKey(request);
      const data = dispatchCommand(options.runtime, context, envelope.operation, envelope.input, key);
      sendJson(response, 200, { data, meta: { requestId, command: envelope.operation } });
      return;
    }
    if (method === "POST" && path === "/v1/queries") {
      const context = await authenticate(options, request, requestId);
      const envelope = parseDispatchEnvelope(await readJsonBody(request, bodyLimit), "query");
      const data = dispatchQuery(options.runtime, context, envelope.operation, envelope.input);
      sendJson(response, 200, { data, meta: { requestId, query: envelope.operation } });
      return;
    }
    if (method === "POST" && (path === "/v1/capabilities" || capabilityMatch?.[1] !== undefined)) {
      const context = await authenticate(options, request, requestId);
      const key = requireIdempotencyKey(request);
      const body = object(await readJsonBody(request, bodyLimit), "request body");
      const batchId = capabilityMatch?.[1] ?? body.batchId;
      const input = body.input ?? (capabilityMatch?.[1] === undefined ? undefined : body);
      const data = await dispatchCapability(options.runtime, options.capabilityRegistry, context, batchId, input, key);
      sendJson(response, 200, { data, meta: { requestId, batchId } });
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

function requireIdempotencyKey(request: IncomingMessage): string {
  const value = headerValue(request, "idempotency-key")?.trim() ?? "";
  if (value.length === 0 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DomainError("VALIDATION_FAILED", "A valid Idempotency-Key header is required");
  }
  return value;
}

async function readJsonBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const contentType = headerValue(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new DomainError("VALIDATION_FAILED", "Content-Type must be application/json", { httpStatus: 415 });
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new DomainError("VALIDATION_FAILED", "Request body contains invalid JSON", { httpStatus: 400 });
  }
}

function requestIdFor(request: IncomingMessage): string {
  const candidate = headerValue(request, "x-request-id")?.trim();
  return candidate !== undefined && REQUEST_ID.test(candidate) ? candidate : randomUUID();
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.setHeader("referrer-policy", "no-referrer");
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
    error: error instanceof Error ? error.message : "Unknown error",
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
    realCandidate.endsWith("index.html") ? "no-cache" : "public, max-age=3600, immutable",
  );
  response.end(request.method === "HEAD" ? undefined : body);
  return true;
}
