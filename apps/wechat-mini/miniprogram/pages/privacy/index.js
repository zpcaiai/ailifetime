const privacy = require("../../services/privacy");

Page({
  data: { referrer: "选择照片" },
  onLoad() {
    const request = getApp().globalData.privacyRequest;
    this.setData({ referrer: request && request.referrer ? request.referrer : "选择照片" });
  },
  agree() { privacy.decide(true); wx.navigateBack({ delta: 1 }); },
  disagree() { privacy.decide(false); wx.navigateBack({ delta: 1 }); },
  onUnload() { if (getApp().globalData.privacyRequest) privacy.decide(false); },
});
