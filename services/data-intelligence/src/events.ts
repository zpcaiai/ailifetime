import { clone, DataIntelligenceError, fingerprint, required, strictUtc, unique } from "./common.js";

export const EVENT_DOMAINS = [
  "user", "family", "generation", "media", "payment", "order", "partner",
  "notification", "support", "supply_chain", "security",
] as const;
export type EventDomain = (typeof EVENT_DOMAINS)[number];
export type TrackingChannel = "web" | "mobile" | "mini_program" | "server";
export type FieldType = "string" | "integer" | "number" | "boolean" | "utc_timestamp";
export type FieldClassification = "public" | "internal" | "confidential" | "restricted";

export interface EventField {
  readonly type: FieldType;
  readonly required: boolean;
  readonly classification: FieldClassification;
  readonly purposes: readonly string[];
}

export interface EventSchema {
  readonly name: string;
  readonly domain: EventDomain;
  readonly version: number;
  readonly owner: string;
  readonly producer: string;
  readonly trigger: string;
  readonly dedupeField: string;
  readonly consentPurpose: string;
  readonly retentionDays: number;
  readonly fields: Readonly<Record<string, EventField>>;
}

export interface RegisteredEventSchema extends EventSchema {
  readonly schemaFingerprint: string;
  readonly dualWritePreviousVersion?: number;
}

export interface TrackingContext {
  readonly environment: "local" | "test" | "sandbox" | "staging" | "production";
  readonly applicationVersion: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly traceId: string;
}

export interface TrackingEnvelope {
  readonly eventId: string;
  readonly name: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly channel: TrackingChannel;
  readonly context: TrackingContext;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly schemaFingerprint: string;
  readonly clockSkew: boolean;
}

export type DeliveryState = "DELIVERED" | "QUEUED_OFFLINE" | "DUPLICATE" | "BLOCKED" | "RETRY_SCHEDULED" | "DEAD_LETTERED";

export interface TrackingReceipt {
  readonly eventId: string;
  readonly state: DeliveryState;
  readonly reason?: string;
}

export interface TrackingTelemetry {
  readonly duplicates: number;
  readonly clockSkew: number;
  readonly blocked: number;
  /** Events are never intentionally discarded. This remains zero and is retained for dashboard compatibility. */
  readonly lost: 0;
  readonly offlineQueued: number;
  readonly retriesScheduled: number;
  readonly deadLettered: number;
}

export interface QueuedTrackingEvent {
  readonly tenantId: string;
  readonly eventId: string;
  readonly payloadSha256: string;
  readonly envelope: TrackingEnvelope;
  readonly state: "PENDING" | "IN_FLIGHT" | "DELIVERED" | "DEAD_LETTERED";
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly leaseOwner?: string;
  readonly leaseUntil?: string;
  readonly lastError?: string;
}

export interface TrackingQueueRepository {
  readonly durable: boolean;
  enqueue(event: QueuedTrackingEvent): Promise<"ENQUEUED" | "DUPLICATE" | "CONFLICT">;
  claimDue(input: {
    readonly tenantId: string;
    readonly workerId: string;
    readonly now: string;
    readonly leaseUntil: string;
    readonly limit: number;
    readonly eventId?: string;
  }): Promise<readonly QueuedTrackingEvent[]>;
  markDelivered(input: { readonly tenantId: string; readonly eventId: string; readonly payloadSha256: string; readonly workerId: string }): Promise<void>;
  scheduleRetry(input: {
    readonly tenantId: string;
    readonly eventId: string;
    readonly payloadSha256: string;
    readonly workerId: string;
    readonly nextAttemptAt: string;
    readonly reason: string;
    readonly deadLettered: boolean;
  }): Promise<void>;
}

export class InMemoryTrackingQueueRepository implements TrackingQueueRepository {
  readonly durable = false;
  readonly #events = new Map<string, QueuedTrackingEvent>();

