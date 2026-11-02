const api = require("../../services/api");
const session = require("../../services/session");
const policy = require("../../services/policy");
const sharingPolicy = require("../../policies/sharing");
const media = require("../../services/timeline-media");

Page({
  data: { items: [], shareReadyIds: [], error: "", activeCommandId: "", delivery: null, selectedAge: 0, selectedNode: null, previewPath: "", timelineBusy: false, timelineMessage: "", batchSaving: false, batchSaved: 0, batchTotal: 0, albumPermissionDenied: false },
  batchState: null, batchSignal: null,
  timelineEpoch: 0,
  timelineTimer: null,
  loadEpoch: 0,
  shareGrants: Object.create(null),
  shareSubmitting: new Set(),
  shareTimers: Object.create(null),
  onShow() { if (!session.get()) wx.navigateTo({ url: "/pages/auth/index" }); else this.load(); },
  onHide() { this.clearPrivateState(); },
  onUnload() { this.clearPrivateState(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    const loadEpoch = ++this.loadEpoch;
    this.stopAllSharePolling();
    try {
      const [result, grantResult] = await Promise.all([
        api.requestForPurpose("/v1/queries", "age_transformation", { data: { query: "record.list", input: { collection: "generation.timeline-commands", limit: 200 } } }),
        api.requestForPurpose("/v1/queries", "sharing", { data: { query: "share-grant.list", input: { limit: 50 } } }),
      ]);
      const records = result && Array.isArray(result.data) ? result.data : [];
      if (loadEpoch !== this.loadEpoch) return;
      const items = await Promise.all(records.filter(record => !(record.data && record.data.retryOfCommandId)).map(async (record) => {
        let previewUrl = "";
        if (record.data && typeof record.data.previewUrl === "string" && /^https:\/\//.test(record.data.previewUrl) && Date.parse(record.data.previewExpiresAt) > Date.now()) {
          previewUrl = record.data.previewUrl;
          session.trackPrivateUrl(previewUrl);
        }
        return {
          id: record.id,
          creationKind: record.data && record.data.wardrobeEdit ? "wardrobe" : "age",
          wardrobeRootId: record.data && record.data.wardrobeEdit && record.data.wardrobeEdit.sourceRootCommandId || "",
          wardrobeAge: record.data && record.data.wardrobeEdit ? record.data.wardrobeEdit.targetAge : null,
          state: record.data && (record.data.state || record.data.commandState) || "processing",
          previewUrl,
          participantIds: record.participantIds || record.data && record.data.participantIds || [],
          provenanceId: record.data && record.data.provenanceId || "",
        };
      }));
      const workIds = new Set(items.map((item) => item.id));
      if (loadEpoch !== this.loadEpoch) return;
      const grants = grantResult && Array.isArray(grantResult.data) ? grantResult.data : [];
      const shareGrants = Object.create(null);
      const shareReadyIds = new Set();
      const pending = [];
      for (const projection of grants) {
        if (!validGrantProjection(projection) || !workIds.has(projection.workId)) continue;
        const workGrants = shareGrants[projection.workId] || [];
        if (workGrants.some((grant) => grant.commandId === projection.exportCommandId)) continue;
        if (projection.state === "active") {
          if (!validReference(projection.providerOperationId) || Date.parse(projection.expiresAt) <= Date.now()) continue;
          workGrants.push(grantFromProjection(projection));
          shareReadyIds.add(projection.workId);
        } else if (projection.state === "publication_pending" || projection.state === "revocation_requested" ||
            projection.state === "revocation_required" || projection.state === "revocation_failed" ||
            projection.state === "reconciliation_required") {
          workGrants.push(grantFromProjection(projection));
          pending.push({ workId: projection.workId, commandId: projection.exportCommandId, state: projection.state });
        }
        if (workGrants.length > 0) shareGrants[projection.workId] = workGrants;
      }
      this.shareGrants = shareGrants;
      this.setData({
        items: items.map((item) => ({ ...item, shareReady: shareReadyIds.has(item.id) })),
        shareReadyIds: [...shareReadyIds],
        error: "",
      });
      for (const grant of pending) {
        if (grant.state === "publication_pending") this.scheduleSharePolling(grant.commandId, () => this.refreshShareGrant(grant.workId, grant.commandId));
        else if (grant.state === "revocation_requested" || grant.state === "revocation_required") {
          this.scheduleSharePolling(grant.commandId, () => this.refreshShareRevocation(grant.workId, grant.commandId));
        }
      }
    } catch (error) {
      if (loadEpoch !== this.loadEpoch) return;
      this.stopAllSharePolling();
      this.shareGrants = Object.create(null);
      this.setData({ items: [], shareReadyIds: [], error: error instanceof Error ? error.message : "LIBRARY_UNAVAILABLE" });
    }
  },
  async openTimeline(event) {
    if (this.data.timelineBusy) return;
    const commandId = event.currentTarget.dataset.id;
    if (!validReference(commandId)) return;
    const item = this.data.items.find(item => item.id === commandId);
    if (item && item.creationKind === "wardrobe") {
      if (!validReference(item.wardrobeRootId) || !Number.isInteger(item.wardrobeAge) || item.wardrobeAge < 0 || item.wardrobeAge > 100) { this.setData({ error: "换装来源信息无效，请刷新相册。" }); return; }
      wx.navigateTo({ url: `/pages/wardrobe/index?rootId=${encodeURIComponent(item.wardrobeRootId)}&age=${item.wardrobeAge}&commandId=${encodeURIComponent(commandId)}` }); return;
    }
    const epoch = ++this.timelineEpoch;
    await media.clearAll();
    if (epoch !== this.timelineEpoch) return;
    this.setData({ activeCommandId: commandId, delivery: null, selectedNode: null, previewPath: "", selectedAge: 0, timelineMessage: "" });
    await this.refreshTimeline();
  },
  changeClothes() {
    if (this.data.timelineBusy || !validReference(this.data.activeCommandId) || this.data.selectedNode?.status !== "ready" || this.data.delivery?.creationKind === "wardrobe") return;
    wx.navigateTo({ url: `/pages/wardrobe/index?rootId=${encodeURIComponent(this.data.activeCommandId)}&age=${this.data.selectedNode.targetAge}` });
  },
  async refreshTimeline() {
    if (!this.data.activeCommandId) return;
    if (this.timelineTimer) clearTimeout(this.timelineTimer);
    this.timelineTimer = null;
    const epoch = ++this.timelineEpoch, commandId = this.data.activeCommandId;
    this.setData({ timelineBusy: true, timelineMessage: "" });
    try {
      const result = await api.requestForPurpose(`/v1/timelines/${encodeURIComponent(commandId)}`, "age_transformation", { method: "GET" });
      if (epoch !== this.timelineEpoch) return;
      const view = result && result.data;
      if (!view || view.commandId !== commandId || !Number.isInteger(view.expectedCount) || view.expectedCount < 1 || view.expectedCount > 101 || !Array.isArray(view.nodes) || view.nodes.length !== view.expectedCount ||
          new Set(view.nodes.map(node => node.targetAge)).size !== view.nodes.length ||
          view.nodes.some(node => !Number.isInteger(node.targetAge) || node.targetAge < 0 || node.targetAge > 100 || !["pending","ready","failed","review","retrying","reconciliation_required"].includes(node.status) || (node.status === "ready" && (!node.asset || !/^[a-f0-9]{64}$/.test(node.asset.sha256) || !Number.isInteger(node.asset.width) || node.asset.width < 1 || !Number.isInteger(node.asset.height) || node.asset.height < 1)))) throw new Error("TIMELINE_PROJECTION_INVALID");
      const selectedNode = view.nodes.find(node => node.targetAge === this.data.selectedAge) || view.nodes[0];
      const keepPreview = selectedNode && selectedNode.status === "ready" && selectedNode.asset && this.data.selectedNode && this.data.selectedNode.asset && selectedNode.asset.sha256 === this.data.selectedNode.asset.sha256;
      if (!keepPreview && this.data.previewPath) await media.remove(this.data.previewPath);
      if (epoch !== this.timelineEpoch) return;
      this.setData({ delivery: view, selectedAge: selectedNode.targetAge, selectedNode, previewPath: keepPreview ? this.data.previewPath : "" });
      const ready = view.nodes.filter(node => node.status === "ready" && node.downloadPath), batch = this.batchFor(commandId, true);
      this.setData({batchTotal: ready.length, batchSaved: ready.filter(node => batch.completed.has(batchKey(node))).length});
      if (!keepPreview && selectedNode.status === "ready" && selectedNode.downloadPath) {
        const path = await media.download(selectedNode);
        if (epoch !== this.timelineEpoch) { await media.remove(path); return; }
        this.setData({ previewPath: path });
      }
      if (view.nodes.some(node => node.status === "pending" || node.status === "retrying")) this.timelineTimer = setTimeout(() => this.refreshTimeline(), 3000);
    } catch (error) {
      if (epoch !== this.timelineEpoch) return;
      if (authorizationFailure(error) || errorCode(error) === "TIMELINE_PROJECTION_INVALID") {
        await media.clearAll();
        if (epoch !== this.timelineEpoch) return;
        this.setData({ delivery: null, selectedNode: null, previewPath: "", batchSaved: 0, batchTotal: 0 });
        this.batchState = null;
      }
      this.setData({ timelineMessage: timelineError(error) });
    } finally { if (epoch === this.timelineEpoch) this.setData({ timelineBusy: false }); }
  },
  async selectAge(event) {
    if (this.data.timelineBusy || !this.data.delivery) return;
    const age = Number(event.currentTarget.dataset.age), node = this.data.delivery.nodes.find(node => node.targetAge === age);
    if (!node) return;
    const epoch = this.timelineEpoch;
    if (this.data.previewPath) await media.remove(this.data.previewPath);
    if (epoch !== this.timelineEpoch) return;
    this.setData({ selectedAge: age, selectedNode: node, previewPath: "", timelineMessage: "" });
    await this.refreshTimeline();
  },
  async saveOriginal() {
    if (this.data.timelineBusy || !this.data.selectedNode || this.data.selectedNode.status !== "ready") return;
    const epoch = this.timelineEpoch;
    this.setData({ timelineBusy: true, timelineMessage: "", albumPermissionDenied: false });
    try { await media.save(this.data.selectedNode); if (epoch === this.timelineEpoch) this.setData({ timelineMessage: "原图已保存到相册" }); }
    catch (error) {
      if (epoch !== this.timelineEpoch) return;
      if (authorizationFailure(error)) { await media.clearAll(); if (epoch !== this.timelineEpoch) return; this.batchState = null; this.setData({ delivery: null, selectedNode: null, previewPath: "", batchSaved: 0, batchTotal: 0 }); }
      this.setData({ timelineMessage: timelineError(error) });
      if (errorCode(error) === "ALBUM_PERMISSION_REQUIRED") this.setData({albumPermissionDenied: true});
    }
    finally { if (epoch === this.timelineEpoch) this.setData({ timelineBusy: false }); }
  },
  batchFor(commandId, verified = false) {
    const actor = session.requireSession(), owner = JSON.stringify([actor.tenantId, actor.actorId]);
    if (!verified && this.batchState && this.batchState.owner !== owner) throw new Error("AUTHENTICATION_REQUIRED");
    if (!this.batchState || this.batchState.owner !== owner || this.batchState.commandId !== commandId) this.batchState = {owner, commandId, completed: new Set()};
    return this.batchState;
  },
  async saveAll() {
    if (this.data.timelineBusy || !this.data.delivery || !this.data.activeCommandId) return;
    const epoch = this.timelineEpoch, commandId = this.data.activeCommandId;
    const nodes = this.data.delivery.nodes.filter(node => node.status === "ready" && node.downloadPath);
    if (!nodes.length) return;
    let state;
    try { state = this.batchFor(commandId); }
    catch (error) { await media.clearAll(); if (epoch !== this.timelineEpoch) return; this.batchState = null; this.setData({delivery: null, selectedNode: null, previewPath: "", batchSaved: 0, batchTotal: 0, timelineMessage: timelineError(error)}); return; }
    const signal = {cancelled: false}; this.batchSignal = signal;
    if (this.timelineTimer) clearTimeout(this.timelineTimer); this.timelineTimer = null;
    this.setData({timelineBusy: true, batchSaving: true, batchTotal: nodes.length, batchSaved: nodes.filter(n => state.completed.has(batchKey(n))).length, albumPermissionDenied: false, timelineMessage: "正在逐张保存原图；本次页面内已保存的照片会跳过。"});
    try {
      for (const node of nodes) {
        if (signal.cancelled || epoch !== this.timelineEpoch) break;
        const actor = session.requireSession();
        if (JSON.stringify([actor.tenantId, actor.actorId]) !== state.owner) throw new Error("AUTHENTICATION_REQUIRED");
        const key = batchKey(node); if (state.completed.has(key)) continue;
        await media.save(node, signal);
        state.completed.add(key);
        if (epoch !== this.timelineEpoch) return;
        this.setData({batchSaved: nodes.filter(n => state.completed.has(batchKey(n))).length});
      }
      if (epoch === this.timelineEpoch) this.setData({timelineMessage: signal.cancelled ? "已停止后续保存。可继续保存剩余照片；已交给系统的本张可能完成。" : "本次就绪的原图已保存。之后生成的照片可刷新后补存。"});
    } catch (error) {
      if (epoch !== this.timelineEpoch) return;
      if (authorizationFailure(error)) {
        await media.clearAll(); if (epoch !== this.timelineEpoch) return;
        this.batchState = null; this.setData({delivery: null, selectedNode: null, previewPath: "", batchSaved: 0, batchTotal: 0});
      }
      this.setData({albumPermissionDenied: errorCode(error) === "ALBUM_PERMISSION_REQUIRED", timelineMessage: signal.cancelled ? "已停止保存，可继续剩余照片。" : timelineError(error)});
    } finally {
      if (this.batchSignal === signal) this.batchSignal = null;
      if (epoch === this.timelineEpoch) this.setData({timelineBusy: false, batchSaving: false});
    }
  },
  cancelBatch() { if (this.batchSignal) this.batchSignal.cancelled = true; },
  async albumSettings() {
    if (this.data.timelineBusy) return;
    const epoch = this.timelineEpoch;
    try { const allowed = await media.openAlbumSettings(); if (epoch === this.timelineEpoch) this.setData({albumPermissionDenied: !allowed, timelineMessage: allowed ? "已允许保存，请再次点击保存；会重新校验照片授权。" : "尚未允许保存，可以稍后再设置。"}); }
    catch (error) { if (epoch === this.timelineEpoch) this.setData({timelineMessage: timelineError(error)}); }
  },
  async retryAge() {
    const node = this.data.selectedNode;
    if (this.data.timelineBusy || !node || !node.canRetry) return;
    const epoch = this.timelineEpoch;
    this.setData({ timelineBusy: true, timelineMessage: "" });
    try {
      await api.requestForPurpose(`/v1/timelines/${encodeURIComponent(this.data.activeCommandId)}/retry`, "age_transformation", {
        data: { targetAge: node.targetAge, attempt: node.attempts + 1 }, headers: { "Idempotency-Key": api.idempotencyKey("timeline-retry") },
      });
      if (epoch !== this.timelineEpoch) return;
      this.setData({ timelineBusy: false }); await this.refreshTimeline();
    } catch (error) { if (epoch === this.timelineEpoch) this.setData({ timelineBusy: false, timelineMessage: timelineError(error) }); }
  },
  async prepareShare(event) {
    const workId = event.currentTarget.dataset.id;
    if (!validReference(workId) || this.shareSubmitting.has(workId)) return;
    const submitting = this.shareSubmitting; submitting.add(workId);
    const epoch = this.loadEpoch, actor = session.get();
    try {
      policy.requireCapabilities(["B10"], session.requireSession().roles);
      const item = this.data.items.find((candidate) => candidate.id === workId);
      if (!item || item.participantIds.length === 0 || !item.provenanceId) throw new Error("SHARE_AUTHORIZATION_CONTEXT_MISSING");
      const existing = grantsForWork(this.shareGrants, workId);
      if (existing.some((grant) => grant.reference && Date.parse(grant.expiresAt) > Date.now())) {
        this.setShareReady(workId, true);
        return;
      }
      if (existing.some((grant) => Date.parse(grant.expiresAt) > Date.now())) throw new Error("SHARE_GRANT_ALREADY_PENDING");
      for (const grant of existing) this.stopSharePolling(grant.commandId);
      delete this.shareGrants[workId];
      await this.ensureExplicitSharingConsent(workId, item.participantIds, epoch, actor);
      if (!this.shareCurrent(epoch, actor)) return;
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const key = api.idempotencyKey("share");
      const result = await api.requestForPurpose("/v1/capabilities/B10", "sharing", {
        data: { workId, participantIds: item.participantIds, format: "single_image", visibility: "link", expiresAt, aiLabel: true, provenanceId: item.provenanceId, revocable: true, containsMinor: false },
        headers: { "Idempotency-Key": key },
      });
      const command = result && result.data;
      if (!this.shareCurrent(epoch, actor)) return;
      if (!command || typeof command.recordId !== "string" || typeof command.externalCommandId !== "string") throw new Error("SHARE_COMMAND_INVALID");
      this.shareGrants[workId] = [{
        workId,
        recordId: command.recordId,
        commandId: command.externalCommandId,
        reference: "",
        expiresAt,
        state: "publication_pending",
      }];
      this.setShareReady(workId, false);
      this.setData({ error: "分享请求已提交；仅在服务端返回可撤销授权后才允许转发" });
      await this.refreshShareGrant(workId, command.externalCommandId);
    } catch (error) {
      if (!this.shareCurrent(epoch, actor)) return;
      const message = error instanceof Error ? error.message : "SHARE_GRANT_FAILED";
      this.setData({ error: new Set(["CONSENT_REQUIRED", "CONSENT_WITHDRAWN"]).has(message)
        ? "等待所有参与者或其监护人完成独立分享授权"
        : message });
    } finally { submitting.delete(workId); }
  },
  shareCurrent(epoch, actor) {
    const current = session.get();
    return epoch === this.loadEpoch && actor && current && actor.actorId === current.actorId && actor.tenantId === current.tenantId && actor.accessToken === current.accessToken;
  },
  async ensureExplicitSharingConsent(workId, participantIds, epoch = this.loadEpoch, actor = session.get()) {
    const activeSession = session.requireSession();
    if (participantIds.length !== 1 || participantIds[0] !== activeSession.actorId) {
      // A participant or guardian must grant their own exact work scope. This
      // client never creates consent for somebody else; B10 remains the final
      // server-side all-participant gate.
      return;
    }
    if (typeof wx.showModal !== "function") throw new Error("SHARING_CONFIRMATION_UNAVAILABLE");
    const confirmation = await new Promise((resolve, reject) => wx.showModal({
      title: "单独授权分享",
      content: sharingPolicy.text,
      confirmText: "同意分享",
      cancelText: "取消",
      success: resolve,
      fail: reject,
    }));
    if (!this.shareCurrent(epoch, actor)) throw new Error("SHARE_REQUEST_CANCELLED");
    if (!confirmation || confirmation.confirm !== true) throw new Error("SHARING_CONSENT_NOT_CONFIRMED");
    const consentId = api.idempotencyKey("sharing-consent");
    await api.requestForPurpose("/v1/commands", "sharing", {
      data: {
        command: "consent.grant",
        input: {
          id: consentId,
          participantId: activeSession.actorId,
          grantorCapacity: "self",
          purpose: "sharing",
          scope: { resource: `work:${workId}`, actions: ["share"] },
          policyVersion: sharingPolicy.version,
        },
      },
      headers: { "Idempotency-Key": consentId },
    });
  },
  async refreshShareGrant(workId, commandId) {
    const epoch = this.loadEpoch, actor = session.get();
    const grant = grantByCommand(this.shareGrants, workId, commandId);
    if (!grant || Date.parse(grant.expiresAt) <= Date.now()) {
      this.stopSharePolling(commandId);
      if (grant) {
        removeGrant(this.shareGrants, workId, commandId);
        this.setShareReady(workId, false);
        this.setData({ error: "分享授权已过期" });
      }
      return;
    }
    try {
      const result = await api.requestForPurpose("/v1/queries", "sharing", {
        data: { query: "share-grant.get", input: { exportCommandId: commandId } },
      });
      const projection = result && result.data;
      if (!this.shareCurrent(epoch, actor)) return;
      if (!validGrantProjection(projection) || projection.exportCommandId !== commandId ||
          projection.exportRecordId !== grant.recordId || projection.workId !== workId) throw new Error("SHARE_COMMAND_BINDING_INVALID");
      if (projection.state === "active") {
        if (!validReference(projection.providerOperationId)) throw new Error("SHARE_REFERENCE_INVALID");
        replaceGrant(this.shareGrants, workId, grantFromProjection(projection));
        this.stopSharePolling(commandId);
        this.setShareReady(workId, true);
        this.setData({ error: "" });
        return;
      }
      if (projection.state === "revocation_required" && projection.revokeCommandId) {
        replaceGrant(this.shareGrants, workId, grantFromProjection(projection));
        this.stopSharePolling(commandId);
        this.setShareReady(workId, false);
        this.scheduleSharePolling(commandId, () => this.refreshShareRevocation(workId, commandId));
        return;
      }
      if (new Set(["unavailable", "revoked", "revocation_failed", "reconciliation_required", "revocation_required"]).has(projection.state)) {
        this.stopSharePolling(commandId);
        if (projection.state === "revoked" || projection.state === "unavailable") removeGrant(this.shareGrants, workId, commandId);
        else replaceGrant(this.shareGrants, workId, grantFromProjection(projection));
        this.setShareReady(workId, hasActiveGrant(this.shareGrants, workId));
        this.setData({ error: `分享授权未完成：${projection.state}` });
        return;
      }
      if (projection.state === "expired") {
        this.stopSharePolling(commandId);
        removeGrant(this.shareGrants, workId, commandId);
        this.setShareReady(workId, hasActiveGrant(this.shareGrants, workId));
        this.setData({ error: "分享授权已过期" });
        return;
      }
      if (projection.state !== "publication_pending") throw new Error("SHARE_COMMAND_STATE_INVALID");
      replaceGrant(this.shareGrants, workId, grantFromProjection(projection));
      this.scheduleSharePolling(commandId, () => this.refreshShareGrant(workId, commandId));
    } catch (error) {
      if (!this.shareCurrent(epoch, actor)) return;
      this.stopSharePolling(commandId);
      removeGrant(this.shareGrants, workId, commandId);
      this.setShareReady(workId, hasActiveGrant(this.shareGrants, workId));
      this.setData({ error: error instanceof Error ? error.message : "SHARE_STATUS_UNAVAILABLE" });
    }
  },
  async revoke(event) {
    const workId = event.currentTarget.dataset.id;
    const epoch = this.loadEpoch, actor = session.get();
    try {
      const grants = grantsForWork(this.shareGrants, workId);
      if (grants.length === 0) throw new Error("ACTIVE_SHARE_GRANT_NOT_FOUND");
      // Disable every local reference before any network call. A work can have
      // multiple independent provider grants and none may remain hidden/active.
      this.shareGrants[workId] = grants.map((grant) => ({ ...grant, reference: "", state: "revocation_requested" }));
      this.setShareReady(workId, false);
      for (const grant of grants) {
        if (!this.shareCurrent(epoch, actor)) return;
        await api.requestForPurpose("/v1/commands", "sharing", {
          data: { command: "share-grant.revoke", input: { exportCommandId: grant.commandId, reason: "user_requested" } },
          headers: { "Idempotency-Key": api.idempotencyKey("share-revoke") },
        });
        this.stopSharePolling(grant.commandId);
      }
      if (!this.shareCurrent(epoch, actor)) return;
      this.setData({ error: "撤销请求已提交；等待服务商签名确认" });
      await Promise.all(grants.map((grant) => this.refreshShareRevocation(workId, grant.commandId)));
    } catch (error) { if (this.shareCurrent(epoch, actor)) this.setData({ error: error instanceof Error ? error.message : "SHARE_REVOKE_FAILED" }); }
  },
  async refreshShareRevocation(workId, exportCommandId) {
    const epoch = this.loadEpoch, actor = session.get();
    const grant = grantByCommand(this.shareGrants, workId, exportCommandId);
    if (!grant) return;
    try {
      const result = await api.requestForPurpose("/v1/queries", "sharing", {
        data: { query: "share-grant.get", input: { exportCommandId } },
      });
      const projection = result && result.data;
      if (!this.shareCurrent(epoch, actor)) return;
      if (!validGrantProjection(projection) || projection.exportCommandId !== exportCommandId ||
          projection.exportRecordId !== grant.recordId || projection.workId !== workId) {
        throw new Error("SHARE_REVOKE_BINDING_INVALID");
      }
      if (projection.state === "revoked") {
        this.stopSharePolling(exportCommandId);
        removeGrant(this.shareGrants, workId, exportCommandId);
        this.setShareReady(workId, hasActiveGrant(this.shareGrants, workId));
        this.setData({ error: "分享已由服务商确认撤销" });
        return;
      }
      if (new Set(["revocation_failed", "reconciliation_required"]).has(projection.state)) {
        this.stopSharePolling(exportCommandId);
        replaceGrant(this.shareGrants, workId, grantFromProjection(projection));
        this.setShareReady(workId, hasActiveGrant(this.shareGrants, workId));
        this.setData({ error: `分享撤销未完成：${projection.state}` });
        return;
      }
      if (projection.state !== "revocation_requested" && projection.state !== "revocation_required") {
        throw new Error("SHARE_REVOKE_STATE_INVALID");
      }
      replaceGrant(this.shareGrants, workId, grantFromProjection(projection));
      this.scheduleSharePolling(exportCommandId, () => this.refreshShareRevocation(workId, exportCommandId));
    } catch (error) {
      if (!this.shareCurrent(epoch, actor)) return;
      this.stopSharePolling(exportCommandId);
      this.setShareReady(workId, hasActiveGrant(this.shareGrants, workId));
      this.setData({ error: error instanceof Error ? error.message : "SHARE_REVOKE_STATUS_UNAVAILABLE" });
    }
  },
  onShareAppMessage(event) {
    const workId = event.target && event.target.dataset.id;
    const grant = grantsForWork(this.shareGrants, workId).find((candidate) =>
      candidate.reference && Date.parse(candidate.expiresAt) > Date.now());
    if (!grant || !grant.reference || Date.parse(grant.expiresAt) <= Date.now()) return { title: "AI 生命时光机", path: "/pages/home/index" };
    return { title: "AI 创作 · 非真实年龄预测", path: `/pages/home/index?share=${encodeURIComponent(grant.reference)}` };
  },
  setShareReady(workId, ready) {
    const readyIds = new Set(this.data.shareReadyIds);
    if (ready) readyIds.add(workId);
    else readyIds.delete(workId);
    const shareReadyIds = [...readyIds];
    this.setData({
      shareReadyIds,
      items: this.data.items.map((item) => ({ ...item, shareReady: readyIds.has(item.id) })),
    });
  },
  scheduleSharePolling(commandId, callback) {
    this.stopSharePolling(commandId);
    this.shareTimers[commandId] = setTimeout(() => {
      delete this.shareTimers[commandId];
      callback();
    }, 2000);
  },
  stopSharePolling(commandId) {
    const timer = this.shareTimers[commandId];
    if (timer) clearTimeout(timer);
    delete this.shareTimers[commandId];
  },
  stopAllSharePolling() {
    for (const commandId of Object.keys(this.shareTimers)) this.stopSharePolling(commandId);
  },
  clearPrivateState() {
    this.cancelBatch();
    this.loadEpoch++;
    this.timelineEpoch++;
    if (this.timelineTimer) clearTimeout(this.timelineTimer);
    this.timelineTimer = null;
    void media.clearAll();
    this.stopAllSharePolling();
    session.clearPrivateUrls();
    this.shareGrants = Object.create(null);
    this.setData({ items: [], shareReadyIds: [], activeCommandId: "", delivery: null, selectedNode: null, previewPath: "", timelineBusy: false, timelineMessage: "", batchSaving: false, batchSaved: 0, batchTotal: 0 });
  },
});

function errorCode(error) { return error && typeof error.message === "string" ? error.message : ""; }
function batchKey(node) { return JSON.stringify([node.targetAge,node.asset?.id || node.nodeId,node.asset?.sha256]); }
function authorizationFailure(error) { return /CONSENT|AUTH|PRIVACY|TIMELINE_DOWNLOAD_HTTP_(401|403|409)/.test(errorCode(error)); }
function timelineError(error) {
  const code = errorCode(error);
  if (code === "ALBUM_PERMISSION_REQUIRED") return "请在微信设置中允许保存到相册，然后重试。";
  if (authorizationFailure(error) || /PURPOSE/.test(code)) return "授权已失效，请重新登录或确认本次照片授权。";
  if (/DIGEST|SIZE|DIMENSIONS/.test(code)) return "图片校验未通过，请刷新后重新下载。";
  if (/VERSION_CONFLICT/.test(code)) return "任务状态已变化，请刷新；正在处理的任务不会重复提交。";
  return "暂时无法完成，请刷新或重试；已生成的年龄照片会保留。";
}

function validGrantProjection(projection) {
  return projection && typeof projection === "object" &&
    validReference(projection.workId) && validReference(projection.exportRecordId) &&
    validReference(projection.exportCommandId) && typeof projection.expiresAt === "string" &&
    Number.isFinite(Date.parse(projection.expiresAt));
}

function validReference(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function grantFromProjection(projection) {
  return {
    workId: projection.workId,
    recordId: projection.exportRecordId,
    commandId: projection.exportCommandId,
    reference: projection.state === "active" ? projection.providerOperationId : "",
    expiresAt: projection.expiresAt,
    state: projection.state,
  };
}

function grantsForWork(store, workId) {
  const grants = store[workId];
  return Array.isArray(grants) ? grants : [];
}

function grantByCommand(store, workId, commandId) {
  return grantsForWork(store, workId).find((grant) => grant.commandId === commandId);
}

function replaceGrant(store, workId, grant) {
  const grants = grantsForWork(store, workId);
  const index = grants.findIndex((candidate) => candidate.commandId === grant.commandId);
  if (index === -1) grants.push(grant);
  else grants[index] = grant;
  store[workId] = grants;
}

function removeGrant(store, workId, commandId) {
  const remaining = grantsForWork(store, workId).filter((grant) => grant.commandId !== commandId);
  if (remaining.length === 0) delete store[workId];
  else store[workId] = remaining;
}

function hasActiveGrant(store, workId) {
  return grantsForWork(store, workId).some((grant) =>
    grant.reference && Date.parse(grant.expiresAt) > Date.now());
}
