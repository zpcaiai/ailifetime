import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import {
  enumValue,
  exactKeys,
  fail,
  httpsUrl,
  identifier,
  integer,
  plainObject,
  requiredString,
  sanitizeText,
  sha256,
  signToken,
  stringArray,
  timestamp,
  verifyToken,
} from "./contracts.mjs";

const CAMPAIGN_STATES = Object.freeze(["draft", "active", "paused", "terminated"]);
const CHANNELS = Object.freeze(["search", "social", "studio", "gift", "insurance", "retirement", "education", "offline", "partner"]);
const FORBIDDEN_BINDING_WORDS = /(?:face|photo|health|child|minor|payment|card|email|phone|name|address)/iu;

function validateUtm(value) {
  const utm = plainObject(value, "utm");
  exactKeys(utm, ["source", "medium", "campaign", "term", "content"], "utm");
  const normalize = (field, required) => {
    if (!required && utm[field] === null) return null;
    const result = requiredString(utm[field], `utm.${field}`, 100).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(result)) fail("UTM_INVALID", `utm.${field} contains unsafe characters`);
    return result;
  };
  return { source: normalize("source", true), medium: normalize("medium", true), campaign: normalize("campaign", true), term: normalize("term", false), content: normalize("content", false) };
}

function validateQrBinding(value) {
  const binding = plainObject(value, "qrBinding");
  exactKeys(binding, ["kind", "id"], "qrBinding");
  const kind = enumValue(binding.kind, ["store", "employee", "partner", "product", "campaign"], "qrBinding.kind");
  const id = identifier(binding.id, "qrBinding.id");
  if (FORBIDDEN_BINDING_WORDS.test(id)) fail("QR_SENSITIVE_DATA_FORBIDDEN", "QR binding identifier appears to contain sensitive data");
  return { kind, id };
}

function validateDestinations(value, policy) {
  const destinations = plainObject(value, "destinations");
  exactKeys(destinations, ["web", "ios", "android", "wechat", "partner"], "destinations");
  const web = httpsUrl(destinations.web, "destinations.web", { allowedOrigins: policy.webOrigins }).toString();
  const ios = requiredString(destinations.ios, "destinations.ios", 512);
  const android = httpsUrl(destinations.android, "destinations.android", { allowedOrigins: policy.appLinkOrigins }).toString();
  const wechat = requiredString(destinations.wechat, "destinations.wechat", 256);
  const partner = destinations.partner === null ? null : httpsUrl(destinations.partner, "destinations.partner", { allowedOrigins: policy.partnerOrigins }).toString();
  if (!ios.startsWith(`${policy.iosScheme}://campaign/`) || !/^pages\/[A-Za-z0-9/_-]+$/u.test(wechat) || wechat.includes("..")) {
    fail("DEEPLINK_DESTINATION_INVALID", "native destination is not an enrolled application route");
  }
  return { web, ios, android, wechat, partner };
}

export function validateCampaignPolicy(value) {
  const policy = plainObject(value, "campaign policy");
  exactKeys(policy, ["webOrigins", "appLinkOrigins", "partnerOrigins", "iosScheme", "entryOrigin"], "campaign policy");
  const origins = (items, label) => stringArray(items, label, { minimum: 1, maximum: 50, itemMaximum: 256 })
    .map((item, index) => httpsUrl(item, `${label}[${index}]`).origin);
  const webOrigins = origins(policy.webOrigins, "webOrigins");
  const appLinkOrigins = origins(policy.appLinkOrigins, "appLinkOrigins");
  const partnerOrigins = origins(policy.partnerOrigins, "partnerOrigins");
  const iosScheme = requiredString(policy.iosScheme, "iosScheme", 32).toLowerCase();
  if (!/^[a-z][a-z0-9+.-]{2,31}$/u.test(iosScheme) || ["http", "https", "javascript", "data"].includes(iosScheme)) fail("CAMPAIGN_POLICY_INVALID", "iosScheme is unsafe");
  const entryOrigin = httpsUrl(policy.entryOrigin, "entryOrigin", { allowedOrigins: webOrigins }).origin;
  return { webOrigins, appLinkOrigins, partnerOrigins, iosScheme, entryOrigin };
}

