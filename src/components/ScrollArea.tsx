import type { ComponentProps } from "react";
import { OverlayScrollbarsComponent } from "overlayscrollbars-react";
import "overlayscrollbars/styles/overlayscrollbars.css";

/**
 * A box whose content scrolls with the app's own scrollbar (the OverlayScrollbars library) instead of the system's.
 * The scrollbar is drawn from the theme's progress bar colors and shape (see "os-theme-app" in src/styles.css),
 * so it looks like the player's sliders in every theme. It takes the same props as a `div`; the children live in an
 * inner element that scrolls, so layout rules for the children (flex, grid, gap) are written for
 * `[data-overlayscrollbars-viewport]` in the stylesheet.
 */
export default function ScrollArea(props: Omit<ComponentProps<"div">, "ref">) {
  return (
    <OverlayScrollbarsComponent
      {...props}
      element="div"
      options={{ scrollbars: { theme: "os-theme-app", autoHide: "never", clickScroll: true }, overflow: { x: "hidden" } }}
    />
  );
}
