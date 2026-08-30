import { CommerceError, assertMoney, hmac, safeEqual, sha256, stableJson, strictUtc } from "./common.js";
import type { CommerceFinanceRepository, CommerceFinanceState } from "./repository.js";

export interface CheckoutDisclosure { readonly quoteId: string; readonly productSummary: string; readonly participantAuthorizationSummary: string; readonly deliveryScope: string; readonly estimatedWait: string; readonly illustrativeAiDisclosure: string; readonly refundPolicyVersion: string; readonly taxMinor: number; readonly totalMinor: number; readonly currency: string; }
export interface PaymentAdapter { createTokenizedIntent(input: { readonly merchantReference: string; readonly providerPaymentToken: string; readonly amountMinor: number; readonly currency: string; readonly idempotencyKey: string }): Promise<{ providerIntentId: string; clientActionReference?: string }>; refund(input: { readonly providerIntentId: string; readonly amountMinor: number; readonly idempotencyKey: string }): Promise<{ providerRefundId: string; receiptSha256: string }>; }
export interface PaymentIntent { readonly id: string; readonly tenantId: string; readonly quoteId: string; readonly providerIntentId: string; readonly amountMinor: number; readonly currency: string; readonly state: "pending" | "authorized" | "paid" | "partially_refunded" | "refunded" | "disputed" | "chargeback" | "failed"; readonly lastProviderSequence: number; readonly refundedMinor: number; readonly requestSha256: string; }
export interface LedgerLine { readonly account: "accounts_receivable" | "cash" | "tax_payable" | "revenue" | "channel_share_payable" | "refund_expense" | "credit_liability" | "chargeback_loss"; readonly debitMinor: number; readonly creditMinor: number; }
export interface JournalEntry { readonly id: string; readonly tenantId: string; readonly sourceType: string; readonly sourceId: string; readonly currency: string; readonly occurredAt: string; readonly lines: readonly LedgerLine[]; readonly artifactSha256: string; }
export interface PaymentWebhook { readonly tenantId: string; readonly eventId: string; readonly providerIntentId: string; readonly sequence: number; readonly type: "authorized" | "paid" | "failed" | "disputed" | "chargeback"; readonly occurredAt: string; readonly amountMinor: number; readonly rawBody: string; readonly signature: string; }
export interface WebhookInboxEntry { readonly eventId: string; readonly type: PaymentWebhook["type"]; readonly fingerprint: string; readonly processedAt: string; readonly payload: Readonly<{ tenantId: string; eventId: string; providerIntentId: string; sequence: number; type: PaymentWebhook["type"]; occurredAt: string; amountMinor: number }>; }
export interface PaymentEffect { readonly type: "revoke_entitlement" | "adjust_partner_settlement" | "notify_customer" | "rebuild_order" | "manual_case"; readonly sourceId: string; readonly amountMinor?: number; }
export interface PaymentOutboxEvent { readonly id: string; readonly aggregateType: "payment" | "order"; readonly aggregateId: string; readonly type: string; readonly occurredAt: string; readonly payload: Readonly<Record<string, unknown>>; }

export class PaymentLedgerService {
  constructor(readonly adapter: PaymentAdapter, readonly webhookSecret: string, readonly repository: CommerceFinanceRepository, readonly now: () => Date = () => new Date()) { if (webhookSecret.length < 32) throw new CommerceError("VALIDATION", "payment webhook secret is too short"); }

  checkout(disclosure: CheckoutDisclosure): CheckoutDisclosure {
    if (!disclosure.illustrativeAiDisclosure.toLowerCase().includes("illustrative") || disclosure.participantAuthorizationSummary.trim() === "" || disclosure.refundPolicyVersion.trim() === "") throw new CommerceError("VALIDATION", "checkout lacks mandatory authorization, AI, or refund disclosure");
    assertMoney(disclosure.taxMinor, "tax"); assertMoney(disclosure.totalMinor, "total"); if (disclosure.taxMinor > disclosure.totalMinor) throw new CommerceError("VALIDATION", "tax exceeds total");
    return Object.freeze(structuredClone(disclosure));
  }

