const api = require("./api");
const session = require("./session");
const media = require("./timeline-media");
const consentPolicy = require("../policies/wardrobe");
const purchases = require("./photo-purchases");
const discovery = require("./wardrobe-catalog");
const LEGACY_CATALOG = "lifetime-wardrobe.v3";
const { ROYAL_CATALOG, CINEMA_CATALOG } = discovery;
const isNewCatalog = version => version === ROYAL_CATALOG || version === CINEMA_CATALOG;
const catalogRoute = version => version === CINEMA_CATALOG ? "/pages/wardrobe-cinema/index" : "/pages/wardrobe/index";
const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const codeOf = error => error && typeof error.message === "string" ? error.message : "";
const authorizationFailure = error => /CONSENT|AUTH|PRIVACY|TIMELINE_DOWNLOAD_HTTP_(401|403|409)/.test(codeOf(error));
const dressPerson = (person, styles, seriesId) => {
  const selected = styles.find(s => s.id === person.styleId);
  return { ...person, seriesId: seriesId || selected.seriesId, selectedLabel: selected.label, options: styles.filter(s => s.seriesId === (seriesId || selected.seriesId)) };
};

module.exports = (defaultCatalog = ROYAL_CATALOG, reference) => ({
  ...reference,
  data: { rootId: "", targetAge: 0, context: null, people: [], styles: [], series: [], visibleSeries: [], categories: [], categoryId: "all", seriesQuery: "", onlyAvailable: false, styleCount: 0, availableSeriesCount: 0, selectedSeries: null, templateStyles: [], focusedTemplate: null, templatePosition: 0, sourcePath: "", resultPath: "", commandId: "", result: null, accepted: false, busy: false, albumPermissionDenied: false, error: "", message: "", selectedSeriesId: "daily", bundleStyles: [], bundleCount: 0, purchaseId: "", seriesPurchase: null, seriesItems: [], retailPriceSeries: purchases.money(purchases.PRICES["wardrobe-series"]), priceSeries: purchases.money(purchases.PRICES["wardrobe-series"]), seriesSaved: 0 },
  active: false, epoch: 0, timer: null, intent: null,
  async onLoad(options) {
    const openingEpoch = ++this.epoch;
    this.seriesSavedKeys = new Set();
    if (reference) this.setData({referenceEnabled: true});
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
        this.purchaseCatalog = isNewCatalog(purchase.catalogVersion) ? purchase.catalogVersion : LEGACY_CATALOG;
        if (catalogRoute(this.purchaseCatalog) !== catalogRoute(defaultCatalog)) {
          wx.redirectTo({url: `${catalogRoute(this.purchaseCatalog)}?purchaseId=${encodeURIComponent(purchase.purchaseId)}`});
          return;
        }
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
    this.catalogGroups = [];
    this.clearCustomTemplate?.();
    this.setData({ context: null, people: [], styles: [], series: [], visibleSeries: [], categories: [], styleCount: 0, availableSeriesCount: 0, selectedSeries: null, templateStyles: [], focusedTemplate: null, templatePosition: 0, sourcePath: "", resultPath: "", result: null, seriesPurchase: null, seriesItems: [], bundleStyles: [], bundleCount: 0, accepted: false, busy: false, albumPermissionDenied: false });
    await Promise.all(paths.filter(Boolean).map(path => media.remove(path)));
  },
  async refresh() {
    if (!this.active || !this.data.rootId) return;
    this.stop(); const epoch = ++this.epoch;
    this.setData({ busy: true, error: "" });
    try {
      let view;
      let requestedCatalog = this.purchaseCatalog || defaultCatalog;
      if (this.data.commandId && !this.data.purchaseId) {
        const result = await api.requestForPurpose(`/v1/timelines/${encodeURIComponent(this.data.commandId)}`, "age_transformation", { method: "GET" });
        if (!this.active || epoch !== this.epoch) return;
        view = result?.data;
        const selections = view?.wardrobeSource?.selections;
        const styleIds = Array.isArray(selections) ? selections.map(s => s?.styleId).filter(id => typeof id === "string") : [];
        requestedCatalog = styleIds.some(id => id.startsWith("cinema-")) ? CINEMA_CATALOG
          : styleIds.some(id => id.startsWith("royal-")) ? ROYAL_CATALOG : LEGACY_CATALOG;
        if (catalogRoute(requestedCatalog) !== catalogRoute(defaultCatalog)) {
          wx.redirectTo({url: `${catalogRoute(requestedCatalog)}?rootId=${encodeURIComponent(this.data.rootId)}&age=${this.data.targetAge}&commandId=${encodeURIComponent(this.data.commandId)}`});
          return;
        }
      }
      const response = await api.requestForPurpose(`/v1/timelines/${encodeURIComponent(this.data.rootId)}/nodes/${this.data.targetAge}/wardrobe?catalogVersion=${requestedCatalog}`, "age_transformation", { method: "GET" });
      if (!this.active || epoch !== this.epoch) return;
      const context = response && response.data;
      if (!context || context.sourceRootCommandId !== this.data.rootId || context.targetAge !== this.data.targetAge || context.policyVersion !== consentPolicy.version ||
          !validId(context.sourceAssetId) || !Array.isArray(context.participants) || context.participants.length < 1 || context.participants.length > 2 || new Set(context.participants.map(p => p.participantId)).size !== context.participants.length ||
          context.participants.some(p => !validId(p.participantId)) || context.sourceNode?.status !== "ready" || context.sourceNode.targetAge !== this.data.targetAge) throw new Error("WARDROBE_CONTEXT_INVALID");
      const groups = discovery.catalog(context);
      if ((defaultCatalog === CINEMA_CATALOG) !== (context.catalogVersion === CINEMA_CATALOG)) throw new Error("WARDROBE_CONTEXT_INVALID");
      const selectedSeriesId = groups.some(group => group.id === this.data.selectedSeriesId) ? this.data.selectedSeriesId : groups[0].id;
      const defaultStyle = isNewCatalog(context.catalogVersion) ? context.styles.find(style => style.seriesId === selectedSeriesId).id : "daily-white-v1";
      const active = session.requireSession(), previous = this.data.people.length ? this.data.people : this.intent?.selections || [];
      const people = context.participants.map(p => {
        const old = previous.find(old => old.participantId === p.participantId && context.styles.some(s => s.id === old.styleId && s.available));
        const styleId = old?.styleId || defaultStyle;
        return dressPerson({ ...p, self: p.participantId === active.actorId, label: p.position === "single" ? "照片里的人" : p.position === "left" ? "左侧人物" : "右侧人物", styleId }, context.styles, old?.seriesId);
      });
      const sameSource = this.data.context?.sourceNode.asset.sha256 === context.sourceNode.asset.sha256;
      if (!sameSource && this.data.sourcePath) await media.remove(this.data.sourcePath);
      if (epoch !== this.epoch) return;
      this.catalogGroups = groups;
      this.setData({ context, people, styles: context.styles, selectedSeriesId, sourcePath: sameSource ? this.data.sourcePath : "" });
      this.loadCustomTemplate?.(active);
      this.updateBundle();
      if (!this.data.sourcePath && context.sourceNode.downloadPath) {
        const path = await media.download(context.sourceNode);
        if (epoch !== this.epoch || !this.active) { await media.remove(path); return; }
        this.setData({ sourcePath: path });
      }
      if (this.data.purchaseId) await this.loadSeries(epoch);
      else if (this.data.commandId) await this.loadResult(epoch, view);
    } catch (error) { if (epoch === this.epoch && this.active) await this.showError(error); }
    finally { if (epoch === this.epoch && this.active) this.setData({ busy: false }); }
  },
  updateBundle(onRendered, preferredStyleIds = []) {
    const selected = this.data.selectedSeriesId;
    const view = discovery.discover(this.data.styles, this.catalogGroups || [], {category:this.data.categoryId,query:this.data.seriesQuery,onlyAvailable:this.data.onlyAvailable});
    const selectedSeries = view.series.find(group => group.id === selected) || null;
    const quote = this.data.seriesPurchase?.seriesId === selected ? this.data.seriesPurchase : null;
    const selectedStyles = this.data.styles.filter(style => style.seriesId === selected && (!quote || quote.items.some(item=>item.itemId===style.id)));
    const templateStyles = selectedSeries ? selectedStyles.map((style,index)=>discovery.presentStyle(style,index,selectedSeries.palette)) : [];
    const bundleStyles = templateStyles.filter(style => style.available);
    const matchedTemplate = bundleStyles.find(style => preferredStyleIds.includes(style.id));
    const focusedTemplate = matchedTemplate || templateStyles.find(style => style.id === this.data.focusedTemplate?.id && style.available) || bundleStyles[0] || templateStyles[0] || null;
    const templatePosition = bundleStyles.findIndex(style => style.id === focusedTemplate?.id) + 1;
    this.setData({ ...view, selectedSeries, templateStyles, focusedTemplate, templatePosition, bundleStyles, bundleCount: bundleStyles.length },
      onRendered && (() => onRendered(focusedTemplate, matchedTemplate)));
  },
  switchCollection() {
    if (!this.active || this.data.busy || this.data.purchaseId || this.data.commandId || this.intent?.uncertain) return;
    const next = defaultCatalog === CINEMA_CATALOG ? ROYAL_CATALOG : CINEMA_CATALOG;
    wx.redirectTo({url: `${catalogRoute(next)}?rootId=${encodeURIComponent(this.data.rootId)}&age=${this.data.targetAge}`});
  },
  previewOutfit(event) {
    const index = this.data.bundleStyles.findIndex(style => style.id === event.currentTarget.dataset.style);
    this.focusTemplate(index, true);
  },
  stepTemplate(event) {
    const { step } = event.currentTarget.dataset;
    if (!this.data.templatePosition || (step !== "previous" && step !== "next")) return;
    this.focusTemplate(this.data.templatePosition - 1 + (step === "next" ? 1 : -1));
  },
  focusTemplate(index, scrollToDetail = false) {
    const style = this.data.bundleStyles[index];
    if (!this.active || this.data.busy || !style) return;
    const epoch = this.epoch;
    const onRendered = scrollToDetail ? () => {
      if (this.active && this.epoch === epoch && this.data.focusedTemplate?.id === style.id) {
        wx.pageScrollTo({ selector: "#wardrobe-template-detail", duration: 240 });
      }
    } : undefined;
    this.setData({ focusedTemplate: style, templatePosition: index + 1 }, onRendered);
  },
  showTemplateGrid() {
    if (this.active && this.data.selectedSeries) {
      wx.pageScrollTo({ selector: "#wardrobe-template-grid", duration: 240 });
    }
  },
  searchSeries(event) { this.setData({seriesQuery:String(event.detail.value || "").slice(0,40)});this.updateBundle(); },
  filterCategory(event) { const id=event.currentTarget.dataset.category;if (!this.data.categories.some(group=>group.id===id)) return;this.setData({categoryId:id});this.updateBundle(); },
  filterAvailable(event) { this.setData({onlyAvailable:event.detail.value === true});this.updateBundle(); },
  clearDiscovery() { this.setData({seriesQuery:"",categoryId:"all",onlyAvailable:false});this.updateBundle(); },
  async selectBundle(event) {
    const id = event.currentTarget.dataset.series;
    const group = this.data.series.find(item => item.id === id && item.count > 0);
    if (!this.active || this.data.busy || !group) return;
    if (this.intent?.uncertain && id !== this.data.selectedSeriesId) { this.setData({error: "上次订单尚待核对，请先恢复原选择并继续，避免重复付款。"}); return; }
    const epoch = this.epoch;
    const query = this.data.seriesQuery;
    const showSelection = (focused, matched) => {
      if (!this.active || this.epoch !== epoch || this.data.selectedSeriesId !== id || this.data.seriesQuery !== query ||
          this.data.focusedTemplate?.id !== focused?.id) return;
      if (matched) wx.pageScrollTo({ selector: "#wardrobe-template-detail", duration: 240 });
      else this.showTemplateGrid();
    };
    if (id !== this.data.selectedSeriesId) {
      const paths = this.data.seriesItems.map(item => item.localPath).filter(Boolean);
      this.intent = null;
      this.setData({ selectedSeriesId: id, priceSeries: this.data.retailPriceSeries, purchaseId: "", seriesPurchase: null, seriesItems: [], seriesSaved: 0 });
      this.updateBundle(showSelection, group.matchedStyleIds);
      await Promise.all(paths.map(path => media.remove(path)));
    } else if (group.matchedStyleIds.length) {
      this.updateBundle(showSelection, group.matchedStyleIds);
    } else {
      this.showTemplateGrid();
    }
  },
  async loadSeries(epoch) {
    const purchase = await purchases.get(this.data.purchaseId);
    if (epoch !== this.epoch || !this.active) return;
    const allowed = this.data.styles.filter(style => style.seriesId === purchase.seriesId && style.available);
    const oldCatalog = purchase.catalogVersion === undefined || ["lifetime-wardrobe.v1","lifetime-wardrobe.v2"].includes(purchase.catalogVersion);
    if (purchase.sku !== "wardrobe-series" || purchase.sourceRootCommandId !== this.data.rootId ||
        (oldCatalog ? purchase.expectedCount < 1 || purchase.expectedCount > 4 : purchase.catalogVersion !== this.data.context.catalogVersion || purchase.expectedCount !== allowed.length) || purchase.items.length !== purchase.expectedCount ||
        purchase.items.some(item => item.targetAge !== this.data.targetAge || !allowed.some(style => style.id === item.itemId)) || new Set(purchase.items.map(item => item.itemId)).size !== purchase.expectedCount) throw new Error("PHOTO_PURCHASE_INVALID");
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
    this.setData({seriesPurchase: purchase,priceSeries:purchases.money(purchase.amountMinor),seriesItems: items,selectedSeriesId: purchase.seriesId,seriesSaved: items.filter(item => this.seriesSavedKeys?.has(`${purchase.purchaseId}:${item.itemId}:${item.asset?.sha256}`)).length});this.updateBundle();
    if (items.some(item => ["pending","retrying"].includes(item.status))) this.timer = setTimeout(() => this.refresh(), 3000);
  },
  async loadResult(epoch, view) {
    const commandId = this.data.commandId;
    if (epoch !== this.epoch || !this.active) return;
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
      const version = this.data.context.catalogVersion;
      const purchase = intent.purchaseId ? await purchases.get(intent.purchaseId) : await purchases.create({sku: "wardrobe-series",sourceRootCommandId: this.data.rootId,targetAge: this.data.targetAge,seriesId: this.data.selectedSeriesId,
        ...(isNewCatalog(version) ? {catalogVersion: version} : {})},intent.key);
      intent.purchaseId = purchase.purchaseId;
      this.purchaseCatalog = isNewCatalog(version) ? version : LEGACY_CATALOG;
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
