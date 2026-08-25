import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { canonicalJson, fingerprint, jsonObject, sha256 } from "./canonical.js";
import { resolveConsentPolicy, verifyConsentPolicyCatalog } from "./consent-policy.js";
import {
  authorityScopeCoversConsent,
  consentScopeAllows,
  deriveRecordConsentRequirementScope,
  normalizeConsentRequirementScope,
  normalizeConsentScope,
  participantEvidenceScope,
} from "./consent-scope.js";
import { evidenceScopeAllowed, validateTrustedEvidenceKey, verifyExternalEvidenceSignature } from "./evidence.js";
import { DomainError } from "./errors.js";
import {
  assertExternalCommandTransition,
  assertExternalCommandRequestCorrelation,
  externalCommandRequestIdentity,
  isExternalCommandTerminal,
  normalizeApplyExternalBusinessEventInput,
  normalizeExternalBusinessAggregateTarget,
  normalizeExternalBusinessReduction,
  normalizeTransitionExternalCommandInput,
} from "./external-business-events.js";
import { authorize as enforceAuthorization, hasPermission, validateContext } from "./policy.js";
import {
  hasExactTenantIsolationPolicySet,
  POSTGRES_TENANT_TABLES,
  type PostgresPolicyCatalogRow,
} from "./postgres-policy-contract.js";
import {
  RIGHTS_REQUEST_COLLECTION,
  applyRightsReview,
  applyRightsTaskReceipt,
  createRightsRequestData,
  escalateRightsRequestData,
  normalizeRightsSubmission,
  parseRightsRequestRecord,
  projectRightsRequest,
  rightsAuthorityScope,
  rightsTaskEvidenceScope,
} from "./rights-requests.js";
import type {
  EscalateRightsRequestInput,
  ListRightsRequestsInput,
  NormalizedRightsSubmission,
  ReviewRightsRequestInput,
  RightsAuthorityDecision,
  RightsRequestData,
  RightsRequestProjection,
  RightsTaskReceiptInput,
  SubmitRightsRequestInput,
} from "./rights-requests.js";
import type {
  AccountBalance,
  ActorContext,
  AppliedExternalBusinessEvent,
  ApplyExternalBusinessEventInput,
  AppendAuditInput,
  AuditEntry,
  AuditVerification,
  AuthorizationResource,
  BackupVerification,
  ConsentRecord,
  ConsentPolicyCatalogMetadata,
  ConsentRequirement,
  ConsentRequirementScope,
  ConsentScope,
  CreateExternalCommandInput,
  CreateRecordInput,
  CreatedExternalCommand,
  DeadLetterExternalCommandInput,
  DeleteRecordInput,
  EvidenceEnvironment,
  EvidenceGatedMutationResult,
  ExecuteEvidenceGatedMutationInput,
  ExternalBusinessReduction,
  ExternalCommandRecord,
  ExternalCommandState,
  GrantParticipantAuthorityInput,
  GrantConsentInput,
  IdempotentResult,
  InboxEvent,
  JsonObject,
  LedgerLine,
  LedgerTransaction,
  LifeTimeMachineRuntimePort,
  ListShareGrantCommandBindingsInput,
  ListRecordsInput,
  OutboxEvent,
  OutboxPublisher,
  OutboxStatus,
  PostgresRuntimeOptions,
  PostLedgerInput,
  ParticipantAuthorityCapacity,
  ParticipantAuthorityRecord,
  ParticipantRecord,
  ReadinessResult,
  ReceiveInboxInput,
  RegisterExternalEvidenceInput,
  RegisterParticipantInput,
  RegisteredExternalEvidence,
  RecordEnvelope,
  RevokeExternalEvidenceInput,
  RevokeParticipantAuthorityInput,
  RevokeParticipantInput,
  RuntimeClock,
  ShareGrantCommandAccess,
  ShareGrantCommandBinding,
  SignedExternalEvidence,
  TrustedEvidenceKey,
  TransitionExternalCommandInput,
  UpdateRecordInput,
  WithdrawConsentInput,
} from "./types.js";
import type { TrustedConsentPolicyKey, VerifiedConsentPolicyCatalog } from "./consent-policy.js";

type DbRow = Record<string, unknown>;

const SYSTEM_CLOCK: RuntimeClock = { now: () => new Date() };
const GENESIS_HASH = "0".repeat(64);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COLLECTION = /^[a-z][a-z0-9_.-]{0,79}$/;
const CURRENCY = /^[A-Z]{3}$/;
const ACCOUNT_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const REQUIRED_SCHEMA_VERSION = "5";
const TENANT_TABLES = POSTGRES_TENANT_TABLES;

function token(value: string, label: string, pattern: RegExp = IDENTIFIER): string {
  const normalized = value.trim();
  if (!pattern.test(normalized)) {
    throw new DomainError("VALIDATION_FAILED", `${label} has an invalid format`);
  }
  return normalized;
}

function assertShareGrantCommand(command: ExternalCommandRecord): void {
  const valid = command.batchId === "B10" && (
    (command.operation === "publishExport" && command.aggregateCollection === "sharing.export-commands") ||
    (command.operation === "revokeExport" && command.aggregateCollection === "sharing.export-revoke-commands")
  );
  if (!valid) {
    throw new DomainError("RESOURCE_NOT_FOUND", "Share grant command was not found");
  }
}

function assertShareGrantOwnerAccess(
  context: ActorContext,
  record: RecordEnvelope,
  access: ShareGrantCommandAccess,
): void {
  if (record.ownerActorId === null) {
    throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Share grant is missing its persisted owner");
  }
  if (record.ownerActorId !== context.actorId && !hasPermission(context, `share-grant:${access}:any`)) {
    throw new DomainError("AUTH_FORBIDDEN", "Share grant access is restricted to its owner or an explicit administrator");
  }
}

function textValue(value: string, label: string, maximum = 500): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new DomainError("VALIDATION_FAILED", `${label} must contain between 1 and ${maximum} characters`);
  }
  return normalized;
}

function idempotencyKey(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new DomainError("VALIDATION_FAILED", "Idempotency key must contain 1-200 visible characters");
  }
  return normalized;
}

