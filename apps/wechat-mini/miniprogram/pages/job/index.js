const api = require("../../services/api");

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "compensated"]);
const STATES = new Set(["requested", "dispatched", "acknowledged", ...TERMINAL]);

Page({
  data: { commandId: "", title: "生成请求已提交", description: "阶段来自服务端；收到处理回执不代表照片已通过质量验收。", state: "requested", complete: false, canOpenLibrary: false, error: "" },
  timer: null,
  active: true,
  epoch: 0,
  onLoad(options) {
    if (typeof options.commandId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(options.commandId)) { this.active = false; this.setData({ error: "COMMAND_ID_INVALID" }); return; }
    this.setData({ commandId: options.commandId }); this.refresh();
  },
  onShow() { if (!this.active && this.data.commandId) { this.active = true; this.refresh(); } },
  onHide() { this.active = false; this.epoch++; this.stop(); },
  onUnload() { this.active = false; this.epoch++; this.stop(); },
  async refresh() {
    if (!this.active || !this.data.commandId) return;
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
      this.setData({ state: command.commandState, complete, title,
        canOpenLibrary: (complete || command.readyCount > 0) && command.reconciliationState !== "reconciliation_required",
        error: command.reconciliationState === "reconciliation_required" ? "外部结果不确定，已冻结并转人工对账" : "" });
      if (!complete && command.reconciliationState !== "reconciliation_required") this.timer = setTimeout(() => this.refresh(), 3000);
    } catch (error) {
      if (!this.active || epoch !== this.epoch) return;
      this.setData({ error: error instanceof Error ? error.message : "STATUS_UNAVAILABLE" });
      this.timer = setTimeout(() => this.refresh(), 5000);
    }
  },
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; },
  library() { wx.switchTab({ url: "/pages/library/index" }); },
});
