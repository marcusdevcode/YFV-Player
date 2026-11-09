import { create } from "zustand";
import { persist } from "zustand/middleware";
import { fileStorage } from "../fileStorage";

const KEEP = 300;

/** The settings file name; the Rust side adds the last position to this file when the program exits. */
export const POSITIONS_STORE_NAME = `${__APP_ID__}:positions`;

interface PlaybackPositionState {
  /** Where each video was left (seconds), newest last. */
  positions: Record<string, number>;
  setPosition: (path: string, seconds: number) => void;
}

export const usePlaybackPositionStore = create<PlaybackPositionState>()(
  persist(
    (set) => ({
      positions: {},
      setPosition: (path, seconds) =>
        set((s) => {
          const next = { ...s.positions };
          delete next[path]; // re-insert so the newest are last
          next[path] = seconds;
          const keys = Object.keys(next);
          for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete next[k];
          return { positions: next };
        }),
    }),
    { name: POSITIONS_STORE_NAME, storage: fileStorage },
  ),
);
