const purchases = require("../../services/photo-purchases");
const session = require("../../services/session");
const LABELS = { pending: "待付款", paid: "已付款", refunded: "已退款", closed: "已关闭", failed: "付款未完成" };

Page({
  data: { orders: [], selected: null, nextCursor: null, loading: false, busy: false, error: "", message: "" },
  active: false,
  epoch: 0,
  onLoad(options) { this.initialId = options && options.purchaseId || ""; },
  onShow() {
    const owner = session.get();
    if (!owner) { this.clear(); wx.navigateTo({ url: "/pages/auth/index" }); return; }
    this.owner = { actorId: owner.actorId, tenantId: owner.tenantId };
    this.active = true; this.refresh();
  },
  onHide() { this.clear(); },
  onUnload() { this.clear(); },
  clear() {
    this.active = false; this.epoch++;
    this.setData({ orders: [], selected: null, nextCursor: null, loading: false, busy: false, error: "", message: "" });
  },
  current(epoch) {
    const now = session.get();
    return this.active && epoch === this.epoch && now && this.owner && now.actorId === this.owner.actorId && now.tenantId === this.owner.tenantId;
  },
  async refresh() {
    if (!this.active || this.data.busy) return;
    const epoch = ++this.epoch;
    this.setData({ loading: true, error: "" });
    try {
      const page = await purchases.listPage(); if (!this.current(epoch)) return;
      this.setData({ orders: page.items.map(order => ({ ...order, stateText: LABELS[order.paymentState] || "正在核对" })), nextCursor: page.nextCursor });
      if (this.initialId) {
        const id = this.initialId; this.initialId = "";
        const selected = await purchases.get(id); if (!this.current(epoch)) return;
        this.showOrder(selected);
      }
    } catch (error) { if (this.current(epoch)) this.setData({ error: purchases.errorText(error) }); }
    finally { if (this.current(epoch)) this.setData({ loading: false }); }
  },
  async more() {
    if (!this.active || this.data.loading || this.data.busy || !this.data.nextCursor) return;
    const epoch = ++this.epoch, cursor = this.data.nextCursor;
    this.setData({ loading: true, error: "" });
    try {
      const page = await purchases.listPage(cursor); if (!this.current(epoch)) return;
      const ids = new Set(this.data.orders.map(order => order.purchaseId));
      this.setData({ orders: [...this.data.orders, ...page.items.filter(order => !ids.has(order.purchaseId)).map(order => ({ ...order, stateText: LABELS[order.paymentState] || "正在核对" }))], nextCursor: page.nextCursor });
    } catch (error) { if (this.current(epoch)) this.setData({ error: purchases.errorText(error) }); }
    finally { if (this.current(epoch)) this.setData({ loading: false }); }
  },
  showOrder(value) {
    this.setData({ selected: { ...value, amountText: purchases.money(value.amountMinor), stateText: LABELS[value.paymentState] || "正在核对",
      canResume: ["pending", "paid"].includes(value.paymentState), canOpen: value.sku === "wardrobe-series" || !!value.commandId }, error: "", message: "" });
  },
  async select(event) {
    if (!this.active || this.data.busy) return;
    const epoch = ++this.epoch; this.setData({ loading: true, selected: null, error: "" });
    try {
      const value = await purchases.get(event.currentTarget.dataset.id);
      if (this.current(epoch)) this.showOrder(value);
    } catch (error) { if (this.current(epoch)) this.setData({ error: purchases.errorText(error) }); }
    finally { if (this.current(epoch)) this.setData({ loading: false }); }
  },
  async resume() {
    if (!this.active || this.data.busy || !this.data.selected || !this.data.selected.canResume) return;
    const epoch = ++this.epoch, selected = this.data.selected;
    this.setData({ busy: true, error: "", message: "正在核对订单，请稍候。" });
    try {
      const result = await purchases.execute(selected, { isCurrent: () => this.current(epoch) });
      if (!this.current(epoch)) return;
      this.showOrder(result);
      this.setData({ message: result.state === "ready" ? "照片已备好，可以查看和保存。" : "订单已继续处理，可以查看进度；已付款的订单不会再次付款。" });
    } catch (error) { if (this.current(epoch)) this.setData({ error: purchases.errorText(error), message: "" }); }
    finally { if (this.current(epoch)) this.setData({ busy: false }); }
  },
  open() {
    const value = this.data.selected;
    if (!this.current(this.epoch) || this.data.busy || !value || !value.canOpen) return;
    wx.navigateTo({ url: value.sku === "wardrobe-series" ? `/pages/wardrobe/index?purchaseId=${encodeURIComponent(value.purchaseId)}` : `/pages/job/index?commandId=${encodeURIComponent(value.commandId)}` });
  },
});
