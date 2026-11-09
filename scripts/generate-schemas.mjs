#!/usr/bin/env node
// Writes the JSON Schemas in schemas/ and the two built-in themes in src/builtin-themes/.
//   node scripts/generate-schemas.mjs          write the files
//   node scripts/generate-schemas.mjs --check  exit with an error if a file is out of date
//
// Single sources of truth:
//   src/theme/registry.json   every themeable color and icon slot (title, description, defaults)
//   src/locales/en.json       every UI text key (a locale schema property is made for each)
// The general-settings schema is written by hand below. Edit those sources, then run this script.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { root } from "./package-info.mjs";

const read = (p) => JSON.parse(readFileSync(resolve(root, p), "utf8"));
const DRAFT = "https://json-schema.org/draft/2020-12/schema";
const ICON_ID = "^(builtin|icomoon):[A-Za-z0-9_-]+$";
const THEME_ID = "[a-z0-9][a-z0-9-]{0,62}";

const registry = read("src/theme/registry.json");
const en = read("src/locales/en.json");

// ---- theme ----------------------------------------------------------------------------------
function themeSchema() {
  const colors = {};
  for (const [id, c] of Object.entries(registry.colors)) {
    colors[id] = {
      type: "string",
      title: c.title,
      description: `${c.description} Group: ${registry.groups[c.group].title}. CSS variable: ${c.cssVar}.` +
        " Format #rrggbb, or #rrggbbaa to make it transparent (aa = opacity, 00 invisible to ff solid).",
      pattern: "^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$",
      default: c.dark,
      examples: [c.dark, c.light],
      "x-cssVariable": c.cssVar,
      "x-group": c.group,
    };
  }
  const icons = {};
  for (const [id, s] of Object.entries(registry.iconSlots)) {
    icons[id] = {
      type: "string",
      title: s.title,
      description: `${s.description} Value is "<icon set>:<icon name>"; sets are "builtin" and "icomoon".`,
      pattern: ICON_ID,
      default: s.default,
      examples: [s.default],
    };
  }
  return {
    $schema: DRAFT,
    $id: "theme.schema.json",
    title: "Theme",
    description:
      "A color and icon theme. A theme is based on the built-in 'dark' or 'light' theme: any color or icon it does not " +
      "list is taken from that base. Used for the built-in themes, the themes you create, and theme export/import files.",
    type: "object",
    properties: {
      $schema: { type: "string", description: "Optional link to this schema, for editors." },
      schemaVersion: { const: 1, title: "Schema version", description: "Version of this file format.", default: 1 },
      id: {
        type: "string",
        title: "Id",
        description: "Unique, stable id: lowercase letters, digits and dashes. 'dark' and 'light' are the built-in themes.",
        pattern: `^${THEME_ID}$`,
        examples: ["dark", "my-theme"],
      },
      name: { type: "string", title: "Name", description: "Name shown in the theme list.", minLength: 1, maxLength: 60, examples: ["Dark", "Ocean"] },
      base: { enum: ["dark", "light"], title: "Base", description: "Built-in theme that supplies every color not set here, and decides the system control style (light or dark).", default: "dark" },
      description: { type: "string", title: "Description", description: "Optional note about the theme.", maxLength: 300 },
      author: { type: "string", title: "Author", description: "Optional name of the creator.", maxLength: 80 },
      colors: {
        type: "object",
        title: "Colors",
        description: "Color of each element, by token. Only the ones you list differ from the base theme.",
        properties: colors,
        additionalProperties: false,
      },
      icons: {
        type: "object",
        title: "Icons",
        description: "Icon of each slot. Only the ones you list differ from the default icons.",
        properties: icons,
        additionalProperties: false,
      },
    },
    required: ["schemaVersion", "id", "name", "base"],
    additionalProperties: false,
  };
}

