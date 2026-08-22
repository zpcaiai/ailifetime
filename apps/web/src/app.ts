import { PORTALS, localized, normalizeLocale, portalForSkill, translate, type CopyKey, type SupportedLocale } from "./surface.js";

interface Capability {
  batchId: string;
  skill: string;
  operation: string;
  mode: string;
  requirements: readonly string[];
  requiresExternalEvidence?: boolean;
}

const connection = element<HTMLDivElement>("connection");
const healthOutput = element<HTMLPreElement>("health-output");
const list = element<HTMLDivElement>("capability-list");
const summary = element<HTMLDivElement>("capability-summary");
const registeredCount = element<HTMLElement>("registered-count");
const search = element<HTMLInputElement>("capability-search");
const journeyForm = element<HTMLFormElement>("journey-form");
const journeyResult = element<HTMLDivElement>("journey-result");
const toast = element<HTMLDivElement>("toast");
const localeSelect = element<HTMLSelectElement>("locale");
const workspaceNav = element<HTMLElement>("workspace-nav");
const workspaceContent = element<HTMLDivElement>("workspace-content");
const capabilityDialog = element<HTMLDialogElement>("capability-dialog");
const capabilityDialogContent = element<HTMLDivElement>("capability-dialog-content");
const tabs = [...document.querySelectorAll<HTMLButtonElement>(".tab")];
const initialUrl = new URL(window.location.href);

let capabilities: Capability[] = [];
let locale: SupportedLocale = normalizeLocale(initialUrl.searchParams.get("lang") ?? navigator.language);
let activePortalId = initialUrl.searchParams.get("portal") ?? PORTALS[0]?.id ?? "consumer";

document.documentElement.lang = locale;
localeSelect.value = locale;
applyTranslations();

for (const tab of tabs) {
  tab.addEventListener("click", () => activatePanel(tab, false));
  tab.addEventListener("keydown", (event) => moveTabFocus(event, tab));
}

search.addEventListener("input", () => renderCapabilities(search.value));
journeyForm.addEventListener("submit", (event) => void runJourney(event));
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
  const url = new URL(window.location.href);
  url.searchParams.delete("capability");
  window.history.replaceState(null, "", url);
});

void initialize();

