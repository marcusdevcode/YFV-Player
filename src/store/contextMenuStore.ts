import { create } from "zustand";

/** One line of the right-click menu, or a divider between groups. */
export type ContextMenuItem =
  | { label: string; onSelect: () => void; disabled?: boolean; danger?: boolean }
  | "separator";

interface ContextMenuState {
  /** Where the menu opens (window coordinates), and what it lists. null = closed. */
  menu: { x: number; y: number; items: ContextMenuItem[] } | null;
  show: (x: number, y: number, items: ContextMenuItem[]) => void;
  close: () => void;
}

export const useContextMenuStore = create<ContextMenuState>()((set) => ({
  menu: null,
  show: (x, y, items) => set({ menu: { x, y, items } }),
  close: () => set({ menu: null }),
}));

/**
 * Open the app's own right-click menu at the pointer and stop the click from reaching the
 * menu of a parent area (the innermost area decides what is listed).
 */
export function openContextMenu(
  e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void },
  items: ContextMenuItem[],
): void {
  e.preventDefault();
  e.stopPropagation();
  useContextMenuStore.getState().show(e.clientX, e.clientY, items);
}
