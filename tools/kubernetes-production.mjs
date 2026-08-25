#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE_DIRECTORY = resolve(PRODUCT_ROOT, "infra/kubernetes/production");
const IMAGE = /^[^\s\u0000-\u001f\u007f]+@sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/;

export class KubernetesProductionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KubernetesProductionError";
    this.code = code;
  }
}

export function renderProductionManifests(options) {
  const output = resolve(required(options.output, "output"));
  if (output === TEMPLATE_DIRECTORY || output.startsWith(`${TEMPLATE_DIRECTORY}${sep}`)) {
    throw failure("KUBERNETES_OUTPUT_INVALID", "Rendered output must not overwrite the production templates");
  }
  if (existsSync(output) && (!statSync(output).isDirectory() || readdirSync(output).length > 0)) {
    throw failure("KUBERNETES_OUTPUT_NOT_EMPTY", "Rendered output directory must be absent or empty");
  }
  const host = productionHost(options.host);
  const oidcIssuer = httpsUrl(options.oidcIssuer, "oidcIssuer", false);
  const values = {
    __LTM_API_IMAGE__: immutableImage(options.apiImage, "apiImage"),
    __LTM_WORKERS_IMAGE__: immutableImage(options.workersImage, "workersImage"),
    __LTM_GATEWAY_IMAGE__: immutableImage(options.gatewayImage, "gatewayImage"),
    __LTM_CLIENT_BROKER_IMAGE__: immutableImage(options.clientBrokerImage, "clientBrokerImage"),
    __LTM_MIGRATOR_IMAGE__: immutableImage(options.migratorImage, "migratorImage"),
    __LTM_HOST__: host,
    __LTM_OIDC_ISSUER__: oidcIssuer,
    __LTM_OIDC_JWKS_URL__: oidcJwksEndpoint(options.oidcJwksUrl, oidcIssuer),
    __LTM_OIDC_AUDIENCE__: safeScalar(options.oidcAudience, "oidcAudience", 512),
    __LTM_WEB_OIDC_AUTHORIZATION_ENDPOINT__: oidcBrowserEndpoint(options.oidcAuthorizationEndpoint, "oidcAuthorizationEndpoint", oidcIssuer),
    __LTM_WEB_OIDC_TOKEN_ENDPOINT__: oidcBrowserEndpoint(options.oidcTokenEndpoint, "oidcTokenEndpoint", oidcIssuer),
    __LTM_WEB_OIDC_CLIENT_ID__: oidcClientId(options.oidcClientId),
    __LTM_WEB_OIDC_REDIRECT_URI__: exactBrowserRedirect(options.oidcRedirectUri, host),
    __LTM_WEB_OIDC_SCOPES__: oidcScopes(options.oidcScopes),
    __LTM_MEDIA_SAFETY_SCANNER_URL__: httpsOrigin443(options.mediaSafetyScannerUrl, "mediaSafetyScannerUrl"),
    __LTM_TENANT_ID__: identifier(options.tenantId, "tenantId"),
    __LTM_RELEASE_ID__: kubernetesName(options.releaseId, "releaseId", 40),
    __LTM_INGRESS_CLASS__: kubernetesName(options.ingressClass, "ingressClass", 63),
    __LTM_INGRESS_NAMESPACE__: kubernetesName(options.ingressNamespace, "ingressNamespace", 63),
    __LTM_POSTGRES_CIDR__: privateIpv4Cidr(options.postgresCidr, "postgresCidr"),
    __LTM_POSTGRES_PORT__: networkPort(options.postgresPort, "postgresPort"),
    __LTM_REDIS_CIDR__: privateIpv4Cidr(options.redisCidr, "redisCidr"),
    __LTM_REDIS_PORT__: networkPort(options.redisPort, "redisPort"),
  };
  const imageDigests = new Set(
    Object.entries(values).filter(([key]) => key.includes("IMAGE")).map(([, value]) => imageDigest(value)),
  );
  if (imageDigests.size !== 5) throw failure("KUBERNETES_IMAGE_REUSED", "API, worker, gateway, client broker, and migrator must use distinct immutable OCI references");

  mkdirSync(output, { recursive: true, mode: 0o700 });
  const rendered = [];
  for (const name of readdirSync(TEMPLATE_DIRECTORY).sort()) {
    if (!name.endsWith(".yaml")) continue;
    let content = readFileSync(resolve(TEMPLATE_DIRECTORY, name), "utf8");
    for (const [token, value] of Object.entries(values)) content = content.replaceAll(token, value);
    if (/__LTM_[A-Z0-9_]+__/.test(content)) throw failure("KUBERNETES_VALUE_UNRESOLVED", `${name} contains an unresolved production token`);
    const path = resolve(output, name);
    writeFileSync(path, content, { mode: 0o600 });
    rendered.push(relative(PRODUCT_ROOT, path).split(sep).join("/"));
  }
  const validation = validateRenderedProductionManifests(output);
  return { ...validation, output, files: rendered };
}

