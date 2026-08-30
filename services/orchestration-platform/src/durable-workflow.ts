import { createHash } from "node:crypto";
import { OrchestrationError } from "./provider-control-plane.js";

export interface WorkflowActivityDefinition {
  readonly id: string;
  readonly timeoutMs: number;
  readonly heartbeatMs: number;
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
  readonly compensationId: string;
  readonly nonRetryableErrorCodes: readonly string[];
}

export interface WorkflowDefinition {
  readonly id: string;
  readonly version: number;
  readonly activities: readonly WorkflowActivityDefinition[];
}

export type WorkflowState = "running" | "compensating" | "completed" | "compensated" | "failed" | "cancelled";
export interface ActivityState {
  readonly id: string;
  readonly state: "pending" | "running" | "completed" | "failed" | "compensated";
  readonly attempts: number;
  readonly startedAt?: string;
  readonly heartbeatAt?: string;
  readonly nextAttemptAt?: string;
  readonly intentSha256?: string;
  readonly idempotencyKey?: string;
  readonly resultSha256?: string;
  readonly compensationReceiptSha256?: string;
  readonly errorCode?: string;
}

export interface WorkflowInstance {
  readonly id: string;
  readonly tenantId: string;
  readonly traceId: string;
  readonly definitionId: string;
  readonly definitionVersion: number;
  readonly codeVersion: string;
  readonly inputSha256: string;
  readonly idempotencyKey: string;
  readonly state: WorkflowState;
  readonly compensationReason?: "cancelled" | "failed";
  readonly currentIndex: number;
  readonly activities: readonly ActivityState[];
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly cancelRequested: boolean;
}

export interface WorkflowActivityRunner {
  run(input: {
    readonly workflowId: string;
    readonly activityId: string;
    readonly attempt: number;
    readonly inputSha256: string;
    readonly idempotencyKey: string;
    readonly abortSignal: AbortSignal;
    readonly heartbeat: (resultSha256?: string) => Promise<void>;
  }): Promise<{ readonly succeeded: boolean; readonly retryable: boolean; readonly resultSha256: string; readonly errorCode?: string }>;
  compensate(input: {
    readonly workflowId: string;
    readonly activityId: string;
    readonly compensationId: string;
    readonly resultSha256: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly succeeded: boolean; readonly receiptSha256: string }>;
}

export interface WorkflowRepository {
  load(id: string): Promise<WorkflowInstance | undefined>;
  save(expectedSha256: string | undefined, next: WorkflowInstance): Promise<void>;
  findByIdempotency(definitionId: string, idempotencyKey: string): Promise<WorkflowInstance | undefined>;
}

export class DurableWorkflowEngine {
  readonly #definitions = new Map<string, WorkflowDefinition>();

  constructor(
    readonly repository: WorkflowRepository,
    readonly runner: WorkflowActivityRunner,
    readonly now: () => Date = () => new Date(),
  ) {}

  register(definition: WorkflowDefinition): void {
    const key = `${definition.id}@${definition.version}`;
    if (
      !/^[a-z][a-z0-9-]+$/u.test(definition.id)
      || !Number.isSafeInteger(definition.version)
      || definition.version < 1
      || definition.activities.length === 0
      || new Set(definition.activities.map((activity) => activity.id)).size !== definition.activities.length
      || this.#definitions.has(key)
    ) throw new OrchestrationError("VALIDATION_FAILED", "workflow definition is invalid or duplicated");
    for (const activity of definition.activities) {
      if (
        !/^[a-z][a-z0-9-]+$/u.test(activity.id)
        || !Number.isSafeInteger(activity.timeoutMs)
        || activity.timeoutMs < 100
        || !Number.isSafeInteger(activity.heartbeatMs)
        || activity.heartbeatMs < 50
        || activity.heartbeatMs >= activity.timeoutMs
        || !Number.isSafeInteger(activity.maxAttempts)
        || activity.maxAttempts < 1
        || activity.maxAttempts > 5
        || !Number.isSafeInteger(activity.initialBackoffMs)
        || activity.initialBackoffMs < 0
        || activity.initialBackoffMs > 60_000
        || activity.compensationId.trim() === ""
      ) throw new OrchestrationError("VALIDATION_FAILED", "workflow activity retry, timeout, heartbeat, idempotency, or compensation policy is invalid");
    }
    this.#definitions.set(key, Object.freeze(structuredClone(definition)));
  }

