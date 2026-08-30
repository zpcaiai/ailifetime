import assert from "node:assert/strict";
import test from "node:test";
import {
  CatalogPricingService,
  hmac,
  InMemoryCommerceFinanceRepository,
  OrderDeliveryService,
  PaymentLedgerService,
  PhysicalFulfillmentService,
  sha256,
  stableJson,
  SubscriptionCreditGiftService,
  SupportRemedyService,
  type PaymentAdapter,
  type CommerceFinanceRepository,
  type PrintVendorAdapter,
  type ProductKind,
} from "./index.js";

const NOW = "2026-08-28T00:00:00.000Z";
const now = () => new Date(NOW);
const secret = "synthetic-secret-at-least-thirty-two-bytes";
const entitlement = { ageNodes: 8, participants: 2, resolution: "4k", redoCount: 2, retentionDays: 30, exportAllowed: true, printAllowed: true, supportTier: "priority" as const };

function pricedCatalog(): { catalog: CatalogPricingService; quote: ReturnType<CatalogPricingService["quote"]> } {
  const catalog = new CatalogPricingService(now);
  catalog.publishSku({ sku: "ARTWORK_1", version: 1, tenantId: "tenant-1", kind: "one_time_artwork", title: "Illustrative artwork", activeFrom: NOW, entitlement });
  catalog.publishPrice({ id: "price-1", tenantId: "tenant-1", sku: "ARTWORK_1", skuVersion: 1, version: 1, region: "CN", currency: "CNY", channel: "web", unitAmountMinor: 10_000, estimatedCostMinor: 2_000, taxBasisPoints: 600, activeFrom: NOW });
  const quote = catalog.quote({ tenantId: "tenant-1", sku: "ARTWORK_1", skuVersion: 1, priceVersion: 1, region: "CN", currency: "CNY", channel: "web", promotionIds: [], ttlSeconds: 600 });
  return { catalog, quote };
}

test("B25 catalog supports every commercial product and immutable dimensional quotes", () => {
  const kinds: ProductKind[] = ["one_time_artwork", "hd_upgrade", "video", "family_pack", "subscription", "credits", "gift_code", "print", "partner_bulk"];
  const catalog = new CatalogPricingService(now);
  kinds.forEach((kind, index) => catalog.publishSku({ sku: `SKU_${index}`, version: 1, tenantId: "tenant-1", kind, title: kind, activeFrom: NOW, entitlement }));
  catalog.publishPrice({ id: "partner-price", tenantId: "tenant-1", sku: "SKU_0", skuVersion: 1, version: 1, region: "CN", currency: "CNY", channel: "studio", partnerAgreementId: "agreement-1", unitAmountMinor: 1_000, estimatedCostMinor: 200, taxBasisPoints: 600, activeFrom: NOW });
  const quote = catalog.quote({ tenantId: "tenant-1", sku: "SKU_0", skuVersion: 1, priceVersion: 1, region: "CN", currency: "CNY", channel: "studio", partnerAgreementId: "agreement-1", promotionIds: [], ttlSeconds: 600 });
  assert.equal(quote.totalMinor, 1_060);
  assert.deepEqual(quote.entitlement, entitlement);
  assert.match(quote.snapshotSha256, /^[a-f0-9]{64}$/u);
  assert.throws(() => catalog.quote({ tenantId: "tenant-2", sku: "SKU_0", skuVersion: 1, priceVersion: 1, region: "CN", currency: "CNY", channel: "studio", partnerAgreementId: "agreement-1", promotionIds: [], ttlSeconds: 600 }), /SKU/);
});

