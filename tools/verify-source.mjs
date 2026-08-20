import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const roots = ["apps", "services", "packages", "infra"];
const productionExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".java", ".py", ".sql", ".yaml", ".yml"]);
const ignoredParts = new Set(["node_modules", "dist", "build", "coverage", ".next", "__pycache__"]);
const placeholderPattern = /\b(?:TO ?DO|FIX ?ME|NotImplemented(?:Error)?|hardcoded[_ -]?success)\b/i;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-(?:live|prod)-[A-Za-z0-9_-]{12,}\b/,
];

const findings = [];
for (const folder of roots) await scan(join(root, folder));

if (findings.length > 0) {
  for (const finding of findings) process.stderr.write(`SOURCE_GATE ${finding}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("PASS source placeholder and secret gate\n");
}

async function scan(path) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (ignoredParts.has(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await scan(child);
      continue;
    }
    if (!productionExtensions.has(extname(entry.name)) || /(?:^|\.)test\.[^.]+$/.test(entry.name)) continue;
    const text = await readFile(child, "utf8");
    if (placeholderPattern.test(text)) findings.push(`${relative(root, child)} contains a placeholder marker`);
    for (const pattern of secretPatterns) {
      if (pattern.test(text)) findings.push(`${relative(root, child)} resembles a committed secret`);
    }
  }
}
