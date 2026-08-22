import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "public/assets");
const surface = readFileSync(resolve(root, "dist/surface.js"), "utf8");
const surfaceHash = createHash("sha256").update(surface).digest("hex").slice(0, 12);
const surfaceName = `surface-${surfaceHash}.js`;
const appSource = readFileSync(resolve(root, "dist/app.js"), "utf8");
const app = appSource.replace('from "./surface.js"', `from "./${surfaceName}"`);

if (app === appSource) throw new Error("Compiled app does not import the surface module");
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, surfaceName), surface, "utf8");
writeFileSync(resolve(output, "app.js"), app, "utf8");
console.log(`Built app.js with immutable ${surfaceName}`);
