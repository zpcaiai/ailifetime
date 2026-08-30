const SUPPORTED_VERSION = "ltm.visible-capability-manifest.v1";
const PORTALS = new Set(["consumer", "family", "partner", "studio", "operations", "support", "developer"]);
const MODES = new Set(["resource", "state-transition", "consent-write", "ledger-post", "partner-settlement-ledger", "inbox-event", "external-command", "attestation"]);
const ROOT_FIELDS = ["schemaVersion", "capabilities", "portals", "count", "requestId"];
const CAPABILITY_FIELDS = ["batchId", "skill", "operation", "permission", "portalId", "mode", "requirements", "requiresExternalEvidence"];
const PORTAL_FIELDS = ["id", "skills", "capabilityCount"];

function requireManifest() {
  const manifest = getApp().globalData.policy;
  if (!validManifest(manifest)) {
    throw new Error("CLIENT_MANIFEST_UNAVAILABLE");
  }
  return manifest;
}

function routeAllowed(routeId, roles) {
  const manifest = requireManifest();
  const portal = manifest.portals.find((item) => item && item.id === routeId);
  if (!portal) return false;
  return manifest.capabilities.some((capability) => capability.portalId === routeId) && validRoles(roles);
}

function capabilitiesAllowed(batchIds, roles) {
  const manifest = requireManifest();
  if (!Array.isArray(batchIds) || batchIds.length === 0 || new Set(batchIds).size !== batchIds.length || !validRoles(roles)) return false;
  return batchIds.every((batchId) => manifest.capabilities.some((capability) => capability.batchId === batchId));
}

function requireCapabilities(batchIds, roles) {
  if (!capabilitiesAllowed(batchIds, roles)) throw new Error("CLIENT_CAPABILITY_FORBIDDEN");
}

function validManifest(manifest) {
  if (!plainObject(manifest) || !exactFields(manifest, ROOT_FIELDS) || manifest.schemaVersion !== SUPPORTED_VERSION ||
      !Array.isArray(manifest.portals) || !Array.isArray(manifest.capabilities) ||
      !Number.isSafeInteger(manifest.count) || manifest.count !== manifest.capabilities.length ||
      manifest.capabilities.length > 128 || manifest.portals.length > 7 ||
      typeof manifest.requestId !== "string" || manifest.requestId.length < 1 || manifest.requestId.length > 512) return false;
  const capabilityIds = new Set();
  const portalIds = new Set();
  for (const portal of manifest.portals) {
    if (!plainObject(portal) || !exactFields(portal, PORTAL_FIELDS) || !PORTALS.has(portal.id) || !portalIds.add(portal.id) ||
        !Array.isArray(portal.skills) || portal.skills.length < 1 || portal.skills.length > 22 || new Set(portal.skills).size !== portal.skills.length ||
        portal.skills.some((skill) => !boundedToken(skill, 256)) || !Number.isSafeInteger(portal.capabilityCount) || portal.capabilityCount < 1) return false;
  }
  for (const capability of manifest.capabilities) {
    if (!plainObject(capability) || !exactFields(capability, CAPABILITY_FIELDS) ||
        !/^B(?:0[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])$/.test(capability.batchId) || !capabilityIds.add(capability.batchId) ||
        !boundedToken(capability.skill, 256) || !boundedToken(capability.operation, 160) || !boundedToken(capability.permission, 160) ||
        !portalIds.has(capability.portalId) || !MODES.has(capability.mode) || typeof capability.requiresExternalEvidence !== "boolean" ||
        !Array.isArray(capability.requirements) || capability.requirements.length !== 5 ||
        capability.requirements.some((requirement, index) => requirement !== `${capability.batchId}-R0${index + 1}`)) return false;
    const portal = manifest.portals.find((item) => item.id === capability.portalId);
    if (!portal || !portal.skills.includes(capability.skill)) return false;
  }
  return manifest.portals.every((portal) =>
    manifest.capabilities.filter((capability) => capability.portalId === portal.id).length === portal.capabilityCount);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value, expected) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && expected.every((field) => actual.includes(field));
}

function boundedToken(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function validRoles(roles) {
  return Array.isArray(roles) && roles.length > 0 && roles.every((role) => boundedToken(role, 64));
}

function minimumVersionSatisfied(currentVersion) {
  const manifest = requireManifest();
  return compareVersions(currentVersion, "2.33.0") >= 0;
}

function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

module.exports = { requireManifest, routeAllowed, capabilitiesAllowed, requireCapabilities, minimumVersionSatisfied };