// ---- general settings -----------------------------------------------------------------------
function settingsSchema() {
  return {
    $schema: DRAFT,
    $id: "settings.schema.json",
    title: "General settings",
    description: "The app's general settings file (settings/settings.json in the app data folder).",
    type: "object",
    properties: {
      $schema: { type: "string", description: "Optional link to this schema, for editors." },
      schemaVersion: { const: 1, title: "Schema version", description: "Version of this file format.", default: 1 },
      language: {
        type: "string",
        title: "Language",
        description: "Language code: the name of a file in src/locales (for example 'en' or 'he'). English until changed.",
        pattern: "^[a-z]{2,3}(-[A-Za-z0-9]+)*$",
        default: "en",
        examples: ["en", "he"],
      },
      theme: {
        type: "string",
        title: "Theme",
        description:
          "'system' follows the operating system's light/dark setting and switches with it. Otherwise the id of a built-in " +
          "('dark', 'light') or custom theme. Starts as 'system'; choosing a theme saves its id here.",
        pattern: `^(system|${THEME_ID})$`,
        default: "system",
        examples: ["system", "dark", "light", "my-theme"],
      },
      sidebar: {
        type: "object",
        title: "Playlist panel",
        description: "State of the playlist panel.",
        properties: {
          open: { type: "boolean", title: "Open", description: "The panel is shown (true) or hidden (false).", default: true },
          side: { enum: ["left", "right"], title: "Side", description: "Window edge the panel sits on. Starts as the language's default side.", default: "left" },
        },
        additionalProperties: false,
      },
      player: {
        type: "object",
        title: "Player",
        description: "Player preferences.",
        properties: {
          volume: { type: "number", title: "Volume", description: "Playback volume, 0 (silent) to 1 (full).", minimum: 0, maximum: 1, default: 1 },
          muted: { type: "boolean", title: "Muted", description: "Sound is switched off.", default: false },
          pauseVideoInBackground: {
            type: "boolean",
            title: "Pause video in the background",
            description:
              "When the window is not in front and the video has a separate audio file, the picture pauses and only the audio plays " +
              "(saves resources). The video continues from the audio's position when the window comes back. Videos without a separate " +
              "audio file are not affected.",
            default: true,
          },
        },
        additionalProperties: false,
      },
    },
    required: ["schemaVersion"],
    additionalProperties: false,
  };
}

// ---- language files -------------------------------------------------------------------------
const GROUPS = {
  common: "Words used on many buttons",
  themes: "The Themes dialog",
  filter: "Names of file types in open/save dialogs",
  app: "Main window",
  add: "The Add videos dialog",
  mgr: "The playlist manager",
  panel: "The playlist badge column",
  side: "The playlist panel",
  settings: "The Settings dialog",
  appearance: "The Appearance settings (themes, colors, icons)",
  playlist: "Playlist defaults",
  notice: "Notices and error messages",
  thumb: "Video preview images",
  player: "The player and its control bar",
  update: "Updates",
  merge: "Merging video and audio",
};
const placeholders = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];