function isoTimestamp(value: string | undefined, label: string): string {
  if (value === undefined) throw new DomainError("VALIDATION_FAILED", `${label} is required`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be a valid timestamp`);
  }
  return parsed.toISOString();
}

function positiveLimit(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) {
    throw new DomainError("VALIDATION_FAILED", `Limit must be an integer between 1 and ${maximum}`);
  }
  return result;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new DomainError("CONFIGURATION_INVALID", `${label} must be between ${minimum} and ${maximum}`);
  }
  return result;
}

function rowString(row: DbRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new DomainError("INTERNAL_ERROR", `Stored ${key} is invalid`);
  return value;
}

function rowNullableString(row: DbRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new DomainError("INTERNAL_ERROR", `Stored ${key} is invalid`);
  return value;
}

function rowBoolean(row: DbRow, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new DomainError("INTERNAL_ERROR", `Stored ${key} is invalid`);
  return value;
}

function rowInteger(row: DbRow, key: string): number {
  const value = row[key];
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) throw new DomainError("INTERNAL_ERROR", `Stored ${key} exceeds the safe integer range`);
  return parsed;
}

function rowTimestamp(row: DbRow, key: string): string {
  const value = row[key];
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === "string") return isoTimestamp(value, `stored ${key}`);
  throw new DomainError("INTERNAL_ERROR", `Stored ${key} is invalid`);
}

function rowNullableTimestamp(row: DbRow, key: string): string | null {
  return row[key] === null ? null : rowTimestamp(row, key);
}

function rowJsonObject(row: DbRow, key: string): JsonObject {
  return jsonObject(row[key], `stored ${key}`);
}

function rowStringArray(row: DbRow, key: string): readonly string[] {
  const value = row[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new DomainError("INTERNAL_ERROR", `Stored ${key} is invalid`);
  }
  return value;
}

function recordFromRow<T extends JsonObject>(row: DbRow): RecordEnvelope<T> {
  return {
    id: rowString(row, "id"),
    tenantId: rowString(row, "tenant_id"),
    collection: rowString(row, "collection"),
    processingPurpose: rowString(row, "processing_purpose"),
    ownerActorId: rowNullableString(row, "owner_actor_id"),
    participantIds: rowStringArray(row, "participant_ids"),
    containsMinor: rowBoolean(row, "contains_minor"),
    data: rowJsonObject(row, "data") as T,
    version: rowInteger(row, "version"),
    createdAt: rowTimestamp(row, "created_at"),
    updatedAt: rowTimestamp(row, "updated_at"),
    deletedAt: rowNullableTimestamp(row, "deleted_at"),
  };
}

function consentFromRow(row: DbRow): ConsentRecord {
  const capacity = rowString(row, "grantor_capacity");
  const status = rowString(row, "status");
  if (!["self", "guardian", "authorized_agent"].includes(capacity) ||
      !["active", "expired", "withdrawn", "disputed", "superseded"].includes(status)) {
    throw new DomainError("INTERNAL_ERROR", "Stored consent state is invalid");
  }
  return {
    id: rowString(row, "id"),
    tenantId: rowString(row, "tenant_id"),
    participantId: rowString(row, "participant_id"),
    grantorActorId: rowString(row, "grantor_actor_id"),
    grantorCapacity: capacity as ConsentRecord["grantorCapacity"],
    purpose: rowString(row, "purpose"),
    scope: normalizeConsentScope(rowJsonObject(row, "scope"), "stored consent scope"),
    policyVersion: rowString(row, "policy_version"),
    policyCatalogSha256: rowNullableString(row, "policy_catalog_sha256"),
    jurisdiction: rowNullableString(row, "jurisdiction"),
    locale: rowNullableString(row, "locale"),
    status: status as ConsentRecord["status"],
    evidenceHash: rowString(row, "evidence_hash"),
    isMinor: rowBoolean(row, "is_minor"),
    grantedAt: rowTimestamp(row, "granted_at"),
    expiresAt: rowNullableTimestamp(row, "expires_at"),
    withdrawnAt: rowNullableTimestamp(row, "withdrawn_at"),
    version: rowInteger(row, "version"),
  };
}

function participantFromRow(row: DbRow): ParticipantRecord {
  const minorStatus = rowString(row, "minor_status");
  const status = rowString(row, "status");
  if (!(["adult", "minor"] as const).includes(minorStatus as "adult" | "minor") ||
      !(["active", "revoked"] as const).includes(status as "active" | "revoked")) {
    throw new DomainError("INTERNAL_ERROR", "Stored participant registry state is invalid");
  }
  return {
    tenantId: rowString(row, "tenant_id"),
    participantId: rowString(row, "participant_id"),
    ownerActorId: rowString(row, "owner_actor_id"),
    minorStatus: minorStatus as ParticipantRecord["minorStatus"],
    status: status as ParticipantRecord["status"],
    evidenceId: rowString(row, "evidence_id"),
    evidenceScope: rowString(row, "evidence_scope"),
    registeredAt: rowTimestamp(row, "registered_at"),
    expiresAt: rowTimestamp(row, "expires_at"),
    revokedAt: rowNullableTimestamp(row, "revoked_at"),
    revocationReason: rowNullableString(row, "revocation_reason"),
    revocationEvidenceId: rowNullableString(row, "revocation_evidence_id"),
    revocationEvidenceScope: rowNullableString(row, "revocation_evidence_scope"),
    version: rowInteger(row, "version"),
  };
}

function participantAuthorityFromRow(row: DbRow, capacity: ParticipantAuthorityCapacity): ParticipantAuthorityRecord {
  const status = rowString(row, "status");
  if (!(["active", "revoked", "superseded"] as const).includes(status as ParticipantAuthorityRecord["status"])) {
    throw new DomainError("INTERNAL_ERROR", "Stored participant authority state is invalid");
  }
  return {
    tenantId: rowString(row, "tenant_id"),
    authorizationId: rowString(row, "authorization_id"),
    authorizedActorId: rowString(row, "authorized_actor_id"),
    participantId: rowString(row, "participant_id"),
    capacity,
    status: status as ParticipantAuthorityRecord["status"],
    scope: normalizeConsentScope(rowJsonObject(row, "scope"), "stored authority scope"),
    evidenceId: rowString(row, "evidence_id"),
    evidenceScope: rowString(row, "evidence_scope"),
    grantedAt: rowTimestamp(row, "granted_at"),
    expiresAt: rowTimestamp(row, "expires_at"),
    revokedAt: rowNullableTimestamp(row, "revoked_at"),
    revocationReason: rowNullableString(row, "revocation_reason"),
    revocationEvidenceId: rowNullableString(row, "revocation_evidence_id"),
    revocationEvidenceScope: rowNullableString(row, "revocation_evidence_scope"),
    version: rowInteger(row, "version"),
  };
}

function inboxFromRow(row: DbRow): InboxEvent {
  const status = rowString(row, "status");
  if (!["received", "processed", "rejected"].includes(status)) {
    throw new DomainError("INTERNAL_ERROR", "Stored inbox status is invalid");
  }
  return {
    id: rowString(row, "id"),
    tenantId: rowString(row, "tenant_id"),
    source: rowString(row, "source"),
    sourceEventId: rowString(row, "source_event_id"),
    eventType: rowString(row, "event_type"),
    payload: rowJsonObject(row, "payload"),
    status: status as InboxEvent["status"],
    receivedAt: rowTimestamp(row, "received_at"),
    processedAt: rowNullableTimestamp(row, "processed_at"),
  };
}

function outboxFromRow(row: DbRow): OutboxEvent {
  const status = rowString(row, "status");
  if (!["pending", "leased", "published", "dead"].includes(status)) {
    throw new DomainError("INTERNAL_ERROR", "Stored outbox status is invalid");
  }
  return {
    id: rowString(row, "id"),
    tenantId: rowString(row, "tenant_id"),
    aggregateType: rowString(row, "aggregate_type"),
    aggregateId: rowString(row, "aggregate_id"),
    eventType: rowString(row, "event_type"),
    payload: rowJsonObject(row, "payload"),
    status: status as OutboxStatus,
    attempts: rowInteger(row, "attempts"),
    availableAt: rowTimestamp(row, "available_at"),
    leaseOwner: rowNullableString(row, "lease_owner"),
    leaseUntil: rowNullableTimestamp(row, "lease_until"),
    createdAt: rowTimestamp(row, "created_at"),
    publishedAt: rowNullableTimestamp(row, "published_at"),
    lastError: rowNullableString(row, "last_error"),
  };
}

function auditFromRow(row: DbRow): AuditEntry {
  return {
    sequence: rowInteger(row, "sequence"),
    id: rowString(row, "id"),
    tenantId: rowString(row, "tenant_id"),
    actorId: rowString(row, "actor_id"),
    action: rowString(row, "action"),
    resourceType: rowString(row, "resource_type"),
    resourceId: rowString(row, "resource_id"),
    purpose: rowString(row, "purpose"),
    requestId: rowString(row, "request_id"),
    details: rowJsonObject(row, "details"),
    previousHash: rowString(row, "previous_hash"),
    hash: rowString(row, "hash"),
    createdAt: rowTimestamp(row, "created_at"),
  };
}

function evidenceFromRow(row: DbRow): RegisteredExternalEvidence {
  const environment = rowString(row, "environment");
  const replayPolicy = rowString(row, "replay_policy");
  const status = rowString(row, "status");
  if (!["test", "sandbox", "staging", "production"].includes(environment) ||
      !["reusable", "single_use"].includes(replayPolicy) ||
      !["verified", "revoked"].includes(status)) {
    throw new DomainError("INTERNAL_ERROR", "Stored external evidence state is invalid");
  }
  const canonicalClaimsSha256 = rowNullableString(row, "canonical_claims_sha256");
  const businessEventSha256 = rowNullableString(row, "business_event_sha256");
  return {
    version: "ltm.external-evidence.v1",
    evidenceId: rowString(row, "id"),
    tenantId: rowString(row, "tenant_id"),
    issuer: rowString(row, "issuer"),
    provider: rowString(row, "provider"),
    environment: environment as EvidenceEnvironment,
    scope: rowString(row, "scope"),
    artifactSha256: rowString(row, "artifact_sha256"),
    ...(canonicalClaimsSha256 === null ? {} : { canonicalClaimsSha256 }),
    ...(businessEventSha256 === null ? {} : { businessEventSha256 }),
    issuedAt: rowTimestamp(row, "issued_at"),
    expiresAt: rowTimestamp(row, "expires_at"),
    nonce: rowString(row, "nonce"),
    replayPolicy: replayPolicy as RegisteredExternalEvidence["replayPolicy"],
    algorithm: "Ed25519",
    keyId: rowString(row, "key_id"),
    signature: rowString(row, "signature"),
    status: status as RegisteredExternalEvidence["status"],
    versionNumber: rowInteger(row, "version_number"),
    verifiedAt: rowTimestamp(row, "verified_at"),
    revokedAt: rowNullableTimestamp(row, "revoked_at"),
    revocationReason: rowNullableString(row, "revocation_reason"),
    consumedAt: rowNullableTimestamp(row, "consumed_at"),
    consumptionKeyHash: rowNullableString(row, "consumption_key_hash"),
  };
}

function externalCommandFromRow(row: DbRow): ExternalCommandRecord {
  const batchId = rowString(row, "batch_id");
  const state = rowString(row, "state");
  const decisionState = rowString(row, "decision_state");
  const reconciliationState = rowString(row, "reconciliation_state");
  if (!/^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(batchId) ||
      !["requested", "dispatched", "acknowledged", "succeeded", "failed", "cancelled", "compensated"].includes(state) ||
      (decisionState !== "active" && decisionState !== "frozen") ||
      (reconciliationState !== "clear" && reconciliationState !== "reconciliation_required")) {
    throw new DomainError("INTERNAL_ERROR", "Stored external command state is invalid");
  }
  return {
    commandId: rowString(row, "command_id"),
    tenantId: rowString(row, "tenant_id"),
    batchId: batchId as `B${string}`,
    operation: rowString(row, "operation"),
    aggregateCollection: rowString(row, "aggregate_collection"),
    aggregateId: rowString(row, "aggregate_id"),
    state: state as ExternalCommandState,
    providerOperationId: rowNullableString(row, "provider_operation_id"),
    evidenceId: rowNullableString(row, "evidence_id"),
    decisionState,
    reconciliationState,
    version: rowInteger(row, "version"),
    requestedAt: rowTimestamp(row, "requested_at"),
    updatedAt: rowTimestamp(row, "updated_at"),
    terminalAt: rowNullableTimestamp(row, "terminal_at"),
    details: rowJsonObject(row, "details"),
  };
}

function verifyAuditRows(rows: readonly DbRow[]): AuditVerification {
  let previousHash = GENESIS_HASH;
  let checked = 0;
  for (const row of rows) {
    const entry = auditFromRow(row);
    const expected = sha256(canonicalJson({
      id: entry.id,
      tenantId: entry.tenantId,
      actorId: entry.actorId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      purpose: entry.purpose,
      requestId: entry.requestId,
      details: entry.details,
      previousHash: entry.previousHash,
      createdAt: entry.createdAt,
    }));
    if (entry.previousHash !== previousHash || entry.hash !== expected) {
      return { valid: false, entriesChecked: checked, invalidSequence: entry.sequence };
    }
    previousHash = entry.hash;
    checked += 1;
  }
  return { valid: true, entriesChecked: checked, invalidSequence: null };
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Real PostgreSQL implementation. Every tenant query runs in a transaction with SET LOCAL app.tenant_id. */
export class PostgresLifeTimeMachineRuntime implements LifeTimeMachineRuntimePort {
  readonly backend = "postgresql" as const;
  readonly #pool: Pool;
  readonly #clock: RuntimeClock;
  readonly #trustedEvidenceKeys: readonly TrustedEvidenceKey[];
  readonly #evidencePolicy: "disabled" | "development" | "production";
  readonly #evidenceEnvironment: EvidenceEnvironment;
  readonly #evidenceClockSkewMs: number;
  readonly #maxEvidenceLifetimeMs: number;
  readonly #consentPolicyCatalog: VerifiedConsentPolicyCatalog | null;
  readonly #trustedConsentPolicyKeys: readonly TrustedConsentPolicyKey[];
  readonly #consentPolicyJurisdiction: string | null;
  readonly #consentPolicyLocale: string | null;
  readonly #allowLegacyConsentPolicy: boolean;
  #closed = false;

  private constructor(options: PostgresRuntimeOptions) {
    const connectionString = textValue(options.connectionString, "PostgreSQL connection string", 4_096);
    let url: URL;
    try {
      url = new URL(connectionString);
    } catch {
      throw new DomainError("CONFIGURATION_INVALID", "connectionString must be a valid PostgreSQL URL");
    }
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new DomainError("CONFIGURATION_INVALID", "connectionString must use postgres:// or postgresql://");
    }
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#trustedEvidenceKeys = [...(options.trustedEvidenceKeys ?? [])];
    this.#evidencePolicy = options.evidencePolicy ?? (this.#trustedEvidenceKeys.length > 0 ? "development" : "disabled");
    this.#evidenceEnvironment = options.evidenceEnvironment ??
      (this.#evidencePolicy === "production" ? "production" : "sandbox");
    this.#evidenceClockSkewMs = boundedInteger(
      options.evidenceClockSkewMs,
      300_000,
      0,
      900_000,
      "evidenceClockSkewMs",
    );
    this.#maxEvidenceLifetimeMs = boundedInteger(
      options.maxEvidenceLifetimeMs,
      30 * 24 * 60 * 60 * 1_000,
      60_000,
      366 * 24 * 60 * 60 * 1_000,
      "maxEvidenceLifetimeMs",
    );
    this.#validateEvidenceTrustConfiguration();
    this.#trustedConsentPolicyKeys = [...(options.trustedConsentPolicyKeys ?? [])];
    this.#allowLegacyConsentPolicy = options.allowLegacyConsentPolicy === true;
    const hasCatalog = options.consentPolicyCatalog !== undefined;
    const hasTrust = this.#trustedConsentPolicyKeys.length > 0;
    const hasJurisdiction = options.consentPolicyJurisdiction !== undefined;
    const hasLocale = options.consentPolicyLocale !== undefined;
    const hasCompletePolicy = hasCatalog && hasTrust && hasJurisdiction && hasLocale;
    if ((hasCatalog || hasTrust || hasJurisdiction || hasLocale) && !hasCompletePolicy) {
      throw new DomainError(
        "CONFIGURATION_INVALID",
        "Consent policy catalog, trust keys, jurisdiction, and locale must be configured together",
      );
    }
    const isProductionRuntime = this.#evidencePolicy === "production" || this.#evidenceEnvironment === "production";
    if (this.#allowLegacyConsentPolicy && (hasCompletePolicy || isProductionRuntime)) {
      throw new DomainError(
        "CONFIGURATION_INVALID",
        "Legacy consent policy mode is test-only and cannot be combined with a verified or production policy",
      );
    }
    if (isProductionRuntime && !hasCompletePolicy) {
      throw new DomainError(
        "CONFIGURATION_INVALID",
        "Production requires a signed consent policy catalog, trust keys, jurisdiction, and locale",
      );
    }
    this.#consentPolicyCatalog = hasCompletePolicy
      ? verifyConsentPolicyCatalog(
          options.consentPolicyCatalog,
          this.#trustedConsentPolicyKeys,
          this.#evidenceEnvironment,
          this.#clock.now().toISOString(),
        )
      : null;
    this.#consentPolicyJurisdiction = hasCompletePolicy
      ? textValue(options.consentPolicyJurisdiction!, "consent policy jurisdiction", 32)
      : null;
    this.#consentPolicyLocale = hasCompletePolicy
      ? textValue(options.consentPolicyLocale!, "consent policy locale", 16)
      : null;
    if ((this.#consentPolicyJurisdiction !== null &&
         !/^(?:GLOBAL|[A-Z]{2}(?:-[A-Z0-9]{1,8})*)$/.test(this.#consentPolicyJurisdiction)) ||
        (this.#consentPolicyLocale !== null && !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(this.#consentPolicyLocale))) {
      throw new DomainError("CONFIGURATION_INVALID", "Consent policy jurisdiction or locale is not canonical");
    }
    this.#pool = new Pool({
      connectionString,
      application_name: textValue(options.applicationName ?? "ltm-api", "applicationName", 63),
      max: boundedInteger(options.poolMax, 10, 1, 100, "poolMax"),
      connectionTimeoutMillis: boundedInteger(
        options.connectionTimeoutMs,
        5_000,
        100,
        60_000,
        "connectionTimeoutMs",
      ),
      idleTimeoutMillis: boundedInteger(options.idleTimeoutMs, 30_000, 1_000, 600_000, "idleTimeoutMs"),
      statement_timeout: boundedInteger(
        options.statementTimeoutMs,
        15_000,
        1_000,
        120_000,
        "statementTimeoutMs",
      ),
    });
    // Idle clients can emit transient pool errors. Keep the mandatory listener
    // to prevent an unhandled EventEmitter error; readiness always performs a
    // fresh database contract probe so a transient error cannot poison it.
    this.#pool.on("error", () => undefined);
  }

  static async connect(options: PostgresRuntimeOptions): Promise<PostgresLifeTimeMachineRuntime> {
    const runtime = new PostgresLifeTimeMachineRuntime(options);
    try {
      await runtime.#assertDatabaseContract();
      return runtime;
    } catch (error) {
      await runtime.#pool.end().catch(() => undefined);
      runtime.#closed = true;
      if (error instanceof DomainError) throw error;
      throw new DomainError("DEPENDENCY_UNAVAILABLE", "PostgreSQL runtime initialization failed", {
        retryable: true,
        details: { cause: error instanceof Error ? error.name : "unknown" },
      });
    }
  }

  currentTime(): Date {
    this.#assertOpen();
    return new Date(this.#clock.now().getTime());
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pool.end();
  }

  async createVerifiedBackup(_destinationPathValue: string): Promise<BackupVerification> {
    throw new DomainError(
      "EXTERNAL_ADAPTER_UNAVAILABLE",
      "PostgreSQL backups require the deployment backup adapter and independent restore verification",
    );
  }

  async readiness(): Promise<ReadinessResult> {
    if (this.#closed) {
      return { ready: false, database: "error", auditChain: "error", evidenceTrust: "error", consentPolicy: "error" };
    }
    try {
      await this.#assertDatabaseContract();
      const now = this.#now();
      const hasActiveTrust = this.#trustedEvidenceKeys.some((key) =>
        key.allowedEnvironments.includes(this.#evidenceEnvironment) &&
        (key.notBefore === undefined || key.notBefore <= now) &&
        (key.notAfter === undefined || key.notAfter >= now));
      const evidenceTrust = this.#evidencePolicy === "disabled" ? "disabled" : hasActiveTrust ? "ok" : "error";
      const consentPolicy = this.#consentPolicyReadiness(now);
      return {
        ready: evidenceTrust !== "error" && consentPolicy !== "error",
        database: "ok",
        auditChain: "ok",
        evidenceTrust,
        consentPolicy,
      };
    } catch {
      return { ready: false, database: "error", auditChain: "error", evidenceTrust: "error", consentPolicy: "error" };
    }
  }

  authorize(context: ActorContext, action: string, resource: AuthorizationResource = {}): void {
    this.#assertOpen();
    enforceAuthorization(context, textValue(action, "action", 160), resource);
  }

  getConsentPolicyCatalogMetadata(context: ActorContext): ConsentPolicyCatalogMetadata {
    this.authorize(context, "consent-policy:publish", { tenantId: context.tenantId });
    const catalog = this.#requiredActiveConsentPolicy(this.#now());
    if (this.#consentPolicyJurisdiction === null || this.#consentPolicyLocale === null) {
      throw new DomainError("CONFIGURATION_INVALID", "Verified consent policy location is unavailable");
    }
    return {
      schemaVersion: "ltm.consent-policy-catalog-metadata.v1",
      catalogId: catalog.document.catalogId,
      issuer: catalog.document.issuer,
      environment: catalog.document.environment as Exclude<EvidenceEnvironment, "test">,
      catalogSha256: catalog.sha256,
      issuedAt: catalog.document.issuedAt,
      expiresAt: catalog.document.expiresAt,
      jurisdiction: this.#consentPolicyJurisdiction,
      locale: this.#consentPolicyLocale,
      policyVersions: [...catalog.policies.keys()].sort(),
    };
  }

  async registerExternalEvidence(
    context: ActorContext,
    input: RegisterExternalEvidenceInput,
  ): Promise<IdempotentResult<RegisteredExternalEvidence>> {
    this.authorize(context, "evidence:register", { tenantId: context.tenantId });
    const evidence = this.#validateSignedEvidence(context, input.evidence);
    const key = idempotencyKey(input.idempotencyKey);
    return this.#idempotent(context, key, "evidence.register", evidence, async (client) => {
      const replayLocks = [
        `evidence-id\n${context.tenantId}\n${evidence.evidenceId}`,
        `evidence-nonce\n${context.tenantId}\n${evidence.issuer}\n${evidence.provider}\n${evidence.nonce}`,
      ].sort();
      for (const replayLock of replayLocks) await this.#advisoryLock(client, replayLock);
      const duplicate = await client.query(
        `SELECT id FROM ltm.external_evidence
         WHERE tenant_id = $1 AND (id = $2 OR (issuer = $3 AND provider = $4 AND nonce = $5)) LIMIT 1`,
        [context.tenantId, evidence.evidenceId, evidence.issuer, evidence.provider, evidence.nonce],
      );
      if (duplicate.rows[0] !== undefined) {
        throw new DomainError("EVIDENCE_REPLAY_DETECTED", "Evidence ID or nonce has already been registered", {
          details: { evidenceId: rowString(duplicate.rows[0] as DbRow, "id") },
        });
      }
      const verifiedAt = this.#now();
      await client.query(
        `INSERT INTO ltm.external_evidence(
          tenant_id, id, envelope_version, issuer, provider, environment, scope, artifact_sha256,
          canonical_claims_sha256,business_event_sha256,issued_at, expires_at, nonce, replay_policy,
          algorithm, key_id, signature,status, version, verified_at, revoked_at, revocation_reason
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'verified',1,$18,NULL,NULL)`,
        [
          context.tenantId,
          evidence.evidenceId,
          evidence.version,
          evidence.issuer,
          evidence.provider,
          evidence.environment,
          evidence.scope,
          evidence.artifactSha256,
          evidence.canonicalClaimsSha256 ?? null,
          evidence.businessEventSha256 ?? null,
          evidence.issuedAt,
          evidence.expiresAt,
          evidence.nonce,
          evidence.replayPolicy,
          evidence.algorithm,
          evidence.keyId,
          evidence.signature,
          verifiedAt,
        ],
      );
      const registered = await this.#requiredEvidence(client, context.tenantId, evidence.evidenceId);
      await this.#appendAuditInternal(client, context, {
        action: "evidence.registered",
        resourceType: "external_evidence",
        resourceId: evidence.evidenceId,
        details: {
          issuer: evidence.issuer,
          provider: evidence.provider,
          environment: evidence.environment,
          scope: evidence.scope,
          artifactSha256: evidence.artifactSha256,
          expiresAt: evidence.expiresAt,
          replayPolicy: evidence.replayPolicy,
          keyId: evidence.keyId,
        },
      });
      await this.#emitOutbox(client, context.tenantId, "external_evidence", evidence.evidenceId, "external_evidence.registered", {
        evidenceId: evidence.evidenceId,
        issuer: evidence.issuer,
        provider: evidence.provider,
        environment: evidence.environment,
        scope: evidence.scope,
        artifactSha256: evidence.artifactSha256,
        expiresAt: evidence.expiresAt,
      });
      return registered;
    });
  }

  async requireExternalEvidence(
    context: ActorContext,
    scopeValue: string,
    evidenceIds: readonly string[],
  ): Promise<readonly RegisteredExternalEvidence[]> {
    this.#assertOpen();
    validateContext(context);
    const requirement = this.#normalizeEvidenceRequirement(scopeValue, evidenceIds);
    return this.#transaction(
      context,
      (client) => this.#requireExternalEvidenceInternal(client, context, requirement.scope, requirement.ids),
    );
  }

  async executeEvidenceGatedMutation(
    context: ActorContext,
    input: ExecuteEvidenceGatedMutationInput,
  ): Promise<EvidenceGatedMutationResult> {
    validateContext(context);
    const requirement = this.#normalizeEvidenceRequirement(input.scope, input.evidenceIds);
    const key = idempotencyKey(input.idempotencyKey);
    const action = textValue(input.audit.action, "capability audit action", 160);
    const actionMatch = /^capability\.(B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7]))\.(execute|transition)$/.exec(action);
    const expectedAuditKind = input.mutation.kind === "record.transition" ? "transition" : "execute";
    if (actionMatch === null || actionMatch[2] !== expectedAuditKind) {
      throw new DomainError("VALIDATION_FAILED", "Capability audit action does not match the mutation kind");
    }
    const replayAction = input.audit.replayAction === undefined
      ? undefined
      : textValue(input.audit.replayAction, "capability replay audit action", 160);
    if (replayAction !== undefined && replayAction !== `capability.${actionMatch[1]}.transition-replayed`) {
      throw new DomainError("VALIDATION_FAILED", "Capability replay audit action does not match the mutation");
    }
    if (input.mutation.kind !== "ledger.post") {
      const mutationBatchId = input.mutation.kind === "external-command.create"
        ? input.mutation.input.batchId
        : input.mutation.input.data.batchId;
      if (mutationBatchId !== undefined && mutationBatchId !== actionMatch[1]) {
        throw new DomainError("VALIDATION_FAILED", "Capability audit batch does not match the mutation batch");
      }
    }
    const details = jsonObject(input.audit.details ?? {}, "capability audit details");
    const normalized: ExecuteEvidenceGatedMutationInput = {
      scope: requirement.scope,
      evidenceIds: requirement.ids,
      idempotencyKey: key,
      mutation: input.mutation,
      audit: { action, ...(replayAction === undefined ? {} : { replayAction }), details },
    };
    const operation = `evidence-gated.mutate:${normalized.mutation.kind}`;
    const requestFingerprint = fingerprint(operation, normalized);
    return this.#transaction(context, async (client) => {
      await this.#requireExternalEvidenceInternal(client, context, requirement.scope, requirement.ids);
      const result = await this.#idempotentValueInternal(
        client,
        context,
        key,
        operation,
        requestFingerprint,
        () => this.#applyEvidenceGatedMutation(client, context, normalized),
      );
      return result.replayed
        ? { ...result.value, replayed: true } as EvidenceGatedMutationResult
        : result.value;
    });
  }

  async getExternalEvidence(context: ActorContext, evidenceIdValue: string): Promise<RegisteredExternalEvidence> {
    this.authorize(context, "evidence:read", { tenantId: context.tenantId });
    const evidenceId = token(evidenceIdValue, "external evidence ID");
    return this.#transaction(context, (client) => this.#requiredEvidence(client, context.tenantId, evidenceId));
  }

  async listExternalEvidence(
    context: ActorContext,
    options: { readonly scope?: string; readonly limit?: number } = {},
  ): Promise<readonly RegisteredExternalEvidence[]> {
    this.authorize(context, "evidence:read", { tenantId: context.tenantId });
    const limit = positiveLimit(options.limit, 50, 200);
    const scope = options.scope === undefined ? undefined : textValue(options.scope, "external evidence scope", 512);
    return this.#transaction(context, async (client) => {
      const result = scope === undefined
        ? await client.query(
            `${this.#evidenceSelectSql()}
             WHERE e.tenant_id = $1 ORDER BY e.verified_at DESC, e.id LIMIT $2`,
            [context.tenantId, limit],
          )
        : await client.query(
            `${this.#evidenceSelectSql()}
             WHERE e.tenant_id = $1 AND e.scope = $2 ORDER BY e.verified_at DESC, e.id LIMIT $3`,
            [context.tenantId, scope, limit],
          );
      return result.rows.map((row) => evidenceFromRow(row as DbRow));
    });
  }

  async revokeExternalEvidence(
    context: ActorContext,
    input: RevokeExternalEvidenceInput,
  ): Promise<IdempotentResult<RegisteredExternalEvidence>> {
    const evidenceId = token(input.evidenceId, "external evidence ID");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) {
      throw new DomainError("VALIDATION_FAILED", "expectedVersion must be a positive integer");
    }
    const reason = textValue(input.reason, "evidence revocation reason", 500);
    const key = idempotencyKey(input.idempotencyKey);
    this.authorize(context, "evidence:revoke", { tenantId: context.tenantId, sensitive: true });
    return this.#idempotent(
      context,
      key,
      "evidence.revoke",
      { evidenceId, expectedVersion: input.expectedVersion, reason },
      async (client) => {
        const current = await this.#requiredEvidence(client, context.tenantId, evidenceId, true);
        if (current.status === "revoked") {
          throw new DomainError("EVIDENCE_REVOKED", "External evidence is already revoked");
        }
        const revokedAt = this.#now();
        const result = await client.query(
          `UPDATE ltm.external_evidence SET status = 'revoked', version = version + 1,
             revoked_at = $1, revocation_reason = $2
           WHERE tenant_id = $3 AND id = $4 AND status = 'verified' AND version = $5`,
          [revokedAt, reason, context.tenantId, evidenceId, input.expectedVersion],
        );
        if (result.rowCount !== 1) {
          throw new DomainError("VERSION_CONFLICT", "External evidence version changed", {
            details: { evidenceId, expectedVersion: input.expectedVersion },
          });
        }
        const revoked = await this.#requiredEvidence(client, context.tenantId, evidenceId);
        await this.#appendAuditInternal(client, context, {
          action: "evidence.revoked",
          resourceType: "external_evidence",
          resourceId: evidenceId,
          details: { reason, version: revoked.versionNumber },
        });
        await this.#emitOutbox(client, context.tenantId, "external_evidence", evidenceId, "external_evidence.revoked", {
          evidenceId,
          revokedAt,
        });
        await this.#projectEvidenceRevocation(client, context, evidenceId, reason, revokedAt);
        return revoked;
      },
    );
  }

  async createExternalCommand<T extends JsonObject>(
    context: ActorContext,
    input: CreateExternalCommandInput<T>,
  ): Promise<IdempotentResult<CreatedExternalCommand<T>>> {
    const collection = token(input.record.collection, "collection", COLLECTION);
    const id = token(input.record.id ?? randomUUID(), "record ID");
    const commandId = token(input.commandId ?? randomUUID(), "command ID");
    const batchId = token(input.batchId, "batchId", /^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/) as `B${string}`;
    const operation = token(input.operation, "operation");
    const ownerActorId = input.record.ownerActorId === undefined ? context.actorId : input.record.ownerActorId;
    const participantIds = this.#participantIds(input.record.participantIds ?? []);
    const containsMinor = input.record.containsMinor ?? false;
    const processingPurpose = this.#processingPurposeForCreate(context, input.record.processingPurpose);
    const requestedData = jsonObject(input.record.data, "record data") as T;
    const data = jsonObject({
      ...requestedData,
      externalCommandId: commandId,
      commandState: "requested",
      executionState: "requested",
    }, "external command record data") as T;
    const details = jsonObject(input.details ?? {}, "external command details");
    const key = idempotencyKey(input.idempotencyKey);
    this.authorize(context, "record:create", { tenantId: context.tenantId, ownerActorId, containsMinor });
    this.#protectMinorSharing(context, collection, containsMinor);
    return this.#idempotent(
      context,
      key,
      `external-command.create:${collection}`,
      {
        requestedRecordId: input.record.id ?? null,
        requestedCommandId: input.commandId ?? null,
        batchId,
        operation,
        collection,
        processingPurpose,
        ownerActorId,
        participantIds,
        containsMinor,
        data,
        details,
      },
      async (client) => {
        const locks = [
          `external-command\n${context.tenantId}\n${commandId}`,
          `record\n${context.tenantId}\n${collection}\n${id}`,
        ].sort();
        for (const lock of locks) await this.#advisoryLock(client, lock);
        await this.#requireParticipantConsent(
          client,
          context,
          participantIds,
          processingPurpose,
          deriveRecordConsentRequirementScope(collection, id, data, "create"),
        );
        if (await this.#selectRecord(client, context.tenantId, collection, id, true, true) !== undefined) {
          throw new DomainError("VERSION_CONFLICT", "External command aggregate already exists");
        }
        const now = this.#now();
        await client.query(
          `INSERT INTO ltm.records(
            tenant_id,collection,id,processing_purpose,owner_actor_id,participant_ids,contains_minor,data,
            version,created_at,updated_at,deleted_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,1,$9,$9,NULL)`,
          [
            context.tenantId,
            collection,
            id,
            processingPurpose,
            ownerActorId,
            participantIds,
            containsMinor,
            canonicalJson(data),
            now,
          ],
        );
        const record = await this.#requiredRecord<T>(client, context.tenantId, collection, id, true);
        const command = await this.#insertRequestedExternalCommand(
          client,
          context,
          { commandId, batchId, operation, aggregateCollection: collection, aggregateId: id, details },
          now,
        );
        await this.#appendAuditInternal(client, context, {
          action: "external_command.created",
          resourceType: collection,
          resourceId: id,
          details: { commandId, batchId, operation, recordVersion: record.version },
        });
        await this.#emitOutbox(client, context.tenantId, collection, id, `${collection}.created`, {
          record: jsonObject(record),
        });
        return { record, command };
      },
    );
  }

  async transitionExternalCommand(
    context: ActorContext,
    input: TransitionExternalCommandInput,
  ): Promise<IdempotentResult<ExternalCommandRecord>> {
    this.#authorizeServiceOperation(context, "external-command:transition");
    const normalized = normalizeTransitionExternalCommandInput(input);
    if (normalized.toState !== "dispatched" && normalized.toState !== "acknowledged") {
      throw new DomainError(
        "AUTH_FORBIDDEN",
        "Delivery workers may only mark external commands dispatched or acknowledged",
      );
    }
    return this.#idempotent(
      context,
      normalized.idempotencyKey,
      "external-command.transition",
      normalized,
      async (client) => this.#transitionExternalCommandInternal(client, context, normalized, randomUUID()),
    );
  }

  async getExternalCommand(context: ActorContext, commandIdValue: string): Promise<ExternalCommandRecord> {
    this.authorize(context, "external-command:read", { tenantId: context.tenantId });
    const commandId = token(commandIdValue, "command ID");
    return this.#transaction(context, (client) => this.#requiredExternalCommand(client, context.tenantId, commandId));
  }

  async getShareGrantCommandBinding(
    context: ActorContext,
    commandIdValue: string,
    access: ShareGrantCommandAccess,
  ): Promise<ShareGrantCommandBinding> {
    validateContext(context);
    const commandId = token(commandIdValue, "command ID");
    return this.#transaction(context, async (client) => {
      const command = await this.#requiredExternalCommand(client, context.tenantId, commandId);
      assertShareGrantCommand(command);
      const record = await this.#requiredRecord(client, context.tenantId, command.aggregateCollection, command.aggregateId, false);
      assertShareGrantOwnerAccess(context, record, access);
      return {
        command,
        record,
        sharingConsentActive: await this.#hasParticipantConsent(
          client,
          context,
          record.participantIds,
          "sharing",
          deriveRecordConsentRequirementScope(record.collection, record.id, record.data, "read"),
        ),
      };
    });
  }

  async listShareGrantCommandBindings(
    context: ActorContext,
    input: ListShareGrantCommandBindingsInput = {},
  ): Promise<readonly ShareGrantCommandBinding[]> {
    validateContext(context);
    const limit = positiveLimit(input.limit, 50, 200);
    const cursor = input.cursor === undefined ? "" : token(input.cursor, "cursor");
    return this.#transaction(context, async (client) => {
      const parameters: unknown[] = [context.tenantId, "sharing.export-commands", cursor];
      const conditions = ["tenant_id=$1", "collection=$2", "id>$3", "deleted_at IS NULL"];
      if (!hasPermission(context, "share-grant:read:any")) {
        parameters.push(context.actorId);
        conditions.push(`owner_actor_id=$${parameters.length}`);
      }
      parameters.push(limit);
      const result = await client.query(
        `SELECT * FROM ltm.records WHERE ${conditions.join(" AND ")} ORDER BY id LIMIT $${parameters.length}`,
        parameters,
      );
      const bindings: ShareGrantCommandBinding[] = [];
      for (const raw of result.rows) {
        const record = recordFromRow(raw as DbRow);
        assertShareGrantOwnerAccess(context, record, "read");
        const storedCommandId = record.data.externalCommandId;
        if (typeof storedCommandId !== "string") {
          throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Share grant record is missing its command binding");
        }
        const command = await this.#requiredExternalCommand(
          client,
          context.tenantId,
          token(storedCommandId, "stored command ID"),
        );
        assertShareGrantCommand(command);
        if (command.operation !== "publishExport" || command.aggregateCollection !== "sharing.export-commands" ||
            command.aggregateId !== record.id) {
          throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Share grant list binding is invalid");
        }
        bindings.push({
          command,
          record,
          sharingConsentActive: await this.#hasParticipantConsent(
            client,
            context,
            record.participantIds,
            "sharing",
            deriveRecordConsentRequirementScope(record.collection, record.id, record.data, "read"),
          ),
        });
      }
      return bindings;
    });
  }

  async applyExternalBusinessEvent(
    context: ActorContext,
    input: ApplyExternalBusinessEventInput,
  ): Promise<IdempotentResult<AppliedExternalBusinessEvent>> {
    this.#authorizeServiceOperation(context, "external-event:apply");
    const normalized = normalizeApplyExternalBusinessEventInput(input);
    const event = normalized.event;
    if (event.tenantId !== context.tenantId) {
      throw new DomainError("TENANT_SCOPE_MISMATCH", "Business event tenant does not match the service tenant");
    }
    if (Date.parse(event.providerOccurredAt) > this.#clock.now().getTime() + this.#evidenceClockSkewMs) {
      throw new DomainError("VALIDATION_FAILED", "Business event providerOccurredAt is in the future");
    }
    const evidence = this.#validateSignedEvidence(context, normalized.evidence);
    this.#assertBusinessEvidenceBinding(event, evidence);
    const idempotentPayload = { event, evidence, reducerName: normalized.reducer.name };
    return this.#idempotent(
      context,
      normalized.idempotencyKey,
      "external-event.apply",
      idempotentPayload,
      async (client) => {
        await this.#advisoryLock(client, `external-event\n${context.tenantId}\n${event.provider}\n${event.eventId}`);
        const eventFingerprint = fingerprint("external-event.apply.event", idempotentPayload);
        const prior = await client.query(
          `SELECT event_fingerprint,result_json FROM ltm.external_business_events
           WHERE tenant_id=$1 AND provider=$2 AND event_id=$3`,
          [context.tenantId, event.provider, event.eventId],
        );
        const priorRow = prior.rows[0] as DbRow | undefined;
        if (priorRow !== undefined) {
          if (rowString(priorRow, "event_fingerprint") !== eventFingerprint) {
            throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Provider event ID was reused with different business facts");
          }
          return { value: priorRow.result_json as AppliedExternalBusinessEvent, replayed: true };
        }

        await this.#registerBusinessEvidence(client, context, evidence);
        const inboxEvent = await this.#receiveBusinessInbox(client, context, event);
        const registeredEvidence = await this.#requiredEvidence(client, context.tenantId, evidence.evidenceId, true);
        await this.#consumeBusinessEvidence(client, context, registeredEvidence, event);

        const target = normalizeExternalBusinessAggregateTarget(normalized.reducer.locate(event));
        const aggregateLocks = [
          `record\n${context.tenantId}\n${target.collection}\n${target.aggregateId}`,
          ...target.relatedRecords.map((selector) =>
            `record\n${context.tenantId}\n${selector.collection}\n${selector.id}`),
        ].sort();
        for (const lock of aggregateLocks) await this.#advisoryLock(client, lock);
        const currentRow = await this.#selectRecord(
          client,
          context.tenantId,
          target.collection,
          target.aggregateId,
          true,
          true,
        );
        const current = currentRow === undefined ? null : recordFromRow(currentRow);
        const relatedRecords: Record<string, RecordEnvelope | null> = {};
        for (const selector of target.relatedRecords) {
          const selected = await client.query(
            `SELECT * FROM ltm.records
             WHERE tenant_id=$1 AND collection=$2 AND id=$3 AND deleted_at IS NULL
             ${selector.lock === "update" ? "FOR UPDATE" : "FOR SHARE"}`,
            [context.tenantId, selector.collection, selector.id],
          );
          const row = selected.rows[0] as DbRow | undefined;
          if (row === undefined && selector.required) {
            throw new DomainError("RESOURCE_NOT_FOUND", "Required reducer fact record was not found", {
              details: { key: selector.key, collection: selector.collection, id: selector.id },
            });
          }
          relatedRecords[selector.key] = row === undefined ? null : recordFromRow(row);
        }
        const reduction = normalizeExternalBusinessReduction(
          normalized.reducer.reduce(event, { current, relatedRecords }),
        );
        const previousState = this.#externalAggregateState(current, reduction.stateField);
        if (!reduction.allowedPriorStates.includes(previousState)) {
          throw new DomainError("VERSION_CONFLICT", "External business transition is illegal", {
            details: { previousState: previousState ?? "absent", nextState: reduction.nextState },
          });
        }
        if (current?.data._externalDecisionState === "frozen") {
          throw new DomainError("EVIDENCE_REVOKED", "The aggregate is frozen pending reconciliation");
        }
        this.#assertExternalEventOrder(current, event);
        const aggregate = await this.#persistExternalAggregate(client, context, target, reduction, current, event);
        const ledgerTransaction = reduction.ledger === undefined
          ? null
          : await this.#postExternalBusinessLedger(client, context, reduction.ledger);
        const command = reduction.commandTransition === undefined
          ? null
          : await this.#transitionExternalCommandFromBusinessEvent(client, context, event, {
              commandId: reduction.commandTransition.commandId,
              batchId: event.batchId,
              operation: event.operation,
              aggregateCollection: target.collection,
              aggregateId: target.aggregateId,
              toState: reduction.commandTransition.toState,
              ...(reduction.commandTransition.providerOperationId === undefined
                ? {}
                : { providerOperationId: reduction.commandTransition.providerOperationId }),
              evidenceId: reduction.commandTransition.evidenceId ?? event.evidenceId,
              ...(reduction.commandTransition.details === undefined
                ? {}
                : { details: reduction.commandTransition.details }),
              idempotencyKey: `external-event:${event.provider}:${event.eventId}`,
            });
        const finalAggregate = command === null
          ? aggregate
          : await this.#requiredRecord(client, context.tenantId, target.collection, target.aggregateId, true);
        const appliedAt = this.#now();
        await client.query(
          `INSERT INTO ltm.evidence_decisions(
            tenant_id,evidence_id,decision_type,decision_id,aggregate_collection,aggregate_id,
            decision_state,reconciliation_state,created_at,updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,'active','clear',$7,$7)`,
          [
            context.tenantId,
            evidence.evidenceId,
            reduction.decisionType,
            reduction.decisionId,
            target.collection,
            target.aggregateId,
            appliedAt,
          ],
        );
        const inboxUpdated = await client.query(
          `UPDATE ltm.inbox SET status='processed',processed_at=$1
           WHERE tenant_id=$2 AND id=$3 AND status='received'`,
          [appliedAt, context.tenantId, inboxEvent.id],
        );
        if (inboxUpdated.rowCount !== 1) {
          throw new DomainError("VERSION_CONFLICT", "Business inbox event was not in received state");
        }
        const result: AppliedExternalBusinessEvent = {
          eventId: event.eventId,
          provider: event.provider,
          inboxEventId: inboxEvent.id,
          aggregate: finalAggregate,
          previousState,
          nextState: reduction.nextState,
          decisionType: reduction.decisionType,
          decisionId: reduction.decisionId,
          command,
          ledgerTransaction,
          appliedAt,
        };
        await client.query(
          `INSERT INTO ltm.external_business_events(
            tenant_id,provider,event_id,inbox_event_id,event_fingerprint,batch_id,operation,
            subject_type,subject_id,event_type,provider_occurred_at,provider_sequence,correlation_id,
            artifact_sha256,evidence_id,evidence_scope,canonical_claims,canonical_claims_sha256,
            business_event_sha256,reducer_name,aggregate_collection,aggregate_id,prior_state,next_state,
            result_json,applied_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,$26)`,
          [
            context.tenantId,
            event.provider,
            event.eventId,
            inboxEvent.id,
            eventFingerprint,
            event.batchId,
            event.operation,
            event.subjectType,
            event.subjectId,
            event.eventType,
            event.providerOccurredAt,
            event.sequence,
            event.correlationId,
            event.artifactSha256,
            event.evidenceId,
            event.evidenceScope,
            canonicalJson(event.canonicalClaims),
            event.canonicalClaimsSha256,
            event.businessEventSha256,
            normalized.reducer.name,
            target.collection,
            target.aggregateId,
            previousState,
            reduction.nextState,
            canonicalJson(result),
            appliedAt,
          ],
        );
        await this.#appendAuditInternal(client, context, {
          action: "external_business_event.applied",
          resourceType: target.collection,
          resourceId: target.aggregateId,
          details: {
            provider: event.provider,
            eventId: event.eventId,
            eventType: event.eventType,
            evidenceId: event.evidenceId,
            reducer: normalized.reducer.name,
            previousState,
            nextState: reduction.nextState,
          },
        });
        await this.#emitOutbox(
          client,
          context.tenantId,
          target.collection,
          target.aggregateId,
          `${target.collection}.external_business_event_applied`,
          {
            eventId: event.eventId,
            provider: event.provider,
            eventType: event.eventType,
            businessEventSha256: event.businessEventSha256,
            evidenceId: event.evidenceId,
            record: jsonObject(finalAggregate),
          },
        );
        return result;
      },
    );
  }

  async createRecord<T extends JsonObject>(
    context: ActorContext,
    input: CreateRecordInput<T>,
  ): Promise<IdempotentResult<RecordEnvelope<T>>> {
    const collection = token(input.collection, "collection", COLLECTION);
    this.#assertGenericRecordCollection(collection);
    const id = token(input.id ?? randomUUID(), "record ID");
    const ownerActorId = input.ownerActorId === undefined ? context.actorId : input.ownerActorId;
    const participantIds = this.#participantIds(input.participantIds ?? []);
    const containsMinor = input.containsMinor ?? false;
    const processingPurpose = this.#processingPurposeForCreate(context, input.processingPurpose);
    const data = jsonObject(input.data, "record data") as T;
    const key = idempotencyKey(input.idempotencyKey);
    this.authorize(context, "record:create", { tenantId: context.tenantId, ownerActorId, containsMinor });
    this.#protectMinorSharing(context, collection, containsMinor);
    return this.#idempotent(
      context,
      key,
      `record.create:${collection}`,
      { requestedId: input.id ?? null, processingPurpose, ownerActorId, participantIds, containsMinor, data },
      async (client) => {
        await this.#requireParticipantConsent(
          client,
          context,
          participantIds,
          processingPurpose,
          deriveRecordConsentRequirementScope(collection, id, data, "create"),
        );
        const existing = await this.#selectRecord(client, context.tenantId, collection, id, true);
        if (existing !== undefined) {
          throw new DomainError("VERSION_CONFLICT", "A record with this ID already exists", {
            details: { collection, id },
          });
        }
        const now = this.#now();
        await client.query(
          `INSERT INTO ltm.records(
            tenant_id, collection, id, processing_purpose, owner_actor_id, participant_ids, contains_minor,
            data, version, created_at, updated_at, deleted_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,1,$9,$9,NULL)`,
          [context.tenantId, collection, id, processingPurpose, ownerActorId, participantIds, containsMinor, canonicalJson(data), now],
        );
        const record = await this.#requiredRecord<T>(client, context.tenantId, collection, id, true);
        await this.#appendAuditInternal(client, context, {
          action: "record.created",
          resourceType: collection,
          resourceId: id,
          details: { version: record.version },
        });
        await this.#emitOutbox(client, context.tenantId, collection, id, `${collection}.created`, {
          record: jsonObject(record),
        });
        return record;
      },
    );
  }

  async getRecord<T extends JsonObject>(
    context: ActorContext,
    collectionValue: string,
    idValue: string,
  ): Promise<RecordEnvelope<T>> {
    const collection = token(collectionValue, "collection", COLLECTION);
    this.#assertGenericRecordCollection(collection);
    const id = token(idValue, "record ID");
    validateContext(context);
    return this.#transaction(context, async (client) => {
      const record = await this.#requiredRecord<T>(client, context.tenantId, collection, id, false);
      this.authorize(context, "record:read", record);
      await this.#assertRecordProcessingPurpose(client, context, record, "read");
      await this.#requireParticipantConsent(
        client,
        context,
        record.participantIds,
        record.processingPurpose,
        deriveRecordConsentRequirementScope(record.collection, record.id, record.data, "read"),
      );
      return record;
    });
  }

  async listRecords<T extends JsonObject>(
    context: ActorContext,
    input: ListRecordsInput,
  ): Promise<readonly RecordEnvelope<T>[]> {
    const collection = token(input.collection, "collection", COLLECTION);
    this.#assertGenericRecordCollection(collection);
    const limit = positiveLimit(input.limit, 50, 200);
    const cursor = input.cursor === undefined ? "" : token(input.cursor, "cursor");
    this.authorize(context, "record:read", { tenantId: context.tenantId });
    return this.#transaction(context, async (client) => {
      const conditions = ["tenant_id = $1", "collection = $2", "id > $3"];
      const parameters: unknown[] = [context.tenantId, collection, cursor];
      if (input.includeDeleted !== true) conditions.push("deleted_at IS NULL");
      if (context.roles.includes("consumer") && !hasPermission(context, "record:read:any")) {
        parameters.push(context.actorId);
        conditions.push(`owner_actor_id = $${parameters.length}`);
      }
      if (!hasPermission(context, "minor:data:manage") || context.guardianVerified !== true) {
        conditions.push("contains_minor = false");
      }
      parameters.push(limit);
      const result = await client.query(
        `SELECT * FROM ltm.records WHERE ${conditions.join(" AND ")} ORDER BY id LIMIT $${parameters.length}`,
        parameters,
      );
      const records = result.rows.map((row) => recordFromRow<T>(row as DbRow));
      const visible: RecordEnvelope<T>[] = [];
      for (const record of records) {
        await this.#assertRecordProcessingPurpose(client, context, record, "list");
        if (await this.#hasParticipantConsent(
          client,
          context,
          record.participantIds,
          record.processingPurpose,
          deriveRecordConsentRequirementScope(record.collection, record.id, record.data, "read"),
        )) visible.push(record);
      }
      return visible;
    });
  }

  async updateRecord<T extends JsonObject>(
    context: ActorContext,
    input: UpdateRecordInput<T>,
  ): Promise<IdempotentResult<RecordEnvelope<T>>> {
    const collection = token(input.collection, "collection", COLLECTION);
    this.#assertGenericRecordCollection(collection);
    const id = token(input.id, "record ID");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) {
      throw new DomainError("VALIDATION_FAILED", "expectedVersion must be a positive integer");
    }
    const data = jsonObject(input.data, "record data") as T;
    const key = idempotencyKey(input.idempotencyKey);
    validateContext(context);
    return this.#idempotent(
      context,
      key,
      `record.update:${collection}`,
      {
        id,
        expectedVersion: input.expectedVersion,
        ownerActorId: input.ownerActorId ?? null,
        participantIds: input.participantIds ?? null,
        containsMinor: input.containsMinor ?? null,
        data,
      },
      async (client) => {
        const current = await this.#requiredRecord<T>(client, context.tenantId, collection, id, false, true);
        const ownerActorId = input.ownerActorId === undefined ? current.ownerActorId : input.ownerActorId;
        const participantIds = this.#participantIds(input.participantIds ?? current.participantIds);
        const containsMinor = input.containsMinor ?? current.containsMinor;
        this.authorize(context, "record:update", { ...current, ownerActorId, containsMinor });
        await this.#assertRecordProcessingPurpose(client, context, current, "update");
        this.#protectMinorSharing(context, collection, containsMinor);
        await this.#requireParticipantConsent(
          client,
          context,
          participantIds,
          current.processingPurpose,
          deriveRecordConsentRequirementScope(collection, id, current.data, "update"),
        );
        await this.#requireParticipantConsent(
          client,
          context,
          participantIds,
          current.processingPurpose,
          deriveRecordConsentRequirementScope(collection, id, data, "update"),
        );
        const now = this.#now();
        const result = await client.query(
          `UPDATE ltm.records
           SET owner_actor_id=$1, participant_ids=$2, contains_minor=$3, data=$4::jsonb,
               version=version+1, updated_at=$5
           WHERE tenant_id=$6 AND collection=$7 AND id=$8 AND deleted_at IS NULL AND version=$9`,
          [
            ownerActorId,
            participantIds,
            containsMinor,
            canonicalJson(data),
            now,
            context.tenantId,
            collection,
            id,
            input.expectedVersion,
          ],
        );
        if (result.rowCount !== 1) {
          await this.#throwRecordMutationConflict(client, context.tenantId, collection, id, input.expectedVersion);
        }
        const record = await this.#requiredRecord<T>(client, context.tenantId, collection, id, false);
        await this.#appendAuditInternal(client, context, {
          action: "record.updated",
          resourceType: collection,
          resourceId: id,
          details: { previousVersion: input.expectedVersion, version: record.version },
        });
        await this.#emitOutbox(client, context.tenantId, collection, id, `${collection}.updated`, {
          record: jsonObject(record),
        });
        return record;
      },
    );
  }

  async deleteRecord(
    context: ActorContext,
    input: DeleteRecordInput,
  ): Promise<IdempotentResult<RecordEnvelope>> {
    const collection = token(input.collection, "collection", COLLECTION);
    this.#assertGenericRecordCollection(collection);
    const id = token(input.id, "record ID");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) {
      throw new DomainError("VALIDATION_FAILED", "expectedVersion must be a positive integer");
    }
    const key = idempotencyKey(input.idempotencyKey);
    validateContext(context);
    return this.#idempotent(
      context,
      key,
      `record.delete:${collection}`,
      { id, expectedVersion: input.expectedVersion },
      async (client) => {
        const current = await this.#requiredRecord(client, context.tenantId, collection, id, true, true);
        this.authorize(context, "record:delete", current);
        await this.#assertRecordProcessingPurpose(client, context, current, "delete");
        await this.#requireParticipantConsent(
          client,
          context,
          current.participantIds,
          current.processingPurpose,
          deriveRecordConsentRequirementScope(collection, id, current.data, "delete"),
        );
        const now = this.#now();
        const result = await client.query(
          `UPDATE ltm.records SET deleted_at=$1, updated_at=$1, version=version+1
           WHERE tenant_id=$2 AND collection=$3 AND id=$4 AND deleted_at IS NULL AND version=$5`,
          [now, context.tenantId, collection, id, input.expectedVersion],
        );
        if (result.rowCount !== 1) {
          await this.#throwRecordMutationConflict(client, context.tenantId, collection, id, input.expectedVersion);
        }
        const record = await this.#requiredRecord(client, context.tenantId, collection, id, true);
        await this.#appendAuditInternal(client, context, {
          action: "record.deleted",
          resourceType: collection,
          resourceId: id,
          details: { previousVersion: input.expectedVersion, version: record.version },
        });
        await this.#emitOutbox(client, context.tenantId, collection, id, `${collection}.deleted`, {
          id,
          version: record.version,
          deletedAt: record.deletedAt,
        });
        return record;
      },
    );
  }

  async registerParticipant(
    context: ActorContext,
    input: RegisterParticipantInput,
  ): Promise<IdempotentResult<ParticipantRecord>> {
    const participantId = token(input.participantId, "participant ID");
    const ownerActorId = token(input.ownerActorId, "participant owner actor ID");
    if (input.minorStatus !== "adult" && input.minorStatus !== "minor") {
      throw new DomainError("VALIDATION_FAILED", "minorStatus must be adult or minor");
    }
    const expiresAt = isoTimestamp(input.expiresAt, "participant registry expiry");
    if (input.expectedVersion !== null &&
        (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0)) {
      throw new DomainError("VALIDATION_FAILED", "expectedVersion must be null or a positive integer");
    }
    const evidenceId = token(input.evidenceId, "external evidence ID");
    const key = idempotencyKey(input.idempotencyKey);
    this.#authorizeServiceOperation(context, "participant:register");
    const mutation = {
      operation: "participant.register" as const,
      tenantId: context.tenantId,
      participantId,
      ownerActorId,
      minorStatus: input.minorStatus,
      expiresAt,
      expectedVersion: input.expectedVersion,
    };
    const evidenceScope = participantEvidenceScope(mutation);
    return this.#idempotent(context, key, "participant.register", { ...mutation, evidenceId }, async (client) => {
      await this.#advisoryLock(client, `participant\n${context.tenantId}\n${participantId}`);
      const evidence = await this.#requireIdentityMutationEvidence(client, context, evidenceScope, evidenceId);
      const now = this.#now();
      if (expiresAt <= now || expiresAt > evidence.expiresAt) {
        throw new DomainError("VALIDATION_FAILED", "Participant registry expiry must be future and evidence-bounded");
      }
      const current = await this.#selectParticipant(client, context.tenantId, participantId, true);
      if (input.expectedVersion === null) {
        if (current !== undefined) throw new DomainError("VERSION_CONFLICT", "Participant is already registered");
        await client.query(
          `INSERT INTO ltm.participants(
            tenant_id,participant_id,owner_actor_id,minor_status,status,evidence_id,evidence_scope,
            registered_at,expires_at,revoked_at,revocation_reason,revocation_evidence_id,
            revocation_evidence_scope,version
          ) VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,NULL,NULL,NULL,NULL,1)`,
          [context.tenantId, participantId, ownerActorId, input.minorStatus, evidenceId, evidenceScope, now, expiresAt],
        );
      } else {
        if (current === undefined || rowInteger(current, "version") !== input.expectedVersion) {
          throw new DomainError("VERSION_CONFLICT", "Participant registry version changed", {
            details: { participantId, expectedVersion: input.expectedVersion },
          });
        }
        await this.#withdrawActiveConsentsForParticipantAuthority(client, context, {
          participantId,
          reason: `participant_registry_replaced:${participantId}`,
          now,
        });
        const updated = await client.query(
          `UPDATE ltm.participants SET owner_actor_id=$1,minor_status=$2,status='active',evidence_id=$3,evidence_scope=$4,
             registered_at=$5,expires_at=$6,revoked_at=NULL,revocation_reason=NULL,
             revocation_evidence_id=NULL,revocation_evidence_scope=NULL,version=version+1
           WHERE tenant_id=$7 AND participant_id=$8 AND version=$9`,
          [ownerActorId, input.minorStatus, evidenceId, evidenceScope, now, expiresAt,
            context.tenantId, participantId, input.expectedVersion],
        );
        if (updated.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "Participant registry version changed");
      }
      const participant = await this.#requiredParticipant(client, context.tenantId, participantId, false);
      await this.#appendAuditInternal(client, context, {
        action: "participant.registered",
        resourceType: "participant",
        resourceId: participantId,
        details: { ownerActorId, minorStatus: input.minorStatus, evidenceId, expiresAt, version: participant.version },
      });
      await this.#emitOutbox(client, context.tenantId, "participant", participantId, "participant.registered", {
        participantId, ownerActorId, minorStatus: input.minorStatus, evidenceId, expiresAt, version: participant.version,
      });
      return participant;
    });
  }

  async revokeParticipant(
    context: ActorContext,
    input: RevokeParticipantInput,
  ): Promise<IdempotentResult<ParticipantRecord>> {
    const participantId = token(input.participantId, "participant ID");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) {
      throw new DomainError("VALIDATION_FAILED", "expectedVersion must be a positive integer");
    }
    const reason = textValue(input.reason, "participant revocation reason", 500);
    const evidenceId = token(input.evidenceId, "external evidence ID");
    const key = idempotencyKey(input.idempotencyKey);
    this.#authorizeServiceOperation(context, "participant:revoke");
    const mutation = {
      operation: "participant.revoke" as const,
      tenantId: context.tenantId,
      participantId,
      expectedVersion: input.expectedVersion,
      reason,
    };
    const evidenceScope = participantEvidenceScope(mutation);
    return this.#idempotent(context, key, "participant.revoke", { ...mutation, evidenceId }, async (client) => {
      await this.#advisoryLock(client, `participant\n${context.tenantId}\n${participantId}`);
      await this.#requireIdentityMutationEvidence(client, context, evidenceScope, evidenceId);
      const current = await this.#requiredParticipant(client, context.tenantId, participantId, true, undefined, true);
      if (current.status !== "active" || current.version !== input.expectedVersion) {
        throw new DomainError("VERSION_CONFLICT", "Participant registry version changed");
      }
      const revokedAt = this.#now();
      const updated = await client.query(
        `UPDATE ltm.participants SET status='revoked',revoked_at=$1,revocation_reason=$2,
           revocation_evidence_id=$3,revocation_evidence_scope=$4,version=version+1
         WHERE tenant_id=$5 AND participant_id=$6 AND status='active' AND version=$7`,
        [revokedAt, reason, evidenceId, evidenceScope, context.tenantId, participantId, input.expectedVersion],
      );
      if (updated.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "Participant registry version changed");
      await this.#withdrawActiveConsentsForParticipantAuthority(client, context, {
        participantId,
        reason: `participant_revoked:${reason}`,
        now: revokedAt,
      });
      const participant = await this.#requiredParticipant(client, context.tenantId, participantId, true);
      await this.#appendAuditInternal(client, context, {
        action: "participant.revoked", resourceType: "participant", resourceId: participantId,
        details: { reason, evidenceId, version: participant.version },
      });
      await this.#emitOutbox(client, context.tenantId, "participant", participantId, "participant.revoked", {
        participantId, revokedAt, evidenceId, version: participant.version,
      });
      return participant;
    });
  }

  async grantParticipantAuthority(
    context: ActorContext,
    input: GrantParticipantAuthorityInput,
  ): Promise<IdempotentResult<ParticipantAuthorityRecord>> {
    const authorizationId = token(input.authorizationId, "participant authorization ID");
    const authorizedActorId = token(input.authorizedActorId, "authorized actor ID");
    const participantId = token(input.participantId, "participant ID");
    const capacity = this.#participantAuthorityCapacity(input.capacity);
    const scope = normalizeConsentScope(jsonObject(input.scope, "participant authority scope"), "participant authority scope");
    const expiresAt = isoTimestamp(input.expiresAt, "participant authority expiry");
    const evidenceId = token(input.evidenceId, "external evidence ID");
    const key = idempotencyKey(input.idempotencyKey);
    this.#authorizeServiceOperation(context, "participant-authority:grant");
    const mutation = {
      operation: "participant-authority.grant" as const,
      tenantId: context.tenantId,
      authorizationId,
      authorizedActorId,
      participantId,
      capacity,
      scope,
      expiresAt,
    };
    const evidenceScope = participantEvidenceScope(mutation);
    return this.#idempotent(context, key, "participant-authority.grant", { ...mutation, evidenceId }, async (client) => {
      await this.#advisoryLock(client, `participant\n${context.tenantId}\n${participantId}`);
      const evidence = await this.#requireIdentityMutationEvidence(client, context, evidenceScope, evidenceId);
      const participant = await this.#requiredParticipant(client, context.tenantId, participantId, false);
      const now = this.#now();
      if (expiresAt <= now || expiresAt > evidence.expiresAt || expiresAt > participant.expiresAt) {
        throw new DomainError("VALIDATION_FAILED", "Participant authority expiry must be future and evidence/participant bounded");
      }
      if (capacity === "guardian" && participant.minorStatus !== "minor") {
        throw new DomainError("AUTH_FORBIDDEN", "Guardian authority is only valid for a registered minor");
      }
      if (capacity === "authorized_agent" && participant.minorStatus === "minor") {
        throw new DomainError("AUTH_FORBIDDEN", "A minor requires exact guardian authority");
      }
      const binding = this.#participantAuthorityStorage(capacity);
      for (const lock of [
        `participant-authority-id\n${context.tenantId}\n${capacity}\n${authorizationId}`,
        `participant-authority-actor\n${context.tenantId}\n${capacity}\n${authorizedActorId}\n${participantId}`,
      ].sort()) await this.#advisoryLock(client, lock);
      if (await this.#selectParticipantAuthority(client, context.tenantId, authorizationId, capacity, true) !== undefined) {
        throw new DomainError("VERSION_CONFLICT", "Participant authorization ID already exists");
      }
      await client.query(
        `UPDATE ltm.${binding.table} SET status='superseded',version=version+1
         WHERE tenant_id=$1 AND ${binding.actorColumn}=$2 AND participant_id=$3 AND status='active'`,
        [context.tenantId, authorizedActorId, participantId],
      );
      await this.#withdrawActiveConsentsForParticipantAuthority(client, context, {
        participantId,
        grantorActorId: authorizedActorId,
        grantorCapacity: capacity,
        reason: `participant_authority_superseded:${authorizationId}`,
        now,
      });
      await client.query(
        `INSERT INTO ltm.${binding.table}(
          tenant_id,authorization_id,${binding.actorColumn},participant_id,status,scope,
          evidence_id,evidence_scope,granted_at,expires_at,revoked_at,revocation_reason,
          revocation_evidence_id,revocation_evidence_scope,version
        ) VALUES ($1,$2,$3,$4,'active',$5::jsonb,$6,$7,$8,$9,NULL,NULL,NULL,NULL,1)`,
        [context.tenantId, authorizationId, authorizedActorId, participantId, canonicalJson(scope),
          evidenceId, evidenceScope, now, expiresAt],
      );
      const authorization = await this.#requiredParticipantAuthority(client, context.tenantId, authorizationId, capacity);
      await this.#appendAuditInternal(client, context, {
        action: "participant_authority.granted", resourceType: "participant_authority", resourceId: authorizationId,
        details: { authorizedActorId, participantId, capacity, scope: jsonObject(scope), evidenceId, expiresAt },
      });
      await this.#emitOutbox(client, context.tenantId, "participant_authority", authorizationId, "participant_authority.granted", {
        authorizationId, authorizedActorId, participantId, capacity, scope: jsonObject(scope), evidenceId, expiresAt,
      });
      return authorization;
    });
  }

  async revokeParticipantAuthority(
    context: ActorContext,
    input: RevokeParticipantAuthorityInput,
  ): Promise<IdempotentResult<ParticipantAuthorityRecord>> {
    const authorizationId = token(input.authorizationId, "participant authorization ID");
    const capacity = this.#participantAuthorityCapacity(input.capacity);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) {
      throw new DomainError("VALIDATION_FAILED", "expectedVersion must be a positive integer");
    }
    const reason = textValue(input.reason, "participant authority revocation reason", 500);
    const evidenceId = token(input.evidenceId, "external evidence ID");
    const key = idempotencyKey(input.idempotencyKey);
    this.#authorizeServiceOperation(context, "participant-authority:revoke");
    const mutation = {
      operation: "participant-authority.revoke" as const,
      tenantId: context.tenantId,
      authorizationId,
      capacity,
      expectedVersion: input.expectedVersion,
      reason,
    };
    const evidenceScope = participantEvidenceScope(mutation);
    return this.#idempotent(context, key, "participant-authority.revoke", { ...mutation, evidenceId }, async (client) => {
      const snapshot = await this.#requiredParticipantAuthority(client, context.tenantId, authorizationId, capacity);
      await this.#advisoryLock(client, `participant\n${context.tenantId}\n${snapshot.participantId}`);
      await this.#requireIdentityMutationEvidence(client, context, evidenceScope, evidenceId);
      for (const lock of [
        `participant-authority-id\n${context.tenantId}\n${capacity}\n${authorizationId}`,
        `participant-authority-actor\n${context.tenantId}\n${capacity}\n${snapshot.authorizedActorId}\n${snapshot.participantId}`,
      ].sort()) await this.#advisoryLock(client, lock);
      const current = await this.#requiredParticipantAuthority(client, context.tenantId, authorizationId, capacity, true);
      if (current.participantId !== snapshot.participantId || current.authorizedActorId !== snapshot.authorizedActorId) {
        throw new DomainError("VERSION_CONFLICT", "Participant authority binding changed");
      }
      if (current.status !== "active" || current.version !== input.expectedVersion) {
        throw new DomainError("VERSION_CONFLICT", "Participant authority version changed");
      }
      const binding = this.#participantAuthorityStorage(capacity);
      const revokedAt = this.#now();
      const updated = await client.query(
        `UPDATE ltm.${binding.table} SET status='revoked',revoked_at=$1,revocation_reason=$2,
           revocation_evidence_id=$3,revocation_evidence_scope=$4,version=version+1
         WHERE tenant_id=$5 AND authorization_id=$6 AND status='active' AND version=$7`,
        [revokedAt, reason, evidenceId, evidenceScope, context.tenantId, authorizationId, input.expectedVersion],
      );
      if (updated.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "Participant authority version changed");
      await this.#withdrawActiveConsentsForParticipantAuthority(client, context, {
        participantId: current.participantId,
        grantorActorId: current.authorizedActorId,
        grantorCapacity: capacity,
        reason: `participant_authority_revoked:${authorizationId}:${reason}`,
        now: revokedAt,
      });
      const authorization = await this.#requiredParticipantAuthority(client, context.tenantId, authorizationId, capacity);
      await this.#appendAuditInternal(client, context, {
        action: "participant_authority.revoked", resourceType: "participant_authority", resourceId: authorizationId,
        details: { capacity, reason, evidenceId, version: authorization.version },
      });
      await this.#emitOutbox(client, context.tenantId, "participant_authority", authorizationId, "participant_authority.revoked", {
        authorizationId, capacity, revokedAt, evidenceId, version: authorization.version,
      });
      return authorization;
    });
  }

  async grantConsent(
    context: ActorContext,
    input: GrantConsentInput,
  ): Promise<IdempotentResult<ConsentRecord>> {
    const id = token(input.id ?? randomUUID(), "consent ID");
    const participantId = token(input.participantId, "participant ID");
    const purpose = textValue(input.purpose, "consent purpose", 120);
    const policyVersion = token(input.policyVersion, "policy version");
    const requestedEvidenceHash = input.evidenceHash === undefined ? null : input.evidenceHash.trim().toLowerCase();
    if (requestedEvidenceHash !== null &&
        (!/^[a-f0-9]{64}$/.test(requestedEvidenceHash) || requestedEvidenceHash !== input.evidenceHash)) {
      throw new DomainError("VALIDATION_FAILED", "evidenceHash must be a canonical lowercase SHA-256 digest");
    }
    if (purpose !== context.purpose) {
      throw new DomainError("PURPOSE_REQUIRED", "Consent purpose must match the request purpose");
    }
    const scope = normalizeConsentScope(jsonObject(input.scope, "consent scope"));
    const expiresAt = input.expiresAt === undefined || input.expiresAt === null
      ? null
      : isoTimestamp(input.expiresAt, "expiresAt");
    const key = idempotencyKey(input.idempotencyKey);
    validateContext(context);
    return this.#idempotent(
      context,
      key,
      "consent.grant",
      {
        requestedId: input.id ?? null,
        participantId,
        purpose,
        scope,
        policyVersion,
        requestedEvidenceHash,
        claimedIsMinor: input.isMinor ?? null,
        expiresAt,
        policyCatalogSha256: this.#consentPolicyCatalog?.sha256 ?? null,
        jurisdiction: this.#consentPolicyJurisdiction,
        locale: this.#consentPolicyLocale,
        legacyTestPolicy: this.#allowLegacyConsentPolicy,
      },
      async (client) => {
        await this.#lockConsentLifecycle(
          client,
          context.tenantId,
          [participantId],
          purpose,
          scope.resource,
          scope.actions,
          false,
        );
        const participant = await this.#requiredParticipant(client, context.tenantId, participantId, false);
        const isMinor = participant.minorStatus === "minor";
        if (input.isMinor !== undefined && input.isMinor !== isMinor) {
          throw new DomainError(
            "VALIDATION_FAILED",
            "isMinor does not match the server-derived participant registry status",
          );
        }
        await this.#authorizeConsentGrant(client, context, participant, input.grantorCapacity, scope);
        const now = this.#now();
        let evidenceHash: string;
        let effectiveExpiresAt: string | null;
        let policyCatalogSha256: string | null;
        let jurisdiction: string | null;
        let locale: string | null;
        if (this.#allowLegacyConsentPolicy) {
          if (requestedEvidenceHash === null) {
            throw new DomainError("VALIDATION_FAILED", "Explicit legacy-test consent requires evidenceHash");
          }
          if (expiresAt !== null && (expiresAt <= now || expiresAt > participant.expiresAt)) {
            throw new DomainError("VALIDATION_FAILED", "Consent expiry must be future and participant-registry bounded");
          }
          evidenceHash = requestedEvidenceHash;
          effectiveExpiresAt = expiresAt;
          policyCatalogSha256 = null;
          jurisdiction = null;
          locale = null;
        } else {
          const catalog = this.#requiredActiveConsentPolicy(now);
          if (this.#consentPolicyJurisdiction === null || this.#consentPolicyLocale === null) {
            throw new DomainError("CONFIGURATION_INVALID", "Verified consent policy location is unavailable");
          }
          const resolved = resolveConsentPolicy(catalog, {
            policyVersion,
            purpose,
            jurisdiction: this.#consentPolicyJurisdiction,
            locale: this.#consentPolicyLocale,
            scope: jsonObject(scope, "consent scope"),
            grantorCapacity: input.grantorCapacity,
            isMinor,
            requestedExpiresAt: expiresAt,
            participantExpiresAt: participant.expiresAt,
            at: now,
          });
          if (requestedEvidenceHash !== null && requestedEvidenceHash !== resolved.disclosureSha256) {
            throw new DomainError("VALIDATION_FAILED", "evidenceHash does not match the server-resolved disclosure");
          }
          evidenceHash = resolved.disclosureSha256;
          effectiveExpiresAt = resolved.expiresAt;
          policyCatalogSha256 = resolved.catalogSha256;
          jurisdiction = resolved.jurisdiction;
          locale = resolved.locale;
        }
        const existing = await client.query(
          "SELECT id FROM ltm.consents WHERE tenant_id=$1 AND id=$2",
          [context.tenantId, id],
        );
        if (existing.rows[0] !== undefined) {
          throw new DomainError("VERSION_CONFLICT", "A consent with this ID already exists");
        }
        await client.query(
          `UPDATE ltm.consents SET status='superseded', version=version+1
           WHERE tenant_id=$1 AND participant_id=$2 AND purpose=$3 AND scope=$4::jsonb AND status='active'`,
          [context.tenantId, participantId, purpose, canonicalJson(scope)],
        );
        await client.query(
          `INSERT INTO ltm.consents(
            tenant_id,id,participant_id,grantor_actor_id,grantor_capacity,purpose,scope,
            policy_version,policy_catalog_sha256,jurisdiction,locale,status,evidence_hash,
            is_minor,granted_at,expires_at,withdrawn_at,version
          ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,'active',$12,$13,$14,$15,NULL,1)`,
          [
            context.tenantId,
            id,
            participantId,
            context.actorId,
            input.grantorCapacity,
            purpose,
            canonicalJson(scope),
            policyVersion,
            policyCatalogSha256,
            jurisdiction,
            locale,
            evidenceHash,
            isMinor,
            now,
            effectiveExpiresAt,
          ],
        );
        const consent = await this.#requiredConsent(client, context.tenantId, id);
        await this.#appendAuditInternal(client, context, {
          action: "consent.granted",
          resourceType: "consent",
          resourceId: id,
          details: { participantId, policyVersion, policyCatalogSha256, jurisdiction, locale, isMinor },
        });
        await this.#emitOutbox(client, context.tenantId, "consent", id, "consent.granted", {
          consentId: id,
          participantId,
          purpose,
          policyVersion,
          policyCatalogSha256,
          jurisdiction,
          locale,
          isMinor,
        });
        return consent;
      },
    );
  }

  async withdrawConsent(
    context: ActorContext,
    input: WithdrawConsentInput,
  ): Promise<IdempotentResult<ConsentRecord>> {
    const consentId = token(input.consentId, "consent ID");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) {
      throw new DomainError("VALIDATION_FAILED", "expectedVersion must be a positive integer");
    }
    const reason = textValue(input.reason, "withdrawal reason", 500);
    const key = idempotencyKey(input.idempotencyKey);
    validateContext(context);
    return this.#idempotent(
      context,
      key,
      "consent.withdraw",
      { consentId, expectedVersion: input.expectedVersion, reason },
      async (client) => {
        const snapshot = await this.#requiredConsent(client, context.tenantId, consentId);
        await this.#lockConsentLifecycle(
          client,
          context.tenantId,
          [snapshot.participantId],
          snapshot.purpose,
          snapshot.scope.resource,
          snapshot.scope.actions,
          false,
        );
        const current = await this.#requiredConsent(client, context.tenantId, consentId, true);
        await this.#authorizeConsentAccess(client, context, current, "withdraw");
        if (current.status !== "active") {
          throw new DomainError("CONSENT_WITHDRAWN", "Consent is no longer active");
        }
        const now = this.#now();
        const result = await client.query(
          `UPDATE ltm.consents SET status='withdrawn', withdrawn_at=$1, version=version+1
           WHERE tenant_id=$2 AND id=$3 AND status='active' AND version=$4`,
          [now, context.tenantId, consentId, input.expectedVersion],
        );
        if (result.rowCount !== 1) {
          throw new DomainError("VERSION_CONFLICT", "Consent version changed", {
            details: { consentId, expectedVersion: input.expectedVersion },
          });
        }
        const consent = await this.#requiredConsent(client, context.tenantId, consentId);
        await this.#appendAuditInternal(client, context, {
          action: "consent.withdrawn",
          resourceType: "consent",
          resourceId: consentId,
          details: { participantId: consent.participantId, reason, version: consent.version },
        });
        await this.#emitOutbox(client, context.tenantId, "consent", consentId, "consent.withdrawn", {
          consentId,
          participantId: consent.participantId,
          purpose: consent.purpose,
          withdrawnAt: consent.withdrawnAt,
        });
        await this.#closeShareExportsForWithdrawnConsent(client, context, consent, reason, now);
        return consent;
      },
    );
  }

  async #withdrawActiveConsentsForParticipantAuthority(
    client: PoolClient,
    context: ActorContext,
    options: {
      readonly participantId: string;
      readonly grantorActorId?: string;
      readonly grantorCapacity?: ParticipantAuthorityCapacity;
      readonly reason: string;
      readonly now: string;
    },
  ): Promise<void> {
    const result = await client.query(
      `SELECT * FROM ltm.consents
       WHERE tenant_id=$1 AND participant_id=$2 AND status='active'
         AND ($3::text IS NULL OR grantor_actor_id=$3)
         AND ($4::text IS NULL OR grantor_capacity=$4)
       ORDER BY granted_at,id
       FOR UPDATE`,
      [
        context.tenantId,
        options.participantId,
        options.grantorActorId ?? null,
        options.grantorCapacity ?? null,
      ],
    );
    for (const row of result.rows as DbRow[]) {
      const prior = consentFromRow(row);
      const updated = await client.query(
        `UPDATE ltm.consents SET status='withdrawn',withdrawn_at=$1,version=version+1
         WHERE tenant_id=$2 AND id=$3 AND status='active' AND version=$4`,
        [options.now, context.tenantId, prior.id, prior.version],
      );
      if (updated.rowCount !== 1) {
        throw new DomainError("VERSION_CONFLICT", "Consent changed during participant-authority lifecycle closure", {
          details: { consentId: prior.id, participantId: options.participantId },
        });
      }
      const consent = await this.#requiredConsent(client, context.tenantId, prior.id);
      await this.#appendAuditInternal(client, context, {
        action: "consent.withdrawn_by_participant_authority_lifecycle",
        resourceType: "consent",
        resourceId: consent.id,
        details: {
          participantId: consent.participantId,
          grantorActorId: consent.grantorActorId,
          grantorCapacity: consent.grantorCapacity,
          reason: options.reason,
          version: consent.version,
        },
      });
      await this.#emitOutbox(client, context.tenantId, "consent", consent.id, "consent.withdrawn", {
        consentId: consent.id,
        participantId: consent.participantId,
        purpose: consent.purpose,
        withdrawnAt: consent.withdrawnAt,
        lifecycleReason: options.reason,
      });
      await this.#closeShareExportsForWithdrawnConsent(client, context, consent, options.reason, options.now);
    }
  }

  async #closeShareExportsForWithdrawnConsent(
    client: PoolClient,
    context: ActorContext,
    consent: ConsentRecord,
    withdrawalReason: string,
    now: string,
  ): Promise<void> {
    if (consent.purpose !== "sharing") return;
    const result = await client.query(
      `SELECT r.* FROM ltm.records r
       JOIN ltm.external_commands c
         ON c.tenant_id=r.tenant_id
        AND c.aggregate_collection=r.collection
        AND c.aggregate_id=r.id
       WHERE r.tenant_id=$1 AND r.collection='sharing.export-commands' AND r.deleted_at IS NULL
         AND c.batch_id='B10' AND c.operation='publishExport' AND $2=ANY(r.participant_ids)
       ORDER BY r.id FOR UPDATE OF r,c`,
      [context.tenantId, consent.participantId],
    );
    for (const raw of result.rows) {
      const exportRecord = recordFromRow(raw as DbRow);
      const workId = exportRecord.data.workId;
      if (typeof workId !== "string" || !consentScopeAllows(consent.scope, { resource: `work:${workId}`, action: "share" })) {
        continue;
      }
      const commandId = exportRecord.data.externalCommandId;
      if (typeof commandId !== "string") {
        throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "B10 export is missing its command binding");
      }
      const exportCommand = await this.#requiredExternalCommand(
        client,
        context.tenantId,
        token(commandId, "B10 export command ID"),
        true,
      );
      if (exportCommand.batchId !== "B10" || exportCommand.operation !== "publishExport" ||
          exportCommand.aggregateCollection !== exportRecord.collection || exportCommand.aggregateId !== exportRecord.id) {
        throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "B10 export command binding is invalid");
      }
      if (exportCommand.state === "succeeded" && exportCommand.providerOperationId !== null) {
        await this.#ensureConsentWithdrawalShareRevoke(
          client,
          context,
          consent,
          withdrawalReason,
          exportRecord,
          exportCommand,
          now,
        );
      } else if (exportCommand.state === "requested" &&
          await this.#suppressPendingExternalCommandRequest(client, context.tenantId, exportCommand, now)) {
        await this.#cancelShareExportForConsentWithdrawal(client, context, consent, exportRecord, exportCommand, now);
      } else if (["requested", "dispatched", "acknowledged"].includes(exportCommand.state)) {
        await this.#freezeShareExportForConsentWithdrawal(client, context, consent, exportRecord, exportCommand, now);
      }
    }
  }

  async #suppressPendingExternalCommandRequest(
    client: PoolClient,
    tenantId: string,
    command: ExternalCommandRecord,
    now: string,
  ): Promise<boolean> {
    const result = await client.query(
      `SELECT * FROM ltm.outbox
       WHERE tenant_id=$1 AND aggregate_type=$2 AND aggregate_id=$3
         AND event_type='external_command.requested'
         AND payload #>> '{command,commandId}'=$4
       ORDER BY created_at,id FOR UPDATE`,
      [tenantId, command.aggregateCollection, command.aggregateId, command.commandId],
    );
    const row = result.rows[0] as DbRow | undefined;
    if (result.rows.length !== 1 || row === undefined || rowString(row, "status") !== "pending" ||
        rowInteger(row, "attempts") !== 0) return false;
    const updated = await client.query(
      `UPDATE ltm.outbox
       SET status='published',published_at=$1,last_error='suppressed_by_consent_withdrawal'
       WHERE tenant_id=$2 AND id=$3 AND status='pending' AND attempts=0`,
      [now, tenantId, rowString(row, "id")],
    );
    return updated.rowCount === 1;
  }

  async #cancelShareExportForConsentWithdrawal(
    client: PoolClient,
    context: ActorContext,
    consent: ConsentRecord,
    record: RecordEnvelope,
    command: ExternalCommandRecord,
    now: string,
  ): Promise<void> {
    assertExternalCommandTransition(command.state, "cancelled");
    const details = jsonObject({
      ...command.details,
      cancellationAuthority: "participant_consent_withdrawal",
      withdrawnConsentId: consent.id,
      withdrawnParticipantId: consent.participantId,
    }, "consent withdrawal cancellation details");
    const updated = await client.query(
      `UPDATE ltm.external_commands
       SET state='cancelled',version=version+1,updated_at=$1,terminal_at=$1,details=$2::jsonb
       WHERE tenant_id=$3 AND command_id=$4 AND state='requested' AND version=$5
         AND decision_state='active' AND reconciliation_state='clear'`,
      [now, canonicalJson(details), context.tenantId, command.commandId, command.version],
    );
    if (updated.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "B10 export changed during consent withdrawal");
    await client.query(
      `INSERT INTO ltm.external_command_transitions(
        tenant_id,transition_id,command_id,from_state,to_state,provider_operation_id,evidence_id,details,occurred_at
      ) VALUES ($1,$2,$3,'requested','cancelled',NULL,NULL,$4::jsonb,$5)`,
      [context.tenantId, randomUUID(), command.commandId,
        canonicalJson({ authority: "participant_consent_withdrawal", consentId: consent.id }), now],
    );
    const aggregateData = jsonObject({
      ...record.data,
      commandState: "cancelled",
      executionState: "cancelled",
      externalReceipt: { providerOperationId: null, evidenceId: null, state: "cancelled", updatedAt: now },
      consentWithdrawal: { consentId: consent.id, participantId: consent.participantId, occurredAt: now },
    }, "cancelled B10 export aggregate");
    const recordUpdate = await client.query(
      `UPDATE ltm.records SET data=$1::jsonb,version=version+1,updated_at=$2
       WHERE tenant_id=$3 AND collection=$4 AND id=$5 AND version=$6 AND deleted_at IS NULL`,
      [canonicalJson(aggregateData), now, context.tenantId, record.collection, record.id, record.version],
    );
    if (recordUpdate.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "B10 export aggregate changed during withdrawal");
    const cancelled = await this.#requiredExternalCommand(client, context.tenantId, command.commandId);
    await this.#appendAuditInternal(client, context, {
      action: "external_command.cancelled_by_consent_withdrawal",
      resourceType: record.collection,
      resourceId: record.id,
      details: { commandId: command.commandId, consentId: consent.id, participantId: consent.participantId },
    });
    await this.#emitOutbox(client, context.tenantId, record.collection, record.id, "external_command.cancelled", {
      command: jsonObject(cancelled),
    });
  }

  async #freezeShareExportForConsentWithdrawal(
    client: PoolClient,
    context: ActorContext,
    consent: ConsentRecord,
    record: RecordEnvelope,
    command: ExternalCommandRecord,
    now: string,
  ): Promise<void> {
    if (command.decisionState === "frozen" || command.reconciliationState === "reconciliation_required") return;
    const details = jsonObject({
      ...command.details,
      reconciliationReason: "participant_consent_withdrawal_with_uncertain_delivery",
      withdrawnConsentId: consent.id,
      withdrawnParticipantId: consent.participantId,
    }, "consent withdrawal reconciliation details");
    const updated = await client.query(
      `UPDATE ltm.external_commands
       SET decision_state='frozen',reconciliation_state='reconciliation_required',
           version=version+1,updated_at=$1,details=$2::jsonb
       WHERE tenant_id=$3 AND command_id=$4 AND version=$5
         AND decision_state='active' AND reconciliation_state='clear'`,
      [now, canonicalJson(details), context.tenantId, command.commandId, command.version],
    );
    if (updated.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "B10 export changed during withdrawal freeze");
    await client.query(
      `INSERT INTO ltm.external_command_transitions(
        tenant_id,transition_id,command_id,from_state,to_state,provider_operation_id,evidence_id,details,occurred_at
      ) VALUES ($1,$2,$3,$4,$4,$5,$6,$7::jsonb,$8)`,
      [context.tenantId, randomUUID(), command.commandId, command.state, command.providerOperationId,
        command.evidenceId, canonicalJson({ authority: "participant_consent_withdrawal", consentId: consent.id,
          reconciliationState: "reconciliation_required" }), now],
    );
    const aggregateData = jsonObject({
      ...record.data,
      executionState: "revocation_required",
      commandState: command.state,
      _externalDecisionState: "frozen",
      _externalReconciliationState: "reconciliation_required",
      consentWithdrawal: { consentId: consent.id, participantId: consent.participantId, occurredAt: now },
    }, "frozen B10 export aggregate");
    const recordUpdate = await client.query(
      `UPDATE ltm.records SET data=$1::jsonb,version=version+1,updated_at=$2
       WHERE tenant_id=$3 AND collection=$4 AND id=$5 AND version=$6 AND deleted_at IS NULL`,
      [canonicalJson(aggregateData), now, context.tenantId, record.collection, record.id, record.version],
    );
    if (recordUpdate.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "B10 export aggregate changed during withdrawal freeze");
    const frozen = await this.#requiredExternalCommand(client, context.tenantId, command.commandId);
    const frozenRecord = await this.#requiredRecord(client, context.tenantId, record.collection, record.id, false);
    await this.#appendAuditInternal(client, context, {
      action: "external_command.reconciliation_required",
      resourceType: record.collection,
      resourceId: record.id,
      details: { commandId: command.commandId, consentId: consent.id, participantId: consent.participantId,
        reason: "participant_consent_withdrawal_with_uncertain_delivery" },
    });
    await this.#emitOutbox(client, context.tenantId, record.collection, record.id, "external_command.reconciliation_required", {
      command: jsonObject(frozen), record: jsonObject(frozenRecord), consentId: consent.id,
    });
  }

  async #ensureConsentWithdrawalShareRevoke(
    client: PoolClient,
    context: ActorContext,
    consent: ConsentRecord,
    withdrawalReason: string,
    exportRecord: RecordEnvelope,
    exportCommand: ExternalCommandRecord,
    now: string,
  ): Promise<void> {
    const digest = createHash("sha256").update("ltm-share-revoke-v1\0").update(exportCommand.commandId).digest("hex");
    const revokeCommandId = `B10-revoke:${digest}`;
    await this.#advisoryLock(client, `external-command\n${context.tenantId}\n${revokeCommandId}`);
    const existing = await client.query(
      "SELECT command_id FROM ltm.external_commands WHERE tenant_id=$1 AND command_id=$2 FOR UPDATE",
      [context.tenantId, revokeCommandId],
    );
    if (existing.rows[0] !== undefined) {
      const revoke = await this.#requiredExternalCommand(client, context.tenantId, revokeCommandId, true);
      if (["failed", "cancelled"].includes(revoke.state)) {
        await this.#freezeShareExportForConsentWithdrawal(client, context, consent, exportRecord, exportCommand, now);
      }
      return;
    }
    const workId = exportRecord.data.workId;
    const expiresAt = exportRecord.data.expiresAt;
    if (typeof workId !== "string" || typeof expiresAt !== "string") {
      await this.#freezeShareExportForConsentWithdrawal(client, context, consent, exportRecord, exportCommand, now);
      return;
    }
    token(workId, "stored share work ID");
    isoTimestamp(expiresAt, "stored share expiry");
    const reason = `consent_withdrawn:${consent.id}:${withdrawalReason}`.slice(0, 500);
    const data = jsonObject({
      batchId: "B10", skill: "building-consumer-time-machine", operation: "revokeExport",
      operationMode: "external-command", purpose: "sharing_revocation",
      exportCommandId: exportCommand.commandId, exportRecordId: exportRecord.id,
      targetProviderOperationId: exportCommand.providerOperationId, workId, expiresAt,
      requestedByActorId: context.actorId, reason, externalCommandId: revokeCommandId,
      commandState: "requested", executionState: "requested",
    }, "automatic B10 revoke record");
    await client.query(
      `INSERT INTO ltm.records(
        tenant_id,collection,id,processing_purpose,owner_actor_id,participant_ids,contains_minor,
        data,version,created_at,updated_at,deleted_at
      ) VALUES ($1,'sharing.export-revoke-commands',$2,'sharing',$3,ARRAY[]::text[],false,$4::jsonb,1,$5,$5,NULL)`,
      [context.tenantId, revokeCommandId, exportRecord.ownerActorId, canonicalJson(data), now],
    );
    const command = await this.#insertRequestedExternalCommand(client, context, {
      commandId: revokeCommandId,
      batchId: "B10",
      operation: "revokeExport",
      aggregateCollection: "sharing.export-revoke-commands",
      aggregateId: revokeCommandId,
      details: { requestedBy: context.actorId, exportCommandId: exportCommand.commandId,
        exportRecordId: exportRecord.id, targetProviderOperationId: exportCommand.providerOperationId,
        trigger: "participant_consent_withdrawal", consentId: consent.id },
    }, now);
    const revokeRecord = await this.#requiredRecord(
      client,
      context.tenantId,
      "sharing.export-revoke-commands",
      revokeCommandId,
      true,
    );
    await this.#appendAuditInternal(client, context, {
      action: "share_grant.revocation_queued_by_consent_withdrawal",
      resourceType: exportRecord.collection,
      resourceId: exportRecord.id,
      details: { exportCommandId: exportCommand.commandId, revokeCommandId, consentId: consent.id,
        participantId: consent.participantId },
    });
    await this.#emitOutbox(client, context.tenantId, revokeRecord.collection, revokeRecord.id,
      `${revokeRecord.collection}.created`, { record: jsonObject(revokeRecord), command: jsonObject(command) });
  }

  async assertConsent(context: ActorContext, requirement: ConsentRequirement): Promise<void> {
    validateContext(context);
    await this.#transaction(context, async (client) => {
      await this.#activeConsents(client, context, requirement, false);
    });
  }

  async requireConsent(context: ActorContext, requirement: ConsentRequirement): Promise<readonly ConsentRecord[]> {
    validateContext(context);
    if (hasPermission(context, "consent:read")) {
      this.authorize(context, "consent:read", { tenantId: context.tenantId });
    } else if (!hasPermission(context, "consent:read:self")) {
      throw new DomainError("AUTH_FORBIDDEN", "Permission to inspect consent is required");
    }
    return this.#transaction(context, (client) => this.#activeConsents(client, context, requirement, true));
  }

  async listConsents(context: ActorContext, participantIdValue?: string): Promise<readonly ConsentRecord[]> {
    validateContext(context);
    const participantId = participantIdValue === undefined ? undefined : token(participantIdValue, "participant ID");
    if (!hasPermission(context, "consent:read") && !hasPermission(context, "consent:read:self")) {
      throw new DomainError("AUTH_FORBIDDEN", "Permission to inspect consent is required");
    }
    return this.#transaction(context, async (client) => {
      const conditions = ["tenant_id=$1"];
      const parameters: unknown[] = [context.tenantId];
      if (participantId !== undefined) {
        parameters.push(participantId);
        conditions.push(`participant_id=$${parameters.length}`);
      }
      const result = await client.query(
        `SELECT * FROM ltm.consents WHERE ${conditions.join(" AND ")}
         ORDER BY granted_at DESC,id DESC LIMIT 200`,
        parameters,
      );
      const consents = result.rows.map((row) => consentFromRow(row as DbRow));
      const visible: ConsentRecord[] = [];
      for (const consent of consents) {
        if (await this.#canAccessConsent(client, context, consent, "read")) visible.push(consent);
      }
      return visible;
    });
  }

  async submitRightsRequest(
    context: ActorContext,
    input: SubmitRightsRequestInput,
  ): Promise<IdempotentResult<RightsRequestProjection>> {
    this.#assertRightsPurpose(context);
    this.authorize(context, "rights-request:create", { tenantId: context.tenantId });
    const submission = normalizeRightsSubmission(input);
    const requestId = token(input.requestId ?? randomUUID(), "rights request ID");
    const key = idempotencyKey(input.idempotencyKey);
    return this.#idempotent(context, key, "rights-request.submit", {
      requestedId: input.requestId ?? null,
      submission,
    }, async (client) => {
      const participantLock = `participant\n${context.tenantId}\n${submission.participantId}`;
      if (["withdraw", "delete", "restrict_processing"].includes(submission.requestType)) {
        await this.#advisoryLock(client, participantLock);
      } else {
        await this.#advisorySharedLock(client, participantLock);
      }
      if (await this.#selectRecord(client, context.tenantId, RIGHTS_REQUEST_COLLECTION, requestId, true, true) !== undefined) {
        throw new DomainError("VERSION_CONFLICT", "Rights request ID already exists");
      }
      const now = this.#now();
      const authority = await this.#rightsAuthorityDecision(client, context, submission, now);
      const participant = await this.#requiredParticipant(client, context.tenantId, submission.participantId, false, now);
      if (submission.parentRequestId !== null) {
        const parent = await this.#requiredRightsRecord(client, context.tenantId, submission.parentRequestId, false, true);
        const parentData = parseRightsRequestRecord(parent);
        if (parentData.subjectParticipantId !== submission.participantId ||
            (parentData.status !== "completed" && parentData.status !== "denied")) {
          throw new DomainError("VALIDATION_FAILED", "Appeal parent must be a terminal request for the same participant");
        }
      }
      const data = createRightsRequestData({
        requestId,
        submission,
        requesterActorId: context.actorId,
        requesterCapacity: authority.requesterCapacity,
        discoveredAssetIds: await this.#discoverRightsAssetIds(client, context.tenantId, submission.participantId),
        now,
      });
      await client.query(
        `INSERT INTO ltm.records(
          tenant_id,collection,id,processing_purpose,owner_actor_id,participant_ids,contains_minor,
          data,version,created_at,updated_at,deleted_at
        ) VALUES ($1,$2,$3,'privacy_rights',$4,$5,$6,$7::jsonb,1,$8,$8,NULL)`,
        [
          context.tenantId,
          RIGHTS_REQUEST_COLLECTION,
          requestId,
          participant.ownerActorId,
          [submission.participantId],
          participant.minorStatus === "minor",
          canonicalJson(data),
          now,
        ],
      );
      if (["withdraw", "delete", "restrict_processing"].includes(submission.requestType)) {
        await this.#withdrawConsentsForRightsRequest(client, context, submission, requestId, now);
      }
      const record = await this.#requiredRightsRecord(client, context.tenantId, requestId, false);
      await this.#appendAuditInternal(client, context, {
        action: "rights_request.submitted",
        resourceType: RIGHTS_REQUEST_COLLECTION,
        resourceId: requestId,
        details: {
          requestType: submission.requestType,
          requesterCapacity: authority.requesterCapacity,
          requestedProcessingPurpose: submission.requestedProcessingPurpose,
          taskCount: data.tasks.length,
          dueAt: data.dueAt,
          policyVersion: data.policyVersion,
        },
      });
      for (const task of data.tasks) {
        await this.#emitOutbox(client, context.tenantId, RIGHTS_REQUEST_COLLECTION, requestId,
          "privacy.rights.task.requested", {
            requestId,
            taskId: task.taskId,
            target: task.target,
            operation: task.operation,
            assetId: task.assetId,
            requestedProcessingPurpose: submission.requestedProcessingPurpose,
            dueAt: data.dueAt,
          });
      }
      return projectRightsRequest(record, context, new Date(now));
    });
  }

  async recordRightsTaskReceipt(
    context: ActorContext,
    input: RightsTaskReceiptInput,
  ): Promise<IdempotentResult<RightsRequestProjection>> {
    this.#assertRightsPurpose(context);
    this.#authorizeServiceOperation(context, "rights-request:receipt");
    const requestId = token(input.requestId, "rights request ID");
    const taskId = token(input.taskId, "rights task ID");
    const evidenceId = token(input.evidenceId, "external evidence ID");
    const key = idempotencyKey(input.idempotencyKey);
    return this.#idempotent(context, key, "rights-request.task-receipt", {
      requestId,
      taskId,
      outcome: input.outcome,
      resultSha256: input.resultSha256,
      providerOccurredAt: input.providerOccurredAt,
      evidenceId,
      errorCode: input.errorCode ?? null,
    }, async (client) => {
      await this.#advisoryLock(client, `rights-request\n${context.tenantId}\n${requestId}`);
      const record = await this.#requiredRightsRecord(client, context.tenantId, requestId, false, true);
      const data = parseRightsRequestRecord(record);
      const task = data.tasks.find((entry) => entry.taskId === taskId);
      if (task === undefined) throw new DomainError("RESOURCE_NOT_FOUND", "Rights propagation task was not found");
      const recordedAt = this.#now();
      const applied = applyRightsTaskReceipt({
        data,
        taskId,
        outcome: input.outcome,
        resultSha256: input.resultSha256,
        evidenceId,
        providerOccurredAt: input.providerOccurredAt,
        errorCode: input.errorCode ?? null,
        recordedAt,
      });
      const scope = rightsTaskEvidenceScope({
        tenantId: context.tenantId,
        requestId,
        task,
        outcome: input.outcome,
        resultSha256: input.resultSha256,
        providerOccurredAt: input.providerOccurredAt,
        errorCode: input.errorCode ?? null,
      });
      const evidence = (await this.#requireExternalEvidenceInternal(client, context, scope, [evidenceId]))[0];
      if (evidence === undefined || evidence.replayPolicy !== "single_use" ||
          evidence.artifactSha256 !== input.resultSha256) {
        throw new DomainError(
          "EXTERNAL_EVIDENCE_UNVERIFIED",
          "Rights propagation receipts require single-use signed evidence bound to the exact result digest",
        );
      }
      const updated = await this.#replaceRightsRecordData(client, context, record, applied.data,
        "rights_request.task_receipt_recorded", {
          taskId,
          target: task.target,
          outcome: input.outcome,
          evidenceId,
          resultSha256: input.resultSha256,
        });
      await this.#emitOutbox(client, context.tenantId, RIGHTS_REQUEST_COLLECTION, requestId,
        "privacy.rights.task.receipt-recorded", {
          requestId,
          taskId,
          target: task.target,
          outcome: input.outcome,
          status: applied.data.status,
        });
      return { value: projectRightsRequest(updated, context, new Date(recordedAt)), replayed: applied.replayed };
    });
  }

  async reviewRightsRequest(
    context: ActorContext,
    input: ReviewRightsRequestInput,
  ): Promise<IdempotentResult<RightsRequestProjection>> {
    this.#assertRightsPurpose(context);
    this.authorize(context, "rights-request:review", { tenantId: context.tenantId, sensitive: true });
    const requestId = token(input.requestId, "rights request ID");
    const key = idempotencyKey(input.idempotencyKey);
    return this.#idempotent(context, key, "rights-request.review", {
      requestId,
      decision: input.decision,
      reasonCode: input.reasonCode,
      caseReference: input.caseReference,
    }, async (client) => {
      await this.#advisoryLock(client, `rights-request\n${context.tenantId}\n${requestId}`);
      const record = await this.#requiredRightsRecord(client, context.tenantId, requestId, false, true);
      const reviewedAt = this.#now();
      const applied = applyRightsReview({
        data: parseRightsRequestRecord(record),
        reviewerActorId: context.actorId,
        decision: input.decision,
        reasonCode: input.reasonCode,
        caseReference: input.caseReference,
        reviewId: `rights-review:${sha256(canonicalJson({ requestId, actorId: context.actorId, key }))}`,
        reviewedAt,
      });
      const updated = await this.#replaceRightsRecordData(client, context, record, applied.data,
        "rights_request.reviewed", {
          decision: input.decision,
          reasonCode: input.reasonCode,
          caseReference: input.caseReference,
          status: applied.data.status,
        });
      await this.#emitOutbox(client, context.tenantId, RIGHTS_REQUEST_COLLECTION, requestId,
        "privacy.rights.review.recorded", {
          requestId,
          decision: input.decision,
          status: applied.data.status,
          reviewCount: applied.data.reviews.length,
        });
      return { value: projectRightsRequest(updated, context, new Date(reviewedAt)), replayed: applied.replayed };
    });
  }

  async escalateRightsRequest(
    context: ActorContext,
    input: EscalateRightsRequestInput,
  ): Promise<IdempotentResult<RightsRequestProjection>> {
    this.#assertRightsPurpose(context);
    if (context.roles.includes("service_account")) {
      this.#authorizeServiceOperation(context, "rights-request:escalate");
    } else {
      this.authorize(context, "rights-request:escalate", { tenantId: context.tenantId, sensitive: true });
    }
    const requestId = token(input.requestId, "rights request ID");
    const key = idempotencyKey(input.idempotencyKey);
    return this.#idempotent(context, key, "rights-request.escalate", {
      requestId,
      reasonCode: input.reasonCode,
    }, async (client) => {
      await this.#advisoryLock(client, `rights-request\n${context.tenantId}\n${requestId}`);
      const record = await this.#requiredRightsRecord(client, context.tenantId, requestId, false, true);
      const data = parseRightsRequestRecord(record);
      const at = this.#now();
      this.#assertRightsEscalationReason(data, input.reasonCode, at);
      const next = escalateRightsRequestData(data, at);
      const updated = await this.#replaceRightsRecordData(client, context, record, next,
        "rights_request.escalated", { reasonCode: input.reasonCode });
      await this.#emitOutbox(client, context.tenantId, RIGHTS_REQUEST_COLLECTION, requestId,
        "privacy.rights.escalated", { requestId, reasonCode: input.reasonCode, escalatedAt: next.escalatedAt });
      return projectRightsRequest(updated, context, new Date(at));
    });
  }

  async getRightsRequest(context: ActorContext, requestIdValue: string): Promise<RightsRequestProjection> {
    this.#assertRightsPurpose(context);
    const requestId = token(requestIdValue, "rights request ID");
    return this.#transaction(context, async (client) => {
      const record = await this.#requiredRightsRecord(client, context.tenantId, requestId, false);
      if (!await this.#canReadRightsRequestCurrent(client, context, record)) {
        throw new DomainError("AUTH_FORBIDDEN", "Rights request is outside the actor's data-subject authority");
      }
      return projectRightsRequest(record, context, this.#clock.now());
    });
  }

  async listRightsRequests(
    context: ActorContext,
    input: ListRightsRequestsInput = {},
  ): Promise<readonly RightsRequestProjection[]> {
    this.#assertRightsPurpose(context);
    const limit = positiveLimit(input.limit, 50, 200);
    const cursor = input.cursor === undefined ? "" : token(input.cursor, "cursor");
    if (!hasPermission(context, "rights-request:read:any") && !hasPermission(context, "rights-request:read:self")) {
      throw new DomainError("AUTH_FORBIDDEN", "Permission to inspect rights requests is required");
    }
    return this.#transaction(context, async (client) => {
      const result = await client.query(
        `SELECT * FROM ltm.records
         WHERE tenant_id=$1 AND collection=$2 AND deleted_at IS NULL AND id>$3
         ORDER BY id LIMIT 10001`,
        [context.tenantId, RIGHTS_REQUEST_COLLECTION, cursor],
      );
      if (result.rows.length > 10_000) {
        throw new DomainError("VALIDATION_FAILED", "Rights request visibility scan exceeds the closed processing limit");
      }
      const visible: RightsRequestProjection[] = [];
      for (const raw of result.rows) {
        const record = recordFromRow(raw as DbRow);
        if (await this.#canReadRightsRequestCurrent(client, context, record)) {
          visible.push(projectRightsRequest(record, context, this.#clock.now()));
          if (visible.length === limit) break;
        }
      }
      return visible;
    });
  }

  async postLedgerTransaction(
    context: ActorContext,
    input: PostLedgerInput,
  ): Promise<IdempotentResult<LedgerTransaction>> {
    this.authorize(context, "ledger:post", { tenantId: context.tenantId });
    const transactionId = token(input.transactionId ?? randomUUID(), "transaction ID");
    const sourceType = token(input.sourceType, "source type");
    const sourceId = token(input.sourceId, "source ID");
    const description = textValue(input.description, "description", 500);
    const occurredAt = input.occurredAt === undefined ? this.#now() : isoTimestamp(input.occurredAt, "occurredAt");
    const reversedTransactionId = input.reversedTransactionId === undefined || input.reversedTransactionId === null
      ? null
      : token(input.reversedTransactionId, "reversed transaction ID");
    const lines = this.#ledgerLines(input.lines);
    this.#assertBalanced(lines);
    const key = idempotencyKey(input.idempotencyKey);
    const sourceFingerprint = fingerprint("ledger.post.source", {
      sourceType,
      sourceId,
      description,
      requestedOccurredAt: input.occurredAt ?? null,
      reversedTransactionId,
      lines,
    });
    return this.#idempotent(
      context,
      key,
      "ledger.post",
      {
        requestedTransactionId: input.transactionId ?? null,
        sourceType,
        sourceId,
        description,
        requestedOccurredAt: input.occurredAt ?? null,
        reversedTransactionId,
        lines,
      },
      async (client) => {
        await this.#advisoryLock(client, `ledger-source\n${context.tenantId}\n${sourceType}\n${sourceId}`);
        const existing = await client.query(
          `SELECT * FROM ltm.ledger_transactions
           WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 FOR SHARE`,
          [context.tenantId, sourceType, sourceId],
        );
        if (existing.rows[0] !== undefined) {
          const row = existing.rows[0] as DbRow;
          if (rowString(row, "request_fingerprint") !== sourceFingerprint) {
            throw new DomainError("IDEMPOTENCY_CONFLICT", "Ledger source reference was reused with different data");
          }
          return {
            value: await this.#ledgerTransactionFromRow(client, row),
            replayed: true,
          };
        }
        if (reversedTransactionId !== null) {
          const reversed = await this.#requiredLedgerTransaction(
            client,
            context.tenantId,
            reversedTransactionId,
            true,
          );
          this.#assertExactReversal(reversed.lines, lines);
        }
        const createdAt = this.#now();
        await client.query(
          `INSERT INTO ltm.ledger_transactions(
            tenant_id,id,source_type,source_id,request_fingerprint,description,
            occurred_at,created_at,reversed_transaction_id
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            context.tenantId,
            transactionId,
            sourceType,
            sourceId,
            sourceFingerprint,
            description,
            occurredAt,
            createdAt,
            reversedTransactionId,
          ],
        );
        for (const [index, line] of lines.entries()) {
          await client.query(
            `INSERT INTO ltm.ledger_lines(
              tenant_id,transaction_id,line_no,account_code,direction,amount_minor,currency,memo
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              context.tenantId,
              transactionId,
              index + 1,
              line.accountCode,
              line.direction,
              line.amountMinor,
              line.currency,
              line.memo ?? null,
            ],
          );
        }
        const transaction = await this.#requiredLedgerTransaction(client, context.tenantId, transactionId);
        await this.#appendAuditInternal(client, context, {
          action: "ledger.posted",
          resourceType: "ledger_transaction",
          resourceId: transactionId,
          details: { sourceType, sourceId, reversedTransactionId, lineCount: lines.length },
        });
        await this.#emitOutbox(client, context.tenantId, "ledger_transaction", transactionId, "ledger.transaction.posted", {
          transaction: jsonObject(transaction),
        });
        return transaction;
      },
    );
  }

  async getLedgerTransaction(context: ActorContext, transactionIdValue: string): Promise<LedgerTransaction> {
    this.authorize(context, "ledger:read", { tenantId: context.tenantId });
    const transactionId = token(transactionIdValue, "transaction ID");
    return this.#transaction(
      context,
      (client) => this.#requiredLedgerTransaction(client, context.tenantId, transactionId),
    );
  }

  async getAccountBalance(
    context: ActorContext,
    accountCodeValue: string,
    currencyValue: string,
  ): Promise<AccountBalance> {
    this.authorize(context, "ledger:read", { tenantId: context.tenantId });
    const accountCode = token(accountCodeValue, "account code", ACCOUNT_CODE);
    const currency = token(currencyValue, "currency", CURRENCY);
    return this.#transaction(context, async (client) => {
      const result = await client.query(
        `SELECT
          COALESCE(SUM(CASE WHEN direction='debit' THEN amount_minor ELSE 0 END),0) AS debit,
          COALESCE(SUM(CASE WHEN direction='credit' THEN amount_minor ELSE 0 END),0) AS credit
         FROM ltm.ledger_lines WHERE tenant_id=$1 AND account_code=$2 AND currency=$3`,
        [context.tenantId, accountCode, currency],
      );
      const row = result.rows[0] as DbRow | undefined;
      if (row === undefined) throw new DomainError("INTERNAL_ERROR", "Ledger balance query returned no row");
      const debitMinor = rowInteger(row, "debit");
      const creditMinor = rowInteger(row, "credit");
      return { accountCode, currency, debitMinor, creditMinor, netMinor: debitMinor - creditMinor };
    });
  }

  async getTrialBalance(context: ActorContext): Promise<readonly AccountBalance[]> {
    this.authorize(context, "ledger:read", { tenantId: context.tenantId });
    return this.#transaction(context, async (client) => {
      const result = await client.query(
        `SELECT account_code,currency,
          SUM(CASE WHEN direction='debit' THEN amount_minor ELSE 0 END) AS debit,
          SUM(CASE WHEN direction='credit' THEN amount_minor ELSE 0 END) AS credit
         FROM ltm.ledger_lines WHERE tenant_id=$1
         GROUP BY account_code,currency ORDER BY account_code,currency`,
        [context.tenantId],
      );
      return result.rows.map((raw) => {
        const row = raw as DbRow;
        const debitMinor = rowInteger(row, "debit");
        const creditMinor = rowInteger(row, "credit");
        return {
          accountCode: rowString(row, "account_code"),
          currency: rowString(row, "currency"),
          debitMinor,
          creditMinor,
          netMinor: debitMinor - creditMinor,
        };
      });
    });
  }

  async receiveInboxEvent(
    context: ActorContext,
    input: ReceiveInboxInput,
  ): Promise<IdempotentResult<InboxEvent>> {
    this.authorize(context, "event:receive", { tenantId: context.tenantId });
    const source = token(input.source, "event source");
    const sourceEventId = token(input.sourceEventId, "source event ID");
    const eventType = token(input.eventType, "event type");
    const payload = jsonObject(input.payload, "event payload");
    const requestFingerprint = fingerprint("inbox.receive", { source, sourceEventId, eventType, payload });
    return this.#transaction(context, async (client) => {
      await this.#advisoryLock(client, `inbox\n${context.tenantId}\n${source}\n${sourceEventId}`);
      const existing = await client.query(
        `SELECT * FROM ltm.inbox
         WHERE tenant_id=$1 AND source=$2 AND source_event_id=$3`,
        [context.tenantId, source, sourceEventId],
      );
      if (existing.rows[0] !== undefined) {
        const row = existing.rows[0] as DbRow;
        if (rowString(row, "request_fingerprint") !== requestFingerprint) {
          throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Event ID was reused with a different payload");
        }
        return { value: inboxFromRow(row), replayed: true };
      }
      const id = randomUUID();
      const receivedAt = this.#now();
      await client.query(
        `INSERT INTO ltm.inbox(
          tenant_id,id,source,source_event_id,event_type,payload,request_fingerprint,status,received_at,processed_at
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'received',$8,NULL)`,
        [context.tenantId, id, source, sourceEventId, eventType, canonicalJson(payload), requestFingerprint, receivedAt],
      );
      const event = await this.#requiredInbox(client, context.tenantId, id);
      await this.#appendAuditInternal(client, context, {
        action: "inbox.received",
        resourceType: "inbox_event",
        resourceId: id,
        details: { source, sourceEventId, eventType },
      });
      await this.#emitOutbox(client, context.tenantId, "inbox_event", id, "inbox.event.received", {
        inboxEventId: id,
        source,
        sourceEventId,
        eventType,
      });
      return { value: event, replayed: false };
    });
  }

  async getInboxEvent(context: ActorContext, eventIdValue: string): Promise<InboxEvent> {
    this.authorize(context, "event:read", { tenantId: context.tenantId });
    const eventId = token(eventIdValue, "inbox event ID");
    return this.#transaction(context, (client) => this.#requiredInbox(client, context.tenantId, eventId));
  }

  async markInboxProcessed(context: ActorContext, eventIdValue: string, rejected = false): Promise<InboxEvent> {
    this.authorize(context, "event:process", { tenantId: context.tenantId });
    const eventId = token(eventIdValue, "inbox event ID");
    return this.#transaction(context, async (client) => {
      const current = await this.#requiredInbox(client, context.tenantId, eventId, true);
      if (current.status !== "received") return current;
      const status: InboxEvent["status"] = rejected ? "rejected" : "processed";
      const processedAt = this.#now();
      await client.query(
        `UPDATE ltm.inbox SET status=$1,processed_at=$2
         WHERE tenant_id=$3 AND id=$4 AND status='received'`,
        [status, processedAt, context.tenantId, eventId],
      );
      const event = await this.#requiredInbox(client, context.tenantId, eventId);
      await this.#appendAuditInternal(client, context, {
        action: `inbox.${status}`,
        resourceType: "inbox_event",
        resourceId: eventId,
        details: { status },
      });
      return event;
    });
  }

  async listOutbox(
    context: ActorContext,
    options: { readonly status?: OutboxStatus; readonly limit?: number } = {},
  ): Promise<readonly OutboxEvent[]> {
    this.authorize(context, "outbox:read", { tenantId: context.tenantId });
    const limit = positiveLimit(options.limit, 50, 200);
    if (options.status !== undefined && !["pending", "leased", "published", "dead"].includes(options.status)) {
      throw new DomainError("VALIDATION_FAILED", "Outbox status is invalid");
    }
    return this.#transaction(context, async (client) => {
      const result = options.status === undefined
        ? await client.query(
            `SELECT * FROM ltm.outbox WHERE tenant_id=$1 ORDER BY created_at,id LIMIT $2`,
            [context.tenantId, limit],
          )
        : await client.query(
            `SELECT * FROM ltm.outbox WHERE tenant_id=$1 AND status=$2 ORDER BY created_at,id LIMIT $3`,
            [context.tenantId, options.status, limit],
          );
      return result.rows.map((row) => outboxFromRow(row as DbRow));
    });
  }

  async claimOutbox(
    context: ActorContext,
    workerIdValue: string,
    limitValue = 50,
    leaseMs = 30_000,
  ): Promise<readonly OutboxEvent[]> {
    this.authorize(context, "outbox:publish", { tenantId: context.tenantId });
    const workerId = token(workerIdValue, "worker ID");
    const limit = positiveLimit(limitValue, 50, 200);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 900_000) {
      throw new DomainError("VALIDATION_FAILED", "leaseMs must be between 1000 and 900000");
    }
    return this.#transaction(context, async (client) => {
      const now = this.#now();
      const leaseUntil = new Date(new Date(now).getTime() + leaseMs).toISOString();
      await client.query(
        `UPDATE ltm.outbox SET status='pending',lease_owner=NULL,lease_until=NULL
         WHERE tenant_id=$1 AND status='leased' AND lease_until <= $2`,
        [context.tenantId, now],
      );
      const result = await client.query(
        `WITH candidates AS (
           SELECT tenant_id,id FROM ltm.outbox
           WHERE tenant_id=$1 AND status='pending' AND available_at <= $2
           ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $3
         )
         UPDATE ltm.outbox AS event
         SET status='leased',lease_owner=$4,lease_until=$5,attempts=event.attempts+1
         FROM candidates
         WHERE event.tenant_id=candidates.tenant_id AND event.id=candidates.id
         RETURNING event.*`,
        [context.tenantId, now, limit, workerId, leaseUntil],
      );
      return result.rows.map((row) => outboxFromRow(row as DbRow))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    });
  }

  async markOutboxPublished(
    context: ActorContext,
    eventIdValue: string,
    workerIdValue: string,
  ): Promise<OutboxEvent> {
    this.authorize(context, "outbox:publish", { tenantId: context.tenantId });
    const eventId = token(eventIdValue, "outbox event ID");
    const workerId = token(workerIdValue, "worker ID");
    return this.#transaction(context, async (client) => {
      const result = await client.query(
        `UPDATE ltm.outbox
         SET status='published',published_at=$1,lease_owner=NULL,lease_until=NULL,last_error=NULL
         WHERE tenant_id=$2 AND id=$3 AND status='leased' AND lease_owner=$4
         RETURNING *`,
        [this.#now(), context.tenantId, eventId, workerId],
      );
      if (result.rows[0] === undefined) {
        throw new DomainError("VERSION_CONFLICT", "Outbox event is not leased by this worker");
      }
      return outboxFromRow(result.rows[0] as DbRow);
    });
  }

  async markOutboxFailed(
    context: ActorContext,
    eventIdValue: string,
    workerIdValue: string,
    errorValue: string,
    options: { readonly retryAt?: string; readonly dead?: boolean } = {},
  ): Promise<OutboxEvent> {
    this.authorize(context, "outbox:publish", { tenantId: context.tenantId });
    const eventId = token(eventIdValue, "outbox event ID");
    const workerId = token(workerIdValue, "worker ID");
    const error = textValue(errorValue, "delivery error", 2_000);
    const retryAt = options.retryAt === undefined ? this.#now() : isoTimestamp(options.retryAt, "retryAt");
    const status: OutboxStatus = options.dead === true ? "dead" : "pending";
    return this.#transaction(context, async (client) => {
      const result = await client.query(
        `UPDATE ltm.outbox
         SET status=$1,available_at=$2,lease_owner=NULL,lease_until=NULL,last_error=$3
         WHERE tenant_id=$4 AND id=$5 AND status='leased' AND lease_owner=$6
         RETURNING *`,
        [status, retryAt, error, context.tenantId, eventId, workerId],
      );
      if (result.rows[0] === undefined) {
        throw new DomainError("VERSION_CONFLICT", "Outbox event is not leased by this worker");
      }
      const event = outboxFromRow(result.rows[0] as DbRow);
      if (status === "dead" && event.eventType === "external_command.requested") {
        throw new DomainError(
          "VALIDATION_FAILED",
          "External command requests must use the atomic command dead-letter path",
        );
      }
      return event;
    });
  }

  async publishOutbox(
    context: ActorContext,
    publisher: OutboxPublisher | undefined,
    options: { readonly workerId?: string; readonly limit?: number; readonly leaseMs?: number } = {},
  ): Promise<{ readonly published: number; readonly failed: number }> {
    if (publisher === undefined) {
      throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", "No outbox publisher is configured", { retryable: true });
    }
    const workerId = options.workerId ?? `publisher-${randomUUID()}`;
    const events = await this.claimOutbox(context, workerId, options.limit, options.leaseMs);
    let published = 0;
    let failed = 0;
    for (const event of events) {
      try {
        await publisher.publish(event);
        await this.markOutboxPublished(context, event.id, workerId);
        published += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown publisher error";
        const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(event.attempts, 8));
        const retryAt = new Date(this.#clock.now().getTime() + delayMs).toISOString();
        if (event.attempts >= 10 && event.eventType === "external_command.requested") {
          const outcome = await this.deadLetterExternalCommand(context, {
            eventId: event.id,
            workerId,
            error: message.slice(0, 2_000),
          });
          if (outcome.status === "published") published += 1;
          else failed += 1;
        } else {
          await this.markOutboxFailed(context, event.id, workerId, message.slice(0, 2_000), {
            retryAt,
            dead: event.attempts >= 10,
          });
          failed += 1;
        }
      }
    }
    return { published, failed };
  }

  async deadLetterExternalCommand(
    context: ActorContext,
    input: DeadLetterExternalCommandInput,
  ): Promise<OutboxEvent> {
    this.#authorizeServiceOperation(context, "outbox:publish");
    const eventId = token(input.eventId, "outbox event ID");
    const workerId = token(input.workerId, "worker ID");
    const deliveryError = textValue(input.error, "delivery error", 2_000);
    return this.#transaction(context, async (client) => {
      const eventResult = await client.query(
        `SELECT * FROM ltm.outbox
         WHERE tenant_id=$1 AND id=$2 AND status='leased' AND lease_owner=$3 FOR UPDATE`,
        [context.tenantId, eventId, workerId],
      );
      const eventRow = eventResult.rows[0] as DbRow | undefined;
      if (eventRow === undefined) {
        throw new DomainError("VERSION_CONFLICT", "Outbox event is not leased by this worker");
      }
      const event = outboxFromRow(eventRow);
      if (event.eventType !== "external_command.requested") {
        throw new DomainError("VALIDATION_FAILED", "Only an external command request can use command dead-letter handling");
      }
      if (event.attempts < 10) {
        throw new DomainError("VERSION_CONFLICT", "External command cannot be dead-lettered before ten delivery attempts");
      }
      const identity = externalCommandRequestIdentity(event);
      await this.#advisoryLock(client, `external-command\n${context.tenantId}\n${identity.commandId}`);
      const current = await this.#requiredExternalCommand(client, context.tenantId, identity.commandId, true);
      assertExternalCommandRequestCorrelation(event, identity, current);
      const now = this.#now();

      if (["acknowledged", "succeeded", "failed", "cancelled", "compensated"].includes(current.state)) {
        await client.query(
          `UPDATE ltm.outbox
           SET status='published',published_at=$1,lease_owner=NULL,lease_until=NULL,last_error=NULL
           WHERE tenant_id=$2 AND id=$3 AND status='leased' AND lease_owner=$4`,
          [now, context.tenantId, eventId, workerId],
        );
        await this.#appendAuditInternal(client, context, {
          action: "external_command.delivery_confirmed_after_error",
          resourceType: current.aggregateCollection,
          resourceId: current.aggregateId,
          details: { commandId: current.commandId, eventId, commandState: current.state },
        });
        return this.#requiredOutbox(client, context.tenantId, eventId);
      }

      await client.query(
        `UPDATE ltm.outbox
         SET status='dead',available_at=$1,lease_owner=NULL,lease_until=NULL,last_error=$2
         WHERE tenant_id=$3 AND id=$4 AND status='leased' AND lease_owner=$5`,
        [now, deliveryError, context.tenantId, eventId, workerId],
      );
      if (current.decisionState === "active" && current.reconciliationState === "clear") {
        const details = jsonObject({
          ...current.details,
          deadLetterEventId: eventId,
          deadLetteredAt: now,
          deliveryAttempts: event.attempts,
          lastDeliveryError: deliveryError,
        }, "external command dead-letter details");
        const updated = await client.query(
          `UPDATE ltm.external_commands
           SET decision_state='frozen',reconciliation_state='reconciliation_required',
               version=version+1,updated_at=$1,details=$2::jsonb
           WHERE tenant_id=$3 AND command_id=$4 AND version=$5
             AND decision_state='active' AND reconciliation_state='clear'`,
          [now, canonicalJson(details), context.tenantId, current.commandId, current.version],
        );
        if (updated.rowCount !== 1) {
          throw new DomainError("VERSION_CONFLICT", "External command changed while it was being dead-lettered");
        }
        await client.query(
          `INSERT INTO ltm.external_command_transitions(
            tenant_id,transition_id,command_id,from_state,to_state,provider_operation_id,
            evidence_id,details,occurred_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
          [
            context.tenantId,
            randomUUID(),
            current.commandId,
            current.state,
            current.state,
            current.providerOperationId,
            current.evidenceId,
            canonicalJson({
              reason: "outbox_dead_letter",
              eventId,
              deliveryAttempts: event.attempts,
              reconciliationState: "reconciliation_required",
            }),
            now,
          ],
        );
        const aggregate = await this.#requiredRecord(
          client,
          context.tenantId,
          current.aggregateCollection,
          current.aggregateId,
          true,
          true,
        );
        const aggregateData = jsonObject({
          ...aggregate.data,
          executionState: "reconciliation_required",
          commandState: current.state,
          _externalDecisionState: "frozen",
          _externalReconciliationState: "reconciliation_required",
          lastDeliveryFailure: {
            eventId,
            attempts: event.attempts,
            error: deliveryError,
            occurredAt: now,
          },
        }, "external command dead-letter aggregate data");
        const recordUpdate = await client.query(
          `UPDATE ltm.records SET data=$1::jsonb,version=version+1,updated_at=$2
           WHERE tenant_id=$3 AND collection=$4 AND id=$5 AND version=$6`,
          [
            canonicalJson(aggregateData),
            now,
            context.tenantId,
            current.aggregateCollection,
            current.aggregateId,
            aggregate.version,
          ],
        );
        if (recordUpdate.rowCount !== 1) {
          throw new DomainError("VERSION_CONFLICT", "External command aggregate changed while it was being dead-lettered");
        }
        const frozen = await this.#requiredExternalCommand(client, context.tenantId, current.commandId);
        const frozenAggregate = await this.#requiredRecord(
          client,
          context.tenantId,
          current.aggregateCollection,
          current.aggregateId,
          true,
        );
        await this.#appendAuditInternal(client, context, {
          action: "external_command.reconciliation_required",
          resourceType: current.aggregateCollection,
          resourceId: current.aggregateId,
          details: {
            commandId: current.commandId,
            eventId,
            commandState: current.state,
            deliveryAttempts: event.attempts,
          },
        });
        await this.#emitOutbox(
          client,
          context.tenantId,
          current.aggregateCollection,
          current.aggregateId,
          "external_command.reconciliation_required",
          { command: jsonObject(frozen), record: jsonObject(frozenAggregate), deadLetterEventId: eventId },
        );
      }
      return this.#requiredOutbox(client, context.tenantId, eventId);
    });
  }

  async appendAudit(context: ActorContext, input: AppendAuditInput): Promise<AuditEntry> {
    this.authorize(context, "audit:append", { tenantId: context.tenantId });
    return this.#transaction(context, (client) => this.#appendAuditInternal(client, context, input));
  }

  async listAudit(context: ActorContext, limitValue = 100): Promise<readonly AuditEntry[]> {
    this.authorize(context, "audit:read", { tenantId: context.tenantId });
    const limit = positiveLimit(limitValue, 100, 500);
    return this.#transaction(context, async (client) => {
      const result = await client.query(
        "SELECT * FROM ltm.audit_log WHERE tenant_id=$1 ORDER BY sequence DESC LIMIT $2",
        [context.tenantId, limit],
      );
      await this.#appendAuditInternal(client, context, {
        action: "audit.read",
        resourceType: "audit_log",
        resourceId: context.tenantId,
        details: { limit, returned: result.rows.length },
      });
      return result.rows.map((row) => auditFromRow(row as DbRow));
    });
  }

  async verifyAuditChain(context: ActorContext): Promise<AuditVerification> {
    this.authorize(context, "audit:read", { tenantId: context.tenantId });
    return this.#transaction(context, async (client) => {
      const result = await this.#verifyAuditTenant(client, context.tenantId);
      await this.#appendAuditInternal(client, context, {
        action: "audit.verified",
        resourceType: "audit_log",
        resourceId: context.tenantId,
        details: { valid: result.valid, entriesChecked: result.entriesChecked },
      });
      return result;
    });
  }

  async #assertDatabaseContract(): Promise<void> {
    this.#assertOpen();
    const client = await this.#pool.connect();
    try {
      const roleResult = await client.query(
        `SELECT rolname,rolsuper,rolbypassrls
         FROM pg_roles WHERE rolname=current_user`,
      );
      const role = roleResult.rows[0] as DbRow | undefined;
      if (role === undefined || rowBoolean(role, "rolsuper") || rowBoolean(role, "rolbypassrls")) {
        throw new DomainError(
          "CONFIGURATION_INVALID",
          "PostgreSQL runtime role must be a non-superuser without BYPASSRLS",
        );
      }
      const metadata = await client.query(
        "SELECT value FROM ltm.schema_metadata WHERE key='runtime_schema_version'",
      );
      if ((metadata.rows[0] as DbRow | undefined)?.value !== REQUIRED_SCHEMA_VERSION) {
        throw new DomainError("DEPENDENCY_UNAVAILABLE", "PostgreSQL runtime schema version is unsupported");
      }
      const tables = await client.query(
        `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='ltm' AND c.relname = ANY($1::text[])`,
        [TENANT_TABLES],
      );
      if (tables.rows.length !== TENANT_TABLES.length || tables.rows.some((raw) => {
        const row = raw as DbRow;
        return !rowBoolean(row, "relrowsecurity") || !rowBoolean(row, "relforcerowsecurity");
      })) {
        throw new DomainError("DEPENDENCY_UNAVAILABLE", "PostgreSQL tenant tables must enable and force RLS");
      }
      const policies = await client.query(
        `SELECT c.relname AS tablename,
                p.polname AS policyname,
                p.polcmd AS command,
                p.polpermissive AS permissive,
                p.polroles = ARRAY[0::oid] AS public_only,
                pg_get_expr(p.polqual,p.polrelid) AS using_expression,
                pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
         FROM pg_policy p
         JOIN pg_class c ON c.oid=p.polrelid
         JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname='ltm' AND c.relname = ANY($1::text[])`,
        [TENANT_TABLES],
      );
      if (!hasExactTenantIsolationPolicySet(policies.rows as PostgresPolicyCatalogRow[], TENANT_TABLES)) {
        throw new DomainError(
          "DEPENDENCY_UNAVAILABLE",
          "PostgreSQL tenant isolation policies must be exact, exclusive, permissive PUBLIC ALL policies",
        );
      }
      const triggers = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid IN (
           'ltm.records'::regclass,
           'ltm.audit_log'::regclass,
           'ltm.ledger_transactions'::regclass,
           'ltm.ledger_lines'::regclass,
           'ltm.external_commands'::regclass,
           'ltm.external_command_transitions'::regclass,
           'ltm.evidence_decisions'::regclass,
           'ltm.external_business_events'::regclass,
           'ltm.participants'::regclass,
           'ltm.guardian_authorizations'::regclass,
           'ltm.authorized_agent_authorizations'::regclass
         )
           AND NOT tgisinternal AND tgenabled <> 'D'`,
      );
      const triggerNames = new Set(triggers.rows.map((row) => rowString(row as DbRow, "tgname")));
      for (const required of [
        "audit_log_immutable",
        "ledger_transactions_immutable",
        "ledger_lines_immutable",
        "ledger_lines_balanced",
        "external_commands_update_guard",
        "external_command_transitions_immutable",
        "evidence_decisions_freeze_only",
        "external_business_events_immutable",
        "records_processing_purpose_immutable",
        "participants_update_guard",
        "participants_no_delete",
        "guardian_authorizations_update_guard",
        "guardian_authorizations_no_delete",
        "authorized_agent_authorizations_update_guard",
        "authorized_agent_authorizations_no_delete",
      ]) {
        if (!triggerNames.has(required)) {
          throw new DomainError("DEPENDENCY_UNAVAILABLE", "PostgreSQL audit or ledger integrity triggers are incomplete");
        }
      }
    } finally {
      client.release();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new DomainError("DEPENDENCY_UNAVAILABLE", "The PostgreSQL runtime is closed");
  }

  #now(): string {
    const value = this.#clock.now();
    if (!Number.isFinite(value.getTime())) throw new DomainError("INTERNAL_ERROR", "Runtime clock returned an invalid date");
    return value.toISOString();
  }

  async #transaction<T>(context: ActorContext, work: (client: PoolClient) => Promise<T>): Promise<T> {
    this.#assertOpen();
    validateContext(context);
    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      throw this.#mapStorageError(error);
    }
    let began = false;
    try {
      await client.query("BEGIN");
      began = true;
      await client.query("SET LOCAL row_security = on");
      const bound = await client.query(
        `SELECT
          set_config('app.tenant_id',$1,true) AS tenant_id,
          set_config('app.actor_id',$2,true) AS actor_id,
          set_config('app.purpose',$3,true) AS purpose,
          set_config('app.request_id',$4,true) AS request_id`,
        [context.tenantId, context.actorId, context.purpose, context.requestId],
      );
      const binding = bound.rows[0] as DbRow | undefined;
      if (binding === undefined || rowString(binding, "tenant_id") !== context.tenantId) {
        throw new DomainError("TENANT_SCOPE_MISMATCH", "PostgreSQL tenant transaction context could not be established");
      }
      const value = await work(client);
      await client.query("COMMIT");
      began = false;
      return value;
    } catch (error) {
      if (began) await client.query("ROLLBACK").catch(() => undefined);
      throw this.#mapStorageError(error);
    } finally {
      client.release();
    }
  }

  #mapStorageError(error: unknown): DomainError {
    if (error instanceof DomainError) return error;
    const code = postgresErrorCode(error);
    const message = error instanceof Error ? error.message : "";
    if (code === "P0001" && message.includes("unbalanced")) {
      return new DomainError("LEDGER_UNBALANCED", "PostgreSQL rejected an unbalanced ledger transaction");
    }
    if (code === "P0001" && message.includes("immutable")) {
      return new DomainError("LEDGER_IMMUTABLE", "PostgreSQL rejected a mutation of immutable financial or audit data");
    }
    if (code === "23505") return new DomainError("VERSION_CONFLICT", "A unique resource already exists");
    if (code === "23503" || code === "23514" || code === "22P02") {
      return new DomainError("VALIDATION_FAILED", "PostgreSQL rejected invalid domain data");
    }
    if (code === "40001" || code === "40P01" || code === "55P03" || code?.startsWith("08") === true) {
      return new DomainError("DEPENDENCY_UNAVAILABLE", "PostgreSQL transaction failed and may be retried", {
        retryable: true,
        details: { cause: code ?? "connection" },
      });
    }
    return new DomainError("DEPENDENCY_UNAVAILABLE", "PostgreSQL operation failed", {
      retryable: false,
      details: { cause: code ?? (error instanceof Error ? error.name : "unknown") },
    });
  }

  async #advisoryLock(client: PoolClient, identity: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [identity]);
  }

  async #advisorySharedLock(client: PoolClient, identity: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [identity]);
  }

  async #lockConsentLifecycle(
    client: PoolClient,
    tenantId: string,
    participantIds: readonly string[],
    purpose: string,
    resource: string,
    actions: readonly string[],
    shared: boolean,
  ): Promise<void> {
    const lock = shared
      ? (identity: string) => this.#advisorySharedLock(client, identity)
      : (identity: string) => this.#advisoryLock(client, identity);
    const participants = [...new Set(participantIds)].sort();
    for (const participantId of participants) {
      await lock(`participant\n${tenantId}\n${participantId}`);
    }
    const decisions = [...new Set(participants.flatMap((participantId) =>
      actions.map((action) => `consent-decision\n${tenantId}\n${participantId}\n${purpose}\n${resource}\n${action}`)))].sort();
    for (const identity of decisions) await lock(identity);
  }

  async #idempotent<T>(
    context: ActorContext,
    key: string,
    operation: string,
    input: unknown,
    work: (client: PoolClient) => Promise<T | IdempotentResult<T>>,
  ): Promise<IdempotentResult<T>> {
    validateContext(context);
    const requestFingerprint = fingerprint(operation, input);
    return this.#transaction(context, async (client) => {
      await this.#advisoryLock(client, `idempotency\n${context.tenantId}\n${context.actorId}\n${key}`);
      const result = await client.query(
        `SELECT operation,request_fingerprint,response_json FROM ltm.idempotency
         WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3`,
        [context.tenantId, context.actorId, key],
      );
      const existing = result.rows[0] as DbRow | undefined;
      if (existing !== undefined) {
        if (rowString(existing, "operation") !== operation ||
            rowString(existing, "request_fingerprint") !== requestFingerprint) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for a different request", {
            details: { idempotencyKey: key, operation },
          });
        }
        return { value: existing.response_json as T, replayed: true };
      }
      const outcome = await work(client);
      const isWrapped = typeof outcome === "object" && outcome !== null && "value" in outcome && "replayed" in outcome;
      const value = isWrapped ? (outcome as IdempotentResult<T>).value : outcome as T;
      const replayed = isWrapped ? (outcome as IdempotentResult<T>).replayed : false;
      await client.query(
        `INSERT INTO ltm.idempotency(
          tenant_id,actor_id,operation,idempotency_key,request_fingerprint,response_json,created_at
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [
          context.tenantId,
          context.actorId,
          operation,
          key,
          requestFingerprint,
          canonicalJson(value),
          this.#now(),
        ],
      );
      return { value, replayed };
    });
  }

  async #idempotentValueInternal<T>(
    client: PoolClient,
    context: ActorContext,
    key: string,
    operation: string,
    requestFingerprint: string,
    work: () => Promise<T>,
  ): Promise<IdempotentResult<T>> {
    await this.#advisoryLock(client, `idempotency\n${context.tenantId}\n${context.actorId}\n${key}`);
    const result = await client.query(
      `SELECT operation,request_fingerprint,response_json FROM ltm.idempotency
       WHERE tenant_id=$1 AND actor_id=$2 AND idempotency_key=$3`,
      [context.tenantId, context.actorId, key],
    );
    const existing = result.rows[0] as DbRow | undefined;
    if (existing !== undefined) {
      if (rowString(existing, "operation") !== operation ||
          rowString(existing, "request_fingerprint") !== requestFingerprint) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for a different request", {
          details: { idempotencyKey: key, operation },
        });
      }
      return { value: existing.response_json as T, replayed: true };
    }
    const value = await work();
    await client.query(
      `INSERT INTO ltm.idempotency(
        tenant_id,actor_id,operation,idempotency_key,request_fingerprint,response_json,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [
        context.tenantId,
        context.actorId,
        operation,
        key,
        requestFingerprint,
        canonicalJson(value),
        this.#now(),
      ],
    );
    return { value, replayed: false };
  }

  async #selectRecord(
    client: PoolClient,
    tenantId: string,
    collection: string,
    id: string,
    includeDeleted: boolean,
    forUpdate = false,
  ): Promise<DbRow | undefined> {
    const result = await client.query(
      `SELECT * FROM ltm.records
       WHERE tenant_id=$1 AND collection=$2 AND id=$3${includeDeleted ? "" : " AND deleted_at IS NULL"}${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, collection, id],
    );
    return result.rows[0] as DbRow | undefined;
  }

  #assertRightsPurpose(context: ActorContext): void {
    validateContext(context);
    if (textValue(context.purpose, "request purpose", 120) !== "privacy_rights") {
      throw new DomainError("PURPOSE_REQUIRED", "Data-subject rights operations require the privacy_rights purpose");
    }
  }

  #assertGenericRecordCollection(collection: string): void {
    if (collection === RIGHTS_REQUEST_COLLECTION) {
      throw new DomainError("AUTH_FORBIDDEN", "Rights requests are available only through the minimized rights workflow");
    }
  }

  async #requiredRightsRecord(
    client: PoolClient,
    tenantId: string,
    requestId: string,
    includeDeleted: boolean,
    forUpdate = false,
  ): Promise<RecordEnvelope> {
    return this.#requiredRecord(client, tenantId, RIGHTS_REQUEST_COLLECTION, requestId, includeDeleted, forUpdate);
  }

  async #rightsAuthorityDecision(
    client: PoolClient,
    context: ActorContext,
    submission: NormalizedRightsSubmission,
    at: string,
  ): Promise<RightsAuthorityDecision> {
    const participant = await this.#requiredParticipant(client, context.tenantId, submission.participantId, false, at);
    if (participant.ownerActorId === context.actorId && participant.minorStatus === "adult" &&
        hasPermission(context, "rights-request:create")) {
      return {
        participantId: participant.participantId,
        requesterCapacity: "self",
        authorityExpiresAt: participant.expiresAt,
      };
    }
    const requirement = rightsAuthorityScope(participant.participantId, submission.requestType);
    const authorityScope: ConsentScope = { resource: requirement.resource, actions: [requirement.action] };
    if (participant.minorStatus === "minor" && context.roles.includes("guardian") && context.guardianVerified === true &&
        await this.#hasParticipantAuthority(client, context, participant.participantId, "guardian", authorityScope, at)) {
      return {
        participantId: participant.participantId,
        requesterCapacity: "guardian",
        authorityExpiresAt: participant.expiresAt,
      };
    }
    if (hasPermission(context, "rights-request:create:agent") &&
        await this.#hasParticipantAuthority(
          client,
          context,
          participant.participantId,
          "authorized_agent",
          authorityScope,
          at,
        )) {
      return {
        participantId: participant.participantId,
        requesterCapacity: "authorized_agent",
        authorityExpiresAt: participant.expiresAt,
      };
    }
    throw new DomainError(
      participant.minorStatus === "minor" ? "GUARDIAN_VERIFICATION_REQUIRED" : "AUTH_FORBIDDEN",
      "Exact active data-subject, guardian, or authorized-agent authority is required",
    );
  }

  async #canReadRightsRequestCurrent(
    client: PoolClient,
    context: ActorContext,
    record: RecordEnvelope,
  ): Promise<boolean> {
    if (record.tenantId !== context.tenantId) return false;
    if (hasPermission(context, "rights-request:read:any") || context.roles.includes("platform_admin")) return true;
    const data = parseRightsRequestRecord(record);
    let participant: ParticipantRecord;
    try {
      participant = await this.#requiredParticipant(client, context.tenantId, data.subjectParticipantId, true);
    } catch {
      return false;
    }
    if (participant.ownerActorId === context.actorId && hasPermission(context, "rights-request:read:self")) return true;
    const now = this.#now();
    try {
      participant = await this.#requiredParticipant(client, context.tenantId, data.subjectParticipantId, false, now);
    } catch {
      return false;
    }
    const requirement = rightsAuthorityScope(participant.participantId, data.requestType);
    const scope: ConsentScope = { resource: requirement.resource, actions: [requirement.action] };
    if (participant.minorStatus === "minor" && context.roles.includes("guardian") && context.guardianVerified === true &&
        await this.#hasParticipantAuthority(client, context, participant.participantId, "guardian", scope, now)) return true;
    return hasPermission(context, "rights-request:read:agent") &&
      await this.#hasParticipantAuthority(
        client,
        context,
        participant.participantId,
        "authorized_agent",
        scope,
        now,
      );
  }

  async #discoverRightsAssetIds(
    client: PoolClient,
    tenantId: string,
    participantId: string,
  ): Promise<readonly string[]> {
    const result = await client.query(
      `SELECT * FROM ltm.records
       WHERE tenant_id=$1 AND collection='media.intake-results' AND deleted_at IS NULL
         AND $2=ANY(participant_ids)
       ORDER BY id LIMIT 10001`,
      [tenantId, participantId],
    );
    if (result.rows.length > 10_000) {
      throw new DomainError("VALIDATION_FAILED", "Rights request asset inventory exceeds the closed processing limit");
    }
    return result.rows.map((row) => {
      const record = recordFromRow(row as DbRow);
      const assetId = record.data.assetId;
      if (typeof assetId !== "string" || token(assetId, "stored media asset ID") !== record.id) {
        throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Stored B07 asset binding is invalid");
      }
      return assetId;
    });
  }

  async #withdrawConsentsForRightsRequest(
    client: PoolClient,
    context: ActorContext,
    submission: NormalizedRightsSubmission,
    requestId: string,
    now: string,
  ): Promise<void> {
    const parameters: unknown[] = [context.tenantId, submission.participantId];
    const purposeCondition = submission.requestedProcessingPurpose === "all"
      ? ""
      : `AND purpose=$${parameters.push(submission.requestedProcessingPurpose)}`;
    const result = await client.query(
      `SELECT * FROM ltm.consents
       WHERE tenant_id=$1 AND participant_id=$2 AND status='active' ${purposeCondition}
       ORDER BY granted_at,id FOR UPDATE`,
      parameters,
    );
    const restricted = submission.requestType === "restrict_processing";
    for (const raw of result.rows) {
      const prior = consentFromRow(raw as DbRow);
      const updated = await client.query(
        `UPDATE ltm.consents SET status=$1,withdrawn_at=$2,version=version+1
         WHERE tenant_id=$3 AND id=$4 AND status='active' AND version=$5`,
        [restricted ? "disputed" : "withdrawn", now, context.tenantId, prior.id, prior.version],
      );
      if (updated.rowCount !== 1) {
        throw new DomainError("VERSION_CONFLICT", "Consent changed during rights-request closure");
      }
      const consent = await this.#requiredConsent(client, context.tenantId, prior.id);
      await this.#appendAuditInternal(client, context, {
        action: restricted ? "consent.restricted_by_rights_request" : "consent.withdrawn_by_rights_request",
        resourceType: "consent",
        resourceId: consent.id,
        details: {
          rightsRequestId: requestId,
          participantId: consent.participantId,
          purpose: consent.purpose,
          version: consent.version,
        },
      });
      await this.#emitOutbox(
        client,
        context.tenantId,
        "consent",
        consent.id,
        restricted ? "consent.processing_restricted" : "consent.withdrawn",
        {
          consentId: consent.id,
          participantId: consent.participantId,
          purpose: consent.purpose,
          withdrawnAt: consent.withdrawnAt,
          rightsRequestId: requestId,
        },
      );
      await this.#closeShareExportsForWithdrawnConsent(
        client,
        context,
        consent,
        `rights_request:${requestId}`,
        now,
      );
    }
  }

  async #replaceRightsRecordData(
    client: PoolClient,
    context: ActorContext,
    record: RecordEnvelope,
    data: RightsRequestData,
    auditAction: string,
    details: JsonObject,
  ): Promise<RecordEnvelope> {
    const now = this.#now();
    const result = await client.query(
      `UPDATE ltm.records SET data=$1::jsonb,version=version+1,updated_at=$2
       WHERE tenant_id=$3 AND collection=$4 AND id=$5 AND deleted_at IS NULL AND version=$6`,
      [canonicalJson(data), now, context.tenantId, RIGHTS_REQUEST_COLLECTION, record.id, record.version],
    );
    if (result.rowCount !== 1) {
      await this.#throwRecordMutationConflict(
        client,
        context.tenantId,
        RIGHTS_REQUEST_COLLECTION,
        record.id,
        record.version,
      );
    }
    const updated = await this.#requiredRightsRecord(client, context.tenantId, record.id, false);
    await this.#appendAuditInternal(client, context, {
      action: auditAction,
      resourceType: RIGHTS_REQUEST_COLLECTION,
      resourceId: record.id,
      details: { ...details, previousVersion: record.version, version: updated.version },
    });
    return updated;
  }

  #assertRightsEscalationReason(
    data: RightsRequestData,
    reason: EscalateRightsRequestInput["reasonCode"],
    at: string,
  ): void {
    const valid = reason === "sla_due" ? data.dueAt <= at
      : reason === "dependency_blocked" ? data.tasks.some((task) => task.state === "blocked")
        : reason === "receipt_failed" ? data.tasks.some((task) => task.state === "failed")
          : reason === "review_disagreement" ? data.reviews.length === 2 &&
            data.reviews[0]!.decision !== data.reviews[1]!.decision
            : false;
    if (!valid) throw new DomainError("VALIDATION_FAILED", "Escalation reason is not supported by current durable workflow facts");
  }

  async #requiredRecord<T extends JsonObject>(
    client: PoolClient,
    tenantId: string,
    collection: string,
    id: string,
    includeDeleted: boolean,
    forUpdate = false,
  ): Promise<RecordEnvelope<T>> {
    const row = await this.#selectRecord(client, tenantId, collection, id, includeDeleted, forUpdate);
    if (row === undefined) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Record was not found", { details: { collection, id } });
    }
    return recordFromRow<T>(row);
  }

  async #throwRecordMutationConflict(
    client: PoolClient,
    tenantId: string,
    collection: string,
    id: string,
    expectedVersion: number,
  ): Promise<never> {
    const row = await this.#selectRecord(client, tenantId, collection, id, true);
    if (row === undefined || row.deleted_at !== null) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Record was not found", { details: { collection, id } });
    }
    throw new DomainError("VERSION_CONFLICT", "Record version changed", {
      details: { collection, id, expectedVersion, actualVersion: rowInteger(row, "version") },
    });
  }

  #participantIds(values: readonly string[]): readonly string[] {
    if (values.length > 100) throw new DomainError("VALIDATION_FAILED", "At most 100 participant references are allowed");
    return [...new Set(values.map((value) => token(value, "participant ID")))].sort();
  }

  #protectMinorSharing(context: ActorContext, collection: string, containsMinor: boolean): void {
    if (containsMinor && collection.includes("share") && !hasPermission(context, "minor:public-share:restricted")) {
      throw new DomainError("AUTH_FORBIDDEN", "Sharing a minor's data is restricted");
    }
  }

  #processingPurposeForCreate(context: ActorContext, requestedPurpose?: string): string {
    const requestPurpose = textValue(context.purpose, "request processing purpose", 120);
    const processingPurpose = requestedPurpose === undefined
      ? requestPurpose
      : textValue(requestedPurpose, "record processing purpose", 120);
    if (processingPurpose === "__legacy_unmapped__") {
      throw new DomainError("PURPOSE_REQUIRED", "The fail-closed legacy purpose cannot be used for new records");
    }
    if (processingPurpose !== requestPurpose) {
      throw new DomainError("PURPOSE_REQUIRED", "Record processing purpose must exactly match the request purpose", {
        details: { requestPurpose, processingPurpose },
      });
    }
    return processingPurpose;
  }

  async #assertRecordProcessingPurpose(
    client: PoolClient,
    context: ActorContext,
    record: RecordEnvelope,
    operation: "read" | "list" | "update" | "delete",
  ): Promise<void> {
    const requestPurpose = textValue(context.purpose, "request processing purpose", 120);
    if (record.processingPurpose === "__legacy_unmapped__") {
      throw new DomainError("PURPOSE_REQUIRED", "Legacy record processing purpose is unmapped and access is fail-closed", {
        details: { collection: record.collection, recordId: record.id },
      });
    }
    if (record.processingPurpose === requestPurpose) return;
    if (!hasPermission(context, "record:purpose:cross")) {
      throw new DomainError("PURPOSE_REQUIRED", "Request purpose does not match the record processing purpose", {
        details: {
          collection: record.collection,
          recordId: record.id,
          requestPurpose,
          processingPurpose: record.processingPurpose,
        },
      });
    }
    await this.#appendAuditInternal(client, context, {
      action: "record.cross_purpose_access",
      resourceType: record.collection,
      resourceId: record.id,
      details: { operation, requestPurpose, processingPurpose: record.processingPurpose },
    });
  }

  #participantAuthorityCapacity(value: unknown): ParticipantAuthorityCapacity {
    if (value !== "guardian" && value !== "authorized_agent") {
      throw new DomainError("VALIDATION_FAILED", "Participant authority capacity is invalid");
    }
    return value;
  }

  #participantAuthorityStorage(capacity: ParticipantAuthorityCapacity): {
    readonly table: "guardian_authorizations" | "authorized_agent_authorizations";
    readonly actorColumn: "guardian_actor_id" | "agent_actor_id";
  } {
    return capacity === "guardian"
      ? { table: "guardian_authorizations", actorColumn: "guardian_actor_id" }
      : { table: "authorized_agent_authorizations", actorColumn: "agent_actor_id" };
  }

  async #selectParticipant(
    client: PoolClient,
    tenantId: string,
    participantId: string,
    forUpdate = false,
  ): Promise<DbRow | undefined> {
    const result = await client.query(
      `SELECT * FROM ltm.participants
       WHERE tenant_id=$1 AND participant_id=$2${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, participantId],
    );
    return result.rows[0] as DbRow | undefined;
  }

  async #requiredParticipant(
    client: PoolClient,
    tenantId: string,
    participantId: string,
    includeInactive: boolean,
    at: string = this.#now(),
    forUpdate = false,
  ): Promise<ParticipantRecord> {
    const row = await this.#selectParticipant(client, tenantId, participantId, forUpdate);
    if (row === undefined) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Participant is not registered", { details: { participantId } });
    }
    const participant = participantFromRow(row);
    if (!includeInactive &&
        (participant.status !== "active" || participant.expiresAt <= at ||
         !await this.#evidenceRemainsValid(client, tenantId, participant.evidenceId, at))) {
      throw new DomainError("CONSENT_REQUIRED", "Participant registry authority is inactive or expired", {
        details: { participantId },
      });
    }
    return participant;
  }

  async #selectParticipantAuthority(
    client: PoolClient,
    tenantId: string,
    authorizationId: string,
    capacity: ParticipantAuthorityCapacity,
    forUpdate = false,
  ): Promise<ParticipantAuthorityRecord | undefined> {
    const binding = this.#participantAuthorityStorage(capacity);
    const result = await client.query(
      `SELECT *,${binding.actorColumn} AS authorized_actor_id FROM ltm.${binding.table}
       WHERE tenant_id=$1 AND authorization_id=$2${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, authorizationId],
    );
    const row = result.rows[0] as DbRow | undefined;
    return row === undefined ? undefined : participantAuthorityFromRow(row, capacity);
  }

  async #requiredParticipantAuthority(
    client: PoolClient,
    tenantId: string,
    authorizationId: string,
    capacity: ParticipantAuthorityCapacity,
    forUpdate = false,
  ): Promise<ParticipantAuthorityRecord> {
    const authorization = await this.#selectParticipantAuthority(
      client,
      tenantId,
      authorizationId,
      capacity,
      forUpdate,
    );
    if (authorization === undefined) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Participant authority was not found", {
        details: { authorizationId, capacity },
      });
    }
    return authorization;
  }

  async #requireIdentityMutationEvidence(
    client: PoolClient,
    context: ActorContext,
    scope: string,
    evidenceId: string,
  ): Promise<RegisteredExternalEvidence> {
    const evidence = (await this.#requireExternalEvidenceInternal(client, context, scope, [evidenceId]))[0];
    if (evidence === undefined || evidence.replayPolicy !== "single_use") {
      throw new DomainError("EXTERNAL_EVIDENCE_UNVERIFIED", "Identity mutations require single-use signed evidence");
    }
    return evidence;
  }

  async #evidenceRemainsValid(
    client: PoolClient,
    tenantId: string,
    evidenceId: string,
    at: string,
  ): Promise<boolean> {
    try {
      const evidence = await this.#requiredEvidence(client, tenantId, evidenceId);
      if (evidence.status !== "verified" || evidence.expiresAt <= at) return false;
      this.#verifyStoredEvidence(evidence);
      return true;
    } catch {
      return false;
    }
  }

  async #hasParticipantAuthority(
    client: PoolClient,
    context: ActorContext,
    participantId: string,
    capacity: ParticipantAuthorityCapacity,
    consentScope: ConsentScope,
    at: string,
  ): Promise<boolean> {
    return this.#hasParticipantAuthorityForActor(
      client,
      context.tenantId,
      context.actorId,
      participantId,
      capacity,
      consentScope,
      at,
    );
  }

  async #hasParticipantAuthorityForActor(
    client: PoolClient,
    tenantId: string,
    actorId: string,
    participantId: string,
    capacity: ParticipantAuthorityCapacity,
    consentScope: ConsentScope,
    at: string,
  ): Promise<boolean> {
    const binding = this.#participantAuthorityStorage(capacity);
    const result = await client.query(
      `SELECT *,${binding.actorColumn} AS authorized_actor_id FROM ltm.${binding.table}
       WHERE tenant_id=$1 AND ${binding.actorColumn}=$2 AND participant_id=$3
         AND status='active' AND expires_at>$4`,
      [tenantId, actorId, participantId, at],
    );
    for (const raw of result.rows) {
      try {
        const authorization = participantAuthorityFromRow(raw as DbRow, capacity);
        if (await this.#evidenceRemainsValid(client, tenantId, authorization.evidenceId, at) &&
            authorityScopeCoversConsent(authorization.scope, consentScope)) return true;
      } catch {
        // Malformed or stale authority rows fail closed.
      }
    }
    return false;
  }

  async #canAccessConsent(
    client: PoolClient,
    context: ActorContext,
    consent: ConsentRecord,
    operation: "read" | "withdraw",
  ): Promise<boolean> {
    let participant: ParticipantRecord;
    try {
      participant = await this.#requiredParticipant(client, context.tenantId, consent.participantId, true);
    } catch {
      return false;
    }
    const permission = operation === "read" ? "consent:read" : "consent:withdraw";
    if (context.permissions?.includes(`${permission}:any`) === true ||
        (operation === "read" && context.roles.includes("platform_admin"))) return true;
    const isOwner = participant.ownerActorId === context.actorId &&
      (hasPermission(context, permission) || hasPermission(context, `${permission}:self`));
    if (operation === "withdraw" && isOwner) return true;
    try {
      participant = await this.#requiredParticipant(client, context.tenantId, consent.participantId, false);
    } catch {
      return false;
    }
    if (isOwner) return true;
    const now = this.#now();
    if (context.roles.includes("guardian") && context.guardianVerified === true && hasPermission(context, permission) &&
        await this.#hasParticipantAuthority(client, context, participant.participantId, "guardian", consent.scope, now)) {
      return true;
    }
    return hasPermission(context, `${permission}:agent`) &&
      await this.#hasParticipantAuthority(
        client,
        context,
        participant.participantId,
        "authorized_agent",
        consent.scope,
        now,
      );
  }

  async #authorizeConsentAccess(
    client: PoolClient,
    context: ActorContext,
    consent: ConsentRecord,
    operation: "read" | "withdraw",
  ): Promise<void> {
    if (!await this.#canAccessConsent(client, context, consent, operation)) {
      throw new DomainError("AUTH_FORBIDDEN", `Exact participant authority is required to ${operation} consent`);
    }
  }

  #consentRowAllows(row: DbRow, scope: ConsentRequirementScope): boolean {
    try {
      return consentScopeAllows(
        normalizeConsentScope(rowJsonObject(row, "scope"), "stored consent scope"),
        scope,
      );
    } catch {
      return false;
    }
  }

  #consentRowPolicyActive(row: DbRow, participant: ParticipantRecord, at: string): boolean {
    const policyCatalogSha256 = rowNullableString(row, "policy_catalog_sha256");
    const jurisdiction = rowNullableString(row, "jurisdiction");
    const locale = rowNullableString(row, "locale");
    if (this.#allowLegacyConsentPolicy) {
      return policyCatalogSha256 === null && jurisdiction === null && locale === null;
    }
    const expiresAt = rowNullableTimestamp(row, "expires_at");
    if (policyCatalogSha256 === null || jurisdiction === null || locale === null || expiresAt === null ||
        this.#consentPolicyCatalog === null || policyCatalogSha256 !== this.#consentPolicyCatalog.sha256 ||
        jurisdiction !== this.#consentPolicyJurisdiction || locale !== this.#consentPolicyLocale) {
      return false;
    }
    try {
      const resolved = resolveConsentPolicy(this.#requiredActiveConsentPolicy(at), {
        policyVersion: rowString(row, "policy_version"),
        purpose: rowString(row, "purpose"),
        jurisdiction,
        locale,
        scope: rowJsonObject(row, "scope"),
        grantorCapacity: rowString(row, "grantor_capacity") as GrantConsentInput["grantorCapacity"],
        isMinor: rowBoolean(row, "is_minor"),
        requestedExpiresAt: expiresAt,
        participantExpiresAt: participant.expiresAt,
        at,
      });
      return resolved.disclosureSha256 === rowString(row, "evidence_hash") &&
        resolved.catalogSha256 === policyCatalogSha256;
    } catch {
      return false;
    }
  }

  async #hasParticipantConsent(
    client: PoolClient,
    context: ActorContext,
    participantIds: readonly string[],
    purpose: string,
    scope: ConsentRequirementScope,
  ): Promise<boolean> {
    if (participantIds.length === 0) return true;
    try {
      await this.#activeConsents(client, context, { participantIds, purpose, scope }, false);
      return true;
    } catch (error) {
      if (error instanceof DomainError && (error.code === "CONSENT_REQUIRED" || error.code === "CONSENT_WITHDRAWN")) {
        return false;
      }
      throw error;
    }
  }

  async #requireParticipantConsent(
    client: PoolClient,
    context: ActorContext,
    participantIds: readonly string[],
    purpose: string,
    scope: ConsentRequirementScope,
  ): Promise<void> {
    if (participantIds.length > 0) {
      await this.#activeConsents(client, context, { participantIds, purpose, scope }, false);
    }
  }

  async #activeConsents(
    client: PoolClient,
    context: ActorContext,
    requirement: ConsentRequirement,
    enforceSelfVisibility: boolean,
  ): Promise<readonly ConsentRecord[]> {
    const participantIds = this.#participantIds(requirement.participantIds);
    if (participantIds.length === 0) {
      throw new DomainError("VALIDATION_FAILED", "At least one participant is required for a consent check");
    }
    const purpose = textValue(requirement.purpose ?? context.purpose, "consent purpose", 120);
    const scope = normalizeConsentRequirementScope(requirement.scope);
    const at = requirement.at === undefined ? this.#now() : isoTimestamp(requirement.at, "consent check time");
    await this.#lockConsentLifecycle(
      client,
      context.tenantId,
      participantIds,
      purpose,
      scope.resource,
      [scope.action],
      true,
    );
    await this.#assertProcessingNotRestricted(client, context.tenantId, participantIds, purpose);
    const consents: ConsentRecord[] = [];
    for (const participantId of participantIds) {
      let participant: ParticipantRecord;
      try {
        participant = await this.#requiredParticipant(client, context.tenantId, participantId, false, at);
      } catch (error) {
        if (error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND") {
          throw new DomainError("CONSENT_REQUIRED", "A durable participant registry entry is required", {
            details: { participantId },
          });
        }
        throw error;
      }
      const result = await client.query(
        `SELECT * FROM ltm.consents
         WHERE tenant_id=$1 AND participant_id=$2 AND purpose=$3
         ORDER BY granted_at DESC,id DESC
         FOR SHARE`,
        [context.tenantId, participantId, purpose],
      );
      const rows = result.rows as DbRow[];
      const active = rows.find((row) => {
        if (rowString(row, "status") !== "active") return false;
        const expiresAt = rowNullableTimestamp(row, "expires_at");
        return (expiresAt === null || expiresAt > at) && this.#consentRowAllows(row, scope) &&
          this.#consentRowPolicyActive(row, participant, at);
      });
      if (active === undefined) {
        const hasWithdrawn = rows.some((row) =>
          rowString(row, "status") === "withdrawn" && this.#consentRowAllows(row, scope));
        throw new DomainError(
          hasWithdrawn ? "CONSENT_WITHDRAWN" : "CONSENT_REQUIRED",
          "Active exact-scope consent is required",
          { details: { participantId, purpose, resource: scope.resource, action: scope.action } },
        );
      }
      const consent = consentFromRow(active);
      const authorityValid = consent.grantorCapacity === "self"
        ? participant.minorStatus === "adult" && participant.ownerActorId === consent.grantorActorId
        : await this.#hasParticipantAuthorityForActor(
            client,
            context.tenantId,
            consent.grantorActorId,
            participantId,
            consent.grantorCapacity,
            consent.scope,
            at,
          );
      if (!authorityValid) {
        throw new DomainError("CONSENT_REQUIRED", "Consent grantor authority does not cover the requested lifetime", {
          details: { participantId, purpose, resource: scope.resource, action: scope.action, at },
        });
      }
      if (enforceSelfVisibility && !await this.#canAccessConsent(client, context, consent, "read")) {
        throw new DomainError("AUTH_FORBIDDEN", "Consent receipt is outside the actor's participant authority");
      }
      consents.push(consent);
    }
    return consents;
  }

  async #assertProcessingNotRestricted(
    client: PoolClient,
    tenantId: string,
    participantIds: readonly string[],
    purpose: string,
  ): Promise<void> {
    for (const participantId of participantIds) {
      const result = await client.query(
        `SELECT * FROM ltm.records
         WHERE tenant_id=$1 AND collection=$2 AND deleted_at IS NULL
           AND data->>'subjectParticipantId'=$3
         ORDER BY id`,
        [tenantId, RIGHTS_REQUEST_COLLECTION, participantId],
      );
      const blocking = result.rows.map((row) => recordFromRow(row as DbRow)).find((record) => {
        const data = parseRightsRequestRecord(record);
        return (data.requestType === "delete" || data.requestType === "restrict_processing") &&
          data.status !== "denied" &&
          (data.scope.requestedProcessingPurpose === "all" || data.scope.requestedProcessingPurpose === purpose);
      });
      if (blocking !== undefined) {
        throw new DomainError("PROCESSING_RESTRICTED", "Processing is frozen by an active data-subject rights request", {
          details: { participantId, purpose, rightsRequestId: blocking.id },
        });
      }
    }
  }

  async #authorizeConsentGrant(
    client: PoolClient,
    context: ActorContext,
    participant: ParticipantRecord,
    capacity: GrantConsentInput["grantorCapacity"],
    scope: ConsentScope,
  ): Promise<void> {
    if (capacity === "self") {
      if (participant.minorStatus === "minor" || participant.ownerActorId !== context.actorId ||
          (!hasPermission(context, "consent:grant:self") && !hasPermission(context, "consent:grant"))) {
        throw new DomainError("AUTH_FORBIDDEN", "Self consent requires the registered adult data-subject owner");
      }
      return;
    }
    if (capacity === "guardian") {
      if (participant.minorStatus !== "minor" || !context.roles.includes("guardian") ||
          context.guardianVerified !== true || !hasPermission(context, "consent:grant") ||
          !await this.#hasParticipantAuthority(
            client,
            context,
            participant.participantId,
            "guardian",
            scope,
            this.#now(),
          )) {
        throw new DomainError("GUARDIAN_VERIFICATION_REQUIRED", "Exact active guardian authority is required");
      }
      return;
    }
    if (!hasPermission(context, "consent:grant:agent") ||
        !await this.#hasParticipantAuthority(
          client,
          context,
          participant.participantId,
          "authorized_agent",
          scope,
          this.#now(),
        )) {
      throw new DomainError("AUTH_FORBIDDEN", "Exact durable authorized-agent authority is required");
    }
  }

  async #requiredConsent(
    client: PoolClient,
    tenantId: string,
    consentId: string,
    forUpdate = false,
  ): Promise<ConsentRecord> {
    const result = await client.query(
      `SELECT * FROM ltm.consents WHERE tenant_id=$1 AND id=$2${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, consentId],
    );
    const row = result.rows[0] as DbRow | undefined;
    if (row === undefined) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Consent was not found", { details: { consentId } });
    }
    return consentFromRow(row);
  }

  #ledgerLines(values: readonly LedgerLine[]): readonly LedgerLine[] {
    if (values.length < 2 || values.length > 1_000) {
      throw new DomainError("VALIDATION_FAILED", "A ledger transaction requires 2-1000 lines");
    }
    return values.map((line) => {
      const accountCode = token(line.accountCode, "account code", ACCOUNT_CODE);
      if (line.direction !== "debit" && line.direction !== "credit") {
        throw new DomainError("VALIDATION_FAILED", "Ledger direction must be debit or credit");
      }
      if (!Number.isSafeInteger(line.amountMinor) || line.amountMinor <= 0) {
        throw new DomainError("VALIDATION_FAILED", "Ledger amounts must be positive safe integers in minor units");
      }
      const currency = token(line.currency, "currency", CURRENCY);
      const memo = line.memo === undefined ? undefined : textValue(line.memo, "ledger memo", 500);
      return memo === undefined
        ? { accountCode, direction: line.direction, amountMinor: line.amountMinor, currency }
        : { accountCode, direction: line.direction, amountMinor: line.amountMinor, currency, memo };
    });
  }

  #assertBalanced(lines: readonly LedgerLine[]): void {
    const totals = new Map<string, { debit: number; credit: number }>();
    for (const line of lines) {
      const total = totals.get(line.currency) ?? { debit: 0, credit: 0 };
      total[line.direction] += line.amountMinor;
      if (!Number.isSafeInteger(total.debit) || !Number.isSafeInteger(total.credit)) {
        throw new DomainError("VALIDATION_FAILED", "Ledger totals exceed safe integer range");
      }
      totals.set(line.currency, total);
    }
    for (const [currency, total] of totals) {
      if (total.debit !== total.credit) {
        throw new DomainError("LEDGER_UNBALANCED", `Ledger transaction is not balanced for ${currency}`, {
          details: { currency, debitMinor: total.debit, creditMinor: total.credit },
        });
      }
    }
  }

  #assertExactReversal(original: readonly LedgerLine[], reversal: readonly LedgerLine[]): void {
    const summarize = (lines: readonly LedgerLine[], reverse: boolean): string => canonicalJson(
      [...lines].map((line) => ({
        accountCode: line.accountCode,
        currency: line.currency,
        direction: reverse ? (line.direction === "debit" ? "credit" : "debit") : line.direction,
        amountMinor: line.amountMinor,
      })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
    );
    if (summarize(original, true) !== summarize(reversal, false)) {
      throw new DomainError("LEDGER_UNBALANCED", "A reversal must exactly invert the original posted lines");
    }
  }

  async #requiredLedgerTransaction(
    client: PoolClient,
    tenantId: string,
    transactionId: string,
    forShare = false,
  ): Promise<LedgerTransaction> {
    const result = await client.query(
      `SELECT * FROM ltm.ledger_transactions
       WHERE tenant_id=$1 AND id=$2${forShare ? " FOR SHARE" : ""}`,
      [tenantId, transactionId],
    );
    const row = result.rows[0] as DbRow | undefined;
    if (row === undefined) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Ledger transaction was not found", { details: { transactionId } });
    }
    return this.#ledgerTransactionFromRow(client, row);
  }

  async #ledgerTransactionFromRow(client: PoolClient, row: DbRow): Promise<LedgerTransaction> {
    const tenantId = rowString(row, "tenant_id");
    const id = rowString(row, "id");
    const lineResult = await client.query(
      `SELECT account_code,direction,amount_minor,currency,memo FROM ltm.ledger_lines
       WHERE tenant_id=$1 AND transaction_id=$2 ORDER BY line_no`,
      [tenantId, id],
    );
    const lines = lineResult.rows.map((raw): LedgerLine => {
      const line = raw as DbRow;
      const direction = rowString(line, "direction");
      if (direction !== "debit" && direction !== "credit") {
        throw new DomainError("INTERNAL_ERROR", "Stored ledger direction is invalid");
      }
      const base = {
        accountCode: rowString(line, "account_code"),
        direction,
        amountMinor: rowInteger(line, "amount_minor"),
        currency: rowString(line, "currency"),
      } as const;
      const memo = rowNullableString(line, "memo");
      return memo === null ? base : { ...base, memo };
    });
    return {
      id,
      tenantId,
      sourceType: rowString(row, "source_type"),
      sourceId: rowString(row, "source_id"),
      description: rowString(row, "description"),
      occurredAt: rowTimestamp(row, "occurred_at"),
      createdAt: rowTimestamp(row, "created_at"),
      reversedTransactionId: rowNullableString(row, "reversed_transaction_id"),
      lines,
    };
  }

  async #requiredInbox(
    client: PoolClient,
    tenantId: string,
    eventId: string,
    forUpdate = false,
  ): Promise<InboxEvent> {
    const result = await client.query(
      `SELECT * FROM ltm.inbox WHERE tenant_id=$1 AND id=$2${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, eventId],
    );
    const row = result.rows[0] as DbRow | undefined;
    if (row === undefined) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Inbox event was not found", { details: { eventId } });
    }
    return inboxFromRow(row);
  }

  async #requiredOutbox(
    client: PoolClient,
    tenantId: string,
    eventId: string,
  ): Promise<OutboxEvent> {
    const result = await client.query(
      "SELECT * FROM ltm.outbox WHERE tenant_id=$1 AND id=$2",
      [tenantId, eventId],
    );
    const row = result.rows[0] as DbRow | undefined;
    if (row === undefined) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Outbox event was not found", { details: { eventId } });
    }
    return outboxFromRow(row);
  }

  async #emitOutbox(
    client: PoolClient,
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: JsonObject,
  ): Promise<OutboxEvent> {
    const id = randomUUID();
    const now = this.#now();
    const result = await client.query(
      `INSERT INTO ltm.outbox(
        tenant_id,id,aggregate_type,aggregate_id,event_type,payload,status,attempts,
        available_at,lease_owner,lease_until,created_at,published_at,last_error
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'pending',0,$7,NULL,NULL,$7,NULL,NULL)
      RETURNING *`,
      [tenantId, id, aggregateType, aggregateId, eventType, canonicalJson(payload), now],
    );
    const row = result.rows[0] as DbRow | undefined;
    if (row === undefined) throw new DomainError("INTERNAL_ERROR", "Outbox insertion returned no row");
    return outboxFromRow(row);
  }

  async #appendAuditInternal(
    client: PoolClient,
    context: ActorContext,
    input: AppendAuditInput,
  ): Promise<AuditEntry> {
    validateContext(context);
    const action = textValue(input.action, "audit action", 160);
    const resourceType = textValue(input.resourceType, "audit resource type", 120);
    const resourceId = textValue(input.resourceId, "audit resource ID", 160);
    const details = jsonObject(input.details ?? {}, "audit details");
    await this.#advisoryLock(client, `audit\n${context.tenantId}`);
    const previousResult = await client.query(
      "SELECT hash FROM ltm.audit_log WHERE tenant_id=$1 ORDER BY sequence DESC LIMIT 1",
      [context.tenantId],
    );
    const previousRow = previousResult.rows[0] as DbRow | undefined;
    const previousHash = previousRow === undefined ? GENESIS_HASH : rowString(previousRow, "hash");
    const id = randomUUID();
    const createdAt = this.#now();
    const hash = sha256(canonicalJson({
      id,
      tenantId: context.tenantId,
      actorId: context.actorId,
      action,
      resourceType,
      resourceId,
      purpose: context.purpose,
      requestId: context.requestId,
      details,
      previousHash,
      createdAt,
    }));
    const result = await client.query(
      `INSERT INTO ltm.audit_log(
        id,tenant_id,actor_id,action,resource_type,resource_id,purpose,request_id,
        details,previous_hash,hash,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
      RETURNING *`,
      [
        id,
        context.tenantId,
        context.actorId,
        action,
        resourceType,
        resourceId,
        context.purpose,
        context.requestId,
        canonicalJson(details),
        previousHash,
        hash,
        createdAt,
      ],
    );
    const row = result.rows[0] as DbRow | undefined;
    if (row === undefined) throw new DomainError("INTERNAL_ERROR", "Audit insertion returned no row");
    return auditFromRow(row);
  }

  async #verifyAuditTenant(client: PoolClient, tenantId: string): Promise<AuditVerification> {
    const result = await client.query(
      "SELECT * FROM ltm.audit_log WHERE tenant_id=$1 ORDER BY sequence",
      [tenantId],
    );
    return verifyAuditRows(result.rows as DbRow[]);
  }

  #authorizeServiceOperation(context: ActorContext, permission: string): void {
    if (!context.roles.includes("service_account")) {
      throw new DomainError("AUTH_FORBIDDEN", `${permission} is restricted to service accounts`);
    }
    this.authorize(context, permission, { tenantId: context.tenantId });
  }

  async #insertRequestedExternalCommand(
    client: PoolClient,
    context: ActorContext,
    input: {
      readonly commandId: string;
      readonly batchId: `B${string}`;
      readonly operation: string;
      readonly aggregateCollection: string;
      readonly aggregateId: string;
      readonly details: JsonObject;
    },
    now: string,
  ): Promise<ExternalCommandRecord> {
    assertExternalCommandTransition(null, "requested");
    await client.query(
      `INSERT INTO ltm.external_commands(
        tenant_id,command_id,batch_id,operation,aggregate_collection,aggregate_id,state,
        provider_operation_id,evidence_id,decision_state,reconciliation_state,version,
        requested_at,updated_at,terminal_at,details
      ) VALUES ($1,$2,$3,$4,$5,$6,'requested',NULL,NULL,'active','clear',1,$7,$7,NULL,$8::jsonb)`,
      [
        context.tenantId,
        input.commandId,
        input.batchId,
        input.operation,
        input.aggregateCollection,
        input.aggregateId,
        now,
        canonicalJson(input.details),
      ],
    );
    await client.query(
      `INSERT INTO ltm.external_command_transitions(
        tenant_id,transition_id,command_id,from_state,to_state,provider_operation_id,evidence_id,details,occurred_at
      ) VALUES ($1,$2,$3,NULL,'requested',NULL,NULL,$4::jsonb,$5)`,
      [context.tenantId, randomUUID(), input.commandId, canonicalJson(input.details), now],
    );
    const command = await this.#requiredExternalCommand(client, context.tenantId, input.commandId);
    await this.#emitOutbox(
      client,
      context.tenantId,
      input.aggregateCollection,
      input.aggregateId,
      "external_command.requested",
      { command: jsonObject(command) },
    );
    return command;
  }

  async #requiredExternalCommand(
    client: PoolClient,
    tenantId: string,
    commandId: string,
    forUpdate = false,
  ): Promise<ExternalCommandRecord> {
    const result = await client.query(
      `SELECT * FROM ltm.external_commands
       WHERE tenant_id=$1 AND command_id=$2${forUpdate ? " FOR UPDATE" : ""}`,
      [tenantId, commandId],
    );
    const row = result.rows[0] as DbRow | undefined;
    if (row === undefined) {
      throw new DomainError("RESOURCE_NOT_FOUND", "External command was not found", { details: { commandId } });
    }
    return externalCommandFromRow(row);
  }

  async #transitionExternalCommandInternal(
    client: PoolClient,
    context: ActorContext,
    input: TransitionExternalCommandInput,
    transitionId: string,
  ): Promise<ExternalCommandRecord> {
    await this.#advisoryLock(client, `external-command\n${context.tenantId}\n${input.commandId}`);
    const current = await this.#requiredExternalCommand(client, context.tenantId, input.commandId, true);
    if (current.batchId !== input.batchId || current.operation !== input.operation ||
        current.aggregateCollection !== input.aggregateCollection || current.aggregateId !== input.aggregateId) {
      throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "External command correlation does not match its aggregate");
    }
    if (current.decisionState === "frozen" || current.reconciliationState === "reconciliation_required") {
      throw new DomainError("EVIDENCE_REVOKED", "External command is frozen pending reconciliation");
    }
    assertExternalCommandTransition(current.state, input.toState);
    if (isExternalCommandTerminal(input.toState) && (input.evidenceId === undefined || input.evidenceId === null)) {
      throw new DomainError("EXTERNAL_EVIDENCE_UNVERIFIED", "Terminal external command transitions require signed evidence");
    }
    const requestedProviderOperationId = input.providerOperationId ?? null;
    if (current.providerOperationId !== null && requestedProviderOperationId !== null &&
        current.providerOperationId !== requestedProviderOperationId) {
      throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "External command provider operation ID changed");
    }
    const requestedEvidenceId = input.evidenceId ?? null;
    if (requestedEvidenceId !== null) {
      const evidence = await this.#requiredEvidence(client, context.tenantId, requestedEvidenceId, true);
      if (evidence.status !== "verified") throw new DomainError("EVIDENCE_REVOKED", "Command evidence is revoked");
    }
    if (current.evidenceId !== null && requestedEvidenceId !== null && current.evidenceId !== requestedEvidenceId) {
      throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "External command evidence correlation changed");
    }
    const providerOperationId = current.providerOperationId ?? requestedProviderOperationId;
    const evidenceId = current.evidenceId ?? requestedEvidenceId;
    const details = jsonObject({ ...current.details, ...(input.details ?? {}) }, "external command details");
    const now = this.#now();
    const terminalAt = isExternalCommandTerminal(input.toState) ? now : current.terminalAt;
    const updated = await client.query(
      `UPDATE ltm.external_commands SET state=$1,provider_operation_id=$2,evidence_id=$3,version=version+1,
         updated_at=$4,terminal_at=$5,details=$6::jsonb
       WHERE tenant_id=$7 AND command_id=$8 AND version=$9 AND state=$10`,
      [
        input.toState,
        providerOperationId,
        evidenceId,
        now,
        terminalAt,
        canonicalJson(details),
        context.tenantId,
        input.commandId,
        current.version,
        current.state,
      ],
    );
    if (updated.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "External command changed concurrently");
    await client.query(
      `INSERT INTO ltm.external_command_transitions(
        tenant_id,transition_id,command_id,from_state,to_state,provider_operation_id,evidence_id,details,occurred_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [
        context.tenantId,
        transitionId,
        input.commandId,
        current.state,
        input.toState,
        providerOperationId,
        evidenceId,
        canonicalJson(input.details ?? {}),
        now,
      ],
    );
    const aggregate = await this.#requiredRecord(
      client,
      context.tenantId,
      current.aggregateCollection,
      current.aggregateId,
      false,
      true,
    );
    const aggregateData = jsonObject({
      ...aggregate.data,
      externalCommandId: current.commandId,
      commandState: input.toState,
      executionState: input.toState,
      externalReceipt: {
        providerOperationId,
        evidenceId,
        state: input.toState,
        updatedAt: now,
      },
    }, "external command aggregate data");
    const recordUpdate = await client.query(
      `UPDATE ltm.records SET data=$1::jsonb,version=version+1,updated_at=$2
       WHERE tenant_id=$3 AND collection=$4 AND id=$5 AND version=$6 AND deleted_at IS NULL`,
      [
        canonicalJson(aggregateData),
        now,
        context.tenantId,
        current.aggregateCollection,
        current.aggregateId,
        aggregate.version,
      ],
    );
    if (recordUpdate.rowCount !== 1) {
      throw new DomainError("VERSION_CONFLICT", "External command aggregate changed concurrently");
    }
    const command = await this.#requiredExternalCommand(client, context.tenantId, input.commandId);
    await this.#appendAuditInternal(client, context, {
      action: "external_command.transitioned",
      resourceType: current.aggregateCollection,
      resourceId: current.aggregateId,
      details: {
        commandId: input.commandId,
        fromState: current.state,
        toState: input.toState,
        providerOperationId,
        evidenceId,
      },
    });
    await this.#emitOutbox(
      client,
      context.tenantId,
      current.aggregateCollection,
      current.aggregateId,
      `external_command.${input.toState}`,
      { command: jsonObject(command) },
    );
    return command;
  }

  async #transitionExternalCommandFromBusinessEvent(
    client: PoolClient,
    context: ActorContext,
    event: ApplyExternalBusinessEventInput["event"],
    input: TransitionExternalCommandInput,
  ): Promise<ExternalCommandRecord> {
    if (input.commandId !== event.subjectId || event.correlationId !== event.subjectId) {
      throw new DomainError(
        "EVENT_FINGERPRINT_CONFLICT",
        "External-command callback must bind its exact subject and correlation to the command ID",
      );
    }
    const current = await this.#requiredExternalCommand(client, context.tenantId, input.commandId, true);
    if (input.toState === "succeeded" && current.state === "dispatched") {
      await this.#transitionExternalCommandInternal(client, context, {
        ...input,
        toState: "acknowledged",
        details: {
          ...(input.details ?? {}),
          implicitProviderAcknowledgement: true,
          providerResultSha256: event.artifactSha256,
        },
      }, randomUUID());
    }
    return this.#transitionExternalCommandInternal(client, context, input, randomUUID());
  }

  #assertBusinessEvidenceBinding(event: ApplyExternalBusinessEventInput["event"], evidence: SignedExternalEvidence): void {
    if (evidence.evidenceId !== event.evidenceId || evidence.tenantId !== event.tenantId ||
        evidence.provider !== event.provider || evidence.scope !== event.evidenceScope ||
        evidence.artifactSha256 !== event.artifactSha256) {
      throw new DomainError("EVIDENCE_SCOPE_MISMATCH", "Signed evidence does not match the business event binding");
    }
    if (evidence.canonicalClaimsSha256 !== event.canonicalClaimsSha256 ||
        evidence.businessEventSha256 !== event.businessEventSha256) {
      throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Signed evidence does not bind the canonical business event");
    }
  }

  async #registerBusinessEvidence(
    client: PoolClient,
    context: ActorContext,
    evidence: SignedExternalEvidence,
  ): Promise<void> {
    const locks = [
      `evidence-id\n${context.tenantId}\n${evidence.evidenceId}`,
      `evidence-nonce\n${context.tenantId}\n${evidence.issuer}\n${evidence.provider}\n${evidence.nonce}`,
    ].sort();
    for (const lock of locks) await this.#advisoryLock(client, lock);
    const existingResult = await client.query(
      `${this.#evidenceSelectSql()} WHERE e.tenant_id=$1 AND e.id=$2 FOR UPDATE OF e`,
      [context.tenantId, evidence.evidenceId],
    );
    const existingRow = existingResult.rows[0] as DbRow | undefined;
    if (existingRow !== undefined) {
      const existing = evidenceFromRow(existingRow);
      const signedExisting: SignedExternalEvidence = {
        version: existing.version,
        evidenceId: existing.evidenceId,
        tenantId: existing.tenantId,
        issuer: existing.issuer,
        provider: existing.provider,
        environment: existing.environment,
        scope: existing.scope,
        artifactSha256: existing.artifactSha256,
        ...(existing.canonicalClaimsSha256 === undefined
          ? {}
          : { canonicalClaimsSha256: existing.canonicalClaimsSha256 }),
        ...(existing.businessEventSha256 === undefined
          ? {}
          : { businessEventSha256: existing.businessEventSha256 }),
        issuedAt: existing.issuedAt,
        expiresAt: existing.expiresAt,
        nonce: existing.nonce,
        replayPolicy: existing.replayPolicy,
        algorithm: existing.algorithm,
        keyId: existing.keyId,
        signature: existing.signature,
      };
      if (canonicalJson(signedExisting) !== canonicalJson(evidence)) {
        throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Evidence ID was reused with a different signed envelope");
      }
      if (existing.status !== "verified") throw new DomainError("EVIDENCE_REVOKED", "External evidence has been revoked");
      return;
    }
    const nonceConflict = await client.query(
      `SELECT id FROM ltm.external_evidence
       WHERE tenant_id=$1 AND issuer=$2 AND provider=$3 AND nonce=$4 LIMIT 1 FOR UPDATE`,
      [context.tenantId, evidence.issuer, evidence.provider, evidence.nonce],
    );
    const conflictRow = nonceConflict.rows[0] as DbRow | undefined;
    if (conflictRow !== undefined) {
      throw new DomainError("EVIDENCE_REPLAY_DETECTED", "Evidence nonce was already registered", {
        details: { evidenceId: rowString(conflictRow, "id") },
      });
    }
    const verifiedAt = this.#now();
    await client.query(
      `INSERT INTO ltm.external_evidence(
        tenant_id,id,envelope_version,issuer,provider,environment,scope,artifact_sha256,
        canonical_claims_sha256,business_event_sha256,issued_at,expires_at,nonce,replay_policy,
        algorithm,key_id,signature,status,version,verified_at,revoked_at,revocation_reason
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'verified',1,$18,NULL,NULL)`,
      [
        context.tenantId,
        evidence.evidenceId,
        evidence.version,
        evidence.issuer,
        evidence.provider,
        evidence.environment,
        evidence.scope,
        evidence.artifactSha256,
        evidence.canonicalClaimsSha256 ?? null,
        evidence.businessEventSha256 ?? null,
        evidence.issuedAt,
        evidence.expiresAt,
        evidence.nonce,
        evidence.replayPolicy,
        evidence.algorithm,
        evidence.keyId,
        evidence.signature,
        verifiedAt,
      ],
    );
    await this.#appendAuditInternal(client, context, {
      action: "evidence.registered_with_business_event",
      resourceType: "external_evidence",
      resourceId: evidence.evidenceId,
      details: {
        provider: evidence.provider,
        scope: evidence.scope,
        businessEventSha256: evidence.businessEventSha256 ?? null,
      },
    });
  }

  async #receiveBusinessInbox(
    client: PoolClient,
    context: ActorContext,
    event: ApplyExternalBusinessEventInput["event"],
  ): Promise<InboxEvent> {
    const requestFingerprint = fingerprint("external-event.apply.inbox", event);
    const existing = await client.query(
      `SELECT * FROM ltm.inbox WHERE tenant_id=$1 AND source=$2 AND source_event_id=$3 FOR UPDATE`,
      [context.tenantId, event.provider, event.eventId],
    );
    const existingRow = existing.rows[0] as DbRow | undefined;
    if (existingRow !== undefined) {
      if (rowString(existingRow, "request_fingerprint") !== requestFingerprint) {
        throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Inbox event ID was reused with different business facts");
      }
      return inboxFromRow(existingRow);
    }
    const id = randomUUID();
    const receivedAt = this.#now();
    const inserted = await client.query(
      `INSERT INTO ltm.inbox(
        tenant_id,id,source,source_event_id,event_type,request_fingerprint,payload,status,received_at,processed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'received',$8,NULL) RETURNING *`,
      [
        context.tenantId,
        id,
        event.provider,
        event.eventId,
        event.eventType,
        requestFingerprint,
        canonicalJson(event),
        receivedAt,
      ],
    );
    const row = inserted.rows[0] as DbRow | undefined;
    if (row === undefined) throw new DomainError("INTERNAL_ERROR", "Business inbox insertion returned no row");
    return inboxFromRow(row);
  }

  async #consumeBusinessEvidence(
    client: PoolClient,
    context: ActorContext,
    evidence: RegisteredExternalEvidence,
    event: ApplyExternalBusinessEventInput["event"],
  ): Promise<void> {
    if (evidence.status !== "verified") throw new DomainError("EVIDENCE_REVOKED", "External evidence has been revoked");
    if (evidence.expiresAt <= this.#now()) throw new DomainError("EVIDENCE_EXPIRED", "External evidence has expired");
    this.#verifyStoredEvidence(evidence);
    if (evidence.replayPolicy !== "single_use") return;
    const consumptionKeyHash = sha256(canonicalJson({
      tenantId: context.tenantId,
      provider: event.provider,
      eventId: event.eventId,
      scope: event.evidenceScope,
      businessEventSha256: event.businessEventSha256,
    }));
    if (evidence.consumptionKeyHash !== null) {
      if (evidence.consumptionKeyHash !== consumptionKeyHash) {
        throw new DomainError("EVIDENCE_REPLAY_DETECTED", "Single-use business evidence was already consumed");
      }
      return;
    }
    const inserted = await client.query(
      `INSERT INTO ltm.evidence_consumptions(tenant_id,evidence_id,scope,consumption_key_hash,consumed_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id,evidence_id) DO NOTHING RETURNING consumption_key_hash`,
      [context.tenantId, evidence.evidenceId, event.evidenceScope, consumptionKeyHash, this.#now()],
    );
    if (inserted.rowCount === 0) {
      const current = await this.#requiredEvidence(client, context.tenantId, evidence.evidenceId);
      if (current.consumptionKeyHash !== consumptionKeyHash) {
        throw new DomainError("EVIDENCE_REPLAY_DETECTED", "Single-use business evidence was already consumed");
      }
    }
  }

  #externalAggregateState(current: RecordEnvelope | null, stateField: string): string | null {
    if (current === null) return null;
    const state = current.data[stateField];
    if (state === undefined) return null;
    if (typeof state !== "string") {
      throw new DomainError("VERSION_CONFLICT", "Existing aggregate does not expose the reducer state field");
    }
    return state;
  }

  #assertExternalEventOrder(current: RecordEnvelope | null, event: ApplyExternalBusinessEventInput["event"]): void {
    if (current === null) return;
    const positionsValue = current.data._externalEventPositions;
    if (positionsValue === undefined) return;
    const positions = jsonObject(positionsValue, "stored external event positions");
    const priorValue = positions[event.provider];
    if (priorValue === undefined) return;
    const prior = jsonObject(priorValue, "stored provider event position");
    const priorOccurredAt = prior.providerOccurredAt;
    const priorSequence = prior.sequence;
    if (typeof priorOccurredAt !== "string" ||
        (priorSequence !== null &&
          (typeof priorSequence !== "number" || !Number.isSafeInteger(priorSequence)))) {
      throw new DomainError("INTERNAL_ERROR", "Stored external event position is invalid");
    }
    const outOfOrder = event.sequence !== null && typeof priorSequence === "number"
      ? event.sequence <= priorSequence
      : event.providerOccurredAt <= priorOccurredAt;
    if (outOfOrder) {
      throw new DomainError("VERSION_CONFLICT", "External business event is out of order", {
        details: {
          provider: event.provider,
          eventId: event.eventId,
          priorSequence,
          sequence: event.sequence,
          priorOccurredAt,
          providerOccurredAt: event.providerOccurredAt,
        },
      });
    }
  }

  async #persistExternalAggregate(
    client: PoolClient,
    context: ActorContext,
    target: ReturnType<typeof normalizeExternalBusinessAggregateTarget>,
    reduction: ExternalBusinessReduction & { readonly stateField: string },
    current: RecordEnvelope | null,
    event: ApplyExternalBusinessEventInput["event"],
  ): Promise<RecordEnvelope> {
    const currentData = current?.data ?? {};
    const positions = currentData._externalEventPositions === undefined
      ? {}
      : jsonObject(currentData._externalEventPositions, "stored external event positions");
    const evidenceIdsValue = currentData._externalEvidenceIds;
    const evidenceIds = Array.isArray(evidenceIdsValue) && evidenceIdsValue.every((entry) => typeof entry === "string")
      ? [...evidenceIdsValue]
      : [];
    if (!evidenceIds.includes(event.evidenceId)) evidenceIds.push(event.evidenceId);
    const data = jsonObject({
      ...currentData,
      ...reduction.patch,
      [reduction.stateField]: reduction.nextState,
      _externalEventPositions: {
        ...positions,
        [event.provider]: {
          eventId: event.eventId,
          sequence: event.sequence,
          providerOccurredAt: event.providerOccurredAt,
        },
      },
      _externalDecisionState: "active",
      _externalReconciliationState: "clear",
      _externalEvidenceIds: evidenceIds,
      _externalLastBusinessEventSha256: event.businessEventSha256,
    }, "external business aggregate data");
    const now = this.#now();
    if (current === null) {
      const processingPurpose = this.#processingPurposeForCreate(context);
      const ownerActorId = target.ownerActorId === undefined ? context.actorId : target.ownerActorId;
      this.authorize(context, "record:create", {
        tenantId: context.tenantId,
        ownerActorId,
        containsMinor: target.containsMinor,
      });
      this.#protectMinorSharing(context, target.collection, target.containsMinor);
      await this.#requireParticipantConsent(
        client,
        context,
        target.participantIds,
        processingPurpose,
        deriveRecordConsentRequirementScope(target.collection, target.aggregateId, data, "create"),
      );
      await client.query(
        `INSERT INTO ltm.records(
          tenant_id,collection,id,processing_purpose,owner_actor_id,participant_ids,contains_minor,data,
          version,created_at,updated_at,deleted_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,1,$9,$9,NULL)`,
        [
          context.tenantId,
          target.collection,
          target.aggregateId,
          processingPurpose,
          ownerActorId,
          target.participantIds,
          target.containsMinor,
          canonicalJson(data),
          now,
        ],
      );
    } else {
      if (current.deletedAt !== null) throw new DomainError("VERSION_CONFLICT", "External business aggregate is deleted");
      await this.#assertRecordProcessingPurpose(client, context, current, "update");
      await this.#requireParticipantConsent(
        client,
        context,
        current.participantIds,
        current.processingPurpose,
        deriveRecordConsentRequirementScope(current.collection, current.id, current.data, "update"),
      );
      await this.#requireParticipantConsent(
        client,
        context,
        current.participantIds,
        current.processingPurpose,
        deriveRecordConsentRequirementScope(current.collection, current.id, data, "update"),
      );
      const updated = await client.query(
        `UPDATE ltm.records SET data=$1::jsonb,version=version+1,updated_at=$2
         WHERE tenant_id=$3 AND collection=$4 AND id=$5 AND version=$6 AND deleted_at IS NULL`,
        [canonicalJson(data), now, context.tenantId, target.collection, target.aggregateId, current.version],
      );
      if (updated.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "External business aggregate changed concurrently");
    }
    return this.#requiredRecord(client, context.tenantId, target.collection, target.aggregateId, true);
  }

  async #postExternalBusinessLedger(
    client: PoolClient,
    context: ActorContext,
    input: NonNullable<ExternalBusinessReduction["ledger"]>,
  ): Promise<LedgerTransaction> {
    const transactionId = token(input.transactionId ?? randomUUID(), "transaction ID");
    const lines = this.#ledgerLines(input.lines);
    this.#assertBalanced(lines);
    const sourceFingerprint = fingerprint("ledger.post.source", {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      description: input.description,
      requestedOccurredAt: input.occurredAt ?? null,
      reversedTransactionId: input.reversedTransactionId ?? null,
      lines,
    });
    await this.#advisoryLock(client, `ledger-source\n${context.tenantId}\n${input.sourceType}\n${input.sourceId}`);
    const existing = await client.query(
      `SELECT * FROM ltm.ledger_transactions
       WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 FOR SHARE`,
      [context.tenantId, input.sourceType, input.sourceId],
    );
    const existingRow = existing.rows[0] as DbRow | undefined;
    if (existingRow !== undefined) {
      if (rowString(existingRow, "request_fingerprint") !== sourceFingerprint) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "Ledger source reference was reused with different business data");
      }
      return this.#ledgerTransactionFromRow(client, existingRow);
    }
    const reversedTransactionId = input.reversedTransactionId ?? null;
    if (reversedTransactionId !== null) {
      const reversed = await this.#requiredLedgerTransaction(client, context.tenantId, reversedTransactionId, true);
      this.#assertExactReversal(reversed.lines, lines);
    }
    const occurredAt = input.occurredAt ?? this.#now();
    const createdAt = this.#now();
    await client.query(
      `INSERT INTO ltm.ledger_transactions(
        tenant_id,id,source_type,source_id,request_fingerprint,description,occurred_at,created_at,reversed_transaction_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        context.tenantId,
        transactionId,
        input.sourceType,
        input.sourceId,
        sourceFingerprint,
        input.description,
        occurredAt,
        createdAt,
        reversedTransactionId,
      ],
    );
    for (const [index, line] of lines.entries()) {
      await client.query(
        `INSERT INTO ltm.ledger_lines(
          tenant_id,transaction_id,line_no,account_code,direction,amount_minor,currency,memo
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          context.tenantId,
          transactionId,
          index + 1,
          line.accountCode,
          line.direction,
          line.amountMinor,
          line.currency,
          line.memo ?? null,
        ],
      );
    }
    const transaction = await this.#requiredLedgerTransaction(client, context.tenantId, transactionId);
    await this.#appendAuditInternal(client, context, {
      action: "ledger.posted_from_external_business_event",
      resourceType: "ledger_transaction",
      resourceId: transactionId,
      details: { sourceType: input.sourceType, sourceId: input.sourceId, lineCount: lines.length },
    });
    await this.#emitOutbox(client, context.tenantId, "ledger_transaction", transactionId, "ledger.transaction.posted", {
      transaction: jsonObject(transaction),
    });
    return transaction;
  }

  async #projectEvidenceRevocation(
    client: PoolClient,
    context: ActorContext,
    evidenceId: string,
    reason: string,
    revokedAt: string,
  ): Promise<void> {
    const decisionResult = await client.query(
      `SELECT aggregate_collection,aggregate_id,decision_type,decision_id
       FROM ltm.evidence_decisions
       WHERE tenant_id=$1 AND evidence_id=$2 AND decision_state='active' FOR UPDATE`,
      [context.tenantId, evidenceId],
    );
    const decisions = decisionResult.rows as DbRow[];
    const aggregates = new Map<string, { readonly collection: string; readonly id: string }>();
    for (const decision of decisions) {
      const collection = rowString(decision, "aggregate_collection");
      const id = rowString(decision, "aggregate_id");
      aggregates.set(`${collection}\n${id}`, { collection, id });
    }
    for (const aggregateIdentity of [...aggregates.values()].sort((left, right) =>
      `${left.collection}\n${left.id}`.localeCompare(`${right.collection}\n${right.id}`))) {
      await this.#advisoryLock(
        client,
        `record\n${context.tenantId}\n${aggregateIdentity.collection}\n${aggregateIdentity.id}`,
      );
      const aggregate = await this.#requiredRecord(
        client,
        context.tenantId,
        aggregateIdentity.collection,
        aggregateIdentity.id,
        true,
        true,
      );
      if (aggregate.deletedAt !== null) continue;
      const revokedIdsValue = aggregate.data._externalRevokedEvidenceIds;
      const revokedIds = Array.isArray(revokedIdsValue) && revokedIdsValue.every((entry) => typeof entry === "string")
        ? [...revokedIdsValue]
        : [];
      if (!revokedIds.includes(evidenceId)) revokedIds.push(evidenceId);
      const data = jsonObject({
        ...aggregate.data,
        _externalDecisionState: "frozen",
        _externalReconciliationState: "reconciliation_required",
        _externalRevokedEvidenceIds: revokedIds,
        _externalEvidenceRevokedAt: revokedAt,
      }, "revoked external decision aggregate");
      const updated = await client.query(
        `UPDATE ltm.records SET data=$1::jsonb,version=version+1,updated_at=$2
         WHERE tenant_id=$3 AND collection=$4 AND id=$5 AND version=$6 AND deleted_at IS NULL`,
        [
          canonicalJson(data),
          revokedAt,
          context.tenantId,
          aggregate.collection,
          aggregate.id,
          aggregate.version,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new DomainError("VERSION_CONFLICT", "Evidence-dependent aggregate changed concurrently");
      }
      await this.#emitOutbox(
        client,
        context.tenantId,
        aggregate.collection,
        aggregate.id,
        `${aggregate.collection}.reconciliation_required`,
        { evidenceId, reason, revokedAt },
      );
    }
    if (decisions.length > 0) {
      await client.query(
        `UPDATE ltm.evidence_decisions
         SET decision_state='frozen',reconciliation_state='reconciliation_required',updated_at=$1
         WHERE tenant_id=$2 AND evidence_id=$3 AND decision_state='active'`,
        [revokedAt, context.tenantId, evidenceId],
      );
      await client.query(
        `UPDATE ltm.external_commands
         SET decision_state='frozen',reconciliation_state='reconciliation_required',version=version+1,updated_at=$1
         WHERE tenant_id=$2 AND evidence_id=$3 AND decision_state='active'`,
        [revokedAt, context.tenantId, evidenceId],
      );
      await this.#appendAuditInternal(client, context, {
        action: "evidence.revocation_projected",
        resourceType: "external_evidence",
        resourceId: evidenceId,
        details: {
          decisionCount: decisions.length,
          aggregateCount: aggregates.size,
          reconciliationState: "reconciliation_required",
        },
      });
    }
  }

  #validateEvidenceTrustConfiguration(): void {
    if (this.#evidencePolicy === "production" && this.#trustedEvidenceKeys.length === 0) {
      throw new DomainError("CONFIGURATION_INVALID", "Production evidence policy requires trusted public keys");
    }
    if (this.#evidencePolicy === "production" && this.#evidenceEnvironment !== "production") {
      throw new DomainError("CONFIGURATION_INVALID", "Production evidence policy requires the production evidence environment");
    }
    const identities = new Set<string>();
    for (const key of this.#trustedEvidenceKeys) {
      token(key.issuer, "trusted evidence issuer");
      token(key.provider, "trusted evidence provider");
      token(key.keyId, "trusted evidence key ID");
      validateTrustedEvidenceKey(key);
      for (const environment of key.allowedEnvironments) {
        if (!["test", "sandbox", "staging", "production"].includes(environment)) {
          throw new DomainError("CONFIGURATION_INVALID", "Trusted evidence key contains an invalid environment");
        }
      }
      if (this.#evidencePolicy === "production" && !key.allowedEnvironments.includes("production")) {
        throw new DomainError("CONFIGURATION_INVALID", "Production trusted evidence keys must allow production evidence");
      }
      if (this.#evidencePolicy === "production" &&
          (/^(?:test|sandbox)(?:[:._-]|$)/i.test(key.issuer) || /^(?:test|sandbox)(?:[:._-]|$)/i.test(key.provider))) {
        throw new DomainError("CONFIGURATION_INVALID", "Production cannot trust test or sandbox evidence issuers/providers");
      }
      if (key.notBefore !== undefined && isoTimestamp(key.notBefore, "trusted key notBefore") !== key.notBefore) {
        throw new DomainError("CONFIGURATION_INVALID", "Trusted key notBefore must be canonical UTC ISO-8601");
      }
      if (key.notAfter !== undefined && isoTimestamp(key.notAfter, "trusted key notAfter") !== key.notAfter) {
        throw new DomainError("CONFIGURATION_INVALID", "Trusted key notAfter must be canonical UTC ISO-8601");
      }
      if (key.notBefore !== undefined && key.notAfter !== undefined && key.notAfter <= key.notBefore) {
        throw new DomainError("CONFIGURATION_INVALID", "Trusted key validity window is invalid");
      }
      const identity = `${key.issuer}\n${key.provider}\n${key.keyId}`;
      if (identities.has(identity)) {
        throw new DomainError("CONFIGURATION_INVALID", "Trusted evidence key identities must be unique");
      }
      identities.add(identity);
    }
  }

  #consentPolicyReadiness(at: string): ReadinessResult["consentPolicy"] {
    if (this.#allowLegacyConsentPolicy) return "legacy_test_only";
    if (this.#consentPolicyCatalog === null || this.#consentPolicyJurisdiction === null ||
        this.#consentPolicyLocale === null) return "error";
    const document = this.#consentPolicyCatalog.document;
    const trustActive = this.#trustedConsentPolicyKeys.some((key) =>
      key.keyId === document.keyId && key.issuer === document.issuer &&
      key.allowedEnvironments.includes(this.#evidenceEnvironment) &&
      key.notBefore <= at && key.notAfter > at && (key.revokedAt === undefined || key.revokedAt === null || key.revokedAt > at));
    return document.issuedAt <= at && document.expiresAt > at && trustActive ? "ok" : "error";
  }

  #requiredActiveConsentPolicy(at: string): VerifiedConsentPolicyCatalog {
    if (this.#consentPolicyReadiness(at) !== "ok" || this.#consentPolicyCatalog === null) {
      throw new DomainError("CONFIGURATION_INVALID", "A currently valid signed consent policy catalog is required");
    }
    return this.#consentPolicyCatalog;
  }

  #validateSignedEvidence(context: ActorContext, value: SignedExternalEvidence): SignedExternalEvidence {
    if (this.#trustedEvidenceKeys.length === 0) {
      throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", "No trusted external evidence keys are configured");
    }
    if (value.version !== "ltm.external-evidence.v1") {
      throw new DomainError("VALIDATION_FAILED", "Unsupported external evidence envelope version");
    }
    if (value.tenantId !== context.tenantId) {
      throw new DomainError("TENANT_SCOPE_MISMATCH", "External evidence tenant does not match the authenticated tenant");
    }
    const evidenceId = token(value.evidenceId, "external evidence ID");
    const tenantId = token(value.tenantId, "external evidence tenant ID");
    const issuer = token(value.issuer, "external evidence issuer");
    const provider = token(value.provider, "external evidence provider");
    const environment = value.environment;
    if (!["test", "sandbox", "staging", "production"].includes(environment)) {
      throw new DomainError("VALIDATION_FAILED", "External evidence environment is invalid");
    }
    if (environment !== this.#evidenceEnvironment) {
      throw new DomainError("EVIDENCE_TRUST_KEY_NOT_FOUND", "External evidence environment is not trusted by this runtime", {
        details: { evidenceEnvironment: environment, runtimeEnvironment: this.#evidenceEnvironment },
      });
    }
    const scope = textValue(value.scope, "external evidence scope", 512);
    const artifactSha256 = value.artifactSha256.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(artifactSha256) || artifactSha256 !== value.artifactSha256) {
      throw new DomainError("VALIDATION_FAILED", "artifactSha256 must be a lowercase SHA-256 digest");
    }
    const optionalDigest = (candidate: string | undefined, label: string): string | undefined => {
      if (candidate === undefined) return undefined;
      const normalized = candidate.trim().toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(normalized) || normalized !== candidate) {
        throw new DomainError("VALIDATION_FAILED", `${label} must be a lowercase SHA-256 digest`);
      }
      return normalized;
    };
    const canonicalClaimsSha256 = optionalDigest(value.canonicalClaimsSha256, "canonicalClaimsSha256");
    const businessEventSha256 = optionalDigest(value.businessEventSha256, "businessEventSha256");
    const issuedAt = isoTimestamp(value.issuedAt, "external evidence issuedAt");
    const expiresAt = isoTimestamp(value.expiresAt, "external evidence expiresAt");
    if (issuedAt !== value.issuedAt || expiresAt !== value.expiresAt) {
      throw new DomainError("VALIDATION_FAILED", "Evidence timestamps must use canonical UTC ISO-8601 format");
    }
    const nonce = token(value.nonce, "external evidence nonce");
    if (nonce.length < 16) {
      throw new DomainError("VALIDATION_FAILED", "External evidence nonce must contain at least 16 characters");
    }
    if (value.replayPolicy !== "reusable" && value.replayPolicy !== "single_use") {
      throw new DomainError("VALIDATION_FAILED", "External evidence replayPolicy is invalid");
    }
    if (value.algorithm !== "Ed25519") {
      throw new DomainError("VALIDATION_FAILED", "Only Ed25519 external evidence signatures are supported");
    }
    const keyId = token(value.keyId, "external evidence key ID");
    const signature = textValue(value.signature, "external evidence signature", 160);
    if (!/^[A-Za-z0-9_-]{80,100}$/.test(signature)) {
      throw new DomainError("EVIDENCE_SIGNATURE_INVALID", "External evidence signature encoding is invalid");
    }
    const issuedTime = new Date(issuedAt).getTime();
    const expiresTime = new Date(expiresAt).getTime();
    const now = this.#clock.now().getTime();
    if (issuedTime > now + this.#evidenceClockSkewMs) {
      throw new DomainError("EVIDENCE_SIGNATURE_INVALID", "External evidence issuance time is in the future");
    }
    if (expiresTime <= now || expiresTime <= issuedTime) {
      throw new DomainError("EVIDENCE_EXPIRED", "External evidence is expired or has an invalid validity window");
    }
    if (expiresTime - issuedTime > this.#maxEvidenceLifetimeMs) {
      throw new DomainError("VALIDATION_FAILED", "External evidence lifetime exceeds the configured maximum");
    }
    const evidence: SignedExternalEvidence = {
      version: value.version,
      evidenceId,
      tenantId,
      issuer,
      provider,
      environment,
      scope,
      artifactSha256,
      ...(canonicalClaimsSha256 === undefined ? {} : { canonicalClaimsSha256 }),
      ...(businessEventSha256 === undefined ? {} : { businessEventSha256 }),
      issuedAt,
      expiresAt,
      nonce,
      replayPolicy: value.replayPolicy,
      algorithm: value.algorithm,
      keyId,
      signature,
    };
    this.#verifyStoredEvidence(evidence);
    return evidence;
  }

  #matchingEvidenceKey(evidence: SignedExternalEvidence): TrustedEvidenceKey {
    const key = this.#trustedEvidenceKeys.find((candidate) =>
      candidate.issuer === evidence.issuer &&
      candidate.provider === evidence.provider &&
      candidate.keyId === evidence.keyId &&
      candidate.algorithm === evidence.algorithm &&
      candidate.allowedEnvironments.includes(evidence.environment));
    if (key === undefined || !evidenceScopeAllowed(key.allowedScopes, evidence.scope)) {
      throw new DomainError("EVIDENCE_TRUST_KEY_NOT_FOUND", "No trusted key is authorized for this evidence scope", {
        details: { issuer: evidence.issuer, provider: evidence.provider, keyId: evidence.keyId },
      });
    }
    if (key.notBefore !== undefined && evidence.issuedAt < key.notBefore) {
      throw new DomainError("EVIDENCE_TRUST_KEY_NOT_FOUND", "Evidence predates the trusted key validity window");
    }
    if (key.notAfter !== undefined && (evidence.issuedAt > key.notAfter || evidence.expiresAt > key.notAfter)) {
      throw new DomainError("EVIDENCE_TRUST_KEY_NOT_FOUND", "Evidence exceeds the trusted key validity window");
    }
    return key;
  }

  #verifyStoredEvidence(evidence: SignedExternalEvidence): void {
    const key = this.#matchingEvidenceKey(evidence);
    if (!verifyExternalEvidenceSignature(evidence, key.publicKeyPem)) {
      throw new DomainError("EVIDENCE_SIGNATURE_INVALID", "External evidence signature verification failed", {
        details: { evidenceId: evidence.evidenceId, keyId: evidence.keyId },
      });
    }
  }

  async #applyEvidenceGatedMutation(
    client: PoolClient,
    context: ActorContext,
    input: ExecuteEvidenceGatedMutationInput,
  ): Promise<EvidenceGatedMutationResult> {
    const mutation = input.mutation;
    if (mutation.kind === "record.create") {
      const collection = token(mutation.input.collection, "collection", COLLECTION);
      const id = token(mutation.input.id ?? randomUUID(), "record ID");
      const ownerActorId = mutation.input.ownerActorId === undefined ? context.actorId : mutation.input.ownerActorId;
      const participantIds = this.#participantIds(mutation.input.participantIds ?? []);
      const containsMinor = mutation.input.containsMinor ?? false;
      const processingPurpose = this.#processingPurposeForCreate(context, mutation.input.processingPurpose);
      const data = jsonObject(mutation.input.data, "record data");
      this.authorize(context, "record:create", { tenantId: context.tenantId, ownerActorId, containsMinor });
      this.#protectMinorSharing(context, collection, containsMinor);
      await this.#requireParticipantConsent(
        client,
        context,
        participantIds,
        processingPurpose,
        deriveRecordConsentRequirementScope(collection, id, data, "create"),
      );
      await this.#advisoryLock(client, `record\n${context.tenantId}\n${collection}\n${id}`);
      if (await this.#selectRecord(client, context.tenantId, collection, id, true, true) !== undefined) {
        throw new DomainError("VERSION_CONFLICT", "A record with this ID already exists", {
          details: { collection, id },
        });
      }
      const now = this.#now();
      await client.query(
        `INSERT INTO ltm.records(
          tenant_id,collection,id,processing_purpose,owner_actor_id,participant_ids,contains_minor,
          data,version,created_at,updated_at,deleted_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,1,$9,$9,NULL)`,
        [context.tenantId, collection, id, processingPurpose, ownerActorId, participantIds, containsMinor, canonicalJson(data), now],
      );
      const record = await this.#requiredRecord(client, context.tenantId, collection, id, true);
      await this.#appendAuditInternal(client, context, {
        action: "record.created",
        resourceType: collection,
        resourceId: id,
        details: { version: record.version },
      });
      await this.#emitOutbox(client, context.tenantId, collection, id, `${collection}.created`, {
        record: jsonObject(record),
      });
      await this.#appendEvidenceGatedAudit(client, context, input, collection, id, {
        replayed: false,
        recordVersion: record.version,
      });
      return { kind: mutation.kind, value: record, replayed: false };
    }

    if (mutation.kind === "record.transition") {
      const collection = token(mutation.input.collection, "collection", COLLECTION);
      const id = token(mutation.input.id, "record ID");
      const stateField = token(mutation.input.stateField, "state field");
      const fromState = textValue(mutation.input.fromState, "from state", 160);
      const toState = textValue(mutation.input.toState, "to state", 160);
      const initialFromStates = [...new Set(mutation.input.initialFromStates.map((state) =>
        textValue(state, "initial from state", 160)))];
      if (initialFromStates.length === 0) {
        throw new DomainError("VALIDATION_FAILED", "At least one initial transition state is required");
      }
      const baseData = jsonObject(mutation.input.data, "record data");
      await this.#advisoryLock(client, `record\n${context.tenantId}\n${collection}\n${id}`);
      const currentRow = await this.#selectRecord(client, context.tenantId, collection, id, false, true);
      const current = currentRow === undefined ? undefined : recordFromRow(currentRow);
      if (current !== undefined) {
        this.authorize(context, "record:read", current);
        await this.#assertRecordProcessingPurpose(client, context, current, "update");
        await this.#requireParticipantConsent(
          client,
          context,
          current.participantIds,
          current.processingPurpose,
          deriveRecordConsentRequirementScope(collection, id, current.data, "update"),
        );
      }
      if (current?.data.lastTransitionKey === input.idempotencyKey && current.data[stateField] === toState) {
        await this.#appendEvidenceGatedAudit(client, context, input, collection, id, {
          replayed: true,
          recordVersion: current.version,
          fromState,
          toState,
        }, true);
        return {
          kind: mutation.kind,
          value: current,
          previousState: fromState,
          state: toState,
          replayed: true,
        };
      }
      if (current === undefined && !initialFromStates.includes(fromState)) {
        throw new DomainError("RESOURCE_NOT_FOUND", "State transition cannot initialize from the supplied state", {
          details: { collection, id, fromState },
        });
      }
      if (current !== undefined && current.data[stateField] !== fromState) {
        throw new DomainError("VERSION_CONFLICT", "State transition received a stale aggregate state", {
          details: { collection, id, expectedState: current.data[stateField] ?? null, suppliedState: fromState },
        });
      }
      const ownerActorId = mutation.input.ownerActorId === undefined
        ? (current?.ownerActorId ?? context.actorId)
        : mutation.input.ownerActorId;
      const participantIds = this.#participantIds(mutation.input.participantIds ?? current?.participantIds ?? []);
      const containsMinor = mutation.input.containsMinor ?? current?.containsMinor ?? false;
      const processingPurpose = current?.processingPurpose ??
        this.#processingPurposeForCreate(context, mutation.input.processingPurpose);
      const priorTransitionCount = current?.data.transitionCount;
      const transitionCount = typeof priorTransitionCount === "number" && Number.isSafeInteger(priorTransitionCount)
        ? priorTransitionCount + 1
        : 1;
      const data = jsonObject({
        ...baseData,
        [stateField]: toState,
        previousState: fromState,
        transitionCount,
        lastTransitionKey: input.idempotencyKey,
      }, "state transition record data");
      this.#protectMinorSharing(context, collection, containsMinor);
      await this.#requireParticipantConsent(
        client,
        context,
        participantIds,
        processingPurpose,
        deriveRecordConsentRequirementScope(
          collection,
          id,
          data,
          current === undefined ? "create" : "update",
        ),
      );
      const now = this.#now();
      let record: RecordEnvelope;
      if (current === undefined) {
        this.authorize(context, "record:create", { tenantId: context.tenantId, ownerActorId, containsMinor });
        await client.query(
          `INSERT INTO ltm.records(
            tenant_id,collection,id,processing_purpose,owner_actor_id,participant_ids,contains_minor,
            data,version,created_at,updated_at,deleted_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,1,$9,$9,NULL)`,
          [context.tenantId, collection, id, processingPurpose, ownerActorId, participantIds, containsMinor, canonicalJson(data), now],
        );
        record = await this.#requiredRecord(client, context.tenantId, collection, id, true);
        await this.#appendAuditInternal(client, context, {
          action: "record.created",
          resourceType: collection,
          resourceId: id,
          details: { version: record.version },
        });
        await this.#emitOutbox(client, context.tenantId, collection, id, `${collection}.created`, {
          record: jsonObject(record),
        });
      } else {
        this.authorize(context, "record:update", { ...current, ownerActorId, containsMinor });
        const updated = await client.query(
          `UPDATE ltm.records SET owner_actor_id=$1,participant_ids=$2,contains_minor=$3,data=$4::jsonb,
             version=version+1,updated_at=$5
           WHERE tenant_id=$6 AND collection=$7 AND id=$8 AND deleted_at IS NULL AND version=$9`,
          [
            ownerActorId,
            participantIds,
            containsMinor,
            canonicalJson(data),
            now,
            context.tenantId,
            collection,
            id,
            current.version,
          ],
        );
        if (updated.rowCount !== 1) {
          await this.#throwRecordMutationConflict(client, context.tenantId, collection, id, current.version);
        }
        record = await this.#requiredRecord(client, context.tenantId, collection, id, false);
        await this.#appendAuditInternal(client, context, {
          action: "record.updated",
          resourceType: collection,
          resourceId: id,
          details: { previousVersion: current.version, version: record.version },
        });
        await this.#emitOutbox(client, context.tenantId, collection, id, `${collection}.updated`, {
          record: jsonObject(record),
        });
      }
      await this.#appendEvidenceGatedAudit(client, context, input, collection, id, {
        replayed: false,
        recordVersion: record.version,
        fromState,
        toState,
      });
      return {
        kind: mutation.kind,
        value: record,
        previousState: fromState,
        state: toState,
        replayed: false,
      };
    }

    if (mutation.kind === "external-command.create") {
      const recordInput = mutation.input.record;
      const collection = token(recordInput.collection, "collection", COLLECTION);
      const id = token(recordInput.id ?? randomUUID(), "record ID");
      const commandId = token(mutation.input.commandId ?? randomUUID(), "command ID");
      const batchId = token(
        mutation.input.batchId,
        "batchId",
        /^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/,
      ) as `B${string}`;
      const operation = token(mutation.input.operation, "operation");
      const ownerActorId = recordInput.ownerActorId === undefined ? context.actorId : recordInput.ownerActorId;
      const participantIds = this.#participantIds(recordInput.participantIds ?? []);
      const containsMinor = recordInput.containsMinor ?? false;
      const processingPurpose = this.#processingPurposeForCreate(context, recordInput.processingPurpose);
      const requestedData = jsonObject(recordInput.data, "record data");
      const data = jsonObject({
        ...requestedData,
        externalCommandId: commandId,
        commandState: "requested",
        executionState: "requested",
      }, "external command record data");
      const commandDetails = jsonObject(mutation.input.details ?? {}, "external command details");
      this.authorize(context, "record:create", { tenantId: context.tenantId, ownerActorId, containsMinor });
      this.#protectMinorSharing(context, collection, containsMinor);
      const locks = [
        `external-command\n${context.tenantId}\n${commandId}`,
        `record\n${context.tenantId}\n${collection}\n${id}`,
      ].sort();
      for (const lock of locks) await this.#advisoryLock(client, lock);
      await this.#requireParticipantConsent(
        client,
        context,
        participantIds,
        processingPurpose,
        deriveRecordConsentRequirementScope(collection, id, data, "create"),
      );
      if (await this.#selectRecord(client, context.tenantId, collection, id, true, true) !== undefined) {
        throw new DomainError("VERSION_CONFLICT", "External command aggregate already exists");
      }
      const now = this.#now();
      await client.query(
        `INSERT INTO ltm.records(
          tenant_id,collection,id,processing_purpose,owner_actor_id,participant_ids,contains_minor,data,
          version,created_at,updated_at,deleted_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,1,$9,$9,NULL)`,
        [context.tenantId, collection, id, processingPurpose, ownerActorId, participantIds, containsMinor, canonicalJson(data), now],
      );
      const record = await this.#requiredRecord(client, context.tenantId, collection, id, true);
      const command = await this.#insertRequestedExternalCommand(
        client,
        context,
        { commandId, batchId, operation, aggregateCollection: collection, aggregateId: id, details: commandDetails },
        now,
      );
      await this.#appendAuditInternal(client, context, {
        action: "external_command.created",
        resourceType: collection,
        resourceId: id,
        details: { commandId, batchId, operation, recordVersion: record.version },
      });
      await this.#emitOutbox(client, context.tenantId, collection, id, `${collection}.created`, {
        record: jsonObject(record),
      });
      await this.#appendEvidenceGatedAudit(client, context, input, collection, id, {
        replayed: false,
        recordVersion: record.version,
        externalCommandId: command.commandId,
        commandState: command.state,
      });
      return { kind: mutation.kind, value: { record, command }, replayed: false };
    }

    this.authorize(context, "ledger:post", { tenantId: context.tenantId });
    const transactionId = token(mutation.input.transactionId ?? randomUUID(), "transaction ID");
    const sourceType = token(mutation.input.sourceType, "source type");
    const sourceId = token(mutation.input.sourceId, "source ID");
    const description = textValue(mutation.input.description, "description", 500);
    const occurredAt = mutation.input.occurredAt === undefined
      ? this.#now()
      : isoTimestamp(mutation.input.occurredAt, "occurredAt");
    const reversedTransactionId = mutation.input.reversedTransactionId === undefined ||
      mutation.input.reversedTransactionId === null
      ? null
      : token(mutation.input.reversedTransactionId, "reversed transaction ID");
    const lines = this.#ledgerLines(mutation.input.lines);
    this.#assertBalanced(lines);
    const sourceFingerprint = fingerprint("ledger.post.source", {
      sourceType,
      sourceId,
      description,
      requestedOccurredAt: mutation.input.occurredAt ?? null,
      reversedTransactionId,
      lines,
    });
    await this.#advisoryLock(client, `ledger-source\n${context.tenantId}\n${sourceType}\n${sourceId}`);
    const existing = await client.query(
      `SELECT * FROM ltm.ledger_transactions
       WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 FOR SHARE`,
      [context.tenantId, sourceType, sourceId],
    );
    if (existing.rows[0] !== undefined) {
      const row = existing.rows[0] as DbRow;
      if (rowString(row, "request_fingerprint") !== sourceFingerprint) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "Ledger source reference was reused with different data");
      }
      const transaction = await this.#ledgerTransactionFromRow(client, row);
      await this.#appendEvidenceGatedAudit(client, context, input, "ledger_transaction", transaction.id, {
        replayed: true,
      }, true);
      return { kind: mutation.kind, value: transaction, replayed: true };
    }
    if (reversedTransactionId !== null) {
      const reversed = await this.#requiredLedgerTransaction(client, context.tenantId, reversedTransactionId, true);
      this.#assertExactReversal(reversed.lines, lines);
    }
    const createdAt = this.#now();
    await client.query(
      `INSERT INTO ltm.ledger_transactions(
        tenant_id,id,source_type,source_id,request_fingerprint,description,
        occurred_at,created_at,reversed_transaction_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        context.tenantId,
        transactionId,
        sourceType,
        sourceId,
        sourceFingerprint,
        description,
        occurredAt,
        createdAt,
        reversedTransactionId,
      ],
    );
    for (const [index, line] of lines.entries()) {
      await client.query(
        `INSERT INTO ltm.ledger_lines(
          tenant_id,transaction_id,line_no,account_code,direction,amount_minor,currency,memo
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          context.tenantId,
          transactionId,
          index + 1,
          line.accountCode,
          line.direction,
          line.amountMinor,
          line.currency,
          line.memo ?? null,
        ],
      );
    }
    const transaction = await this.#requiredLedgerTransaction(client, context.tenantId, transactionId);
    await this.#appendAuditInternal(client, context, {
      action: "ledger.posted",
      resourceType: "ledger_transaction",
      resourceId: transactionId,
      details: { sourceType, sourceId, reversedTransactionId, lineCount: lines.length },
    });
    await this.#emitOutbox(client, context.tenantId, "ledger_transaction", transactionId, "ledger.transaction.posted", {
      transaction: jsonObject(transaction),
    });
    await this.#appendEvidenceGatedAudit(client, context, input, "ledger_transaction", transactionId, {
      replayed: false,
    });
    return { kind: mutation.kind, value: transaction, replayed: false };
  }

  async #appendEvidenceGatedAudit(
    client: PoolClient,
    context: ActorContext,
    input: ExecuteEvidenceGatedMutationInput,
    resourceType: string,
    resourceId: string,
    details: JsonObject,
    replayed = false,
  ): Promise<void> {
    await this.#appendAuditInternal(client, context, {
      action: replayed && input.audit.replayAction !== undefined
        ? input.audit.replayAction
        : input.audit.action,
      resourceType,
      resourceId,
      details: { ...(input.audit.details ?? {}), ...details },
    });
  }

  #normalizeEvidenceRequirement(
    scopeValue: string,
    evidenceIds: readonly string[],
  ): { readonly scope: string; readonly ids: readonly string[] } {
    const scope = textValue(scopeValue, "external evidence scope", 512);
    const ids = [...new Set(evidenceIds.map((id) => token(id, "external evidence ID")))].sort();
    if (ids.length === 0 || ids.length > 100) {
      throw new DomainError("VALIDATION_FAILED", "Between 1 and 100 external evidence IDs are required");
    }
    if (this.#trustedEvidenceKeys.length === 0) {
      throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", "No trusted external evidence keys are configured");
    }
    return { scope, ids };
  }

  async #requireExternalEvidenceInternal(
    client: PoolClient,
    context: ActorContext,
    scope: string,
    ids: readonly string[],
  ): Promise<readonly RegisteredExternalEvidence[]> {
    const verified: RegisteredExternalEvidence[] = [];
    for (const evidenceId of ids) {
      let evidence: RegisteredExternalEvidence;
      try {
        evidence = await this.#requiredEvidence(client, context.tenantId, evidenceId, true);
      } catch (error) {
        if (error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND") {
          throw new DomainError("EXTERNAL_EVIDENCE_UNVERIFIED", "External evidence is not registered", {
            details: { evidenceId, scope },
          });
        }
        throw error;
      }
      if (evidence.scope !== scope) {
        throw new DomainError("EVIDENCE_SCOPE_MISMATCH", "External evidence scope does not match this operation", {
          details: { evidenceId, requiredScope: scope },
        });
      }
      if (evidence.status === "revoked") {
        throw new DomainError("EVIDENCE_REVOKED", "External evidence has been revoked", { details: { evidenceId } });
      }
      if (evidence.expiresAt <= this.#now()) {
        throw new DomainError("EVIDENCE_EXPIRED", "External evidence has expired", { details: { evidenceId } });
      }
      this.#verifyStoredEvidence(evidence);
      if (evidence.replayPolicy === "single_use") {
        await this.#consumeEvidence(client, context, evidence, scope);
        evidence = await this.#requiredEvidence(client, context.tenantId, evidenceId);
      }
      verified.push(evidence);
    }
    await this.#appendAuditInternal(client, context, {
      action: "evidence.required",
      resourceType: "external_evidence_set",
      resourceId: sha256(ids.join("\n")),
      details: { scope, evidenceIds: [...ids] },
    });
    return verified;
  }

  async #consumeEvidence(
    client: PoolClient,
    context: ActorContext,
    evidence: RegisteredExternalEvidence,
    scope: string,
  ): Promise<void> {
    if (context.operationId === undefined) {
      throw new DomainError(
        "EVIDENCE_REPLAY_CONTEXT_REQUIRED",
        "Single-use evidence requires a server-derived stable operation identity",
      );
    }
    const operationId = textValue(context.operationId, "operationId", 256);
    const consumptionKeyHash = sha256(canonicalJson({
      tenantId: context.tenantId,
      actorId: context.actorId,
      scope,
      operationId,
    }));
    if (evidence.consumptionKeyHash !== null) {
      if (evidence.consumptionKeyHash !== consumptionKeyHash) {
        throw new DomainError("EVIDENCE_REPLAY_DETECTED", "Single-use evidence was already consumed", {
          details: { evidenceId: evidence.evidenceId },
        });
      }
      return;
    }
    const inserted = await client.query(
        `INSERT INTO ltm.evidence_consumptions(
          tenant_id,evidence_id,scope,consumption_key_hash,consumed_at
        ) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (tenant_id,evidence_id) DO NOTHING
        RETURNING consumption_key_hash`,
        [context.tenantId, evidence.evidenceId, scope, consumptionKeyHash, this.#now()],
      );
    if (inserted.rowCount === 0) {
      const current = await this.#requiredEvidence(client, context.tenantId, evidence.evidenceId);
      if (current.consumptionKeyHash !== consumptionKeyHash) {
        throw new DomainError("EVIDENCE_REPLAY_DETECTED", "Single-use evidence was already consumed", {
          details: { evidenceId: evidence.evidenceId },
        });
      }
    }
  }

  #evidenceSelectSql(): string {
    return `SELECT e.*,e.version AS version_number,c.consumed_at,c.consumption_key_hash
      FROM ltm.external_evidence e
      LEFT JOIN ltm.evidence_consumptions c
        ON c.tenant_id=e.tenant_id AND c.evidence_id=e.id`;
  }

  async #requiredEvidence(
    client: PoolClient,
    tenantId: string,
    evidenceId: string,
    forUpdate = false,
  ): Promise<RegisteredExternalEvidence> {
    const result = await client.query(
      `${this.#evidenceSelectSql()}
       WHERE e.tenant_id=$1 AND e.id=$2${forUpdate ? " FOR UPDATE OF e" : ""}`,
      [tenantId, evidenceId],
    );
    const row = result.rows[0] as DbRow | undefined;
    if (row === undefined) {
      throw new DomainError("RESOURCE_NOT_FOUND", "External evidence was not found", { details: { evidenceId } });
    }
    return evidenceFromRow(row);
  }
}
