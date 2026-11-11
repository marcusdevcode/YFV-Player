import { getCurrentWindow } from "@tauri-apps/api/window";
import registry from "./registry.json";
import type { Theme } from "./themeEngine";

/** One setting of the floating window style, from the registry (src/theme/registry.json). */
export interface LayoutField {
  id: LayoutKey;
  title: string;
  description: string;
  type: "number" | "boolean";
  minimum?: number;
  maximum?: number;
  step?: number;
  unit?: string;
  default: number | boolean;
}

export type LayoutKey = keyof typeof registry.layout;
export type WindowLayout = { [K in LayoutKey]: (typeof registry.layout)[K]["default"] extends boolean ? boolean : number };

export const LAYOUT_FIELDS = Object.entries(registry.layout).map(([id, f]) => ({ id: id as LayoutKey, ...f })) as LayoutField[];

/** Every layout value of a theme: its own, kept inside the allowed range, over the defaults. */
export function layoutOf(theme: Theme): WindowLayout {
  const out: Record<string, number | boolean> = {};
  for (const f of LAYOUT_FIELDS) {
    const own = (theme.layout as Record<string, unknown> | undefined)?.[f.id];
    if (f.type === "boolean") out[f.id] = typeof own === "boolean" ? own : (f.default as boolean);
    else out[f.id] = typeof own === "number" ? Math.min(f.maximum!, Math.max(f.minimum!, own)) : (f.default as number);
  }
  return out as unknown as WindowLayout;
}

/**
 * Put the theme's window style on the page and the window: CSS variables for the sizes, and the
 * native window's title bar, shadow, resizing and background (src/styles.css reads the variables).
 */
export function applyWindowLayout(theme: Theme, playerBackground: string) {
  const root = document.documentElement;
  const floating = theme.windowStyle === "experimental";
  const layout = layoutOf(theme);
  // With the system title bar the window has its own frame: no margin, rounding or shadow of ours.
  const framed = floating && layout.titleBar;
  const set = (name: string, value: string | number) => root.style.setProperty(`--layout-${name}`, String(value));
  set("margin", `${floating && !framed && layout.shadowSize > 0 ? Math.round(layout.shadowSize * 1.4 + 4) : 0}px`);
  set("window-radius", floating && !framed ? `${layout.cornerRadius}px` : "0px");
  set("shadow", framed ? "0px" : `${layout.shadowSize}px`);
  set("window-opacity", layout.windowOpacity);
  set("panel-radius", `${layout.panelRadius}px`);
  set("progress-glow", `${layout.progressGlow}px`);
  set("panel-border", `${layout.panelBorder}px`);
  set("panel-glow", `${layout.panelGlow}px`);
  set("scanlines", layout.scanlines);
  set("text-shadow", layout.textGlow > 0 ? `0 0 ${layout.textGlow}px currentColor` : "none");
  root.dataset.monospace = layout.monospace ? "yes" : "no";
  // Round (pill) shapes for big panel radii, square-ish shapes for small ones.
  const round = layout.panelRadius >= 20;
  set("button-radius", round ? "999px" : `${layout.panelRadius}px`);
  set("control-radius", round ? "50%" : `${layout.panelRadius}px`);
  set("bar-radius", round ? "999px" : `${Math.min(layout.panelRadius, 3)}px`);
  set("input-radius", `${Math.min(16, layout.panelRadius)}px`);
  set("progress-gloss", layout.progressGloss);
  set("panel-opacity", layout.panelOpacity);
  set("panel-blur", `${layout.panelBlur}px`);
  set("controls-gap", `${layout.controlsGap}px`);
  set("playlist-gap", `${layout.playlistGap}px`);
  root.dataset.windowStyle = floating ? "experimental" : "regular";
  const resizable = !floating || layout.resizable;
  root.dataset.windowResizable = resizable ? "yes" : "no";

  const window = getCurrentWindow();
  const decorated = !floating || framed;
  void window.setDecorations(decorated).catch(() => {});
  void window.setShadow(decorated).catch(() => {});
  void window.isFullscreen().then((full) => window.setResizable(resizable || full)).catch(() => {});
  // The window's own background shows where the page has not been redrawn yet; transparent when floating.
  void window.setBackgroundColor(floating ? "#00000000" : playerBackground).catch(() => {});
}
