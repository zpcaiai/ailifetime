#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { captureLocalOciArtifacts, verifyOciArtifactManifest } from "../security/oci-artifacts.mjs";
import { stableJson } from "../security/lib/canonical.mjs";

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const command = options._[0] ?? "capture";
  let result;
  if (command === "capture") {
    const images = values(options.image).map((item) => {
      const split = item.indexOf("=");
      if (split < 1) throw new Error("--image must use role=reference");
      return { role: item.slice(0, split), reference: item.slice(split + 1) };
    });
    const manifest = captureLocalOciArtifacts(images, { environment: one(options.environment) ?? "ci" });
    const output = one(options.out);
    if (output === undefined) throw new Error("--out is required");
    const target = resolve(output); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, stableJson(manifest), { mode: 0o600 });
    result = verifyOciArtifactManifest(manifest, { environment: one(options.environment) ?? "ci" });
  } else if (command === "verify") {
    const path = one(options.manifest); if (path === undefined) throw new Error("--manifest is required");
    result = verifyOciArtifactManifest(JSON.parse(readFileSync(resolve(path), "utf8")), { environment: one(options.environment) });
  } else throw new Error(`unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === "BLOCKED_EXTERNAL") process.exitCode = 2;
  return result;
}
function parse(argv) { const result = { _: [] }; for (const item of argv) { if (!item.startsWith("--")) result._.push(item); else { const split = item.indexOf("="); if (split < 0) throw new Error(`invalid argument: ${item}`); const key = item.slice(2, split); const value = item.slice(split + 1); result[key] = result[key] === undefined ? value : [...values(result[key]), value]; } } return result; }
function values(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function one(value) { const list = values(value); if (list.length > 1) throw new Error("argument may only be supplied once"); return list[0]; }
if (import.meta.url === `file://${process.argv[1]}`) { try { main(); } catch (error) { process.stderr.write(`SECURITY_IMAGE_MANIFEST ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; } }