test("B25 promotion stacking fails closed and price changes require independent approval without mutating quotes", () => {
  const { catalog, quote } = pricedCatalog();
  for (const [id, kind] of [["promo-1", "coupon"], ["promo-2", "referral"]] as const) catalog.publishPromotion({ id, tenantId: "tenant-1", kind, discountMinor: 500, stackingGroup: "acquisition", combinableWith: ["coupon", "referral"], startsAt: NOW, endsAt: "2026-09-28T00:00:00.000Z", maximumUses: 10, uses: 0 });
  assert.throws(() => catalog.quote({ tenantId: "tenant-1", sku: "ARTWORK_1", skuVersion: 1, priceVersion: 1, region: "CN", currency: "CNY", channel: "web", promotionIds: ["promo-1", "promo-2"], ttlSeconds: 600 }), /stacking group/);
  const change = catalog.proposePrice({ proposal: { id: "price-2", tenantId: "tenant-1", sku: "ARTWORK_1", skuVersion: 1, version: 2, region: "CN", currency: "CNY", channel: "web", unitAmountMinor: 12_000, estimatedCostMinor: 2_100, taxBasisPoints: 600, activeFrom: NOW }, proposedBy: "pricing-operator", reason: "cost revision", ticketId: "PRICE-1" });
  assert.equal(change.affectedOpenQuotes, 1);
  assert.throws(() => catalog.approvePrice(change.id, "pricing-operator"), /independent/);
  catalog.approvePrice(change.id, "finance-approver"); catalog.approvePrice(change.id, "commercial-approver"); catalog.applyPrice(change.id, "release-operator");
  assert.equal(catalog.quoteSnapshot(quote.id).totalMinor, quote.totalMinor);
  assert.equal(catalog.audit().length, 1);
});

function paymentAdapter(): PaymentAdapter & { refunds: number } {
  return { refunds: 0, createTokenizedIntent: async () => ({ providerIntentId: "provider-intent-1" }), async refund(input) { this.refunds += 1; return { providerRefundId: `refund-${this.refunds}`, receiptSha256: sha256(stableJson(input)) }; } };
}

test("B26 checkout, tokenized payment, signed/ordered webhooks, balanced ledger, and reversal effects are executable", async () => {
  const adapter = paymentAdapter(); const repository = new InMemoryCommerceFinanceRepository(); const service = new PaymentLedgerService(adapter, secret, repository, now);
  assert.equal(service.checkout({ quoteId: "q", productSummary: "Artwork", participantAuthorizationSummary: "two participants authorized", deliveryScope: "digital", estimatedWait: "2 minutes", illustrativeAiDisclosure: "Illustrative AI simulation, not prediction", refundPolicyVersion: "v1", taxMinor: 600, totalMinor: 10_600, currency: "CNY" }).totalMinor, 10_600);
  const intent = await service.createIntent({ tenantId: "tenant-1", quoteId: "q", providerPaymentToken: "tok_synthetic_123", amountMinor: 10_600, currency: "CNY", idempotencyKey: "pay-idem-1" });
  assert.throws(() => service.browserReturn(), /not authoritative/);
  const body = stableJson({ tenantId: "tenant-1", eventId: "event-1", providerIntentId: "provider-intent-1", sequence: 1, type: "paid", occurredAt: NOW, amountMinor: 10_600 });
  const paid = await service.processWebhook({ tenantId: "tenant-1", eventId: "event-1", providerIntentId: "provider-intent-1", sequence: 1, type: "paid", occurredAt: NOW, amountMinor: 10_600, rawBody: body, signature: hmac(secret, body) }, { taxMinor: 600, channelShareMinor: 1_000 });
  assert.equal(paid.state, "paid");
  const journal = (await service.journals("tenant-1"))[0]; assert.equal(journal?.lines.reduce((sum, line) => sum + line.debitMinor, 0), journal?.lines.reduce((sum, line) => sum + line.creditMinor, 0));
  await assert.rejects(() => service.processWebhook({ tenantId: "tenant-1", eventId: "event-forged", providerIntentId: "provider-intent-1", sequence: 2, type: "chargeback", occurredAt: NOW, amountMinor: 10_600, rawBody: body, signature: hmac(secret, body) }, { taxMinor: 0, channelShareMinor: 0 }), /body binding/);
  const refundRequest = { tenantId: "tenant-1", paymentId: intent.id, amountMinor: 5_000, reason: "partial delivery failure", idempotencyKey: "refund-idem-1" };
  assert.equal((await service.refund(refundRequest)).state, "partially_refunded");
  assert.equal((await service.refund(refundRequest)).refundedMinor, 5_000);
  assert.equal(adapter.refunds, 1);
  assert.deepEqual(new Set((await service.effects("tenant-1")).map((item) => item.type)), new Set(["revoke_entitlement", "adjust_partner_settlement", "notify_customer"]));
});