  async createIntent(input: { readonly tenantId: string; readonly quoteId: string; readonly providerPaymentToken: string; readonly amountMinor: number; readonly currency: string; readonly idempotencyKey: string }): Promise<PaymentIntent> {
    if (!/^tok_[A-Za-z0-9_-]{8,}$/u.test(input.providerPaymentToken) || /(?:\d[ -]*?){13,19}/u.test(input.providerPaymentToken)) throw new CommerceError("VALIDATION", "only provider-tokenized payment credentials are accepted");
    assertMoney(input.amountMinor); if (!/^[A-Z]{3}$/u.test(input.currency) || input.idempotencyKey.length < 8) throw new CommerceError("VALIDATION", "payment request is invalid");
    const requestSha256 = sha256(stableJson(input));
    const prior = await this.repository.read(input.tenantId, (state) => priorIntent(state, input.idempotencyKey, requestSha256)); if (prior !== undefined) return prior;
    const id = sha256(`${input.tenantId}:${input.idempotencyKey}`);
    const provider = await this.adapter.createTokenizedIntent({ merchantReference: id, providerPaymentToken: input.providerPaymentToken, amountMinor: input.amountMinor, currency: input.currency, idempotencyKey: input.idempotencyKey });
    if (provider.providerIntentId.trim() === "") throw new CommerceError("DEPENDENCY", "payment provider returned no intent identity");
    return this.repository.transaction(input.tenantId, (state) => {
      const raced = priorIntent(state, input.idempotencyKey, requestSha256); if (raced !== undefined) return raced;
      if (state.paymentByProvider[provider.providerIntentId] !== undefined) throw new CommerceError("DEPENDENCY", "payment provider returned a reused intent identity");
      const intent: PaymentIntent = Object.freeze({ id, tenantId: input.tenantId, quoteId: input.quoteId, providerIntentId: provider.providerIntentId, amountMinor: input.amountMinor, currency: input.currency, state: "pending", lastProviderSequence: 0, refundedMinor: 0, requestSha256 });
      state.payments[id] = intent; state.paymentByProvider[provider.providerIntentId] = id; state.paymentRequestKeys[input.idempotencyKey] = id;
      appendOutbox(state, input.tenantId, id, "payment.intent_created", this.now().toISOString(), { quoteId: input.quoteId, amountMinor: input.amountMinor, currency: input.currency });
      return intent;
    });
  }

