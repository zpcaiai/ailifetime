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

  constructor(
    private readonly storage: SecureStorage,
    private readonly storageKey = "ltm.offline.commands",
    options: { readonly allowedBatches?: readonly string[]; readonly maxAttempts?: number } = {},
  ) {
    this.#allowedBatches = new Set(options.allowedBatches ?? ["B64", "B65"]);
    this.#maxAttempts = options.maxAttempts ?? 5;
    if (this.#allowedBatches.size === 0 || [...this.#allowedBatches].some((batchId) => !/^B\d{2,3}$/.test(batchId))) {
      throw new Error("offline capability allowlist is invalid");
    }
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > 10) {
      throw new Error("offline maximum attempts is invalid");
    }
  }

  async enqueue(command: OfflineCommand): Promise<void> {
    validateCommand(command);
    if (!this.#allowedBatches.has(command.batchId)) throw new Error("capability is not permitted in the offline queue");
    assertOfflineSafePayload(command.payload);
    const commands = await this.read();
    if (commands.some((item) => item.id === command.id || item.idempotencyKey === command.idempotencyKey)) return;
    commands.push({ ...structuredClone(command), attempts: command.attempts ?? 0 });
    await this.storage.set(this.storageKey, JSON.stringify(commands));
  }

  async flush(
    client: CapabilityExecutor,
    now = new Date(),
  ): Promise<{ sent: string[]; retained: string[]; dropped: Array<{ id: string; reason: "expired" | "permanent" | "attempts_exhausted" }> }> {
    const commands = await this.read();
    const retained: OfflineCommand[] = [];
    const sent: string[] = [];
    const dropped: Array<{ id: string; reason: "expired" | "permanent" | "attempts_exhausted" }> = [];
    for (const command of commands) {
      if (new Date(command.expiresAt).getTime() <= now.getTime()) {
        dropped.push({ id: command.id, reason: "expired" });
        continue;
      }
      try {
        await client.execute(command.batchId, command.payload, command.idempotencyKey);
        sent.push(command.id);
      } catch (error) {
        const attempts = (command.attempts ?? 0) + 1;
        if (error instanceof MobileCapabilityError && !error.retryable) {
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
    await this.storage.delete(this.storageKey);
  }

  private async read(): Promise<OfflineCommand[]> {
    const raw = await this.storage.get(this.storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("offline queue is corrupted");
    return parsed.map((entry) => {
      validateCommand(entry);
      return entry;
    });
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

function validateCommand(value: unknown): asserts value is OfflineCommand {
  if (!value || typeof value !== "object") throw new Error("offline command must be an object");
  const command = value as Partial<OfflineCommand>;
  if (!command.id || !command.idempotencyKey || !command.batchId || !/^B\d{2,3}$/.test(command.batchId) || !command.payload || !command.createdAt || !command.expiresAt) {
    throw new Error("offline command is incomplete");
  }
  if (!Number.isFinite(Date.parse(command.createdAt)) || !Number.isFinite(Date.parse(command.expiresAt))) {
    throw new Error("offline command timestamps are invalid");
  }
  if (command.attempts !== undefined && (!Number.isSafeInteger(command.attempts) || command.attempts < 0 || command.attempts > 10)) {
    throw new Error("offline command attempts are invalid");
  }
}

function assertOfflineSafePayload(payload: Record<string, unknown>): void {
  const serialized = JSON.stringify(payload);
  if (new TextEncoder().encode(serialized).byteLength > 64 * 1_024) throw new Error("offline payload is too large");
  const forbidden = /(?:access.?token|refresh.?token|signed.?transaction|purchase.?token|payment.?credential|raw.?media|face.?embedding|private.?dialogue)/i;
  const visit = (value: unknown, path: string): void => {
    if (value === null || typeof value === "boolean" || typeof value === "number") return;
    if (typeof value === "string") {
      if (value.length > 8_192) throw new Error(`offline payload value at ${path} is too large`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (typeof value !== "object") throw new Error(`offline payload value at ${path} is invalid`);
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (forbidden.test(key)) throw new Error(`offline payload contains prohibited field ${key}`);
      visit(entry, `${path}.${key}`);
    }
  };
  visit(payload, "payload");
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
