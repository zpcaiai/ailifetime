import { authorization, bool, digest, exact, fail, id, integer, iso, list, object, oneOf, redactText, safeText, sha256, text } from "./contracts.mjs";

export const HELP_CATEGORIES = Object.freeze(["account", "photos", "generation", "family-authorization", "future-self", "payments", "refunds", "printing", "shipping", "privacy", "security", "partner-api"]);

function articleApproval(value, index) {
  const approval = object(value, `approvals[${index}]`); exact(approval, ["role", "actorId", "evidenceSha256", "approvedAt"], `approvals[${index}]`);
  return { role: oneOf(approval.role, ["content", "policy", "security", "finance", "legal"], "approval role"), actorId: id(approval.actorId, "actorId"), evidenceSha256: digest(approval.evidenceSha256, "evidenceSha256"), approvedAt: iso(approval.approvedAt, "approvedAt") };
}

export function validateHelpArticle(value) {
  const article = object(value, "help article");
  exact(article, ["articleId", "tenantId", "version", "category", "locale", "roles", "productVersions", "region", "title", "body", "keywords", "synonyms", "errorCodes", "statusChecks", "recoverySteps", "escalationRoute", "state", "approvals", "sourceDependencies", "publishedAt", "reviewAt", "expiresAt"], "help article");
  const category = oneOf(article.category, HELP_CATEGORIES, "category"); const state = oneOf(article.state, ["draft", "review", "published", "withdrawn", "stale", "expired"], "state");
  const approvals = list(article.approvals, "approvals", { maximum: 10, item: articleApproval });
  const requiredRoles = ["privacy", "security"].includes(category) ? ["content", "policy", "security"] : ["payments", "refunds"].includes(category) ? ["content", "policy", "finance"] : ["content"];
  if (state === "published" && requiredRoles.some((role) => !approvals.some((item) => item.role === role))) fail("ARTICLE_APPROVAL_REQUIRED", "published article lacks independent approval");
  const publishedAt = article.publishedAt === null ? null : iso(article.publishedAt, "publishedAt"); const reviewAt = iso(article.reviewAt, "reviewAt"); const expiresAt = iso(article.expiresAt, "expiresAt");
  if (new Date(expiresAt) <= new Date(reviewAt)) fail("ARTICLE_REVIEW_WINDOW_INVALID", "article expiry must follow review date");
  return { schemaVersion: "ltm.help-article.v1", articleId: id(article.articleId, "articleId"), tenantId: id(article.tenantId, "tenantId"), version: id(article.version, "version"), category, locale: text(article.locale, "locale", 16), roles: list(article.roles, "roles", { minimum: 1, maximum: 20, item: id }), productVersions: list(article.productVersions, "productVersions", { minimum: 1, maximum: 100, item: id }), region: id(article.region, "region"), title: safeText(article.title, "title", 300), body: safeText(article.body, "body", 30_000), keywords: list(article.keywords, "keywords", { minimum: 1, maximum: 100, item: (item, label) => text(item, label, 80).toLowerCase() }), synonyms: list(article.synonyms, "synonyms", { maximum: 100, item: (item, label) => text(item, label, 80).toLowerCase() }), errorCodes: list(article.errorCodes, "errorCodes", { maximum: 100, item: id }), statusChecks: list(article.statusChecks, "statusChecks", { maximum: 30, item: (item, label) => safeText(item, label, 500) }), recoverySteps: list(article.recoverySteps, "recoverySteps", { minimum: 1, maximum: 30, item: (item, label) => safeText(item, label, 1000) }), escalationRoute: id(article.escalationRoute, "escalationRoute"), state, approvals, sourceDependencies: list(article.sourceDependencies, "sourceDependencies", { maximum: 100, item: (item, index) => { exact(item, ["sourceId", "versionSha256"], `sourceDependencies[${index}]`); return { sourceId: id(item.sourceId, "sourceId"), versionSha256: digest(item.versionSha256, "versionSha256") }; } }), publishedAt, reviewAt, expiresAt };
}

export function publishHelpArticle(store, input, now = new Date()) {
  const article = validateHelpArticle(input.article); const auth = authorization(input.authorization, { tenantId: article.tenantId, roles: ["knowledge-publisher"], purpose: "knowledge-management", stepUp: true });
  if (article.state !== "published" || article.publishedAt === null || new Date(article.expiresAt) <= now) fail("ARTICLE_NOT_PUBLISHABLE", "article must be current and published");
  return store.transact({ authorization: input.authorization, tenantId: article.tenantId, purpose: "knowledge-management", action: "article.publish", subject: `${article.articleId}:${article.version}`, idempotencyKey: input.idempotencyKey, at: input.at, input: article }, (records) => {
    const key = `${article.tenantId}:${article.articleId}`; const aggregate = records.articles[key] ?? { versions: {}, currentVersion: null, history: [] };
    if (aggregate.versions[article.version] !== undefined) fail("ARTICLE_VERSION_IMMUTABLE", "article version already exists");
    aggregate.versions[article.version] = article; aggregate.currentVersion = article.version; aggregate.history.push({ operation: "published", version: article.version, actorId: auth.actorId, at: input.at }); records.articles[key] = aggregate;
    return { articleId: article.articleId, version: article.version, state: "published" };
  });
}

function levenshtein(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) { let previous = row[0]; row[0] = i; for (let j = 1; j <= right.length; j += 1) { const old = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + Number(left[i - 1] !== right[j - 1])); previous = old; } }
  return row[right.length];
}

