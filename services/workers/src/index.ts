import { DomainError } from "@ltm/core";
import type { ActorContext, LifeTimeMachineRuntime, OutboxEvent, OutboxPublisher } from "@ltm/core";

export type WorkerRoute = "media" | "notification" | "fulfillment" | "integration" | "data";

export interface WorkerOptions {
  readonly workerId: string;
  readonly batchSize?: number;
  readonly leaseMs?: number;
  readonly idlePollMs?: number;
}

export type WorkerPublishers = Readonly<Partial<Record<WorkerRoute, OutboxPublisher>>>;

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
    private readonly runtime: LifeTimeMachineRuntime,
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

  async runUntilAborted(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const result = await this.runOnce();
      if (result.published + result.failed === 0) await abortableDelay(this.#idlePollMs, signal);
    }
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
