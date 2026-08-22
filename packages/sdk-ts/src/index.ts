export interface ClientSession {
  accessToken: string;
  purpose: string;
}

export interface CapabilitySummary {
  batchId: string;
  skill: string;
  operation: string;
  requirements: readonly string[];
  requiresExternalEvidence: boolean;
}

export interface DispatchMeta {
  readonly requestId: string;
  readonly batchId?: string;
  readonly command?: string;
  readonly query?: string;
}

export interface DispatchEnvelope<T> {
  readonly data: T;
  readonly meta: DispatchMeta;
}

export interface ClientOptions {
  baseUrl: string;
  session: ClientSession;
  timeoutMs?: number;
  maxRetries?: number;
  maxResponseBytes?: number;
  maxRetryDelayMs?: number;
  fetch?: typeof fetch;
}

interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details: Record<string, unknown>;
  };
  readonly requestId: string;
}

const BATCH_ID = /^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RETRY_DELAY_MS = 5_000;
const MAX_TIMEOUT_MS = 120_000;

export class LifeTimeMachineApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly retryable = false,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "LifeTimeMachineApiError";
  }
}

export class LifeTimeMachineTransportError extends Error {
  constructor(readonly code: "NETWORK_ERROR" | "REQUEST_TIMEOUT", message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "LifeTimeMachineTransportError";
  }
}

