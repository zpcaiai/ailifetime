import { DomainError } from "@ltm/core";
import type { ActorContext, LifeTimeMachineRuntimePort, OutboxEvent, OutboxPublisher } from "@ltm/core";
import type { PartnerCommandInput, PartnerCommandReceipt } from "@ltm/providers";

export type WorkerRoute = "media" | "notification" | "fulfillment" | "integration" | "data";

export interface WorkerOptions {
  readonly workerId: string;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly idlePollMs?: number;
}

export type WorkerPublishers = Readonly<Partial<Record<WorkerRoute, OutboxPublisher>>>;

export interface ExternalCommandSender {
  send(input: PartnerCommandInput): Promise<PartnerCommandReceipt>;
}

export type ExternalCommandSenders = Readonly<Partial<Record<`B${string}`, ExternalCommandSender>>>;

export function routeOutboxEvent(event: Pick<OutboxEvent, "aggregateType" | "eventType">): WorkerRoute {
  const value = `${event.aggregateType}.${event.eventType}`.toLowerCase();
  if (/media|asset|generation|timeline|render/.test(value)) return "media";
  if (/notification|message|email|sms|push|wechat/.test(value)) return "notification";
  if (/fulfillment|shipment|shipping|vendor|inventory|print|return/.test(value)) return "fulfillment";
  if (/analytics|metric|experiment|warehouse|model|data/.test(value)) return "data";
  return "integration";
}

export class RoutedOutboxPublisher implements OutboxPublisher {
  constructor(private readonly publishers: WorkerPublishers) {}

  async publish(event: OutboxEvent): Promise<void> {
    const route = routeOutboxEvent(event);
    const publisher = this.publishers[route];
    if (publisher === undefined) {
      throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", `No ${route} event publisher is configured`, {
        retryable: true,
        details: { eventId: event.id, eventType: event.eventType, route },
      });
    }
    await publisher.publish(event);
  }
}

export class DurableOutboxWorker {
  readonly #publisher: RoutedOutboxPublisher;
  readonly #workerId: string;
  readonly #batchSize: number;
  readonly #leaseMs: number;
  readonly #idlePollMs: number;

  constructor(
    private readonly runtime: LifeTimeMachineRuntimePort,
    private readonly actor: ActorContext,
    publishers: WorkerPublishers,
    options: WorkerOptions,
  ) {
    this.#publisher = new RoutedOutboxPublisher(publishers);
    this.#workerId = boundedToken(options.workerId, "workerId");
    this.#batchSize = boundedInteger(options.batchSize ?? 50, "batchSize", 1, 200);
    this.#leaseMs = boundedInteger(options.leaseMs ?? 30_000, "leaseMs", 1_000, 900_000);
    this.#idlePollMs = boundedInteger(options.idlePollMs ?? 1_000, "idlePollMs", 25, 60_000);
  }

  runOnce(): Promise<{ readonly published: number; readonly failed: number }> {
    return this.runtime.publishOutbox(this.actor, this.#publisher, {
      workerId: this.#workerId,
      limit: this.#batchSize,
      leaseMs: this.#leaseMs,
    });
  }

  async runUntilAborted(
    signal: AbortSignal,
    onCycle: (result: { readonly published: number; readonly failed: number }) => void = () => undefined,
  ): Promise<void> {
    while (!signal.aborted) {
      const result = await this.runOnce();
      onCycle(result);
      if (result.published + result.failed === 0) await abortableDelay(this.#idlePollMs, signal);
    }
  }
}

/**
 * Delivers the one durable `external_command.requested` intent for a command.
 * The command is marked dispatched before the side effect; response loss is
 * retried with the same provider idempotency key. An authenticated callback,
 * not the outbound HTTP response, owns the terminal business state.
 */
export class ProductionExternalCommandPublisher implements OutboxPublisher {
  readonly #clock: () => Date;