export function validateCampaign(value, policy) {
  policy = validateCampaignPolicy(policy);
  const campaign = plainObject(value, "campaign");
  exactKeys(campaign, [
    "campaignId", "version", "state", "creatives", "audienceId", "channels", "budgetTags", "utm", "shortCode",
    "qrBinding", "startsAt", "expiresAt", "destinations", "attributionWindowDays", "approvals", "terminationReason",
  ], "campaign");
  const campaignId = identifier(campaign.campaignId, "campaignId");
  const startsAt = timestamp(campaign.startsAt, "startsAt");
  const expiresAt = timestamp(campaign.expiresAt, "expiresAt", { after: startsAt });
  const state = enumValue(campaign.state, CAMPAIGN_STATES, "state");
  const approvals = stringArray(campaign.approvals, "approvals", { maximum: 20, itemMaximum: 64 });
  if (state === "active" && (!approvals.includes("marketing") || !approvals.includes("privacy"))) fail("CAMPAIGN_APPROVAL_REQUIRED", "active campaigns require marketing and privacy approval");
  const terminationReason = campaign.terminationReason === null ? null : enumValue(campaign.terminationReason, ["manual", "contract-ended", "consent-withdrawn", "security-incident", "expired"], "terminationReason");
  if (["paused", "terminated"].includes(state) && terminationReason === null) fail("CAMPAIGN_STATE_INVALID", "paused or terminated campaign requires a reason");
  if (!["paused", "terminated"].includes(state) && terminationReason !== null) fail("CAMPAIGN_STATE_INVALID", "active or draft campaign cannot carry a termination reason");
  const shortCode = requiredString(campaign.shortCode, "shortCode", 64);
  if (!/^[A-Za-z0-9_-]{20,64}$/u.test(shortCode)) fail("SHORT_CODE_ENTROPY_INSUFFICIENT", "short code must be an unguessable 20 to 64 character token");
  return {
    campaignId,
    version: identifier(campaign.version, "version"),
    state,
    creatives: stringArray(campaign.creatives, "creatives", { minimum: 1, maximum: 100 }).map((item) => identifier(item, "creative")),
    audienceId: identifier(campaign.audienceId, "audienceId"),
    channels: stringArray(campaign.channels, "channels", { minimum: 1, maximum: CHANNELS.length }).map((item) => enumValue(item, CHANNELS, "channel")),
    budgetTags: stringArray(campaign.budgetTags, "budgetTags", { minimum: 1, maximum: 20 }).map((item) => identifier(item, "budgetTag")),
    utm: validateUtm(campaign.utm),
    shortCode,
    qrBinding: validateQrBinding(campaign.qrBinding),
    startsAt,
    expiresAt,
    destinations: validateDestinations(campaign.destinations, policy),
    attributionWindowDays: integer(campaign.attributionWindowDays, "attributionWindowDays", 1, 180),
    approvals,
    terminationReason,
  };
}

export function configureCampaign(store, input, policy) {
  const campaign = validateCampaign(input.campaign, policy);
  return store.transact({
    actorId: input.actorId,
    action: "campaign.configure",
    subject: campaign.campaignId,
    idempotencyKey: input.idempotencyKey,
    input: campaign,
    at: input.at,
  }, (records) => {
    const aggregate = records.campaigns[campaign.campaignId] ?? { versions: {}, currentVersion: null, history: [] };
    if (aggregate.versions[campaign.version] !== undefined && sha256(aggregate.versions[campaign.version]) !== sha256(campaign)) fail("VERSION_IMMUTABLE", "campaign version is immutable");
    aggregate.versions[campaign.version] = campaign;
    aggregate.currentVersion = campaign.version;
    aggregate.history.push({ state: campaign.state, version: campaign.version, at: input.at, actorId: input.actorId });
    records.campaigns[campaign.campaignId] = aggregate;
    return { campaignId: campaign.campaignId, version: campaign.version, state: campaign.state };
  });
}

export function changeCampaignState(store, input) {
  const campaignId = identifier(input.campaignId, "campaignId");
  const state = enumValue(input.state, ["active", "paused", "terminated"], "state");
  return store.transact({
    actorId: input.actorId,
    action: "campaign.state-change",
    subject: campaignId,
    idempotencyKey: input.idempotencyKey,
    input,
    at: input.at,
  }, (records) => {
    const aggregate = records.campaigns[campaignId];
    if (aggregate === undefined) fail("CAMPAIGN_NOT_FOUND", "campaign does not exist");
    const prior = aggregate.versions[aggregate.currentVersion];
    const reason = state === "active" ? null : enumValue(input.reason, ["manual", "contract-ended", "consent-withdrawn", "security-incident", "expired"], "reason");
    if (prior.state === "terminated" && state !== "terminated") fail("CAMPAIGN_TERMINATED", "terminated campaigns cannot be reactivated");
    const nextVersion = identifier(input.version, "version");
    const next = { ...prior, version: nextVersion, state, terminationReason: reason };
    if (aggregate.versions[nextVersion] !== undefined) fail("VERSION_IMMUTABLE", "campaign version already exists");
    aggregate.versions[nextVersion] = next;
    aggregate.currentVersion = nextVersion;
    aggregate.history.push({ state, version: nextVersion, priorState: prior.state, reason, at: input.at, actorId: input.actorId });
    return { campaignId, state, version: nextVersion, entryEnabled: state === "active", recoveryPage: state === "active" ? null : "/campaign-unavailable" };
  });
}

