import { createHash } from "node:crypto";
import { OrchestrationError, type ProviderControlPlane, type ProviderRoute, type RouteRequest } from "./provider-control-plane.js";
import type { SqlTransactionExecutor } from "./durable-runtime.js";

export type ProviderOperation = "generate_image" | "generate_video" | "generate_text" | "moderate" | "delete_asset";
export type ProviderErrorCategory = "validation" | "authorization" | "consent" | "policy" | "transient_dependency" | "permanent_dependency" | "conflict" | "quota" | "internal";

export interface ProviderModelRecord {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly operations: readonly ProviderOperation[];
  readonly regions: readonly string[];
  readonly purposes: readonly string[];
  readonly retentionDays: number;
  readonly trainingUseAllowed: boolean;
  readonly registrationReferences: readonly string[];
  readonly limitations: readonly string[];
  readonly priceMinorPerUnit: number;
  readonly slo: Readonly<{ p95LatencyMs: number; availabilityBasisPoints: number }>;
  readonly allowedScenarios: readonly string[];
  readonly review?: ModelVersionReview;
}

export interface ModelVersionReview {
  readonly previousVersion: string;
  readonly qualityPassed: boolean;
  readonly safetyPassed: boolean;
  readonly costApproved: boolean;
  readonly contractApproved: boolean;
  readonly reviewedAt: string;
  readonly reviewerIds: readonly string[];
  readonly evidenceSha256: string;
}

export class ProviderModelRegistry {
  readonly #records = new Map<string, ProviderModelRecord>();
  readonly #active = new Map<string, string>();

  register(record: ProviderModelRecord): void {
    const key = this.#key(record.providerId, record.modelId, record.modelVersion);
    const versions = [...this.#records.values()].filter((item) => item.providerId === record.providerId && item.modelId === record.modelId);
    if (
      !/^[a-z][a-z0-9-]+$/u.test(record.providerId)
      || record.modelId.trim() === ""
      || record.modelVersion.trim() === ""
      || record.operations.length === 0
      || record.regions.length === 0
      || record.purposes.length === 0
      || !Number.isSafeInteger(record.retentionDays)
      || record.retentionDays < 0
      || !Number.isSafeInteger(record.priceMinorPerUnit)
      || record.priceMinorPerUnit < 0
      || record.slo.p95LatencyMs < 1
      || record.slo.availabilityBasisPoints < 1
      || record.slo.availabilityBasisPoints > 10_000
      || record.allowedScenarios.length === 0
      || this.#records.has(key)
    ) {
      throw new OrchestrationError("VALIDATION_FAILED", "provider model registry record is invalid or duplicated");
    }
    if (versions.length > 0) {
      const review = record.review;
      if (
        review === undefined
        || !versions.some((item) => item.modelVersion === review.previousVersion)
        || !review.qualityPassed
        || !review.safetyPassed
        || !review.costApproved
        || !review.contractApproved
        || review.reviewerIds.length < 2
        || !strictUtc(review.reviewedAt)
        || !digest(review.evidenceSha256)
      ) {
        throw new OrchestrationError("AUTHORIZATION_FAILED", "provider model version change lacks independent quality, safety, cost, and contract review");
      }
    }
    this.#records.set(key, Object.freeze(structuredClone(record)));
  }

  activate(providerId: string, modelId: string, modelVersion: string): void {
    const record = this.get(providerId, modelId, modelVersion);
    if (record.trainingUseAllowed) {
      throw new OrchestrationError("AUTHORIZATION_FAILED", "training-enabled provider models cannot be activated for participant media");
    }
    this.#active.set(`${providerId}:${modelId}`, modelVersion);
  }

  get(providerId: string, modelId: string, modelVersion?: string): ProviderModelRecord {
    const resolvedVersion = modelVersion ?? this.#active.get(`${providerId}:${modelId}`);
    if (resolvedVersion === undefined) throw new OrchestrationError("CONFLICT", "provider model has no active version");
    const value = this.#records.get(this.#key(providerId, modelId, resolvedVersion));
    if (value === undefined) throw new OrchestrationError("CONFLICT", "provider model version is not registered");
    return structuredClone(value);
  }

  #key(providerId: string, modelId: string, modelVersion: string): string {
    return `${providerId}:${modelId}:${modelVersion}`;
  }
}

