import { createHash, randomUUID } from "node:crypto";
import { OrchestrationError } from "./provider-control-plane.js";
import { type WorkflowDefinition, type WorkflowInstance, type WorkflowRepository, workflowStateSha256 } from "./durable-workflow.js";

export const ORCHESTRATION_SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS orchestration;
CREATE TABLE IF NOT EXISTS orchestration.workflow_instances (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  definition_id text NOT NULL,
  definition_version integer NOT NULL CHECK (definition_version > 0),
  idempotency_key text NOT NULL,
  state jsonb NOT NULL,
  state_sha256 text NOT NULL CHECK (state_sha256 ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, definition_id, idempotency_key)
);
ALTER TABLE orchestration.workflow_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration.workflow_instances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_tenant_isolation ON orchestration.workflow_instances;
CREATE POLICY workflow_tenant_isolation ON orchestration.workflow_instances
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE TABLE IF NOT EXISTS orchestration.outbox (
  id text PRIMARY KEY, tenant_id text NOT NULL, idempotency_key text NOT NULL,
  request_sha256 text NOT NULL, envelope jsonb NOT NULL, state text NOT NULL,
  attempt integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL,
  receipt_sha256 text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS orchestration.inbox (
  tenant_id text NOT NULL, message_id text NOT NULL, payload_sha256 text NOT NULL,
  processed_at timestamptz NOT NULL, PRIMARY KEY (tenant_id, message_id)
);
CREATE TABLE IF NOT EXISTS orchestration.dead_letters (
  id text PRIMARY KEY, tenant_id text NOT NULL, envelope jsonb NOT NULL,
  reason_code text NOT NULL, replay_count integer NOT NULL DEFAULT 0,
  quarantined_at timestamptz NOT NULL, replayed_at timestamptz
);
ALTER TABLE orchestration.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration.outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE orchestration.inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration.inbox FORCE ROW LEVEL SECURITY;
ALTER TABLE orchestration.dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE orchestration.dead_letters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS outbox_tenant_isolation ON orchestration.outbox;
DROP POLICY IF EXISTS inbox_tenant_isolation ON orchestration.inbox;
DROP POLICY IF EXISTS dead_letters_tenant_isolation ON orchestration.dead_letters;
CREATE POLICY outbox_tenant_isolation ON orchestration.outbox USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY inbox_tenant_isolation ON orchestration.inbox USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
CREATE POLICY dead_letters_tenant_isolation ON orchestration.dead_letters USING (tenant_id = current_setting('app.tenant_id', true)) WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
ALTER TABLE orchestration.outbox ADD COLUMN IF NOT EXISTS reason_code text;
ALTER TABLE orchestration.outbox ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE orchestration.outbox ADD COLUMN IF NOT EXISTS lease_until timestamptz;
CREATE TABLE IF NOT EXISTS orchestration.provider_executions (
  idempotency_key text PRIMARY KEY, tenant_id text NOT NULL, version integer NOT NULL,
  record jsonb NOT NULL, updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS orchestration.late_provider_results (
  id bigserial PRIMARY KEY, tenant_id text NOT NULL, provider_id text NOT NULL,
  provider_operation_id text NOT NULL, provider_idempotency_key text NOT NULL,
  output_artifact_sha256 text NOT NULL, observed_at timestamptz NOT NULL,
  state text NOT NULL, deletion_receipt_sha256 text
);
CREATE TABLE IF NOT EXISTS orchestration.workflow_history (
  workflow_id text NOT NULL, sequence integer NOT NULL, tenant_id text NOT NULL,
  event jsonb NOT NULL, event_sha256 text NOT NULL,
  PRIMARY KEY (workflow_id, sequence)
);
CREATE TABLE IF NOT EXISTS orchestration.scheduler_jobs (
  id text PRIMARY KEY, tenant_id text NOT NULL, kind text NOT NULL,
  payload_sha256 text NOT NULL, due_at timestamptz NOT NULL,
  interval_ms bigint, last_enqueued_at timestamptz
);
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['provider_executions','late_provider_results','workflow_history','scheduler_jobs'] LOOP
    EXECUTE format('ALTER TABLE orchestration.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE orchestration.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON orchestration.%I', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON orchestration.%I USING (tenant_id = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))', table_name);
  END LOOP;
END $$;
`;

export interface SqlResult<Row> { readonly rows: readonly Row[]; readonly rowCount: number | null; }
export interface SqlClient { query<Row extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<SqlResult<Row>>; }
export interface SqlTransactionExecutor { transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T>; }
export interface PgPoolLike { connect(): Promise<SqlClient & { release(): void }>; }

export class PostgresTransactionExecutor implements SqlTransactionExecutor {
  constructor(readonly pool: PgPoolLike) {}
  async transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* retain the original transaction failure */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

interface WorkflowRow extends Record<string, unknown> {
  readonly state: WorkflowInstance | string;
}

export class PostgresWorkflowRepository implements WorkflowRepository {
  constructor(readonly sql: SqlTransactionExecutor, readonly tenantId: string) {
    if (tenantId.trim() === "") throw new OrchestrationError("VALIDATION_FAILED", "PostgreSQL workflow tenant is required");
  }

  async initialize(): Promise<void> {
    await this.sql.transaction(async (client) => { await client.query(ORCHESTRATION_SCHEMA_SQL); });
  }

  async load(id: string): Promise<WorkflowInstance | undefined> {
    return this.#tenantTransaction(async (client) => {
      const result = await client.query<WorkflowRow>("SELECT state FROM orchestration.workflow_instances WHERE tenant_id = $1 AND id = $2", [this.tenantId, id]);
      return parseInstance(result.rows[0]?.state);
    });
  }

  async findByIdempotency(definitionId: string, idempotencyKey: string): Promise<WorkflowInstance | undefined> {
    return this.#tenantTransaction(async (client) => {
      const result = await client.query<WorkflowRow>("SELECT state FROM orchestration.workflow_instances WHERE tenant_id = $1 AND definition_id = $2 AND idempotency_key = $3", [this.tenantId, definitionId, idempotencyKey]);
      return parseInstance(result.rows[0]?.state);
    });
  }

  async save(expectedSha256: string | undefined, next: WorkflowInstance): Promise<void> {
    if (next.tenantId !== this.tenantId) throw new OrchestrationError("AUTHORIZATION_FAILED", "cross-tenant workflow persistence is forbidden");
    const state = stableJson(next);
    const stateSha256 = workflowStateSha256(next);
    if (expectedSha256 === undefined) {
      try {
        await this.#tenantTransaction(async (client) => { await client.query("INSERT INTO orchestration.workflow_instances (id, tenant_id, definition_id, definition_version, idempotency_key, state, state_sha256, updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::timestamptz)", [next.id, next.tenantId, next.definitionId, next.definitionVersion, next.idempotencyKey, state, stateSha256, next.updatedAt]); });
      } catch (error) {
        if (postgresCode(error) === "23505") throw new OrchestrationError("CONFLICT", "workflow PostgreSQL insert conflicted with an existing identity");
        throw error;
      }
      return;
    }
    if (!digest(expectedSha256)) throw new OrchestrationError("VALIDATION_FAILED", "workflow expected state digest is invalid");
    const result = await this.#tenantTransaction(async (client) => client.query("UPDATE orchestration.workflow_instances SET definition_version=$4, state=$5::jsonb, state_sha256=$6, updated_at=$7::timestamptz WHERE tenant_id=$1 AND id=$2 AND state_sha256=$3", [next.tenantId, next.id, expectedSha256, next.definitionVersion, state, stateSha256, next.updatedAt]));
    if (result.rowCount !== 1) throw new OrchestrationError("CONFLICT", "workflow PostgreSQL compare-and-swap failed");
  }

  async #tenantTransaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    return this.sql.transaction(async (client) => {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [this.tenantId]);
      return operation(client);
    });
  }
}

export interface DurableEnvelope {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly payloadSha256: string;
  readonly consentArtifactSha256: string;
  readonly resourceRevision: number;
  readonly partnerId?: string;
  readonly providerId?: string;
  readonly createdAt: string;
}

export interface OutboxRecord {
  readonly envelope: DurableEnvelope;
  readonly state: "pending" | "delivering" | "delivered" | "dead_letter";
  readonly attempt: number;
  readonly nextAttemptAt: string;
  readonly receiptSha256?: string;
  readonly reasonCode?: string;
  /** Internal lease fencing token; never exposed as a provider payload. */
  readonly leaseToken?: string;
}

export interface DeadLetter {
  readonly id: string;
  readonly envelope: DurableEnvelope;
  readonly reasonCode: string;
  readonly replayCount: number;
  readonly quarantinedAt: string;
  readonly replayedAt?: string;
}

export interface MessageJournalStore {
  findOutboxByIdempotency(tenantId: string, key: string): Promise<OutboxRecord | undefined>;
  putOutbox(record: OutboxRecord): Promise<void>;
  listDue(now: string, limit: number): Promise<readonly OutboxRecord[]>;
  inboxPayload(tenantId: string, messageId: string): Promise<string | undefined>;
  markInbox(tenantId: string, messageId: string, payloadSha256: string, processedAt: string): Promise<void>;
  putDeadLetter(value: DeadLetter): Promise<void>;
  getDeadLetter(id: string): Promise<DeadLetter | undefined>;
  /** Atomically leases due rows. Production stores must implement this method. */
  claimDue?(now: string, limit: number, leaseUntil: string): Promise<readonly OutboxRecord[]>;
  /** Fenced completion of a previously claimed row. */
  settleClaim?(claimed: OutboxRecord, next: OutboxRecord): Promise<void>;
}

export class InMemoryMessageJournalStore implements MessageJournalStore {
  readonly #outbox = new Map<string, OutboxRecord>();
  readonly #inbox = new Map<string, string>();
  readonly #dead = new Map<string, DeadLetter>();
  async findOutboxByIdempotency(tenantId: string, key: string): Promise<OutboxRecord | undefined> { return clone(this.#outbox.get(`${tenantId}:${key}`)); }
  async putOutbox(record: OutboxRecord): Promise<void> { this.#outbox.set(`${record.envelope.tenantId}:${record.envelope.idempotencyKey}`, structuredClone(record)); }
  async listDue(now: string, limit: number): Promise<readonly OutboxRecord[]> { return [...this.#outbox.values()].filter((value) => ["pending", "delivering"].includes(value.state) && value.nextAttemptAt <= now).sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt)).slice(0, limit).map((value) => structuredClone(value)); }
  async claimDue(now: string, limit: number, _leaseUntil: string): Promise<readonly OutboxRecord[]> {
    const due = [...this.#outbox.values()]
      .filter((value) => ["pending", "delivering"].includes(value.state) && value.nextAttemptAt <= now)
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt))
      .slice(0, limit);
    const claimed = due.map((value) => Object.freeze({ ...value, state: "delivering" as const, attempt: value.attempt + 1, leaseToken: `${value.envelope.id}:${value.attempt + 1}` }));
    for (const value of claimed) this.#outbox.set(`${value.envelope.tenantId}:${value.envelope.idempotencyKey}`, structuredClone(value));
    return Object.freeze(structuredClone(claimed));
  }
  async settleClaim(claimed: OutboxRecord, next: OutboxRecord): Promise<void> {
    const key = `${claimed.envelope.tenantId}:${claimed.envelope.idempotencyKey}`;
    const current = this.#outbox.get(key);
    if (current?.state !== "delivering" || current.attempt !== claimed.attempt || current.leaseToken !== claimed.leaseToken) throw new OrchestrationError("CONFLICT", "outbox claim fence was lost");
    this.#outbox.set(key, structuredClone(next));
  }
  async inboxPayload(tenantId: string, messageId: string): Promise<string | undefined> { return this.#inbox.get(`${tenantId}:${messageId}`); }
  async markInbox(tenantId: string, messageId: string, payloadSha256: string): Promise<void> { const key = `${tenantId}:${messageId}`; const prior = this.#inbox.get(key); if (prior !== undefined && prior !== payloadSha256) throw new OrchestrationError("CONFLICT", "inbox message id was reused with a different payload"); this.#inbox.set(key, payloadSha256); }
  async putDeadLetter(value: DeadLetter): Promise<void> { this.#dead.set(value.id, structuredClone(value)); }
  async getDeadLetter(id: string): Promise<DeadLetter | undefined> { return clone(this.#dead.get(id)); }
}

interface OutboxSqlRow extends Record<string, unknown> {
  readonly envelope: unknown;
  readonly state: OutboxRecord["state"];
  readonly attempt: number | string;
  readonly next_attempt_at: string | Date;
  readonly receipt_sha256?: string | null;
  readonly reason_code?: string | null;
  readonly lease_owner?: string | null;
}
interface DeadLetterSqlRow extends Record<string, unknown> { readonly envelope: unknown; readonly replay_count: number | string; readonly quarantined_at: string | Date; readonly replayed_at?: string | Date | null; }

/** PostgreSQL outbox/inbox journal with SKIP LOCKED leasing and fencing. */
export class PostgresMessageJournalStore implements MessageJournalStore {
  constructor(readonly sql: SqlTransactionExecutor, readonly tenantId: string) {
    if (tenantId.trim() === "") throw new OrchestrationError("VALIDATION_FAILED", "PostgreSQL journal tenant is required");
  }
  async findOutboxByIdempotency(_tenantId: string, key: string): Promise<OutboxRecord | undefined> {
    return this.#tenant(async (client) => {
      const result = await client.query<OutboxSqlRow>("SELECT envelope,state,attempt,next_attempt_at,receipt_sha256,reason_code,lease_owner FROM orchestration.outbox WHERE tenant_id=$1 AND idempotency_key=$2", [this.tenantId, key]);
      return result.rows[0] === undefined ? undefined : outboxRecord(result.rows[0]);
    });
  }
  async putOutbox(record: OutboxRecord): Promise<void> {
    if (record.envelope.tenantId !== this.tenantId) throw new OrchestrationError("AUTHORIZATION_FAILED", "cross-tenant outbox persistence is forbidden");
    await this.#tenant(async (client) => {
      await client.query(
        "INSERT INTO orchestration.outbox (id,tenant_id,idempotency_key,request_sha256,envelope,state,attempt,next_attempt_at,receipt_sha256,reason_code,lease_owner,lease_until,created_at,updated_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::timestamptz,$9,$10,$11,$12::timestamptz,$13::timestamptz,$13::timestamptz) ON CONFLICT (tenant_id,idempotency_key) DO UPDATE SET state=EXCLUDED.state,attempt=EXCLUDED.attempt,next_attempt_at=EXCLUDED.next_attempt_at,receipt_sha256=EXCLUDED.receipt_sha256,reason_code=EXCLUDED.reason_code,lease_owner=EXCLUDED.lease_owner,lease_until=EXCLUDED.lease_until,updated_at=EXCLUDED.updated_at",
        [record.envelope.id, this.tenantId, record.envelope.idempotencyKey, record.envelope.requestSha256, JSON.stringify(record.envelope), record.state, record.attempt, record.nextAttemptAt, record.receiptSha256 ?? null, record.reasonCode ?? null, record.leaseToken ?? null, record.leaseToken === undefined ? null : record.nextAttemptAt, record.envelope.createdAt],
      );
    });
  }
  async claimDue(now: string, limit: number, leaseUntil: string): Promise<readonly OutboxRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new OrchestrationError("VALIDATION_FAILED", "outbox claim limit is invalid");
    const leaseToken = randomUUID();
    return this.#tenant(async (client) => {
      const result = await client.query<OutboxSqlRow>(
        "WITH candidates AS (SELECT id FROM orchestration.outbox WHERE tenant_id=$1 AND ((state='pending' AND next_attempt_at <= $2::timestamptz) OR (state='delivering' AND lease_until <= $2::timestamptz)) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT $3) UPDATE orchestration.outbox AS o SET state='delivering',attempt=o.attempt+1,lease_owner=$4,lease_until=$5::timestamptz,updated_at=$2::timestamptz FROM candidates WHERE o.id=candidates.id RETURNING o.envelope,o.state,o.attempt,o.next_attempt_at,o.receipt_sha256,o.reason_code,o.lease_owner",
        [this.tenantId, now, limit, leaseToken, leaseUntil],
      );
      return Object.freeze(result.rows.map((row) => outboxRecord(row)));
    });
  }
  async settleClaim(claimed: OutboxRecord, next: OutboxRecord): Promise<void> {
    if (claimed.envelope.tenantId !== this.tenantId || next.envelope.tenantId !== this.tenantId || claimed.leaseToken === undefined) throw new OrchestrationError("AUTHORIZATION_FAILED", "outbox claim tenant or fence is invalid");
    await this.#tenant(async (client) => {
      const result = await client.query(
        "UPDATE orchestration.outbox SET state=$4,attempt=$5,next_attempt_at=$6::timestamptz,receipt_sha256=$7,reason_code=$8,lease_owner=NULL,lease_until=NULL,updated_at=$9::timestamptz WHERE tenant_id=$1 AND id=$2 AND state='delivering' AND attempt=$3 AND lease_owner=$10",
        [this.tenantId, claimed.envelope.id, claimed.attempt, next.state, next.attempt, next.nextAttemptAt, next.receiptSha256 ?? null, next.reasonCode ?? null, next.envelope.createdAt, claimed.leaseToken],
      );
      if (result.rowCount !== 1) throw new OrchestrationError("CONFLICT", "outbox claim fence was lost");
    });
  }
  async listDue(now: string, limit: number): Promise<readonly OutboxRecord[]> { return this.#tenant(async (client) => { const result = await client.query<OutboxSqlRow>("SELECT envelope,state,attempt,next_attempt_at,receipt_sha256,reason_code,lease_owner FROM orchestration.outbox WHERE tenant_id=$1 AND ((state='pending' AND next_attempt_at <= $2::timestamptz) OR (state='delivering' AND lease_until <= $2::timestamptz)) ORDER BY next_attempt_at,id LIMIT $3", [this.tenantId, now, limit]); return Object.freeze(result.rows.map((row) => outboxRecord(row))); }); }
  async inboxPayload(_tenantId: string, messageId: string): Promise<string | undefined> { return this.#tenant(async (client) => { const result = await client.query<{ payload_sha256: string }>("SELECT payload_sha256 FROM orchestration.inbox WHERE tenant_id=$1 AND message_id=$2", [this.tenantId, messageId]); return result.rows[0]?.payload_sha256; }); }
  async markInbox(_tenantId: string, messageId: string, payloadSha256: string, processedAt: string): Promise<void> { await this.#tenant(async (client) => { try { await client.query("INSERT INTO orchestration.inbox (tenant_id,message_id,payload_sha256,processed_at) VALUES ($1,$2,$3,$4::timestamptz)", [this.tenantId, messageId, payloadSha256, processedAt]); } catch (error) { if (postgresCode(error) !== "23505") throw error; const prior = await client.query<{ payload_sha256: string }>("SELECT payload_sha256 FROM orchestration.inbox WHERE tenant_id=$1 AND message_id=$2", [this.tenantId, messageId]); if (prior.rows[0]?.payload_sha256 !== payloadSha256) throw new OrchestrationError("CONFLICT", "inbox message id was reused with a different payload"); } }); }
  async putDeadLetter(value: DeadLetter): Promise<void> { if (value.envelope.tenantId !== this.tenantId) throw new OrchestrationError("AUTHORIZATION_FAILED", "cross-tenant dead-letter persistence is forbidden"); await this.#tenant(async (client) => { await client.query("INSERT INTO orchestration.dead_letters (id,tenant_id,envelope,reason_code,replay_count,quarantined_at,replayed_at) VALUES ($1,$2,$3::jsonb,$4,$5,$6::timestamptz,$7::timestamptz) ON CONFLICT (id) DO UPDATE SET replay_count=EXCLUDED.replay_count,replayed_at=EXCLUDED.replayed_at", [value.id, this.tenantId, JSON.stringify(value.envelope), value.reasonCode, value.replayCount, value.quarantinedAt, value.replayedAt ?? null]); }); }
  async getDeadLetter(id: string): Promise<DeadLetter | undefined> { return this.#tenant(async (client) => { const result = await client.query<DeadLetterSqlRow>("SELECT id,envelope,reason_code,replay_count,quarantined_at,replayed_at FROM orchestration.dead_letters WHERE tenant_id=$1 AND id=$2", [this.tenantId, id]); const row = result.rows[0]; if (row === undefined) return undefined; return { id, envelope: parseEnvelope(row.envelope), reasonCode: String(row.reason_code), replayCount: Number(row.replay_count), quarantinedAt: iso(row.quarantined_at), ...(row.replayed_at == null ? {} : { replayedAt: iso(row.replayed_at) }) }; }); }
  async #tenant<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> { return this.sql.transaction(async (client) => { await client.query("SELECT set_config('app.tenant_id',$1,true)", [this.tenantId]); return operation(client); }); }
}

function outboxRecord(row: OutboxSqlRow): OutboxRecord { return { envelope: parseEnvelope(row.envelope), state: row.state, attempt: Number(row.attempt), nextAttemptAt: iso(row.next_attempt_at), ...(row.receipt_sha256 == null ? {} : { receiptSha256: String(row.receipt_sha256) }), ...(row.reason_code == null ? {} : { reasonCode: String(row.reason_code) }), ...(row.lease_owner == null ? {} : { leaseToken: String(row.lease_owner) }) }; }
function parseEnvelope(value: unknown): DurableEnvelope { const parsed = typeof value === "string" ? JSON.parse(value) as DurableEnvelope : value as DurableEnvelope; if (parsed === null || typeof parsed !== "object" || typeof parsed.tenantId !== "string" || typeof parsed.id !== "string") throw new OrchestrationError("DEPENDENCY_FAILED", "stored outbox envelope is invalid"); return structuredClone(parsed); }
function iso(value: string | Date): string { const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString(); if (!strictUtc(result)) throw new OrchestrationError("DEPENDENCY_FAILED", "stored orchestration timestamp is invalid"); return result; }

export interface CurrentReplayGuard {
  authorize(envelope: DurableEnvelope): Promise<{ allowed: boolean; reasonCode?: string }>;
}

export class ScopedRateLimiter {
  readonly #events = new Map<string, number[]>();
  constructor(readonly limits: Readonly<{ tenant: number; partner: number; provider: number }>, readonly windowMs = 60_000) {}
  acquire(envelope: DurableEnvelope, now: number): boolean {
    const keys = [`tenant:${envelope.tenantId}`, ...(envelope.partnerId === undefined ? [] : [`partner:${envelope.partnerId}`]), ...(envelope.providerId === undefined ? [] : [`provider:${envelope.providerId}`])];
    const allowed = keys.every((key) => {
      const limit = key.startsWith("tenant:") ? this.limits.tenant : key.startsWith("partner:") ? this.limits.partner : this.limits.provider;
      return (this.#events.get(key) ?? []).filter((time) => time > now - this.windowMs).length < limit;
    });
    if (!allowed) return false;
    for (const key of keys) this.#events.set(key, [...(this.#events.get(key) ?? []).filter((time) => time > now - this.windowMs), now]);
    return true;
  }
}

export class OutboxInboxRuntime {
  constructor(readonly store: MessageJournalStore, readonly limiter: ScopedRateLimiter, readonly now: () => Date = () => new Date()) {}

  async enqueue(input: Omit<DurableEnvelope, "id" | "requestSha256" | "createdAt"> & { readonly request: unknown }): Promise<OutboxRecord> {
    if (!digest(input.payloadSha256) || !digest(input.consentArtifactSha256) || input.resourceRevision < 0 || input.idempotencyKey.length < 8) throw new OrchestrationError("VALIDATION_FAILED", "outbox intent is invalid");
    const requestSha256 = hash(stableJson(input.request));
    const prior = await this.store.findOutboxByIdempotency(input.tenantId, input.idempotencyKey);
    if (prior !== undefined) {
      if (prior.envelope.requestSha256 !== requestSha256) throw new OrchestrationError("CONFLICT", "outbox idempotency key was reused");
      return prior;
    }
    const createdAt = this.now().toISOString();
    const envelope: DurableEnvelope = Object.freeze({ id: hash(`${input.tenantId}:${input.idempotencyKey}`), tenantId: input.tenantId, kind: input.kind, idempotencyKey: input.idempotencyKey, requestSha256, payloadSha256: input.payloadSha256, consentArtifactSha256: input.consentArtifactSha256, resourceRevision: input.resourceRevision, ...(input.partnerId === undefined ? {} : { partnerId: input.partnerId }), ...(input.providerId === undefined ? {} : { providerId: input.providerId }), createdAt });
    const record: OutboxRecord = Object.freeze({ envelope, state: "pending", attempt: 0, nextAttemptAt: createdAt });
    await this.store.putOutbox(record);
    return record;
  }

  async relay(deliver: (envelope: DurableEnvelope) => Promise<{ delivered: boolean; retryable: boolean; receiptSha256?: string; reasonCode?: string }>, limit = 100): Promise<readonly OutboxRecord[]> {
    const results: OutboxRecord[] = [];
    const now = this.now();
    const claimed = this.store.claimDue === undefined
      ? await this.store.listDue(now.toISOString(), limit)
      : await this.store.claimDue(now.toISOString(), limit, new Date(now.getTime() + 60_000).toISOString());
    for (const record of claimed) {
      if (!this.limiter.acquire(record.envelope, this.now().getTime())) continue;
      const delivering: OutboxRecord = this.store.claimDue === undefined
        ? Object.freeze({ ...record, state: "delivering", attempt: record.attempt + 1 })
        : record;
      if (this.store.claimDue === undefined) await this.store.putOutbox(delivering);
      let response: { delivered: boolean; retryable: boolean; receiptSha256?: string; reasonCode?: string };
      try { response = await deliver(delivering.envelope); } catch { response = { delivered: false, retryable: true, reasonCode: "DELIVERY_EXCEPTION" }; }
      let next: OutboxRecord;
      if (response.delivered && digest(response.receiptSha256)) {
        next = Object.freeze({ ...delivering, state: "delivered", receiptSha256: response.receiptSha256 });
      } else if (response.retryable && delivering.attempt < 5) {
        next = Object.freeze({ ...delivering, state: "pending", nextAttemptAt: new Date(this.now().getTime() + 1_000 * 2 ** (delivering.attempt - 1)).toISOString(), reasonCode: response.reasonCode ?? "TRANSIENT_DELIVERY_FAILURE" });
      } else {
        const reasonCode = response.delivered ? "INVALID_DELIVERY_RECEIPT" : response.reasonCode ?? "PERMANENT_DELIVERY_FAILURE";
        next = Object.freeze({ ...delivering, state: "dead_letter", reasonCode });
        await this.store.putDeadLetter({ id: delivering.envelope.id, envelope: delivering.envelope, reasonCode, replayCount: 0, quarantinedAt: this.now().toISOString() });
      }
      if (this.store.settleClaim !== undefined && delivering.leaseToken !== undefined) await this.store.settleClaim(delivering, next);
      else await this.store.putOutbox(next);
      results.push(next);
    }
    return Object.freeze(results);
  }

  async consume(envelope: DurableEnvelope, guard: CurrentReplayGuard, handler: (envelope: DurableEnvelope) => Promise<{ succeeded: boolean; retryable: boolean; reasonCode?: string }>): Promise<"PROCESSED" | "DUPLICATE" | "DEAD_LETTER"> {
    const prior = await this.store.inboxPayload(envelope.tenantId, envelope.id);
    if (prior !== undefined) {
      if (prior !== envelope.payloadSha256) throw new OrchestrationError("CONFLICT", "inbox message id was reused with a different payload");
      return "DUPLICATE";
    }
    const authorization = await guard.authorize(envelope);
    if (!authorization.allowed) {
      await this.#deadLetter(envelope, authorization.reasonCode ?? "CURRENT_STATE_DENIED");
      return "DEAD_LETTER";
    }
    const result = await handler(envelope);
    if (result.succeeded) {
      await this.store.markInbox(envelope.tenantId, envelope.id, envelope.payloadSha256, this.now().toISOString());
      return "PROCESSED";
    }
    await this.#deadLetter(envelope, result.reasonCode ?? (result.retryable ? "RETRY_EXHAUSTED" : "PERMANENT_HANDLER_FAILURE"));
    return "DEAD_LETTER";
  }

  async replay(input: { readonly deadLetterId: string; readonly actorId: string; readonly actorRoles: readonly string[]; readonly ticketId: string; readonly stepUpArtifactSha256: string }, guard: CurrentReplayGuard): Promise<OutboxRecord> {
    if (!input.actorRoles.includes("workflow_replay_operator") || input.ticketId.trim() === "" || !digest(input.stepUpArtifactSha256)) throw new OrchestrationError("AUTHORIZATION_FAILED", "dead-letter replay requires operator role, ticket, and step-up evidence");
    const dead = await this.store.getDeadLetter(input.deadLetterId);
    if (dead === undefined) throw new OrchestrationError("CONFLICT", "dead letter does not exist");
    const decision = await guard.authorize(dead.envelope);
    if (!decision.allowed) throw new OrchestrationError("AUTHORIZATION_FAILED", `dead-letter replay denied by current state: ${decision.reasonCode ?? "UNKNOWN"}`);
    const replayedEnvelope = Object.freeze({ ...dead.envelope, idempotencyKey: `${dead.envelope.idempotencyKey}:replay:${dead.replayCount + 1}` });
    const record: OutboxRecord = Object.freeze({ envelope: replayedEnvelope, state: "pending", attempt: 0, nextAttemptAt: this.now().toISOString(), reasonCode: `MANUAL_REPLAY:${input.ticketId}:${input.actorId}` });
    await this.store.putOutbox(record);
    await this.store.putDeadLetter({ ...dead, replayCount: dead.replayCount + 1, replayedAt: this.now().toISOString() });
    return record;
  }

  async #deadLetter(envelope: DurableEnvelope, reasonCode: string): Promise<void> {
    await this.store.putDeadLetter({ id: envelope.id, envelope, reasonCode, replayCount: 0, quarantinedAt: this.now().toISOString() });
  }
}

export class DurableScheduler {
  readonly #jobs = new Map<string, { id: string; tenantId: string; kind: string; payloadSha256: string; dueAt: string; intervalMs?: number; lastEnqueuedAt?: string }>();
  register(job: { readonly id: string; readonly tenantId: string; readonly kind: string; readonly payloadSha256: string; readonly dueAt: string; readonly intervalMs?: number }): void {
    if (this.#jobs.has(job.id) || !digest(job.payloadSha256) || !strictUtc(job.dueAt) || (job.intervalMs !== undefined && (!Number.isSafeInteger(job.intervalMs) || job.intervalMs < 1_000))) throw new OrchestrationError("VALIDATION_FAILED", "scheduler job is invalid or duplicated");
    this.#jobs.set(job.id, structuredClone(job));
  }
  due(now: Date): readonly Readonly<{ jobId: string; tenantId: string; kind: string; payloadSha256: string; occurrence: string }>[] {
    const occurrences: Array<{ jobId: string; tenantId: string; kind: string; payloadSha256: string; occurrence: string }> = [];
    for (const job of this.#jobs.values()) {
      if (Date.parse(job.dueAt) <= now.getTime() && job.lastEnqueuedAt !== job.dueAt) {
        occurrences.push({ jobId: job.id, tenantId: job.tenantId, kind: job.kind, payloadSha256: job.payloadSha256, occurrence: job.dueAt });
        job.lastEnqueuedAt = job.dueAt;
        if (job.intervalMs !== undefined) job.dueAt = new Date(Date.parse(job.dueAt) + job.intervalMs).toISOString();
      }
    }
    return Object.freeze(occurrences);
  }
}

const activity = (id: string, compensationId: string): WorkflowDefinition["activities"][number] => ({ id, timeoutMs: 60_000, heartbeatMs: 10_000, maxAttempts: 3, initialBackoffMs: 1_000, compensationId, nonRetryableErrorCodes: ["AUTHORIZATION_DENIED", "CONSENT_REVOKED", "POLICY_DENIED", "MALFORMED_INPUT"] });
export const COMMERCIAL_SAGA_DEFINITIONS: readonly WorkflowDefinition[] = Object.freeze([
  { id: "payment-saga", version: 1, activities: [activity("persist-payment-intent", "void-payment-intent"), activity("authorize-payment", "void-authorization"), activity("grant-entitlement", "revoke-entitlement")] },
  { id: "credit-saga", version: 1, activities: [activity("reserve-credit", "release-credit"), activity("commit-credit", "restore-credit-if-not-refunded")] },
  { id: "order-saga", version: 1, activities: [activity("price-order", "void-price"), activity("reserve-inventory", "release-inventory"), activity("confirm-order", "cancel-order")] },
  { id: "generation-saga", version: 1, activities: [activity("persist-generation-intent", "void-generation-intent"), activity("invoke-provider", "delete-provider-asset"), activity("publish-derived-asset", "revoke-derived-asset")] },
  { id: "deletion-saga", version: 1, activities: [activity("revoke-access", "noop-never-restore-revoked-consent"), activity("delete-primary", "noop-deletion-is-irreversible"), activity("delete-downstream", "retry-downstream-deletion")] },
  { id: "print-saga", version: 1, activities: [activity("persist-print-intent", "void-print-intent"), activity("submit-printer", "cancel-printer-job"), activity("confirm-fulfillment", "open-fulfillment-case")] },
  { id: "settlement-saga", version: 1, activities: [activity("snapshot-ledger", "void-settlement-snapshot"), activity("submit-payout", "reverse-payout-if-provider-allows"), activity("reconcile-payout", "open-finance-case")] },
]);

export interface WorkflowHistoryEvent {
  readonly sequence: number;
  readonly workflowId: string;
  readonly definitionVersion: number;
  readonly codeVersion: string;
  readonly traceId: string;
  readonly occurredAt: string;
  readonly type: string;
  readonly stateSha256: string;
  readonly previousEventSha256: string;
  readonly eventSha256: string;
}

export class WorkflowHistoryLedger {
  readonly #events = new Map<string, WorkflowHistoryEvent[]>();
  readonly #supportedVersions = new Map<string, Set<number>>();
  support(definitionId: string, versions: readonly number[]): void { this.#supportedVersions.set(definitionId, new Set(versions)); }
  assertCompatible(instance: WorkflowInstance): void {
    if (!this.#supportedVersions.get(instance.definitionId)?.has(instance.definitionVersion)) throw new OrchestrationError("CONFLICT", "in-flight workflow definition version is not supported by this worker");
  }
  append(instance: WorkflowInstance, type: string): WorkflowHistoryEvent {
    this.assertCompatible(instance);
    const events = this.#events.get(instance.id) ?? [];
    const unsigned = { sequence: events.length + 1, workflowId: instance.id, definitionVersion: instance.definitionVersion, codeVersion: instance.codeVersion, traceId: instance.traceId, occurredAt: instance.updatedAt, type, stateSha256: workflowStateSha256(instance), previousEventSha256: events.at(-1)?.eventSha256 ?? "0".repeat(64) };
    const event = Object.freeze({ ...unsigned, eventSha256: hash(stableJson(unsigned)) });
    events.push(event);
    this.#events.set(instance.id, events);
    return event;
  }
  history(workflowId: string): readonly WorkflowHistoryEvent[] { return Object.freeze(structuredClone(this.#events.get(workflowId) ?? [])); }
  compact(workflowId: string, throughSequence: number): Readonly<{ checkpointSha256: string; retained: number }> {
    const events = this.#events.get(workflowId) ?? [];
    if (throughSequence < 1 || throughSequence >= events.length) throw new OrchestrationError("VALIDATION_FAILED", "history compaction must retain at least one event");
    const removed = events.slice(0, throughSequence);
    const retained = events.slice(throughSequence);
    const checkpointSha256 = hash(stableJson(removed));
    const checkpoint: WorkflowHistoryEvent = Object.freeze({ ...retained[0] as WorkflowHistoryEvent, sequence: 1, type: `history-checkpoint:${checkpointSha256}`, previousEventSha256: "0".repeat(64), eventSha256: hash(`${checkpointSha256}:${(retained[0] as WorkflowHistoryEvent).eventSha256}`) });
    this.#events.set(workflowId, [checkpoint, ...retained.slice(1).map((event, index) => Object.freeze({ ...event, sequence: index + 2 }))]);
    return Object.freeze({ checkpointSha256, retained: retained.length });
  }
  visualize(instance: WorkflowInstance): Readonly<{ nodes: readonly Readonly<{ id: string; state: string; attempts: number }>[]; traceId: string; state: string }> { return Object.freeze({ nodes: Object.freeze(instance.activities.map((item) => Object.freeze({ id: item.id, state: item.state, attempts: item.attempts }))), traceId: instance.traceId, state: instance.state }); }
}

/** PostgreSQL history ledger; event sequence and hash chaining are protected
 * by a per-workflow advisory lock so two workers cannot fork a history. */
export class PostgresWorkflowHistoryLedger {
  constructor(readonly sql: SqlTransactionExecutor, readonly tenantId: string) {
    if (tenantId.trim() === "") throw new OrchestrationError("VALIDATION_FAILED", "history tenant is required");
  }
  async support(_definitionId: string, _versions: readonly number[]): Promise<void> { return undefined; }
  async append(instance: WorkflowInstance, type: string): Promise<WorkflowHistoryEvent> {
    if (instance.tenantId !== this.tenantId || type.trim() === "") throw new OrchestrationError("AUTHORIZATION_FAILED", "history event tenant or type is invalid");
    return this.#tenant(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 3))", [instance.id]);
      const prior = await client.query<{ sequence: number | string; event_sha256: string }>("SELECT sequence,event_sha256 FROM orchestration.workflow_history WHERE tenant_id=$1 AND workflow_id=$2 ORDER BY sequence DESC LIMIT 1", [this.tenantId, instance.id]);
      const sequence = Number(prior.rows[0]?.sequence ?? 0) + 1;
      const unsigned = { sequence, workflowId: instance.id, definitionVersion: instance.definitionVersion, codeVersion: instance.codeVersion, traceId: instance.traceId, occurredAt: instance.updatedAt, type, stateSha256: workflowStateSha256(instance), previousEventSha256: prior.rows[0]?.event_sha256 ?? "0".repeat(64) };
      const event = Object.freeze({ ...unsigned, eventSha256: hash(stableJson(unsigned)) });
      await client.query("INSERT INTO orchestration.workflow_history (workflow_id,sequence,tenant_id,event,event_sha256) VALUES ($1,$2,$3,$4::jsonb,$5)", [instance.id, sequence, this.tenantId, JSON.stringify(event), event.eventSha256]);
      return event;
    });
  }
  async history(workflowId: string): Promise<readonly WorkflowHistoryEvent[]> { return this.#tenant(async (client) => { const result = await client.query<{ event: unknown }>("SELECT event FROM orchestration.workflow_history WHERE tenant_id=$1 AND workflow_id=$2 ORDER BY sequence", [this.tenantId, workflowId]); return Object.freeze(result.rows.map((row) => typeof row.event === "string" ? JSON.parse(row.event) as WorkflowHistoryEvent : structuredClone(row.event as WorkflowHistoryEvent))); }); }
  async #tenant<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> { return this.sql.transaction(async (client) => { await client.query("SELECT set_config('app.tenant_id',$1,true)", [this.tenantId]); return operation(client); }); }
}

export class PostgresDurableScheduler {
  constructor(readonly sql: SqlTransactionExecutor, readonly tenantId: string) {
    if (tenantId.trim() === "") throw new OrchestrationError("VALIDATION_FAILED", "scheduler tenant is required");
  }
  async register(job: { readonly id: string; readonly tenantId: string; readonly kind: string; readonly payloadSha256: string; readonly dueAt: string; readonly intervalMs?: number }): Promise<void> {
    if (job.tenantId !== this.tenantId || !digest(job.payloadSha256) || !strictUtc(job.dueAt) || (job.intervalMs !== undefined && (!Number.isSafeInteger(job.intervalMs) || job.intervalMs < 1_000))) throw new OrchestrationError("VALIDATION_FAILED", "scheduler job is invalid");
    await this.#tenant(async (client) => { await client.query("INSERT INTO orchestration.scheduler_jobs (id,tenant_id,kind,payload_sha256,due_at,interval_ms) VALUES ($1,$2,$3,$4,$5::timestamptz,$6)", [job.id, this.tenantId, job.kind, job.payloadSha256, job.dueAt, job.intervalMs ?? null]); });
  }
  async due(now: Date, limit = 100): Promise<readonly Readonly<{ jobId: string; tenantId: string; kind: string; payloadSha256: string; occurrence: string }>[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new OrchestrationError("VALIDATION_FAILED", "scheduler claim limit is invalid");
    const nowIso = now.toISOString();
    return this.#tenant(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4))", [this.tenantId]);
      const result = await client.query<{ id: string; tenant_id: string; kind: string; payload_sha256: string; due_at: string | Date; interval_ms: number | string | null }>("SELECT id,tenant_id,kind,payload_sha256,due_at,interval_ms FROM orchestration.scheduler_jobs WHERE tenant_id=$1 AND due_at <= $2::timestamptz AND (last_enqueued_at IS NULL OR last_enqueued_at < due_at) ORDER BY due_at,id FOR UPDATE SKIP LOCKED LIMIT $3", [this.tenantId, nowIso, limit]);
      const occurrences: Array<{ jobId: string; tenantId: string; kind: string; payloadSha256: string; occurrence: string }> = [];
      for (const row of result.rows) {
        const occurrence = row.due_at instanceof Date ? row.due_at.toISOString() : new Date(row.due_at).toISOString();
        occurrences.push({ jobId: row.id, tenantId: row.tenant_id, kind: row.kind, payloadSha256: row.payload_sha256, occurrence });
        if (row.interval_ms === null) await client.query("UPDATE orchestration.scheduler_jobs SET last_enqueued_at=$2::timestamptz WHERE tenant_id=$1 AND id=$3", [this.tenantId, occurrence, row.id]);
        else await client.query("UPDATE orchestration.scheduler_jobs SET last_enqueued_at=$2::timestamptz,due_at=$3::timestamptz WHERE tenant_id=$1 AND id=$4", [this.tenantId, occurrence, new Date(Date.parse(occurrence) + Number(row.interval_ms)).toISOString(), row.id]);
      }
      return Object.freeze(occurrences);
    });
  }
  async #tenant<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> { return this.sql.transaction(async (client) => { await client.query("SELECT set_config('app.tenant_id',$1,true)", [this.tenantId]); return operation(client); }); }
}

export class VirtualClock {
  #epochMs: number;
  constructor(start: string) { if (!strictUtc(start)) throw new OrchestrationError("VALIDATION_FAILED", "virtual clock requires strict UTC"); this.#epochMs = Date.parse(start); }
  now = (): Date => new Date(this.#epochMs);
  advance(milliseconds: number): Date { if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new OrchestrationError("VALIDATION_FAILED", "virtual time can only advance by a non-negative integer"); this.#epochMs += milliseconds; return this.now(); }
}

function parseInstance(value: WorkflowInstance | string | undefined): WorkflowInstance | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "string" ? JSON.parse(value) as WorkflowInstance : value;
  return structuredClone(parsed);
}
function postgresCode(value: unknown): string | undefined { return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string" ? value.code : undefined; }
function clone<T>(value: T | undefined): T | undefined { return value === undefined ? undefined : structuredClone(value); }
function digest(value: string | undefined): value is string { return value !== undefined && /^[a-f0-9]{64}$/u.test(value); }
function strictUtc(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && new Date(value).toISOString() === value; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`; return JSON.stringify(value) ?? "null"; }
