import { CommerceError, digest, hmac, safeEqual, sha256, stableJson, strictUtc } from "./common.js";
import type { EntitlementSnapshot, Quote } from "./catalog-pricing.js";
import type { CommerceFinanceRepository, CommerceFinanceState } from "./repository.js";

export type OrderState = "awaiting-consent" | "awaiting-payment" | "paid" | "processing" | "partial" | "fulfilled" | "cancelled" | "refunded" | "disputed";
export interface OrderItemSnapshot { readonly id: string; readonly sku: string; readonly skuVersion: number; readonly priceVersion: number; readonly entitlement: EntitlementSnapshot; readonly templateVersion: string; readonly participantIds: readonly string[]; readonly deliveryPromise: string; readonly quoteSnapshotSha256: string; readonly generationJobIds: readonly string[]; readonly shareIds: readonly string[]; }
export interface Order { readonly id: string; readonly tenantId: string; readonly quoteId: string; readonly quoteTotalMinor: number; readonly currency: string; readonly consentEvidenceSha256?: string; readonly paymentId?: string; readonly state: OrderState; readonly items: readonly OrderItemSnapshot[]; readonly createdAt: string; readonly updatedAt: string; }
export interface DeliveryAsset { readonly id: string; readonly orderId: string; readonly itemId: string; readonly artifactSha256: string; readonly objectReference: string; readonly maximumDownloads: number; readonly expiresAt: string; readonly downloadCount: number; }
export interface OrderRemedy { readonly orderId: string; readonly itemId: string; readonly type: "deliver" | "redo" | "credit" | "refund"; readonly amount?: number; readonly reason: string; }

export class OrderDeliveryService {
  constructor(readonly signingSecret: string, readonly repository: CommerceFinanceRepository, readonly now: () => Date = () => new Date()) { if (signingSecret.length < 32) throw new CommerceError("VALIDATION", "delivery signing secret is too short"); }

  async create(input: { readonly id: string; readonly tenantId: string; readonly quote: Quote; readonly items: readonly Omit<OrderItemSnapshot, "quoteSnapshotSha256">[]; readonly participantConsentEvidenceSha256?: string }): Promise<Order> {
    if (input.items.length === 0 || input.quote.tenantId !== input.tenantId || (input.participantConsentEvidenceSha256 !== undefined && !digest(input.participantConsentEvidenceSha256)) || input.items.some((item) => item.sku !== input.quote.sku || item.skuVersion !== input.quote.skuVersion || item.priceVersion !== input.quote.priceVersion || stableJson(item.entitlement) !== stableJson(input.quote.entitlement))) throw new CommerceError("VALIDATION", "order item, quote, entitlement, or consent evidence is invalid");
    return this.repository.transaction(input.tenantId, (state) => {
      if (state.orders[input.id] !== undefined) throw new CommerceError("CONFLICT", "order identity was reused");
      const createdAt = this.now().toISOString();
      const order: Order = Object.freeze({ id: input.id, tenantId: input.tenantId, quoteId: input.quote.id, quoteTotalMinor: input.quote.totalMinor, currency: input.quote.currency, ...(input.participantConsentEvidenceSha256 === undefined ? {} : { consentEvidenceSha256: input.participantConsentEvidenceSha256 }), state: input.participantConsentEvidenceSha256 === undefined ? "awaiting-consent" : "awaiting-payment", items: Object.freeze(input.items.map((item) => Object.freeze({ ...structuredClone(item), quoteSnapshotSha256: input.quote.snapshotSha256 }))), createdAt, updatedAt: createdAt });
      state.orders[order.id] = order; appendOrderOutbox(state, order, "order.created", { state: order.state }); return order;
    });
  }

  async recordConsentComplete(tenantId: string, id: string, consentEvidenceSha256: string): Promise<Order> {
    if (!digest(consentEvidenceSha256)) throw new CommerceError("VALIDATION", "consent evidence digest is invalid");
    return this.repository.transaction(tenantId, (state) => { const current = requiredOrder(state, id); if (current.state !== "awaiting-consent") throw new CommerceError("CONFLICT", "order is not waiting for consent"); const next: Order = Object.freeze({ ...current, consentEvidenceSha256, state: "awaiting-payment", updatedAt: this.now().toISOString() }); state.orders[id] = next; appendOrderOutbox(state, next, "order.consent_completed", { consentEvidenceSha256 }); return next; });
  }