function localeSchema() {
  const strings = {};
  for (const [key, text] of Object.entries(en.strings)) {
    const group = key.split(".")[0];
    const plural = key.match(/\.(one|two|few|many|other)$/)?.[1];
    const names = placeholders(text);
    strings[key] = {
      type: "string",
      minLength: 1,
      title: key,
      description:
        `${GROUPS[group] ?? "Interface text"}.` +
        (plural ? ` Plural form "${plural}" (chosen by the language's plural rules).` : "") +
        (names.length ? ` Keep the placeholders ${names.map((n) => `{${n}}`).join(", ")} in the text.` : ""),
      default: text,
      examples: [text],
      ...(names.length ? { "x-placeholders": names } : {}),
    };
    // Other languages can need more plural forms than English (for example Hebrew "two").
    if (key.endsWith(".other")) {
      const base = key.slice(0, -".other".length);
      for (const form of ["zero", "two", "few", "many"]) {
        strings[`${base}.${form}`] = {
          type: "string",
          minLength: 1,
          title: `${base}.${form}`,
          description:
            `${GROUPS[group] ?? "Interface text"}. Optional plural form "${form}" for languages whose plural rules have it; ` +
            `English does not use it. Placeholders may be left out.`,
          examples: [text],
        };
      }
    }
  }
  // Names of colors, icon slots and groups come from the registry (English there); a language may translate them.
  for (const [id, c] of Object.entries(registry.colors)) {
    strings[`theme.color.${id}`] = { type: "string", minLength: 1, title: `theme.color.${id}`, description: `Name of the color "${c.title}" in the theme editor.`, default: c.title, examples: [c.title] };
  }
  for (const [id, s] of Object.entries(registry.iconSlots)) {
    strings[`theme.icon.${id}`] = { type: "string", minLength: 1, title: `theme.icon.${id}`, description: `Name of the icon slot "${s.title}" in the theme editor.`, default: s.title, examples: [s.title] };
  }
  for (const [id, grp] of Object.entries(registry.groups)) {
    strings[`theme.group.${id}`] = { type: "string", minLength: 1, title: `theme.group.${id}`, description: `Name of the color group "${grp.title}" in the theme editor.`, default: grp.title, examples: [grp.title] };
  }
  return {
    $schema: DRAFT,
    $id: "locale.schema.json",
    title: "Language file",
    description:
      "A language: one file in src/locales named after the language code (en.json, he.json). English (en.json) is the base " +
      "and must hold every text; other languages may leave texts out and get the English one instead.",
    type: "object",
    properties: {
      $schema: { type: "string", description: "Optional link to this schema, for editors." },
      name: { type: "string", title: "Name", description: "The language's name in that language, shown in Settings and the Language menu.", minLength: 1, maxLength: 40, examples: ["English", "עברית"] },
      dir: { enum: ["ltr", "rtl"], title: "Text direction", description: "Reading direction: left-to-right or right-to-left.", default: "ltr" },
      sidebarSide: { enum: ["left", "right"], title: "Default panel side", description: "Where the playlist panel is placed by default in this language. Changing the language resets the panel to this side.", default: "left" },
      strings: {
        type: "object",
        title: "Texts",
        description: "The interface texts by key. A missing key falls back to English. Plural texts use <key>.one/.two/.few/.many/.other; '.other' is required for each plural text.",
        properties: strings,
        additionalProperties: false,
      },
    },
    required: ["name", "dir", "sidebarSide"],
    additionalProperties: false,
  };
}

