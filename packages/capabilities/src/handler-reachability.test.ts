import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, LifeTimeMachineRuntime, type ActorContext } from "@ltm/core";
import { createCapabilityRegistry } from "./index.js";

const platformActor: ActorContext = {
  actorId: "capability-reachability-auditor",
  tenantId: "capability-reachability-tenant",
  roles: ["platform_admin"],
  purpose: "code_implementation_audit",
  requestId: "capability-reachability",
  stepUp: true,
};

test("all 128 executable handlers reach a named domain validator and fail closed on empty input", async () => {
  const runtime = new LifeTimeMachineRuntime({
    databasePath: ":memory:",
    allowLegacyConsentPolicy: true,
    evidencePolicy: "development",
    evidenceEnvironment: "sandbox",
  });
  try {
    const definitions = createCapabilityRegistry().list();
    assert.equal(definitions.length, 128);
    const failures = new Map<string, string>();
    for (const definition of definitions) {
      await assert.rejects(
        definition.execute(runtime, {
          actor: { ...platformActor, requestId: `reach-${definition.batchId}` },
          idempotencyKey: `reach-${definition.batchId}`,
          input: {},
        }),
        (error: unknown) => {
          assert.ok(error instanceof DomainError, `${definition.batchId} did not fail with a domain error`);
          assert.ok(
            ["VALIDATION_FAILED", "CONFIGURATION_INVALID"].includes(error.code),
            `${definition.batchId} bypassed validation with ${error.code}`,
          );
          failures.set(definition.batchId, error.message);
          return true;
        },
      );
    }
    assert.equal(failures.size, 128);
    assert.equal(runtime.listAudit(platformActor).length, 0, "invalid calls must not append success audit records");
  } finally {
    runtime.close();
  }
});
