import { create } from "zustand";
import type { YouTubeEntry, YouTubeFormat } from "../youtubeApi";

/** What the quality dialog is asked to download. */
export interface QualityRequest {
  entries: YouTubeEntry[];
  /** The real formats when they are known (one video); otherwise fetched when the dialog opens. */
  formats: YouTubeFormat[] | null;
  /** Set when a whole playlist/channel is downloaded: the title of the new playlist. */
  newPlaylistTitle: string | null;
}

interface YouTubeDownloadState {
  request: QualityRequest | null;
  askQuality: (request: QualityRequest) => void;
  close: () => void;
}

export const useYouTubeDownloadStore = create<YouTubeDownloadState>()((set) => ({
  request: null,
  askQuality: (request) => set({ request }),
  close: () => set({ request: null }),
}));
