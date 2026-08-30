import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import {
  boolean,
  digest,
  enumValue,
  escapeHtml,
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
  syntheticOnly,
  timestamp,
  verifyToken,
} from "./contracts.mjs";

const ASSET_KINDS = Object.freeze(["share-card", "video-cover", "og-image", "qr"]);
const PLATFORM_SIZES = Object.freeze({
  web: { width: 1200, height: 630 },
  wechat: { width: 1080, height: 1440 },
  instagram: { width: 1080, height: 1350 },
  tiktok: { width: 1080, height: 1920 },
  linkedin: { width: 1200, height: 627 },
});
const AI_LABEL = "AI-generated artistic simulation · Illustrative, not predictive";

function validateAuthorization(value, index, policy, binding, now) {
  const authorization = plainObject(value, `participantAuthorizations[${index}]`);
  exactKeys(authorization, ["authorizationId", "participantId", "workId", "purpose", "consentState", "containsMinor", "guardianState", "visibility", "region", "expiresAt", "revokedAt"], `participantAuthorizations[${index}]`);
  if (authorization.authorizationId !== binding.authorizationId || authorization.workId !== binding.workId || authorization.revokedAt !== null || new Date(timestamp(authorization.expiresAt, `participantAuthorizations[${index}].expiresAt`)) <= now) fail("SHARE_AUTHORIZATION_INVALID", "participant authorization is missing, expired, revoked, or bound to another work");
  const containsMinor = boolean(authorization.containsMinor, `participantAuthorizations[${index}].containsMinor`);
  const guardianState = enumValue(authorization.guardianState, ["not-required", "verified", "missing", "revoked"], `participantAuthorizations[${index}].guardianState`);
  const visibility = enumValue(authorization.visibility, ["private", "unlisted", "public"], `participantAuthorizations[${index}].visibility`);
  const region = identifier(authorization.region, `participantAuthorizations[${index}].region`);
  if (!policy.allowedRegions.includes(region)) fail("SHARE_REGION_NOT_ALLOWED", `sharing is unavailable in ${region}`);
  if (authorization.consentState !== "granted") fail("CONSENT_REQUIRED", "every participant must grant the exact sharing purpose");
  if (containsMinor && (guardianState !== "verified" || visibility === "public")) fail("MINOR_SHARING_FORBIDDEN", "minor work requires guardian authorization and cannot be publicly indexed");
  if (!containsMinor && guardianState !== "not-required") fail("SHARE_AUTHORIZATION_INVALID", "adult authorization cannot carry guardian state");
  return {
    participantId: identifier(authorization.participantId, `participantAuthorizations[${index}].participantId`),
    purpose: enumValue(authorization.purpose, ["social-sharing", "press-kit", "partner-demo"], `participantAuthorizations[${index}].purpose`),
    consentState: "granted",
    containsMinor,
    guardianState,
    visibility,
    region,
  };
}

function validateLicense(value, index, region, now) {
  const license = plainObject(value, `licenses[${index}]`);
  exactKeys(license, ["assetId", "kind", "licenseId", "commercialUse", "territories", "expiresAt"], `licenses[${index}]`);
  const territories = stringArray(license.territories, `licenses[${index}].territories`, { minimum: 1, maximum: 100 }).map((item) => identifier(item, "territory"));
  const expiresAt = timestamp(license.expiresAt, `licenses[${index}].expiresAt`);
  if (license.commercialUse !== true || !territories.includes(region) || new Date(expiresAt) <= now) fail("ASSET_LICENSE_INVALID", "template asset lacks an active commercial license for the region");
  return {
    assetId: identifier(license.assetId, `licenses[${index}].assetId`),
    kind: enumValue(license.kind, ["music", "font", "graphic", "video", "photo"], `licenses[${index}].kind`),
    licenseId: identifier(license.licenseId, `licenses[${index}].licenseId`),
    commercialUse: true,
    territories,
    expiresAt,
  };
}