test("B26 paid-order recovery rebuilds, refunds, or opens a manual case", async () => {
  const repository = new InMemoryCommerceFinanceRepository(); const service = new PaymentLedgerService(paymentAdapter(), secret, repository, now); const intent = await service.createIntent({ tenantId: "tenant-1", quoteId: "q", providerPaymentToken: "tok_synthetic_456", amountMinor: 100, currency: "CNY", idempotencyKey: "pay-idem-2" }); const body = stableJson({ tenantId: "tenant-1", eventId: "event-2", providerIntentId: "provider-intent-1", sequence: 1, type: "paid", occurredAt: NOW, amountMinor: 100 }); await service.processWebhook({ tenantId: "tenant-1", eventId: "event-2", providerIntentId: "provider-intent-1", sequence: 1, type: "paid", occurredAt: NOW, amountMinor: 100, rawBody: body, signature: hmac(secret, body) }, { taxMinor: 0, channelShareMinor: 0 }); await service.recoverPaidOrder({ tenantId: "tenant-1", paymentId: intent.id, orderState: "missing", recovery: "rebuild", reason: "outbox lost" }); await service.recoverPaidOrder({ tenantId: "tenant-1", paymentId: intent.id, orderState: "failed", recovery: "manual", reason: "ambiguous state" }); assert.deepEqual((await service.effects("tenant-1")).map((item) => item.type), ["rebuild_order", "manual_case"]);
});

test("commerce finance transaction rolls back failures, serializes duplicate webhooks, and survives service restart", async () => {
  const repository = new InMemoryCommerceFinanceRepository(); const adapter = paymentAdapter(); const service = new PaymentLedgerService(adapter, secret, repository, now);
  const intent = await service.createIntent({ tenantId: "tenant-1", quoteId: "q", providerPaymentToken: "tok_restart_123", amountMinor: 1_000, currency: "CNY", idempotencyKey: "restart-pay-1" });
  const body = stableJson({ tenantId: "tenant-1", eventId: "atomic-event", providerIntentId: "provider-intent-1", sequence: 1, type: "paid", occurredAt: NOW, amountMinor: 1_000 });
  const faulting: CommerceFinanceRepository = {
    read: (tenantId, work) => repository.read(tenantId, work),
    transaction: (tenantId, work) => repository.transaction(tenantId, async (state) => { await work(state); throw new Error("injected commit failure"); }),
  };
  const failingService = new PaymentLedgerService(adapter, secret, faulting, now);
  await assert.rejects(() => failingService.processWebhook({ tenantId: "tenant-1", eventId: "atomic-event", providerIntentId: "provider-intent-1", sequence: 1, type: "paid", occurredAt: NOW, amountMinor: 1_000, rawBody: body, signature: hmac(secret, body) }, { taxMinor: 100, channelShareMinor: 100 }), /injected/);
  assert.equal((await service.payment("tenant-1", intent.id)).state, "pending"); assert.equal((await service.journals("tenant-1")).length, 0);
  const restarted = new PaymentLedgerService(adapter, secret, repository, now); const webhook = { tenantId: "tenant-1", eventId: "atomic-event", providerIntentId: "provider-intent-1", sequence: 1, type: "paid" as const, occurredAt: NOW, amountMinor: 1_000, rawBody: body, signature: hmac(secret, body) };
  const results = await Promise.all([restarted.processWebhook(webhook, { taxMinor: 100, channelShareMinor: 100 }), restarted.processWebhook(webhook, { taxMinor: 100, channelShareMinor: 100 })]);
  assert.deepEqual(results.map((item) => item.state), ["paid", "paid"]); assert.equal((await restarted.journals("tenant-1")).length, 1); assert.equal((await restarted.outbox("tenant-1")).filter((item) => item.type === "payment.paid").length, 1);
});

