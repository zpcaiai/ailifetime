const session = require("../../services/session");

Page({
  data: { authenticated: false, tenantId: "", capabilityCount: 0 },
  onShow() {
    const value = session.get();
    const policy = getApp().globalData.policy;
    this.setData({
      authenticated: value !== null,
      tenantId: value ? value.tenantId : "",
      capabilityCount: policy && Array.isArray(policy.capabilities) ? policy.capabilities.length : 0,
    });
  },
  start() { wx.switchTab({ url: "/pages/capture/index" }); },
  login() { wx.navigateTo({ url: "/pages/auth/index" }); },
  commerce() { wx.navigateTo({ url: "/pages/commerce/index" }); },
  service() { wx.navigateTo({ url: "/pages/service/index" }); },
});