export function validateSharePolicy(value) {
  const policy = plainObject(value, "share policy");
  exactKeys(policy, ["shareOrigin", "allowedRegions", "purgeTargets", "maximumTtlSeconds"], "share policy");
  const shareOrigin = httpsUrl(policy.shareOrigin, "shareOrigin").origin;
  return {
    shareOrigin,
    allowedRegions: stringArray(policy.allowedRegions, "allowedRegions", { minimum: 1, maximum: 100 }).map((item) => identifier(item, "allowedRegion")),
    purgeTargets: stringArray(policy.purgeTargets, "purgeTargets", { minimum: 1, maximum: 20 }).map((item) => identifier(item, "purgeTarget")),
    maximumTtlSeconds: integer(policy.maximumTtlSeconds, "maximumTtlSeconds", 60, 86_400),
  };
}

export function validateUgcTemplate(value, region, now = new Date()) {
  const template = plainObject(value, "UGC template");
  exactKeys(template, ["templateId", "version", "campaignId", "moderationState", "regions", "expiresAt", "licenses"], "UGC template");
  const regions = stringArray(template.regions, "regions", { minimum: 1, maximum: 100 }).map((item) => identifier(item, "region"));
  const expiresAt = timestamp(template.expiresAt, "expiresAt");
  if (template.moderationState !== "approved") fail("UGC_TEMPLATE_NOT_APPROVED", "UGC template requires moderation approval");
  if (!regions.includes(region) || new Date(expiresAt) <= now) fail("UGC_TEMPLATE_UNAVAILABLE", "UGC template is unavailable in this region or has expired");
  if (!Array.isArray(template.licenses) || template.licenses.length === 0 || template.licenses.length > 100) fail("ASSET_LICENSE_INVALID", "UGC template licenses are required");
  const licenses = template.licenses.map((license, index) => validateLicense(license, index, region, now));
  return {
    templateId: identifier(template.templateId, "templateId"),
    version: identifier(template.version, "version"),
    campaignId: identifier(template.campaignId, "campaignId"),
    moderationState: "approved",
    regions,
    expiresAt,
    licenses,
  };
}

