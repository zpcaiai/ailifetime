import { assertMinorUnits, canonicalJson, clone, DataIntelligenceError, fingerprint, required, strictUtc } from "./common.js";

export const INGESTION_SOURCES = [
  "event", "postgres_cdc", "ledger", "payment", "partner", "notification", "ticket", "supply_chain",
] as const;
export type IngestionSource = (typeof INGESTION_SOURCES)[number];
export type WarehouseLayer = "raw" | "staging" | "core" | "mart";

export interface SourceRecord {
  readonly tenantId: string;
  readonly sequence: number;
  readonly primaryKey: string;
  readonly sourceOccurredAt: string;
  readonly sourceVersion: number;
  readonly deleted: boolean;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly currency?: string;
  readonly amountMinor?: number;
}

export interface LayeredRecord extends SourceRecord {
  readonly source: IngestionSource;
  readonly ingestedAt: string;
  readonly traceKey: string;
  readonly sourceFingerprint: string;
  readonly lateArrival: boolean;
  readonly layer: WarehouseLayer;
  readonly normalizedCurrency?: string;
  readonly normalizedOccurredAt: string;
}

export interface IngestionBatch {
  readonly batchId: string;
  readonly source: IngestionSource;
  readonly schemaFingerprint: string;
  readonly records: readonly SourceRecord[];
  readonly expectedRowCount: number;
  readonly expectedAmountMinor: number;
  readonly maxCostMinor: number;
  readonly actualCostMinor: number;
  readonly freshnessSloSeconds: number;
  readonly replayOfBatchId?: string;
}

export interface IngestionReport {
  readonly batchId: string;
  readonly source: IngestionSource;
  readonly status: "COMMITTED" | "NOOP";
  readonly acceptedRows: number;
  readonly duplicateRows: number;
  readonly watermark: string;
  readonly cursor: number;
  readonly amountMinor: number;
  readonly lateRows: number;
  readonly fresh: boolean;
  readonly costMinor: number;
  readonly replayOfBatchId?: string;
}

interface SourceCheckpoint {
  cursor: number;
  watermark: string;
  schemaFingerprint: string;
}

export interface WarehouseSnapshot {
  readonly version: "ltm.warehouse-state.v1";
  readonly checkpoints: Readonly<Record<string, SourceCheckpoint>>;
  readonly records: readonly LayeredRecord[];
  readonly recordFingerprints: Readonly<Record<string, string>>;
  readonly committedBatchFingerprints: Readonly<Record<string, string>>;
  readonly approvedSchemas: Readonly<Record<string, readonly string[]>>;
}

export interface WarehouseStateRepository {
  load(): Promise<WarehouseSnapshot | undefined>;
  compareAndSwap(expectedStateFingerprint: string | undefined, next: WarehouseSnapshot): Promise<void>;
}

export class WarehousePipeline {
  readonly #checkpoints = new Map<IngestionSource, SourceCheckpoint>();
  readonly #records: LayeredRecord[] = [];
  readonly #recordFingerprints = new Map<string, string>();
  readonly #committedBatchFingerprints = new Map<string, string>();
  readonly #approvedSchemas = new Map<IngestionSource, Set<string>>();

  constructor(readonly now: () => Date = () => new Date(), snapshot?: WarehouseSnapshot) {
    for (const source of INGESTION_SOURCES) this.#approvedSchemas.set(source, new Set());
    if (snapshot !== undefined) this.restore(snapshot);
  }

  approveSchema(source: IngestionSource, schemaFingerprint: string): void {
    if (!/^[a-f0-9]{64}$/u.test(schemaFingerprint)) throw new DataIntelligenceError("VALIDATION_FAILED", "schema fingerprint is invalid");
    this.#approvedSchemas.get(source)?.add(schemaFingerprint);
  }