  async enqueue(event: QueuedTrackingEvent): Promise<"ENQUEUED" | "DUPLICATE" | "CONFLICT"> {
    const key = trackingKey(event.tenantId, event.eventId);
    const prior = this.#events.get(key);
    if (prior !== undefined) return prior.payloadSha256 === event.payloadSha256 ? "DUPLICATE" : "CONFLICT";
    this.#events.set(key, Object.freeze(clone(event)));
    return "ENQUEUED";
  }

  async claimDue(input: { readonly tenantId: string; readonly workerId: string; readonly now: string; readonly leaseUntil: string; readonly limit: number; readonly eventId?: string }): Promise<readonly QueuedTrackingEvent[]> {
    const nowMs = Date.parse(strictUtc(input.now, "claim now"));
    strictUtc(input.leaseUntil, "claim leaseUntil");
    const claimed: QueuedTrackingEvent[] = [];
    for (const [key, event] of [...this.#events.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (claimed.length >= input.limit || event.tenantId !== input.tenantId || (input.eventId !== undefined && event.eventId !== input.eventId) ||
          event.state === "DELIVERED" || event.state === "DEAD_LETTERED" || Date.parse(event.nextAttemptAt) > nowMs ||
          (event.state === "IN_FLIGHT" && event.leaseUntil !== undefined && Date.parse(event.leaseUntil) > nowMs)) continue;
      const next = Object.freeze({ ...event, state: "IN_FLIGHT" as const, attempts: event.attempts + 1, leaseOwner: input.workerId, leaseUntil: input.leaseUntil });
      this.#events.set(key, next); claimed.push(clone(next));
    }
    return Object.freeze(claimed);
  }

