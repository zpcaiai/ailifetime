import assert from "node:assert/strict";
import test from "node:test";
import { captureLocalOciArtifacts, verifyOciArtifactManifest } from "../security/oci-artifacts.mjs";

test("captures exact local OCI content IDs without pretending they are registry digests", () => {
  const manifest = captureLocalOciArtifacts([{ role: "api", reference: "ltm-api:test" }], {
    inspect: () => [{
      Id: "sha256:" + "a".repeat(64),
      // Docker Desktop/BuildKit can synthesize this without a registry push.
      RepoDigests: ["ltm-api@sha256:" + "a".repeat(64)],
      Os: "linux",
      Architecture: "amd64",
    }],
  });
  assert.equal(verifyOciArtifactManifest(manifest).status, "PASS");
  assert.equal(manifest.images[0].repoDigests.length, 0);
  assert.equal(verifyOciArtifactManifest(manifest, { environment: "production" }).status, "BLOCKED_EXTERNAL");
});

test("production passes only with every required role bound to an immutable registry digest", () => {
  const roles = ["api", "workers", "integration-gateway", "client-integration-broker", "migrator"];
  const manifest = {
    version: "ltm.oci-artifact-manifest.v1", environment: "production",
    images: roles.map((role, index) => {
      const reference = `registry.example/${role}@sha256:${String(index + 1).repeat(64)}`;
      return { role, buildReference: reference, imageId: `sha256:${String(index + 1).repeat(64)}`, repoDigests: [reference], platform: "linux/amd64" };
    }),
  };
  assert.equal(verifyOciArtifactManifest(manifest).status, "PASS");
  manifest.images[0].repoDigests = ["registry.example/api:latest"];
  assert.throws(() => verifyOciArtifactManifest(manifest), /registry sha256/);
});

test("a locally synthesized RepoDigest cannot upgrade a mutable build tag to production", () => {
  const roles = ["api", "workers", "integration-gateway", "client-integration-broker", "migrator"];
  const manifest = {
    version: "ltm.oci-artifact-manifest.v1", environment: "production",
    images: roles.map((role, index) => ({
      role,
      buildReference: `local/${role}:validation`,
      imageId: `sha256:${String(index + 1).repeat(64)}`,
      repoDigests: [`local/${role}@sha256:${String(index + 1).repeat(64)}`],
      platform: "linux/amd64",
    })),
  };
  assert.equal(verifyOciArtifactManifest(manifest).status, "BLOCKED_EXTERNAL");
});
