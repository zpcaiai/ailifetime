export const MOBILE_VISIBLE_MANIFEST_SCHEMA_VERSION = "ltm.visible-capability-manifest.v1" as const;

export type MobilePlatform = "ios" | "android";
export type MobileEnvironment = "development" | "staging" | "production";
export type MobileApplicationState = "stopped" | "starting" | "authenticating" | "ready" | "signing_out" | "signed_out" | "failed";
export type MobilePortalId = "consumer" | "family" | "partner" | "studio" | "operations" | "support" | "developer";
export type MobileCapabilityMode =
  | "resource"
  | "state-transition"
  | "consent-write"
  | "ledger-post"
  | "partner-settlement-ledger"
  | "inbox-event"
  | "external-command"
  | "attestation";
export type MobileAuthenticatedRole =
  | "consumer"
  | "household_admin"
  | "guardian"
  | "partner_employee"
  | "partner_admin"
  | "studio_operator"
  | "support_agent"
  | "moderator"
  | "privacy_officer"
  | "finance_operator"
  | "platform_admin"
  | "auditor"
  | "service_account";

export interface MobileProductionConfiguration {
  readonly environment: MobileEnvironment;
  readonly platform: MobilePlatform;
  readonly applicationId: string;
  readonly applicationVersion: string;
  readonly apiBaseUrl: string;
  readonly allowedApiOrigins: readonly string[];
  readonly purpose: string;
  readonly allowedDeepLinkHosts: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** A native OIDC/OAuth adapter owns refresh credentials. Access tokens returned here remain memory-only. */
export interface MobileIdentityPort {
  restore(): Promise<MobileIdentityGrant | null>;
  signIn(): Promise<MobileIdentityGrant>;
  refresh(): Promise<MobileIdentityGrant>;
  signOut(): Promise<void>;
}

export interface MobileIdentityGrant {
  readonly accessToken: string;
  readonly expiresAt: string;
}

export interface MobileApiRequestContext {
  readonly accessToken: string;
  readonly purpose: string;
}

/** API responses are deliberately unknown: every injected adapter is validated at the application boundary. */
export interface MobileApplicationApiPort {
  getSession(context: MobileApiRequestContext): Promise<unknown>;
  getVisibleCapabilityManifest(context: MobileApiRequestContext): Promise<unknown>;
  executeCapability(
    context: MobileApiRequestContext,
    batchId: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<unknown>;
}

export interface MobileOfflineLifecyclePort {
  activate(binding: { readonly tenantId: string; readonly actorId: string }): Promise<void>;
  purge(): Promise<void>;
}

export interface MobileTelemetryEvent {
  readonly name: "application_started" | "authentication_succeeded" | "authentication_failed" | "signed_out" | "capability_opened" | "capability_executed";
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

export interface MobileTelemetryPort {
  record(event: MobileTelemetryEvent): void | Promise<void>;
}

export interface MobileAuthenticatedSession {
  readonly actorId: string;
  readonly tenantId: string;
  readonly roles: readonly MobileAuthenticatedRole[];
  readonly purpose: string;
  readonly stepUp: boolean;
  readonly guardianVerified: boolean;
  readonly authenticationState: "server_verified";
}

export interface MobileCapabilityProjection {
  readonly batchId: string;
  readonly skill: string;
  readonly operation: string;
  readonly permission: string;
  readonly portalId: MobilePortalId;
  readonly mode: MobileCapabilityMode;
  readonly requirements: readonly string[];
  readonly requiresExternalEvidence: boolean;
}

export interface MobilePortalProjection {
  readonly id: MobilePortalId;
  readonly skills: readonly string[];
  readonly capabilityCount: number;
}

export interface MobileVisibleCapabilityManifest {
  readonly schemaVersion: typeof MOBILE_VISIBLE_MANIFEST_SCHEMA_VERSION;
  readonly capabilities: readonly MobileCapabilityProjection[];
  readonly portals: readonly MobilePortalProjection[];
  readonly count: number;
  readonly requestId: string;
}

export type MobileRoute =
  | { readonly name: "sign_in" }
  | { readonly name: "workspace"; readonly portalId: MobilePortalId }
  | { readonly name: "capability"; readonly portalId: MobilePortalId; readonly batchId: string }
  | { readonly name: "settings" };

export interface MobileApplicationSnapshot {
  readonly state: MobileApplicationState;
  readonly route: MobileRoute;
  readonly session?: MobileAuthenticatedSession;
  readonly manifest?: MobileVisibleCapabilityManifest;
  readonly error?: { readonly code: string; readonly retryable: boolean };
}

export class MobileApplicationError extends Error {
  constructor(
    readonly code: "INVALID_CONFIGURATION" | "AUTHENTICATION_REQUIRED" | "INVALID_IDENTITY_GRANT" | "INVALID_SERVER_PROJECTION" | "NAVIGATION_FORBIDDEN" | "NETWORK_ERROR" | "REQUEST_TIMEOUT" | "API_ERROR" | "SIGN_OUT_FAILED",
    message: string,
    readonly retryable = false,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MobileApplicationError";
  }
}

export interface MobileApplicationOptions {
  readonly configuration: MobileProductionConfiguration;
  readonly identity: MobileIdentityPort;
  readonly offline: MobileOfflineLifecyclePort;
  readonly telemetry: MobileTelemetryPort;
  readonly api?: MobileApplicationApiPort;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

const ROLES = new Set<MobileAuthenticatedRole>([
  "consumer", "household_admin", "guardian", "partner_employee", "partner_admin", "studio_operator", "support_agent",
  "moderator", "privacy_officer", "finance_operator", "platform_admin", "auditor", "service_account",
]);
const PORTALS = new Set<MobilePortalId>(["consumer", "family", "partner", "studio", "operations", "support", "developer"]);
const MODES = new Set<MobileCapabilityMode>([
  "resource", "state-transition", "consent-write", "ledger-post", "partner-settlement-ledger", "inbox-event", "external-command", "attestation",
]);
const BATCH_ID = /^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/;
const OPERATION = /^[a-z][A-Za-z0-9.-]*$/;

export class MobileApplication {
  readonly #configuration: Readonly<MobileProductionConfiguration>;
  readonly #identity: MobileIdentityPort;
  readonly #api: MobileApplicationApiPort;
  readonly #offline: MobileOfflineLifecyclePort;
  readonly #telemetry: MobileTelemetryPort;
  readonly #now: () => Date;
  readonly #listeners = new Set<(snapshot: MobileApplicationSnapshot) => void>();
  #state: MobileApplicationState = "stopped";
  #route: MobileRoute = { name: "sign_in" };
  #session: MobileAuthenticatedSession | undefined = undefined;
  #manifest: MobileVisibleCapabilityManifest | undefined = undefined;
  #accessToken: string | undefined = undefined;
  #error: { code: string; retryable: boolean } | undefined = undefined;
  #revision = 0;

