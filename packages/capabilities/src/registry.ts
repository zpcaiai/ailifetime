import type { ActorContext, LifeTimeMachineRuntimePort } from "@ltm/core";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface CapabilityInvocation {
  actor: ActorContext;
  idempotencyKey: string;
  input: JsonObject;
}

export type CapabilityMode =
  | "resource"
  | "state-transition"
  | "consent-write"
  | "ledger-post"
  | "partner-settlement-ledger"
  | "inbox-event"
  | "external-command"
  | "attestation";

export interface CapabilityDefinition {
  batchId: `B${string}`;
  skill: string;
  operation: string;
  /** Stable, batch-specific domain validator. Shared persistence never replaces this validator. */
  validatorId: string;
  /** The only ingress allowed to persist the business result. */
  executionPath: "capability" | "signed-external-event";
  /** The exact permission enforced by the executable handler. */
  permission: string;
  mode: CapabilityMode;
  requirements: readonly [`${string}-R01`, `${string}-R02`, `${string}-R03`, `${string}-R04`, `${string}-R05`];
  requiresExternalEvidence?: boolean;
  /** Side-effect-free parse path used by contract tooling and the execute path itself. */
  parseInput(invocation: CapabilityInvocation): JsonObject;
  execute(runtime: LifeTimeMachineRuntimePort, invocation: CapabilityInvocation): Promise<JsonValue>;
}

export class CapabilityRegistry {
  readonly #definitions = new Map<string, CapabilityDefinition>();
  readonly #validatorIds = new Set<string>();

  register(definition: CapabilityDefinition): void {
    if (!/^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(definition.batchId)) {
      throw new Error(`Invalid batch id: ${definition.batchId}`);
    }
    if (this.#definitions.has(definition.batchId)) {
      throw new Error(`Capability already registered: ${definition.batchId}`);
    }
    if (!/^[a-z][A-Za-z0-9]+$/.test(definition.operation)) {
      throw new Error(`Invalid capability operation: ${definition.operation}`);
    }
    if (!/^[a-z][A-Za-z0-9]+$/.test(definition.validatorId)) {
      throw new Error(`Invalid capability validator: ${definition.validatorId}`);
    }
    if (this.#validatorIds.has(definition.validatorId)) {
      throw new Error(`Capability validator is not batch-specific: ${definition.validatorId}`);
    }
    if (definition.requirements.length !== 5 || new Set(definition.requirements).size !== 5 ||
        definition.requirements.some((requirementId, index) => requirementId !== `${definition.batchId}-R0${index + 1}`)) {
      throw new Error(`Capability requirement binding is incomplete: ${definition.batchId}`);
    }
    if (definition.executionPath === "signed-external-event" && definition.requiresExternalEvidence !== true) {
      throw new Error(`Signed external-event capability must require external evidence: ${definition.batchId}`);
    }
    this.#validatorIds.add(definition.validatorId);
    this.#definitions.set(definition.batchId, Object.freeze(definition));
  }

  get(batchId: string): CapabilityDefinition | undefined {
    return this.#definitions.get(batchId);
  }

  list(): readonly CapabilityDefinition[] {
    return [...this.#definitions.values()].sort((left, right) => Number(left.batchId.slice(1)) - Number(right.batchId.slice(1)));
  }

  async execute(runtime: LifeTimeMachineRuntimePort, batchId: string, invocation: CapabilityInvocation): Promise<JsonValue> {
    const definition = this.#definitions.get(batchId);
    if (!definition) {
      throw new Error(`Unknown capability: ${batchId}`);
    }
    return definition.execute(runtime, invocation);
  }
}

export function requirementIds(batchId: `B${string}`): CapabilityDefinition["requirements"] {
  return [
    `${batchId}-R01`,
    `${batchId}-R02`,
    `${batchId}-R03`,
    `${batchId}-R04`,
    `${batchId}-R05`,
  ];
}
