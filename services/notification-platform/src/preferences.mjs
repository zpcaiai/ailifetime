import { authorization, bool, digest, exact, fail, id, integer, isQuietAt, iso, list, object, oneOf, sha256, signToken, text, verifyToken } from "./contracts.mjs";

export const NOTIFICATION_CHANNELS = Object.freeze(["email", "sms", "push", "wechat", "inapp"]);
export const NOTIFICATION_PURPOSES = Object.freeze(["transactional", "generation", "family", "security", "marketing", "annual-ritual", "partner-service"]);

function mapOfBooleans(value, keys, label) {
  exact(value, keys, label);
  return Object.fromEntries(keys.map((key) => [key, bool(value[key], `${label}.${key}`)]));
}

export function validatePreferenceRecord(value) {
  const record = object(value, "preference record");
  exact(record, ["tenantId", "accountId", "contactId", "policyVersion", "region", "isMinor", "globalUnsubscribed", "purposeEnabled", "channelEnabled", "quietHours", "frequencyCaps", "updatedAt"], "preference record");
  const quiet = object(record.quietHours, "quietHours");
  exact(quiet, ["timeZone", "startMinute", "endMinute"], "quietHours");
  const caps = object(record.frequencyCaps, "frequencyCaps");
  exact(caps, ["hour", "day", "week"], "frequencyCaps");
  const normalized = {
    schemaVersion: "ltm.notification-preferences.v1",
    tenantId: id(record.tenantId, "tenantId"), accountId: id(record.accountId, "accountId"), contactId: id(record.contactId, "contactId"),
    policyVersion: id(record.policyVersion, "policyVersion"), region: id(record.region, "region"), isMinor: bool(record.isMinor, "isMinor"), globalUnsubscribed: bool(record.globalUnsubscribed, "globalUnsubscribed"),
    purposeEnabled: mapOfBooleans(record.purposeEnabled, NOTIFICATION_PURPOSES, "purposeEnabled"),
    channelEnabled: mapOfBooleans(record.channelEnabled, NOTIFICATION_CHANNELS, "channelEnabled"),
    quietHours: { timeZone: text(quiet.timeZone, "quietHours.timeZone", 64), startMinute: integer(quiet.startMinute, "startMinute", 0, 1439), endMinute: integer(quiet.endMinute, "endMinute", 0, 1439) },
    frequencyCaps: { hour: integer(caps.hour, "hour cap", 0, 100), day: integer(caps.day, "day cap", 0, 500), week: integer(caps.week, "week cap", 0, 2000) },
    updatedAt: iso(record.updatedAt, "updatedAt"),
  };
  if (normalized.isMinor && normalized.purposeEnabled.marketing) fail("MINOR_MARKETING_FORBIDDEN", "minor marketing must remain disabled");
  return normalized;
}

export function savePreferences(store, input) {
  const record = validatePreferenceRecord(input.preferences);
  authorization(input.authorization, { tenantId: record.tenantId, roles: ["account-owner", "privacy-operator"], purpose: "notification-preferences" });
  return store.transact({ authorization: input.authorization, tenantId: record.tenantId, purpose: "notification-preferences", action: "preferences.save", subject: `${record.accountId}:${record.contactId}`, idempotencyKey: input.idempotencyKey, at: input.at, input: record }, (records) => {
    const key = `${record.tenantId}:${record.accountId}:${record.contactId}`;
    const prior = records.preferences[key];
    if (prior !== undefined && prior.policyVersion === record.policyVersion && new Date(record.updatedAt) <= new Date(prior.updatedAt)) fail("PREFERENCE_VERSION_STALE", "preference update is not newer");
    records.preferences[key] = record;
    records.contacts[record.contactId] ??= { contactId: record.contactId, tenantId: record.tenantId, accountId: record.accountId, state: "verified", endpointReference: null, endpointSha256: null, updatedAt: record.updatedAt };
    return { key, policyVersion: record.policyVersion, globalUnsubscribed: record.globalUnsubscribed };
  });
}

function recentCount(records, scope, after) {
  return Object.values(records.messages).filter((message) => message.contactId === scope.contactId && message.tenantId === scope.tenantId && new Date(message.createdAt) > after && !["cancelled", "expired"].includes(message.state)).length;
}

