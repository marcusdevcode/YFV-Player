#!/usr/bin/env node
// Turns an IcoMoon download into the app's icon pack file (src/icons/icomoon.json).
//   1. Unzip the IcoMoon download.
//   2. node scripts/import-icomoon.mjs <folder that holds the SVG/ folder>
// Every icon is read from SVG/<name>.svg (only <path d="..."> shapes are used, drawn with the
// current text color), and is stored under its file name. Run `npm run schemas:check` afterwards.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { root } from "./package-info.mjs";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: node scripts/import-icomoon.mjs <unzipped IcoMoon folder>");
  process.exit(1);
}
const svgDir = resolve(dir, "SVG");
const icons = {};
for (const file of readdirSync(svgDir).filter((f) => f.endsWith(".svg")).sort()) {
  const svg = readFileSync(join(svgDir, file), "utf8");
  const viewBox = svg.match(/viewBox="([^"]*)"/)?.[1];
  const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]*)"/g)].map((m) => m[1]);
  if (!viewBox || paths.length === 0) {
    console.warn(`Skipped ${file}: no viewBox or no paths`);
    continue;
  }
  icons[file.replace(/\.svg$/, "")] = { viewBox, paths };
}

const pack = {
  $schema: "../../schemas/icon-pack.schema.json",
  schemaVersion: 1,
  id: "icomoon",
  name: "IcoMoon selection",
  icons,
};
const out = resolve(root, "src/icons/icomoon.json");
writeFileSync(out, JSON.stringify(pack, null, 1) + "\n");
console.log(`${Object.keys(icons).length} icons written to ${out}`);
