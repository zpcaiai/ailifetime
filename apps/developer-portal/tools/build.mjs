import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDeveloperPortal } from "../dist/portal.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = resolve(root, "public");
await mkdir(publicRoot, { recursive: true });
const html = renderDeveloperPortal({
  documentationVersion: "1.0.0", contractSha256: "local-synthetic-contract".padEnd(64, "0"), productionCredentialEligible: false,
  applications: [{ id: "sandbox-app", partnerId: "partner-synthetic", name: "Synthetic quickstart", environment: "sandbox", status: "ACTIVE", requestCount: 0, errorCount: 0 }],
  webhookDeliveries: [], connectors: [], certifications: [],
  status: ["api", "webhook", "sandbox", "documentation", "sdk"].map((component) => ({ component, state: "LOCAL_SANDBOX" })),
}, { partnerId: "partner-synthetic", actorId: "developer-synthetic", roles: ["developer"] });
await writeFile(resolve(publicRoot, "index.html"), html, { encoding: "utf8", mode: 0o644 });
