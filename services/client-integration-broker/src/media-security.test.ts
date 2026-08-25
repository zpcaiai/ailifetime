import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BrokerError,
  RotatingSecretFile,
  sha256,
  type MediaSafetyEvidence,
} from "./contracts.js";
import { HttpsMediaSafetyScanner } from "./media-security.js";

const NOW = new Date("2026-08-24T08:00:00.000Z");
const TENANT_ID = "tenant-1";
const ACTOR_ID = "actor-1";
const MEDIA_REFERENCE = "media-1";

test("production scanner accepts only an Ed25519 receipt bound to the pinned provider, policy, model, key, and environment", async (context) => {
  const tokenFile = await scannerToken(context);
  const directory = await mkdtemp(join(tmpdir(), "ltm-media-scanner-key-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync("ed25519");
  const publicKeyFile = join(directory, "receipt.pub");
  await writeFile(publicKeyFile, keys.publicKey.export({ type: "spki", format: "pem" }).toString(), { mode: 0o400 });
  await chmod(publicKeyFile, 0o400);
  const bytes = Buffer.from("signed-scanner-receipt", "utf8");
  const canonicalSha256 = sha256(bytes);
  const authority = {
    publicKeyFile,
    provider: "scanner-workload-1",
    policyId: "media-safety-v4",
    policySha256: "d".repeat(64),
    modelVersion: "scanner-model-2026-08",
    keyId: "scanner-receipt-key-1",
    environment: "production" as const,
  };
  let tamper = false;
  const scanner = new HttpsMediaSafetyScanner({
    baseUrl: "https://media-safety.example.com",
    tokenFile,
    receiptAuthority: authority,
    clock: () => new Date(NOW),
    fetch: async (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      const signed = {
        version: "ltm.media-safety-evidence.v3",
        requestNonce: headers["x-ltm-request-nonce"],
        evidenceId: "scan-evidence-signed-1",
        provider: authority.provider,
        environment: authority.environment,
        policyId: authority.policyId,
        policySha256: authority.policySha256,
        modelVersion: authority.modelVersion,
        keyId: authority.keyId,
        tenantId: headers["x-ltm-tenant-id"],
        actorId: headers["x-ltm-actor-id"],
        mediaReference: headers["x-ltm-media-reference"],
        canonicalSha256: headers["x-ltm-content-sha256"],
        malwareState: "clean",
        contentPolicyState: "allowed",
        faceCount: 1,
        faceSubjectReferences: ["face-subject-1"],
        assessedAt: NOW.toISOString(),
      };
      const signature = sign(null, Buffer.from(canonical(signed)), keys.privateKey).toString("base64url");
      return jsonResponse({ ...signed, ...(tamper ? { faceSubjectReferences: ["attacker-face"] } : {}), signature });
    },
  });
  assert.deepEqual(scanner.authority(), {
    mediaSafetyPolicySha256: authority.policySha256,
    provider: authority.provider,
    policyId: authority.policyId,
    modelVersion: authority.modelVersion,
    keyId: authority.keyId,
    environment: "production",
  });
  const evidence = await scanner.scan({ tenantId: TENANT_ID, actorId: ACTOR_ID, mediaReference: MEDIA_REFERENCE, canonicalSha256, bytes });
  assert.equal(evidence.version, "ltm.media-safety-evidence.v3");
  assert.equal(evidence.policySha256, authority.policySha256);
  assert.throws(
    () => scanner.verifyEvidence({ ...evidence, faceSubjectReferences: ["tampered-face"] }),
    (error: unknown) => error instanceof BrokerError && error.code === "DEPENDENCY_UNAVAILABLE",
  );
  tamper = true;
  await assert.rejects(
    scanner.scan({ tenantId: TENANT_ID, actorId: ACTOR_ID, mediaReference: MEDIA_REFERENCE, canonicalSha256, bytes }),
    dependencyFailure,
  );
});

test("HTTPS scanner requires nonce-bound closed scan and ordered participant responses", async (context) => {
  const tokenFile = await scannerToken(context);
  const bytes = Buffer.from("canonical-jpeg-pixel-projection", "utf8");
  const canonicalSha256 = sha256(bytes);
  let mappingRequest: Record<string, unknown> | undefined;
  const scanner = new HttpsMediaSafetyScanner({
    baseUrl: "https://media-safety.example.com",
    tokenFile,
    clock: () => new Date(NOW),
    fetch: async (input, init) => {
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.authorization, "Bearer scanner-workload-token-value-123456789");
      const path = new URL(String(input)).pathname;
      if (path === "/v1/media/scan") {
        assert.equal(init?.method, "POST");
        assert.equal(headers["x-ltm-content-sha256"], canonicalSha256);
        assert.match(headers["x-ltm-request-nonce"] ?? "", /^scan_[0-9a-f-]{36}$/);
        return jsonResponse({
          version: "ltm.media-safety-evidence.v2",
          requestNonce: headers["x-ltm-request-nonce"],
          evidenceId: "scan-evidence-1",
          provider: "scanner-workload-1",
          tenantId: headers["x-ltm-tenant-id"],
          actorId: headers["x-ltm-actor-id"],
          mediaReference: headers["x-ltm-media-reference"],
          canonicalSha256: headers["x-ltm-content-sha256"],
          malwareState: "clean",
          contentPolicyState: "allowed",
          faceCount: 1,
          faceSubjectReferences: ["face-subject-1"],
          assessedAt: NOW.toISOString(),
        });
      }
      if (path === "/v1/media/participant-mappings") {
        mappingRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          version: "ltm.media-participant-mapping.v2",
          requestNonce: mappingRequest.requestNonce,
          evidenceId: "mapping-evidence-1",
          provider: "identity-review-workload-1",
          tenantId: mappingRequest.tenantId,
          actorId: mappingRequest.actorId,
          mediaReference: mappingRequest.mediaReference,
          canonicalSha256: mappingRequest.canonicalSha256,
          scanEvidenceId: mappingRequest.scanEvidenceId,
          participantIds: mappingRequest.participantIds,
          faceSubjectReferences: mappingRequest.faceSubjectReferences,
          state: "approved",
          assessedAt: NOW.toISOString(),
        });
      }
      throw new Error(`unexpected scanner path ${path}`);
    },
  });
  const scan = await scanner.scan({
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    mediaReference: MEDIA_REFERENCE,
    canonicalSha256,
    bytes,
  });
  const mapping = await scanner.approveParticipants({
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    mediaReference: MEDIA_REFERENCE,
    canonicalSha256,
    scanEvidence: scan,
    participantIds: ["participant-1"],
  });
  assert.deepEqual(mapping.participantIds, ["participant-1"]);
  assert.deepEqual(mapping.faceSubjectReferences, ["face-subject-1"]);
  assert.ok(mappingRequest);
  assert.match(String(mappingRequest.requestNonce), /^mapping_[0-9a-f-]{36}$/);
  assert.deepEqual(mappingRequest, {
    version: "ltm.media-participant-mapping-request.v2",
    requestNonce: mappingRequest.requestNonce,
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    mediaReference: MEDIA_REFERENCE,
    canonicalSha256,
    scanEvidenceId: "scan-evidence-1",
    participantIds: ["participant-1"],
    faceSubjectReferences: ["face-subject-1"],
  });
});