export function searchHelp(store, input, now = new Date()) {
  const tenantId = id(input.tenantId, "tenantId"); const role = id(input.role, "role"); const query = text(input.query, "query", 200).toLowerCase();
  authorization(input.authorization, { tenantId, roles: ["help-reader", "support-agent", "partner-user"], purpose: "help-search" });
  const terms = query.split(/\s+/u).filter(Boolean);
  const articles = Object.values(store.read().records.articles).map((aggregate) => aggregate.versions[aggregate.currentVersion]).filter((article) => article?.state === "published" && new Date(article.expiresAt) > now && article.tenantId === tenantId && article.locale === input.locale && article.region === input.region && article.roles.includes(role) && article.productVersions.includes(input.productVersion));
  const scored = articles.map((article) => {
    const corpus = [...article.keywords, ...article.synonyms, ...article.title.toLowerCase().split(/\s+/u)];
    const score = terms.reduce((sum, term) => sum + Math.max(0, ...corpus.map((word) => word.includes(term) ? 3 : levenshtein(term, word) <= 1 ? 1 : 0)), 0);
    return { article, score };
  }).filter((item) => item.score > 0).sort((left, right) => right.score - left.score || left.article.articleId.localeCompare(right.article.articleId));
  return { schemaVersion: "ltm.help-search.v1", querySha256: sha256(query), results: scored.slice(0, integer(input.limit, "limit", 1, 20)).map(({ article, score }) => ({ articleId: article.articleId, version: article.version, category: article.category, title: article.title, score })), noResult: scored.length === 0, isolation: { tenantId, role, locale: input.locale, region: input.region, productVersion: input.productVersion } };
}

export function contextualHelp(store, input, now = new Date()) {
  const tenantId = id(input.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["help-reader", "support-agent"], purpose: "help-search" });
  const article = Object.values(store.read().records.articles).map((aggregate) => aggregate.versions[aggregate.currentVersion]).find((candidate) => candidate?.tenantId === tenantId && candidate.state === "published" && candidate.errorCodes.includes(input.errorCode) && candidate.region === input.region && candidate.productVersions.includes(input.productVersion) && new Date(candidate.expiresAt) > now);
  if (article === undefined) return { found: false, escalationRoute: "support-general", errorCode: id(input.errorCode, "errorCode") };
  return { found: true, articleId: article.articleId, version: article.version, statusChecks: article.statusChecks, recoverySteps: article.recoverySteps, escalationRoute: article.escalationRoute, errorCode: input.errorCode };
}

export function markArticlesForProductChange(store, input) {
  const tenantId = id(input.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["knowledge-worker"], purpose: "knowledge-management" });
  const changes = list(input.dependencies, "dependencies", { minimum: 1, maximum: 100, item: (item, index) => { exact(item, ["sourceId", "versionSha256"], `dependencies[${index}]`); return { sourceId: id(item.sourceId, "sourceId"), versionSha256: digest(item.versionSha256, "versionSha256") }; } });
  return store.transact({ authorization: input.authorization, tenantId, purpose: "knowledge-management", action: "article.reconcile", subject: tenantId, idempotencyKey: input.idempotencyKey, at: input.at, input: changes }, (records) => {
    const stale = [];
    for (const aggregate of Object.values(records.articles)) { const article = aggregate.versions[aggregate.currentVersion]; if (article?.tenantId !== tenantId) continue; const drift = article.sourceDependencies.filter((binding) => changes.some((change) => change.sourceId === binding.sourceId && change.versionSha256 !== binding.versionSha256)); if (drift.length > 0) { article.state = "stale"; stale.push({ articleId: article.articleId, version: article.version, sourceIds: drift.map((item) => item.sourceId) }); } }
    return { stale, cacheInvalidationRequired: stale.length > 0 };
  });
}

export function recordHelpFeedback(store, input) {
  const feedback = object(input.feedback, "help feedback"); exact(feedback, ["feedbackId", "tenantId", "articleId", "articleVersion", "helpful", "noResultQuerySha256", "handoffReason", "containsRawMedia", "containsPrivateConversation", "comment", "occurredAt"], "help feedback");
  const tenantId = id(feedback.tenantId, "tenantId"); authorization(input.authorization, { tenantId, roles: ["help-feedback-writer"], purpose: "help-feedback" });
  if (bool(feedback.containsRawMedia, "containsRawMedia") || bool(feedback.containsPrivateConversation, "containsPrivateConversation")) fail("SENSITIVE_FEEDBACK_FORBIDDEN", "feedback analytics cannot contain raw media or private conversations");
  const normalized = { feedbackId: id(feedback.feedbackId, "feedbackId"), tenantId, articleId: feedback.articleId === null ? null : id(feedback.articleId, "articleId"), articleVersion: feedback.articleVersion === null ? null : id(feedback.articleVersion, "articleVersion"), helpful: feedback.helpful === null ? null : bool(feedback.helpful, "helpful"), noResultQuerySha256: feedback.noResultQuerySha256 === null ? null : digest(feedback.noResultQuerySha256, "noResultQuerySha256"), handoffReason: feedback.handoffReason === null ? null : id(feedback.handoffReason, "handoffReason"), comment: feedback.comment === null ? null : redactText(feedback.comment), occurredAt: iso(feedback.occurredAt, "occurredAt") };
  return store.transact({ authorization: input.authorization, tenantId, purpose: "help-feedback", action: "help.feedback", subject: normalized.feedbackId, idempotencyKey: normalized.feedbackId, at: normalized.occurredAt, input: normalized }, (records) => { records.searchFeedback.push(normalized); return { feedbackId: normalized.feedbackId, recorded: true }; });
}
