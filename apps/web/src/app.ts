interface Capability {
  batchId: string;
  skill: string;
  operation: string;
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
let capabilities: Capability[] = [];

for (const tab of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tab.addEventListener("click", () => {
    for (const item of document.querySelectorAll<HTMLButtonElement>(".tab")) {
      const selected = item === tab;
      item.classList.toggle("active", selected);
      item.setAttribute("aria-selected", String(selected));
    }
    for (const panel of document.querySelectorAll<HTMLElement>(".panel")) {
      const active = panel.id === tab.dataset.panel;
      panel.hidden = !active;
      panel.classList.toggle("active", active);
    }
  });
}

search.addEventListener("input", () => renderCapabilities(search.value));
journeyForm.addEventListener("submit", (event) => void runJourney(event));

void initialize();

async function initialize(): Promise<void> {
  try {
    const health = await api<Record<string, unknown>>("/health/ready");
    connection.classList.add("online");
    connection.innerHTML = "<span></span>本地运行正常";
    healthOutput.textContent = JSON.stringify(health, null, 2);
    const catalog = await api<{ capabilities: Capability[] }>("/v1/capabilities");
    capabilities = catalog.capabilities;
    registeredCount.textContent = String(capabilities.length);
    renderCapabilities("");
  } catch (error) {
    connection.classList.add("offline");
    connection.innerHTML = "<span></span>本地 API 未启动";
    healthOutput.textContent = error instanceof Error ? error.message : String(error);
    showToast("请先运行 pnpm dev 启动本地 API");
  }
}

async function runJourney(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const tenantId = element<HTMLInputElement>("tenantId").value.trim();
  const actorId = element<HTMLInputElement>("actorId").value.trim();
  const currentAge = Number(element<HTMLInputElement>("currentAge").value);
  const consent = element<HTMLInputElement>("consent").checked;
  const targetAges = [...document.querySelectorAll<HTMLInputElement>('input[name="ages"]:checked')].map((item) => Number(item.value));
  if (!consent) return showToast("必须确认合成数据与本地测试用途");
  if (!tenantId || !actorId || !Number.isInteger(currentAge) || targetAges.length === 0) return showToast("请完整填写旅程参数");

  journeyResult.innerHTML = "<strong>正在创建…</strong><p>执行授权与策略检查。</p>";
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
    journeyResult.innerHTML = `<strong>时间轴计划已创建</strong><p>结果带有租户、授权、幂等与审计上下文。</p><pre class="result-json">${escapeHtml(JSON.stringify(result, null, 2))}</pre>`;
  } catch (error) {
    journeyResult.innerHTML = `<strong>安全停止</strong><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
  }
}

function renderCapabilities(query: string): void {
  const normalized = query.trim().toLowerCase();
  const filtered = capabilities.filter((item) => `${item.batchId} ${item.skill} ${item.operation}`.toLowerCase().includes(normalized));
  const skills = new Set(capabilities.map((item) => item.skill));
  const external = capabilities.filter((item) => item.requiresExternalEvidence).length;
  summary.innerHTML = `<article><strong>${capabilities.length}</strong><small>已注册批次</small></article><article><strong>${skills.size}</strong><small>技能领域</small></article><article><strong>${external}</strong><small>仍需外部证据</small></article>`;
  list.innerHTML = filtered.map((item) => `<article class="capability"><code>${escapeHtml(item.batchId)}</code><div><strong>${escapeHtml(item.operation)}</strong><small>${escapeHtml(item.skill)}</small></div>${item.requiresExternalEvidence ? '<span class="external">外部证据门</span>' : ""}</article>`).join("");
  if (filtered.length === 0) list.innerHTML = '<div class="card">没有匹配的能力。</div>';
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
  window.setTimeout(() => toast.classList.remove("show"), 3200);
}
