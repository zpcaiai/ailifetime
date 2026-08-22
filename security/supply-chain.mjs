import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { canonicalSha256, canonicalize, sha256 } from "./lib/canonical.mjs";

const LOCKFILE = "pnpm-lock.yaml";
const DEFAULT_ALLOWED_LICENSES = ["0BSD", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MIT"];

export function generateSupplyChainBundle(options) {
  const root = resolve(options.root ?? process.cwd());
  const environment = options.environment ?? "ci";
  if (!new Set(["ci", "staging", "production"]).has(environment)) throw new Error("supply-chain environment must be ci, staging, or production");
  const trustTier = options.trustTier ?? environment;
  if (trustTier !== environment) throw new Error("supply-chain trust tier must match its evidence environment");
  const sourceDateEpoch = integer(options.sourceDateEpoch ?? process.env.SOURCE_DATE_EPOCH ?? "0", "source date epoch");
  const created = new Date(sourceDateEpoch * 1_000).toISOString().replace(".000Z", "Z");
  const lockPath = resolveInside(root, options.lockfile ?? LOCKFILE);
  const lockBytes = readFileSync(lockPath);
  const lockText = lockBytes.toString("utf8");
  const components = parsePnpmPackages(lockText);
  if (components.length === 0) throw new Error("the pnpm lockfile contains no resolved packages");
  const licenses = options.licenses ?? readPnpmLicenses(root, options.productionOnly === true);
  const artifacts = collectArtifacts(root, options.artifactPaths === undefined
    ? defaultArtifactPaths(root)
    : [...defaultArtifactPaths(root), ...options.artifactPaths]);
  if (artifacts.length === 0) throw new Error("at least one built artifact is required");

  const lockfileSha256 = sha256(lockBytes);
  const sourceRevision = options.sourceRevision ?? detectSourceRevision(root);
  if (options.trustTier === "production" && !/^[a-f0-9]{40,64}$/.test(sourceRevision)) throw new Error("production provenance requires an exact source revision digest");
  const artifactManifest = {
    version: "ltm.artifact-manifest.v1",
    algorithm: "sha256",
    files: artifacts,
  };
  const artifactManifestSha256 = canonicalSha256(artifactManifest);
  const cycloneDx = cycloneDocument(components, lockfileSha256, artifactManifestSha256);
  const spdx = spdxDocument(components, lockfileSha256, created);
  const licenseInventory = licenseDocument(licenses, lockfileSha256);
  enforceLicensePolicy(licenseInventory, options.allowedLicenses ?? DEFAULT_ALLOWED_LICENSES);
  const materials = [
    { uri: relative(root, lockPath).split(sep).join("/"), digest: { sha256: lockfileSha256 } },
    { uri: options.sourceUri ?? ((process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY)
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
      : "local:git-checkout"), digest: { gitCommit: sourceRevision } },
  ];
  const provenance = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "ltm-build-artifacts", digest: { sha256: artifactManifestSha256 } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://ai-life-time-machine.example/build/pnpm/v1",
        externalParameters: {
          packageManager: "pnpm@10.12.4",
          sourceDateEpoch,
        },
        internalParameters: {},
        resolvedDependencies: materials,
      },
      runDetails: {
        builder: { id: options.builderId ?? process.env.GITHUB_WORKFLOW_REF ?? "local:security-supply-chain" },
        metadata: { invocationId: options.invocationId ?? process.env.GITHUB_RUN_ID ?? "local" },
      },
    },
  };
  const documents = {
    cycloneDx: { sha256: canonicalSha256(cycloneDx), mediaType: "application/vnd.cyclonedx+json" },
    spdx: { sha256: canonicalSha256(spdx), mediaType: "application/spdx+json" },
    licenses: { sha256: canonicalSha256(licenseInventory), mediaType: "application/json" },
    artifacts: { sha256: canonicalSha256(artifactManifest), mediaType: "application/json" },
    provenance: { sha256: canonicalSha256(provenance), mediaType: "application/vnd.in-toto+json" },
  };
  const claims = {
    version: "ltm.supply-chain-claims.v1",
    environment,
    sourceDateEpoch,
    sourceRevision,
    lockfileSha256,
    artifactManifestSha256,
    documents,
  };
  const signing = signClaims(claims, options.privateKeyPem, options.keyId, trustTier);
  return {
    cycloneDx,
    spdx,
    licenseInventory,
    artifactManifest,
    provenance,
    attestation: {
      version: "ltm.supply-chain-attestation.v1",
      claims,
      signature: signing.signature,
      algorithm: "Ed25519",
      keyId: signing.keyId,
      trustTier: signing.trustTier,
      publicKeyPem: signing.publicKeyPem,
    },
  };
}

