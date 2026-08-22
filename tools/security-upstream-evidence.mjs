#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { verifyUpstreamControlEvidence } from "../security/upstream-control-evidence.mjs";

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const trustStorePath = resolve(options["trust-store"] ?? "security/upstream-controls/trusted-keys.json");
  const trustStore = JSON.parse(readFileSync(trustStorePath, "utf8"));
  if (options.bundle === undefined) return emit(
    verifyUpstreamControlEvidence({ bundle: undefined, trustStore }),
    options,
  );
  const bundlePath = resolve(options.bundle);
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  const artifactRoot = realpathSync(resolve(options["artifact-root"] ?? dirname(bundlePath)));
  const result = verifyUpstreamControlEvidence({
    bundle,
    trustStore,
    requiredEnvironment: options.environment ?? "production",
    artifactResolver: (artifactPath) => {
      if (isAbsolute(artifactPath)) throw new Error("operational report artifact paths must be relative to the evidence root");
      const target = resolve(artifactRoot, artifactPath);
      const lexicalRelative = relative(artifactRoot, target);
      if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("operational report artifact path escapes the evidence root");
      const canonicalTarget = realpathSync(target);
      const canonicalRelative = relative(artifactRoot, canonicalTarget);
      if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("operational report artifact symlink escapes the evidence root");
      return readFileSync(canonicalTarget);
    },
  });
  return emit(result, options);
}

function emit(result, options) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "BLOCKED_EXTERNAL" && options["allow-blocked"] !== "true") process.exitCode = 2;
  return result;
}

function parse(argv) {
  const result = {};
  for (const item of argv) {
    if (!item.startsWith("--") || !item.includes("=")) throw new Error(`invalid argument: ${item}`);
    const split = item.indexOf("=");
    result[item.slice(2, split)] = item.slice(split + 1);
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) {
    process.stderr.write(`SECURITY_UPSTREAM_EVIDENCE ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error && typeof error === "object" && error.code === "ENOENT" ? 2 : 1;
  }
}
