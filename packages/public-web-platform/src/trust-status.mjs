import {
  boolean,
  digest,
  enumValue,
  exactKeys,
  fail,
  identifier,
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

export const BRAND_ASSET_TYPES = Object.freeze([
  "logo",
  "brand-guide",
  "product-screenshot",
  "demo-asset",
  "press-kit",
  "fact-sheet",
]);

export const SALES_ASSET_TYPES = Object.freeze([
  "sales-deck",
  "rfp-response",
  "dpa",
  "security-questionnaire",
  "partner-material",
]);

const REQUIRED_SALES_APPROVALS = Object.freeze({
  "sales-deck": ["content", "sales", "brand", "finance"],
  "rfp-response": ["content", "sales", "security", "legal", "finance"],
  dpa: ["content", "privacy", "security", "legal"],
  "security-questionnaire": ["content", "security", "legal"],
  "partner-material": ["content", "partner", "brand", "legal", "finance"],
});

const TRUST_STATEMENTS = Object.freeze({
  aiDisclosure: "AI-generated artistic simulations are illustrative and not predictive.",
  childBoundary: "Child and minor data is subject to age gating, guardian authorization, and region-specific restrictions.",
  highImpactDecisionProhibition: "The service must not be used to make or recommend high-impact insurance, employment, credit, education, housing, or healthcare decisions.",
});

const PUBLIC_COMPONENTS = Object.freeze([
  "website",
  "api",
  "generation",
  "media-processing",
  "authentication",
  "notifications",
]);

function optionalTimestamp(value, label) {
  return value === null ? null : timestamp(value, label);
}

function validateApproval(value, index, label = "approvals") {
  const approval = plainObject(value, `${label}[${index}]`);
  exactKeys(approval, ["role", "approvalId", "evidenceSha256", "approvedAt", "expiresAt"], `${label}[${index}]`);
  const approvedAt = timestamp(approval.approvedAt, `${label}[${index}].approvedAt`);
  const expiresAt = optionalTimestamp(approval.expiresAt, `${label}[${index}].expiresAt`);
  if (expiresAt !== null && new Date(expiresAt) <= new Date(approvedAt)) fail("APPROVAL_EXPIRY_INVALID", "approval expiry must follow approval time");
  return {
    role: identifier(approval.role, `${label}[${index}].role`),
    approvalId: identifier(approval.approvalId, `${label}[${index}].approvalId`),
    evidenceSha256: digest(approval.evidenceSha256, `${label}[${index}].evidenceSha256`),
    approvedAt,
    expiresAt,
  };
}

function validateApprovals(value, requiredRoles, now, label = "approvals") {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) fail("APPROVALS_INVALID", `${label} must be a bounded non-empty array`);
  const approvals = value.map((item, index) => validateApproval(item, index, label));
  if (new Set(approvals.map((approval) => approval.role)).size !== approvals.length) fail("APPROVALS_INVALID", `${label} roles must be unique`);
  for (const role of requiredRoles) {
    const approval = approvals.find((candidate) => candidate.role === role);
    if (approval === undefined || (approval.expiresAt !== null && new Date(approval.expiresAt) <= now)) {
      fail("APPROVAL_REQUIRED", `${role} approval is missing or expired`);
    }
  }
  return approvals;
}

function validateLicense(value, now) {
  const license = plainObject(value, "license");
  exactKeys(license, ["licenseId", "scope", "territories", "expiresAt", "evidenceSha256"], "license");
  const expiresAt = timestamp(license.expiresAt, "license.expiresAt");
  if (new Date(expiresAt) <= now) fail("LICENSE_EXPIRED", "asset license has expired");
  return {
    licenseId: identifier(license.licenseId, "license.licenseId"),
    scope: enumValue(license.scope, ["public-web", "press", "sales", "partner"], "license.scope"),
    territories: stringArray(license.territories, "license.territories", { minimum: 1, maximum: 100 }).map((item) => identifier(item, "territory")),
    expiresAt,
    evidenceSha256: digest(license.evidenceSha256, "license.evidenceSha256"),
  };
}

