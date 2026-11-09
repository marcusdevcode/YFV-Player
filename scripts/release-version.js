#!/usr/bin/env node
// Publishes the current version as a GitHub release, using the files that `npm run build`
// put in builds/v<version>/. The version, name and repository come from package.json.
//
//   node scripts/release-version.js            asks for confirmation, then publishes
//   node scripts/release-version.js --yes      no confirmation question
//   node scripts/release-version.js --draft    create a draft release (not visible to the updater)
//   node scripts/release-version.js --dry-run  check everything and print the command, publish nothing
//   node scripts/release-version.js --allow-partial   publish even if some platforms are missing
//
// It runs the GitHub CLI (`gh`) as whoever is logged in on this machine: run it yourself.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { appInfo, root } from "./package-info.mjs";

const flags = new Set(process.argv.slice(2));
const { name, version, repoUrl } = appInfo;
const tag = `v${version}`;
const dir = resolve(root, "builds", tag);
const repo = repoUrl.replace(/^https:\/\/github\.com\//, "");

const fail = (msg) => {
  console.error(`\n${msg}\n`);
  process.exit(1);
};

// 1. The built files for exactly this version must exist.
if (!existsSync(join(dir, "latest.json"))) {
  fail(`Nothing to publish for ${tag}: ${dir}/latest.json is missing.\nBuild first: npm run build`);
}
const latest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
if (latest.version !== version) fail(`latest.json is for version ${latest.version}, package.json says ${version}.`);

const expected = ["darwin-aarch64", "darwin-x86_64", "linux-aarch64", "linux-x86_64", "windows-aarch64", "windows-x86_64"];
const missing = expected.filter((p) => !latest.platforms?.[p]);
if (missing.length && !flags.has("--allow-partial")) {
  fail(`Missing platforms in ${tag}: ${missing.join(", ")}.\nBuild them, or run with --allow-partial (those users get no update).`);
}

// Every platform's installer must really be in the folder (and be of this version).
const absent = Object.values(latest.platforms).map((p) => decodeURIComponent(p.url.split("/").pop())).filter((f) => !existsSync(join(dir, f)));
if (absent.length) fail(`latest.json lists files that are not in ${dir}: ${absent.join(", ")}`);

// Published: the installers and latest.json (not the .sig files, nor the macOS .app test copies).
const files = readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isFile() && !e.name.endsWith(".sig"))
  .map((e) => e.name)
  .sort();
const gh = (args, opts = {}) => spawnSync("gh", args, { encoding: "utf8", ...opts });
const createArgs = [
  "release", "create", tag, ...files.map((f) => join(dir, f)),
  "--repo", repo,
  "--title", `${name} ${tag}`,
  "--notes", `${name} ${tag}`,
  ...(flags.has("--draft") ? ["--draft"] : []),
];

console.log(`Release ${tag} of ${name} -> ${repoUrl}`);
for (const f of files) console.log(`  ${f}`);

if (flags.has("--dry-run")) {
  console.log(`\nDry run, nothing published. Would run:\n  gh ${createArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}\n`);
  process.exit(0);
}

// 2. GitHub CLI installed, logged in, and the release does not exist yet.
if (gh(["--version"]).error) fail("The GitHub CLI (gh) is not installed. Install it from https://cli.github.com and run: gh auth login");
if (gh(["auth", "status"]).status !== 0) fail("You are not logged in to GitHub. Run: gh auth login");
if (gh(["release", "view", tag, "--repo", repo]).status === 0) {
  fail(`Release ${tag} already exists in ${repo}. Raise "version" in package.json for a new release.`);
}

// 3. Confirm, then publish.
if (!flags.has("--yes")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\nPublish ${tag} to ${repo} now? (y/N) `)).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") fail("Cancelled. Nothing was published.");
}

const result = spawnSync("gh", createArgs, { stdio: "inherit" });
if (result.status !== 0) fail("gh release create failed (see above). Nothing else was changed.");
console.log(`\nPublished ${tag}.`);
