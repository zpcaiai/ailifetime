import { parseJsonObject, ProductionIntegrationError, requiredString, sha256 } from "./production-common.js";
import { SignedPartnerCommandAdapter } from "./partner-protocol.js";

export interface TrustedAccountBinding {
  readonly tenantId: string;
  readonly accountId: string;
}

export interface TrustedWechatOrderBinding extends TrustedAccountBinding {
  /** Stable internal payment aggregate ID; never derived from callback URL/query/header. */
  readonly paymentId: string;
  readonly expectedAmountMinor: number;
  readonly expectedCurrency: string;
}

export interface TrustedGoogleVoidedPurchaseBinding extends TrustedAccountBinding {
  readonly productId: string;
  readonly purchaseType: "product" | "subscription";
  readonly expectedObfuscatedAccountId?: string;
}

/** Server-side commerce ownership lookup. Implementations must never trust callback URL/query/header assertions. */
export interface TrustedCommerceBindingResolver {
  resolveApple(input: {
    readonly transactionId: string;
    readonly originalTransactionId: string;
    readonly productId: string;
    readonly appAccountToken: string | null;
  }): Promise<TrustedAccountBinding>;
  resolveGoogle(input: {
    readonly purchaseTokenSha256: string;
    readonly productId: string;
    readonly purchaseType: "product" | "subscription";
  }): Promise<TrustedAccountBinding & { readonly expectedObfuscatedAccountId?: string }>;
  resolveGoogleVoided(input: {
    readonly purchaseTokenSha256: string;
    readonly orderId: string;
    readonly providerProductType: number;
  }): Promise<TrustedGoogleVoidedPurchaseBinding>;
  resolveWechat(input: {
    readonly merchantId: string;
    readonly outTradeNo: string;
    readonly transactionId: string | null;
  }): Promise<TrustedWechatOrderBinding>;
}

export class TrustedCommerceBindingUnavailableError extends ProductionIntegrationError {
  constructor() {
    super("CONFIGURATION_INVALID", "trusted commerce binding resolver is not configured");
    this.name = "TrustedCommerceBindingUnavailableError";
  }
}

export class FailClosedTrustedCommerceBindingResolver implements TrustedCommerceBindingResolver {
  async resolveApple(_input: Parameters<TrustedCommerceBindingResolver["resolveApple"]>[0]): Promise<TrustedAccountBinding> {
    throw new TrustedCommerceBindingUnavailableError();
  }
  async resolveGoogle(_input: Parameters<TrustedCommerceBindingResolver["resolveGoogle"]>[0]): Promise<TrustedAccountBinding> {
    throw new TrustedCommerceBindingUnavailableError();
  }
  async resolveGoogleVoided(_input: Parameters<TrustedCommerceBindingResolver["resolveGoogleVoided"]>[0]): Promise<TrustedGoogleVoidedPurchaseBinding> {
    throw new TrustedCommerceBindingUnavailableError();
  }
  async resolveWechat(_input: Parameters<TrustedCommerceBindingResolver["resolveWechat"]>[0]): Promise<TrustedWechatOrderBinding> {
    throw new TrustedCommerceBindingUnavailableError();
  }
}

/** Resolves commerce ownership through a mutually authenticated, signed-response internal adapter. */
export class SignedCommerceBindingResolver implements TrustedCommerceBindingResolver {
  constructor(private readonly adapter: SignedPartnerCommandAdapter) {}

  async resolveApple(input: Parameters<TrustedCommerceBindingResolver["resolveApple"]>[0]): Promise<TrustedAccountBinding> {
    const receipt = await this.adapter.send({
      tenantId: "commerce-binding-service",
      batchId: "B66",
      operation: "resolveAppleTransactionBinding",
      idempotencyKey: `apple:${input.transactionId}`,
      payload: { ...input },
    });
    return accountBinding(receipt.artifact, "Apple commerce binding");
  }