  async processWebhook(event: PaymentWebhook, allocation: { readonly taxMinor: number; readonly channelShareMinor: number }): Promise<PaymentIntent> {
    let boundBody: unknown; try { boundBody = JSON.parse(event.rawBody); } catch { throw new CommerceError("VALIDATION", "payment webhook body is not valid JSON"); }
    const expectedBody = { tenantId: event.tenantId, eventId: event.eventId, providerIntentId: event.providerIntentId, sequence: event.sequence, type: event.type, occurredAt: event.occurredAt, amountMinor: event.amountMinor };
    if (!safeEqual(hmac(this.webhookSecret, event.rawBody), event.signature) || stableJson(boundBody) !== stableJson(expectedBody) || !strictUtc(event.occurredAt) || event.sequence < 1) throw new CommerceError("AUTHORIZATION", "payment webhook signature, body binding, time, or sequence is invalid");
    const fingerprint = sha256(event.rawBody);
    if (event.type === "paid") { assertMoney(allocation.taxMinor, "tax"); assertMoney(allocation.channelShareMinor, "channel share"); if (event.amountMinor - allocation.taxMinor - allocation.channelShareMinor < 0) throw new CommerceError("VALIDATION", "payment allocation is negative"); }
    return this.repository.transaction(event.tenantId, (state) => {
      const prior = state.webhookInbox[event.eventId];
      if (prior !== undefined) { if (prior.fingerprint !== fingerprint) throw new CommerceError("CONFLICT", "payment webhook event id was reused"); return requiredByProvider(state, event.providerIntentId); }
      const current = requiredByProvider(state, event.providerIntentId); if (current.tenantId !== event.tenantId) throw new CommerceError("AUTHORIZATION", "payment webhook crossed tenant scope");
      if (event.amountMinor !== current.amountMinor) throw new CommerceError("CONFLICT", "authoritative payment amount differs from the quote snapshot");
      const inbox: WebhookInboxEntry = Object.freeze({ eventId: event.eventId, type: event.type, fingerprint, processedAt: this.now().toISOString(), payload: Object.freeze(expectedBody) });
      if (event.sequence <= current.lastProviderSequence) { state.webhookInbox[event.eventId] = inbox; return current; }
      const next: PaymentIntent = Object.freeze({ ...current, state: reducePayment(current.state, event.type), lastProviderSequence: event.sequence });
      if (event.type === "paid") { const revenue = current.amountMinor - allocation.taxMinor - allocation.channelShareMinor; appendJournal(state, { tenantId: current.tenantId, sourceType: "payment", sourceId: event.eventId, currency: current.currency, occurredAt: event.occurredAt, lines: [line("cash", current.amountMinor, 0), line("revenue", 0, revenue), line("tax_payable", 0, allocation.taxMinor), line("channel_share_payable", 0, allocation.channelShareMinor)] }); }
      if (event.type === "chargeback") { appendJournal(state, { tenantId: current.tenantId, sourceType: "chargeback", sourceId: event.eventId, currency: current.currency, occurredAt: event.occurredAt, lines: [line("chargeback_loss", current.amountMinor, 0), line("cash", 0, current.amountMinor)] }); synchronizeReversal(state, current.id, current.amountMinor, event.occurredAt); }
      state.payments[current.id] = next; state.webhookInbox[event.eventId] = inbox;
      appendOutbox(state, current.tenantId, current.id, `payment.${event.type}`, event.occurredAt, { eventId: event.eventId, state: next.state, amountMinor: current.amountMinor, currency: current.currency });
      return next;
    });
  }

