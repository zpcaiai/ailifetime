import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EnterpriseControlError, canonicalJson, digest, freeze, identifier, type JsonObject, type JsonValue } from "./common.js";

const SCHEMA_VERSION = "1";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS enterprise_schema(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS enterprise_aggregates(tenant_id TEXT NOT NULL,aggregate_type TEXT NOT NULL,aggregate_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),state_json TEXT NOT NULL CHECK(json_valid(state_json)),updated_at TEXT NOT NULL,PRIMARY KEY(tenant_id,aggregate_type,aggregate_id)) STRICT;
CREATE TABLE IF NOT EXISTS enterprise_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,tenant_id TEXT NOT NULL,event_id TEXT NOT NULL,aggregate_type TEXT NOT NULL,aggregate_id TEXT NOT NULL,aggregate_version INTEGER NOT NULL,event_type TEXT NOT NULL,event_json TEXT NOT NULL CHECK(json_valid(event_json)),occurred_at TEXT NOT NULL,UNIQUE(tenant_id,event_id),UNIQUE(tenant_id,aggregate_type,aggregate_id,aggregate_version)) STRICT;
CREATE TABLE IF NOT EXISTS enterprise_idempotency(tenant_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,operation TEXT NOT NULL,request_sha256 TEXT NOT NULL,result_json TEXT NOT NULL CHECK(json_valid(result_json)),created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,idempotency_key)) STRICT;
CREATE TABLE IF NOT EXISTS enterprise_facts(tenant_id TEXT NOT NULL,fact_id TEXT NOT NULL,fact_sha256 TEXT NOT NULL,issuer TEXT NOT NULL,fact_kind TEXT NOT NULL,subject_id TEXT NOT NULL,sequence INTEGER NOT NULL,occurred_at TEXT NOT NULL,PRIMARY KEY(tenant_id,fact_id),UNIQUE(tenant_id,issuer,fact_kind,subject_id,sequence)) STRICT;
CREATE TRIGGER IF NOT EXISTS enterprise_events_no_update BEFORE UPDATE ON enterprise_events BEGIN SELECT RAISE(ABORT,'enterprise events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS enterprise_events_no_delete BEFORE DELETE ON enterprise_events BEGIN SELECT RAISE(ABORT,'enterprise events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS enterprise_facts_no_update BEFORE UPDATE ON enterprise_facts BEGIN SELECT RAISE(ABORT,'enterprise facts are append-only'); END;
CREATE TRIGGER IF NOT EXISTS enterprise_facts_no_delete BEFORE DELETE ON enterprise_facts BEGIN SELECT RAISE(ABORT,'enterprise facts are append-only'); END;
`;

export interface EnterpriseSnapshot<T extends JsonObject = JsonObject> { readonly aggregateType: string; readonly aggregateId: string; readonly version: number; readonly state: Readonly<T>; readonly updatedAt: string }
export interface EnterpriseEvent { readonly sequence: number; readonly aggregateType: string; readonly aggregateId: string; readonly aggregateVersion: number; readonly eventType: string; readonly payload: Readonly<JsonObject>; readonly occurredAt: string }
export interface EnterpriseRepository {
  execute<T extends JsonValue>(tenantId: string, key: string, operation: string, request: JsonObject, run: () => T): { readonly value: T; readonly replayed: boolean };
  get<T extends JsonObject>(tenantId: string, type: string, id: string): EnterpriseSnapshot<T> | undefined;
  put<T extends JsonObject>(input: { tenantId: string; aggregateType: string; aggregateId: string; expectedVersion: number | null; state: T; eventType: string; event: JsonObject }): EnterpriseSnapshot<T>;
  claimFact(input: { tenantId: string; factId: string; factSha256: string; issuer: string; factKind: string; subjectId: string; sequence: number; occurredAt: string }): void;
  events(tenantId: string, type?: string): readonly EnterpriseEvent[];
  close(): void;
}

export class SqliteEnterpriseRepository implements EnterpriseRepository {
  readonly #db: DatabaseSync;
  readonly #clock: () => Date;
  #transaction = false;
  constructor(path: string, clock: () => Date = () => new Date()) {
    if (path !== ":memory:" && !isAbsolute(path)) throw new EnterpriseControlError("CONFIGURATION_INVALID", "enterprise database path must be absolute");
    this.#db = new DatabaseSync(path, { timeout: 5_000 }); this.#clock = clock;
    this.#db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    this.#migrate();
  }
  execute<T extends JsonValue>(tenantValue: string, keyValue: string, operationValue: string, request: JsonObject, run: () => T): { readonly value: T; readonly replayed: boolean } {
    const tenantId = identifier(tenantValue, "tenantId"); const key = identifier(keyValue, "idempotencyKey", 256); const operation = identifier(operationValue, "operation", 200); const requestHash = digest(request);
    if (this.#transaction) throw new EnterpriseControlError("CONFLICT", "nested enterprise transaction forbidden");
    this.#db.exec("BEGIN IMMEDIATE"); this.#transaction = true;
    try {
      const previous = this.#db.prepare("SELECT operation,request_sha256,result_json FROM enterprise_idempotency WHERE tenant_id=? AND idempotency_key=?").get(tenantId, key) as { operation: string; request_sha256: string; result_json: string } | undefined;
      if (previous !== undefined) {
        if (previous.operation !== operation || previous.request_sha256 !== requestHash) throw new EnterpriseControlError("IDEMPOTENCY_CONFLICT", "idempotency key reused for different command");
        this.#db.exec("COMMIT"); return { value: freeze(JSON.parse(previous.result_json) as T) as T, replayed: true };
      }
      const value = freeze(run()) as T;
      this.#db.prepare("INSERT INTO enterprise_idempotency VALUES(?,?,?,?,?,?)").run(tenantId, key, operation, requestHash, canonicalJson(value), this.#now());
      this.#db.exec("COMMIT"); return { value, replayed: false };
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; } finally { this.#transaction = false; }
  }
  get<T extends JsonObject>(tenantValue: string, typeValue: string, idValue: string): EnterpriseSnapshot<T> | undefined {
    const tenantId = identifier(tenantValue, "tenantId"); const type = identifier(typeValue, "aggregateType"); const id = identifier(idValue, "aggregateId");
    const row = this.#db.prepare("SELECT version,state_json,updated_at FROM enterprise_aggregates WHERE tenant_id=? AND aggregate_type=? AND aggregate_id=?").get(tenantId, type, id) as { version: number; state_json: string; updated_at: string } | undefined;
    return row === undefined ? undefined : freeze({ aggregateType: type, aggregateId: id, version: row.version, state: JSON.parse(row.state_json) as T, updatedAt: row.updated_at });
  }
  put<T extends JsonObject>(input: { tenantId: string; aggregateType: string; aggregateId: string; expectedVersion: number | null; state: T; eventType: string; event: JsonObject }): EnterpriseSnapshot<T> {
    if (!this.#transaction) throw new EnterpriseControlError("CONFLICT", "enterprise writes require atomic command");
    const tenantId = identifier(input.tenantId, "tenantId"); const type = identifier(input.aggregateType, "aggregateType"); const id = identifier(input.aggregateId, "aggregateId"); const eventType = identifier(input.eventType, "eventType", 200);
    const current = this.get<T>(tenantId, type, id);
    if ((current?.version ?? null) !== input.expectedVersion) throw new EnterpriseControlError("CONFLICT", "aggregate version changed");
    const version = (current?.version ?? 0) + 1; const now = this.#now(); const stateJson = canonicalJson(input.state);
    if (current === undefined) this.#db.prepare("INSERT INTO enterprise_aggregates VALUES(?,?,?,?,?,?)").run(tenantId, type, id, version, stateJson, now);
    else this.#db.prepare("UPDATE enterprise_aggregates SET version=?,state_json=?,updated_at=? WHERE tenant_id=? AND aggregate_type=? AND aggregate_id=? AND version=?").run(version, stateJson, now, tenantId, type, id, current.version);
    const eventId = digest({ tenantId, type, id, version, eventType, event: input.event });
    this.#db.prepare("INSERT INTO enterprise_events(tenant_id,event_id,aggregate_type,aggregate_id,aggregate_version,event_type,event_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)").run(tenantId, eventId, type, id, version, eventType, canonicalJson(input.event), now);
    return freeze({ aggregateType: type, aggregateId: id, version, state: freeze(input.state), updatedAt: now });
  }
  claimFact(input: { tenantId: string; factId: string; factSha256: string; issuer: string; factKind: string; subjectId: string; sequence: number; occurredAt: string }): void {
    if (!this.#transaction) throw new EnterpriseControlError("CONFLICT", "fact claim requires atomic command");
    const old = this.#db.prepare("SELECT fact_sha256 FROM enterprise_facts WHERE tenant_id=? AND fact_id=?").get(input.tenantId, input.factId) as { fact_sha256: string } | undefined;
    if (old !== undefined) {
      if (old.fact_sha256 !== input.factSha256) throw new EnterpriseControlError("IDEMPOTENCY_CONFLICT", "fact ID content changed");
      return;
    }
    try { this.#db.prepare("INSERT INTO enterprise_facts VALUES(?,?,?,?,?,?,?,?)").run(input.tenantId, input.factId, input.factSha256, input.issuer, input.factKind, input.subjectId, input.sequence, input.occurredAt); }
    catch (error) { if (String(error).includes("UNIQUE constraint failed")) throw new EnterpriseControlError("CONFLICT", "fact sequence duplicated"); throw error; }
  }
  events(tenantValue: string, typeValue?: string): readonly EnterpriseEvent[] {
    const tenantId = identifier(tenantValue, "tenantId"); const rows = (typeValue === undefined
      ? this.#db.prepare("SELECT sequence,aggregate_type,aggregate_id,aggregate_version,event_type,event_json,occurred_at FROM enterprise_events WHERE tenant_id=? ORDER BY sequence").all(tenantId)
      : this.#db.prepare("SELECT sequence,aggregate_type,aggregate_id,aggregate_version,event_type,event_json,occurred_at FROM enterprise_events WHERE tenant_id=? AND aggregate_type=? ORDER BY sequence").all(tenantId, identifier(typeValue, "aggregateType"))) as unknown as Array<{ sequence: number; aggregate_type: string; aggregate_id: string; aggregate_version: number; event_type: string; event_json: string; occurred_at: string }>;
    return freeze(rows.map((row) => ({ sequence: row.sequence, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, aggregateVersion: row.aggregate_version, eventType: row.event_type, payload: JSON.parse(row.event_json) as JsonObject, occurredAt: row.occurred_at })));
  }
  close(): void { this.#db.close(); }
  #migrate(): void {
    this.#db.exec(SCHEMA); const checksum = digest(SCHEMA);
    const rows = this.#db.prepare("SELECT key,value FROM enterprise_schema").all() as unknown as Array<{ key: string; value: string }>;
    if (rows.length === 0) { this.#db.prepare("INSERT INTO enterprise_schema VALUES('version',?),('checksum',?)").run(SCHEMA_VERSION, checksum); return; }
    const map = new Map(rows.map((row) => [row.key, row.value]));
    if (map.get("version") !== SCHEMA_VERSION || map.get("checksum") !== checksum) throw new EnterpriseControlError("CONFIGURATION_INVALID", "enterprise schema checksum/version mismatch");
  }
  #now(): string { return this.#clock().toISOString(); }
}