export interface ProviderCommand {
  readonly operation: ProviderOperation;
  readonly providerIdempotencyKey: string;
  readonly requestSha256: string;
  readonly inputAssetSha256?: string;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  readonly abortSignal: AbortSignal;
}

export interface ProviderResponse {
  readonly status: "succeeded" | "rejected";
  readonly providerOperationId: string;
  readonly outputArtifactSha256?: string;
  readonly safetyArtifactSha256?: string;
  readonly billedMinor: number;
  readonly errorCategory?: ProviderErrorCategory;
  readonly errorCode?: string;
}

export interface ProviderAdapter {
  execute(command: ProviderCommand): Promise<ProviderResponse>;
  cancel(input: { providerOperationId: string; providerIdempotencyKey: string }): Promise<{ cancelled: boolean; receiptSha256: string }>;
  delete(input: { providerOperationId: string; providerIdempotencyKey: string }): Promise<{ deleted: boolean; receiptSha256: string }>;
}

export interface ProviderExecutionRequest extends RouteRequest {
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly operation: ProviderOperation;
  readonly modelId: string;
  readonly scenario: string;
  readonly authorizationArtifactSha256: string;
  readonly inputAssetSha256?: string;
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
  readonly timeoutMs: number;
}

export interface ProviderExecutionRecord {
  readonly id: string;
  readonly version: number;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly operation: ProviderOperation;
  readonly route: ProviderRoute;
  readonly modelId: string;
  readonly state: "intent_persisted" | "executing" | "succeeded" | "failed" | "cancelled" | "deleted" | "publishing" | "published";
  readonly attempt: number;
  readonly providerIdempotencyKey: string;
  readonly providerOperationId?: string;
  readonly outputArtifactSha256?: string;
  readonly safetyArtifactSha256?: string;
  readonly billedMinor?: number;
  readonly errorCategory?: ProviderErrorCategory;
  readonly errorCode?: string;
  readonly publicationReceiptSha256?: string;
  readonly updatedAt: string;
}

export interface ProviderExecutionStore {
  find(idempotencyKey: string): Promise<ProviderExecutionRecord | undefined>;
  create(record: ProviderExecutionRecord): Promise<void>;
  compareAndSwap(expectedVersion: number, record: ProviderExecutionRecord): Promise<void>;
}

