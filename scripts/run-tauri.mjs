#!/usr/bin/env node
// The only way Tauri is run (`npm run tauri`, `npm run dev`, `npm run build:*`, CI).
//
// It injects everything that comes from package.json (product name, bundle identifier, version,
// window title, updater endpoint) through the CLI's --config option, so none of it
// is written in src-tauri/tauri.conf.json. It also keeps src-tauri/Cargo.toml's version in sync.
//
// The updater public key comes from keys/public.pub (committed). For `build`, the private key
// comes from, in order:
//   1. TAURI_SIGNING_PRIVATE_KEY already set in the environment (CI) -> used as is.
//   2. keys/private.key (git-ignored; or the path in APP_SIGNING_KEY) -> used.
//   3. no key at all -> builds WITHOUT update files (fine for local test builds).
//
// Extra arguments go to the Tauri CLI, e.g. `npm run build:app -- --bundles app`.
// If your key has a password, set TAURI_SIGNING_PRIVATE_KEY_PASSWORD.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { appInfo, root } from "./package-info.mjs";
import { ensureYtdlp, hostTarget } from "./fetch-ytdlp.mjs";
import { moveBuildToVersionsFolder } from "./copy-build-to-versions-folder.mjs";

const args = process.argv.slice(2);
const env = { ...process.env };

// --- config injected from package.json -------------------------------------------------------
const baseConfig = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
const pubFile = resolve(root, "keys/public.pub");
if (!existsSync(pubFile)) {
  console.error("keys/public.pub is missing. Create the signing keys first (see DEVELOPMENT.md).");
  process.exit(1);
}

const config = {
  productName: appInfo.name,
  identifier: appInfo.identifier,
  version: appInfo.version,
  app: {
    windows: (baseConfig.app?.windows ?? []).map((w) => ({ ...w, title: appInfo.name })),
  },
  bundle: {
    // The yt-dlp program for YouTube search and downloads (fetched below, one file per target).
    externalBin: ["binaries/yt-dlp"],
    // Lets the signed yt-dlp load the Python it unpacks at run time (see the file for why).
    macOS: { entitlements: "macos-entitlements.plist" },
    copyright: appInfo.copyright,
    shortDescription: appInfo.description,
    longDescription: appInfo.description,
  },
  plugins: {
    updater: {
      pubkey: readFileSync(pubFile, "utf8").trim(),
      endpoints: [appInfo.updaterEndpoint],
    },
  },
};
// The yt-dlp sidecar must exist for the target being built (Tauri checks for it, also in dev).
if (["dev", "build", "bundle"].includes(args[0])) {
  const at = args.findIndex((a) => a === "--target" || a === "-t");
  const target = at >= 0 ? args[at + 1] : hostTarget();
  try {
    await ensureYtdlp([target]);
  } catch (e) {
    console.error(`Could not get yt-dlp: ${e.message ?? e}`);
    process.exit(1);
  }
}
// The CLI only honours --config (not the TAURI_CONFIG variable) for the base config file.
const extra = [];
if (["dev", "build", "bundle"].includes(args[0])) extra.push("--config", JSON.stringify(config));

// --- keep Cargo.toml's version equal to package.json ----------------------------------------
const cargoFile = resolve(root, "src-tauri/Cargo.toml");
const cargo = readFileSync(cargoFile, "utf8");
const synced = cargo.replace(/^version = ".*"$/m, `version = "${appInfo.version}"`);
if (synced !== cargo) writeFileSync(cargoFile, synced);

// --- macOS: name the Dock icon of the dev app after the product name ---------------------------
// A built app takes its Dock name from the bundle, but `npm run dev` runs the bare program, which
// Cargo must call "app". scripts/dev-runner.sh starts it under a link named like the product.
if (process.platform === "darwin" && args[0] === "dev") {
  const host = spawnSync("rustc", ["-vV"], { encoding: "utf8" }).stdout?.match(/^host: (.+)$/m)?.[1];
  if (host) {
    env[`CARGO_TARGET_${host.toUpperCase().replaceAll("-", "_")}_RUNNER`] = resolve(root, "scripts/dev-runner.sh");
    env.APP_DEV_NAME = appInfo.name;
  }
}

// --- macOS: build the .dmg without Finder ----------------------------------------------------
// The DMG tool styles its window with AppleScript through Finder, which randomly fails ("Can't set
// statusbar visible ... -10006", "resource busy"). Tauri skips that step when CI is set.
if (process.platform === "darwin" && args[0] === "build") env.CI ??= "true";

// Without a paid Apple Developer ID there is no real signature, but the whole .app must still carry
// an ad-hoc one ("-"): the compiler only signs the binary, and macOS then says the downloaded app is
// "damaged". Set APPLE_SIGNING_IDENTITY (and the notarization variables) to sign for real instead.
if (process.platform === "darwin" && args[0] === "build" && !env.APPLE_SIGNING_IDENTITY) {
  config.bundle.macOS = { ...config.bundle.macOS, signingIdentity: "-" };
  extra.length = 0;
  extra.push("--config", JSON.stringify(config));
}

// --- signing key (build only) -----------------------------------------------------------------
if (args[0] === "build") {
  const keyFile = resolve(root, env.APP_SIGNING_KEY ?? "keys/private.key");
  if (env.TAURI_SIGNING_PRIVATE_KEY) {
    console.log("Signing update files with TAURI_SIGNING_PRIVATE_KEY from the environment.");
  } else if (existsSync(keyFile)) {
    env.TAURI_SIGNING_PRIVATE_KEY = keyFile; // the CLI accepts a path as well as the key text
    console.log(`Signing update files with ${keyFile}`);
  } else if (env.APP_SIGNING_KEY) {
    console.error(`APP_SIGNING_KEY points to a file that does not exist: ${keyFile}`);
    process.exit(1);
  } else {
    console.warn(
      "No signing key found (keys/private.key), so this build has NO update files.\n" +
        "That is fine for testing. To get one, see DEVELOPMENT.md.",
    );
    extra.push("--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }));
  }
  // Keys made without a password (the default in DEVELOPMENT.md) need an empty one.
  if (env.TAURI_SIGNING_PRIVATE_KEY && env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
  }
}

// Run the Tauri CLI directly (no shell), so quoting works the same on every OS.
const require = createRequire(import.meta.url);
const pkgPath = require.resolve("@tauri-apps/cli/package.json");
const cliPkg = require(pkgPath);
const bin = typeof cliPkg.bin === "string" ? cliPkg.bin : cliPkg.bin.tauri;
const cli = join(dirname(pkgPath), bin);

const result = spawnSync(process.execPath, [cli, ...args, ...extra], { stdio: "inherit", env, cwd: root });
// A finished build moves into builds/v<version>/ (one folder for all builds of this version); the bundle
// folder in src-tauri/target is removed, so no installers stay there.
// (Inside the Docker build container, APP_KEEP_BUNDLE is set: docker/build.sh copies the installers out itself.)
if (result.status === 0 && args[0] === "build" && !env.APP_KEEP_BUNDLE) {
  const at = args.findIndex((a) => a === "--target" || a === "-t");
  const triple = (at >= 0 ? args[at + 1] : hostTarget()) ?? "";
  const bundleDir = resolve(root, "src-tauri/target", ...(at >= 0 ? [triple] : []), "release/bundle");
  const os = triple.includes("apple") ? "darwin" : triple.includes("windows") ? "windows" : "linux";
  try {
    moveBuildToVersionsFolder(bundleDir, os, triple.startsWith("aarch64") ? "aarch64" : "x86_64");
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
process.exit(result.status ?? 1);
