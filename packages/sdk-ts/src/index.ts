export interface ClientSession {
  accessToken: string;
  purpose: string;
}

export interface ConsentGrantRequest {
  readonly participantId: string;
  readonly grantorCapacity: "self" | "guardian" | "authorized_agent";
  readonly purpose: string;
  readonly scope: { readonly resource: string; readonly actions: readonly string[] };
  readonly policyVersion: string;
  /** Optional acknowledgement; the service remains authoritative and requires an exact disclosure digest match. */
  readonly evidenceHash?: string;
  readonly id?: string;
  readonly expiresAt?: string | null;
}

export type RightsRequestType =
  | "access"
  | "correction"
  | "export"
  | "withdraw"
  | "delete"
  | "restrict_processing"
  | "appeal";

export interface RightsRequestSubmission {
  readonly requestId?: string;
  readonly participantId: string;
  readonly requestType: RightsRequestType;
  readonly requestedProcessingPurpose: string;
  readonly correctionFields?: readonly string[];
  readonly correctionPayloadSha256?: string;
  readonly parentRequestId?: string;
}

export interface RightsTaskReceiptRequest {
  readonly requestId: string;
  readonly taskId: string;
  readonly outcome: "succeeded" | "blocked" | "failed";
  readonly resultSha256: string;
  readonly providerOccurredAt: string;
  readonly evidenceId: string;
  readonly errorCode?: string;
}

export interface RightsReviewRequest {
  readonly requestId: string;
  readonly decision: "approve" | "deny";
  readonly reasonCode: string;
  readonly caseReference: string;
}

export interface RightsRequestProjection {
  readonly requestId: string;
  readonly requestType: RightsRequestType;
  readonly subjectReference: string;
  readonly requestedProcessingPurpose: string;
  readonly status: "propagation_pending" | "review_pending" | "awaiting_second_review" | "escalated" | "completed" | "denied";
  readonly policyVersion: string;
  readonly submittedAt: string;
  readonly dueAt: string;
  readonly overdue: boolean;
  readonly completedAt: string | null;
  readonly parentRequestId: string | null;
  readonly progress: Readonly<{ total: number; succeeded: number; pending: number; blocked: number; failed: number }>;
  readonly tasks: readonly Readonly<{
    taskId: string;
    target: "primary_record_store" | "object_storage" | "cache" | "derived_artifacts" | "search_index" |
      "processing_queue" | "log_references" | "downstream_processors";
    assetReference: string | null;
    state: "pending" | "succeeded" | "blocked" | "failed";
    attempts: number;
  }>[];
  readonly review: Readonly<{ approvals: number; denials: number; requiredDistinctReviewers: 2 }>;
  readonly explanationCode: "PROPAGATION_PENDING" | "DEPENDENCY_ATTENTION_REQUIRED" | "REVIEW_PENDING" |
    "SECOND_REVIEW_REQUIRED" | "COMPLETED" | "DENIED";
}

export interface RightsRequestMutationResult {
  readonly value: RightsRequestProjection;
  readonly replayed: boolean;
}

export type AuthenticatedRole =
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

export type CapabilityPortalId = "consumer" | "family" | "partner" | "studio" | "operations" | "support" | "developer";

export type CapabilityMode =
  | "resource"
  | "state-transition"
  | "consent-write"
  | "ledger-post"
  | "partner-settlement-ledger"
  | "inbox-event"
  | "external-command"
  | "attestation";

export interface AuthenticatedSession {
  readonly actorId: string;
  readonly tenantId: string;
  readonly roles: readonly AuthenticatedRole[];
  readonly purpose: string;
  readonly stepUp: boolean;
  readonly guardianVerified: boolean;
  readonly authenticationState: "server_verified";
}

export interface AuthenticatedSessionResponse {
  readonly session: AuthenticatedSession;
  readonly requestId: string;
}

export interface CapabilitySummary {
  readonly batchId: string;
  readonly skill: string;
  readonly operation: string;
  readonly permission: string;
  readonly portalId: CapabilityPortalId;
  readonly mode: CapabilityMode;
  readonly requirements: readonly string[];
  readonly requiresExternalEvidence: boolean;
}

export interface VisibleCapabilityPortal {
  readonly id: CapabilityPortalId;
  readonly skills: readonly string[];
  readonly capabilityCount: number;
}

