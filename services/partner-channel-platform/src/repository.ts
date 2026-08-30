import { PartnerError, stableJson } from "./common.js";
import type { AnomalyDecision, RateContract, SettlementAdjustment, SettlementDispute, SettlementStatement, UsageEvent } from "./partner-api-metering.js";

export interface PartnerSettlementState {
  readonly schemaVersion: 1;
  readonly usage: UsageEvent[];
  readonly usageAllocations: Record<string, string>;
  readonly contracts: Record<string, RateContract>;
  readonly statements: Record<string, SettlementStatement>;
  readonly statementRequests: Record<string, string>;
  readonly settlementAnomalies: Record<string, readonly string[]>;
  readonly anomalyDecisions: Record<string, Record<string, AnomalyDecision>>;
  readonly adjustments: Record<string, SettlementAdjustment>;
  readonly disputes: Record<string, SettlementDispute>;
}
export interface PartnerSettlementRepository {
  transaction<T>(partnerId: string, work: (state: PartnerSettlementState) => T | Promise<T>): Promise<T>;
  read<T>(partnerId: string, work: (state: Readonly<PartnerSettlementState>) => T | Promise<T>): Promise<T>;
}
export function emptyPartnerSettlementState(): PartnerSettlementState { return { schemaVersion: 1, usage: [], usageAllocations: {}, contracts: {}, statements: {}, statementRequests: {}, settlementAnomalies: {}, anomalyDecisions: {}, adjustments: {}, disputes: {} }; }

