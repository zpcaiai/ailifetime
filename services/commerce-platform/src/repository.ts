import { CommerceError } from "./common.js";
import type { DeliveryAsset, Order, OrderRemedy } from "./orders-delivery.js";
import type { JournalEntry, PaymentEffect, PaymentIntent, PaymentOutboxEvent, WebhookInboxEntry } from "./payments-ledger.js";

export interface CommerceFinanceState {
  readonly schemaVersion: 1;
  readonly payments: Record<string, PaymentIntent>;
  readonly paymentByProvider: Record<string, string>;
  readonly paymentRequestKeys: Record<string, string>;
  readonly refundReservations: Record<string, Readonly<{ requestSha256: string; paymentId: string; amountMinor: number }>>;
  readonly refundKeys: Record<string, Readonly<{ requestSha256: string; paymentId: string; result: PaymentIntent }>>;
  readonly webhookInbox: Record<string, WebhookInboxEntry>;
  readonly journals: JournalEntry[];
  readonly outbox: PaymentOutboxEvent[];
  readonly effects: PaymentEffect[];
  readonly orders: Record<string, Order>;
  readonly deliveryAssets: Record<string, DeliveryAsset>;
  readonly orderRemedies: OrderRemedy[];
}

export interface CommerceFinanceRepository {
  transaction<T>(tenantId: string, work: (state: CommerceFinanceState) => T | Promise<T>): Promise<T>;
  read<T>(tenantId: string, work: (state: Readonly<CommerceFinanceState>) => T | Promise<T>): Promise<T>;
}

export function emptyCommerceFinanceState(): CommerceFinanceState {
  return {
    schemaVersion: 1,
    payments: {}, paymentByProvider: {}, paymentRequestKeys: {}, refundReservations: {}, refundKeys: {}, webhookInbox: {},
    journals: [], outbox: [], effects: [], orders: {}, deliveryAssets: {}, orderRemedies: [],
  };
}

/** Test-only deterministic repository. Production composition must use PostgresCommerceFinanceRepository. */
export class InMemoryCommerceFinanceRepository implements CommerceFinanceRepository {
  readonly #states = new Map<string, CommerceFinanceState>();
  readonly #tails = new Map<string, Promise<void>>();

  async transaction<T>(tenantId: string, work: (state: CommerceFinanceState) => T | Promise<T>): Promise<T> {
    validateTenant(tenantId);
    const previous = this.#tails.get(tenantId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    this.#tails.set(tenantId, previous.then(() => turn));
    await previous;
    try {
      const candidate = structuredClone(this.#states.get(tenantId) ?? emptyCommerceFinanceState());
      const result = await work(candidate);
      this.#states.set(tenantId, structuredClone(candidate));
      return structuredClone(result);
    } finally {
      release();
      if (this.#tails.get(tenantId) === turn) this.#tails.delete(tenantId);
    }
  }

  async read<T>(tenantId: string, work: (state: Readonly<CommerceFinanceState>) => T | Promise<T>): Promise<T> {
    return this.transaction(tenantId, async (state) => work(structuredClone(state)));
  }
}

export interface CommerceSqlResult<Row extends Record<string, unknown> = Record<string, unknown>> { readonly rows: readonly Row[]; readonly rowCount?: number | null; }
export interface CommerceSqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, parameters?: readonly unknown[]): Promise<CommerceSqlResult<Row>>;
  release(): void;
}
export interface CommerceSqlPool { connect(): Promise<CommerceSqlClient>; }

/**
 * PostgreSQL-backed, tenant-serialized unit of work. Besides the state projection it writes
 * the canonical inbox, immutable ledger and outbox tables in the same database transaction.
 */
export class PostgresCommerceFinanceRepository implements CommerceFinanceRepository {
  constructor(readonly pool: CommerceSqlPool) {}

