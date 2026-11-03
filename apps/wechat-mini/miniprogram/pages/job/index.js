const api = require("../../services/api");

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "compensated"]);
const STATES = new Set(["requested", "dispatched", "acknowledged", ...TERMINAL]);

Page({
  data: { commandId: "", title: "生成请求已提交", description: "阶段来自服务端；收到处理回执不代表照片已通过质量验收。", state: "requested", complete: false, canOpenLibrary: false, error: "",
    readyCount: 0, saving: false, savedCount: 0, saveTotal: 0, saveMessage: "", albumPermissionDenied: false },
  saveRun: null,
  savedState: null,
  timer: null,
  active: true,
  epoch: 0,
  onLoad(options) {
    if (typeof options.commandId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(options.commandId)) { this.active = false; this.setData({ error: "COMMAND_ID_INVALID" }); return; }
    this.setData({ commandId: options.commandId }); this.refresh();
  },
  onShow() { if (!this.active && this.data.commandId) { this.active = true; this.refresh(); } },
  onHide() { this.active = false; this.epoch++; this.cancelSave(); this.stop(); this.setData({ saving: false }); },
  onUnload() { this.onHide(); },
  async refresh() {
    if (!this.active || !this.data.commandId || this.saveRun) return;
    this.stop();
    const epoch = ++this.epoch;
    try {
      const result = await api.requestForPurpose(`/v1/timelines/${encodeURIComponent(this.data.commandId)}`, "age_transformation", { method: "GET" });
      if (!this.active || epoch !== this.epoch) return;
      const command = result && result.data;
      if (!command || !STATES.has(command.commandState)) throw new Error("COMMAND_STATUS_INVALID");
      const complete = TERMINAL.has(command.commandState);
      const title = command.state === "ready" ? `年龄照片已完成验收记录（${command.readyCount}/${command.expectedCount}）` :
        command.commandState === "succeeded" ? "服务商处理结束，照片交付待核验" :
        command.commandState === "failed" ? "生成处理失败，可到作品库恢复" : command.commandState === "cancelled" ? "生成已取消" :
        command.commandState === "compensated" ? "生成已进入补偿处理" : "生成处理中";
      this.setData({ state: command.commandState, complete, title, readyCount: command.reconciliationState === "reconciliation_required" ? 0 : (Number.isInteger(command.readyCount) ? command.readyCount : 0),
        canOpenLibrary: (complete || command.readyCount > 0) && command.reconciliationState !== "reconciliation_required",
        error: command.reconciliationState === "reconciliation_required" ? "外部结果不确定，已冻结并转人工对账" : "" });
      if ((!complete || command.nodes?.some(node => node.status === "pending" || node.status === "retrying")) && command.reconciliationState !== "reconciliation_required") this.timer = setTimeout(() => this.refresh(), 3000);
    } catch (error) {
      if (!this.active || epoch !== this.epoch) return;
      this.setData({ error: error instanceof Error ? error.message : "STATUS_UNAVAILABLE" });
      this.timer = setTimeout(() => this.refresh(), 5000);
    }
  },
  async saveAll() {
    if (!this.active || !this.data.commandId || this.saveRun) return;
    const session = require("../../services/session"), media = require("../../services/timeline-media");
    const commandId = this.data.commandId, epoch = ++this.epoch;
    const signal = { cancelled: false }; this.saveRun = signal;
    const current = () => this.active && epoch === this.epoch && this.saveRun === signal;
    this.stop();
    this.setData({ saving: true, savedCount: 0, saveTotal: 0, albumPermissionDenied: false, saveMessage: "正在获取本次生成的照片…" });
    try {
      const owner = albumOwner(session);
      if (this.savedState && this.savedState.owner !== owner) throw new Error("AUTHENTICATION_REQUIRED");
      if (!this.savedState || this.savedState.commandId !== commandId) this.savedState = { owner, commandId, completed: new Set() };
      const completed = this.savedState.completed;
      const response = await api.requestForPurpose(`/v1/timelines/${encodeURIComponent(commandId)}`, "age_transformation", { method: "GET" });
      if (!current()) return;
      if (signal.cancelled) { this.setData({ saveMessage: "已停止保存，尚未写入手机相册。" }); return; }
      const nodes = albumNodes(response && response.data, commandId);
      const count = () => nodes.filter(node => completed.has(albumKey(node))).length;
      this.setData({ savedCount: count(), saveTotal: nodes.length });
      if (!nodes.length) { this.setData({ saveMessage: "照片尚未就绪，请稍后刷新再保存。" }); return; }
      for (const node of nodes) {
        if (!current() || signal.cancelled) break;
        if (albumOwner(session) !== owner) throw new Error("AUTHENTICATION_REQUIRED");
        const key = albumKey(node); if (completed.has(key)) continue;
        await media.save(node, signal);
        completed.add(key); // Count only successful native album callbacks.
        if (!current()) return;
        this.setData({ savedCount: count(), saveMessage: `已保存 ${count()} / ${nodes.length} 张到手机相册` });
      }
      if (current()) this.setData({ saveMessage: signal.cancelled ? `已停止后续保存，已保存 ${count()} / ${nodes.length} 张；可继续保存剩余照片。` : `已保存 ${count()} / ${nodes.length} 张到手机相册。尚未生成的照片可稍后补存。` });
    } catch (error) {
      if (!current()) return;
      const code = error && error.message || "";
      const denied = code === "ALBUM_PERMISSION_REQUIRED";
      const detail = denied ? "请允许保存到相册，再点击重试。" : /AUTH|CONSENT|PRIVACY|HTTP_(401|403|409)/.test(code) ? "照片授权已失效，请重新登录或确认授权。" : "保存未完成，请重试；会跳过本页已保存的照片。";
      this.setData({ albumPermissionDenied: denied, saveMessage: signal.cancelled ? `已停止后续保存，已保存 ${this.data.savedCount} / ${this.data.saveTotal} 张。` : `已保存 ${this.data.savedCount} / ${this.data.saveTotal} 张。${detail}` });
    } finally {
      if (this.saveRun === signal) this.saveRun = null;
      if (this.active) {
        this.setData({ saving: false });
        // Restart status polling after saving or a foreground return during a save.
        this.timer = setTimeout(() => this.refresh(), 3000);
      }
    }
  },
  cancelSave() { if (this.saveRun) this.saveRun.cancelled = true; },
  async albumSettings() {
    if (!this.active || this.saveRun) return;
    const epoch = this.epoch;
    try {
      const allowed = await require("../../services/timeline-media").openAlbumSettings();
      if (this.active && epoch === this.epoch) this.setData({ albumPermissionDenied: !allowed, saveMessage: allowed ? "已允许保存，请再次点击保存到手机相册。" : "尚未允许保存，可以稍后再设置。" });
    } catch {
      if (this.active && epoch === this.epoch) this.setData({ saveMessage: "无法打开相册权限设置，请稍后重试。" });
    }
  },
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; },
  library() { wx.switchTab({ url: "/pages/library/index" }); },
});

function albumOwner(session) {
  const actor = session.requireSession();
  return JSON.stringify([actor.tenantId, actor.actorId]);
}
function albumKey(node) { return JSON.stringify([node.targetAge, node.asset.sha256]); }
function albumNodes(view, commandId) {
  if (!view || view.commandId !== commandId || view.reconciliationState === "reconciliation_required" ||
      !Number.isInteger(view.expectedCount) || view.expectedCount < 1 || view.expectedCount > 101 ||
      !Array.isArray(view.nodes) || view.nodes.length !== view.expectedCount ||
      new Set(view.nodes.map(node => node && node.targetAge)).size !== view.nodes.length ||
      view.nodes.some(node => !node || !Number.isInteger(node.targetAge) || node.targetAge < 0 || node.targetAge > 100 ||
        !["pending", "ready", "failed", "review", "retrying", "reconciliation_required"].includes(node.status) ||
        (node.status === "ready" && (!node.asset || !/^[a-f0-9]{64}$/.test(node.asset.sha256) ||
          node.downloadPath !== `/v1/timelines/${commandId}/nodes/${node.targetAge}/image`)))) throw new Error("TIMELINE_PROJECTION_INVALID");
  return view.nodes.filter(node => node.status === "ready");
}
