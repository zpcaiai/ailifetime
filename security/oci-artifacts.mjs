import { execFileSync } from "node:child_process";

const REQUIRED_PRODUCTION_ROLES = [
  "api",
  "workers",
  "integration-gateway",
  "client-integration-broker",
  "migrator",
];

export function captureLocalOciArtifacts(images, options = {}) {
  if (!Array.isArray(images) || images.length === 0) throw new Error("at least one OCI image is required");
  const inspect = options.inspect ?? ((reference) => JSON.parse(execFileSync("docker", ["image", "inspect", reference], { encoding: "utf8", timeout: 30_000 })));
  const records = images.map(({ role, reference }) => {
    identifier(role, "image role");
    imageReference(reference, false);
    const result = inspect(reference);
    const image = Array.isArray(result) ? result[0] : undefined;
    if (image === undefined || !/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new Error(`docker did not return a content-addressed image ID for ${role}`);
    // BuildKit may synthesize a name@sha256 RepoDigest for an image that only
    // exists in the local image store. A tagged capture is therefore local CI
    // evidence only. Preserve a registry digest solely when the caller itself
    // addressed the image by that exact immutable digest.
    const repoDigests = isDigestReference(reference) && Array.isArray(image.RepoDigests)
      ? image.RepoDigests.filter((item) => item === reference).sort()
      : [];
    return {
      role,
      buildReference: reference,
      imageId: image.Id,
      repoDigests,
      platform: `${String(image.Os ?? "unknown")}/${String(image.Architecture ?? "unknown")}`,
    };
  }).sort((left, right) => left.role.localeCompare(right.role));
  if (new Set(records.map((item) => item.role)).size !== records.length) throw new Error("OCI image roles must be unique");
  return { version: "ltm.oci-artifact-manifest.v1", environment: options.environment ?? "ci", images: records };
}

export function verifyOciArtifactManifest(manifest, options = {}) {
  if (manifest?.version !== "ltm.oci-artifact-manifest.v1" || !Array.isArray(manifest.images) || manifest.images.length === 0) throw new Error("OCI artifact manifest is invalid");
  const environment = options.environment ?? manifest.environment;
  const roles = new Set();
  for (const image of manifest.images) {
    identifier(image.role, "image role");
    if (roles.has(image.role)) throw new Error("OCI artifact manifest contains a duplicate role");
    roles.add(image.role);
    if (!/^sha256:[a-f0-9]{64}$/.test(image.imageId)) throw new Error("OCI image ID must be content-addressed");
    if (!Array.isArray(image.repoDigests)) throw new Error("OCI repoDigests must be an array");
    for (const digest of image.repoDigests) imageReference(digest, true);
  }
  if (environment === "production") {
    const missing = REQUIRED_PRODUCTION_ROLES.filter((role) => !roles.has(role));
    if (missing.length > 0) return { status: "BLOCKED_EXTERNAL", gate: "production-oci-digests", reason: `missing production image roles: ${missing.join(",")}` };
    const mutable = manifest.images.filter((image) =>
      !isDigestReference(image.buildReference) || !image.repoDigests.includes(image.buildReference),
    );
    if (mutable.length > 0) return { status: "BLOCKED_EXTERNAL", gate: "production-oci-digests", reason: `registry digests are missing for: ${mutable.map((item) => item.role).join(",")}` };
  }
  return { status: "PASS", environment, images: manifest.images.length };
}

function imageReference(value, requireDigest) {
  if (typeof value !== "string" || value.length > 1_024 || /[\s\u0000-\u001f\u007f]/.test(value)) throw new Error("OCI image reference is invalid");
  const digest = /@sha256:[a-f0-9]{64}$/.test(value);
  if (requireDigest && !digest) throw new Error("production OCI references must use registry sha256 digests");
  return value;
}
function isDigestReference(value) { return typeof value === "string" && /@sha256:[a-f0-9]{64}$/.test(value); }
function identifier(value, label) { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error(`${label} is invalid`); return value; }
