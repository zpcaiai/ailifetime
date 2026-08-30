import { authorization, bool, exact, fail, id, integer, iso, list, object, oneOf, sha256, text } from "./contracts.mjs";
import { NOTIFICATION_CHANNELS, NOTIFICATION_PURPOSES } from "./preferences.mjs";

export const NOTIFICATION_FACT_EVENTS = Object.freeze(["sent", "accepted", "delivered", "failed", "bounced", "complained", "unsubscribed", "opened", "clicked", "goal-completed"]);

export function recordNotificationEvent(store, input) {
  const event = object(input.event, "notification event");
  exact(event, ["eventId", "tenantId", "accountId", "contactId", "familyId", "messageId", "campaignId", "journeyId", "templateId", "providerId", "channel", "purpose", "event", "costMicros", "observable", "isMinor", "localHour", "occurredAt"], "notification event");
  const tenantId = id(event.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["notification-analytics-worker"], purpose: "notification-analytics" });
  const normalized = { schemaVersion: "ltm.notification-fact.v1", eventId: id(event.eventId, "eventId"), tenantId, accountId: id(event.accountId, "accountId"), contactId: id(event.contactId, "contactId"), familyId: event.familyId === null ? null : id(event.familyId, "familyId"), messageId: id(event.messageId, "messageId"), campaignId: event.campaignId === null ? null : id(event.campaignId, "campaignId"), journeyId: event.journeyId === null ? null : id(event.journeyId, "journeyId"), templateId: id(event.templateId, "templateId"), providerId: id(event.providerId, "providerId"), channel: oneOf(event.channel, NOTIFICATION_CHANNELS, "channel"), purpose: oneOf(event.purpose, NOTIFICATION_PURPOSES, "purpose"), event: oneOf(event.event, NOTIFICATION_FACT_EVENTS, "event"), costMicros: integer(event.costMicros, "costMicros", 0, 1_000_000_000), observable: bool(event.observable, "observable"), isMinor: bool(event.isMinor, "isMinor"), localHour: integer(event.localHour, "localHour", 0, 23), occurredAt: iso(event.occurredAt, "occurredAt") };
  return store.transact({ authorization: input.authorization, tenantId, purpose: "notification-analytics", action: "analytics.record", subject: normalized.eventId, idempotencyKey: normalized.eventId, at: normalized.occurredAt, input: normalized }, (records) => { records.analytics.push(normalized); return { eventId: normalized.eventId, recorded: true }; });
}

export function reserveFrequency(store, input) {
  const reservation = object(input.reservation, "frequency reservation"); exact(reservation, ["reservationId", "tenantId", "accountId", "contactId", "familyId", "purpose", "channel", "windowSeconds", "limits", "amount", "expiresAt"], "frequency reservation");
  const tenantId = id(reservation.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["notification-worker"], purpose: "frequency-reservation" });
  const limits = object(reservation.limits, "limits"); exact(limits, ["account", "contact", "family", "tenant", "purpose"], "limits");
  const normalized = { reservationId: id(reservation.reservationId, "reservationId"), tenantId, accountId: id(reservation.accountId, "accountId"), contactId: id(reservation.contactId, "contactId"), familyId: reservation.familyId === null ? null : id(reservation.familyId, "familyId"), purpose: oneOf(reservation.purpose, NOTIFICATION_PURPOSES, "purpose"), channel: oneOf(reservation.channel, NOTIFICATION_CHANNELS, "channel"), windowSeconds: integer(reservation.windowSeconds, "windowSeconds", 60, 2_592_000), limits: Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, integer(value, `${key} limit`, 0, 10_000_000)])), amount: integer(reservation.amount, "amount", 1, 100), expiresAt: iso(reservation.expiresAt, "expiresAt") };
  if (new Date(normalized.expiresAt) <= new Date(input.at)) fail("FREQUENCY_RESERVATION_EXPIRED", "frequency reservation expiry must be in the future");
  return store.transact({ authorization: input.authorization, tenantId, purpose: "frequency-reservation", action: "frequency.reserve", subject: normalized.contactId, idempotencyKey: normalized.reservationId, at: input.at, input: normalized }, (records) => {
    const after = new Date(new Date(input.at).getTime() - normalized.windowSeconds * 1000);
    const active = Object.values(records.frequency).filter((item) => item.tenantId === tenantId && new Date(item.reservedAt) > after && new Date(item.expiresAt) > new Date(input.at));
    const scopes = { account: ["accountId", normalized.accountId], contact: ["contactId", normalized.contactId], family: ["familyId", normalized.familyId], tenant: ["tenantId", tenantId], purpose: ["purpose", normalized.purpose] };
    for (const [scope, [field, value]] of Object.entries(scopes)) {
      if (value === null) continue;
      const used = active.filter((item) => item[field] === value).reduce((sum, item) => sum + item.amount, 0);
      if (used + normalized.amount > normalized.limits[scope]) fail("FREQUENCY_RESERVATION_DENIED", `${scope} rolling-window limit exceeded`, { scope, used, requested: normalized.amount, limit: normalized.limits[scope] });
    }
    records.frequency[normalized.reservationId] = { ...normalized, reservedAt: iso(input.at, "at"), state: "reserved" };
    return { reservationId: normalized.reservationId, state: "reserved", atomicRevisionRequired: true };
  });
}

