import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { canonicalJson, fingerprint, jsonObject, sha256 } from "./canonical.js";
import { evidenceScopeAllowed, validateTrustedEvidenceKey, verifyExternalEvidenceSignature } from "./evidence.js";
import { DomainError } from "./errors.js";
import {
  assertExternalCommandTransition,
  isExternalCommandTerminal,
  normalizeApplyExternalBusinessEventInput,
  normalizeExternalBusinessAggregateTarget,
  normalizeExternalBusinessReduction,
  normalizeTransitionExternalCommandInput,
} from "./external-business-events.js";
import { authorize as enforceAuthorization, hasPermission, validateContext } from "./policy.js";
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
  ConsentRequirement,
  CreateExternalCommandInput,
  CreateRecordInput,
  CreatedExternalCommand,
  DeleteRecordInput,
  EvidenceEnvironment,
  ExternalBusinessReduction,
  ExternalCommandRecord,
  ExternalCommandState,
  GrantConsentInput,
  IdempotentResult,
  InboxEvent,
  JsonObject,
  LedgerLine,
  LedgerTransaction,
  LifeTimeMachineRuntimePort,
  ListRecordsInput,
  OutboxEvent,
  OutboxPublisher,
  OutboxStatus,
  PostgresRuntimeOptions,
  PostLedgerInput,
  ReadinessResult,
  ReceiveInboxInput,
  RegisterExternalEvidenceInput,
  RegisteredExternalEvidence,
  RecordEnvelope,
  RevokeExternalEvidenceInput,
  RuntimeClock,
  SignedExternalEvidence,
  TrustedEvidenceKey,
  TransitionExternalCommandInput,
  UpdateRecordInput,
  WithdrawConsentInput,
} from "./types.js";

type DbRow = Record<string, unknown>;

const SYSTEM_CLOCK: RuntimeClock = { now: () => new Date() };
const GENESIS_HASH = "0".repeat(64);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COLLECTION = /^[a-z][a-z0-9_.-]{0,79}$/;
const CURRENCY = /^[A-Z]{3}$/;
const ACCOUNT_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const REQUIRED_SCHEMA_VERSION = "4";
const TENANT_TABLES = [
  "records",
  "consents",
  "idempotency",
  "inbox",
  "outbox",
  "audit_log",
  "ledger_transactions",
  "ledger_lines",
  "external_evidence",
  "evidence_consumptions",
  "external_commands",
  "external_command_transitions",
  "evidence_decisions",
  "external_business_events",
] as const;

