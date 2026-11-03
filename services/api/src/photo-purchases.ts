import { createHash } from "node:crypto";
import { canonicalJson, DomainError, type ActorContext, type JsonObject, type JsonValue, type LifeTimeMachineRuntimePort, type RecordEnvelope } from "@ltm/core";
import { buildAgeGenerationPlan, type CapabilityRegistry } from "@ltm/capabilities";
import { agePhotoProduct, wardrobeSeriesProduct } from "./photo-catalog.js";
import { WardrobeService, wardrobeCommandId } from "./wardrobe.js";
import { TimelineDeliveryService } from "./timeline-delivery.js";
import type { TimelineArtifactReader } from "./timeline-artifacts.js";
import type { WechatPaymentProjection } from "./wechat-platform.js";

export const PHOTO_PURCHASE_COLLECTION = "commerce.photo-purchases";
export const PHOTO_COMMAND_BINDING_COLLECTION = "commerce.photo-command-bindings";
export interface PhotoCheckoutRequest { readonly purchaseId: string; readonly amountMinor: number; readonly currency: "CNY"; readonly sku: string; readonly priceVersion: string; readonly scopeSha256: string; readonly imageCount: number; readonly idempotencyKey: string }
export interface PhotoCheckoutResult { readonly schemaVersion: "ltm.photo-checkout.v1"; readonly checkoutId: string; readonly orderId: string; readonly amountMinor: number; readonly currency: "CNY"; readonly scopeSha256: string }
export interface PhotoPurchasePayments {
  preparePhotoCheckout(actor: ActorContext, input: PhotoCheckoutRequest): Promise<PhotoCheckoutResult>;
  getPayment(actor: ActorContext, input: { readonly orderId: string; readonly requestId: string }): Promise<WechatPaymentProjection>;
}
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value as JsonValue)).digest("hex");
const json = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
function closed(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => ![...required, ...optional].includes(k))) throw new DomainError("VALIDATION_FAILED", "invalid closed photo purchase input");
  return value as Record<string, unknown>;
}

export class PhotoPurchaseService {
  constructor(private readonly runtime: LifeTimeMachineRuntimePort, private readonly registry: CapabilityRegistry,
    private readonly artifacts?: TimelineArtifactReader, private readonly payments?: PhotoPurchasePayments) {}

  async create(actor: ActorContext, input: Record<string, unknown>, key: string) {
    let scope: JsonObject, request: JsonObject;
    if (input.sku === "wardrobe-series") {
      closed(input, ["sku", "sourceRootCommandId", "targetAge", "seriesId"]);
      if (!identifier(input.sourceRootCommandId)) throw new DomainError("VALIDATION_FAILED", "invalid source timeline");
      const source = await new WardrobeService(this.runtime, this.registry, this.artifacts).context(actor, input.sourceRootCommandId, input.targetAge as number);
      if (source.participants.some(p => !p.authorized)) throw new DomainError("CONSENT_REQUIRED", "every participant must authorize the whole wardrobe series");
      scope = json(wardrobeSeriesProduct(input.seriesId, input.targetAge, source.participants.length));
      request = json({ sourceRootCommandId: input.sourceRootCommandId, targetAge: input.targetAge, sourceSha256: source.sourceNode.asset!.sha256, participantIds: source.participants.map(p => p.participantId) });
    } else {
      closed(input, ["sku", "generation"]);
      const g = closed(input.generation, ["sourceAssetId", "participantIds", "targetAges", "currentAge", "timelineProfile", "seed", "promptPolicyVersion", "illustrativeLabel"], ["templateId", "participantAges"]);
      if (!identifier(g.sourceAssetId) || !identifier(g.seed) || !identifier(g.promptPolicyVersion) || (g.templateId !== undefined && !identifier(g.templateId)) || g.illustrativeLabel !== true ||
          !Array.isArray(g.participantIds) || g.participantIds.length < 1 || g.participantIds.length > 2 || g.participantIds.some(p => !identifier(p)) || new Set(g.participantIds).size !== g.participantIds.length || typeof g.timelineProfile !== "string" || !Number.isInteger(g.currentAge)) throw new DomainError("VALIDATION_FAILED", "invalid age purchase request");
      const product = agePhotoProduct(g.timelineProfile, g.targetAges);
      if (product.sku !== input.sku) throw new DomainError("VALIDATION_FAILED", "photo product does not match requested age scope");
      buildAgeGenerationPlan(g as Parameters<typeof buildAgeGenerationPlan>[0]);
      const intake = await this.runtime.getRecord(actor, "media.intake-results", g.sourceAssetId);
      if (JSON.stringify(intake.data.participantIds) !== JSON.stringify(g.participantIds)) throw new DomainError("VALIDATION_FAILED", "purchase participants differ from the verified source");
      await this.runtime.assertConsent(actor, { participantIds: g.participantIds as string[], purpose: "age_transformation", scope: { resource: `media.asset:${g.sourceAssetId}`, action: "transform" } });
      scope = json(product); request = json(g);
    }
    const id = `photo-${digest([actor.tenantId, actor.actorId, key])}`;
    await this.runtime.createRecord(actor, { collection: PHOTO_PURCHASE_COLLECTION, id, ownerActorId: actor.actorId, processingPurpose: actor.purpose,
      data: { kind: "photo_purchase.v1", scope, request, scopeSha256: digest([scope, request]), commands: {}, checkout: null, paymentProof: null, paymentState: "pending" }, idempotencyKey: `photo-create:${key}` });
    await this.bindCommands(actor, await this.load(actor, id));
    return this.get(actor, id);
  }

