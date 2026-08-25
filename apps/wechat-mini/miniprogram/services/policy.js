const SUPPORTED_VERSION = "ltm.visible-capability-manifest.v1";

function requireManifest() {
  const manifest = getApp().globalData.policy;
  if (!manifest || manifest.schemaVersion !== SUPPORTED_VERSION || !Array.isArray(manifest.portals) || !Array.isArray(manifest.capabilities)) {
    throw new Error("CLIENT_MANIFEST_UNAVAILABLE");
  }
  return manifest;
}

function routeAllowed(routeId, roles) {
  const manifest = requireManifest();
  const portal = manifest.portals.find((item) => item && item.id === routeId);
  if (!portal) return false;
  return manifest.capabilities.some((capability) => capability && capability.portal === routeId) && roles.length > 0;
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

module.exports = { requireManifest, routeAllowed, minimumVersionSatisfied };
