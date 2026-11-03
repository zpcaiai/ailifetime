const api = require("../../services/api");
const session = require("../../services/session");

const LOGIN_MESSAGES = Object.freeze({
  BACKEND_NOT_CONFIGURED: "登录服务尚未就绪，请稍后再试。",
  EXTERNAL_ADAPTER_UNAVAILABLE: "登录服务尚未就绪，请稍后再试。",
  DEPENDENCY_UNAVAILABLE: "登录服务暂时不可用，请稍后再试。",
  DEVELOPMENT_API_CONFIGURATION_INVALID: "当前版本暂时无法连接服务，请稍后再试。",
  PRODUCTION_API_CONFIGURATION_REQUIRED: "当前版本暂时无法连接服务，请稍后再试。",
  PRODUCTION_API_CONFIGURATION_INVALID: "当前版本暂时无法连接服务，请稍后再试。",
  PRODUCTION_API_ORIGIN_NOT_ENROLLED: "当前版本暂时无法连接服务，请稍后再试。",
  NETWORK_DOMAIN_NOT_ENROLLED: "暂时无法连接服务，请稍后再试。",
  NETWORK_TLS_FAILED: "暂时无法连接服务，请稍后再试。",
  NETWORK_TIMEOUT: "连接超时，请检查网络后重试。",
  NETWORK_UNAVAILABLE: "暂时无法连接服务，请检查网络后重试。",
  WECHAT_LOGIN_CODE_MISSING: "未能取得微信登录凭证，请重试。",
  LOGIN_FAILED: "登录暂未成功，请稍后重试。",
});

Page({
  data: { accepted: false, busy: false, error: "", errorCode: "" },
  consentChanged(event) { this.setData({ accepted: event.detail.value.includes("accepted") }); },
  async login() {
    if (!this.data.accepted || this.data.busy) return;
    this.setData({ busy: true, error: "", errorCode: "" });
    try {
      const login = await new Promise((resolve, reject) => wx.login({ timeout: 10000, success: resolve, fail: reject }));
      if (!login.code) throw new Error("WECHAT_LOGIN_CODE_MISSING");
      const result = await api.publicRequest("/v1/auth/wechat/session", {
        data: { code: login.code, consentVersion: "wechat-privacy-v1", clientRequestId: api.idempotencyKey("wechat-login") },
        headers: { "Idempotency-Key": api.idempotencyKey("wechat-session") },
      });
      session.set(result.session);
      const verifiedSession = await api.request("/v1/session", { method: "GET" });
      session.bindServerProjection(result.session, verifiedSession);
      const manifest = await api.request("/v1/capabilities/visible", { method: "GET" });
      if (!manifest || manifest.schemaVersion !== "ltm.visible-capability-manifest.v1") throw new Error("VISIBLE_MANIFEST_UNSUPPORTED");
      getApp().globalData.policy = manifest;
      wx.navigateBack({ delta: 1 });
    } catch (error) {
      session.clear();
      const candidate = error instanceof Error ? error.message : "LOGIN_FAILED";
      const errorCode = Object.prototype.hasOwnProperty.call(LOGIN_MESSAGES, candidate) ? candidate : "LOGIN_FAILED";
      this.setData({ error: LOGIN_MESSAGES[errorCode], errorCode });
    } finally {
      this.setData({ busy: false });
    }
  },
});
