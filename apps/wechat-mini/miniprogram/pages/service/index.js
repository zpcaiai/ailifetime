const messaging = require("../../services/messaging");
const session = require("../../services/session");

Page({
  data: { offer: null, stateText: "", busy: false, error: "" },
  onShow() { if (!session.get()) wx.navigateTo({ url: "/pages/auth/index" }); },
  async loadOffer() {
    this.setData({ busy: true, error: "" });
    try { this.setData({ offer: await messaging.loadSubscriptionOffer(), stateText: "可选择一次性订阅通知" }); }
    catch (error) { this.setData({ error: error instanceof Error ? error.message : "SUBSCRIPTION_OFFER_FAILED" }); }
    finally { this.setData({ busy: false }); }
  },
  async subscribe() {
    if (!this.data.offer || this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try {
      const result = await messaging.requestSubscriptions(this.data.offer);
      this.setData({ stateText: result.state === "server_recorded" ? "订阅选择已由服务端记录" : "未授权订阅消息" });
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : "SUBSCRIPTION_FAILED" }); }
    finally { this.setData({ busy: false }); }
  },
  async customerService() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try { const result = await messaging.openCustomerService(); this.setData({ stateText: `微信客服已打开，工单 ${result.ticketId}` }); }
    catch (error) { this.setData({ error: error instanceof Error ? error.message : "CUSTOMER_SERVICE_FAILED" }); }
    finally { this.setData({ busy: false }); }
  },
});