  ingest(batch: IngestionBatch): IngestionReport {
    validateBatch(batch);
    const batchFingerprint = fingerprint(batch);
    const existingBatch = this.#committedBatchFingerprints.get(batch.batchId);
    if (existingBatch !== undefined) {
      if (existingBatch !== batchFingerprint) throw new DataIntelligenceError("CONFLICT", "batch id was reused with different input");
      const checkpoint = this.#checkpoints.get(batch.source);
      if (checkpoint === undefined) throw new DataIntelligenceError("CONFLICT", "committed batch is missing its checkpoint");
      return Object.freeze({
        batchId: batch.batchId, source: batch.source, status: "NOOP", acceptedRows: 0,
        duplicateRows: batch.records.length, watermark: checkpoint.watermark, cursor: checkpoint.cursor,
        amountMinor: 0, lateRows: 0, fresh: freshness(checkpoint.watermark, this.now(), batch.freshnessSloSeconds),
        costMinor: 0, ...(batch.replayOfBatchId === undefined ? {} : { replayOfBatchId: batch.replayOfBatchId }),
      });
    }
    const checkpoint = this.#checkpoints.get(batch.source);
    if (checkpoint !== undefined && checkpoint.schemaFingerprint !== batch.schemaFingerprint &&
        !this.#approvedSchemas.get(batch.source)?.has(batch.schemaFingerprint)) {
      throw new DataIntelligenceError("SCHEMA_INCOMPATIBLE", `unapproved schema drift for ${batch.source}`);
    }
    if (batch.actualCostMinor > batch.maxCostMinor) throw new DataIntelligenceError("POLICY_BLOCKED", "ingestion cost budget exceeded");
    const sorted = [...batch.records].sort((left, right) => left.sequence - right.sequence);
    const accepted: SourceRecord[] = [];
    let duplicates = 0;
    let nextCursor = checkpoint?.cursor ?? 0;
    for (const record of sorted) {
      validateSourceRecord(record);
      const key = recordKey(batch.source, record);
      const rowFingerprint = fingerprint(record);
      const prior = this.#recordFingerprints.get(key);
      if (record.sequence <= nextCursor) {
        if (prior !== rowFingerprint) throw new DataIntelligenceError("CONFLICT", `source record ${key} changed after ingestion`);
        duplicates += 1;
        continue;
      }
      if (record.sequence !== nextCursor + 1) throw new DataIntelligenceError("CONFLICT", `source ${batch.source} cursor has a gap at ${nextCursor + 1}`);
      accepted.push(record);
      nextCursor = record.sequence;
    }
    if (accepted.length !== batch.expectedRowCount) throw new DataIntelligenceError("CONTROL_TOTAL_MISMATCH", "row-count control total does not match accepted rows");
    const amountMinor = accepted.reduce((total, record) => total + (record.amountMinor ?? 0), 0);
    if (amountMinor !== batch.expectedAmountMinor) throw new DataIntelligenceError("CONTROL_TOTAL_MISMATCH", "amount control total does not balance");
    const ingestedAt = this.now().toISOString();
    const priorWatermark = checkpoint?.watermark ?? "1970-01-01T00:00:00.000Z";
    const lateRows = accepted.filter((record) => Date.parse(strictUtc(record.sourceOccurredAt)) < Date.parse(priorWatermark)).length;
    for (const record of accepted) {
      const base = normalizeRecord(batch.source, record, ingestedAt, priorWatermark);
      for (const layer of ["raw", "staging", "core", "mart"] as const) this.#records.push(Object.freeze({ ...base, layer }));
      this.#recordFingerprints.set(recordKey(batch.source, record), fingerprint(record));
    }
    const latest = accepted.reduce((watermark, record) => {
      const occurredAt = strictUtc(record.sourceOccurredAt);
      return Date.parse(occurredAt) > Date.parse(watermark) ? occurredAt : watermark;
    }, priorWatermark);
    const nextCheckpoint = { cursor: nextCursor, watermark: latest, schemaFingerprint: batch.schemaFingerprint };
    this.#checkpoints.set(batch.source, nextCheckpoint);
    this.#approvedSchemas.get(batch.source)?.add(batch.schemaFingerprint);
    this.#committedBatchFingerprints.set(batch.batchId, batchFingerprint);
    return Object.freeze({
      batchId: batch.batchId, source: batch.source, status: "COMMITTED", acceptedRows: accepted.length,
      duplicateRows: duplicates, watermark: latest, cursor: nextCursor, amountMinor, lateRows,
      fresh: freshness(latest, this.now(), batch.freshnessSloSeconds), costMinor: batch.actualCostMinor,
      ...(batch.replayOfBatchId === undefined ? {} : { replayOfBatchId: batch.replayOfBatchId }),
    });
  }

