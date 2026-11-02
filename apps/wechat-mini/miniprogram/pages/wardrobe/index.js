const api = require("../../services/api");
const session = require("../../services/session");
const media = require("../../services/timeline-media");
const consentPolicy = require("../../policies/wardrobe");
const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const codeOf = error => error && typeof error.message === "string" ? error.message : "";
const authorizationFailure = error => /CONSENT|AUTH|PRIVACY|TIMELINE_DOWNLOAD_HTTP_(401|403|409)/.test(codeOf(error));
const dressPerson = (person, styles, seriesId) => {
  const selected = styles.find(s => s.id === person.styleId);
  return { ...person, seriesId: seriesId || selected.seriesId, selectedLabel: selected.label, options: styles.filter(s => s.seriesId === (seriesId || selected.seriesId)) };
};

Page({
  data: { rootId: "", targetAge: 0, context: null, people: [], styles: [], series: [], sourcePath: "", resultPath: "", commandId: "", result: null, accepted: false, busy: false, error: "", message: "" },
  active: false, epoch: 0, timer: null, intent: null,
  async onLoad(options) {
    if (!validId(options.rootId) || typeof options.age !== "string" || !/^(?:0|[1-9][0-9]?|100)$/.test(options.age) || (options.commandId !== undefined && !validId(options.commandId))) { this.setData({ error: "请选择已完成的年龄照片再换装。" }); return; }
    this.setData({ rootId: options.rootId, targetAge: Number(options.age), commandId: options.commandId || "" });
    if (!session.get()) { wx.navigateTo({ url: "/pages/auth/index" }); return; }
    this.active = true; await this.refresh();
  },
  onShow() {
    if (this.data.rootId && !this.active && session.get()) {
      if (this.intent?.commandId && !this.data.commandId) this.setData({commandId: this.intent.commandId});
      this.active = true; this.refresh();
    }
  },
  onHide() { this.active = false; this.epoch++; this.stop(); this.clearViews(); },
  onUnload() { this.onHide(); },
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; },
  async clearViews() {
    const paths = [this.data.sourcePath, this.data.resultPath];
    this.loadedCommandId = "";
    this.setData({ context: null, people: [], styles: [], series: [], sourcePath: "", resultPath: "", result: null, accepted: false, busy: false });
    await Promise.all(paths.filter(Boolean).map(path => media.remove(path)));
  },
  async refresh() {
    if (!this.active || !this.data.rootId) return;
    this.stop(); const epoch = ++this.epoch;
    this.setData({ busy: true, error: "" });
    try {
      const response = await api.requestForPurpose(`/v1/timelines/${encodeURIComponent(this.data.rootId)}/nodes/${this.data.targetAge}/wardrobe`, "age_transformation", { method: "GET" });
      if (!this.active || epoch !== this.epoch) return;
      const context = response && response.data;
      if (!context || context.sourceRootCommandId !== this.data.rootId || context.targetAge !== this.data.targetAge || context.policyVersion !== consentPolicy.version ||
          !validId(context.sourceAssetId) || !Array.isArray(context.participants) || context.participants.length < 1 || context.participants.length > 2 || new Set(context.participants.map(p => p.participantId)).size !== context.participants.length ||
          context.participants.some(p => !validId(p.participantId)) || context.catalogVersion !== "lifetime-wardrobe.v1" || !Array.isArray(context.styles) || context.styles.length !== 34 || new Set(context.styles.map(s => s.id)).size !== 34 ||
          context.styles.some(s => !validId(s.id) || typeof s.label !== "string" || !s.label || !["east","retro","together","daily","wedding","milestone","winter","newyear","legacy"].includes(s.seriesId) || typeof s.seriesLabel !== "string" || typeof s.legacy !== "boolean" || s.legacy !== (s.seriesId === "legacy") || !Number.isInteger(s.minAge) || s.minAge < 0 || s.minAge > 100 || s.maxAge !== 100 || ![1,2].includes(s.minPeople) || typeof s.unavailableReason !== "string" || s.available !== (context.targetAge >= s.minAge && context.participants.length >= s.minPeople)) ||
          context.styles.filter(s => !s.legacy).length !== 31 || new Set(context.styles.filter(s => !s.legacy).map(s => s.seriesId)).size !== 8 || !context.styles.some(s => s.id === "daily-white-v1" && s.available) || context.sourceNode?.status !== "ready" || context.sourceNode.targetAge !== this.data.targetAge) throw new Error("WARDROBE_CONTEXT_INVALID");
      const active = session.requireSession(), previous = this.data.people.length ? this.data.people : this.intent?.selections || [];
      const people = context.participants.map(p => {
        const old = previous.find(old => old.participantId === p.participantId), styleId = old?.styleId || "daily-white-v1";
        if (!context.styles.some(s => s.id === styleId && s.available)) throw new Error("WARDROBE_CONTEXT_INVALID");
        return dressPerson({ ...p, self: p.participantId === active.actorId, label: p.position === "single" ? "照片里的人" : p.position === "left" ? "左侧人物" : "右侧人物", styleId }, context.styles, old?.seriesId);
      });
      const series = [...new Map(context.styles.filter(s => !s.legacy).map(s => [s.seriesId, { id: s.seriesId, label: s.seriesLabel.split(" · ")[0] }])).values()];
      const sameSource = this.data.context?.sourceNode.asset.sha256 === context.sourceNode.asset.sha256;
      if (!sameSource && this.data.sourcePath) await media.remove(this.data.sourcePath);
      if (epoch !== this.epoch) return;
      this.setData({ context, people, styles: context.styles, series, sourcePath: sameSource ? this.data.sourcePath : "" });
      if (!this.data.sourcePath && context.sourceNode.downloadPath) {
        const path = await media.download(context.sourceNode);
        if (epoch !== this.epoch || !this.active) { await media.remove(path); return; }
        this.setData({ sourcePath: path });
      }
      if (this.data.commandId) await this.loadResult(epoch);
    } catch (error) { if (epoch === this.epoch && this.active) await this.showError(error); }
    finally { if (epoch === this.epoch && this.active) this.setData({ busy: false }); }
  },
  async loadResult(epoch) {
    const commandId = this.data.commandId;
    const response = await api.requestForPurpose(`/v1/timelines/${encodeURIComponent(commandId)}`, "age_transformation", { method: "GET" });
    if (epoch !== this.epoch || !this.active) return;
    const view = response && response.data;
    if (!view || view.commandId !== commandId || view.creationKind !== "wardrobe" || view.wardrobeSource?.sourceRootCommandId !== this.data.rootId || view.wardrobeSource.targetAge !== this.data.targetAge || view.expectedCount !== 1 || !Array.isArray(view.nodes) || view.nodes.length !== 1 || view.nodes[0].targetAge !== this.data.targetAge) throw new Error("WARDROBE_RESULT_INVALID");
    const selections = view.wardrobeSource.selections;
    if (!Array.isArray(selections) || selections.length !== this.data.people.length || selections.some((s, i) => s.participantId !== this.data.people[i].participantId || !this.data.styles.some(style => style.id === s.styleId && style.available))) throw new Error("WARDROBE_RESULT_INVALID");
    if (this.loadedCommandId !== commandId) {
      this.setData({ people: this.data.people.map((p,i) => dressPerson({ ...p, styleId: selections[i].styleId }, this.data.styles)) });
      this.loadedCommandId = commandId;
    }
    const node = view.nodes[0], keep = node.status === "ready" && node.asset && this.data.result?.asset?.sha256 === node.asset.sha256;
    if (!keep && this.data.resultPath) await media.remove(this.data.resultPath);
    if (epoch !== this.epoch) return;
    this.setData({ result: node, resultPath: keep ? this.data.resultPath : "" });
    if (node.status === "ready" && !this.data.resultPath && node.downloadPath) {
      const path = await media.download(node);
      if (epoch !== this.epoch || !this.active) { await media.remove(path); return; }
      this.setData({ resultPath: path });
    }
    if (["pending","retrying"].includes(node.status)) this.timer = setTimeout(() => this.refresh(), 3000);
  },
  chooseStyle(event) {
    if (this.data.busy) return;
    const { participant, style } = event.currentTarget.dataset;
    if (!this.data.styles.some(s => s.id === style && s.available)) return;
    this.setData({ people: this.data.people.map(p => p.participantId === participant ? dressPerson({ ...p, styleId: style }, this.data.styles) : p), error: "" });
  },
  chooseSeries(event) {
    if (this.data.busy) return;
    const {participant, series} = event.currentTarget.dataset;
    if (!this.data.series.some(s => s.id === series)) return;
    this.setData({people: this.data.people.map(p => p.participantId === participant ? dressPerson(p, this.data.styles, series) : p)});
  },
  consentChanged(event) { this.setData({ accepted: event.detail.value.includes("accepted") }); },
  async submit() {
    if (this.data.busy) return;
    if (!this.data.accepted || !this.data.context || !this.data.sourcePath) { this.setData({ error: "请先查看原片并确认换装用途。" }); return; }
    const selections = this.data.people.map(p => ({ participantId: p.participantId, styleId: p.styleId }));
    if (selections.some(s => !this.data.styles.some(style => style.id === s.styleId && style.available))) { this.setData({error: "请为每位人物选择适合当前年龄的衣着。"}); return; }
    const fingerprint = JSON.stringify([this.data.rootId,this.data.targetAge,this.data.context.sourceNode.asset.sha256,selections]);
    if (this.intent?.uncertain && this.intent.fingerprint !== fingerprint) { this.setData({ error: "上次换装结果尚待核对，请恢复原选择重试，避免重复提交。" }); return; }
    if (!this.intent || this.intent.fingerprint !== fingerprint) this.intent = { fingerprint, key: api.idempotencyKey("wardrobe"), consentKey: api.idempotencyKey("wardrobe-consent"), uncertain: false, commandId: "", selections };
    const intent = this.intent;
    if (intent.commandId) { this.setData({ commandId: intent.commandId }); await this.refresh(); return; }
    const epoch = ++this.epoch; this.stop(); this.setData({ busy: true, error: "", message: "" });
    const wasUncertain = intent.uncertain;
    try {
      const actor = session.requireSession();
      const self = this.data.people.find(p => p.participantId === actor.actorId);
      if (!self) throw new Error("WARDROBE_SELF_REQUIRED");
      if (!self.authorized) await api.requestForPurpose("/v1/commands", "age_transformation", { data: { command: "consent.grant", input: {
        id: intent.consentKey, participantId: actor.actorId, grantorCapacity: "self", purpose: "age_transformation", scope: { resource: `media.asset:${this.data.context.sourceAssetId}`, actions: ["wardrobe"] }, policyVersion: consentPolicy.version,
      } }, headers: { "Idempotency-Key": intent.consentKey } });
      if (epoch !== this.epoch || !this.active) return;
      intent.uncertain = true;
      const response = await api.requestForPurpose(`/v1/timelines/${encodeURIComponent(this.data.rootId)}/nodes/${this.data.targetAge}/wardrobe`, "age_transformation", { data: { selections: intent.selections }, headers: { "Idempotency-Key": intent.key } });
      const commandId = response && response.data && response.data.commandId;
      if (!validId(commandId)) throw new Error("WARDROBE_COMMAND_INVALID");
      intent.commandId = commandId; intent.uncertain = false;
      if (epoch !== this.epoch || !this.active) return;
      this.setData({ commandId, busy: false, message: "换装请求已提交，原年龄照片会保留。" });
      await this.refresh();
    } catch (error) {
      if (!wasUncertain && /^(CONSENT_REQUIRED|VALIDATION_FAILED|AUTH_FORBIDDEN|WARDROBE_SELF_REQUIRED)$/.test(codeOf(error))) intent.uncertain = false;
      if (epoch === this.epoch && this.active) await this.showError(error);
    } finally { if (epoch === this.epoch && this.active) this.setData({ busy: false }); }
  },
  async save() {
    if (this.data.busy || this.data.result?.status !== "ready") return;
    const epoch = this.epoch; this.setData({ busy: true, error: "", message: "" });
    try { await media.save(this.data.result); if (epoch === this.epoch && this.active) this.setData({ message: "换装原图已保存到相册。" }); }
    catch (error) { if (epoch === this.epoch && this.active) await this.showError(error); }
    finally { if (epoch === this.epoch && this.active) this.setData({ busy: false }); }
  },
  async retry() {
    if (this.data.busy || !this.data.result?.canRetry) return;
    const epoch = this.epoch; this.setData({ busy: true, error: "" });
    try {
      await api.requestForPurpose(`/v1/timelines/${encodeURIComponent(this.data.commandId)}/retry`, "age_transformation", { data: { targetAge: this.data.targetAge, attempt: this.data.result.attempts + 1 }, headers: { "Idempotency-Key": api.idempotencyKey("wardrobe-retry") } });
      if (epoch !== this.epoch || !this.active) return;
      this.setData({ busy: false }); await this.refresh();
    } catch (error) { if (epoch === this.epoch && this.active) await this.showError(error); }
    finally { if (epoch === this.epoch && this.active) this.setData({ busy: false }); }
  },
  async revoke() {
    if (this.data.busy || !this.data.context) return;
    const epoch = this.epoch, assetId = this.data.context.sourceAssetId, actor = session.requireSession();
    this.setData({ busy: true, error: "" }); this.stop();
    try {
      const response = await api.requestForPurpose("/v1/queries", "age_transformation", { data: { query: "consent.list", input: { participantId: actor.actorId } } });
      if (!response || !Array.isArray(response.data)) throw new Error("WARDROBE_CONSENT_LIST_INVALID");
      if (epoch !== this.epoch || !this.active) return;
      const grants = response.data.filter(c => c.participantId === actor.actorId && c.purpose === "age_transformation" && c.status === "active" && c.scope?.resource === `media.asset:${assetId}` && Array.isArray(c.scope.actions) && c.scope.actions.includes("wardrobe"));
      for (const grant of grants) {
        if (epoch !== this.epoch || !this.active) return;
        await api.requestForPurpose("/v1/commands", "age_transformation", { data: { command: "consent.withdraw", input: { consentId: grant.id, expectedVersion: grant.version, reason: "用户撤回本原照的换装授权" } }, headers: { "Idempotency-Key": api.idempotencyKey("wardrobe-withdraw") } });
      }
      if (epoch !== this.epoch || !this.active) return;
      await this.clearViews(); this.intent = null; this.setData({ commandId: "", message: "已撤回本人的换装授权；原年龄照片授权未改动。" });
    } catch (error) { if (epoch === this.epoch && this.active) await this.showError(error); }
    finally { if (epoch === this.epoch && this.active) this.setData({ busy: false }); }
  },
  async showError(error) {
    if ((authorizationFailure(error) && codeOf(error) !== "CONSENT_REQUIRED") || /CONTEXT_INVALID|RESULT_INVALID|COMMAND_INVALID/.test(codeOf(error))) await this.clearViews();
    const code = codeOf(error);
    const message = code === "ALBUM_PERMISSION_REQUIRED" ? "请在微信设置中允许保存到相册，再重试。" :
      code === "CONSENT_REQUIRED" ? "请等待每位人物独立确认换装用途，再重试。" :
      code === "WARDROBE_SELF_REQUIRED" ? "请由照片参与者本人确认；监护授权需先由服务端核验。" :
      authorizationFailure(error) ? "换装授权已失效，请重新确认；原年龄照片授权可单独管理。" :
      /CONTEXT|RESULT|COMMAND/.test(code) ? "照片或任务信息未通过校验，请从相册重新打开。" :
      /DIGEST|SIZE|DIMENSIONS/.test(code) ? "图片校验未通过，请刷新后重新下载。" : "暂时未能完成，请刷新或按原选择重试。";
    this.setData({ error: message });
  },
  onShareAppMessage(event = {}) {
    const participantId = event.target?.dataset?.participant;
    if (!this.data.context || !this.data.people.some(p => p.participantId === participantId && !p.self)) return { title: "一生衣橱 · 人生时光机", path: "/pages/home/index", imageUrl: "/assets/wardrobe-invite.png" };
    return { title: "一生衣橱 · 邀请你确认换装用途", path: `/pages/privacy/index?assetId=${encodeURIComponent(this.data.context.sourceAssetId)}&participantId=${encodeURIComponent(participantId)}&action=wardrobe`, imageUrl: "/assets/wardrobe-invite.png" };
  },
  library() { wx.switchTab({ url: "/pages/library/index" }); },
});
