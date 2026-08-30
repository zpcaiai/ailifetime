import { CommerceError, assertMoney, sha256, stableJson, strictUtc } from "./common.js";

export type ProductKind = "one_time_artwork" | "hd_upgrade" | "video" | "family_pack" | "subscription" | "credits" | "gift_code" | "print" | "partner_bulk";
export interface EntitlementSnapshot { readonly ageNodes: number; readonly participants: number; readonly resolution: string; readonly redoCount: number; readonly retentionDays: number; readonly exportAllowed: boolean; readonly printAllowed: boolean; readonly supportTier: "standard" | "priority" | "managed"; }
export interface SkuVersion { readonly sku: string; readonly version: number; readonly tenantId: string; readonly kind: ProductKind; readonly title: string; readonly activeFrom: string; readonly activeUntil?: string; readonly entitlement: EntitlementSnapshot; }
export interface PriceVersion { readonly id: string; readonly tenantId: string; readonly sku: string; readonly skuVersion: number; readonly version: number; readonly region: string; readonly currency: string; readonly channel: string; readonly partnerAgreementId?: string; readonly unitAmountMinor: number; readonly estimatedCostMinor: number; readonly taxBasisPoints: number; readonly activeFrom: string; readonly activeUntil?: string; }
export interface Promotion { readonly id: string; readonly tenantId: string; readonly kind: "coupon" | "referral" | "partner_contract" | "bundle"; readonly codeHash?: string; readonly discountMinor: number; readonly stackingGroup: string; readonly combinableWith: readonly string[]; readonly startsAt: string; readonly endsAt: string; readonly maximumUses: number; readonly uses: number; }
export interface Quote { readonly id: string; readonly tenantId: string; readonly sku: string; readonly skuVersion: number; readonly priceVersion: number; readonly region: string; readonly currency: string; readonly channel: string; readonly partnerAgreementId?: string; readonly promotionIds: readonly string[]; readonly subtotalMinor: number; readonly discountMinor: number; readonly taxMinor: number; readonly totalMinor: number; readonly estimatedCostMinor: number; readonly entitlement: EntitlementSnapshot; readonly issuedAt: string; readonly expiresAt: string; readonly snapshotSha256: string; }
interface PriceChange { readonly id: string; readonly proposal: PriceVersion; readonly reason: string; readonly ticketId: string; readonly proposedBy: string; readonly approvals: readonly string[]; readonly affectedOpenQuotes: number; readonly createdAt: string; readonly state: "draft" | "approved" | "applied"; }

export class CatalogPricingService {
  readonly #skus = new Map<string, SkuVersion>();
  readonly #prices = new Map<string, PriceVersion>();
  readonly #promotions = new Map<string, Promotion>();
  readonly #quotes = new Map<string, Quote>();
  readonly #changes = new Map<string, PriceChange>();
  readonly #audit: Array<Readonly<{ action: string; actorId: string; reason: string; ticketId: string; beforeSha256?: string; afterSha256: string; occurredAt: string }>> = [];
  constructor(readonly now: () => Date = () => new Date()) {}

