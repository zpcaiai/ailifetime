const api = require("../../services/api");
const session = require("../../services/session");
const privacy = require("../../services/privacy");
const { createSha256 } = require("../../services/sha256");
const templateLimit = 8 * 1024 * 1024;

function localTemplatePath(actor) {
  if (!actor?.tenantId || !actor.actorId || !wx.env?.USER_DATA_PATH) return "";
  const owner = JSON.stringify([actor.tenantId, actor.actorId]);
  const hash = createSha256();
  hash.update(Uint8Array.from(owner, character => character.charCodeAt(0)));
  return `${wx.env.USER_DATA_PATH}/wardrobe-template-${hash.digestHex()}.image`;
}

function selectTemplatePhoto() {
  return new Promise((resolve, reject) => wx.chooseMedia({
    count: 1, mediaType: ["image"], sourceType: ["album"], sizeType: ["compressed"],
    success: result => resolve(result.tempFiles?.[0]),
    fail: error => /\bcancel\b/i.test(error?.errMsg || "") ? resolve(null) : reject(error),
  }));
}

module.exports = {
  templateSelection: null,
  clearCustomTemplate() {
    this.templateSelection = null;
    this.setData({ customTemplatePath: "", choosingTemplate: false, templateError: "" });
  },
  loadCustomTemplate(actor) {
    const path = localTemplatePath(actor);
    if (path) {
      try {
        wx.getFileSystemManager().accessSync(path);
        this.setData({ customTemplatePath: path });
        return;
      } catch {}
    }
    this.setData({ customTemplatePath: "" });
  },
  async chooseCustomTemplate() {
    if (!this.active || !this.data.context || this.data.busy || this.templateSelection) return;
    const destination = localTemplatePath(session.get());
    if (!destination) return;
    const selection = {};
    this.templateSelection = selection;
    const isCurrent = () => this.active && this.templateSelection === selection && localTemplatePath(session.get()) === destination;
    this.setData({ choosingTemplate: true, templateError: "" });
    try {
      await privacy.requireAuthorization();
      if (!isCurrent()) return;
      const file = await selectTemplatePhoto();
      if (!file || !isCurrent()) return;
      if (typeof file.tempFilePath !== "string" || !file.tempFilePath ||
          !Number.isSafeInteger(file.size) || file.size < 1 || file.size > templateLimit) throw new Error("WARDROBE_TEMPLATE_INVALID");
      const info = await new Promise((resolve, reject) => wx.getImageInfo({ src: file.tempFilePath, success: resolve, fail: reject }));
      if (!isCurrent()) return;
      if (!["jpeg", "jpg", "png"].includes(String(info.type).toLowerCase()) ||
          !Number.isSafeInteger(info.width) || info.width < 1 || !Number.isSafeInteger(info.height) || info.height < 1) throw new Error("WARDROBE_TEMPLATE_INVALID");

      // Stage a complete copy before replacing the prior reference.
      const fs = wx.getFileSystemManager();
      const staged = `${destination}.${api.idempotencyKey("preview")}.tmp`;
      try {
        fs.copyFileSync(file.tempFilePath, staged);
        fs.renameSync(staged, destination);
      } catch (error) {
        try { fs.unlinkSync(staged); } catch {}
        throw error;
      }
      this.setData({ customTemplatePath: "" }, () => {
        if (this.active && localTemplatePath(session.get()) === destination) this.loadCustomTemplate(session.get());
      });
    } catch (error) {
      if (isCurrent()) this.setData({ templateError: error?.message === "WARDROBE_TEMPLATE_INVALID" ? "请选择 8 MiB 以内的 JPEG 或 PNG 图片。" : "未能保存参考图，请确认相册授权或设备存储空间后重试。" });
    } finally {
      if (this.templateSelection === selection) {
        this.templateSelection = null;
        this.setData({ choosingTemplate: false });
      }
    }
  },
  deleteCustomTemplate() {
    if (!this.active || this.data.busy || this.templateSelection) return;
    const path = localTemplatePath(session.get());
    if (!path || this.data.customTemplatePath !== path) return;
    try {
      wx.getFileSystemManager().unlinkSync(path);
      this.setData({ customTemplatePath: "", templateError: "" });
    } catch {
      this.setData({ templateError: "未能删除参考图，请重试。" });
    }
  },
};
