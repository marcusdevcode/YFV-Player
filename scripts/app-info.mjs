// Single reader of package.json: the only place the app's name, version and repository are defined.
// Everything else (Vite, the Tauri wrapper, CI) gets its values from here.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const repoUrl = String(typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url ?? "")
  .replace(/^git\+/, "")
  .replace(/\.git$/, "");
const authorName = String(typeof pkg.author === "string" ? pkg.author : pkg.author?.name ?? "").toLowerCase();

export const appInfo = {
  /** package.json "name": used for storage keys, identifiers and file names. */
  id: pkg.name,
  /** Display name: package.json "productName" (falls back to the capitalised name). */
  name: pkg.productName ?? pkg.name.charAt(0).toUpperCase() + pkg.name.slice(1),
  version: pkg.version,
  /** Reverse-DNS bundle identifier, built from the author and the package name. */
  identifier: `com.${authorName.replace(/[^a-z0-9]/g, "")}.${pkg.name.replace(/[^a-z0-9]/g, "")}`,
  repoUrl,
  updaterEndpoint: `${repoUrl}/releases/latest/download/latest.json`,
};

// `node scripts/app-info.mjs <field>` prints one field (used by the CI workflow).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const field = process.argv[2];
  if (!field || !(field in appInfo)) {
    console.error(`Usage: node scripts/app-info.mjs <${Object.keys(appInfo).join("|")}>`);
    process.exit(1);
  }
  console.log(appInfo[field]);
}