test("every scan and participant response binding mismatch fails as dependency evidence, never safety evidence", async (context) => {
  const tokenFile = await scannerToken(context);
  const bytes = Buffer.from("closed-response-subject", "utf8");
  const canonicalSha256 = sha256(bytes);
  for (const field of ["requestNonce", "tenantId", "actorId", "mediaReference", "canonicalSha256"] as const) {
    const scanner = new HttpsMediaSafetyScanner({
      baseUrl: "https://media-safety.example.com",
      tokenFile,
      clock: () => new Date(NOW),
      fetch: async (_input, init) => {
        const headers = init?.headers as Record<string, string>;
        const payload: Record<string, unknown> = {
          version: "ltm.media-safety-evidence.v2",
          requestNonce: headers["x-ltm-request-nonce"],
          evidenceId: "scan-evidence-1",
          provider: "scanner-workload-1",
          tenantId: headers["x-ltm-tenant-id"],
          actorId: headers["x-ltm-actor-id"],
          mediaReference: headers["x-ltm-media-reference"],
          canonicalSha256: headers["x-ltm-content-sha256"],
          malwareState: "clean",
          contentPolicyState: "allowed",
          faceCount: 2,
          faceSubjectReferences: ["face-1", "face-2"],
          assessedAt: NOW.toISOString(),
        };
        payload[field] = field === "canonicalSha256" ? "f".repeat(64) : `wrong-${field}`;
        return jsonResponse(payload);
      },
    });
    await assert.rejects(
      scanner.scan({ tenantId: TENANT_ID, actorId: ACTOR_ID, mediaReference: MEDIA_REFERENCE, canonicalSha256, bytes }),
      dependencyFailure,
      `scan ${field} mismatch must fail closed`,
    );
  }

  const scanEvidence = validScanEvidence(canonicalSha256);
  for (const field of [
    "requestNonce", "tenantId", "actorId", "mediaReference", "canonicalSha256", "scanEvidenceId",
    "participantIds", "faceSubjectReferences",
  ] as const) {
    const scanner = new HttpsMediaSafetyScanner({
      baseUrl: "https://media-safety.example.com",
      tokenFile,
      clock: () => new Date(NOW),
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const payload: Record<string, unknown> = {
          version: "ltm.media-participant-mapping.v2",
          requestNonce: request.requestNonce,
          evidenceId: "mapping-evidence-1",
          provider: "identity-review-workload-1",
          tenantId: request.tenantId,
          actorId: request.actorId,
          mediaReference: request.mediaReference,
          canonicalSha256: request.canonicalSha256,
          scanEvidenceId: request.scanEvidenceId,
          participantIds: request.participantIds,
          faceSubjectReferences: request.faceSubjectReferences,
          state: "approved",
          assessedAt: NOW.toISOString(),
        };
        payload[field] = field === "canonicalSha256"
          ? "f".repeat(64)
          : field === "participantIds"
            ? ["participant-2", "participant-1"]
            : field === "faceSubjectReferences"
              ? ["face-2", "face-1"]
              : `wrong-${field}`;
        return jsonResponse(payload);
      },
    });
    await assert.rejects(
      scanner.approveParticipants({
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        mediaReference: MEDIA_REFERENCE,
        canonicalSha256,
        scanEvidence,
        participantIds: ["participant-1", "participant-2"],
      }),
      dependencyFailure,
      `participant mapping ${field} mismatch must fail closed`,
    );
  }
});