  async resolveGoogle(input: Parameters<TrustedCommerceBindingResolver["resolveGoogle"]>[0]): Promise<TrustedAccountBinding & { expectedObfuscatedAccountId?: string }> {
    const receipt = await this.adapter.send({
      tenantId: "commerce-binding-service",
      batchId: "B66",
      operation: "resolveGooglePurchaseBinding",
      idempotencyKey: `google:${input.purchaseTokenSha256}`,
      payload: { ...input },
    });
    const payload = parseJsonObject(receipt.artifact, "Google commerce binding response");
    const binding = accountBindingObject(payload, "Google commerce binding");
    const expected = binding.expectedObfuscatedAccountId;
    return {
      tenantId: requiredString(binding.tenantId, "Google binding tenantId", 128),
      accountId: requiredString(binding.accountId, "Google binding accountId", 128),
      ...(expected === undefined
        ? {}
        : { expectedObfuscatedAccountId: requiredString(expected, "Google binding expectedObfuscatedAccountId", 256) }),
    };
  }

  async resolveGoogleVoided(input: Parameters<TrustedCommerceBindingResolver["resolveGoogleVoided"]>[0]): Promise<TrustedGoogleVoidedPurchaseBinding> {
    const receipt = await this.adapter.send({
      tenantId: "commerce-binding-service",
      batchId: "B66",
      operation: "resolveGoogleVoidedPurchaseBinding",
      idempotencyKey: `google-voided:${input.orderId}`,
      payload: { ...input },
    });
    const payload = parseJsonObject(receipt.artifact, "Google voided purchase binding response");
    const binding = accountBindingObject(payload, "Google voided purchase binding");
    const purchaseType = binding.purchaseType;
    if (purchaseType !== "product" && purchaseType !== "subscription") {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "Google voided binding purchaseType is invalid");
    }
    const expected = binding.expectedObfuscatedAccountId;
    return {
      tenantId: requiredString(binding.tenantId, "Google voided binding tenantId", 128),
      accountId: requiredString(binding.accountId, "Google voided binding accountId", 128),
      productId: requiredString(binding.productId, "Google voided binding productId", 255),
      purchaseType,
      ...(expected === undefined
        ? {}
        : { expectedObfuscatedAccountId: requiredString(expected, "Google voided binding expectedObfuscatedAccountId", 256) }),
    };
  }

  async resolveWechat(input: Parameters<TrustedCommerceBindingResolver["resolveWechat"]>[0]): Promise<TrustedWechatOrderBinding> {
    const receipt = await this.adapter.send({
      tenantId: "commerce-binding-service",
      batchId: "B71",
      operation: "resolveWechatOrderBinding",
      idempotencyKey: `wechat:${sha256(Buffer.from(input.outTradeNo, "utf8"))}`,
      payload: { ...input },
    });
    const payload = parseJsonObject(receipt.artifact, "WeChat commerce binding response");
    const binding = accountBindingObject(payload, "WeChat commerce binding");
    const amount = binding.expectedAmountMinor;
    const currency = requiredString(binding.expectedCurrency, "WeChat binding expectedCurrency", 3);
    if (!Number.isSafeInteger(amount) || (amount as number) <= 0 || !/^[A-Z]{3}$/.test(currency)) {
      throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", "WeChat commerce binding amount/currency is invalid");
    }
    return {
      tenantId: requiredString(binding.tenantId, "WeChat binding tenantId", 128),
      accountId: requiredString(binding.accountId, "WeChat binding accountId", 128),
      paymentId: requiredString(binding.paymentId, "WeChat binding paymentId", 128),
      expectedAmountMinor: amount as number,
      expectedCurrency: currency,
    };
  }
}

function accountBinding(artifact: Uint8Array, label: string): TrustedAccountBinding {
  return accountBindingFromObject(accountBindingObject(parseJsonObject(artifact, `${label} response`), label), label);
}

function accountBindingFromObject(binding: Record<string, unknown>, label: string): TrustedAccountBinding {
  return {
    tenantId: requiredString(binding.tenantId, `${label} tenantId`, 128),
    accountId: requiredString(binding.accountId, `${label} accountId`, 128),
  };
}

function accountBindingObject(payload: Record<string, unknown>, label: string): Record<string, unknown> {
  const value = payload.binding;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProductionIntegrationError("PROVIDER_RESPONSE_INVALID", `${label} response requires a binding object`);
  }
  return value as Record<string, unknown>;
}
