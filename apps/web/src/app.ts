import { BrowserOidcClient, EphemeralBrowserAuthentication, type BrowserOidcConfiguration } from "./auth.js";
import {
  StableCapabilityIdempotency,
  parseCapabilityInput,
  readBoundedJsonResponse,
  validateCapabilityExecutionResponse,
} from "./capability-execution.js";
import { localized, normalizeLocale, portalById, translate, type CopyKey, type PortalId, type SupportedLocale } from "./surface.js";

interface Capability {
  batchId: string;
  skill: string;
  operation: string;
  permission: string;
  portalId: PortalId;
  mode: string;
  requirements: readonly string[];
  requiresExternalEvidence?: boolean;
}

interface AuthenticatedSession {
  actorId: string;
  tenantId: string;
  roles: readonly string[];
  purpose: string;
  stepUp: boolean;
  guardianVerified: boolean;
  authenticationState: "server_verified";
}

interface VisiblePortal {
  id: PortalId;
  skills: readonly string[];
  capabilityCount: number;
}

const connection = element<HTMLDivElement>("connection");
const healthOutput = element<HTMLPreElement>("health-output");
const sessionOutput = element<HTMLPreElement>("session-output");
const list = element<HTMLDivElement>("capability-list");
const summary = element<HTMLDivElement>("capability-summary");
const registeredCount = element<HTMLElement>("registered-count");
const search = element<HTMLInputElement>("capability-search");
const journeyForm = element<HTMLFormElement>("journey-form");
const journeyResult = element<HTMLDivElement>("journey-result");
const rightsForm = element<HTMLFormElement>("rights-form");
const rightsOutput = element<HTMLDivElement>("rights-output");
const rightsRefresh = element<HTMLButtonElement>("rights-refresh");
const toast = element<HTMLDivElement>("toast");
const localeSelect = element<HTMLSelectElement>("locale");
const workspaceNav = element<HTMLElement>("workspace-nav");
const workspaceContent = element<HTMLDivElement>("workspace-content");
const loginButton = element<HTMLButtonElement>("login-button");
const logoutButton = element<HTMLButtonElement>("logout-button");
const authenticationOutput = element<HTMLSpanElement>("authentication-output");
const capabilityDialog = element<HTMLDialogElement>("capability-dialog");
const capabilityDialogContent = element<HTMLDivElement>("capability-dialog-content");
const tabs = [...document.querySelectorAll<HTMLButtonElement>(".tab")];
const initialUrl = new URL(window.location.href);
if (initialUrl.pathname === "/auth/callback" && initialUrl.search !== "") {
  window.history.replaceState(null, "", `${initialUrl.origin}${initialUrl.pathname}`);
}
const authentication = new EphemeralBrowserAuthentication();
const oidc = new BrowserOidcClient();
const capabilityIdempotency = new StableCapabilityIdempotency();

let capabilities: Capability[] = [];
let visiblePortals: VisiblePortal[] = [];
let session: AuthenticatedSession | undefined;
let locale: SupportedLocale = normalizeLocale(initialUrl.searchParams.get("lang") ?? navigator.language);
let activePortalId = initialUrl.searchParams.get("portal") ?? "consumer";
let authenticationRevision = 0;
let browserOidcConfiguration: BrowserOidcConfiguration | undefined;

document.documentElement.lang = locale;
localeSelect.value = locale;
applyTranslations();
updateAuthenticationControls();

loginButton.addEventListener("click", () => void beginLogin());
logoutButton.addEventListener("click", () => signOut());

for (const tab of tabs) {
  tab.addEventListener("click", () => activatePanel(tab, false));
  tab.addEventListener("keydown", (event) => moveTabFocus(event, tab));
}

