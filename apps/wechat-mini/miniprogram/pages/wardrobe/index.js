const api = require("../../services/api");
const session = require("../../services/session");
const media = require("../../services/timeline-media");
const consentPolicy = require("../../policies/wardrobe");
const purchases = require("../../services/photo-purchases");
const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const codeOf = error => error && typeof error.message === "string" ? error.message : "";
const authorizationFailure = error => /CONSENT|AUTH|PRIVACY|TIMELINE_DOWNLOAD_HTTP_(401|403|409)/.test(codeOf(error));
const dressPerson = (person, styles, seriesId) => {
  const selected = styles.find(s => s.id === person.styleId);
  return { ...person, seriesId: seriesId || selected.seriesId, selectedLabel: selected.label, options: styles.filter(s => s.seriesId === (seriesId || selected.seriesId)) };
};

Page({
  data: { rootId: "", targetAge: 0, context: null, people: [], styles: [], series: [], sourcePath: "", resultPath: "", commandId: "", result: null, accepted: false, busy: false, albumPermissionDenied: false, error: "", message: "", selectedSeriesId: "daily", bundleStyles: [], bundleCount: 0, purchaseId: "", seriesPurchase: null, seriesItems: [], priceSeries: purchases.money(purchases.PRICES["wardrobe-series"]), seriesSaved: 0 },
  active: false, epoch: 0, timer: null, intent: null,
  async onLoad(options) {
    const openingEpoch = ++this.epoch;
    this.seriesSavedKeys = new Set();
    if (options.purchaseId) {
      const initial = session.get();
      if (!initial) { wx.navigateTo({url: "/pages/auth/index"}); return; }
      const owner = { actorId: initial.actorId, tenantId: initial.tenantId };
      try {
        const purchase = await purchases.get(options.purchaseId);
        if (openingEpoch !== this.epoch) return;
        const current = session.get();
        if (!current || current.actorId !== owner.actorId || current.tenantId !== owner.tenantId) throw new Error("PHOTO_ACCOUNT_CHANGED");
        if (purchase.sku !== "wardrobe-series") throw new Error("PHOTO_PURCHASE_INVALID");
        options = { ...options, rootId: purchase.sourceRootCommandId, age: String(purchase.items[0].targetAge) };
        this.setData({purchaseId: purchase.purchaseId, selectedSeriesId: purchase.seriesId});
      } catch (error) { if (openingEpoch === this.epoch) await this.showError(error); return; }
    }
    if (!validId(options.rootId) || typeof options.age !== "string" || !/^(?:0|[1-9][0-9]?|100)$/.test(options.age) || (options.commandId !== undefined && !validId(options.commandId))) { this.setData({ error: "请选择已完成的年龄照片再换装。" }); return; }
    this.setData({ rootId: options.rootId, targetAge: Number(options.age), commandId: options.commandId || "" });
    if (!session.get()) { wx.navigateTo({ url: "/pages/auth/index" }); return; }
    this.active = true; await this.refresh();
  },
  onShow() {
    if (this.data.rootId && !this.active && session.get()) {
      if (this.intent?.commandId && !this.data.commandId) this.setData({commandId: this.intent.commandId});
      if (this.intent?.purchaseId && !this.data.purchaseId) this.setData({purchaseId: this.intent.purchaseId});
      this.active = true; this.refresh();
    }
  },
  onHide() { this.active = false; this.epoch++; this.stop(); this.clearViews(); },
  onUnload() { this.onHide(); },
  stop() { if (this.timer) clearTimeout(this.timer); this.timer = null; },
  async clearViews() {
    const paths = [this.data.sourcePath, this.data.resultPath, ...this.data.seriesItems.map(item => item.localPath)];
    this.loadedCommandId = "";
    this.setData({ context: null, people: [], styles: [], series: [], sourcePath: "", resultPath: "", result: null, seriesPurchase: null, seriesItems: [], bundleStyles: [], bundleCount: 0, accepted: false, busy: false, albumPermissionDenied: false });
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
      this.updateBundle();
      if (!this.data.sourcePath && context.sourceNode.downloadPath) {
        const path = await media.download(context.sourceNode);
        if (epoch !== this.epoch || !this.active) { await media.remove(path); return; }
        this.setData({ sourcePath: path });
      }
      if (this.data.purchaseId) await this.loadSeries(epoch);
      else if (this.data.commandId) await this.loadResult(epoch);
    } catch (error) { if (epoch === this.epoch && this.active) await this.showError(error); }
    finally { if (epoch === this.epoch && this.active) this.setData({ busy: false }); }
  },
  updateBundle() {
    const selected = this.data.selectedSeriesId;
    const bundleStyles = this.data.styles.filter(style => style.seriesId === selected && style.available);
    const series = this.data.series.map(group => ({ ...group, count: this.data.styles.filter(style => style.seriesId === group.id && style.available).length }));
    this.setData({ bundleStyles, bundleCount: bundleStyles.length, series });
  },
  async selectBundle(event) {
    const id = event.currentTarget.dataset.series;
    if (this.data.busy || !this.data.series.some(group => group.id === id && group.count > 0)) return;
    if (this.intent?.uncertain && id !== this.data.selectedSeriesId) { this.setData({error: "上次订单尚待核对，请先恢复原选择并继续，避免重复付款。"}); return; }
    if (id !== this.data.selectedSeriesId) {
      const paths = this.data.seriesItems.map(item => item.localPath).filter(Boolean);
      this.intent = null;this.setData({selectedSeriesId: id,purchaseId: "",seriesPurchase: null,seriesItems: [],seriesSaved: 0});this.updateBundle();
      await Promise.all(paths.map(path => media.remove(path)));
    }
  },
  async loadSeries(epoch) {
    const purchase = await purchases.get(this.data.purchaseId);
    if (epoch !== this.epoch || !this.active) return;
    const allowed = this.data.styles.filter(style => style.seriesId === purchase.seriesId && style.available);
    if (purchase.sku !== "wardrobe-series" || purchase.sourceRootCommandId !== this.data.rootId || purchase.expectedCount !== allowed.length ||
        purchase.items.some(item => item.targetAge !== this.data.targetAge || !allowed.some(style => style.id === item.itemId)) || new Set(purchase.items.map(item => item.itemId)).size !== allowed.length) throw new Error("PHOTO_PURCHASE_INVALID");
    const previous = this.data.seriesItems, items = [], created = [];
    try {
      for (const item of purchase.items) {
        const old = previous.find(candidate => candidate.itemId === item.itemId && candidate.asset?.sha256 === item.asset?.sha256);
        let localPath = old?.localPath || "";
        if (item.status === "ready" && !localPath && item.downloadPath) { localPath = await media.download(item); created.push(localPath); }
        if (epoch !== this.epoch || !this.active) { await Promise.all(created.map(path => media.remove(path))); return; }
        items.push({...item, localPath});
      }
    } catch (error) { await Promise.all(created.map(path => media.remove(path))); throw error; }
    await Promise.all(previous.filter(item => item.localPath && !items.some(next => next.localPath === item.localPath)).map(item => media.remove(item.localPath)));
    if (epoch !== this.epoch || !this.active) { await Promise.all(created.map(path => media.remove(path))); return; }
    this.setData({seriesPurchase: purchase,seriesItems: items,selectedSeriesId: purchase.seriesId,seriesSaved: items.filter(item => this.seriesSavedKeys?.has(`${purchase.purchaseId}:${item.itemId}:${item.asset?.sha256}`)).length});this.updateBundle();
    if (items.some(item => ["pending","retrying"].includes(item.status))) this.timer = setTimeout(() => this.refresh(), 3000);
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
    if (!this.data.bundleCount) { this.setData({error: "这个系列没有适合当前年龄与人数的款式，请换一个系列。"}); return; }
    const fingerprint = JSON.stringify([this.data.rootId,this.data.targetAge,this.data.context.sourceNode.asset.sha256,this.data.selectedSeriesId]);
    if (this.intent?.uncertain && this.intent.fingerprint !== fingerprint) { this.setData({ error: "上次换装结果尚待核对，请恢复原选择重试，避免重复提交。" }); return; }
    if (!this.intent || this.intent.fingerprint !== fingerprint) this.intent = { fingerprint, key: api.idempotencyKey("wardrobe-series"), consentKey: api.idempotencyKey("wardrobe-consent"), uncertain: false, purchaseId: this.data.purchaseId };
    const intent = this.intent;
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
      const purchase = intent.purchaseId ? await purchases.get(intent.purchaseId) : await purchases.create({sku: "wardrobe-series",sourceRootCommandId: this.data.rootId,targetAge: this.data.targetAge,seriesId: this.data.selectedSeriesId},intent.key);
      intent.purchaseId = purchase.purchaseId;
      if (epoch !== this.epoch || !this.active) return;
      this.setData({purchaseId: purchase.purchaseId,commandId: ""});
      await purchases.execute(purchase,{isCurrent: () => this.active && epoch === this.epoch});
      intent.uncertain = false;
      if (epoch !== this.epoch || !this.active) return;
      this.setData({ busy: false, message: "整套换装订单已确认，各款照片会分别显示；原片会保留。" });
      await this.refresh();
    } catch (error) {
      if (codeOf(error) === "PAYMENT_USER_CANCELLED") intent.uncertain = false;
      if (!wasUncertain && /^(CONSENT_REQUIRED|VALIDATION_FAILED|AUTH_FORBIDDEN|WARDROBE_SELF_REQUIRED)$/.test(codeOf(error))) intent.uncertain = false;
      if (epoch === this.epoch && this.active) await this.showError(error);
    } finally { if (epoch === this.epoch && this.active) this.setData({ busy: false }); }
  },
  async saveSeries(event) {
    if (this.data.busy || !this.active) return;
    const requested = event?.currentTarget?.dataset?.item;
    const items = this.data.seriesItems.filter(item => item.status === "ready" && (!requested || item.itemId === requested));
    const epoch = this.epoch, purchaseId = this.data.purchaseId;
    this.setData({busy: true,error: "",message: ""});
    try {
      for (const item of items) {
        if (!this.active || epoch !== this.epoch) return;
        const key = `${purchaseId}:${item.itemId}:${item.asset.sha256}`;
        if (this.seriesSavedKeys.has(key)) continue;
        await media.save(item);this.seriesSavedKeys.add(key);
        if (this.active && epoch === this.epoch) this.setData({seriesSaved: this.data.seriesItems.filter(row => this.seriesSavedKeys.has(`${purchaseId}:${row.itemId}:${row.asset?.sha256}`)).length,message: "已保存的款式会保留，未完成的款式可以继续保存。"});
      }
    } catch (error) { if (this.active && epoch === this.epoch) { if (codeOf(error) === "ALBUM_PERMISSION_REQUIRED") this.setData({albumPermissionDenied: true}); await this.showError(error); } }
    finally { if (this.active && epoch === this.epoch) this.setData({busy: false}); }
  },
  async retrySeries(event) {
    if (this.data.busy || !this.active) return;
    const item = this.data.seriesItems.find(row => row.itemId === event.currentTarget.dataset.item);
    if (!item?.canRetry) return;
    const epoch = this.epoch;this.setData({busy: true,error: ""});
    try { await purchases.retry(this.data.purchaseId,item.itemId,item.attempts+1); if (this.active && epoch === this.epoch) {this.setData({busy:false});await this.refresh();} }
    catch (error) {if (this.active && epoch === this.epoch) await this.showError(error);}
    finally {if (this.active && epoch === this.epoch) this.setData({busy:false});}
  },
  async save() {
    if (this.data.busy || this.data.result?.status !== "ready") return;
    const epoch = this.epoch; this.setData({ busy: true, error: "", message: "", albumPermissionDenied: false });
    try { await media.save(this.data.result); if (epoch === this.epoch && this.active) this.setData({ message: "换装原图已保存到相册。" }); }
    catch (error) { if (epoch === this.epoch && this.active) { if (codeOf(error) === "ALBUM_PERMISSION_REQUIRED") this.setData({albumPermissionDenied: true}); await this.showError(error); } }
    finally { if (epoch === this.epoch && this.active) this.setData({ busy: false }); }
  },
  async albumSettings() {
    if (this.data.busy || !this.active) return;
    const epoch = this.epoch;
    try { const allowed = await media.openAlbumSettings(); if (this.active && epoch === this.epoch) this.setData({albumPermissionDenied: !allowed, message: allowed ? "已允许保存，请再次点击保存原图；会重新校验授权。" : "尚未允许保存，可以稍后再设置。", error: ""}); }
    catch (error) { if (this.active && epoch === this.epoch) await this.showError(error); }
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
    if ((authorizationFailure(error) && codeOf(error) !== "CONSENT_REQUIRED") || /CONTEXT_INVALID|RESULT_INVALID|COMMAND_INVALID|PHOTO_.*(?:INVALID|CHANGED)/.test(codeOf(error))) await this.clearViews();
    const code = codeOf(error);
    const message = code === "ALBUM_PERMISSION_REQUIRED" ? "请在微信设置中允许保存到相册，再重试。" :
      code === "CONSENT_REQUIRED" ? "请等待每位人物独立确认换装用途，再重试。" :
      code === "WARDROBE_SELF_REQUIRED" ? "请由照片参与者本人确认；监护授权需先由服务端核验。" :
      authorizationFailure(error) ? "换装授权已失效，请重新确认；原年龄照片授权可单独管理。" :
      /CONTEXT|RESULT|COMMAND/.test(code) ? "照片或任务信息未通过校验，请从相册重新打开。" :
      /DIGEST|SIZE|DIMENSIONS/.test(code) ? "图片校验未通过，请刷新后重新下载。" :
      /PHOTO_|PAYMENT_|EXTERNAL_ADAPTER_UNAVAILABLE|DEPENDENCY_UNAVAILABLE/.test(code) ? purchases.errorText(error) : "暂时未能完成，请刷新或按原选择重试。";
    this.setData({ error: message });
  },
  onShareAppMessage(event = {}) {
    const participantId = event.target?.dataset?.participant;
    if (!this.data.context || !this.data.people.some(p => p.participantId === participantId && !p.self)) return { title: "一生衣橱 · 人生时光机", path: "/pages/home/index", imageUrl: "/assets/wardrobe-invite.png" };
    return { title: "一生衣橱 · 邀请你确认换装用途", path: `/pages/privacy/index?assetId=${encodeURIComponent(this.data.context.sourceAssetId)}&participantId=${encodeURIComponent(participantId)}&action=wardrobe`, imageUrl: "/assets/wardrobe-invite.png" };
  },
  library() { wx.switchTab({ url: "/pages/library/index" }); },
});
