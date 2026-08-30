const commerce = require("../../services/commerce");
const session = require("../../services/session");

Page({
  data: { checkoutId: "", amountText: "", stateText: "", busy: false, error: "" },
  onLoad(options) {
    if (options && typeof options.checkoutId === "string") this.setData({ checkoutId: options.checkoutId });
  },
  onShow() { if (!session.get()) wx.navigateTo({ url: "/pages/auth/index" }); },
  checkoutChanged(event) { this.setData({ checkoutId: String(event.detail.value || "") }); },
  async pay() {
    if (this.data.busy) return;
    this.setData({ busy: true, error: "" });
    try {
      const accepted = await commerce.requestPayment({ checkoutId: this.data.checkoutId });
      this.setData({
        amountText: `¥${(accepted.amountMinor / 100).toFixed(2)}`,
        stateText: "微信已受理，正在等待商户服务端验签",
      });
      const projection = await commerce.waitForTerminal(accepted.orderId);
      this.setData({ stateText: projection.state === "paid" ? "商户服务端已确认支付" : `支付状态：${projection.state}` });
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : "PAYMENT_FAILED" }); }
    finally { this.setData({ busy: false }); }
  },
});
