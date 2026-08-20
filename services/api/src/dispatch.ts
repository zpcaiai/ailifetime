import type { CapabilityRegistry, JsonValue as CapabilityJsonValue } from "@ltm/capabilities";
import { DomainError } from "@ltm/core";
import type {
  ActorContext,
  GrantorCapacity,
  JsonObject,
  LedgerDirection,
  LifeTimeMachineRuntime,
  OutboxStatus,
} from "@ltm/core";

type InputObject = Record<string, unknown>;

export const COMMANDS = [
  "record.create",
  "record.update",
  "record.delete",
  "consent.grant",
  "consent.withdraw",
  "ledger.post",
  "inbox.receive",
] as const;

export const QUERIES = [
  "record.get",
  "record.list",
  "consent.require",
  "consent.list",
  "ledger.get",
  "ledger.balance",
  "ledger.trialBalance",
  "inbox.get",
  "outbox.list",
  "audit.list",
  "audit.verify",
] as const;

export interface DispatchEnvelope {
  readonly operation: string;
  readonly input: InputObject;
}

export interface CapabilityCatalogEntry {
  readonly batchId: string;
  readonly skill: string;
  readonly operation: string;
  readonly requirements: readonly string[];
  readonly requiresExternalEvidence: boolean;
}

export function parseDispatchEnvelope(body: unknown, operationField: "command" | "query"): DispatchEnvelope {
  const value = object(body, "request body");
  return {
    operation: string(value[operationField], operationField, 160),
    input: object(value.input ?? {}, "input"),
  };
}

export function capabilityCatalog(registry: CapabilityRegistry): readonly CapabilityCatalogEntry[] {
  return registry.list().map((definition) => ({
    batchId: definition.batchId,
    skill: definition.skill,
    operation: definition.operation,
    requirements: definition.requirements,
    requiresExternalEvidence: definition.requiresExternalEvidence ?? false,
  }));
}

export async function dispatchCapability(
  runtime: LifeTimeMachineRuntime,
  registry: CapabilityRegistry,
  context: ActorContext,
  batchIdValue: unknown,
  inputValue: unknown,
  idempotencyKey: string,
): Promise<CapabilityJsonValue> {
  const batchId = string(batchIdValue, "batchId", 8);
  const definition = registry.get(batchId);
  if (definition === undefined) {
    throw new DomainError("RESOURCE_NOT_FOUND", "Capability was not found", { details: { batchId } });
  }
  const input = jsonObject(inputValue ?? {}, "input") as Record<string, CapabilityJsonValue>;
  return registry.execute(runtime, batchId, { actor: context, idempotencyKey, input });
}

export function dispatchCommand(
  runtime: LifeTimeMachineRuntime,
  context: ActorContext,
  command: string,
  input: InputObject,
  idempotencyKey: string,
): unknown {
  switch (command) {
    case "record.create":
      return runtime.createRecord(context, {
        collection: string(input.collection, "input.collection", 80),
        data: jsonObject(input.data, "input.data"),
        idempotencyKey,
        ...(input.id === undefined ? {} : { id: string(input.id, "input.id", 128) }),
        ...(input.ownerActorId === undefined
          ? {}
          : { ownerActorId: nullableString(input.ownerActorId, "input.ownerActorId", 128) }),
        ...(input.participantIds === undefined
          ? {}
          : { participantIds: stringArray(input.participantIds, "input.participantIds", 100) }),
        ...(input.containsMinor === undefined
          ? {}
          : { containsMinor: boolean(input.containsMinor, "input.containsMinor") }),
      });
    case "record.update":
      return runtime.updateRecord(context, {
        collection: string(input.collection, "input.collection", 80),
        id: string(input.id, "input.id", 128),
        expectedVersion: integer(input.expectedVersion, "input.expectedVersion", 1),
        data: jsonObject(input.data, "input.data"),
        idempotencyKey,
        ...(input.ownerActorId === undefined
          ? {}
          : { ownerActorId: nullableString(input.ownerActorId, "input.ownerActorId", 128) }),
        ...(input.participantIds === undefined
          ? {}
          : { participantIds: stringArray(input.participantIds, "input.participantIds", 100) }),
        ...(input.containsMinor === undefined
          ? {}
          : { containsMinor: boolean(input.containsMinor, "input.containsMinor") }),
      });
    case "record.delete":
      return runtime.deleteRecord(context, {
        collection: string(input.collection, "input.collection", 80),
        id: string(input.id, "input.id", 128),
        expectedVersion: integer(input.expectedVersion, "input.expectedVersion", 1),
        idempotencyKey,
      });
    case "consent.grant":
      return runtime.grantConsent(context, {
        participantId: string(input.participantId, "input.participantId", 128),
        grantorCapacity: oneOf(
          input.grantorCapacity,
          "input.grantorCapacity",
          ["self", "guardian", "authorized_agent"] as const,
        ) as GrantorCapacity,
        purpose: string(input.purpose, "input.purpose", 120),
        scope: jsonObject(input.scope, "input.scope"),
        policyVersion: string(input.policyVersion, "input.policyVersion", 128),
        evidenceHash: string(input.evidenceHash, "input.evidenceHash", 64),
        idempotencyKey,
        ...(input.id === undefined ? {} : { id: string(input.id, "input.id", 128) }),
        ...(input.isMinor === undefined ? {} : { isMinor: boolean(input.isMinor, "input.isMinor") }),
        ...(input.expiresAt === undefined
          ? {}
          : { expiresAt: nullableString(input.expiresAt, "input.expiresAt", 64) }),
      });
    case "consent.withdraw":
      return runtime.withdrawConsent(context, {
        consentId: string(input.consentId, "input.consentId", 128),
        expectedVersion: integer(input.expectedVersion, "input.expectedVersion", 1),
        reason: string(input.reason, "input.reason", 500),
        idempotencyKey,
      });
    case "ledger.post": {
      if (!Array.isArray(input.lines)) {
        throw new DomainError("VALIDATION_FAILED", "input.lines must be an array");
      }
      const lines = input.lines.map((lineValue, index) => {
        const line = object(lineValue, `input.lines[${index}]`);
        return {
          accountCode: string(line.accountCode, `input.lines[${index}].accountCode`, 80),
          direction: oneOf(
            line.direction,
            `input.lines[${index}].direction`,
            ["debit", "credit"] as const,
          ) as LedgerDirection,
          amountMinor: integer(line.amountMinor, `input.lines[${index}].amountMinor`, 1),
          currency: string(line.currency, `input.lines[${index}].currency`, 3),
          ...(line.memo === undefined ? {} : { memo: string(line.memo, `input.lines[${index}].memo`, 500) }),
        };
      });
      return runtime.postLedgerTransaction(context, {
        sourceType: string(input.sourceType, "input.sourceType", 128),
        sourceId: string(input.sourceId, "input.sourceId", 128),
        description: string(input.description, "input.description", 500),
        lines,
        idempotencyKey,
        ...(input.transactionId === undefined
          ? {}
          : { transactionId: string(input.transactionId, "input.transactionId", 128) }),
        ...(input.occurredAt === undefined ? {} : { occurredAt: string(input.occurredAt, "input.occurredAt", 64) }),
        ...(input.reversedTransactionId === undefined
          ? {}
          : { reversedTransactionId: nullableString(input.reversedTransactionId, "input.reversedTransactionId", 128) }),
      });
    }
    case "inbox.receive":
      return runtime.receiveInboxEvent(context, {
        source: string(input.source, "input.source", 128),
        sourceEventId: string(input.sourceEventId, "input.sourceEventId", 128),
        eventType: string(input.eventType, "input.eventType", 128),
        payload: jsonObject(input.payload, "input.payload"),
      });
    default:
      throw new DomainError("RESOURCE_NOT_FOUND", "Command was not found", { details: { command } });
  }
}

