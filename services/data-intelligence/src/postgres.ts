import type { Pool, PoolClient, QueryResultRow } from "pg";
import { clone, DataIntelligenceError, fingerprint, strictUtc } from "./common.js";
import type { QueuedTrackingEvent, TrackingQueueRepository } from "./events.js";
import type { WarehouseSnapshot, WarehouseStateRepository } from "./warehouse.js";

type Row = QueryResultRow & Record<string, unknown>;

/** PostgreSQL-backed tracking outbox with SKIP LOCKED leases for multi-worker delivery. */
export class PostgresTrackingQueueRepository implements TrackingQueueRepository {
  readonly durable = true;

  constructor(readonly pool: Pool) {}

  async enqueue(event: QueuedTrackingEvent): Promise<"ENQUEUED" | "DUPLICATE" | "CONFLICT"> {
    return this.#tenant(event.tenantId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO ltm.data_tracking_queue
           (tenant_id,event_id,payload_sha256,envelope,state,attempts,next_attempt_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4::jsonb,'PENDING',0,$5::timestamptz,clock_timestamp(),clock_timestamp())
         ON CONFLICT (tenant_id,event_id) DO NOTHING`,
        [event.tenantId, event.eventId, event.payloadSha256, JSON.stringify(event.envelope), event.nextAttemptAt],
      );
      if (inserted.rowCount === 1) return "ENQUEUED";
      const prior = await client.query<Row>(
        "SELECT payload_sha256 FROM ltm.data_tracking_queue WHERE tenant_id=$1 AND event_id=$2",
        [event.tenantId, event.eventId],
      );
      return prior.rows[0]?.payload_sha256 === event.payloadSha256 ? "DUPLICATE" : "CONFLICT";
    });
  }

  async claimDue(input: { readonly tenantId: string; readonly workerId: string; readonly now: string; readonly leaseUntil: string; readonly limit: number; readonly eventId?: string }): Promise<readonly QueuedTrackingEvent[]> {
    strictUtc(input.now, "claim now"); strictUtc(input.leaseUntil, "claim leaseUntil");
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) throw new DataIntelligenceError("VALIDATION_FAILED", "tracking claim limit is invalid");
    return this.#tenant(input.tenantId, async (client) => {
      const result = await client.query<Row>(
        `WITH due AS (
           SELECT tenant_id,event_id
             FROM ltm.data_tracking_queue
            WHERE tenant_id=$1
              AND state IN ('PENDING','IN_FLIGHT')
              AND next_attempt_at <= $3::timestamptz
              AND (state='PENDING' OR lease_until <= $3::timestamptz)
              AND ($5::text IS NULL OR event_id=$5)
            ORDER BY next_attempt_at,event_id
            FOR UPDATE SKIP LOCKED
            LIMIT $4
         )
         UPDATE ltm.data_tracking_queue queue
            SET state='IN_FLIGHT', attempts=queue.attempts+1, lease_owner=$2,
                lease_until=$6::timestamptz, updated_at=clock_timestamp()
           FROM due
          WHERE queue.tenant_id=due.tenant_id AND queue.event_id=due.event_id
         RETURNING queue.*`,
        [input.tenantId, input.workerId, input.now, input.limit, input.eventId ?? null, input.leaseUntil],
      );
      return Object.freeze(result.rows.map((row) => trackingRow(row, input.tenantId)));
    });
  }

  async markDelivered(input: { readonly tenantId: string; readonly eventId: string; readonly payloadSha256: string; readonly workerId: string }): Promise<void> {
    await this.#transition(input, "DELIVERED", undefined, undefined);
  }

  async scheduleRetry(input: { readonly tenantId: string; readonly eventId: string; readonly payloadSha256: string; readonly workerId: string; readonly nextAttemptAt: string; readonly reason: string; readonly deadLettered: boolean }): Promise<void> {
    strictUtc(input.nextAttemptAt, "retry nextAttemptAt");
    await this.#transition(input, input.deadLettered ? "DEAD_LETTERED" : "PENDING", input.nextAttemptAt, input.reason.slice(0, 512));
  }

  async #transition(
    input: { readonly tenantId: string; readonly eventId: string; readonly payloadSha256: string; readonly workerId: string },
    state: "PENDING" | "DELIVERED" | "DEAD_LETTERED",
    nextAttemptAt: string | undefined,
    reason: string | undefined,
  ): Promise<void> {
    await this.#tenant(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE ltm.data_tracking_queue
            SET state=$5, next_attempt_at=COALESCE($6::timestamptz,next_attempt_at),
                last_error=$7, lease_owner=NULL, lease_until=NULL, updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND event_id=$2 AND payload_sha256=$3
            AND state='IN_FLIGHT' AND lease_owner=$4`,
        [input.tenantId, input.eventId, input.payloadSha256, input.workerId, state, nextAttemptAt ?? null, reason ?? null],
      );
      if (result.rowCount !== 1) throw new DataIntelligenceError("CONFLICT", "tracking delivery lease or payload binding changed");
    });
  }

  async #tenant<T>(tenantId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let began = false;
    try {
      await client.query("BEGIN"); began = true;
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const result = await operation(client);
      await client.query("COMMIT"); began = false;
      return result;
    } catch (error) {
      if (began) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

/** Tenant-bound CAS repository for warehouse checkpoints and their complete lineage snapshot. */
export class PostgresWarehouseStateRepository implements WarehouseStateRepository {
  constructor(readonly pool: Pool, readonly tenantId: string, readonly stateKey = "primary") {}

  async load(): Promise<WarehouseSnapshot | undefined> {
    return this.#tenant(async (client) => {
      const result = await client.query<Row>(
        "SELECT snapshot,state_sha256 FROM ltm.data_warehouse_state WHERE tenant_id=$1 AND state_key=$2",
        [this.tenantId, this.stateKey],
      );
      const row = result.rows[0]; if (row === undefined) return undefined;
      const snapshot = row.snapshot as WarehouseSnapshot;
      if (fingerprint(snapshot) !== row.state_sha256) throw new DataIntelligenceError("CONFLICT", "persisted warehouse state digest is invalid");
      return clone(snapshot);
    });
  }

  async compareAndSwap(expectedStateFingerprint: string | undefined, next: WarehouseSnapshot): Promise<void> {
    const nextFingerprint = fingerprint(next);
    await this.#tenant(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`warehouse:${this.tenantId}:${this.stateKey}`]);
      const current = await client.query<Row>(
        "SELECT state_sha256 FROM ltm.data_warehouse_state WHERE tenant_id=$1 AND state_key=$2 FOR UPDATE",
        [this.tenantId, this.stateKey],
      );
      const actual = current.rows[0]?.state_sha256;
      if (actual !== expectedStateFingerprint) throw new DataIntelligenceError("CONFLICT", "warehouse state changed since it was loaded");
      await client.query(
        `INSERT INTO ltm.data_warehouse_state(tenant_id,state_key,state_sha256,snapshot,version,updated_at)
         VALUES ($1,$2,$3,$4::jsonb,1,clock_timestamp())
         ON CONFLICT (tenant_id,state_key) DO UPDATE
           SET state_sha256=EXCLUDED.state_sha256,snapshot=EXCLUDED.snapshot,
               version=ltm.data_warehouse_state.version+1,updated_at=clock_timestamp()`,
        [this.tenantId, this.stateKey, nextFingerprint, JSON.stringify(next)],
      );
    });
  }

  async #tenant<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let began = false;
    try {
      await client.query("BEGIN"); began = true;
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [this.tenantId]);
      const result = await operation(client);
      await client.query("COMMIT"); began = false;
      return result;
    } catch (error) {
      if (began) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

function trackingRow(row: Row, tenantId: string): QueuedTrackingEvent {
  if (row.tenant_id !== tenantId || typeof row.event_id !== "string" || typeof row.payload_sha256 !== "string" ||
      typeof row.state !== "string" || (typeof row.attempts !== "number" && typeof row.attempts !== "string") ||
      !(typeof row.next_attempt_at === "string" || row.next_attempt_at instanceof Date)) {
    throw new DataIntelligenceError("CONFLICT", "persisted tracking event has an invalid database shape");
  }
  const envelope = row.envelope as TrackingEnvelopeCandidate;
  if (envelope?.context?.tenantId !== tenantId || envelope.eventId !== row.event_id) throw new DataIntelligenceError("CONFLICT", "persisted tracking event crossed its tenant or event binding");
  return Object.freeze({
    tenantId, eventId: row.event_id, payloadSha256: row.payload_sha256,
    envelope: clone(envelope as QueuedTrackingEvent["envelope"]),
    state: row.state as QueuedTrackingEvent["state"], attempts: Number(row.attempts),
    nextAttemptAt: strictUtc(dateString(row.next_attempt_at), "persisted nextAttemptAt"),
    ...(typeof row.lease_owner === "string" ? { leaseOwner: row.lease_owner } : {}),
    ...(typeof row.lease_until === "string" || row.lease_until instanceof Date ? { leaseUntil: strictUtc(dateString(row.lease_until), "persisted leaseUntil") } : {}),
    ...(typeof row.last_error === "string" ? { lastError: row.last_error } : {}),
  });
}

function dateString(value: string | Date): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }

interface TrackingEnvelopeCandidate { readonly eventId?: unknown; readonly context?: { readonly tenantId?: unknown }; }
