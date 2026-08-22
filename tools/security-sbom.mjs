#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateSupplyChainBundle, verifySupplyChainBundle } from "../security/supply-chain.mjs";
import { stableJson } from "../security/lib/canonical.mjs";

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = argumentsMap(argv);
  const command = options._[0] ?? "generate";
  if (command === "generate") {
    const out = resolve(String(options.out ?? ".artifacts/security/supply-chain"));
    const keyPath = options["private-key"] ?? environment.LTM_SUPPLY_CHAIN_SIGNING_KEY_FILE;
    if (typeof keyPath !== "string") {
      throw new Error("--private-key or LTM_SUPPLY_CHAIN_SIGNING_KEY_FILE is required");
    }
    const artifactPaths = values(options.artifact);
    const licensePolicyPath = String(options["license-policy"] ?? "security/license-policy.json");
    const licensePolicy = JSON.parse(readFileSync(resolve(licensePolicyPath), "utf8"));
    const bundle = generateSupplyChainBundle({
      root: String(options.root ?? process.cwd()),
      privateKeyPem: readFileSync(resolve(keyPath), "utf8"),
      environment: String(options.environment ?? environment.APP_ENV ?? "ci"),
      trustTier: String(options["trust-tier"] ?? "ci"),
      sourceDateEpoch: String(options["source-date-epoch"] ?? environment.SOURCE_DATE_EPOCH ?? "0"),
      builderId: String(options.builder ?? environment.GITHUB_WORKFLOW_REF ?? "local:security-supply-chain"),
      invocationId: String(options.invocation ?? environment.GITHUB_RUN_ID ?? "local"),
      ...(options["source-revision"] === undefined ? {} : { sourceRevision: String(options["source-revision"]) }),
      ...(options["source-uri"] === undefined ? {} : { sourceUri: String(options["source-uri"]) }),
      ...(artifactPaths.length === 0 ? {} : { artifactPaths }),
      allowedLicenses: licensePolicy.allowedLicenses,
    });
    mkdirSync(out, { recursive: true });
    const files = {
      "bom.cyclonedx.json": bundle.cycloneDx,
      "bom.spdx.json": bundle.spdx,
      "dependency-licenses.json": bundle.licenseInventory,
      "artifact-manifest.json": bundle.artifactManifest,
      "provenance.intoto.json": bundle.provenance,
      "attestation.json": bundle.attestation,
      "bundle.json": bundle,
    };
    for (const [name, value] of Object.entries(files)) writeFileSync(resolve(out, name), stableJson(value), { mode: 0o600 });
    const result = verifySupplyChainBundle(bundle);
    process.stdout.write(`${JSON.stringify({ ...result, output: out, artifactFiles: bundle.artifactManifest.files.length })}\n`);
    return result;
  }
  if (command === "verify") {
    const bundlePath = options.bundle;
    if (typeof bundlePath !== "string") throw new Error("--bundle is required for verify");
    const publicKeyPath = options["public-key"];
    const trustedKeyIds = values(options["trusted-key-id"]);
    const result = verifySupplyChainBundle(JSON.parse(readFileSync(resolve(bundlePath), "utf8")), {
      ...(typeof publicKeyPath === "string" ? { publicKeyPem: readFileSync(resolve(publicKeyPath), "utf8") } : {}),
      ...(trustedKeyIds.length > 0 ? { trustedKeyIds } : {}),
      ...(options["required-trust-tier"] === undefined ? {} : { requiredTrustTier: String(options["required-trust-tier"]) }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  throw new Error(`unknown command: ${command}`);
}

function argumentsMap(argv) {
  const result = { _: [] };
  for (const item of argv) {
    if (!item.startsWith("--")) { result._.push(item); continue; }
    const split = item.indexOf("=");
    const key = item.slice(2, split < 0 ? undefined : split);
    const value = split < 0 ? true : item.slice(split + 1);
    if (result[key] === undefined) result[key] = value;
    else result[key] = [...values(result[key]), value];
  }
  return result;
}

function values(value) {
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`SECURITY_SBOM ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
