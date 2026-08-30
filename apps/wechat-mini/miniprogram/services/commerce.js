const api = require("./api");

const activeCheckouts = new Set();
const intentsByOrder = new Map();

async function requestPayment(input) {
  const expected = validateCheckoutInput(input);
  if (activeCheckouts.has(expected.checkoutId)) throw new Error("PAYMENT_ALREADY_IN_PROGRESS");
  activeCheckouts.add(expected.checkoutId);
  try {
    const response = await api.requestForPurpose("/v1/wechat/payments", "commerce", {
      data: { checkoutId: expected.checkoutId },
      headers: { "Idempotency-Key": api.idempotencyKey("wechat-pay") },
    });
    const intent = validatePaymentIntent(response && response.data, expected);
    intentsByOrder.set(intent.orderId, intent);
    await nativePayment(intent.parameters);
    return Object.freeze({
      state: "native_payment_accepted_pending_server_verification",
      checkoutId: intent.checkoutId,
      orderId: intent.orderId,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
    });
  } finally { activeCheckouts.delete(expected.checkoutId); }
}

async function projectPayment(orderIdValue) {
  const orderId = requireIdentifier(orderIdValue, "PAYMENT_ORDER_INVALID");
  const expected = intentsByOrder.get(orderId);
  if (!expected) throw new Error("PAYMENT_INTENT_NOT_IN_SESSION");
  const response = await api.requestForPurpose(`/v1/wechat/payments/${orderId}`, "commerce", { method: "GET" });
  return validateProjection(response && response.data, expected);
}

async function waitForTerminal(orderId, options = {}) {
  const attempts = options.attempts === undefined ? 12 : options.attempts;
  const intervalMs = options.intervalMs === undefined ? 1500 : options.intervalMs;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 40 || !Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 5000) {
    throw new Error("PAYMENT_POLL_POLICY_INVALID");
  }
  let projection;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    projection = await projectPayment(orderId);
    if (projection.state !== "pending") return projection;
    if (attempt + 1 < attempts) await delay(intervalMs);
  }
  return projection;
}

function nativePayment(parameters) {
  return new Promise((resolve, reject) => wx.requestPayment({
    timeStamp: parameters.timeStamp,
    nonceStr: parameters.nonceStr,
    package: parameters.package,
    signType: parameters.signType,
    paySign: parameters.paySign,
    success: () => resolve(),
    fail: (failure) => {
      const message = failure && typeof failure.errMsg === "string" ? failure.errMsg : "requestPayment:fail";
      reject(new Error(message.includes("cancel") ? "PAYMENT_USER_CANCELLED" : "PAYMENT_NATIVE_FAILED"));
    },
  }));
}

function validateCheckoutInput(value) {
  if (!exact(value, ["checkoutId"])) throw new Error("PAYMENT_CHECKOUT_INVALID");
  return { checkoutId: requireIdentifier(value.checkoutId, "PAYMENT_CHECKOUT_INVALID") };
}

function validatePaymentIntent(value, expected) {
  const keys = ["schemaVersion", "checkoutId", "orderId", "amountMinor", "currency", "expiresAt", "parameters"];
  const parameterKeys = ["timeStamp", "nonceStr", "package", "signType", "paySign"];
  const parameters = value && value.parameters;
  if (!exact(value, keys) || !exact(parameters, parameterKeys) || value.schemaVersion !== "ltm.wechat.payment-intent.v1" ||
      value.checkoutId !== expected.checkoutId || !identifier(value.orderId) ||
      !Number.isSafeInteger(value.amountMinor) || value.amountMinor < 1 || value.amountMinor > 100_000_000 || value.currency !== "CNY" ||
      typeof parameters.timeStamp !== "string" || !/^\d{10}$/.test(parameters.timeStamp) || !identifier(parameters.nonceStr) ||
      typeof parameters.package !== "string" || !/^prepay_id=[A-Za-z0-9_-]{8,128}$/.test(parameters.package) || parameters.signType !== "RSA" ||
      typeof parameters.paySign !== "string" || !/^[A-Za-z0-9+/=_-]{64,1024}$/.test(parameters.paySign) ||
      !isExactUtcTimestamp(value.expiresAt) || Date.parse(value.expiresAt) <= Date.now() || Date.parse(value.expiresAt) > Date.now() + 15 * 60 * 1000) {
    throw new Error("PAYMENT_INTENT_INVALID");
  }
  return Object.freeze({ ...value, parameters: Object.freeze({ ...parameters }) });
}

function validateProjection(value, expected) {
  const keys = ["schemaVersion", "checkoutId", "orderId", "amountMinor", "currency", "state", "version", "updatedAt", "providerTransactionReference"];
  const withProviderReference = value && (value.state === "paid" || value.state === "refunded");
  if (!exact(value, keys) || value.schemaVersion !== "ltm.wechat.payment-projection.v1" || value.checkoutId !== expected.checkoutId ||
      value.orderId !== expected.orderId || value.amountMinor !== expected.amountMinor || value.currency !== expected.currency ||
      !["pending", "paid", "closed", "refunded", "failed"].includes(value.state) ||
      !Number.isSafeInteger(value.version) || value.version < 1 || !isExactUtcTimestamp(value.updatedAt) ||
      (withProviderReference ? !identifier(value.providerTransactionReference) : value.providerTransactionReference !== null)) {
    throw new Error("PAYMENT_PROJECTION_INVALID");
  }
  return Object.freeze({ ...value });
}

function clear() { activeCheckouts.clear(); intentsByOrder.clear(); }
function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function requireIdentifier(value, code) { if (!identifier(value)) throw new Error(code); return value; }
function identifier(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(value); }
function exact(value, keys) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(","); }
function isExactUtcTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === (value.includes(".") ? value : value.replace(/Z$/, ".000Z"));
}

module.exports = { requestPayment, projectPayment, waitForTerminal, validatePaymentIntent, validateProjection, clear };
