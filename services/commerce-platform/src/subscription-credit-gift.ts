import { CommerceError, assertMoney, sha256, stableJson, strictUtc } from "./common.js";

export interface SubscriptionPlan { readonly id: string; readonly version: number; readonly periodDays: number; readonly trialDays: number; readonly graceDays: number; readonly autoRenew: boolean; readonly entitlementEffective: "immediate" | "next_period"; readonly cancellationEffective: "immediate" | "period_end"; }
export interface Subscription { readonly id: string; readonly accountId: string; readonly planId: string; readonly planVersion: number; readonly state: "trial" | "active" | "grace" | "paused" | "cancel_at_period_end" | "cancelled"; readonly periodStart: string; readonly periodEnd: string; readonly pendingPlanId?: string; readonly renewalNoticeAt: string; readonly priceChangeNoticeRequired: boolean; }
export type CreditEntryKind = "grant" | "reserve" | "consume" | "release" | "expire" | "gift" | "refund";
export interface CreditEntry { readonly id: string; readonly accountId: string; readonly kind: CreditEntryKind; readonly amount: number; readonly reservationId?: string; readonly sourceId: string; readonly expiresAt?: string; readonly occurredAt: string; readonly priorEntrySha256: string; readonly entrySha256: string; }
export interface GiftDefinition { readonly id: string; readonly tenantId: string; readonly type: "denomination" | "sku"; readonly amountMinor?: number; readonly sku?: string; readonly regions: readonly string[]; readonly expiresAt: string; readonly maximumRedemptions: number; readonly recipientAccountId?: string; readonly termsVersion: string; readonly codeHash: string; }

export class SubscriptionCreditGiftService {
  readonly #plans = new Map<string, SubscriptionPlan>();
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #credits = new Map<string, CreditEntry[]>();
  readonly #creditEntriesById = new Map<string, CreditEntry>();
  readonly #creditRequestHashes = new Map<string, string>();
  readonly #gifts = new Map<string, GiftDefinition & { redemptions: number }>();
  readonly #giftRedemptions = new Map<string, Readonly<{ requestSha256: string; gift: GiftDefinition }>>();
  readonly #giftAttempts = new Map<string, number[]>();
  readonly #familyLimits = new Map<string, Map<string, number>>();
  readonly #notifications: Array<Readonly<{ accountId: string; type: "renewal" | "price_change" | "payment_failed" | "cancelled"; actionPath: string }>> = [];
  constructor(readonly giftPepper: string, readonly now: () => Date = () => new Date()) { if (giftPepper.length < 32) throw new CommerceError("VALIDATION", "gift-code pepper is too short"); }

