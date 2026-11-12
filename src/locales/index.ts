// Languages are the .json files in this folder: adding a file adds a language (the file name is
// the language code, for example `fr.json`). Copy `en.json` and translate it. A file holds:
//   name         how the language is called in its own language (shown in Settings)
//   dir          "ltr" or "rtl": the reading direction of the texts
//   sidebarSide  "left" or "right": where the playlist panel is placed by default in this language
//   strings      the UI texts by key; a missing key falls back to English
// Plurals use the keys `<key>.one`, `<key>.two`, `<key>.few`, `<key>.many`, `<key>.other`,
// chosen by the language's own plural rules; `.other` must exist.

import en from "./en.json";

export type SidebarSide = "left" | "right";

export interface Locale {
  name: string;
  dir: "ltr" | "rtl";
  sidebarSide: SidebarSide;
  strings?: Record<string, string>;
}

/** Every key of the English file: the keys the UI can ask for. */
export type TKey = keyof typeof en.strings;
/** Keys that have plural forms (`<base>.other` exists). */
export type PluralKey = TKey extends infer K ? (K extends `${infer B}.other` ? B : never) : never;

const modules = import.meta.glob<Locale>("./*.json", { eager: true, import: "default" });

export const LOCALES: Record<string, Locale> = Object.fromEntries(
  Object.entries(modules).map(([path, locale]) => [path.replace(/^\.\/(.*)\.json$/, "$1"), locale]),
);

export const DEFAULT_LANGUAGE = "en";

/** Where the playlist panel goes by default in a language. */
export function defaultSidebarSide(language: string): SidebarSide {
  return LOCALES[language]?.sidebarSide === "right" ? "right" : "left";
}

/** Add (or replace) a language while the app runs: a file the user imported (see src/translationFiles.ts). */
export function registerLocale(code: string, locale: Locale) {
  LOCALES[code] = locale;
}

/** Take an imported language away again; a built-in language of that code comes back. */
export function unregisterLocale(code: string) {
  const builtin = Object.entries(modules).find(([path]) => path === `./${code}.json`)?.[1];
  if (builtin) LOCALES[code] = builtin;
  else delete LOCALES[code];
}

/** True when the language is one of the files shipped in src/locales. */
export const isBuiltInLanguage = (code: string) => `./${code}.json` in modules;
