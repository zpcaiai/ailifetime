import { createHash, randomUUID } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { canonicalJson, fingerprint, jsonObject, parseJsonObject, sha256 } from "./canonical.js";
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
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
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
  CreateRecordInput,
  CreateExternalCommandInput,
  CreatedExternalCommand,
  DeleteRecordInput,
  GrantConsentInput,
  IdempotentResult,
  InboxEvent,
  JsonObject,
  LedgerLine,
  LedgerTransaction,
  ListRecordsInput,
  OutboxEvent,
  OutboxPublisher,
  OutboxStatus,
  PostLedgerInput,
  ReadinessResult,
  ReceiveInboxInput,
  RegisterExternalEvidenceInput,
  RegisteredExternalEvidence,
  RecordEnvelope,
  RevokeExternalEvidenceInput,
  RuntimeClock,
  RuntimeOptions,
  EvidenceEnvironment,
  ExternalBusinessReduction,
  ExternalCommandRecord,
  ExternalCommandState,
  SignedExternalEvidence,
  TrustedEvidenceKey,
  UpdateRecordInput,
  TransitionExternalCommandInput,
  WithdrawConsentInput,
} from "./types.js";

interface RecordRow {
  id: string;
  tenant_id: string;
  collection: string;
  owner_actor_id: string | null;
  participant_ids_json: string;
  contains_minor: number;
  data_json: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface IdempotencyRow {
  operation: string;
  request_fingerprint: string;
  response_json: string;
}

interface ConsentRow {
  id: string;
  tenant_id: string;
  participant_id: string;
  grantor_actor_id: string;
  grantor_capacity: "self" | "guardian" | "authorized_agent";
  purpose: string;
  scope_json: string;
  policy_version: string;
  status: "active" | "expired" | "withdrawn" | "disputed" | "superseded";
  evidence_hash: string;
  is_minor: number;
  granted_at: string;
  expires_at: string | null;
  withdrawn_at: string | null;
  version: number;
}

interface LedgerTransactionRow {
  id: string;
  tenant_id: string;
  source_type: string;
  source_id: string;
  description: string;
  occurred_at: string;
  created_at: string;
  reversed_transaction_id: string | null;
  request_fingerprint: string;
}

interface LedgerLineRow {
  account_code: string;
  direction: "debit" | "credit";
  amount_minor: number;
  currency: string;
  memo: string | null;
}

interface InboxRow {
  id: string;
  tenant_id: string;
  source: string;
  source_event_id: string;
  event_type: string;
  request_fingerprint: string;
  payload_json: string;
  status: "received" | "processed" | "rejected";
  received_at: string;
  processed_at: string | null;
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload_json: string;
  status: OutboxStatus;
  attempts: number;
  available_at: string;
  lease_owner: string | null;
  lease_until: string | null;
  created_at: string;
  published_at: string | null;
  last_error: string | null;
}

interface AuditRow {
  sequence: number;
  id: string;
  tenant_id: string;
  actor_id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  purpose: string;
  request_id: string;
  details_json: string;
  previous_hash: string;
  entry_hash: string;
  created_at: string;
}

interface SchemaVersionRow {
  value: string;
}

interface TenantRow {
  tenant_id: string;
}

interface EvidenceRow {
  tenant_id: string;
  id: string;
  envelope_version: "ltm.external-evidence.v1";
  issuer: string;
  provider: string;
  environment: EvidenceEnvironment;
  scope: string;
  artifact_sha256: string;
  canonical_claims_sha256: string | null;
  business_event_sha256: string | null;
  issued_at: string;
  expires_at: string;
  nonce: string;
  replay_policy: "reusable" | "single_use";
  algorithm: "Ed25519";
  key_id: string;
  signature: string;
  status: "verified" | "revoked";
  evidence_version: number;
  verified_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  consumed_at: string | null;
  consumption_key_hash: string | null;
}

interface ExternalCommandRow {
  tenant_id: string;
  command_id: string;
  batch_id: `B${string}`;
  operation: string;
  aggregate_collection: string;
  aggregate_id: string;
  state: ExternalCommandState;
  provider_operation_id: string | null;
  evidence_id: string | null;
  decision_state: "active" | "frozen";
  reconciliation_state: "clear" | "reconciliation_required";
  version: number;
  requested_at: string;
  updated_at: string;
  terminal_at: string | null;
  details_json: string;
}

interface ExternalBusinessEventRow {
  event_fingerprint: string;
  result_json: string;
}

const SYSTEM_CLOCK: RuntimeClock = { now: () => new Date() };
const GENESIS_HASH = "0".repeat(64);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COLLECTION = /^[a-z][a-z0-9_.-]{0,79}$/;
const CURRENCY = /^[A-Z]{3}$/;
const ACCOUNT_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

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
  if (value === undefined) {
    throw new DomainError("VALIDATION_FAILED", `${label} is required`);
  }
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

function parseParticipantIds(serialized: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new DomainError("INTERNAL_ERROR", "Stored participant references are invalid JSON");
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new DomainError("INTERNAL_ERROR", "Stored participant references are invalid");
  }
  return parsed;
}

function recordFromRow<T extends JsonObject>(row: RecordRow): RecordEnvelope<T> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    collection: row.collection,
    ownerActorId: row.owner_actor_id,
    participantIds: parseParticipantIds(row.participant_ids_json),
    containsMinor: row.contains_minor === 1,
    data: parseJsonObject(row.data_json, "record data") as T,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function consentFromRow(row: ConsentRow): ConsentRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    participantId: row.participant_id,
    grantorActorId: row.grantor_actor_id,
    grantorCapacity: row.grantor_capacity,
    purpose: row.purpose,
    scope: parseJsonObject(row.scope_json, "consent scope"),
    policyVersion: row.policy_version,
    status: row.status,
    evidenceHash: row.evidence_hash,
    isMinor: row.is_minor === 1,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    withdrawnAt: row.withdrawn_at,
    version: row.version,
  };
}

function inboxFromRow(row: InboxRow): InboxEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    source: row.source,
    sourceEventId: row.source_event_id,
    eventType: row.event_type,
    payload: parseJsonObject(row.payload_json, "inbox payload"),
    status: row.status,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  };
}

function outboxFromRow(row: OutboxRow): OutboxEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: parseJsonObject(row.payload_json, "outbox payload"),
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    lastError: row.last_error,
  };
}

function auditFromRow(row: AuditRow): AuditEntry {
  return {
    sequence: row.sequence,
    id: row.id,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    purpose: row.purpose,
    requestId: row.request_id,
    details: parseJsonObject(row.details_json, "audit details"),
    previousHash: row.previous_hash,
    hash: row.entry_hash,
    createdAt: row.created_at,
  };
}

function ledgerLineFromRow(row: LedgerLineRow): LedgerLine {
  const base = {
    accountCode: row.account_code,
    direction: row.direction,
    amountMinor: row.amount_minor,
    currency: row.currency,
  } as const;
  return row.memo === null ? base : { ...base, memo: row.memo };
}

function evidenceFromRow(row: EvidenceRow): RegisteredExternalEvidence {
  return {
    version: row.envelope_version,
    evidenceId: row.id,
    tenantId: row.tenant_id,
    issuer: row.issuer,
    provider: row.provider,
    environment: row.environment,
    scope: row.scope,
    artifactSha256: row.artifact_sha256,
    ...(row.canonical_claims_sha256 === null ? {} : { canonicalClaimsSha256: row.canonical_claims_sha256 }),
    ...(row.business_event_sha256 === null ? {} : { businessEventSha256: row.business_event_sha256 }),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    nonce: row.nonce,
    replayPolicy: row.replay_policy,
    algorithm: row.algorithm,
    keyId: row.key_id,
    signature: row.signature,
    status: row.status,
    versionNumber: row.evidence_version,
    verifiedAt: row.verified_at,
    revokedAt: row.revoked_at,
    revocationReason: row.revocation_reason,
    consumedAt: row.consumed_at,
    consumptionKeyHash: row.consumption_key_hash,
  };
}

function externalCommandFromRow(row: ExternalCommandRow): ExternalCommandRecord {
  return {
    commandId: row.command_id,
    tenantId: row.tenant_id,
    batchId: row.batch_id,
    operation: row.operation,
    aggregateCollection: row.aggregate_collection,
    aggregateId: row.aggregate_id,
    state: row.state,
    providerOperationId: row.provider_operation_id,
    evidenceId: row.evidence_id,
    decisionState: row.decision_state,
    reconciliationState: row.reconciliation_state,
    version: row.version,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
    details: parseJsonObject(row.details_json, "external command details"),
  };
}

function verifyAuditRows(rows: readonly AuditRow[]): AuditVerification {
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

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function countValue(database: DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as { count: number } | undefined;
  const count = row?.count;
  if (!Number.isSafeInteger(count) || (count ?? -1) < 0) {
    throw new DomainError("BACKUP_VERIFICATION_FAILED", "Backup returned an invalid row count");
  }
  return count as number;
}

export async function verifyDatabaseBackup(pathValue: string): Promise<BackupVerification> {
  const path = resolve(textValue(pathValue, "backup path", 4_096));
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new DomainError("BACKUP_VERIFICATION_FAILED", "Backup file does not exist or is not a regular file");
  }
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;");
    const integrityRows = database.prepare("PRAGMA integrity_check").all() as unknown as Array<{ integrity_check: string }>;
    if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== "ok") {
      throw new DomainError("BACKUP_VERIFICATION_FAILED", "SQLite integrity_check failed");
    }
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length !== 0) {
      throw new DomainError("BACKUP_VERIFICATION_FAILED", "Backup contains foreign-key violations");
    }
    const schema = database.prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get() as
      | SchemaVersionRow
      | undefined;
    if (schema?.value !== String(SCHEMA_VERSION)) {
      throw new DomainError("BACKUP_VERIFICATION_FAILED", "Backup schema version is unsupported");
    }
    const tenants = database.prepare(`
      SELECT tenant_id FROM records
      UNION SELECT tenant_id FROM consents
      UNION SELECT tenant_id FROM idempotency_records
      UNION SELECT tenant_id FROM ledger_transactions
      UNION SELECT tenant_id FROM inbox_events
      UNION SELECT tenant_id FROM outbox_events
      UNION SELECT tenant_id FROM audit_entries
      UNION SELECT tenant_id FROM external_evidence
      ORDER BY tenant_id
    `).all() as unknown as TenantRow[];
    const auditChainsValid = tenants.every((tenant) => {
      const rows = database
        .prepare("SELECT * FROM audit_entries WHERE tenant_id = ? ORDER BY sequence")
        .all(tenant.tenant_id) as unknown as AuditRow[];
      return rows.length > 0 && verifyAuditRows(rows).valid;
    });
    if (!auditChainsValid) {
      throw new DomainError("BACKUP_VERIFICATION_FAILED", "Backup contains an invalid audit hash chain");
    }
    const invalidLedgerTransactions = countValue(database, `
      SELECT COUNT(*) AS count FROM (
        SELECT t.tenant_id, t.id, l.currency,
          COUNT(l.line_number) AS line_count,
          COALESCE(SUM(CASE WHEN l.direction = 'debit' THEN l.amount_minor ELSE -l.amount_minor END), 0) AS net
        FROM ledger_transactions t
        LEFT JOIN ledger_lines l ON l.tenant_id = t.tenant_id AND l.transaction_id = t.id
        GROUP BY t.tenant_id, t.id, l.currency
        HAVING line_count < 2 OR net <> 0
      )
    `);
    if (invalidLedgerTransactions !== 0) {
      throw new DomainError("BACKUP_VERIFICATION_FAILED", "Backup contains incomplete or unbalanced ledger transactions");
    }
    const invalidConsumptions = countValue(database, `
      SELECT COUNT(*) AS count
      FROM evidence_consumptions c
      JOIN external_evidence e ON e.tenant_id = c.tenant_id AND e.id = c.evidence_id
      WHERE c.scope <> e.scope OR e.replay_policy <> 'single_use'
    `);
    if (invalidConsumptions !== 0) {
      throw new DomainError("BACKUP_VERIFICATION_FAILED", "Backup contains invalid external evidence consumption records");
    }
    const stats = statSync(path);
    if (!Number.isSafeInteger(stats.size) || stats.size <= 0) {
      throw new DomainError("BACKUP_VERIFICATION_FAILED", "Backup file is empty or too large to report safely");
    }
    return {
      path,
      sha256: await fileSha256(path),
      sizeBytes: stats.size,
      schemaVersion: SCHEMA_VERSION,
      integrity: "ok",
      auditChainsValid: true,
      tenantCount: tenants.length,
      recordCount: countValue(database, "SELECT COUNT(*) AS count FROM records"),
      auditEntryCount: countValue(database, "SELECT COUNT(*) AS count FROM audit_entries"),
      evidenceCount: countValue(database, "SELECT COUNT(*) AS count FROM external_evidence"),
      verifiedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("BACKUP_VERIFICATION_FAILED", "Backup database could not be verified", {
      details: { cause: error instanceof Error ? error.name : "unknown" },
    });
  } finally {
    database.close();
  }
}