  async linkPayment(tenantId: string, id: string, paymentId: string): Promise<Order> {
    return this.repository.transaction(tenantId, (state) => {
      const current = requiredOrder(state, id); const payment = state.payments[paymentId];
      if (payment === undefined || payment.tenantId !== tenantId || payment.quoteId !== current.quoteId || payment.amountMinor !== current.quoteTotalMinor || payment.currency !== current.currency) throw new CommerceError("CONFLICT", "payment is not the authoritative projection for this order quote");
      if (current.paymentId !== undefined && current.paymentId !== paymentId) throw new CommerceError("CONFLICT", "order is already linked to another payment");
      const next: Order = Object.freeze({ ...current, paymentId, updatedAt: this.now().toISOString() }); state.orders[id] = next; appendOrderOutbox(state, next, "order.payment_linked", { paymentId }); return next;
    });
  }

  async confirmPaid(tenantId: string, id: string): Promise<Order> {
    return this.repository.transaction(tenantId, (state) => {
      const current = requiredOrder(state, id); const payment = current.paymentId === undefined ? undefined : state.payments[current.paymentId];
      if (current.state !== "awaiting-payment" || payment === undefined || payment.state !== "paid" || payment.tenantId !== tenantId || payment.quoteId !== current.quoteId || payment.amountMinor !== current.quoteTotalMinor || payment.currency !== current.currency) throw new CommerceError("CONFLICT", "order cannot be paid without matching authoritative payment state");
      const next: Order = Object.freeze({ ...current, state: "paid", updatedAt: this.now().toISOString() }); state.orders[id] = next; appendOrderOutbox(state, next, "order.paid", { paymentId: payment.id }); return next;
    });
  }

  async transition(tenantId: string, id: string, target: Exclude<OrderState, "paid">): Promise<Order> {
    return this.repository.transaction(tenantId, (state) => { const current = requiredOrder(state, id); const allowed: Record<OrderState, readonly OrderState[]> = { "awaiting-consent": ["awaiting-payment", "cancelled"], "awaiting-payment": ["cancelled"], paid: ["processing", "cancelled", "refunded", "disputed"], processing: ["partial", "fulfilled", "cancelled", "refunded", "disputed"], partial: ["processing", "fulfilled", "refunded", "disputed"], fulfilled: ["refunded", "disputed"], cancelled: ["refunded"], refunded: [], disputed: ["refunded", "fulfilled"] }; if (!allowed[current.state].includes(target)) throw new CommerceError("CONFLICT", `illegal order transition ${current.state} -> ${target}`); const next: Order = Object.freeze({ ...current, state: target, updatedAt: this.now().toISOString() }); state.orders[id] = next; appendOrderOutbox(state, next, `order.${target}`, {}); return next; });
  }

