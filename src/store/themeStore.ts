import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { tr } from "../translate";
import { BUILTIN_THEMES, themeProblems, isBuiltin, makeThemeId, type ColorToken, type IconSlot, type Theme, type ThemeBase } from "../theme/themeEngine";

interface ThemeState {
  /** Themes the user made or imported (built-in ones are in BUILTIN_THEMES). */
  custom: Theme[];
  /** "system" (follow the operating system) or the id of a theme. Saved in the general settings. */
  selected: string;
  /** The operating system is set to dark. */
  systemDark: boolean;
  load: () => Promise<void>;
  setSystemDark: (dark: boolean) => void;
  select: (id: string) => void;
  /** New custom theme based on a built-in one (or a copy of any theme); returns its id and selects it. */
  create: (name: string, base: ThemeBase, from?: Theme) => string;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  setColor: (id: string, token: ColorToken, value: string | null) => void;
  setIcon: (id: string, slot: IconSlot, ref: string | null) => void;
  exportText: (id: string) => string | null;
  /** Add a theme from file text. Throws a readable Error when the file is not a valid theme. */
  importText: (text: string) => Theme;
}

/** The theme in use now: the selected one, or dark/light following the system. */
export function activeTheme(s: Pick<ThemeState, "custom" | "selected" | "systemDark">): Theme {
  if (s.selected !== "system") {
    const found = [...BUILTIN_THEMES, ...s.custom].find((t) => t.id === s.selected);
    if (found) return found;
  }
  return BUILTIN_THEMES.find((t) => t.id === (s.systemDark ? "dark" : "light"))!;
}

// Saving a theme file: while one write is running, further changes only mark the theme as dirty and
// one more write follows, so dragging a color picker does not queue a write per mouse move.
const writing = new Set<string>();
const dirty = new Set<string>();
async function persist(id: string) {
  if (writing.has(id)) {
    dirty.add(id);
    return;
  }
  writing.add(id);
  try {
    do {
      dirty.delete(id);
      const theme = useThemeStore.getState().custom.find((t) => t.id === id);
      if (!theme) break;
      await invoke("theme_save", { id, json: JSON.stringify(theme, null, 2) });
    } while (dirty.has(id));
  } catch (e) {
    void import("./playlistLibraryStore").then((m) => m.usePlaylistLibraryStore.getState().setNotice(tr("appearance.saveFailed", { error: String(e) })));
  } finally {
    writing.delete(id);
  }
}

export const useThemeStore = create<ThemeState>()((set, get) => {
  const change = (id: string, fn: (t: Theme) => Theme) => {
    set((s) => ({ custom: s.custom.map((t) => (t.id === id ? fn(t) : t)) }));
    void persist(id);
  };
  return {
    custom: [],
    selected: "system",
    systemDark: typeof matchMedia !== "undefined" ? matchMedia("(prefers-color-scheme: dark)").matches : true,

    load: async () => {
      const problems: string[] = [];
      const custom: Theme[] = [];
      try {
        for (const text of await invoke<string[]>("theme_list")) {
          try {
            const value = JSON.parse(text);
            const errors = themeProblems(value);
            if (errors.length || isBuiltin(value.id)) problems.push(`${value?.name ?? "?"}: ${errors[0] ?? "reserved id"}`);
            else custom.push(value as Theme);
          } catch (e) {
            problems.push(String(e));
          }
        }
      } catch (e) {
        problems.push(String(e));
      }
      set({ custom });
      if (problems.length) {
        const { usePlaylistLibraryStore } = await import("./playlistLibraryStore");
        usePlaylistLibraryStore.getState().setNotice(tr("appearance.loadProblems", { problems: problems.join("; ") }));
      }
    },
    setSystemDark: (systemDark) => set({ systemDark }),
    select: (selected) => set({ selected }),

    create: (name, base, from) => {
      const source = from ?? BUILTIN_THEMES.find((t) => t.id === base)!;
      const id = makeThemeId(name, get().custom.map((t) => t.id));
      // A new theme lists no colors of its own when based on a built-in one: it follows the base.
      const theme: Theme = {
        schemaVersion: 1,
        id,
        name: name.trim() || "Theme",
        base: source.base,
        ...(isBuiltin(source.id) ? {} : { colors: { ...source.colors }, icons: { ...source.icons } }),
      };
      set((s) => ({ custom: [...s.custom, theme], selected: id }));
      void persist(id);
      return id;
    },
    rename: (id, name) => {
      if (name.trim()) change(id, (t) => ({ ...t, name: name.trim() }));
    },
    remove: (id) => {
      set((s) => ({ custom: s.custom.filter((t) => t.id !== id), selected: s.selected === id ? "system" : s.selected }));
      void invoke("theme_delete", { id }).catch(() => {});
    },
    setColor: (id, token, value) =>
      change(id, (t) => {
        const colors = { ...t.colors };
        if (value === null) delete colors[token];
        else colors[token] = value;
        return { ...t, colors };
      }),
    setIcon: (id, slot, ref) =>
      change(id, (t) => {
        const icons = { ...t.icons };
        if (ref === null) delete icons[slot];
        else icons[slot] = ref;
        return { ...t, icons };
      }),

    exportText: (id) => {
      const theme = [...BUILTIN_THEMES, ...get().custom].find((t) => t.id === id);
      if (!theme) return null;
      const { $schema: _link, ...clean } = theme as Theme & { $schema?: string }; // the built-in files link a schema by a repo-relative path
      return JSON.stringify(clean, null, 2) + "\n";
    },
    importText: (text) => {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error(tr("appearance.notJson"));
      }
      const errors = themeProblems(value);
      if (errors.length) throw new Error(errors.slice(0, 3).join("; "));
      // The file's id may already be taken (or be 'dark' / 'light'): then the copy gets a new one.
      const incoming = value as Theme;
      const id = makeThemeId(incoming.id, get().custom.map((t) => t.id));
      const theme: Theme = { ...incoming, id: get().custom.some((t) => t.id === incoming.id) || isBuiltin(incoming.id) ? id : incoming.id };
      delete (theme as Partial<Theme> & { $schema?: string }).$schema;
      set((s) => ({ custom: [...s.custom, theme], selected: theme.id }));
      void persist(theme.id);
      return theme;
    },
  };
});