export function validateBrandAsset(value, now = new Date()) {
  const asset = plainObject(value, "brand asset");
  exactKeys(asset, [
    "assetId", "type", "version", "artifactSha256", "sourceOrigin", "license", "approvals", "publishedAt", "expiresAt",
  ], "brand asset");
  const type = enumValue(asset.type, BRAND_ASSET_TYPES, "type");
  if (["product-screenshot", "demo-asset"].includes(type)) syntheticOnly(asset.sourceOrigin, "sourceOrigin");
  else enumValue(asset.sourceOrigin, ["synthetic", "owned-brand-source"], "sourceOrigin");
  const expiresAt = timestamp(asset.expiresAt, "expiresAt");
  if (new Date(expiresAt) <= now) fail("ASSET_EXPIRED", "brand asset has expired");
  return {
    schemaVersion: "ltm.brand-asset.v1",
    assetId: identifier(asset.assetId, "assetId"),
    type,
    version: identifier(asset.version, "version"),
    artifactSha256: digest(asset.artifactSha256, "artifactSha256"),
    sourceOrigin: asset.sourceOrigin,
    license: validateLicense(asset.license, now),
    approvals: validateApprovals(asset.approvals, ["brand", "legal"], now),
    publishedAt: timestamp(asset.publishedAt, "publishedAt"),
    expiresAt,
  };
}

export function publishBrandAsset(store, input, now = new Date()) {
  const asset = validateBrandAsset(input.asset, now);
  return store.transact({
    actorId: input.actorId,
    action: "brand-asset.publish",
    subject: asset.assetId,
    idempotencyKey: input.idempotencyKey,
    input: asset,
    at: input.at,
  }, (records) => {
    records.trust.brandAssets ??= {};
    const aggregate = records.trust.brandAssets[asset.assetId] ?? { versions: {}, currentVersion: null, history: [] };
    const prior = aggregate.versions[asset.version];
    if (prior !== undefined && sha256(prior) !== sha256(asset)) fail("VERSION_IMMUTABLE", "brand asset version is immutable");
    aggregate.versions[asset.version] = asset;
    aggregate.currentVersion = asset.version;
    aggregate.history.push({ operation: "published", version: asset.version, at: input.at, actorId: input.actorId });
    records.trust.brandAssets[asset.assetId] = aggregate;
    return { assetId: asset.assetId, version: asset.version, cacheTags: [`brand-asset:${asset.assetId}`] };
  });
}

function validateCertification(value, index, now) {
  const certification = plainObject(value, `certifications[${index}]`);
  exactKeys(certification, ["certificationId", "label", "status", "provider", "evidenceSha256", "verifiedAt", "expiresAt"], `certifications[${index}]`);
  const status = enumValue(certification.status, ["verified", "expired", "withdrawn"], `certifications[${index}].status`);
  const expiresAt = timestamp(certification.expiresAt, `certifications[${index}].expiresAt`);
  if (status === "verified" && new Date(expiresAt) <= now) fail("CERTIFICATION_EXPIRED", "verified certification has expired");
  return {
    certificationId: identifier(certification.certificationId, `certifications[${index}].certificationId`),
    label: sanitizeText(certification.label, `certifications[${index}].label`, 160),
    status,
    provider: identifier(certification.provider, `certifications[${index}].provider`),
    evidenceSha256: digest(certification.evidenceSha256, `certifications[${index}].evidenceSha256`),
    verifiedAt: timestamp(certification.verifiedAt, `certifications[${index}].verifiedAt`),
    expiresAt,
  };
}

export function validateTrustCenter(value, now = new Date()) {
  const trust = plainObject(value, "trust center");
  exactKeys(trust, [
    "version", "dataFlows", "retentionDeletion", "subprocessors", "aiDisclosure", "securityControls", "childBoundary",
    "highImpactDecisionProhibition", "certifications", "approvals", "publishedAt",
  ], "trust center");
  if (sanitizeText(trust.aiDisclosure, "aiDisclosure", 500) !== TRUST_STATEMENTS.aiDisclosure) fail("TRUST_STATEMENT_INVALID", "AI disclosure cannot be weakened");
  if (sanitizeText(trust.childBoundary, "childBoundary", 500) !== TRUST_STATEMENTS.childBoundary) fail("TRUST_STATEMENT_INVALID", "child protection boundary cannot be weakened");
  if (sanitizeText(trust.highImpactDecisionProhibition, "highImpactDecisionProhibition", 500) !== TRUST_STATEMENTS.highImpactDecisionProhibition) fail("TRUST_STATEMENT_INVALID", "high-impact decision prohibition cannot be weakened");
  if (!Array.isArray(trust.certifications) || trust.certifications.length > 50) fail("CERTIFICATIONS_INVALID", "certifications must be bounded");
  const certifications = trust.certifications.map((item, index) => validateCertification(item, index, now));
  if (new Set(certifications.map((item) => item.certificationId)).size !== certifications.length) fail("CERTIFICATIONS_INVALID", "certification IDs must be unique");
  return {
    schemaVersion: "ltm.trust-center.v1",
    version: identifier(trust.version, "version"),
    dataFlows: stringArray(trust.dataFlows, "dataFlows", { minimum: 1, maximum: 100, itemMaximum: 500 }).map((item) => sanitizeText(item, "dataFlow", 500)),
    retentionDeletion: stringArray(trust.retentionDeletion, "retentionDeletion", { minimum: 1, maximum: 100, itemMaximum: 500 }).map((item) => sanitizeText(item, "retentionDeletion", 500)),
    subprocessors: stringArray(trust.subprocessors, "subprocessors", { maximum: 100, itemMaximum: 256 }).map((item) => identifier(item, "subprocessor")),
    aiDisclosure: TRUST_STATEMENTS.aiDisclosure,
    securityControls: stringArray(trust.securityControls, "securityControls", { minimum: 1, maximum: 100, itemMaximum: 500 }).map((item) => sanitizeText(item, "securityControl", 500)),
    childBoundary: TRUST_STATEMENTS.childBoundary,
    highImpactDecisionProhibition: TRUST_STATEMENTS.highImpactDecisionProhibition,
    certifications,
    approvals: validateApprovals(trust.approvals, ["privacy", "security", "legal"], now),
    publishedAt: timestamp(trust.publishedAt, "publishedAt"),
  };
}

