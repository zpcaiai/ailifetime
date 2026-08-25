const api = require("../../services/api");

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "compensated"]);

Page({
  data: { commandId: "", title: "生成请求已提交", description: "阶段来自服务端，不显示伪造百分比。", state: "requested", complete: false, error: "" },
  timer: null,
  onLoad(options) {
    if (typeof options.commandId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(options.commandId)) { this.setData({ error: "COMMAND_ID_INVALID" }); return; }
    this.setData({ commandId: options.commandId }); this.refresh();
  },
  onHide() { this.stop(); },
  onUnload() { this.stop(); },
  async refresh() {
    this.stop();
    try {
      const result = await api.requestForPurpose("/v1/queries", "age_transformation", { data: { query: "external-command.get", input: { commandId: this.data.commandId } } });
      const command = result && result.data;
      if (!command || typeof command.state !== "string") throw new Error("COMMAND_STATUS_INVALID");
      const complete = TERMINAL.has(command.state);
      this.setData({ state: command.state, complete, error: command.reconciliationState === "reconciliation_required" ? "外部结果不确定，已冻结并转人工对账" : "" });
      if (!complete && command.reconciliationState !== "reconciliation_required") this.timer = setTimeout(() => this.refresh(), 3000);
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "STATUS_UNAVAILABLE" });
      this.timer = setTimeout(() => this.refresh(), 5000);
    }
  },
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; },
  library() { wx.switchTab({ url: "/pages/library/index" }); },
});
