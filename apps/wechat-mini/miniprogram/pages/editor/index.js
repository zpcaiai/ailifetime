const api = require("../../services/api");
const session = require("../../services/session");
const policy = require("../../services/policy");
const consentPolicy = require("../../policies/age-transformation");
const purchases = require("../../services/photo-purchases");
const LIFESPAN_AGES = Array.from({ length: 21 }, (_, index) => index * 5);

Page({
  data: { subjectMode: "single", playMode: "lifespan", albumCount:21,imageQuality:"hd",ageStep:5,imageSize:2048,targetAge: "30", partnerParticipantId: "", partnerCurrentAge: "", assetId: "", participantId: "", currentAge: "", ages: LIFESPAN_AGES.join(","), templateId: "timeline-classic-v1", consentAccepted: false, busy: false, error: "", priceLifespan: purchases.money(purchases.PRICES["lifespan-21"]), priceAge: purchases.money(purchases.PRICES["selected-age"]) },
  active: true,
  submission: null,
  onShow() { this.active = true; },
  onHide() { this.active = false; },
  onLoad(options) {
    if (!session.get()) { wx.navigateTo({ url: "/pages/auth/index" }); return; }
    if (typeof options.assetId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(options.assetId)) { this.setData({ error: "ASSET_ID_INVALID" }); return; }
    const current = session.get();
    this.setData({ assetId: options.assetId, participantId: current ? current.actorId : "" });
  },
  subjectChanged(event) { this.setData({ subjectMode: event.currentTarget.dataset.value, consentAccepted: false }); },
  playChanged(event) { this.setData({ playMode: event.currentTarget.dataset.value }); },
  setAlbum(count,quality) {
    if (this.data.busy) return;
    try {
      const tier=purchases.album(count,quality),ageStep=count===11?10:5;
      this.setData({albumCount:tier.count,imageQuality:tier.quality,imageSize:tier.size,ageStep,ages:Array.from({length:count},(_,i)=>i*ageStep).join(","),priceLifespan:purchases.money(tier.amountMinor),error:""});
    } catch { this.setData({error:"PHOTO_PURCHASE_INVALID"}); }
  },
  albumCountChanged(event) { this.setAlbum(Number(event.currentTarget.dataset.value),this.data.imageQuality); },
  imageQualityChanged(event) { this.setAlbum(this.data.albumCount,event.currentTarget.dataset.value); },
  targetAgeChanged(event) { this.setData({ targetAge: event.detail.value }); },
  partnerChanged(event) { this.setData({ partnerParticipantId: event.detail.value.trim() }); },
  partnerAgeChanged(event) { this.setData({ partnerCurrentAge: event.detail.value }); },
  onShareAppMessage() {
    const valid = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
    if (this.data.subjectMode !== "couple" || !valid(this.data.assetId) || !valid(this.data.partnerParticipantId) || this.data.partnerParticipantId === this.data.participantId) return { title: "人生时光机", path: "/pages/home/index" };
    return { title: "邀请你确认这张合照的年龄创作授权", path: `/pages/privacy/index?assetId=${encodeURIComponent(this.data.assetId)}&participantId=${encodeURIComponent(this.data.partnerParticipantId)}` };
  },
  participantChanged(event) { this.setData({ participantId: event.detail.value.trim() }); },
  agesChanged(event) { this.setData({ ages: event.detail.value }); },
  currentAgeChanged(event) { this.setData({ currentAge: event.detail.value }); },
  templateChanged(event) { this.setData({ templateId: event.detail.value.trim() }); },
  consentChanged(event) { this.setData({ consentAccepted: event.detail.value.includes("accepted") }); },
  async generate() {
    if (this.data.busy) return;
    const participantId = this.data.participantId;
    const assetId = this.data.assetId;
    const templateId = this.data.templateId;
    const couple = this.data.subjectMode === "couple";
    const singleAge = this.data.playMode === "age";
    const albumCount = this.data.albumCount, imageQuality = this.data.imageQuality;
    const participantIds = couple ? [participantId, this.data.partnerParticipantId] : [participantId];
    const partnerAgeText = String(this.data.partnerCurrentAge).trim();
    const participantAges = couple ? [Number(this.data.currentAge), Number(partnerAgeText)] : undefined;
    const ageTokens = (singleAge ? String(this.data.targetAge) : this.data.ages).split(",").map((value) => value.trim());
    const targetAges = ageTokens.map(Number);
    const currentAgeText = String(this.data.currentAge).trim();
    const currentAge = Number(currentAgeText);
    if (!this.data.consentAccepted || !/^[A-Za-z0-9._:-]{1,128}$/.test(participantId) ||
        currentAgeText === "" || !Number.isInteger(currentAge) || currentAge < 0 || currentAge > 100 ||
        !["single", "couple"].includes(this.data.subjectMode) || !["lifespan", "age"].includes(this.data.playMode) ||
        (couple && (!/^[A-Za-z0-9._:-]{1,128}$/.test(participantIds[1]) || participantIds[1] === participantId || partnerAgeText === "" || !Number.isInteger(participantAges[1]) || participantAges[1] < 0 || participantAges[1] > 100)) ||
        (singleAge && targetAges.length !== 1) || ageTokens.some((value) => value === "") || targetAges.length < 1 || targetAges.some((age) => !Number.isInteger(age) || age < 0 || age > 100) || new Set(targetAges).size !== targetAges.length) {
      this.setData({ error: "PARTICIPANT_OR_AGES_INVALID" }); return;
    }
    if (!singleAge && (![11,21].includes(albumCount) || !["standard","hd"].includes(imageQuality) || targetAges.length !== albumCount || targetAges.some((age,i) => age !== i*(albumCount===11?10:5)))) { this.setData({error: "PARTICIPANT_OR_AGES_INVALID"}); return; }
    const fingerprint = JSON.stringify({ assetId, participantIds, templateId, targetAges, currentAge, participantAges, subjectMode: this.data.subjectMode, playMode: this.data.playMode,albumCount:singleAge?undefined:albumCount,imageQuality:singleAge?undefined:imageQuality });
    if (this.submission && this.submission.fingerprint !== fingerprint && this.submission.effectUncertain) {
      this.setData({ error: "GENERATION_RECONCILIATION_REQUIRED" }); return;
    }
    if (!this.submission || this.submission.fingerprint !== fingerprint) {
      this.submission = { fingerprint, consentId: api.idempotencyKey("age-consent"), intakeId: api.idempotencyKey("wechat-intake"),
        draftId: api.idempotencyKey("wechat-draft"), jobId: api.idempotencyKey("wechat-job"), seed: api.idempotencyKey("seed"), effectUncertain: false, commandId: "" };
    }
    const submission = this.submission;
    if (submission.commandId) { wx.redirectTo({ url: `/pages/job/index?commandId=${encodeURIComponent(submission.commandId)}` }); return; }
    this.setData({ busy: true, error: "" });
    try {
      const activeSession = session.requireSession();
      policy.requireCapabilities(["B07", "B08", "B14"], activeSession.roles);
      const grantorCapacity = participantId === activeSession.actorId ? "self" : "guardian";
      if (grantorCapacity === "guardian" && !activeSession.roles.includes("guardian")) {
        throw new Error("DURABLE_GUARDIAN_AUTHORITY_REQUIRED");
      }
      const { consentId, intakeId, draftId, jobId } = submission;
      await api.requestForPurpose("/v1/commands", "age_transformation", {
        data: {
          command: "consent.grant",
          input: {
            id: consentId,
            participantId,
            grantorCapacity,
            purpose: "age_transformation",
            scope: { resource: `media.asset:${assetId}`, actions: ["ingest", "transform"] },
            policyVersion: consentPolicy.version,
          },
        },
        headers: { "Idempotency-Key": consentId },
      });
      const intake = await api.requestForPurpose("/v1/capabilities/B07", "age_transformation", {
        data: { assetId, participantIds },
        headers: { "Idempotency-Key": intakeId },
      });
      if (!intake || !intake.data || intake.data.state !== "persisted") throw new Error("MEDIA_INTAKE_NOT_ACCEPTED");
      await api.requestForPurpose("/v1/capabilities/B08", "age_transformation", {
        data: { draftId, sourceAssetId: assetId, templateId, participantIds, targetAges, composition: { sourceAssetIds: [assetId], layout: "timeline" }, illustrativeLabel: true },
        headers: { "Idempotency-Key": draftId },
      });
      submission.effectUncertain = true;
      const generation = { sourceAssetId: assetId, templateId, participantIds, targetAges, currentAge,
          ...(participantAges ? { participantAges } : {}),
          timelineProfile: singleAge ? couple ? "single-age-couple-v1" : "single-age-v1" : `lifespan-${albumCount}${couple?"-couple":""}-v1`,
          ...(singleAge?{}:{imageQuality}),
          seed: submission.seed, promptPolicyVersion: "age-policy-v1", illustrativeLabel: true };
      const quote = submission.purchaseId ? await purchases.get(submission.purchaseId) : await purchases.create({ sku: singleAge ? "selected-age" : purchases.album(albumCount,imageQuality).sku, generation }, jobId);
      submission.purchaseId = quote.purchaseId;
      const result = await purchases.execute(quote, { isCurrent: () => this.active });
      const commandId = result && result.commandId;
      if (typeof commandId !== "string") throw new Error("GENERATION_COMMAND_INVALID");
      submission.commandId = commandId;
      submission.effectUncertain = false;
      if (!this.active) return;
      wx.redirectTo({ url: `/pages/job/index?commandId=${encodeURIComponent(commandId)}` });
    } catch (error) {
      if (error.message === "PAYMENT_USER_CANCELLED") submission.effectUncertain = false;
      if (this.active) this.setData({ error: /^(PHOTO_|PAYMENT_|EXTERNAL_ADAPTER_UNAVAILABLE|DEPENDENCY_UNAVAILABLE)/.test(error.message || "") ? purchases.errorText(error) : error instanceof Error ? error.message : "GENERATION_SUBMIT_FAILED" });
    } finally { this.setData({ busy: false }); }
  },
});
