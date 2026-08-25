import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "public/assets");
const surface = readFileSync(resolve(root, "dist/surface.js"), "utf8");
const surfaceHash = createHash("sha256").update(surface).digest("hex").slice(0, 12);
const surfaceName = `surface-${surfaceHash}.js`;
const authentication = readFileSync(resolve(root, "dist/auth.js"), "utf8");
const authenticationHash = createHash("sha256").update(authentication).digest("hex").slice(0, 12);
const authenticationName = `auth-${authenticationHash}.js`;
const appSource = readFileSync(resolve(root, "dist/app.js"), "utf8");
const app = appSource
  .replace('from "./surface.js"', `from "./${surfaceName}"`)
  .replace('from "./auth.js"', `from "./${authenticationName}"`);

if (!app.includes(`from "./${surfaceName}"`) || !app.includes(`from "./${authenticationName}"`)) {
  throw new Error("Compiled app does not import the expected browser modules");
}
mkdirSync(output, { recursive: true });
for (const entry of readdirSync(output, { withFileTypes: true })) {
  if (entry.isFile() && (entry.name === "app.js" || /^(?:auth|surface)(?:-[a-f0-9]{8,64})?\.js$/.test(entry.name))) {
    unlinkSync(resolve(output, entry.name));
  }
}
writeFileSync(resolve(output, surfaceName), surface, "utf8");
writeFileSync(resolve(output, authenticationName), authentication, "utf8");
writeFileSync(resolve(output, "app.js"), app, "utf8");
console.log(`Built app.js with immutable ${surfaceName} and ${authenticationName}`);