export function publishTrustCenter(store, input, now = new Date()) {
  const trust = validateTrustCenter(input.trustCenter, now);
  return store.transact({
    actorId: input.actorId,
    action: "trust-center.publish",
    subject: trust.version,
    idempotencyKey: input.idempotencyKey,
    input: trust,
    at: input.at,
  }, (records) => {
    records.trust.trustCenters ??= {};
    const prior = records.trust.trustCenters[trust.version];
    if (prior !== undefined && sha256(prior) !== sha256(trust)) fail("VERSION_IMMUTABLE", "trust-center version is immutable");
    records.trust.trustCenters[trust.version] = trust;
    records.trust.currentTrustCenter = trust.version;
    return { version: trust.version, publicCertificationCount: trust.certifications.filter((item) => item.status === "verified").length };
  });
}

export function publicTrustCenter(store, now = new Date()) {
  const state = store.read().records.trust;
  const document = state.trustCenters?.[state.currentTrustCenter];
  if (document === undefined) fail("TRUST_CENTER_NOT_FOUND", "published trust center does not exist");
  const { approvals: _privateApprovals, ...publicDocument } = document;
  return {
    ...publicDocument,
    certifications: document.certifications.filter((item) => item.status === "verified" && new Date(item.expiresAt) > now),
    headers: { "cache-control": "public, max-age=300, stale-while-revalidate=3600" },
  };
}

function validateIncidentUpdate(value, index) {
  const update = plainObject(value, `updates[${index}]`);
  exactKeys(update, ["at", "state", "message"], `updates[${index}]`);
  return {
    at: timestamp(update.at, `updates[${index}].at`),
    state: enumValue(update.state, ["investigating", "identified", "monitoring", "resolved"], `updates[${index}].state`),
    message: sanitizeText(update.message, `updates[${index}].message`, 1_000),
  };
}

export function validatePublicIncident(value) {
  const incident = plainObject(value, "public incident");
  exactKeys(incident, ["incidentId", "title", "severity", "state", "components", "startedAt", "resolvedAt", "updates"], "public incident");
  const state = enumValue(incident.state, ["investigating", "identified", "monitoring", "resolved"], "state");
  const resolvedAt = optionalTimestamp(incident.resolvedAt, "resolvedAt");
  if ((state === "resolved") !== (resolvedAt !== null)) fail("INCIDENT_STATE_INVALID", "resolvedAt must exist exactly when incident is resolved");
  if (!Array.isArray(incident.updates) || incident.updates.length === 0 || incident.updates.length > 100) fail("INCIDENT_UPDATES_INVALID", "public incident updates are required and bounded");
  const updates = incident.updates.map(validateIncidentUpdate);
  if (updates.at(-1).state !== state) fail("INCIDENT_STATE_INVALID", "latest update must match incident state");
  for (let index = 1; index < updates.length; index += 1) {
    if (new Date(updates[index].at) <= new Date(updates[index - 1].at)) fail("INCIDENT_UPDATES_INVALID", "incident updates must be strictly chronological");
  }
  return {
    schemaVersion: "ltm.public-incident.v1",
    incidentId: identifier(incident.incidentId, "incidentId"),
    title: sanitizeText(incident.title, "title", 240),
    severity: enumValue(incident.severity, ["minor", "major", "critical"], "severity"),
    state,
    components: stringArray(incident.components, "components", { minimum: 1, maximum: PUBLIC_COMPONENTS.length }).map((item) => enumValue(item, PUBLIC_COMPONENTS, "component")),
    startedAt: timestamp(incident.startedAt, "startedAt"),
    resolvedAt,
    updates,
  };
}

