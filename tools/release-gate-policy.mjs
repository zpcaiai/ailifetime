/**
 * Production approval is deliberately stricter than the human-readable gate
 * outcome: limited/config-only/not-run states are not production evidence.
 */
export function isProductionReleaseApproved(profile, checks) {
  return profile === "production" &&
    Array.isArray(checks) &&
    checks.length > 0 &&
    checks.every((check) => check?.status === "PASS");
}

export function releaseGateOutcome(profile, checks) {
  if (checks.some((check) => check.status === "FAIL")) return "FAIL";
  if (profile === "production" && checks.some((check) => check.status !== "PASS")) return "BLOCKED";
  return "VERIFIED_CHECKS_PASS";
}