  publishPlan(plan: SubscriptionPlan): void { if (plan.periodDays < 1 || plan.trialDays < 0 || plan.graceDays < 0 || this.#plans.has(`${plan.id}:${plan.version}`)) throw new CommerceError("VALIDATION", "subscription plan is invalid or duplicated"); this.#plans.set(`${plan.id}:${plan.version}`, Object.freeze(structuredClone(plan))); }
  subscribe(input: { readonly id: string; readonly accountId: string; readonly planId: string; readonly planVersion: number; readonly startsAt: string }): Subscription { const plan = this.#plans.get(`${input.planId}:${input.planVersion}`); if (plan === undefined || !strictUtc(input.startsAt)) throw new CommerceError("NOT_FOUND", "subscription plan or start time is invalid"); const trial = plan.trialDays > 0; const periodStart = input.startsAt; const periodEnd = new Date(Date.parse(periodStart) + (trial ? plan.trialDays : plan.periodDays) * 86_400_000).toISOString(); const value: Subscription = Object.freeze({ id: input.id, accountId: input.accountId, planId: input.planId, planVersion: input.planVersion, state: trial ? "trial" : "active", periodStart, periodEnd, renewalNoticeAt: new Date(Date.parse(periodEnd) - 3 * 86_400_000).toISOString(), priceChangeNoticeRequired: false }); this.#subscriptions.set(input.id, value); return value; }
  transition(id: string, action: "trial_convert" | "payment_failed" | "payment_recovered" | "pause" | "resume" | "cancel" | "period_end" | "renew", pendingPlanId?: string): Subscription {
    const current = this.#subscriptions.get(id);
    if (current === undefined) throw new CommerceError("NOT_FOUND", "subscription does not exist");
    let next: Subscription;
    if (action === "trial_convert" && current.state === "trial") next = { ...current, state: "active" };
    else if (action === "payment_failed" && ["trial", "active"].includes(current.state)) { next = { ...current, state: "grace" }; this.#notifications.push({ accountId: current.accountId, type: "payment_failed", actionPath: "/account/billing/recover" }); }
    else if (action === "payment_recovered" && current.state === "grace") next = { ...current, state: "active" };
    else if (action === "pause" && current.state === "active") next = { ...current, state: "paused" };
    else if (action === "resume" && current.state === "paused") next = { ...current, state: "active" };
    else if (action === "cancel" && !["cancelled", "cancel_at_period_end"].includes(current.state)) { next = { ...current, state: "cancel_at_period_end" }; this.#notifications.push({ accountId: current.accountId, type: "cancelled", actionPath: "/account/billing/cancellation-confirmation" }); }
    else if (action === "period_end" && current.state === "cancel_at_period_end") next = { ...current, state: "cancelled" };
    else if (action === "renew" && ["trial", "active", "grace"].includes(current.state)) {
      const planKey = current.pendingPlanId ?? `${current.planId}:${current.planVersion}`;
      const plan = this.#plans.get(planKey);
      if (plan === undefined || !plan.autoRenew) throw new CommerceError("CONFLICT", "subscription cannot renew under the current plan");
      const periodStart = current.periodEnd;
      const periodEnd = new Date(Date.parse(periodStart) + plan.periodDays * 86_400_000).toISOString();
      next = { ...current, planId: plan.id, planVersion: plan.version, state: "active", periodStart, periodEnd, renewalNoticeAt: new Date(Date.parse(periodEnd) - 3 * 86_400_000).toISOString() };
      delete (next as { pendingPlanId?: string }).pendingPlanId;
    } else throw new CommerceError("CONFLICT", `illegal subscription transition ${current.state}:${action}`);
    if (pendingPlanId !== undefined) next = { ...next, pendingPlanId };
    const frozen = Object.freeze(next);
    this.#subscriptions.set(id, frozen);
    return frozen;
  }
  changePlan(id: string, targetPlanId: string, targetPlanVersion: number, effective: "immediate" | "next_period"): Subscription {
    const current = this.#subscriptions.get(id);
    const targetKey = `${targetPlanId}:${targetPlanVersion}`;
    const target = this.#plans.get(targetKey);
    if (current === undefined || target === undefined || !["trial", "active", "grace", "paused"].includes(current.state)) throw new CommerceError("CONFLICT", "subscription plan change is unavailable");
    if (current.pendingPlanId !== undefined && current.pendingPlanId !== targetKey) throw new CommerceError("CONFLICT", "a different subscription plan change is already pending");
    if (effective === "next_period" && current.pendingPlanId === targetKey) return current;
    const { pendingPlanId: _pending, ...withoutPending } = current;
    void _pending;
    const next: Subscription = effective === "immediate" ? Object.freeze({ ...withoutPending, planId: targetPlanId, planVersion: targetPlanVersion }) : Object.freeze({ ...current, pendingPlanId: targetKey });
    this.#subscriptions.set(id, next);
    return next;
  }
  renewalNotice(id: string): void { const current = this.#subscriptions.get(id); if (current === undefined || !["trial", "active", "grace"].includes(current.state)) throw new CommerceError("CONFLICT", "renewal notice is not applicable"); this.#notifications.push({ accountId: current.accountId, type: "renewal", actionPath: "/account/billing/renew-or-cancel" }); }
  notifyPriceChange(id: string): Subscription { const current = this.#subscriptions.get(id); if (current === undefined) throw new CommerceError("NOT_FOUND", "subscription does not exist"); const next = Object.freeze({ ...current, priceChangeNoticeRequired: true }); this.#subscriptions.set(id, next); this.#notifications.push({ accountId: current.accountId, type: "price_change", actionPath: "/account/billing/compare-or-cancel" }); return next; }

  credit(input: { readonly id: string; readonly accountId: string; readonly kind: CreditEntryKind; readonly amount: number; readonly reservationId?: string; readonly sourceId: string; readonly expiresAt?: string }): CreditEntry {
    if (!Number.isSafeInteger(input.amount) || input.amount <= 0 || (input.expiresAt !== undefined && !strictUtc(input.expiresAt))) throw new CommerceError("VALIDATION", "credit ledger amount or expiry is invalid");
    const requestSha256 = sha256(stableJson(input)); const entries = this.#credits.get(input.accountId) ?? []; const prior = this.#creditEntriesById.get(input.id); if (prior !== undefined) { if (this.#creditRequestHashes.get(input.id) !== requestSha256) throw new CommerceError("CONFLICT", "credit entry id was reused"); return prior; }
    if (["reserve", "consume", "release"].includes(input.kind) && input.reservationId === undefined) throw new CommerceError("VALIDATION", "credit reservation identity is required");
    if (["reserve", "expire"].includes(input.kind) && this.balance(input.accountId) < input.amount) throw new CommerceError("CONFLICT", "credit balance is insufficient");
    if (["consume", "release"].includes(input.kind)) { const reserved = entries.filter((item) => item.reservationId === input.reservationId).reduce((sum, item) => sum + (item.kind === "reserve" ? item.amount : ["consume", "release"].includes(item.kind) ? -item.amount : 0), 0); if (reserved < input.amount) throw new CommerceError("CONFLICT", "credit consumption or release lacks sufficient matching reservation"); }
    const unsigned = { id: input.id, accountId: input.accountId, kind: input.kind, amount: input.amount, ...(input.reservationId === undefined ? {} : { reservationId: input.reservationId }), sourceId: input.sourceId, ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }), occurredAt: this.now().toISOString(), priorEntrySha256: entries.at(-1)?.entrySha256 ?? "0".repeat(64) };
    const value = Object.freeze({ ...unsigned, entrySha256: sha256(stableJson(unsigned)) }); entries.push(value); this.#credits.set(input.accountId, entries); this.#creditEntriesById.set(input.id, value); this.#creditRequestHashes.set(input.id, requestSha256); return value;
  }
  balance(accountId: string): number { return (this.#credits.get(accountId) ?? []).reduce((sum, item) => sum + (["grant", "gift", "refund", "release"].includes(item.kind) ? item.amount : item.kind === "consume" ? 0 : -item.amount), 0); }
  ledger(accountId: string): readonly CreditEntry[] { return Object.freeze(structuredClone(this.#credits.get(accountId) ?? [])); }

  issueGift(input: Omit<GiftDefinition, "id" | "codeHash"> & { readonly code: string }): GiftDefinition { if (input.code.length < 12 || !strictUtc(input.expiresAt) || input.maximumRedemptions < 1 || input.termsVersion.trim() === "" || (input.type === "denomination" ? input.amountMinor === undefined : input.sku === undefined)) throw new CommerceError("VALIDATION", "gift definition or terms are invalid"); if (input.amountMinor !== undefined) assertMoney(input.amountMinor); const codeHash = sha256(`${this.giftPepper}:${input.code}`); if (this.#gifts.has(codeHash)) throw new CommerceError("CONFLICT", "gift code is already issued"); const id = sha256(`${input.tenantId}:${codeHash}`); const gift = Object.freeze({ id, tenantId: input.tenantId, type: input.type, ...(input.amountMinor === undefined ? {} : { amountMinor: input.amountMinor }), ...(input.sku === undefined ? {} : { sku: input.sku }), regions: [...input.regions], expiresAt: input.expiresAt, maximumRedemptions: input.maximumRedemptions, ...(input.recipientAccountId === undefined ? {} : { recipientAccountId: input.recipientAccountId }), termsVersion: input.termsVersion, codeHash }); this.#gifts.set(codeHash, { ...gift, redemptions: 0 }); return gift; }
  giftTerms(input: { readonly code: string; readonly tenantId: string }): Readonly<{ type: "denomination" | "sku"; amountMinor?: number; sku?: string; regions: readonly string[]; expiresAt: string; maximumRedemptions: number; termsVersion: string }> { const value = this.#gifts.get(sha256(`${this.giftPepper}:${input.code}`)); if (value === undefined || value.tenantId !== input.tenantId) throw new CommerceError("NOT_FOUND", "gift terms do not exist"); return Object.freeze({ type: value.type, ...(value.amountMinor === undefined ? {} : { amountMinor: value.amountMinor }), ...(value.sku === undefined ? {} : { sku: value.sku }), regions: Object.freeze([...value.regions]), expiresAt: value.expiresAt, maximumRedemptions: value.maximumRedemptions, termsVersion: value.termsVersion }); }
  redeemGift(input: { readonly code: string; readonly tenantId: string; readonly accountId: string; readonly region: string; readonly acceptedTermsVersion: string; readonly requesterFingerprint: string; readonly idempotencyKey: string }): GiftDefinition { const requestSha256 = sha256(stableJson(input)); const idempotencyScope = `${input.tenantId}:${input.accountId}:${input.idempotencyKey}`; const prior = this.#giftRedemptions.get(idempotencyScope); if (prior !== undefined) { if (prior.requestSha256 !== requestSha256) throw new CommerceError("CONFLICT", "gift redemption idempotency key was reused"); return structuredClone(prior.gift); } if (input.idempotencyKey.length < 8) throw new CommerceError("VALIDATION", "gift redemption idempotency key is invalid"); const nowMs = this.now().getTime(); const attempts = (this.#giftAttempts.get(input.requesterFingerprint) ?? []).filter((time) => time > nowMs - 60_000); if (attempts.length >= 5) throw new CommerceError("RATE_LIMIT", "gift redemption attempts are rate limited"); attempts.push(nowMs); this.#giftAttempts.set(input.requesterFingerprint, attempts); const value = this.#gifts.get(sha256(`${this.giftPepper}:${input.code}`)); if (value === undefined || value.tenantId !== input.tenantId || value.expiresAt <= this.now().toISOString() || !value.regions.includes(input.region) || value.redemptions >= value.maximumRedemptions || (value.recipientAccountId !== undefined && value.recipientAccountId !== input.accountId) || value.termsVersion !== input.acceptedTermsVersion) throw new CommerceError("AUTHORIZATION", "gift code cannot be redeemed under current terms"); value.redemptions += 1; const redeemed = structuredClone(value); this.#giftRedemptions.set(idempotencyScope, Object.freeze({ requestSha256, gift: redeemed })); return redeemed; }

  setFamilyLimit(input: { readonly holderAccountId: string; readonly memberAccountId: string; readonly limit: number; readonly holderAuthorized: boolean }): void { if (!input.holderAuthorized || input.holderAccountId === input.memberAccountId || input.limit < 0 || !Number.isSafeInteger(input.limit)) throw new CommerceError("AUTHORIZATION", "family credit limit requires explicit holder authorization"); const limits = this.#familyLimits.get(input.holderAccountId) ?? new Map<string, number>(); limits.set(input.memberAccountId, input.limit); this.#familyLimits.set(input.holderAccountId, limits); }
  familyView(holderAccountId: string, memberAccountId: string): Readonly<{ memberAccountId: string; limit: number; paymentDetails: never[] }> { const limit = this.#familyLimits.get(holderAccountId)?.get(memberAccountId); if (limit === undefined) throw new CommerceError("NOT_FOUND", "family member limit does not exist"); return Object.freeze({ memberAccountId, limit, paymentDetails: [] }); }
  notifications(): readonly Readonly<{ accountId: string; type: "renewal" | "price_change" | "payment_failed" | "cancelled"; actionPath: string }>[] { return Object.freeze(structuredClone(this.#notifications)); }
}
