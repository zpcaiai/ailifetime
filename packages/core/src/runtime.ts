import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, fingerprint, jsonObject, parseJsonObject, sha256 } from "./canonical.js";
import { DomainError } from "./errors.js";
import { authorize as enforceAuthorization, hasPermission, validateContext } from "./policy.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
import type {
  AccountBalance,
  ActorContext,
  AppendAuditInput,
  AuditEntry,
  AuditVerification,
  AuthorizationResource,
  ConsentRecord,
  ConsentRequirement,
  CreateRecordInput,
  DeleteRecordInput,
  ExternalEvidenceVerifier,
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
  RecordEnvelope,
  RuntimeClock,
  RuntimeOptions,
  UpdateRecordInput,
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
  if (normalized.length === 0 || normalized.length > maximum) {
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

export class LifeTimeMachineRuntime {
  readonly #database: DatabaseSync;
  readonly #clock: RuntimeClock;
  readonly #externalEvidenceVerifier: ExternalEvidenceVerifier | undefined;
  #closed = false;

  constructor(options: RuntimeOptions) {
    if (options.databasePath.trim().length === 0) {
      throw new DomainError("VALIDATION_FAILED", "databasePath is required");
    }
    this.#clock = options.clock ?? SYSTEM_CLOCK;
    this.#externalEvidenceVerifier = options.externalEvidenceVerifier;
    if (options.databasePath !== ":memory:") {
      mkdirSync(dirname(resolve(options.databasePath)), { recursive: true, mode: 0o700 });
    }
    this.#database = new DatabaseSync(options.databasePath, { timeout: options.busyTimeoutMs ?? 5_000 });
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF;");
    if (options.databasePath !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL;");
    }
    this.#database.exec(SCHEMA_SQL);
    const schema = this.#database.prepare("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get() as
      | SchemaVersionRow
      | undefined;
    if (schema?.value !== String(SCHEMA_VERSION)) {
      this.#database.close();
      this.#closed = true;
      throw new DomainError("DEPENDENCY_UNAVAILABLE", "Unsupported database schema version");
    }
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  readiness(): ReadinessResult {
    if (this.#closed) {
      return { ready: false, database: "error", auditChain: "error" };
    }
    try {
      this.#database.prepare("SELECT 1").get();
      const tenants = this.#database.prepare("SELECT DISTINCT tenant_id FROM audit_entries").all() as unknown as TenantRow[];
      const auditValid = tenants.every((row) => this.#verifyAuditTenant(row.tenant_id).valid);
      return {
        ready: auditValid,
        database: "ok",
        auditChain: auditValid ? "ok" : "error",
      };
    } catch {
      return { ready: false, database: "error", auditChain: "error" };
    }
  }

  authorize(context: ActorContext, action: string, resource: AuthorizationResource = {}): void {
    this.#assertOpen();
    enforceAuthorization(context, textValue(action, "action", 160), resource);
  }

  requireExternalEvidence(context: ActorContext, scopeValue: string, evidenceIds: readonly string[]): void {
    this.#assertOpen();
    validateContext(context);
    const scope = token(scopeValue, "external evidence scope");
    const ids = [...new Set(evidenceIds.map((id) => token(id, "external evidence ID")))].sort();
    if (ids.length === 0 || ids.length > 100) {
      throw new DomainError("VALIDATION_FAILED", "Between 1 and 100 external evidence IDs are required");
    }
    if (this.#externalEvidenceVerifier === undefined) {
      throw new DomainError(
        "EXTERNAL_ADAPTER_UNAVAILABLE",
        "No server-side external evidence verifier is configured",
      );
    }
    let verified: readonly string[];
    try {
      verified = this.#externalEvidenceVerifier.verify(context, scope, ids);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("DEPENDENCY_UNAVAILABLE", "External evidence verification failed", { retryable: true });
    }
    const verifiedIds = new Set(verified.map((id) => token(id, "verified external evidence ID")));
    const unverified = ids.filter((id) => !verifiedIds.has(id));
    if (unverified.length > 0) {
      throw new DomainError("EXTERNAL_EVIDENCE_UNVERIFIED", "One or more external evidence IDs were not verified", {
        details: { scope, unverified },
      });
    }
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
    let previousHash = GENESIS_HASH;
    let checked = 0;
    for (const row of rows) {
      const entry = auditFromRow(row);
      const expected = this.#auditHash({
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
      });
      if (entry.previousHash !== previousHash || entry.hash !== expected) {
        return { valid: false, entriesChecked: checked, invalidSequence: entry.sequence };
      }
      previousHash = entry.hash;
      checked += 1;
    }
    return { valid: true, entriesChecked: checked, invalidSequence: null };
  }
}