export function evaluateContactEligibility(store, input, now = new Date()) {
  const tenantId = id(input.tenantId, "tenantId"); const accountId = id(input.accountId, "accountId"); const contactId = id(input.contactId, "contactId");
  const purpose = oneOf(input.purpose, NOTIFICATION_PURPOSES, "purpose"); const channel = oneOf(input.channel, NOTIFICATION_CHANNELS, "channel");
  const state = store.read().records;
  const preference = state.preferences[`${tenantId}:${accountId}:${contactId}`];
  const contact = state.contacts[contactId];
  if (preference === undefined || contact === undefined || preference.tenantId !== tenantId || contact.tenantId !== tenantId || contact.accountId !== accountId || contact.state !== "verified") return { eligible: false, code: "CONTACT_POLICY_UNKNOWN" };
  const suppressed = Object.values(state.suppressions).some((item) => item.tenantId === tenantId && item.contactId === contactId && item.state === "active" && item.channel === channel && (item.purpose === purpose || item.purpose === "marketing" && purpose === "marketing"));
  if (suppressed) return { eligible: false, code: "DELIVERABILITY_SUPPRESSED" };
  if (input.policyVersion !== preference.policyVersion) return { eligible: false, code: "POLICY_VERSION_STALE" };
  const emergency = purpose === "security" && input.priority === "emergency";
  if (preference.isMinor && purpose === "marketing") return { eligible: false, code: "MINOR_MARKETING_FORBIDDEN" };
  if (!emergency && preference.globalUnsubscribed) return { eligible: false, code: "GLOBAL_UNSUBSCRIBED" };
  if (!preference.purposeEnabled[purpose]) return { eligible: false, code: "PURPOSE_UNSUBSCRIBED" };
  if (!preference.channelEnabled[channel]) return { eligible: false, code: "CHANNEL_UNSUBSCRIBED" };
  if (!emergency && isQuietAt(now, preference.quietHours)) return { eligible: false, code: "QUIET_HOURS" };
  if (!emergency) {
    const scope = { tenantId, contactId };
    const counts = { hour: recentCount(state, scope, new Date(now.getTime() - 3_600_000)), day: recentCount(state, scope, new Date(now.getTime() - 86_400_000)), week: recentCount(state, scope, new Date(now.getTime() - 604_800_000)) };
    for (const window of ["hour", "day", "week"]) if (counts[window] >= preference.frequencyCaps[window]) return { eligible: false, code: `FREQUENCY_${window.toUpperCase()}_CAP` };
  }
  return { eligible: true, code: emergency ? "EMERGENCY_SECURITY_EXCEPTION" : "ELIGIBLE", preferenceRevision: store.read().revision };
}

export function applyContactLifecycleEvent(store, input) {
  const event = object(input.event, "contact lifecycle event");
  exact(event, ["eventId", "tenantId", "accountId", "contactId", "type", "replacementContactId", "endpointReference", "endpointSha256", "occurredAt"], "contact lifecycle event");
  const tenantId = id(event.tenantId, "tenantId"); const accountId = id(event.accountId, "accountId"); const contactId = id(event.contactId, "contactId");
  const type = oneOf(event.type, ["endpoint-changed", "account-merged", "family-invite-revoked", "data-deleted"], "type");
  authorization(input.authorization, { tenantId, roles: ["identity-service", "privacy-operator"], purpose: "contact-lifecycle" });
  return store.transact({ authorization: input.authorization, tenantId, purpose: "contact-lifecycle", action: "contact.lifecycle", subject: contactId, idempotencyKey: event.eventId, at: event.occurredAt, input: event }, (records) => {
    const current = records.contacts[contactId];
    if (current === undefined || current.tenantId !== tenantId || current.accountId !== accountId) fail("CONTACT_NOT_FOUND", "contact is unavailable");
    if (type === "endpoint-changed") {
      current.state = "isolated-replaced";
      const replacementContactId = id(event.replacementContactId, "replacementContactId");
      if (records.contacts[replacementContactId] !== undefined) fail("REPLACEMENT_CONTACT_CONFLICT", "replacement contact identifier already exists");
      records.contacts[replacementContactId] = { contactId: replacementContactId, tenantId, accountId, state: "pending-verification", endpointReference: text(event.endpointReference, "endpointReference", 512), endpointSha256: digest(event.endpointSha256, "endpointSha256"), updatedAt: iso(event.occurredAt, "occurredAt") };
      return { priorState: current.state, replacementContactId, replacementState: "pending-verification" };
    }
    if (type === "account-merged") {
      const target = id(event.replacementContactId, "replacementContactId");
      const targetContact = records.contacts[target];
      if (targetContact === undefined || targetContact.tenantId !== tenantId) fail("MERGE_TARGET_INVALID", "merge target is unavailable");
      current.state = "merged";
      for (const preference of Object.values(records.preferences).filter((item) => item.contactId === contactId)) {
        const targetKey = `${tenantId}:${targetContact.accountId}:${target}`;
        const targetPreference = records.preferences[targetKey];
        if (targetPreference !== undefined) {
          targetPreference.globalUnsubscribed ||= preference.globalUnsubscribed;
          for (const purpose of NOTIFICATION_PURPOSES) targetPreference.purposeEnabled[purpose] &&= preference.purposeEnabled[purpose];
          for (const channel of NOTIFICATION_CHANNELS) targetPreference.channelEnabled[channel] &&= preference.channelEnabled[channel];
        }
      }
      return { state: "merged", target };
    }
    current.state = type === "family-invite-revoked" ? "invite-revoked" : "deleted";
    current.endpointReference = null; current.endpointSha256 = null;
    return { state: current.state, contactId };
  });
}

