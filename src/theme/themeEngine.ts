import builtinPack from "../icons/builtin.json";
import icomoonPack from "../icons/icomoon.json";
import themeSchema from "../../schemas/theme.schema.json";
import { validate } from "../jsonSchemaValidator";
import darkJson from "../builtin-themes/dark.json";
import lightJson from "../builtin-themes/light.json";
import studioJson from "../builtin-themes/studio.json";
import studioDarkJson from "../builtin-themes/studio-dark.json";
import espressoJson from "../builtin-themes/espresso.json";
import latteJson from "../builtin-themes/latte.json";
import midnightJson from "../builtin-themes/midnight.json";
import glassJson from "../builtin-themes/glass.json";
import detroitJson from "../builtin-themes/detroit.json";
import rpgJson from "../builtin-themes/rpg.json";
import glassBlurJson from "../builtin-themes/glass-blur.json";
import rosegoldJson from "../builtin-themes/rosegold.json";
import cyberpunkJson from "../builtin-themes/cyberpunk.json";
import falloutJson from "../builtin-themes/fallout-2.json";
import townfallJson from "../builtin-themes/townfall-crt.json";
import greenConsoleJson from "../builtin-themes/green-console.json";
import creamKeysJson from "../builtin-themes/cream-keys.json";
import { applyWindowLayout, type LayoutKey } from "./windowLayout";
import registry from "./registry.json";

export type ColorToken = keyof typeof registry.colors;
export type IconSlot = keyof typeof registry.iconSlots;
export type ThemeBase = "dark" | "light";

/** A theme as stored in a file (see schemas/theme.schema.json). */
export interface Theme {
  schemaVersion: 1;
  id: string;
  name: string;
  base: ThemeBase;
  /** "experimental": frameless transparent rounded window. Missing means "regular". */
  windowStyle?: "regular" | "experimental";
  /** Floating style only: "detroit" draws double-line borders, corner brackets and moving button borders; "rpg" draws wood frames with gold corner ornaments. Missing means "plain". */
  frame?: "plain" | "detroit" | "rpg";
  /** Settings of the experimental window style (see src/theme/registry.json "layout"). */
  layout?: Partial<Record<LayoutKey, number | boolean>>;
  description?: string;
  author?: string;
  colors?: Partial<Record<ColorToken, string>>;
  icons?: Partial<Record<IconSlot, string>>;
}

export const BUILTIN_THEMES: Theme[] = [darkJson, lightJson, studioJson, studioDarkJson, espressoJson, latteJson, midnightJson, glassJson, glassBlurJson, detroitJson, rpgJson, rosegoldJson, cyberpunkJson, falloutJson, townfallJson, greenConsoleJson, creamKeysJson] as Theme[];

export const COLOR_TOKENS = Object.entries(registry.colors).map(([id, c]) => ({ id: id as ColorToken, ...c }));
export const ICON_SLOTS = Object.entries(registry.iconSlots).map(([id, s]) => ({ id: id as IconSlot, ...s }));
export const COLOR_GROUPS = Object.entries(registry.groups).map(([id, g]) => ({ id, ...g }));

// ---- icons -----------------------------------------------------------------------------------
interface IconData {
  viewBox: string;
  paths: string[];
}
const PACKS: Record<string, { icons: Record<string, IconData> }> = { builtin: builtinPack, icomoon: icomoonPack };

/** The drawing data of an icon reference such as "icomoon:play3", or null if there is no such icon. */
export function iconData(ref: string): IconData | null {
  const [set, name] = ref.split(":");
  return PACKS[set]?.icons[name] ?? null;
}

/** Every icon that can be chosen, as "<set>:<name>" (built-in set first). */
export const ALL_ICON_REFS: string[] = ["builtin", "icomoon"].flatMap((set) =>
  Object.keys(PACKS[set].icons).map((name) => `${set}:${name}`),
);

export function defaultIconRef(slot: IconSlot): string {
  return registry.iconSlots[slot].default;
}

export function iconRefOf(theme: Theme, slot: IconSlot): string {
  const ref = theme.icons?.[slot];
  return ref && iconData(ref) ? ref : defaultIconRef(slot);
}

// ---- colors ----------------------------------------------------------------------------------
/** Every color token of a theme: its own values over the base theme's. */
export function colorsOf(theme: Theme): Record<ColorToken, string> {
  const base = theme.base === "light" ? lightJson.colors : darkJson.colors;
  const colors = { ...base, ...theme.colors } as Record<ColorToken, string>;
  // A theme that changes the progress bar color but says nothing about the gradient end gets a flat bar
  // (the end color would otherwise come from the base theme and show up as a stray red tip).
  if (theme.colors?.progressBar && !theme.colors.progressBarEnd) colors.progressBarEnd = colors.progressBar;
  return colors;
}

/** Put a theme on the page: its colors as CSS variables, and light/dark control styling. */
export function applyThemeToDocument(theme: Theme) {
  const root = document.documentElement;
  const colors = colorsOf(theme);
  for (const token of COLOR_TOKENS) root.style.setProperty(token.cssVar, colors[token.id]);
  root.dataset.theme = theme.base;
  root.style.colorScheme = theme.base;
  // Window style (floating or regular) and its layout; also sets the native window's background.
  applyWindowLayout(theme, colors.playerBackground);
}

// ---- validation ------------------------------------------------------------------------------
/** Problems found in unknown data that should be a theme; empty when it is valid. */
export function themeProblems(value: unknown): string[] {
  const errors = validate(themeSchema, value);
  if (errors.length) return errors;
  const theme = value as Theme;
  for (const [slot, ref] of Object.entries(theme.icons ?? {})) {
    if (!iconData(ref as string)) errors.push(`/icons/${slot}: there is no icon "${ref}"`);
  }
  return errors;
}

// ---- helpers ---------------------------------------------------------------------------------
export const isBuiltin = (id: string) => BUILTIN_THEMES.some((t) => t.id === id);

/** An id for a new theme: the name as a slug plus a short random suffix. */
export function makeThemeId(name: string, taken: string[]): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "theme";
  let id = slug;
  while (taken.includes(id) || isBuiltin(id)) id = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
  return id;
}
