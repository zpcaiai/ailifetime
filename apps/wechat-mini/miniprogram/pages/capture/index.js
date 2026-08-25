const session = require("../../services/session");
const upload = require("../../services/upload");

Page({
  data: { accepted: false, preview: "", details: "", busy: false, progress: 0, error: "" },
  file: null,
  cancellation: null,
  onShow() {
    if (!session.get()) wx.navigateTo({ url: "/pages/auth/index" });
  },
  onHide() { if (!this.data.busy) this.clearLocal(); },
  onUnload() { this.cancel(); this.clearLocal(); },
  consentChanged(event) { this.setData({ accepted: event.detail.value.includes("accepted") }); },
  async choose() {
    try {
      const result = await new Promise((resolve, reject) => wx.chooseMedia({ count: 1, mediaType: ["image"], sourceType: ["album", "camera"], sizeType: ["original"], success: resolve, fail: reject }));
      const original = result.tempFiles && result.tempFiles[0] && result.tempFiles[0].tempFilePath;
      if (!original) throw new Error("MEDIA_SELECTION_EMPTY");
      const sanitizedPath = await upload.sanitize(original);
      this.file = await upload.preflight(sanitizedPath);
      this.setData({ preview: sanitizedPath, details: `${this.file.width}×${this.file.height} · ${Math.ceil(this.file.size / 1024)} KB`, error: "" });
    } catch (error) {
      this.clearLocal();
      this.setData({ error: error instanceof Error ? error.message : "MEDIA_SELECTION_FAILED" });
    }
  },
  async upload() {
    if (!this.file || this.data.busy) return;
    this.cancellation = { cancelled: false };
    this.setData({ busy: true, progress: 0, error: "" });
    try {
      const result = await upload.resumableUpload(this.file, (progress) => this.setData({ progress }), this.cancellation);
      if (!result || typeof result.assetId !== "string") throw new Error("UPLOAD_COMPLETION_INVALID");
      const assetId = result.assetId;
      this.clearLocal();
      wx.navigateTo({ url: `/pages/editor/index?assetId=${encodeURIComponent(assetId)}` });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "UPLOAD_FAILED" });
    } finally {
      this.cancellation = null;
      this.setData({ busy: false });
    }
  },
  cancel() { if (this.cancellation) this.cancellation.cancelled = true; },
  clearLocal() {
    const path = this.file && this.file.path;
    this.file = null;
    this.setData({ preview: "", details: "", progress: 0 });
    if (path) wx.getFileSystemManager().unlink({ filePath: path, fail() {} });
  },
});
