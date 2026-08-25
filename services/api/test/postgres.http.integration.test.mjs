import assert from "node:assert/strict";
import { test } from "node:test";
import { createCapabilityRegistry } from "@ltm/capabilities";
import { PostgresLifeTimeMachineRuntime } from "@ltm/core";
import { StaticTokenAuthenticator, createApiServer } from "../dist/index.js";

const connectionString = process.env.LTM_TEST_POSTGRES_URL;

test("HTTP command, query, and capability traffic use PostgreSQL", {
  skip: connectionString === undefined ? "set LTM_TEST_POSTGRES_URL to a migrated disposable database" : false,
}, async () => {
  assert.ok(connectionString);
  const runtime = await PostgresLifeTimeMachineRuntime.connect({
    connectionString,
    evidencePolicy: "disabled",
    allowLegacyConsentPolicy: true,
  });
  const server = createApiServer({
    runtime,
    authenticator: new StaticTokenAuthenticator([{
      token: "postgres-http-integration-token",
      actorId: "postgres-http-admin",
      tenantId: "tenant-pg-http",
      roles: ["platform_admin"],
      allowedPurposes: ["product_operation"],
      stepUp: true,
    }]),
    capabilityRegistry: createCapabilityRegistry(),
    staticDirectory: null,
    appEnvironment: "test",
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const headers = {
      authorization: "Bearer postgres-http-integration-token",
      "content-type": "application/json",
      "x-purpose": "product_operation",
    };

    const ready = await fetch(`${baseUrl}/health/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).database, "ok");

    const created = await fetch(`${baseUrl}/v1/commands`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "postgres-http-create-1" },
      body: JSON.stringify({
        command: "record.create",
        input: { collection: "projects", processingPurpose: "product_operation", data: { backend: "postgresql" } },
      }),
    });
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.equal(createdBody.data.value.tenantId, "tenant-pg-http");

    const queried = await fetch(`${baseUrl}/v1/queries`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: "record.get",
        input: { collection: "projects", id: createdBody.data.value.id },
      }),
    });
    assert.equal(queried.status, 200);
    assert.equal((await queried.json()).data.data.backend, "postgresql");

    const capability = await fetch(`${baseUrl}/v1/capabilities/B01`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "postgres-http-capability-1" },
      body: JSON.stringify({
        input: {
          repositoryId: "postgres-http-repository",
          stackProfile: "all-typescript",
          boundedContexts: ["identity", "generation"],
          healthChecks: ["liveness", "readiness"],
          ownershipRules: ["tenant-scoped"],
        },
      }),
    });
    assert.equal(capability.status, 200);
    const capabilityBody = await capability.json();
    assert.equal(capabilityBody.data.state, "persisted");
    assert.equal(capabilityBody.data.recordId, "postgres-http-repository");

    const capabilityRecord = await fetch(`${baseUrl}/v1/queries`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: "record.get",
        input: { collection: "platform.architectures", id: capabilityBody.data.recordId },
      }),
    });
    assert.equal(capabilityRecord.status, 200);
    assert.equal((await capabilityRecord.json()).data.data.batchId, "B01");

    const uncertifiedLaunch = await fetch(`${baseUrl}/v1/capabilities/B127`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": "postgres-http-b127-without-evidence-1" },
      body: JSON.stringify({
        input: {
          launchId: "postgres-http-launch-1",
          releaseControlProviderId: "release-control-1",
          providerEnvironment: "production",
          releaseManifestDigest: "a".repeat(64),
          repositoryCommit: "commit-1",
          artifactCommit: "commit-1",
          sbomDigest: "b".repeat(64),
          wave: "internal",
          rolloutPercent: 1,
          waveStartedAt: "2026-08-20T00:00:00.000Z",
          releaseGates: Array.from({ length: 12 }, (_, index) => `G${index}`),
          monitoringDomains: ["quality", "payment", "refund", "message", "support", "ledger", "supply", "privacy", "security", "cost", "slo"],
          approvalIds: ["approval-1", "approval-2"],
          rollbackExerciseId: "rollback-exercise-1",
          automaticPausePolicyVersion: "pause-policy-v1",
          guardrailPolicySha256: "c".repeat(64),
          waveObservationSetSha256: "d".repeat(64),
          rollbackForwardDrillSha256: "e".repeat(64),
          changeApproverEvidenceIds: ["change-risk-evidence-1", "change-operations-evidence-1"],
          activeGuardrailBreaches: 0,
          externalEvidenceIds: ["evidence-1", "evidence-2", "evidence-3", "evidence-4", "evidence-5"],
        },
      }),
    });
    assert.equal(uncertifiedLaunch.status, 503);
    assert.equal((await uncertifiedLaunch.json()).error.code, "EXTERNAL_ADAPTER_UNAVAILABLE");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
  }
});
