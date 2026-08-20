import { DomainError } from "@ltm/core";
import type {
  ConsentRequirement,
  GrantorCapacity,
  JsonObject as CoreJsonObject,
  LedgerLine,
  LifeTimeMachineRuntime,
} from "@ltm/core";
import type { CapabilityDefinition, CapabilityInvocation, CapabilityRegistry, JsonObject, JsonValue } from "../registry.js";
import { requirementIds } from "../registry.js";

export type DomainValidator = (input: JsonObject, invocation: CapabilityInvocation) => JsonObject;
export type ConsentResolver = (
  data: JsonObject,
  invocation: CapabilityInvocation,
) => ConsentRequirement | readonly ConsentRequirement[] | undefined;

export interface DomainCapabilityOptions {
  readonly permission?: string;
  readonly sensitive?: boolean;
  readonly requiresExternalEvidence?: boolean;
  readonly consent?: ConsentResolver;
  readonly mode?: "record" | "consent-write" | "ledger-post";
  readonly collection?: string;
}

export type DomainCapabilityDefinition = CapabilityDefinition;

export function defineCapability(
  batchId: CapabilityDefinition["batchId"],
  skill: string,
  operation: string,
  validate: DomainValidator,
  options: DomainCapabilityOptions = {},
): DomainCapabilityDefinition {
  return {
    batchId,
    skill,
    operation,
    requirements: requirementIds(batchId),
    ...(options.requiresExternalEvidence ? { requiresExternalEvidence: true } : {}),
    execute(runtime, invocation) {
      assertInvocation(invocation);
      assertActorTenant(invocation.input, invocation);
      runtime.authorize(invocation.actor, options.permission ?? "record:create", {
        tenantId: invocation.actor.tenantId,
        sensitive: options.sensitive ?? false,
      });

      const data = validate(invocation.input, invocation);
      requireExternalEvidence(runtime, invocation, options, batchId, operation, invocation.input, data);
      requireResolvedConsent(runtime, invocation, data, options.consent);

      if (options.mode === "consent-write") {
        return persistConsent(runtime, invocation, batchId, skill, operation, data);
      }
      if (options.mode === "ledger-post") {
        return persistLedger(runtime, invocation, batchId, operation, data);
      }
      return persistRecord(runtime, invocation, batchId, skill, operation, data, options.collection);
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
  runtime: LifeTimeMachineRuntime,
  invocation: CapabilityInvocation,
  data: JsonObject,
  resolve: ConsentResolver | undefined,
): void {
  if (!resolve) return;
  const resolved = resolve(data, invocation);
  if (!resolved) {
    throw new DomainError("CONSENT_REQUIRED", "consent requirement could not be resolved");
  }
  const requirements = Array.isArray(resolved) ? resolved : [resolved];
  if (requirements.length === 0) return;
  for (const requirement of requirements) runtime.requireConsent(invocation.actor, requirement);
}

function requireExternalEvidence(
  runtime: LifeTimeMachineRuntime,
  invocation: CapabilityInvocation,
  options: DomainCapabilityOptions,
  batchId: CapabilityDefinition["batchId"],
  operation: string,
  input: JsonObject,
  data: JsonObject,
): void {
  if (!options.requiresExternalEvidence) return;
  const evidence = data.externalEvidenceIds ?? input.externalEvidenceIds;
  const evidenceIds = jsonStringList(evidence, "externalEvidenceIds", 1);
  runtime.requireExternalEvidence(invocation.actor, `${batchId}:${operation}`, evidenceIds);
}

function persistRecord(
  runtime: LifeTimeMachineRuntime,
  invocation: CapabilityInvocation,
  batchId: CapabilityDefinition["batchId"],
  skill: string,
  operation: string,
  data: JsonObject,
  collectionOverride: string | undefined,
): JsonObject {
  assertActorTenant(data, invocation);
  const participantIds = Array.isArray(data.participantIds)
    ? jsonStringList(data.participantIds, "participantIds")
    : [];
  const containsMinor = data.containsMinor === true || data.isMinor === true;
  const ownerActorId = typeof data.ownerActorId === "string" ? data.ownerActorId : invocation.actor.actorId;
  const recordData: CoreJsonObject = { batchId, skill, operation, ...data };
  const result = runtime.createRecord(invocation.actor, {
    collection: collectionOverride ?? `capability.${skill}`,
    data: recordData,
    ownerActorId,
    participantIds,
    containsMinor,
    idempotencyKey: `${batchId}:${invocation.idempotencyKey}`,
  });
  runtime.appendAudit(invocation.actor, {
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
    state: "persisted",
  };
}

function persistConsent(
  runtime: LifeTimeMachineRuntime,
  invocation: CapabilityInvocation,
  batchId: CapabilityDefinition["batchId"],
  skill: string,
  operation: string,
  data: JsonObject,
): JsonObject {
  const participantId = asString(data.participantId, "participantId");
  const purpose = asString(data.purpose, "purpose");
  const policyVersion = asString(data.policyVersion, "policyVersion");
  const evidenceHash = asString(data.evidenceHash, "evidenceHash");
  const isMinor = data.isMinor === true;
  const grantorCapacity: GrantorCapacity = isMinor ? "guardian" : "self";
  const expiresAt = typeof data.expiresAt === "string" ? data.expiresAt : null;
  const result = runtime.grantConsent(invocation.actor, {
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
  runtime.appendAudit(invocation.actor, {
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

function persistLedger(
  runtime: LifeTimeMachineRuntime,
  invocation: CapabilityInvocation,
  batchId: CapabilityDefinition["batchId"],
  operation: string,
  data: JsonObject,
): JsonObject {
  const transactionId = asString(data.journalId, "journalId");
  const sourceType = asString(data.sourceType, "sourceType");
  const sourceId = asString(data.sourceId, "sourceId");
  const legalEntityId = asString(data.legalEntityId, "legalEntityId");
  const period = asString(data.period, "period");
  const lines = asLedgerLines(data.lines);
  const result = runtime.postLedgerTransaction(invocation.actor, {
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