// ---- icon packs and the registry ------------------------------------------------------------
function iconPackSchema() {
  return {
    $schema: DRAFT,
    $id: "icon-pack.schema.json",
    title: "Icon pack",
    description: "A set of icons made of path shapes, drawn in the current text color. Files: src/icons/builtin.json and src/icons/icomoon.json (made by scripts/import-icomoon.mjs).",
    type: "object",
    properties: {
      $schema: { type: "string", description: "Optional link to this schema, for editors." },
      schemaVersion: { const: 1, title: "Schema version", description: "Version of this file format.", default: 1 },
      id: { type: "string", title: "Id", description: "Icon set id, used before the colon in an icon reference.", pattern: "^[a-z][a-z0-9]*$", examples: ["builtin", "icomoon"] },
      name: { type: "string", title: "Name", description: "Name of the pack.", minLength: 1 },
      icons: {
        type: "object",
        title: "Icons",
        description: "The icons by name.",
        patternProperties: {
          "^[A-Za-z0-9_-]+$": {
            type: "object",
            title: "Icon",
            description: "One icon.",
            properties: {
              viewBox: { type: "string", title: "View box", description: "SVG viewBox: 'minX minY width height'.", pattern: "^\\d+(\\.\\d+)? \\d+(\\.\\d+)? \\d+(\\.\\d+)? \\d+(\\.\\d+)?$", examples: ["0 0 24 24"] },
              paths: { type: "array", title: "Paths", description: "SVG path data of each shape.", minItems: 1, items: { type: "string", minLength: 1 } },
            },
            required: ["viewBox", "paths"],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    required: ["schemaVersion", "id", "name", "icons"],
    additionalProperties: false,
  };
}

function registrySchema() {
  return {
    $schema: DRAFT,
    $id: "theme-registry.schema.json",
    title: "Theme registry",
    description: "Lists every color token and icon slot a theme can set (src/theme/registry.json). The theme schema and the built-in themes are generated from it.",
    type: "object",
    properties: {
      $schema: { type: "string", description: "Optional link to this schema, for editors." },
      schemaVersion: { const: 1, description: "Version of this file format." },
      groups: {
        type: "object",
        description: "Groups the colors are listed under in the editor.",
        additionalProperties: { type: "object", properties: { title: { type: "string" }, description: { type: "string" } }, required: ["title", "description"], additionalProperties: false },
      },
      colors: {
        type: "object",
        description: "Color tokens by id.",
        additionalProperties: {
          type: "object",
          properties: {
            cssVar: { type: "string", pattern: "^--[a-z0-9-]+$", description: "CSS custom property the token sets." },
            group: { type: "string", description: "Group id (a key of 'groups')." },
            title: { type: "string", description: "Name shown in the editor." },
            description: { type: "string", description: "What the color is used for." },
            dark: { type: "string", pattern: "^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$", description: "Value in the built-in dark theme." },
            light: { type: "string", pattern: "^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$", description: "Value in the built-in light theme." },
          },
          required: ["cssVar", "group", "title", "description", "dark", "light"],
          additionalProperties: false,
        },
      },
      iconSlots: {
        type: "object",
        description: "Icon slots by id.",
        additionalProperties: {
          type: "object",
          properties: { title: { type: "string" }, description: { type: "string" }, default: { type: "string", pattern: ICON_ID } },
          required: ["title", "description", "default"],
          additionalProperties: false,
        },
      },
    },
    required: ["schemaVersion", "groups", "colors", "iconSlots"],
    additionalProperties: false,
  };
}

// ---- built-in themes ------------------------------------------------------------------------
function builtinTheme(base) {
  return {
    $schema: "../../schemas/theme.schema.json",
    schemaVersion: 1,
    id: base,
    name: base === "dark" ? "Dark" : "Light",
    base,
    description: `Built-in ${base} theme.`,
    colors: Object.fromEntries(Object.entries(registry.colors).map(([id, c]) => [id, c[base]])),
  };
}

function exampleSettings() {
  return {
    $schema: "../settings.schema.json",
    schemaVersion: 1,
    language: "en",
    theme: "system",
    sidebar: { open: true, side: "left" },
    player: { volume: 1, muted: false, pauseVideoInBackground: true },
  };
}

function exampleTheme() {
  return {
    $schema: "../theme.schema.json",
    schemaVersion: 1,
    id: "ocean",
    name: "Ocean",
    base: "dark",
    description: "Example custom theme based on the dark theme.",
    author: "Example",
    colors: { accent: "#0b5cad", accentBorder: "#4da3ff", progressBar: "#4da3ff", trackCurrent: "#0b5cad59" },
    icons: { play: "icomoon:play3", pause: "icomoon:pause3" },
  };
}

function defaultsCss() {
  const lines = (key) => Object.values(registry.colors).map((c) => `  ${c.cssVar}: ${c[key]};`).join("\n");
  return `/* Generated by scripts/generate-schemas.mjs from src/theme/registry.json. Do not edit.
   The first paint follows the system (dark, or light when the system is light) until the theme engine runs. */
:root {
${lines("dark")}
}
@media (prefers-color-scheme: light) {
  :root {
${lines("light").replace(/^/gm, "  ")}
  }
}
`;
}

export function buildAll() {
  const json = (o) => JSON.stringify(o, null, 2) + "\n";
  return {
    "schemas/theme.schema.json": json(themeSchema()),
    "schemas/settings.schema.json": json(settingsSchema()),
    "schemas/locale.schema.json": json(localeSchema()),
    "schemas/icon-pack.schema.json": json(iconPackSchema()),
    "schemas/theme-registry.schema.json": json(registrySchema()),
    "src/theme/defaults.css": defaultsCss(),
    "schemas/examples/settings.json": json(exampleSettings()),
    "schemas/examples/theme.json": json(exampleTheme()),
    "src/builtin-themes/dark.json": json(builtinTheme("dark")),
    "src/builtin-themes/light.json": json(builtinTheme("light")),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [file, text] of Object.entries(buildAll())) {
    const path = resolve(root, file);
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === text) continue;
    if (check) {
      console.error(`Out of date: ${file}. Run: npm run schemas`);
      stale++;
    } else {
      writeFileSync(path, text);
      console.log(`Wrote ${file}`);
    }
  }
  if (check && stale) process.exit(1);
  if (check) console.log("Schemas and built-in themes are up to date.");
}
