import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  Ed25519EvidenceAttestor,
  sha256,
  type HardenedHttpRequest,
  type SecretReference,
  type SecretResolver,
} from "@ltm/providers";
import { ApiExternalBusinessEventOutput, RotatingFileBearerTokenProvider } from "./evidence-output.js";

test("signed callback event and evidence become one atomic external-event.apply command envelope", async () => {
  const pair = generateKeyPairSync("ed25519");
  const reference: SecretReference = "secret-manager:test/evidence-key";
  const secrets: SecretResolver = {
    async resolve(value) {
      assert.equal(value, reference);
      return Buffer.from(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
    },
  };
  const artifact = Buffer.from("exact verified native callback bytes", "utf8");
  const attestor = new Ed25519EvidenceAttestor({
    issuer: "test:gateway",
    keyId: "test-key-1",
    privateKeyReference: reference,
    clock: () => new Date(),
  }, secrets);
  const attested = await attestor.attestBusinessEvent({
    tenantId: "tenant-1",
    batchId: "B66",
    operation: "verifyStoreTransaction",
    kind: "store-transaction",
    provider: "google-play",
    artifactSha256: sha256(artifact),
    environment: "test",
    subjectId: "gplay:transaction-1",
  }, artifact, {
    eventId: "google-message-1",
    subjectType: "account",
    subjectId: "account-1",
    eventType: "entitlement.granted",
    providerOccurredAt: new Date().toISOString(),
    sequence: 1,
    correlationId: "gplay:transaction-1",
    canonicalClaims: { accountId: "account-1", productId: "life.yearly", transactionId: "gplay:transaction-1" },
  });
  const { evidence, event: businessEvent } = attested;
  let observed: HardenedHttpRequest | undefined;
  const output = new ApiExternalBusinessEventOutput({
    endpoint: new URL("https://api.example.test/v1/commands"),
    purpose: "external_business_event_projection",
  }, { getToken: async () => "rotated-workload-identity-token-value-123456789" }, {
    async request(input) {
      observed = input;
      return {
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        body: Buffer.from(JSON.stringify({
          data: { value: { eventId: businessEvent.eventId, nextState: "active" }, replayed: false },
          meta: { command: "external-event.apply", requestId: "api-request-1" },
        })),
      };
    },
  });
  await output.publish({
    requestId: "gateway-request-1",
    providerEventId: "google-message-1",
    evidence,
    businessEvent,
    receipt: { state: "verified" },
  });
  const body = JSON.parse(Buffer.from(observed?.body ?? []).toString("utf8")) as Record<string, unknown>;
  assert.equal(body.command, "external-event.apply");
  const input = body.input as Record<string, unknown>;
  const runtimeEvidence = input.evidence as Record<string, unknown>;
  assert.equal(runtimeEvidence.environment, "test");
  assert.equal(runtimeEvidence.evidenceId, evidence.evidenceId);
  assert.equal((input.event as Record<string, unknown>).businessEventSha256, businessEvent.businessEventSha256);
  assert.equal("binding" in runtimeEvidence, false);
  assert.equal(observed?.headers?.["idempotency-key"], businessEvent.eventId);
  assert.equal(observed?.headers?.["x-purpose"], "external_business_event_projection");
  assert.match(observed?.headers?.authorization ?? "", /^Bearer rotated-workload-identity-token/);
});

test("workload identity token provider re-reads a safely permissioned token file after rotation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ltm-gateway-token-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "token");
  const first = "workload-identity-token-first-1234567890";
  const second = "workload-identity-token-second-123456789";
  await writeFile(path, `${first}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  const provider = new RotatingFileBearerTokenProvider(path);
  assert.equal(await provider.getToken(), first);
  await writeFile(path, `${second}\n`, { mode: 0o600 });
  assert.equal(await provider.getToken(), second);
});
