import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CommercialOperationsError,
  canonicalJson,
  freeze,
  identifier,
  sha256,
  type JsonObject,
  type JsonValue,
} from "./common.js";

const SCHEMA_VERSION = "1";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS commercial_schema_metadata(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS commercial_aggregates(
  tenant_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, aggregate_type, aggregate_id)
) STRICT;
CREATE TABLE IF NOT EXISTS commercial_events(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version > 0),
  event_type TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK(json_valid(event_json)),
  occurred_at TEXT NOT NULL,
  UNIQUE(tenant_id, event_id),
  UNIQUE(tenant_id, aggregate_type, aggregate_id, aggregate_version)
) STRICT;
CREATE TABLE IF NOT EXISTS commercial_idempotency(
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, idempotency_key)
) STRICT;
CREATE TABLE IF NOT EXISTS commercial_external_facts(
  tenant_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  fact_sha256 TEXT NOT NULL CHECK(length(fact_sha256)=64),
  provider TEXT NOT NULL,
  fact_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, fact_id),
  UNIQUE(tenant_id, provider, fact_kind, subject_id, sequence)
) STRICT;
CREATE TRIGGER IF NOT EXISTS commercial_events_no_update
BEFORE UPDATE ON commercial_events BEGIN SELECT RAISE(ABORT, 'commercial events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS commercial_events_no_delete
BEFORE DELETE ON commercial_events BEGIN SELECT RAISE(ABORT, 'commercial events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS commercial_facts_no_update
BEFORE UPDATE ON commercial_external_facts BEGIN SELECT RAISE(ABORT, 'commercial facts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS commercial_facts_no_delete
BEFORE DELETE ON commercial_external_facts BEGIN SELECT RAISE(ABORT, 'commercial facts are append-only'); END;
`;

export interface AggregateSnapshot<T extends JsonObject = JsonObject> {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly version: number;
  readonly state: Readonly<T>;
  readonly updatedAt: string;
}

export interface CommercialDomainEvent {
  readonly sequence: number;
  readonly eventId: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly payload: Readonly<JsonObject>;
  readonly occurredAt: string;
}

export interface CommandResult<T extends JsonValue> {
  readonly value: T;
  readonly replayed: boolean;
}

export interface CommercialOperationsRepository {
  execute<T extends JsonValue>(input: {
    readonly tenantId: string;
    readonly idempotencyKey: string;
    readonly operation: string;
    readonly request: JsonObject;
    readonly run: () => T;
  }): CommandResult<T>;
  get<T extends JsonObject>(tenantId: string, aggregateType: string, aggregateId: string): AggregateSnapshot<T> | undefined;
  put<T extends JsonObject>(input: {
    readonly tenantId: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly expectedVersion: number | null;
    readonly state: T;
    readonly eventType: string;
    readonly event: JsonObject;
  }): AggregateSnapshot<T>;
  claimExternalFact(input: {
    readonly tenantId: string;
    readonly factId: string;
    readonly factSha256: string;
    readonly provider: string;
    readonly factKind: string;
    readonly subjectId: string;
    readonly sequence: number;
    readonly occurredAt: string;
  }): "claimed" | "replayed";
  listEvents(tenantId: string, aggregateType?: string, aggregateId?: string): readonly CommercialDomainEvent[];
  close(): void;
}

export class SqliteCommercialOperationsRepository implements CommercialOperationsRepository {
  readonly #database: DatabaseSync;
  readonly #clock: () => Date;
  #inTransaction = false;

  constructor(databasePath: string, clock: () => Date = () => new Date()) {
    if (databasePath !== ":memory:" && !isAbsolute(databasePath)) {
      throw new CommercialOperationsError("CONFIGURATION_INVALID", "commercial database path must be absolute");
    }
    this.#clock = clock;
    this.#database = new DatabaseSync(databasePath, { timeout: 5_000 });
    this.#database.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    this.#migrate();
  }

  execute<T extends JsonValue>(input: {
    readonly tenantId: string;
    readonly idempotencyKey: string;
    readonly operation: string;
    readonly request: JsonObject;
    readonly run: () => T;
  }): CommandResult<T> {
    const tenantId = identifier(input.tenantId, "tenantId");
    const key = identifier(input.idempotencyKey, "idempotencyKey", 256);
    const operation = identifier(input.operation, "operation", 160);
    const requestSha256 = sha256(canonicalJson(input.request));
    if (this.#inTransaction) throw new CommercialOperationsError("CONFLICT", "nested commercial transaction is forbidden");
    this.#database.exec("BEGIN IMMEDIATE");
    this.#inTransaction = true;
    try {
      const existing = this.#database.prepare(
        "SELECT operation,request_sha256,result_json FROM commercial_idempotency WHERE tenant_id=? AND idempotency_key=?",
      ).get(tenantId, key) as { operation: string; request_sha256: string; result_json: string } | undefined;
      if (existing !== undefined) {
        if (existing.operation !== operation || existing.request_sha256 !== requestSha256) {
          throw new CommercialOperationsError("IDEMPOTENCY_CONFLICT", "idempotency key was used for a different command");
        }
        this.#database.exec("COMMIT");
        return { value: freeze(JSON.parse(existing.result_json) as T) as T, replayed: true };
      }
      const value = freeze(input.run()) as T;
      const resultJson = canonicalJson(value);
      this.#database.prepare(
        `INSERT INTO commercial_idempotency(tenant_id,idempotency_key,operation,request_sha256,result_json,created_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(tenantId, key, operation, requestSha256, resultJson, this.#now());
      this.#database.exec("COMMIT");
      return { value, replayed: false };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    } finally {
      this.#inTransaction = false;
    }
  }

  get<T extends JsonObject>(tenantIdValue: string, aggregateTypeValue: string, aggregateIdValue: string): AggregateSnapshot<T> | undefined {
    const tenantId = identifier(tenantIdValue, "tenantId");
    const aggregateType = identifier(aggregateTypeValue, "aggregateType");
    const aggregateId = identifier(aggregateIdValue, "aggregateId");
    const row = this.#database.prepare(
      `SELECT version,state_json,updated_at FROM commercial_aggregates
       WHERE tenant_id=? AND aggregate_type=? AND aggregate_id=?`,
    ).get(tenantId, aggregateType, aggregateId) as { version: number; state_json: string; updated_at: string } | undefined;
    if (row === undefined) return undefined;
    return freeze({
      aggregateType,
      aggregateId,
      version: row.version,
      state: JSON.parse(row.state_json) as T,
      updatedAt: row.updated_at,
    });
  }

  put<T extends JsonObject>(input: {
    readonly tenantId: string;
    readonly aggregateType: string;
    readonly aggregateId: string;
    readonly expectedVersion: number | null;
    readonly state: T;
    readonly eventType: string;
    readonly event: JsonObject;
  }): AggregateSnapshot<T> {
    if (!this.#inTransaction) throw new CommercialOperationsError("CONFLICT", "aggregate writes require an atomic command");
    const tenantId = identifier(input.tenantId, "tenantId");
    const aggregateType = identifier(input.aggregateType, "aggregateType");
    const aggregateId = identifier(input.aggregateId, "aggregateId");
    const eventType = identifier(input.eventType, "eventType", 160);
    const current = this.get<T>(tenantId, aggregateType, aggregateId);
    if ((current?.version ?? null) !== input.expectedVersion) {
      throw new CommercialOperationsError("CONFLICT", "aggregate version changed", {
        expectedVersion: input.expectedVersion,
        currentVersion: current?.version ?? null,
      });
    }
    const version = (current?.version ?? 0) + 1;
    const now = this.#now();
    const stateJson = canonicalJson(input.state);
    if (current === undefined) {
      this.#database.prepare(
        `INSERT INTO commercial_aggregates(tenant_id,aggregate_type,aggregate_id,version,state_json,updated_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(tenantId, aggregateType, aggregateId, version, stateJson, now);
    } else {
      const result = this.#database.prepare(
        `UPDATE commercial_aggregates SET version=?,state_json=?,updated_at=?
         WHERE tenant_id=? AND aggregate_type=? AND aggregate_id=? AND version=?`,
      ).run(version, stateJson, now, tenantId, aggregateType, aggregateId, current.version);
      if (result.changes !== 1) throw new CommercialOperationsError("CONFLICT", "aggregate changed concurrently");
    }
    const eventId = sha256(`${tenantId}\n${aggregateType}\n${aggregateId}\n${version}\n${eventType}\n${canonicalJson(input.event)}`);
    this.#database.prepare(
      `INSERT INTO commercial_events(
        tenant_id,event_id,aggregate_type,aggregate_id,aggregate_version,event_type,event_json,occurred_at
      ) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(tenantId, eventId, aggregateType, aggregateId, version, eventType, canonicalJson(input.event), now);
    return freeze({ aggregateType, aggregateId, version, state: freeze(input.state), updatedAt: now });
  }

  claimExternalFact(input: {
    readonly tenantId: string;
    readonly factId: string;
    readonly factSha256: string;
    readonly provider: string;
    readonly factKind: string;
    readonly subjectId: string;
    readonly sequence: number;
    readonly occurredAt: string;
  }): "claimed" | "replayed" {
    if (!this.#inTransaction) throw new CommercialOperationsError("CONFLICT", "external fact claims require an atomic command");
    const existing = this.#database.prepare(
      "SELECT fact_sha256 FROM commercial_external_facts WHERE tenant_id=? AND fact_id=?",
    ).get(input.tenantId, input.factId) as { fact_sha256: string } | undefined;
    if (existing !== undefined) {
      if (existing.fact_sha256 !== input.factSha256) {
        throw new CommercialOperationsError("IDEMPOTENCY_CONFLICT", "external fact ID was reused with different signed content");
      }
      return "replayed";
    }
    try {
      this.#database.prepare(
        `INSERT INTO commercial_external_facts(
          tenant_id,fact_id,fact_sha256,provider,fact_kind,subject_id,sequence,occurred_at,recorded_at
        ) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        input.tenantId,
        input.factId,
        input.factSha256,
        input.provider,
        input.factKind,
        input.subjectId,
        input.sequence,
        input.occurredAt,
        this.#now(),
      );
      return "claimed";
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) {
        throw new CommercialOperationsError("CONFLICT", "external fact sequence is duplicated or out of order");
      }
      throw error;
    }
  }

  listEvents(tenantIdValue: string, aggregateTypeValue?: string, aggregateIdValue?: string): readonly CommercialDomainEvent[] {
    const tenantId = identifier(tenantIdValue, "tenantId");
    const clauses = ["tenant_id=?"];
    const values: string[] = [tenantId];
    if (aggregateTypeValue !== undefined) {
      clauses.push("aggregate_type=?");
      values.push(identifier(aggregateTypeValue, "aggregateType"));
    }
    if (aggregateIdValue !== undefined) {
      clauses.push("aggregate_id=?");
      values.push(identifier(aggregateIdValue, "aggregateId"));
    }
    const rows = this.#database.prepare(
      `SELECT sequence,event_id,aggregate_type,aggregate_id,aggregate_version,event_type,event_json,occurred_at
       FROM commercial_events WHERE ${clauses.join(" AND ")} ORDER BY sequence`,
    ).all(...values) as unknown as Array<{
      sequence: number; event_id: string; aggregate_type: string; aggregate_id: string;
      aggregate_version: number; event_type: string; event_json: string; occurred_at: string;
    }>;
    return freeze(rows.map((row) => ({
      sequence: row.sequence,
      eventId: row.event_id,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version,
      eventType: row.event_type,
      payload: JSON.parse(row.event_json) as JsonObject,
      occurredAt: row.occurred_at,
    })));
  }

  close(): void {
    this.#database.close();
  }

  #migrate(): void {
    this.#database.exec(SCHEMA);
    const checksum = sha256(SCHEMA);
    const metadata = this.#database.prepare(
      "SELECT key,value FROM commercial_schema_metadata WHERE key IN ('version','checksum')",
    ).all() as unknown as Array<{ key: string; value: string }>;
    if (metadata.length === 0) {
      this.#database.prepare("INSERT INTO commercial_schema_metadata(key,value) VALUES ('version',?),('checksum',?)")
        .run(SCHEMA_VERSION, checksum);
      return;
    }
    const values = new Map(metadata.map((entry) => [entry.key, entry.value]));
    if (values.get("version") !== SCHEMA_VERSION || values.get("checksum") !== checksum) {
      throw new CommercialOperationsError("CONFIGURATION_INVALID", "commercial database schema metadata does not match this binary");
    }
  }

  #now(): string {
    const value = this.#clock().toISOString();
    if (!value.endsWith("Z")) throw new CommercialOperationsError("CONFIGURATION_INVALID", "clock must return UTC time");
    return value;
  }
}