search.addEventListener("input", () => renderCapabilities(search.value));
journeyForm.addEventListener("submit", (event) => void runJourney(event));
rightsForm.addEventListener("submit", (event) => void submitRightsRequest(event));
rightsRefresh.addEventListener("click", () => void listRightsRequests());
localeSelect.addEventListener("change", () => {
  locale = normalizeLocale(localeSelect.value);
  document.documentElement.lang = locale;
  const url = new URL(window.location.href);
  url.searchParams.set("lang", locale);
  window.history.replaceState(null, "", url);
  applyTranslations();
  renderWorkspaces();
  renderCapabilities(search.value);
});
workspaceNav.addEventListener("click", (event) => {
  const button = closestWithData(event.target, "portal");
  if (button?.dataset.portal === undefined) return;
  activePortalId = button.dataset.portal;
  const url = new URL(window.location.href);
  url.searchParams.set("portal", activePortalId);
  window.history.replaceState(null, "", url);
  renderWorkspaces();
});
for (const container of [list, workspaceContent]) {
  container.addEventListener("click", (event) => {
    const target = closestWithData(event.target, "batch");
    if (target?.dataset.batch === undefined) return;
    event.preventDefault();
    openCapability(target.dataset.batch);
  });
}
capabilityDialog.addEventListener("close", () => {
  capabilityIdempotency.reset();
  capabilityDialogContent.replaceChildren();
  const url = new URL(window.location.href);
  url.searchParams.delete("capability");
  window.history.replaceState(null, "", url);
});

void initialize();

async function initialize(): Promise<void> {
  try {
    browserOidcConfiguration = oidc.parseConfiguration(
      await api<unknown>("/v1/auth/browser/config", undefined, false),
    );
    if (oidc.isCallback(browserOidcConfiguration, initialUrl.toString())) {
      authenticationOutput.textContent = translate(locale, "signingIn");
      const accessToken = await oidc.completeAuthorization(browserOidcConfiguration, initialUrl.toString());
      if (accessToken === undefined) throw new Error("OIDC callback did not return an access token");
      authentication.setBearerToken(accessToken, "product_operation");
      const health = await api<Record<string, unknown>>("/health/ready", undefined, false);
      healthOutput.textContent = JSON.stringify(health, null, 2);
      const verified = await authenticateWorkspace();
      if (!verified) {
        authentication.clear();
        throw new Error("The API rejected the OIDC access token");
      }
      authenticationOutput.textContent = translate(locale, "authenticated");
      updateAuthenticationControls();
      return;
    }
    const health = await api<Record<string, unknown>>("/health/ready", undefined, false);
    healthOutput.textContent = JSON.stringify(health, null, 2);
    await authenticateWorkspace();
    updateAuthenticationControls();
  } catch (error) {
    authentication.clear();
    setConnection("auth-required", "authRequired");
    const message = error instanceof Error ? error.message : String(error);
    authenticationOutput.textContent = `${translate(locale, "authenticationFailed")}: ${message}`;
    clearAuthorizedWorkspace();
    updateAuthenticationControls();
    showToast(translate(locale, "authenticationFailed"));
  }
}

async function authenticateWorkspace(): Promise<boolean> {
  const revision = ++authenticationRevision;
  try {
    const [sessionEnvelope, catalog] = await Promise.all([
      api<{ session: AuthenticatedSession }>("/v1/session"),
      api<{ schemaVersion: string; capabilities: Capability[]; portals: VisiblePortal[]; count: number }>("/v1/capabilities/visible"),
    ]);
    if (revision !== authenticationRevision) return false;
    validateAuthorizedProjection(
      sessionEnvelope.session,
      catalog.schemaVersion,
      catalog.capabilities,
      catalog.portals,
      catalog.count,
    );
    session = sessionEnvelope.session;
    capabilities = catalog.capabilities;
    visiblePortals = catalog.portals;
    activePortalId = visiblePortals.some((portal) => portal.id === activePortalId)
      ? activePortalId
      : visiblePortals[0]?.id ?? "consumer";
    element<HTMLInputElement>("tenantId").value = session.tenantId;
    element<HTMLInputElement>("actorId").value = session.actorId;
    registeredCount.textContent = String(capabilities.length);
    sessionOutput.textContent = JSON.stringify({
      actorId: session.actorId,
      tenantId: session.tenantId,
      roles: session.roles,
      purpose: session.purpose,
      authenticationState: session.authenticationState,
      visibleCapabilities: capabilities.length,
      visiblePortals: visiblePortals.map((portal) => portal.id),
    }, null, 2);
    setConnection("online", "authenticated");
    renderCapabilities(search.value);
    renderWorkspaces();
    applyInitialDeepLink();
    updateAuthenticationControls();
    return true;
  } catch (error) {
    if (revision !== authenticationRevision) return false;
    clearAuthorizedWorkspace();
    setConnection("auth-required", "authRequired");
    sessionOutput.textContent = error instanceof Error ? error.message : String(error);
    showToast(translate(locale, "authRequiredDescription"));
    updateAuthenticationControls();
    return false;
  }
}