  constructor(options: MobileApplicationOptions) {
    this.#configuration = validateConfiguration(options.configuration);
    assertPort(options.identity, ["restore", "signIn", "refresh", "signOut"], "identity");
    assertPort(options.offline, ["activate", "purge"], "offline lifecycle");
    assertPort(options.telemetry, ["record"], "telemetry");
    this.#identity = options.identity;
    this.#offline = options.offline;
    this.#telemetry = options.telemetry;
    this.#api = options.api ?? new MobileHttpApiClient({
      baseUrl: this.#configuration.apiBaseUrl,
      environment: this.#configuration.environment,
      allowedOrigins: this.#configuration.allowedApiOrigins,
      ...(this.#configuration.requestTimeoutMs === undefined ? {} : { timeoutMs: this.#configuration.requestTimeoutMs }),
      ...(this.#configuration.maxResponseBytes === undefined ? {} : { maxResponseBytes: this.#configuration.maxResponseBytes }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    assertPort(this.#api, ["getSession", "getVisibleCapabilityManifest", "executeCapability"], "application API");
    this.#now = options.now ?? (() => new Date());
  }

  snapshot(): MobileApplicationSnapshot {
    const value: MobileApplicationSnapshot = {
      state: this.#state,
      route: structuredClone(this.#route),
      ...(this.#session === undefined ? {} : { session: structuredClone(this.#session) }),
      ...(this.#manifest === undefined ? {} : { manifest: structuredClone(this.#manifest) }),
      ...(this.#error === undefined ? {} : { error: { ...this.#error } }),
    };
    return value;
  }

  subscribe(listener: (snapshot: MobileApplicationSnapshot) => void): () => void {
    if (typeof listener !== "function") throw new TypeError("mobile application listener must be a function");
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<MobileApplicationSnapshot> {
    if (this.#state !== "stopped" && this.#state !== "failed" && this.#state !== "signed_out") return this.snapshot();
    const revision = ++this.#revision;
    this.#transition("starting", { name: "sign_in" });
    try {
      const grant = await this.#identity.restore();
      if (revision !== this.#revision) return this.snapshot();
      if (grant === null) {
        this.#clearAuthorization("signed_out");
        this.#record({ name: "application_started", fields: { authenticated: false } });
        return this.snapshot();
      }
      await this.#authorize(grant, revision);
      this.#record({ name: "application_started", fields: { authenticated: true } });
      return this.snapshot();
    } catch (error) {
      if (revision !== this.#revision) return this.snapshot();
      throw this.#failAuthorization(error);
    }
  }

  async signIn(): Promise<MobileApplicationSnapshot> {
    const revision = ++this.#revision;
    this.#transition("authenticating", { name: "sign_in" });
    try {
      await this.#authorize(await this.#identity.signIn(), revision);
      return this.snapshot();
    } catch (error) {
      if (revision !== this.#revision) return this.snapshot();
      throw this.#failAuthorization(error);
    }
  }

  async refresh(): Promise<MobileApplicationSnapshot> {
    if (this.#state !== "ready") throw new MobileApplicationError("AUTHENTICATION_REQUIRED", "a ready authenticated session is required");
    const revision = ++this.#revision;
    this.#transition("authenticating", this.#route);
    try {
      await this.#authorize(await this.#identity.refresh(), revision);
      return this.snapshot();
    } catch (error) {
      if (revision !== this.#revision) return this.snapshot();
      throw this.#failAuthorization(error);
    }
  }

  async signOut(): Promise<MobileApplicationSnapshot> {
    ++this.#revision;
    this.#accessToken = undefined;
    this.#session = undefined;
    this.#manifest = undefined;
    this.#error = undefined;
    this.#transition("signing_out", { name: "sign_in" });
    const results = await Promise.allSettled([this.#offline.purge(), this.#identity.signOut()]);
    this.#clearAuthorization("signed_out");
    this.#record({ name: "signed_out", fields: {} });
    if (results.some((result) => result.status === "rejected")) {
      throw new MobileApplicationError("SIGN_OUT_FAILED", "local authorization was cleared but a sign-out adapter failed", true);
    }
    return this.snapshot();
  }

  openPortal(portalId: MobilePortalId): MobileApplicationSnapshot {
    const manifest = this.#requireReadyManifest();
    if (!manifest.portals.some((portal) => portal.id === portalId)) {
      throw new MobileApplicationError("NAVIGATION_FORBIDDEN", "portal is not present in the server-visible projection");
    }
    this.#transition("ready", { name: "workspace", portalId });
    return this.snapshot();
  }

  openCapability(batchId: string): MobileApplicationSnapshot {
    const manifest = this.#requireReadyManifest();
    const capability = manifest.capabilities.find((item) => item.batchId === batchId);
    if (capability === undefined) {
      throw new MobileApplicationError("NAVIGATION_FORBIDDEN", "capability is not present in the server-visible projection");
    }
    this.#transition("ready", { name: "capability", portalId: capability.portalId, batchId: capability.batchId });
    this.#record({ name: "capability_opened", fields: { batchId: capability.batchId, portalId: capability.portalId } });
    return this.snapshot();
  }

  openSettings(): MobileApplicationSnapshot {
    this.#requireReadyManifest();
    this.#transition("ready", { name: "settings" });
    return this.snapshot();
  }

  openDeepLink(raw: string): MobileApplicationSnapshot {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !this.#configuration.allowedDeepLinkHosts.includes(url.hostname)) {
      throw new MobileApplicationError("NAVIGATION_FORBIDDEN", "deep link origin is not allowed");
    }
    for (const field of ["token", "role", "tenant", "permission", "stepUp"]) {
      if (url.searchParams.has(field)) throw new MobileApplicationError("NAVIGATION_FORBIDDEN", `deep link cannot assert ${field}`);
    }
    const capability = /^\/capabilities\/(B\d{2,3})$/.exec(url.pathname);
    if (capability?.[1] !== undefined) return this.openCapability(capability[1]);
    if (url.pathname === "/settings") return this.openSettings();
    throw new MobileApplicationError("NAVIGATION_FORBIDDEN", "deep link path is not supported by the application shell");
  }

  async executeCapability<T>(batchId: string, input: Record<string, unknown>, idempotencyKey: string): Promise<T> {
    const manifest = this.#requireReadyManifest();
    if (!manifest.capabilities.some((capability) => capability.batchId === batchId)) {
      throw new MobileApplicationError("NAVIGATION_FORBIDDEN", "capability is not present in the server-visible projection");
    }
    const accessToken = this.#accessToken;
    if (accessToken === undefined) throw new MobileApplicationError("AUTHENTICATION_REQUIRED", "an in-memory access token is required");
    validateIdempotencyKey(idempotencyKey);
    if (!isPlainObject(input)) throw new TypeError("capability input must be a JSON object");
    try {
      const result = await this.#api.executeCapability({ accessToken, purpose: this.#configuration.purpose }, batchId, input, idempotencyKey);
      this.#record({ name: "capability_executed", fields: { batchId } });
      return result as T;
    } catch (error) {
      if (error instanceof MobileHttpApiError && error.status === 401) this.#failAuthorization(error);
      throw error;
    }
  }

  async #authorize(grantValue: MobileIdentityGrant, revision: number): Promise<void> {
    const grant = validateIdentityGrant(grantValue, this.#now());
    if (revision !== this.#revision) return;
    const context = { accessToken: grant.accessToken, purpose: this.#configuration.purpose } as const;
    const [sessionValue, manifestValue] = await Promise.all([
      this.#api.getSession(context),
      this.#api.getVisibleCapabilityManifest(context),
    ]);
    if (revision !== this.#revision) return;
    const sessionResponse = parseSessionResponse(sessionValue);
    const manifest = parseVisibleManifest(manifestValue);
    if (sessionResponse.session.purpose !== this.#configuration.purpose) {
      throw new MobileApplicationError("INVALID_SERVER_PROJECTION", "server session purpose does not match mobile configuration");
    }
    await this.#offline.activate({ tenantId: sessionResponse.session.tenantId, actorId: sessionResponse.session.actorId });
    if (revision !== this.#revision) return;
    this.#accessToken = grant.accessToken;
    this.#session = sessionResponse.session;
    this.#manifest = manifest;
    this.#error = undefined;
    const portalId = manifest.portals[0]?.id;
    this.#transition("ready", portalId === undefined ? { name: "settings" } : { name: "workspace", portalId });
    this.#record({
      name: "authentication_succeeded",
      fields: { roleCount: sessionResponse.session.roles.length, capabilityCount: manifest.count, portalCount: manifest.portals.length },
    });
  }

  #requireReadyManifest(): MobileVisibleCapabilityManifest {
    if (this.#state !== "ready" || this.#manifest === undefined || this.#session === undefined || this.#accessToken === undefined) {
      throw new MobileApplicationError("AUTHENTICATION_REQUIRED", "server-verified mobile authorization is required");
    }
    return this.#manifest;
  }

  #failAuthorization(error: unknown): MobileApplicationError {
    const mapped = error instanceof MobileApplicationError
      ? error
      : error instanceof MobileHttpApiError
        ? new MobileApplicationError(error.status === 401 ? "AUTHENTICATION_REQUIRED" : "API_ERROR", "mobile authorization request failed", error.retryable, error)
        : new MobileApplicationError("INVALID_SERVER_PROJECTION", "mobile authorization could not be established", false, error);
    this.#accessToken = undefined;
    this.#session = undefined;
    this.#manifest = undefined;
    this.#error = { code: mapped.code, retryable: mapped.retryable };
    this.#transition("failed", { name: "sign_in" });
    this.#record({ name: "authentication_failed", fields: { code: mapped.code, retryable: mapped.retryable } });
    return mapped;
  }

  #clearAuthorization(state: "signed_out"): void {
    this.#accessToken = undefined;
    this.#session = undefined;
    this.#manifest = undefined;
    this.#error = undefined;
    this.#transition(state, { name: "sign_in" });
  }

  #transition(state: MobileApplicationState, route: MobileRoute): void {
    this.#state = state;
    this.#route = structuredClone(route);
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) {
      try { listener(snapshot); } catch { /* UI adapters cannot block authorization transitions. */ }
    }
  }

  #record(event: MobileTelemetryEvent): void {
    try {
      const result = this.#telemetry.record(event);
      if (result instanceof Promise) void result.catch(() => undefined);
    } catch {
      // Telemetry is non-authoritative and must not block application security state.
    }
  }
}

export interface MobileHttpApiClientOptions {
  readonly baseUrl: string;
  readonly environment?: MobileEnvironment;
  readonly allowedOrigins: readonly string[];
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof fetch;
}

export class MobileHttpApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly retryable = false,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MobileHttpApiError";
  }
}

/** Dependency-free production HTTP adapter. It receives, uses, and discards the bearer on every call. */
export class MobileHttpApiClient implements MobileApplicationApiPort {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: MobileHttpApiClientOptions) {
    const environment = options.environment ?? "production";
    this.#baseUrl = validateApiAllowlist(options.baseUrl, options.allowedOrigins, environment).baseUrl;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 120_000) {
      throw new MobileApplicationError("INVALID_CONFIGURATION", "requestTimeoutMs must be 1 through 120000");
    }
    if (!Number.isSafeInteger(this.#maxResponseBytes) || this.#maxResponseBytes < 1 || this.#maxResponseBytes > 16 * 1024 * 1024) {
      throw new MobileApplicationError("INVALID_CONFIGURATION", "maxResponseBytes must be 1 through 16777216");
    }
    if (typeof this.#fetch !== "function") throw new MobileApplicationError("INVALID_CONFIGURATION", "a Fetch implementation is required");
  }

  getSession(context: MobileApiRequestContext): Promise<unknown> {
    return this.#request("/v1/session", context, { method: "GET" });
  }

  getVisibleCapabilityManifest(context: MobileApiRequestContext): Promise<unknown> {
    return this.#request("/v1/capabilities/visible", context, { method: "GET" });
  }

  async executeCapability(
    context: MobileApiRequestContext,
    batchId: string,
    input: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<unknown> {
    if (!BATCH_ID.test(batchId)) throw new TypeError("batchId must be B00 through B127");
    validateIdempotencyKey(idempotencyKey);
    const response = await this.#request(`/v1/capabilities/${batchId}`, context, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(input),
    });
    if (!isPlainObject(response) || !("data" in response) || !isPlainObject(response.meta)) {
      throw new MobileHttpApiError(502, "INVALID_RESPONSE", "capability response must contain data and meta");
    }
    const requestId = boundedString(response.meta.requestId, "capability meta.requestId", 512);
    if (response.meta.batchId !== batchId) {
      throw new MobileHttpApiError(502, "INVALID_RESPONSE", "capability response batch binding is invalid", requestId);
    }
    return response.data;
  }

  async #request(path: string, context: MobileApiRequestContext, init: RequestInit): Promise<unknown> {
    validateAccessToken(context.accessToken);
    boundedString(context.purpose, "request purpose", 120);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const headers = new Headers(init.headers);
      headers.set("accept", "application/json");
      headers.set("authorization", `Bearer ${context.accessToken}`);
      headers.set("x-purpose", context.purpose);
      headers.set("x-client-platform", "mobile");
      const response = await this.#fetch(`${this.#baseUrl}${path}`, { ...init, headers, redirect: "error", signal: controller.signal });
      const raw = await readBoundedResponse(response, this.#maxResponseBytes);
      let value: unknown;
      try { value = JSON.parse(raw); } catch (error) {
        throw new MobileHttpApiError(502, "INVALID_RESPONSE", "server returned malformed JSON", undefined, false, error);
      }
      if (response.ok) return value;
      if (!isPlainObject(value) || !isPlainObject(value.error)) {
        throw new MobileHttpApiError(502, "INVALID_RESPONSE", "server returned a malformed error response");
      }
      const requestId = boundedString(value.requestId, "error requestId", 512);
      const code = boundedString(value.error.code, "error code", 160);
      const message = boundedString(value.error.message, "error message", 2_048);
      if (typeof value.error.retryable !== "boolean" || !isPlainObject(value.error.details)) {
        throw new MobileHttpApiError(502, "INVALID_RESPONSE", "server returned a malformed error response", requestId);
      }
      // Client errors are terminal for offline replay even when an upstream payload incorrectly labels them retryable.
      const retryable = response.status >= 500 && response.status <= 599 && value.error.retryable;
      throw new MobileHttpApiError(response.status, code, message, requestId, retryable);
    } catch (error) {
      if (error instanceof MobileHttpApiError) throw error;
      const timeoutError = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      throw new MobileApplicationError(timeoutError ? "REQUEST_TIMEOUT" : "NETWORK_ERROR", timeoutError ? "mobile API request timed out" : "mobile API request failed", true, error);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateConfiguration(value: MobileProductionConfiguration): Readonly<MobileProductionConfiguration> {
  if (!isPlainObject(value)) throw new MobileApplicationError("INVALID_CONFIGURATION", "mobile production configuration is required");
  if (!new Set(["development", "staging", "production"]).has(value.environment)) {
    throw new MobileApplicationError("INVALID_CONFIGURATION", "mobile environment is invalid");
  }
  if (value.platform !== "ios" && value.platform !== "android") {
    throw new MobileApplicationError("INVALID_CONFIGURATION", "mobile platform is invalid");
  }
  if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+){2,}$/.test(value.applicationId)) {
    throw new MobileApplicationError("INVALID_CONFIGURATION", "applicationId must be a reverse-domain identifier");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.applicationVersion)) {
    throw new MobileApplicationError("INVALID_CONFIGURATION", "applicationVersion must be semantic-version compatible");
  }
  const { baseUrl: apiBaseUrl, allowedOrigins: allowedApiOrigins } = validateApiAllowlist(
    value.apiBaseUrl,
    value.allowedApiOrigins,
    value.environment,
  );
  const purpose = boundedString(value.purpose, "mobile purpose", 120);
  if (!Array.isArray(value.allowedDeepLinkHosts) || value.allowedDeepLinkHosts.length === 0 || value.allowedDeepLinkHosts.length > 20) {
    throw new MobileApplicationError("INVALID_CONFIGURATION", "at least one bounded deep-link host is required");
  }
  const hosts = value.allowedDeepLinkHosts.map((host) => {
    if (typeof host !== "string" || host !== host.toLowerCase() || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ||
        (value.environment !== "development" && !isPublicDnsName(host))) {
      throw new MobileApplicationError("INVALID_CONFIGURATION", "deep-link hosts must be normalized DNS names");
    }
    return host;
  });
  if (new Set(hosts).size !== hosts.length) throw new MobileApplicationError("INVALID_CONFIGURATION", "deep-link hosts must be unique");
  return Object.freeze({
    ...value,
    apiBaseUrl,
    allowedApiOrigins: Object.freeze(allowedApiOrigins),
    purpose,
    allowedDeepLinkHosts: Object.freeze(hosts),
  });
}

function validateApiOrigin(raw: string, environment: MobileEnvironment): string {
  let url: URL;
  try { url = new URL(raw); } catch (error) {
    throw new MobileApplicationError("INVALID_CONFIGURATION", "apiBaseUrl must be an absolute URL", false, error);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || raw !== url.origin) {
    throw new MobileApplicationError("INVALID_CONFIGURATION", "API origins must be canonical credential-free origins without a trailing slash");
  }
  const loopbackDevelopment = environment === "development" && isLoopback(url.hostname) &&
    (url.protocol === "http:" || url.protocol === "https:");
  if (!loopbackDevelopment && (url.protocol !== "https:" || !isPublicDnsName(url.hostname))) {
    throw new MobileApplicationError("INVALID_CONFIGURATION", "API origins require public HTTPS except for loopback development");
  }
  return url.origin;
}

function validateApiAllowlist(
  baseUrl: string,
  origins: readonly string[],
  environment: MobileEnvironment,
): { readonly baseUrl: string; readonly allowedOrigins: readonly string[] } {
  const normalizedBaseUrl = validateApiOrigin(baseUrl, environment);
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > 16) {
    throw new MobileApplicationError("INVALID_CONFIGURATION", "one to sixteen API origins must be allowlisted");
  }
  const normalizedOrigins = origins.map((origin) => validateApiOrigin(origin, environment));
  if (new Set(normalizedOrigins).size !== normalizedOrigins.length || !normalizedOrigins.includes(normalizedBaseUrl)) {
    throw new MobileApplicationError("INVALID_CONFIGURATION", "apiBaseUrl must be uniquely enrolled in allowedApiOrigins");
  }
  return { baseUrl: normalizedBaseUrl, allowedOrigins: normalizedOrigins };
}

function isPublicDnsName(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (isLoopback(normalized) || normalized.endsWith(".localhost") || normalized.endsWith(".local") ||
      normalized.endsWith(".test") || normalized.endsWith(".example") || normalized.endsWith(".invalid") ||
      normalized.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return false;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalized);
}

function validateIdentityGrant(value: MobileIdentityGrant, now: Date): MobileIdentityGrant {
  if (!isPlainObject(value)) throw new MobileApplicationError("INVALID_IDENTITY_GRANT", "native identity adapter returned no grant");
  validateAccessToken(value.accessToken);
  const expiration = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiration) || expiration <= now.getTime() + 5_000) {
    throw new MobileApplicationError("INVALID_IDENTITY_GRANT", "native identity grant is expired or too close to expiry");
  }
  return { accessToken: value.accessToken, expiresAt: new Date(expiration).toISOString() };
}

function parseSessionResponse(raw: unknown): { session: MobileAuthenticatedSession; requestId: string } {
  if (!isPlainObject(raw)) throw projectionError("authenticated session response must be an object");
  assertOnlyKeys(raw, ["session", "requestId"], "authenticated session response");
  const requestId = boundedString(raw.requestId, "session requestId", 512);
  if (!isPlainObject(raw.session)) throw projectionError("authenticated session response is missing session");
  const value = raw.session;
  assertOnlyKeys(value, ["actorId", "tenantId", "roles", "purpose", "stepUp", "guardianVerified", "authenticationState"], "authenticated session");
  if (!Array.isArray(value.roles) || value.roles.length === 0 || value.roles.length > ROLES.size) throw projectionError("session roles are invalid");
  const roles = value.roles.map((role) => {
    if (typeof role !== "string" || !ROLES.has(role as MobileAuthenticatedRole)) throw projectionError("session contains an unknown role");
    return role as MobileAuthenticatedRole;
  });
  assertUnique(roles, "session roles");
  if (value.authenticationState !== "server_verified" || typeof value.stepUp !== "boolean" || typeof value.guardianVerified !== "boolean") {
    throw projectionError("session verification state is invalid");
  }
  return {
    session: Object.freeze({
      actorId: boundedString(value.actorId, "session actorId", 512),
      tenantId: boundedString(value.tenantId, "session tenantId", 512),
      roles: Object.freeze(roles),
      purpose: boundedString(value.purpose, "session purpose", 120),
      stepUp: value.stepUp,
      guardianVerified: value.guardianVerified,
      authenticationState: "server_verified" as const,
    }),
    requestId,
  };
}

function parseVisibleManifest(raw: unknown): MobileVisibleCapabilityManifest {
  if (!isPlainObject(raw)) throw projectionError("visible capability manifest must be an object");
  assertOnlyKeys(raw, ["schemaVersion", "capabilities", "portals", "count", "requestId"], "visible capability manifest");
  const requestId = boundedString(raw.requestId, "visible manifest requestId", 512);
  if (raw.schemaVersion !== MOBILE_VISIBLE_MANIFEST_SCHEMA_VERSION) throw projectionError("visible capability schema version is unsupported");
  if (!Array.isArray(raw.capabilities) || raw.capabilities.length > 128 || !Array.isArray(raw.portals) || raw.portals.length > 7) {
    throw projectionError("visible capability arrays are invalid");
  }
  if (!Number.isSafeInteger(raw.count) || (raw.count as number) < 0 || (raw.count as number) > 128) throw projectionError("visible capability count is invalid");
  const capabilities = raw.capabilities.map((item, index) => parseCapability(item, `capabilities[${index}]`));
  const portals = raw.portals.map((item, index) => parsePortal(item, `portals[${index}]`));
  if (raw.count !== capabilities.length) throw projectionError("visible capability count is inconsistent");
  assertUnique(capabilities.map((item) => item.batchId), "visible capability batch identifiers");
  assertUnique(portals.map((item) => item.id), "visible portal identifiers");
  for (const portal of portals) {
    const projected = capabilities.filter((item) => item.portalId === portal.id);
    if (projected.length !== portal.capabilityCount) throw projectionError(`portal ${portal.id} capability count is inconsistent`);
    const skills = new Set(projected.map((item) => item.skill));
    if (portal.skills.some((skill) => !skills.has(skill)) || projected.some((item) => !portal.skills.includes(item.skill))) {
      throw projectionError(`portal ${portal.id} skills are inconsistent`);
    }
  }
  if (capabilities.some((item) => !portals.some((portal) => portal.id === item.portalId))) throw projectionError("capability references a missing portal");
  return Object.freeze({
    schemaVersion: MOBILE_VISIBLE_MANIFEST_SCHEMA_VERSION,
    capabilities: Object.freeze(capabilities),
    portals: Object.freeze(portals),
    count: capabilities.length,
    requestId,
  });
}

function parseCapability(raw: unknown, label: string): MobileCapabilityProjection {
  if (!isPlainObject(raw)) throw projectionError(`${label} must be an object`);
  assertOnlyKeys(raw, ["batchId", "skill", "operation", "permission", "portalId", "mode", "requirements", "requiresExternalEvidence"], label);
  const batchId = boundedString(raw.batchId, `${label}.batchId`, 4);
  const operation = boundedString(raw.operation, `${label}.operation`, 160);
  if (!BATCH_ID.test(batchId) || !OPERATION.test(operation)) throw projectionError(`${label} identity is invalid`);
  if (typeof raw.portalId !== "string" || !PORTALS.has(raw.portalId as MobilePortalId)) throw projectionError(`${label}.portalId is invalid`);
  if (typeof raw.mode !== "string" || !MODES.has(raw.mode as MobileCapabilityMode)) throw projectionError(`${label}.mode is invalid`);
  if (!Array.isArray(raw.requirements) || raw.requirements.length !== 5) throw projectionError(`${label}.requirements must contain five entries`);
  const requirements = raw.requirements.map((item, index) => boundedString(item, `${label}.requirements[${index}]`, 1_024));
  if (typeof raw.requiresExternalEvidence !== "boolean") throw projectionError(`${label}.requiresExternalEvidence must be boolean`);
  return Object.freeze({
    batchId,
    skill: boundedString(raw.skill, `${label}.skill`, 256),
    operation,
    permission: boundedString(raw.permission, `${label}.permission`, 160),
    portalId: raw.portalId as MobilePortalId,
    mode: raw.mode as MobileCapabilityMode,
    requirements: Object.freeze(requirements),
    requiresExternalEvidence: raw.requiresExternalEvidence,
  });
}

function parsePortal(raw: unknown, label: string): MobilePortalProjection {
  if (!isPlainObject(raw)) throw projectionError(`${label} must be an object`);
  assertOnlyKeys(raw, ["id", "skills", "capabilityCount"], label);
  if (typeof raw.id !== "string" || !PORTALS.has(raw.id as MobilePortalId)) throw projectionError(`${label}.id is invalid`);
  if (!Array.isArray(raw.skills) || raw.skills.length === 0 || raw.skills.length > 22) throw projectionError(`${label}.skills are invalid`);
  const skills = raw.skills.map((skill, index) => boundedString(skill, `${label}.skills[${index}]`, 256));
  assertUnique(skills, `${label}.skills`);
  if (!Number.isSafeInteger(raw.capabilityCount) || (raw.capabilityCount as number) < 1 || (raw.capabilityCount as number) > 128) {
    throw projectionError(`${label}.capabilityCount is invalid`);
  }
  return Object.freeze({ id: raw.id as MobilePortalId, skills: Object.freeze(skills), capabilityCount: raw.capabilityCount as number });
}

async function readBoundedResponse(response: Response, maximum: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maximum) {
    await response.body?.cancel().catch(() => undefined);
    throw new MobileHttpApiError(502, "INVALID_RESPONSE", "response exceeds maxResponseBytes");
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => undefined);
      throw new MobileHttpApiError(502, "INVALID_RESPONSE", "response exceeds maxResponseBytes");
    }
    chunks.push(part.value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(joined); } catch (error) {
    throw new MobileHttpApiError(502, "INVALID_RESPONSE", "server returned malformed UTF-8", undefined, false, error);
  }
}

function validateAccessToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192 || /\s|[\u0000-\u001f\u007f]/.test(value)) {
    throw new MobileApplicationError("INVALID_IDENTITY_GRANT", "a bounded bearer access token is required");
  }
}

function validateIdempotencyKey(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("a bounded idempotency key is required");
  }
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw projectionError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) throw projectionError(`${label} contains an unknown field`);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw projectionError(`${label} must be unique`);
}

function projectionError(message: string): MobileApplicationError {
  return new MobileApplicationError("INVALID_SERVER_PROJECTION", message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const parts = host.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function assertPort(value: unknown, methods: readonly string[], label: string): void {
  if (!isPlainObject(value) && (value === null || typeof value !== "object")) {
    throw new MobileApplicationError("INVALID_CONFIGURATION", `${label} port is required`);
  }
  const port = value as Record<string, unknown>;
  if (methods.some((method) => typeof port[method] !== "function")) {
    throw new MobileApplicationError("INVALID_CONFIGURATION", `${label} port is incomplete`);
  }
}