export function issueAnonymousUnsubscribeToken({ tenantId, accountId, contactId, scope, purpose, channel, expiresInSeconds }, secret, now = new Date()) {
  const iat = Math.floor(now.getTime() / 1000);
  const normalizedScope = oneOf(scope, ["global", "purpose", "channel"], "scope"); const normalizedPurpose = purpose === null || purpose === undefined ? null : oneOf(purpose, NOTIFICATION_PURPOSES, "purpose"); const normalizedChannel = channel === null || channel === undefined ? null : oneOf(channel, NOTIFICATION_CHANNELS, "channel");
  if (normalizedScope === "purpose" ? normalizedPurpose === null || normalizedChannel !== null : normalizedScope === "channel" ? normalizedChannel === null || normalizedPurpose !== null : normalizedPurpose !== null || normalizedChannel !== null) fail("UNSUBSCRIBE_SCOPE_INVALID", "unsubscribe scope must bind exactly its purpose or channel");
  return signToken({ schemaVersion: "ltm.unsubscribe.v1", audience: "anonymous-unsubscribe", tenantId: id(tenantId, "tenantId"), accountId: id(accountId, "accountId"), contactId: id(contactId, "contactId"), scope: normalizedScope, purpose: normalizedPurpose, channel: normalizedChannel, iat, exp: iat + integer(expiresInSeconds, "expiresInSeconds", 60, 2_592_000) }, secret);
}

export function consumeAnonymousUnsubscribe(store, input, secret, now = new Date()) {
  const claims = verifyToken(input.token, secret, { schemaVersion: "ltm.unsubscribe.v1", audience: "anonymous-unsubscribe" }, now);
  const generic = { accepted: true, message: "If the contact is enrolled, the preference update has been applied." };
  return store.transact({ authorization: input.authorization, tenantId: claims.tenantId, purpose: "anonymous-unsubscribe", action: "preferences.unsubscribe", subject: sha256(`${claims.tenantId}:${claims.contactId}`), idempotencyKey: input.idempotencyKey, at: input.at, input: { tokenSha256: sha256(input.token) } }, (records) => {
    const preference = records.preferences[`${claims.tenantId}:${claims.accountId}:${claims.contactId}`];
    if (preference !== undefined) {
      if (claims.scope === "global") preference.globalUnsubscribed = true;
      if (claims.scope === "purpose" && claims.purpose !== null) preference.purposeEnabled[claims.purpose] = false;
      if (claims.scope === "channel" && claims.channel !== null) preference.channelEnabled[claims.channel] = false;
      preference.updatedAt = iso(input.at, "at");
    }
    return generic;
  });
}

export function exportAuthenticatedPreferences(store, input) {
  const tenantId = id(input.tenantId, "tenantId"); const accountId = id(input.accountId, "accountId");
  authorization(input.authorization, { tenantId, roles: ["account-owner", "privacy-operator"], purpose: "notification-preferences" });
  const state = store.read();
  return {
    schemaVersion: "ltm.notification-preference-export.v1", tenantId, accountId, revision: state.revision,
    preferences: Object.values(state.records.preferences).filter((item) => item.tenantId === tenantId && item.accountId === accountId),
    audit: state.audit.filter((item) => item.tenantId === tenantId && item.subject.includes(accountId)).map(({ requestSha256, resultSha256, ...safe }) => ({ ...safe, requestSha256, resultSha256 })),
  };
}
