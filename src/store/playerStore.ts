import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface Source {
  videoPath: string;
  audioPath?: string; // optional separate audio track
  title: string;
}

interface PlayerState {
  source: Source | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  /** Repeat the current video forever (independent from playlist loop). */
  videoLoop: boolean;
  /** 0..1. Remembered between runs together with `muted`. */
  volume: number;
  muted: boolean;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  setSource: (s: Source | null) => void;
  setPlaying: (v: boolean) => void;
  setTime: (t: number) => void;
  setDuration: (d: number) => void;
  toggleVideoLoop: () => void;
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set) => ({
      source: null,
      playing: false,
      currentTime: 0,
      duration: 0,
      videoLoop: false,
      volume: 1,
      muted: false,
      // Moving the slider up from 0 or while muted un-mutes; dragging to 0 counts as muted.
      setVolume: (v) => {
        const volume = Math.max(0, Math.min(1, v));
        set({ volume, muted: volume === 0 });
      },
      toggleMute: () =>
        set((s) =>
          s.muted || s.volume === 0 ? { muted: false, volume: s.volume === 0 ? 0.5 : s.volume } : { muted: true },
        ),
      setSource: (source) => set({ source, playing: false, currentTime: 0, duration: 0 }),
      setPlaying: (playing) => set({ playing }),
      setTime: (currentTime) => set({ currentTime }),
      setDuration: (duration) => set({ duration }),
      toggleVideoLoop: () => set((s) => ({ videoLoop: !s.videoLoop })),
    }),
    {
      name: `${__APP_ID__}:player`, // localStorage; the player works without it
      partialize: (s) => ({ volume: s.volume, muted: s.muted }),
    },
  ),
);