export interface VisibleCapabilityManifest {
  readonly schemaVersion: "ltm.visible-capability-manifest.v1";
  readonly capabilities: readonly CapabilitySummary[];
  readonly portals: readonly VisibleCapabilityPortal[];
  readonly count: number;
  readonly requestId: string;
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
const VISIBLE_CAPABILITY_SCHEMA_VERSION = "ltm.visible-capability-manifest.v1" as const;
const AUTHENTICATED_ROLES = new Set<AuthenticatedRole>([
  "consumer", "household_admin", "guardian", "partner_employee", "partner_admin", "studio_operator", "support_agent",
  "moderator", "privacy_officer", "finance_operator", "platform_admin", "auditor", "service_account",
]);
const CAPABILITY_PORTALS = new Set<CapabilityPortalId>(["consumer", "family", "partner", "studio", "operations", "support", "developer"]);
const CAPABILITY_MODES = new Set<CapabilityMode>([
  "resource", "state-transition", "consent-write", "ledger-post", "partner-settlement-ledger", "inbox-event", "external-command", "attestation",
]);
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

  async getSession(): Promise<AuthenticatedSessionResponse> {
    const response = parseAuthenticatedSessionResponse(await this.#requestObject("/v1/session", { method: "GET" }, true));
    if (response.session.purpose !== this.#session.purpose) {
      throw invalidResponse("authenticated session purpose does not match the request", response.requestId);
    }
    return response;
  }

  async getVisibleCapabilityManifest(): Promise<VisibleCapabilityManifest> {
    return parseVisibleCapabilityManifest(await this.#requestObject("/v1/capabilities/visible", { method: "GET" }, true));
  }

  async listCapabilities(): Promise<readonly CapabilitySummary[]> {
    const response = await this.#requestObject("/v1/capabilities", { method: "GET" }, true);
    assertOnlyKeys(response, ["capabilities", "count", "requestId"], "capability catalog response");
    const requestId = boundedResponseString(response.requestId, "capability catalog requestId", 512);
    if (!Array.isArray(response.capabilities)) {
      throw invalidResponse("capability response is missing capabilities", requestId);
    }
    if (response.capabilities.length > 128) throw invalidResponse("capability response exceeds the catalog limit", requestId);
    if (!Number.isSafeInteger(response.count) || response.count !== response.capabilities.length) {
      throw invalidResponse("capability response count is inconsistent", requestId);
    }
    const capabilities = response.capabilities.map((value, index) => parseCapabilitySummary(value, `capabilities[${index}]`, requestId));
    assertUnique(capabilities.map((capability) => capability.batchId), "capability batch identifiers", requestId);
    return Object.freeze(capabilities);
  }

  async execute<T>(batchId: string, input: Record<string, unknown>, idempotencyKey: string): Promise<T> {
    return (await this.executeEnvelope<T>(batchId, input, idempotencyKey)).data;
  }

  executeEnvelope<T>(batchId: string, input: Record<string, unknown>, idempotencyKey: string): Promise<DispatchEnvelope<T>> {
    if (!BATCH_ID.test(batchId)) throw new Error("batchId must be B00 through B127");
    validateIdempotencyKey(idempotencyKey);
    const body = serializePlainJsonInput(input);
    return this.#dispatch<T>(`/v1/capabilities/${batchId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body,
    }, { batchId }, true);
  }

  async command<T>(command: string, input: Record<string, unknown>, idempotencyKey: string): Promise<T> {
    return (await this.commandEnvelope<T>(command, input, idempotencyKey)).data;
  }

  grantConsent<T = unknown>(input: ConsentGrantRequest, idempotencyKey: string): Promise<T> {
    return this.command<T>("consent.grant", {
      participantId: input.participantId,
      grantorCapacity: input.grantorCapacity,
      purpose: input.purpose,
      scope: { resource: input.scope.resource, actions: [...input.scope.actions] },
      policyVersion: input.policyVersion,
      ...(input.evidenceHash === undefined ? {} : { evidenceHash: input.evidenceHash }),
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    }, idempotencyKey);
  }