export async function issueCampaignEntry(store, input, policy, secret, now = new Date()) {
  policy = validateCampaignPolicy(policy);
  const campaignId = identifier(input.campaignId, "campaignId");
  const state = store.read().records.campaigns[campaignId];
  const campaign = state?.versions?.[state.currentVersion];
  if (campaign === undefined) fail("CAMPAIGN_NOT_FOUND", "campaign does not exist");
  const nowMs = now.getTime();
  if (campaign.state !== "active" || nowMs < new Date(campaign.startsAt).getTime() || nowMs >= new Date(campaign.expiresAt).getTime()) {
    fail("CAMPAIGN_ENTRY_DISABLED", "campaign entry is paused, terminated, not started, or expired");
  }
  const ttlSeconds = Math.min(integer(input.ttlSeconds, "ttlSeconds", 60, 86_400), Math.floor((new Date(campaign.expiresAt).getTime() - nowMs) / 1_000));
  const entryId = input.entryId === undefined ? randomBytes(24).toString("base64url") : requiredString(input.entryId, "entryId", 64);
  if (!/^[A-Za-z0-9_-]{24,64}$/u.test(entryId)) fail("ENTRY_TOKEN_ENTROPY_INSUFFICIENT", "entryId is not sufficiently unguessable");
  const issuedAt = Math.floor(nowMs / 1_000);
  const token = signToken({
    schemaVersion: "ltm.campaign-entry.v1",
    audience: "campaign-entry",
    campaignId,
    version: campaign.version,
    entryId,
    bindingKind: campaign.qrBinding.kind,
    bindingId: campaign.qrBinding.id,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  }, secret);
  const url = `${policy.entryOrigin}/c/${encodeURIComponent(campaign.shortCode)}?token=${encodeURIComponent(token)}`;
  const qrSvg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 2, width: 512 });
  return { schemaVersion: "ltm.campaign-entry-artifact.v1", campaignId, entryId, url, token, qrSvg, qrPayloadSha256: sha256(url), expiresAt: new Date((issuedAt + ttlSeconds) * 1_000).toISOString() };
}

export function resolveCampaignEntry(store, input, policy, secret, now = new Date()) {
  validateCampaignPolicy(policy);
  const claims = verifyToken(input.token, secret, { schemaVersion: "ltm.campaign-entry.v1", audience: "campaign-entry" }, now);
  const aggregate = store.read().records.campaigns[claims.campaignId];
  const campaign = aggregate?.versions?.[aggregate.currentVersion];
  if (campaign === undefined || campaign.version !== claims.version || campaign.state !== "active") {
    return { status: "gone", httpStatus: 410, recoveryPath: "/campaign-unavailable", redirect: null };
  }
  if (new Date(campaign.expiresAt) <= now) return { status: "gone", httpStatus: 410, recoveryPath: "/campaign-unavailable", redirect: null };
  const client = enumValue(input.client, ["web", "ios", "android", "wechat", "partner"], "client");
  const selected = client === "partner" && campaign.destinations.partner === null ? campaign.destinations.web : campaign.destinations[client];
  return {
    status: "active",
    httpStatus: 302,
    redirect: selected,
    recoveryPath: null,
    attributionHandoff: {
      handoffId: claims.entryId,
      campaignId: campaign.campaignId,
      version: campaign.version,
      channel: campaign.channels[0],
      confidence: "high",
    },
  };
}

export function campaignFunnelHealth(events) {
  if (!Array.isArray(events) || events.length > 1_000_000) fail("CAMPAIGN_EVENTS_INVALID", "events must be a bounded array");
  const steps = ["click", "arrival", "upload", "generation", "purchase", "share", "partner-lead"];
  const counts = Object.fromEntries(steps.map((step) => [step, 0]));
  const seen = new Set();
  let duplicates = 0;
  for (const event of events) {
    const id = identifier(event.eventId, "eventId");
    const type = enumValue(event.eventType, steps, "eventType");
    if (seen.has(id)) duplicates += 1;
    else { seen.add(id); counts[type] += 1; }
  }
  const anomalies = [];
  if (duplicates > 0) anomalies.push("duplicate-events");
  if (counts.arrival > counts.click) anomalies.push("arrival-without-click");
  if (counts.purchase > counts.generation) anomalies.push("purchase-without-generation");
  return { schemaVersion: "ltm.campaign-funnel-health.v1", counts, duplicates, anomalies, status: anomalies.length === 0 ? "healthy" : "degraded" };
}