  async start(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly traceId: string;
    readonly definitionId: string;
    readonly definitionVersion: number;
    readonly codeVersion: string;
    readonly payload: unknown;
    readonly idempotencyKey: string;
  }): Promise<WorkflowInstance> {
    const definition = this.#definition(input.definitionId, input.definitionVersion);
    if (input.id.trim() === "" || input.tenantId.trim() === "" || input.traceId.trim() === "" || input.codeVersion.trim() === "" || input.idempotencyKey.length < 8) {
      throw new OrchestrationError("VALIDATION_FAILED", "workflow identity, tenant, trace, version, or idempotency key is invalid");
    }
    const inputSha256 = sha(input.payload);
    const prior = await this.repository.findByIdempotency(input.definitionId, input.idempotencyKey);
    if (prior !== undefined) {
      if (prior.inputSha256 !== inputSha256 || prior.tenantId !== input.tenantId) throw new OrchestrationError("CONFLICT", "workflow idempotency key was reused");
      return prior;
    }
    const startedAt = this.now().toISOString();
    const instance: WorkflowInstance = Object.freeze({
      id: input.id,
      tenantId: input.tenantId,
      traceId: input.traceId,
      definitionId: input.definitionId,
      definitionVersion: input.definitionVersion,
      codeVersion: input.codeVersion,
      inputSha256,
      idempotencyKey: input.idempotencyKey,
      state: "running",
      currentIndex: 0,
      activities: Object.freeze(definition.activities.map((activity) => Object.freeze({ id: activity.id, state: "pending" as const, attempts: 0 }))),
      startedAt,
      updatedAt: startedAt,
      cancelRequested: false,
    });
    await this.repository.save(undefined, instance);
    return instance;
  }

