/**
 * Client-side WeChat boundary.
 *
 * Merchant signatures, API-v3 keys, payment notifications and entitlement
 * decisions intentionally do not exist in this package. They belong to the
 * server integration gateway. A successful `requestPayment` call is only a UI
 * signal; the server projection remains the commercial source of truth.
 */

export interface WechatNativePaymentParameters {
  readonly timeStamp: string;
  readonly nonceStr: string;
  readonly package: string;
  readonly signType: "RSA";
  readonly paySign: string;
}

export interface WechatPaymentIntent {
  readonly orderId: string;
  readonly checkoutId: string;
  readonly amountMinor: number;
  readonly currency: "CNY";
  readonly expiresAt: string;
  readonly parameters: WechatNativePaymentParameters;
}

export type WechatPaymentState = "pending" | "paid" | "closed" | "refunded" | "failed";

export interface WechatPaymentProjection {
  readonly orderId: string;
  readonly checkoutId: string;
  readonly amountMinor: number;
  readonly currency: "CNY";
  readonly state: WechatPaymentState;
  readonly version: number;
  readonly updatedAt: string;
  readonly providerTransactionReference?: string;
}

export interface WechatCommerceApi {
  createPaymentIntent(input: {
    readonly checkoutId: string;
    readonly idempotencyKey: string;
  }): Promise<WechatPaymentIntent>;
  getPaymentProjection(orderId: string): Promise<WechatPaymentProjection>;
}

export interface WechatNativeBridge {
  requestPayment(parameters: WechatNativePaymentParameters): Promise<void>;
}

export interface WechatPaymentStartResult {
  readonly orderId: string;
  /** Never means paid. It only records that the native sheet resolved. */
  readonly clientSignal: "native_sheet_resolved";
  readonly state: "verification_pending";
}

export class WechatPaymentCoordinator {
  readonly #intents = new Map<string, WechatPaymentIntent>();

