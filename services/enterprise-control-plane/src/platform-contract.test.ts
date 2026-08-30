import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { signEnterpriseAttestation } from "./attestation.js";
import { EnterpriseControlError } from "./common.js";
import { parseEnterpriseServiceConfiguration } from "./config.js";
import { ENTERPRISE_REQUIREMENT_TRACE } from "./requirement-trace.js";
import { ACTOR, HASH, makeHarness } from "./test-fixtures.js";

test("enterprise trace has an exact unique B119-B124 30-requirement inventory", () => {
  const expected = Array.from({ length: 6 }, (_, batchIndex) => Array.from({ length: 5 }, (_, requirementIndex) => `B${119 + batchIndex}-R0${requirementIndex + 1}`)).flat();
  assert.deepEqual(ENTERPRISE_REQUIREMENT_TRACE.map((entry) => entry.requirementId), expected); assert.equal(new Set(ENTERPRISE_REQUIREMENT_TRACE.map((entry) => entry.implementation)).size, 30);
});

test("SQLite command idempotency is durable and different content conflicts", () => {
  const h = makeHarness(); const first = h.repository.execute(ACTOR.tenantId, "key-1", "test.command", { value: 1 }, () => ({ result: "created" })); const replay = h.repository.execute(ACTOR.tenantId, "key-1", "test.command", { value: 1 }, () => ({ result: "must-not-run" }));
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.deepEqual(replay.value, { result: "created" }); assert.throws(() => h.repository.execute(ACTOR.tenantId, "key-1", "test.command", { value: 2 }, () => ({ result: "changed" })), (error: unknown) => error instanceof EnterpriseControlError && error.code === "IDEMPOTENCY_CONFLICT"); h.repository.close();
});

test("enterprise facts reject non-canonical leap-date UTC timestamps", () => {
  const keys = generateKeyPairSync("ed25519"); const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.throws(() => signEnterpriseAttestation({ version: "ltm.enterprise-attestation.v1", factId: "invalid-date", tenantId: ACTOR.tenantId, issuer: "issuer", issuerRole: "role", environment: "test", factKind: "security.dast", subjectId: "build-1", sequence: 1, occurredAt: "2025-02-29T00:00:00Z", expiresAt: "2026-08-29T00:00:00.000Z", payload: { reportSha256: HASH }, algorithm: "Ed25519", keyId: "key-1" }, privateKey), /exact UTC/);
});

test("production configuration requires durable storage managed authorities and immutable protections", () => {
  const base = { environment: "production", databasePath: "/var/lib/ltm/enterprise.sqlite", workloadIdentity: "workload-identity://enterprise/production", authorityCatalogReference: "secret-manager://production/enterprise-authorities", defaultRegion: "cn-east", regions: ["cn-east"], protections: { consent: true, safety: true, aiLabel: true, children: true, highImpact: true, provenance: true } } as const;
  assert.equal(parseEnterpriseServiceConfiguration(base).environment, "production"); assert.throws(() => parseEnterpriseServiceConfiguration({ ...base, databasePath: ":memory:" }), /durable storage/); assert.throws(() => parseEnterpriseServiceConfiguration({ ...base, protections: { ...base.protections, children: false } }), /cannot be disabled/);
});