  async step(id: string): Promise<WorkflowInstance> {
    let current = await this.#load(id);
    const definition = this.#definition(current.definitionId, current.definitionVersion);
    if (!(["running", "compensating"] as const).includes(current.state as "running" | "compensating")) return current;
    if (current.cancelRequested && current.state === "running") return this.#beginCompensation(current, "cancelled");
    if (current.state === "compensating") return this.#compensate(current, definition);
    const activityDefinition = definition.activities[current.currentIndex];
    if (activityDefinition === undefined) {
      const completed = Object.freeze({ ...current, state: "completed" as const, updatedAt: this.now().toISOString() });
      await this.repository.save(sha(current), completed);
      return completed;
    }
    let activity = current.activities[current.currentIndex] as ActivityState;
    if (activity.nextAttemptAt !== undefined && Date.parse(activity.nextAttemptAt) > this.now().getTime()) return current;
    if (activity.state === "pending") {
      const attempt = activity.attempts + 1;
      const startedAt = this.now().toISOString();
      const idempotencyKey = sha(`${current.id}:${activity.id}:${attempt}:${current.inputSha256}`);
      const intentSha256 = sha({ workflowId: current.id, activityId: activity.id, attempt, inputSha256: current.inputSha256, idempotencyKey });
      const intended = Object.freeze({
        ...current,
        activities: replace(current.activities, current.currentIndex, { id: activity.id, state: "running", attempts: attempt, startedAt, heartbeatAt: startedAt, intentSha256, idempotencyKey }),
        updatedAt: startedAt,
      });
      await this.repository.save(sha(current), intended);
      current = intended;
      activity = current.activities[current.currentIndex] as ActivityState;
    }
    if (activity.state !== "running" || activity.idempotencyKey === undefined || activity.startedAt === undefined) {
      throw new OrchestrationError("CONFLICT", "workflow activity is not executable in its persisted state");
    }
    const controller = new AbortController();
    let resetHeartbeatWatchdog = (): void => undefined;
    const heartbeat = async (resultSha256?: string): Promise<void> => {
      if (resultSha256 !== undefined && !digest(resultSha256)) throw new OrchestrationError("VALIDATION_FAILED", "activity heartbeat result digest is invalid");
      const latest = await this.#load(id);
      const latestActivity = latest.activities[latest.currentIndex];
      if (latestActivity?.id !== activity.id || latestActivity.state !== "running" || latestActivity.idempotencyKey !== activity.idempotencyKey) {
        throw new OrchestrationError("CONFLICT", "activity heartbeat belongs to a stale execution intent");
      }
      const next = Object.freeze({
        ...latest,
        activities: replace(latest.activities, latest.currentIndex, { ...latestActivity, heartbeatAt: this.now().toISOString(), ...(resultSha256 === undefined ? {} : { resultSha256 }) }),
        updatedAt: this.now().toISOString(),
      });
      await this.repository.save(sha(latest), next);
      current = next;
      resetHeartbeatWatchdog();
    };
    let result: { succeeded: boolean; retryable: boolean; resultSha256: string; errorCode?: string };
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined; let totalTimer: ReturnType<typeof setTimeout> | undefined; let timeoutResolved = false;
    const timeout = new Promise<typeof result>((resolve) => {
      const expire = (errorCode: "ACTIVITY_TIMEOUT" | "ACTIVITY_HEARTBEAT_TIMEOUT"): void => {
        if (timeoutResolved) return; timeoutResolved = true; controller.abort();
        resolve({ succeeded: false, retryable: true, resultSha256: sha(errorCode), errorCode });
      };
      resetHeartbeatWatchdog = () => { if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer); heartbeatTimer = setTimeout(() => expire("ACTIVITY_HEARTBEAT_TIMEOUT"), activityDefinition.heartbeatMs); };
      resetHeartbeatWatchdog(); totalTimer = setTimeout(() => expire("ACTIVITY_TIMEOUT"), activityDefinition.timeoutMs);
    });
    const execution = this.runner.run({ workflowId: id, activityId: activity.id, attempt: activity.attempts, inputSha256: current.inputSha256, idempotencyKey: activity.idempotencyKey, abortSignal: controller.signal, heartbeat })
      .catch(() => ({ succeeded: false, retryable: true, resultSha256: sha("runner-exception"), errorCode: "ACTIVITY_RUNNER_ERROR" }));
    try { result = await Promise.race([execution, timeout]); }
    finally { if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer); if (totalTimer !== undefined) clearTimeout(totalTimer); }
    if (timeoutResolved) void execution.catch(() => undefined);
    if (!digest(result.resultSha256)) throw new OrchestrationError("DEPENDENCY_FAILED", "activity result digest is invalid");
    const latest = await this.#load(id);
    const latestActivity = latest.activities[latest.currentIndex] as ActivityState;
    if (latestActivity.idempotencyKey !== activity.idempotencyKey || latestActivity.state !== "running") throw new OrchestrationError("CONFLICT", "activity result belongs to a stale execution intent");
    const heartbeatAt = latestActivity.heartbeatAt ?? latestActivity.startedAt ?? latest.updatedAt;
    const timedOut = this.now().getTime() - Date.parse(heartbeatAt) > activityDefinition.heartbeatMs
      || this.now().getTime() - Date.parse(latestActivity.startedAt ?? latest.updatedAt) > activityDefinition.timeoutMs;
    const nonRetryable = result.errorCode !== undefined && activityDefinition.nonRetryableErrorCodes.includes(result.errorCode);
    let next: WorkflowInstance;
    if (result.succeeded && !timedOut) {
      next = Object.freeze({
        ...latest,
        currentIndex: latest.currentIndex + 1,
        activities: replace(latest.activities, latest.currentIndex, { ...latestActivity, state: "completed", resultSha256: result.resultSha256, heartbeatAt }),
        updatedAt: this.now().toISOString(),
      });
    } else if (result.retryable && !nonRetryable && latestActivity.attempts < activityDefinition.maxAttempts) {
      const backoff = activityDefinition.initialBackoffMs * 2 ** (latestActivity.attempts - 1);
      next = Object.freeze({
        ...latest,
        activities: replace(latest.activities, latest.currentIndex, {
          id: latestActivity.id,
          state: "pending",
          attempts: latestActivity.attempts,
          nextAttemptAt: new Date(this.now().getTime() + backoff).toISOString(),
          resultSha256: result.resultSha256,
          ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        }),
        updatedAt: this.now().toISOString(),
      });
    } else {
      next = Object.freeze({
        ...latest,
        state: "compensating" as const,
        compensationReason: "failed" as const,
        activities: replace(latest.activities, latest.currentIndex, { ...latestActivity, state: "failed", resultSha256: result.resultSha256, ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }) }),
        updatedAt: this.now().toISOString(),
      });
    }
    await this.repository.save(sha(latest), next);
    return next;
  }

  async cancel(id: string): Promise<WorkflowInstance> {
    const current = await this.#load(id);
    if (current.state !== "running") throw new OrchestrationError("CONFLICT", "only a running workflow can be cancelled");
    const next = Object.freeze({ ...current, cancelRequested: true, updatedAt: this.now().toISOString() });
    await this.repository.save(sha(current), next);
    return next;
  }

  projection(instance: WorkflowInstance): Readonly<{ state: WorkflowState; completed: number; total: number; currentActivity?: string; recoverable: boolean; traceId: string; definitionVersion: number }> {
    const completed = instance.activities.filter((activity) => activity.state === "completed" || activity.state === "compensated").length;
    const current = instance.activities[instance.currentIndex];
    return Object.freeze({ state: instance.state, completed, total: instance.activities.length, ...(current === undefined ? {} : { currentActivity: current.id }), recoverable: instance.state === "running" || instance.state === "compensating", traceId: instance.traceId, definitionVersion: instance.definitionVersion });
  }

  async #beginCompensation(current: WorkflowInstance, reason: "cancelled" | "failed"): Promise<WorkflowInstance> {
    const completedIndex = [...current.activities].map((activity, index) => ({ activity, index })).filter(({ activity }) => activity.state === "completed").at(-1)?.index;
    if (completedIndex === undefined) {
      const next = Object.freeze({ ...current, state: reason, compensationReason: reason, updatedAt: this.now().toISOString() });
      await this.repository.save(sha(current), next);
      return next;
    }
    const next = Object.freeze({ ...current, state: "compensating" as const, compensationReason: reason, currentIndex: completedIndex, updatedAt: this.now().toISOString() });
    await this.repository.save(sha(current), next);
    return next;
  }

  async #compensate(current: WorkflowInstance, definition: WorkflowDefinition): Promise<WorkflowInstance> {
    const index = [...current.activities].map((activity, position) => ({ activity, position })).filter(({ activity, position }) => position <= current.currentIndex && activity.state === "completed").at(-1)?.position;
    if (index === undefined) {
      const next = Object.freeze({ ...current, state: "compensated" as const, currentIndex: 0, updatedAt: this.now().toISOString() });
      await this.repository.save(sha(current), next);
      return next;
    }
    const activity = current.activities[index] as ActivityState;
    const activityDefinition = definition.activities[index] as WorkflowActivityDefinition;
    if (activity.resultSha256 === undefined) throw new OrchestrationError("DEPENDENCY_FAILED", "completed activity lacks a compensation source receipt");
    const compensationIdempotencyKey = sha(`${current.id}:${activity.id}:${activityDefinition.compensationId}:${activity.resultSha256}`);
    const result = await this.runner.compensate({ workflowId: current.id, activityId: activity.id, compensationId: activityDefinition.compensationId, resultSha256: activity.resultSha256, idempotencyKey: compensationIdempotencyKey });
    if (!result.succeeded || !digest(result.receiptSha256)) {
      const next = Object.freeze({ ...current, state: "failed" as const, updatedAt: this.now().toISOString() });
      await this.repository.save(sha(current), next);
      return next;
    }
    const next = Object.freeze({
      ...current,
      currentIndex: Math.max(0, index - 1),
      activities: replace(current.activities, index, { ...activity, state: "compensated", compensationReceiptSha256: result.receiptSha256 }),
      updatedAt: this.now().toISOString(),
    });
    await this.repository.save(sha(current), next);
    return next;
  }

  #definition(id: string, version: number): WorkflowDefinition {
    const value = this.#definitions.get(`${id}@${version}`);
    if (value === undefined) throw new OrchestrationError("VALIDATION_FAILED", "workflow definition is not registered");
    return value;
  }

  async #load(id: string): Promise<WorkflowInstance> {
    const value = await this.repository.load(id);
    if (value === undefined) throw new OrchestrationError("CONFLICT", "workflow instance does not exist");
    return value;
  }
}

export class InMemoryWorkflowRepository implements WorkflowRepository {
  readonly #values = new Map<string, WorkflowInstance>();
  async load(id: string): Promise<WorkflowInstance | undefined> {
    const value = this.#values.get(id);
    return value === undefined ? undefined : structuredClone(value);
  }
  async findByIdempotency(definitionId: string, key: string): Promise<WorkflowInstance | undefined> {
    const value = [...this.#values.values()].find((item) => item.definitionId === definitionId && item.idempotencyKey === key);
    return value === undefined ? undefined : structuredClone(value);
  }
  async save(expected: string | undefined, next: WorkflowInstance): Promise<void> {
    const prior = this.#values.get(next.id);
    if (expected === undefined ? prior !== undefined : prior === undefined || sha(prior) !== expected) throw new OrchestrationError("CONFLICT", "workflow repository compare-and-swap failed");
    this.#values.set(next.id, structuredClone(next));
  }
}

export function workflowStateSha256(value: WorkflowInstance): string {
  return sha(value);
}

function replace(values: readonly ActivityState[], index: number, value: ActivityState): readonly ActivityState[] {
  return Object.freeze(values.map((item, position) => position === index ? Object.freeze(structuredClone(value)) : item));
}

function sha(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function digest(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
