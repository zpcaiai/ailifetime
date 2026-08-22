import { createHash } from "node:crypto";
import { DomainError } from "@ltm/core";
import type {
  ConsentRequirement,
  GrantorCapacity,
  JsonObject as CoreJsonObject,
  LedgerLine,
  LifeTimeMachineRuntimePort,
  RecordEnvelope,
} from "@ltm/core";
import type { CapabilityDefinition, CapabilityInvocation, CapabilityMode, CapabilityRegistry, JsonObject, JsonValue } from "../registry.js";
import { requirementIds } from "../registry.js";

export type DomainValidator = (input: JsonObject, invocation: CapabilityInvocation) => JsonObject;
export type ConsentResolver = (
  data: JsonObject,
  invocation: CapabilityInvocation,
) => ConsentRequirement | readonly ConsentRequirement[] | undefined;
export type ExternalEvidenceScopeResolver = (data: JsonObject, invocation: CapabilityInvocation) => string;

export interface DomainCapabilityOptions {
  readonly permission?: string;
  readonly sensitive?: boolean;
  /** Provider-authenticated facts must enter through API external-event.apply, never this legacy capability shape. */
  readonly trustedExternalEventOnly?: boolean;
  readonly requiresExternalEvidence?: boolean;
  readonly externalEvidenceScope?: ExternalEvidenceScopeResolver;
  readonly consent?: ConsentResolver;
  readonly mode: CapabilityMode;
  readonly collection?: string;
  readonly recordIdField?: string;
  readonly recordId?: (data: JsonObject, invocation: CapabilityInvocation) => string;
  readonly transition?: {
    readonly fromField: string;
    readonly toField: string;
    readonly stateField: string;
    readonly initialFromStates: readonly string[];
  };
}

export type DomainCapabilityDefinition = CapabilityDefinition;

export function defineCapability(
  batchId: CapabilityDefinition["batchId"],
  skill: string,
  operation: string,
  validate: DomainValidator,
  options: DomainCapabilityOptions,
): DomainCapabilityDefinition {
  return {
    batchId,
    skill,
    operation,
    mode: options.mode,
    requirements: requirementIds(batchId),
    ...(options.requiresExternalEvidence ? { requiresExternalEvidence: true } : {}),
    async execute(runtime, invocation) {
      assertInvocation(invocation);
      assertActorTenant(invocation.input, invocation);
      runtime.authorize(invocation.actor, options.permission ?? "record:create", {
        tenantId: invocation.actor.tenantId,
        sensitive: options.sensitive ?? false,
      });

      if (options.trustedExternalEventOnly === true) {
        throw new DomainError(
          "AUTH_FORBIDDEN",
          `${batchId} provider facts can only be written through the signed external-event.apply path`,
          { details: { batchId, operation } },
        );
      }

      const data = validate(invocation.input, invocation);
      // Resolve all local policy gates before consuming potentially single-use evidence.
      await requireResolvedConsent(runtime, invocation, data, options.consent);
      await requireExternalEvidence(runtime, invocation, options, batchId, operation, invocation.input, data);

      if (options.mode === "consent-write") {
        return persistConsent(runtime, invocation, batchId, skill, operation, data);
      }
      if (options.mode === "ledger-post") {
        return persistLedger(runtime, invocation, batchId, operation, data);
      }
      if (options.mode === "partner-settlement-ledger") {
        return persistPartnerSettlement(runtime, invocation, batchId, operation, data);
      }
      if (options.mode === "inbox-event") {
        return persistInboxEvent(runtime, invocation, batchId, operation, data);
      }
      if (options.mode === "state-transition") {
        return persistStateTransition(runtime, invocation, batchId, skill, operation, data, options);
      }
      if (options.mode === "external-command") {
        return persistExternalCommand(runtime, invocation, batchId, skill, operation, data, options);
      }
      return persistRecord(runtime, invocation, batchId, skill, operation, data, options);
    },
  };
}

export function registerDefinitions(
  registry: CapabilityRegistry,
  definitions: readonly DomainCapabilityDefinition[],
): void {
  for (const definition of definitions) registry.register(definition);
}