  rows(layer: WarehouseLayer, tenantId?: string): readonly LayeredRecord[] {
    return Object.freeze(this.#records.filter((record) => record.layer === layer && (tenantId === undefined || record.tenantId === tenantId)).map(clone));
  }

  checkpoint(source: IngestionSource): Readonly<SourceCheckpoint> | undefined {
    const checkpoint = this.#checkpoints.get(source);
    return checkpoint === undefined ? undefined : Object.freeze({ ...checkpoint });
  }

  snapshot(): WarehouseSnapshot {
    return Object.freeze({
      version: "ltm.warehouse-state.v1",
      checkpoints: Object.freeze(Object.fromEntries([...this.#checkpoints.entries()].map(([source, checkpoint]) => [source, { ...checkpoint }]))),
      records: Object.freeze(this.#records.map(clone)),
      recordFingerprints: Object.freeze(Object.fromEntries(this.#recordFingerprints)),
      committedBatchFingerprints: Object.freeze(Object.fromEntries(this.#committedBatchFingerprints)),
      approvedSchemas: Object.freeze(Object.fromEntries([...this.#approvedSchemas.entries()].map(([source, schemas]) => [source, Object.freeze([...schemas].sort())]))),
    });
  }

  restore(snapshot: WarehouseSnapshot): void {
    if (snapshot.version !== "ltm.warehouse-state.v1") throw new DataIntelligenceError("VALIDATION_FAILED", "warehouse snapshot version is unsupported");
    this.#checkpoints.clear(); this.#records.length = 0; this.#recordFingerprints.clear(); this.#committedBatchFingerprints.clear();
    for (const source of INGESTION_SOURCES) {
      const checkpoint = snapshot.checkpoints[source];
      if (checkpoint !== undefined) this.#checkpoints.set(source, clone(checkpoint));
      this.#approvedSchemas.set(source, new Set(snapshot.approvedSchemas[source] ?? []));
    }
    this.#records.push(...snapshot.records.map(clone));
    for (const [key, value] of Object.entries(snapshot.recordFingerprints)) this.#recordFingerprints.set(key, value);
    for (const [key, value] of Object.entries(snapshot.committedBatchFingerprints)) this.#committedBatchFingerprints.set(key, value);
  }

  stateFingerprint(): string {
    return fingerprint(this.snapshot());
  }

  async persist(repository: WarehouseStateRepository, expectedStateFingerprint?: string): Promise<void> {
    await repository.compareAndSwap(expectedStateFingerprint, this.snapshot());
  }
}

export interface SlowlyChangingDimensionInput {
  readonly naturalKey: string;
  readonly effectiveAt: string;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly deleted: boolean;
}

export interface SlowlyChangingDimensionVersion extends SlowlyChangingDimensionInput {
  readonly version: number;
  readonly effectiveUntil?: string;
  readonly current: boolean;
}

export class SlowlyChangingDimension {
  readonly #versions = new Map<string, SlowlyChangingDimensionVersion[]>();

  apply(input: SlowlyChangingDimensionInput): readonly SlowlyChangingDimensionVersion[] {
    required(input.naturalKey, "naturalKey");
    strictUtc(input.effectiveAt, "effectiveAt");
    const values = [...(this.#versions.get(input.naturalKey) ?? []), { ...clone(input), version: 0, current: false }]
      .sort((left, right) => Date.parse(left.effectiveAt) - Date.parse(right.effectiveAt));
    for (let index = 1; index < values.length; index += 1) {
      if (values[index]?.effectiveAt === values[index - 1]?.effectiveAt) throw new DataIntelligenceError("CONFLICT", "dimension effective time is duplicated");
    }
    const rebuilt = values.map((value, index): SlowlyChangingDimensionVersion => Object.freeze({
      naturalKey: value.naturalKey,
      effectiveAt: value.effectiveAt,
      attributes: Object.freeze(clone(value.attributes)),
      deleted: value.deleted,
      version: index + 1,
      ...(values[index + 1] === undefined ? {} : { effectiveUntil: values[index + 1]?.effectiveAt as string }),
      current: values[index + 1] === undefined,
    }));
    this.#versions.set(input.naturalKey, rebuilt);
    return Object.freeze(rebuilt.map(clone));
  }
}

export const SEMANTIC_METRICS = Object.freeze({
  activation: { expression: "activated_users / eligible_users", owner: "growth", grain: "day" },
  generation_success: { expression: "successful_generations / accepted_generations", owner: "ai-operations", grain: "hour" },
  paid_conversion: { expression: "paid_orders / checkout_starts", owner: "commerce", grain: "day" },
  retention: { expression: "retained_accounts / cohort_accounts", owner: "growth", grain: "cohort_week" },
  arr: { expression: "sum(active_subscription_mrr_minor) * 12", owner: "finance", grain: "month" },
  mrr: { expression: "sum(active_subscription_mrr_minor)", owner: "finance", grain: "month" },
  gross_margin: { expression: "(net_revenue_minor - variable_cost_minor) / net_revenue_minor", owner: "finance", grain: "month" },
  sla_attainment: { expression: "within_sla_cases / eligible_cases", owner: "operations", grain: "day" },
  security_incident_rate: { expression: "confirmed_security_incidents / million_requests", owner: "security", grain: "day" },
} as const);

function validateBatch(batch: IngestionBatch): void {
  required(batch.batchId, "batchId");
  if (!INGESTION_SOURCES.includes(batch.source)) throw new DataIntelligenceError("VALIDATION_FAILED", "ingestion source is invalid");
  if (!/^[a-f0-9]{64}$/u.test(batch.schemaFingerprint)) throw new DataIntelligenceError("VALIDATION_FAILED", "schemaFingerprint is invalid");
  for (const [field, value] of [["expectedRowCount", batch.expectedRowCount], ["maxCostMinor", batch.maxCostMinor], ["actualCostMinor", batch.actualCostMinor], ["freshnessSloSeconds", batch.freshnessSloSeconds]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new DataIntelligenceError("VALIDATION_FAILED", `${field} is invalid`);
  }
  assertMinorUnits(batch.expectedAmountMinor, "expectedAmountMinor");
}

function validateSourceRecord(record: SourceRecord): void {
  required(record.tenantId, "tenantId"); required(record.primaryKey, "primaryKey"); strictUtc(record.sourceOccurredAt, "sourceOccurredAt");
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1 || !Number.isSafeInteger(record.sourceVersion) || record.sourceVersion < 1) {
    throw new DataIntelligenceError("VALIDATION_FAILED", "source sequence or version is invalid");
  }
  if (record.amountMinor !== undefined) assertMinorUnits(record.amountMinor, "amountMinor");
  if (record.currency !== undefined && !/^[A-Z]{3}$/u.test(record.currency)) throw new DataIntelligenceError("VALIDATION_FAILED", "currency must use ISO uppercase format");
}

function normalizeRecord(source: IngestionSource, record: SourceRecord, ingestedAt: string, priorWatermark: string): Omit<LayeredRecord, "layer"> {
  const normalizedOccurredAt = strictUtc(record.sourceOccurredAt);
  return Object.freeze({
    ...clone(record), source, ingestedAt, traceKey: `${record.tenantId}:${source}:${record.primaryKey}`,
    sourceFingerprint: fingerprint(record), lateArrival: Date.parse(normalizedOccurredAt) < Date.parse(priorWatermark),
    normalizedOccurredAt,
    ...(record.currency === undefined ? {} : { normalizedCurrency: record.currency.toUpperCase() }),
  });
}

function recordKey(source: IngestionSource, record: SourceRecord): string {
  return `${record.tenantId}:${source}:${record.sequence}:${record.primaryKey}`;
}

function freshness(watermark: string, now: Date, sloSeconds: number): boolean {
  return now.getTime() - Date.parse(watermark) <= sloSeconds * 1000;
}

export function assertWarehouseSnapshotDigest(snapshot: WarehouseSnapshot, expectedSha256: string): void {
  if (fingerprint(snapshot) !== expectedSha256) throw new DataIntelligenceError("CONFLICT", "warehouse checkpoint digest changed");
  canonicalJson(snapshot);
}
