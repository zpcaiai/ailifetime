const api = require("../../services/api");
const session = require("../../services/session");
const consentPolicy = require("../../policies/age-transformation");

Page({
  data: { assetId: "", participantId: "", ages: "8,18,35,60", templateId: "timeline-classic-v1", consentAccepted: false, busy: false, error: "" },
  onLoad(options) {
    if (!session.get()) { wx.navigateTo({ url: "/pages/auth/index" }); return; }
    if (typeof options.assetId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(options.assetId)) { this.setData({ error: "ASSET_ID_INVALID" }); return; }
    const current = session.get();
    this.setData({ assetId: options.assetId, participantId: current ? current.actorId : "" });
  },
  participantChanged(event) { this.setData({ participantId: event.detail.value.trim() }); },
  agesChanged(event) { this.setData({ ages: event.detail.value }); },
  templateChanged(event) { this.setData({ templateId: event.detail.value.trim() }); },
  consentChanged(event) { this.setData({ consentAccepted: event.detail.value.includes("accepted") }); },
  async generate() {
    const participantId = this.data.participantId;
    const targetAges = this.data.ages.split(",").map((value) => Number(value.trim()));
    if (!this.data.consentAccepted || !/^[A-Za-z0-9._:-]{1,128}$/.test(participantId) || targetAges.length < 2 || targetAges.some((age) => !Number.isInteger(age) || age < 0 || age > 100) || new Set(targetAges).size !== targetAges.length) {
      this.setData({ error: "PARTICIPANT_OR_AGES_INVALID" }); return;
    }
    this.setData({ busy: true, error: "" });
    try {
      const activeSession = session.requireSession();
      const grantorCapacity = participantId === activeSession.actorId ? "self" : "guardian";
      if (grantorCapacity === "guardian" && !activeSession.roles.includes("guardian")) {
        throw new Error("DURABLE_GUARDIAN_AUTHORITY_REQUIRED");
      }
      const consentId = api.idempotencyKey("age-consent");
      await api.requestForPurpose("/v1/commands", "age_transformation", {
        data: {
          command: "consent.grant",
          input: {
            id: consentId,
            participantId,
            grantorCapacity,
            purpose: "age_transformation",
            scope: { resource: `media.asset:${this.data.assetId}`, actions: ["ingest", "transform"] },
            policyVersion: consentPolicy.version,
          },
        },
        headers: { "Idempotency-Key": consentId },
      });
      const intakeId = api.idempotencyKey("wechat-intake");
      const intake = await api.requestForPurpose("/v1/capabilities/B07", "age_transformation", {
        data: { assetId: this.data.assetId, participantIds: [participantId] },
        headers: { "Idempotency-Key": intakeId },
      });
      if (!intake || !intake.data || intake.data.state !== "persisted") throw new Error("MEDIA_INTAKE_NOT_ACCEPTED");
      const draftId = api.idempotencyKey("wechat-draft");
      await api.requestForPurpose("/v1/capabilities/B08", "age_transformation", {
        data: { draftId, sourceAssetId: this.data.assetId, templateId: this.data.templateId, participantIds: [participantId], targetAges, composition: { sourceAssetIds: [this.data.assetId], layout: "timeline" }, illustrativeLabel: true },
        headers: { "Idempotency-Key": draftId },
      });
      const jobId = api.idempotencyKey("wechat-job");
      const result = await api.requestForPurpose("/v1/capabilities/B14", "age_transformation", {
        data: { jobId, sourceAssetId: this.data.assetId, participantIds: [participantId], targetAges, seed: api.idempotencyKey("seed"), promptPolicyVersion: "age-policy-v1", illustrativeLabel: true },
        headers: { "Idempotency-Key": jobId },
      });
      const commandId = result && result.data && result.data.externalCommandId;
      if (typeof commandId !== "string") throw new Error("GENERATION_COMMAND_INVALID");
      wx.redirectTo({ url: `/pages/job/index?commandId=${encodeURIComponent(commandId)}` });
    } catch (error) {
      this.setData({ error: error instanceof Error ? error.message : "GENERATION_SUBMIT_FAILED" });
    } finally { this.setData({ busy: false }); }
  },
});
