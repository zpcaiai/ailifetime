const api = require("./api");

async function loadSubscriptionOffer() {
  const response = await api.requestForPurpose("/v1/wechat/subscription-offer", "notifications", { method: "GET" });
  return validateOffer(response && response.data);
}

async function requestSubscriptions(offerValue) {
  const offer = validateOffer(offerValue);
  const native = await new Promise((resolve, reject) => wx.requestSubscribeMessage({ tmplIds: [...offer.templateIds], success: resolve, fail: reject }));
  const acceptedTemplateIds = offer.templateIds.filter((templateId) => native && native[templateId] === "accept");
  if (acceptedTemplateIds.length === 0) return Object.freeze({ state: "not_authorized", authorizationReferences: Object.freeze([]) });
  const response = await api.requestForPurpose("/v1/wechat/subscription-authorizations", "notifications", {
    data: { offerId: offer.offerId, revision: offer.revision, acceptedTemplateIds },
    headers: { "Idempotency-Key": api.idempotencyKey("wechat-subscribe") },
  });
  const value = response && response.data;
  if (!exact(value, ["schemaVersion", "offerId", "revision", "state", "authorizationReferences"]) ||
      value.schemaVersion !== "ltm.wechat.subscription-authorization.v1" || value.offerId !== offer.offerId || value.revision !== offer.revision ||
      value.state !== "server_recorded" || !Array.isArray(value.authorizationReferences) ||
      value.authorizationReferences.length !== acceptedTemplateIds.length || value.authorizationReferences.some((entry) => !identifier(entry))) {
    throw new Error("SUBSCRIPTION_AUTHORIZATION_INVALID");
  }
  return Object.freeze({ state: value.state, authorizationReferences: Object.freeze([...value.authorizationReferences]) });
}

async function openCustomerService() {
  const response = await api.requestForPurpose("/v1/wechat/customer-service-grants", "customer_support", {
    data: {},
    headers: { "Idempotency-Key": api.idempotencyKey("wechat-customer-service") },
  });
  const grant = validateCustomerServiceGrant(response && response.data);
  await new Promise((resolve, reject) => wx.openCustomerServiceChat({ corpId: grant.corpId, extInfo: { url: grant.extInfoUrl }, success: resolve, fail: reject }));
  return Object.freeze({ state: "customer_service_opened", ticketId: grant.ticketId });
}

async function submitMinimalTicket(input) {
  if (!exact(input, ["category", "message"]) || !["billing", "privacy", "generation", "account"].includes(input.category) ||
      typeof input.message !== "string" || input.message !== input.message.trim() || input.message.length < 5 || input.message.length > 1000 || /(?:Bearer\s|https?:\/\/|file:|wxid_)/i.test(input.message)) {
    throw new Error("SUPPORT_TICKET_INPUT_INVALID");
  }
  const response = await api.requestForPurpose("/v1/commands", "customer_support", {
    data: { command: "support-ticket.create", input: { ...input, attachmentReferences: [], privacySensitive: false } },
    headers: { "Idempotency-Key": api.idempotencyKey("support-ticket") },
  });
  const value = response && response.data;
  if (!exact(value, ["ticketId", "state"]) || !identifier(value.ticketId) || value.state !== "queued") throw new Error("SUPPORT_TICKET_RESPONSE_INVALID");
  return Object.freeze({ ...value });
}

function validateOffer(value) {
  if (!exact(value, ["schemaVersion", "offerId", "revision", "templateIds", "expiresAt"]) || value.schemaVersion !== "ltm.wechat.subscription-offer.v1" ||
      !identifier(value.offerId) || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.templateIds) || value.templateIds.length < 1 || value.templateIds.length > 3 ||
      new Set(value.templateIds).size !== value.templateIds.length || value.templateIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{20,80}$/.test(id)) ||
      typeof value.expiresAt !== "string" || Date.parse(value.expiresAt) <= Date.now() || Date.parse(value.expiresAt) > Date.now() + 24 * 60 * 60 * 1000) {
    throw new Error("SUBSCRIPTION_OFFER_INVALID");
  }
  return Object.freeze({ ...value, templateIds: Object.freeze([...value.templateIds]) });
}

function validateCustomerServiceGrant(value) {
  if (!exact(value, ["schemaVersion", "corpId", "extInfoUrl", "ticketId", "expiresAt"]) || value.schemaVersion !== "ltm.wechat.customer-service-grant.v1" ||
      typeof value.corpId !== "string" || !/^ww[0-9a-f]{16}$/.test(value.corpId) || !identifier(value.ticketId) ||
      typeof value.expiresAt !== "string" || Date.parse(value.expiresAt) <= Date.now() || Date.parse(value.expiresAt) > Date.now() + 10 * 60 * 1000 || !safeServiceUrl(value.extInfoUrl)) {
    throw new Error("CUSTOMER_SERVICE_GRANT_INVALID");
  }
  return Object.freeze({ ...value });
}

function safeServiceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && url.pathname.length < 512 &&
      /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname);
  } catch { return false; }
}
function identifier(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$/.test(value); }
function exact(value, keys) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(","); }

module.exports = { loadSubscriptionOffer, requestSubscriptions, openCustomerService, submitMinimalTicket, validateOffer, validateCustomerServiceGrant };