test("only scanner HTTP 422 is a safety rejection; auth, conflict and capacity failures remain retry/config failures", async (context) => {
  const tokenFile = await scannerToken(context);
  const bytes = Buffer.from("scanner-status-contract", "utf8");
  const canonicalSha256 = sha256(bytes);
  const cases = [
    [422, "SAFETY_REJECTED", false],
    [401, "CONFIGURATION_INVALID", false],
    [403, "CONFIGURATION_INVALID", false],
    [404, "CONFIGURATION_INVALID", false],
    [409, "DEPENDENCY_UNAVAILABLE", true],
    [429, "DEPENDENCY_UNAVAILABLE", true],
    [503, "DEPENDENCY_UNAVAILABLE", true],
    [400, "DEPENDENCY_UNAVAILABLE", false],
  ] as const;
  for (const [status, code, retryable] of cases) {
    const scanner = new HttpsMediaSafetyScanner({
      baseUrl: "https://media-safety.example.com",
      tokenFile,
      fetch: async () => new Response("{}", { status, headers: { "content-type": "application/json" } }),
    });
    await assert.rejects(
      scanner.scan({ tenantId: TENANT_ID, actorId: ACTOR_ID, mediaReference: MEDIA_REFERENCE, canonicalSha256, bytes }),
      (error: unknown) => error instanceof BrokerError && error.code === code && error.retryable === retryable,
      `unexpected scanner classification for HTTP ${status}`,
    );
  }
});