function token(value: string, label: string, pattern: RegExp = IDENTIFIER): string {
  const normalized = value.trim();
  if (!pattern.test(normalized)) {
    throw new DomainError("VALIDATION_FAILED", `${label} has an invalid format`);
  }
  return normalized;
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
    scope: rowJsonObject(row, "scope"),
    policyVersion: rowString(row, "policy_version"),
    status: status as ConsentRecord["status"],
    evidenceHash: rowString(row, "evidence_hash"),
    isMinor: rowBoolean(row, "is_minor"),
    grantedAt: rowTimestamp(row, "granted_at"),
    expiresAt: rowNullableTimestamp(row, "expires_at"),
    withdrawnAt: rowNullableTimestamp(row, "withdrawn_at"),
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
      return { ready: false, database: "error", auditChain: "error", evidenceTrust: "error" };
    }
    try {
      await this.#assertDatabaseContract();
      const now = this.#now();
      const hasActiveTrust = this.#trustedEvidenceKeys.some((key) =>
        key.allowedEnvironments.includes(this.#evidenceEnvironment) &&
        (key.notBefore === undefined || key.notBefore <= now) &&
        (key.notAfter === undefined || key.notAfter >= now));
      const evidenceTrust = this.#evidencePolicy === "disabled" ? "disabled" : hasActiveTrust ? "ok" : "error";
      return { ready: evidenceTrust !== "error", database: "ok", auditChain: "ok", evidenceTrust };
    } catch {
      return { ready: false, database: "error", auditChain: "error", evidenceTrust: "error" };
    }
  }

  authorize(context: ActorContext, action: string, resource: AuthorizationResource = {}): void {
    this.#assertOpen();
    enforceAuthorization(context, textValue(action, "action", 160), resource);
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
    const scope = textValue(scopeValue, "external evidence scope", 512);
    const ids = [...new Set(evidenceIds.map((id) => token(id, "external evidence ID")))].sort();
    if (ids.length === 0 || ids.length > 100) {
      throw new DomainError("VALIDATION_FAILED", "Between 1 and 100 external evidence IDs are required");
    }
    if (this.#trustedEvidenceKeys.length === 0) {
      throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", "No trusted external evidence keys are configured");
    }
    return this.#transaction(context, async (client) => {
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
        details: { scope, evidenceIds: ids },
      });
      return verified;
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
        await this.#requireParticipantConsent(client, context, participantIds);
        if (await this.#selectRecord(client, context.tenantId, collection, id, true, true) !== undefined) {
          throw new DomainError("VERSION_CONFLICT", "External command aggregate already exists");
        }
        const now = this.#now();
        await client.query(
          `INSERT INTO ltm.records(
            tenant_id,collection,id,owner_actor_id,participant_ids,contains_minor,data,
            version,created_at,updated_at,deleted_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,1,$8,$8,NULL)`,
          [
            context.tenantId,
            collection,
            id,
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
          : await this.#transitionExternalCommandInternal(client, context, {
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
            }, randomUUID());
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
    const id = token(input.id ?? randomUUID(), "record ID");
    const ownerActorId = input.ownerActorId === undefined ? context.actorId : input.ownerActorId;
    const participantIds = this.#participantIds(input.participantIds ?? []);
    const containsMinor = input.containsMinor ?? false;
    const data = jsonObject(input.data, "record data") as T;
    const key = idempotencyKey(input.idempotencyKey);
    this.authorize(context, "record:create", { tenantId: context.tenantId, ownerActorId, containsMinor });
    this.#protectMinorSharing(context, collection, containsMinor);
    return this.#idempotent(
      context,
      key,
      `record.create:${collection}`,
      { requestedId: input.id ?? null, ownerActorId, participantIds, containsMinor, data },
      async (client) => {
        await this.#requireParticipantConsent(client, context, participantIds);
        const existing = await this.#selectRecord(client, context.tenantId, collection, id, true);
        if (existing !== undefined) {
          throw new DomainError("VERSION_CONFLICT", "A record with this ID already exists", {
            details: { collection, id },
          });
        }
        const now = this.#now();
        await client.query(
          `INSERT INTO ltm.records(
            tenant_id, collection, id, owner_actor_id, participant_ids, contains_minor,
            data, version, created_at, updated_at, deleted_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,1,$8,$8,NULL)`,
          [context.tenantId, collection, id, ownerActorId, participantIds, containsMinor, canonicalJson(data), now],
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
    const id = token(idValue, "record ID");
    validateContext(context);
    return this.#transaction(context, async (client) => {
      const record = await this.#requiredRecord<T>(client, context.tenantId, collection, id, false);
      this.authorize(context, "record:read", record);
      await this.#requireParticipantConsent(client, context, record.participantIds);
      return record;
    });
  }

  async listRecords<T extends JsonObject>(
    context: ActorContext,
    input: ListRecordsInput,
  ): Promise<readonly RecordEnvelope<T>[]> {
    const collection = token(input.collection, "collection", COLLECTION);
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
        if (await this.#hasParticipantConsent(client, context, record.participantIds)) visible.push(record);
      }
      return visible;
    });
  }

  async updateRecord<T extends JsonObject>(
    context: ActorContext,
    input: UpdateRecordInput<T>,
  ): Promise<IdempotentResult<RecordEnvelope<T>>> {
    const collection = token(input.collection, "collection", COLLECTION);
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
        this.#protectMinorSharing(context, collection, containsMinor);
        await this.#requireParticipantConsent(client, context, participantIds);
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

  async grantConsent(
    context: ActorContext,
    input: GrantConsentInput,
  ): Promise<IdempotentResult<ConsentRecord>> {
    const id = token(input.id ?? randomUUID(), "consent ID");
    const participantId = token(input.participantId, "participant ID");
    const purpose = textValue(input.purpose, "consent purpose", 120);
    const policyVersion = token(input.policyVersion, "policy version");
    const evidenceHash = input.evidenceHash.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(evidenceHash) || evidenceHash !== input.evidenceHash) {
      throw new DomainError("VALIDATION_FAILED", "evidenceHash must be a lowercase SHA-256 digest");
    }
    if (purpose !== context.purpose) {
      throw new DomainError("PURPOSE_REQUIRED", "Consent purpose must match the request purpose");
    }
    const scope = jsonObject(input.scope, "consent scope");
    const isMinor = input.isMinor ?? false;
    const expiresAt = input.expiresAt === undefined || input.expiresAt === null
      ? null
      : isoTimestamp(input.expiresAt, "expiresAt");
    const key = idempotencyKey(input.idempotencyKey);
    validateContext(context);
    return this.#idempotent(
      context,
      key,
      "consent.grant",
      { requestedId: input.id ?? null, participantId, purpose, scope, policyVersion, evidenceHash, isMinor, expiresAt },
      async (client) => {
        await this.#authorizeConsentGrant(client, context, participantId, input.grantorCapacity, isMinor);
        const now = this.#now();
        if (expiresAt !== null && expiresAt <= now) {
          throw new DomainError("VALIDATION_FAILED", "Consent expiry must be in the future");
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
           WHERE tenant_id=$1 AND participant_id=$2 AND purpose=$3 AND status='active'`,
          [context.tenantId, participantId, purpose],
        );
        await client.query(
          `INSERT INTO ltm.consents(
            tenant_id,id,participant_id,grantor_actor_id,grantor_capacity,purpose,scope,
            policy_version,status,evidence_hash,is_minor,granted_at,expires_at,withdrawn_at,version
          ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'active',$9,$10,$11,$12,NULL,1)`,
          [
            context.tenantId,
            id,
            participantId,
            context.actorId,
            input.grantorCapacity,
            purpose,
            canonicalJson(scope),
            policyVersion,
            evidenceHash,
            isMinor,
            now,
            expiresAt,
          ],
        );
        const consent = await this.#requiredConsent(client, context.tenantId, id);
        await this.#appendAuditInternal(client, context, {
          action: "consent.granted",
          resourceType: "consent",
          resourceId: id,
          details: { participantId, policyVersion, isMinor },
        });
        await this.#emitOutbox(client, context.tenantId, "consent", id, "consent.granted", {
          consentId: id,
          participantId,
          purpose,
          policyVersion,
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
        const current = await this.#requiredConsent(client, context.tenantId, consentId, true);
        const ownsConsent = current.grantorActorId === context.actorId;
        if (ownsConsent) {
          if (!hasPermission(context, "consent:withdraw:self") && !hasPermission(context, "consent:withdraw")) {
            throw new DomainError("AUTH_FORBIDDEN", "Permission to withdraw consent is required");
          }
        } else {
          this.authorize(context, "consent:withdraw", { tenantId: current.tenantId });
        }
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
        return consent;
      },
    );
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
    const mayReadAll = hasPermission(context, "consent:read");
    if (!mayReadAll && !hasPermission(context, "consent:read:self")) {
      throw new DomainError("AUTH_FORBIDDEN", "Permission to inspect consent is required");
    }
    return this.#transaction(context, async (client) => {
      const conditions = ["tenant_id=$1"];
      const parameters: unknown[] = [context.tenantId];
      if (participantId !== undefined) {
        parameters.push(participantId);
        conditions.push(`participant_id=$${parameters.length}`);
      }
      if (!mayReadAll) {
        parameters.push(context.actorId);
        conditions.push(`grantor_actor_id=$${parameters.length}`);
      }
      const result = await client.query(
        `SELECT * FROM ltm.consents WHERE ${conditions.join(" AND ")}
         ORDER BY granted_at DESC,id DESC LIMIT 200`,
        parameters,
      );
      return result.rows.map((row) => consentFromRow(row as DbRow));
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
      return outboxFromRow(result.rows[0] as DbRow);
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
        await this.markOutboxFailed(context, event.id, workerId, message.slice(0, 2_000), {
          retryAt,
          dead: event.attempts >= 10,
        });
        failed += 1;
      }
    }
    return { published, failed };
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
        `SELECT tablename,qual,with_check FROM pg_policies
         WHERE schemaname='ltm' AND policyname='tenant_isolation' AND tablename = ANY($1::text[])`,
        [TENANT_TABLES],
      );
      if (policies.rows.length !== TENANT_TABLES.length || policies.rows.some((raw) => {
        const row = raw as DbRow;
        return !rowString(row, "qual").includes("current_tenant") ||
          !rowString(row, "with_check").includes("current_tenant");
      })) {
        throw new DomainError("DEPENDENCY_UNAVAILABLE", "PostgreSQL tenant isolation policies are incomplete");
      }
      const triggers = await client.query(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid IN (
           'ltm.audit_log'::regclass,
           'ltm.ledger_transactions'::regclass,
           'ltm.ledger_lines'::regclass,
           'ltm.external_commands'::regclass,
           'ltm.external_command_transitions'::regclass,
           'ltm.evidence_decisions'::regclass,
           'ltm.external_business_events'::regclass
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

  async #hasParticipantConsent(
    client: PoolClient,
    context: ActorContext,
    participantIds: readonly string[],
  ): Promise<boolean> {
    try {
      await this.#activeConsents(client, context, { participantIds }, false);
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
  ): Promise<void> {
    if (participantIds.length > 0) await this.#activeConsents(client, context, { participantIds }, false);
  }

  async #activeConsents(
    client: PoolClient,
    context: ActorContext,
    requirement: ConsentRequirement,
    enforceSelfVisibility: boolean,
  ): Promise<readonly ConsentRecord[]> {
    const participantIds = this.#participantIds(requirement.participantIds);
    const purpose = textValue(requirement.purpose ?? context.purpose, "consent purpose", 120);
    const at = requirement.at === undefined ? this.#now() : isoTimestamp(requirement.at, "consent check time");
    const consents: ConsentRecord[] = [];
    for (const participantId of participantIds) {
      const result = await client.query(
        `SELECT * FROM ltm.consents
         WHERE tenant_id=$1 AND participant_id=$2 AND purpose=$3
         ORDER BY granted_at DESC,id DESC`,
        [context.tenantId, participantId, purpose],
      );
      const rows = result.rows as DbRow[];
      const active = rows.find((row) => {
        if (rowString(row, "status") !== "active") return false;
        const expiresAt = rowNullableTimestamp(row, "expires_at");
        return expiresAt === null || expiresAt > at;
      });
      if (active === undefined) {
        const hasWithdrawn = rows.some((row) => rowString(row, "status") === "withdrawn");
        throw new DomainError(
          hasWithdrawn ? "CONSENT_WITHDRAWN" : "CONSENT_REQUIRED",
          "Active purpose-specific consent is required",
          { details: { participantId, purpose } },
        );
      }
      if (enforceSelfVisibility && !hasPermission(context, "consent:read") &&
          rowString(active, "grantor_actor_id") !== context.actorId) {
        throw new DomainError("AUTH_FORBIDDEN", "Consent belongs to another actor");
      }
      consents.push(consentFromRow(active));
    }
    return consents;
  }

  async #authorizeConsentGrant(
    client: PoolClient,
    context: ActorContext,
    participantId: string,
    capacity: GrantConsentInput["grantorCapacity"],
    isMinor: boolean,
  ): Promise<void> {
    if (isMinor) {
      if (capacity !== "guardian" || !context.roles.includes("guardian")) {
        throw new DomainError("GUARDIAN_VERIFICATION_REQUIRED", "A verified guardian role is required");
      }
      this.authorize(context, "consent:grant", { tenantId: context.tenantId, containsMinor: true });
      return;
    }
    if (capacity === "guardian") {
      throw new DomainError("AUTH_FORBIDDEN", "A guardian cannot grant consent for a non-minor participant");
    }
    if (capacity === "authorized_agent") {
      this.authorize(context, "consent:grant:agent", { tenantId: context.tenantId });
      return;
    }
    if (!hasPermission(context, "consent:grant:self") && !hasPermission(context, "consent:grant")) {
      throw new DomainError("AUTH_FORBIDDEN", "Permission to grant consent is required");
    }
    const participant = await this.#selectRecord(client, context.tenantId, "participants", participantId, false);
    if (participant === undefined) {
      if (participantId !== context.actorId && !hasPermission(context, "consent:grant:any")) {
        throw new DomainError("AUTH_FORBIDDEN", "Participant ownership must be established before granting consent");
      }
    } else if (rowNullableString(participant, "owner_actor_id") !== context.actorId &&
               !hasPermission(context, "consent:grant:any")) {
      throw new DomainError("AUTH_FORBIDDEN", "The participant is owned by another actor");
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
      const ownerActorId = target.ownerActorId === undefined ? context.actorId : target.ownerActorId;
      this.authorize(context, "record:create", {
        tenantId: context.tenantId,
        ownerActorId,
        containsMinor: target.containsMinor,
      });
      this.#protectMinorSharing(context, target.collection, target.containsMinor);
      await this.#requireParticipantConsent(client, context, target.participantIds);
      await client.query(
        `INSERT INTO ltm.records(
          tenant_id,collection,id,owner_actor_id,participant_ids,contains_minor,data,
          version,created_at,updated_at,deleted_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,1,$8,$8,NULL)`,
        [
          context.tenantId,
          target.collection,
          target.aggregateId,
          ownerActorId,
          target.participantIds,
          target.containsMinor,
          canonicalJson(data),
          now,
        ],
      );
    } else {
      if (current.deletedAt !== null) throw new DomainError("VERSION_CONFLICT", "External business aggregate is deleted");
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
