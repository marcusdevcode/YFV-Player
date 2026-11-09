import { create } from "zustand";
import { DEFAULT_LANGUAGE, LOCALES, defaultSidebarSide, type SidebarSide } from "../locales";

export type { SidebarSide };

interface InterfaceState {
  /** The playlist panel (badges + track list) is shown. */
  sidebarOpen: boolean;
  /** Which edge of the window the panel sits on; it slides in from and out to that edge. */
  sidebarSide: SidebarSide;
  /** Language code: the name of a file in src/locales. */
  language: string;
  settingsOpen: boolean;
  /** The Themes dialog (View -> Themes…). */
  themesOpen: boolean;
  /** The download manager (View -> Downloads…). */
  downloadsOpen: boolean;
  toggleSidebar: () => void;
  /** The user places the panel by hand: it stays there (until the language is changed). */
  setSidebarSide: (side: SidebarSide) => void;
  /** Changing the language puts the panel back to that language's default side. */
  setLanguage: (language: string) => void;
  setSettingsOpen: (open: boolean) => void;
  setThemesOpen: (open: boolean) => void;
  setDownloadsOpen: (open: boolean) => void;
}

// Not persisted here: src/generalSettings.ts saves language and panel state in the general settings file.
export const useInterfaceStore = create<InterfaceState>()((set) => ({
  sidebarOpen: true,
  sidebarSide: defaultSidebarSide(DEFAULT_LANGUAGE), // first launch only; afterwards the saved side wins
  language: DEFAULT_LANGUAGE, // English until the user picks another (then it is remembered)
  settingsOpen: false,
  themesOpen: false,
  downloadsOpen: false,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  // Moving it to the other side also opens it, so the change is visible.
  setSidebarSide: (sidebarSide) => set({ sidebarSide, sidebarOpen: true }),
  setLanguage: (language) => {
    if (LOCALES[language]) set({ language, sidebarSide: defaultSidebarSide(language), sidebarOpen: true });
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setThemesOpen: (themesOpen) => set({ themesOpen }),
  setDownloadsOpen: (downloadsOpen) => set({ downloadsOpen }),
}));
