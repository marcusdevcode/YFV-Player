#!/usr/bin/env node
// Empties everything a build leaves behind, so the next build starts from scratch:
//   builds/ (all versions), the old release/ folder, and every bundle folder inside src-tauri/target.
// Run first by `npm run build`. The compiler's own cache stays (dependencies are not rebuilt).

import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { root } from "./package-info.mjs";

const gone = [resolve(root, "builds"), resolve(root, "release")];
const target = resolve(root, "src-tauri/target");
if (existsSync(target)) {
  gone.push(join(target, "release/bundle"), join(target, "debug/bundle"));
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory()) gone.push(join(target, entry.name, "release/bundle"), join(target, entry.name, "debug/bundle"));
  }
}
for (const dir of gone) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`Removed ${dir}`);
  }
}
