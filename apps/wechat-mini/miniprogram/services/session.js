let current = null;
const privateUrls = new Set();
const SESSION_KEYS = ["accessToken", "expiresAt", "tenantId", "actorId", "roles", "purpose"];
const PROJECTION_KEYS = ["actorId", "tenantId", "roles", "purpose", "stepUp", "guardianVerified", "authenticationState"];
const ALLOWED_ROLES = new Set([
  "consumer", "household_admin", "guardian", "partner_employee", "partner_admin", "studio_operator",
  "support_agent", "moderator", "privacy_officer", "finance_operator", "platform_admin", "auditor", "service_account",
]);

function set(value) {
  if (!isExactObject(value, SESSION_KEYS) || !Array.isArray(value.roles) || value.roles.length < 1 || value.roles.length > 20 ||
      new Set(value.roles).size !== value.roles.length || value.roles.some((role) => !ALLOWED_ROLES.has(role)) ||
      !identifier(value.tenantId) || !identifier(value.actorId) ||
      Date.parse(value.expiresAt) <= Date.now() || Date.parse(value.expiresAt) > Date.now() + 24 * 60 * 60 * 1000 ||
      /[\u0000-\u001f\u007f]/.test(value.accessToken) || /[\u0000-\u001f\u007f]/.test(value.purpose)) {
    throw new Error("INVALID_SESSION");
  }
  if (!value || typeof value.accessToken !== "string" || value.accessToken.length < 20 ||
      typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) ||
      typeof value.tenantId !== "string" || typeof value.actorId !== "string" ||
      typeof value.purpose !== "string" || value.purpose.length < 1 || value.purpose.length > 120) {
    throw new Error("INVALID_SESSION");
  }
  current = Object.freeze({
    accessToken: value.accessToken,
    expiresAt: value.expiresAt,
    tenantId: value.tenantId,
    actorId: value.actorId,
    roles: Array.isArray(value.roles) ? Object.freeze([...value.roles]) : Object.freeze([]),
    purpose: value.purpose,
  });
  getApp().globalData.session = current;
  return current;
}

function bindServerProjection(candidate, response) {
  const projection = response && response.session;
  if (!isExactObject(response, ["session", "requestId"]) || !isExactObject(projection, PROJECTION_KEYS) ||
      projection.authenticationState !== "server_verified" || typeof projection.stepUp !== "boolean" ||
      typeof projection.guardianVerified !== "boolean" || !identifier(response.requestId) ||
      projection.actorId !== candidate.actorId || projection.tenantId !== candidate.tenantId ||
      projection.purpose !== candidate.purpose || !sameRoles(projection.roles, candidate.roles)) {
    throw new Error("SESSION_PROJECTION_MISMATCH");
  }
  return set(candidate);
}

function isExactObject(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function sameRoles(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    new Set(left).size === left.length && left.every((role) => ALLOWED_ROLES.has(role) && right.includes(role));
}

function get() {
  if (!current || Date.parse(current.expiresAt) <= Date.now() + 30_000) return null;
  return current;
}

function requireSession() {
  const value = get();
  if (!value) throw new Error("AUTHENTICATION_REQUIRED");
  return value;
}

function clear() {
  current = null;
  try { getApp().globalData.session = null; } catch {}
  clearPrivateUrls();
  wx.removeStorageSync("ltm-session");
  wx.removeStorageSync("ltm-token");
}

function trackPrivateUrl(url) {
  if (typeof url === "string" && /^https:\/\//.test(url)) privateUrls.add(url);
}

function clearPrivateUrls() {
  privateUrls.clear();
}

module.exports = { set, bindServerProjection, get, requireSession, clear, trackPrivateUrl, clearPrivateUrls };
