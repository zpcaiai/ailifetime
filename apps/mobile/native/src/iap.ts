import * as Crypto from "expo-crypto";
import {
  endConnection,
  fetchProducts,
  finishTransaction,
  initConnection,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
  type Product,
  type Purchase,
} from "expo-iap";

export interface StorePurchaseVerificationPort {
  verify(input: {
    readonly store: Purchase["store"];
    readonly productId: string;
    readonly transactionReference: string;
    readonly purchaseToken: string;
    readonly quantity: number;
    readonly transactionDate: number;
    readonly idempotencyKey: string;
  }): Promise<{ readonly state: "verified" | "pending" | "rejected" }>;
}

export class StorePurchaseCoordinator {
  #products = new Map<string, Product>();
  #processing = new Set<string>();
  #subscriptions: Array<{ remove(): void }> = [];

  constructor(private readonly verifier: StorePurchaseVerificationPort, private readonly allowedProducts: readonly string[]) {
    if (allowedProducts.length < 1 || allowedProducts.length > 32 || new Set(allowedProducts).size !== allowedProducts.length ||
        allowedProducts.some((product) => !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(product))) throw new Error("IAP_PRODUCT_ALLOWLIST_INVALID");
  }

  async connect(onPending: (productId: string) => void, onError: (code: string) => void): Promise<void> {
    if (!(await initConnection())) throw new Error("IAP_CONNECTION_FAILED");
    const products = await fetchProducts({ skus: [...this.allowedProducts], type: "in-app" });
    for (const product of products ?? []) if (product.type === "in-app" && this.allowedProducts.includes(product.id)) this.#products.set(product.id, product);
    this.#subscriptions.push(
      purchaseUpdatedListener((purchase) => { void this.verify(purchase).then(() => onPending(purchase.productId)).catch(() => onError("IAP_SERVER_VERIFICATION_FAILED")); }),
      purchaseErrorListener((error) => onError(typeof error.code === "string" ? error.code : "IAP_PURCHASE_FAILED")),
    );
  }

  async purchase(productId: string): Promise<void> {
    if (!this.allowedProducts.includes(productId) || !this.#products.has(productId)) throw new Error("IAP_PRODUCT_UNAVAILABLE");
    // The return value is intentionally ignored: only the listener plus server verification can grant access.
    await requestPurchase({ request: { apple: { sku: productId, andDangerouslyFinishTransactionAutomatically: false }, google: { skus: [productId] } }, type: "in-app" });
  }

  async disconnect(): Promise<void> {
    for (const subscription of this.#subscriptions.splice(0)) subscription.remove();
    this.#products.clear();
    await endConnection();
  }

  private async verify(purchase: Purchase): Promise<void> {
    const transactionReference = purchase.transactionId ?? purchase.id;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,511}$/.test(transactionReference) || !this.allowedProducts.includes(purchase.productId) ||
        typeof purchase.purchaseToken !== "string" || purchase.purchaseToken.length < 20 || purchase.purchaseToken.length > 32_768) {
      throw new Error("IAP_PURCHASE_PAYLOAD_INVALID");
    }
    if (this.#processing.has(transactionReference)) return;
    this.#processing.add(transactionReference);
    try {
      const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${purchase.store}:${transactionReference}`);
      // The verifier must perform Apple JWS/x5c or Google Android Publisher
      // verification server-to-server. Without a production implementation the
      // coordinator cannot be constructed, and no transaction is acknowledged.
      const result = await this.verifier.verify({
        store: purchase.store, productId: purchase.productId, transactionReference,
        purchaseToken: purchase.purchaseToken, quantity: purchase.quantity, transactionDate: purchase.transactionDate,
        idempotencyKey: `iap-verify:${digest}`,
      });
      if (!plain(result) || (result.state !== "verified" && result.state !== "pending" && result.state !== "rejected")) {
        throw new Error("IAP_VERIFICATION_RESPONSE_INVALID");
      }
      if (result.state === "verified") await finishTransaction({ purchase, isConsumable: false });
      if (result.state === "rejected") throw new Error("IAP_RECEIPT_REJECTED");
    } finally { this.#processing.delete(transactionReference); }
  }
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
