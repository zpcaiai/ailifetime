import { createHash } from "node:crypto";
import { DomainError } from "./errors.js";
import { hasPermission } from "./policy.js";
import type {
  ActorContext,
  ExternalCommandRecord,
  ExternalCommandState,
  IdempotentResult,
  JsonObject,
  LifeTimeMachineRuntimePort,
  RecordEnvelope,
} from "./types.js";

export const SHARE_EXPORT_COLLECTION = "sharing.export-commands";
export const SHARE_REVOKE_COLLECTION = "sharing.export-revoke-commands";
export const SHARE_EXPORT_OPERATION = "publishExport";
export const SHARE_REVOKE_OPERATION = "revokeExport";

export type ShareGrantState =
  | "publication_pending"
  | "active"
  | "expired"
  | "revocation_requested"
  | "revocation_required"
  | "revocation_failed"
  | "revoked"
  | "unavailable"
  | "reconciliation_required";

export interface ShareGrantProjection {
  /** The immutable original B10 export command ID. */
  readonly grantId: string;
  readonly exportCommandId: string;
  readonly exportRecordId: string;
  readonly workId: string;
  readonly expiresAt: string;
  readonly state: ShareGrantState;
  /** Opaque provider share reference. Null whenever client sharing must be disabled. */
  readonly providerOperationId: string | null;
  readonly exportCommandState: ExternalCommandState;
  readonly revokeCommandId: string | null;
  readonly revokeCommandState: ExternalCommandState | null;
  readonly updatedAt: string;
}

export interface RequestShareGrantRevocationInput {
  readonly exportCommandId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface ShareGrantRevocationRequest {
  readonly grant: ShareGrantProjection;
  readonly record: RecordEnvelope;
  readonly command: ExternalCommandRecord;
}

export interface ListShareGrantsInput {
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * Durable B10 share authority built exclusively from server-owned records and
 * external commands. The client supplies only the original export command ID;
 * provider IDs, tenant, actor, work and aggregate bindings are copied from the
 * persisted successful export. The resulting revoke request is an ordinary
 * outbox-backed B10 command and only a signed terminal callback can mark it
 * revoked.
 */
export class DurableShareGrantService {
  readonly #clock: () => Date;

  constructor(
    private readonly runtime: LifeTimeMachineRuntimePort,
    clock: () => Date = () => runtime.currentTime(),
  ) {
    this.#clock = clock;
  }

