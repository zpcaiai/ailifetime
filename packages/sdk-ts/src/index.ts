export interface ClientSession {
  accessToken: string;
  purpose: string;
}

export interface CapabilitySummary {
  batchId: string;
  skill: string;
  operation: string;
  requirements: readonly string[];
  requiresExternalEvidence?: boolean;
}

export interface ClientOptions {
  baseUrl: string;
  session: ClientSession;
  timeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof fetch;
}

export class LifeTimeMachineApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) {
    super(message);
    this.name = "LifeTimeMachineApiError";
  }
}

export class LifeTimeMachineClient {
  readonly #baseUrl: string;
  readonly #session: ClientSession;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#session = Object.freeze({ ...options.session });
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (!this.#baseUrl.startsWith("http://") && !this.#baseUrl.startsWith("https://")) throw new Error("baseUrl must use HTTP or HTTPS");
    if (!this.#fetch) throw new Error("a Fetch implementation is required");
    if (!this.#session.accessToken || /\s/.test(this.#session.accessToken)) throw new Error("a bearer access token is required");
    if (!this.#session.purpose.trim()) throw new Error("a request purpose is required");
  }

  health(): Promise<Record<string, unknown>> {
    return this.request("/health/ready", { method: "GET" }, true);
  }

  async listCapabilities(): Promise<readonly CapabilitySummary[]> {
    const response = await this.request<{ capabilities: CapabilitySummary[] }>("/v1/capabilities", { method: "GET" }, true);
    return response.capabilities;
  }

  execute<T>(batchId: string, input: Record<string, unknown>, idempotencyKey: string): Promise<T> {
    if (!/^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(batchId)) throw new Error("batchId must be B00 through B127");
    if (!idempotencyKey || idempotencyKey.length > 128) throw new Error("a bounded idempotency key is required");
    return this.request(`/v1/capabilities/${batchId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    }, true);
  }

  private async request<T>(path: string, init: RequestInit, retrySafe: boolean): Promise<T> {
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
        const response = await this.#fetch(`${this.#baseUrl}${path}`, { ...init, headers, signal: controller.signal });
        const requestId = response.headers.get("x-request-id") ?? undefined;
        const value = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
        if (response.ok) return value as T;
        if (retrySafe && attempt < this.#maxRetries && (response.status === 429 || response.status >= 500)) {
          await delay(25 * (2 ** attempt));
          attempt += 1;
          continue;
        }
        throw new LifeTimeMachineApiError(response.status, value?.error?.code ?? "HTTP_ERROR", value?.error?.message ?? response.statusText, requestId);
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