export function publishStatusIncident(store, input) {
  const incident = validatePublicIncident(input.incident);
  return store.transact({
    actorId: input.actorId,
    action: "status-incident.publish",
    subject: incident.incidentId,
    idempotencyKey: input.idempotencyKey,
    input: incident,
    at: input.at,
  }, (records) => {
    const prior = records.incidents[incident.incidentId];
    if (prior !== undefined && new Date(incident.updates[0].at).getTime() !== new Date(prior.updates[0].at).getTime()) fail("INCIDENT_IMMUTABLE", "incident origin is immutable");
    records.incidents[incident.incidentId] = incident;
    return { incidentId: incident.incidentId, state: incident.state, subscriberNotificationRequired: true };
  });
}

export function publishStatusMaintenance(store, input) {
  const maintenance = plainObject(input.maintenance, "public maintenance");
  exactKeys(maintenance, ["maintenanceId", "title", "state", "components", "startsAt", "endsAt", "message"], "public maintenance");
  const startsAt = timestamp(maintenance.startsAt, "startsAt");
  const endsAt = timestamp(maintenance.endsAt, "endsAt");
  if (new Date(endsAt) <= new Date(startsAt)) fail("MAINTENANCE_WINDOW_INVALID", "maintenance end must follow its start");
  const normalized = {
    schemaVersion: "ltm.public-maintenance.v1",
    maintenanceId: identifier(maintenance.maintenanceId, "maintenanceId"),
    title: sanitizeText(maintenance.title, "title", 240),
    state: enumValue(maintenance.state, ["scheduled", "in-progress", "completed", "cancelled"], "state"),
    components: stringArray(maintenance.components, "components", { minimum: 1, maximum: PUBLIC_COMPONENTS.length }).map((item) => enumValue(item, PUBLIC_COMPONENTS, "component")),
    startsAt,
    endsAt,
    message: sanitizeText(maintenance.message, "message", 1_000),
  };
  return store.transact({ actorId: input.actorId, action: "status-maintenance.publish", subject: normalized.maintenanceId, idempotencyKey: input.idempotencyKey, input: normalized, at: input.at }, (records) => {
    records.trust.maintenances ??= {};
    records.trust.maintenances[normalized.maintenanceId] = normalized;
    return { maintenanceId: normalized.maintenanceId, state: normalized.state, subscriberNotificationRequired: true };
  });
}

export function publicStatusProjection(store, componentMeasurements, now = new Date()) {
  const measurements = plainObject(componentMeasurements, "component measurements");
  exactKeys(measurements, PUBLIC_COMPONENTS, "component measurements");
  const components = Object.fromEntries(PUBLIC_COMPONENTS.map((component) => {
    const measurement = plainObject(measurements[component], `componentMeasurements.${component}`);
    exactKeys(measurement, ["state", "measuredAt", "availabilityBasisPoints", "history"], `componentMeasurements.${component}`);
    if (!Array.isArray(measurement.history) || measurement.history.length === 0 || measurement.history.length > 400) fail("STATUS_MEASUREMENT_INVALID", "availability history must be bounded and non-empty");
    const history = measurement.history.map((value, index) => {
      const period = plainObject(value, `${component}.history[${index}]`);
      exactKeys(period, ["periodStart", "periodEnd", "availabilityBasisPoints"], `${component}.history[${index}]`);
      const periodStart = timestamp(period.periodStart, `${component}.history[${index}].periodStart`);
      const periodEnd = timestamp(period.periodEnd, `${component}.history[${index}].periodEnd`);
      if (new Date(periodEnd) <= new Date(periodStart)) fail("STATUS_MEASUREMENT_INVALID", "availability history period end must follow start");
      if (!Number.isSafeInteger(period.availabilityBasisPoints) || period.availabilityBasisPoints < 0 || period.availabilityBasisPoints > 10_000) fail("STATUS_MEASUREMENT_INVALID", "historical availabilityBasisPoints must be 0 to 10000");
      return { periodStart, periodEnd, availabilityBasisPoints: period.availabilityBasisPoints };
    });
    return [component, {
      state: enumValue(measurement.state, ["operational", "degraded", "outage", "maintenance", "unknown"], `${component}.state`),
      measuredAt: timestamp(measurement.measuredAt, `${component}.measuredAt`),
      availabilityBasisPoints: Number.isSafeInteger(measurement.availabilityBasisPoints) && measurement.availabilityBasisPoints >= 0 && measurement.availabilityBasisPoints <= 10_000 ? measurement.availabilityBasisPoints : fail("STATUS_MEASUREMENT_INVALID", "availabilityBasisPoints must be 0 to 10000"),
      history,
    }];
  }));
  const incidents = Object.values(store.read().records.incidents)
    .filter((incident) => incident.state !== "resolved" || new Date(incident.resolvedAt) > new Date(now.getTime() - 90 * 86_400_000))
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const maintenances = Object.values(store.read().records.trust.maintenances ?? {})
    .filter((maintenance) => maintenance.state !== "completed" || new Date(maintenance.endsAt) > new Date(now.getTime() - 90 * 86_400_000))
    .sort((left, right) => right.startsAt.localeCompare(left.startsAt));
  return {
    schemaVersion: "ltm.public-status.v1",
    generatedAt: now.toISOString(),
    overall: Object.values(components).some((item) => item.state === "outage") ? "outage" : Object.values(components).some((item) => item.state !== "operational") ? "degraded" : "operational",
    components,
    incidents,
    maintenances,
    privacyBoundary: "No internal topology, customer identity, or tenant-specific data is published.",
  };
}