  private planned(actor: ActorContext, record: RecordEnvelope): Array<{ itemId: string; commandId: string }> {
    const scope = record.data.scope as JsonObject, request = record.data.request as JsonObject;
    return scope.sku === "wardrobe-series" ? (scope.styleIds as string[]).map(itemId => ({ itemId,
      commandId: wardrobeCommandId(actor, request.sourceRootCommandId as string, request.targetAge as number, `${record.id}:${itemId}`) })) : [{ itemId: "age", commandId: `${record.id}:age` }];
  }

  private async bindCommands(actor: ActorContext, record: RecordEnvelope) {
    for (const item of this.planned(actor, record)) await this.runtime.createRecord(actor, { collection: PHOTO_COMMAND_BINDING_COLLECTION, id: item.commandId,
      ownerActorId: actor.actorId, processingPurpose: actor.purpose, data: { kind: "photo_command_binding.v1", purchaseId: record.id, itemId: item.itemId, commandId: item.commandId }, idempotencyKey: `photo-binding:${item.commandId}` });
  }

  async authorizeRetry(actor: ActorContext, commandId: string): Promise<void> {
    let binding: RecordEnvelope;
    try { binding = await this.runtime.getRecord(actor, PHOTO_COMMAND_BINDING_COLLECTION, commandId); }
    catch (error) { if (error instanceof DomainError && error.code === "RESOURCE_NOT_FOUND") return; throw error; }
    if (binding.data.kind !== "photo_command_binding.v1" || typeof binding.data.purchaseId !== "string") throw new DomainError("AUTH_FORBIDDEN", "invalid paid command binding");
    const purchase = await this.paid(actor, binding.data.purchaseId);
    if (!this.planned(actor,purchase).some(item => item.commandId === commandId && item.itemId === binding.data.itemId)) throw new DomainError("AUTH_FORBIDDEN", "command does not belong to the paid purchase");
  }

  private async load(actor: ActorContext, id: string) {
    const record = await this.runtime.getRecord(actor, PHOTO_PURCHASE_COLLECTION, id);
    if (record.ownerActorId !== actor.actorId || record.data.kind !== "photo_purchase.v1") throw new DomainError("AUTH_FORBIDDEN", "photo purchase is not owned by this account");
    return record;
  }
  private async change(actor: ActorContext, id: string, operation: string, apply: (data: JsonObject) => JsonObject | null): Promise<RecordEnvelope> {
    for (let i = 0; i < 8; i++) {
      const current = await this.load(actor, id), data = apply(current.data);
      if (!data) return current;
      try { return (await this.runtime.updateRecord(actor, { collection: PHOTO_PURCHASE_COLLECTION, id, expectedVersion: current.version, data,
        idempotencyKey: `photo:${id}:${operation}:v${current.version}` })).value; }
      catch (error) { if (!(error instanceof DomainError) || error.code !== "VERSION_CONFLICT") throw error; }
    }
    throw new DomainError("VERSION_CONFLICT", "photo purchase changed; refresh and resume");
  }