test("B27 subscription lifecycle, immutable credits, family limits, gift terms and anti-enumeration are enforced", () => {
  const service = new SubscriptionCreditGiftService(secret, now); service.publishPlan({ id: "annual", version: 1, periodDays: 365, trialDays: 7, graceDays: 3, autoRenew: true, entitlementEffective: "immediate", cancellationEffective: "period_end" }); service.publishPlan({ id: "premium", version: 1, periodDays: 365, trialDays: 0, graceDays: 3, autoRenew: true, entitlementEffective: "next_period", cancellationEffective: "period_end" }); service.publishPlan({ id: "basic", version: 1, periodDays: 30, trialDays: 0, graceDays: 3, autoRenew: true, entitlementEffective: "next_period", cancellationEffective: "period_end" }); const subscription = service.subscribe({ id: "sub-1", accountId: "holder", planId: "annual", planVersion: 1, startsAt: NOW }); assert.equal(subscription.state, "trial"); assert.equal(service.transition("sub-1", "trial_convert").state, "active"); assert.equal(service.changePlan("sub-1", "premium", 1, "next_period").pendingPlanId, "premium:1"); assert.throws(() => service.changePlan("sub-1", "basic", 1, "next_period"), /already pending/); assert.equal(service.transition("sub-1", "renew").planId, "premium"); service.renewalNotice("sub-1"); service.notifyPriceChange("sub-1"); assert.equal(service.transition("sub-1", "cancel").state, "cancel_at_period_end"); assert.deepEqual(new Set(service.notifications().map((item) => item.type)), new Set(["renewal", "price_change", "cancelled"]));
  const grant = service.credit({ id: "credit-1", accountId: "holder", kind: "grant", amount: 10, sourceId: "purchase" }); assert.equal(service.credit({ id: "credit-1", accountId: "holder", kind: "grant", amount: 10, sourceId: "purchase" }).entrySha256, grant.entrySha256); service.credit({ id: "credit-2", accountId: "holder", kind: "reserve", amount: 10, reservationId: "reservation-1", sourceId: "generation" }); service.credit({ id: "credit-3", accountId: "holder", kind: "consume", amount: 3, reservationId: "reservation-1", sourceId: "generation" }); assert.equal(service.balance("holder"), 0); service.credit({ id: "credit-4", accountId: "holder", kind: "release", amount: 7, reservationId: "reservation-1", sourceId: "generation" }); assert.equal(service.balance("holder"), 7); assert.throws(() => service.credit({ id: "credit-5", accountId: "holder", kind: "consume", amount: 1, reservationId: "missing", sourceId: "generation" }), /matching reservation/); assert.throws(() => service.credit({ id: "credit-1", accountId: "other", kind: "grant", amount: 10, sourceId: "purchase" }), /reused/);
  service.setFamilyLimit({ holderAccountId: "holder", memberAccountId: "member", limit: 2, holderAuthorized: true }); assert.deepEqual(service.familyView("holder", "member").paymentDetails, []);
  const gift = service.issueGift({ tenantId: "tenant-1", type: "denomination", amountMinor: 1_000, regions: ["CN"], expiresAt: "2026-09-28T00:00:00.000Z", maximumRedemptions: 1, recipientAccountId: "member", termsVersion: "terms-v1", code: "SYNTHETIC-GIFT-CODE" }); assert.equal(service.giftTerms({ code: "SYNTHETIC-GIFT-CODE", tenantId: "tenant-1" }).termsVersion, "terms-v1"); const redemption = { code: "SYNTHETIC-GIFT-CODE", tenantId: "tenant-1", accountId: "member", region: "CN", acceptedTermsVersion: "terms-v1", requesterFingerprint: "device-1", idempotencyKey: "gift-idem-1" }; assert.equal(service.redeemGift(redemption).id, gift.id); assert.equal(service.redeemGift(redemption).id, gift.id); assert.throws(() => service.redeemGift({ ...redemption, idempotencyKey: "gift-idem-2" }), /cannot be redeemed/);
});