  async registerAsset(tenantId: string, input: Omit<DeliveryAsset, "downloadCount">): Promise<DeliveryAsset> {
    return this.repository.transaction(tenantId, (state) => { const order = requiredOrder(state, input.orderId); if (state.deliveryAssets[input.id] !== undefined || !digest(input.artifactSha256) || input.maximumDownloads < 1 || !strictUtc(input.expiresAt) || input.expiresAt <= this.now().toISOString() || !order.items.some((item) => item.id === input.itemId)) throw new CommerceError("VALIDATION", "delivery asset is invalid"); const value: DeliveryAsset = Object.freeze({ ...structuredClone(input), downloadCount: 0 }); state.deliveryAssets[input.id] = value; return value; });
  }
  async issueDownload(tenantId: string, assetId: string, ttlSeconds: number): Promise<string> { return this.repository.read(tenantId, (state) => { const asset = requiredAsset(state, assetId); if (asset.expiresAt <= this.now().toISOString() || asset.downloadCount >= asset.maximumDownloads || ttlSeconds < 10 || ttlSeconds > 900) throw new CommerceError("AUTHORIZATION", "delivery asset is expired or exhausted"); const expires = Math.min(Date.parse(asset.expiresAt), this.now().getTime() + ttlSeconds * 1_000); const payload = Buffer.from(stableJson({ tenantId, assetId, expires, expectedSha256: asset.artifactSha256 })).toString("base64url"); return `${payload}.${hmac(this.signingSecret, payload)}`; }); }
  async download(token: string, fetchObject: (reference: string) => Promise<{ succeeded: boolean; bytesSha256?: string }>): Promise<{ objectReference: string; artifactSha256: string }> {
    const [payload, signature, extra] = token.split("."); if (payload === undefined || signature === undefined || extra !== undefined || !safeEqual(hmac(this.signingSecret, payload), signature)) throw new CommerceError("AUTHORIZATION", "download token signature is invalid");
    let decoded: { tenantId: string; assetId: string; expires: number; expectedSha256: string }; try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as typeof decoded; } catch { throw new CommerceError("VALIDATION", "download token payload is invalid"); }
    if (decoded.expires < this.now().getTime()) throw new CommerceError("AUTHORIZATION", "download token expired");
    const asset = await this.repository.read(decoded.tenantId, (state) => requiredAsset(state, decoded.assetId)); if (decoded.expectedSha256 !== asset.artifactSha256 || asset.downloadCount >= asset.maximumDownloads) throw new CommerceError("CONFLICT", "delivery asset snapshot changed or download limit was reached");
    const result = await fetchObject(asset.objectReference); if (!result.succeeded || result.bytesSha256 !== asset.artifactSha256) throw new CommerceError("DEPENDENCY", "download failed integrity validation and was not charged");
    return this.repository.transaction(decoded.tenantId, (state) => { const current = requiredAsset(state, decoded.assetId); if (current.artifactSha256 !== decoded.expectedSha256 || current.downloadCount >= current.maximumDownloads) throw new CommerceError("CONFLICT", "delivery asset changed or download limit was reached"); state.deliveryAssets[current.id] = Object.freeze({ ...current, downloadCount: current.downloadCount + 1 }); return Object.freeze({ objectReference: current.objectReference, artifactSha256: current.artifactSha256 }); });
  }

  async remedy(tenantId: string, input: OrderRemedy): Promise<void> { await this.repository.transaction(tenantId, (state) => { const order = requiredOrder(state, input.orderId); if (!order.items.some((item) => item.id === input.itemId) || !["processing", "partial"].includes(order.state) || input.reason.trim() === "") throw new CommerceError("CONFLICT", "partial-delivery remedy is not applicable"); if (["credit", "refund"].includes(input.type) && (input.amount === undefined || input.amount < 1)) throw new CommerceError("VALIDATION", "monetary remedy requires a positive amount"); state.orderRemedies.push(Object.freeze(structuredClone(input))); }); }
  async receipt(tenantId: string, id: string): Promise<Readonly<{ orderId: string; state: OrderState; paymentId?: string; licenseScope: string; aiLabel: string; retentionAndDeletion: string; supportPath: string; itemSnapshotsSha256: string }>> { return this.repository.read(tenantId, (state) => { const order = requiredOrder(state, id); return Object.freeze({ orderId: id, state: order.state, ...(order.paymentId === undefined ? {} : { paymentId: order.paymentId }), licenseScope: "personal-use-unless-partner-contract-says-otherwise", aiLabel: "AI-created illustrative simulation", retentionAndDeletion: "See the order-bound retention policy; deletion is available from account privacy controls.", supportPath: `/support/orders/${id}`, itemSnapshotsSha256: sha256(stableJson(order.items)) }); }); }
  async remedies(tenantId: string): Promise<readonly OrderRemedy[]> { return this.repository.read(tenantId, (state) => Object.freeze(structuredClone(state.orderRemedies))); }
}

function requiredOrder(state: Readonly<CommerceFinanceState>, id: string): Order { const value = state.orders[id]; if (value === undefined) throw new CommerceError("NOT_FOUND", "order does not exist"); return value; }
function requiredAsset(state: Readonly<CommerceFinanceState>, id: string): DeliveryAsset { const value = state.deliveryAssets[id]; if (value === undefined) throw new CommerceError("NOT_FOUND", "delivery asset does not exist"); return value; }
function appendOrderOutbox(state: CommerceFinanceState, order: Order, type: string, payload: Readonly<Record<string, unknown>>): void { const id = sha256(`${order.tenantId}:${type}:${order.id}:${stableJson(payload)}`); if (!state.outbox.some((item) => item.id === id)) state.outbox.push(Object.freeze({ id, aggregateType: "order", aggregateId: order.id, type, occurredAt: order.updatedAt, payload: Object.freeze(structuredClone(payload)) })); }