  submitRightsRequest(input: RightsRequestSubmission, idempotencyKey: string): Promise<RightsRequestMutationResult> {
    return this.command<RightsRequestMutationResult>("rights-request.submit", {
      participantId: input.participantId,
      requestType: input.requestType,
      requestedProcessingPurpose: input.requestedProcessingPurpose,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.correctionFields === undefined ? {} : { correctionFields: [...input.correctionFields] }),
      ...(input.correctionPayloadSha256 === undefined
        ? {}
        : { correctionPayloadSha256: input.correctionPayloadSha256 }),
      ...(input.parentRequestId === undefined ? {} : { parentRequestId: input.parentRequestId }),
    }, idempotencyKey);
  }

  recordRightsTaskReceipt(input: RightsTaskReceiptRequest, idempotencyKey: string): Promise<RightsRequestMutationResult> {
    return this.command<RightsRequestMutationResult>("rights-request.task-receipt", {
      requestId: input.requestId,
      taskId: input.taskId,
      outcome: input.outcome,
      resultSha256: input.resultSha256,
      providerOccurredAt: input.providerOccurredAt,
      evidenceId: input.evidenceId,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    }, idempotencyKey);
  }

  reviewRightsRequest(input: RightsReviewRequest, idempotencyKey: string): Promise<RightsRequestMutationResult> {
    return this.command<RightsRequestMutationResult>("rights-request.review", { ...input }, idempotencyKey);
  }

  escalateRightsRequest(
    requestId: string,
    reasonCode: "sla_due" | "dependency_blocked" | "receipt_failed" | "review_disagreement",
    idempotencyKey: string,
  ): Promise<RightsRequestMutationResult> {
    return this.command<RightsRequestMutationResult>("rights-request.escalate", { requestId, reasonCode }, idempotencyKey);
  }

  getRightsRequest(requestId: string): Promise<RightsRequestProjection> {
    return this.query<RightsRequestProjection>("rights-request.get", { requestId });
  }

  listRightsRequests(input: Readonly<{ limit?: number; cursor?: string }> = {}): Promise<readonly RightsRequestProjection[]> {
    return this.query<readonly RightsRequestProjection[]>("rights-request.list", { ...input });
  }

  commandEnvelope<T>(command: string, input: Record<string, unknown>, idempotencyKey: string): Promise<DispatchEnvelope<T>> {
    validateOperation(command, "command");
    validateIdempotencyKey(idempotencyKey);
    const serializedInput = serializePlainJsonInput(input);
    return this.#dispatch<T>("/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: `{"command":${JSON.stringify(command)},"input":${serializedInput}}`,
    }, { command }, true);
  }

  async query<T>(query: string, input: Record<string, unknown> = {}): Promise<T> {
    return (await this.queryEnvelope<T>(query, input)).data;
  }

  queryEnvelope<T>(query: string, input: Record<string, unknown> = {}): Promise<DispatchEnvelope<T>> {
    validateOperation(query, "query");
    const serializedInput = serializePlainJsonInput(input);
    return this.#dispatch<T>("/v1/queries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"query":${JSON.stringify(query)},"input":${serializedInput}}`,
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

function parseAuthenticatedSessionResponse(value: Record<string, unknown>): AuthenticatedSessionResponse {
  assertOnlyKeys(value, ["session", "requestId"], "authenticated session response");
  if (!isObject(value.session)) throw invalidResponse("authenticated session response is missing session");
  const requestId = boundedResponseString(value.requestId, "session requestId", 512);
  const session = value.session;
  assertOnlyKeys(
    session,
    ["actorId", "tenantId", "roles", "purpose", "stepUp", "guardianVerified", "authenticationState"],
    "authenticated session",
    requestId,
  );
  if (!Array.isArray(session.roles) || session.roles.length === 0 || session.roles.length > AUTHENTICATED_ROLES.size) {
    throw invalidResponse("authenticated session roles are invalid", requestId);
  }
  const roles = session.roles.map((role) => {
    if (typeof role !== "string" || !AUTHENTICATED_ROLES.has(role as AuthenticatedRole)) {
      throw invalidResponse("authenticated session contains an unknown role", requestId);
    }
    return role as AuthenticatedRole;
  });
  assertUnique(roles, "authenticated session roles", requestId);
  if (session.authenticationState !== "server_verified") {
    throw invalidResponse("authenticated session is not server verified", requestId);
  }
  if (typeof session.stepUp !== "boolean" || typeof session.guardianVerified !== "boolean") {
    throw invalidResponse("authenticated session verification flags are invalid", requestId);
  }
  return Object.freeze({
    session: Object.freeze({
      actorId: boundedResponseString(session.actorId, "session actorId", 512, requestId),
      tenantId: boundedResponseString(session.tenantId, "session tenantId", 512, requestId),
      roles: Object.freeze(roles),
      purpose: boundedResponseString(session.purpose, "session purpose", 120, requestId),
      stepUp: session.stepUp,
      guardianVerified: session.guardianVerified,
      authenticationState: "server_verified" as const,
    }),
    requestId,
  });
}

function parseVisibleCapabilityManifest(value: Record<string, unknown>): VisibleCapabilityManifest {
  assertOnlyKeys(value, ["schemaVersion", "capabilities", "portals", "count", "requestId"], "visible capability manifest");
  const requestId = boundedResponseString(value.requestId, "visible manifest requestId", 512);
  if (value.schemaVersion !== VISIBLE_CAPABILITY_SCHEMA_VERSION) {
    throw invalidResponse("visible capability manifest schema version is unsupported", requestId);
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length > 128) {
    throw invalidResponse("visible capability manifest capabilities are invalid", requestId);
  }
  if (!Array.isArray(value.portals) || value.portals.length > CAPABILITY_PORTALS.size) {
    throw invalidResponse("visible capability manifest portals are invalid", requestId);
  }
  if (!Number.isSafeInteger(value.count) || (value.count as number) < 0 || (value.count as number) > 128) {
    throw invalidResponse("visible capability manifest count is invalid", requestId);
  }
  const capabilities = value.capabilities.map((item, index) => parseCapabilitySummary(item, `capabilities[${index}]`, requestId));
  const portals = value.portals.map((item, index) => parseVisiblePortal(item, `portals[${index}]`, requestId));
  if (value.count !== capabilities.length) throw invalidResponse("visible capability manifest count is inconsistent", requestId);
  assertUnique(capabilities.map((capability) => capability.batchId), "visible capability batch identifiers", requestId);
  assertUnique(portals.map((portal) => portal.id), "visible capability portal identifiers", requestId);
  for (const portal of portals) {
    const projected = capabilities.filter((capability) => capability.portalId === portal.id);
    if (projected.length !== portal.capabilityCount) {
      throw invalidResponse(`visible portal ${portal.id} capability count is inconsistent`, requestId);
    }
    const projectedSkills = new Set(projected.map((capability) => capability.skill));
    if (portal.skills.some((skill) => !projectedSkills.has(skill)) || projected.some((capability) => !portal.skills.includes(capability.skill))) {
      throw invalidResponse(`visible portal ${portal.id} skills are inconsistent`, requestId);
    }
  }
  if (capabilities.some((capability) => !portals.some((portal) => portal.id === capability.portalId))) {
    throw invalidResponse("visible capability references a missing portal", requestId);
  }
  return Object.freeze({
    schemaVersion: VISIBLE_CAPABILITY_SCHEMA_VERSION,
    capabilities: Object.freeze(capabilities),
    portals: Object.freeze(portals),
    count: capabilities.length,
    requestId,
  });
}

function parseCapabilitySummary(value: unknown, label: string, requestId?: string): CapabilitySummary {
  if (!isObject(value)) throw invalidResponse(`${label} must be an object`, requestId);
  assertOnlyKeys(
    value,
    ["batchId", "skill", "operation", "permission", "portalId", "mode", "requirements", "requiresExternalEvidence"],
    label,
    requestId,
  );
  const batchId = boundedResponseString(value.batchId, `${label}.batchId`, 4, requestId);
  if (!BATCH_ID.test(batchId)) throw invalidResponse(`${label}.batchId is invalid`, requestId);
  const operation = boundedResponseString(value.operation, `${label}.operation`, 160, requestId);
  if (!/^[a-z][A-Za-z0-9.-]*$/.test(operation)) throw invalidResponse(`${label}.operation is invalid`, requestId);
  if (typeof value.portalId !== "string" || !CAPABILITY_PORTALS.has(value.portalId as CapabilityPortalId)) {
    throw invalidResponse(`${label}.portalId is invalid`, requestId);
  }
  if (typeof value.mode !== "string" || !CAPABILITY_MODES.has(value.mode as CapabilityMode)) {
    throw invalidResponse(`${label}.mode is invalid`, requestId);
  }
  if (!Array.isArray(value.requirements) || value.requirements.length !== 5) {
    throw invalidResponse(`${label}.requirements must contain exactly five entries`, requestId);
  }
  const requirements = value.requirements.map((requirement, index) => boundedResponseString(
    requirement,
    `${label}.requirements[${index}]`,
    1_024,
    requestId,
  ));
  if (typeof value.requiresExternalEvidence !== "boolean") {
    throw invalidResponse(`${label}.requiresExternalEvidence must be boolean`, requestId);
  }
  return Object.freeze({
    batchId,
    skill: boundedResponseString(value.skill, `${label}.skill`, 256, requestId),
    operation,
    permission: boundedResponseString(value.permission, `${label}.permission`, 160, requestId),
    portalId: value.portalId as CapabilityPortalId,
    mode: value.mode as CapabilityMode,
    requirements: Object.freeze(requirements),
    requiresExternalEvidence: value.requiresExternalEvidence,
  });
}

function parseVisiblePortal(value: unknown, label: string, requestId: string): VisibleCapabilityPortal {
  if (!isObject(value)) throw invalidResponse(`${label} must be an object`, requestId);
  assertOnlyKeys(value, ["id", "skills", "capabilityCount"], label, requestId);
  if (typeof value.id !== "string" || !CAPABILITY_PORTALS.has(value.id as CapabilityPortalId)) {
    throw invalidResponse(`${label}.id is invalid`, requestId);
  }
  if (!Array.isArray(value.skills) || value.skills.length === 0 || value.skills.length > 22) {
    throw invalidResponse(`${label}.skills are invalid`, requestId);
  }
  const skills = value.skills.map((skill, index) => boundedResponseString(skill, `${label}.skills[${index}]`, 256, requestId));
  assertUnique(skills, `${label}.skills`, requestId);
  if (!Number.isSafeInteger(value.capabilityCount) || (value.capabilityCount as number) < 1 || (value.capabilityCount as number) > 128) {
    throw invalidResponse(`${label}.capabilityCount is invalid`, requestId);
  }
  return Object.freeze({ id: value.id as CapabilityPortalId, skills: Object.freeze(skills), capabilityCount: value.capabilityCount as number });
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string, requestId?: string): void {
  const expected = new Set(allowed);
  if (Object.keys(value).some((key) => !expected.has(key))) throw invalidResponse(`${label} contains an unknown field`, requestId);
}

function boundedResponseString(value: unknown, label: string, maximum: number, requestId?: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalidResponse(`${label} must be a bounded non-empty string`, requestId);
  }
  return value;
}

