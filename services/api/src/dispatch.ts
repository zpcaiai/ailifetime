import {
  CAPABILITY_PORTAL_MANIFEST,
  EXTERNAL_EVENT_REDUCER_TARGET_COLLECTIONS,
  capabilityPortalForSkill,
  roleCanAccessCapabilityPortal,
  type CapabilityPortalId,
  type CapabilityRegistry,
  type JsonValue as CapabilityJsonValue,
} from "@ltm/capabilities";
import {
  DomainError,
  DurableShareGrantService,
  EXTERNAL_COMMAND_CALLBACK_ROUTES,
  RIGHTS_REQUEST_COLLECTION,
  RIGHTS_REQUEST_TYPES,
  hasPermission,
} from "@ltm/core";
import type {
  ActorContext,
  EvidenceEnvironment,
  ExternalBusinessEventReducerRegistry,
  ExternalCommandState,
  GrantorCapacity,
  JsonObject,
  LedgerDirection,
  LifeTimeMachineRuntimePort,
  OutboxStatus,
  ParticipantAuthorityCapacity,
  ParticipantMinorStatus,
  SignedExternalEvidence,
  VerifiedBusinessEvent,
} from "@ltm/core";

type InputObject = Record<string, unknown>;

const EXTERNAL_COMMAND_COLLECTIONS = new Set<string>(
  EXTERNAL_COMMAND_CALLBACK_ROUTES.map((route) => route.collection),
);
const SERVER_MANAGED_MUTATION_COLLECTIONS = new Set<string>([
  ...EXTERNAL_COMMAND_COLLECTIONS,
  ...EXTERNAL_EVENT_REDUCER_TARGET_COLLECTIONS,
  "media.quality-decisions",
  "media.safety-certificates",
  RIGHTS_REQUEST_COLLECTION,
]);
const SHARE_COMMAND_COLLECTIONS = new Set<string>(
  EXTERNAL_COMMAND_CALLBACK_ROUTES
    .filter((route) => route.batchId === "B10" && (route.operation === "publishExport" || route.operation === "revokeExport"))
    .map((route) => route.collection),
);

export const COMMANDS = [
  "record.create",
  "record.update",
  "record.delete",
  "consent.grant",
  "consent.withdraw",
  "ledger.post",
  "inbox.receive",
  "evidence.register",
  "evidence.revoke",
  "participant.register",
  "participant.revoke",
  "participant-authority.grant",
  "participant-authority.revoke",
  "rights-request.submit",
  "rights-request.task-receipt",
  "rights-request.review",
  "rights-request.escalate",
  "share-grant.revoke",
  "external-command.transition",
  "external-event.apply",
] as const;

export const QUERIES = [
  "record.get",
  "record.list",
  "consent.require",
  "consent.list",
  "rights-request.get",
  "rights-request.list",
  "ledger.get",
  "ledger.balance",
  "ledger.trialBalance",
  "inbox.get",
  "outbox.list",
  "audit.list",
  "audit.verify",
  "evidence.get",
  "evidence.list",
  "external-command.get",
  "share-grant.get",
  "share-grant.list",
] as const;

export interface DispatchEnvelope {
  readonly operation: string;
  readonly input: InputObject;
}

export interface CapabilityCatalogEntry {
  readonly batchId: string;
  readonly skill: string;
  readonly operation: string;
  readonly permission: string;
  readonly portalId: CapabilityPortalId;
  readonly mode: string;
  readonly requirements: readonly string[];
  readonly requiresExternalEvidence: boolean;
}

export interface VisibleCapabilityPortalEntry {
  readonly id: CapabilityPortalId;
  readonly skills: readonly string[];
  readonly capabilityCount: number;
}

export function parseDispatchEnvelope(body: unknown, operationField: "command" | "query"): DispatchEnvelope {
  const value = object(body, "request body");
  assertOnlyKeys(value, [operationField, "input"], "request body");
  return {
    operation: string(value[operationField], operationField, 160),
    input: object(value.input ?? {}, "input"),
  };
}

