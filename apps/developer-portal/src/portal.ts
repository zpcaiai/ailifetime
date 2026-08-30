export interface PortalSession {
  readonly partnerId: string;
  readonly actorId: string;
  readonly roles: readonly ("partner_admin" | "developer" | "viewer")[];
}

export interface PortalApplication {
  readonly id: string;
  readonly partnerId: string;
  readonly name: string;
  readonly environment: "sandbox" | "staging" | "production";
  readonly status: string;
  readonly requestCount: number;
  readonly errorCount: number;
}

export interface DeveloperPortalModel {
  readonly documentationVersion: string;
  readonly contractSha256: string;
  readonly applications: readonly PortalApplication[];
  readonly productionCredentialEligible: boolean;
  readonly webhookDeliveries: readonly { readonly id: string; readonly eventId: string; readonly status: string; readonly latencyMs: number }[];
  readonly connectors: readonly { readonly id: string; readonly version: string; readonly status: string; readonly dataAccess: string }[];
  readonly certifications: readonly { readonly id: string; readonly applicationId: string; readonly state: string; readonly expiresAt: string }[];
  readonly status: readonly { readonly component: string; readonly state: string; readonly incidentId?: string }[];
}

export function renderDeveloperPortal(model: DeveloperPortalModel, session: PortalSession): string {
  if (session.roles.length === 0) throw new Error("developer portal requires a server-authorized partner role");
  const applications = model.applications.filter((application) => application.partnerId === session.partnerId);
  if (applications.length !== model.applications.length) throw new Error("developer portal model contains cross-partner data");
  const navigation = ["getting-started", "authentication", "api", "webhooks", "sdks", "errors", "rate-limits", "versions", "examples", "security-consent"];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Life Time Machine Developer Portal</title><link rel="stylesheet" href="/developer-portal.css"></head>
<body><a class="skip" href="#main">Skip to developer controls</a><header><p class="eyebrow">Partner workspace</p><h1>Developer portal</h1><p>Contract ${escapeHtml(model.documentationVersion)} · <code>${escapeHtml(model.contractSha256.slice(0, 16))}</code></p></header>
<nav aria-label="API documentation">${navigation.map((item) => `<a href="#${item}">${title(item)}</a>`).join("")}</nav>
<main id="main">
<section id="getting-started"><h2>Applications and sandbox</h2><p>Create isolated applications, choose deterministic synthetic scenarios, reset fixtures, and inspect redacted request logs.</p>${table(["Application", "Environment", "Status", "Requests", "Errors"], applications.map((application) => [application.name, application.environment, application.status, String(application.requestCount), String(application.errorCount)]))}</section>
<section id="authentication"><h2>Authentication and credentials</h2><p>API keys, OAuth clients, service accounts, exact scopes, rotation, revocation, IP/domain, optional mTLS and signed-request controls.</p><button type="button" ${model.productionCredentialEligible ? "" : "disabled aria-disabled=\"true\""}>Issue production credential</button>${model.productionCredentialEligible ? "" : "<p role=\"status\">Contract, application, security configuration, and two-person approval are required.</p>"}</section>
<section id="api"><h2>API contract</h2><p>Types, pagination, error envelopes, idempotency, cancellation and compatibility are generated from the frozen OpenAPI and event contracts.</p></section>
<section id="webhooks"><h2>Webhook delivery console</h2>${table(["Delivery", "Event", "State", "Latency"], model.webhookDeliveries.map((delivery) => [delivery.id, delivery.eventId, delivery.status, `${delivery.latencyMs} ms`]))}<p>Authorized replay preserves the original event ID. Request signatures and response secrets are redacted.</p></section>
<section id="sdks"><h2>SDKs</h2><p>TypeScript, Python, and Java clients share source-version, timeout, retry, cancellation, idempotency, request-ID and safe-logging contracts.</p></section>
<section id="errors"><h2>Error catalog</h2><p>Validation, authorization, consent, conflict, quota, transient dependency, permanent dependency and reconciliation errors keep stable machine codes.</p></section>
<section id="rate-limits"><h2>Rate and budget limits</h2><p>Limits are enforced per credential, endpoint, connector, tenant and environment. Rejected requests are never reported as success.</p></section>
<section id="versions"><h2>Versions, connectors and certification</h2>${table(["Connector", "Version", "State", "Data access"], model.connectors.map((connector) => [connector.id, connector.version, connector.status, connector.dataAccess]))}${table(["Certification", "Application", "State", "Expires"], model.certifications.map((certification) => [certification.id, certification.applicationId, certification.state, certification.expiresAt]))}</section>
<section id="examples"><h2>Runnable examples</h2><pre><code>await client.command("order.create", input, idempotencyKey);</code></pre><p>Examples use synthetic identifiers and never contain production credentials.</p></section>
<section id="security-consent"><h2>Security and consent boundaries</h2><p>Every participant requires purpose-specific revocable authorization. Face media, children, and private conversations are excluded from connector exports. Illustrative AI output is never a prediction or eligibility signal.</p></section>
<section aria-labelledby="status-title"><h2 id="status-title">Developer status and support</h2>${table(["Component", "State", "Incident"], model.status.map((component) => [component.component, component.state, component.incidentId ?? "—"]))}</section>
</main><footer>Actor ${escapeHtml(session.actorId)} · Partner ${escapeHtml(session.partnerId)}</footer></body></html>`;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.length === 0 ? `<tr><td colspan="${headers.length}">No records in this tenant.</td></tr>` : rows.map((row) => `<tr>${row.map((cell, index) => `<${index === 0 ? "th scope=\"row\"" : "td"}>${escapeHtml(cell)}</${index === 0 ? "th" : "td"}>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function title(value: string): string { return value.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" "); }
function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
