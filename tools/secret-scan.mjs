import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

const root = process.cwd();
const scanExtensions = new Set([
  ".env", ".ini", ".java", ".js", ".json", ".md", ".mjs", ".properties", ".py",
  ".sql", ".toml", ".ts", ".tsx", ".yaml", ".yml",
]);
const ignoredSegments = new Set(["node_modules", "dist", "build", "coverage", ".next", ".git"]);
const ignoredFiles = new Set(["tools/secret-scan.mjs"]);
const patterns = [
  { name: "private-key", value: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "aws-access-key", value: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "github-token", value: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/ },
  { name: "google-api-key", value: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "openai-key", value: /\bsk-(?:live|prod|proj)-[A-Za-z0-9_-]{20,}\b/ },
  { name: "slack-token", value: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "credential-url", value: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/:]{2,}:[^\s/@]{8,}@/i },
];

const candidates = new Set([
  ...listFiles(["ls-files", "-z"]),
  ...listFiles(["ls-files", "--others", "--exclude-standard", "-z"]),
]);
const findings = [];
let filesScanned = 0;
for (const relativePath of [...candidates].sort()) {
  if (relativePath.length === 0 || ignoredFiles.has(relativePath)) continue;
  if (relativePath.split("/").some((segment) => ignoredSegments.has(segment))) continue;
  const extension = extname(relativePath).toLowerCase();
  if (!scanExtensions.has(extension) && !relativePath.endsWith(".env.example") && !relativePath.startsWith(".env")) continue;
  const absolutePath = resolve(root, relativePath);
  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    continue;
  }
  if (!stats.isFile() || stats.size > 2 * 1_024 * 1_024) continue;
  const content = readFileSync(absolutePath, "utf8");
  if (content.includes("\0")) continue;
  filesScanned += 1;
  for (const pattern of patterns) {
    const match = pattern.value.exec(content);
    if (match === null) continue;
    const matchEnd = (match.index ?? 0) + match[0].length;
    if (pattern.name === "credential-url" && relativePath.endsWith(".env.example") &&
        /^(?:localhost|127\.0\.0\.1)(?::|\/|$)/.test(content.slice(matchEnd))) continue;
    const lineStart = content.lastIndexOf("\n", match.index ?? 0) + 1;
    const lineEnd = content.indexOf("\n", match.index ?? 0);
    const matchedLine = content.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    // Explicitly annotated negative fixtures are reviewed exceptions, not a broad test-directory bypass.
    if (matchedLine.includes("secret-scan: allow-test-fixture")) continue;
    findings.push({ file: relative(root, absolutePath), kind: pattern.name });
  }
}

if (findings.length > 0) {
  for (const finding of findings) process.stderr.write(`SECRET_SCAN ${finding.kind} ${finding.file}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify({ status: "PASS", check: "secret-scan", filesScanned, findings: 0 })}\n`);
}

function listFiles(arguments_) {
  try {
    return execFileSync("git", arguments_, { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  } catch {
    process.stderr.write("SECRET_SCAN git file inventory failed\n");
    process.exitCode = 1;
    return [];
  }
}