export function createStatusSubscription(store, input, secret, now = new Date()) {
  const subscription = plainObject(input.subscription, "status subscription");
  exactKeys(subscription, ["subscriptionId", "channel", "destinationReference", "destinationSha256", "locale", "components"], "status subscription");
  const subscriptionId = identifier(subscription.subscriptionId, "subscriptionId");
  const destinationReference = requiredString(subscription.destinationReference, "destinationReference", 512);
  if (
    !/^(?:notification-provider|secret-manager):[A-Za-z0-9][A-Za-z0-9._:/-]{2,480}$/u.test(destinationReference) ||
    destinationReference.includes("@") || destinationReference.includes("..")
  ) fail("SUBSCRIPTION_DESTINATION_INVALID", "destinationReference must be an opaque managed-provider reference");
  const normalized = {
    subscriptionId,
    channel: enumValue(subscription.channel, ["email", "webhook"], "channel"),
    destinationReference,
    destinationSha256: digest(subscription.destinationSha256, "destinationSha256"),
    locale: requiredString(subscription.locale, "locale", 16),
    components: stringArray(subscription.components, "components", { minimum: 1, maximum: PUBLIC_COMPONENTS.length }).map((item) => enumValue(item, PUBLIC_COMPONENTS, "component")),
    state: "pending-confirmation",
    createdAt: now.toISOString(),
  };
  const iat = Math.floor(now.getTime() / 1_000);
  const token = signToken({ schemaVersion: "ltm.status-subscription.v1", audience: "status-confirmation", subscriptionId, destinationSha256: normalized.destinationSha256, iat, exp: iat + 1_800 }, secret);
  const result = store.transact({ actorId: input.actorId, action: "status-subscription.create", subject: subscriptionId, idempotencyKey: input.idempotencyKey, input: normalized, at: input.at }, (records) => {
    records.trust.statusSubscriptions ??= {};
    if (records.trust.statusSubscriptions[subscriptionId] !== undefined) fail("SUBSCRIPTION_EXISTS", "status subscription already exists");
    records.trust.statusSubscriptions[subscriptionId] = normalized;
    return normalized;
  });
  return { ...result, confirmationToken: token };
}

export function confirmStatusSubscription(store, input, secret, now = new Date()) {
  const claims = verifyToken(input.token, secret, { schemaVersion: "ltm.status-subscription.v1", audience: "status-confirmation" }, now);
  return store.transact({ actorId: input.actorId, action: "status-subscription.confirm", subject: claims.subscriptionId, idempotencyKey: input.idempotencyKey, input: { tokenSha256: sha256(input.token) }, at: input.at }, (records) => {
    const subscription = records.trust.statusSubscriptions?.[claims.subscriptionId];
    if (subscription === undefined || subscription.destinationSha256 !== claims.destinationSha256) fail("SUBSCRIPTION_NOT_FOUND", "status subscription is unavailable");
    subscription.state = "active";
    subscription.confirmedAt = timestamp(input.at, "at");
    return subscription;
  });
}

