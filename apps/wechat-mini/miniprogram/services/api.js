const session = require("./session");

function configuration() {
  const ext = wx.getExtConfigSync ? wx.getExtConfigSync() : {};
  const account = wx.getAccountInfoSync ? wx.getAccountInfoSync() : { miniProgram: { envVersion: "release" } };
  const baseUrl = typeof ext.apiBaseUrl === "string" ? ext.apiBaseUrl.replace(/\/+$/, "") : "";
  const envVersion = account.miniProgram.envVersion;
  if (envVersion === "release") {
    const origin = productionOrigin(baseUrl);
    const allowlist = Array.isArray(ext.apiAllowedOrigins) ? ext.apiAllowedOrigins : [];
    if (allowlist.length < 1 || allowlist.length > 16 ||
        !allowlist.every((entry) => typeof entry === "string" && productionOrigin(entry) === entry) ||
        !allowlist.includes(origin)) {
      throw new Error("PRODUCTION_API_ORIGIN_NOT_ENROLLED");
    }
  } else if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(baseUrl)) {
    throw new Error("DEVELOPMENT_API_CONFIGURATION_INVALID");
  }
  return { baseUrl, appId: account.miniProgram.appId, envVersion };
}

function productionOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("PRODUCTION_API_CONFIGURATION_REQUIRED"); }
  const hostname = parsed.hostname.toLowerCase();
  const reserved = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
    hostname.endsWith(".test") || hostname.endsWith(".example") || hostname.endsWith(".invalid") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" ||
      parsed.search || parsed.hash || reserved || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
    throw new Error("PRODUCTION_API_CONFIGURATION_INVALID");
  }
  return parsed.origin;
}

function publicRequest(path, options = {}) {
  return send(path, options, null);
}

function request(path, options = {}) {
  const authenticatedSession = session.requireSession();
  return send(path, options, authenticatedSession.accessToken, authenticatedSession.purpose);
}

function requestForPurpose(path, purpose, options = {}) {
  if (purpose !== "sharing" && purpose !== "privacy_rights" && purpose !== "age_transformation" &&
      purpose !== "commerce" && purpose !== "notifications" && purpose !== "customer_support") {
    return Promise.reject(new Error("UNSUPPORTED_EXPLICIT_PURPOSE"));
  }
  const authenticatedSession = session.requireSession();
  return send(path, options, authenticatedSession.accessToken, purpose);
}

function send(path, options, accessToken, authenticatedPurpose) {
  if (!/^\/[A-Za-z0-9/_?&=.%:-]*$/.test(path) || path.includes("..")) return Promise.reject(new Error("INVALID_API_PATH"));
  const config = configuration();
  const callerHeaders = safeCallerHeaders(options.headers || {});
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${config.baseUrl}${path}`,
      method: options.method || "POST",
      data: options.data,
      timeout: options.timeout || 15000,
      header: {
        Accept: "application/json",
        ...(options.data === undefined ? {} : { "Content-Type": "application/json" }),
        ...callerHeaders,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(accessToken ? { "X-Purpose": authenticatedPurpose } : {}),
      },
      success(response) {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const code = response.data && response.data.error && typeof response.data.error.code === "string"
            ? response.data.error.code
            : `HTTP_${response.statusCode}`;
          if (response.statusCode === 401) session.clear();
          reject(new Error(code));
          return;
        }
        resolve(response.data);
      },
      fail(error) { reject(new Error(error && error.errMsg ? error.errMsg.split(":", 1)[0] : "NETWORK_UNAVAILABLE")); },
    });
  });
}

function safeCallerHeaders(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_API_HEADERS");
  const result = {};
  for (const [name, headerValue] of Object.entries(value)) {
    const normalized = name.toLowerCase();
    if (["authorization", "x-purpose", "host", "cookie", "origin"].includes(normalized) || normalized.startsWith("x-ltm-")) {
      throw new Error("PROTECTED_API_HEADER");
    }
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || typeof headerValue !== "string" ||
        headerValue.length < 1 || headerValue.length > 8192 || /[\u0000-\u001f\u007f]/.test(headerValue)) {
      throw new Error("INVALID_API_HEADERS");
    }
    result[name] = headerValue;
  }
  return result;
}

function idempotencyKey(prefix) {
  const random = new Uint8Array(16);
  wx.getRandomValues(random);
  const suffix = Array.from(random, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${Date.now()}-${suffix}`;
}

module.exports = { configuration, productionOrigin, publicRequest, request, requestForPurpose, idempotencyKey };