export function verifySupplyChainBundle(bundle, options = {}) {
  assertObject(bundle, "bundle");
  assertObject(bundle.attestation, "attestation");
  if (bundle.attestation.version !== "ltm.supply-chain-attestation.v1" || bundle.attestation.algorithm !== "Ed25519") {
    throw new Error("unsupported supply-chain attestation version or algorithm");
  }
  const claims = bundle.attestation.claims;
  assertObject(claims, "attestation claims");
  if (options.requiredTrustTier !== undefined) {
    if (bundle.attestation.trustTier !== options.requiredTrustTier || claims.environment !== options.requiredTrustTier) {
      throw new Error(`supply-chain evidence is not in the required ${options.requiredTrustTier} trust tier`);
    }
    if (options.requiredTrustTier === "production" && (!Array.isArray(options.trustedKeyIds) || options.trustedKeyIds.length === 0)) {
      throw new Error("production supply-chain verification requires an explicit trusted key ID allowlist");
    }
  }
  const expected = {
    cycloneDx: canonicalSha256(bundle.cycloneDx),
    spdx: canonicalSha256(bundle.spdx),
    licenses: canonicalSha256(bundle.licenseInventory),
    artifacts: canonicalSha256(bundle.artifactManifest),
    provenance: canonicalSha256(bundle.provenance),
  };
  for (const [name, digest] of Object.entries(expected)) {
    if (claims.documents?.[name]?.sha256 !== digest) throw new Error(`${name} digest is not bound by the attestation`);
  }
  const manifestDigest = canonicalSha256(bundle.artifactManifest);
  if (claims.artifactManifestSha256 !== manifestDigest || bundle.provenance?.subject?.[0]?.digest?.sha256 !== manifestDigest) {
    throw new Error("artifact manifest digest is not bound to provenance");
  }
  const publicKeyPem = options.publicKeyPem ?? bundle.attestation.publicKeyPem;
  if (typeof publicKeyPem !== "string" || publicKeyPem.trim() === "") throw new Error("an Ed25519 public key is required");
  const calculatedKeyId = keyIdentifier(publicKeyPem);
  if (calculatedKeyId !== bundle.attestation.keyId) throw new Error("attestation key identifier does not match its public key");
  if (options.trustedKeyIds !== undefined && !options.trustedKeyIds.includes(calculatedKeyId)) {
    throw new Error("attestation signing key is not trusted for this release");
  }
  const valid = verify(
    null,
    Buffer.from(canonicalize(claims), "utf8"),
    createPublicKey(publicKeyPem),
    Buffer.from(bundle.attestation.signature, "base64"),
  );
  if (!valid) throw new Error("supply-chain attestation signature is invalid");
  return { status: "PASS", keyId: calculatedKeyId, artifactManifestSha256: manifestDigest };
}

function signClaims(claims, privateKeyPem, requestedKeyId, trustTier) {
  if (typeof privateKeyPem !== "string" || privateKeyPem.trim() === "") {
    throw new Error("an external Ed25519 signing private key is required; unsigned build evidence is forbidden");
  }
  if (!new Set(["ci", "staging", "production"]).has(trustTier)) throw new Error("trust tier must be ci, staging, or production");
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("the supply-chain signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const derivedKeyId = keyIdentifier(publicKeyPem);
  if (requestedKeyId !== undefined && requestedKeyId !== derivedKeyId) throw new Error("configured keyId does not match the signing key");
  return {
    signature: sign(null, Buffer.from(canonicalize(claims), "utf8"), privateKey).toString("base64"),
    keyId: derivedKeyId,
    trustTier,
    publicKeyPem,
  };
}

function keyIdentifier(publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("trusted supply-chain keys must be Ed25519");
  const der = key.export({ format: "der", type: "spki" });
  return `ed25519:${sha256(der)}`;
}

function cycloneDocument(components, lockfileSha256, artifactManifestSha256) {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      component: {
        type: "application",
        "bom-ref": "pkg:npm/ai-life-time-machine-project@1.0.0",
        name: "ai-life-time-machine-project",
        version: "1.0.0",
        hashes: [{ alg: "SHA-256", content: artifactManifestSha256 }],
      },
      properties: [{ name: "ltm:pnpm-lock-sha256", value: lockfileSha256 }],
    },
    components: components.map((component) => ({
      type: "library",
      "bom-ref": component.purl,
      name: component.name,
      version: component.version,
      purl: component.purl,
      ...(component.integrity === undefined ? {} : { hashes: [integrityHash(component.integrity)] }),
    })),
  };
}

function spdxDocument(components, lockfileSha256, created) {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "ai-life-time-machine-project-sbom",
    documentNamespace: `https://ai-life-time-machine.example/spdx/${lockfileSha256}`,
    creationInfo: { created, creators: ["Tool: ltm-security-supply-chain/1"] },
    packages: components.map((component, index) => ({
      SPDXID: `SPDXRef-Package-${index + 1}`,
      name: component.name,
      versionInfo: component.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      externalRefs: [{
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: component.purl,
      }],
      ...(component.integrity === undefined ? {} : { checksums: [integrityHash(component.integrity, true)] }),
    })),
  };
}