async function beginLogin(): Promise<void> {
  if (browserOidcConfiguration === undefined) {
    authenticationOutput.textContent = translate(locale, "authenticationFailed");
    return;
  }
  loginButton.disabled = true;
  authenticationOutput.textContent = translate(locale, "signingIn");
  try {
    const authorizationUrl = await oidc.beginAuthorization(browserOidcConfiguration, window.location.href);
    window.location.assign(authorizationUrl);
  } catch (error) {
    loginButton.disabled = false;
    authenticationOutput.textContent = `${translate(locale, "authenticationFailed")}: ${error instanceof Error ? error.message : String(error)}`;
    showToast(translate(locale, "authenticationFailed"));
  }
}

function signOut(): void {
  authentication.clear();
  oidc.clearTransaction();
  authenticationRevision += 1;
  clearAuthorizedWorkspace();
  setConnection("auth-required", "authRequired");
  authenticationOutput.textContent = translate(locale, "signedOut");
  updateAuthenticationControls();
}

function updateAuthenticationControls(): void {
  const authenticated = authentication.snapshot().hasInjectedBearer && session !== undefined;
  loginButton.hidden = authenticated;
  loginButton.disabled = browserOidcConfiguration === undefined;
  logoutButton.hidden = !authenticated;
}

function clearAuthorizedWorkspace(): void {
  session = undefined;
  capabilities = [];
  visiblePortals = [];
  element<HTMLInputElement>("tenantId").value = "";
  element<HTMLInputElement>("actorId").value = "";
  registeredCount.textContent = "0";
  renderCapabilities(search.value);
  renderWorkspaces();
  rightsOutput.innerHTML = "<strong>需要登录</strong><p>服务器验证会话建立后才能提交或查询隐私权请求。</p>";
}

async function submitRightsRequest(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (session === undefined) {
    showToast("需要服务器验证会话");
    return;
  }
  try {
    const participantId = boundedIdentifier(element<HTMLInputElement>("rights-participant").value, "参与者标识");
    const requestType = element<HTMLSelectElement>("rights-type").value;
    if (!RIGHTS_REQUEST_TYPES.has(requestType)) throw new Error("权利类型无效");
    const requestedProcessingPurpose = element<HTMLInputElement>("rights-purpose").value.trim();
    if (requestedProcessingPurpose !== "all" && !/^[a-z][a-z0-9_:-]{0,119}$/.test(requestedProcessingPurpose)) {
      throw new Error("处理用途必须为 all 或精确规范用途");
    }
    const requestId = `rights-${crypto.randomUUID()}`;
    const input: Record<string, unknown> = {
      requestId,
      participantId,
      requestType,
      requestedProcessingPurpose,
    };
    if (requestType === "correction") {
      const correctionFields = [...new Set(element<HTMLInputElement>("rights-correction-fields").value
        .split(",").map((value) => value.trim()).filter((value) => value !== ""))];
      const correctionPayloadSha256 = element<HTMLInputElement>("rights-correction-digest").value.trim().toLowerCase();
      if (correctionFields.length === 0 || correctionFields.some((field) => !/^[a-z][a-z0-9_.-]{0,79}$/.test(field)) ||
          !/^[a-f0-9]{64}$/.test(correctionPayloadSha256)) {
        throw new Error("更正请求需要规范字段名和安全载荷 SHA-256");
      }
      input.correctionFields = correctionFields;
      input.correctionPayloadSha256 = correctionPayloadSha256;
    }
    if (requestType === "appeal") {
      input.parentRequestId = boundedIdentifier(element<HTMLInputElement>("rights-parent").value, "原请求标识");
    }
    const envelope = await api<{ data: unknown }>("/v1/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": requestId,
        "X-Purpose": "privacy_rights",
      },
      body: JSON.stringify({ command: "rights-request.submit", input }),
    });
    const mutation = objectValue(envelope.data, "权利请求响应");
    renderRightsProjection(minimizedRightsProjection("value" in mutation ? mutation.value : mutation));
  } catch (error) {
    rightsOutput.innerHTML = `<strong>请求未提交</strong><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  }
}

async function listRightsRequests(): Promise<void> {
  try {
    const envelope = await api<{ data: unknown }>("/v1/queries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Purpose": "privacy_rights" },
      body: JSON.stringify({ query: "rights-request.list", input: { limit: 100 } }),
    });
    if (!Array.isArray(envelope.data)) throw new Error("权利请求列表响应无效");
    const projections = envelope.data.map((value) => minimizedRightsProjection(value));
    rightsOutput.innerHTML = projections.length === 0
      ? "<strong>暂无请求</strong><p>没有当前账户可见的隐私权请求。</p>"
      : `<pre class="result-json">${escapeHtml(JSON.stringify(projections, null, 2))}</pre>`;
  } catch (error) {
    rightsOutput.innerHTML = `<strong>查询失败</strong><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  }
}

