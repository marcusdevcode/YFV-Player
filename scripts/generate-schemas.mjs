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
function layoutProperties() {
  const out = {};
  for (const [id, f] of Object.entries(registry.layout)) {
    out[id] =
      f.type === "boolean"
        ? { type: "boolean", title: f.title, description: f.description, default: f.default }
        : {
            type: "number",
            title: f.title,
            description: `${f.description} From ${f.minimum} to ${f.maximum}${f.unit ? ` ${f.unit}` : ""}.`,
            minimum: f.minimum,
            maximum: f.maximum,
            default: f.default,
          };
  }
  return out;
}

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
      windowStyle: {
        enum: ["regular", "experimental"],
        title: "Window style",
        description:
          "'regular' is the normal window with the system title bar. 'experimental' removes the title bar and the three window buttons, " +
          "makes the window transparent with rounded corners and a large shadow, and floats the control bar over the video.",
        default: "regular",
      },
      frame: {
        enum: ["plain", "detroit", "rpg", "terminal", "re4", "requiem", "cyberpunk2"],
        title: "Frame style",
        description:
          "Floating window style only. 'plain' uses simple borders. 'detroit' draws thin double-line borders, square panels, " +
          "white corner brackets on the selected item and a light that travels around the border of every button. " +
          "'rpg' draws carved wood frames with gold scroll-work corners, parchment panels and gold and brown gradient buttons. " +
          "'terminal' draws a thick border in the accent color around the whole window, a filled title bar, and panels separated by lines. " +
          "'re4' draws a worn dark book: serif text, thin dividing lines, and a smudged light brush stroke behind the chosen item. " +
          "'requiem' draws a dark tactical inventory: grid-lined square cells with notched corners, thin white stat bars, and a red glowing selection. " +
          "'cyberpunk2' draws the neon window and button images of the Cyberpunk UI asset pack (cyan chamfered frames, image buttons and progress bar).",
        default: "plain",
      },
      layout: {
        type: "object",
        title: "Window layout",
        description:
          "Settings of the 'experimental' window style (rounded transparent window): corner radii, transparency, shadow, blur, " +
          "distance of the panels from the edges. Only the ones you list differ from the defaults.",
        properties: layoutProperties(),
        additionalProperties: false,
      },
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
      downloads: {
        type: "object",
        title: "YouTube downloads",
        description: "Defaults for downloading from YouTube. The quality dialog opens with these selected.",
        properties: {
          mode: {
            enum: ["together", "separate", "audioOnly"],
            title: "Download as",
            description:
              "'together' = one file with picture and sound (YouTube offers this only up to about 720p); 'separate' = a video file " +
              "and an audio file (best quality; the player plays them together); 'audioOnly' = only the audio.",
            default: "separate",
          },
          videoQuality: {
            enum: ["best", "2160", "1440", "1080", "720", "480", "360", "240", "144"],
            title: "Video quality",
            description: "Highest picture height in pixels. A video that lacks it uses the closest quality.",
            default: "1080",
          },
          audioQuality: {
            enum: ["best", "medium", "low"],
            title: "Audio quality",
            description: "'medium' is about 128 kbit/s and 'low' about 64 kbit/s.",
            default: "best",
          },
          folder: {
            type: "string",
            title: "Download folder",
            description: "Where downloaded files are saved. Empty = the system's Videos folder.",
            default: "",
          },
          delayBetweenVideos: {
            type: "integer",
            title: "Pause between videos",
            description: "Seconds to wait after a video is finished before the next one starts (0 = no pause).",
            minimum: 0,
            maximum: 60,
            default: 3,
          },
          speedLimitKbps: {
            type: "integer",
            title: "Speed limit",
            description: "Maximum download speed in KiB per second (0 = unlimited).",
            minimum: 0,
            default: 0,
          },
          autoResume: {
            type: "boolean",
            title: "Continue after restart",
            description: "Downloads that were unfinished when the app was closed continue when it starts again.",
            default: true,
          },
          cookiesBrowser: {
            enum: ["", "chrome", "chromium", "brave", "edge", "firefox", "opera", "safari", "vivaldi"],
            title: "Use YouTube sign-in from browser",
            description:
              "Needed for age-restricted videos and when YouTube asks to confirm that you are not a robot. Empty = do not use a browser.",
            default: "",
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
  for (const [id, f] of Object.entries(registry.layout)) {
    strings[`theme.layout.${id}`] = { type: "string", minLength: 1, title: `theme.layout.${id}`, description: `Name of the window layout setting "${f.title}" in the theme editor.`, default: f.title, examples: [f.title] };
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
      layout: {
        type: "object",
        description: "Window layout settings of the experimental window style, by id (shown in the theme editor).",
        additionalProperties: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            type: { enum: ["number", "boolean"] },
            minimum: { type: "number" },
            maximum: { type: "number" },
            step: { type: "number" },
            unit: { type: "string" },
            default: {},
          },
          required: ["title", "description", "type", "default"],
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
    required: ["schemaVersion", "groups", "colors", "iconSlots", "layout"],
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

/** The floating designs: frameless, transparent, rounded windows. Each is a color set plus a layout. */
const FLOATING_DESIGNS = [
  {
    id: "studio", name: "Studio", base: "light", description: "Light floating design: rounded transparent window, floating control bar.",
    colors: { background: "#ffffff", accent: "#4338f5", accentBorder: "#6a5cff", accentText: "#ffffff", playerBackground: "#0f0f14", controlsBackground: "#ffffff", controlsText: "#1b1b1b", progressTrack: "#eeeef2", progressBar: "#4338f5" },
    layout: {},
  },
  {
    id: "studio-dark", name: "Studio dark", base: "dark", description: "Dark floating design: rounded transparent window, floating control bar.",
    colors: { background: "#121216", border: "#2f2f38", panel: "#1c1c22", panelRaised: "#26262e", buttonBackground: "#26262e", buttonHover: "#32323c", accent: "#5b4bff", accentBorder: "#7d70ff", accentText: "#ffffff", playerBackground: "#0a0a0d", controlsBackground: "#1c1c22", controlsText: "#ffffff", progressTrack: "#33333d", progressBar: "#7d70ff" },
    layout: {},
  },
  {
    id: "espresso", name: "Espresso", base: "dark", description: "Warm brown floating design with tan highlights.",
    colors: { background: "#24140a", text: "#f6ead9", textMuted: "#c4a98a", border: "#5a3a22", panel: "#3a2212", panelRaised: "#4a2d19", buttonBackground: "#4a2d19", buttonHover: "#5d3b22", buttonText: "#f6ead9", accent: "#c8996a", accentBorder: "#dcb184", accentText: "#2a1608", playerBackground: "#1a0e06", controlsBackground: "#3a2212", controlsText: "#f6ead9", progressTrack: "#5a3a22", progressBar: "#dcb184" },
    layout: { cornerRadius: 36, panelRadius: 32, panelOpacity: 0.96 },
  },
  {
    id: "latte", name: "Latte", base: "light", description: "Soft cream floating design with terracotta buttons, the light sibling of Espresso.",
    colors: {
      background: "#f6e7dc", text: "#3b2a22", textMuted: "#8a6f60", border: "#e3cdbd", accent: "#d98a6c", accentBorder: "#e9a98e", accentText: "#ffffff",
      buttonBackground: "#fbf4ee", buttonHover: "#f1e2d6", buttonText: "#3b2a22", panel: "#f9ede4", panelRaised: "#f0dccd",
      badgesBackground: "#f3e2d5", badgeText: "#3b2a22", badgeActiveBorder: "#d98a6c", playerBackground: "#2a1d17",
      controlsBackground: "#fbf1ea", controlsText: "#3b2a22", progressTrack: "#ecd8ca", progressBar: "#d4806a", progressBarEnd: "#eeb394",
      trackCurrent: "#d98a6c2e", trackHover: "#d98a6c1a", rowStripe: "#d98a6c0d", rowSelected: "#d98a6c24", errorText: "#b3402a", warningText: "#a8661a",
      dangerBackground: "#c4523a", dangerBorder: "#e07a60", backdrop: "#3b2a2299",
    },
    layout: { cornerRadius: 34, panelRadius: 30, shadowSize: 28, panelOpacity: 0.96, panelBlur: 8, progressGlow: 6, progressGloss: 0.2, controlsGap: 22, playlistGap: 22 },
  },
  {
    id: "midnight", name: "Midnight", base: "dark", description: "Night-blue frosted-glass floating design.",
    colors: { background: "#1d1f3a", text: "#eceeff", textMuted: "#a9acd6", border: "#4b4f86", panel: "#2b2e55", panelRaised: "#383c6b", buttonBackground: "#383c6b", buttonHover: "#464b82", buttonText: "#eceeff", accent: "#7b83ff", accentBorder: "#a2a8ff", accentText: "#ffffff", playerBackground: "#14152b", controlsBackground: "#2b2e55", controlsText: "#eceeff", progressTrack: "#3a3d6b", progressBar: "#8f98ff" },
    layout: { cornerRadius: 38, panelRadius: 34, panelOpacity: 0.72, panelBlur: 18 },
  },
  {
    id: "glass", name: "Glass", base: "light", description: "Light frosted-glass floating design with large rounded corners.",
    colors: { background: "#eef0fb", text: "#1d1f3a", textMuted: "#6b6f95", border: "#d6daf0", panel: "#f4f4fc", panelRaised: "#e2e6f6", buttonBackground: "#e2e6f6", buttonHover: "#d3d8ef", buttonText: "#1d1f3a", accent: "#2b2a6e", accentBorder: "#4a49a0", accentText: "#ffffff", playerBackground: "#1d2340", controlsBackground: "#f6f6fd", controlsText: "#1d1f3a", progressTrack: "#d9dcf0", progressBar: "#2b2a6e" },
    layout: { cornerRadius: 44, panelRadius: 40, panelOpacity: 0.6, panelBlur: 22, controlsGap: 26, playlistGap: 26 },
  },
  {
    id: "glass-blur", name: "Glass blur", base: "dark", description: "Frosted-glass floating design: a see-through window, and a heavily blurred control bar and playlist cards, with white controls.",
    colors: {
      background: "#5c5c60", text: "#ffffff", textMuted: "#d4d4d8", border: "#ffffff4d", accent: "#ffffff", accentBorder: "#ffffff", accentText: "#1c1c1e",
      buttonBackground: "#ffffff26", buttonHover: "#ffffff40", buttonText: "#ffffff", panel: "#8e8e93", panelRaised: "#ffffff1f",
      badgesBackground: "#8e8e93", badgeText: "#ffffff", badgeActiveBorder: "#ffffff", playerBackground: "#000000",
      controlsBackground: "#9a9a9f", controlsText: "#ffffff", progressTrack: "#ffffff59", progressBar: "#ffffff",
      trackCurrent: "#ffffff2e", trackHover: "#ffffff1a", rowStripe: "#ffffff0a", rowSelected: "#ffffff29", backdrop: "#00000066",
    },
    layout: { cornerRadius: 52, panelRadius: 40, shadowSize: 30, windowOpacity: 0.55, panelOpacity: 0.42, panelBlur: 40, panelBorder: 1, progressGlow: 4, progressGloss: 0.25, controlsGap: 24, playlistGap: 24 },
  },
  {
    id: "detroit", name: "Detroit", base: "dark", frame: "detroit", description: "Blue sci-fi interface: dark navy glass panels, thin light borders, corner brackets on the selected item and buttons whose borders have a moving light.",
    colors: {
      background: "#0b1a2b", text: "#dcecf7", textMuted: "#6f8ca6", border: "#35597a", accent: "#31c6ff", accentBorder: "#8fe3ff", accentText: "#04141f",
      buttonBackground: "#14304b", buttonHover: "#1d4262", buttonText: "#cfe6f5", panel: "#0f2740", panelRaised: "#17344f",
      badgesBackground: "#0c2236", badgeText: "#cfe6f5", badgeActiveBorder: "#8fe3ff", playerBackground: "#07121e",
      controlsBackground: "#0f2740", controlsText: "#dcecf7", progressTrack: "#1b3a57", progressBar: "#1fa8e6", progressBarEnd: "#8fe3ff",
      trackCurrent: "#31c6ff2e", trackHover: "#31c6ff14", rowStripe: "#ffffff08", rowSelected: "#31c6ff26", backdrop: "#020a12b3",
      errorText: "#ff7a7a", warningText: "#ffd36b", dangerBackground: "#a82a3a", dangerBorder: "#ff6b7d",
    },
    layout: { cornerRadius: 4, panelRadius: 2, shadowSize: 24, windowOpacity: 0.97, panelOpacity: 0.86, panelBlur: 14, panelBorder: 1, panelGlow: 8, progressGlow: 10, progressGloss: 0.35, textGlow: 2, controlsGap: 18, playlistGap: 18 },
  },
  {
    id: "rpg", name: "RPG style", base: "light", frame: "rpg", description: "Fantasy-game interface: carved wood frames with gold corner ornaments, parchment panels, gold and brown gradient buttons and capital letters in a serif face.",
    colors: {
      background: "#5a3a1c", text: "#3a2410", textMuted: "#7a5a38", border: "#7a4e24", accent: "#d9a553", accentBorder: "#3b2410", accentText: "#3a2410",
      buttonBackground: "#6e4826", buttonHover: "#86603a", buttonText: "#f5e6c4", panel: "#f1e3bf", panelRaised: "#e6d3a4",
      badgesBackground: "#e3d0a0", badgeText: "#3a2410", badgeActiveBorder: "#3b2410", playerBackground: "#1b120a",
      controlsBackground: "#5a3a1c", controlsText: "#f5e6c4", progressTrack: "#7d7a72", progressBar: "#b98a3a", progressBarEnd: "#efc66e",
      trackCurrent: "#d9a5532e", trackHover: "#b4823c26", rowStripe: "#7a4e2410", rowSelected: "#d9a5534d", backdrop: "#1b120acc",
      errorText: "#a82a1a", warningText: "#8a5a10", dangerBackground: "#a8402a", dangerBorder: "#3b2410",
    },
    layout: { cornerRadius: 24, panelRadius: 16, shadowSize: 28, windowOpacity: 1, panelOpacity: 1, panelBlur: 0, panelBorder: 0, panelGlow: 0, progressGlow: 0, progressGloss: 0.3, controlsGap: 18, playlistGap: 18 },
  },
  {
    id: "orange-terminal", name: "Orange terminal", base: "dark", frame: "terminal", description: "Amber terminal: black screen, orange monospace text, a thick orange border around the window, a filled orange title bar and panels cut by thin orange lines.",
    colors: {
      background: "#0d0a04", text: "#ffb21e", textMuted: "#b9780f", border: "#ffb21e", accent: "#ffb21e", accentBorder: "#ffc94d", accentText: "#0d0a04",
      buttonBackground: "#17110a", buttonHover: "#2a1d08", buttonText: "#ffb21e", panel: "#100c05", panelRaised: "#1b1407",
      badgesBackground: "#0b0803", badgeText: "#ffb21e", badgeActiveBorder: "#ffc94d", playerBackground: "#050301",
      controlsBackground: "#100c05", controlsText: "#ffb21e", progressTrack: "#3a2a0a", progressBar: "#ffb21e",
      trackCurrent: "#ffb21e", trackHover: "#ffb21e26", rowStripe: "#ffb21e0d", rowSelected: "#ffb21e40", backdrop: "#000000cc",
      errorText: "#ff6a4a", warningText: "#ffd24a", dangerBackground: "#8a2a10", dangerBorder: "#ff6a4a",
    },
    layout: { cornerRadius: 0, panelRadius: 0, shadowSize: 0, windowOpacity: 1, panelOpacity: 1, panelBlur: 0, panelBorder: 2, panelGlow: 8, progressGlow: 8, progressGloss: 0, textGlow: 4, scanlines: 0.18, monospace: true, controlsGap: 14, playlistGap: 14 },
  },
  {
    id: "re4", name: "RE4", base: "dark", frame: "re4", description: "Worn dark-book interface: charcoal smoke, pale serif text, thin dividing lines and a smudged light brush stroke behind the chosen item.",
    colors: {
      background: "#0c0c0d", text: "#d8d5cf", textMuted: "#8b8982", border: "#4b4a46", accent: "#cfcbc2", accentBorder: "#f1eee7", accentText: "#101011",
      buttonBackground: "#1a1a1b", buttonHover: "#2b2b2c", buttonText: "#d8d5cf", panel: "#141415", panelRaised: "#1f1f20",
      badgesBackground: "#101011", badgeText: "#d8d5cf", badgeActiveBorder: "#f1eee7", playerBackground: "#050505",
      controlsBackground: "#131314", controlsText: "#e4e1da", progressTrack: "#3a3936", progressBar: "#cfcbc2", progressBarEnd: "#f1eee7",
      trackCurrent: "#cfcbc247", trackHover: "#cfcbc21a", rowStripe: "#ffffff06", rowSelected: "#cfcbc238", backdrop: "#000000b8",
      errorText: "#e0705a", warningText: "#d9b45a", dangerBackground: "#6e2a22", dangerBorder: "#c4503f",
    },
    layout: { cornerRadius: 6, panelRadius: 2, shadowSize: 22, windowOpacity: 0.98, panelOpacity: 0.88, panelBlur: 6, panelBorder: 0, panelGlow: 0, progressGlow: 0, progressGloss: 0, textGlow: 0, controlsGap: 16, playlistGap: 16 },
  },
  {
    id: "re-requiem", name: "RE Requiem", base: "dark", frame: "requiem", description: "Dark tactical inventory: charcoal grid-lined square cells with notched corners, thin white bars and a red glowing selection.",
    colors: {
      background: "#0e0f10", text: "#dedede", textMuted: "#8c9094", border: "#3b3d40", accent: "#c4343a", accentBorder: "#e8575e", accentText: "#ffffff",
      buttonBackground: "#1c1e20", buttonHover: "#2a2d30", buttonText: "#e4e4e4", panel: "#151617", panelRaised: "#1f2123",
      badgesBackground: "#101112", badgeText: "#e4e4e4", badgeActiveBorder: "#e8575e", playerBackground: "#050505",
      controlsBackground: "#131415", controlsText: "#ececec", progressTrack: "#2d2f31", progressBar: "#e6e6e6", progressBarEnd: "#e6e6e6",
      trackCurrent: "#c4343a4d", trackHover: "#ffffff12", rowStripe: "#ffffff05", rowSelected: "#c4343a40", backdrop: "#000000bf",
      errorText: "#ff6b6b", warningText: "#e0b84a", dangerBackground: "#8a1f25", dangerBorder: "#e8575e",
    },
    layout: { cornerRadius: 4, panelRadius: 0, shadowSize: 22, windowOpacity: 0.97, panelOpacity: 0.9, panelBlur: 4, panelBorder: 1, panelGlow: 0, progressGlow: 0, progressGloss: 0, textGlow: 0, controlsGap: 16, playlistGap: 16 },
  },
  {
    id: "cyberpunk-2", name: "Cyberpunk 2.0", base: "dark", frame: "cyberpunk2", description: "Neon cyberpunk interface built from the Cyberpunk UI asset pack images: a chamfered glowing window frame, image buttons with hover and pressed states, and an image progress bar.",
    colors: {
      background: "#060b12", text: "#c6f8ff", textMuted: "#5fb6c4", border: "#1fc8d6", accent: "#19e6f0", accentBorder: "#7ffbff", accentText: "#031318",
      buttonBackground: "#101a2b", buttonHover: "#16263d", buttonText: "#c6f8ff", panel: "#0b1420", panelRaised: "#122033",
      badgesBackground: "#0a121d", badgeText: "#c6f8ff", badgeActiveBorder: "#7ffbff", playerBackground: "#03070c",
      controlsBackground: "#0b1420", controlsText: "#d9fbff", progressTrack: "#14243a", progressBar: "#19e6f0", progressBarEnd: "#7ffbff",
      trackCurrent: "#19e6f033", trackHover: "#19e6f01a", rowStripe: "#19e6f008", rowSelected: "#19e6f040", backdrop: "#02060ccc",
      errorText: "#ff6f8a", warningText: "#ffd45a", dangerBackground: "#8a1f4a", dangerBorder: "#ff4d8d",
    },
    layout: { cornerRadius: 0, panelRadius: 0, shadowSize: 0, windowOpacity: 1, panelOpacity: 1, panelBlur: 0, panelBorder: 0, panelGlow: 0, progressGlow: 8, progressGloss: 0, textGlow: 3, controlsGap: 10, playlistGap: 10 },
  },
  {
    id: "rosegold", name: "Rose gold", base: "dark", description: "Graphite floating design with rose-gold highlights and a glowing gradient progress bar.",
    colors: { background: "#232428", text: "#ece6e2", textMuted: "#a79f9b", border: "#55565c", panel: "#3d3e44", panelRaised: "#4a4b52", buttonBackground: "#4a4b52", buttonHover: "#5a5b63", buttonText: "#ece6e2", accent: "#c98f7d", accentBorder: "#e6b4a0", accentText: "#2a1c17", playerBackground: "#17181b", controlsBackground: "#3d3e44", controlsText: "#ece6e2", progressTrack: "#26272b", progressBar: "#b9786a", progressBarEnd: "#f0c2ae" },
    layout: { cornerRadius: 30, panelRadius: 26, panelOpacity: 0.94, panelBlur: 8, progressGlow: 16, progressGloss: 0.9 },
  },
  {
    id: "cyberpunk", name: "Cyberpunk", base: "dark", description: "Squared neon design: crimson black, cyan panels with glowing edges, scanlines and a terminal font.",
    colors: {
      background: "#14070c", text: "#5fe3f0", textMuted: "#3b9aa8", border: "#2f8fa0", accent: "#ff4a42", accentBorder: "#ff7a70", accentText: "#14070c",
      buttonBackground: "#0f2a33", buttonHover: "#17414f", buttonText: "#5fe3f0", panel: "#0f2a33", panelRaised: "#143743",
      badgesBackground: "#0b1f27", badgeText: "#5fe3f0", badgeActiveBorder: "#ff4a42", playerBackground: "#0a0306",
      controlsBackground: "#0f2a33", controlsText: "#5fe3f0", progressTrack: "#2a0d12", progressBar: "#d8322c", progressBarEnd: "#ff6a5e",
      trackCurrent: "#ff4a4233", trackHover: "#5fe3f022", rowStripe: "#5fe3f00d", rowSelected: "#5fe3f01f", errorText: "#ff4a42", warningText: "#ffd24a",
      dangerBackground: "#b3241f", dangerBorder: "#ff4a42", backdrop: "#0a0306cc",
    },
    layout: { cornerRadius: 2, panelRadius: 2, shadowSize: 18, panelOpacity: 0.9, panelBlur: 6, panelBorder: 1, panelGlow: 12, progressGlow: 14, textGlow: 5, scanlines: 0.2, monospace: true, controlsGap: 18, playlistGap: 18 },
  },
  {
    id: "fallout-2", name: "Fallout 2", base: "dark", description: "Squared wasteland design: olive metal frames, green phosphor text and a thick border.",
    colors: {
      background: "#1b1a14", text: "#3dff4a", textMuted: "#22b52e", border: "#6b6a4f", accent: "#d4c23a", accentBorder: "#ece07a", accentText: "#1b1a14",
      buttonBackground: "#3a3826", buttonHover: "#4b4832", buttonText: "#d9d27a", panel: "#26241b", panelRaised: "#33301f",
      badgesBackground: "#211f17", badgeText: "#3dff4a", badgeActiveBorder: "#d4c23a", playerBackground: "#080d08",
      controlsBackground: "#26241b", controlsText: "#3dff4a", progressTrack: "#0e1a0e", progressBar: "#22c030", progressBarEnd: "#8dff7a",
      trackCurrent: "#3dff4a26", trackHover: "#3dff4a14", rowStripe: "#3dff4a0a", rowSelected: "#3dff4a1c", errorText: "#ff6a4a", warningText: "#e8d24a",
      dangerBackground: "#7a2a1a", dangerBorder: "#c2563a", backdrop: "#050805cc",
    },
    layout: { cornerRadius: 4, panelRadius: 3, shadowSize: 14, panelOpacity: 1, panelBorder: 3, textGlow: 4, scanlines: 0.2, monospace: true, controlsGap: 16, playlistGap: 16 },
  },
  {
    id: "townfall-crt", name: "Townfall CRT", base: "dark", description: "Squared retro-terminal design: weathered grey-olive metal, brass edges and an amber glowing CRT screen.",
    colors: {
      background: "#2c2b27", text: "#ffb347", textMuted: "#c28a3a", border: "#8a7a46", accent: "#d98a1f", accentBorder: "#f2b24a", accentText: "#1a1006",
      buttonBackground: "#4a4943", buttonHover: "#5c5a52", buttonText: "#ffb347", panel: "#3b3a35", panelRaised: "#4a4943",
      badgesBackground: "#33322e", badgeText: "#ffb347", badgeActiveBorder: "#f2b24a", playerBackground: "#140c04",
      controlsBackground: "#3b3a35", controlsText: "#ffb347", progressTrack: "#1a1008", progressBar: "#c97a12", progressBarEnd: "#ffc766",
      trackCurrent: "#ffb34730", trackHover: "#ffb34718", rowStripe: "#ffb3470c", rowSelected: "#ffb34722", errorText: "#ff7a4a", warningText: "#ffd24a",
      dangerBackground: "#8a3a14", dangerBorder: "#d9742a", backdrop: "#0c0803cc",
    },
    layout: { cornerRadius: 6, panelRadius: 6, shadowSize: 16, panelBorder: 2, panelGlow: 8, progressGlow: 12, progressGloss: 0.3, textGlow: 7, scanlines: 0.22, monospace: true, controlsGap: 18, playlistGap: 18 },
  },
  {
    id: "green-console", name: "Green console", base: "dark", description: "Squared control-room design: charcoal metal, grey keys and bright green phosphor screens with a glossy glowing progress bar.",
    colors: {
      background: "#1c1d1f", text: "#7dff4a", textMuted: "#4fa82e", border: "#3a3c40", accent: "#7dff4a", accentBorder: "#b4ff8a", accentText: "#0b1a06",
      buttonBackground: "#3a3b3f", buttonHover: "#4a4b50", buttonText: "#d7d9da", panel: "#2a2b2e", panelRaised: "#35363a",
      badgesBackground: "#232427", badgeText: "#7dff4a", badgeActiveBorder: "#7dff4a", playerBackground: "#050a04",
      controlsBackground: "#2a2b2e", controlsText: "#7dff4a", progressTrack: "#0b1408", progressBar: "#3fbf1f", progressBarEnd: "#9dff6a",
      trackCurrent: "#7dff4a2b", trackHover: "#7dff4a16", rowStripe: "#7dff4a0a", rowSelected: "#7dff4a1f", errorText: "#ff5a3a", warningText: "#ffb02e",
      dangerBackground: "#b3261e", dangerBorder: "#ff5a3a", backdrop: "#050805cc",
    },
    layout: { cornerRadius: 10, panelRadius: 8, shadowSize: 20, panelBorder: 2, panelGlow: 6, progressGlow: 12, progressGloss: 0.4, textGlow: 4, scanlines: 0.15, monospace: true, controlsGap: 18, playlistGap: 18 },
  },
  {
    id: "cream-keys", name: "Cream keys", base: "dark", description: "Squared keyboard-panel design: black body, cream keys with thin cream lines and a cyan highlight.",
    colors: {
      background: "#0f0d0b", text: "#f0dc8c", textMuted: "#a89a62", border: "#8a7d4a", accent: "#f0dc8c", accentBorder: "#fff0b0", accentText: "#16120a",
      buttonBackground: "#e8d58a", buttonHover: "#f6e6a4", buttonText: "#16120a", panel: "#17140f", panelRaised: "#221e16",
      badgesBackground: "#120f0b", badgeText: "#f0dc8c", badgeActiveBorder: "#3ec8e8", playerBackground: "#050a10",
      controlsBackground: "#17140f", controlsText: "#f0dc8c", progressTrack: "#0a0806", progressBar: "#e8d58a", progressBarEnd: "#f6e8a8",
      trackCurrent: "#3ec8e82b", trackHover: "#f0dc8c18", rowStripe: "#f0dc8c0a", rowSelected: "#f0dc8c1f", errorText: "#ff6a4a", warningText: "#f0b84a",
      dangerBackground: "#a82a1c", dangerBorder: "#ff6a4a", backdrop: "#060504cc",
    },
    layout: { cornerRadius: 4, panelRadius: 4, shadowSize: 14, panelBorder: 1, scanlines: 0.06, monospace: true, controlsGap: 16, playlistGap: 16 },
  },
];

function floatingTheme(design) {
  const theme = builtinTheme(design.base);
  return {
    $schema: theme.$schema,
    schemaVersion: 1,
    id: design.id,
    name: design.name,
    base: design.base,
    windowStyle: "experimental",
    ...(design.frame ? { frame: design.frame } : {}),
    description: design.description,
    // A design that sets only the progress bar color gets a flat bar (no red gradient end from the base theme).
    colors: { ...theme.colors, ...design.colors, ...(design.colors.progressBar && !design.colors.progressBarEnd ? { progressBarEnd: design.colors.progressBar } : {}) },
    ...(Object.keys(design.layout).length ? { layout: design.layout } : {}),
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
    downloads: {
      mode: "separate",
      videoQuality: "1080",
      audioQuality: "best",
      folder: "",
      delayBetweenVideos: 3,
      speedLimitKbps: 0,
      autoResume: true,
      cookiesBrowser: "",
    },
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
    ...Object.fromEntries(FLOATING_DESIGNS.map((d) => [`src/builtin-themes/${d.id}.json`, json(floatingTheme(d))])),
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
