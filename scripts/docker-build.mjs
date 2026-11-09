#!/usr/bin/env node
// Builds the Linux or Windows release inside Docker, on this machine.
//   node scripts/docker-build.mjs <linux|windows> <x64|arm64>
// Result: release/docker/<os>-<arch>/ (collected into one release by scripts/release.mjs).
// The signing key is passed to the container through the environment, never copied into it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appInfo, root } from "./app-info.mjs";

const [os, arch] = process.argv.slice(2);

const targets = {
  linux: {
    x64: { platform: "linux/amd64", bundleDir: "src-tauri/target/release/bundle", args: ["--bundles", "appimage,deb,rpm"] },
    arm64: { platform: "linux/arm64", bundleDir: "src-tauri/target/release/bundle", args: ["--bundles", "appimage,deb,rpm"] },
  },
  windows: {
    x64: {
      bundleDir: "src-tauri/target/x86_64-pc-windows-msvc/release/bundle",
      args: ["--runner", "cargo-xwin", "--target", "x86_64-pc-windows-msvc", "--bundles", "nsis"],
    },
    arm64: {
      bundleDir: "src-tauri/target/aarch64-pc-windows-msvc/release/bundle",
      args: ["--runner", "cargo-xwin", "--target", "aarch64-pc-windows-msvc", "--bundles", "nsis"],
    },
  },
};

const target = targets[os]?.[arch];
if (!target) {
  console.error("Usage: node scripts/docker-build.mjs <linux|windows> <x64|arm64>");
  process.exit(1);
}

if (spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status !== 0) {
  console.error("Docker is not installed or not running. Install and start Docker Desktop, then try again.");
  process.exit(1);
}

// Signing key: from the environment, or keys/private.key. Releases must be signed.
const env = { ...process.env };
const keyFile = resolve(root, env.APP_SIGNING_KEY ?? "keys/private.key");
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  if (!existsSync(keyFile)) {
    console.error(`No signing key (${keyFile}). Create one first, see DEVELOPMENT.md.`);
    process.exit(1);
  }
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyFile, "utf8").trim();
}
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";

// One image per OS (and per CPU for Linux); named volumes keep the Rust build cache between runs.
const tag = os === "linux" ? `${appInfo.id}-build-linux-${arch}` : `${appInfo.id}-build-windows`;
const outDir = resolve(root, "release/docker", `${os}-${arch}`);
mkdirSync(outDir, { recursive: true });

const run = (args) => {
  const r = spawnSync("docker", args, { stdio: "inherit", env, cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
// Windows builds use /qbuild: clang-cl and NSIS mistake a path that starts with
// "/work" or "/x" for one of their own options and then fail.
const work = os === "windows" ? "/qbuild" : "/work";
const platform = target.platform ? ["--platform", target.platform] : [];

// buildx (BuildKit) keeps the x64 and arm64 base images apart; the classic builder mixes them up.
run(["buildx", "build", "--load", ...platform, "-f", `docker/${os}.Dockerfile`, "-t", tag, "docker"]);
run([
  "run", "--rm", ...platform,
  "-e", "TAURI_SIGNING_PRIVATE_KEY",
  "-e", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "-v", `${root}:/src:ro`,
  "-v", `${outDir}:/out`,
  "-e", `WORK_DIR=${work}`,
  "-v", `${tag}-target:${work}/src-tauri/target`,
  "-v", `${tag}-cargo:/usr/local/cargo/registry`,
  ...(os === "windows" ? ["-v", `${tag}-xwin:/xwin-cache`] : []),
  tag,
  "build.sh", target.bundleDir, ...target.args,
]);
console.log(`\nDone: ${outDir}`);
