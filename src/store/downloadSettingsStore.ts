import { create } from "zustand";

export type DownloadMode = "together" | "separate" | "audioOnly";

export const VIDEO_QUALITIES = ["best", "2160", "1440", "1080", "720", "480", "360", "240", "144"] as const;
export const AUDIO_QUALITIES = ["best", "medium", "low"] as const;
/** Browsers yt-dlp can take the YouTube sign-in from; "" = none. */
export const COOKIE_BROWSERS = ["", "chrome", "chromium", "brave", "edge", "firefox", "opera", "safari", "vivaldi"] as const;

/** The YouTube download defaults, saved in the general settings file (schemas/settings.schema.json, "downloads"). */
export interface DownloadSettings {
  mode: DownloadMode;
  videoQuality: string;
  audioQuality: string;
  /** Empty = the system's Videos folder. */
  folder: string;
  delayBetweenVideos: number;
  speedLimitKbps: number;
  autoResume: boolean;
  cookiesBrowser: string;
}

export const DEFAULT_DOWNLOAD_SETTINGS: DownloadSettings = {
  mode: "separate",
  videoQuality: "1080",
  audioQuality: "best",
  folder: "",
  delayBetweenVideos: 3,
  speedLimitKbps: 0,
  autoResume: true,
  cookiesBrowser: "",
};

interface DownloadSettingsState extends DownloadSettings {
  change: (patch: Partial<DownloadSettings>) => void;
  reset: () => void;
}

export const useDownloadSettingsStore = create<DownloadSettingsState>()((set) => ({
  ...DEFAULT_DOWNLOAD_SETTINGS,
  change: (patch) => set(patch),
  reset: () => set(DEFAULT_DOWNLOAD_SETTINGS),
}));

export function currentDownloadSettings(): DownloadSettings {
  const { change: _change, reset: _reset, ...settings } = useDownloadSettingsStore.getState();
  return settings;
}