export interface LateProviderResult {
  readonly providerId: string;
  readonly providerOperationId: string;
  readonly providerIdempotencyKey: string;
  readonly outputArtifactSha256: string;
  readonly observedAt: string;
  readonly state: "DELETED" | "QUARANTINED";
  readonly deletionReceiptSha256?: string;
}
export interface LateProviderResultJournal { record(value: LateProviderResult): Promise<void>; list(): Promise<readonly LateProviderResult[]>; }
export class InMemoryLateProviderResultJournal implements LateProviderResultJournal {
  readonly #values: LateProviderResult[] = [];
  async record(value: LateProviderResult): Promise<void> { this.#values.push(Object.freeze(structuredClone(value))); }
  async list(): Promise<readonly LateProviderResult[]> { return Object.freeze(structuredClone(this.#values)); }
}

/** Durable late-result quarantine journal. A late provider result is never
 * promoted to a user-visible artifact; it is recorded for deletion/reconcile. */
export class PostgresLateProviderResultJournal implements LateProviderResultJournal {
  constructor(readonly sql: SqlTransactionExecutor, readonly tenantId: string) {
    if (tenantId.trim() === "") throw new OrchestrationError("VALIDATION_FAILED", "late-result tenant is required");
  }
  async record(value: LateProviderResult): Promise<void> {
    await this.sql.transaction(async (client) => {
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [this.tenantId]);
      await client.query("INSERT INTO orchestration.late_provider_results (tenant_id,provider_id,provider_operation_id,provider_idempotency_key,output_artifact_sha256,observed_at,state,deletion_receipt_sha256) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8)", [this.tenantId, value.providerId, value.providerOperationId, value.providerIdempotencyKey, value.outputArtifactSha256, value.observedAt, value.state, value.deletionReceiptSha256 ?? null]);
    });
  }
  async list(): Promise<readonly LateProviderResult[]> {
    return this.sql.transaction(async (client) => {
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [this.tenantId]);
      const result = await client.query<{ provider_id: string; provider_operation_id: string; provider_idempotency_key: string; output_artifact_sha256: string; observed_at: string | Date; state: LateProviderResult["state"]; deletion_receipt_sha256?: string | null }>("SELECT provider_id,provider_operation_id,provider_idempotency_key,output_artifact_sha256,observed_at,state,deletion_receipt_sha256 FROM orchestration.late_provider_results WHERE tenant_id=$1 ORDER BY id", [this.tenantId]);
      return Object.freeze(result.rows.map((row) => ({ providerId: row.provider_id, providerOperationId: row.provider_operation_id, providerIdempotencyKey: row.provider_idempotency_key, outputArtifactSha256: row.output_artifact_sha256, observedAt: row.observed_at instanceof Date ? row.observed_at.toISOString() : new Date(row.observed_at).toISOString(), state: row.state, ...(row.deletion_receipt_sha256 == null ? {} : { deletionReceiptSha256: row.deletion_receipt_sha256 }) })));
    });
  }
}

export class InMemoryProviderExecutionStore implements ProviderExecutionStore {
  readonly #records = new Map<string, ProviderExecutionRecord>();
  async find(key: string): Promise<ProviderExecutionRecord | undefined> {
    const value = this.#records.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }
  async create(record: ProviderExecutionRecord): Promise<void> {
    if (this.#records.has(record.idempotencyKey)) throw new OrchestrationError("CONFLICT", "provider intent already exists");
    this.#records.set(record.idempotencyKey, structuredClone(record));
  }
  async compareAndSwap(expectedVersion: number, record: ProviderExecutionRecord): Promise<void> {
    const prior = this.#records.get(record.idempotencyKey);
    if (prior === undefined || prior.version !== expectedVersion || record.version !== expectedVersion + 1) {
      throw new OrchestrationError("CONFLICT", "provider intent compare-and-swap failed");
    }
    this.#records.set(record.idempotencyKey, structuredClone(record));
  }
}

export class PostgresProviderExecutionStore implements ProviderExecutionStore {
  constructor(readonly sql: SqlTransactionExecutor, readonly tenantId: string) {
    if (tenantId.trim() === "") throw new OrchestrationError("VALIDATION_FAILED", "provider execution tenant is required");
  }
  async find(idempotencyKey: string): Promise<ProviderExecutionRecord | undefined> {
    return this.#tenant(async (client) => {
      const result = await client.query<{ record: unknown }>("SELECT record FROM orchestration.provider_executions WHERE tenant_id=$1 AND idempotency_key=$2", [this.tenantId, idempotencyKey]);
      const value = result.rows[0]?.record;
      return value === undefined ? undefined : parseProviderRecord(value);
    });
  }
  async create(record: ProviderExecutionRecord): Promise<void> {
    if (record.tenantId !== this.tenantId) throw new OrchestrationError("AUTHORIZATION_FAILED", "cross-tenant provider persistence is forbidden");
    await this.#tenant(async (client) => {
      try { await client.query("INSERT INTO orchestration.provider_executions (idempotency_key,tenant_id,version,record,updated_at) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)", [record.idempotencyKey, this.tenantId, record.version, JSON.stringify(record), record.updatedAt]); }
      catch (error) { if (postgresCode(error) === "23505") throw new OrchestrationError("CONFLICT", "provider intent already exists"); throw error; }
    });
  }
  async compareAndSwap(expectedVersion: number, record: ProviderExecutionRecord): Promise<void> {
    if (record.tenantId !== this.tenantId || record.version !== expectedVersion + 1) throw new OrchestrationError("CONFLICT", "provider intent compare-and-swap version is invalid");
    await this.#tenant(async (client) => {
      const result = await client.query("UPDATE orchestration.provider_executions SET version=$3,record=$4::jsonb,updated_at=$5::timestamptz WHERE tenant_id=$1 AND idempotency_key=$2 AND version=$6", [this.tenantId, record.idempotencyKey, record.version, JSON.stringify(record), record.updatedAt, expectedVersion]);
      if (result.rowCount !== 1) throw new OrchestrationError("CONFLICT", "provider intent compare-and-swap failed");
    });
  }
  async #tenant<T>(operation: (client: import("./durable-runtime.js").SqlClient) => Promise<T>): Promise<T> { return this.sql.transaction(async (client) => { await client.query("SELECT set_config('app.tenant_id',$1,true)", [this.tenantId]); return operation(client); }); }
}

