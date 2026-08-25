import type { Role } from "@ltm/core";

export type CapabilityPortalId =
  | "consumer"
  | "family"
  | "partner"
  | "studio"
  | "operations"
  | "support"
  | "developer";

export interface CapabilityPortalDefinition {
  readonly id: CapabilityPortalId;
  readonly roles: readonly Role[];
  readonly skills: readonly string[];
}

/**
 * The single server-side navigation manifest. The API combines this role
 * boundary with each capability's executable permission before returning a
 * browser projection. Clients never decide that a capability is visible.
 */
export const CAPABILITY_PORTAL_MANIFEST: readonly CapabilityPortalDefinition[] = [
  {
    id: "consumer",
    roles: ["consumer", "household_admin", "guardian", "platform_admin"],
    skills: ["building-consumer-time-machine", "building-age-media-pipeline", "building-mobile-and-mini-programs"],
  },
  {
    id: "family",
    roles: ["consumer", "household_admin", "guardian", "platform_admin"],
    skills: ["building-family-future-self"],
  },
  {
    id: "partner",
    roles: ["partner_employee", "partner_admin", "platform_admin"],
    skills: ["building-partner-platform", "building-channel-solutions"],
  },
  {
    id: "studio",
    roles: ["studio_operator", "partner_admin", "platform_admin"],
    skills: ["building-physical-supply-network"],
  },
  {
    id: "operations",
    roles: ["support_agent", "moderator", "privacy_officer", "finance_operator", "platform_admin", "auditor"],
    skills: [
      "orchestrating-life-time-machine",
      "bootstrapping-life-time-machine-platform",
      "building-commerce-fulfillment",
      "building-growth-data-loop",
      "building-notification-lifecycle-platform",
      "building-finance-tax-operations",
      "building-marketing-content-platform",
      "building-data-intelligence-platform",
      "securing-operating-life-time-machine",
      "certifying-life-time-machine-release",
      "designing-life-time-machine-experience",
      "hardening-enterprise-platform",
      "launching-complete-commercial-product",
    ],
  },
  {
    id: "support",
    roles: ["support_agent", "moderator", "privacy_officer", "platform_admin"],
    skills: ["building-customer-support-success"],
  },
  {
    id: "developer",
    roles: ["partner_admin", "platform_admin", "auditor", "service_account"],
    skills: ["building-developer-integration-platform"],
  },
] as const;

export function capabilityPortalForSkill(skill: string): CapabilityPortalDefinition | undefined {
  return CAPABILITY_PORTAL_MANIFEST.find((portal) => portal.skills.includes(skill));
}

export function roleCanAccessCapabilityPortal(roles: readonly Role[], portal: CapabilityPortalDefinition): boolean {
  return roles.some((role) => portal.roles.includes(role));
}
