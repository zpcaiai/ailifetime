import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const group = (from, to, module, sources, tests) => Object.freeze({ from, to, module, sources: Object.freeze(sources), tests: Object.freeze(tests) });

/**
 * These are executable, independently owned production surfaces. The canonical
 * capability registry remains the authenticated/durable public ingress, but it
 * is not accepted here as proof that domain behavior exists.
 */
export const PRODUCTION_SURFACE_GROUPS = Object.freeze([
  group(0, 5, "core-platform", ["packages/core/src/runtime.ts", "packages/core/src/postgres-runtime.ts", "services/api/src/domain-runtime.ts", "tools/repository-baseline.mjs"], ["packages/core/test/runtime.test.mjs", "packages/core/test/postgres.integration.test.mjs", "services/api/test/http.test.mjs", "tools/repository-baseline.test.mjs"]),
  group(6, 11, "consumer-media", ["services/experience-platform/src/consumer.ts", "services/experience-platform/src/media-pipeline.ts"], ["services/experience-platform/src/experience-platform.test.ts"]),
  group(12, 13, "durable-orchestration", ["services/orchestration-platform/src/provider-control-plane.ts", "services/orchestration-platform/src/durable-workflow.ts", "services/orchestration-platform/src/durable-runtime.ts"], ["services/orchestration-platform/src/orchestration-platform.test.ts", "services/orchestration-platform/src/production-orchestration.test.ts"]),
  group(14, 24, "media-family-future", ["services/experience-platform/src/media-pipeline.ts", "services/experience-platform/src/family-future.ts"], ["services/experience-platform/src/experience-platform.test.ts"]),
  group(25, 30, "commerce-fulfillment", ["services/commerce-platform/src/catalog-pricing.ts", "services/commerce-platform/src/payments-ledger.ts", "services/commerce-platform/src/subscription-credit-gift.ts", "services/commerce-platform/src/orders-delivery.ts", "services/commerce-platform/src/physical-fulfillment.ts", "services/commerce-platform/src/support-remedies.ts"], ["services/commerce-platform/src/commerce-platform.test.ts"]),
  group(31, 38, "partner-channels", ["services/partner-channel-platform/src/tenancy-onboarding.ts", "services/partner-channel-platform/src/partner-api-metering.ts", "services/partner-channel-platform/src/studio-gift.ts", "services/partner-channel-platform/src/regulated-crm.ts"], ["services/partner-channel-platform/src/partner-channel-platform.test.ts"]),
  group(39, 43, "growth-operations", ["services/growth-operations-platform/src/referral-lifecycle.ts", "services/growth-operations-platform/src/analytics-personalization.ts", "services/growth-operations-platform/src/admin-risk.ts"], ["services/growth-operations-platform/src/growth-operations-platform.test.ts"]),
  group(44, 48, "security-external-events", ["packages/core/src/evidence.ts", "packages/providers/src/production-common.ts", "services/integration-gateway/src/direct-evidence-callbacks.ts"], ["packages/providers/src/production-integrations.test.ts", "services/integration-gateway/src/direct-evidence-callbacks.test.ts", "packages/capabilities/src/external-evidence.integration.test.ts"]),
  group(49, 50, "trusted-execution", ["skills/certifying-life-time-machine-release/scripts/trusted_execution.py", "skills/orchestrating-life-time-machine/scripts/orchestrate_batches.py"], ["skills/certifying-life-time-machine-release/tests/test_trusted_execution.py", "skills/orchestrating-life-time-machine/tests/test_trusted_orchestration.py"]),
  group(51, 56, "experience-governance", ["packages/experience-governance/src/profile-research.ts", "packages/experience-governance/src/information-design.ts", "packages/experience-governance/src/localization-quality.ts"], ["packages/experience-governance/src/experience-governance.test.ts"]),
  group(57, 62, "public-web", ["packages/public-web-platform/src", "apps/web/src/capability-execution.ts"], ["packages/public-web-platform/test", "apps/web/src/capability-execution.test.ts"]),
  group(63, 72, "mobile-mini-program", ["apps/mobile/src/application.ts", "apps/mobile/native/app", "apps/wechat-mini/miniprogram"], ["apps/mobile/src/application.test.ts", "apps/mobile/src/mobile.test.ts", "apps/wechat-mini/tools/miniprogram.test.mjs"]),
  group(73, 78, "notifications", ["services/notification-platform/src"], ["services/notification-platform/test"]),
  group(79, 86, "customer-support", ["services/support-platform/src"], ["services/support-platform/test"]),
  group(87, 102, "finance-supply", ["services/commercial-operations/src/finance-engine.ts", "services/commercial-operations/src/supply-engine.ts", "services/commercial-operations/src/store.ts", "services/commercial-operations/src/signed-facts.ts"], ["services/commercial-operations/src/finance-engine.test.ts", "services/commercial-operations/src/supply-engine.test.ts", "services/commercial-operations/src/requirement-trace.test.ts"]),
  group(103, 110, "developer-integrations", ["services/developer-platform/src", "apps/developer-portal/src/portal.ts"], ["services/developer-platform/src/developer-platform.test.ts", "apps/developer-portal/src/portal.test.ts"]),
  group(111, 118, "data-intelligence", ["services/data-intelligence/src/events.ts", "services/data-intelligence/src/warehouse.ts", "services/data-intelligence/src/analytics.ts", "services/data-intelligence/src/experimentation.ts", "services/data-intelligence/src/governance.ts", "services/data-intelligence/src/model-quality.ts"], ["services/data-intelligence/src/data-intelligence.test.ts", "services/data-intelligence/src/data-assets.test.ts"]),
  group(119, 124, "enterprise-control-plane", ["services/enterprise-control-plane/src/security-compliance-engine.ts", "services/enterprise-control-plane/src/governance-engine.ts", "services/enterprise-control-plane/src/assurance-engine.ts", "services/enterprise-control-plane/src/store.ts", "services/enterprise-control-plane/src/attestation.ts"], ["services/enterprise-control-plane/src/governance-engine.test.ts", "services/enterprise-control-plane/src/assurance-engine.test.ts"]),
  group(125, 127, "release-certification", ["tools/b127-certifier.mjs", "tools/b127-release-controls.mjs", "tools/production-evidence-contracts.mjs", "tools/security-pentest-evidence.mjs"], ["tools/b127-certifier.test.mjs", "tools/b127-postgres.integration.test.mjs", "tools/security-pentest-evidence.test.mjs"]),
]);