export async function createGovernedShareAsset(store, input, policyValue, secret, now = new Date(), authorizationAuthority) {
  const policy = validateSharePolicy(policyValue);
  const request = plainObject(input.request, "share request");
  exactKeys(request, [
    "shareId", "workId", "brandId", "assetKind", "platform", "region", "caption", "ageRange", "participantAuthorizationIds",
    "template", "previewArtifact", "expiresAt",
  ], "share request");
  const platform = enumValue(request.platform, Object.keys(PLATFORM_SIZES), "platform");
  const region = identifier(request.region, "region");
  if (authorizationAuthority === undefined || typeof authorizationAuthority.resolve !== "function") fail("SHARE_AUTHORITY_REQUIRED", "participant sharing state must be resolved by a trusted server authority");
  const authorizationIds = stringArray(request.participantAuthorizationIds, "participantAuthorizationIds", { minimum: 1, maximum: 20 }).map((value) => identifier(value, "participantAuthorizationId"));
  const workId = identifier(request.workId, "workId");
  const participantAuthorizations = authorizationIds.map((authorizationId, index) => validateAuthorization(authorizationAuthority.resolve(authorizationId), index, policy, { authorizationId, workId }, now));
  if (new Set(participantAuthorizations.map((authorization) => authorization.participantId)).size !== participantAuthorizations.length) fail("SHARE_AUTHORIZATION_INVALID", "participant authorization IDs must be unique");
  if (participantAuthorizations.some((authorization) => authorization.region !== region)) fail("SHARE_REGION_MISMATCH", "participant authorization region must match the asset");
  const template = validateUgcTemplate(request.template, region, now);
  const previewArtifact = plainObject(request.previewArtifact, "previewArtifact");
  exactKeys(previewArtifact, ["artifactId", "sha256", "variant"], "previewArtifact");
  if (previewArtifact.variant !== "derived-preview") fail("HIGH_RESOLUTION_MEDIA_FORBIDDEN", "sharing may use only a derived preview artifact");
  const expiresAt = timestamp(request.expiresAt, "expiresAt");
  const ttlSeconds = Math.floor((new Date(expiresAt).getTime() - now.getTime()) / 1_000);
  if (ttlSeconds < 60 || ttlSeconds > policy.maximumTtlSeconds) fail("SHARE_EXPIRY_INVALID", "share expiry is outside policy bounds");
  const shareId = identifier(request.shareId, "shareId");
  const accessId = input.accessId === undefined ? randomBytes(24).toString("base64url") : requiredString(input.accessId, "accessId", 64);
  if (!/^[A-Za-z0-9_-]{24,64}$/u.test(accessId)) fail("SHARE_TOKEN_ENTROPY_INSUFFICIENT", "share access ID is guessable");
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const token = signToken({ schemaVersion: "ltm.share-access.v1", audience: "public-share", shareId, accessId, iat: issuedAt, exp: Math.floor(new Date(expiresAt).getTime() / 1_000) }, secret);
  const url = `${policy.shareOrigin}/s/${encodeURIComponent(accessId)}?token=${encodeURIComponent(token)}`;
  const qrSvg = await QRCode.toString(url, { type: "svg", errorCorrectionLevel: "Q", margin: 2, width: 512 });
  const dimensions = PLATFORM_SIZES[platform];
  const caption = request.caption === null ? null : sanitizeText(request.caption, "caption", 280);
  const brandId = identifier(request.brandId, "brandId");
  const cardSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}" role="img" aria-label="${escapeHtml(request.ageRange)} AI artistic simulation"><rect width="100%" height="100%" fill="#101828"/><text x="48" y="48" fill="white" font-size="24">${escapeHtml(brandId)}</text>${caption === null ? "" : `<text x="48" y="96" fill="white" font-size="44">${escapeHtml(caption)}</text>`}<text x="48" y="${dimensions.height - 56}" fill="white" font-size="24">${escapeHtml(AI_LABEL)}</text></svg>`;
  const asset = {
    schemaVersion: "ltm.governed-share-asset.v1",
    shareId,
    workId,
    brandId,
    assetKind: enumValue(request.assetKind, ASSET_KINDS, "assetKind"),
    platform,
    dimensions,
    region,
    caption,
    ageRange: requiredString(request.ageRange, "ageRange", 64),
    participantAuthorizations,
    template,
    previewArtifact: { artifactId: identifier(previewArtifact.artifactId, "previewArtifact.artifactId"), sha256: digest(previewArtifact.sha256, "previewArtifact.sha256"), variant: "derived-preview" },
    aiLabel: AI_LABEL,
    accessId,
    token,
    url,
    qrSvg,
    cardSvg,
    expiresAt,
    state: "active",
    createdAt: now.toISOString(),
  };
  return store.transact({
    actorId: input.actorId,
    action: "share.create",
    subject: shareId,
    idempotencyKey: input.idempotencyKey,
    input: { ...asset, token: sha256(token), qrSvg: sha256(qrSvg), cardSvg: sha256(cardSvg) },
    at: input.at,
  }, (records) => {
    if (records.shares[shareId] !== undefined) fail("SHARE_EXISTS", "share already exists");
    records.shares[shareId] = asset;
    return asset;
  });
}

export class MemoryShareRateLimiter {
  constructor(limit = 20, windowMs = 60_000) {
    this.durable = false;
    this.limit = integer(limit, "limit", 1, 10_000);
    this.windowMs = integer(windowMs, "windowMs", 1_000, 86_400_000);
    this.entries = new Map();
  }