export function planStatusNotifications(store, input) {
  const eventKind = enumValue(input.eventKind, ["incident", "maintenance"], "eventKind");
  const eventId = identifier(input.eventId, "eventId");
  return store.transact({
    actorId: input.actorId,
    action: "status-notifications.plan",
    subject: `${eventKind}:${eventId}`,
    idempotencyKey: input.idempotencyKey,
    input: { eventKind, eventId },
    at: input.at,
  }, (records) => {
    const event = eventKind === "incident"
      ? records.incidents[eventId]
      : records.trust.maintenances?.[eventId];
    if (event === undefined) fail("STATUS_EVENT_NOT_FOUND", "status event is unavailable");
    records.trust.statusDeliveries ??= {};
    const deliveries = Object.values(records.trust.statusSubscriptions ?? {})
      .filter((subscription) => subscription.state === "active" && subscription.components.some((component) => event.components.includes(component)))
      .sort((left, right) => left.subscriptionId.localeCompare(right.subscriptionId))
      .map((subscription) => {
        const deliveryId = sha256({ eventKind, eventId, subscriptionId: subscription.subscriptionId }).slice(0, 32);
        const existing = records.trust.statusDeliveries[deliveryId];
        if (existing !== undefined) return existing;
        const delivery = {
          schemaVersion: "ltm.status-notification-delivery.v1",
          deliveryId,
          eventKind,
          eventId,
          subscriptionId: subscription.subscriptionId,
          channel: subscription.channel,
          destinationReference: subscription.destinationReference,
          destinationSha256: subscription.destinationSha256,
          locale: subscription.locale,
          state: "pending",
          attempts: 0,
          plannedAt: timestamp(input.at, "at"),
          providerReceiptSha256: null,
          acknowledgedAt: null,
        };
        records.trust.statusDeliveries[deliveryId] = delivery;
        return delivery;
      });
    return { eventKind, eventId, deliveries };
  });
}

export function acknowledgeStatusNotification(store, input) {
  const deliveryId = requiredString(input.deliveryId, "deliveryId", 32);
  if (!/^[a-f0-9]{32}$/u.test(deliveryId)) fail("VALIDATION_FAILED", "deliveryId must be a lowercase 128-bit digest identifier");
  const state = enumValue(input.state, ["delivered", "failed", "suppressed"], "state");
  const providerReceiptSha256 = digest(input.providerReceiptSha256, "providerReceiptSha256");
  return store.transact({
    actorId: input.actorId,
    action: "status-notification.acknowledge",
    subject: deliveryId,
    idempotencyKey: input.idempotencyKey,
    input: { deliveryId, state, providerReceiptSha256 },
    at: input.at,
  }, (records) => {
    const delivery = records.trust.statusDeliveries?.[deliveryId];
    if (delivery === undefined) fail("STATUS_DELIVERY_NOT_FOUND", "status notification delivery is unavailable");
    if (["delivered", "suppressed"].includes(delivery.state)) fail("STATUS_DELIVERY_TERMINAL", "terminal notification delivery cannot be changed");
    if (delivery.attempts >= 3) fail("STATUS_DELIVERY_RETRY_EXHAUSTED", "status notification retry limit is exhausted");
    delivery.state = state;
    delivery.attempts += 1;
    delivery.providerReceiptSha256 = providerReceiptSha256;
    delivery.acknowledgedAt = timestamp(input.at, "at");
    return delivery;
  });
}

export function validateFactCatalog(value) {
  const catalog = plainObject(value, "fact catalog");
  exactKeys(catalog, ["implementationVersion", "facts", "generatedAt"], "fact catalog");
  if (!Array.isArray(catalog.facts) || catalog.facts.length === 0 || catalog.facts.length > 1_000) fail("FACT_CATALOG_INVALID", "fact catalog must be bounded and non-empty");
  const facts = catalog.facts.map((item, index) => {
    const fact = plainObject(item, `facts[${index}]`);
    exactKeys(fact, ["factId", "valueSha256", "sourceArtifactSha256", "status", "verifiedAt", "expiresAt"], `facts[${index}]`);
    return {
      factId: identifier(fact.factId, `facts[${index}].factId`),
      valueSha256: digest(fact.valueSha256, `facts[${index}].valueSha256`),
      sourceArtifactSha256: digest(fact.sourceArtifactSha256, `facts[${index}].sourceArtifactSha256`),
      status: enumValue(fact.status, ["verified", "withdrawn", "superseded"], `facts[${index}].status`),
      verifiedAt: timestamp(fact.verifiedAt, `facts[${index}].verifiedAt`),
      expiresAt: timestamp(fact.expiresAt, `facts[${index}].expiresAt`),
    };
  });
  if (new Set(facts.map((fact) => fact.factId)).size !== facts.length) fail("FACT_CATALOG_INVALID", "fact IDs must be unique");
  return { implementationVersion: identifier(catalog.implementationVersion, "implementationVersion"), facts, generatedAt: timestamp(catalog.generatedAt, "generatedAt") };
}