function assertUnique(values: readonly string[], label: string, requestId?: string): void {
  if (new Set(values).size !== values.length) throw invalidResponse(`${label} must be unique`, requestId);
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
  if (typeof value !== "string" || value.length === 0 || value.length > 160 || !/^[a-z][A-Za-z0-9.-]*$/.test(value)) {
    throw new Error(`${label} must be a bounded operation name`);
  }
}

function serializePlainJsonInput(value: unknown): string {
  validatePlainJsonInput(value);
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new TypeError("input must be a serializable plain JSON object", { cause: error });
  }
}

function validatePlainJsonInput(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("input must be a plain JSON object");
  }
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (entry: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > 100_000 || depth > 64) throw new TypeError("input exceeds JSON structural limits");
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new TypeError(`input ${path} must be a finite JSON number`);
      return;
    }
    if (typeof entry !== "object") throw new TypeError(`input ${path} is not a JSON value`);
    if (seen.has(entry)) throw new TypeError("input must not contain cycles");
    seen.add(entry);
    try {
      if (Array.isArray(entry)) {
        if (Object.getPrototypeOf(entry) !== Array.prototype || Object.getOwnPropertySymbols(entry).length > 0) {
          throw new TypeError(`input ${path} contains a non-plain array`);
        }
        const keys = Object.keys(entry);
        if (keys.some((key) => !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= entry.length) || keys.length !== entry.length) {
          throw new TypeError(`input ${path} contains a sparse or extended array`);
        }
        for (let index = 0; index < entry.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
          if (descriptor === undefined || !("value" in descriptor)) throw new TypeError(`input ${path}[${index}] contains an accessor`);
          visit(descriptor.value, `${path}[${index}]`, depth + 1);
        }
        return;
      }
      if (Object.getPrototypeOf(entry) !== Object.prototype || Object.getOwnPropertySymbols(entry).length > 0) {
        throw new TypeError(`input ${path} must contain only plain objects`);
      }
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(entry))) {
        if (key === "__proto__" || key === "prototype" || key === "constructor") {
          throw new TypeError(`input ${path} contains an unsafe property name`);
        }
        if (!("value" in descriptor)) throw new TypeError(`input ${path}.${key} contains an accessor`);
        visit(descriptor.value, `${path}.${key}`, depth + 1);
      }
    } finally {
      seen.delete(entry);
    }
  };
  visit(value, "input", 0);
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