const RIGHTS_REQUEST_TYPES = new Set([
  "access", "correction", "export", "withdraw", "delete", "restrict_processing", "appeal",
]);

function minimizedRightsProjection(value: unknown): Record<string, unknown> {
  const projection = objectValue(value, "权利请求投影");
  const requestId = boundedIdentifier(projection.requestId, "请求标识");
  const requestType = typeof projection.requestType === "string" && RIGHTS_REQUEST_TYPES.has(projection.requestType)
    ? projection.requestType : invalidRightsProjection();
  const status = typeof projection.status === "string" ? projection.status : invalidRightsProjection();
  const subjectReference = typeof projection.subjectReference === "string" && /^subject_[a-f0-9]{16}$/.test(projection.subjectReference)
    ? projection.subjectReference : invalidRightsProjection();
  const progress = objectValue(projection.progress, "传播进度");
  const review = objectValue(projection.review, "复核进度");
  const tasks = Array.isArray(projection.tasks) ? projection.tasks.map((raw) => {
    const task = objectValue(raw, "传播任务");
    return {
      taskId: boundedIdentifier(task.taskId, "任务标识"),
      target: typeof task.target === "string" ? task.target : invalidRightsProjection(),
      assetReference: task.assetReference === null ||
        (typeof task.assetReference === "string" && /^asset_[a-f0-9]{16}$/.test(task.assetReference))
        ? task.assetReference : invalidRightsProjection(),
      state: typeof task.state === "string" ? task.state : invalidRightsProjection(),
      attempts: typeof task.attempts === "number" && Number.isSafeInteger(task.attempts) ? task.attempts : invalidRightsProjection(),
    };
  }) : invalidRightsProjection();
  return {
    requestId,
    requestType,
    subjectReference,
    requestedProcessingPurpose: projection.requestedProcessingPurpose,
    status,
    submittedAt: projection.submittedAt,
    dueAt: projection.dueAt,
    overdue: projection.overdue,
    completedAt: projection.completedAt,
    parentRequestId: projection.parentRequestId,
    progress: {
      total: progress.total,
      succeeded: progress.succeeded,
      pending: progress.pending,
      blocked: progress.blocked,
      failed: progress.failed,
    },
    tasks,
    review: {
      approvals: review.approvals,
      denials: review.denials,
      requiredDistinctReviewers: review.requiredDistinctReviewers,
    },
    explanationCode: projection.explanationCode,
  };
}

function renderRightsProjection(projection: Record<string, unknown>): void {
  rightsOutput.innerHTML = `<pre class="result-json">${escapeHtml(JSON.stringify(projection, null, 2))}</pre>`;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${label}无效`);
  }
  return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label}无效`);
  return value as Record<string, unknown>;
}

function invalidRightsProjection(): never {
  throw new Error("服务端权利请求脱敏投影无效");
}

