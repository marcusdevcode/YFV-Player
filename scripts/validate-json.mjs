#!/usr/bin/env node
// Checks every JSON data file of the app against its JSON Schema, plus the rules a schema cannot say.
//   npm run validate:json
// Files: src/theme/registry.json, src/icons/*.json, src/builtin-themes/*.json, src/locales/*.json,
//        schemas/examples/*.json. Also fails if the generated schemas/themes are out of date.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { root } from "./package-info.mjs";
import { buildAll } from "./generate-schemas.mjs";

const read = (p) => JSON.parse(readFileSync(resolve(root, p), "utf8"));
const list = (dir) => readdirSync(resolve(root, dir)).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
const ajv = new Ajv2020({ allErrors: true, strict: false });
let failures = 0;
const fail = (file, msg) => {
  console.error(`✗ ${file}: ${msg}`);
  failures++;
};

// 1. Generated files are current.
for (const [file, text] of Object.entries(buildAll())) {
  let current = "";
  try {
    current = readFileSync(resolve(root, file), "utf8");
  } catch {
    /* missing */
  }
  if (current !== text) fail(file, "out of date, run: npm run schemas");
}

// 2. Schema validation.
const validators = {};
for (const name of ["theme", "settings", "locale", "icon-pack", "theme-registry"]) {
  validators[name] = ajv.compile(read(`schemas/${name}.schema.json`));
}
function check(file, schemaName) {
  const validate = validators[schemaName];
  if (!validate(read(file))) {
    for (const e of validate.errors ?? []) fail(file, `${e.instancePath || "/"} ${e.message}`);
  }
}
check("src/theme/registry.json", "theme-registry");
const packs = {};
for (const file of list("src/icons")) {
  check(file, "icon-pack");
  const pack = read(file);
  packs[pack.id] = pack;
}
for (const file of list("src/builtin-themes")) check(file, "theme");
for (const file of list("src/locales")) check(file, "locale");
for (const file of list("schemas/examples")) {
  check(file, file.includes("settings") ? "settings" : "theme");
}

// 3. Rules beyond the schemas.
const registry = read("src/theme/registry.json");
const iconExists = (ref) => {
  const [set, name] = ref.split(":");
  return Boolean(packs[set]?.icons?.[name]);
};
for (const [slot, s] of Object.entries(registry.iconSlots)) {
  if (!iconExists(s.default)) fail("src/theme/registry.json", `slot ${slot}: default icon ${s.default} does not exist`);
}
for (const [id, c] of Object.entries(registry.colors)) {
  if (!registry.groups[c.group]) fail("src/theme/registry.json", `color ${id}: unknown group ${c.group}`);
}
for (const file of [...list("src/builtin-themes"), ...list("schemas/examples")].filter((f) => !f.includes("settings"))) {
  for (const [slot, ref] of Object.entries(read(file).icons ?? {})) {
    if (!iconExists(ref)) fail(file, `icon ${slot}: ${ref} does not exist`);
  }
}
const en = read("src/locales/en.json").strings;
const placeholders = (t) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
for (const key of Object.keys(en)) {
  const base = key.match(/^(.*)\.(one|two|few|many)$/)?.[1];
  if (base && !(`${base}.other` in en)) fail("src/locales/en.json", `${key} needs ${base}.other`);
}
for (const file of list("src/locales")) {
  const strings = read(file).strings ?? {};
  for (const [key, text] of Object.entries(strings)) {
    const extraForm = /\.(zero|two|few|many)$/.test(key);
    const fromRegistry =
      (key.startsWith("theme.color.") && key.slice(12) in registry.colors) ||
      (key.startsWith("theme.icon.") && key.slice(11) in registry.iconSlots) ||
      (key.startsWith("theme.group.") && key.slice(12) in registry.groups) ||
      (key.startsWith("theme.layout.") && key.slice(13) in registry.layout);
    if (fromRegistry) continue;
    if (!(key in en) && !extraForm) fail(file, `unknown text key ${key}`);
    const reference = en[key] ?? en[key.replace(/\.(zero|two|few|many)$/, ".other")];
    if (reference === undefined) continue;
    const have = text.match(/\{(\w+)\}/g)?.map((m) => m.slice(1, -1)) ?? [];
    const allowed = reference.match(/\{(\w+)\}/g)?.map((m) => m.slice(1, -1)) ?? [];
    const isPlural = /\.(zero|one|two|few|many)$/.test(key);
    // Plain texts must keep every placeholder; plural forms such as "one" may leave {count} out.
    const missing = isPlural ? [] : allowed.filter((n) => !have.includes(n));
    const unknown = have.filter((n) => !allowed.includes(n));
    if (missing.length || unknown.length) {
      fail(file, `${key}: placeholders must match English ({${allowed.join(",")}})`);
    }
  }
}

if (failures) {
  console.error(`\n${failures} problem${failures === 1 ? "" : "s"} found.`);
  process.exit(1);
}
console.log("All JSON files are valid.");
