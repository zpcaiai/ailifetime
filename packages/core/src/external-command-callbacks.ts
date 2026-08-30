import { DomainError } from "./errors.js";
import type {
  ExternalCommandRecord,
  ExternalCommandState,
  JsonObject,
  JsonValue,
  RecordEnvelope,
  SignedExternalEvidence,
  VerifiedBusinessEvent,
} from "./types.js";

export type ExternalCommandTerminalState = "succeeded" | "failed" | "cancelled" | "compensated";

export const EXTERNAL_COMMAND_TERMINAL_EVENT_TYPES = Object.freeze({
  succeeded: "external-command.succeeded",
  failed: "external-command.failed",
  cancelled: "external-command.cancelled",
  compensated: "external-command.compensated",
} as const satisfies Readonly<Record<ExternalCommandTerminalState, string>>);

export type ExternalCommandCallbackProviderBinding =
  | { readonly kind: "exact"; readonly provider: string }
  | { readonly kind: "record-field"; readonly prefix: string; readonly field: string }
  | {
      readonly kind: "record-provider-pair";
      readonly typeField: string;
      readonly idField: string;
      readonly allowedTypes: readonly string[];
    };

export interface ExternalCommandCallbackRoute {
  readonly routeId: string;
  readonly batchId: `B${string}`;
  readonly operation: string;
  readonly collection: string;
  readonly subjectType: string;
  readonly evidenceKind: string;
  readonly providerBinding: ExternalCommandCallbackProviderBinding;
  readonly requiredClaimIdentifiers?: readonly string[];
}

/**
 * The complete compile-time callback surface for commands created by the B00-B127
 * capability catalog. Collections, subjects, provider authority and evidence
 * kinds are application-owned; no callback payload can replace them.
 */
export const EXTERNAL_COMMAND_CALLBACK_ROUTES = Object.freeze([
  route("b05-media-lifecycle", "B05", "scheduleMediaLifecycle", "media.lifecycle-commands", "media-lifecycle", "media-lifecycle-result", exact("media-lifecycle")),
  route("b10-export", "B10", "publishExport", "sharing.export-commands", "export", "export-publication-result", exact("export-publisher")),
  route("b10-export-revoke", "B10", "revokeExport", "sharing.export-revoke-commands", "export-revocation", "export-revocation-result", exact("export-publisher"), ["targetProviderOperationId"]),
  route("b13-workflow", "B13", "startDurableWorkflow", "workflows.start-commands", "workflow", "workflow-result", exact("workflow-engine")),
  route("b14-timeline", "B14", "createTimeline", "generation.timeline-commands", "timeline-job", "timeline-generation-result", exact("generation-engine")),
  route("b16-video-render", "B16", "renderVideo", "media.video-render-commands", "video-render", "video-render-result", exact("video-renderer")),
  route("b23-future-self", "B23", "converseWithFutureSelf", "future-self.dialogue-commands", "dialogue-turn", "future-self-dialogue-result", exact("future-self-engine")),
  route("b26-checkout", "B26", "authorizeCheckout", "commerce.checkout-commands", "checkout", "checkout-result", exact("checkout-orchestrator")),
  route("b29-fulfillment", "B29", "submitPhysicalFulfillment", "fulfillment.submit-commands", "fulfillment-order", "fulfillment-result", exact("fulfillment-provider")),
  route("b36-gift-memorial", "B36", "processGiftOrMemorial", "channels.gift-memorial-commands", "gift-memorial-order", "gift-memorial-result", exact("gift-memorial-provider")),
  route("b38-crm-handoff", "B38", "handoffLead", "channels.crm-handoff-commands", "crm-handoff", "crm-handoff-result", exact("crm-handoff-provider")),
  route("b40-lifecycle-message", "B40", "scheduleLifecycleMessage", "notifications.lifecycle-commands", "lifecycle-message", "lifecycle-message-result", exact("lifecycle-notification-provider")),
  route("b65-mobile-generation", "B65", "runMobileGenerationAction", "capability.building-mobile-and-mini-programs", "mobile-generation-action", "mobile-generation-result", exact("mobile-generation-provider")),
  route("b67-mobile-notification", "B67", "registerMobileNotification", "capability.building-mobile-and-mini-programs", "mobile-notification", "mobile-notification-result", exact("mobile-notification-provider")),
  route("b74-notification", "B74", "scheduleMultiChannelNotification", "notification.delivery-commands", "notification", "notification-route", recordField("notification:", "providerId")),
  route("b83-support-remedy", "B83", "requestControlledSupportAction", "capability.building-customer-support-success", "support-remedy", "support-remedy-result", exact("support-remedy-provider")),
  route("b89-tax-document", "B89", "requestTaxDocument", "finance.tax-document-commands", "tax-document", "tax-document-request", recordField("tax-authority:", "providerId")),
  route("b98-vendor-job", "B98", "createVendorProductionJob", "supply.vendor-production-commands", "vendor-job", "vendor-job-acceptance", recordField("vendor:", "vendorId"), ["vendorId"]),
  route("b101-return-claim", "B101", "createReturnOrClaim", "supply.return-claim-commands", "return-claim", "return-claim", {
    kind: "record-provider-pair",
    typeField: "providerType",
    idField: "providerId",
    allowedTypes: ["vendor", "carrier"],
  }, ["vendorId"]),
] as const satisfies readonly ExternalCommandCallbackRoute[]);