  constructor(
    private readonly runtime: LifeTimeMachineRuntimePort,
    private readonly actor: ActorContext,
    private readonly senders: ExternalCommandSenders,
    clock: () => Date = () => new Date(),
  ) {
    this.#clock = clock;
  }

  async publish(event: OutboxEvent): Promise<void> {
    if (event.tenantId !== this.actor.tenantId) {
      throw new DomainError("TENANT_SCOPE_MISMATCH", "worker event tenant does not match its service actor");
    }
    if (event.eventType !== "external_command.requested") {
      throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", "event is not a configured external command", {
        retryable: false,
        details: { eventId: event.id, eventType: event.eventType },
      });
    }
    const snapshot = externalCommandSnapshot(event);
    const commandId = stringValue(snapshot.commandId, "external command ID");
    const batchId = stringValue(snapshot.batchId, "external command batchId");
    const operation = stringValue(snapshot.operation, "external command operation");
    if (!/^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(batchId)) {
      throw new DomainError("VALIDATION_FAILED", "external command batchId is invalid");
    }
    const sender = this.senders[batchId as `B${string}`];
    if (sender === undefined) {
      throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", `No external command adapter is configured for ${batchId}`, {
        retryable: true,
        details: { batchId, operation },
      });
    }
    let command = await this.runtime.getExternalCommand(this.actor, commandId);
    if (command.batchId !== batchId || command.operation !== operation ||
        command.aggregateCollection !== event.aggregateType || command.aggregateId !== event.aggregateId ||
        snapshot.aggregateCollection !== command.aggregateCollection || snapshot.aggregateId !== command.aggregateId) {
      throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "external command outbox identity does not match persisted intent", {
        details: { eventId: event.id, commandId },
      });
    }
    if (["acknowledged", "succeeded", "failed", "cancelled", "compensated"].includes(command.state)) return;
    if (command.state === "requested") {
      command = (await this.runtime.transitionExternalCommand(this.actor, {
        commandId,
        batchId: batchId as `B${string}`,
        operation,
        aggregateCollection: command.aggregateCollection,
        aggregateId: command.aggregateId,
        toState: "dispatched",
        details: { sourceEventId: event.id, workerDispatchedAt: this.#clock().toISOString() },
        idempotencyKey: `external-command-dispatched:${event.id}`,
      })).value;
    }
    if (command.state !== "dispatched") {
      throw new DomainError("VERSION_CONFLICT", "external command is not awaiting provider delivery", {
        details: { batchId, commandId, state: command.state },
      });
    }
    const current = await this.runtime.getRecord(this.actor, command.aggregateCollection, command.aggregateId);
    if (current.data.operationMode !== "external-command" || current.data.externalCommandId !== commandId) {
      throw new DomainError("EVENT_FINGERPRINT_CONFLICT", "external command aggregate no longer matches its intent", {
        details: { commandId, collection: current.collection, aggregateId: current.id },
      });
    }
    const receipt = await sender.send({
      tenantId: event.tenantId,
      batchId: batchId as `B${string}`,
      operation,
      idempotencyKey: event.id,
      payload: current.data,
    });
    // A provider can deliver its authenticated callback before the outbound
    // response reaches us. In that race the callback already owns the state;
    // never move a terminal command backwards or fail the outbox needlessly.
    const afterResponse = await this.runtime.getExternalCommand(this.actor, commandId);
    if (["acknowledged", "succeeded", "failed", "cancelled", "compensated"].includes(afterResponse.state)) return;
    if (afterResponse.state !== "dispatched") {
      throw new DomainError("VERSION_CONFLICT", "external command changed while the provider response was in flight", {
        details: { commandId, state: afterResponse.state },
      });
    }
    await this.runtime.transitionExternalCommand(this.actor, {
      commandId,
      batchId: batchId as `B${string}`,
      operation,
      aggregateCollection: command.aggregateCollection,
      aggregateId: command.aggregateId,
      toState: "acknowledged",
      providerOperationId: safeReceiptValue(receipt.providerRequestId, "providerRequestId"),
      details: {
        providerResponseSha256: exactSha256(receipt.artifactSha256),
        sourceEventId: event.id,
        acknowledgedAt: this.#clock().toISOString(),
      },
      idempotencyKey: `external-command-accepted:${event.id}`,
    });
  }
}

