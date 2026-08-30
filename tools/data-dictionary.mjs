#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DICTIONARY, validateDataDictionary } from "../packages/core/dist/index.js";

const productRoot = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = resolve(productRoot, ".artifacts/data-contracts");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

const validation = validateDataDictionary();
const contract = Object.freeze({
  schemaVersion: "ltm.data-dictionary.v1",
  runtimeSchemaVersion: 7,
  tables: DATA_DICTIONARY,
});
const serialized = `${canonical(contract)}\n`;
const sha256 = createHash("sha256").update(serialized).digest("hex");
const markdown = [
  "# Generated data dictionary",
  "",
  `Schema: \`${contract.schemaVersion}\` · runtime schema: \`${contract.runtimeSchemaVersion}\` · SHA-256: \`${sha256}\``,
  "",
  "| Table | Field | Classification | Retention policy | Encryption control | Allowed purposes |",
  "|---|---|---|---|---|---|",
  ...contract.tables.flatMap((table) => table.fields.map((field) =>
    `| ${table.table} | ${field.field} | ${field.classification} | ${field.retentionPolicy} | ${field.encryptionControl} | ${field.allowedPurposes.join(", ")} |`,
  )),
  "",
].join("\n");

await atomicWrite(resolve(outputRoot, "data-dictionary.json"), serialized);
await atomicWrite(resolve(outputRoot, "data-dictionary.md"), markdown);
await atomicWrite(resolve(outputRoot, "manifest.json"), `${canonical({
  schemaVersion: "ltm.data-contract-manifest.v1",
  dictionarySha256: sha256,
  ...validation,
})}\n`);
process.stdout.write(`${JSON.stringify({ status: "GENERATED", output: outputRoot, sha256, ...validation })}\n`);