  async refund(input: { readonly tenantId: string; readonly paymentId: string; readonly amountMinor: number; readonly reason: string; readonly idempotencyKey: string }): Promise<PaymentIntent> {
    assertMoney(input.amountMinor); if (input.amountMinor < 1 || input.reason.trim() === "" || input.idempotencyKey.length < 8) throw new CommerceError("VALIDATION", "refund amount, reason, or idempotency key is invalid");
    const requestSha256 = sha256(stableJson(input));
    const reserved = await this.repository.transaction(input.tenantId, (state) => {
      const prior = state.refundKeys[input.idempotencyKey]; if (prior !== undefined) { validateRefundReuse(prior, input.paymentId, requestSha256); return { complete: prior.result } as const; }
      const existing = state.refundReservations[input.idempotencyKey];
      if (existing !== undefined) { if (existing.requestSha256 !== requestSha256 || existing.paymentId !== input.paymentId) throw new CommerceError("CONFLICT", "refund idempotency key was reused"); }
      else { const current = requiredPayment(state, input.paymentId); if (current.tenantId !== input.tenantId) throw new CommerceError("AUTHORIZATION", "refund crossed tenant scope"); const pendingMinor = Object.values(state.refundReservations).filter((item) => item.paymentId === input.paymentId).reduce((sum, item) => sum + item.amountMinor, 0); if (current.refundedMinor + pendingMinor + input.amountMinor > current.amountMinor) throw new CommerceError("VALIDATION", "refund exceeds the authoritative payment amount"); state.refundReservations[input.idempotencyKey] = Object.freeze({ requestSha256, paymentId: input.paymentId, amountMinor: input.amountMinor }); }
      return { providerIntentId: requiredPayment(state, input.paymentId).providerIntentId } as const;
    });
    if ("complete" in reserved) return reserved.complete;
    const provider = await this.adapter.refund({ providerIntentId: reserved.providerIntentId, amountMinor: input.amountMinor, idempotencyKey: input.idempotencyKey });
    if (provider.providerRefundId.trim() === "" || !/^[a-f0-9]{64}$/u.test(provider.receiptSha256)) throw new CommerceError("DEPENDENCY", "refund lacks provider identity or receipt");
    return this.repository.transaction(input.tenantId, (state) => {
      const prior = state.refundKeys[input.idempotencyKey]; if (prior !== undefined) { validateRefundReuse(prior, input.paymentId, requestSha256); return prior.result; }
      const reservation = state.refundReservations[input.idempotencyKey]; if (reservation === undefined || reservation.requestSha256 !== requestSha256) throw new CommerceError("CONFLICT", "refund reservation was lost");
      const current = requiredPayment(state, input.paymentId); const refundedMinor = current.refundedMinor + input.amountMinor; if (refundedMinor > current.amountMinor) throw new CommerceError("CONFLICT", "refund completion exceeds payment amount");
      const next: PaymentIntent = Object.freeze({ ...current, refundedMinor, state: refundedMinor === current.amountMinor ? "refunded" : "partially_refunded" });
      const occurredAt = this.now().toISOString(); appendJournal(state, { tenantId: current.tenantId, sourceType: "refund", sourceId: provider.providerRefundId, currency: current.currency, occurredAt, lines: [line("refund_expense", input.amountMinor, 0), line("cash", 0, input.amountMinor)] }); synchronizeReversal(state, current.id, input.amountMinor, occurredAt);
      state.payments[current.id] = next; delete state.refundReservations[input.idempotencyKey]; state.refundKeys[input.idempotencyKey] = Object.freeze({ requestSha256, paymentId: input.paymentId, result: next }); appendOutbox(state, current.tenantId, current.id, "payment.refunded", occurredAt, { providerRefundId: provider.providerRefundId, amountMinor: input.amountMinor, refundedMinor }); return next;
    });
  }

  async recoverPaidOrder(input: { readonly tenantId: string; readonly paymentId: string; readonly orderState: "missing" | "failed"; readonly recovery: "rebuild" | "refund" | "manual"; readonly reason: string }): Promise<PaymentIntent> {
    if (input.recovery === "refund") { const current = await this.payment(input.tenantId, input.paymentId); if (current.state !== "paid") throw new CommerceError("CONFLICT", "only authoritative paid payments can enter order recovery"); return this.refund({ tenantId: input.tenantId, paymentId: current.id, amountMinor: current.amountMinor, reason: input.reason, idempotencyKey: `recovery:${current.id}` }); }
    return this.repository.transaction(input.tenantId, (state) => { const current = requiredPayment(state, input.paymentId); if (current.state !== "paid") throw new CommerceError("CONFLICT", "only authoritative paid payments can enter order recovery"); const effect: PaymentEffect = Object.freeze({ type: input.recovery === "rebuild" ? "rebuild_order" : "manual_case", sourceId: current.id }); state.effects.push(effect); appendOutbox(state, input.tenantId, current.id, `payment.order_recovery_${input.recovery}`, this.now().toISOString(), { orderState: input.orderState, reason: input.reason }); return current; });
  }

  browserReturn(): never { throw new CommerceError("AUTHORIZATION", "browser redirects are not authoritative payment state"); }
  async payment(tenantId: string, paymentId: string): Promise<PaymentIntent> { return this.repository.read(tenantId, (state) => requiredPayment(state, paymentId)); }
  async journals(tenantId: string): Promise<readonly JournalEntry[]> { return this.repository.read(tenantId, (state) => Object.freeze(structuredClone(state.journals))); }
  async effects(tenantId: string): Promise<readonly PaymentEffect[]> { return this.repository.read(tenantId, (state) => Object.freeze(structuredClone(state.effects))); }
  async outbox(tenantId: string): Promise<readonly PaymentOutboxEvent[]> { return this.repository.read(tenantId, (state) => Object.freeze(structuredClone(state.outbox))); }
}

