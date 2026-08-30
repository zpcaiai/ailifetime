import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "@ltm/core";
import {
  Ed25519EvidenceAttestor,
  ProductionIntegrationError,
  sha256,
  type EvidenceArtifactStore,
  type ReplayStore,
  type SecretReference,
  type SecretResolver,
} from "@ltm/providers";
import {
  SUPPLY_EVENT_CALLBACK_ROUTES,
  createSupplyEventCallbackHandlers,
  parseSupplyEventAuthorityDocument,
  supplyEventCallbackPath,
} from "./supply-event-callbacks.js";

const NOW = new Date("2026-08-28T00:00:00.000Z");
const WEBHOOK_REFERENCE: SecretReference = "secret-manager:ltm/test/supply-webhook";
const ATTESTOR_REFERENCE: SecretReference = "secret-manager:ltm/test/supply-attestor";
const WEBHOOK_KEY = Buffer.from("supply-event-webhook-key-at-least-32-bytes");

class MemorySecrets implements SecretResolver {
  constructor(private readonly values: ReadonlyMap<SecretReference, Uint8Array>) {}
  async resolve(reference: SecretReference): Promise<Uint8Array> {
    const value = this.values.get(reference);
    if (value === undefined) throw new Error(`missing test secret ${reference}`);
    return Buffer.from(value);
  }
}

class MemoryReplays implements ReplayStore {
  readonly values = new Set<string>();
  async claimOnce(namespace: string, value: string): Promise<boolean> {
    const key = `${namespace}:${value}`;
    if (this.values.has(key)) return false;
    this.values.add(key);
    return true;
  }
}

class MemoryArtifacts implements EvidenceArtifactStore {
  readonly values: Array<{ readonly provider: string; readonly subjectId: string; readonly sha256: string }> = [];
  async put(input: Parameters<EvidenceArtifactStore["put"]>[0]) {
    this.values.push({ provider: input.provider, subjectId: input.subjectId, sha256: input.sha256 });
    return { uri: `memory://supply/${input.sha256}`, sha256: input.sha256 };
  }
}

function authorityDocument() {
  return {
    version: "ltm.supply-event-authorities.v1",
    authorities: SUPPLY_EVENT_CALLBACK_ROUTES.map((route) => ({
      routeId: route.routeId,
      provider: route.providerPrefix === "carrier:" ? "carrier:carrier-1" : "vendor:vendor-1",
      signatureScheme: "hmac-sha256",
      verificationKeyReference: WEBHOOK_REFERENCE,
      maximumClockSkewSeconds: 300,
      maximumBodyBytes: 64 * 1_024,
      retentionClass: "operational",
    })),
  };
}

function signedHeaders(body: Uint8Array, nonce: string): Readonly<Record<string, string>> {
  const timestamp = String(Math.floor(NOW.getTime() / 1_000));
  const digest = sha256(body);
  return {
    "x-ltm-timestamp": timestamp,
    "x-ltm-nonce": nonce,
    "x-ltm-signature": createHmac("sha256", WEBHOOK_KEY)
      .update(`ltm-provider-webhook-v1\n${timestamp}\n${nonce}\n${digest}\n`)
      .digest("base64"),
  };
}

test("managed supply policy is a closed enrolled authority inventory for B99, B100, and B102", () => {
  const document = authorityDocument();
  const loaded = parseSupplyEventAuthorityDocument(document, {
    tenantId: "tenant-supply-1",
    evidenceEnvironment: "sandbox",
  });
  assert.deepEqual(
    [...new Set(loaded.map((authority) => authority.route.batchId))].sort(),
    ["B100", "B102", "B99"],
  );
  assert.equal(loaded.length, 3);

  assert.throws(() => parseSupplyEventAuthorityDocument({
    ...document,
    authorities: document.authorities.slice(0, 2),
  }, { tenantId: "tenant-supply-1", evidenceEnvironment: "sandbox" }), /three to 128 authorities/);

  assert.throws(() => parseSupplyEventAuthorityDocument({
    ...document,
    authorities: [document.authorities[0], document.authorities[0], document.authorities[2]],
  }, { tenantId: "tenant-supply-1", evidenceEnvironment: "sandbox" }), /duplicated/);

  assert.throws(() => parseSupplyEventAuthorityDocument({
    ...document,
    authorities: document.authorities.map((authority, index) => index === 0
      ? { ...authority, provider: "vendor:not-a-carrier" }
      : authority),
  }, { tenantId: "tenant-supply-1", evidenceEnvironment: "sandbox" }), /does not match route/);
});