export function validateExperiment(value) {
  const experiment = object(value, "experiment"); exact(experiment, ["experimentId", "tenantId", "campaignId", "purpose", "design", "variants", "holdoutBasisPoints", "primaryMetric", "guardrails", "stoppingRule", "minimumDetectableEffectBasisPoints", "sampleSize", "preregisteredAt", "startsAt", "endsAt"], "experiment");
  const variants = list(experiment.variants, "variants", { minimum: 1, maximum: 10, item: (item, index) => { exact(item, ["variantId", "weightBasisPoints"], `variants[${index}]`); return { variantId: id(item.variantId, "variantId"), weightBasisPoints: integer(item.weightBasisPoints, "weightBasisPoints", 1, 10_000) }; } });
  const holdoutBasisPoints = integer(experiment.holdoutBasisPoints, "holdoutBasisPoints", 1, 9_000);
  if (variants.reduce((sum, item) => sum + item.weightBasisPoints, 0) !== 10_000 - holdoutBasisPoints) fail("EXPERIMENT_WEIGHTS_INVALID", "variant and holdout weights must total 10000");
  const purpose = oneOf(experiment.purpose, NOTIFICATION_PURPOSES, "purpose"); if (purpose === "security") fail("SECURITY_EXPERIMENT_FORBIDDEN", "security message content cannot be experimented on");
  const startsAt = iso(experiment.startsAt, "startsAt"); const endsAt = iso(experiment.endsAt, "endsAt"); const preregisteredAt = iso(experiment.preregisteredAt, "preregisteredAt");
  if (new Date(preregisteredAt) >= new Date(startsAt) || new Date(endsAt) <= new Date(startsAt)) fail("EXPERIMENT_WINDOW_INVALID", "experiment must be preregistered before its valid window");
  return { schemaVersion: "ltm.notification-experiment.v1", experimentId: id(experiment.experimentId, "experimentId"), tenantId: id(experiment.tenantId, "tenantId"), campaignId: id(experiment.campaignId, "campaignId"), purpose, design: oneOf(experiment.design, ["fixed-sample", "sequential"], "design"), variants, holdoutBasisPoints, primaryMetric: id(experiment.primaryMetric, "primaryMetric"), guardrails: list(experiment.guardrails, "guardrails", { minimum: 1, maximum: 20, item: id }), stoppingRule: text(experiment.stoppingRule, "stoppingRule", 500), minimumDetectableEffectBasisPoints: integer(experiment.minimumDetectableEffectBasisPoints, "minimumDetectableEffectBasisPoints", 1, 5000), sampleSize: integer(experiment.sampleSize, "sampleSize", 100, 100_000_000), preregisteredAt, startsAt, endsAt };
}

export function assignExperiment(store, input) {
  const experiment = validateExperiment(input.experiment); authorization(input.authorization, { tenantId: experiment.tenantId, roles: ["experiment-worker"], purpose: "notification-experiment" });
  const subjectId = id(input.subjectId, "subjectId"); const assignmentId = `${experiment.tenantId}:${experiment.campaignId}:${subjectId}`;
  return store.transact({ authorization: input.authorization, tenantId: experiment.tenantId, purpose: "notification-experiment", action: "experiment.assign", subject: subjectId, idempotencyKey: id(input.idempotencyKey, "idempotencyKey"), at: input.at, input: { experiment, subjectId } }, (records) => {
    const existing = records.experiments[assignmentId]; if (existing !== undefined) return existing;
    const bucket = Number.parseInt(sha256(assignmentId).slice(0, 8), 16) % 10_000; let assignment = "holdout";
    if (bucket >= experiment.holdoutBasisPoints) { let cumulative = experiment.holdoutBasisPoints; for (const variant of experiment.variants) { cumulative += variant.weightBasisPoints; if (bucket < cumulative) { assignment = variant.variantId; break; } } }
    const result = { assignmentId, tenantId: experiment.tenantId, experimentId: experiment.experimentId, campaignId: experiment.campaignId, subjectId, assignment, crossChannel: true, assignedAt: input.at };
    records.experiments[assignmentId] = result; return result;
  });
}

function interval(success, total) {
  if (total === 0) return { rate: null, lower: null, upper: null };
  const p = success / total; const margin = 1.96 * Math.sqrt(p * (1 - p) / total);
  return { rate: p, lower: Math.max(0, p - margin), upper: Math.min(1, p + margin) };
}

