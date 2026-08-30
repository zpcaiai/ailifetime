import { GrowthError } from "./common.js";
import type { LifecycleDelivery, MessagePreference, ReferralLink, RewardEntry } from "./referral-lifecycle.js";

export interface GrowthOperationsState {
  readonly schemaVersion: 1;
  readonly referralLinks: Record<string, ReferralLink>;
  readonly rewards: RewardEntry[];
  readonly rewardIds: Record<string, string>;
  readonly rewardSources: Record<string, string>;
  readonly messagePreferences: Record<string, MessagePreference>;
  readonly lifecycleDeliveries: Record<string, LifecycleDelivery>;
}
export interface GrowthOperationsRepository {
  transaction<T>(tenantId: string, work: (state: GrowthOperationsState) => T | Promise<T>): Promise<T>;
  read<T>(tenantId: string, work: (state: Readonly<GrowthOperationsState>) => T | Promise<T>): Promise<T>;
}
export function emptyGrowthOperationsState(): GrowthOperationsState { return { schemaVersion: 1, referralLinks: {}, rewards: [], rewardIds: {}, rewardSources: {}, messagePreferences: {}, lifecycleDeliveries: {} }; }

/** Test-only repository; production composition must use PostgresGrowthOperationsRepository. */
export class InMemoryGrowthOperationsRepository implements GrowthOperationsRepository {
  readonly #states = new Map<string, GrowthOperationsState>(); readonly #tails = new Map<string, Promise<void>>();
  async transaction<T>(tenantId: string, work: (state: GrowthOperationsState) => T | Promise<T>): Promise<T> { validateTenant(tenantId); const previous = this.#tails.get(tenantId) ?? Promise.resolve(); let release!: () => void; const turn = new Promise<void>((resolve) => { release = resolve; }); this.#tails.set(tenantId, previous.then(() => turn)); await previous; try { const candidate = structuredClone(this.#states.get(tenantId) ?? emptyGrowthOperationsState()); const result = await work(candidate); this.#states.set(tenantId, structuredClone(candidate)); return structuredClone(result); } finally { release(); } }
  async read<T>(tenantId: string, work: (state: Readonly<GrowthOperationsState>) => T | Promise<T>): Promise<T> { return this.transaction(tenantId, async (state) => work(structuredClone(state))); }
}

export interface GrowthSqlResult<Row extends Record<string, unknown> = Record<string, unknown>> { readonly rows: readonly Row[]; readonly rowCount?: number | null; }
export interface GrowthSqlClient { query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters?: readonly unknown[]): Promise<GrowthSqlResult<Row>>; release(): void; }
export interface GrowthSqlPool { connect(): Promise<GrowthSqlClient>; }
export class PostgresGrowthOperationsRepository implements GrowthOperationsRepository {
  constructor(readonly pool: GrowthSqlPool) {}
  async transaction<T>(tenantId: string, work: (state: GrowthOperationsState) => T | Promise<T>): Promise<T> { validateTenant(tenantId); const client = await this.pool.connect(); try { await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]); await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [tenantId]); const selected = await client.query<{ state: unknown; version: string | number }>("SELECT state, version FROM ltm.growth_operations_state WHERE tenant_id = $1 FOR UPDATE", [tenantId]); const row = selected.rows[0]; const before = row === undefined ? emptyGrowthOperationsState() : parseState(row.state); const candidate = structuredClone(before); const result = await work(candidate); await projectRows(client, tenantId, before, candidate); if (row === undefined) await client.query("INSERT INTO ltm.growth_operations_state (tenant_id, version, state) VALUES ($1, 1, $2::jsonb)", [tenantId, JSON.stringify(candidate)]); else { const updated = await client.query("UPDATE ltm.growth_operations_state SET version = version + 1, state = $3::jsonb, updated_at = clock_timestamp() WHERE tenant_id = $1 AND version = $2", [tenantId, Number(row.version), JSON.stringify(candidate)]); if (updated.rowCount !== 1) throw new GrowthError("CONFLICT", "growth state changed concurrently"); } await client.query("COMMIT"); return structuredClone(result); } catch (error) { try { await client.query("ROLLBACK"); } catch { /* preserve error */ } throw error; } finally { client.release(); } }
  async read<T>(tenantId: string, work: (state: Readonly<GrowthOperationsState>) => T | Promise<T>): Promise<T> { validateTenant(tenantId); const client = await this.pool.connect(); try { await client.query("BEGIN READ ONLY"); await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]); const selected = await client.query<{ state: unknown }>("SELECT state FROM ltm.growth_operations_state WHERE tenant_id = $1", [tenantId]); const state = selected.rows[0] === undefined ? emptyGrowthOperationsState() : parseState(selected.rows[0].state); const result = await work(structuredClone(state)); await client.query("COMMIT"); return structuredClone(result); } catch (error) { try { await client.query("ROLLBACK"); } catch { /* preserve error */ } throw error; } finally { client.release(); } }
}
async function projectRows(client: GrowthSqlClient, tenantId: string, before: GrowthOperationsState, after: GrowthOperationsState): Promise<void> {
  for (const reward of after.rewards.slice(before.rewards.length)) await client.query("INSERT INTO ltm.referral_rewards (tenant_id, id, source_key, source_order_id, referral_id, beneficiary_id, kind, amount_minor, reverses_reward_id, occurred_at, entry_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11)", [tenantId, reward.id, reward.sourceKey, reward.sourceOrderId, reward.referralId, reward.beneficiaryId, reward.kind, reward.amountMinor, reward.reversesRewardId ?? null, reward.occurredAt, reward.entrySha256]);
  for (const delivery of Object.values(after.lifecycleDeliveries).filter((item) => before.lifecycleDeliveries[item.messageId] === undefined)) await client.query("INSERT INTO ltm.lifecycle_deliveries (tenant_id, message_id, account_id, message_class, channel, occurred_at) VALUES ($1,$2,$3,$4,$5,$6::timestamptz)", [tenantId, delivery.messageId, delivery.accountId, delivery.messageClass, delivery.channel, delivery.occurredAt]);
}
function parseState(raw: unknown): GrowthOperationsState { const value = typeof raw === "string" ? JSON.parse(raw) as unknown : raw; if (value === null || typeof value !== "object" || (value as { schemaVersion?: unknown }).schemaVersion !== 1) throw new GrowthError("DEPENDENCY", "stored growth state has an unsupported schema"); return structuredClone(value as GrowthOperationsState); }
function validateTenant(tenantId: string): void { if (tenantId.trim() === "" || tenantId.length > 200) throw new GrowthError("VALIDATION", "tenant identity is invalid"); }