export class LifeTimeMachineClient {
  readonly #baseUrl: string;
  readonly #session: Readonly<ClientSession>;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #maxResponseBytes: number;
  readonly #maxRetryDelayMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    this.#baseUrl = validateBaseUrl(options.baseUrl);
    this.#session = Object.freeze({ ...options.session });
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0 || this.#timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error("timeoutMs must be an integer from 1 through 120000");
    }
    if (!Number.isInteger(this.#maxRetries) || this.#maxRetries < 0 || this.#maxRetries > 5) {
      throw new Error("maxRetries must be an integer from 0 through 5");
    }
    if (!Number.isInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1 || this.#maxResponseBytes > MAX_RESPONSE_BYTES) {
      throw new Error("maxResponseBytes must be an integer from 1 through 16777216");
    }
    if (!Number.isInteger(this.#maxRetryDelayMs) || this.#maxRetryDelayMs < 0 || this.#maxRetryDelayMs > 60_000) {
      throw new Error("maxRetryDelayMs must be an integer from 0 through 60000");
    }
    if (typeof this.#fetch !== "function") throw new Error("a Fetch implementation is required");
    validateHeaderValue(this.#session.accessToken, "bearer access token", 8_192, true, false);
    validateHeaderValue(this.#session.purpose, "request purpose", 120, false, true);
  }

  health(): Promise<Record<string, unknown>> {
    return this.#requestObject("/health/ready", { method: "GET" }, true, [503]);
  }

  async listCapabilities(): Promise<readonly CapabilitySummary[]> {
    const response = await this.#requestObject("/v1/capabilities", { method: "GET" }, true);
    if (!Array.isArray(response.capabilities)) {
      throw invalidResponse("capability response is missing capabilities");
    }
    return response.capabilities as unknown as readonly CapabilitySummary[];
  }

  async execute<T>(batchId: string, input: Record<string, unknown>, idempotencyKey: string): Promise<T> {
    return (await this.executeEnvelope<T>(batchId, input, idempotencyKey)).data;
  }

  executeEnvelope<T>(batchId: string, input: Record<string, unknown>, idempotencyKey: string): Promise<DispatchEnvelope<T>> {
    if (!BATCH_ID.test(batchId)) throw new Error("batchId must be B00 through B127");
    validateIdempotencyKey(idempotencyKey);
    return this.#dispatch<T>(`/v1/capabilities/${batchId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    }, { batchId }, true);
  }

  async command<T>(command: string, input: Record<string, unknown>, idempotencyKey: string): Promise<T> {
    return (await this.commandEnvelope<T>(command, input, idempotencyKey)).data;
  }

  commandEnvelope<T>(command: string, input: Record<string, unknown>, idempotencyKey: string): Promise<DispatchEnvelope<T>> {
    validateOperation(command, "command");
    validateIdempotencyKey(idempotencyKey);
    return this.#dispatch<T>("/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ command, input }),
    }, { command }, true);
  }

  async query<T>(query: string, input: Record<string, unknown> = {}): Promise<T> {
    return (await this.queryEnvelope<T>(query, input)).data;
  }

  queryEnvelope<T>(query: string, input: Record<string, unknown> = {}): Promise<DispatchEnvelope<T>> {
    validateOperation(query, "query");
    return this.#dispatch<T>("/v1/queries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, input }),
    }, { query }, true);
  }

  async #dispatch<T>(
    path: string,
    init: RequestInit,
    expected: Readonly<{ batchId?: string; command?: string; query?: string }>,
    retrySafe: boolean,
  ): Promise<DispatchEnvelope<T>> {
    const value = await this.#requestObject(path, init, retrySafe);
    if (!("data" in value) || !isObject(value.meta)) {
      throw invalidResponse("dispatch response must contain data and meta");
    }
    const requestId = requiredString(value.meta.requestId, "dispatch meta.requestId");
    for (const field of ["batchId", "command", "query"] as const) {
      const expectedValue = expected[field];
      if (expectedValue !== undefined && value.meta[field] !== expectedValue) {
        throw invalidResponse(`dispatch meta.${field} does not match the request`, requestId);
      }
    }
    return { data: value.data as T, meta: value.meta as unknown as DispatchMeta };
  }

  async #requestObject(
    path: string,
    init: RequestInit,
    retrySafe: boolean,
    acceptedStatuses: readonly number[] = [],
  ): Promise<Record<string, unknown>> {
    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
      try {
        const headers = new Headers(init.headers);
        headers.set("accept", "application/json");
        headers.set("x-purpose", this.#session.purpose);
        headers.set("x-sdk-version", "typescript/1.0.0");
        headers.set("authorization", `Bearer ${this.#session.accessToken}`);
        const response = await this.#fetch(`${this.#baseUrl}${path}`, {
          ...init,
          headers,
          redirect: "error",
          signal: controller.signal,
        });
        const raw = await readBoundedBody(response, this.#maxResponseBytes);
        const value = parseJsonObject(raw);
        const headerRequestId = response.headers.get("x-request-id") ?? undefined;
        if (response.ok || acceptedStatuses.includes(response.status)) return value;
        const error = parseErrorEnvelope(value, headerRequestId);
        if (retrySafe && attempt < this.#maxRetries && isRetryableStatus(response.status) && error.error.retryable) {
          await delay(retryDelayMs(response.headers.get("retry-after"), attempt, this.#maxRetryDelayMs));
          attempt += 1;
          continue;
        }
        throw new LifeTimeMachineApiError(
          response.status,
          error.error.code,
          error.error.message,
          error.requestId,
          error.error.retryable,
          error.error.details,
        );
      } catch (error) {
        if (error instanceof LifeTimeMachineApiError) throw error;
        if (error instanceof LifeTimeMachineTransportError) {
          if (retrySafe && attempt < this.#maxRetries) {
            await delay(retryDelayMs(null, attempt, this.#maxRetryDelayMs));
            attempt += 1;
            continue;
          }
          throw error;
        }
        const timeoutError = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
        const transportError = new LifeTimeMachineTransportError(
          timeoutError ? "REQUEST_TIMEOUT" : "NETWORK_ERROR",
          timeoutError ? "request timed out" : "network request failed",
          error,
        );
        if (retrySafe && attempt < this.#maxRetries) {
          await delay(retryDelayMs(null, attempt, this.#maxRetryDelayMs));
          attempt += 1;
          continue;
        }
        throw transportError;
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}

function validateBaseUrl(value: string): string {
  if (typeof value !== "string" || value !== value.trim() || value.includes("?") || value.includes("#")) {
    throw new Error("baseUrl must not contain whitespace, a query, or a fragment");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("baseUrl must be an absolute HTTP or HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("baseUrl must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("baseUrl must not contain credentials");
  if (url.search || url.hash) throw new Error("baseUrl must not contain a query or fragment");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("baseUrl must identify an origin without a path");
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error("unencrypted HTTP is permitted only for loopback development endpoints");
  }
  return url.origin;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) && parts[0] === "127";
}

function validateHeaderValue(
  value: string,
  label: string,
  maxLength: number,
  forbidWhitespace: boolean,
  requireTrimmed: boolean,
): void {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)
    || (forbidWhitespace && /\s/.test(value))
    || (requireTrimmed && value !== value.trim())
  ) {
    throw new Error(`a valid ${label} is required`);
  }
}

function validateIdempotencyKey(value: string): void {
  validateHeaderValue(value, "idempotency key", 200, false, true);
}

function validateOperation(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 160 || !/^[a-z][a-z0-9.-]*$/.test(value)) {
    throw new Error(`${label} must be a bounded operation name`);
  }
}

async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw invalidResponse("response body exceeds maxResponseBytes");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw invalidResponse("response body exceeds maxResponseBytes");
    }
    chunks.push(part.value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch (error) {
    throw invalidResponse("server returned malformed UTF-8", undefined, error);
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw invalidResponse("server returned malformed JSON", undefined, error);
  }
  if (!isObject(value)) throw invalidResponse("server returned a non-object response");
  return value;
}

function parseErrorEnvelope(value: Record<string, unknown>, headerRequestId?: string): ErrorEnvelope {
  if (!isObject(value.error)) throw invalidResponse("error response is missing error");
  const requestId = requiredString(value.requestId, "error requestId");
  if (headerRequestId !== undefined && headerRequestId !== requestId) {
    throw invalidResponse("response request identifiers do not match", requestId);
  }
  if (typeof value.error.retryable !== "boolean" || !isObject(value.error.details)) {
    throw invalidResponse("error response has invalid retryable or details fields", requestId);
  }
  return {
    error: {
      code: requiredString(value.error.code, "error code"),
      message: requiredString(value.error.message, "error message"),
      retryable: value.error.retryable,
      details: value.error.details,
    },
    requestId,
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw invalidResponse(`${label} must be a non-empty string`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidResponse(message: string, requestId?: string, cause?: unknown): LifeTimeMachineApiError {
  const error = new LifeTimeMachineApiError(502, "INVALID_RESPONSE", message, requestId, false);
  if (cause !== undefined) error.cause = cause;
  return error;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayMs(retryAfter: string | null, attempt: number, maximum: number): number {
  let requested = 25 * (2 ** attempt);
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) requested = seconds * 1_000;
    else {
      const timestamp = Date.parse(retryAfter);
      if (Number.isFinite(timestamp)) requested = Math.max(0, timestamp - Date.now());
    }
  }
  return Math.min(maximum, Math.max(0, requested));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