  publishSku(value: SkuVersion): void {
    if (!/^[A-Z0-9][A-Z0-9_-]+$/u.test(value.sku) || value.tenantId.trim() === "" || value.version < 1 || !strictUtc(value.activeFrom) || (value.activeUntil !== undefined && (!strictUtc(value.activeUntil) || value.activeUntil <= value.activeFrom))) throw new CommerceError("VALIDATION", "SKU version is invalid");
    for (const amount of [value.entitlement.ageNodes, value.entitlement.participants, value.entitlement.redoCount, value.entitlement.retentionDays]) if (!Number.isSafeInteger(amount) || amount < 0) throw new CommerceError("VALIDATION", "entitlement amount is invalid");
    const key = `${value.tenantId}:${value.sku}:${value.version}`;
    if (this.#skus.has(key)) throw new CommerceError("CONFLICT", "SKU version already exists");
    this.#skus.set(key, Object.freeze(structuredClone(value)));
  }

  publishPrice(value: PriceVersion): void {
    assertMoney(value.unitAmountMinor, "unit price"); assertMoney(value.estimatedCostMinor, "estimated cost");
    if (!/^[A-Z]{3}$/u.test(value.currency) || value.taxBasisPoints < 0 || value.taxBasisPoints > 10_000 || !Number.isSafeInteger(value.taxBasisPoints) || !strictUtc(value.activeFrom)) throw new CommerceError("VALIDATION", "price version is invalid");
    this.#requiredSku(value.tenantId, value.sku, value.skuVersion);
    const key = this.#priceKey(value);
    if (this.#prices.has(key)) throw new CommerceError("CONFLICT", "price version already exists");
    this.#prices.set(key, Object.freeze(structuredClone(value)));
  }

  publishPromotion(value: Promotion): void {
    assertMoney(value.discountMinor, "discount");
    if (value.maximumUses < 1 || value.uses < 0 || value.uses > value.maximumUses || !strictUtc(value.startsAt) || !strictUtc(value.endsAt) || value.endsAt <= value.startsAt) throw new CommerceError("VALIDATION", "promotion is invalid");
    if (this.#promotions.has(value.id)) throw new CommerceError("CONFLICT", "promotion already exists");
    this.#promotions.set(value.id, Object.freeze(structuredClone(value)));
  }

  quote(input: { readonly tenantId: string; readonly sku: string; readonly skuVersion: number; readonly priceVersion: number; readonly region: string; readonly currency: string; readonly channel: string; readonly partnerAgreementId?: string; readonly promotionIds: readonly string[]; readonly ttlSeconds: number }): Quote {
    const sku = this.#requiredSku(input.tenantId, input.sku, input.skuVersion);
    const price = [...this.#prices.values()].find((item) => item.tenantId === input.tenantId && item.sku === input.sku && item.skuVersion === input.skuVersion && item.version === input.priceVersion && item.region === input.region && item.currency === input.currency && item.channel === input.channel && item.partnerAgreementId === input.partnerAgreementId);
    if (price === undefined || !active(price, this.now())) throw new CommerceError("NOT_FOUND", "an active price matching the quote dimensions does not exist");
    if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 30 || input.ttlSeconds > 86_400) throw new CommerceError("VALIDATION", "quote TTL is invalid");
    const promotions = input.promotionIds.map((id) => {
      const value = this.#promotions.get(id);
      if (value === undefined || value.tenantId !== input.tenantId || !active(value, this.now()) || value.uses >= value.maximumUses) throw new CommerceError("AUTHORIZATION", "promotion is unavailable for this tenant or time");
      return value;
    });
    if (new Set(promotions.map((value) => value.stackingGroup)).size !== promotions.length) throw new CommerceError("VALIDATION", "promotions in the same stacking group cannot be combined");
    for (const left of promotions) for (const right of promotions) if (left.id !== right.id && (!left.combinableWith.includes(right.kind) || !right.combinableWith.includes(left.kind))) throw new CommerceError("VALIDATION", "promotion combination is not mutually allowed");
    const discountMinor = promotions.reduce((sum, item) => sum + item.discountMinor, 0);
    if (discountMinor > price.unitAmountMinor) throw new CommerceError("VALIDATION", "promotion combination would produce a negative price");
    const subtotalMinor = price.unitAmountMinor;
    const taxableMinor = subtotalMinor - discountMinor;
    const taxMinor = Math.round(taxableMinor * price.taxBasisPoints / 10_000);
    const issuedAt = this.now().toISOString();
    const unsigned = { tenantId: input.tenantId, sku: input.sku, skuVersion: input.skuVersion, priceVersion: input.priceVersion, region: input.region, currency: input.currency, channel: input.channel, ...(input.partnerAgreementId === undefined ? {} : { partnerAgreementId: input.partnerAgreementId }), promotionIds: [...input.promotionIds].sort(), subtotalMinor, discountMinor, taxMinor, totalMinor: taxableMinor + taxMinor, estimatedCostMinor: price.estimatedCostMinor, entitlement: sku.entitlement, issuedAt, expiresAt: new Date(this.now().getTime() + input.ttlSeconds * 1_000).toISOString() };
    const snapshotSha256 = sha256(stableJson(unsigned));
    const quote = Object.freeze({ id: sha256(`${input.tenantId}:${snapshotSha256}`), ...unsigned, snapshotSha256 });
    this.#quotes.set(quote.id, quote);
    for (const promotion of promotions) this.#promotions.set(promotion.id, Object.freeze({ ...promotion, uses: promotion.uses + 1 }));
    return quote;
  }

  quoteSnapshot(id: string): Quote { const value = this.#quotes.get(id); if (value === undefined) throw new CommerceError("NOT_FOUND", "quote does not exist"); return structuredClone(value); }

  proposePrice(input: { readonly proposal: PriceVersion; readonly proposedBy: string; readonly reason: string; readonly ticketId: string }): PriceChange {
    if (input.proposedBy.trim() === "" || input.reason.trim() === "" || input.ticketId.trim() === "") throw new CommerceError("VALIDATION", "price change requires actor, reason, and ticket");
    const id = sha256(stableJson(input));
    const change: PriceChange = Object.freeze({ id, proposal: structuredClone(input.proposal), reason: input.reason, ticketId: input.ticketId, proposedBy: input.proposedBy, approvals: [], affectedOpenQuotes: [...this.#quotes.values()].filter((quote) => quote.tenantId === input.proposal.tenantId && quote.sku === input.proposal.sku && quote.expiresAt > this.now().toISOString()).length, createdAt: this.now().toISOString(), state: "draft" });
    this.#changes.set(id, change);
    return change;
  }

  approvePrice(changeId: string, actorId: string): PriceChange {
    const current = this.#changes.get(changeId); if (current === undefined) throw new CommerceError("NOT_FOUND", "price change does not exist");
    if (actorId === current.proposedBy || current.approvals.includes(actorId)) throw new CommerceError("AUTHORIZATION", "price change approval must be independent and unique");
    const approvals = [...current.approvals, actorId];
    const next = Object.freeze({ ...current, approvals, state: approvals.length >= 2 ? "approved" as const : "draft" as const }); this.#changes.set(changeId, next); return next;
  }

  applyPrice(changeId: string, actorId: string): PriceChange {
    const current = this.#changes.get(changeId); if (current === undefined || current.state !== "approved") throw new CommerceError("AUTHORIZATION", "price change lacks two-person approval");
    this.publishPrice(current.proposal);
    const next = Object.freeze({ ...current, state: "applied" as const }); this.#changes.set(changeId, next);
    this.#audit.push(Object.freeze({ action: "price.apply", actorId, reason: current.reason, ticketId: current.ticketId, afterSha256: sha256(stableJson(current.proposal)), occurredAt: this.now().toISOString() }));
    return next;
  }
  audit(): readonly Readonly<{ action: string; actorId: string; reason: string; ticketId: string; beforeSha256?: string; afterSha256: string; occurredAt: string }>[] { return Object.freeze(structuredClone(this.#audit)); }

  #requiredSku(tenantId: string, sku: string, version: number): SkuVersion {
    const value = this.#skus.get(`${tenantId}:${sku}:${version}`);
    if (value === undefined || !active(value, this.now())) throw new CommerceError("NOT_FOUND", "active SKU version does not exist"); return value;
  }
  #priceKey(value: PriceVersion): string { return [value.tenantId, value.id, value.sku, value.skuVersion, value.version, value.region, value.currency, value.channel, value.partnerAgreementId ?? "direct"].join(":"); }
}

function active(value: { startsAt?: string; endsAt?: string; activeFrom?: string; activeUntil?: string }, now: Date): boolean { const start = value.startsAt ?? value.activeFrom as string; const end = value.endsAt ?? value.activeUntil; return start <= now.toISOString() && (end === undefined || end > now.toISOString()); }