function validateAuthorizedProjection(
  sessionValue: AuthenticatedSession,
  schemaVersion: string,
  capabilityValues: Capability[],
  portalValues: VisiblePortal[],
  count: number,
): void {
  if (
    schemaVersion !== "ltm.visible-capability-manifest.v1"
    || sessionValue.authenticationState !== "server_verified"
    || sessionValue.actorId.trim() === ""
    || sessionValue.tenantId.trim() === ""
    || sessionValue.purpose.trim() === ""
    || sessionValue.roles.length === 0
    || new Set(sessionValue.roles).size !== sessionValue.roles.length
  ) {
    throw new Error("server returned an invalid authenticated session");
  }
  if (count !== capabilityValues.length || new Set(capabilityValues.map((item) => item.batchId)).size !== capabilityValues.length) {
    throw new Error("server returned an inconsistent visible capability catalog");
  }
  const portalIds = new Set(portalValues.map((portal) => portal.id));
  if (
    portalIds.size !== portalValues.length
    || portalValues.some((portal) => (
      portalById(portal.id) === undefined
      || portal.capabilityCount !== capabilityValues.filter((capability) => capability.portalId === portal.id).length
    ))
    || capabilityValues.some((capability) => {
      const portal = portalValues.find((item) => item.id === capability.portalId);
      return portal === undefined || !portal.skills.includes(capability.skill) || capability.permission.trim() === "";
    })
  ) {
    throw new Error("server returned an invalid visible portal projection");
  }
}

function setConnection(style: "online" | "offline" | "auth-required", key: CopyKey): void {
  connection.className = `status ${style}`;
  connection.innerHTML = `<span aria-hidden="true"></span><span class="status-copy" data-i18n="${escapeHtml(key)}">${escapeHtml(translate(locale, key))}</span>`;
}

function applyInitialDeepLink(): void {
  const panel = initialUrl.searchParams.get("panel");
  if (panel !== null) {
    const target = tabs.find((tab) => tab.dataset.panel === panel);
    if (target !== undefined) activatePanel(target, false);
  } else if (initialUrl.searchParams.has("portal")) {
    const workspaceTab = tabs.find((tab) => tab.dataset.panel === "workspaces");
    if (workspaceTab !== undefined) activatePanel(workspaceTab, false);
  }
  const requestedCapability = initialUrl.searchParams.get("capability");
  if (requestedCapability !== null) openCapability(requestedCapability);
}

