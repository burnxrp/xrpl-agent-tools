// prepack: ship the built web console inside the MCP package (served at http://127.0.0.1:7480 by the adapter).
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "../../../apps/console/dist"), to = join(here, "../console");
if (!existsSync(join(from, "index.html"))) { console.error("console not built — run `npm run build` at the repo root first"); process.exit(1); }
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true });
console.log("bundled console →", to);