  async markDelivered(input: { readonly tenantId: string; readonly eventId: string; readonly payloadSha256: string; readonly workerId: string }): Promise<void> {
    this.#transition(input, (event) => {
      const { leaseOwner: _leaseOwner, leaseUntil: _leaseUntil, lastError: _lastError, ...stable } = event;
      return Object.freeze({ ...stable, state: "DELIVERED" as const });
    });
  }

  async scheduleRetry(input: { readonly tenantId: string; readonly eventId: string; readonly payloadSha256: string; readonly workerId: string; readonly nextAttemptAt: string; readonly reason: string; readonly deadLettered: boolean }): Promise<void> {
    strictUtc(input.nextAttemptAt, "retry nextAttemptAt");
    this.#transition(input, (event) => {
      const { leaseOwner: _leaseOwner, leaseUntil: _leaseUntil, lastError: _lastError, ...stable } = event;
      return Object.freeze({ ...stable, state: input.deadLettered ? "DEAD_LETTERED" as const : "PENDING" as const, nextAttemptAt: input.nextAttemptAt, lastError: input.reason.slice(0, 512) });
    });
  }

  snapshot(): readonly QueuedTrackingEvent[] { return Object.freeze([...this.#events.values()].map(clone)); }

  #transition(input: { readonly tenantId: string; readonly eventId: string; readonly payloadSha256: string; readonly workerId: string }, update: (event: QueuedTrackingEvent) => QueuedTrackingEvent): void {
    const key = trackingKey(input.tenantId, input.eventId); const event = this.#events.get(key);
    if (event === undefined || event.payloadSha256 !== input.payloadSha256 || event.state !== "IN_FLIGHT" || event.leaseOwner !== input.workerId) {
      throw new DataIntelligenceError("CONFLICT", "tracking delivery lease or payload binding changed");
    }
    this.#events.set(key, update(event));
  }
}

const classificationRank: Record<FieldClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export class EventSchemaRegistry {
  readonly #schemas = new Map<string, RegisteredEventSchema>();

  register(input: EventSchema, options: { readonly dualWritePreviousVersion?: number } = {}): RegisteredEventSchema {
    validateSchema(input);
    const key = schemaKey(input.name, input.version);
    if (this.#schemas.has(key)) throw new DataIntelligenceError("CONFLICT", `event schema ${key} already exists`);
    const previous = this.latest(input.name);
    if (previous !== undefined) {
      if (input.version !== previous.version + 1) throw new DataIntelligenceError("SCHEMA_INCOMPATIBLE", "event schema versions must be contiguous");
      assertCompatible(previous, input, options.dualWritePreviousVersion);
    } else if (input.version !== 1) {
      throw new DataIntelligenceError("SCHEMA_INCOMPATIBLE", "first event schema version must be 1");
    }
    const registered: RegisteredEventSchema = Object.freeze({
      ...clone(input),
      fields: Object.freeze(clone(input.fields)),
      schemaFingerprint: fingerprint(input),
      ...(options.dualWritePreviousVersion === undefined ? {} : { dualWritePreviousVersion: options.dualWritePreviousVersion }),
    });
    this.#schemas.set(key, registered);
    return registered;
  }

  get(name: string, version: number): RegisteredEventSchema {
    const schema = this.#schemas.get(schemaKey(name, version));
    if (schema === undefined) throw new DataIntelligenceError("NOT_FOUND", `event schema ${name}@${version} is not registered`);
    return schema;
  }

  latest(name: string): RegisteredEventSchema | undefined {
    return [...this.#schemas.values()]
      .filter((schema) => schema.name === name)
      .sort((left, right) => right.version - left.version)[0];
  }

  validate(name: string, version: number, payload: Readonly<Record<string, unknown>>, grantedPurposes: readonly string[]): RegisteredEventSchema {
    const schema = this.get(name, version);
    if (!grantedPurposes.includes(schema.consentPurpose)) {
      throw new DataIntelligenceError("CONSENT_REQUIRED", `event ${name} requires purpose ${schema.consentPurpose}`);
    }
    const known = new Set(Object.keys(schema.fields));
    for (const key of Object.keys(payload)) {
      if (!known.delete(key)) throw new DataIntelligenceError("VALIDATION_FAILED", `event ${name} contains unknown field ${key}`);
    }
    for (const [fieldName, field] of Object.entries(schema.fields)) {
      const value = payload[fieldName];
      if (value === undefined) {
        if (field.required) throw new DataIntelligenceError("VALIDATION_FAILED", `event ${name} is missing ${fieldName}`);
        continue;
      }
      validateField(fieldName, field.type, value);
      if (!field.purposes.every((purpose) => grantedPurposes.includes(purpose))) {
        throw new DataIntelligenceError("CONSENT_REQUIRED", `event field ${fieldName} lacks a granted purpose`);
      }
    }
    return schema;
  }

  catalog(): readonly RegisteredEventSchema[] {
    return Object.freeze([...this.#schemas.values()].sort((left, right) => schemaKey(left.name, left.version).localeCompare(schemaKey(right.name, right.version))));
  }
}

export interface TrackingTransport {
  deliver(envelope: TrackingEnvelope): Promise<{ readonly accepted: boolean; readonly retryable?: boolean; readonly reason?: string }>;
}

export class TrackingClient {
  readonly #telemetry = { duplicates: 0, clockSkew: 0, blocked: 0, lost: 0 as const, offlineQueued: 0, retriesScheduled: 0, deadLettered: 0 };
  #online = true;

  constructor(
    readonly channel: TrackingChannel,
    readonly context: TrackingContext,
    readonly registry: EventSchemaRegistry,
    readonly transport: TrackingTransport,
    readonly now: () => Date = () => new Date(),
    readonly queue: TrackingQueueRepository = new InMemoryTrackingQueueRepository(),
    readonly workerId = `tracking-${context.applicationVersion}-${context.sessionId}`,
  ) {
    for (const value of Object.values(context)) required(value, "tracking context");
    if (context.environment === "production" && !queue.durable) throw new DataIntelligenceError("POLICY_BLOCKED", "production tracking requires a durable queue repository");
  }

  setOnline(online: boolean): void {
    this.#online = online;
  }

  async track(input: {
    readonly eventId: string;
    readonly name: string;
    readonly version: number;
    readonly occurredAt: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly grantedPurposes: readonly string[];
  }): Promise<TrackingReceipt> {
    required(input.eventId, "eventId");
    let schema: RegisteredEventSchema;
    try {
      schema = this.registry.validate(input.name, input.version, input.payload, input.grantedPurposes);
    } catch (error) {
      this.#telemetry.blocked += 1;
      throw error;
    }
    const occurredAt = strictUtc(input.occurredAt, "occurredAt");
    const receivedAt = this.now().toISOString();
    const skew = Math.abs(Date.parse(receivedAt) - Date.parse(occurredAt)) > 5 * 60_000;
    const envelope: TrackingEnvelope = Object.freeze({
      eventId: input.eventId,
      name: input.name,
      version: input.version,
      occurredAt,
      receivedAt,
      channel: this.channel,
      context: Object.freeze(clone(this.context)),
      payload: Object.freeze(clone(input.payload)),
      schemaFingerprint: schema.schemaFingerprint,
      clockSkew: skew,
    });
    const payloadSha256 = fingerprint({
      eventId: input.eventId, name: input.name, version: input.version, occurredAt,
      channel: this.channel, context: this.context, payload: input.payload, schemaFingerprint: schema.schemaFingerprint,
    });
    const queued: QueuedTrackingEvent = Object.freeze({
      tenantId: this.context.tenantId, eventId: input.eventId, payloadSha256, envelope,
      state: "PENDING", attempts: 0, nextAttemptAt: receivedAt,
    });
    const enqueued = await this.queue.enqueue(queued);
    if (enqueued === "CONFLICT") throw new DataIntelligenceError("CONFLICT", "event id was reused with a changed tracking payload or binding");
    if (enqueued === "DUPLICATE") {
      this.#telemetry.duplicates += 1;
      return Object.freeze({ eventId: input.eventId, state: "DUPLICATE" });
    }
    if (skew) this.#telemetry.clockSkew += 1;
    if (!this.#online) {
      this.#telemetry.offlineQueued += 1;
      return Object.freeze({ eventId: input.eventId, state: "QUEUED_OFFLINE" });
    }
    const [claimed] = await this.queue.claimDue({ tenantId: this.context.tenantId, workerId: this.workerId, now: receivedAt, leaseUntil: new Date(this.now().getTime() + 30_000).toISOString(), limit: 1, eventId: input.eventId });
    if (claimed === undefined) throw new DataIntelligenceError("CONFLICT", "new tracking event could not be claimed for delivery");
    return this.#deliver(claimed);
  }

  async flush(limit = 100): Promise<readonly TrackingReceipt[]> {
    if (!this.#online) return Object.freeze([]);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new DataIntelligenceError("VALIDATION_FAILED", "tracking flush limit is invalid");
    const receipts: TrackingReceipt[] = [];
    const at = this.now();
    const claimed = await this.queue.claimDue({ tenantId: this.context.tenantId, workerId: this.workerId, now: at.toISOString(), leaseUntil: new Date(at.getTime() + 30_000).toISOString(), limit });
    for (const event of claimed) receipts.push(await this.#deliver(event));
    return Object.freeze(receipts);
  }

  telemetry(): TrackingTelemetry {
    return Object.freeze({ ...this.#telemetry });
  }

  async #deliver(event: QueuedTrackingEvent): Promise<TrackingReceipt> {
    let accepted = false; let retryable = true; let reason = "tracking transport failed without a reason";
    try {
      const result = await this.transport.deliver(event.envelope);
      accepted = result.accepted; retryable = result.retryable ?? true; reason = result.reason ?? (accepted ? "accepted" : "transport rejected event");
    } catch (error) {
      reason = error instanceof Error ? error.message : "tracking transport threw a non-error value";
    }
    if (accepted) {
      await this.queue.markDelivered({ tenantId: event.tenantId, eventId: event.eventId, payloadSha256: event.payloadSha256, workerId: this.workerId });
      return Object.freeze({ eventId: event.eventId, state: "DELIVERED" });
    }
    const deadLettered = !retryable || event.attempts >= 8;
    const delayMs = Math.min(15 * 60_000, 1_000 * 2 ** Math.max(0, event.attempts - 1));
    const nextAttemptAt = new Date(this.now().getTime() + delayMs).toISOString();
    await this.queue.scheduleRetry({ tenantId: event.tenantId, eventId: event.eventId, payloadSha256: event.payloadSha256, workerId: this.workerId, nextAttemptAt, reason, deadLettered });
    if (deadLettered) this.#telemetry.deadLettered += 1; else this.#telemetry.retriesScheduled += 1;
    return Object.freeze({ eventId: event.eventId, state: deadLettered ? "DEAD_LETTERED" : "RETRY_SCHEDULED", reason });
  }
}

function trackingKey(tenantId: string, eventId: string): string { return `${tenantId}\u0000${eventId}`; }

function schemaKey(name: string, version: number): string {
  return `${name}@${version}`;
}

function validateSchema(schema: EventSchema): void {
  if (!/^ltm\.(?:user|family|generation|media|payment|order|partner|notification|support|supply_chain|security)\.[a-z][a-z0-9_]*$/u.test(schema.name)) {
    throw new DataIntelligenceError("VALIDATION_FAILED", "event name does not follow the owned taxonomy");
  }
  if (schema.name.split(".")[1] !== schema.domain) throw new DataIntelligenceError("VALIDATION_FAILED", "event domain does not match its name");
  if (!Number.isSafeInteger(schema.version) || schema.version < 1) throw new DataIntelligenceError("VALIDATION_FAILED", "event version is invalid");
  required(schema.owner, "owner");
  required(schema.producer, "producer");
  required(schema.trigger, "trigger");
  required(schema.dedupeField, "dedupeField");
  required(schema.consentPurpose, "consentPurpose");
  if (!Number.isSafeInteger(schema.retentionDays) || schema.retentionDays < 1 || schema.retentionDays > 3650) {
    throw new DataIntelligenceError("VALIDATION_FAILED", "retentionDays is invalid");
  }
  const names = Object.keys(schema.fields);
  if (names.length === 0 || !names.includes(schema.dedupeField)) throw new DataIntelligenceError("VALIDATION_FAILED", "event fields must contain the dedupe field");
  for (const [name, field] of Object.entries(schema.fields)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(name)) throw new DataIntelligenceError("VALIDATION_FAILED", `event field ${name} is invalid`);
    unique(field.purposes, `${name}.purposes`);
    if (field.classification === "restricted" && !field.purposes.includes(schema.consentPurpose)) {
      throw new DataIntelligenceError("CONSENT_REQUIRED", `restricted field ${name} must be bound to the event consent purpose`);
    }
  }
}

function assertCompatible(previous: RegisteredEventSchema, next: EventSchema, dualWritePreviousVersion: number | undefined): void {
  if (previous.domain !== next.domain || previous.owner !== next.owner || previous.producer !== next.producer) {
    throw new DataIntelligenceError("SCHEMA_INCOMPATIBLE", "event ownership or producer changed");
  }
  for (const [name, field] of Object.entries(previous.fields)) {
    const candidate = next.fields[name];
    if (candidate === undefined || candidate.type !== field.type || (field.required && !candidate.required)) {
      throw new DataIntelligenceError("SCHEMA_INCOMPATIBLE", `event field ${name} was removed or weakened`);
    }
    if (classificationRank[candidate.classification] < classificationRank[field.classification]) {
      throw new DataIntelligenceError("SCHEMA_INCOMPATIBLE", `event field ${name} classification was weakened`);
    }
  }
  const newRequired = Object.entries(next.fields).some(([name, field]) => previous.fields[name] === undefined && field.required);
  if (newRequired && dualWritePreviousVersion !== previous.version) {
    throw new DataIntelligenceError("SCHEMA_INCOMPATIBLE", "new required fields require an explicit previous-version dual-write window");
  }
}

function validateField(name: string, type: FieldType, value: unknown): void {
  if (type === "string" && typeof value === "string" && value.length > 0) return;
  if (type === "boolean" && typeof value === "boolean") return;
  if (type === "integer" && Number.isSafeInteger(value)) return;
  if (type === "number" && typeof value === "number" && Number.isFinite(value)) return;
  if (type === "utc_timestamp" && typeof value === "string") {
    strictUtc(value, name);
    return;
  }
  throw new DataIntelligenceError("VALIDATION_FAILED", `event field ${name} has the wrong type`);
}