export function dispatchQuery(
  runtime: LifeTimeMachineRuntime,
  context: ActorContext,
  query: string,
  input: InputObject,
): unknown {
  switch (query) {
    case "record.get":
      return runtime.getRecord(
        context,
        string(input.collection, "input.collection", 80),
        string(input.id, "input.id", 128),
      );
    case "record.list":
      return runtime.listRecords(context, {
        collection: string(input.collection, "input.collection", 80),
        ...(input.limit === undefined ? {} : { limit: integer(input.limit, "input.limit", 1, 200) }),
        ...(input.cursor === undefined ? {} : { cursor: string(input.cursor, "input.cursor", 128) }),
        ...(input.includeDeleted === undefined
          ? {}
          : { includeDeleted: boolean(input.includeDeleted, "input.includeDeleted") }),
      });
    case "consent.require":
      return runtime.requireConsent(context, {
        participantIds: stringArray(input.participantIds, "input.participantIds", 100),
        ...(input.purpose === undefined ? {} : { purpose: string(input.purpose, "input.purpose", 120) }),
        ...(input.at === undefined ? {} : { at: string(input.at, "input.at", 64) }),
      });
    case "consent.list":
      return runtime.listConsents(
        context,
        input.participantId === undefined ? undefined : string(input.participantId, "input.participantId", 128),
      );
    case "ledger.get":
      return runtime.getLedgerTransaction(context, string(input.transactionId, "input.transactionId", 128));
    case "ledger.balance":
      return runtime.getAccountBalance(
        context,
        string(input.accountCode, "input.accountCode", 80),
        string(input.currency, "input.currency", 3),
      );
    case "ledger.trialBalance":
      return runtime.getTrialBalance(context);
    case "inbox.get":
      return runtime.getInboxEvent(context, string(input.eventId, "input.eventId", 128));
    case "outbox.list":
      return runtime.listOutbox(context, {
        ...(input.status === undefined
          ? {}
          : {
              status: oneOf(
                input.status,
                "input.status",
                ["pending", "leased", "published", "dead"] as const,
              ) as OutboxStatus,
            }),
        ...(input.limit === undefined ? {} : { limit: integer(input.limit, "input.limit", 1, 200) }),
      });
    case "audit.list":
      return runtime.listAudit(context, input.limit === undefined ? 100 : integer(input.limit, "input.limit", 1, 500));
    case "audit.verify":
      return runtime.verifyAuditChain(context);
    default:
      throw new DomainError("RESOURCE_NOT_FOUND", "Query was not found", { details: { query } });
  }
}

export function object(value: unknown, label: string): InputObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be an object`);
  }
  return value as InputObject;
}

function jsonObject(value: unknown, label: string): JsonObject {
  const result = object(value, label);
  validateJson(result, label, new Set<object>());
  return result as JsonObject;
}

function validateJson(value: unknown, label: string, seen: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object") {
    throw new DomainError("VALIDATION_FAILED", `${label} must contain only JSON values`);
  }
  if (seen.has(value)) {
    throw new DomainError("VALIDATION_FAILED", `${label} must not contain cycles`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJson(item, `${label}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) validateJson(item, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

function string(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", `${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new DomainError("VALIDATION_FAILED", `${label} is invalid`);
  }
  return normalized;
}

function nullableString(value: unknown, label: string, maximum: number): string | null {
  return value === null ? null : string(value, label, maximum);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new DomainError("VALIDATION_FAILED", `${label} must be a boolean`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function stringArray(value: unknown, label: string, maximumItems: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be an array with at most ${maximumItems} items`);
  }
  return value.map((item, index) => string(item, `${label}[${index}]`, 128));
}

function oneOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}