test("B100 callback authenticates exact bytes and derives a fixed inventory event without provider-computed balances", async () => {
  const keyPair = generateKeyPairSync("ed25519");
  const secrets = new MemorySecrets(new Map([
    [WEBHOOK_REFERENCE, WEBHOOK_KEY],
    [ATTESTOR_REFERENCE, Buffer.from(keyPair.privateKey.export({ type: "pkcs8", format: "pem" }))],
  ]));
  const replays = new MemoryReplays();
  const artifacts = new MemoryArtifacts();
  const attestor = new Ed25519EvidenceAttestor({
    issuer: "sandbox:supply-gateway",
    keyId: "supply-attestor-key-1",
    privateKeyReference: ATTESTOR_REFERENCE,
    clock: () => NOW,
  }, secrets);
  const authorities = parseSupplyEventAuthorityDocument(authorityDocument(), {
    tenantId: "tenant-supply-1",
    evidenceEnvironment: "sandbox",
  });
  const handlers = createSupplyEventCallbackHandlers(authorities, {
    secrets,
    replays,
    artifacts,
    attestor,
    clock: () => NOW,
  });
  const handler = handlers.get(supplyEventCallbackPath("b100-inventory-fact"));
  assert.ok(handler);
  const payload = {
    version: "ltm.supply-event.v1",
    routeId: "b100-inventory-fact",
    provider: "vendor:vendor-1",
    eventId: "inventory-event-1",
    subjectId: "inventory-item-1",
    eventType: "inventory.adjusted",
    providerOccurredAt: NOW.toISOString(),
    sequence: 7,
    vendorId: "vendor-1",
    sku: "sku-1",
    warehouseId: "warehouse-1",
    quantityDelta: 5,
    reservationDelta: 2,
    adjustmentReason: "receipt",
  };
  const rawBody = Buffer.from(canonicalJson(payload));
  const result = await handler.process({
    rawBody,
    headers: signedHeaders(rawBody, "supply-inventory-nonce-1"),
    requestId: "supply-request-1",
  });
  assert.equal(result.disposition, "attested");
  if (result.disposition !== "attested") assert.fail("expected attested supply event");
  assert.equal(result.businessEvent.batchId, "B100");
  assert.equal(result.businessEvent.operation, "recordInventoryAdjustment");
  assert.equal(result.businessEvent.subjectType, "inventory-item");
  assert.deepEqual(result.businessEvent.canonicalClaims, {
    vendorId: "vendor-1",
    sku: "sku-1",
    warehouseId: "warehouse-1",
    quantityDelta: 5,
    reservationDelta: 2,
    adjustmentReason: "receipt",
  });
  assert.equal("availableAfter" in result.businessEvent.canonicalClaims, false);
  assert.deepEqual(artifacts.values, [{
    provider: "vendor:vendor-1",
    subjectId: "inventory-item-1",
    sha256: sha256(rawBody),
  }]);

  await assert.rejects(handler.process({
    rawBody,
    headers: signedHeaders(rawBody, "supply-inventory-nonce-1"),
    requestId: "supply-request-replay",
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_REPLAY_DETECTED");

  const assertedBalance = Buffer.from(canonicalJson({ ...payload, availableAfter: 999 }));
  await assert.rejects(handler.process({
    rawBody: assertedBalance,
    headers: signedHeaders(assertedBalance, "supply-inventory-nonce-2"),
    requestId: "supply-request-asserted-balance",
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_RESPONSE_INVALID");
});

test("B99 shipment and B102 scorecard callbacks use distinct fixed schemas and derive reducer-owned correlations", async () => {
  const keyPair = generateKeyPairSync("ed25519");
  const secrets = new MemorySecrets(new Map([
    [WEBHOOK_REFERENCE, WEBHOOK_KEY],
    [ATTESTOR_REFERENCE, Buffer.from(keyPair.privateKey.export({ type: "pkcs8", format: "pem" }))],
  ]));
  const authorities = parseSupplyEventAuthorityDocument(authorityDocument(), {
    tenantId: "tenant-supply-1",
    evidenceEnvironment: "sandbox",
  });
  const handlers = createSupplyEventCallbackHandlers(authorities, {
    secrets,
    replays: new MemoryReplays(),
    artifacts: new MemoryArtifacts(),
    attestor: new Ed25519EvidenceAttestor({
      issuer: "sandbox:supply-gateway",
      keyId: "supply-attestor-key-2",
      privateKeyReference: ATTESTOR_REFERENCE,
      clock: () => NOW,
    }, secrets),
    clock: () => NOW,
  });
  const cases = [
    {
      routeId: "b99-shipment-fact" as const,
      nonce: "supply-shipment-nonce-1",
      payload: {
        version: "ltm.supply-event.v1",
        routeId: "b99-shipment-fact",
        provider: "carrier:carrier-1",
        eventId: "shipment-event-1",
        subjectId: "shipment-1",
        eventType: "shipment.in_transit",
        providerOccurredAt: NOW.toISOString(),
        sequence: 11,
        vendorId: "vendor-1",
        vendorJobId: "vendor-job-1",
        carrierTrackingRef: "tracking-opaque-1",
        locationCode: "hub-1",
      },
      expected: {
        batchId: "B99",
        subjectType: "shipment",
        correlationId: "vendor-job-1",
        claims: {
          vendorId: "vendor-1",
          vendorJobId: "vendor-job-1",
          carrierTrackingRef: "tracking-opaque-1",
          locationCode: "hub-1",
        },
      },
    },
    {
      routeId: "b102-scorecard-fact" as const,
      nonce: "supply-scorecard-nonce-1",
      payload: {
        version: "ltm.supply-event.v1",
        routeId: "b102-scorecard-fact",
        provider: "vendor:vendor-1",
        eventId: "scorecard-event-1",
        subjectId: "vendor-1",
        eventType: "scorecard.shipment",
        providerOccurredAt: NOW.toISOString(),
        sequence: 12,
        projectedFactId: "shipment-1",
      },
      expected: {
        batchId: "B102",
        subjectType: "vendor",
        correlationId: "shipment-1",
        claims: { projectedFactId: "shipment-1" },
      },
    },
  ];
  for (const entry of cases) {
    const handler = handlers.get(supplyEventCallbackPath(entry.routeId));
    assert.ok(handler);
    const rawBody = Buffer.from(canonicalJson(entry.payload));
    const result = await handler.process({
      rawBody,
      headers: signedHeaders(rawBody, entry.nonce),
      requestId: `request-${entry.routeId}`,
    });
    assert.equal(result.disposition, "attested");
    if (result.disposition !== "attested") assert.fail("expected attested supply event");
    assert.equal(result.businessEvent.batchId, entry.expected.batchId);
    assert.equal(result.businessEvent.subjectType, entry.expected.subjectType);
    assert.equal(result.businessEvent.correlationId, entry.expected.correlationId);
    assert.deepEqual(result.businessEvent.canonicalClaims, entry.expected.claims);
  }

  const scorecardHandler = handlers.get(supplyEventCallbackPath("b102-scorecard-fact"));
  assert.ok(scorecardHandler);
  const assertedMetric = Buffer.from(canonicalJson({ ...cases[1]?.payload, score: 100 }));
  await assert.rejects(scorecardHandler.process({
    rawBody: assertedMetric,
    headers: signedHeaders(assertedMetric, "supply-scorecard-nonce-asserted-score"),
    requestId: "request-scorecard-asserted-score",
  }), (error: unknown) => error instanceof ProductionIntegrationError && error.code === "PROVIDER_RESPONSE_INVALID");
});
