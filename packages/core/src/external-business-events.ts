import { canonicalJson, jsonObject, sha256 } from "./canonical.js";
import { DomainError } from "./errors.js";
import type {
  ApplyExternalBusinessEventInput,
  ExternalBusinessAggregateTarget,
  ExternalBusinessEventReducer,
  ExternalBusinessReduction,
  ExternalCommandState,
  JsonObject,
  LedgerLine,
  TransitionExternalCommandInput,
  VerifiedBusinessEvent,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COLLECTION = /^[a-z][a-z0-9_.-]{0,79}$/;
const BATCH = /^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/;
const SHA256 = /^[a-f0-9]{64}$/;
const STATE_FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const COMMAND_STATES = new Set<ExternalCommandState>([
  "requested",
  "dispatched",
  "acknowledged",
  "succeeded",
  "failed",
  "cancelled",
  "compensated",
]);

export interface NormalizedApplyExternalBusinessEventInput {
  readonly event: VerifiedBusinessEvent;
  readonly evidence: ApplyExternalBusinessEventInput["evidence"];
  readonly reducer: ExternalBusinessEventReducer;
  readonly idempotencyKey: string;
}

export function canonicalBusinessClaimsSha256(claims: JsonObject): string {
  return sha256(canonicalJson(jsonObject(claims, "canonicalClaims")));
}

export function canonicalBusinessEventSha256(event: Omit<VerifiedBusinessEvent, "businessEventSha256">): string {
  return sha256(canonicalJson({
    version: event.version,
    eventId: event.eventId,
    tenantId: event.tenantId,
    batchId: event.batchId,
    operation: event.operation,
    provider: event.provider,
    subjectType: event.subjectType,
    subjectId: event.subjectId,
    eventType: event.eventType,
    providerOccurredAt: event.providerOccurredAt,
    sequence: event.sequence,
    correlationId: event.correlationId,
    artifactSha256: event.artifactSha256,
    evidenceId: event.evidenceId,
    evidenceScope: event.evidenceScope,
    canonicalClaims: event.canonicalClaims,
    canonicalClaimsSha256: event.canonicalClaimsSha256,
  }));
}

export function normalizeApplyExternalBusinessEventInput(
  input: ApplyExternalBusinessEventInput,
): NormalizedApplyExternalBusinessEventInput {
  const event = normalizeVerifiedBusinessEvent(input.event);
  if (input.reducer === null || typeof input.reducer !== "object" ||
      typeof input.reducer.locate !== "function" || typeof input.reducer.reduce !== "function") {
    throw new DomainError("CONFIGURATION_INVALID", "A trusted external business event reducer is required");
  }
  identifier(input.reducer.name, "reducer name");
  return {
    event,
    evidence: input.evidence,
    reducer: input.reducer,
    idempotencyKey: visible(input.idempotencyKey, "idempotencyKey", 200),
  };
}

export function normalizeVerifiedBusinessEvent(value: VerifiedBusinessEvent): VerifiedBusinessEvent {
  if (value.version !== "ltm.external-business-event.v1") {
    throw new DomainError("VALIDATION_FAILED", "External business event version is unsupported");
  }
  const canonicalClaims = jsonObject(value.canonicalClaims, "canonicalClaims");
  if (Object.keys(canonicalClaims).length === 0) {
    throw new DomainError("VALIDATION_FAILED", "canonicalClaims must not be empty");
  }
  const canonicalClaimsSha256Value = digest(value.canonicalClaimsSha256, "canonicalClaimsSha256");
  if (canonicalBusinessClaimsSha256(canonicalClaims) !== canonicalClaimsSha256Value) {
    throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Canonical business claims digest does not match the claims");
  }
  const providerOccurredAt = canonicalTimestamp(value.providerOccurredAt, "providerOccurredAt");
  if (value.sequence !== null && (!Number.isSafeInteger(value.sequence) || value.sequence < 0)) {
    throw new DomainError("VALIDATION_FAILED", "External business event sequence must be null or a non-negative integer");
  }
  const batchId = identifier(value.batchId, "batchId", BATCH) as `B${string}`;
  const normalized = {
    version: value.version,
    eventId: identifier(value.eventId, "eventId"),
    tenantId: identifier(value.tenantId, "tenantId"),
    batchId,
    operation: identifier(value.operation, "operation"),
    provider: identifier(value.provider, "provider"),
    subjectType: identifier(value.subjectType, "subjectType"),
    subjectId: identifier(value.subjectId, "subjectId"),
    eventType: identifier(value.eventType, "eventType"),
    providerOccurredAt,
    sequence: value.sequence,
    correlationId: identifier(value.correlationId, "correlationId"),
    artifactSha256: digest(value.artifactSha256, "artifactSha256"),
    evidenceId: identifier(value.evidenceId, "evidenceId"),
    evidenceScope: visible(value.evidenceScope, "evidenceScope", 512),
    canonicalClaims,
    canonicalClaimsSha256: canonicalClaimsSha256Value,
  } as const;
  const businessEventSha256 = digest(value.businessEventSha256, "businessEventSha256");
  if (canonicalBusinessEventSha256(normalized) !== businessEventSha256) {
    throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Business event digest does not match its canonical binding");
  }
  return { ...normalized, businessEventSha256 };
}

export function normalizeTransitionExternalCommandInput(
  input: TransitionExternalCommandInput,
): TransitionExternalCommandInput {
  const toState = commandState(input.toState);
  return {
    commandId: identifier(input.commandId, "commandId"),
    batchId: identifier(input.batchId, "batchId", BATCH) as `B${string}`,
    operation: identifier(input.operation, "operation"),
    aggregateCollection: identifier(input.aggregateCollection, "aggregateCollection", COLLECTION),
    aggregateId: identifier(input.aggregateId, "aggregateId"),
    toState,
    ...(input.providerOperationId === undefined
      ? {}
      : { providerOperationId: nullableIdentifier(input.providerOperationId, "providerOperationId") }),
    ...(input.evidenceId === undefined
      ? {}
      : { evidenceId: nullableIdentifier(input.evidenceId, "evidenceId") }),
    details: jsonObject(input.details ?? {}, "external command details"),
    idempotencyKey: visible(input.idempotencyKey, "idempotencyKey", 200),
  };
}

export function assertExternalCommandTransition(
  from: ExternalCommandState | null,
  to: ExternalCommandState,
): void {
  const allowed = from === null
    ? ["requested"]
    : from === "requested"
      ? ["dispatched", "cancelled"]
      : from === "dispatched"
        ? ["acknowledged", "failed", "cancelled"]
        : from === "acknowledged"
          ? ["succeeded", "failed", "cancelled"]
          : from === "succeeded"
            ? ["compensated"]
            : [];
  if (!allowed.includes(to)) {
    throw new DomainError("VERSION_CONFLICT", "External command transition is illegal", {
      details: { from: from ?? "absent", to, allowed },
    });
  }
}

export function isExternalCommandTerminal(state: ExternalCommandState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled" || state === "compensated";
}

export function normalizeExternalBusinessAggregateTarget(
  value: ExternalBusinessAggregateTarget,
): Required<Pick<ExternalBusinessAggregateTarget, "collection" | "aggregateId" | "participantIds" | "containsMinor" | "relatedRecords">> &
  Pick<ExternalBusinessAggregateTarget, "ownerActorId"> {
  const participantIds = [...new Set((value.participantIds ?? []).map((entry) => identifier(entry, "participantId")))];
  if (participantIds.length > 100) throw new DomainError("VALIDATION_FAILED", "participantIds exceeds 100 entries");
  const relatedRecords = (value.relatedRecords ?? []).map((related) => ({
    key: identifier(related.key, "related record key"),
    collection: identifier(related.collection, "related record collection", COLLECTION),
    id: identifier(related.id, "related record id"),
    required: related.required === true,
    lock: related.lock ?? "share",
  }));
  if (relatedRecords.length > 64 || new Set(relatedRecords.map((entry) => entry.key)).size !== relatedRecords.length ||
      relatedRecords.some((entry) => entry.lock !== "share" && entry.lock !== "update")) {
    throw new DomainError("VALIDATION_FAILED", "Related record selectors are invalid");
  }
  return {
    collection: identifier(value.collection, "aggregate collection", COLLECTION),
    aggregateId: identifier(value.aggregateId, "aggregateId"),
    ...(value.ownerActorId === undefined
      ? {}
      : { ownerActorId: nullableIdentifier(value.ownerActorId, "ownerActorId") }),
    participantIds,
    containsMinor: value.containsMinor === true,
    relatedRecords,
  };
}

export function normalizeExternalBusinessReduction(
  value: ExternalBusinessReduction,
): ExternalBusinessReduction & { readonly stateField: string } {
  const stateField = value.stateField === undefined
    ? "state"
    : identifier(value.stateField, "stateField", STATE_FIELD);
  const patch = jsonObject(value.patch, "reducer patch");
  const forbidden = Object.keys(patch).filter((key) => key === stateField || key.startsWith("_external"));
  if (forbidden.length > 0) {
    throw new DomainError("VALIDATION_FAILED", "Reducer patch contains core-owned state fields", {
      details: { fields: forbidden },
    });
  }
  if (!Array.isArray(value.allowedPriorStates) || value.allowedPriorStates.length === 0 || value.allowedPriorStates.length > 64) {
    throw new DomainError("VALIDATION_FAILED", "allowedPriorStates must contain between 1 and 64 states");
  }
  const allowedPriorStates = value.allowedPriorStates.map((state) =>
    state === null ? null : identifier(state, "allowedPriorState"));
  if (new Set(allowedPriorStates.map((state) => state ?? "<absent>")).size !== allowedPriorStates.length) {
    throw new DomainError("VALIDATION_FAILED", "allowedPriorStates must be unique");
  }
  const ledger = value.ledger === undefined ? undefined : normalizeLedger(value.ledger);
  const commandTransition = value.commandTransition === undefined
    ? undefined
    : {
        commandId: identifier(value.commandTransition.commandId, "commandId"),
        toState: commandState(value.commandTransition.toState),
        ...(value.commandTransition.providerOperationId === undefined
          ? {}
          : { providerOperationId: nullableIdentifier(value.commandTransition.providerOperationId, "providerOperationId") }),
        ...(value.commandTransition.evidenceId === undefined
          ? {}
          : { evidenceId: nullableIdentifier(value.commandTransition.evidenceId, "evidenceId") }),
        details: jsonObject(value.commandTransition.details ?? {}, "commandTransition.details"),
      };
  return {
    stateField,
    allowedPriorStates,
    nextState: identifier(value.nextState, "nextState"),
    patch,
    decisionType: identifier(value.decisionType, "decisionType"),
    decisionId: identifier(value.decisionId, "decisionId"),
    ...(commandTransition === undefined ? {} : { commandTransition }),
    ...(ledger === undefined ? {} : { ledger }),
  };
}

function normalizeLedger(value: ExternalBusinessReduction["ledger"]): NonNullable<ExternalBusinessReduction["ledger"]> {
  if (value === undefined) throw new DomainError("VALIDATION_FAILED", "ledger is required");
  if (!Array.isArray(value.lines) || value.lines.length < 2 || value.lines.length > 100) {
    throw new DomainError("LEDGER_UNBALANCED", "External business ledger requires between 2 and 100 lines");
  }
  const lines: LedgerLine[] = value.lines.map((line) => {
    const amountMinor = line.amountMinor;
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new DomainError("VALIDATION_FAILED", "Ledger amountMinor must be a positive integer");
    }
    if (line.direction !== "debit" && line.direction !== "credit") {
      throw new DomainError("VALIDATION_FAILED", "Ledger direction is invalid");
    }
    const currency = identifier(line.currency, "ledger currency", /^[A-Z]{3}$/);
    return {
      accountCode: identifier(line.accountCode, "ledger accountCode", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/),
      direction: line.direction,
      amountMinor,
      currency,
      ...(line.memo === undefined ? {} : { memo: visible(line.memo, "ledger memo", 500) }),
    };
  });
  const currencies = new Set(lines.map((line) => line.currency));
  for (const currency of currencies) {
    const debit = lines.filter((line) => line.currency === currency && line.direction === "debit")
      .reduce((sum, line) => sum + line.amountMinor, 0);
    const credit = lines.filter((line) => line.currency === currency && line.direction === "credit")
      .reduce((sum, line) => sum + line.amountMinor, 0);
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit) || debit !== credit) {
      throw new DomainError("LEDGER_UNBALANCED", "External business ledger is not balanced per currency");
    }
  }
  return {
    ...(value.transactionId === undefined ? {} : { transactionId: identifier(value.transactionId, "transactionId") }),
    sourceType: identifier(value.sourceType, "ledger sourceType"),
    sourceId: identifier(value.sourceId, "ledger sourceId"),
    description: visible(value.description, "ledger description", 500),
    ...(value.occurredAt === undefined ? {} : { occurredAt: canonicalTimestamp(value.occurredAt, "ledger occurredAt") }),
    ...(value.reversedTransactionId === undefined
      ? {}
      : { reversedTransactionId: nullableIdentifier(value.reversedTransactionId, "reversedTransactionId") }),
    lines,
  };
}

function commandState(value: ExternalCommandState): ExternalCommandState {
  if (!COMMAND_STATES.has(value)) throw new DomainError("VALIDATION_FAILED", "External command state is invalid");
  return value;
}

function identifier(value: string, label: string, pattern: RegExp = IDENTIFIER): string {
  if (typeof value !== "string") throw new DomainError("VALIDATION_FAILED", `${label} must be a string`);
  const normalized = value.trim();
  if (!pattern.test(normalized)) throw new DomainError("VALIDATION_FAILED", `${label} has an invalid format`);
  return normalized;
}

function nullableIdentifier(value: string | null, label: string): string | null {
  return value === null ? null : identifier(value, label);
}

function visible(value: string, label: string, maximum: number): string {
  if (typeof value !== "string") throw new DomainError("VALIDATION_FAILED", `${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new DomainError("VALIDATION_FAILED", `${label} must contain between 1 and ${maximum} visible characters`);
  }
  return normalized;
}

function digest(value: string, label: string): string {
  return identifier(value, label, SHA256);
}

function canonicalTimestamp(value: string, label: string): string {
  if (typeof value !== "string") throw new DomainError("VALIDATION_FAILED", `${label} must be a string`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be canonical UTC ISO-8601`);
  }
  return value;
}
