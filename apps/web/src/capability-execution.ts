export const MAX_CAPABILITY_INPUT_BYTES = 64 * 1_024;
export const MAX_API_RESPONSE_BYTES = 1 * 1_024 * 1_024;

export interface CapabilityExecutionResponse {
  readonly data: unknown;
  readonly meta: {
    readonly requestId: string;
    readonly batchId: string;
  };
}

export function parseCapabilityInput(serialized: string): Record<string, unknown> {
  if (new TextEncoder().encode(serialized).byteLength > MAX_CAPABILITY_INPUT_BYTES) {
    throw new Error("Capability input exceeds the 64 KiB browser limit");
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("Capability input must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Capability input must be a JSON object");
  }
  assertSafeJson(value, 0, { nodes: 0 });
  return value as Record<string, unknown>;
}

export function validateCapabilityExecutionResponse(batchId: string, value: unknown): CapabilityExecutionResponse {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  const envelope = value as Record<string, unknown>;
  if (!hasExactKeys(envelope, ["data", "meta"])) invalidResponse();
  if (envelope.meta === null || typeof envelope.meta !== "object" || Array.isArray(envelope.meta)) invalidResponse();
  const meta = envelope.meta as Record<string, unknown>;
  if (!hasExactKeys(meta, ["requestId", "batchId"]) || meta.batchId !== batchId ||
      typeof meta.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(meta.requestId)) {
    invalidResponse();
  }
  assertSafeJson(envelope.data, 0, { nodes: 0 });
  return value as CapabilityExecutionResponse;
}

export class StableCapabilityIdempotency {
  readonly #randomUuid: () => string;
  #fingerprint: string | undefined;
  #key: string | undefined;

  constructor(randomUuid: () => string = () => crypto.randomUUID()) {
    this.#randomUuid = randomUuid;
  }

  forDraft(batchId: string, serialized: string): string {
    if (!/^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(batchId)) throw new Error("Capability batch is invalid");
    const fingerprint = `${batchId}\n${serialized}`;
    if (fingerprint !== this.#fingerprint) {
      const uuid = this.#randomUuid();
      if (!/^[a-f0-9-]{36}$/i.test(uuid)) throw new Error("Browser random UUID source is invalid");
      this.#fingerprint = fingerprint;
      this.#key = `web:${batchId}:${uuid}`;
    }
    return this.#key ?? (() => { throw new Error("Capability idempotency state is unavailable"); })();
  }

  reset(): void {
    this.#fingerprint = undefined;
    this.#key = undefined;
  }
}

export async function readBoundedJsonResponse(
  response: Response,
  maximumBytes = MAX_API_RESPONSE_BYTES,
): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("API response is not JSON");
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const size = Number(declaredLength);
    if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) throw new Error("API response exceeds the browser limit");
  }
  if (response.body === null) throw new Error("API response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("response limit exceeded");
        throw new Error("API response exceeds the browser limit");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("API response is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("API response contains invalid JSON");
  }
}

function assertSafeJson(value: unknown, depth: number, state: { nodes: number }): void {
  state.nodes += 1;
  if (state.nodes > 10_000 || depth > 32) throw new Error("JSON structure exceeds browser safety limits");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON numbers must be finite");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertSafeJson(item, depth + 1, state);
    return;
  }
  if (typeof value !== "object") throw new Error("JSON value is invalid");
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("JSON object contains a forbidden key");
    assertSafeJson(item, depth + 1, state);
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function invalidResponse(): never {
  throw new Error("API returned an invalid capability execution envelope");
}