  async checkout(actor: ActorContext, id: string) {
    const record = await this.load(actor, id), scope = record.data.scope as JsonObject;
    await this.bindCommands(actor, record);
    if (!this.payments) throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", "photo checkout is not configured");
    if (record.data.checkout === null) {
      const result = await this.payments.preparePhotoCheckout({ ...actor, purpose: "commerce" }, { purchaseId: id, sku: scope.sku as string,
        priceVersion: scope.priceVersion as string, amountMinor: scope.amountMinor as number, currency: "CNY", scopeSha256: record.data.scopeSha256 as string, imageCount: scope.imageCount as number, idempotencyKey: `photo-checkout:${id}` });
      if (result.schemaVersion !== "ltm.photo-checkout.v1" || result.checkoutId !== id || !identifier(result.orderId) || result.amountMinor !== scope.amountMinor || result.currency !== "CNY" || result.scopeSha256 !== record.data.scopeSha256) throw new DomainError("DEPENDENCY_UNAVAILABLE", "merchant checkout changed the purchased scope or amount");
      await this.change(actor, id, "checkout", data => {
        if (data.checkout !== null && canonicalJson(data.checkout!) !== canonicalJson(json(result))) throw new DomainError("VERSION_CONFLICT", "merchant returned conflicting checkouts; reconciliation required");
        return data.checkout === null ? { ...data, checkout: json(result) } : null;
      });
    }
    return this.get(actor, id);
  }

  async assertIntent(actor: ActorContext, checkoutId: string, intent: { orderId: string; amountMinor: number; currency: string }) {
    const record = await this.load(actor, checkoutId), checkout = record.data.checkout as JsonObject | null, scope = record.data.scope as JsonObject;
    if (!checkout || intent.orderId !== checkout.orderId || intent.amountMinor !== scope.amountMinor || intent.currency !== scope.currency) throw new DomainError("DEPENDENCY_UNAVAILABLE", "payment intent differs from the purchased bundle");
  }

  private async refreshPayment(actor: ActorContext, id: string) {
    const record = await this.load(actor, id), checkout = record.data.checkout as JsonObject | null, scope = record.data.scope as JsonObject;
    if (!this.payments || !checkout) throw new DomainError("EXTERNAL_ADAPTER_UNAVAILABLE", "photo purchase has no prepared merchant checkout");
    const payment = await this.payments.getPayment({ ...actor, purpose: "commerce" }, { orderId: checkout.orderId as string, requestId: actor.requestId });
    if (payment.schemaVersion !== "ltm.wechat.payment-projection.v1" || payment.checkoutId !== id || payment.orderId !== checkout.orderId || payment.amountMinor !== scope.amountMinor || payment.currency !== scope.currency) throw new DomainError("DEPENDENCY_UNAVAILABLE", "verified payment does not match purchase");
    if (!["pending", "paid", "closed", "refunded", "failed"].includes(payment.state)) throw new DomainError("DEPENDENCY_UNAVAILABLE", "unknown verified payment state");
    await this.change(actor, id, "payment-state", data => data.paymentState === payment.state ? null : { ...data, paymentState: payment.state });
    if (payment.state !== "paid") return this.load(actor, id);
    if (!identifier(payment.providerTransactionReference)) throw new DomainError("DEPENDENCY_UNAVAILABLE", "paid projection has no trusted provider transaction reference");
    return this.change(actor, id, "paid", data => data.paymentProof === null ? { ...data, paymentProof: json({ orderId: payment.orderId, reference: payment.providerTransactionReference, updatedAt: payment.updatedAt }) } : null);
  }

  async confirm(actor: ActorContext, id: string) {
    await this.refreshPayment(actor, id);
    return this.get(actor, id);
  }

  private async paid(actor: ActorContext, id: string) {
    const record = await this.refreshPayment(actor, id);
    if (record.data.paymentState !== "paid" || !record.data.paymentProof) throw new DomainError("VERSION_CONFLICT", "payment has not been confirmed; generation has not started");
    return record;
  }

