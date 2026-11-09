import { invoke } from "@tauri-apps/api/core";
import { videoDir } from "@tauri-apps/api/path";
import type { DownloadMode } from "./store/downloadSettingsStore";

/** One video found on YouTube (search result, playlist item or a single link). */
export interface YouTubeEntry {
  /** A video, a whole playlist (its videos are fetched when needed) or a channel (opened to browse). */
  kind: "video" | "playlist" | "channel";
  id: string;
  title: string;
  url: string;
  thumbnail: string;
  duration: number | null;
  channel: string | null;
}

/** One downloadable format of a video. */
export interface YouTubeFormat {
  id: string;
  /** "together" = picture and sound, "video" = picture only, "audio" = sound only. */
  kind: "together" | "video" | "audio";
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  ext: string;
  size: number | null;
  audioBitrate: number | null;
}

export type YouTubeLookup =
  | { type: "video"; entry: YouTubeEntry; formats: YouTubeFormat[] }
  /** `channelUrl` is set for a channel page (its Videos or Playlists tab). */
  | { type: "list"; title: string; entries: YouTubeEntry[]; channelUrl: string | null }
  | { type: "search"; entries: YouTubeEntry[] };

/** Exact formats chosen for one video; without them the quality rule decides. */
export interface ChosenFormats {
  together?: string;
  video?: string;
  audio?: string;
}

/** What is sent to the download queue for each video. */
export interface NewDownload {
  videoId: string;
  url: string;
  title: string;
  thumbnail: string;
  duration: number | null;
  channel: string | null;
  mode: DownloadMode;
  videoQuality: string;
  audioQuality: string;
  formats: ChosenFormats;
  folder: string;
  playlistId: string | null;
  trackId: string | null;
}

/**
 * A link (video, playlist, channel) or a search text. `count` items are returned, after the first
 * `offset` ones (pages of a playlist or channel); a count of 0 returns everything.
 */
export const youtubeLookup = (input: string, count = 30, offset = 0) =>
  invoke<YouTubeLookup>("youtube_lookup", { input, count, offset });

export const enqueueDownloads = (downloads: NewDownload[]) => invoke<string[]>("downloads_enqueue", { downloads });
export const moveDownload = (id: string, to: number) => invoke("downloads_move", { id, to });
export const downloadNow = (id: string) => invoke("downloads_download_now", { id });
export const pauseDownload = (id: string) => invoke("downloads_pause", { id });
export const resumeDownload = (id: string) => invoke("downloads_resume", { id });
export const pauseAllDownloads = () => invoke("downloads_pause_all");
export const resumeAllDownloads = () => invoke("downloads_resume_all");
export const cancelDownload = (id: string, deletePartial: boolean) => invoke("downloads_cancel", { id, deletePartial });
export const retryDownload = (id: string) => invoke("downloads_retry", { id });
/** Remove one entry from the history, or all of them with an empty id. */
export const forgetDownload = (id: string) => invoke("downloads_forget", { id });

export const downloaderVersion = () => invoke<string>("ytdlp_version");
export const updateDownloader = () => invoke<string>("ytdlp_update");
export const restoreDownloader = () => invoke("ytdlp_restore");

/** The folder downloads go to: the chosen one, or the system's Videos folder. */
export async function resolveDownloadFolder(chosen: string): Promise<string> {
  return chosen.trim() || (await videoDir());
}