export function validateSalesAsset(value, factCatalogValue, now = new Date()) {
  const catalog = validateFactCatalog(factCatalogValue);
  const asset = plainObject(value, "sales asset");
  exactKeys(asset, ["assetId", "type", "version", "artifactSha256", "implementationVersion", "factBindings", "approvals", "publishedAt", "expiresAt"], "sales asset");
  const type = enumValue(asset.type, SALES_ASSET_TYPES, "type");
  if (asset.implementationVersion !== catalog.implementationVersion) fail("IMPLEMENTATION_VERSION_MISMATCH", "sales asset does not describe the current implementation version");
  if (!Array.isArray(asset.factBindings) || asset.factBindings.length === 0 || asset.factBindings.length > 500) fail("FACT_BINDINGS_INVALID", "sales asset fact bindings are required and bounded");
  const factBindings = asset.factBindings.map((item, index) => {
    const binding = plainObject(item, `factBindings[${index}]`);
    exactKeys(binding, ["factId", "valueSha256", "sourceArtifactSha256"], `factBindings[${index}]`);
    const factId = identifier(binding.factId, `factBindings[${index}].factId`);
    const current = catalog.facts.find((fact) => fact.factId === factId);
    if (current === undefined || current.status !== "verified" || new Date(current.expiresAt) <= now) fail("FACT_NOT_CURRENT", `fact ${factId} is missing, unverified, or expired`);
    const valueSha256 = digest(binding.valueSha256, `factBindings[${index}].valueSha256`);
    const sourceArtifactSha256 = digest(binding.sourceArtifactSha256, `factBindings[${index}].sourceArtifactSha256`);
    if (valueSha256 !== current.valueSha256 || sourceArtifactSha256 !== current.sourceArtifactSha256) fail("FACT_BINDING_DRIFT", `fact ${factId} changed`);
    return { factId, valueSha256, sourceArtifactSha256 };
  });
  if (new Set(factBindings.map((fact) => fact.factId)).size !== factBindings.length) fail("FACT_BINDINGS_INVALID", "sales asset fact bindings must be unique");
  const expiresAt = timestamp(asset.expiresAt, "expiresAt");
  if (new Date(expiresAt) <= now) fail("SALES_ASSET_EXPIRED", "sales asset has expired");
  return {
    schemaVersion: "ltm.sales-asset.v1",
    assetId: identifier(asset.assetId, "assetId"),
    type,
    version: identifier(asset.version, "version"),
    artifactSha256: digest(asset.artifactSha256, "artifactSha256"),
    implementationVersion: catalog.implementationVersion,
    factBindings,
    approvals: validateApprovals(asset.approvals, REQUIRED_SALES_APPROVALS[type], now),
    publishedAt: timestamp(asset.publishedAt, "publishedAt"),
    expiresAt,
    state: "current",
  };
}

export function publishSalesAsset(store, input, factCatalogValue, now = new Date()) {
  const asset = validateSalesAsset(input.asset, factCatalogValue, now);
  return store.transact({ actorId: input.actorId, action: "sales-asset.publish", subject: asset.assetId, idempotencyKey: input.idempotencyKey, input: asset, at: input.at }, (records) => {
    const aggregate = records.salesAssets[asset.assetId] ?? { versions: {}, currentVersion: null, history: [] };
    const prior = aggregate.versions[asset.version];
    if (prior !== undefined && sha256(prior) !== sha256(asset)) fail("VERSION_IMMUTABLE", "sales asset version is immutable");
    aggregate.versions[asset.version] = asset;
    aggregate.currentVersion = asset.version;
    aggregate.history.push({ operation: "published", version: asset.version, at: input.at, actorId: input.actorId });
    records.salesAssets[asset.assetId] = aggregate;
    return { assetId: asset.assetId, version: asset.version, state: asset.state };
  });
}

export function markStaleSalesAssets(store, input, factCatalogValue, now = new Date()) {
  const catalog = validateFactCatalog(factCatalogValue);
  return store.transact({ actorId: input.actorId, action: "sales-assets.reconcile-facts", subject: catalog.implementationVersion, idempotencyKey: input.idempotencyKey, input: catalog, at: input.at }, (records) => {
    const stale = [];
    for (const [assetId, aggregate] of Object.entries(records.salesAssets)) {
      const asset = aggregate.versions[aggregate.currentVersion];
      const reasons = [];
      if (asset.implementationVersion !== catalog.implementationVersion) reasons.push("implementation-version-changed");
      if (new Date(asset.expiresAt) <= now) reasons.push("asset-expired");
      for (const binding of asset.factBindings) {
        const current = catalog.facts.find((fact) => fact.factId === binding.factId);
        if (current === undefined || current.status !== "verified" || new Date(current.expiresAt) <= now || current.valueSha256 !== binding.valueSha256 || current.sourceArtifactSha256 !== binding.sourceArtifactSha256) reasons.push(`fact-drift:${binding.factId}`);
      }
      asset.state = reasons.length === 0 ? "current" : "stale";
      asset.staleReasons = [...new Set(reasons)];
      if (asset.state === "stale") stale.push({ assetId, version: asset.version, reasons: asset.staleReasons });
    }
    return { implementationVersion: catalog.implementationVersion, stale };
  });
}

