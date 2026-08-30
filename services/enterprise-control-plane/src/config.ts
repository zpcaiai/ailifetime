import { isAbsolute } from "node:path";
import { EnterpriseControlError, exactKeys, freeze, identifier, unique, type JsonObject } from "./common.js";

export interface EnterpriseServiceConfiguration {
  readonly environment: "test" | "staging" | "production";
  readonly databasePath: string;
  readonly workloadIdentity: string;
  readonly authorityCatalogReference: string;
  readonly defaultRegion: string;
  readonly regions: readonly string[];
  readonly protections: Readonly<{ consent: true; safety: true; aiLabel: true; children: true; highImpact: true; provenance: true }>;
}

export function parseEnterpriseServiceConfiguration(raw: JsonObject): EnterpriseServiceConfiguration {
  exactKeys(raw, ["environment", "databasePath", "workloadIdentity", "authorityCatalogReference", "defaultRegion", "regions", "protections"], "enterprise service configuration");
  if (raw.environment !== "test" && raw.environment !== "staging" && raw.environment !== "production") throw new EnterpriseControlError("CONFIGURATION_INVALID", "environment must be test, staging, or production");
  const databasePath = String(raw.databasePath); if (databasePath !== ":memory:" && !isAbsolute(databasePath)) throw new EnterpriseControlError("CONFIGURATION_INVALID", "database path must be absolute");
  const workloadIdentity = String(raw.workloadIdentity); const authorityCatalogReference = String(raw.authorityCatalogReference);
  if (!/^workload-identity:\/\/[A-Za-z0-9._/-]+$/.test(workloadIdentity)) throw new EnterpriseControlError("CONFIGURATION_INVALID", "workload identity reference is invalid");
  if (!/^(secret-manager|file):\/\/[A-Za-z0-9._/-]+$/.test(authorityCatalogReference)) throw new EnterpriseControlError("CONFIGURATION_INVALID", "authority catalog must be an opaque managed reference");
  if (raw.environment === "production" && (databasePath === ":memory:" || !authorityCatalogReference.startsWith("secret-manager://"))) throw new EnterpriseControlError("CONFIGURATION_INVALID", "production requires durable storage and a secret-manager authority catalog");
  const regions = unique(raw.regions as readonly string[], "regions"); const defaultRegion = identifier(String(raw.defaultRegion), "defaultRegion"); if (!regions.includes(defaultRegion)) throw new EnterpriseControlError("CONFIGURATION_INVALID", "default region is absent from inventory");
  const protections = raw.protections as JsonObject; exactKeys(protections, ["consent", "safety", "aiLabel", "children", "highImpact", "provenance"], "enterprise protections");
  if (Object.values(protections).some((value) => value !== true)) throw new EnterpriseControlError("POLICY_BLOCKED", "enterprise protections are immutable and cannot be disabled");
  return freeze({ environment: raw.environment, databasePath, workloadIdentity, authorityCatalogReference, defaultRegion, regions, protections: { consent: true, safety: true, aiLabel: true, children: true, highImpact: true, provenance: true } });
}
