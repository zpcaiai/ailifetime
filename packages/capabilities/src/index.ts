export * from "./registry.js";
export * from "./validation.js";
export * from "./external-business-event-reducers.js";
export * from "./portal-manifest.js";

import { CapabilityRegistry } from "./registry.js";
import { registerBootstrappingLifeTimeMachinePlatformCapabilities } from "./domains/bootstrapping-life-time-machine-platform.js";
import { registerBuildingAgeMediaPipelineCapabilities } from "./domains/building-age-media-pipeline.js";
import { registerBuildingChannelSolutionsCapabilities } from "./domains/building-channel-solutions.js";
import { registerBuildingCommerceFulfillmentCapabilities } from "./domains/building-commerce-fulfillment.js";
import { registerBuildingConsumerTimeMachineCapabilities } from "./domains/building-consumer-time-machine.js";
import { registerBuildingCustomerSupportSuccessCapabilities } from "./domains/building-customer-support-success.js";
import { registerBuildingDataIntelligencePlatformCapabilities } from "./domains/building-data-intelligence-platform.js";
import { registerBuildingDeveloperIntegrationPlatformCapabilities } from "./domains/building-developer-integration-platform.js";
import { registerBuildingFamilyFutureSelfCapabilities } from "./domains/building-family-future-self.js";
import { registerBuildingFinanceTaxOperationsCapabilities } from "./domains/building-finance-tax-operations.js";
import { registerBuildingGrowthDataLoopCapabilities } from "./domains/building-growth-data-loop.js";
import { registerBuildingMarketingContentPlatformCapabilities } from "./domains/building-marketing-content-platform.js";
import { registerBuildingMobileAndMiniProgramsCapabilities } from "./domains/building-mobile-and-mini-programs.js";
import { registerBuildingNotificationLifecyclePlatformCapabilities } from "./domains/building-notification-lifecycle-platform.js";
import { registerBuildingPartnerPlatformCapabilities } from "./domains/building-partner-platform.js";
import { registerBuildingPhysicalSupplyNetworkCapabilities } from "./domains/building-physical-supply-network.js";
import { registerCertifyingLifeTimeMachineReleaseCapabilities } from "./domains/certifying-life-time-machine-release.js";
import { registerDesigningLifeTimeMachineExperienceCapabilities } from "./domains/designing-life-time-machine-experience.js";
import { registerHardeningEnterprisePlatformCapabilities } from "./domains/hardening-enterprise-platform.js";
import { registerLaunchingCompleteCommercialProductCapabilities } from "./domains/launching-complete-commercial-product.js";
import { registerOrchestratingLifeTimeMachineCapabilities } from "./domains/orchestrating-life-time-machine.js";
import { registerSecuringOperatingLifeTimeMachineCapabilities } from "./domains/securing-operating-life-time-machine.js";

const registrars = [
  registerOrchestratingLifeTimeMachineCapabilities,
  registerBootstrappingLifeTimeMachinePlatformCapabilities,
  registerBuildingConsumerTimeMachineCapabilities,
  registerBuildingAgeMediaPipelineCapabilities,
  registerBuildingFamilyFutureSelfCapabilities,
  registerBuildingCommerceFulfillmentCapabilities,
  registerBuildingPartnerPlatformCapabilities,
  registerBuildingChannelSolutionsCapabilities,
  registerBuildingGrowthDataLoopCapabilities,
  registerSecuringOperatingLifeTimeMachineCapabilities,
  registerCertifyingLifeTimeMachineReleaseCapabilities,
  registerDesigningLifeTimeMachineExperienceCapabilities,
  registerBuildingMarketingContentPlatformCapabilities,
  registerBuildingMobileAndMiniProgramsCapabilities,
  registerBuildingNotificationLifecyclePlatformCapabilities,
  registerBuildingCustomerSupportSuccessCapabilities,
  registerBuildingFinanceTaxOperationsCapabilities,
  registerBuildingPhysicalSupplyNetworkCapabilities,
  registerBuildingDeveloperIntegrationPlatformCapabilities,
  registerBuildingDataIntelligencePlatformCapabilities,
  registerHardeningEnterprisePlatformCapabilities,
  registerLaunchingCompleteCommercialProductCapabilities,
] as const;

export function createCapabilityRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const register of registrars) register(registry);
  return registry;
}
