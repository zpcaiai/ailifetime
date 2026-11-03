const api = require("./api");
const session = require("./session");
const commerce = require("./commerce");
const PRICES = Object.freeze({ "lifespan-21": 990, "selected-age": 590, "wardrobe-series": 990 });
const active = new Set();
const validId = value => typeof value === "string" && /^photo-[a-f0-9]{64}$/.test(value);
const money = value => `¥${(value / 100).toFixed(2)}`;

function validate(value, expected) {
  if (!value || value.schemaVersion !== "ltm.photo-purchase.v1" || !validId(value.purchaseId) || !Object.prototype.hasOwnProperty.call(PRICES, value.sku) || value.amountMinor !== PRICES[value.sku] || value.currency !== "CNY" || value.priceVersion !== "photo-retail-cny.v1" ||
      !/^[a-f0-9]{64}$/.test(value.scopeSha256) || !Number.isInteger(value.expectedCount) || value.expectedCount < 1 || (value.sku === "wardrobe-series" ? value.expectedCount > 4 || !["east","retro","together","daily","wedding","milestone","winter","newyear"].includes(value.seriesId) : value.expectedCount !== (value.sku === "lifespan-21" ? 21 : 1)) ||
      !["pending","paid","closed","refunded","failed"].includes(value.paymentState) || !["awaiting_payment","processing","partial","ready","blocked","closed","refunded","failed"].includes(value.state) || !Array.isArray(value.items) || value.items.length !== value.expectedCount || new Set(value.items.map(i => i.itemId)).size !== value.items.length ||
      value.items.some(i => typeof i.itemId !== "string" || !Number.isInteger(i.targetAge) || i.targetAge < 0 || i.targetAge > 100 || !["awaiting_payment","unsubmitted","pending","retrying","ready","failed","review","reconciliation_required"].includes(i.status)) ||
      value.readyCount !== value.items.filter(i => i.status === "ready").length || (value.state === "ready" && value.readyCount !== value.expectedCount)) throw new Error("PHOTO_PURCHASE_INVALID");
  if (value.sku === "lifespan-21" && value.items.some((i,n) => i.targetAge !== n*5)) throw new Error("PHOTO_PURCHASE_SCOPE_CHANGED");
  if (value.sku === "wardrobe-series" && value.items.some(i => !i.itemId.startsWith(value.seriesId + "-") || i.targetAge !== value.items[0].targetAge)) throw new Error("PHOTO_PURCHASE_SCOPE_CHANGED");
  if (value.checkout && (value.checkout.checkoutId !== value.purchaseId || value.checkout.amountMinor !== value.amountMinor || value.checkout.currency !== value.currency || value.checkout.scopeSha256 !== value.scopeSha256)) throw new Error("PHOTO_CHECKOUT_CHANGED");
  if (expected && ["purchaseId","sku","amountMinor","currency","priceVersion","expectedCount","scopeSha256","seriesId"].some(key => value[key] !== expected[key])) throw new Error("PHOTO_PURCHASE_SCOPE_CHANGED");
  return value;
}
async function call(path, data, key) {
  const response = await api.requestForPurpose(path, "age_transformation", data === undefined ? { method: "GET" } : { data, headers: { "Idempotency-Key": key || api.idempotencyKey("photo-order") } });
  return response && response.data;
}
async function create(input, key) { return validate(await call("/v1/photo-purchases", input, key)); }
async function get(id) { if (!validId(id)) throw new Error("PHOTO_PURCHASE_INVALID"); const value = validate(await call(`/v1/photo-purchases/${id}`)); if (value.purchaseId !== id) throw new Error("PHOTO_PURCHASE_SCOPE_CHANGED"); return value; }
async function operation(value, action, data = {}) { return validate(await call(`/v1/photo-purchases/${value.purchaseId}/${action}`, data), value); }
async function listPage(cursor) {
  if (cursor !== undefined && cursor !== null && !validId(cursor)) throw new Error("PHOTO_ORDERS_INVALID");
  const result = await call("/v1/photo-purchases" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""));
  if (!result || !Array.isArray(result.items) || result.items.some(i => !validId(i.purchaseId) || !Object.prototype.hasOwnProperty.call(PRICES,i.sku) || i.amountMinor !== PRICES[i.sku] || i.currency !== "CNY")) throw new Error("PHOTO_ORDERS_INVALID");
  if (result.nextCursor !== null && (!validId(result.nextCursor) || result.nextCursor === cursor || !result.items.length || result.items[result.items.length-1].purchaseId !== result.nextCursor)) throw new Error("PHOTO_ORDERS_INVALID");
  return { items: result.items.map(i => ({ ...i, amountText: money(i.amountMinor) })), nextCursor: result.nextCursor };
}
async function list() { return (await listPage()).items; }
async function execute(value, options = {}) {
  const expected = validate(JSON.parse(JSON.stringify(value))), initial = session.requireSession();
  const owner = { actorId: initial.actorId, tenantId: initial.tenantId };
  const attempts = options.attempts ?? 12, intervalMs = options.intervalMs ?? 1500;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 40 || !Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 5000) throw new Error("PHOTO_PAYMENT_POLL_INVALID");
  function current() {
    const now = session.get();
    if (!now || now.actorId !== owner.actorId || now.tenantId !== owner.tenantId) throw new Error("PHOTO_ACCOUNT_CHANGED");
    if (options.isCurrent && !options.isCurrent()) throw new Error("PHOTO_BACKGROUND_RECOVERY_REQUIRED");
  }
  if (active.has(expected.purchaseId)) throw new Error("PHOTO_PURCHASE_IN_PROGRESS");
  active.add(expected.purchaseId);
  try {
    current();
    if (expected.paymentState !== "paid") {
      const accepted = await new Promise((resolve,reject) => wx.showModal({ title: expected.seriesTitle || expected.title, content: `本单共 ${expected.expectedCount} 张照片，总价 ${money(expected.amountMinor)}。已支付的订单只核对状态，不重复付款。`, confirmText: "确认并继续", success: r => resolve(r.confirm), fail: reject }));
      if (!accepted) throw new Error("PAYMENT_USER_CANCELLED");
    }
    current();let purchase = await operation(expected, "checkout");current();purchase = await operation(purchase, "confirm");current();
    if (purchase.paymentState === "pending") {
      await commerce.requestPayment({ checkoutId: purchase.purchaseId }, intent => {
        current();if (intent.amountMinor !== expected.amountMinor || intent.currency !== expected.currency) throw new Error("PHOTO_PAYMENT_AMOUNT_CHANGED");
      });
      current();
      for (let i=0;i<attempts;i++) {
        purchase = await operation(purchase,"confirm");current();
        if (purchase.paymentState !== "pending") break;
        if (i+1<attempts) await new Promise(resolve=>setTimeout(resolve,intervalMs));
      }
    }
    if (purchase.paymentState === "pending") throw new Error("PHOTO_PAYMENT_CONFIRMATION_PENDING");
    if (purchase.paymentState !== "paid") throw new Error("PHOTO_PAYMENT_NOT_PAID");
    current();return await operation(purchase,"fulfill");
  } finally { active.delete(expected.purchaseId); }
}
async function retry(id, itemId, attempt) {
  if (!validId(id) || typeof itemId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(itemId) || !Number.isInteger(attempt) || attempt < 1 || attempt > 3) throw new Error("PHOTO_RETRY_INVALID");
  await call(`/v1/photo-purchases/${id}/items/${itemId}/retry`, { attempt }); return get(id);
}
function errorText(error) {
  const code = error && error.message || "";
  if (code === "PAYMENT_USER_CANCELLED") return "已取消付款，订单会保留，可以稍后继续。";
  if (code === "PHOTO_PAYMENT_CONFIRMATION_PENDING" || code === "PHOTO_BACKGROUND_RECOVERY_REQUIRED") return "订单已保留，请到「我的订单」核对并继续，避免重复付款。";
  if (/PHOTO_.*CHANGED|PHOTO_.*INVALID/.test(code)) return "订单金额或照片范围未通过核对，请刷新后重试。";
  if (/ADAPTER_UNAVAILABLE|DEPENDENCY_UNAVAILABLE|CONFIGURATION/.test(code)) return "付款服务暂未就绪，请稍后重试；不会开始生成。";
  if (code === "PHOTO_PAYMENT_NOT_PAID") return "此订单未完成付款或已退款，请在订单中查看状态。";
  return "暂时未能完成，已创建的订单会保留；请从「我的订单」继续。";
}
module.exports = { PRICES, money, validate, create, get, list, listPage, execute, retry, errorText };
