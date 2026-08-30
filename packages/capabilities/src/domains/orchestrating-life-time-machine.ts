import { DomainError } from "@ltm/core";
import type { CapabilityInvocation, CapabilityRegistry, JsonObject } from "../registry.js";
import { requiredString, stringList } from "../validation.js";
import {
  assertISODate,
  assertKnownState,
  defineCapability,
  registerDefinitions,
  requireNonEmptyObject,
  type DomainCapabilityDefinition,
} from "./_shared.js";

const SKILL = "orchestrating-life-time-machine";

function recordRepositoryBaseline(input: JsonObject, invocation: CapabilityInvocation): JsonObject {
  if (!invocation.actor.roles.some((role) => role === "platform_admin" || role === "service_account")) {
    throw new DomainError("AUTH_FORBIDDEN", "B00 is restricted to a platform administrator or service identity");
  }
  const repositoryId = requiredString(input, "repositoryId");
  const repositoryKind = assertKnownState(requiredString(input, "repositoryKind"), ["single_repo", "multi_repo", "monorepo"] as const, "repositoryKind");
  const baseCommit = requiredString(input, "baseCommit");
  const inventoryHash = requiredString(input, "inventoryHash");
  const inventory = requireNonEmptyObject(input, "inventory");
  const commandResults = requireNonEmptyObject(input, "commandResults");
  const riskIds = stringList(input, "riskIds", { min: 1, unique: true });
  const allowedCommandStates = ["passed", "failed", "skipped", "missing"];
  if (!/^[a-f0-9]{7,128}$/i.test(baseCommit) || !/^[a-f0-9]{32,128}$/i.test(inventoryHash)) {
    throw new DomainError("VALIDATION_FAILED", "baseline commit and inventory digest must be valid hashes");
  }
  for (const [command, state] of Object.entries(commandResults)) {
    if (typeof state !== "string" || !allowedCommandStates.includes(state)) {
      throw new DomainError("VALIDATION_FAILED", "baseline command results must preserve pass, fail, skipped, or missing state", {
        details: { command, state: typeof state === "string" ? state : "invalid" },
      });
    }
  }
  return { repositoryId, repositoryKind, baseCommit, inventoryHash, inventory, commandResults, riskIds, baselineState: "observed" };
}

const ORCHESTRATION_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  planned: ["ready", "blocked"],
  ready: ["running", "blocked"],
  running: ["review", "blocked", "failed"],
  blocked: ["ready", "failed"],
  failed: ["ready"],
  review: ["merged", "blocked", "failed"],
  merged: ["factory_attested"],
  factory_attested: [],
};

function transitionBatchOrchestration(input: JsonObject): JsonObject {
  const orchestrationId = requiredString(input, "orchestrationId");
  const batchId = requiredString(input, "batchId");
  const fromState = assertKnownState(requiredString(input, "fromState"), Object.keys(ORCHESTRATION_TRANSITIONS), "fromState");
  const toState = assertKnownState(requiredString(input, "toState"), Object.keys(ORCHESTRATION_TRANSITIONS), "toState");
  const branch = requiredString(input, "branch");
  const worktree = requiredString(input, "worktree");
  const leaseExpiresAt = assertISODate(requiredString(input, "leaseExpiresAt"), "leaseExpiresAt");
  const dependencyBatchIds = stringList(input, "dependencyBatchIds", { min: 0, unique: true });
  const verifiedDependencyIds = stringList(input, "verifiedDependencyIds", { min: 0, unique: true });
  const evidenceIds = stringList(input, "evidenceIds", { min: 0, unique: true });
  if (!/^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(batchId)) throw new DomainError("VALIDATION_FAILED", "batchId is invalid");
  if (!ORCHESTRATION_TRANSITIONS[fromState]?.includes(toState)) {
    throw new DomainError("VERSION_CONFLICT", `illegal orchestration transition ${fromState} -> ${toState}`);
  }
  if (["ready", "running", "review", "merged", "factory_attested"].includes(toState)) {
    const missing = dependencyBatchIds.filter((dependency) => !verifiedDependencyIds.includes(dependency));
    if (missing.length > 0) throw new DomainError("DEPENDENCY_UNAVAILABLE", "batch dependencies lack validated completion evidence", { details: { missing } });
  }
  if (["review", "merged", "factory_attested"].includes(toState) && evidenceIds.length === 0) {
    throw new DomainError("DEPENDENCY_UNAVAILABLE", "review and terminal states require reproducible evidence");
  }
  if (Object.prototype.hasOwnProperty.call(input, "externalEvidenceIds")) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "B50 local orchestration cannot consume production certification evidence; use the independently gated B127 authority",
    );
  }
  if (Date.parse(leaseExpiresAt) <= Date.now() && toState === "running") throw new DomainError("VERSION_CONFLICT", "cannot enter running with an expired lease");
  return { orchestrationId, batchId, fromState, toState, branch, worktree, leaseExpiresAt, dependencyBatchIds, verifiedDependencyIds, evidenceIds };
}

const definitions: readonly DomainCapabilityDefinition[] = [
  defineCapability("B00", SKILL, "recordRepositoryBaseline", recordRepositoryBaseline, {
    permission: "platform.baseline.record",
    mode: "resource",
    collection: "orchestration.baselines",
    recordIdField: "repositoryId",
  }),
  defineCapability("B50", SKILL, "transitionBatchOrchestration", transitionBatchOrchestration, {
    permission: "orchestration.batch.transition",
    mode: "state-transition",
    collection: "orchestration.batches",
    recordIdField: "batchId",
    transition: { fromField: "fromState", toField: "toState", stateField: "state", initialFromStates: ["planned"] },
  }),
];

export function registerOrchestratingLifeTimeMachineCapabilities(registry: CapabilityRegistry): void {
  registerDefinitions(registry, definitions);
}

export const orchestratingLifeTimeMachineCoverage = definitions.length;