export function assertActorTenant(input: JsonObject, invocation: CapabilityInvocation): string {
  const tenantId = input.tenantId;
  if (tenantId !== undefined && tenantId !== invocation.actor.tenantId) {
    throw new DomainError("TENANT_SCOPE_MISMATCH", "tenantId does not match the authenticated actor");
  }
  return invocation.actor.tenantId;
}

export function assertKnownState<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) {
    throw new DomainError("VALIDATION_FAILED", `${field} has an unknown or illegal state`, {
      details: { field, value, allowed: [...allowed] },
    });
  }
  return value as T;
}

export function assertISODate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new DomainError("VALIDATION_FAILED", `${field} must be an ISO-8601 UTC timestamp`, { details: { field } });
  }
  return value;
}

export function requireNonEmptyObject(input: JsonObject, field: string): JsonObject {
  const value = input[field];
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new DomainError("VALIDATION_FAILED", `${field} must be a non-empty object`, { details: { field } });
  }
  return value as JsonObject;
}

export function requireInteger(value: number, field: string, minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DomainError("VALIDATION_FAILED", `${field} must be an integer in range`, {
      details: { field, minimum, maximum },
    });
  }
  return value;
}

export function requireTrue(value: boolean, field: string, message?: string): true {
  if (!value) {
    throw new DomainError("VALIDATION_FAILED", message ?? `${field} must be true`, { details: { field } });
  }
  return true;
}

/**
 * Reject legacy client-authored assertions that previously stood in for a
 * provider callback, control-plane decision, or independent attestation.
 */
export function rejectClientAssertions(input: JsonObject, fields: readonly string[]): void {
  const supplied = fields.filter((field) => Object.prototype.hasOwnProperty.call(input, field));
  if (supplied.length > 0) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Client assertions cannot replace server-verified external evidence",
      { details: { fields: supplied } },
    );
  }
}

export function jsonStringList(value: JsonValue | undefined, field: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new DomainError("VALIDATION_FAILED", `${field} must be a string array`, { details: { field } });
  }
  const result = value as string[];
  if (result.length < minimum || new Set(result).size !== result.length) {
    throw new DomainError("VALIDATION_FAILED", `${field} must contain at least ${minimum} unique values`, {
      details: { field, minimum },
    });
  }
  return [...result];
}

export function participantConsent(
  participantIdsField = "participantIds",
  purposeField = "purpose",
): ConsentResolver {
  return (data, invocation) => {
    const participantIds = jsonStringList(data[participantIdsField], participantIdsField, 1);
    const purposeValue = data[purposeField];
    const purpose = typeof purposeValue === "string" ? purposeValue : invocation.actor.purpose;
    return { participantIds, purpose };
  };
}

function assertInvocation(invocation: CapabilityInvocation): void {
  if (invocation.idempotencyKey.trim() === "") {
    throw new DomainError("VALIDATION_FAILED", "idempotencyKey is required", { details: { field: "idempotencyKey" } });
  }
  if (
    invocation.actor.actorId.trim() === "" ||
    invocation.actor.tenantId.trim() === "" ||
    invocation.actor.requestId.trim() === "" ||
    invocation.actor.purpose.trim() === ""
  ) {
    throw new DomainError("AUTH_UNAUTHENTICATED", "authenticated actor context is incomplete");
  }
}

function requireResolvedConsent(
  runtime: LifeTimeMachineRuntimePort,
  invocation: CapabilityInvocation,
  data: JsonObject,
  resolve: ConsentResolver | undefined,
): Promise<void> {
  if (!resolve) return Promise.resolve();
  const resolved = resolve(data, invocation);
  if (!resolved) {
    throw new DomainError("CONSENT_REQUIRED", "consent requirement could not be resolved");
  }
  const requirements = Array.isArray(resolved) ? resolved : [resolved];
  if (requirements.length === 0) return Promise.resolve();
  return Promise.all(requirements.map((requirement) => runtime.requireConsent(invocation.actor, requirement))).then(() => undefined);
}