  consume(key, now = new Date()) {
    const normalized = requiredString(key, "rateLimitKey", 256);
    const current = this.entries.get(normalized);
    if (current === undefined || now.getTime() - current.startedAt >= this.windowMs) {
      this.entries.set(normalized, { startedAt: now.getTime(), count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }
}

export class RedisShareRateLimiter {
  constructor(client, { limit = 20, windowMs = 60_000, keyPrefix = "ltm:public-share-rate:v1" } = {}) {
    if (client === undefined || typeof client.eval !== "function") fail("RATE_LIMITER_INVALID", "Redis rate limiter requires an atomic eval client");
    this.client = client; this.limit = integer(limit, "limit", 1, 10_000); this.windowMs = integer(windowMs, "windowMs", 1_000, 86_400_000); this.keyPrefix = identifier(keyPrefix.replaceAll(":", "-"), "keyPrefix"); this.durable = true;
  }

  async consume(key) {
    const normalized = requiredString(key, "rateLimitKey", 256);
    const redisKey = `${this.keyPrefix}:${sha256(normalized)}`;
    const count = await this.client.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return n", { keys: [redisKey], arguments: [String(this.windowMs)] });
    if (!Number.isSafeInteger(Number(count)) || Number(count) < 1) fail("RATE_LIMITER_FAILED", "Redis returned an invalid atomic rate-limit result");
    return Number(count) <= this.limit;
  }
}

export async function resolveShareAccess(store, input, secret, limiter, now = new Date()) {
  if (limiter === undefined || typeof limiter.consume !== "function") fail("RATE_LIMITER_REQUIRED", "public share access requires a rate limiter");
  const environment = enumValue(input.environment, ["test", "staging", "production"], "environment");
  if (environment === "production" && limiter.durable !== true) fail("DURABLE_RATE_LIMITER_REQUIRED", "production public sharing requires a shared atomic rate limiter");
  const claims = verifyToken(input.token, secret, { schemaVersion: "ltm.share-access.v1", audience: "public-share" }, now);
  if (!await limiter.consume(`${claims.shareId}:${requiredString(input.clientKey, "clientKey", 128)}`, now)) fail("RATE_LIMITED", "share access rate limit exceeded");
  const share = store.read().records.shares[claims.shareId];
  if (share === undefined || share.accessId !== claims.accessId || share.state !== "active" || new Date(share.expiresAt) <= now) fail("SHARE_GONE", "share is revoked, expired, or unavailable");
  const containsMinor = share.participantAuthorizations.some((authorization) => authorization.containsMinor);
  const crawler = boolean(input.crawler, "crawler");
  return {
    schemaVersion: "ltm.public-share-response.v1",
    shareId: share.shareId,
    aiLabel: share.aiLabel,
    cardSvg: share.cardSvg,
    qrSvg: share.qrSvg,
    previewArtifact: crawler ? null : share.previewArtifact,
    headers: {
      "cache-control": "private, no-store",
      "x-robots-tag": containsMinor ? "noindex, nofollow, noarchive" : "noindex, noarchive",
    },
  };
}

export function revokeShare(store, input, policyValue) {
  const policy = validateSharePolicy(policyValue);
  const shareId = identifier(input.shareId, "shareId");
  return store.transact({
    actorId: input.actorId,
    action: "share.revoke",
    subject: shareId,
    idempotencyKey: input.idempotencyKey,
    input,
    at: input.at,
  }, (records) => {
    const share = records.shares[shareId];
    if (share === undefined) fail("SHARE_NOT_FOUND", "share does not exist");
    share.state = "revoked";
    share.revokedAt = timestamp(input.at, "at");
    share.revocationReason = sanitizeText(input.reason, "reason", 500);
    share.revocation = {
      purgeTasks: policy.purgeTargets.map((target) => ({ target, state: "pending", shareId, artifactSha256: share.previewArtifact.sha256 })),
      externalCacheNotice: "External platforms may retain cached previews until their cache expires.",
    };
    return share.revocation;
  });
}

export function validateOfficialMediaKit(value) {
  const kit = plainObject(value, "official media kit");
  exactKeys(kit, ["kitId", "version", "brandGuideVersion", "sampleDataOrigin", "assets", "licenses", "approvedBy"], "official media kit");
  syntheticOnly(kit.sampleDataOrigin, "sampleDataOrigin");
  const assets = stringArray(kit.assets, "assets", { minimum: 1, maximum: 100 }).map((item) => identifier(item, "asset"));
  const licenses = stringArray(kit.licenses, "licenses", { minimum: 1, maximum: 100 }).map((item) => identifier(item, "license"));
  const approvedBy = stringArray(kit.approvedBy, "approvedBy", { minimum: 2, maximum: 20 });
  if (!approvedBy.includes("brand") || !approvedBy.includes("legal")) fail("MEDIA_KIT_APPROVAL_REQUIRED", "media kit requires brand and legal approval");
  return {
    schemaVersion: "ltm.official-media-kit.v1",
    kitId: identifier(kit.kitId, "kitId"),
    version: identifier(kit.version, "version"),
    brandGuideVersion: identifier(kit.brandGuideVersion, "brandGuideVersion"),
    sampleDataOrigin: "synthetic",
    assets,
    licenses,
    approvedBy,
    verificationSha256: sha256({ assets, licenses, source: "synthetic" }),
  };
}

export const requiredShareAiLabel = AI_LABEL;