export function experimentReport(store, input) {
  const tenantId = id(input.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["notification-analyst"], purpose: "notification-experiment" });
  const experimentId = id(input.experimentId, "experimentId"); const assignments = Object.values(store.read().records.experiments).filter((item) => item.tenantId === tenantId && item.experimentId === experimentId);
  const facts = store.read().records.analytics.filter((fact) => fact.tenantId === tenantId && fact.campaignId === input.campaignId);
  const groups = {};
  for (const assignment of assignments) {
    const group = groups[assignment.assignment] ?? { assigned: 0, goals: 0, unsubscribed: 0, complained: 0, observable: 0 };
    group.assigned += 1; const subjectFacts = facts.filter((fact) => fact.contactId === assignment.subjectId || fact.accountId === assignment.subjectId);
    group.goals += Number(subjectFacts.some((fact) => fact.event === "goal-completed")); group.unsubscribed += Number(subjectFacts.some((fact) => fact.event === "unsubscribed")); group.complained += Number(subjectFacts.some((fact) => fact.event === "complained")); group.observable += Number(subjectFacts.some((fact) => fact.observable)); groups[assignment.assignment] = group;
  }
  const holdout = groups.holdout ?? { assigned: 0, goals: 0, unsubscribed: 0, complained: 0, observable: 0 }; const holdoutRate = holdout.assigned === 0 ? null : holdout.goals / holdout.assigned;
  const results = Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, { ...group, conversion: interval(group.goals, group.assigned), correlationRate: group.assigned === 0 ? null : group.goals / group.assigned, incrementalLift: name === "holdout" || holdoutRate === null || group.assigned === 0 ? null : group.goals / group.assigned - holdoutRate }]));
  return { schemaVersion: "ltm.notification-experiment-report.v1", experimentId, results, contamination: integer(input.contaminationCount, "contaminationCount", 0, 100_000_000), channelUnobservableCount: facts.filter((fact) => !fact.observable).length, survivorBiasWarning: "Outcomes exclude deleted/unreachable subjects unless independently reconciled.", causalBoundary: "Correlation is reported separately from holdout-based incremental lift." };
}

export function enforceNotificationGuardrails(store, input) {
  const tenantId = id(input.tenantId, "tenantId"); const auth = authorization(input.authorization, { tenantId, roles: ["notification-safety-worker"], purpose: "notification-guardrail" });
  const thresholds = object(input.thresholds, "thresholds"); exact(thresholds, ["unsubscribeBasisPoints", "complaintBasisPoints", "nightSendCount", "minorMarketingCount", "securityIncidentCount"], "thresholds");
  const normalizedThresholds = { unsubscribeBasisPoints: integer(thresholds.unsubscribeBasisPoints, "unsubscribeBasisPoints", 0, 10_000), complaintBasisPoints: integer(thresholds.complaintBasisPoints, "complaintBasisPoints", 0, 10_000), nightSendCount: integer(thresholds.nightSendCount, "nightSendCount", 0, 100_000_000), minorMarketingCount: integer(thresholds.minorMarketingCount, "minorMarketingCount", 0, 100_000_000), securityIncidentCount: integer(thresholds.securityIncidentCount, "securityIncidentCount", 0, 1_000_000) };
  const facts = store.read().records.analytics.filter((fact) => fact.tenantId === tenantId && fact.templateId === input.templateId && (!input.journeyId || fact.journeyId === input.journeyId)); const sent = Math.max(facts.filter((fact) => fact.event === "sent").length, 1);
  const breaches = [];
  if (facts.filter((fact) => fact.event === "unsubscribed").length / sent * 10_000 > normalizedThresholds.unsubscribeBasisPoints) breaches.push("unsubscribe");
  if (facts.filter((fact) => fact.event === "complained").length / sent * 10_000 > normalizedThresholds.complaintBasisPoints) breaches.push("complaint");
  if (facts.filter((fact) => fact.event === "sent" && (fact.localHour >= 22 || fact.localHour < 8)).length > normalizedThresholds.nightSendCount) breaches.push("night-send");
  if (facts.filter((fact) => fact.event === "sent" && fact.isMinor && fact.purpose === "marketing").length > normalizedThresholds.minorMarketingCount) breaches.push("minor-marketing");
  if (integer(input.securityIncidentCount, "securityIncidentCount", 0, 1_000_000) > normalizedThresholds.securityIncidentCount) breaches.push("security-incident");
  if (breaches.length === 0) return { paused: false, breaches: [] };
  return store.transact({ authorization: input.authorization, tenantId, purpose: "notification-guardrail", action: "guardrail.pause", subject: input.templateId, idempotencyKey: input.idempotencyKey, at: input.at, input: { templateId: input.templateId, journeyId: input.journeyId, breaches } }, (records) => {
    const aggregate = records.templates[`${tenantId}:${id(input.templateId, "templateId")}`]; if (aggregate?.currentVersion !== null && aggregate?.currentVersion !== undefined) aggregate.versions[aggregate.currentVersion].state = "withdrawn";
    if (input.journeyId !== null) { const journey = records.journeys[`${tenantId}:${id(input.journeyId, "journeyId")}`]; if (journey?.currentVersion) journey.versions[journey.currentVersion].state = "paused"; }
    records.operations[`guardrail:${input.idempotencyKey}`] = { breaches, actorId: auth.actorId, at: input.at };
    return { paused: true, breaches, templateId: input.templateId, journeyId: input.journeyId };
  });
}
