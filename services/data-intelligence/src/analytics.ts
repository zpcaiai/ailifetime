import { assertFinite, assertMinorUnits, clone, DataIntelligenceError, required, strictUtc, unique } from "./common.js";

export const DASHBOARD_IDS = [
  "acquisition", "activation", "generation", "sharing", "payment", "retention", "revenue",
  "partner", "support", "supply_chain", "slo",
] as const;
export type DashboardId = (typeof DASHBOARD_IDS)[number];
export type AnalyticsRole = "platform_analyst" | "finance" | "operations" | "security" | "partner_analyst";

export interface MetricPresentation {
  readonly metric: string;
  readonly definition: string;
  readonly asOf: string;
  readonly refreshSeconds: number;
  readonly grain: string;
  readonly filters: readonly string[];
  readonly currency?: string;
  readonly confidence: "observed" | "estimated" | "incomplete";
  readonly owner: string;
}

export interface DashboardDefinition {
  readonly id: DashboardId;
  readonly owner: string;
  readonly roles: readonly AnalyticsRole[];
  readonly metrics: readonly MetricPresentation[];
  readonly allowedDetailColumns: readonly string[];
  readonly drilldownAction: string;
  readonly contractVersion: number;
  readonly expiresAt?: string;
}

export interface DashboardActor {
  readonly tenantId: string;
  readonly role: AnalyticsRole;
  readonly regions: readonly string[];
  readonly partnerId?: string;
  readonly permissions: readonly string[];
}

export interface DashboardRow {
  readonly tenantId: string;
  readonly region: string;
  readonly partnerId?: string;
  readonly values: Readonly<Record<string, string | number | boolean | null>>;
}

const forbiddenDetailColumns = new Set(["raw_media", "private_conversation", "face_embedding", "child_identity", "payment_credential"]);

export class DashboardCatalog {
  readonly #definitions = new Map<DashboardId, DashboardDefinition>();
  readonly #usage = new Map<DashboardId, number>();

  publish(definition: DashboardDefinition): void {
    if (!DASHBOARD_IDS.includes(definition.id)) throw new DataIntelligenceError("VALIDATION_FAILED", "dashboard id is invalid");
    required(definition.owner, "dashboard owner"); required(definition.drilldownAction, "drilldownAction");
    unique(definition.roles, "dashboard roles"); unique(definition.allowedDetailColumns, "dashboard columns");
    if (definition.metrics.length === 0 || definition.contractVersion < 1 || !Number.isSafeInteger(definition.contractVersion)) {
      throw new DataIntelligenceError("VALIDATION_FAILED", "dashboard contract is incomplete");
    }
    if (definition.allowedDetailColumns.some((column) => forbiddenDetailColumns.has(column))) {
      throw new DataIntelligenceError("POLICY_BLOCKED", "dashboard exposes a prohibited sensitive detail column");
    }
    for (const metric of definition.metrics) validateMetricPresentation(metric);
    if (definition.expiresAt !== undefined) strictUtc(definition.expiresAt, "dashboard expiresAt");
    const previous = this.#definitions.get(definition.id);
    if (previous !== undefined && definition.contractVersion !== previous.contractVersion + 1) {
      throw new DataIntelligenceError("CONFLICT", "dashboard contract versions must be contiguous");
    }
    this.#definitions.set(definition.id, Object.freeze(clone(definition)));
  }

  query(id: DashboardId, actor: DashboardActor, rows: readonly DashboardRow[], now = new Date()): readonly DashboardRow[] {
    const definition = this.#definitions.get(id);
    if (definition === undefined) throw new DataIntelligenceError("NOT_FOUND", `dashboard ${id} is not published`);
    if (definition.expiresAt !== undefined && Date.parse(definition.expiresAt) <= now.getTime()) {
      throw new DataIntelligenceError("POLICY_BLOCKED", "dashboard contract has expired and must be reviewed");
    }
    if (!definition.roles.includes(actor.role) || !actor.permissions.includes(`dashboard:${id}:read`)) {
      throw new DataIntelligenceError("AUTHORIZATION_DENIED", "dashboard access is not authorized");
    }
    if (actor.role === "partner_analyst" && actor.partnerId === undefined) {
      throw new DataIntelligenceError("AUTHORIZATION_DENIED", "partner analytics require a server-bound partner id");
    }
    const result = rows.filter((row) => row.tenantId === actor.tenantId && actor.regions.includes(row.region) &&
      (actor.role !== "partner_analyst" || row.partnerId === actor.partnerId)).map((row) => {
      const values = Object.fromEntries(Object.entries(row.values).filter(([column]) => definition.allowedDetailColumns.includes(column)));
      return Object.freeze({ tenantId: row.tenantId, region: row.region, ...(row.partnerId === undefined ? {} : { partnerId: row.partnerId }), values: Object.freeze(values) });
    });
    this.#usage.set(id, (this.#usage.get(id) ?? 0) + 1);
    return Object.freeze(result);
  }