  async fulfill(actor: ActorContext, id: string) {
    const record = await this.paid(actor, id), scope = record.data.scope as JsonObject, request = record.data.request as JsonObject;
    await this.bindCommands(actor, record);
    const keys = scope.sku === "wardrobe-series" ? scope.styleIds as string[] : ["age"];
    for (const item of keys) {
      const current = await this.load(actor, id);
      if ((current.data.commands as JsonObject)[item]) continue;
      let commandId: string;
      if (scope.sku === "wardrobe-series") {
        const wardrobe = new WardrobeService(this.runtime, this.registry, this.artifacts);
        const context = await wardrobe.context(actor, request.sourceRootCommandId as string, request.targetAge as number);
        if (context.sourceNode.asset!.sha256 !== request.sourceSha256 || JSON.stringify(context.participants.map(p => p.participantId)) !== JSON.stringify(request.participantIds)) throw new DomainError("VERSION_CONFLICT", "purchased wardrobe source changed");
        commandId = (await wardrobe.create(actor, request.sourceRootCommandId as string, request.targetAge as number,
          { selections: context.participants.map(p => ({ participantId: p.participantId, styleId: item })) }, `${id}:${item}`)).commandId;
      } else {
        const value = await this.registry.execute(this.runtime, "B14", { actor, idempotencyKey: `${id}:age`, input: { ...request, jobId: `${id}:age` } });
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.externalCommandId !== "string") throw new DomainError("DEPENDENCY_UNAVAILABLE", "invalid generation command receipt");
        commandId = value.externalCommandId;
      }
      await this.change(actor, id, `item:${item}`, data => (data.commands as JsonObject)[item] ? null : { ...data, commands: { ...data.commands as JsonObject, [item]: commandId } });
    }
    return this.get(actor, id);
  }

  async get(actor: ActorContext, id: string) {
    const record = await this.load(actor, id), scope = record.data.scope as JsonObject, request = record.data.request as JsonObject, commands = record.data.commands as JsonObject;
    const specs = scope.sku === "wardrobe-series" ? (scope.styles as JsonObject[]).map(s => ({ itemId: s.id as string, title: s.title as string, age: request.targetAge as number, key: s.id as string })) :
      (scope.targetAges as number[]).map(age => ({ itemId: `age-${age}`, title: `${age} 岁`, age, key: "age" }));
    const views = new Map<string, Awaited<ReturnType<TimelineDeliveryService["get"]>>>();
    for (const command of new Set(Object.values(commands))) {
      if (typeof command !== "string") throw new DomainError("DEPENDENCY_UNAVAILABLE", "invalid purchased command binding");
      views.set(command, await new TimelineDeliveryService(this.runtime).get(actor, command));
    }
    const items = specs.map(spec => {
      const commandId = commands[spec.key] as string | undefined, view = commandId ? views.get(commandId) : undefined, node = view?.nodes.find(n => n.targetAge === spec.age);
      return { itemId: spec.itemId, title: spec.title, commandId: commandId ?? null, targetAge: spec.age, status: node?.status ?? (record.data.paymentProof ? "unsubmitted" : "awaiting_payment"),
        attempts: node?.attempts ?? 0, canRetry: node?.canRetry ?? false, errorCode: node?.errorCode ?? null, ...(node?.asset ? { asset: node.asset } : {}),
        downloadPath: node?.status === "ready" ? `/v1/timelines/${encodeURIComponent(commandId!)}/nodes/${spec.age}/image` : null };
    });
    const readyCount = items.filter(i => i.status === "ready").length;
    return { schemaVersion: "ltm.photo-purchase.v1", purchaseId: id, sku: scope.sku, title: scope.title, priceVersion: scope.priceVersion,
      amountMinor: scope.amountMinor, currency: "CNY", expectedCount: scope.imageCount, seriesId: scope.seriesId ?? null, seriesTitle: scope.seriesTitle ?? null,
      sourceRootCommandId: request.sourceRootCommandId ?? null,
      scopeSha256: record.data.scopeSha256, checkout: record.data.checkout, paymentState: record.data.paymentState, commandId: commands.age ?? null,
      state: ["closed", "refunded", "failed"].includes(record.data.paymentState as string) ? record.data.paymentState : !record.data.paymentProof ? "awaiting_payment" : readyCount === specs.length ? "ready" : readyCount > 0 ? "partial" : items.some(i => ["unsubmitted", "pending", "retrying"].includes(i.status)) ? "processing" : "blocked",
      readyCount, items };
  }

  async retry(actor: ActorContext, id: string, itemId: string, attempt: number) {
    await this.paid(actor, id);
    const view = await this.get(actor, id), item = view.items.find(i => i.itemId === itemId);
    if (!item?.commandId) throw new DomainError("VALIDATION_FAILED", "purchased item has no submitted command");
    return new TimelineDeliveryService(this.runtime).retry(actor, item.commandId, item.targetAge, attempt);
  }
}