async function initialize(): Promise<void> {
  try {
    const health = await api<Record<string, unknown>>("/health/ready");
    connection.classList.add("online");
    connection.innerHTML = `<span aria-hidden="true"></span><span class="status-copy" data-i18n="online">${escapeHtml(translate(locale, "online"))}</span>`;
    healthOutput.textContent = JSON.stringify(health, null, 2);
    const catalog = await api<{ capabilities: Capability[] }>("/v1/capabilities");
    capabilities = catalog.capabilities;
    registeredCount.textContent = String(capabilities.length);
    renderCapabilities("");
    renderWorkspaces();
    applyInitialDeepLink();
  } catch (error) {
    connection.classList.add("offline");
    connection.innerHTML = `<span aria-hidden="true"></span><span class="status-copy" data-i18n="offline">${escapeHtml(translate(locale, "offline"))}</span>`;
    healthOutput.textContent = error instanceof Error ? error.message : String(error);
    showToast(translate(locale, "startApi"));
  }
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
  const tenantId = element<HTMLInputElement>("tenantId").value.trim();
  const actorId = element<HTMLInputElement>("actorId").value.trim();
  const currentAge = Number(element<HTMLInputElement>("currentAge").value);
  const consent = element<HTMLInputElement>("consent").checked;
  const targetAges = [...document.querySelectorAll<HTMLInputElement>('input[name="ages"]:checked')].map((item) => Number(item.value));
  if (!consent) return showToast(translate(locale, "syntheticConfirm"));
  if (!tenantId || !actorId || !Number.isInteger(currentAge) || targetAges.length === 0) return showToast(translate(locale, "completeJourney"));

  journeyResult.innerHTML = `<strong>${escapeHtml(translate(locale, "creating"))}</strong><p>${escapeHtml(translate(locale, "policyCheck"))}</p>`;
  try {
    const journeyId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const evidenceHash = await sha256(`${tenantId}:${actorId}:${journeyId}:age_transformation`);
    await api<unknown>("/v1/capabilities/B04", {
      method: "POST",
      headers: actorHeaders(`consent-${journeyId}`, "age_transformation"),
      body: JSON.stringify({ participantId: actorId, subjectId: actorId, purpose: "age_transformation", policyVersion: "local-synthetic-v1", evidenceHash, expiresAt, status: "active", isMinor: false }),
    });
    const result = await api<unknown>("/v1/capabilities/B14", {
      method: "POST",
      headers: actorHeaders(`timeline-${journeyId}`, "age_transformation"),
      body: JSON.stringify({ jobId: `job-${journeyId}`, currentAge, targetAges, sourceAssetId: "asset-synthetic-portrait", participantIds: [actorId], seed: journeyId, promptPolicyVersion: "illustrative-v1", illustrativeLabel: true }),
    });
    journeyResult.innerHTML = `<strong>${escapeHtml(translate(locale, "timelineCreated"))}</strong><p>${escapeHtml(translate(locale, "timelineCreatedDescription"))}</p><pre class="result-json">${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
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
    const portal = portalForSkill(item.skill);
    const href = capabilityHref(item.batchId, portal?.id);
    return `<article class="capability"><code>${escapeHtml(item.batchId)}</code><div><strong>${escapeHtml(item.operation)}</strong><small>${escapeHtml(item.skill)} · ${escapeHtml(item.mode)}</small></div><div>${item.requiresExternalEvidence ? `<span class="external">${escapeHtml(translate(locale, "externalGate"))}</span>` : ""}<a class="capability-open" href="${escapeHtml(href)}" data-batch="${escapeHtml(item.batchId)}">${escapeHtml(translate(locale, "view"))}</a></div></article>`;
  }).join("");
  if (filtered.length === 0) list.innerHTML = `<div class="card">${escapeHtml(translate(locale, "noMatch"))}</div>`;
}

function renderWorkspaces(): void {
  const portal = PORTALS.find((item) => item.id === activePortalId) ?? PORTALS[0];
  if (portal === undefined) return;
  activePortalId = portal.id;
  workspaceNav.innerHTML = PORTALS.map((item) => `<button type="button" data-portal="${item.id}" class="${item.id === portal.id ? "active" : ""}" aria-current="${item.id === portal.id ? "page" : "false"}">${escapeHtml(localized(item.title, locale))}</button>`).join("");
  const workspaces = portal.skills.map((skill) => {
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
  capabilityDialogContent.innerHTML = `<p class="eyebrow">${escapeHtml(capability.batchId)} · ${escapeHtml(capability.skill)}</p><h2 id="capability-dialog-title">${escapeHtml(capability.operation)}</h2><p>${escapeHtml(translate(locale, "executionMode"))}：<code>${escapeHtml(capability.mode)}</code></p><p>${escapeHtml(translate(locale, "stableEndpoint"))}：<code>POST /v1/capabilities/${escapeHtml(capability.batchId)}</code></p><h3>${escapeHtml(translate(locale, "atomicRequirements"))}</h3><ul class="requirement-list">${requirements}</ul>${capability.requiresExternalEvidence ? `<p class="evidence-status"><strong>${escapeHtml(translate(locale, "externalRequired"))}</strong> ${escapeHtml(translate(locale, "externalRequiredDescription"))}</p>` : `<p>${escapeHtml(translate(locale, "protectedOperation"))}</p>`}`;
  const url = new URL(window.location.href);
  url.searchParams.set("capability", capability.batchId);
  const portal = portalForSkill(capability.skill);
  if (portal !== undefined) url.searchParams.set("portal", portal.id);
  window.history.replaceState(null, "", url);
  if (!capabilityDialog.open) capabilityDialog.showModal();
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

function actorHeaders(idempotencyKey: string, purpose: string): HeadersInit {
  return {
    "content-type": "application/json",
    authorization: "Bearer local-consumer",
    "x-purpose": purpose,
    "idempotency-key": idempotencyKey,
  };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({ error: { message: response.statusText } })) as { error?: { message?: string } };
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