  review(): ReadonlyArray<{ readonly id: DashboardId; readonly usage: number; readonly expired: boolean }> {
    const now = Date.now();
    return Object.freeze([...this.#definitions.values()].map((definition) => Object.freeze({
      id: definition.id,
      usage: this.#usage.get(definition.id) ?? 0,
      expired: definition.expiresAt !== undefined && Date.parse(definition.expiresAt) <= now,
    })));
  }
}

export type AttributionModel = "first_touch" | "last_touch" | "linear_multi_touch" | "experimental_incrementality";
export interface AttributionTouch {
  readonly touchId: string;
  readonly subjectId: string;
  readonly deviceId: string;
  readonly channel: string;
  readonly occurredAt: string;
  readonly contactConsent: boolean;
  readonly bot: boolean;
  readonly affiliateFraud: boolean;
  readonly identityMergeConfidence: number;
}
export interface AttributionCredit { readonly touchId: string; readonly channel: string; readonly weight: number; }
export interface AttributionResult {
  readonly model: AttributionModel;
  readonly credits: readonly AttributionCredit[];
  readonly excludedTouchIds: readonly string[];
  readonly limitations: readonly string[];
}

export function attribute(input: {
  readonly model: AttributionModel;
  readonly conversionAt: string;
  readonly windowDays: number;
  readonly touches: readonly AttributionTouch[];
  readonly observableAcrossDevices: boolean;
  readonly experimentLift?: number;
}): AttributionResult {
  const conversionAt = Date.parse(strictUtc(input.conversionAt, "conversionAt"));
  if (!Number.isSafeInteger(input.windowDays) || input.windowDays < 1 || input.windowDays > 365) throw new DataIntelligenceError("VALIDATION_FAILED", "attribution window is invalid");
  const cutoff = conversionAt - input.windowDays * 86_400_000;
  const excluded = input.touches.filter((touch) => !touch.contactConsent || touch.bot || touch.affiliateFraud || touch.identityMergeConfidence < 0.8 ||
    Date.parse(strictUtc(touch.occurredAt)) < cutoff || Date.parse(touch.occurredAt) > conversionAt);
  const eligible = input.touches.filter((touch) => !excluded.includes(touch)).sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
  if (eligible.length === 0) return Object.freeze({ model: input.model, credits: Object.freeze([]), excludedTouchIds: Object.freeze(excluded.map((touch) => touch.touchId)), limitations: Object.freeze(["no_observable_eligible_touch"]) });
  let credits: AttributionCredit[];
  if (input.model === "first_touch") credits = [{ touchId: eligible[0]!.touchId, channel: eligible[0]!.channel, weight: 1 }];
  else if (input.model === "last_touch") {
    const touch = eligible[eligible.length - 1]!;
    credits = [{ touchId: touch.touchId, channel: touch.channel, weight: 1 }];
  } else if (input.model === "linear_multi_touch") {
    const weight = 1 / eligible.length;
    credits = eligible.map((touch) => ({ touchId: touch.touchId, channel: touch.channel, weight }));
  } else {
    if (input.experimentLift === undefined || input.experimentLift < 0 || input.experimentLift > 1) throw new DataIntelligenceError("VALIDATION_FAILED", "experimental attribution requires a bounded measured lift");
    const weight = input.experimentLift / eligible.length;
    credits = eligible.map((touch) => ({ touchId: touch.touchId, channel: touch.channel, weight }));
  }
  const limitations = [
    ...(input.observableAcrossDevices ? [] : ["cross_device_unobservable"]),
    ...(excluded.some((touch) => !touch.contactConsent) ? ["consent_missing"] : []),
    ...(excluded.some((touch) => touch.bot || touch.affiliateFraud) ? ["invalid_traffic_removed"] : []),
    ...(excluded.some((touch) => touch.identityMergeConfidence < 0.8) ? ["identity_merge_uncertain"] : []),
  ];
  return Object.freeze({ model: input.model, credits: Object.freeze(credits.map((credit) => Object.freeze({ ...credit }))), excludedTouchIds: Object.freeze(excluded.map((touch) => touch.touchId)), limitations: Object.freeze(limitations) });
}

