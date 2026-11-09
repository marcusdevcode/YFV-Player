import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useContextMenuStore } from "../store/contextMenuStore";

/**
 * The app's own right-click menu. The system's menu is switched off for the whole window; areas
 * that have something to offer call openContextMenu (src/store/contextMenuStore.ts).
 */
export default function ContextMenu() {
  const menu = useContextMenuStore((s) => s.menu);
  const close = useContextMenuStore((s) => s.close);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // The system menu never appears, anywhere in the window.
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
  }, []);

  // Closes on a click elsewhere, Escape, the window losing focus, resizing or scrolling.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close, true);
    };
  }, [menu, close]);

  // Keep the whole menu inside the window: measured after it is drawn, before it is painted.
  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null);
      return;
    }
    const { width, height } = ref.current.getBoundingClientRect();
    const margin = 4;
    setPos({
      left: Math.max(margin, Math.min(menu.x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(menu.y, window.innerHeight - height - margin)),
    });
  }, [menu]);

  if (!menu) return null;
  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={{ left: pos?.left ?? menu.x, top: pos?.top ?? menu.y, visibility: pos ? "visible" : "hidden" }}
      // Keep the focus (and the text selection) where it was, so Cut / Copy / Paste act on it.
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) =>
        item === "separator" ? (
          <div key={i} className="context-separator" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={item.danger ? "danger-text" : ""}
            disabled={item.disabled}
            onClick={() => {
              close();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
