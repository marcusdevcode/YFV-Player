#!/usr/bin/env node
// The only way Tauri is run (`npm run tauri`, `npm start`, `npm run build:*`, CI).
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
import { appInfo, root } from "./app-info.mjs";

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
// The CLI only honours --config (not the TAURI_CONFIG variable) for the base config file.
const extra = [];
if (["dev", "build", "bundle"].includes(args[0])) extra.push("--config", JSON.stringify(config));

// --- keep Cargo.toml's version equal to package.json ----------------------------------------
const cargoFile = resolve(root, "src-tauri/Cargo.toml");
const cargo = readFileSync(cargoFile, "utf8");
const synced = cargo.replace(/^version = ".*"$/m, `version = "${appInfo.version}"`);
if (synced !== cargo) writeFileSync(cargoFile, synced);

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
process.exit(result.status ?? 1);