test("chunked scanner bodies are cancelled as soon as they exceed 64 KiB", async (context) => {
  const tokenFile = await scannerToken(context);
  const bytes = Buffer.from("bounded-stream-contract", "utf8");
  const canonicalSha256 = sha256(bytes);
  let cancelled = 0;
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(40 * 1024).fill(0x78));
    },
    cancel() { cancelled += 1; },
  });
  const scanner = new HttpsMediaSafetyScanner({
    baseUrl: "https://media-safety.example.com",
    tokenFile,
    fetch: async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    scanner.scan({ tenantId: TENANT_ID, actorId: ACTOR_ID, mediaReference: MEDIA_REFERENCE, canonicalSha256, bytes }),
    dependencyFailure,
  );
  // WHATWG streams may perform one bounded prefetch pull, but cancellation must
  // happen before a third 40 KiB chunk can be consumed or the stream can close.
  assert.ok(pulls >= 2 && pulls <= 3);
  assert.equal(cancelled, 1);
});

test("malformed scanner content types and open readiness payloads fail closed", async (context) => {
  const tokenFile = await scannerToken(context);
  const bytes = Buffer.from("malformed-scanner-contract", "utf8");
  const canonicalSha256 = sha256(bytes);
  const malformed = new HttpsMediaSafetyScanner({
    baseUrl: "https://media-safety.example.com",
    tokenFile,
    fetch: async () => new Response("{}", { status: 200, headers: { "content-type": "text/json" } }),
  });
  await assert.rejects(
    malformed.scan({ tenantId: TENANT_ID, actorId: ACTOR_ID, mediaReference: MEDIA_REFERENCE, canonicalSha256, bytes }),
    dependencyFailure,
  );
  const openReadiness = new HttpsMediaSafetyScanner({
    baseUrl: "https://media-safety.example.com",
    tokenFile,
    fetch: async () => jsonResponse({ ready: true, untrustedStatus: "passed" }),
  });
  assert.equal(await openReadiness.readiness(), false);
});

async function scannerToken(context: { after(callback: () => void | Promise<void>): void }): Promise<RotatingSecretFile> {
  const directory = await mkdtemp(join(tmpdir(), "ltm-media-scanner-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const tokenPath = join(directory, "token");
  await writeFile(tokenPath, "scanner-workload-token-value-123456789\n", { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  return new RotatingSecretFile(tokenPath);
}

function validScanEvidence(canonicalSha256: string): MediaSafetyEvidence {
  return {
    version: "ltm.media-safety-evidence.v2",
    requestNonce: "scan_test_nonce_1",
    evidenceId: "scan-evidence-1",
    provider: "scanner-workload-1",
    tenantId: TENANT_ID,
    actorId: ACTOR_ID,
    mediaReference: MEDIA_REFERENCE,
    canonicalSha256,
    malwareState: "clean",
    contentPolicyState: "allowed",
    faceCount: 2,
    faceSubjectReferences: ["face-1", "face-2"],
    assessedAt: NOW.toISOString(),
  };
}

function dependencyFailure(error: unknown): boolean {
  return error instanceof BrokerError && error.code === "DEPENDENCY_UNAVAILABLE" && error.retryable === false;
}

function jsonResponse(value: unknown): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
  });
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}