export function capabilityCatalog(registry: CapabilityRegistry): readonly CapabilityCatalogEntry[] {
  return registry.list().map((definition) => {
    const portal = capabilityPortalForSkill(definition.skill);
    if (portal === undefined) {
      throw new DomainError("INTERNAL_ERROR", "Capability skill is missing from the portal manifest", {
        details: { batchId: definition.batchId, skill: definition.skill },
      });
    }
    return {
      batchId: definition.batchId,
      skill: definition.skill,
      operation: definition.operation,
      permission: definition.permission,
      portalId: portal.id,
      mode: definition.mode,
      requirements: definition.requirements,
      requiresExternalEvidence: definition.requiresExternalEvidence ?? false,
    };
  });
}

export function visibleCapabilityCatalog(
  registry: CapabilityRegistry,
  context: ActorContext,
): readonly CapabilityCatalogEntry[] {
  const accessiblePortals = new Set(
    CAPABILITY_PORTAL_MANIFEST
      .filter((portal) => roleCanAccessCapabilityPortal(context.roles, portal))
      .map((portal) => portal.id),
  );
  return capabilityCatalog(registry).filter(
    (capability) => accessiblePortals.has(capability.portalId) && hasPermission(context, capability.permission),
  );
}

export function visibleCapabilityPortals(
  context: ActorContext,
  capabilities: readonly CapabilityCatalogEntry[],
): readonly VisibleCapabilityPortalEntry[] {
  return CAPABILITY_PORTAL_MANIFEST.flatMap((portal) => {
    if (!roleCanAccessCapabilityPortal(context.roles, portal)) return [];
    const skills = portal.skills.filter((skill) => capabilities.some((capability) => capability.skill === skill));
    const capabilityCount = capabilities.filter((capability) => capability.portalId === portal.id).length;
    return capabilityCount === 0 ? [] : [{ id: portal.id, skills, capabilityCount }];
  });
}

export async function dispatchCapability(
  runtime: LifeTimeMachineRuntimePort,
  registry: CapabilityRegistry,
  context: ActorContext,
  batchIdValue: unknown,
  inputValue: unknown,
  idempotencyKey: string,
  serverAuthorization: "portal-manifest" | "b05-data-erasure" = "portal-manifest",
): Promise<CapabilityJsonValue> {
  const batchId = normalizeCapabilityBatchId(batchIdValue);
  const definition = registry.get(batchId);
  if (definition === undefined) {
    throw new DomainError("RESOURCE_NOT_FOUND", "Capability was not found", { details: { batchId } });
  }
  const portal = capabilityPortalForSkill(definition.skill);
  if (portal === undefined) {
    throw new DomainError("INTERNAL_ERROR", "Capability skill is missing from the portal manifest", {
      details: { batchId: definition.batchId, skill: definition.skill },
    });
  }
  const serverAuthorizedErasure = batchId === "B05" && serverAuthorization === "b05-data-erasure";
  if ((!roleCanAccessCapabilityPortal(context.roles, portal) && !serverAuthorizedErasure) ||
      !hasPermission(context, definition.permission)) {
    throw new DomainError("AUTH_FORBIDDEN", "Capability is outside the authenticated portal and permission boundary", {
      details: { batchId: definition.batchId, portalId: portal.id },
    });
  }
  const input = jsonObject(inputValue ?? {}, "input") as Record<string, CapabilityJsonValue>;
  return registry.execute(runtime, batchId, { actor: context, idempotencyKey, input });
}

export function normalizeCapabilityBatchId(batchIdValue: unknown): string {
  return string(batchIdValue, "batchId", 8);
}