function activatePanel(tab: HTMLButtonElement, focusTab: boolean): void {
  for (const item of tabs) {
    const selected = item === tab;
    item.classList.toggle("active", selected);
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  for (const panel of document.querySelectorAll<HTMLElement>(".panel")) {
    const active = panel.id === tab.dataset.panel;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  }
  const url = new URL(window.location.href);
  if (tab.dataset.panel === "journey") url.searchParams.delete("panel");
  else if (tab.dataset.panel !== undefined) url.searchParams.set("panel", tab.dataset.panel);
  window.history.replaceState(null, "", url);
  if (focusTab) tab.focus();
}

function moveTabFocus(event: KeyboardEvent, current: HTMLButtonElement): void {
  const index = tabs.indexOf(current);
  let next = index;
  if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
  else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.length - 1;
  else return;
  event.preventDefault();
  const target = tabs[next];
  if (target !== undefined) activatePanel(target, true);
}

async function runJourney(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (session === undefined) return showToast(translate(locale, "authRequiredDescription"));
  const tenantId = element<HTMLInputElement>("tenantId").value.trim();
  const actorId = element<HTMLInputElement>("actorId").value.trim();
  const currentAge = Number(element<HTMLInputElement>("currentAge").value);
  const consent = element<HTMLInputElement>("consent").checked;
  const targetAges = [...document.querySelectorAll<HTMLInputElement>('input[name="ages"]:checked')].map((item) => Number(item.value));
  if (!consent) return showToast(translate(locale, "syntheticConfirm"));
  if (!tenantId || !actorId || !Number.isInteger(currentAge) || targetAges.length === 0) return showToast(translate(locale, "completeJourney"));

  journeyResult.innerHTML = `<strong>${escapeHtml(translate(locale, "creating"))}</strong><p>${escapeHtml(translate(locale, "policyCheck"))}</p>`;
  try {
    const localPlan = Object.freeze({
      schemaVersion: "ltm.local-journey-plan.v1",
      planId: crypto.randomUUID(),
      actorId,
      tenantId,
      currentAge,
      targetAges,
      submitted: false,
      reason: "media intake, B07 safety approval, and purpose-scoped participant consent are required before B08/B14",
    });
    journeyResult.innerHTML = `<strong>${escapeHtml(translate(locale, "timelineCreated"))}</strong><p>${escapeHtml(translate(locale, "timelineCreatedDescription"))}</p><pre class="result-json">${escapeHtml(JSON.stringify(localPlan, null, 2))}</pre>`;
  } catch (error) {
    journeyResult.innerHTML = `<strong>${escapeHtml(translate(locale, "safeStop"))}</strong><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  }
}

function renderCapabilities(query: string): void {
  const normalized = query.trim().toLowerCase();
  const filtered = capabilities.filter((item) => `${item.batchId} ${item.skill} ${item.operation} ${item.mode}`.toLowerCase().includes(normalized));
  const skills = new Set(capabilities.map((item) => item.skill));
  const external = capabilities.filter((item) => item.requiresExternalEvidence).length;
  summary.innerHTML = `<article><strong>${capabilities.length}</strong><small>${escapeHtml(translate(locale, "registeredBatches"))}</small></article><article><strong>${skills.size}</strong><small>${escapeHtml(translate(locale, "skillDomains"))}</small></article><article><strong>${external}</strong><small>${escapeHtml(translate(locale, "externalEvidenceCount"))}</small></article>`;
  list.innerHTML = filtered.map((item) => {
    const href = capabilityHref(item.batchId, item.portalId);
    return `<article class="capability"><code>${escapeHtml(item.batchId)}</code><div><strong>${escapeHtml(item.operation)}</strong><small>${escapeHtml(item.skill)} · ${escapeHtml(item.mode)}</small></div><div>${item.requiresExternalEvidence ? `<span class="external">${escapeHtml(translate(locale, "externalGate"))}</span>` : ""}<a class="capability-open" href="${escapeHtml(href)}" data-batch="${escapeHtml(item.batchId)}">${escapeHtml(translate(locale, "view"))}</a></div></article>`;
  }).join("");
  if (filtered.length === 0) list.innerHTML = `<div class="card">${escapeHtml(translate(locale, "noMatch"))}</div>`;
}

function renderWorkspaces(): void {
  const projectedPortal = visiblePortals.find((item) => item.id === activePortalId) ?? visiblePortals[0];
  if (projectedPortal === undefined) {
    workspaceNav.innerHTML = "";
    workspaceContent.innerHTML = `<div class="card"><strong>${escapeHtml(translate(locale, "authRequired"))}</strong><p>${escapeHtml(translate(locale, "authRequiredDescription"))}</p></div>`;
    return;
  }
  const portal = portalById(projectedPortal.id);
  if (portal === undefined) throw new Error("visible portal has no localized shell");
  activePortalId = projectedPortal.id;
  workspaceNav.innerHTML = visiblePortals.map((item) => {
    const copy = portalById(item.id);
    if (copy === undefined) return "";
    return `<button type="button" data-portal="${item.id}" class="${item.id === projectedPortal.id ? "active" : ""}" aria-current="${item.id === projectedPortal.id ? "page" : "false"}">${escapeHtml(localized(copy.title, locale))}</button>`;
  }).join("");
  const workspaces = projectedPortal.skills.map((skill) => {
    const operations = capabilities.filter((item) => item.skill === skill);
    const links = operations.map((item) => `<a class="operation-link" href="${escapeHtml(capabilityHref(item.batchId, portal.id))}" data-batch="${escapeHtml(item.batchId)}"><code>${escapeHtml(item.batchId)}</code><span>${escapeHtml(item.operation)}</span></a>`).join("");
    return `<section class="domain-workspace" aria-labelledby="workspace-${escapeHtml(skill)}"><h3 id="workspace-${escapeHtml(skill)}">${escapeHtml(humanizeSkill(skill))} · ${operations.length}</h3><div class="operation-grid">${links}</div></section>`;
  }).join("");
  workspaceContent.innerHTML = `<header class="workspace-intro"><h3>${escapeHtml(localized(portal.title, locale))}</h3><p>${escapeHtml(localized(portal.description, locale))}</p></header>${workspaces}`;
}

function openCapability(batchId: string): void {
  const capability = capabilities.find((item) => item.batchId === batchId);
  if (capability === undefined) {
    showToast(`未找到能力 ${batchId}`);
    return;
  }
  const requirements = capability.requirements.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join("");
  capabilityDialogContent.innerHTML = `<p class="eyebrow">${escapeHtml(capability.batchId)} · ${escapeHtml(capability.skill)}</p><h2 id="capability-dialog-title">${escapeHtml(capability.operation)}</h2><p>${escapeHtml(translate(locale, "executionMode"))}：<code>${escapeHtml(capability.mode)}</code></p><p>${escapeHtml(translate(locale, "stableEndpoint"))}：<code>POST /v1/capabilities/${escapeHtml(capability.batchId)}</code></p><h3>${escapeHtml(translate(locale, "atomicRequirements"))}</h3><ul class="requirement-list">${requirements}</ul>${capability.requiresExternalEvidence ? `<p class="evidence-status"><strong>${escapeHtml(translate(locale, "externalRequired"))}</strong> ${escapeHtml(translate(locale, "externalRequiredDescription"))}</p>` : `<p>${escapeHtml(translate(locale, "protectedOperation"))}</p>`}<form id="capability-execution-form" class="capability-execution-form"><label for="capability-input">JSON 请求对象</label><textarea id="capability-input" rows="10" maxlength="65536" spellcheck="false" autocomplete="off" autocapitalize="off">{}</textarea><p class="execution-help">请求仅发送到当前已登录的同源 API。幂等键在相同草稿重试时保持不变；修改草稿后自动轮换。</p><button id="capability-execute" class="primary" type="submit">执行 ${escapeHtml(capability.batchId)}</button></form><div id="capability-execution-output" class="execution-output" role="status" aria-live="polite"><strong>尚未执行</strong></div>`;
  const executionForm = element<HTMLFormElement>("capability-execution-form");
  executionForm.addEventListener("submit", (event) => void executeCapability(event, capability));
  const url = new URL(window.location.href);
  url.searchParams.set("capability", capability.batchId);
  url.searchParams.set("portal", capability.portalId);
  window.history.replaceState(null, "", url);
  if (!capabilityDialog.open) capabilityDialog.showModal();
}

async function executeCapability(event: SubmitEvent, capability: Capability): Promise<void> {
  event.preventDefault();
  if (session === undefined) {
    showToast(translate(locale, "authRequiredDescription"));
    return;
  }
  const inputElement = element<HTMLTextAreaElement>("capability-input");
  const output = element<HTMLDivElement>("capability-execution-output");
  const button = element<HTMLButtonElement>("capability-execute");
  try {
    const input = parseCapabilityInput(inputElement.value);
    const idempotencyKey = capabilityIdempotency.forDraft(capability.batchId, inputElement.value);
    button.disabled = true;
    output.innerHTML = "<strong>正在执行并等待服务端最终裁决…</strong>";
    const response = validateCapabilityExecutionResponse(capability.batchId, await api<unknown>(
      `/v1/capabilities/${capability.batchId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(input),
      },
    ));
    output.innerHTML = `<strong>服务端已返回</strong><pre class="result-json">${escapeHtml(JSON.stringify(response, null, 2))}</pre>`;
  } catch (error) {
    output.innerHTML = `<strong>执行失败并保持关闭</strong><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  } finally {
    button.disabled = false;
  }
}

function capabilityHref(batchId: string, portalId: string | undefined): string {
  const url = new URL(window.location.href);
  url.searchParams.set("panel", "workspaces");
  url.searchParams.set("capability", batchId);
  if (portalId !== undefined) url.searchParams.set("portal", portalId);
  return `${url.pathname}${url.search}`;
}

function humanizeSkill(value: string): string {
  return value.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function closestWithData(target: EventTarget | null, key: "portal" | "batch"): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(`[data-${key}]`) : null;
}

function applyTranslations(): void {
  for (const target of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = target.dataset.i18n as CopyKey | undefined;
    if (key !== undefined) target.textContent = translate(locale, key);
  }
  for (const target of document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
    const key = target.dataset.i18nAriaLabel as CopyKey | undefined;
    if (key !== undefined) target.setAttribute("aria-label", translate(locale, key));
  }
  for (const target of document.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]")) {
    const key = target.dataset.i18nPlaceholder as CopyKey | undefined;
    if (key !== undefined) target.placeholder = translate(locale, key);
  }
}

async function api<T>(path: string, init?: RequestInit, authenticated = true): Promise<T> {
  const headers = authenticated ? authentication.authenticatedHeaders(init?.headers) : new Headers(init?.headers);
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
  });
  const body = await readBoundedJsonResponse(response).catch(() => ({ error: { message: response.statusText } })) as { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  return body as T;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 3_200);
}
