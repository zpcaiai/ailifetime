import assert from "node:assert/strict";
import test from "node:test";
import { ProductionDependencyReadiness } from "./production-readiness.js";

function clients(overrides: {
  readonly versioning?: string;
  readonly objectLock?: string;
  readonly keyState?: string;
  readonly keyUsage?: string;
  readonly keySpec?: string;
  readonly ciphertext?: Uint8Array;
} = {}) {
  const calls: string[] = [];
  return {
    calls,
    s3: {
      async send(command: unknown) {
        const name = (command as { constructor: { name: string } }).constructor.name;
        calls.push(name);
        if (name === "HeadBucketCommand") return {};
        if (name === "GetBucketVersioningCommand") return { Status: overrides.versioning ?? "Enabled" };
        if (name === "GetObjectLockConfigurationCommand") {
          return { ObjectLockConfiguration: { ObjectLockEnabled: overrides.objectLock ?? "Enabled" } };
        }
        throw new Error("unexpected S3 command");
      },
    },
    kms: {
      async send(command: unknown) {
        const name = (command as { constructor: { name: string } }).constructor.name;
        calls.push(name);
        if (name === "DescribeKeyCommand") {
          return { KeyMetadata: {
            Enabled: true,
            KeyState: overrides.keyState ?? "Enabled",
            KeyUsage: overrides.keyUsage ?? "ENCRYPT_DECRYPT",
            KeySpec: overrides.keySpec ?? "SYMMETRIC_DEFAULT",
          } };
        }
        if (name === "GenerateDataKeyWithoutPlaintextCommand") {
          return { CiphertextBlob: overrides.ciphertext ?? new Uint8Array(32) };
        }
        throw new Error("unexpected KMS command");
      },
    },
  };
}

test("production readiness proves S3 durability, symmetric KMS encryption, and both API sink permissions with a short cache", async () => {
  let now = 1_000;
  let apiCalls = 0;
  const aws = clients();
  const readiness = new ProductionDependencyReadiness({
    bucket: "ltm-production-evidence",
    kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/production",
    tenantId: "tenant-production-1",
    cacheTtlMs: 1_000,
    clock: () => now,
  }, {
    async preflightPermissions() {
      apiCalls += 1;
      return {
        actorId: "integration-gateway",
        tenantId: "tenant-production-1",
        permissions: ["evidence:register", "external-event:apply"],
      };
    },
  }, aws);
  const [first, concurrent] = await Promise.all([readiness.check(), readiness.check()]);
  assert.deepEqual(first, concurrent);
  assert.equal(first.ready, true);
  assert.deepEqual(first.checks, {
    evidenceBucketAccessible: true,
    evidenceBucketVersioning: true,
    evidenceBucketObjectLock: true,
    evidenceKmsKey: true,
    evidenceKmsDataKeyWithoutPlaintext: true,
    apiEvidenceRegister: true,
    apiExternalEventApply: true,
  });
  assert.equal(apiCalls, 1);
  assert.equal(aws.calls.length, 5);
  assert.equal((await readiness.check()).ready, true);
  assert.equal(apiCalls, 1);
  now += 1_001;
  assert.equal((await readiness.check()).ready, true);
  assert.equal(apiCalls, 2);
  assert.equal(aws.calls.length, 10);
});

test("production readiness fails closed for incomplete durability, KMS, or cross-tenant API authority", async () => {
  const cases = [
    { overrides: { versioning: "Suspended" }, tenantId: "tenant-production-1", check: "evidenceBucketVersioning" },
    { overrides: { objectLock: "Disabled" }, tenantId: "tenant-production-1", check: "evidenceBucketObjectLock" },
    { overrides: { keyState: "Disabled" }, tenantId: "tenant-production-1", check: "evidenceKmsKey" },
    { overrides: { keySpec: "RSA_2048" }, tenantId: "tenant-production-1", check: "evidenceKmsKey" },
    { overrides: { ciphertext: new Uint8Array() }, tenantId: "tenant-production-1", check: "evidenceKmsDataKeyWithoutPlaintext" },
    { overrides: {}, tenantId: "tenant-other", check: "apiEvidenceRegister" },
  ] as const;
  for (const item of cases) {
    const aws = clients(item.overrides);
    const readiness = new ProductionDependencyReadiness({
      bucket: "ltm-production-evidence",
      kmsKeyId: "production-key",
      tenantId: "tenant-production-1",
      cacheTtlMs: 1_000,
    }, {
      async preflightPermissions() {
        return {
          actorId: "integration-gateway",
          tenantId: item.tenantId,
          permissions: ["evidence:register", "external-event:apply"],
        };
      },
    }, aws);
    const result = await readiness.check();
    assert.equal(result.ready, false, item.check);
    assert.equal(result.checks[item.check], false, item.check);
  }
});