export async function dispatchCommand(
  runtime: LifeTimeMachineRuntimePort,
  externalBusinessEventReducers: ExternalBusinessEventReducerRegistry,
  context: ActorContext,
  command: string,
  input: InputObject,
  idempotencyKey: string,
): Promise<unknown> {
  switch (command) {
    case "record.create": {
      const collection = callerMutableCollection(input.collection);
      return runtime.createRecord(context, {
        collection,
        processingPurpose: string(input.processingPurpose, "input.processingPurpose", 120),
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
    }
    case "record.update": {
      const collection = callerMutableCollection(input.collection);
      return runtime.updateRecord(context, {
        collection,
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
    }
    case "record.delete": {
      const collection = callerMutableCollection(input.collection);
      return runtime.deleteRecord(context, {
        collection,
        id: string(input.id, "input.id", 128),
        expectedVersion: integer(input.expectedVersion, "input.expectedVersion", 1),
        idempotencyKey,
      });
    }
    case "consent.grant":
      assertOnlyKeys(input, [
        "participantId", "grantorCapacity", "purpose", "scope", "policyVersion", "evidenceHash", "id", "expiresAt",
      ], "input");
      return runtime.grantConsent(context, {
        participantId: string(input.participantId, "input.participantId", 128),
        grantorCapacity: oneOf(
          input.grantorCapacity,
          "input.grantorCapacity",
          ["self", "guardian", "authorized_agent"] as const,
        ) as GrantorCapacity,
        purpose: string(input.purpose, "input.purpose", 120),
        scope: consentScope(input.scope, "input.scope"),
        policyVersion: string(input.policyVersion, "input.policyVersion", 128),
        idempotencyKey,
        ...(input.evidenceHash === undefined
          ? {}
          : { evidenceHash: string(input.evidenceHash, "input.evidenceHash", 64) }),
        ...(input.id === undefined ? {} : { id: string(input.id, "input.id", 128) }),
        ...(input.expiresAt === undefined
          ? {}
          : { expiresAt: nullableString(input.expiresAt, "input.expiresAt", 64) }),
      });
    case "consent.withdraw":
      assertOnlyKeys(input, ["consentId", "expectedVersion", "reason"], "input");
      return runtime.withdrawConsent(context, {
        consentId: string(input.consentId, "input.consentId", 128),
        expectedVersion: integer(input.expectedVersion, "input.expectedVersion", 1),
        reason: string(input.reason, "input.reason", 500),
        idempotencyKey,
      });
    case "participant.register":
      assertOnlyKeys(input, [
        "participantId", "ownerActorId", "minorStatus", "expiresAt", "expectedVersion", "evidenceId",
      ], "input");
      return runtime.registerParticipant(context, {
        participantId: string(input.participantId, "input.participantId", 128),
        ownerActorId: string(input.ownerActorId, "input.ownerActorId", 128),
        minorStatus: oneOf(
          input.minorStatus,
          "input.minorStatus",
          ["adult", "minor"] as const,
        ) as ParticipantMinorStatus,
        expiresAt: string(input.expiresAt, "input.expiresAt", 64),
        expectedVersion: input.expectedVersion === null
          ? null
          : integer(input.expectedVersion, "input.expectedVersion", 1),
        evidenceId: string(input.evidenceId, "input.evidenceId", 128),
        idempotencyKey,
      });
    case "participant.revoke":
      assertOnlyKeys(input, ["participantId", "expectedVersion", "reason", "evidenceId"], "input");
      return runtime.revokeParticipant(context, {
        participantId: string(input.participantId, "input.participantId", 128),
        expectedVersion: integer(input.expectedVersion, "input.expectedVersion", 1),
        reason: string(input.reason, "input.reason", 500),
        evidenceId: string(input.evidenceId, "input.evidenceId", 128),
        idempotencyKey,
      });
    case "participant-authority.grant":
      assertOnlyKeys(input, [
        "authorizationId", "authorizedActorId", "participantId", "capacity", "scope", "expiresAt", "evidenceId",
      ], "input");
      return runtime.grantParticipantAuthority(context, {
        authorizationId: string(input.authorizationId, "input.authorizationId", 128),
        authorizedActorId: string(input.authorizedActorId, "input.authorizedActorId", 128),
        participantId: string(input.participantId, "input.participantId", 128),
        capacity: oneOf(
          input.capacity,
          "input.capacity",
          ["guardian", "authorized_agent"] as const,
        ) as ParticipantAuthorityCapacity,
        scope: consentScope(input.scope, "input.scope"),
        expiresAt: string(input.expiresAt, "input.expiresAt", 64),
        evidenceId: string(input.evidenceId, "input.evidenceId", 128),
        idempotencyKey,
      });
    case "participant-authority.revoke":
      assertOnlyKeys(input, ["authorizationId", "capacity", "expectedVersion", "reason", "evidenceId"], "input");
      return runtime.revokeParticipantAuthority(context, {
        authorizationId: string(input.authorizationId, "input.authorizationId", 128),
        capacity: oneOf(
          input.capacity,
          "input.capacity",
          ["guardian", "authorized_agent"] as const,
        ) as ParticipantAuthorityCapacity,
        expectedVersion: integer(input.expectedVersion, "input.expectedVersion", 1),
        reason: string(input.reason, "input.reason", 500),
        evidenceId: string(input.evidenceId, "input.evidenceId", 128),
        idempotencyKey,
      });
    case "rights-request.submit":
      assertOnlyKeys(input, [
        "requestId",
        "participantId",
        "requestType",
        "requestedProcessingPurpose",
        "correctionFields",
        "correctionPayloadSha256",
        "parentRequestId",
      ], "input");
      return runtime.submitRightsRequest(context, {
        participantId: string(input.participantId, "input.participantId", 128),
        requestType: oneOf(input.requestType, "input.requestType", RIGHTS_REQUEST_TYPES),
        requestedProcessingPurpose: string(
          input.requestedProcessingPurpose,
          "input.requestedProcessingPurpose",
          120,
        ),
        idempotencyKey,
        ...(input.requestId === undefined ? {} : { requestId: string(input.requestId, "input.requestId", 128) }),
        ...(input.correctionFields === undefined
          ? {}
          : { correctionFields: stringArray(input.correctionFields, "input.correctionFields", 50) }),
        ...(input.correctionPayloadSha256 === undefined
          ? {}
          : { correctionPayloadSha256: string(input.correctionPayloadSha256, "input.correctionPayloadSha256", 64) }),
        ...(input.parentRequestId === undefined
          ? {}
          : { parentRequestId: string(input.parentRequestId, "input.parentRequestId", 128) }),
      });
    case "rights-request.task-receipt":
      assertOnlyKeys(input, [
        "requestId", "taskId", "outcome", "resultSha256", "providerOccurredAt", "evidenceId", "errorCode",
      ], "input");
      return runtime.recordRightsTaskReceipt(context, {
        requestId: string(input.requestId, "input.requestId", 128),
        taskId: string(input.taskId, "input.taskId", 128),
        outcome: oneOf(input.outcome, "input.outcome", ["succeeded", "blocked", "failed"] as const),
        resultSha256: string(input.resultSha256, "input.resultSha256", 64),
        providerOccurredAt: string(input.providerOccurredAt, "input.providerOccurredAt", 64),
        evidenceId: string(input.evidenceId, "input.evidenceId", 128),
        ...(input.errorCode === undefined ? {} : { errorCode: string(input.errorCode, "input.errorCode", 80) }),
        idempotencyKey,
      });
    case "rights-request.review":
      assertOnlyKeys(input, ["requestId", "decision", "reasonCode", "caseReference"], "input");
      return runtime.reviewRightsRequest(context, {
        requestId: string(input.requestId, "input.requestId", 128),
        decision: oneOf(input.decision, "input.decision", ["approve", "deny"] as const),
        reasonCode: string(input.reasonCode, "input.reasonCode", 80),
        caseReference: string(input.caseReference, "input.caseReference", 128),
        idempotencyKey,
      });
    case "rights-request.escalate":
      assertOnlyKeys(input, ["requestId", "reasonCode"], "input");
      return runtime.escalateRightsRequest(context, {
        requestId: string(input.requestId, "input.requestId", 128),
        reasonCode: oneOf(
          input.reasonCode,
          "input.reasonCode",
          ["sla_due", "dependency_blocked", "receipt_failed", "review_disagreement"] as const,
        ),
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
    case "evidence.register": {
      return runtime.registerExternalEvidence(context, {
        evidence: signedExternalEvidence(input.evidence, "input.evidence"),
        idempotencyKey,
      });
    }
    case "evidence.revoke":
      return runtime.revokeExternalEvidence(context, {
        evidenceId: string(input.evidenceId, "input.evidenceId", 128),
        expectedVersion: integer(input.expectedVersion, "input.expectedVersion", 1),
        reason: string(input.reason, "input.reason", 500),
        idempotencyKey,
      });
    case "share-grant.revoke":
      assertOnlyKeys(input, ["exportCommandId", "reason"], "input");
      return new DurableShareGrantService(runtime).requestRevocation(context, {
        exportCommandId: string(input.exportCommandId, "input.exportCommandId", 128),
        reason: string(input.reason, "input.reason", 500),
        idempotencyKey,
      });
    case "external-command.transition":
      assertOnlyKeys(input, [
        "commandId",
        "batchId",
        "operation",
        "aggregateCollection",
        "aggregateId",
        "toState",
        "providerOperationId",
        "evidenceId",
        "details",
      ], "input");
      return runtime.transitionExternalCommand(context, {
        commandId: string(input.commandId, "input.commandId", 128),
        batchId: string(input.batchId, "input.batchId", 8) as `B${string}`,
        operation: string(input.operation, "input.operation", 128),
        aggregateCollection: string(input.aggregateCollection, "input.aggregateCollection", 80),
        aggregateId: string(input.aggregateId, "input.aggregateId", 128),
        toState: oneOf(
          input.toState,
          "input.toState",
          ["dispatched", "acknowledged"] as const,
        ) as ExternalCommandState,
        ...(input.providerOperationId === undefined
          ? {}
          : { providerOperationId: nullableString(input.providerOperationId, "input.providerOperationId", 128) }),
        ...(input.evidenceId === undefined
          ? {}
          : { evidenceId: nullableString(input.evidenceId, "input.evidenceId", 128) }),
        ...(input.details === undefined ? {} : { details: jsonObject(input.details, "input.details") }),
        idempotencyKey,
      });
    case "external-event.apply": {
      if (Object.prototype.hasOwnProperty.call(input, "reducer")) {
        throw new DomainError("AUTH_FORBIDDEN", "External business event reducers cannot be supplied by callers");
      }
      assertOnlyKeys(input, ["event", "evidence"], "input");
      const event = verifiedBusinessEvent(input.event, "input.event");
      const reducer = externalBusinessEventReducers.resolve(event);
      if (reducer === undefined) {
        throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", "No trusted reducer is registered for this business event", {
          details: { batchId: event.batchId, operation: event.operation, eventType: event.eventType },
        });
      }
      return runtime.applyExternalBusinessEvent(context, {
        event,
        evidence: signedExternalEvidence(input.evidence, "input.evidence"),
        reducer,
        idempotencyKey,
      });
    }
    default:
      throw new DomainError("RESOURCE_NOT_FOUND", "Command was not found", { details: { command } });
  }
}

export async function dispatchQuery(
  runtime: LifeTimeMachineRuntimePort,
  context: ActorContext,
  query: string,
  input: InputObject,
): Promise<unknown> {
  switch (query) {
    case "record.get": {
      const collection = callerReadableCollection(input.collection);
      return runtime.getRecord(
        context,
        collection,
        string(input.id, "input.id", 128),
      );
    }
    case "record.list": {
      const collection = callerReadableCollection(input.collection);
      return runtime.listRecords(context, {
        collection,
        ...(input.limit === undefined ? {} : { limit: integer(input.limit, "input.limit", 1, 200) }),
        ...(input.cursor === undefined ? {} : { cursor: string(input.cursor, "input.cursor", 128) }),
        ...(input.includeDeleted === undefined
          ? {}
          : { includeDeleted: boolean(input.includeDeleted, "input.includeDeleted") }),
      });
    }
    case "consent.require": {
      assertOnlyKeys(input, ["participantIds", "purpose", "scope", "at"], "input");
      const scope = object(input.scope, "input.scope");
      assertOnlyKeys(scope, ["resource", "action"], "input.scope");
      return runtime.requireConsent(context, {
        participantIds: stringArray(input.participantIds, "input.participantIds", 100),
        ...(input.purpose === undefined ? {} : { purpose: string(input.purpose, "input.purpose", 120) }),
        scope: {
          resource: string(scope.resource, "input.scope.resource", 256),
          action: string(scope.action, "input.scope.action", 80),
        },
        ...(input.at === undefined ? {} : { at: string(input.at, "input.at", 64) }),
      });
    }
    case "consent.list":
      return runtime.listConsents(
        context,
        input.participantId === undefined ? undefined : string(input.participantId, "input.participantId", 128),
      );
    case "rights-request.get":
      assertOnlyKeys(input, ["requestId"], "input");
      return runtime.getRightsRequest(context, string(input.requestId, "input.requestId", 128));
    case "rights-request.list":
      assertOnlyKeys(input, ["limit", "cursor"], "input");
      return runtime.listRightsRequests(context, {
        ...(input.limit === undefined ? {} : { limit: integer(input.limit, "input.limit", 1, 200) }),
        ...(input.cursor === undefined ? {} : { cursor: string(input.cursor, "input.cursor", 128) }),
      });
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
    case "evidence.get":
      return runtime.getExternalEvidence(context, string(input.evidenceId, "input.evidenceId", 128));
    case "evidence.list":
      return runtime.listExternalEvidence(context, {
        ...(input.scope === undefined ? {} : { scope: string(input.scope, "input.scope", 512) }),
        ...(input.limit === undefined ? {} : { limit: integer(input.limit, "input.limit", 1, 200) }),
      });
    case "external-command.get":
      assertOnlyKeys(input, ["commandId"], "input");
      return runtime.getExternalCommand(context, string(input.commandId, "input.commandId", 128));
    case "share-grant.get":
      assertOnlyKeys(input, ["exportCommandId"], "input");
      return new DurableShareGrantService(runtime).get(
        context,
        string(input.exportCommandId, "input.exportCommandId", 128),
      );
    case "share-grant.list":
      assertOnlyKeys(input, ["limit", "cursor"], "input");
      return new DurableShareGrantService(runtime).list(context, {
        ...(input.limit === undefined ? {} : { limit: integer(input.limit, "input.limit", 1, 200) }),
        ...(input.cursor === undefined ? {} : { cursor: string(input.cursor, "input.cursor", 128) }),
      });
    default:
      throw new DomainError("RESOURCE_NOT_FOUND", "Query was not found", { details: { query } });
  }
}

function callerMutableCollection(value: unknown): string {
  const collection = string(value, "input.collection", 80);
  if (collection === "media.intake-results") {
    throw new DomainError(
      "AUTH_FORBIDDEN",
      "Media intake records are server-managed; use the server-verified B07 capability path",
    );
  }
  if (SERVER_MANAGED_MUTATION_COLLECTIONS.has(collection)) {
    throw new DomainError(
      "AUTH_FORBIDDEN",
      "Provider-owned aggregates are server-managed; use their capability or signed external-event contract",
    );
  }
  return collection;
}

function callerReadableCollection(value: unknown): string {
  const collection = string(value, "input.collection", 80);
  if (collection === RIGHTS_REQUEST_COLLECTION) {
    throw new DomainError(
      "AUTH_FORBIDDEN",
      "Rights requests are exposed only through the minimized rights-request projection contract",
    );
  }
  if (SHARE_COMMAND_COLLECTIONS.has(collection)) {
    throw new DomainError(
      "AUTH_FORBIDDEN",
      "Share command aggregates are not exposed through generic record queries; use the share-grant projection contract",
    );
  }
  return collection;
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

function consentScope(value: unknown, label: string): JsonObject {
  const scope = object(value, label);
  assertOnlyKeys(scope, ["resource", "actions"], label);
  const actions = stringArray(scope.actions, `${label}.actions`, 32);
  if (actions.length === 0 || new Set(actions).size !== actions.length) {
    throw new DomainError("VALIDATION_FAILED", `${label}.actions must be a non-empty unique list`);
  }
  return {
    resource: string(scope.resource, `${label}.resource`, 256),
    actions: [...actions],
  };
}

function oneOf<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new DomainError("VALIDATION_FAILED", `${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function signedExternalEvidence(value: unknown, label: string): SignedExternalEvidence {
  const evidence = object(value, label);
  assertOnlyKeys(evidence, [
    "version",
    "evidenceId",
    "tenantId",
    "issuer",
    "provider",
    "environment",
    "scope",
    "artifactSha256",
    "canonicalClaimsSha256",
    "businessEventSha256",
    "issuedAt",
    "expiresAt",
    "nonce",
    "replayPolicy",
    "algorithm",
    "keyId",
    "signature",
  ], label);
  return {
    version: oneOf(evidence.version, `${label}.version`, ["ltm.external-evidence.v1"] as const),
    evidenceId: string(evidence.evidenceId, `${label}.evidenceId`, 128),
    tenantId: string(evidence.tenantId, `${label}.tenantId`, 128),
    issuer: string(evidence.issuer, `${label}.issuer`, 128),
    provider: string(evidence.provider, `${label}.provider`, 128),
    environment: oneOf(
      evidence.environment,
      `${label}.environment`,
      ["test", "sandbox", "staging", "production"] as const,
    ) as EvidenceEnvironment,
    scope: string(evidence.scope, `${label}.scope`, 512),
    artifactSha256: string(evidence.artifactSha256, `${label}.artifactSha256`, 64),
    ...(evidence.canonicalClaimsSha256 === undefined
      ? {}
      : { canonicalClaimsSha256: string(evidence.canonicalClaimsSha256, `${label}.canonicalClaimsSha256`, 64) }),
    ...(evidence.businessEventSha256 === undefined
      ? {}
      : { businessEventSha256: string(evidence.businessEventSha256, `${label}.businessEventSha256`, 64) }),
    issuedAt: string(evidence.issuedAt, `${label}.issuedAt`, 64),
    expiresAt: string(evidence.expiresAt, `${label}.expiresAt`, 64),
    nonce: string(evidence.nonce, `${label}.nonce`, 128),
    replayPolicy: oneOf(evidence.replayPolicy, `${label}.replayPolicy`, ["reusable", "single_use"] as const),
    algorithm: oneOf(evidence.algorithm, `${label}.algorithm`, ["Ed25519"] as const),
    keyId: string(evidence.keyId, `${label}.keyId`, 128),
    signature: string(evidence.signature, `${label}.signature`, 160),
  };
}

function verifiedBusinessEvent(value: unknown, label: string): VerifiedBusinessEvent {
  const event = object(value, label);
  assertOnlyKeys(event, [
    "version",
    "eventId",
    "tenantId",
    "batchId",
    "operation",
    "provider",
    "subjectType",
    "subjectId",
    "eventType",
    "providerOccurredAt",
    "sequence",
    "correlationId",
    "artifactSha256",
    "evidenceId",
    "evidenceScope",
    "canonicalClaims",
    "canonicalClaimsSha256",
    "businessEventSha256",
  ], label);
  const sequence = event.sequence;
  if (sequence !== null && !Number.isSafeInteger(sequence)) {
    throw new DomainError("VALIDATION_FAILED", `${label}.sequence must be null or an integer`);
  }
  return {
    version: oneOf(event.version, `${label}.version`, ["ltm.external-business-event.v1"] as const),
    eventId: string(event.eventId, `${label}.eventId`, 128),
    tenantId: string(event.tenantId, `${label}.tenantId`, 128),
    batchId: string(event.batchId, `${label}.batchId`, 8) as `B${string}`,
    operation: string(event.operation, `${label}.operation`, 128),
    provider: string(event.provider, `${label}.provider`, 128),
    subjectType: string(event.subjectType, `${label}.subjectType`, 128),
    subjectId: string(event.subjectId, `${label}.subjectId`, 128),
    eventType: string(event.eventType, `${label}.eventType`, 128),
    providerOccurredAt: string(event.providerOccurredAt, `${label}.providerOccurredAt`, 64),
    sequence: sequence as number | null,
    correlationId: string(event.correlationId, `${label}.correlationId`, 128),
    artifactSha256: string(event.artifactSha256, `${label}.artifactSha256`, 64),
    evidenceId: string(event.evidenceId, `${label}.evidenceId`, 128),
    evidenceScope: string(event.evidenceScope, `${label}.evidenceScope`, 512),
    canonicalClaims: jsonObject(event.canonicalClaims, `${label}.canonicalClaims`),
    canonicalClaimsSha256: string(event.canonicalClaimsSha256, `${label}.canonicalClaimsSha256`, 64),
    businessEventSha256: string(event.businessEventSha256, `${label}.businessEventSha256`, 64),
  };
}

function assertOnlyKeys(value: InputObject, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key)).sort();
  if (unexpected.length > 0) {
    throw new DomainError("VALIDATION_FAILED", `${label} contains unsupported fields`, {
      details: { fields: unexpected },
    });
  }
}