test("B28 order snapshots, legal states, integrity-bound download and item-level remedies are enforced", async () => {
  const { quote } = pricedCatalog(); const repository = new InMemoryCommerceFinanceRepository(); const payments = new PaymentLedgerService(paymentAdapter(), secret, repository, now); const service = new OrderDeliveryService(secret, repository, now); const order = await service.create({ id: "order-1", tenantId: "tenant-1", quote, participantConsentEvidenceSha256: sha256("consent"), items: [{ id: "item-1", sku: quote.sku, skuVersion: quote.skuVersion, priceVersion: quote.priceVersion, entitlement: quote.entitlement, templateVersion: "template-v1", participantIds: ["participant-1"], deliveryPromise: "within 2 minutes", generationJobIds: ["job-1"], shareIds: [] }] }); assert.equal(order.state, "awaiting-payment"); const intent = await payments.createIntent({ tenantId: "tenant-1", quoteId: quote.id, providerPaymentToken: "tok_synthetic_789", amountMinor: quote.totalMinor, currency: quote.currency, idempotencyKey: "order-pay-1" }); await service.linkPayment("tenant-1", order.id, intent.id); await assert.rejects(() => service.confirmPaid("tenant-1", order.id), /authoritative/); const body = stableJson({ tenantId: "tenant-1", eventId: "event-order", providerIntentId: "provider-intent-1", sequence: 1, type: "paid", occurredAt: NOW, amountMinor: quote.totalMinor }); await payments.processWebhook({ tenantId: "tenant-1", eventId: "event-order", providerIntentId: "provider-intent-1", sequence: 1, type: "paid", occurredAt: NOW, amountMinor: quote.totalMinor, rawBody: body, signature: hmac(secret, body) }, { taxMinor: quote.taxMinor, channelShareMinor: 0 }); assert.equal((await service.confirmPaid("tenant-1", order.id)).state, "paid"); await service.transition("tenant-1", order.id, "processing"); await assert.rejects(() => service.transition("tenant-1", order.id, "awaiting-consent"), /illegal/); await service.registerAsset("tenant-1", { id: "asset-1", orderId: order.id, itemId: "item-1", artifactSha256: sha256("bytes"), objectReference: "object_ref_asset_1", maximumDownloads: 1, expiresAt: "2026-08-28T01:00:00.000Z" }); const token = await service.issueDownload("tenant-1", "asset-1", 300); await assert.rejects(() => service.download(token, async () => ({ succeeded: false })), /not charged/); assert.equal((await service.download(token, async () => ({ succeeded: true, bytesSha256: sha256("bytes") }))).artifactSha256, sha256("bytes")); await assert.rejects(() => service.download(token, async () => ({ succeeded: true, bytesSha256: sha256("bytes") })), /limit/); await service.transition("tenant-1", order.id, "partial"); await service.remedy("tenant-1", { orderId: order.id, itemId: "item-1", type: "redo", reason: "one age node failed" }); assert.match((await service.receipt("tenant-1", order.id)).aiLabel, /illustrative/);
});