function batchId(index) {
  return `B${String(index).padStart(2, "0")}`;
}

async function assertProductionPath(repositoryRoot, relativePath, kind) {
  if (relativePath.includes("node_modules") || relativePath.includes("/dist") || relativePath.startsWith("packages/capabilities/src/domains/")) {
    throw new Error(`${kind} path is generated, dependency-owned, or generic capability configuration: ${relativePath}`);
  }
  const absolutePath = resolve(repositoryRoot, relativePath);
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink()) throw new Error(`${kind} path must not be a symbolic link: ${relativePath}`);
  if (metadata.isFile()) {
    const contents = await readFile(absolutePath, "utf8");
    if (contents.trim().length < 32) throw new Error(`${kind} file is empty or placeholder-sized: ${relativePath}`);
  } else if (!metadata.isDirectory()) {
    throw new Error(`${kind} path is not a regular file or directory: ${relativePath}`);
  }
}

export async function validateProductionSurfaces(repositoryRoot = process.cwd()) {
  const assignments = new Map();
  const modules = new Set();
  for (const surface of PRODUCTION_SURFACE_GROUPS) {
    if (!Number.isInteger(surface.from) || !Number.isInteger(surface.to) || surface.from < 0 || surface.to > 127 || surface.from > surface.to) throw new Error(`invalid production-surface range: ${surface.module}`);
    if (surface.sources.length === 0 || surface.tests.length === 0) throw new Error(`production surface lacks source or tests: ${surface.module}`);
    modules.add(surface.module);
    await Promise.all(surface.sources.map((file) => assertProductionPath(repositoryRoot, file, "source")));
    await Promise.all(surface.tests.map((file) => assertProductionPath(repositoryRoot, file, "test")));
    for (let index = surface.from; index <= surface.to; index += 1) {
      const id = batchId(index);
      if (assignments.has(id)) throw new Error(`duplicate production-surface assignment: ${id}`);
      assignments.set(id, surface.module);
    }
  }
  const expected = Array.from({ length: 128 }, (_, index) => batchId(index));
  const missing = expected.filter((id) => !assignments.has(id));
  if (missing.length > 0 || assignments.size !== expected.length) throw new Error(`incomplete production-surface assignment: ${missing.join(",")}`);
  return Object.freeze({
    schemaVersion: "ltm.production-surface-gate.v1",
    batches: assignments.size,
    mandatoryRequirements: assignments.size * 5,
    independentModules: modules.size,
    genericCapabilityDefinitionsAcceptedAsIndependentImplementation: false,
    externalCertification: Object.freeze({ batches: Object.freeze(["B125", "B126", "B127"]), state: "NOT_CERTIFIED", policy: "fail_closed_until_request_bound_external_evidence" }),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await validateProductionSurfaces(), null, 2));
}