function parseProviderRecord(value: unknown): ProviderExecutionRecord {
  const parsed = typeof value === "string" ? JSON.parse(value) as ProviderExecutionRecord : value as ProviderExecutionRecord;
  if (parsed === null || typeof parsed !== "object" || typeof parsed.idempotencyKey !== "string" || typeof parsed.version !== "number") throw new OrchestrationError("DEPENDENCY_FAILED", "stored provider execution record is invalid");
  return structuredClone(parsed);
}
function postgresCode(value: unknown): string | undefined { return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string" ? value.code : undefined; }

export class ProviderExecutionService {
  constructor(
    readonly controlPlane: ProviderControlPlane,
    readonly registry: ProviderModelRegistry,
    readonly adapters: ReadonlyMap<string, ProviderAdapter>,
    readonly store: ProviderExecutionStore,
    readonly now: () => Date = () => new Date(),
    readonly lateResults: LateProviderResultJournal = new InMemoryLateProviderResultJournal(),
    readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  async execute(request: ProviderExecutionRequest): Promise<ProviderExecutionRecord> {
    this.#validateRequest(request);
    const requestSha256 = sha256(stableJson(request));
    const prior = await this.store.find(request.idempotencyKey);
    if (prior !== undefined) {
      if (prior.requestSha256 !== requestSha256) throw new OrchestrationError("CONFLICT", "provider idempotency key was reused with a different request");
      if (["succeeded", "published", "cancelled", "deleted", "failed"].includes(prior.state)) return prior;
    }
    let current = prior ?? await this.#persistInitialIntent(request, requestSha256);
    const excluded = new Set<string>();
    for (let attempt = current.attempt + 1; attempt <= 3; attempt += 1) {
      const adapter = this.adapters.get(current.route.providerId);
      if (adapter === undefined) throw new OrchestrationError("DEPENDENCY_FAILED", "selected provider adapter is unavailable");
      current = await this.#update(current, { state: "executing", attempt });
      const response = await this.#invokeWithTimeout(current.route.providerId, adapter, {
        operation: request.operation,
        providerIdempotencyKey: current.providerIdempotencyKey,
        requestSha256,
        ...(request.inputAssetSha256 === undefined ? {} : { inputAssetSha256: request.inputAssetSha256 }),
        parameters: request.parameters,
      }, request.timeoutMs);
      const valid = this.#validResponse(response, request.operation);
      const succeeded = valid && response.status === "succeeded";
      this.controlPlane.complete(current.route.providerId, succeeded);
      if (succeeded) {
        return this.#update(current, {
          state: "succeeded",
          providerOperationId: response.providerOperationId,
          ...(response.outputArtifactSha256 === undefined ? {} : { outputArtifactSha256: response.outputArtifactSha256 }),
          ...(response.safetyArtifactSha256 === undefined ? {} : { safetyArtifactSha256: response.safetyArtifactSha256 }),
          billedMinor: response.billedMinor,
        });
      }
      const category = valid ? response.errorCategory ?? "internal" : "permanent_dependency";
      const retryable = category === "transient_dependency" || category === "internal";
      if (!retryable || attempt === 3) {
        return this.#update(current, { state: "failed", errorCategory: category, errorCode: valid ? response.errorCode ?? "PROVIDER_REJECTED" : "INVALID_PROVIDER_RESPONSE" });
      }
      await this.sleep(100 * 2 ** (attempt - 1));
      excluded.add(current.route.providerId);
      let nextRoute: ProviderRoute;
      try { nextRoute = this.controlPlane.route({ ...routeFields(request), requestId: `${request.requestId}:failover:${attempt}`, excludeProviderIds: [...excluded] }); }
      catch (error) {
        if (error instanceof OrchestrationError && error.code === "NO_ELIGIBLE_PROVIDER") return this.#update(current, { state: "failed", errorCategory: "transient_dependency", errorCode: "NO_COMPLIANT_FAILOVER" });
        throw error;
      }
      const nextKey = sha256(`${request.idempotencyKey}:${nextRoute.providerId}:${requestSha256}`);
      current = await this.#update(current, { state: "intent_persisted", route: nextRoute, providerIdempotencyKey: nextKey });
    }
    throw new OrchestrationError("DEPENDENCY_FAILED", "provider execution exhausted its bounded retry policy");
  }

  async publish(idempotencyKey: string, publisher: (input: { publicationId: string; outputArtifactSha256: string; safetyArtifactSha256: string }) => Promise<{ receiptSha256: string }>): Promise<ProviderExecutionRecord> {
    let current = await this.#required(idempotencyKey);
    if (current.state === "published") return current;
    if (current.state !== "succeeded" && current.state !== "publishing") throw new OrchestrationError("CONFLICT", "only a successful provider result can be published");
    if (current.outputArtifactSha256 === undefined || current.safetyArtifactSha256 === undefined) throw new OrchestrationError("DEPENDENCY_FAILED", "provider result lacks output or safety evidence");
    const outputArtifactSha256 = current.outputArtifactSha256;
    const safetyArtifactSha256 = current.safetyArtifactSha256;
    if (current.state === "succeeded") current = await this.#update(current, { state: "publishing" });
    const publicationId = sha256(`${current.id}:${outputArtifactSha256}`);
    const result = await publisher({ publicationId, outputArtifactSha256, safetyArtifactSha256 });
    if (!digest(result.receiptSha256)) throw new OrchestrationError("DEPENDENCY_FAILED", "publisher returned an invalid receipt");
    return this.#update(current, { state: "published", publicationReceiptSha256: result.receiptSha256 });
  }

  async cancel(idempotencyKey: string): Promise<ProviderExecutionRecord> {
    const current = await this.#required(idempotencyKey);
    if (current.state === "cancelled") return current;
    if (current.providerOperationId === undefined || !["executing", "succeeded"].includes(current.state)) throw new OrchestrationError("CONFLICT", "provider operation cannot be cancelled in its current state");
    const adapter = this.#adapter(current.route.providerId);
    const receipt = await adapter.cancel({ providerOperationId: current.providerOperationId, providerIdempotencyKey: `${current.providerIdempotencyKey}:cancel` });
    if (!receipt.cancelled || !digest(receipt.receiptSha256)) throw new OrchestrationError("DEPENDENCY_FAILED", "provider cancellation was not authoritatively confirmed");
    return this.#update(current, { state: "cancelled" });
  }

  async delete(idempotencyKey: string): Promise<ProviderExecutionRecord> {
    const current = await this.#required(idempotencyKey);
    if (current.state === "deleted") return current;
    if (current.providerOperationId === undefined || !["succeeded", "published", "cancelled"].includes(current.state)) throw new OrchestrationError("CONFLICT", "provider asset cannot be deleted in its current state");
    const adapter = this.#adapter(current.route.providerId);
    const receipt = await adapter.delete({ providerOperationId: current.providerOperationId, providerIdempotencyKey: `${current.providerIdempotencyKey}:delete` });
    if (!receipt.deleted || !digest(receipt.receiptSha256)) throw new OrchestrationError("DEPENDENCY_FAILED", "provider deletion was not authoritatively confirmed");
    return this.#update(current, { state: "deleted" });
  }

  async #persistInitialIntent(request: ProviderExecutionRequest, requestSha256: string): Promise<ProviderExecutionRecord> {
    const route = this.controlPlane.route(routeFields(request));
    const model = this.registry.get(route.providerId, request.modelId, route.providerVersion);
    if (!model.operations.includes(request.operation) || !model.allowedScenarios.includes(request.scenario) || !model.purposes.some((purpose) => request.requiredPurposes.includes(purpose))) {
      this.controlPlane.complete(route.providerId, false);
      throw new OrchestrationError("AUTHORIZATION_FAILED", "provider model is not approved for this operation, scenario, or purpose");
    }
    const record: ProviderExecutionRecord = Object.freeze({
      id: sha256(`${request.tenantId}:${request.idempotencyKey}`),
      version: 1,
      idempotencyKey: request.idempotencyKey,
      requestSha256,
      tenantId: request.tenantId,
      actorId: request.actorId,
      operation: request.operation,
      route,
      modelId: request.modelId,
      state: "intent_persisted",
      attempt: 0,
      providerIdempotencyKey: sha256(`${request.idempotencyKey}:${route.providerId}:${requestSha256}`),
      updatedAt: this.now().toISOString(),
    });
    await this.store.create(record);
    return record;
  }

  async #invokeWithTimeout(providerId: string, adapter: ProviderAdapter, command: Omit<ProviderCommand, "abortSignal">, timeoutMs: number): Promise<ProviderResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<ProviderResponse>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({ status: "rejected", providerOperationId: "timeout-unknown", billedMinor: 0, errorCategory: "transient_dependency", errorCode: "PROVIDER_TIMEOUT" });
      }, timeoutMs);
    });
    const execution = adapter.execute({ ...command, abortSignal: controller.signal });
    try {
      const result = await Promise.race([execution, timeout]);
      if (timedOut) {
        void execution.then(async (late) => {
          if (late.status !== "succeeded" || !digest(late.outputArtifactSha256)) return;
          let state: LateProviderResult["state"] = "QUARANTINED";
          let deletionReceiptSha256: string | undefined;
          try {
            const deletion = await adapter.delete({ providerOperationId: late.providerOperationId, providerIdempotencyKey: `${command.providerIdempotencyKey}:late-delete` });
            if (deletion.deleted && digest(deletion.receiptSha256)) { state = "DELETED"; deletionReceiptSha256 = deletion.receiptSha256; }
          } catch { /* the journal keeps the late artifact quarantined for operator reconciliation */ }
          await this.lateResults.record({ providerId, providerOperationId: late.providerOperationId, providerIdempotencyKey: command.providerIdempotencyKey, outputArtifactSha256: late.outputArtifactSha256, observedAt: this.now().toISOString(), state, ...(deletionReceiptSha256 === undefined ? {} : { deletionReceiptSha256 }) });
        }).catch(async () => { /* a late provider failure created no publishable artifact */ });
      }
      return result;
    } catch {
      return { status: "rejected", providerOperationId: "adapter-error-unknown", billedMinor: 0, errorCategory: "transient_dependency", errorCode: "PROVIDER_ADAPTER_ERROR" };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #validResponse(response: ProviderResponse, operation: ProviderOperation): boolean {
    if (response.providerOperationId.trim() === "" || !Number.isSafeInteger(response.billedMinor) || response.billedMinor < 0) return false;
    if (response.status === "rejected") return response.errorCategory !== undefined && response.errorCode !== undefined;
    if (operation === "delete_asset") return true;
    return digest(response.outputArtifactSha256) && digest(response.safetyArtifactSha256);
  }

  #validateRequest(request: ProviderExecutionRequest): void {
    if (
      request.idempotencyKey.length < 8
      || request.actorId.trim() === ""
      || !digest(request.authorizationArtifactSha256)
      || (request.inputAssetSha256 !== undefined && !digest(request.inputAssetSha256))
      || !Number.isSafeInteger(request.timeoutMs)
      || request.timeoutMs < 50
      || request.timeoutMs > 120_000
      || Object.keys(request.parameters).some((key) => /raw|image|prompt|secret|token/iu.test(key))
    ) throw new OrchestrationError("VALIDATION_FAILED", "provider execution request is invalid or contains prohibited raw fields");
  }

  async #required(idempotencyKey: string): Promise<ProviderExecutionRecord> {
    const value = await this.store.find(idempotencyKey);
    if (value === undefined) throw new OrchestrationError("CONFLICT", "provider intent does not exist");
    return value;
  }

  #adapter(providerId: string): ProviderAdapter {
    const value = this.adapters.get(providerId);
    if (value === undefined) throw new OrchestrationError("DEPENDENCY_FAILED", "provider adapter is unavailable");
    return value;
  }

  async #update(current: ProviderExecutionRecord, changes: Partial<Omit<ProviderExecutionRecord, "id" | "version" | "idempotencyKey" | "requestSha256" | "tenantId" | "actorId" | "operation" | "modelId">>): Promise<ProviderExecutionRecord> {
    const next = Object.freeze({ ...current, ...changes, version: current.version + 1, updatedAt: this.now().toISOString() });
    await this.store.compareAndSwap(current.version, next);
    return next;
  }
}

function routeFields(request: ProviderExecutionRequest): RouteRequest {
  return {
    tenantId: request.tenantId,
    subjectId: request.subjectId,
    capability: request.capability,
    region: request.region,
    participantMinor: request.participantMinor,
    dataCategories: request.dataCategories,
    consentPurposes: request.consentPurposes,
    requiredPurposes: request.requiredPurposes,
    units: request.units,
    maxCostMinor: request.maxCostMinor,
    maximumRetentionDays: request.maximumRetentionDays,
    requestId: request.requestId,
    ...(request.excludeProviderIds === undefined ? {} : { excludeProviderIds: request.excludeProviderIds }),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value: string | undefined): value is string {
  return value !== undefined && /^[a-f0-9]{64}$/u.test(value);
}

function strictUtc(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && new Date(value).toISOString() === value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
