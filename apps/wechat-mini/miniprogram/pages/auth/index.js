const api = require("../../services/api");
const session = require("../../services/session");

Page({
  data: { accepted: false, busy: false, error: "" },
  consentChanged(event) { this.setData({ accepted: event.detail.value.includes("accepted") }); },
  async login() {
    if (!this.data.accepted || this.data.busy) return;
    this.setData({ busy: true, error: "" });
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
      this.setData({ error: error instanceof Error ? error.message : "LOGIN_FAILED" });
    } finally {
      this.setData({ busy: false });
    }
  },
});
