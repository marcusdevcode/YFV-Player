#!/usr/bin/env node
// Gathers every finished build into release/v<version>/ and writes latest.json for the updater.
//   node scripts/collect-release.mjs
// Finds: the macOS builds in src-tauri/target, and the Docker builds in release/docker/.
// Nothing is uploaded. At the end it prints the command to publish the release yourself.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, copyFileSync, writeFileSync, statSync } from "node:fs";
import { arch as hostArch, platform as hostPlatform } from "node:os";
import { basename, join, resolve } from "node:path";
import { appInfo, root } from "./package-info.mjs";

const { id, name, version, repoUrl } = appInfo;
const tag = `v${version}`;
const releaseRoot = resolve(root, "release");
const outDir = resolve(releaseRoot, tag);

const hostCpu = hostArch() === "arm64" ? "aarch64" : "x86_64";
const t = (p) => resolve(root, p);

// Where each build leaves its files, and what it is.
const sources = [
  { dir: t("src-tauri/target/aarch64-apple-darwin/release/bundle"), os: "darwin", arch: "aarch64" },
  { dir: t("src-tauri/target/x86_64-apple-darwin/release/bundle"), os: "darwin", arch: "x86_64" },
  ...(hostPlatform() === "darwin" ? [{ dir: t("src-tauri/target/release/bundle"), os: "darwin", arch: hostCpu }] : []),
  { dir: t("release/docker/linux-x64"), os: "linux", arch: "x86_64" },
  { dir: t("release/docker/linux-arm64"), os: "linux", arch: "aarch64" },
  { dir: t("release/docker/windows-x64"), os: "windows", arch: "x86_64" },
  { dir: t("release/docker/windows-arm64"), os: "windows", arch: "aarch64" },
];

// file name ending -> [published extension, is it the updater package?]
const kinds = {
  darwin: [[".dmg", ".dmg", false], [".app.tar.gz", ".app.tar.gz", true]],
  linux: [[".AppImage", ".AppImage", true], [".deb", ".deb", false], [".rpm", ".rpm", false]],
  windows: [["-setup.exe", "-setup.exe", true]],
};

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const platforms = {};
const found = new Set();
const missing = [];

for (const src of sources) {
  const label = `${src.os}-${src.arch}`;
  if (found.has(label) || !existsSync(src.dir)) continue;
  const files = walk(src.dir);
  // A build of this version has the version in some file name; otherwise it is old.
  if (!files.some((f) => basename(f).includes(version))) continue;

  for (const [suffix, ext, updater] of kinds[src.os]) {
    const file = files.find((f) => f.endsWith(suffix) && (updater || basename(f).includes(version)));
    if (!file) continue;
    const published = `${id}_${version}_${src.os}-${src.arch}${ext}`;
    copyFileSync(file, join(outDir, published));
    if (updater) {
      const sig = `${file}.sig`;
      if (!existsSync(sig)) {
        console.warn(`! ${basename(file)} has no .sig file (built without a signing key?), so it is not in latest.json`);
        continue;
      }
      platforms[`${src.os}-${src.arch}`] = {
        signature: readFileSync(sig, "utf8").trim(),
        url: `${repoUrl}/releases/download/${tag}/${published}`,
      };
    }
  }
  found.add(label);
}

for (const l of ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "linux-aarch64", "windows-x86_64", "windows-aarch64"]) {
  if (!found.has(l)) missing.push(l);
}

if (found.size === 0) {
  console.error(`No builds of version ${version} found. Build first, see DEVELOPMENT.md.`);
  process.exit(1);
}

writeFileSync(
  join(outDir, "latest.json"),
  JSON.stringify({ version, notes: `${name} ${tag}`, pub_date: new Date().toISOString(), platforms }, null, 2) + "\n",
);

console.log(`\nRelease ${tag}: ${outDir}`);
for (const f of readdirSync(outDir).sort()) {
  console.log(`  ${f}  (${(statSync(join(outDir, f)).size / 1048576).toFixed(1)} MB)`);
}
// A new release replaces the old ones on disk: remove the other release/v<version> folders.
for (const entry of readdirSync(releaseRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && /^v\d+\.\d+\.\d+/.test(entry.name) && entry.name !== tag) {
    rmSync(join(releaseRoot, entry.name), { recursive: true, force: true });
    console.log(`Removed old release folder ${entry.name}`);
  }
}

if (missing.length) console.warn(`\nNot included (not built): ${missing.join(", ")}`);
console.log(`\nPublish it yourself (needs the GitHub CLI, logged in as you):

  gh release create ${tag} release/${tag}/* --repo ${repoUrl.replace("https://github.com/", "")} --title "${name} ${tag}" --notes "${name} ${tag}"
`);