export type ExternalCommandCallbackRouteDefinition = (typeof EXTERNAL_COMMAND_CALLBACK_ROUTES)[number];
export type ExternalCommandCallbackBatchId = ExternalCommandCallbackRouteDefinition["batchId"];

export function resolveExternalCommandCallbackRoute(
  batchId: string,
  operation: string,
): ExternalCommandCallbackRouteDefinition | undefined {
  return EXTERNAL_COMMAND_CALLBACK_ROUTES.find(
    (candidate) => candidate.batchId === batchId && candidate.operation === operation,
  );
}

export function externalCommandCallbackProviderAllowed(
  routeDefinition: ExternalCommandCallbackRoute,
  provider: string,
): boolean {
  const binding = routeDefinition.providerBinding;
  if (binding.kind === "exact") return provider === binding.provider;
  if (binding.kind === "record-field") {
    return provider.startsWith(binding.prefix) && provider.length > binding.prefix.length;
  }
  const separator = provider.indexOf(":");
  if (separator <= 0 || separator === provider.length - 1) return false;
  return binding.allowedTypes.includes(provider.slice(0, separator));
}

export interface FrozenExternalCommandReconciliation {
  readonly terminalState: ExternalCommandTerminalState;
  readonly originalFreezeReason: string;
  readonly previousState: ExternalCommandState;
}

/** Return the next state-graph edge inferred by an exact signed terminal fact. */
export function frozenExternalCommandReconciliationBridge(
  current: ExternalCommandState,
  terminal: ExternalCommandTerminalState,
): ExternalCommandState | null {
  if (current === "requested" && terminal !== "cancelled") return "dispatched";
  if (current === "dispatched" && (terminal === "succeeded" || terminal === "compensated")) {
    return "acknowledged";
  }
  if (current === "acknowledged" && terminal === "compensated") return "succeeded";
  return null;
}

/**
 * Validate the sole path allowed to resolve a frozen external command. This is
 * deliberately a pure binding check used by both storage runtimes; it does not
 * expose an unfreeze operation. The caller must still perform the state change
 * inside the same transaction that consumes the signed business evidence.
 */
export function validateFrozenExternalCommandReconciliation(
  command: ExternalCommandRecord,
  aggregate: RecordEnvelope,
  event: VerifiedBusinessEvent,
  evidence: SignedExternalEvidence,
  toState: ExternalCommandState,
): FrozenExternalCommandReconciliation {
  if (command.decisionState !== "frozen" || command.reconciliationState !== "reconciliation_required" ||
      aggregate.data._externalDecisionState !== "frozen" ||
      aggregate.data._externalReconciliationState !== "reconciliation_required") {
    throw new DomainError("EVIDENCE_REVOKED", "External command is not in the exact frozen reconciliation state");
  }
  if (evidence.replayPolicy !== "single_use") {
    throw new DomainError(
      "EVIDENCE_REPLAY_DETECTED",
      "Frozen external-command reconciliation requires single-use signed evidence",
    );
  }
  const terminalState = terminalStateForEventType(event.eventType);
  if (terminalState === null || toState !== terminalState) {
    throw new DomainError(
      "EVIDENCE_REVOKED",
      "Only an exact terminal external-command event may reconcile a frozen command",
    );
  }
  if (event.tenantId !== command.tenantId || event.subjectId !== command.commandId ||
      event.correlationId !== command.commandId || aggregate.tenantId !== command.tenantId ||
      aggregate.collection !== command.aggregateCollection || aggregate.id !== command.aggregateId ||
      event.batchId !== command.batchId || event.operation !== command.operation) {
    throw new DomainError(
      "EVENT_FINGERPRINT_CONFLICT",
      "Frozen external-command event does not match its tenant, command, operation, or aggregate",
    );
  }
  const routeDefinition = resolveExternalCommandCallbackRoute(command.batchId, command.operation);
  if (routeDefinition === undefined || routeDefinition.collection !== command.aggregateCollection ||
      routeDefinition.subjectType !== event.subjectType) {
    throw new DomainError(
      "EXTERNAL_ADAPTER_UNAVAILABLE",
      "Frozen external command has no exact trusted terminal callback route",
    );
  }
  if (aggregate.data.operationMode !== "external-command" || aggregate.data.externalCommandId !== command.commandId ||
      aggregate.data.batchId !== command.batchId || aggregate.data.operation !== command.operation) {
    throw new DomainError(
      "EVENT_FINGERPRINT_CONFLICT",
      "Frozen external-command aggregate binding is invalid",
    );
  }
  const expectedProvider = expectedProviderForRecord(routeDefinition, aggregate.data);
  if (event.provider !== expectedProvider || evidence.provider !== expectedProvider) {
    throw new DomainError(
      "TENANT_SCOPE_MISMATCH",
      "Frozen external-command reconciliation provider does not match the requested authority",
      { details: { expectedProvider, actualProvider: event.provider } },
    );
  }
  for (const field of routeDefinition.requiredClaimIdentifiers ?? []) {
    const persisted = persistedIdentifier(aggregate.data[field], field);
    const supplied = persistedIdentifier(event.canonicalClaims[field], field);
    if (persisted !== supplied) {
      throw new DomainError(
        "TENANT_SCOPE_MISMATCH",
        "Frozen external-command reconciliation claim does not match the requested command",
        { details: { field } },
      );
    }
  }
  const freezeReason = originalFreezeReason(command.details);
  if (freezeReason !== "outbox_dead_letter") {
    throw new DomainError(
      "EVIDENCE_REVOKED",
      "Only an outbox dead-letter ambiguity may be automatically reconciled by a provider terminal event",
      { details: { originalFreezeReason: freezeReason } },
    );
  }
  return {
    terminalState,
    originalFreezeReason: freezeReason,
    previousState: command.state,
  };
}

