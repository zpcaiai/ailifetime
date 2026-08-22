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
  mode: CapabilityMode;
  requirements: readonly [`${string}-R01`, `${string}-R02`, `${string}-R03`, `${string}-R04`, `${string}-R05`];
  requiresExternalEvidence?: boolean;
  execute(runtime: LifeTimeMachineRuntimePort, invocation: CapabilityInvocation): Promise<JsonValue>;
}

export class CapabilityRegistry {
  readonly #definitions = new Map<string, CapabilityDefinition>();

  register(definition: CapabilityDefinition): void {
    if (!/^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(definition.batchId)) {
      throw new Error(`Invalid batch id: ${definition.batchId}`);
    }
    if (this.#definitions.has(definition.batchId)) {
      throw new Error(`Capability already registered: ${definition.batchId}`);
    }
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