async function requireExternalEvidence(
  runtime: LifeTimeMachineRuntimePort,
  invocation: CapabilityInvocation,
  options: DomainCapabilityOptions,
  batchId: CapabilityDefinition["batchId"],
  operation: string,
  input: JsonObject,
  data: JsonObject,
): Promise<void> {
  if (!options.requiresExternalEvidence) return;
  const evidence = data.externalEvidenceIds ?? input.externalEvidenceIds;
  const evidenceIds = jsonStringList(evidence, "externalEvidenceIds", 1);
  const scope = options.externalEvidenceScope?.(data, invocation) ?? `${batchId}:${operation}`;
  if (scope.trim() === "") throw new DomainError("VALIDATION_FAILED", "external evidence scope is required");
  await runtime.requireExternalEvidence(invocation.actor, scope, evidenceIds);
}

async function persistRecord(
  runtime: LifeTimeMachineRuntimePort,
  invocation: CapabilityInvocation,
  batchId: CapabilityDefinition["batchId"],
  skill: string,
  operation: string,
  data: JsonObject,
  options: DomainCapabilityOptions,
): Promise<JsonObject> {
  assertActorTenant(data, invocation);
  const participantIds = Array.isArray(data.participantIds)
    ? jsonStringList(data.participantIds, "participantIds")
    : [];
  const containsMinor = data.containsMinor === true || data.isMinor === true;
  const ownerActorId = typeof data.ownerActorId === "string" ? data.ownerActorId : invocation.actor.actorId;
  const operationMode = options.mode;
  const executionState = operationMode === "attestation"
      ? "evidence_persisted"
      : "persisted";
  const recordId = resolveRecordId(options, data, invocation);
  const recordData: CoreJsonObject = { batchId, skill, operation, operationMode, ...data, executionState };
  const result = await runtime.createRecord(invocation.actor, {
    collection: options.collection ?? `capability.${skill}`,
    ...(recordId ? { id: recordId } : {}),
    data: recordData,
    ownerActorId,
    participantIds,
    containsMinor,
    idempotencyKey: `${batchId}:${invocation.idempotencyKey}`,
  });
  await runtime.appendAudit(invocation.actor, {
    action: `capability.${batchId}.execute`,
    resourceType: result.value.collection,
    resourceId: result.value.id,
    details: { operation, replayed: result.replayed, recordVersion: result.value.version },
  });
  return {
    batchId,
    operation,
    recordId: result.value.id,
    recordVersion: result.value.version,
    replayed: result.replayed,
    state: executionState,
  };
}

async function persistExternalCommand(
  runtime: LifeTimeMachineRuntimePort,
  invocation: CapabilityInvocation,
  batchId: CapabilityDefinition["batchId"],
  skill: string,
  operation: string,
  data: JsonObject,
  options: DomainCapabilityOptions,
): Promise<JsonObject> {
  assertActorTenant(data, invocation);
  const participantIds = Array.isArray(data.participantIds)
    ? jsonStringList(data.participantIds, "participantIds")
    : [];
  const containsMinor = data.containsMinor === true || data.isMinor === true;
  const ownerActorId = typeof data.ownerActorId === "string" ? data.ownerActorId : invocation.actor.actorId;
  const configuredRecordId = resolveRecordId(options, data, invocation);
  const recordId = configuredRecordId ?? deterministicCommandId(batchId, invocation);
  const externalCommandId = recordId;
  const collection = options.collection ?? `capability.${skill}`;
  const recordData: CoreJsonObject = {
    batchId,
    skill,
    operation,
    operationMode: "external-command",
    ...data,
    commandState: "requested",
    executionState: "requested",
    externalCommandId,
  };
  const result = await runtime.createExternalCommand(invocation.actor, {
    record: {
      collection,
      id: recordId,
      data: recordData,
      ownerActorId,
      participantIds,
      containsMinor,
    },
    commandId: externalCommandId,
    batchId,
    operation,
    details: { skill, requestedBy: invocation.actor.actorId },
    idempotencyKey: `${batchId}:${invocation.idempotencyKey}`,
  });
  await runtime.appendAudit(invocation.actor, {
    action: `capability.${batchId}.execute`,
    resourceType: result.value.record.collection,
    resourceId: result.value.record.id,
    details: {
      operation,
      replayed: result.replayed,
      recordVersion: result.value.record.version,
      externalCommandId: result.value.command.commandId,
      commandState: result.value.command.state,
    },
  });
  return {
    batchId,
    operation,
    recordId: result.value.record.id,
    recordVersion: result.value.record.version,
    externalCommandId: result.value.command.commandId,
    commandState: result.value.command.state,
    replayed: result.replayed,
    state: result.value.command.state,
  };
}