  async transaction<T>(tenantId: string, work: (state: CommerceFinanceState) => T | Promise<T>): Promise<T> {
    validateTenant(tenantId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [tenantId]);
      const selected = await client.query<{ state: unknown; version: string | number }>("SELECT state, version FROM ltm.commerce_finance_state WHERE tenant_id = $1 FOR UPDATE", [tenantId]);
      const row = selected.rows[0];
      const before = row === undefined ? emptyCommerceFinanceState() : parseState(row.state);
      const candidate = structuredClone(before);
      const result = await work(candidate);
      await projectAppendOnlyRows(client, tenantId, before, candidate);
      if (row === undefined) {
        await client.query("INSERT INTO ltm.commerce_finance_state (tenant_id, version, state) VALUES ($1, 1, $2::jsonb)", [tenantId, JSON.stringify(candidate)]);
      } else {
        const updated = await client.query("UPDATE ltm.commerce_finance_state SET version = version + 1, state = $3::jsonb, updated_at = clock_timestamp() WHERE tenant_id = $1 AND version = $2", [tenantId, Number(row.version), JSON.stringify(candidate)]);
        if (updated.rowCount !== 1) throw new CommerceError("CONFLICT", "commerce state changed concurrently");
      }
      await client.query("COMMIT");
      return structuredClone(result);
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the business error */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async read<T>(tenantId: string, work: (state: Readonly<CommerceFinanceState>) => T | Promise<T>): Promise<T> {
    validateTenant(tenantId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const selected = await client.query<{ state: unknown }>("SELECT state FROM ltm.commerce_finance_state WHERE tenant_id = $1", [tenantId]);
      const state = selected.rows[0] === undefined ? emptyCommerceFinanceState() : parseState(selected.rows[0].state);
      const result = await work(structuredClone(state));
      await client.query("COMMIT");
      return structuredClone(result);
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the business error */ }
      throw error;
    } finally { client.release(); }
  }
}

async function projectAppendOnlyRows(client: CommerceSqlClient, tenantId: string, before: CommerceFinanceState, after: CommerceFinanceState): Promise<void> {
  const newInbox = Object.values(after.webhookInbox).filter((entry) => before.webhookInbox[entry.eventId] === undefined);
  for (const entry of newInbox) {
    await client.query("INSERT INTO ltm.inbox (tenant_id, source, source_event_id, event_type, payload, request_fingerprint, status, processed_at) VALUES ($1, 'commerce_payment', $2, $3, $4::jsonb, $5, 'processed', $6::timestamptz)", [tenantId, entry.eventId, entry.type, JSON.stringify(entry.payload), entry.fingerprint, entry.processedAt]);
  }
  for (const journal of after.journals.slice(before.journals.length)) {
    await client.query("INSERT INTO ltm.ledger_transactions (tenant_id, id, source_type, source_id, description, occurred_at) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)", [tenantId, journal.id, journal.sourceType, journal.sourceId, `commerce:${journal.sourceType}`, journal.occurredAt]);
    let lineNo = 0;
    for (const line of journal.lines) {
      for (const [direction, amount] of [["debit", line.debitMinor], ["credit", line.creditMinor]] as const) {
        if (amount === 0) continue;
        lineNo += 1;
        await client.query("INSERT INTO ltm.ledger_lines (tenant_id, transaction_id, line_no, account_code, direction, amount_minor, currency) VALUES ($1, $2, $3, $4, $5, $6, $7)", [tenantId, journal.id, lineNo, line.account, direction, amount, journal.currency]);
      }
    }
  }
  for (const event of after.outbox.slice(before.outbox.length)) {
    await client.query("INSERT INTO ltm.outbox (tenant_id, id, aggregate_type, aggregate_id, event_type, payload) VALUES ($1, $2, $3, $4, $5, $6::jsonb)", [tenantId, event.id, event.aggregateType, event.aggregateId, event.type, JSON.stringify(event.payload)]);
  }
}

function parseState(raw: unknown): CommerceFinanceState {
  const value = typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
  if (value === null || typeof value !== "object" || (value as { schemaVersion?: unknown }).schemaVersion !== 1) throw new CommerceError("DEPENDENCY", "stored commerce state has an unsupported schema");
  return structuredClone(value as CommerceFinanceState);
}
function validateTenant(tenantId: string): void { if (tenantId.trim() === "" || tenantId.length > 200) throw new CommerceError("VALIDATION", "tenant identity is invalid"); }
