const session = require("../../services/session");
const upload = require("../../services/upload");
const privacy = require("../../services/privacy");

Page({
  data: { accepted: false, preview: "", details: "", busy: false, choosing: false, progress: 0, error: "" },
  epoch: 0, active: false,
  file: null,
  cancellation: null,
  onShow() {
    this.active = true;
    if (!session.get()) wx.navigateTo({ url: "/pages/auth/index" });
  },
  onHide() { this.active = false; this.epoch++; this.cancel(); this.clearLocal(); this.setData({ accepted: false, busy: false, choosing: false }); },
  onUnload() { this.onHide(); },
  consentChanged(event) { const accepted = event.detail.value.includes("accepted"); if (!accepted) { this.epoch++; this.cancel(); this.clearLocal(); this.setData({busy: false, choosing: false}); } this.setData({ accepted }); },
  async choose() {
    if (this.data.busy || this.data.choosing || !this.active) return;
    if (!this.data.accepted) { this.setData({error: "请先确认照片使用授权。"}); return; }
    const epoch = ++this.epoch; let sanitizedPath = "";
    this.setData({choosing: true, error: ""});
    try {
      await privacy.requireAuthorization();
      if (!this.active || epoch !== this.epoch || !this.data.accepted) return;
      const result = await new Promise((resolve, reject) => wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["album", "camera"], sizeType: ["original"], success: resolve, fail: reject }));
      const original = result.tempFiles && result.tempFiles[0] && result.tempFiles[0].tempFilePath;
      if (!original) throw new Error("MEDIA_SELECTION_EMPTY");
      if (!this.active || epoch !== this.epoch) return;
      const candidate = await upload.sanitize(original);
      if (!candidate || candidate === original) throw new Error("MEDIA_SANITIZATION_INVALID");
      sanitizedPath = candidate;
      if (!this.active || epoch !== this.epoch) return;
      const file = await upload.preflight(sanitizedPath);
      if (!this.active || epoch !== this.epoch || !this.data.accepted) return;
      if (this.file && this.file.path !== sanitizedPath) this.remove(this.file.path);
      this.file = file;
      this.setData({ preview: sanitizedPath, details: `${this.file.width}×${this.file.height} · ${Math.ceil(this.file.size / 1024)} KB`, error: "" });
    } catch (error) {
      if (this.active && epoch === this.epoch) {
        if (/PRIVACY/.test(error.message || "")) this.clearLocal();
        this.setData({ error: "未能选取清晰照片，请重新选择并确认使用授权。" });
      }
    } finally {
      if (sanitizedPath && this.file?.path !== sanitizedPath) this.remove(sanitizedPath);
      if (this.active && epoch === this.epoch) this.setData({choosing: false});
    }
  },
  async upload() {
    if (!this.file || this.data.busy || this.data.choosing || !this.active) return;
    if (!this.data.accepted) { this.setData({error: "请先确认照片使用授权。"}); return; }
    const epoch = ++this.epoch, cancellation = { cancelled: false };
    this.cancellation = cancellation;
    this.setData({ busy: true, progress: 0, error: "" });
    try {
      const result = await upload.resumableUpload(this.file, (progress) => { if (this.active && epoch === this.epoch) this.setData({ progress }); }, cancellation);
      if (!this.active || epoch !== this.epoch || cancellation.cancelled) return;
      if (!result || typeof result.assetId !== "string") throw new Error("UPLOAD_COMPLETION_INVALID");
      const assetId = result.assetId;
      this.clearLocal();
      wx.navigateTo({ url: `/pages/editor/index?assetId=${encodeURIComponent(assetId)}` });
    } catch (error) {
      if (this.active && epoch === this.epoch) this.setData({ error: cancellation.cancelled ? "上传已取消，可以重新上传。" : "上传未完成，请重试；不会开始生成照片。" });
    } finally {
      if (this.cancellation === cancellation) this.cancellation = null;
      if (this.active && epoch === this.epoch) this.setData({ busy: false });
    }
  },
  cancel() { if (this.cancellation) this.cancellation.cancelled = true; },
  clearLocal() {
    const path = this.file && this.file.path;
    this.file = null;
    this.setData({ preview: "", details: "", progress: 0 });
    if (path) this.remove(path);
  },
  remove(path) { wx.getFileSystemManager().unlink({filePath: path, fail() {}}); },
});
