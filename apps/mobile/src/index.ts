import { MobileApplicationError, MobileHttpApiError } from "./application.js";

export * from "./application.js";

export interface CapabilityExecutor {
  execute<T>(batchId: string, payload: Record<string, unknown>, idempotencyKey: string): Promise<T>;
}

export interface SecureStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface OfflineCommand {
  id: string;
  batchId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
  attempts?: number;
}

export class MobileOfflineQueue {
  readonly #allowedBatches: ReadonlySet<string>;
  readonly #maxAttempts: number;
  readonly #maxTtlMs: number;
  readonly #now: () => Date;
  readonly #authorizationKey: string;
  #authorizationBinding: string | undefined = undefined;

  constructor(
    private readonly storage: SecureStorage,
    private readonly storageKey = "ltm.offline.commands",
    options: {
      readonly allowedBatches?: readonly string[];
      readonly maxAttempts?: number;
      readonly maxTtlMs?: number;
      readonly now?: () => Date;
    } = {},
  ) {
    this.#allowedBatches = new Set(options.allowedBatches ?? ["B64", "B65"]);
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#maxTtlMs = options.maxTtlMs ?? 24 * 60 * 60 * 1_000;
    this.#now = options.now ?? (() => new Date());
    this.#authorizationKey = `${storageKey}.authorization`;
    if (this.#allowedBatches.size === 0 || [...this.#allowedBatches].some((batchId) => !/^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(batchId))) {
      throw new Error("offline capability allowlist is invalid");
    }
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > 10) {
      throw new Error("offline maximum attempts is invalid");
    }
    if (!Number.isSafeInteger(this.#maxTtlMs) || this.#maxTtlMs < 60_000 || this.#maxTtlMs > 7 * 24 * 60 * 60 * 1_000) {
      throw new Error("offline maximum TTL must be from one minute through seven days");
    }
    if (typeof this.#now !== "function") throw new Error("offline clock is invalid");
  }

  /** Binds persisted work to the server-verified tenant and actor before any queue access. */
  async activate(binding: { readonly tenantId: string; readonly actorId: string }): Promise<void> {
    const normalized = JSON.stringify({
      tenantId: boundedIdentifier(binding.tenantId, "tenantId"),
      actorId: boundedIdentifier(binding.actorId, "actorId"),
    });
    const stored = await this.storage.get(this.#authorizationKey);
    if (stored !== normalized) {
      // Legacy, corrupt, or different-account commands are not replayed under the current principal.
      await this.storage.delete(this.storageKey);
      await this.storage.set(this.#authorizationKey, normalized);
    }
    this.#authorizationBinding = normalized;
  }

  async enqueue(command: OfflineCommand): Promise<void> {
    await this.assertAuthorizedBinding();
    const now = validNow(this.#now());
    validateCommand(command, this.#maxTtlMs);
    assertCommandLiveAt(command, now);
    if ((command.attempts ?? 0) !== 0) throw new Error("new offline command attempts must be zero");
    if (!this.#allowedBatches.has(command.batchId)) throw new Error("capability is not permitted in the offline queue");
    assertOfflineSafePayload(command.payload);
    const commands = await this.read();
    if (commands.some((item) => item.id === command.id || item.idempotencyKey === command.idempotencyKey)) return;
    commands.push({ ...structuredClone(command), attempts: command.attempts ?? 0 });
    await this.storage.set(this.storageKey, JSON.stringify(commands));
  }

  async flush(
    client: CapabilityExecutor,
    now = this.#now(),
  ): Promise<{ sent: string[]; retained: string[]; dropped: Array<{ id: string; reason: "expired" | "permanent" | "attempts_exhausted" }> }> {
    await this.assertAuthorizedBinding();
    const nowMs = validNow(now);
    const commands = await this.read();
    const retained: OfflineCommand[] = [];
    const sent: string[] = [];
    const dropped: Array<{ id: string; reason: "expired" | "permanent" | "attempts_exhausted" }> = [];
    for (const command of commands) {
      if (Date.parse(command.createdAt) > nowMs) throw new Error("offline queue contains a future-created command");
      if (Date.parse(command.expiresAt) <= nowMs) {
        dropped.push({ id: command.id, reason: "expired" });
        continue;
      }
      try {
        await client.execute(command.batchId, command.payload, command.idempotencyKey);
        sent.push(command.id);
      } catch (error) {
        const attempts = (command.attempts ?? 0) + 1;
        if (isExplicitlyPermanent(error)) {
          dropped.push({ id: command.id, reason: "permanent" });
        } else if (attempts >= this.#maxAttempts) {
          dropped.push({ id: command.id, reason: "attempts_exhausted" });
        } else {
          retained.push({ ...command, attempts });
        }
      }
    }
    if (retained.length === 0) await this.storage.delete(this.storageKey);
    else await this.storage.set(this.storageKey, JSON.stringify(retained));
    return { sent, retained: retained.map((item) => item.id), dropped };
  }

  async purge(): Promise<void> {
    this.#authorizationBinding = undefined;
    await Promise.all([this.storage.delete(this.storageKey), this.storage.delete(this.#authorizationKey)]);
  }

  private async read(): Promise<OfflineCommand[]> {
    const raw = await this.storage.get(this.storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("offline queue is corrupted");
    return parsed.map((entry) => {
      validateCommand(entry, this.#maxTtlMs);
      assertOfflineSafePayload(entry.payload);
      return entry;
    });
  }

  private async assertAuthorizedBinding(): Promise<void> {
    if (this.#authorizationBinding === undefined) throw new Error("offline queue requires a server-verified authorization binding");
    if (await this.storage.get(this.#authorizationKey) !== this.#authorizationBinding) {
      throw new Error("offline queue authorization binding is missing or changed");
    }
  }
}

export class MobileCapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MobileCapabilityError";
  }
}

export type MobileStorePlatform = "ios" | "android";

export interface NativeStorePurchase {
  readonly platform: MobileStorePlatform;
  readonly productId: string;
  readonly transactionReference: string;
  /** Opaque JWS/purchase token; it is forwarded once and never persisted locally. */
  readonly providerPayload: string;
}

export interface NativeStoreBridge {
  purchase(productId: string): Promise<NativeStorePurchase>;
  restorePurchases(): Promise<readonly NativeStorePurchase[]>;
}

export interface StoreVerificationApi {
  submitPurchase(input: NativeStorePurchase & { readonly idempotencyKey: string }): Promise<{
    readonly verificationId: string;
    readonly state: "verification_pending";
  }>;
  getEntitlementProjection(verificationId: string): Promise<MobileEntitlementProjection>;
}

export interface MobileEntitlementProjection {
  readonly verificationId: string;
  readonly productId: string;
  readonly state: "pending" | "active" | "grace" | "billing_retry" | "expired" | "revoked" | "refunded";
  readonly version: number;
  readonly updatedAt: string;
}

/** Native purchase success never grants an entitlement; only the server projection can. */
export class MobileStorePurchaseCoordinator {
  readonly #products = new Map<string, string>();

  constructor(
    private readonly bridge: NativeStoreBridge,
    private readonly api: StoreVerificationApi,
  ) {}

  async purchase(productIdValue: string, idempotencyKeyValue: string): Promise<{ verificationId: string; state: "verification_pending" }> {
    const productId = boundedIdentifier(productIdValue, "productId");
    const idempotencyKey = boundedIdentifier(idempotencyKeyValue, "idempotencyKey");
    const native = validateNativePurchase(await this.bridge.purchase(productId));
    if (native.productId !== productId) throw new Error("native purchase product binding is invalid");
    const submitted = await this.api.submitPurchase({ ...native, idempotencyKey });
    const verificationId = boundedIdentifier(submitted.verificationId, "verificationId");
    if (submitted.state !== "verification_pending") throw new Error("purchase API returned an unsafe client-final state");
    this.#products.set(verificationId, productId);
    // Do not retain the provider payload or token in application storage.
    return { verificationId, state: "verification_pending" };
  }

  async restore(idempotencyKeyPrefixValue: string): Promise<readonly { verificationId: string; state: "verification_pending" }[]> {
    const prefix = boundedIdentifier(idempotencyKeyPrefixValue, "idempotencyKeyPrefix");
    const purchases = await this.bridge.restorePurchases();
    if (purchases.length > 100) throw new Error("native restore returned too many purchases");
    const seen = new Set<string>();
    const results: Array<{ verificationId: string; state: "verification_pending" }> = [];
    for (const value of purchases) {
      const native = validateNativePurchase(value);
      const deduplicationKey = `${native.platform}:${native.transactionReference}`;
      if (seen.has(deduplicationKey)) continue;
      seen.add(deduplicationKey);
      const idempotencyKey = boundedIdentifier(`${prefix}:${deduplicationKey}`, "restore idempotencyKey");
      const submitted = await this.api.submitPurchase({ ...native, idempotencyKey });
      const verificationId = boundedIdentifier(submitted.verificationId, "verificationId");
      if (submitted.state !== "verification_pending") throw new Error("restore API returned an unsafe client-final state");
      this.#products.set(verificationId, native.productId);
      results.push({ verificationId, state: "verification_pending" });
    }
    return results;
  }

  async refresh(verificationIdValue: string): Promise<MobileEntitlementProjection> {
    const verificationId = boundedIdentifier(verificationIdValue, "verificationId");
    const productId = this.#products.get(verificationId);
    if (productId === undefined) throw new Error("purchase verification is not known to this session");
    const projection = validateEntitlement(await this.api.getEntitlementProjection(verificationId));
    if (projection.verificationId !== verificationId || projection.productId !== productId) {
      throw new Error("entitlement projection does not match the submitted purchase");
    }
    return projection;
  }
}

export function authorizeMobileDeepLink(raw: string, allowedHosts: readonly string[]): { path: string; query: URLSearchParams } {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !allowedHosts.includes(url.hostname)) throw new Error("deep link origin is not allowed");
  const allowedPaths = [/^\/projects\/[A-Za-z0-9_-]+$/, /^\/jobs\/[A-Za-z0-9_-]+$/, /^\/library$/, /^\/consent\/[A-Za-z0-9_-]+$/];
  if (!allowedPaths.some((pattern) => pattern.test(url.pathname))) throw new Error("deep link path is not allowed");
  for (const forbidden of ["token", "role", "tenant", "price", "consent"]) {
    if (url.searchParams.has(forbidden)) throw new Error(`deep link cannot assert ${forbidden}`);
  }
  return { path: url.pathname, query: new URLSearchParams(url.searchParams) };
}

export function preflightMobileCapture(input: { mimeType: string; byteLength: number; width: number; height: number }): { accepted: true; warnings: string[] } {
  if (!new Set(["image/jpeg", "image/png", "image/heic"]).has(input.mimeType)) throw new Error("unsupported capture format");
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength <= 0 || input.byteLength > 25 * 1024 * 1024) throw new Error("capture size is outside allowed bounds");
  if (input.width < 512 || input.height < 512) throw new Error("capture resolution is too low");
  const warnings = input.width < 1024 || input.height < 1024 ? ["higher resolution is recommended"] : [];
  return { accepted: true, warnings };
}

function validateCommand(value: unknown, maxTtlMs: number): asserts value is OfflineCommand {
  if (!isPlainRecord(value)) throw new Error("offline command must be a plain object");
  const allowed = new Set(["id", "batchId", "idempotencyKey", "payload", "createdAt", "expiresAt", "attempts"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("offline command contains an unknown field");
  assertDataProperties(value, "offline command");
  const command = value as Partial<OfflineCommand>;
  if (typeof command.id !== "string" || typeof command.idempotencyKey !== "string" || typeof command.batchId !== "string"
    || !/^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(command.batchId)
    || !isPlainRecord(command.payload) || typeof command.createdAt !== "string" || typeof command.expiresAt !== "string") {
    throw new Error("offline command is incomplete");
  }
  boundedIdentifier(command.id, "offline command id");
  boundedIdentifier(command.idempotencyKey, "offline command idempotencyKey");
  const createdAt = parseOfflineInstant(command.createdAt, "createdAt");
  const expiresAt = parseOfflineInstant(command.expiresAt, "expiresAt");
  if (expiresAt <= createdAt || expiresAt - createdAt > maxTtlMs) throw new Error("offline command TTL is invalid");
  if (command.attempts !== undefined && (!Number.isSafeInteger(command.attempts) || command.attempts < 0 || command.attempts > 10)) {
    throw new Error("offline command attempts are invalid");
  }
}

function assertOfflineSafePayload(payload: Record<string, unknown>): void {
  if (!isPlainRecord(payload)) throw new Error("offline payload must be a plain object");
  const forbidden = /(?:access.?token|refresh.?token|signed.?transaction|purchase.?token|payment.?credential|raw.?media|face.?embedding|private.?dialogue)/i;
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > 10_000 || depth > 32) throw new Error("offline payload exceeds structural limits");
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error(`offline payload value at ${path} is not a finite number`);
      return;
    }
    if (typeof value === "string") {
      if (value.length > 8_192) throw new Error(`offline payload value at ${path} is too large`);
      return;
    }
    if (typeof value !== "object") throw new Error(`offline payload value at ${path} is invalid`);
    if (seen.has(value)) throw new Error("offline payload must not contain cycles");
    seen.add(value);
    try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0
        || Object.keys(value).length !== value.length) throw new Error(`offline payload array at ${path} is not plain`);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) throw new Error(`offline payload array at ${path} contains an accessor`);
        visit(descriptor.value, `${path}[${index}]`, depth + 1);
      }
      return;
    }
    if (!isPlainRecord(value)) throw new Error(`offline payload value at ${path} is invalid`);
    assertDataProperties(value, `offline payload value at ${path}`);
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error(`offline payload contains unsafe field ${key}`);
      }
      if (forbidden.test(key)) throw new Error(`offline payload contains prohibited field ${key}`);
      visit(entry, `${path}.${key}`, depth + 1);
    }
    } finally {
      seen.delete(value);
    }
  };
  visit(payload, "payload", 0);
  let serialized: string;
  try { serialized = JSON.stringify(payload); } catch (error) {
    throw new Error("offline payload is not valid JSON", { cause: error });
  }
  if (new TextEncoder().encode(serialized).byteLength > 64 * 1_024) throw new Error("offline payload is too large");
}

function assertCommandLiveAt(command: OfflineCommand, nowMs: number): void {
  if (Date.parse(command.createdAt) > nowMs || Date.parse(command.expiresAt) <= nowMs) {
    throw new Error("offline command must satisfy createdAt <= now < expiresAt");
  }
}

function parseOfflineInstant(value: string, field: string): number {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (match === null) {
    throw new Error(`offline command ${field} must be an RFC 3339 UTC instant`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`offline command ${field} is invalid`);
  const canonical = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  if (new Date(parsed).toISOString() !== canonical) throw new Error(`offline command ${field} is invalid`);
  return parsed;
}

function validNow(value: Date): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("offline clock returned an invalid instant");
  return value.getTime();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDataProperties(value: Record<string, unknown>, label: string): void {
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${label} contains symbol fields`);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (descriptor.get !== undefined || descriptor.set !== undefined) throw new Error(`${label} contains an accessor field`);
  }
}

function isExplicitlyPermanent(error: unknown): boolean {
  return (error instanceof MobileCapabilityError || error instanceof MobileHttpApiError || error instanceof MobileApplicationError)
    && !error.retryable;
}

function validateNativePurchase(value: NativeStorePurchase): NativeStorePurchase {
  if (value.platform !== "ios" && value.platform !== "android") throw new Error("native store platform is invalid");
  boundedIdentifier(value.productId, "productId");
  boundedIdentifier(value.transactionReference, "transactionReference");
  if (value.providerPayload.length < 16 || value.providerPayload.length > 64 * 1_024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.providerPayload)) {
    throw new Error("native provider payload is invalid");
  }
  return value;
}

function validateEntitlement(value: MobileEntitlementProjection): MobileEntitlementProjection {
  boundedIdentifier(value.verificationId, "verificationId");
  boundedIdentifier(value.productId, "productId");
  if (!new Set(["pending", "active", "grace", "billing_retry", "expired", "revoked", "refunded"]).has(value.state)) {
    throw new Error("entitlement projection state is invalid");
  }
  if (!Number.isSafeInteger(value.version) || value.version < 1 || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error("entitlement projection version or timestamp is invalid");
  }
  return structuredClone(value);
}

function boundedIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}
