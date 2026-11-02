const privacy = require("../../services/privacy");

Page({
  data: { referrer: "选择照片", invitation: false, inviteKind: "age", inviteValid: false, assetId: "", participantId: "", busy: false, error: "", agreed: false },
  onLoad(options = {}) {
    if (options.assetId !== undefined || options.participantId !== undefined) {
      const valid = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
      const kindValid = options.action === undefined || options.action === "age" || options.action === "wardrobe";
      this.setData({ invitation: true, inviteKind: options.action === "wardrobe" ? "wardrobe" : "age", inviteValid: kindValid && valid(options.assetId) && valid(options.participantId), assetId: valid(options.assetId) ? options.assetId : "", participantId: valid(options.participantId) ? options.participantId : "" });
      if (!this.data.inviteValid) this.setData({ error: "邀请信息无效，请重新发送" });
      return;
    }
    const request = getApp().globalData.privacyRequest;
    this.setData({ referrer: request && request.referrer ? request.referrer : "选择照片" });
  },
  async agree() {
    if (!this.data.invitation) { privacy.decide(true); wx.navigateBack({ delta: 1 }); return; }
    if (this.data.busy || this.data.agreed || !this.data.inviteValid) return;
    const session = require("../../services/session");
    const active = session.get();
    if (!active) { wx.navigateTo({ url: "/pages/auth/index" }); return; }
    if (active.actorId !== this.data.participantId) { this.setData({ error: "请使用受邀者本人的账号确认，不能代替他人授权" }); return; }
    const api = require("../../services/api");
    const wardrobe = this.data.inviteKind === "wardrobe";
    const consentPolicy = wardrobe ? require("../../policies/wardrobe") : require("../../policies/age-transformation");
    this.consentId = this.consentId || api.idempotencyKey("pair-consent");
    this.setData({ busy: true, error: "" });
    try {
      await api.requestForPurpose("/v1/commands", "age_transformation", { data: { command: "consent.grant", input: {
        id: this.consentId, participantId: active.actorId, grantorCapacity: "self", purpose: "age_transformation",
        scope: { resource: `media.asset:${this.data.assetId}`, actions: wardrobe ? ["wardrobe"] : ["ingest", "transform"] }, policyVersion: consentPolicy.version,
      } }, headers: { "Idempotency-Key": this.consentId } });
      this.setData({ agreed: true });
    } catch (error) { this.setData({ error: error instanceof Error ? error.message : "授权未成功，请重试" }); }
    finally { this.setData({ busy: false }); }
  },
  disagree() {
    if (!this.data.invitation) { privacy.decide(false); wx.navigateBack({ delta: 1 }); return; }
    wx.navigateBack({ delta: 1, fail() { wx.switchTab({ url: "/pages/home/index" }); } });
  },
  onUnload() { if (!this.data.invitation && getApp().globalData.privacyRequest) privacy.decide(false); },
});
