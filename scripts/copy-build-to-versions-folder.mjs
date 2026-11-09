// Moves the finished build of one platform into builds/v<version>/ (one folder for all builds of a version).
//   node scripts/copy-build-to-versions-folder.mjs <bundle folder> <os> <cpu>
//   os: darwin | linux | windows      cpu: aarch64 | x86_64
// Called by scripts/run-tauri.mjs after `build` and by scripts/docker-build.mjs after a Docker build.
//
// Files get their published names  <id>_<version>_<os>-<cpu>.<ext>  (the updater packages come with their
// .sig). The macOS .app is copied too, for testing. Afterwards builds/v<version>/latest.json is rewritten
// from what is in the folder, and the bundle folder is DELETED, so no installers are left in src-tauri.

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appInfo, root } from "./package-info.mjs";

const { id, name, version, repoUrl } = appInfo;
export const tag = `v${version}`;
export const versionFolder = resolve(root, "builds", tag);

// file name ending -> [is it the updater package?]
const kinds = {
  darwin: [[".dmg", false], [".app.tar.gz", true]],
  linux: [[".AppImage", true], [".deb", false], [".rpm", false]],
  windows: [["-setup.exe", true]],
};

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.name.endsWith(".app") ? [join(dir, e.name)] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

/** Rewrites latest.json (what the in-app updater reads) from the signed packages in the folder. */
export function writeUpdaterManifest() {
  const platforms = {};
  for (const [os, list] of Object.entries(kinds)) {
    for (const cpu of ["aarch64", "x86_64"]) {
      for (const [ending, updater] of list) {
        const file = `${id}_${version}_${os}-${cpu}${ending}`;
        if (updater && existsSync(join(versionFolder, file)) && existsSync(join(versionFolder, `${file}.sig`))) {
          platforms[`${os}-${cpu}`] = {
            signature: readFileSync(join(versionFolder, `${file}.sig`), "utf8").trim(),
            url: `${repoUrl}/releases/download/${tag}/${file}`,
          };
        }
      }
    }
  }
  writeFileSync(
    join(versionFolder, "latest.json"),
    JSON.stringify({ version, notes: `${name} ${tag}`, pub_date: new Date().toISOString(), platforms }, null, 2) + "\n",
  );
}

/** Moves this build into the version folder. Throws if the build is not of the current version. */
export function moveBuildToVersionsFolder(bundleDir, os, cpu) {
  if (!existsSync(bundleDir)) throw new Error(`No build output found in ${bundleDir}`);
  const files = walk(bundleDir);
  mkdirSync(versionFolder, { recursive: true });
  const moved = [];
  for (const [ending, updater] of kinds[os]) {
    // The macOS update package has no version in its name; the bundle folder was emptied before the build.
    const file = files.find(
      (f) => f.endsWith(ending) && !f.endsWith(".app") && (basename(f).includes(version) || (updater && os === "darwin")),
    );
    if (!file) continue;
    const published = `${id}_${version}_${os}-${cpu}${ending}`;
    copyFileSync(file, join(versionFolder, published));
    moved.push(published);
    if (updater) {
      if (existsSync(`${file}.sig`)) {
        copyFileSync(`${file}.sig`, join(versionFolder, `${published}.sig`));
      } else {
        console.warn(`! ${basename(file)} has no .sig file (built without a signing key?), so it is not in latest.json`);
      }
    }
  }
  if (!moved.length) throw new Error(`The build in ${bundleDir} contains nothing of version ${version}.`);
  const app = files.find((f) => f.endsWith(".app"));
  if (app) {
    const published = `${id}_${version}_${os}-${cpu}.app`;
    rmSync(join(versionFolder, published), { recursive: true, force: true });
    cpSync(app, join(versionFolder, published), { recursive: true, verbatimSymlinks: true });
    moved.push(published);
  }
  writeUpdaterManifest();
  rmSync(bundleDir, { recursive: true, force: true });
  console.log(`\nBuild of ${version} for ${os}-${cpu} is in ${versionFolder}\n  ${moved.sort().join("\n  ")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    moveBuildToVersionsFolder(resolve(process.argv[2] ?? ""), process.argv[3], process.argv[4]);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
