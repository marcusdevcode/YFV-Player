import { create } from "zustand";
import { persist } from "zustand/middleware";
import { fileStorage } from "../fileStorage";

export interface Source {
  videoPath: string;
  audioPath?: string; // optional separate audio track
  title: string;
}

interface PlayerState {
  source: Source | null;
  /** Changes on every setSource, even for the same file, so the player starts over from the beginning. */
  playId: number;
  /** False for the video restored at startup: it waits, paused, at its saved position. */
  autoStart: boolean;
  /** The player was torn down while playing (for example rebuilt after a code change): the next one plays on. */
  resumeAfterRemount: boolean;
  /** The current video was chosen from a playlist: it starts at the beginning. */
  fromStart: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  /** Repeat the current video forever (independent from playlist loop). */
  videoLoop: boolean;
  /** 0..1. Remembered between runs together with `muted`. */
  volume: number;
  muted: boolean;
  /** With a separate audio file, pause the video (not the audio) while the window is in the background. */
  pauseVideoInBackground: boolean;
  setPauseVideoInBackground: (v: boolean) => void;
  /** The window is fullscreen (the side panels hide). Not remembered. */
  fullscreen: boolean;
  setFullscreen: (v: boolean) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  /** `fromStart`: ignore the remembered position of this video and begin at 0:00. */
  setSource: (s: Source | null, fromStart?: boolean) => void;
  setPlaying: (v: boolean) => void;
  setTime: (t: number) => void;
  setDuration: (d: number) => void;
  toggleVideoLoop: () => void;
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set) => ({
      source: null,
      playId: 0,
      autoStart: false,
      fromStart: false,
      resumeAfterRemount: false,
      playing: false,
      currentTime: 0,
      duration: 0,
      videoLoop: false,
      volume: 1,
      muted: false,
      pauseVideoInBackground: true,
      setPauseVideoInBackground: (pauseVideoInBackground) => set({ pauseVideoInBackground }),
      fullscreen: false,
      setFullscreen: (fullscreen) => set({ fullscreen }),
      // Moving the slider up from 0 or while muted un-mutes; dragging to 0 counts as muted.
      setVolume: (v) => {
        const volume = Math.max(0, Math.min(1, v));
        set({ volume, muted: volume === 0 });
      },
      toggleMute: () =>
        set((s) =>
          s.muted || s.volume === 0 ? { muted: false, volume: s.volume === 0 ? 0.5 : s.volume } : { muted: true },
        ),
      setSource: (source, fromStart = false) => set((s) => ({ source, playId: s.playId + 1, autoStart: true, fromStart, playing: false, currentTime: 0, duration: 0 })),
      setPlaying: (playing) => set({ playing }),
      setTime: (currentTime) => set({ currentTime }),
      setDuration: (duration) => set({ duration }),
      toggleVideoLoop: () => set((s) => ({ videoLoop: !s.videoLoop })),
    }),
    {
      name: `${__APP_ID__}:player`,
      storage: fileStorage,
      // Only the last video comes from this file; older versions also saved volume here.
      merge: (persisted, current) => ({ ...current, source: (persisted as { source?: Source | null } | undefined)?.source ?? null }),
      // The last video is remembered too, so the next launch comes back to it (position: see utils).
      partialize: (s) => ({ source: s.source }), // volume and mute live in the general settings file
    },
  ),
);