function deterministicCommandId(
  batchId: CapabilityDefinition["batchId"],
  invocation: CapabilityInvocation,
): string {
  const digest = createHash("sha256")
    .update(invocation.actor.tenantId)
    .update("\0")
    .update(batchId)
    .update("\0")
    .update(invocation.idempotencyKey)
    .digest("hex");
  return `${batchId}:${digest}`;
}

async function persistStateTransition(
  runtime: LifeTimeMachineRuntimePort,
  invocation: CapabilityInvocation,
  batchId: CapabilityDefinition["batchId"],
  skill: string,
  operation: string,
  data: JsonObject,
  options: DomainCapabilityOptions,
): Promise<JsonObject> {
  if (!options.collection || !options.transition) {
    throw new DomainError("INTERNAL_ERROR", `state transition ${batchId} is missing persistence configuration`);
  }
  const recordId = resolveRecordId(options, data, invocation);
  if (!recordId) throw new DomainError("INTERNAL_ERROR", `state transition ${batchId} requires a stable record ID`);
  const fromState = asString(data[options.transition.fromField], options.transition.fromField);
  const toState = asString(data[options.transition.toField], options.transition.toField);
  const transitionKey = `${batchId}:${invocation.idempotencyKey}`;
  let current: RecordEnvelope<CoreJsonObject> | undefined;
  try {
    current = await runtime.getRecord<CoreJsonObject>(invocation.actor, options.collection, recordId);
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== "RESOURCE_NOT_FOUND") throw error;
  }

  if (current?.data.lastTransitionKey === transitionKey && current.data[options.transition.stateField] === toState) {
    await runtime.appendAudit(invocation.actor, {
      action: `capability.${batchId}.transition-replayed`,
      resourceType: current.collection,
      resourceId: current.id,
      details: { operation, fromState, toState, recordVersion: current.version },
    });
    return {
      batchId,
      operation,
      recordId: current.id,
      recordVersion: current.version,
      previousState: fromState,
      state: toState,
      replayed: true,
    };
  }
  if (current === undefined && !options.transition.initialFromStates.includes(fromState)) {
    throw new DomainError("RESOURCE_NOT_FOUND", `${operation} cannot transition an aggregate that has not been initialized`, {
      details: { recordId, fromState },
    });
  }
  if (current !== undefined && current.data[options.transition.stateField] !== fromState) {
    throw new DomainError("VERSION_CONFLICT", `${operation} received a stale aggregate state`, {
      details: { recordId, expectedState: current.data[options.transition.stateField] ?? null, suppliedState: fromState },
    });
  }

  const participantIds = Array.isArray(data.participantIds)
    ? jsonStringList(data.participantIds, "participantIds")
    : [];
  const containsMinor = data.containsMinor === true || data.isMinor === true;
  const ownerActorId = typeof data.ownerActorId === "string" ? data.ownerActorId : invocation.actor.actorId;
  const priorTransitionCount = current?.data.transitionCount;
  const transitionCount = typeof priorTransitionCount === "number" && Number.isSafeInteger(priorTransitionCount)
    ? priorTransitionCount + 1
    : 1;
  const recordData: CoreJsonObject = {
    batchId,
    skill,
    operation,
    operationMode: "state-transition",
    ...data,
    [options.transition.stateField]: toState,
    previousState: fromState,
    transitionCount,
    lastTransitionKey: transitionKey,
  };
  const result = current === undefined
    ? await runtime.createRecord(invocation.actor, {
        collection: options.collection,
        id: recordId,
        data: recordData,
        ownerActorId,
        participantIds,
        containsMinor,
        idempotencyKey: transitionKey,
      })
    : await runtime.updateRecord(invocation.actor, {
        collection: options.collection,
        id: recordId,
        expectedVersion: current.version,
        data: recordData,
        ownerActorId,
        participantIds,
        containsMinor,
        idempotencyKey: transitionKey,
      });
  await runtime.appendAudit(invocation.actor, {
    action: `capability.${batchId}.transition`,
    resourceType: result.value.collection,
    resourceId: result.value.id,
    details: { operation, fromState, toState, replayed: result.replayed, recordVersion: result.value.version },
  });
  return {
    batchId,
    operation,
    recordId: result.value.id,
    recordVersion: result.value.version,
    previousState: fromState,
    state: toState,
    replayed: result.replayed,
  };
}

