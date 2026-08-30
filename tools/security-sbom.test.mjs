import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { generateSupplyChainBundle, verifySupplyChainBundle } from "../security/supply-chain.mjs";

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "ltm-sbom-"));
  mkdirSync(resolve(root, "dist"));
  writeFileSync(resolve(root, "dist/app.js"), "export const answer = 42;\n");
  writeFileSync(resolve(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\npackages:\n\n  'safe-lib@1.2.3':\n    resolution: {integrity: sha512-YWJj}\n\nsnapshots:\n");
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    root,
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    licenses: { MIT: [{ name: "safe-lib", versions: ["1.2.3"], license: "MIT", paths: ["ignored-machine-path"] }] },
  };
}

test("generates reproducible CycloneDX/SPDX/license/artifact/provenance documents and verifies their signature", () => {
  const input = fixture();
  const options = { ...input, artifactPaths: ["dist"], sourceDateEpoch: 1_700_000_000, environment: "ci", trustTier: "ci" };
  const first = generateSupplyChainBundle(options);
  const second = generateSupplyChainBundle(options);
  assert.deepEqual(first, second);
  assert.equal(first.cycloneDx.bomFormat, "CycloneDX");
  assert.equal(first.spdx.spdxVersion, "SPDX-2.3");
  assert.equal(first.licenseInventory.components[0].license, "MIT");
  assert.equal(first.artifactManifest.files.length, 1);
  assert.equal(first.provenance.predicateType, "https://slsa.dev/provenance/v1");
  assert.equal(verifySupplyChainBundle(first).status, "PASS");
});

test("fails closed for unsigned bundles, changed artifacts, and untrusted keys", () => {
  const input = fixture();
  assert.throws(() => generateSupplyChainBundle({ ...input, privateKeyPem: undefined, artifactPaths: ["dist"] }), /signing private key/);
  const bundle = generateSupplyChainBundle({ ...input, artifactPaths: ["dist"] });
  bundle.artifactManifest.files[0].size += 1;
  assert.throws(() => verifySupplyChainBundle(bundle), /digest/);
  const valid = generateSupplyChainBundle({ ...input, artifactPaths: ["dist"] });
  assert.throws(() => verifySupplyChainBundle(valid, { trustedKeyIds: ["ed25519:" + "0".repeat(64)] }), /not trusted/);
  assert.throws(() => verifySupplyChainBundle(valid, { requiredTrustTier: "production" }), /production trust tier|trusted key/);
});

test("rejects dependencies whose licenses are not explicitly approved", () => {
  const input = fixture();
  input.licenses = { "GPL-3.0-only": [{ name: "copyleft-lib", versions: ["1.0.0"], license: "GPL-3.0-only" }] };
  assert.throws(() => generateSupplyChainBundle({ ...input, artifactPaths: ["dist"] }), /legal approval/);
});

test("production evidence requires an exact source revision even when trustTier is derived", () => {
  const input = fixture();
  assert.throws(
    () => generateSupplyChainBundle({
      ...input,
      artifactPaths: ["dist"],
      environment: "production",
      sourceRevision: "unversioned",
    }),
    /production provenance requires an exact source revision digest/,
  );
});