export function registerMaterialDependencies(store, input) {
  const material = plainObject(input.material, "material dependency registration");
  exactKeys(material, ["materialId", "materialType", "materialVersion", "dependencies"], "material dependency registration");
  if (!Array.isArray(material.dependencies) || material.dependencies.length === 0 || material.dependencies.length > 500) fail("MATERIAL_DEPENDENCIES_INVALID", "material dependencies must be bounded and non-empty");
  const dependencies = material.dependencies.map((value, index) => {
    const dependency = plainObject(value, `dependencies[${index}]`);
    exactKeys(dependency, ["kind", "dependencyId", "stateSha256"], `dependencies[${index}]`);
    return {
      kind: enumValue(dependency.kind, ["fact", "certification", "vendor", "policy"], `dependencies[${index}].kind`),
      dependencyId: identifier(dependency.dependencyId, `dependencies[${index}].dependencyId`),
      stateSha256: digest(dependency.stateSha256, `dependencies[${index}].stateSha256`),
    };
  });
  if (new Set(dependencies.map((dependency) => `${dependency.kind}:${dependency.dependencyId}`)).size !== dependencies.length) fail("MATERIAL_DEPENDENCIES_INVALID", "material dependencies must be unique");
  const normalized = {
    materialId: identifier(material.materialId, "materialId"),
    materialType: enumValue(material.materialType, ["page", "brand-asset", "trust-center", "sales-asset"], "materialType"),
    materialVersion: identifier(material.materialVersion, "materialVersion"),
    dependencies,
    state: "current",
    staleReasons: [],
  };
  return store.transact({ actorId: input.actorId, action: "material-dependencies.register", subject: `${normalized.materialType}:${normalized.materialId}`, idempotencyKey: input.idempotencyKey, input: normalized, at: input.at }, (records) => {
    records.trust.materialDependencies ??= {};
    const key = `${normalized.materialType}:${normalized.materialId}`;
    const prior = records.trust.materialDependencies[key];
    if (prior !== undefined && prior.materialVersion === normalized.materialVersion && sha256(prior.dependencies) !== sha256(dependencies)) fail("VERSION_IMMUTABLE", "material dependency registration is immutable within a version");
    records.trust.materialDependencies[key] = normalized;
    return normalized;
  });
}

export function reconcileMaterialDependencies(store, input) {
  if (!Array.isArray(input.currentDependencies) || input.currentDependencies.length > 10_000) fail("MATERIAL_DEPENDENCIES_INVALID", "current dependencies must be a bounded array");
  const current = new Map(input.currentDependencies.map((value, index) => {
    const dependency = plainObject(value, `currentDependencies[${index}]`);
    exactKeys(dependency, ["kind", "dependencyId", "stateSha256", "status"], `currentDependencies[${index}]`);
    const normalized = {
      kind: enumValue(dependency.kind, ["fact", "certification", "vendor", "policy"], `currentDependencies[${index}].kind`),
      dependencyId: identifier(dependency.dependencyId, `currentDependencies[${index}].dependencyId`),
      stateSha256: digest(dependency.stateSha256, `currentDependencies[${index}].stateSha256`),
      status: enumValue(dependency.status, ["current", "changed", "expired", "withdrawn"], `currentDependencies[${index}].status`),
    };
    return [`${normalized.kind}:${normalized.dependencyId}`, normalized];
  }));
  return store.transact({ actorId: input.actorId, action: "material-dependencies.reconcile", subject: "public-materials", idempotencyKey: input.idempotencyKey, input: input.currentDependencies, at: input.at }, (records) => {
    const stale = [];
    for (const [key, material] of Object.entries(records.trust.materialDependencies ?? {})) {
      const reasons = [];
      for (const dependency of material.dependencies) {
        const observed = current.get(`${dependency.kind}:${dependency.dependencyId}`);
        if (observed === undefined) reasons.push(`dependency-missing:${dependency.kind}:${dependency.dependencyId}`);
        else if (observed.status !== "current") reasons.push(`dependency-${observed.status}:${dependency.kind}:${dependency.dependencyId}`);
        else if (observed.stateSha256 !== dependency.stateSha256) reasons.push(`dependency-drift:${dependency.kind}:${dependency.dependencyId}`);
      }
      material.state = reasons.length === 0 ? "current" : "stale";
      material.staleReasons = reasons;
      if (material.state === "stale") stale.push({ key, materialId: material.materialId, materialType: material.materialType, reasons });
    }
    return { stale, invalidationRequired: stale.length > 0, cacheTags: stale.map((item) => `${item.materialType}:${item.materialId}`) };
  });
}

export const mandatoryTrustStatements = TRUST_STATEMENTS;