function licenseDocument(raw, lockfileSha256) {
  const components = [];
  for (const [license, entries] of Object.entries(raw).sort(([left], [right]) => left.localeCompare(right))) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry?.name !== "string" || !Array.isArray(entry.versions)) continue;
      for (const version of entry.versions) {
        components.push({
          name: entry.name,
          version: String(version),
          license: String(entry.license ?? license),
          ...(typeof entry.author === "string" ? { author: entry.author } : {}),
          ...(typeof entry.homepage === "string" ? { homepage: entry.homepage } : {}),
        });
      }
    }
  }
  components.sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
  return { version: "ltm.dependency-license-inventory.v1", lockfileSha256, components };
}

function enforceLicensePolicy(inventory, allowedLicenses) {
  if (!Array.isArray(allowedLicenses) || allowedLicenses.length === 0 || new Set(allowedLicenses).size !== allowedLicenses.length) throw new Error("dependency license allowlist must be non-empty and unique");
  if (inventory.components.length === 0) throw new Error("dependency license inventory is empty");
  const allowed = new Set(allowedLicenses);
  const rejected = inventory.components.filter((component) => !allowed.has(component.license));
  if (rejected.length > 0) throw new Error(`dependency licenses require legal approval: ${rejected.map((item) => `${item.name}@${item.version}:${item.license}`).join(", ")}`);
}

function readPnpmLicenses(root, productionOnly) {
  let output;
  try {
    output = execFileSync("pnpm", ["licenses", "list", "--json", ...(productionOnly ? ["--prod"] : [])], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
  } catch (error) {
    throw new Error(`pnpm license inventory failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return JSON.parse(output);
}

function detectSourceRevision(root) {
  try {
    const value = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim().toLowerCase();
    return /^[a-f0-9]{40,64}$/.test(value) ? value : "unversioned";
  } catch { return "unversioned"; }
}

function parsePnpmPackages(lockText) {
  const lines = lockText.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "packages:");
  if (start < 0) return [];
  const result = [];
  let current;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[A-Za-z][A-Za-z-]*:$/.test(line)) break;
    const packageMatch = /^  ('(?:[^']|'')+'|[^ ].*):$/.exec(line);
    if (packageMatch !== null) {
      const key = unquoteYaml(packageMatch[1]);
      const parsed = packageNameVersion(key);
      current = parsed === undefined ? undefined : { ...parsed };
      if (current !== undefined) result.push(current);
      continue;
    }
    const integrity = /^    resolution: \{integrity: ([^}]+)\}/.exec(line)?.[1];
    if (integrity !== undefined && current !== undefined) current.integrity = unquoteYaml(integrity.trim());
  }
  return result.sort((left, right) => left.purl.localeCompare(right.purl));
}

function packageNameVersion(key) {
  const normalized = key.replace(/\(.+\)$/, "");
  const split = normalized.lastIndexOf("@");
  if (split <= 0 || split === normalized.length - 1) return undefined;
  const name = normalized.slice(0, split);
  const version = normalized.slice(split + 1);
  const encodedName = name.startsWith("@")
    ? `%40${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(name);
  return { name, version, purl: `pkg:npm/${encodedName}@${encodeURIComponent(version)}` };
}

function integrityHash(integrity, spdx = false) {
  const match = /^(sha256|sha384|sha512)-(.+)$/.exec(integrity);
  if (match === null) throw new Error("unsupported dependency integrity digest");
  const algorithm = match[1].toUpperCase().replace("SHA", "SHA-");
  const content = Buffer.from(match[2], "base64").toString("hex");
  return spdx ? { algorithm: algorithm.replace("-", ""), checksumValue: content } : { alg: algorithm, content };
}

function defaultArtifactPaths(root) {
  const candidates = [];
  for (const parent of ["apps", "packages", "services"]) {
    const absolute = resolve(root, parent);
    if (!existsDirectory(absolute)) continue;
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dist = resolve(absolute, entry.name, "dist");
      if (existsDirectory(dist)) candidates.push(relative(root, dist));
    }
  }
  const webPublic = resolve(root, "apps/web/public");
  if (existsDirectory(webPublic)) candidates.push("apps/web/public");
  return candidates;
}

function collectArtifacts(root, paths) {
  const files = [];
  for (const input of [...new Set(paths)].sort()) {
    const absolute = resolveInside(root, input);
    const stats = statSync(absolute);
    if (stats.isDirectory()) walk(absolute, files);
    else if (stats.isFile()) files.push(absolute);
    else throw new Error(`artifact path is not a regular file or directory: ${input}`);
  }
  return [...new Set(files)].sort().map((file) => ({
    path: relative(root, file).split(sep).join("/"),
    size: statSync(file).size,
    sha256: sha256(readFileSync(file)),
  }));
}

function walk(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`artifact trees must not contain symbolic links: ${child}`);
    if (entry.isDirectory()) walk(child, files);
    else if (entry.isFile()) files.push(child);
  }
}

function resolveInside(root, input) {
  const result = resolve(root, input);
  if (result !== root && !result.startsWith(`${root}${sep}`)) throw new Error(`path escapes repository root: ${input}`);
  return result;
}

function existsDirectory(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function unquoteYaml(value) {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

function integer(value, label) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}