  async get(context: ActorContext, exportCommandIdValue: string): Promise<ShareGrantProjection> {
    const exportCommandId = identifier(exportCommandIdValue, "exportCommandId");
    const { command: exportCommand, record: exportRecord, sharingConsentActive } =
      await this.runtime.getShareGrantCommandBinding(context, exportCommandId, "read");
    assertExportBinding(exportCommand, exportRecord);
    assertGrantAccess(context, exportRecord, "read");
    const revoke = await this.#optionalRevokeBinding(context, exportCommand, exportRecord, "read");
    return projectGrant(exportCommand, exportRecord, revoke?.command ?? null, sharingConsentActive, this.#clock());
  }

  async list(context: ActorContext, input: ListShareGrantsInput = {}): Promise<readonly ShareGrantProjection[]> {
    const bindings = await this.runtime.listShareGrantCommandBindings(context, {
      ...(input.limit === undefined ? {} : { limit: boundedLimit(input.limit) }),
      ...(input.cursor === undefined ? {} : { cursor: identifier(input.cursor, "cursor") }),
    });
    const grants: ShareGrantProjection[] = [];
    for (const binding of bindings) {
      assertExportBinding(binding.command, binding.record);
      const revoke = await this.#optionalRevokeBinding(context, binding.command, binding.record, "read");
      grants.push(projectGrant(
        binding.command,
        binding.record,
        revoke?.command ?? null,
        binding.sharingConsentActive,
        this.#clock(),
      ));
    }
    return grants;
  }

  async requestRevocation(
    context: ActorContext,
    input: RequestShareGrantRevocationInput,
  ): Promise<IdempotentResult<ShareGrantRevocationRequest>> {
    const exportCommandId = identifier(input.exportCommandId, "exportCommandId");
    const reason = visible(input.reason, "share revocation reason", 500);
    const idempotencyKey = visible(input.idempotencyKey, "idempotencyKey", 200);
    const { command: exportCommand, record: exportRecord, sharingConsentActive } =
      await this.runtime.getShareGrantCommandBinding(context, exportCommandId, "revoke");
    const exportData = assertExportBinding(exportCommand, exportRecord);
    assertGrantAccess(context, exportRecord, "revoke");
    if (exportCommand.decisionState !== "active" || exportCommand.reconciliationState !== "clear") {
      throw new DomainError("EVIDENCE_REVOKED", "Share export is frozen pending reconciliation");
    }
    if (exportCommand.state !== "succeeded" || exportCommand.providerOperationId === null) {
      throw new DomainError("VERSION_CONFLICT", "Only a signed successful share grant can be revoked", {
        details: { exportCommandId, state: exportCommand.state },
      });
    }

    const existing = await this.#optionalRevokeBinding(context, exportCommand, exportRecord, "revoke");
    if (existing !== null) {
      return {
        value: {
          grant: projectGrant(exportCommand, exportRecord, existing.command, sharingConsentActive, this.#clock()),
          record: existing.record,
          command: existing.command,
        },
        replayed: true,
      };
    }

    const revokeCommandId = shareRevokeCommandId(exportCommandId);
    const binding = {
      batchId: "B10",
      skill: "building-consumer-time-machine",
      operation: SHARE_REVOKE_OPERATION,
      operationMode: "external-command",
      purpose: "sharing_revocation",
      exportCommandId,
      exportRecordId: exportRecord.id,
      targetProviderOperationId: exportCommand.providerOperationId,
      workId: exportData.workId,
      expiresAt: exportData.expiresAt,
      requestedByActorId: context.actorId,
      reason,
    } as const satisfies JsonObject;
    try {
      const created = await this.runtime.createExternalCommand(context, {
        record: {
          collection: SHARE_REVOKE_COLLECTION,
          id: revokeCommandId,
          data: binding,
          ownerActorId: exportRecord.ownerActorId,
          // Revocation must remain possible without copying media/participant
          // data into the provider command or demanding renewed sharing consent.
          participantIds: [],
          containsMinor: false,
          processingPurpose: "sharing",
        },
        commandId: revokeCommandId,
        batchId: "B10",
        operation: SHARE_REVOKE_OPERATION,
        details: {
          requestedBy: context.actorId,
          exportCommandId,
          exportRecordId: exportRecord.id,
          targetProviderOperationId: exportCommand.providerOperationId,
        },
        idempotencyKey: `B10:share-revoke:${createHash("sha256").update(idempotencyKey).digest("hex")}`,
      });
      return {
        value: {
          grant: projectGrant(exportCommand, exportRecord, created.value.command, sharingConsentActive, this.#clock()),
          record: created.value.record,
          command: created.value.command,
        },
        replayed: created.replayed,
      };
    } catch (error) {
      // A concurrent request with another HTTP idempotency key is still one
      // logical provider revocation. The deterministic command ID closes that
      // race without generating a second provider side effect.
      if (!(error instanceof DomainError) || error.code !== "VERSION_CONFLICT") throw error;
      const concurrent = await this.#optionalRevokeBinding(context, exportCommand, exportRecord, "revoke");
      if (concurrent === null) throw error;
      return {
        value: {
          grant: projectGrant(exportCommand, exportRecord, concurrent.command, sharingConsentActive, this.#clock()),
          record: concurrent.record,
          command: concurrent.command,
        },
        replayed: true,
      };
    }
  }

  async #optionalRevokeBinding(
    context: ActorContext,
    exportCommand: ExternalCommandRecord,
    exportRecord: RecordEnvelope,
    access: "read" | "revoke",
  ): Promise<{ readonly command: ExternalCommandRecord; readonly record: RecordEnvelope } | null> {
    const revokeCommandId = shareRevokeCommandId(exportCommand.commandId);
    let command: ExternalCommandRecord;
    let record: RecordEnvelope;
    try {
      const binding = await this.runtime.getShareGrantCommandBinding(context, revokeCommandId, access);
      command = binding.command;
      record = binding.record;
    } catch (error) {
      if (error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND") return null;
      throw error;
    }
    assertRevokeBinding(command, record, exportCommand, exportRecord);
    return { command, record };
  }
}

export function shareRevokeCommandId(exportCommandIdValue: string): string {
  const exportCommandId = identifier(exportCommandIdValue, "exportCommandId");
  const digest = createHash("sha256").update("ltm-share-revoke-v1\0").update(exportCommandId).digest("hex");
  return `B10-revoke:${digest}`;
}

function assertExportBinding(
  command: ExternalCommandRecord,
  record: RecordEnvelope,
): { readonly workId: string; readonly expiresAt: string } {
  if (command.batchId !== "B10" || command.operation !== SHARE_EXPORT_OPERATION ||
      command.aggregateCollection !== SHARE_EXPORT_COLLECTION || command.aggregateId !== record.id ||
      record.collection !== SHARE_EXPORT_COLLECTION || record.tenantId !== command.tenantId ||
      record.data.batchId !== "B10" || record.data.operation !== SHARE_EXPORT_OPERATION ||
      record.data.operationMode !== "external-command" || record.data.externalCommandId !== command.commandId ||
      record.data.revocable !== true || record.ownerActorId === null ||
      command.details.requestedBy !== record.ownerActorId) {
    throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Share grant does not match its persisted B10 export intent");
  }
  const workId = identifierValue(record.data.workId, "stored share workId");
  const expiresAt = canonicalTimestamp(record.data.expiresAt, "stored share expiresAt");
  if (command.state === "succeeded") {
    const receipt = objectValue(record.data.externalReceipt, "stored share externalReceipt");
    if (receipt.providerOperationId !== command.providerOperationId || receipt.state !== "succeeded") {
      throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Share provider operation is not bound to the signed export result");
    }
  }
  return { workId, expiresAt };
}

function assertRevokeBinding(
  command: ExternalCommandRecord,
  record: RecordEnvelope,
  exportCommand: ExternalCommandRecord,
  exportRecord: RecordEnvelope,
): void {
  if (command.commandId !== shareRevokeCommandId(exportCommand.commandId) || command.batchId !== "B10" ||
      command.operation !== SHARE_REVOKE_OPERATION || command.aggregateCollection !== SHARE_REVOKE_COLLECTION ||
      command.aggregateId !== record.id || record.collection !== SHARE_REVOKE_COLLECTION ||
      record.tenantId !== exportRecord.tenantId || record.ownerActorId !== exportRecord.ownerActorId ||
      record.data.batchId !== "B10" || record.data.operation !== SHARE_REVOKE_OPERATION ||
      record.data.operationMode !== "external-command" || record.data.externalCommandId !== command.commandId ||
      record.data.exportCommandId !== exportCommand.commandId || record.data.exportRecordId !== exportRecord.id ||
      record.data.workId !== exportRecord.data.workId || record.data.expiresAt !== exportRecord.data.expiresAt ||
      record.data.requestedByActorId !== command.details.requestedBy ||
      command.details.exportCommandId !== exportCommand.commandId || command.details.exportRecordId !== exportRecord.id ||
      record.data.targetProviderOperationId !== exportCommand.providerOperationId ||
      command.details.targetProviderOperationId !== exportCommand.providerOperationId) {
    throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "Share revocation command does not match its persisted export grant");
  }
}

function assertGrantAccess(context: ActorContext, record: RecordEnvelope, action: "read" | "revoke"): void {
  if (!canAccessGrant(context, record, action)) {
    throw new DomainError("AUTH_FORBIDDEN", `Share grant ${action} is restricted to its owner or an explicit administrator`);
  }
}

function canAccessGrant(context: ActorContext, record: RecordEnvelope, action: "read" | "revoke"): boolean {
  return record.ownerActorId === context.actorId || hasPermission(context, `share-grant:${action}:any`);
}

function projectGrant(
  exportCommand: ExternalCommandRecord,
  exportRecord: RecordEnvelope,
  revokeCommand: ExternalCommandRecord | null,
  sharingConsentActive: boolean,
  now: Date,
): ShareGrantProjection {
  const exportData = assertExportBinding(exportCommand, exportRecord);
  const expired = Date.parse(exportData.expiresAt) <= now.getTime();
  let state: ShareGrantState;
  if (revokeCommand?.state === "succeeded" || exportCommand.state === "compensated") {
    state = "revoked";
  } else if (!sharingConsentActive) {
    state = "revocation_required";
  } else if (exportCommand.decisionState === "frozen" || exportCommand.reconciliationState === "reconciliation_required" ||
      revokeCommand?.decisionState === "frozen" || revokeCommand?.reconciliationState === "reconciliation_required") {
    state = "reconciliation_required";
  } else if (revokeCommand !== null && ["requested", "dispatched", "acknowledged"].includes(revokeCommand.state)) {
    state = "revocation_requested";
  } else if (revokeCommand !== null && ["failed", "cancelled"].includes(revokeCommand.state)) {
    state = "revocation_failed";
  } else if (exportCommand.state === "succeeded") {
    state = expired ? "expired" : "active";
  } else if (["requested", "dispatched", "acknowledged"].includes(exportCommand.state)) {
    state = "publication_pending";
  } else {
    state = "unavailable";
  }
  const shareEnabled = state === "active" && exportCommand.providerOperationId !== null;
  return {
    grantId: exportCommand.commandId,
    exportCommandId: exportCommand.commandId,
    exportRecordId: exportRecord.id,
    workId: exportData.workId,
    expiresAt: exportData.expiresAt,
    state,
    providerOperationId: shareEnabled ? exportCommand.providerOperationId : null,
    exportCommandState: exportCommand.state,
    revokeCommandId: revokeCommand?.commandId ?? null,
    revokeCommandState: revokeCommand?.state ?? null,
    updatedAt: revokeCommand?.updatedAt ?? exportCommand.updatedAt,
  };
}

function identifier(value: string, label: string): string {
  const normalized = visible(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new DomainError("VALIDATION_FAILED", `${label} is invalid`);
  }
  return normalized;
}

function identifierValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new DomainError("INTERNAL_ERROR", `${label} is missing`);
  try {
    return identifier(value, label);
  } catch {
    throw new DomainError("INTERNAL_ERROR", `${label} is invalid`);
  }
}

function visible(value: string, label: string, maximum: number): string {
  if (typeof value !== "string") throw new DomainError("VALIDATION_FAILED", `${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new DomainError("VALIDATION_FAILED", `${label} is invalid`);
  }
  return normalized;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
    throw new DomainError("INTERNAL_ERROR", `${label} is invalid`);
  }
  return value;
}

function objectValue(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("EVENT_FINGERPRINT_CONFLICT", `${label} is invalid`);
  }
  return value as JsonObject;
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new DomainError("VALIDATION_FAILED", "share grant limit must be between 1 and 200");
  }
  return value;
}