/**
 * Publishes ordinary capability events to a route-specific signed integration
 * endpoint. External commands are always dispatched through their exact
 * batch-specific adapter instead of the generic route endpoint.
 */
export class ProductionRoutePublisher implements OutboxPublisher {
  readonly #externalCommands: ProductionExternalCommandPublisher;

  constructor(
    private readonly runtime: LifeTimeMachineRuntimePort,
    private readonly actor: ActorContext,
    externalCommandSenders: ExternalCommandSenders,
    private readonly routeSender: ExternalCommandSender,
  ) {
    this.#externalCommands = new ProductionExternalCommandPublisher(runtime, actor, externalCommandSenders);
  }

  async publish(event: OutboxEvent): Promise<void> {
    if (event.tenantId !== this.actor.tenantId) {
      throw new DomainError("TENANT_SCOPE_MISMATCH", "worker event tenant does not match its service actor");
    }
    if (event.eventType === "external_command.requested") {
      await this.#externalCommands.publish(event);
      return;
    }
    // Aggregate create/update and command lifecycle events are projections of
    // the one requested intent. Delivering any of them would duplicate the
    // provider side effect under a different outbox idempotency key.
    const snapshot = recordSnapshot(event);
    if (snapshot?.data.operationMode === "external-command" || event.eventType.startsWith("external_command.")) return;
    const batchId = stringValue(snapshot?.data.batchId, "capability event batchId");
    if (!/^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(batchId)) {
      throw new DomainError("VALIDATION_FAILED", "capability event batchId is invalid");
    }
    const receipt = await this.routeSender.send({
      tenantId: event.tenantId,
      batchId: batchId as `B${string}`,
      operation: event.eventType,
      idempotencyKey: event.id,
      payload: {
        eventId: event.id,
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        occurredAt: event.createdAt,
        payload: event.payload,
      },
    });
    await this.runtime.appendAudit(this.actor, {
      action: "outbox.provider_accepted",
      resourceType: event.aggregateType,
      resourceId: event.aggregateId,
      details: {
        eventId: event.id,
        batchId,
        providerRequestId: safeReceiptValue(receipt.providerRequestId, "providerRequestId"),
        providerResponseSha256: exactSha256(receipt.artifactSha256),
      },
    });
  }
}

function boundedToken(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new DomainError("VALIDATION_FAILED", `${field} is invalid`);
  }
  return normalized;
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DomainError("VALIDATION_FAILED", `${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolvePromise();
    }
  });
}

function recordSnapshot(event: OutboxEvent): { readonly data: Record<string, unknown> } | undefined {
  const record = event.payload.record;
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
  const data = (record as Record<string, unknown>).data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  return { data: data as Record<string, unknown> };
}

function externalCommandSnapshot(event: OutboxEvent): {
  readonly commandId: unknown;
  readonly batchId: unknown;
  readonly operation: unknown;
  readonly aggregateCollection: unknown;
  readonly aggregateId: unknown;
} {
  const command = objectValue(event.payload.command);
  if (command === undefined) {
    throw new DomainError("VALIDATION_FAILED", "external command request payload is missing its command snapshot");
  }
  return {
    commandId: command.commandId,
    batchId: command.batchId,
    operation: command.operation,
    aggregateCollection: command.aggregateCollection,
    aggregateId: command.aggregateId,
  };
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DomainError("VALIDATION_FAILED", `${field} is invalid`);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeReceiptValue(value: string, field: string): string {
  if (value.trim() === "" || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", `provider ${field} is invalid`, { retryable: true });
  }
  return value;
}

function exactSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "provider response digest is invalid", { retryable: true });
  }
  return value;
}