/** Test-only repository; production composition must use PostgresPartnerSettlementRepository. */
export class InMemoryPartnerSettlementRepository implements PartnerSettlementRepository {
  readonly #states = new Map<string, PartnerSettlementState>(); readonly #tails = new Map<string, Promise<void>>();
  async transaction<T>(partnerId: string, work: (state: PartnerSettlementState) => T | Promise<T>): Promise<T> { validatePartner(partnerId); const previous = this.#tails.get(partnerId) ?? Promise.resolve(); let release!: () => void; const turn = new Promise<void>((resolve) => { release = resolve; }); this.#tails.set(partnerId, previous.then(() => turn)); await previous; try { const candidate = structuredClone(this.#states.get(partnerId) ?? emptyPartnerSettlementState()); const result = await work(candidate); this.#states.set(partnerId, structuredClone(candidate)); return structuredClone(result); } finally { release(); } }
  async read<T>(partnerId: string, work: (state: Readonly<PartnerSettlementState>) => T | Promise<T>): Promise<T> { return this.transaction(partnerId, async (state) => work(structuredClone(state))); }
}

export interface PartnerSqlResult<Row extends Record<string, unknown> = Record<string, unknown>> { readonly rows: readonly Row[]; readonly rowCount?: number | null; }
export interface PartnerSqlClient { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters?: readonly unknown[]): Promise<PartnerSqlResult<Row>>; release(): void; }
export interface PartnerSqlPool { connect(): Promise<PartnerSqlClient>; }
export class PostgresPartnerSettlementRepository implements PartnerSettlementRepository {
  constructor(readonly pool: PartnerSqlPool) {}
  async transaction<T>(partnerId: string, work: (state: PartnerSettlementState) => T | Promise<T>): Promise<T> { validatePartner(partnerId); const client = await this.pool.connect(); try { await client.query("BEGIN"); await client.query("SELECT set_config('app.partner_id', $1, true)", [partnerId]); await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 2))", [partnerId]); const selected = await client.query<{ state: unknown; version: string | number }>("SELECT state, version FROM ltm.partner_settlement_state WHERE partner_id = $1 FOR UPDATE", [partnerId]); const row = selected.rows[0]; const before = row === undefined ? emptyPartnerSettlementState() : parseState(row.state); const candidate = structuredClone(before); const result = await work(candidate); await projectRows(client, partnerId, before, candidate); if (row === undefined) await client.query("INSERT INTO ltm.partner_settlement_state (partner_id, version, state) VALUES ($1,1,$2::jsonb)", [partnerId, JSON.stringify(candidate)]); else { const updated = await client.query("UPDATE ltm.partner_settlement_state SET version = version + 1, state = $3::jsonb, updated_at = clock_timestamp() WHERE partner_id = $1 AND version = $2", [partnerId, Number(row.version), JSON.stringify(candidate)]); if (updated.rowCount !== 1) throw new PartnerError("CONFLICT", "partner settlement state changed concurrently"); } await client.query("COMMIT"); return structuredClone(result); } catch (error) { try { await client.query("ROLLBACK"); } catch { /* preserve error */ } throw error; } finally { client.release(); } }
  async read<T>(partnerId: string, work: (state: Readonly<PartnerSettlementState>) => T | Promise<T>): Promise<T> { validatePartner(partnerId); const client = await this.pool.connect(); try { await client.query("BEGIN READ ONLY"); await client.query("SELECT set_config('app.partner_id', $1, true)", [partnerId]); const selected = await client.query<{ state: unknown }>("SELECT state FROM ltm.partner_settlement_state WHERE partner_id = $1", [partnerId]); const state = selected.rows[0] === undefined ? emptyPartnerSettlementState() : parseState(selected.rows[0].state); const result = await work(structuredClone(state)); await client.query("COMMIT"); return structuredClone(result); } catch (error) { try { await client.query("ROLLBACK"); } catch { /* preserve error */ } throw error; } finally { client.release(); } }
}
async function projectRows(client: PartnerSqlClient, partnerId: string, before: PartnerSettlementState, after: PartnerSettlementState): Promise<void> {
  for (const usage of after.usage.slice(before.usage.length)) await client.query("INSERT INTO ltm.partner_usage_events (partner_id,id,event_sha256,occurred_at,payload) VALUES ($1,$2,$3,$4::timestamptz,$5::jsonb)", [partnerId, usage.id, usage.eventSha256, usage.occurredAt, JSON.stringify(usage)]);
  for (const [key, contract] of Object.entries(after.contracts)) if (before.contracts[key] === undefined) await client.query("INSERT INTO ltm.partner_rate_contracts (partner_id,contract_id,version,effective_from,effective_until,payload) VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6::jsonb)", [partnerId, contract.id, contract.version, contract.effectiveFrom, contract.effectiveUntil ?? null, JSON.stringify(contract)]);
  for (const [id, statement] of Object.entries(after.statements)) { const prior = before.statements[id]; if (prior === undefined) await client.query("INSERT INTO ltm.partner_settlement_statements (partner_id,id,period,amount_minor,state,artifact_sha256) VALUES ($1,$2,$3,$4,$5,$6)", [partnerId, id, statement.period, statement.amountMinor, statement.state, statement.artifactSha256]); else if (stableJson(prior) !== stableJson(statement)) await client.query("UPDATE ltm.partner_settlement_statements SET amount_minor=$3,state=$4,artifact_sha256=$5,updated_at=clock_timestamp() WHERE partner_id=$1 AND id=$2", [partnerId, id, statement.amountMinor, statement.state, statement.artifactSha256]); }
  for (const [statementId, decisions] of Object.entries(after.anomalyDecisions)) for (const [anomaly, decision] of Object.entries(decisions)) if (before.anomalyDecisions[statementId]?.[anomaly] === undefined) await client.query("INSERT INTO ltm.partner_anomaly_decisions (partner_id,statement_id,anomaly,decision,decided_by,reason,evidence_sha256,decided_at,waiver_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz)", [partnerId, statementId, anomaly, decision.decision, decision.decidedBy, decision.reason, decision.evidenceSha256, decision.decidedAt, decision.waiverExpiresAt ?? null]);
}
function parseState(raw: unknown): PartnerSettlementState { const value = typeof raw === "string" ? JSON.parse(raw) as unknown : raw; if (value === null || typeof value !== "object" || (value as { schemaVersion?: unknown }).schemaVersion !== 1) throw new PartnerError("DEPENDENCY", "stored partner settlement state has an unsupported schema"); return structuredClone(value as PartnerSettlementState); }
function validatePartner(partnerId: string): void { if (partnerId.trim() === "" || partnerId.length > 200) throw new PartnerError("VALIDATION", "partner identity is invalid"); }
