#!/usr/bin/env node
// Builds the Linux or Windows release inside Docker, on this machine.
//   node scripts/docker-build.mjs <linux|windows> <x64|arm64>
// Result: the installers in builds/v<version>/ (see scripts/copy-build-to-versions-folder.mjs).
// The signing key is passed to the container through the environment, never copied into it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { appInfo, root } from "./package-info.mjs";
import { ensureYtdlp } from "./fetch-ytdlp.mjs";
import { moveBuildToVersionsFolder } from "./copy-build-to-versions-folder.mjs";

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

// Docker without Docker Desktop (for example Colima) often leaves "credsStore": "desktop" in
// ~/.docker/config.json, which makes every image pull fail ("docker-credential-desktop not found").
// If that helper is missing, use a temporary copy of the config without it for our docker calls.
// The real config is never changed.
const dockerEnv = { ...process.env };
try {
  const dockerDir = process.env.DOCKER_CONFIG ?? join(homedir(), ".docker");
  const cfgFile = join(dockerDir, "config.json");
  const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : {};
  const helper = cfg.credsStore && `docker-credential-${cfg.credsStore}`;
  const onPath = (bin) =>
    (process.env.PATH ?? "").split(delimiter).some((d) => existsSync(join(d, process.platform === "win32" ? `${bin}.exe` : bin)));
  if (helper && !onPath(helper)) {
    const host = spawnSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8" }).stdout?.trim();
    const tmp = mkdtempSync(join(tmpdir(), "docker-config-"));
    delete cfg.credsStore;
    cfg.cliPluginsExtraDirs = [
      ...(cfg.cliPluginsExtraDirs ?? []),
      join(dockerDir, "cli-plugins"),
      "/opt/homebrew/lib/docker/cli-plugins",
      "/usr/local/lib/docker/cli-plugins",
    ];
    writeFileSync(join(tmp, "config.json"), JSON.stringify(cfg));
    dockerEnv.DOCKER_CONFIG = tmp;
    if (host && !dockerEnv.DOCKER_HOST) dockerEnv.DOCKER_HOST = host;
    console.log(`Docker credentials helper "${helper}" is missing: using a temporary Docker config (yours is unchanged).`);
  }
} catch {
  /* fall through to the normal docker calls */
}

if (spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore", env: dockerEnv }).status !== 0) {
  console.error("Docker is not installed or not running. Install and start Docker Desktop, then try again.");
  process.exit(1);
}

// Signing key: from the environment, or keys/private.key. Releases must be signed.
const env = { ...dockerEnv };
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
// The container leaves its installers here; they are moved into builds/v<version>/ afterwards.
const outDir = resolve(root, "builds", `.docker-${os}-${arch}`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// yt-dlp is downloaded here, on the host, and copied into the build with the sources: the
// container then needs no internet access for it (and a failed download stops the release early).
const ytdlpTarget = {
  linux: { x64: "x86_64-unknown-linux-gnu", arm64: "aarch64-unknown-linux-gnu" },
  windows: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
}[os][arch];
try {
  await ensureYtdlp([ytdlpTarget]);
} catch (e) {
  console.error(`Could not get yt-dlp: ${e.message ?? e}`);
  process.exit(1);
}

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
try {
  moveBuildToVersionsFolder(outDir, os, arch === "arm64" ? "aarch64" : "x86_64");
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}