test("B29 print preflight, soft-proof lock, minimized vendor request, signed lifecycle and quality attribution are executable", async () => {
  const adapter: PrintVendorAdapter = { submit: async (input) => { assert.match(input.fileReference, /^derived_print_ref_/u); assert.match(input.addressReference, /^address_ref_/u); return { vendorOrderId: "vendor-order-1", receiptSha256: sha256(stableJson(input)) }; }, cancel: async () => ({ cancelled: true, receiptSha256: sha256("cancel") }), requestDeletion: async () => ({ deleted: true, receiptSha256: sha256("delete") }) };
  const service = new PhysicalFulfillmentService(new Map([["vendor-a", adapter]]), new Map([["vendor-a", secret]]), now); service.publishSpecification({ id: "photo-book-a4", version: 1, product: "photo_book", widthMm: 210, heightMm: 297, bleedMm: 3, colorProfile: "CMYK-FOGRA39", minimumDpi: 300, embeddedFontsRequired: true, qrMinimumMm: 10, packaging: "anonymous recyclable rigid mailer" }); const preflight = service.preflight("photo-book-a4", 1, { fileSha256: sha256("print"), widthMm: 210, heightMm: 297, bleedMm: 3, colorProfile: "CMYK-FOGRA39", dpi: 300, fontsEmbedded: true, qrSizeMm: 10 }); assert.equal(preflight.passed, true); service.lockProof({ id: "fulfillment-1", tenantId: "tenant-1", orderId: "order-1", specificationId: "photo-book-a4", specificationVersion: 1, preflight, userConfirmedProofSha256: preflight.proofSha256, finalFileSha256: sha256("print"), addressReference: "address_ref_123", quantity: 1, vendorId: "vendor-a", slaDueAt: "2026-08-30T00:00:00.000Z", retentionDays: 7 }); assert.equal((await service.submit("fulfillment-1", "derived_print_ref_123")).state, "submitted"); const body = stableJson({ vendorId: "vendor-a", eventId: "print-event-1", vendorOrderId: "vendor-order-1", type: "production", occurredAt: NOW }); assert.equal(service.webhook({ vendorId: "vendor-a", eventId: "print-event-1", rawBody: body, signature: hmac(secret, body), vendorOrderId: "vendor-order-1", type: "production", occurredAt: NOW }).state, "production"); assert.equal(service.qualityCase({ fulfillmentId: "fulfillment-1", evidenceArtifactSha256: sha256("damage-photo"), remedy: "reprint", vendorResponsibilityBasisPoints: 8_000, costAdjustmentMinor: 500, settlementAdjustmentMinor: 500 }).remedy, "reprint");
});

test("B30 redacted timeline, bounded media unlock, remedies, dispute retention, SLA and feedback are enforced", () => {
  let clock = new Date(NOW); const service = new SupportRemedyService(() => new Date(clock)); service.recordEvent({ id: "timeline-1", tenantId: "tenant-1", customerId: "customer-1", kind: "quality", occurredAt: NOW, summary: "derived output contains artifact", sensitiveMediaReference: "private-media", participantReference: "participant-private", sourceArtifactSha256: sha256("event") }); assert.equal(service.timeline({ tenantId: "tenant-1", customerId: "customer-1", actorRoles: ["support_timeline_read"] })[0]?.media, "blurred"); const supportCase = service.openCase({ id: "case-1", tenantId: "tenant-1", customerId: "customer-1", issueType: "dispute", severity: "critical" }); assert.ok(service.remedies(supportCase.id, { paid: true, printable: false, consentCurrent: true, assetExists: true }).includes("refund")); const token = service.unlockMedia({ caseId: supportCase.id, actorId: "agent-1", actorRoles: ["sensitive_media_temporary_read"], reason: "inspect reported defect", ticketId: "SUP-1", ttlSeconds: 60 }); assert.match(service.mediaReference({ token, caseId: supportCase.id, actorId: "agent-1" }).watermark, /agent-1/); service.retainDisputeEvidence({ caseId: supportCase.id, artifactSha256: sha256("evidence"), retainUntil: "2026-08-29T00:00:00.000Z" }); assert.throws(() => service.purgeDisputeEvidence(supportCase.id), /still under retention/); clock = new Date("2026-08-30T00:00:00.000Z"); service.purgeDisputeEvidence(supportCase.id); service.resolve({ caseId: supportCase.id, actorId: "agent-1", reason: "provider accepted responsibility", ticketId: "SUP-1", rootCause: "vendor color drift", destinations: ["quality", "provider"] }); assert.deepEqual(service.feedback()[0]?.destinations, ["quality", "provider"]); assert.equal(service.audit().length, 2);
});
