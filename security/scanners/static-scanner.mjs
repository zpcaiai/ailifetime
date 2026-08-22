import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";

const SEVERITY = Object.freeze({ info: 0, low: 1, medium: 2, high: 3, critical: 4 });
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx", ".java", ".py"]);
const IGNORED = new Set(["node_modules", "dist", "build", "coverage", ".git", ".next"]);

const SOURCE_RULES = [
  rule("LTM-SAST-001", "critical", /(?:(?<![.\w])eval\s*\(\s*(?![A-Za-z_$][\w$]*\s*:)|\bnew\s+Function\s*\()/, "dynamic code evaluation is forbidden"),
  rule("LTM-SAST-002", "critical", /rejectUnauthorized\s*:\s*false/, "TLS certificate verification is disabled"),
  rule("LTM-SAST-003", "high", /createHash\s*\(\s*["'](?:md5|sha1)["']\s*\)/i, "weak cryptographic hash is used in a security path"),
  rule("LTM-SAST-004", "high", /(?<![.\w])(?:exec|execSync)\s*\(\s*(?:request|input|body|query|params|payload)\b/, "untrusted data may reach a shell command"),
  rule("LTM-SAST-005", "critical", /(?:privateKey|secret|password|token)\s*[:=]\s*["'](?:prod|live)[-_][A-Za-z0-9+/=_-]{16,}["']/i, "production-looking credential is hard-coded"),
];

const CLIENT_RULES = [
  rule("LTM-CLIENT-001", "high", /(?:localStorage|sessionStorage)\.setItem\s*\(\s*["'][^"']*(?:token|auth|session|credential)/i, "authentication material is persisted in browser storage"),
  rule("LTM-CLIENT-002", "high", /document\.cookie\s*=/, "client code writes an authentication cookie without server cookie controls"),
  rule("LTM-CLIENT-003", "high", /^(?!.*escapeHtml).*\.innerHTML\s*=.*(?:location\.|searchParams|request\.|response\.|payload\.|message\b)/im, "potentially untrusted content reaches innerHTML without visible escaping"),
  rule("LTM-CLIENT-004", "critical", /rejectUnauthorized\s*:\s*false/, "client disables TLS certificate validation"),
];

const IAC_RULES = [
  rule("LTM-IAC-001", "critical", /^\s*privileged\s*:\s*true\s*$/im, "container runs privileged"),
  rule("LTM-IAC-002", "high", /^\s*network_mode\s*:\s*["']?host["']?\s*$/im, "container shares the host network"),
  rule("LTM-IAC-003", "high", /^\s*ADD\s+https?:\/\//im, "Docker build downloads an unverified remote resource"),
  rule("LTM-IAC-004", "high", /^\s*FROM\s+\S+:latest(?:\s|$)/im, "container base image uses the mutable latest tag"),
  rule("LTM-IAC-005", "critical", /^\s*(?:environment\s*:)?\s*(?:PASSWORD|PRIVATE_KEY|SECRET|TOKEN)\s*[:=]\s*[^${][^\s]{12,}\s*$/im, "IaC appears to embed a credential"),
  rule("LTM-IAC-006", "high", /^\s*image\s*:\s*[^\s#]+:latest(?:\s|$)/im, "Compose service uses the mutable latest image tag"),
  rule("LTM-IAC-007", "medium", /^\s*image\s*:\s*(?![^\s#]+@sha256:[a-f0-9]{64}(?:\s|$))[^\s#]+:[^\s#]+(?:\s|$)/im, "Compose image is versioned but not digest-pinned"),
];

export function scanRepository(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const findings = [];
  const coverage = {};
  scanSurface(root, "nativeSource", ["packages", "services"], SOURCE_RULES, findings, coverage);
  scanSurface(root, "frontend", ["apps/web/src", "apps/web/public"], CLIENT_RULES, findings, coverage);
  scanSurface(root, "mobile", ["apps/mobile/src"], CLIENT_RULES, findings, coverage);
  scanSurface(root, "mini", ["apps/wechat-mini/src"], CLIENT_RULES, findings, coverage);
  scanIac(root, findings, coverage);
  scanApi(root, findings, coverage);
  applyExternalEvidence(options, findings, coverage);
  const threshold = options.threshold ?? "high";
  if (!(threshold in SEVERITY)) throw new Error(`unsupported severity threshold: ${threshold}`);
  findings.sort((left, right) => `${left.file}:${left.line}:${left.ruleId}`.localeCompare(`${right.file}:${right.line}:${right.ruleId}`));
  const blocking = findings.filter((finding) => SEVERITY[finding.severity] >= SEVERITY[threshold]);
  const missingRequiredEvidence = Object.entries(coverage)
    .filter(([, value]) => value.required === true && value.status !== "scanned")
    .map(([name]) => name);
  return {
    version: "ltm.security-scan.v1",
    status: blocking.length > 0 ? "FAIL" : missingRequiredEvidence.length > 0 ? "NOT_RUN" : "PASS",
    nativeGuardrailsStatus: findings.filter((item) => item.engine === "native" && SEVERITY[item.severity] >= SEVERITY[threshold]).length === 0 ? "PASS" : "FAIL",
    threshold,
    coverage,
    missingRequiredEvidence,
    summary: countFindings(findings),
    blockingFindings: blocking.length,
    findings,
  };
}

export function toSarif(report) {
  const rules = [...new Map(report.findings.map((finding) => [finding.ruleId, {
    id: finding.ruleId,
    shortDescription: { text: finding.message },
    defaultConfiguration: { level: sarifLevel(finding.severity) },
  }])).values()];
  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [{
      tool: { driver: { name: "ltm-security-scan", version: "1", rules } },
      results: report.findings.map((finding) => ({
        ruleId: finding.ruleId,
        level: sarifLevel(finding.severity),
        message: { text: finding.message },
        locations: [{ physicalLocation: {
          artifactLocation: { uri: finding.file },
          region: { startLine: finding.line },
        } }],
        properties: { category: finding.category, severity: finding.severity },
      })),
    }],
  };
}

function scanSurface(root, category, paths, rules, findings, coverage) {
  let filesScanned = 0;
  for (const path of paths) {
    const absolute = resolve(root, path);
    if (!exists(absolute)) continue;
    for (const file of filesUnder(absolute, SOURCE_EXTENSIONS)) {
      filesScanned += 1;
      scanText(root, file, category, rules, findings);
    }
  }
  coverage[category] = { status: filesScanned > 0 ? "scanned" : "missing", filesScanned, engine: "native-guardrails", required: false };
  if (filesScanned === 0) findings.push(finding(category, "LTM-COVERAGE-001", "high", ".", 1, `${category} scan root is missing or empty`));
}

function scanIac(root, findings, coverage) {
  const files = [];
  for (const path of ["infra", "compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml", "services"]) {
    const absolute = resolve(root, path);
    if (!exists(absolute)) continue;
    if (statSync(absolute).isFile()) files.push(absolute);
    else {
      files.push(...filesUnder(absolute, new Set([".yaml", ".yml", ".tf", ".json"]), (file) => file.endsWith("Dockerfile")));
    }
  }
  const unique = [...new Set(files)];
  for (const file of unique) {
    scanText(root, file, "iac", IAC_RULES, findings);
    if (file.endsWith("Dockerfile")) scanDockerfile(root, file, findings);
  }
  coverage.nativeIac = { status: unique.length > 0 ? "scanned" : "missing", filesScanned: unique.length, engine: "native-guardrails", required: false };
  coverage.containerDefinitions = {
    status: unique.some((file) => file.endsWith("Dockerfile")) ? "definition_scanned" : "missing",
    filesScanned: unique.filter((file) => file.endsWith("Dockerfile")).length,
    note: "This is not an OCI vulnerability scan; CI must supply Trivy image reports.",
    engine: "native-guardrails",
    required: false,
  };
}

function scanDockerfile(root, file, findings) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const stages = [];
  let current;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*FROM\s+/i.test(lines[index])) {
      current = { line: index + 1, user: undefined, from: lines[index].trim() };
      stages.push(current);
    } else if (current !== undefined && /^\s*USER\s+/i.test(lines[index])) current.user = lines[index].trim();
  }
  const runtime = stages.at(-1);
  const path = relative(root, file).split(sep).join("/");
  if (runtime === undefined) findings.push(finding("container", "LTM-CONTAINER-001", "high", path, 1, "Dockerfile has no build stage"));
  else if (runtime.user === undefined || /^USER\s+(?:0|root)(?::|\s|$)/i.test(runtime.user)) {
    findings.push(finding("container", "LTM-CONTAINER-002", "high", path, runtime.line, "runtime image does not declare a non-root user"));
  }
  for (const stage of stages) {
    if (!/@sha256:[a-f0-9]{64}(?:\s|$)/i.test(stage.from)) {
      findings.push(finding("container", "LTM-CONTAINER-003", "medium", path, stage.line, "base image tag is versioned but not digest-pinned"));
    }
  }
}

function scanApi(root, findings, coverage) {
  const openapiPath = resolve(root, "services/api/openapi.yaml");
  const serverPath = resolve(root, "services/api/src/server.ts");
  let filesScanned = 0;
  if (!exists(openapiPath)) findings.push(finding("api", "LTM-API-001", "high", "services/api/openapi.yaml", 1, "OpenAPI contract is missing"));
  else {
    filesScanned += 1;
    const text = readFileSync(openapiPath, "utf8");
    requireApiToken(text, /bearerAuth:\s*\n\s+type:\s*http\s*\n\s+scheme:\s*bearer/, "LTM-API-002", "OpenAPI bearer security scheme is missing", findings);
    for (const path of ["/v1/capabilities:", "/v1/capabilities/{batchId}:", "/v1/commands:"]) {
      const section = yamlPathSection(text, path);
      if (!/\n\s{4}post:\s/.test(`\n${section}`) || !/\n\s{6}security:\s/.test(`\n${section}`) || !/IdempotencyKey/.test(section)) {
        findings.push(finding("api", "LTM-API-003", "high", "services/api/openapi.yaml", lineOf(text, path), `${path} must declare bearer security and idempotency`));
      }
    }
    const unsafeServer = /^\s*-\s+url:\s+http:\/\/(?!127\.0\.0\.1|localhost|\[::1\])/m.exec(text);
    if (unsafeServer !== null) findings.push(finding("api", "LTM-API-004", "high", "services/api/openapi.yaml", lineAt(text, unsafeServer.index), "OpenAPI advertises clear-text non-loopback HTTP"));
  }
  if (!exists(serverPath)) findings.push(finding("api", "LTM-API-005", "high", "services/api/src/server.ts", 1, "API server security controls are missing"));
  else {
    filesScanned += 1;
    const text = readFileSync(serverPath, "utf8");
    for (const [token, ruleId] of [["content-security-policy", "LTM-API-006"], ["x-content-type-options", "LTM-API-007"], ["FORBIDDEN_CONTEXT_HEADERS", "LTM-API-008"], ["timingSafeEqual", "LTM-API-009"]]) {
      if (!text.includes(token)) findings.push(finding("api", ruleId, "high", "services/api/src/server.ts", 1, `API is missing required control ${token}`));
    }
  }
  coverage.nativeApi = { status: filesScanned === 2 ? "scanned" : "incomplete", filesScanned, engine: "native-contract", required: false };
}

function applyExternalEvidence(options, findings, coverage) {
  coverage.secret = externalStatus(options.secretReport, "repository secret scan", (report) => {
    if (report.status !== "PASS" || report.findings !== 0 || !Number.isSafeInteger(report.filesScanned) || report.filesScanned < 1) throw new Error("secret scan report is not a passing non-empty scan");
  });
  coverage.sast = externalStatus(options.codeqlSarif, "CodeQL SARIF", (report) => scanSarif(report, findings));
  if (options.auditJson !== undefined) scanAudit(options.auditJson, findings, coverage);
  else coverage.sca = missingExternal("pnpm audit JSON");
  coverage.iac = externalStatus(options.trivyConfigReport, "Trivy IaC/config JSON", (report) => scanTrivy(report, findings, "iac"));
  const imageReports = options.trivyImageReports ?? [];
  if (imageReports.length < (options.expectedImageCount ?? 3)) coverage.container = missingExternal(`Trivy image JSON (${options.expectedImageCount ?? 3} images required, ${imageReports.length} supplied)`);
  else {
    const artifactNames = imageReports.map((report) => report?.ArtifactName);
    if (artifactNames.some((name) => typeof name !== "string") || new Set(artifactNames).size !== imageReports.length) throw new Error("Trivy image evidence must cover distinct OCI artifacts");
    if ((options.expectedImageNames ?? []).some((name) => !artifactNames.includes(name))) throw new Error("Trivy image evidence does not cover every expected OCI artifact");
    for (const report of imageReports) scanTrivy(report, findings, "container");
    coverage.container = { status: "scanned", required: true, engine: "trivy", reports: imageReports.length, artifacts: artifactNames.sort() };
  }
  coverage.dast = externalStatus(options.dastReport, "DAST JSON", (report) => {
    const required = ["auth", "tenant_idor", "upload_signed_url", "webhook_payment", "ssrf", "xss", "csrf", "admin"];
    if (report.version !== "ltm.dast-report.v1" || report.status !== "PASS" || required.some((item) => !report.coveredCategories?.includes(item))) {
      throw new Error("DAST report is missing a passing mandatory attack category");
    }
  });
  coverage.api = combineCoverage("nativeApi", coverage.nativeApi, coverage.dast);
  for (const category of ["frontend", "mobile", "mini"]) coverage[category] = { ...coverage[category], required: true };
}

function scanAudit(input, findings, coverage) {
  const audit = typeof input === "string" ? JSON.parse(readFileSync(input, "utf8")) : input;
  const vulnerabilities = audit?.metadata?.vulnerabilities ?? audit?.vulnerabilities ?? {};
  if (audit?.metadata === undefined || audit.metadata.vulnerabilities === undefined || !Number.isSafeInteger(audit.metadata.totalDependencies) || audit.metadata.totalDependencies < 1 ||
      ["info", "low", "moderate", "high", "critical"].some((key) => !Number.isSafeInteger(audit.metadata.vulnerabilities[key]) || audit.metadata.vulnerabilities[key] < 0)) {
    throw new Error("pnpm audit evidence is empty, incomplete, or not a successful registry response");
  }
  const critical = number(vulnerabilities.critical);
  const high = number(vulnerabilities.high);
  if (critical > 0) findings.push(finding("sca", "LTM-SCA-001", "critical", "pnpm-lock.yaml", 1, `dependency audit reports ${critical} critical vulnerabilities`));
  if (high > 0) findings.push(finding("sca", "LTM-SCA-002", "high", "pnpm-lock.yaml", 1, `dependency audit reports ${high} high vulnerabilities`));
  if (audit?.advisories !== undefined) {
    for (const advisory of Object.values(audit.advisories)) {
      const severity = String(advisory?.severity ?? "").toLowerCase();
      if (severity === "critical" || severity === "high") {
        findings.push(finding("sca", "LTM-SCA-003", severity, "pnpm-lock.yaml", 1, `dependency advisory ${advisory.id ?? "unknown"}: ${advisory.title ?? "security vulnerability"}`));
      }
    }
  }
  coverage.sca = { status: "scanned", filesScanned: 1, required: true, engine: "pnpm-audit" };
}

function scanSarif(report, findings) {
  if (report?.version !== "2.1.0" || !Array.isArray(report.runs) || report.runs.length === 0) throw new Error("CodeQL SARIF is empty or invalid");
  for (const run of report.runs) {
    if (!String(run?.tool?.driver?.name ?? "").toLowerCase().includes("codeql")) throw new Error("SAST evidence must be produced by CodeQL");
    for (const result of run.results ?? []) {
      const securitySeverity = Number(result?.properties?.["security-severity"] ?? result?.properties?.securitySeverity ?? 0);
      const level = String(result?.level ?? "warning").toLowerCase();
      if (level === "error" || securitySeverity >= 7) {
        findings.push({ category: "sast", ruleId: String(result.ruleId ?? "CODEQL"), severity: securitySeverity >= 9 ? "critical" : "high", file: String(result.locations?.[0]?.physicalLocation?.artifactLocation?.uri ?? "codeql"), line: Number(result.locations?.[0]?.physicalLocation?.region?.startLine ?? 1), message: String(result.message?.text ?? "CodeQL security finding"), engine: "codeql" });
      }
    }
  }
}

function scanTrivy(report, findings, category) {
  if (!Number.isSafeInteger(report?.SchemaVersion) || report.SchemaVersion < 2 || typeof report.ArtifactName !== "string" || report.ArtifactName.trim() === "" ||
      typeof report.ArtifactType !== "string" || report.ArtifactType.trim() === "" || !Number.isFinite(Date.parse(report.CreatedAt)) ||
      (report.Results !== null && report.Results !== undefined && !Array.isArray(report.Results))) {
    throw new Error(`Trivy ${category} report is empty or invalid`);
  }
  for (const result of report.Results ?? []) {
    for (const item of [...(result.Vulnerabilities ?? []), ...(result.Misconfigurations ?? []), ...(result.Secrets ?? [])]) {
      const severity = String(item.Severity ?? "UNKNOWN").toLowerCase();
      if (severity === "high" || severity === "critical") findings.push({ category, ruleId: String(item.VulnerabilityID ?? item.ID ?? item.RuleID ?? "TRIVY"), severity, file: String(result.Target ?? "trivy"), line: Number(item.StartLine ?? item.CauseMetadata?.StartLine ?? 1), message: String(item.Title ?? item.Message ?? item.Description ?? `Trivy ${category} finding`), engine: "trivy" });
    }
  }
}

function externalStatus(report, label, validate) {
  if (report === undefined) return missingExternal(label);
  validate(report);
  return { status: "scanned", required: true, engine: label.toLowerCase().replaceAll(" ", "-") };
}

function missingExternal(label) { return { status: "not_run", required: true, engine: label, reason: `${label} was not supplied` }; }
function combineCoverage(name, native, dynamic) { return { status: native.status === "scanned" && dynamic.status === "scanned" ? "scanned" : "not_run", required: true, engine: `${name}+dast`, components: { native: native.status, dynamic: dynamic.status } }; }

function scanText(root, file, category, rules, findings) {
  const text = readFileSync(file, "utf8");
  const path = relative(root, file).split(sep).join("/");
  for (const candidate of rules) {
    const match = candidate.pattern.exec(text);
    candidate.pattern.lastIndex = 0;
    if (match !== null) findings.push(finding(category, candidate.id, candidate.severity, path, lineAt(text, match.index), candidate.message));
  }
}

function filesUnder(root, extensions, additional = () => false) {
  if (statSync(root).isFile()) return [root];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED.has(entry.name)) continue;
      const child = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && (extensions.has(extname(entry.name).toLowerCase()) || additional(child))) files.push(child);
    }
  };
  visit(root);
  return files;
}

function yamlPathSection(text, path) {
  const start = text.indexOf(`  ${path}`);
  if (start < 0) return "";
  const rest = text.slice(start + 2);
  const next = rest.slice(path.length).search(/^  \/[^\n]+:\s*$/m);
  return next < 0 ? rest : rest.slice(0, path.length + next);
}

function requireApiToken(text, pattern, ruleId, message, findings) {
  if (!pattern.test(text)) findings.push(finding("api", ruleId, "high", "services/api/openapi.yaml", 1, message));
}

function rule(id, severity, pattern, message) { return { id, severity, pattern, message }; }
function finding(category, ruleId, severity, file, line, message) { return { category, ruleId, severity, file, line, message, engine: "native" }; }
function exists(path) { try { statSync(path); return true; } catch { return false; } }
function lineAt(text, index) { return text.slice(0, index).split("\n").length; }
function lineOf(text, token) { const index = text.indexOf(token); return index < 0 ? 1 : lineAt(text, index); }
function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function countFindings(findings) {
  const result = { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: findings.length };
  for (const item of findings) result[item.severity] += 1;
  return result;
}
function sarifLevel(severity) { return severity === "critical" || severity === "high" ? "error" : severity === "medium" ? "warning" : "note"; }