function priorIntent(state: Readonly<CommerceFinanceState>, key: string, requestSha256: string): PaymentIntent | undefined { const id = state.paymentRequestKeys[key]; if (id === undefined) return undefined; const prior = state.payments[id]; if (prior === undefined) throw new CommerceError("DEPENDENCY", "payment idempotency index is corrupt"); if (prior.requestSha256 !== requestSha256) throw new CommerceError("CONFLICT", "payment idempotency key was reused"); return structuredClone(prior); }
function requiredPayment(state: Readonly<CommerceFinanceState>, id: string): PaymentIntent { const value = state.payments[id]; if (value === undefined) throw new CommerceError("NOT_FOUND", "payment does not exist"); return value; }
function requiredByProvider(state: Readonly<CommerceFinanceState>, providerIntentId: string): PaymentIntent { const id = state.paymentByProvider[providerIntentId]; if (id === undefined) throw new CommerceError("NOT_FOUND", "provider payment intent is unknown"); return requiredPayment(state, id); }
function validateRefundReuse(prior: Readonly<{ requestSha256: string; paymentId: string }>, paymentId: string, requestSha256: string): void { if (prior.requestSha256 !== requestSha256 || prior.paymentId !== paymentId) throw new CommerceError("CONFLICT", "refund idempotency key was reused"); }
function line(account: LedgerLine["account"], debitMinor: number, creditMinor: number): LedgerLine { return Object.freeze({ account, debitMinor, creditMinor }); }
function appendJournal(state: CommerceFinanceState, input: Omit<JournalEntry, "id" | "artifactSha256">): void { const debit = input.lines.reduce((sum, item) => sum + item.debitMinor, 0); const credit = input.lines.reduce((sum, item) => sum + item.creditMinor, 0); if (debit !== credit || debit === 0) throw new CommerceError("VALIDATION", "journal entry is not balanced"); const unsigned = { ...input, lines: Object.freeze(structuredClone(input.lines)) }; const entry = Object.freeze({ id: sha256(`${input.tenantId}:${input.sourceType}:${input.sourceId}`), ...unsigned, artifactSha256: sha256(stableJson(unsigned)) }); if (state.journals.some((item) => item.id === entry.id)) throw new CommerceError("CONFLICT", "journal source was already posted"); state.journals.push(entry); }
function appendOutbox(state: CommerceFinanceState, tenantId: string, aggregateId: string, type: string, occurredAt: string, payload: Readonly<Record<string, unknown>>): void { const id = sha256(`${tenantId}:${type}:${aggregateId}:${stableJson(payload)}`); if (!state.outbox.some((item) => item.id === id)) state.outbox.push(Object.freeze({ id, aggregateType: "payment", aggregateId, type, occurredAt, payload: Object.freeze(structuredClone(payload)) })); }
function synchronizeReversal(state: CommerceFinanceState, sourceId: string, amountMinor: number, occurredAt: string): void { for (const type of ["revoke_entitlement", "adjust_partner_settlement", "notify_customer"] as const) { state.effects.push(Object.freeze({ type, sourceId, amountMinor })); appendOutbox(state, requiredPayment(state, sourceId).tenantId, sourceId, `payment.${type}`, occurredAt, { amountMinor }); } }
function reducePayment(current: PaymentIntent["state"], event: PaymentWebhook["type"]): PaymentIntent["state"] { const allowed: Record<PaymentWebhook["type"], readonly PaymentIntent["state"][]> = { authorized: ["pending", "authorized"], paid: ["pending", "authorized", "paid"], failed: ["pending", "authorized", "failed"], disputed: ["paid", "partially_refunded", "disputed"], chargeback: ["paid", "partially_refunded", "disputed", "chargeback"] }; if (!allowed[event].includes(current)) throw new CommerceError("CONFLICT", `illegal payment transition ${current} -> ${event}`); return event === "authorized" ? "authorized" : event === "paid" ? "paid" : event === "failed" ? "failed" : event; }
