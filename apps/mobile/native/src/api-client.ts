import type { RuntimeConfig } from "./runtime";

export interface AccessTokenProvider {
  accessToken(): Promise<string>;
  invalidate(): Promise<void>;
}

export class MobileApiClient {
  constructor(private readonly config: RuntimeConfig, private readonly tokens: AccessTokenProvider) {}

  async request<T>(path: string, input: {
    readonly method?: "GET" | "POST" | "DELETE";
    readonly body?: unknown;
    readonly binaryBody?: Uint8Array;
    readonly contentRange?: string;
    readonly contentSha256?: string;
    readonly purpose: "age_transformation" | "sharing" | "privacy_rights" | "commerce" | "product_operation";
    readonly idempotencyKey?: string;
    readonly timeoutMs?: number;
  }): Promise<T> {
    if (!/^\/v1\/[A-Za-z0-9/_?&=.%:-]{1,400}$/.test(path) || path.includes("..") || /%2f|%5c/i.test(path)) {
      throw new Error("API_PATH_INVALID");
    }
    const method = input.method ?? "POST";
    if (input.idempotencyKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,200}$/.test(input.idempotencyKey)) {
      throw new Error("IDEMPOTENCY_KEY_INVALID");
    }
    if (method !== "GET" && path !== "/v1/queries" && input.idempotencyKey === undefined) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    if (input.body !== undefined && input.binaryBody !== undefined) throw new Error("API_BODY_AMBIGUOUS");
    if (method === "GET" && (input.body !== undefined || input.binaryBody !== undefined)) throw new Error("API_GET_BODY_FORBIDDEN");
    if (input.binaryBody !== undefined) validateBinaryUpload(input.binaryBody, input.contentRange, input.contentSha256);
    else if (input.contentRange !== undefined || input.contentSha256 !== undefined) throw new Error("API_BINARY_HEADERS_FORBIDDEN");
    const token = await this.tokens.accessToken();
    const controller = new AbortController();
    const timeoutMs = input.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error("API_TIMEOUT_INVALID");
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.config.apiOrigin}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "X-Purpose": input.purpose,
          ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(input.binaryBody === undefined ? {} : {
            "Content-Type": "application/octet-stream",
            "Content-Range": input.contentRange!,
            "X-Chunk-Sha256": input.contentSha256!,
          }),
          ...(input.idempotencyKey === undefined ? {} : { "Idempotency-Key": input.idempotencyKey }),
        },
        ...(input.body !== undefined
          ? { body: JSON.stringify(input.body) }
          : input.binaryBody === undefined
            ? {}
            : { body: copiedBuffer(input.binaryBody) }),
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
      });
      if (response.status === 401) await this.tokens.invalidate();
      if (!response.ok) {
        const code = await closedErrorCode(response);
        throw new Error(code);
      }
      if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("API_CONTENT_TYPE_INVALID");
      return await response.json() as T;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw new Error("API_TIMEOUT", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async query<T>(operation: "record.get" | "record.list", input: Readonly<Record<string, unknown>>, purpose: "age_transformation" | "sharing" | "privacy_rights" | "commerce" | "product_operation"): Promise<T> {
    return this.requestData<T>("/v1/queries", { purpose, body: { query: operation, input } });
  }

  async requestData<T>(path: string, input: Parameters<MobileApiClient["request"]>[1]): Promise<T> {
    const envelope = await this.request<unknown>(path, input);
    if (!plain(envelope) || Object.keys(envelope).sort().join(",") !== "data,meta" || !plain(envelope.meta) ||
        typeof envelope.meta.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(envelope.meta.requestId)) {
      throw new Error("API_ENVELOPE_INVALID");
    }
    return envelope.data as T;
  }
}

function validateBinaryUpload(bytes: Uint8Array, range: string | undefined, checksum: string | undefined): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 5 * 1024 * 1024) throw new Error("API_BINARY_BODY_INVALID");
  const match = /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(range ?? "");
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) throw new Error("API_CONTENT_RANGE_INVALID");
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || end - start + 1 !== bytes.byteLength || start > end || end >= total || total > 25 * 1024 * 1024) {
    throw new Error("API_CONTENT_RANGE_INVALID");
  }
  if (checksum === undefined || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error("API_CHUNK_SHA256_INVALID");
}

function copiedBuffer(bytes: Uint8Array): ArrayBuffer {
  const result = new Uint8Array(bytes.byteLength);
  result.set(bytes);
  return result.buffer;
}

async function closedErrorCode(response: Response): Promise<string> {
  try {
    const value: unknown = await response.json();
    if (plain(value) && plain(value.error) && typeof value.error.code === "string" && /^[A-Z][A-Z0-9_]{1,127}$/.test(value.error.code)) {
      return value.error.code;
    }
  } catch { /* fail to the closed HTTP status */ }
  return `HTTP_${response.status}`;
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