export function validateRenderedProductionManifests(directoryValue) {
  const directory = resolve(required(directoryValue, "directory"));
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw failure("KUBERNETES_DIRECTORY_INVALID", "Rendered Kubernetes directory does not exist");
  }
  const files = readdirSync(directory).filter((name) => name.endsWith(".yaml")).sort();
  if (files.length !== 11) throw failure("KUBERNETES_FILE_SET_INVALID", "Production Kubernetes output must contain exactly eleven YAML files");
  const content = files.map((name) => readFileSync(resolve(directory, name), "utf8")).join("\n---\n");
  if (/__LTM_[A-Z0-9_]+__/.test(content)) throw failure("KUBERNETES_VALUE_UNRESOLVED", "Rendered Kubernetes output contains unresolved tokens");
  if (/\nkind:\s*Secret\s*(?:\n|$)/.test(content) || /\n\s*(?:data|stringData):\s*\n\s+[A-Za-z0-9_.-]+:/m.test(content) && /\nkind:\s*Secret/m.test(content)) {
    throw failure("KUBERNETES_INLINE_SECRET_FORBIDDEN", "Production templates must reference external Secrets and never define secret values");
  }
  const imageLines = [...content.matchAll(/^\s*image:\s*([^\s#]+)\s*$/gm)].map((match) => match[1]);
  if (imageLines.length !== 5 || imageLines.some((image) => !IMAGE.test(image)) ||
      new Set(imageLines.map((image) => imageDigest(image))).size !== 5) {
    throw failure("KUBERNETES_IMAGE_INVALID", "Every production workload must use its own immutable OCI sha256 reference");
  }

  const documents = yamlDocuments(content);
  requireNamed(documents, "Namespace", ["ltm-production"]);
  requireNamed(documents, "ServiceAccount", ["ltm-api", "ltm-workers", "ltm-integration-gateway", "ltm-client-integration-broker", "ltm-postgres-migrator"]);
  requireNamed(documents, "Deployment", ["ltm-api", "ltm-workers", "ltm-integration-gateway", "ltm-client-integration-broker"]);
  requireNamed(documents, "Service", ["ltm-api", "ltm-integration-gateway", "ltm-client-integration-broker"]);
  requireNamed(documents, "PodDisruptionBudget", ["ltm-api", "ltm-workers", "ltm-integration-gateway", "ltm-client-integration-broker"]);
  requireNamed(documents, "HorizontalPodAutoscaler", ["ltm-api", "ltm-workers", "ltm-integration-gateway", "ltm-client-integration-broker"]);
  requireNamed(documents, "NetworkPolicy", [
    "default-deny", "allow-public-ingress", "allow-dns-egress", "allow-https-egress",
    "allow-postgres-egress", "allow-redis-egress", "allow-client-broker-ingress", "allow-client-broker-egress",
  ]);
  if (documents.length !== 32) throw failure("KUBERNETES_RESOURCE_SET_INVALID", "Production resources must match the exact 32-resource contract");
  requireNamed(documents, "Ingress", ["ltm-public"]);
  validatePrivateNetworkPolicy(documents, "allow-postgres-egress", "postgres");
  validatePrivateNetworkPolicy(documents, "allow-redis-egress", "redis");
  validateClientBrokerHttpsEgress(documents);
  validateClientBrokerMediaSafety(documents);
  validateBrowserOidcConfig(content);
  const jobs = documents.filter((document) => document.kind === "Job");
  if (jobs.length !== 1 || !jobs[0].name.startsWith("ltm-postgres-migrate-")) {
    throw failure("KUBERNETES_MIGRATION_JOB_MISSING", "Exactly one release-bound PostgreSQL migration Job is required");
  }
  const workloads = documents.filter((document) => document.kind === "Deployment" || document.kind === "Job");
  for (const workload of workloads) validateRestrictedWorkload(workload);
  for (const deployment of documents.filter((document) => document.kind === "Deployment")) {
    for (const control of ["topologySpreadConstraints:", "readinessProbe:", "livenessProbe:", "startupProbe:"]) {
      if (!deployment.text.includes(control)) throw failure("KUBERNETES_AVAILABILITY_CONTROL_MISSING", `${deployment.name} is missing ${control.slice(0, -1)}`);
    }
  }
  const job = jobs[0].text;
  for (const token of ["backoffLimit: 0", "activeDeadlineSeconds: 900", "--profile=production", "migrator-url"]) {
    if (!job.includes(token)) throw failure("KUBERNETES_MIGRATION_JOB_INVALID", `Migration Job is missing ${token}`);
  }
  for (const token of [
    "pod-security.kubernetes.io/enforce: restricted",
    "LTM_DEPLOYMENT_PROFILE: distributed",
    "LTM_PROVIDER_MODE: external-verified",
    "LTM_WECHAT_IDENTITY_BROKER_URL: \"https://ltm-client-integration-broker.ltm-production.svc:8443\"",
    "LTM_UPLOAD_BROKER_URL: \"https://ltm-client-integration-broker.ltm-production.svc:8443\"",
    "LTM_CONSENT_POLICY_CATALOG_FILE: /var/run/secrets/ltm-consent-policy/catalog.json",
    "LTM_CONSENT_POLICY_JURISDICTION: CN",
    "LTM_CONSENT_POLICY_LOCALE: zh-CN",
    "LTM_WEB_OIDC_AUTHORIZATION_ENDPOINT",
    "LTM_WEB_OIDC_TOKEN_ENDPOINT",
    "LTM_WEB_OIDC_CLIENT_ID",
    "LTM_WEB_OIDC_REDIRECT_URI",
    "LTM_WEB_OIDC_SCOPES",
    "LTM_CONSENT_POLICY_TRUST_KEYS_JSON",
    "secretName: ltm-production-consent-policy",
    "NODE_EXTRA_CA_CERTS",
    "secretName: ltm-production-client-integration-broker-tls",
    "secretName: ltm-production-client-integration-broker-credentials",
    "secretName: ltm-production-client-integration-broker-scanner-credentials\n            optional: false",
    "secretName: ltm-production-client-integration-broker-egress-ca-bundle\n            optional: false",
    "LTM_MEDIA_SAFETY_SCANNER_URL",
    "LTM_MEDIA_SAFETY_SCANNER_TOKEN_FILE",
    "scheme: HTTPS",
    "secretName: ltm-production-client-brokers",
    "default-deny",
    "secretKeyRef:",
    "projected:",
    "secretName: ltm-production-integration-gateway-api-token",
    "ltm.openai.com/external-command-batches: \"18\"",
    "ltm.openai.com/external-callback-route-contracts: \"19\"",
    "tls:",
    "secretName: ltm-production-tls",
  ]) {
    if (!content.includes(token)) throw failure("KUBERNETES_PRODUCTION_CONTROL_MISSING", `Rendered manifests are missing ${token}`);
  }
  return {
    schemaVersion: "ltm.kubernetes-production-validation.v1",
    status: "PASS",
    files: files.length,
    resources: documents.length,
    workloadImages: imageLines,
    externalCertification: false,
  };
}

function validateRestrictedWorkload(workload) {
  const requiredControls = [
    "automountServiceAccountToken: false",
    "enableServiceLinks: false",
    "runAsNonRoot: true",
    "runAsUser: 10001",
    "runAsGroup: 10001",
    "fsGroup: 10001",
    "fsGroupChangePolicy: OnRootMismatch",
    "type: RuntimeDefault",
    "allowPrivilegeEscalation: false",
    "readOnlyRootFilesystem: true",
    "drop: [\"ALL\"]",
    "requests:",
    "limits:",
    "imagePullPolicy: IfNotPresent",
    "serviceAccountName:",
  ];
  for (const control of requiredControls) {
    if (!workload.text.includes(control)) throw failure("KUBERNETES_RESTRICTED_WORKLOAD_INVALID", `${workload.name} is missing ${control}`);
  }
}

function yamlDocuments(content) {
  return content.split(/^---\s*$/m).map((text) => text.trim()).filter(Boolean).flatMap((text) => {
    const kind = /^kind:\s*([^\s#]+)\s*$/m.exec(text)?.[1];
    if (kind === undefined || kind === "Kustomization") return [];
    const resourceName = /^metadata:\s*\n(?:\s{2}[^\n]+\n)*?\s{2}name:\s*["']?([^\s"'#]+)["']?\s*$/m.exec(text)?.[1];
    if (resourceName === undefined) throw failure("KUBERNETES_RESOURCE_NAME_MISSING", `A ${kind} resource has no canonical metadata.name`);
    return [{ kind, name: resourceName, text }];
  });
}

function requireNamed(documents, kind, names) {
  const actual = documents.filter((document) => document.kind === kind).map((document) => document.name).sort();
  const expected = [...names].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw failure("KUBERNETES_RESOURCE_SET_INVALID", `${kind} resources do not match the production contract`);
  }
}

function validatePrivateNetworkPolicy(documents, name, label) {
  const policy = documents.find((document) => document.kind === "NetworkPolicy" && document.name === name);
  const text = policy?.text ?? "";
  const cidrs = [...text.matchAll(/^\s*cidr:\s*["']?([^\s"'#]+)["']?\s*$/gm)].map((match) => match[1]);
  const ports = [...text.matchAll(/^\s*port:\s*(\d+)\s*$/gm)].map((match) => match[1]);
  const protocols = [...text.matchAll(/^\s*-\s*protocol:\s*([^\s#]+)\s*$/gm)].map((match) => match[1]);
  if (cidrs.length !== 1 || ports.length !== 1 || protocols.length !== 1 || protocols[0] !== "TCP") {
    throw failure("KUBERNETES_PRIVATE_EGRESS_INVALID", `${name} must bind one private CIDR and exact TCP port`);
  }
  privateIpv4Cidr(cidrs[0], `${label}Cidr`);
  networkPort(ports[0], `${label}Port`);
}

function validateClientBrokerHttpsEgress(documents) {
  const policy = documents.find((document) => document.kind === "NetworkPolicy" && document.name === "allow-https-egress");
  const text = policy?.text ?? "";
  const ports = [...text.matchAll(/^\s*port:\s*(\d+)\s*$/gm)].map((match) => match[1]);
  const protocols = [...text.matchAll(/^\s*-\s*protocol:\s*([^\s#]+)\s*$/gm)].map((match) => match[1]);
  if (!text.includes('values: ["api", "workers", "integration-gateway", "client-integration-broker"]') ||
      ports.length !== 1 || ports[0] !== "443" || protocols.length !== 1 || protocols[0] !== "TCP") {
    throw failure(
      "KUBERNETES_MEDIA_SCANNER_EGRESS_INVALID",
      "allow-https-egress must select the client integration broker and allow exactly TCP 443 for its scanner HTTPS origin",
    );
  }
}

function validateBrowserOidcConfig(content) {
  const publicBaseValue = configMapValue(content, "LTM_PUBLIC_BASE_URL");
  let publicBase;
  try { publicBase = new URL(publicBaseValue); } catch {
    throw failure("KUBERNETES_OIDC_BROWSER_INVALID", "LTM_PUBLIC_BASE_URL must be an HTTPS origin");
  }
  if (publicBase.protocol !== "https:" || publicBase.origin !== publicBaseValue || publicBase.pathname !== "/" ||
      publicBase.username !== "" || publicBase.password !== "" || publicBase.search !== "" || publicBase.hash !== "") {
    throw failure("KUBERNETES_OIDC_BROWSER_INVALID", "LTM_PUBLIC_BASE_URL must be an exact HTTPS origin");
  }
  productionHost(publicBase.hostname);
  const issuer = httpsUrl(configMapValue(content, "LTM_OIDC_ISSUER"), "oidcIssuer", false);
  oidcJwksEndpoint(configMapValue(content, "LTM_OIDC_JWKS_URL"), issuer);
  oidcBrowserEndpoint(configMapValue(content, "LTM_WEB_OIDC_AUTHORIZATION_ENDPOINT"), "oidcAuthorizationEndpoint", issuer);
  oidcBrowserEndpoint(configMapValue(content, "LTM_WEB_OIDC_TOKEN_ENDPOINT"), "oidcTokenEndpoint", issuer);
  oidcClientId(configMapValue(content, "LTM_WEB_OIDC_CLIENT_ID"));
  exactBrowserRedirect(configMapValue(content, "LTM_WEB_OIDC_REDIRECT_URI"), publicBase.hostname);
  oidcScopes(configMapValue(content, "LTM_WEB_OIDC_SCOPES"));
  if (/LTM_WEB_OIDC_CLIENT_SECRET|OIDC_CLIENT_SECRET/.test(content)) {
    throw failure("KUBERNETES_OIDC_BROWSER_INVALID", "public SPA configuration must not contain a client secret");
  }
}

function configMapValue(content, name) {
  const matches = [...content.matchAll(new RegExp(`^\\s{2}${name}:\\s+"([^"]+)"\\s*$`, "gm"))];
  if (matches.length !== 1 || matches[0][1] === undefined) {
    throw failure("KUBERNETES_OIDC_BROWSER_INVALID", `${name} must occur exactly once as a quoted ConfigMap value`);
  }
  return matches[0][1];
}

function validateClientBrokerMediaSafety(documents) {
  const deployment = documents.find(
    (document) => document.kind === "Deployment" && document.name === "ltm-client-integration-broker",
  );
  const text = deployment?.text ?? "";
  const scannerUrl = /- name: LTM_MEDIA_SAFETY_SCANNER_URL\n\s+value: "([^"]+)"/.exec(text)?.[1];
  if (scannerUrl === undefined || [...text.matchAll(/- name: LTM_MEDIA_SAFETY_SCANNER_TOKEN_FILE\s*$/gm)].length !== 1) {
    throw failure(
      "KUBERNETES_MEDIA_SCANNER_CONFIG_INVALID",
      "client integration broker production scanner environment is incomplete",
    );
  }
  httpsOrigin443(scannerUrl, "mediaSafetyScannerUrl");
  const requiredControls = [
    "value: /var/run/secrets/ltm-media-scanner/token",
    "value: /var/run/secrets/ltm-egress-ca-bundle/ca-bundle.pem",
    "mountPath: /var/run/secrets/ltm-media-scanner",
    "mountPath: /var/run/secrets/ltm-egress-ca-bundle",
    "secretName: ltm-production-client-integration-broker-scanner-credentials",
    "secretName: ltm-production-client-integration-broker-egress-ca-bundle",
    "- key: token\n                path: token",
    "- key: ca-bundle.pem\n                path: ca-bundle.pem",
    "- key: idp-ca.crt\n                path: sources/idp-ca.crt",
    "- key: scanner-ca.crt\n                path: sources/scanner-ca.crt",
  ];
  for (const control of requiredControls) {
    if (!text.includes(control)) {
      throw failure(
        "KUBERNETES_MEDIA_SCANNER_CONFIG_INVALID",
        "client integration broker must project scanner credentials and one explicit IdP plus scanner CA bundle",
      );
    }
  }
  if ([...text.matchAll(/- name: NODE_EXTRA_CA_CERTS/g)].length !== 1) {
    throw failure(
      "KUBERNETES_MEDIA_SCANNER_CONFIG_INVALID",
      "client integration broker must use exactly one NODE_EXTRA_CA_CERTS bundle file",
    );
  }
}

function immutableImage(value, label) {
  const normalized = required(value, label);
  if (!IMAGE.test(normalized)) throw failure("KUBERNETES_IMAGE_INVALID", `${label} must be an immutable OCI sha256 reference`);
  return normalized;
}

function imageDigest(value) {
  const match = /@sha256:([a-f0-9]{64})$/.exec(value);
  if (match === null) throw failure("KUBERNETES_IMAGE_INVALID", "workload image must contain an immutable sha256 digest");
  return match[1];
}

function productionHost(value) {
  const normalized = required(value, "host").toLowerCase();
  if (!DNS_HOST.test(normalized) || normalized.endsWith(".invalid") || normalized.endsWith(".test") || normalized === "localhost") {
    throw failure("KUBERNETES_HOST_INVALID", "Production host must be a non-test DNS hostname");
  }
  return normalized;
}

function httpsUrl(value, label, requirePath) {
  const normalized = required(value, label);
  let url;
  try { url = new URL(normalized); } catch { throw failure("KUBERNETES_URL_INVALID", `${label} must be an HTTPS URL`); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "" || (requirePath && url.pathname === "/")) {
    throw failure("KUBERNETES_URL_INVALID", `${label} must be credential-free HTTPS with the required path`);
  }
  return url.toString();
}

function oidcBrowserEndpoint(value, label, issuerValue) {
  const endpoint = new URL(httpsUrl(value, label, true));
  const issuer = new URL(issuerValue);
  productionHost(endpoint.hostname);
  if (endpoint.origin !== issuer.origin || endpoint.search !== "" || endpoint.hash !== "" ||
      (issuer.pathname !== "/" && !endpoint.pathname.startsWith(issuer.pathname))) {
    throw failure("KUBERNETES_OIDC_BROWSER_INVALID", `${label} must be an exact path on the trusted issuer origin`);
  }
  return endpoint.toString();
}

function oidcJwksEndpoint(value, issuerValue) {
  const endpoint = new URL(httpsUrl(value, "oidcJwksUrl", true));
  const issuer = new URL(issuerValue);
  productionHost(endpoint.hostname);
  if (endpoint.origin !== issuer.origin || endpoint.search !== "" || endpoint.hash !== "") {
    throw failure("KUBERNETES_OIDC_JWKS_INVALID", "oidcJwksUrl must be an exact path on the trusted issuer origin");
  }
  return endpoint.toString();
}

function exactBrowserRedirect(value, host) {
  const redirect = new URL(httpsUrl(value, "oidcRedirectUri", true));
  const expected = `https://${host}/auth/callback`;
  if (redirect.toString() !== expected || redirect.search !== "" || redirect.hash !== "") {
    throw failure("KUBERNETES_OIDC_BROWSER_INVALID", `oidcRedirectUri must exactly equal ${expected}`);
  }
  return expected;
}

function oidcClientId(value) {
  const normalized = required(value, "oidcClientId");
  if (normalized.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._~:-]{0,255}$/.test(normalized)) {
    throw failure("KUBERNETES_OIDC_BROWSER_INVALID", "oidcClientId is invalid");
  }
  return normalized;
}

function oidcScopes(value) {
  const normalized = required(value, "oidcScopes");
  const scopes = normalized.split(/\s+/);
  if (normalized.length > 1024 || scopes.length > 20 || new Set(scopes).size !== scopes.length ||
      scopes.some((scope) => !/^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,127}$/.test(scope)) ||
      !scopes.includes("openid") || scopes.includes("offline_access")) {
    throw failure("KUBERNETES_OIDC_BROWSER_INVALID", "oidcScopes must be unique, include openid, and exclude offline_access");
  }
  return normalized;
}

function httpsOrigin443(value, label) {
  const normalized = required(value, label);
  let url;
  try { url = new URL(normalized); } catch { throw failure("KUBERNETES_URL_INVALID", `${label} must be an HTTPS origin on port 443`); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" ||
      url.pathname !== "/" || url.port !== "") {
    throw failure("KUBERNETES_URL_INVALID", `${label} must be a credential-free HTTPS origin on port 443`);
  }
  productionHost(url.hostname);
  return url.origin;
}

function safeScalar(value, label, maximum) {
  const normalized = required(value, label);
  if (normalized.length > maximum || !/^[A-Za-z0-9:/._-]+$/.test(normalized)) {
    throw failure("KUBERNETES_SCALAR_INVALID", `${label} is not a safe bounded YAML scalar`);
  }
  return normalized;
}

function identifier(value, label) {
  const normalized = required(value, label);
  if (!IDENTIFIER.test(normalized)) throw failure("KUBERNETES_IDENTIFIER_INVALID", `${label} is invalid`);
  return normalized;
}

function kubernetesName(value, label, maximum) {
  const normalized = required(value, label);
  if (normalized.length > maximum || !DNS_LABEL.test(normalized)) throw failure("KUBERNETES_NAME_INVALID", `${label} must be a DNS label`);
  return normalized;
}

function privateIpv4Cidr(value, label) {
  const normalized = required(value, label);
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/.exec(normalized);
  if (match === null) throw failure("KUBERNETES_CIDR_INVALID", `${label} must be a canonical private IPv4 CIDR`);
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || octets.map(String).some((octet, index) => octet !== match[index + 1])) {
    throw failure("KUBERNETES_CIDR_INVALID", `${label} must be a canonical private IPv4 CIDR`);
  }
  const privateAddress = octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
  if (!privateAddress) throw failure("KUBERNETES_CIDR_PUBLIC", `${label} must be one RFC1918 endpoint`);
  if (prefix !== 32) throw failure("KUBERNETES_CIDR_SCOPE_INVALID", `${label} must identify exactly one endpoint with /32`);
  return normalized;
}

function networkPort(value, label) {
  const normalized = required(String(value ?? ""), label);
  if (!/^\d+$/.test(normalized)) throw failure("KUBERNETES_PORT_INVALID", `${label} must be an integer port`);
  const port = Number(normalized);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw failure("KUBERNETES_PORT_INVALID", `${label} must be an integer port`);
  }
  return String(port);
}

function required(value, label) {
  if (typeof value !== "string" || value.trim() !== value || value === "" || /[\u0000-\u001f\u007f]/.test(value)) {
    throw failure("KUBERNETES_ARGUMENT_REQUIRED", `${label} is required`);
  }
  return value;
}

function parse(argv) {
  const result = { _: [] };
  for (const value of argv) {
    if (!value.startsWith("--")) { result._.push(value); continue; }
    const split = value.indexOf("=");
    if (split < 3) throw failure("KUBERNETES_ARGUMENT_INVALID", `Invalid argument ${value}`);
    const name = value.slice(2, split);
    if (result[name] !== undefined) throw failure("KUBERNETES_ARGUMENT_INVALID", `Duplicate argument --${name}`);
    result[name] = value.slice(split + 1);
  }
  return result;
}

function failure(code, message) {
  return new KubernetesProductionError(code, message);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const command = options._[0];
  let result;
  if (command === "render") {
    result = renderProductionManifests({
      output: options.output,
      apiImage: options["api-image"],
      workersImage: options["workers-image"],
      gatewayImage: options["gateway-image"],
      clientBrokerImage: options["client-broker-image"],
      migratorImage: options["migrator-image"],
      host: options.host,
      oidcIssuer: options["oidc-issuer"],
      oidcJwksUrl: options["oidc-jwks-url"],
      oidcAudience: options["oidc-audience"],
      oidcAuthorizationEndpoint: options["oidc-authorization-endpoint"],
      oidcTokenEndpoint: options["oidc-token-endpoint"],
      oidcClientId: options["oidc-client-id"],
      oidcRedirectUri: options["oidc-redirect-uri"],
      oidcScopes: options["oidc-scopes"],
      mediaSafetyScannerUrl: options["media-safety-scanner-url"],
      tenantId: options["tenant-id"],
      releaseId: options["release-id"],
      ingressClass: options["ingress-class"],
      ingressNamespace: options["ingress-namespace"],
      postgresCidr: options["postgres-cidr"],
      postgresPort: options["postgres-port"],
      redisCidr: options["redis-cidr"],
      redisPort: options["redis-port"],
    });
  } else if (command === "validate") {
    result = validateRenderedProductionManifests(options.directory);
  } else {
    throw failure("KUBERNETES_COMMAND_INVALID", "Command must be render or validate");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: "FAIL",
      code: error instanceof KubernetesProductionError ? error.code : "KUBERNETES_PRODUCTION_FAILED",
      error: error instanceof Error ? error.name : "UnknownError",
    })}\n`);
    process.exitCode = 1;
  });
}