async function persistInboxEvent(
  runtime: LifeTimeMachineRuntimePort,
  invocation: CapabilityInvocation,
  batchId: CapabilityDefinition["batchId"],
  operation: string,
  data: JsonObject,
): Promise<JsonObject> {
  const sourceEventId = asString(data.eventId, "eventId");
  const eventType = asString(data.eventType, "eventType");
  const result = await runtime.receiveInboxEvent(invocation.actor, {
    source: "analytics",
    sourceEventId,
    eventType,
    payload: { batchId, operation, operationMode: "inbox-event", ...data },
  });
  await runtime.appendAudit(invocation.actor, {
    action: `capability.${batchId}.execute`,
    resourceType: "inbox_event",
    resourceId: result.value.id,
    details: { operation, sourceEventId, replayed: result.replayed },
  });
  return {
    batchId,
    operation,
    eventId: result.value.id,
    sourceEventId,
    replayed: result.replayed,
    state: result.value.status,
  };
}

async function persistPartnerSettlement(
  runtime: LifeTimeMachineRuntimePort,
  invocation: CapabilityInvocation,
  batchId: CapabilityDefinition["batchId"],
  operation: string,
  data: JsonObject,
): Promise<JsonObject> {
  const settlementId = asString(data.settlementId, "settlementId");
  const partnerId = asString(data.partnerId, "partnerId");
  const currency = asString(data.currency, "currency");
  const grossMinor = asPositiveInteger(data.grossMinor, "grossMinor");
  const allocations = [
    { accountCode: "revenue.platform", amountMinor: asNonNegativeInteger(data.platformMinor, "platformMinor") },
    { accountCode: `payable.partner.${partnerId}`, amountMinor: asNonNegativeInteger(data.partnerMinor, "partnerMinor") },
    { accountCode: "liability.refunds", amountMinor: asNonNegativeInteger(data.refundMinor, "refundMinor") },
  ];
  const lines: LedgerLine[] = [
    { accountCode: "settlement.clearing", direction: "debit", amountMinor: grossMinor, currency },
    ...allocations
      .filter((allocation) => allocation.amountMinor > 0)
      .map((allocation): LedgerLine => ({
        accountCode: allocation.accountCode,
        direction: "credit",
        amountMinor: allocation.amountMinor,
        currency,
      })),
  ];
  const result = await runtime.postLedgerTransaction(invocation.actor, {
    transactionId: settlementId,
    sourceType: "partner_settlement",
    sourceId: settlementId,
    description: `Partner settlement ${settlementId}`,
    lines,
    idempotencyKey: `${batchId}:${invocation.idempotencyKey}`,
  });
  await runtime.appendAudit(invocation.actor, {
    action: `capability.${batchId}.execute`,
    resourceType: "ledger_transaction",
    resourceId: result.value.id,
    details: { operation, partnerId, replayed: result.replayed },
  });
  return {
    batchId,
    operation,
    transactionId: result.value.id,
    replayed: result.replayed,
    state: "posted",
  };
}