function terminalStateForEventType(eventType: string): ExternalCommandTerminalState | null {
  for (const [state, expectedEventType] of Object.entries(EXTERNAL_COMMAND_TERMINAL_EVENT_TYPES)) {
    if (eventType === expectedEventType) return state as ExternalCommandTerminalState;
  }
  return null;
}

function expectedProviderForRecord(routeDefinition: ExternalCommandCallbackRoute, data: JsonObject): string {
  const binding = routeDefinition.providerBinding;
  if (binding.kind === "exact") return binding.provider;
  if (binding.kind === "record-field") {
    return `${binding.prefix}${persistedIdentifier(data[binding.field], binding.field)}`;
  }
  const providerType = persistedIdentifier(data[binding.typeField], binding.typeField);
  if (!binding.allowedTypes.includes(providerType)) {
    throw new DomainError("INTERNAL_ERROR", "Frozen external command has an unsupported persisted provider type");
  }
  return `${providerType}:${persistedIdentifier(data[binding.idField], binding.idField)}`;
}

function persistedIdentifier(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new DomainError("INTERNAL_ERROR", `Frozen external command is missing persisted ${field}`);
  }
  return value;
}

function originalFreezeReason(details: JsonObject): string {
  if (typeof details.reconciliationReason === "string" && details.reconciliationReason.length > 0) {
    return details.reconciliationReason;
  }
  if (typeof details.deadLetterEventId === "string") return "outbox_dead_letter";
  if (typeof details.withdrawnConsentId === "string") return "participant_consent_withdrawal";
  return "evidence_or_delivery_reconciliation_required";
}

function route<
  const RouteId extends string,
  const Batch extends `B${string}`,
  const Operation extends string,
  const Collection extends string,
  const SubjectType extends string,
  const EvidenceKind extends string,
  const ProviderBinding extends ExternalCommandCallbackProviderBinding,
>(
  routeId: RouteId,
  batchId: Batch,
  operation: Operation,
  collection: Collection,
  subjectType: SubjectType,
  evidenceKind: EvidenceKind,
  providerBinding: ProviderBinding,
  requiredClaimIdentifiers?: readonly string[],
): {
  readonly routeId: RouteId;
  readonly batchId: Batch;
  readonly operation: Operation;
  readonly collection: Collection;
  readonly subjectType: SubjectType;
  readonly evidenceKind: EvidenceKind;
  readonly providerBinding: ProviderBinding;
  readonly requiredClaimIdentifiers?: readonly string[];
} {
  return {
    routeId,
    batchId,
    operation,
    collection,
    subjectType,
    evidenceKind,
    providerBinding,
    ...(requiredClaimIdentifiers === undefined ? {} : { requiredClaimIdentifiers }),
  };
}

function exact<const Provider extends string>(provider: Provider): { readonly kind: "exact"; readonly provider: Provider } {
  return { kind: "exact", provider };
}

function recordField<const Prefix extends string, const Field extends string>(
  prefix: Prefix,
  field: Field,
): { readonly kind: "record-field"; readonly prefix: Prefix; readonly field: Field } {
  return { kind: "record-field", prefix, field };
}
