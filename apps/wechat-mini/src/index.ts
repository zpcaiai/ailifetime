import { createHmac, timingSafeEqual } from "node:crypto";

export interface WechatPaymentCallback {
  eventId: string;
  transactionId: string;
  merchantOrderId: string;
  status: "SUCCESS" | "CLOSED" | "REFUND";
  amountMinor: number;
  currency: "CNY";
  occurredAt: string;
}

export function verifyWechatCallback(rawBody: Uint8Array, signatureHex: string, secret: string): boolean {
  if (secret.length < 16 || !/^[a-f0-9]{64}$/.test(signatureHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const supplied = Buffer.from(signatureHex, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function normalizeWechatPaymentCallback(value: unknown): WechatPaymentCallback {
  if (!value || typeof value !== "object") throw new Error("payment callback must be an object");
  const item = value as Partial<WechatPaymentCallback>;
  if (!item.eventId || !item.transactionId || !item.merchantOrderId || !item.occurredAt) throw new Error("payment callback identifiers are required");
  if (!new Set(["SUCCESS", "CLOSED", "REFUND"]).has(item.status ?? "")) throw new Error("payment callback status is unsupported");
  if (!Number.isSafeInteger(item.amountMinor) || (item.amountMinor ?? 0) <= 0 || item.currency !== "CNY") throw new Error("payment callback amount is invalid");
  if (Number.isNaN(Date.parse(item.occurredAt))) throw new Error("payment callback time is invalid");
  return item as WechatPaymentCallback;
}

export function createWechatShareCard(input: { workId: string; title: string; containsMinor: boolean; publicConsent: boolean }): { path: string; title: string; aiLabel: string; indexable: false } {
  if (!input.workId || !input.title) throw new Error("share card fields are required");
  if (input.containsMinor && !input.publicConsent) throw new Error("minor work cannot be shared without explicit public consent");
  return {
    path: `/pages/work/index?id=${encodeURIComponent(input.workId)}`,
    title: `${input.title} · AI 艺术化示意`,
    aiLabel: "AI_GENERATED_ILLUSTRATION",
    indexable: false,
  };
}

export function serviceMessageEligibility(input: { serviceConsent: boolean; suppressed: boolean; quietHours: boolean; templateApproved: boolean }): boolean {
  return input.serviceConsent && !input.suppressed && !input.quietHours && input.templateApproved;
}
