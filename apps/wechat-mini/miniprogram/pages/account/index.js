const api = require("../../services/api");
const session = require("../../services/session");
const policy = require("../../services/policy");

Page({
  data: { authenticated: false, actorId: "", tenantId: "", roles: "", error: "" },
  onShow() { this.project(); },
  project() {
    const value = session.get();
    this.setData({ authenticated: value !== null, actorId: value ? value.actorId : "", tenantId: value ? value.tenantId : "", roles: value ? value.roles.join("、") : "" });
  },
  login() { wx.navigateTo({ url: "/pages/auth/index" }); },
  async refresh() {
    try {
      const result = await api.request("/v1/auth/session/refresh", { data: {}, headers: { "Idempotency-Key": api.idempotencyKey("refresh") } });
      session.set(result.session);
      const verifiedSession = await api.request("/v1/session", { method: "GET" });
      session.bindServerProjection(result.session, verifiedSession);
      getApp().globalData.policy = await api.request("/v1/capabilities/visible", { method: "GET" }); this.project();
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : "SESSION_REFRESH_FAILED" }); }
  },
  async logout() {
    try {
      await api.request("/v1/auth/session/logout", { data: {}, headers: { "Idempotency-Key": api.idempotencyKey("logout") } });
      session.clear(); getApp().globalData.policy = null; this.project();
    } catch (error) {
      if (session.get()) this.setData({ error: error instanceof Error ? error.message : "SESSION_LOGOUT_FAILED" });
      else { getApp().globalData.policy = null; this.project(); }
    }
  },
  async support() {
    try {
      policy.requireCapabilities(["B80"], session.requireSession().roles);
      const ticketId = api.idempotencyKey("support");
      const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const result = await api.request("/v1/capabilities/B80", {
        data: {
          ticketId,
          channel: "in_app",
          severity: "P2",
          queue: "consumer-support",
          dueAt,
          privacySensitive: false,
          dedupeKey: ticketId,
          assignedRole: "support_agent",
        },
        headers: { "Idempotency-Key": ticketId },
      });
      const ticket = result && result.data;
      if (!ticket || typeof ticket.recordId !== "string" || ticket.batchId !== "B80") throw new Error("SUPPORT_TICKET_INVALID");
      wx.showModal({ title: "客服工单已创建", content: `客户请求号：${ticketId}\n服务端记录：${ticket.recordId}`, showCancel: false });
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : "SUPPORT_UNAVAILABLE" }); }
  },
});