  constructor(
    private readonly api: WechatCommerceApi,
    private readonly bridge: WechatNativeBridge,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async start(checkoutIdValue: string, idempotencyKeyValue: string): Promise<WechatPaymentStartResult> {
    const checkoutId = identifier(checkoutIdValue, "checkoutId");
    const idempotencyKey = identifier(idempotencyKeyValue, "idempotencyKey");
    const intent = validateIntent(await this.api.createPaymentIntent({ checkoutId, idempotencyKey }));
    if (intent.checkoutId !== checkoutId) throw new Error("payment intent checkout binding is invalid");
    if (Date.parse(intent.expiresAt) <= this.clock().getTime()) throw new Error("payment intent has expired");
    this.#intents.set(intent.orderId, structuredClone(intent));
    await this.bridge.requestPayment(intent.parameters);
    return { orderId: intent.orderId, clientSignal: "native_sheet_resolved", state: "verification_pending" };
  }

  async refresh(orderIdValue: string): Promise<WechatPaymentProjection> {
    const orderId = identifier(orderIdValue, "orderId");
    const intent = this.#intents.get(orderId);
    if (intent === undefined) throw new Error("payment intent is not known to this session");
    const projection = validateProjection(await this.api.getPaymentProjection(orderId));
    if (
      projection.orderId !== intent.orderId ||
      projection.checkoutId !== intent.checkoutId ||
      projection.amountMinor !== intent.amountMinor ||
      projection.currency !== intent.currency
    ) {
      throw new Error("server payment projection does not match the original intent");
    }
    return projection;
  }
}

export interface ServerShareGrant {
  readonly grantId: string;
  /** Opaque, server-issued path. It must not expose a work, tenant or actor ID. */
  readonly path: string;
  readonly title: string;
  readonly aiLabel: "AI_GENERATED_ILLUSTRATION";
  readonly expiresAt: string;
  readonly indexable: false;
}

export function createWechatShareCard(
  grant: ServerShareGrant,
  now: Date = new Date(),
): {
  readonly path: string;
  readonly title: string;
  readonly aiLabel: "AI_GENERATED_ILLUSTRATION";
  readonly indexable: false;
} {
  identifier(grant.grantId, "grantId");
  if (grant.title.trim() === "" || grant.title.length > 80) throw new Error("share title is invalid");
  if (grant.aiLabel !== "AI_GENERATED_ILLUSTRATION" || grant.indexable !== false) {
    throw new Error("share disclosure policy is invalid");
  }
  const match = /^\/pages\/share\/index\?grant=([A-Za-z0-9_-]{24,256})$/.exec(grant.path);
  if (match === null || match[1] !== grant.grantId) throw new Error("share path is not an opaque server grant");
  if (!isIsoTimestamp(grant.expiresAt) || Date.parse(grant.expiresAt) <= now.getTime()) {
    throw new Error("share grant has expired");
  }
  return { path: grant.path, title: grant.title, aiLabel: grant.aiLabel, indexable: false };
}

export interface ServerMessageAuthorization {
  readonly authorizationId: string;
  readonly templateId: string;
  readonly channel: "wechat";
  readonly status: "authorized";
  readonly remainingUses: number;
  readonly expiresAt: string;
}

/** Returns only an opaque authorization reference; eligibility is rechecked by the server. */
export function createServiceMessageRequest(
  authorization: ServerMessageAuthorization,
  now: Date = new Date(),
): { readonly authorizationId: string; readonly templateId: string } {
  const authorizationId = identifier(authorization.authorizationId, "authorizationId");
  const templateId = identifier(authorization.templateId, "templateId");
  if (authorization.channel !== "wechat" || authorization.status !== "authorized") {
    throw new Error("service message authorization is invalid");
  }
  if (!Number.isSafeInteger(authorization.remainingUses) || authorization.remainingUses < 1) {
    throw new Error("service message authorization has no remaining use");
  }
  if (!isIsoTimestamp(authorization.expiresAt) || Date.parse(authorization.expiresAt) <= now.getTime()) {
    throw new Error("service message authorization has expired");
  }
  return { authorizationId, templateId };
}

function validateIntent(value: WechatPaymentIntent): WechatPaymentIntent {
  identifier(value.orderId, "orderId");
  identifier(value.checkoutId, "checkoutId");
  positiveMoney(value.amountMinor, value.currency);
  if (!isIsoTimestamp(value.expiresAt)) throw new Error("payment intent expiry is invalid");
  const parameters = value.parameters;
  if (
    !/^\d{10,13}$/.test(parameters.timeStamp) ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(parameters.nonceStr) ||
    !/^prepay_id=[A-Za-z0-9_-]{8,256}$/.test(parameters.package) ||
    parameters.signType !== "RSA" ||
    !/^[A-Za-z0-9+/=_-]{80,1024}$/.test(parameters.paySign)
  ) {
    throw new Error("native payment parameters are invalid");
  }
  return structuredClone(value);
}

function validateProjection(value: WechatPaymentProjection): WechatPaymentProjection {
  identifier(value.orderId, "orderId");
  identifier(value.checkoutId, "checkoutId");
  positiveMoney(value.amountMinor, value.currency);
  if (!new Set<WechatPaymentState>(["pending", "paid", "closed", "refunded", "failed"]).has(value.state)) {
    throw new Error("payment state is invalid");
  }
  if (!Number.isSafeInteger(value.version) || value.version < 1 || !isIsoTimestamp(value.updatedAt)) {
    throw new Error("payment projection version or timestamp is invalid");
  }
  if (value.providerTransactionReference !== undefined) identifier(value.providerTransactionReference, "providerTransactionReference");
  return structuredClone(value);
}

function positiveMoney(amountMinor: number, currency: string): void {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 1 || currency !== "CNY") {
    throw new Error("payment amount is invalid");
  }
}

function identifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(normalized)) throw new Error(`${field} is invalid`);
  return normalized;
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}