export type CohortAnchor = "first_generation" | "first_purchase" | "family_created";
export interface CohortMember {
  readonly subjectId: string;
  readonly anchor: CohortAnchor;
  readonly anchorAt: string;
  readonly channel: string;
  readonly partnerId?: string;
  readonly region: string;
  readonly plan: string;
}
export interface RetentionActivity {
  readonly subjectId: string;
  readonly occurredAt: string;
  readonly kind: "visit" | "generation" | "family_interaction" | "annual_update" | "subscription" | "revenue" | "refund" | "deletion" | "churn";
  readonly amountMinor?: number;
}

export function cohortKey(member: CohortMember): string {
  const anchorAt = strictUtc(member.anchorAt, "anchorAt");
  const month = anchorAt.slice(0, 7);
  return [member.anchor, month, required(member.channel, "channel"), member.partnerId ?? "direct", required(member.region, "region"), required(member.plan, "plan")].join(":");
}

export function retentionCurve(member: CohortMember, activities: readonly RetentionActivity[]): Readonly<Record<string, number>> {
  const anchor = Date.parse(strictUtc(member.anchorAt));
  const buckets = new Map<string, number>();
  for (const activity of activities.filter((item) => item.subjectId === member.subjectId)) {
    const occurredAt = Date.parse(strictUtc(activity.occurredAt));
    if (occurredAt < anchor) continue;
    const week = Math.floor((occurredAt - anchor) / (7 * 86_400_000));
    const key = `${activity.kind}:w${week}`;
    buckets.set(key, (buckets.get(key) ?? 0) + (activity.amountMinor ?? 1));
  }
  return Object.freeze(Object.fromEntries([...buckets.entries()].sort()));
}

export interface LifetimeValueInput {
  readonly revenueMinor: number;
  readonly refundsMinor: number;
  readonly revenueShareMinor: number;
  readonly aiCostMinor: number;
  readonly paymentCostMinor: number;
  readonly notificationCostMinor: number;
  readonly supportCostMinor: number;
  readonly fulfillmentCostMinor: number;
  readonly observationMonths: number;
  readonly horizonMonths: number;
  readonly monthlyRetentionLow: number;
  readonly monthlyRetentionHigh: number;
}

export function lifetimeValue(input: LifetimeValueInput): { readonly observedNetMinor: number; readonly lowMinor: number; readonly highMinor: number; readonly assumptions: Readonly<Record<string, number>> } {
  for (const [field, value] of Object.entries(input)) assertFinite(value, field);
  if (input.observationMonths < 1 || input.horizonMonths < input.observationMonths || input.monthlyRetentionLow < 0 || input.monthlyRetentionHigh > 1 || input.monthlyRetentionLow > input.monthlyRetentionHigh) {
    throw new DataIntelligenceError("VALIDATION_FAILED", "LTV horizon or retention range is invalid");
  }
  const observedNetMinor = input.revenueMinor - input.refundsMinor - input.revenueShareMinor - input.aiCostMinor - input.paymentCostMinor - input.notificationCostMinor - input.supportCostMinor - input.fulfillmentCostMinor;
  const monthly = observedNetMinor / input.observationMonths;
  const remaining = input.horizonMonths - input.observationMonths;
  const projected = (retention: number): number => Math.round(observedNetMinor + monthly * [...Array(remaining)].reduce((sum, _value, index) => sum + retention ** (index + 1), 0));
  return Object.freeze({ observedNetMinor, lowMinor: projected(input.monthlyRetentionLow), highMinor: projected(input.monthlyRetentionHigh), assumptions: Object.freeze({ horizonMonths: input.horizonMonths, monthlyRetentionLow: input.monthlyRetentionLow, monthlyRetentionHigh: input.monthlyRetentionHigh }) });
}

export type CommercialUnit = "digital_art" | "video" | "subscription" | "gift" | "physical" | "partner_api" | "channel_order";
export interface UnitEconomicsFacts {
  readonly unit: CommercialUnit;
  readonly grossRevenueMinor: number;
  readonly refundsMinor: number;
  readonly discountsMinor: number;
  readonly revenueShareMinor: number;
  readonly costs: Readonly<Record<"model" | "model_retry" | "storage_cdn" | "payment" | "message" | "printing" | "shipping" | "support", number>>;
  readonly customers: number;
  readonly acquiredCustomers: number;
  readonly acquisitionCostMinor: number;
  readonly successfulGenerations: number;
}