async function persistConsent(
  runtime: LifeTimeMachineRuntimePort,
  invocation: CapabilityInvocation,
  batchId: CapabilityDefinition["batchId"],
  skill: string,
  operation: string,
  data: JsonObject,
): Promise<JsonObject> {
  const participantId = asString(data.participantId, "participantId");
  const purpose = asString(data.purpose, "purpose");
  const policyVersion = asString(data.policyVersion, "policyVersion");
  const evidenceHash = asString(data.evidenceHash, "evidenceHash");
  const isMinor = data.isMinor === true;
  const grantorCapacity: GrantorCapacity = isMinor ? "guardian" : "self";
  const expiresAt = typeof data.expiresAt === "string" ? data.expiresAt : null;
  const result = await runtime.grantConsent(invocation.actor, {
    participantId,
    grantorCapacity,
    purpose,
    scope: { skill, operation },
    policyVersion,
    evidenceHash,
    isMinor,
    expiresAt,
    idempotencyKey: `${batchId}:${invocation.idempotencyKey}`,
  });
  await runtime.appendAudit(invocation.actor, {
    action: `capability.${batchId}.execute`,
    resourceType: "consent",
    resourceId: result.value.id,
    details: { operation, replayed: result.replayed, consentVersion: result.value.version },
  });
  return {
    batchId,
    operation,
    consentId: result.value.id,
    consentVersion: result.value.version,
    replayed: result.replayed,
    state: result.value.status,
  };
}

async function persistLedger(
  runtime: LifeTimeMachineRuntimePort,
  invocation: CapabilityInvocation,
  batchId: CapabilityDefinition["batchId"],
  operation: string,
  data: JsonObject,
): Promise<JsonObject> {
  const transactionId = asString(data.journalId, "journalId");
  const sourceType = asString(data.sourceType, "sourceType");
  const sourceId = asString(data.sourceId, "sourceId");
  const legalEntityId = asString(data.legalEntityId, "legalEntityId");
  const period = asString(data.period, "period");
  const lines = asLedgerLines(data.lines);
  const result = await runtime.postLedgerTransaction(invocation.actor, {
    transactionId,
    sourceType,
    sourceId,
    description: `${legalEntityId} journal for ${period}`,
    lines,
    idempotencyKey: `${batchId}:${invocation.idempotencyKey}`,
  });
  return {
    batchId,
    operation,
    transactionId: result.value.id,
    sourceType: result.value.sourceType,
    sourceId: result.value.sourceId,
    replayed: result.replayed,
    state: "posted",
  };
}

function asLedgerLines(value: JsonValue | undefined): LedgerLine[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new DomainError("VALIDATION_FAILED", "lines must contain at least two ledger lines");
  }
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DomainError("VALIDATION_FAILED", "each ledger line must be an object");
    }
    const accountCode = asString(entry.accountCode, "accountCode");
    const direction = asString(entry.direction, "direction");
    if (direction !== "debit" && direction !== "credit") {
      throw new DomainError("VALIDATION_FAILED", "direction must be debit or credit");
    }
    const amountMinor = entry.amountMinor;
    if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new DomainError("VALIDATION_FAILED", "amountMinor must be a positive safe integer");
    }
    const currency = asString(entry.currency, "currency");
    const memo = typeof entry.memo === "string" && entry.memo.trim() !== "" ? entry.memo : undefined;
    return memo === undefined
      ? { accountCode, direction, amountMinor, currency }
      : { accountCode, direction, amountMinor, currency, memo };
  });
}

function asString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("VALIDATION_FAILED", `${field} must be a non-empty string`, { details: { field } });
  }
  return value;
}

function resolveRecordId(
  options: DomainCapabilityOptions,
  data: JsonObject,
  invocation: CapabilityInvocation,
): string | undefined {
  if (options.recordId) return options.recordId(data, invocation);
  if (options.recordIdField) return asString(data[options.recordIdField], options.recordIdField);
  return undefined;
}

function asPositiveInteger(value: JsonValue | undefined, field: string): number {
  const result = asNonNegativeInteger(value, field);
  if (result === 0) throw new DomainError("VALIDATION_FAILED", `${field} must be positive`, { details: { field } });
  return result;
}

function asNonNegativeInteger(value: JsonValue | undefined, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("VALIDATION_FAILED", `${field} must be a non-negative integer`, { details: { field } });
  }
  return value;
}
