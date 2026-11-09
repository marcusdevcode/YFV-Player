#!/usr/bin/env node
// Downloads the yt-dlp program that the app bundles as a sidecar (YouTube search and downloads).
//
// Tauri expects one file per target named  src-tauri/binaries/yt-dlp-<target-triple>[.exe].
// This script saves the pinned release there and checks it against the release's SHA-256 list.
// It is called by scripts/run-tauri.mjs before every dev run and build (a file that is already
// there for the pinned version is not downloaded again), and can be run by hand:
//   node scripts/fetch-ytdlp.mjs                         the machine's own target
//   node scripts/fetch-ytdlp.mjs --all                   every release target
//   node scripts/fetch-ytdlp.mjs <target-triple> ...     the given targets

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root } from "./package-info.mjs";

/** The yt-dlp release the app is built with. The app can update its own copy later. */
export const YTDLP_VERSION = "2026.10.26";

/** Which release file serves which target. The macOS file runs on both Mac architectures. */
const RELEASE_FILE_FOR_TARGET = {
  "aarch64-apple-darwin": "yt-dlp_macos",
  "x86_64-apple-darwin": "yt-dlp_macos",
  "x86_64-pc-windows-msvc": "yt-dlp.exe",
  "aarch64-pc-windows-msvc": "yt-dlp_arm64.exe",
  "x86_64-unknown-linux-gnu": "yt-dlp_linux",
  "aarch64-unknown-linux-gnu": "yt-dlp_linux_aarch64",
};

const binariesDir = resolve(root, "src-tauri/binaries");

export function hostTarget() {
  return spawnSync("rustc", ["-vV"], { encoding: "utf8" }).stdout?.match(/^host: (.+)$/m)?.[1];
}

/** Where the sidecar for a target lives (the name Tauri's externalBin expects). */
export function sidecarPath(target) {
  return resolve(binariesDir, `yt-dlp-${target}${target.includes("windows") ? ".exe" : ""}`);
}

/** Download with a few retries: GitHub sometimes answers 502/503 for a moment. */
async function download(url) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`${url} answered ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (e) {
      lastError = e;
      if (attempt < 5) {
        const wait = 2 ** attempt;
        console.warn(`${e.message ?? e}; trying again in ${wait} s (${attempt}/5)`);
        await new Promise((done) => setTimeout(done, wait * 1000));
      }
    }
  }
  throw lastError;
}

/** Make sure the sidecar for each target is present and is the pinned version. */
export async function ensureYtdlp(targets) {
  mkdirSync(binariesDir, { recursive: true });
  let sums = null;
  for (const target of targets) {
    const releaseFile = RELEASE_FILE_FOR_TARGET[target];
    if (!releaseFile) throw new Error(`No yt-dlp build is known for the target ${target}`);
    const destination = sidecarPath(target);
    const marker = `${destination}.version`; // which release the file is
    const current = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
    if (current === YTDLP_VERSION && existsSync(destination)) continue;

    const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}`;
    console.log(`Downloading yt-dlp ${YTDLP_VERSION} for ${target} ...`);
    sums ??= (await download(`${base}/SHA2-256SUMS`)).toString("utf8");
    const expected = sums
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find(([, name]) => name === releaseFile)?.[0];
    if (!expected) throw new Error(`${releaseFile} is not in the release's SHA2-256SUMS`);
    const data = await download(`${base}/${releaseFile}`);
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== expected) {
      throw new Error(`Checksum of ${releaseFile} does not match (expected ${expected}, got ${actual})`);
    }
    writeFileSync(destination, data);
    chmodSync(destination, 0o755);
    writeFileSync(marker, `${YTDLP_VERSION}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const given = process.argv.slice(2);
  const targets = given.includes("--all") ? Object.keys(RELEASE_FILE_FOR_TARGET) : given.length ? given : [hostTarget()];
  ensureYtdlp(targets).catch((e) => {
    console.error(String(e.message ?? e));
    process.exit(1);
  });
}