export function unitEconomics(facts: UnitEconomicsFacts): Readonly<Record<string, number | string>> {
  for (const value of [facts.grossRevenueMinor, facts.refundsMinor, facts.discountsMinor, facts.revenueShareMinor, facts.acquisitionCostMinor, ...Object.values(facts.costs)]) assertMinorUnits(value, "unit economics amount");
  if (![facts.customers, facts.acquiredCustomers, facts.successfulGenerations].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new DataIntelligenceError("VALIDATION_FAILED", "unit economics counts are invalid");
  const netRevenueMinor = facts.grossRevenueMinor - facts.refundsMinor - facts.discountsMinor - facts.revenueShareMinor;
  const variableCostMinor = Object.values(facts.costs).reduce((sum, value) => sum + value, 0);
  const contributionMarginMinor = netRevenueMinor - variableCostMinor;
  return Object.freeze({
    unit: facts.unit, netRevenueMinor, variableCostMinor, contributionMarginMinor,
    grossMargin: netRevenueMinor === 0 ? 0 : contributionMarginMinor / netRevenueMinor,
    arpuMinor: facts.customers === 0 ? 0 : Math.round(netRevenueMinor / facts.customers),
    cacMinor: facts.acquiredCustomers === 0 ? 0 : Math.round(facts.acquisitionCostMinor / facts.acquiredCustomers),
    refundRate: facts.grossRevenueMinor === 0 ? 0 : facts.refundsMinor / facts.grossRevenueMinor,
    successfulGenerationCostMinor: facts.successfulGenerations === 0 ? 0 : Math.round((facts.costs.model + facts.costs.model_retry) / facts.successfulGenerations),
  });
}

export interface EconomicsScenario {
  readonly scenarioId: string;
  readonly facts: UnitEconomicsFacts;
  readonly assumptions: Readonly<Record<"modelPriceMultiplier" | "conversionMultiplier" | "refundMultiplier" | "retryMultiplier" | "shippingMultiplier", number>>;
}

export function runEconomicsScenario(scenario: EconomicsScenario): { readonly scenarioId: string; readonly assumptions: EconomicsScenario["assumptions"]; readonly result: ReturnType<typeof unitEconomics> } {
  required(scenario.scenarioId, "scenarioId");
  for (const [key, value] of Object.entries(scenario.assumptions)) if (!Number.isFinite(value) || value < 0 || value > 10) throw new DataIntelligenceError("VALIDATION_FAILED", `scenario ${key} is invalid`);
  const facts = clone(scenario.facts);
  const adjusted: UnitEconomicsFacts = {
    ...facts,
    grossRevenueMinor: Math.round(facts.grossRevenueMinor * scenario.assumptions.conversionMultiplier),
    refundsMinor: Math.round(facts.refundsMinor * scenario.assumptions.refundMultiplier),
    costs: {
      ...facts.costs,
      model: Math.round(facts.costs.model * scenario.assumptions.modelPriceMultiplier),
      model_retry: Math.round(facts.costs.model_retry * scenario.assumptions.retryMultiplier),
      shipping: Math.round(facts.costs.shipping * scenario.assumptions.shippingMultiplier),
    },
  };
  return Object.freeze({ scenarioId: scenario.scenarioId, assumptions: Object.freeze(clone(scenario.assumptions)), result: unitEconomics(adjusted) });
}

export function reconcileEconomics(input: { readonly ledgerNetMinor: number; readonly vendorBilledMinor: number; readonly operationalAllocatedMinor: number; readonly toleranceMinor: number; readonly period: string }): { readonly balanced: boolean; readonly varianceMinor: number; readonly caseId?: string } {
  for (const [field, value] of Object.entries(input).filter(([key]) => key !== "period")) assertMinorUnits(value as number, field);
  required(input.period, "period");
  const varianceMinor = input.ledgerNetMinor - input.vendorBilledMinor - input.operationalAllocatedMinor;
  const balanced = Math.abs(varianceMinor) <= input.toleranceMinor;
  return Object.freeze({ balanced, varianceMinor, ...(balanced ? {} : { caseId: `economics-reconciliation:${input.period}` }) });
}

function validateMetricPresentation(metric: MetricPresentation): void {
  required(metric.metric, "metric"); required(metric.definition, "metric definition"); required(metric.grain, "metric grain"); required(metric.owner, "metric owner");
  strictUtc(metric.asOf, "metric asOf"); unique(metric.filters, "metric filters");
  if (!Number.isSafeInteger(metric.refreshSeconds) || metric.refreshSeconds < 1) throw new DataIntelligenceError("VALIDATION_FAILED", "metric refresh interval is invalid");
  if (metric.currency !== undefined && !/^[A-Z]{3}$/u.test(metric.currency)) throw new DataIntelligenceError("VALIDATION_FAILED", "metric currency is invalid");
}
