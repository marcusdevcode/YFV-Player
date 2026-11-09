import { create } from "zustand";
import { isAudioPath, isMediaPath, isVideoPath } from "../mediaFiles";

export type AddMode = "video" | "pair";
export type AddTab = "files" | "youtube";

interface AddState {
  open: boolean;
  /** Local files, or search/links on YouTube. */
  tab: AddTab;
  mode: AddMode;
  /** Every file dropped or chosen so far (the dialog turns them into items). */
  paths: string[];
  /** Items the user unticked. */
  unchecked: string[];
  targetId: string | null;
  openWith: (paths?: string[]) => void;
  openYouTube: () => void;
  setTab: (tab: AddTab) => void;
  addPaths: (paths: string[]) => void;
  setMode: (m: AddMode) => void;
  toggle: (id: string) => void;
  setTarget: (id: string | null) => void;
  close: () => void;
}

export const useAddDialogStore = create<AddState>()((set) => ({
  open: false,
  tab: "files",
  mode: "video",
  paths: [],
  unchecked: [],
  targetId: null,
  // A drop that holds both video and audio files starts in "video + separate audio" mode.
  openWith: (paths = []) =>
    set((s) => ({
      open: true,
      tab: "files",
      paths: s.open ? [...new Set([...s.paths, ...paths])] : [...new Set(paths)],
      unchecked: s.open ? s.unchecked : [],
      mode: !s.open && paths.some(isVideoPath) && paths.some(isAudioPath) ? "pair" : s.mode,
    })),
  openYouTube: () => set({ open: true, tab: "youtube" }),
  setTab: (tab) => set({ tab }),
  addPaths: (paths) => set((s) => ({ paths: [...new Set([...s.paths, ...paths.filter(isMediaPath)])] })),
  setMode: (mode) => set({ mode }),
  toggle: (id) => set((s) => ({ unchecked: s.unchecked.includes(id) ? s.unchecked.filter((u) => u !== id) : [...s.unchecked, id] })),
  setTarget: (targetId) => set({ targetId }),
  close: () => set({ open: false, paths: [], unchecked: [] }),
}));