export class LifeTimeMachineRuntime {
  readonly backend = "sqlite" as const;
  readonly #database: DatabaseSync;
  readonly #databasePath: string;
  readonly #clock: RuntimeClock;
  readonly #trustedEvidenceKeys: readonly TrustedEvidenceKey[];
  readonly #evidencePolicy: "disabled" | "development" | "production";
  readonly #evidenceEnvironment: EvidenceEnvironment;
  readonly #evidenceClockSkewMs: number;
  readonly #maxEvidenceLifetimeMs: number;
  #closed = false;

  constructor(options: RuntimeOptions) {
    if (options.databasePath.trim().length === 0) {
      throw new DomainError("VALIDATION_FAILED", "databasePath is required");
    }
    this.#databasePath = options.databasePath === ":memory:" ? ":memory:" : resolve(options.databasePath);
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#trustedEvidenceKeys = [...(options.trustedEvidenceKeys ?? [])];
    this.#evidencePolicy = options.evidencePolicy ?? (this.#trustedEvidenceKeys.length > 0 ? "development" : "disabled");
    this.#evidenceEnvironment = options.evidenceEnvironment ??
      (this.#evidencePolicy === "production" ? "production" : "sandbox");
    this.#evidenceClockSkewMs = options.evidenceClockSkewMs ?? 300_000;
    this.#maxEvidenceLifetimeMs = options.maxEvidenceLifetimeMs ?? 30 * 24 * 60 * 60 * 1_000;
    if (!Number.isSafeInteger(this.#evidenceClockSkewMs) || this.#evidenceClockSkewMs < 0 || this.#evidenceClockSkewMs > 900_000) {
      throw new DomainError("CONFIGURATION_INVALID", "evidenceClockSkewMs must be between 0 and 900000");
    }
    if (
      !Number.isSafeInteger(this.#maxEvidenceLifetimeMs) ||
      this.#maxEvidenceLifetimeMs < 60_000 ||
      this.#maxEvidenceLifetimeMs > 366 * 24 * 60 * 60 * 1_000
    ) {
      throw new DomainError("CONFIGURATION_INVALID", "maxEvidenceLifetimeMs must be between one minute and 366 days");
    }
    this.#validateEvidenceTrustConfiguration();
    if (this.#databasePath !== ":memory:") {
      mkdirSync(dirname(this.#databasePath), { recursive: true, mode: 0o700 });
    }
    this.#database = new DatabaseSync(this.#databasePath, { timeout: options.busyTimeoutMs ?? 5_000 });
    try {
      this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;");
      if (this.#databasePath !== ":memory:") {
        this.#database.exec("PRAGMA journal_mode = WAL;");
        chmodSync(this.#databasePath, 0o600);
      }
      this.#assertSupportedExistingSchema();
      this.#migrateEvidenceEnvironmentColumn();
      this.#migrateBusinessEvidenceDigestColumns();
      this.#database.exec(SCHEMA_SQL);
      const schema = this.#database.prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get() as
        | SchemaVersionRow
        | undefined;
      if (schema?.value !== String(SCHEMA_VERSION)) {
        throw new DomainError("DEPENDENCY_UNAVAILABLE", "Unsupported database schema version");
      }
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      if (error instanceof DomainError) throw error;
      throw new DomainError("DEPENDENCY_UNAVAILABLE", "Runtime database initialization failed", {
        details: { cause: error instanceof Error ? error.name : "unknown" },
      });
    }
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  async createVerifiedBackup(destinationPathValue: string): Promise<BackupVerification> {
    this.#assertOpen();
    if (this.#databasePath === ":memory:") {
      throw new DomainError("BACKUP_VERIFICATION_FAILED", "In-memory databases cannot produce a durable backup");
    }
    const destinationPath = resolve(textValue(destinationPathValue, "backup destination path", 4_096));
    if (destinationPath === this.#databasePath) {
      throw new DomainError("BACKUP_VERIFICATION_FAILED", "Backup destination must differ from the live database");
    }
    if (existsSync(destinationPath)) {
      throw new DomainError("BACKUP_VERIFICATION_FAILED", "Backup destination already exists; refusing to overwrite it");
    }
    mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
    try {
      await backup(this.#database, destinationPath);
      chmodSync(destinationPath, 0o600);
      return await verifyDatabaseBackup(destinationPath);
    } catch (error) {
      if (existsSync(destinationPath)) unlinkSync(destinationPath);
      if (error instanceof DomainError) throw error;
      throw new DomainError("BACKUP_VERIFICATION_FAILED", "Online database backup failed", {
        details: { cause: error instanceof Error ? error.name : "unknown" },
      });
    }
  }

  readiness(): ReadinessResult {
    if (this.#closed) {
      return { ready: false, database: "error", auditChain: "error", evidenceTrust: "error" };
    }
    try {
      this.#database.prepare("SELECT 1").get();
      const tenants = this.#database.prepare(`
        SELECT tenant_id FROM records
        UNION SELECT tenant_id FROM consents
        UNION SELECT tenant_id FROM idempotency_records
        UNION SELECT tenant_id FROM ledger_transactions
        UNION SELECT tenant_id FROM inbox_events
        UNION SELECT tenant_id FROM outbox_events
        UNION SELECT tenant_id FROM audit_entries
        UNION SELECT tenant_id FROM external_evidence
      `).all() as unknown as TenantRow[];
      const auditValid = tenants.every((row) => {
        const result = this.#verifyAuditTenant(row.tenant_id);
        return result.valid && result.entriesChecked > 0;
      });
      const now = this.#now();
      const hasActiveTrust = this.#trustedEvidenceKeys.some((key) =>
        key.allowedEnvironments.includes(this.#evidenceEnvironment) &&
        (key.notBefore === undefined || key.notBefore <= now) &&
        (key.notAfter === undefined || key.notAfter >= now));
      const evidenceTrust = this.#evidencePolicy === "disabled" ? "disabled" : hasActiveTrust ? "ok" : "error";
      return {
        ready: auditValid && evidenceTrust !== "error",
        database: "ok",
        auditChain: auditValid ? "ok" : "error",
        evidenceTrust,
      };
    } catch {
      return { ready: false, database: "error", auditChain: "error", evidenceTrust: "error" };
    }
  }

  authorize(context: ActorContext, action: string, resource: AuthorizationResource = {}): void {
    this.#assertOpen();
    enforceAuthorization(context, textValue(action, "action", 160), resource);
  }

  registerExternalEvidence(
    context: ActorContext,
    input: RegisterExternalEvidenceInput,
  ): IdempotentResult<RegisteredExternalEvidence> {
    this.authorize(context, "evidence:register", { tenantId: context.tenantId });
    const evidence = this.#validateSignedEvidence(context, input.evidence);
    const key = idempotencyKey(input.idempotencyKey);
    return this.#idempotent(context, key, "evidence.register", evidence, () => {
      const duplicate = this.#database
        .prepare(
          `SELECT id FROM external_evidence
           WHERE tenant_id = ? AND (id = ? OR (issuer = ? AND provider = ? AND nonce = ?)) LIMIT 1`,
        )
        .get(context.tenantId, evidence.evidenceId, evidence.issuer, evidence.provider, evidence.nonce) as
        | { id: string }
        | undefined;
      if (duplicate !== undefined) {
        throw new DomainError("EVIDENCE_REPLAY_DETECTED", "Evidence ID or nonce has already been registered", {
          details: { evidenceId: duplicate.id },
        });
      }
      const verifiedAt = this.#now();
      this.#database
        .prepare(
          `INSERT INTO external_evidence(
            tenant_id, id, envelope_version, issuer, provider, environment, scope, artifact_sha256,
            canonical_claims_sha256, business_event_sha256,
            issued_at, expires_at, nonce, replay_policy, algorithm, key_id, signature,
            status, version, verified_at, revoked_at, revocation_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', 1, ?, NULL, NULL)`,
        )
        .run(
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
        );
      const registered = this.#requiredEvidence(context.tenantId, evidence.evidenceId);
      this.#appendAuditInternal(context, {
        action: "evidence.registered",
        resourceType: "external_evidence",
        resourceId: evidence.evidenceId,
        details: {
          issuer: evidence.issuer,
          provider: evidence.provider,
          environment: evidence.environment,
          scope: evidence.scope,
          artifactSha256: evidence.artifactSha256,
          canonicalClaimsSha256: evidence.canonicalClaimsSha256 ?? null,
          businessEventSha256: evidence.businessEventSha256 ?? null,
          expiresAt: evidence.expiresAt,
          replayPolicy: evidence.replayPolicy,
          keyId: evidence.keyId,
        },
      });
      this.#emitOutbox(context.tenantId, "external_evidence", evidence.evidenceId, "external_evidence.registered", {
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

  requireExternalEvidence(
    context: ActorContext,
    scopeValue: string,
    evidenceIds: readonly string[],
  ): readonly RegisteredExternalEvidence[] {
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
    return this.#transaction(() => {
      const verified: RegisteredExternalEvidence[] = [];
      for (const evidenceId of ids) {
        let evidence: RegisteredExternalEvidence;
        try {
          evidence = this.#requiredEvidence(context.tenantId, evidenceId);
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
          throw new DomainError("EVIDENCE_REVOKED", "External evidence has been revoked", {
            details: { evidenceId },
          });
        }
        if (evidence.expiresAt <= this.#now()) {
          throw new DomainError("EVIDENCE_EXPIRED", "External evidence has expired", { details: { evidenceId } });
        }
        this.#verifyStoredEvidence(evidence);
        if (evidence.replayPolicy === "single_use") {
          this.#consumeEvidence(context, evidence, scope);
          evidence = this.#requiredEvidence(context.tenantId, evidenceId);
        }
        verified.push(evidence);
      }
      this.#appendAuditInternal(context, {
        action: "evidence.required",
        resourceType: "external_evidence_set",
        resourceId: sha256(ids.join("\n")),
        details: { scope, evidenceIds: ids },
      });
      return verified;
    });
  }

  getExternalEvidence(context: ActorContext, evidenceIdValue: string): RegisteredExternalEvidence {
    this.authorize(context, "evidence:read", { tenantId: context.tenantId });
    return this.#requiredEvidence(context.tenantId, token(evidenceIdValue, "external evidence ID"));
  }

  listExternalEvidence(
    context: ActorContext,
    options: { readonly scope?: string; readonly limit?: number } = {},
  ): readonly RegisteredExternalEvidence[] {
    this.authorize(context, "evidence:read", { tenantId: context.tenantId });
    const limit = positiveLimit(options.limit, 50, 200);
    const scope = options.scope === undefined ? undefined : textValue(options.scope, "external evidence scope", 512);
    const rows = scope === undefined
      ? (this.#database
          .prepare(this.#evidenceSelectSql("WHERE e.tenant_id = ? ORDER BY e.verified_at DESC, e.id LIMIT ?"))
          .all(context.tenantId, limit) as unknown as EvidenceRow[])
      : (this.#database
          .prepare(this.#evidenceSelectSql("WHERE e.tenant_id = ? AND e.scope = ? ORDER BY e.verified_at DESC, e.id LIMIT ?"))
          .all(context.tenantId, scope, limit) as unknown as EvidenceRow[]);
    return rows.map(evidenceFromRow);
  }

  revokeExternalEvidence(
    context: ActorContext,
    input: RevokeExternalEvidenceInput,
  ): IdempotentResult<RegisteredExternalEvidence> {
    const evidenceId = token(input.evidenceId, "external evidence ID");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) {
      throw new DomainError("VALIDATION_FAILED", "expectedVersion must be a positive integer");
    }
    const reason = textValue(input.reason, "evidence revocation reason", 500);
    const key = idempotencyKey(input.idempotencyKey);
    this.authorize(context, "evidence:revoke", { tenantId: context.tenantId, sensitive: true });
    const current = this.#requiredEvidence(context.tenantId, evidenceId);
    return this.#idempotent(context, key, "evidence.revoke", { evidenceId, expectedVersion: input.expectedVersion, reason }, () => {
      if (current.status === "revoked") {
        throw new DomainError("EVIDENCE_REVOKED", "External evidence is already revoked");
      }
      const revokedAt = this.#now();
      const result = this.#database
        .prepare(
          `UPDATE external_evidence SET status = 'revoked', version = version + 1,
             revoked_at = ?, revocation_reason = ?
           WHERE tenant_id = ? AND id = ? AND status = 'verified' AND version = ?`,
        )
        .run(revokedAt, reason, context.tenantId, evidenceId, input.expectedVersion);
      if (result.changes !== 1) {
        throw new DomainError("VERSION_CONFLICT", "External evidence version changed", {
          details: { evidenceId, expectedVersion: input.expectedVersion },
        });
      }
      const revoked = this.#requiredEvidence(context.tenantId, evidenceId);
      this.#appendAuditInternal(context, {
        action: "evidence.revoked",
        resourceType: "external_evidence",
        resourceId: evidenceId,
        details: { reason, version: revoked.versionNumber },
      });
      this.#emitOutbox(context.tenantId, "external_evidence", evidenceId, "external_evidence.revoked", {
        evidenceId,
        revokedAt,
      });
      this.#projectEvidenceRevocation(context, evidenceId, reason, revokedAt);
      return revoked;
    });
  }

  createExternalCommand<T extends JsonObject>(
    context: ActorContext,
    input: CreateExternalCommandInput<T>,
  ): IdempotentResult<CreatedExternalCommand<T>> {
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
    this.#requireParticipantConsent(context, participantIds);
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
      () => {
        if (this.#selectRecord(context.tenantId, collection, id, true) !== undefined) {
          throw new DomainError("VERSION_CONFLICT", "External command aggregate already exists");
        }
        const now = this.#now();
        this.#database.prepare(
          `INSERT INTO records(
            tenant_id,collection,id,owner_actor_id,participant_ids_json,contains_minor,
            data_json,version,created_at,updated_at,deleted_at
          ) VALUES (?,?,?,?,?,?,?,1,?,?,NULL)`,
        ).run(
          context.tenantId,
          collection,
          id,
          ownerActorId,
          canonicalJson(participantIds),
          containsMinor ? 1 : 0,
          canonicalJson(data),
          now,
          now,
        );
        const record = this.#requiredRecord<T>(context.tenantId, collection, id, true);
        const command = this.#insertRequestedExternalCommand(
          context,
          { commandId, batchId, operation, aggregateCollection: collection, aggregateId: id, details },
          now,
        );
        this.#appendAuditInternal(context, {
          action: "external_command.created",
          resourceType: collection,
          resourceId: id,
          details: { commandId, batchId, operation, recordVersion: record.version },
        });
        this.#emitOutbox(context.tenantId, collection, id, `${collection}.created`, { record: jsonObject(record) });
        return { record, command };
      },
    );
  }

  transitionExternalCommand(
    context: ActorContext,
    input: TransitionExternalCommandInput,
  ): IdempotentResult<ExternalCommandRecord> {
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
      () => this.#transitionExternalCommandInternal(context, normalized, randomUUID()),
    );
  }

  getExternalCommand(context: ActorContext, commandIdValue: string): ExternalCommandRecord {
    this.authorize(context, "external-command:read", { tenantId: context.tenantId });
    return this.#requiredExternalCommand(context.tenantId, token(commandIdValue, "command ID"));
  }

  applyExternalBusinessEvent(
    context: ActorContext,
    input: ApplyExternalBusinessEventInput,
  ): IdempotentResult<AppliedExternalBusinessEvent> {
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
      () => {
        const eventFingerprint = fingerprint("external-event.apply.event", idempotentPayload);
        const priorEvent = this.#database.prepare(
          `SELECT event_fingerprint,result_json FROM external_business_events
           WHERE tenant_id=? AND provider=? AND event_id=?`,
        ).get(context.tenantId, event.provider, event.eventId) as ExternalBusinessEventRow | undefined;
        if (priorEvent !== undefined) {
          if (priorEvent.event_fingerprint !== eventFingerprint) {
            throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Provider event ID was reused with different business facts");
          }
          return { value: JSON.parse(priorEvent.result_json) as AppliedExternalBusinessEvent, replayed: true };
        }

        this.#registerBusinessEvidence(context, evidence);
        const inboxEvent = this.#receiveBusinessInbox(context, event);
        const registeredEvidence = this.#requiredEvidence(context.tenantId, evidence.evidenceId);
        this.#consumeBusinessEvidence(context, registeredEvidence, event);

        const target = normalizeExternalBusinessAggregateTarget(normalized.reducer.locate(event));
        const currentRow = this.#selectRecord(context.tenantId, target.collection, target.aggregateId, true);
        const current = currentRow === undefined ? null : recordFromRow(currentRow);
        const relatedRecords: Record<string, RecordEnvelope | null> = {};
        for (const selector of target.relatedRecords) {
          const row = this.#selectRecord(context.tenantId, selector.collection, selector.id, false);
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
        const aggregate = this.#persistExternalAggregate(context, target, reduction, current, event);
        const ledgerTransaction = reduction.ledger === undefined
          ? null
          : this.#postExternalBusinessLedger(context, reduction.ledger);
        const command = reduction.commandTransition === undefined
          ? null
          : this.#transitionExternalCommandInternal(context, {
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
          : this.#requiredRecord(context.tenantId, target.collection, target.aggregateId, true);
        const appliedAt = this.#now();
        this.#database.prepare(
          `INSERT INTO evidence_decisions(
            tenant_id,evidence_id,decision_type,decision_id,aggregate_collection,aggregate_id,
            decision_state,reconciliation_state,created_at,updated_at
          ) VALUES (?,?,?,?,?,?,'active','clear',?,?)`,
        ).run(
          context.tenantId,
          evidence.evidenceId,
          reduction.decisionType,
          reduction.decisionId,
          target.collection,
          target.aggregateId,
          appliedAt,
          appliedAt,
        );
        this.#database.prepare(
          `UPDATE inbox_events SET status='processed',processed_at=?
           WHERE tenant_id=? AND id=? AND status='received'`,
        ).run(appliedAt, context.tenantId, inboxEvent.id);
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
        this.#database.prepare(
          `INSERT INTO external_business_events(
            tenant_id,provider,event_id,inbox_event_id,event_fingerprint,batch_id,operation,
            subject_type,subject_id,event_type,provider_occurred_at,provider_sequence,correlation_id,
            artifact_sha256,evidence_id,evidence_scope,canonical_claims_json,canonical_claims_sha256,
            business_event_sha256,reducer_name,aggregate_collection,aggregate_id,prior_state,next_state,
            result_json,applied_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
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
        );
        this.#appendAuditInternal(context, {
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
        this.#emitOutbox(
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

  createRecord<T extends JsonObject>(
    context: ActorContext,
    input: CreateRecordInput<T>,
  ): IdempotentResult<RecordEnvelope<T>> {
    const collection = token(input.collection, "collection", COLLECTION);
    const id = token(input.id ?? randomUUID(), "record ID");
    const ownerActorId = input.ownerActorId === undefined ? context.actorId : input.ownerActorId;
    const participantIds = this.#participantIds(input.participantIds ?? []);
    const containsMinor = input.containsMinor ?? false;
    const data = jsonObject(input.data, "record data") as T;
    const key = idempotencyKey(input.idempotencyKey);
    this.authorize(context, "record:create", {
      tenantId: context.tenantId,
      ownerActorId,
      containsMinor,
    });
    this.#protectMinorSharing(context, collection, containsMinor);
    this.#requireParticipantConsent(context, participantIds);

    return this.#idempotent(
      context,
      key,
      `record.create:${collection}`,
      { requestedId: input.id ?? null, ownerActorId, participantIds, containsMinor, data },
      () => {
        const exists = this.#selectRecord(context.tenantId, collection, id, true);
        if (exists !== undefined) {
          throw new DomainError("VERSION_CONFLICT", "A record with this ID already exists", {
            details: { collection, id },
          });
        }
        const now = this.#now();
        this.#database
          .prepare(
            `INSERT INTO records(
              tenant_id, collection, id, owner_actor_id, participant_ids_json, contains_minor,
              data_json, version, created_at, updated_at, deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
          )
          .run(
            context.tenantId,
            collection,
            id,
            ownerActorId,
            canonicalJson(participantIds),
            containsMinor ? 1 : 0,
            canonicalJson(data),
            now,
            now,
          );
        const record = this.#requiredRecord<T>(context.tenantId, collection, id, true);
        this.#appendAuditInternal(context, {
          action: "record.created",
          resourceType: collection,
          resourceId: id,
          details: { version: record.version },
        });
        this.#emitOutbox(context.tenantId, collection, id, `${collection}.created`, {
          record: jsonObject(record),
        });
        return record;
      },
    );
  }

  getRecord<T extends JsonObject>(context: ActorContext, collectionValue: string, idValue: string): RecordEnvelope<T> {
    const collection = token(collectionValue, "collection", COLLECTION);
    const id = token(idValue, "record ID");
    validateContext(context);
    const record = this.#requiredRecord<T>(context.tenantId, collection, id, false);
    this.authorize(context, "record:read", record);
    this.#requireParticipantConsent(context, record.participantIds);
    return record;
  }

  listRecords<T extends JsonObject>(context: ActorContext, input: ListRecordsInput): readonly RecordEnvelope<T>[] {
    const collection = token(input.collection, "collection", COLLECTION);
    const limit = positiveLimit(input.limit, 50, 200);
    const cursor = input.cursor === undefined ? "" : token(input.cursor, "cursor");
    this.authorize(context, "record:read", { tenantId: context.tenantId });
    const conditions = ["tenant_id = ?", "collection = ?", "id > ?"];
    const parameters: Array<string | number> = [context.tenantId, collection, cursor];
    if (input.includeDeleted !== true) {
      conditions.push("deleted_at IS NULL");
    }
    if (context.roles.includes("consumer") && !hasPermission(context, "record:read:any")) {
      conditions.push("owner_actor_id = ?");
      parameters.push(context.actorId);
    }
    if (!hasPermission(context, "minor:data:manage") || context.guardianVerified !== true) {
      conditions.push("contains_minor = 0");
    }
    parameters.push(limit);
    const rows = this.#database
      .prepare(`SELECT * FROM records WHERE ${conditions.join(" AND ")} ORDER BY id LIMIT ?`)
      .all(...parameters) as unknown as RecordRow[];
    return rows
      .map((row) => recordFromRow<T>(row))
      .filter((record) => this.#hasParticipantConsent(context, record.participantIds));
  }

  updateRecord<T extends JsonObject>(
    context: ActorContext,
    input: UpdateRecordInput<T>,
  ): IdempotentResult<RecordEnvelope<T>> {
    const collection = token(input.collection, "collection", COLLECTION);
    const id = token(input.id, "record ID");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) {
      throw new DomainError("VALIDATION_FAILED", "expectedVersion must be a positive integer");
    }
    const data = jsonObject(input.data, "record data") as T;
    const key = idempotencyKey(input.idempotencyKey);
    validateContext(context);
    const current = this.#requiredRecord<T>(context.tenantId, collection, id, false);
    const ownerActorId = input.ownerActorId === undefined ? current.ownerActorId : input.ownerActorId;
    const participantIds = this.#participantIds(input.participantIds ?? current.participantIds);
    const containsMinor = input.containsMinor ?? current.containsMinor;
    this.authorize(context, "record:update", { ...current, ownerActorId, containsMinor });
    this.#protectMinorSharing(context, collection, containsMinor);
    this.#requireParticipantConsent(context, participantIds);

    return this.#idempotent(
      context,
      key,
      `record.update:${collection}`,
      { id, expectedVersion: input.expectedVersion, ownerActorId, participantIds, containsMinor, data },
      () => {
        const now = this.#now();
        const result = this.#database
          .prepare(
            `UPDATE records
             SET owner_actor_id = ?, participant_ids_json = ?, contains_minor = ?, data_json = ?,
                 version = version + 1, updated_at = ?
             WHERE tenant_id = ? AND collection = ? AND id = ? AND deleted_at IS NULL AND version = ?`,
          )
          .run(
            ownerActorId,
            canonicalJson(participantIds),
            containsMinor ? 1 : 0,
            canonicalJson(data),
            now,
            context.tenantId,
            collection,
            id,
            input.expectedVersion,
          );
        if (result.changes !== 1) {
          this.#throwRecordMutationConflict(context.tenantId, collection, id, input.expectedVersion);
        }
        const record = this.#requiredRecord<T>(context.tenantId, collection, id, false);
        this.#appendAuditInternal(context, {
          action: "record.updated",
          resourceType: collection,
          resourceId: id,
          details: { previousVersion: input.expectedVersion, version: record.version },
        });
        this.#emitOutbox(context.tenantId, collection, id, `${collection}.updated`, {
          record: jsonObject(record),
        });
        return record;
      },
    );
  }

  deleteRecord(context: ActorContext, input: DeleteRecordInput): IdempotentResult<RecordEnvelope> {
    const collection = token(input.collection, "collection", COLLECTION);
    const id = token(input.id, "record ID");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) {
      throw new DomainError("VALIDATION_FAILED", "expectedVersion must be a positive integer");
    }
    const key = idempotencyKey(input.idempotencyKey);
    validateContext(context);
    const current = this.#requiredRecord(context.tenantId, collection, id, true);
    this.authorize(context, "record:delete", current);

    return this.#idempotent(
      context,
      key,
      `record.delete:${collection}`,
      { id, expectedVersion: input.expectedVersion },
      () => {
        const now = this.#now();
        const result = this.#database
          .prepare(
            `UPDATE records SET deleted_at = ?, updated_at = ?, version = version + 1
             WHERE tenant_id = ? AND collection = ? AND id = ? AND deleted_at IS NULL AND version = ?`,
          )
          .run(now, now, context.tenantId, collection, id, input.expectedVersion);
        if (result.changes !== 1) {
          this.#throwRecordMutationConflict(context.tenantId, collection, id, input.expectedVersion);
        }
        const record = this.#requiredRecord(context.tenantId, collection, id, true);
        this.#appendAuditInternal(context, {
          action: "record.deleted",
          resourceType: collection,
          resourceId: id,
          details: { previousVersion: input.expectedVersion, version: record.version },
        });
        this.#emitOutbox(context.tenantId, collection, id, `${collection}.deleted`, {
          id,
          version: record.version,
          deletedAt: record.deletedAt,
        });
        return record;
      },
    );
  }

  grantConsent(context: ActorContext, input: GrantConsentInput): IdempotentResult<ConsentRecord> {
    const id = token(input.id ?? randomUUID(), "consent ID");
    const participantId = token(input.participantId, "participant ID");
    const purpose = textValue(input.purpose, "consent purpose", 120);
    const policyVersion = token(input.policyVersion, "policy version");
    const evidenceHash = input.evidenceHash.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(evidenceHash)) {
      throw new DomainError("VALIDATION_FAILED", "evidenceHash must be a lowercase SHA-256 digest");
    }
    if (purpose !== context.purpose) {
      throw new DomainError("PURPOSE_REQUIRED", "Consent purpose must match the request purpose");
    }
    const scope = jsonObject(input.scope, "consent scope");
    const isMinor = input.isMinor ?? false;
    const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? null : isoTimestamp(input.expiresAt, "expiresAt");
    const key = idempotencyKey(input.idempotencyKey);
    validateContext(context);
    this.#authorizeConsentGrant(context, participantId, input.grantorCapacity, isMinor);

    return this.#idempotent(
      context,
      key,
      "consent.grant",
      { requestedId: input.id ?? null, participantId, purpose, scope, policyVersion, evidenceHash, isMinor, expiresAt },
      () => {
        if (expiresAt !== null && expiresAt <= this.#now()) {
          throw new DomainError("VALIDATION_FAILED", "Consent expiry must be in the future");
        }
        const exists = this.#database
          .prepare("SELECT id FROM consents WHERE tenant_id = ? AND id = ?")
          .get(context.tenantId, id);
        if (exists !== undefined) {
          throw new DomainError("VERSION_CONFLICT", "A consent with this ID already exists");
        }
        this.#database
          .prepare(
            `UPDATE consents SET status = 'superseded', version = version + 1
             WHERE tenant_id = ? AND participant_id = ? AND purpose = ? AND status = 'active'`,
          )
          .run(context.tenantId, participantId, purpose);
        const now = this.#now();
        this.#database
          .prepare(
            `INSERT INTO consents(
              tenant_id, id, participant_id, grantor_actor_id, grantor_capacity, purpose, scope_json,
              policy_version, status, evidence_hash, is_minor, granted_at, expires_at, withdrawn_at, version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, 1)`,
          )
          .run(
            context.tenantId,
            id,
            participantId,
            context.actorId,
            input.grantorCapacity,
            purpose,
            canonicalJson(scope),
            policyVersion,
            evidenceHash,
            isMinor ? 1 : 0,
            now,
            expiresAt,
          );
        const consent = this.#requiredConsent(context.tenantId, id);
        this.#appendAuditInternal(context, {
          action: "consent.granted",
          resourceType: "consent",
          resourceId: id,
          details: { participantId, policyVersion, isMinor },
        });
        this.#emitOutbox(context.tenantId, "consent", id, "consent.granted", {
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

  withdrawConsent(context: ActorContext, input: WithdrawConsentInput): IdempotentResult<ConsentRecord> {
    const consentId = token(input.consentId, "consent ID");
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion <= 0) {
      throw new DomainError("VALIDATION_FAILED", "expectedVersion must be a positive integer");
    }
    const reason = textValue(input.reason, "withdrawal reason", 500);
    const key = idempotencyKey(input.idempotencyKey);
    validateContext(context);
    const current = this.#requiredConsent(context.tenantId, consentId);
    const ownsConsent = current.grantorActorId === context.actorId;
    if (ownsConsent) {
      if (!hasPermission(context, "consent:withdraw:self") && !hasPermission(context, "consent:withdraw")) {
        throw new DomainError("AUTH_FORBIDDEN", "Permission to withdraw consent is required");
      }
    } else {
      this.authorize(context, "consent:withdraw", { tenantId: current.tenantId });
    }

    return this.#idempotent(
      context,
      key,
      "consent.withdraw",
      { consentId, expectedVersion: input.expectedVersion, reason },
      () => {
        if (current.status !== "active") {
          throw new DomainError("CONSENT_WITHDRAWN", "Consent is no longer active");
        }
        const now = this.#now();
        const result = this.#database
          .prepare(
            `UPDATE consents SET status = 'withdrawn', withdrawn_at = ?, version = version + 1
             WHERE tenant_id = ? AND id = ? AND status = 'active' AND version = ?`,
          )
          .run(now, context.tenantId, consentId, input.expectedVersion);
        if (result.changes !== 1) {
          throw new DomainError("VERSION_CONFLICT", "Consent version changed", {
            details: { consentId, expectedVersion: input.expectedVersion },
          });
        }
        const consent = this.#requiredConsent(context.tenantId, consentId);
        this.#appendAuditInternal(context, {
          action: "consent.withdrawn",
          resourceType: "consent",
          resourceId: consentId,
          details: { participantId: consent.participantId, reason, version: consent.version },
        });
        this.#emitOutbox(context.tenantId, "consent", consentId, "consent.withdrawn", {
          consentId,
          participantId: consent.participantId,
          purpose: consent.purpose,
          withdrawnAt: consent.withdrawnAt,
        });
        return consent;
      },
    );
  }

  requireConsent(context: ActorContext, requirement: ConsentRequirement): readonly ConsentRecord[] {
    validateContext(context);
    if (hasPermission(context, "consent:read")) {
      this.authorize(context, "consent:read", { tenantId: context.tenantId });
    } else if (!hasPermission(context, "consent:read:self")) {
      throw new DomainError("AUTH_FORBIDDEN", "Permission to inspect consent is required");
    }
    return this.#activeConsents(context, requirement, true);
  }

  listConsents(context: ActorContext, participantIdValue?: string): readonly ConsentRecord[] {
    validateContext(context);
    const participantId = participantIdValue === undefined ? undefined : token(participantIdValue, "participant ID");
    const mayReadAll = hasPermission(context, "consent:read");
    if (!mayReadAll && !hasPermission(context, "consent:read:self")) {
      throw new DomainError("AUTH_FORBIDDEN", "Permission to inspect consent is required");
    }
    const conditions = ["tenant_id = ?"];
    const parameters: string[] = [context.tenantId];
    if (participantId !== undefined) {
      conditions.push("participant_id = ?");
      parameters.push(participantId);
    }
    if (!mayReadAll) {
      conditions.push("grantor_actor_id = ?");
      parameters.push(context.actorId);
    }
    const rows = this.#database
      .prepare(`SELECT * FROM consents WHERE ${conditions.join(" AND ")} ORDER BY granted_at DESC, id DESC LIMIT 200`)
      .all(...parameters) as unknown as ConsentRow[];
    return rows.map(consentFromRow);
  }

  postLedgerTransaction(
    context: ActorContext,
    input: PostLedgerInput,
  ): IdempotentResult<LedgerTransaction> {
    this.authorize(context, "ledger:post", { tenantId: context.tenantId });
    const transactionId = token(input.transactionId ?? randomUUID(), "transaction ID");
    const sourceType = token(input.sourceType, "source type");
    const sourceId = token(input.sourceId, "source ID");
    const description = textValue(input.description, "description", 500);
    const occurredAt = input.occurredAt === undefined ? this.#now() : isoTimestamp(input.occurredAt, "occurredAt");
    const reversedTransactionId =
      input.reversedTransactionId === undefined || input.reversedTransactionId === null
        ? null
        : token(input.reversedTransactionId, "reversed transaction ID");
    const lines = this.#ledgerLines(input.lines);
    this.#assertBalanced(lines);
    const key = idempotencyKey(input.idempotencyKey);
    const requestFingerprint = fingerprint("ledger.post.source", {
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
      () => {
        const existing = this.#database
          .prepare(
            "SELECT * FROM ledger_transactions WHERE tenant_id = ? AND source_type = ? AND source_id = ?",
          )
          .get(context.tenantId, sourceType, sourceId) as LedgerTransactionRow | undefined;
        if (existing !== undefined) {
          if (existing.request_fingerprint !== requestFingerprint) {
            throw new DomainError("IDEMPOTENCY_CONFLICT", "Ledger source reference was reused with different data");
          }
          return { value: this.#ledgerTransactionFromRow(existing), replayed: true };
        }
        if (reversedTransactionId !== null) {
          const reversed = this.#requiredLedgerTransaction(context.tenantId, reversedTransactionId);
          this.#assertExactReversal(reversed.lines, lines);
        }
        const createdAt = this.#now();
        this.#database
          .prepare(
            `INSERT INTO ledger_transactions(
              tenant_id, id, source_type, source_id, request_fingerprint, description,
              occurred_at, created_at, reversed_transaction_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            context.tenantId,
            transactionId,
            sourceType,
            sourceId,
            requestFingerprint,
            description,
            occurredAt,
            createdAt,
            reversedTransactionId,
          );
        const insertLine = this.#database.prepare(
          `INSERT INTO ledger_lines(
            tenant_id, transaction_id, line_number, account_code, direction, amount_minor, currency, memo
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        lines.forEach((line, index) => {
          insertLine.run(
            context.tenantId,
            transactionId,
            index,
            line.accountCode,
            line.direction,
            line.amountMinor,
            line.currency,
            line.memo ?? null,
          );
        });
        const transaction = this.#requiredLedgerTransaction(context.tenantId, transactionId);
        this.#appendAuditInternal(context, {
          action: "ledger.posted",
          resourceType: "ledger_transaction",
          resourceId: transactionId,
          details: { sourceType, sourceId, reversedTransactionId, lineCount: lines.length },
        });
        this.#emitOutbox(context.tenantId, "ledger_transaction", transactionId, "ledger.transaction.posted", {
          transaction: jsonObject(transaction),
        });
        return transaction;
      },
    );
  }

  getLedgerTransaction(context: ActorContext, transactionIdValue: string): LedgerTransaction {
    this.authorize(context, "ledger:read", { tenantId: context.tenantId });
    return this.#requiredLedgerTransaction(context.tenantId, token(transactionIdValue, "transaction ID"));
  }

  getAccountBalance(context: ActorContext, accountCodeValue: string, currencyValue: string): AccountBalance {
    this.authorize(context, "ledger:read", { tenantId: context.tenantId });
    const accountCode = token(accountCodeValue, "account code", ACCOUNT_CODE);
    const currency = token(currencyValue, "currency", CURRENCY);
    const row = this.#database
      .prepare(
        `SELECT
          COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE 0 END), 0) AS debit,
          COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE 0 END), 0) AS credit
         FROM ledger_lines WHERE tenant_id = ? AND account_code = ? AND currency = ?`,
      )
      .get(context.tenantId, accountCode, currency) as { debit: number; credit: number };
    return {
      accountCode,
      currency,
      debitMinor: row.debit,
      creditMinor: row.credit,
      netMinor: row.debit - row.credit,
    };
  }

  getTrialBalance(context: ActorContext): readonly AccountBalance[] {
    this.authorize(context, "ledger:read", { tenantId: context.tenantId });
    const rows = this.#database
      .prepare(
        `SELECT account_code, currency,
          SUM(CASE WHEN direction = 'debit' THEN amount_minor ELSE 0 END) AS debit,
          SUM(CASE WHEN direction = 'credit' THEN amount_minor ELSE 0 END) AS credit
         FROM ledger_lines WHERE tenant_id = ? GROUP BY account_code, currency ORDER BY account_code, currency`,
      )
      .all(context.tenantId) as unknown as Array<{
      account_code: string;
      currency: string;
      debit: number;
      credit: number;
    }>;
    return rows.map((row) => ({
      accountCode: row.account_code,
      currency: row.currency,
      debitMinor: row.debit,
      creditMinor: row.credit,
      netMinor: row.debit - row.credit,
    }));
  }

  receiveInboxEvent(context: ActorContext, input: ReceiveInboxInput): IdempotentResult<InboxEvent> {
    this.authorize(context, "event:receive", { tenantId: context.tenantId });
    const source = token(input.source, "event source");
    const sourceEventId = token(input.sourceEventId, "source event ID");
    const eventType = token(input.eventType, "event type");
    const payload = jsonObject(input.payload, "event payload");
    const requestFingerprint = fingerprint("inbox.receive", { source, sourceEventId, eventType, payload });

    return this.#transaction(() => {
      const existing = this.#database
        .prepare("SELECT * FROM inbox_events WHERE tenant_id = ? AND source = ? AND source_event_id = ?")
        .get(context.tenantId, source, sourceEventId) as InboxRow | undefined;
      if (existing !== undefined) {
        if (existing.request_fingerprint !== requestFingerprint) {
          throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Event ID was reused with a different payload");
        }
        return { value: inboxFromRow(existing), replayed: true };
      }
      const id = randomUUID();
      const receivedAt = this.#now();
      this.#database
        .prepare(
          `INSERT INTO inbox_events(
            tenant_id, id, source, source_event_id, event_type, request_fingerprint,
            payload_json, status, received_at, processed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'received', ?, NULL)`,
        )
        .run(
          context.tenantId,
          id,
          source,
          sourceEventId,
          eventType,
          requestFingerprint,
          canonicalJson(payload),
          receivedAt,
        );
      const event = this.#requiredInbox(context.tenantId, id);
      this.#appendAuditInternal(context, {
        action: "inbox.received",
        resourceType: "inbox_event",
        resourceId: id,
        details: { source, sourceEventId, eventType },
      });
      this.#emitOutbox(context.tenantId, "inbox_event", id, "inbox.event.received", {
        inboxEventId: id,
        source,
        sourceEventId,
        eventType,
      });
      return { value: event, replayed: false };
    });
  }

  getInboxEvent(context: ActorContext, eventIdValue: string): InboxEvent {
    this.authorize(context, "event:read", { tenantId: context.tenantId });
    return this.#requiredInbox(context.tenantId, token(eventIdValue, "inbox event ID"));
  }

  markInboxProcessed(context: ActorContext, eventIdValue: string, rejected = false): InboxEvent {
    this.authorize(context, "event:process", { tenantId: context.tenantId });
    const eventId = token(eventIdValue, "inbox event ID");
    return this.#transaction(() => {
      const current = this.#requiredInbox(context.tenantId, eventId);
      if (current.status !== "received") {
        return current;
      }
      const status = rejected ? "rejected" : "processed";
      const processedAt = this.#now();
      this.#database
        .prepare(
          "UPDATE inbox_events SET status = ?, processed_at = ? WHERE tenant_id = ? AND id = ? AND status = 'received'",
        )
        .run(status, processedAt, context.tenantId, eventId);
      const event = this.#requiredInbox(context.tenantId, eventId);
      this.#appendAuditInternal(context, {
        action: `inbox.${status}`,
        resourceType: "inbox_event",
        resourceId: eventId,
        details: { status },
      });
      return event;
    });
  }

  listOutbox(
    context: ActorContext,
    options: { readonly status?: OutboxStatus; readonly limit?: number } = {},
  ): readonly OutboxEvent[] {
    this.authorize(context, "outbox:read", { tenantId: context.tenantId });
    const limit = positiveLimit(options.limit, 50, 200);
    const rows = options.status === undefined
      ? (this.#database
          .prepare("SELECT * FROM outbox_events WHERE tenant_id = ? ORDER BY created_at, id LIMIT ?")
          .all(context.tenantId, limit) as unknown as OutboxRow[])
      : (this.#database
          .prepare(
            "SELECT * FROM outbox_events WHERE tenant_id = ? AND status = ? ORDER BY created_at, id LIMIT ?",
          )
          .all(context.tenantId, options.status, limit) as unknown as OutboxRow[]);
    return rows.map(outboxFromRow);
  }

  claimOutbox(context: ActorContext, workerIdValue: string, limitValue = 50, leaseMs = 30_000): readonly OutboxEvent[] {
    this.authorize(context, "outbox:publish", { tenantId: context.tenantId });
    const workerId = token(workerIdValue, "worker ID");
    const limit = positiveLimit(limitValue, 50, 200);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 900_000) {
      throw new DomainError("VALIDATION_FAILED", "leaseMs must be between 1000 and 900000");
    }
    return this.#transaction(() => {
      const now = this.#now();
      this.#database
        .prepare(
          `UPDATE outbox_events
           SET status = 'pending', lease_owner = NULL, lease_until = NULL
           WHERE tenant_id = ? AND status = 'leased' AND lease_until <= ?`,
        )
        .run(context.tenantId, now);
      const candidates = this.#database
        .prepare(
          `SELECT id FROM outbox_events
           WHERE tenant_id = ? AND status = 'pending' AND available_at <= ?
           ORDER BY created_at, id LIMIT ?`,
        )
        .all(context.tenantId, now, limit) as unknown as Array<{ id: string }>;
      const leaseUntil = new Date(new Date(now).getTime() + leaseMs).toISOString();
      const update = this.#database.prepare(
        `UPDATE outbox_events SET status = 'leased', lease_owner = ?, lease_until = ?, attempts = attempts + 1
         WHERE tenant_id = ? AND id = ? AND status = 'pending'`,
      );
      for (const candidate of candidates) {
        update.run(workerId, leaseUntil, context.tenantId, candidate.id);
      }
      if (candidates.length === 0) {
        return [];
      }
      const placeholders = candidates.map(() => "?").join(", ");
      const rows = this.#database
        .prepare(`SELECT * FROM outbox_events WHERE tenant_id = ? AND id IN (${placeholders}) ORDER BY created_at, id`)
        .all(context.tenantId, ...candidates.map((candidate) => candidate.id)) as unknown as OutboxRow[];
      return rows.map(outboxFromRow);
    });
  }

  markOutboxPublished(context: ActorContext, eventIdValue: string, workerIdValue: string): OutboxEvent {
    this.authorize(context, "outbox:publish", { tenantId: context.tenantId });
    const eventId = token(eventIdValue, "outbox event ID");
    const workerId = token(workerIdValue, "worker ID");
    return this.#transaction(() => {
      const now = this.#now();
      const result = this.#database
        .prepare(
          `UPDATE outbox_events
           SET status = 'published', published_at = ?, lease_owner = NULL, lease_until = NULL, last_error = NULL
           WHERE tenant_id = ? AND id = ? AND status = 'leased' AND lease_owner = ?`,
        )
        .run(now, context.tenantId, eventId, workerId);
      if (result.changes !== 1) {
        throw new DomainError("VERSION_CONFLICT", "Outbox event is not leased by this worker");
      }
      return this.#requiredOutbox(context.tenantId, eventId);
    });
  }

  markOutboxFailed(
    context: ActorContext,
    eventIdValue: string,
    workerIdValue: string,
    errorValue: string,
    options: { readonly retryAt?: string; readonly dead?: boolean } = {},
  ): OutboxEvent {
    this.authorize(context, "outbox:publish", { tenantId: context.tenantId });
    const eventId = token(eventIdValue, "outbox event ID");
    const workerId = token(workerIdValue, "worker ID");
    const error = textValue(errorValue, "delivery error", 2_000);
    const retryAt = options.retryAt === undefined ? this.#now() : isoTimestamp(options.retryAt, "retryAt");
    const status: OutboxStatus = options.dead === true ? "dead" : "pending";
    return this.#transaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE outbox_events
           SET status = ?, available_at = ?, lease_owner = NULL, lease_until = NULL, last_error = ?
           WHERE tenant_id = ? AND id = ? AND status = 'leased' AND lease_owner = ?`,
        )
        .run(status, retryAt, error, context.tenantId, eventId, workerId);
      if (result.changes !== 1) {
        throw new DomainError("VERSION_CONFLICT", "Outbox event is not leased by this worker");
      }
      return this.#requiredOutbox(context.tenantId, eventId);
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
    const events = this.claimOutbox(context, workerId, options.limit, options.leaseMs);
    let published = 0;
    let failed = 0;
    for (const event of events) {
      try {
        await publisher.publish(event);
        this.markOutboxPublished(context, event.id, workerId);
        published += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown publisher error";
        const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(event.attempts, 8));
        const retryAt = new Date(this.#clock.now().getTime() + delayMs).toISOString();
        this.markOutboxFailed(context, event.id, workerId, message.slice(0, 2_000), {
          retryAt,
          dead: event.attempts >= 10,
        });
        failed += 1;
      }
    }
    return { published, failed };
  }

  appendAudit(context: ActorContext, input: AppendAuditInput): AuditEntry {
    this.authorize(context, "audit:append", { tenantId: context.tenantId });
    return this.#transaction(() => this.#appendAuditInternal(context, input));
  }

  listAudit(context: ActorContext, limitValue = 100): readonly AuditEntry[] {
    this.authorize(context, "audit:read", { tenantId: context.tenantId });
    const limit = positiveLimit(limitValue, 100, 500);
    return this.#transaction(() => {
      const rows = this.#database
        .prepare("SELECT * FROM audit_entries WHERE tenant_id = ? ORDER BY sequence DESC LIMIT ?")
        .all(context.tenantId, limit) as unknown as AuditRow[];
      this.#appendAuditInternal(context, {
        action: "audit.read",
        resourceType: "audit_log",
        resourceId: context.tenantId,
        details: { limit, returned: rows.length },
      });
      return rows.map(auditFromRow);
    });
  }

  verifyAuditChain(context: ActorContext): AuditVerification {
    this.authorize(context, "audit:read", { tenantId: context.tenantId });
    return this.#transaction(() => {
      const result = this.#verifyAuditTenant(context.tenantId);
      this.#appendAuditInternal(context, {
        action: "audit.verified",
        resourceType: "audit_log",
        resourceId: context.tenantId,
        details: { valid: result.valid, entriesChecked: result.entriesChecked },
      });
      return result;
    });
  }

  #authorizeServiceOperation(context: ActorContext, permission: string): void {
    if (!context.roles.includes("service_account")) {
      throw new DomainError("AUTH_FORBIDDEN", `${permission} is restricted to service accounts`);
    }
    this.authorize(context, permission, { tenantId: context.tenantId });
  }

  #insertRequestedExternalCommand(
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
  ): ExternalCommandRecord {
    assertExternalCommandTransition(null, "requested");
    this.#database.prepare(
      `INSERT INTO external_commands(
        tenant_id,command_id,batch_id,operation,aggregate_collection,aggregate_id,state,
        provider_operation_id,evidence_id,decision_state,reconciliation_state,version,
        requested_at,updated_at,terminal_at,details_json
      ) VALUES (?,?,?,?,?,?,'requested',NULL,NULL,'active','clear',1,?,?,NULL,?)`,
    ).run(
      context.tenantId,
      input.commandId,
      input.batchId,
      input.operation,
      input.aggregateCollection,
      input.aggregateId,
      now,
      now,
      canonicalJson(input.details),
    );
    this.#database.prepare(
      `INSERT INTO external_command_transitions(
        tenant_id,transition_id,command_id,from_state,to_state,provider_operation_id,evidence_id,details_json,occurred_at
      ) VALUES (?,?,?,NULL,'requested',NULL,NULL,?,?)`,
    ).run(context.tenantId, randomUUID(), input.commandId, canonicalJson(input.details), now);
    const command = this.#requiredExternalCommand(context.tenantId, input.commandId);
    this.#emitOutbox(
      context.tenantId,
      input.aggregateCollection,
      input.aggregateId,
      "external_command.requested",
      { command: jsonObject(command) },
    );
    return command;
  }

  #requiredExternalCommand(tenantId: string, commandId: string): ExternalCommandRecord {
    const row = this.#database.prepare(
      "SELECT * FROM external_commands WHERE tenant_id=? AND command_id=?",
    ).get(tenantId, commandId) as ExternalCommandRow | undefined;
    if (row === undefined) {
      throw new DomainError("RESOURCE_NOT_FOUND", "External command was not found", { details: { commandId } });
    }
    return externalCommandFromRow(row);
  }

  #transitionExternalCommandInternal(
    context: ActorContext,
    input: TransitionExternalCommandInput,
    transitionId: string,
  ): ExternalCommandRecord {
    const current = this.#requiredExternalCommand(context.tenantId, input.commandId);
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
      const evidence = this.#requiredEvidence(context.tenantId, requestedEvidenceId);
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
    const updated = this.#database.prepare(
      `UPDATE external_commands SET state=?,provider_operation_id=?,evidence_id=?,version=version+1,
         updated_at=?,terminal_at=?,details_json=?
       WHERE tenant_id=? AND command_id=? AND version=? AND state=?`,
    ).run(
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
    );
    if (updated.changes !== 1) throw new DomainError("VERSION_CONFLICT", "External command changed concurrently");
    this.#database.prepare(
      `INSERT INTO external_command_transitions(
        tenant_id,transition_id,command_id,from_state,to_state,provider_operation_id,evidence_id,details_json,occurred_at
      ) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      context.tenantId,
      transitionId,
      input.commandId,
      current.state,
      input.toState,
      providerOperationId,
      evidenceId,
      canonicalJson(input.details ?? {}),
      now,
    );
    const aggregate = this.#requiredRecord(context.tenantId, current.aggregateCollection, current.aggregateId, false);
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
    const recordUpdate = this.#database.prepare(
      `UPDATE records SET data_json=?,version=version+1,updated_at=?
       WHERE tenant_id=? AND collection=? AND id=? AND version=? AND deleted_at IS NULL`,
    ).run(
      canonicalJson(aggregateData),
      now,
      context.tenantId,
      current.aggregateCollection,
      current.aggregateId,
      aggregate.version,
    );
    if (recordUpdate.changes !== 1) throw new DomainError("VERSION_CONFLICT", "External command aggregate changed concurrently");
    const command = this.#requiredExternalCommand(context.tenantId, input.commandId);
    this.#appendAuditInternal(context, {
      action: "external_command.transitioned",
      resourceType: current.aggregateCollection,
      resourceId: current.aggregateId,
      details: { commandId: input.commandId, fromState: current.state, toState: input.toState, providerOperationId, evidenceId },
    });
    this.#emitOutbox(
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

  #registerBusinessEvidence(context: ActorContext, evidence: SignedExternalEvidence): void {
    let existing: RegisteredExternalEvidence | undefined;
    try {
      existing = this.#requiredEvidence(context.tenantId, evidence.evidenceId);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "RESOURCE_NOT_FOUND") throw error;
    }
    if (existing !== undefined) {
      const signedExisting = {
        version: existing.version,
        evidenceId: existing.evidenceId,
        tenantId: existing.tenantId,
        issuer: existing.issuer,
        provider: existing.provider,
        environment: existing.environment,
        scope: existing.scope,
        artifactSha256: existing.artifactSha256,
        ...(existing.canonicalClaimsSha256 === undefined ? {} : { canonicalClaimsSha256: existing.canonicalClaimsSha256 }),
        ...(existing.businessEventSha256 === undefined ? {} : { businessEventSha256: existing.businessEventSha256 }),
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
    const nonceConflict = this.#database.prepare(
      `SELECT id FROM external_evidence
       WHERE tenant_id=? AND issuer=? AND provider=? AND nonce=? LIMIT 1`,
    ).get(context.tenantId, evidence.issuer, evidence.provider, evidence.nonce) as { id: string } | undefined;
    if (nonceConflict !== undefined) {
      throw new DomainError("EVIDENCE_REPLAY_DETECTED", "Evidence nonce was already registered", {
        details: { evidenceId: nonceConflict.id },
      });
    }
    const verifiedAt = this.#now();
    this.#database.prepare(
      `INSERT INTO external_evidence(
        tenant_id,id,envelope_version,issuer,provider,environment,scope,artifact_sha256,
        canonical_claims_sha256,business_event_sha256,issued_at,expires_at,nonce,replay_policy,
        algorithm,key_id,signature,status,version,verified_at,revoked_at,revocation_reason
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'verified',1,?,NULL,NULL)`,
    ).run(
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
    );
    this.#appendAuditInternal(context, {
      action: "evidence.registered_with_business_event",
      resourceType: "external_evidence",
      resourceId: evidence.evidenceId,
      details: { provider: evidence.provider, scope: evidence.scope, businessEventSha256: evidence.businessEventSha256 ?? null },
    });
  }

  #receiveBusinessInbox(context: ActorContext, event: ApplyExternalBusinessEventInput["event"]): InboxEvent {
    const requestFingerprint = fingerprint("external-event.apply.inbox", event);
    const existing = this.#database.prepare(
      "SELECT * FROM inbox_events WHERE tenant_id=? AND source=? AND source_event_id=?",
    ).get(context.tenantId, event.provider, event.eventId) as InboxRow | undefined;
    if (existing !== undefined) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Inbox event ID was reused with different business facts");
      }
      return inboxFromRow(existing);
    }
    const id = randomUUID();
    const receivedAt = this.#now();
    this.#database.prepare(
      `INSERT INTO inbox_events(
        tenant_id,id,source,source_event_id,event_type,request_fingerprint,payload_json,status,received_at,processed_at
      ) VALUES (?,?,?,?,?,?,?,'received',?,NULL)`,
    ).run(
      context.tenantId,
      id,
      event.provider,
      event.eventId,
      event.eventType,
      requestFingerprint,
      canonicalJson(event),
      receivedAt,
    );
    return this.#requiredInbox(context.tenantId, id);
  }

  #consumeBusinessEvidence(
    context: ActorContext,
    evidence: RegisteredExternalEvidence,
    event: ApplyExternalBusinessEventInput["event"],
  ): void {
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
    this.#database.prepare(
      `INSERT INTO evidence_consumptions(tenant_id,evidence_id,scope,consumption_key_hash,consumed_at)
       VALUES (?,?,?,?,?)`,
    ).run(context.tenantId, evidence.evidenceId, event.evidenceScope, consumptionKeyHash, this.#now());
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

  #persistExternalAggregate(
    context: ActorContext,
    target: ReturnType<typeof normalizeExternalBusinessAggregateTarget>,
    reduction: ExternalBusinessReduction & { readonly stateField: string },
    current: RecordEnvelope | null,
    event: ApplyExternalBusinessEventInput["event"],
  ): RecordEnvelope {
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
      this.#requireParticipantConsent(context, target.participantIds);
      this.#database.prepare(
        `INSERT INTO records(
          tenant_id,collection,id,owner_actor_id,participant_ids_json,contains_minor,data_json,
          version,created_at,updated_at,deleted_at
        ) VALUES (?,?,?,?,?,?,?,1,?,?,NULL)`,
      ).run(
        context.tenantId,
        target.collection,
        target.aggregateId,
        ownerActorId,
        canonicalJson(target.participantIds),
        target.containsMinor ? 1 : 0,
        canonicalJson(data),
        now,
        now,
      );
    } else {
      if (current.deletedAt !== null) throw new DomainError("VERSION_CONFLICT", "External business aggregate is deleted");
      const updated = this.#database.prepare(
        `UPDATE records SET data_json=?,version=version+1,updated_at=?
         WHERE tenant_id=? AND collection=? AND id=? AND version=? AND deleted_at IS NULL`,
      ).run(canonicalJson(data), now, context.tenantId, target.collection, target.aggregateId, current.version);
      if (updated.changes !== 1) throw new DomainError("VERSION_CONFLICT", "External business aggregate changed concurrently");
    }
    return this.#requiredRecord(context.tenantId, target.collection, target.aggregateId, true);
  }

  #postExternalBusinessLedger(
    context: ActorContext,
    input: NonNullable<ExternalBusinessReduction["ledger"]>,
  ): LedgerTransaction {
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
    const existing = this.#database.prepare(
      "SELECT * FROM ledger_transactions WHERE tenant_id=? AND source_type=? AND source_id=?",
    ).get(context.tenantId, input.sourceType, input.sourceId) as LedgerTransactionRow | undefined;
    if (existing !== undefined) {
      if (existing.request_fingerprint !== sourceFingerprint) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", "Ledger source reference was reused with different business data");
      }
      return this.#ledgerTransactionFromRow(existing);
    }
    const reversedTransactionId = input.reversedTransactionId ?? null;
    if (reversedTransactionId !== null) {
      const reversed = this.#requiredLedgerTransaction(context.tenantId, reversedTransactionId);
      this.#assertExactReversal(reversed.lines, lines);
    }
    const occurredAt = input.occurredAt ?? this.#now();
    const createdAt = this.#now();
    this.#database.prepare(
      `INSERT INTO ledger_transactions(
        tenant_id,id,source_type,source_id,request_fingerprint,description,occurred_at,created_at,reversed_transaction_id
      ) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(
      context.tenantId,
      transactionId,
      input.sourceType,
      input.sourceId,
      sourceFingerprint,
      input.description,
      occurredAt,
      createdAt,
      reversedTransactionId,
    );
    const insertLine = this.#database.prepare(
      `INSERT INTO ledger_lines(
        tenant_id,transaction_id,line_number,account_code,direction,amount_minor,currency,memo
      ) VALUES (?,?,?,?,?,?,?,?)`,
    );
    lines.forEach((line, index) => insertLine.run(
      context.tenantId,
      transactionId,
      index,
      line.accountCode,
      line.direction,
      line.amountMinor,
      line.currency,
      line.memo ?? null,
    ));
    const transaction = this.#requiredLedgerTransaction(context.tenantId, transactionId);
    this.#appendAuditInternal(context, {
      action: "ledger.posted_from_external_business_event",
      resourceType: "ledger_transaction",
      resourceId: transactionId,
      details: { sourceType: input.sourceType, sourceId: input.sourceId, lineCount: lines.length },
    });
    this.#emitOutbox(context.tenantId, "ledger_transaction", transactionId, "ledger.transaction.posted", {
      transaction: jsonObject(transaction),
    });
    return transaction;
  }

  #projectEvidenceRevocation(context: ActorContext, evidenceId: string, reason: string, revokedAt: string): void {
    const decisions = this.#database.prepare(
      `SELECT aggregate_collection,aggregate_id,decision_type,decision_id
       FROM evidence_decisions WHERE tenant_id=? AND evidence_id=? AND decision_state='active'`,
    ).all(context.tenantId, evidenceId) as unknown as Array<{
      aggregate_collection: string;
      aggregate_id: string;
      decision_type: string;
      decision_id: string;
    }>;
    const aggregates = new Map(decisions.map((decision) => [
      `${decision.aggregate_collection}\n${decision.aggregate_id}`,
      { collection: decision.aggregate_collection, id: decision.aggregate_id },
    ]));
    for (const aggregateIdentity of aggregates.values()) {
      const aggregate = this.#requiredRecord(context.tenantId, aggregateIdentity.collection, aggregateIdentity.id, true);
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
      const updated = this.#database.prepare(
        `UPDATE records SET data_json=?,version=version+1,updated_at=?
         WHERE tenant_id=? AND collection=? AND id=? AND version=? AND deleted_at IS NULL`,
      ).run(
        canonicalJson(data),
        revokedAt,
        context.tenantId,
        aggregate.collection,
        aggregate.id,
        aggregate.version,
      );
      if (updated.changes !== 1) throw new DomainError("VERSION_CONFLICT", "Evidence-dependent aggregate changed concurrently");
      this.#emitOutbox(
        context.tenantId,
        aggregate.collection,
        aggregate.id,
        `${aggregate.collection}.reconciliation_required`,
        { evidenceId, reason, revokedAt },
      );
    }
    if (decisions.length > 0) {
      this.#database.prepare(
        `UPDATE evidence_decisions SET decision_state='frozen',reconciliation_state='reconciliation_required',updated_at=?
         WHERE tenant_id=? AND evidence_id=? AND decision_state='active'`,
      ).run(revokedAt, context.tenantId, evidenceId);
      this.#database.prepare(
        `UPDATE external_commands SET decision_state='frozen',reconciliation_state='reconciliation_required',
           version=version+1,updated_at=?
         WHERE tenant_id=? AND evidence_id=? AND decision_state='active'`,
      ).run(revokedAt, context.tenantId, evidenceId);
      this.#appendAuditInternal(context, {
        action: "evidence.revocation_projected",
        resourceType: "external_evidence",
        resourceId: evidenceId,
        details: { decisionCount: decisions.length, aggregateCount: aggregates.size, reconciliationState: "reconciliation_required" },
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
        if (!(["test", "sandbox", "staging", "production"] as const).includes(environment)) {
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
    if (!(["test", "sandbox", "staging", "production"] as const).includes(environment)) {
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
    const canonicalClaimsSha256Value = value.canonicalClaimsSha256;
    if (canonicalClaimsSha256Value !== undefined && !/^[a-f0-9]{64}$/.test(canonicalClaimsSha256Value)) {
      throw new DomainError("VALIDATION_FAILED", "canonicalClaimsSha256 must be a lowercase SHA-256 digest");
    }
    const businessEventSha256Value = value.businessEventSha256;
    if (businessEventSha256Value !== undefined && !/^[a-f0-9]{64}$/.test(businessEventSha256Value)) {
      throw new DomainError("VALIDATION_FAILED", "businessEventSha256 must be a lowercase SHA-256 digest");
    }
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
      ...(canonicalClaimsSha256Value === undefined ? {} : { canonicalClaimsSha256: canonicalClaimsSha256Value }),
      ...(businessEventSha256Value === undefined ? {} : { businessEventSha256: businessEventSha256Value }),
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
    const key = this.#trustedEvidenceKeys.find(
      (candidate) =>
        candidate.issuer === evidence.issuer &&
        candidate.provider === evidence.provider &&
        candidate.keyId === evidence.keyId &&
        candidate.algorithm === evidence.algorithm &&
        candidate.allowedEnvironments.includes(evidence.environment),
    );
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

  #migrateEvidenceEnvironmentColumn(): void {
    const table = this.#database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'external_evidence'")
      .get() as { name: string } | undefined;
    if (table === undefined) return;
    const columns = this.#database.prepare("PRAGMA table_info(external_evidence)").all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "environment")) {
      // Legacy v2 evidence did not bind an environment. It is downgraded to sandbox,
      // so a production runtime will never accept it as production evidence.
      this.#database.exec(
        "ALTER TABLE external_evidence ADD COLUMN environment TEXT NOT NULL DEFAULT 'sandbox' " +
        "CHECK (environment IN ('test', 'sandbox', 'staging', 'production'))",
      );
    }
  }

  #migrateBusinessEvidenceDigestColumns(): void {
    const table = this.#database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'external_evidence'")
      .get() as { name: string } | undefined;
    if (table === undefined) return;
    const columns = this.#database.prepare("PRAGMA table_info(external_evidence)").all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "canonical_claims_sha256")) {
      this.#database.exec(
        "ALTER TABLE external_evidence ADD COLUMN canonical_claims_sha256 TEXT " +
        "CHECK (canonical_claims_sha256 IS NULL OR length(canonical_claims_sha256) = 64)",
      );
    }
    if (!columns.some((column) => column.name === "business_event_sha256")) {
      this.#database.exec(
        "ALTER TABLE external_evidence ADD COLUMN business_event_sha256 TEXT " +
        "CHECK (business_event_sha256 IS NULL OR length(business_event_sha256) = 64)",
      );
    }
  }

  #assertSupportedExistingSchema(): void {
    const table = this.#database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_metadata'")
      .get() as { name: string } | undefined;
    if (table === undefined) return;
    const schema = this.#database.prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get() as
      | SchemaVersionRow
      | undefined;
    if (schema === undefined || !["1", "2", "3", String(SCHEMA_VERSION)].includes(schema.value)) {
      throw new DomainError("DEPENDENCY_UNAVAILABLE", "Unsupported database schema version");
    }
  }

  #verifyStoredEvidence(evidence: SignedExternalEvidence): void {
    const key = this.#matchingEvidenceKey(evidence);
    if (!verifyExternalEvidenceSignature(evidence, key.publicKeyPem)) {
      throw new DomainError("EVIDENCE_SIGNATURE_INVALID", "External evidence signature verification failed", {
        details: { evidenceId: evidence.evidenceId, keyId: evidence.keyId },
      });
    }
  }

  #consumeEvidence(context: ActorContext, evidence: RegisteredExternalEvidence, scope: string): void {
    if (context.operationId === undefined) {
      throw new DomainError(
        "EVIDENCE_REPLAY_CONTEXT_REQUIRED",
        "Single-use evidence requires a server-derived stable operation identity",
      );
    }
    const operationId = textValue(context.operationId, "operationId", 256);
    const consumptionKeyHash = sha256(
      canonicalJson({ tenantId: context.tenantId, actorId: context.actorId, scope, operationId }),
    );
    if (evidence.consumptionKeyHash !== null) {
      if (evidence.consumptionKeyHash !== consumptionKeyHash) {
        throw new DomainError("EVIDENCE_REPLAY_DETECTED", "Single-use evidence was already consumed", {
          details: { evidenceId: evidence.evidenceId },
        });
      }
      return;
    }
    this.#database
      .prepare(
        `INSERT INTO evidence_consumptions(tenant_id, evidence_id, scope, consumption_key_hash, consumed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(context.tenantId, evidence.evidenceId, scope, consumptionKeyHash, this.#now());
  }

  #evidenceSelectSql(suffix: string): string {
    return `SELECT e.*, e.version AS evidence_version,
      c.consumed_at, c.consumption_key_hash
      FROM external_evidence e
      LEFT JOIN evidence_consumptions c
        ON c.tenant_id = e.tenant_id AND c.evidence_id = e.id
      ${suffix}`;
  }

  #requiredEvidence(tenantId: string, evidenceId: string): RegisteredExternalEvidence {
    const row = this.#database
      .prepare(this.#evidenceSelectSql("WHERE e.tenant_id = ? AND e.id = ?"))
      .get(tenantId, evidenceId) as unknown as EvidenceRow | undefined;
    if (row === undefined) {
      throw new DomainError("RESOURCE_NOT_FOUND", "External evidence was not found", {
        details: { evidenceId },
      });
    }
    return evidenceFromRow(row);
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new DomainError("DEPENDENCY_UNAVAILABLE", "The runtime database is closed");
    }
  }

  #now(): string {
    const value = this.#clock.now();
    if (!Number.isFinite(value.getTime())) {
      throw new DomainError("INTERNAL_ERROR", "Runtime clock returned an invalid date");
    }
    return value.toISOString();
  }

  #transaction<T>(work: () => T): T {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original domain/storage failure.
      }
      throw error;
    }
  }

  #idempotent<T>(
    context: ActorContext,
    key: string,
    operation: string,
    input: unknown,
    work: () => T | IdempotentResult<T>,
  ): IdempotentResult<T> {
    validateContext(context);
    const requestFingerprint = fingerprint(operation, input);
    return this.#transaction(() => {
      const existing = this.#database
        .prepare(
          `SELECT operation, request_fingerprint, response_json FROM idempotency_records
           WHERE tenant_id = ? AND actor_id = ? AND idempotency_key = ?`,
        )
        .get(context.tenantId, context.actorId, key) as IdempotencyRow | undefined;
      if (existing !== undefined) {
        if (existing.operation !== operation || existing.request_fingerprint !== requestFingerprint) {
          throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for a different request", {
            details: { idempotencyKey: key, operation },
          });
        }
        return { value: JSON.parse(existing.response_json) as T, replayed: true };
      }
      const outcome = work();
      const isWrapped =
        typeof outcome === "object" && outcome !== null && "value" in outcome && "replayed" in outcome;
      const value = isWrapped ? (outcome as IdempotentResult<T>).value : (outcome as T);
      const replayed = isWrapped ? (outcome as IdempotentResult<T>).replayed : false;
      this.#database
        .prepare(
          `INSERT INTO idempotency_records(
            tenant_id, actor_id, idempotency_key, operation, request_fingerprint, response_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          context.tenantId,
          context.actorId,
          key,
          operation,
          requestFingerprint,
          canonicalJson(value),
          this.#now(),
        );
      return { value, replayed };
    });
  }

  #selectRecord(tenantId: string, collection: string, id: string, includeDeleted: boolean): RecordRow | undefined {
    const deletedClause = includeDeleted ? "" : " AND deleted_at IS NULL";
    return this.#database
      .prepare(`SELECT * FROM records WHERE tenant_id = ? AND collection = ? AND id = ?${deletedClause}`)
      .get(tenantId, collection, id) as RecordRow | undefined;
  }

  #requiredRecord<T extends JsonObject>(
    tenantId: string,
    collection: string,
    id: string,
    includeDeleted: boolean,
  ): RecordEnvelope<T> {
    const row = this.#selectRecord(tenantId, collection, id, includeDeleted);
    if (row === undefined) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Record was not found", { details: { collection, id } });
    }
    return recordFromRow<T>(row);
  }

  #throwRecordMutationConflict(tenantId: string, collection: string, id: string, expectedVersion: number): never {
    const row = this.#selectRecord(tenantId, collection, id, true);
    if (row === undefined || row.deleted_at !== null) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Record was not found", { details: { collection, id } });
    }
    throw new DomainError("VERSION_CONFLICT", "Record version changed", {
      details: { collection, id, expectedVersion, actualVersion: row.version },
    });
  }

  #participantIds(values: readonly string[]): readonly string[] {
    if (values.length > 100) {
      throw new DomainError("VALIDATION_FAILED", "At most 100 participant references are allowed");
    }
    return [...new Set(values.map((value) => token(value, "participant ID")))].sort();
  }

  #protectMinorSharing(context: ActorContext, collection: string, containsMinor: boolean): void {
    if (containsMinor && collection.includes("share") && !hasPermission(context, "minor:public-share:restricted")) {
      throw new DomainError("AUTH_FORBIDDEN", "Sharing a minor's data is restricted");
    }
  }

  #hasParticipantConsent(context: ActorContext, participantIds: readonly string[]): boolean {
    try {
      this.#activeConsents(context, { participantIds }, false);
      return true;
    } catch (error) {
      if (error instanceof DomainError && (error.code === "CONSENT_REQUIRED" || error.code === "CONSENT_WITHDRAWN")) {
        return false;
      }
      throw error;
    }
  }

  #requireParticipantConsent(context: ActorContext, participantIds: readonly string[]): void {
    if (participantIds.length > 0) {
      this.#activeConsents(context, { participantIds }, false);
    }
  }

  #activeConsents(
    context: ActorContext,
    requirement: ConsentRequirement,
    enforceSelfVisibility: boolean,
  ): readonly ConsentRecord[] {
    const participantIds = this.#participantIds(requirement.participantIds);
    const purpose = textValue(requirement.purpose ?? context.purpose, "consent purpose", 120);
    const at = requirement.at === undefined ? this.#now() : isoTimestamp(requirement.at, "consent check time");
    const results: ConsentRecord[] = [];
    for (const participantId of participantIds) {
      const rows = this.#database
        .prepare(
          `SELECT * FROM consents
           WHERE tenant_id = ? AND participant_id = ? AND purpose = ?
           ORDER BY granted_at DESC, id DESC`,
        )
        .all(context.tenantId, participantId, purpose) as unknown as ConsentRow[];
      const active = rows.find((row) => row.status === "active" && (row.expires_at === null || row.expires_at > at));
      if (active === undefined) {
        const hasWithdrawn = rows.some((row) => row.status === "withdrawn");
        throw new DomainError(hasWithdrawn ? "CONSENT_WITHDRAWN" : "CONSENT_REQUIRED", "Active purpose-specific consent is required", {
          details: { participantId, purpose },
        });
      }
      if (
        enforceSelfVisibility &&
        !hasPermission(context, "consent:read") &&
        active.grantor_actor_id !== context.actorId
      ) {
        throw new DomainError("AUTH_FORBIDDEN", "Consent belongs to another actor");
      }
      results.push(consentFromRow(active));
    }
    return results;
  }

  #authorizeConsentGrant(
    context: ActorContext,
    participantId: string,
    capacity: GrantConsentInput["grantorCapacity"],
    isMinor: boolean,
  ): void {
    if (isMinor) {
      if (capacity !== "guardian") {
        throw new DomainError("GUARDIAN_VERIFICATION_REQUIRED", "A minor's consent must be granted by a guardian");
      }
      if (!context.roles.includes("guardian")) {
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
    const participant = this.#selectRecord(context.tenantId, "participants", participantId, false);
    if (participant === undefined) {
      if (participantId !== context.actorId && !hasPermission(context, "consent:grant:any")) {
        throw new DomainError("AUTH_FORBIDDEN", "Participant ownership must be established before granting consent");
      }
    } else if (participant.owner_actor_id !== context.actorId && !hasPermission(context, "consent:grant:any")) {
      throw new DomainError("AUTH_FORBIDDEN", "The participant is owned by another actor");
    }
  }

  #requiredConsent(tenantId: string, consentId: string): ConsentRecord {
    const row = this.#database
      .prepare("SELECT * FROM consents WHERE tenant_id = ? AND id = ?")
      .get(tenantId, consentId) as ConsentRow | undefined;
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
    const summarize = (lines: readonly LedgerLine[], reverse: boolean): string =>
      canonicalJson(
        [...lines]
          .map((line) => ({
            accountCode: line.accountCode,
            currency: line.currency,
            direction: reverse ? (line.direction === "debit" ? "credit" : "debit") : line.direction,
            amountMinor: line.amountMinor,
          }))
          .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
      );
    if (summarize(original, true) !== summarize(reversal, false)) {
      throw new DomainError("LEDGER_UNBALANCED", "A reversal must exactly invert the original posted lines");
    }
  }

  #requiredLedgerTransaction(tenantId: string, transactionId: string): LedgerTransaction {
    const row = this.#database
      .prepare("SELECT * FROM ledger_transactions WHERE tenant_id = ? AND id = ?")
      .get(tenantId, transactionId) as LedgerTransactionRow | undefined;
    if (row === undefined) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Ledger transaction was not found", {
        details: { transactionId },
      });
    }
    return this.#ledgerTransactionFromRow(row);
  }

  #ledgerTransactionFromRow(row: LedgerTransactionRow): LedgerTransaction {
    const lineRows = this.#database
      .prepare(
        `SELECT account_code, direction, amount_minor, currency, memo FROM ledger_lines
         WHERE tenant_id = ? AND transaction_id = ? ORDER BY line_number`,
      )
      .all(row.tenant_id, row.id) as unknown as LedgerLineRow[];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      sourceType: row.source_type,
      sourceId: row.source_id,
      description: row.description,
      occurredAt: row.occurred_at,
      createdAt: row.created_at,
      reversedTransactionId: row.reversed_transaction_id,
      lines: lineRows.map(ledgerLineFromRow),
    };
  }

  #requiredInbox(tenantId: string, eventId: string): InboxEvent {
    const row = this.#database
      .prepare("SELECT * FROM inbox_events WHERE tenant_id = ? AND id = ?")
      .get(tenantId, eventId) as InboxRow | undefined;
    if (row === undefined) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Inbox event was not found", { details: { eventId } });
    }
    return inboxFromRow(row);
  }

  #emitOutbox(
    tenantId: string,
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: JsonObject,
  ): OutboxEvent {
    const id = randomUUID();
    const now = this.#now();
    this.#database
      .prepare(
        `INSERT INTO outbox_events(
          tenant_id, id, aggregate_type, aggregate_id, event_type, payload_json, status,
          attempts, available_at, lease_owner, lease_until, created_at, published_at, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, NULL, NULL)`,
      )
      .run(tenantId, id, aggregateType, aggregateId, eventType, canonicalJson(payload), now, now);
    return this.#requiredOutbox(tenantId, id);
  }

  #requiredOutbox(tenantId: string, eventId: string): OutboxEvent {
    const row = this.#database
      .prepare("SELECT * FROM outbox_events WHERE tenant_id = ? AND id = ?")
      .get(tenantId, eventId) as OutboxRow | undefined;
    if (row === undefined) {
      throw new DomainError("RESOURCE_NOT_FOUND", "Outbox event was not found", { details: { eventId } });
    }
    return outboxFromRow(row);
  }

  #appendAuditInternal(context: ActorContext, input: AppendAuditInput): AuditEntry {
    validateContext(context);
    const action = textValue(input.action, "audit action", 160);
    const resourceType = textValue(input.resourceType, "audit resource type", 120);
    const resourceId = textValue(input.resourceId, "audit resource ID", 160);
    const details = jsonObject(input.details ?? {}, "audit details");
    const previous = this.#database
      .prepare("SELECT entry_hash FROM audit_entries WHERE tenant_id = ? ORDER BY sequence DESC LIMIT 1")
      .get(context.tenantId) as { entry_hash: string } | undefined;
    const previousHash = previous?.entry_hash ?? GENESIS_HASH;
    const id = randomUUID();
    const createdAt = this.#now();
    const hash = this.#auditHash({
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
    });
    this.#database
      .prepare(
        `INSERT INTO audit_entries(
          id, tenant_id, actor_id, action, resource_type, resource_id, purpose, request_id,
          details_json, previous_hash, entry_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
    const row = this.#database.prepare("SELECT * FROM audit_entries WHERE id = ?").get(id) as unknown as AuditRow;
    return auditFromRow(row);
  }

  #auditHash(entry: Omit<AuditEntry, "sequence" | "hash">): string {
    return sha256(canonicalJson(entry));
  }

  #verifyAuditTenant(tenantId: string): AuditVerification {
    const rows = this.#database
      .prepare("SELECT * FROM audit_entries WHERE tenant_id = ? ORDER BY sequence")
      .all(tenantId) as unknown as AuditRow[];
    return verifyAuditRows(rows);
  }
}
