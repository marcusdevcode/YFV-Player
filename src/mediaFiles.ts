import { fileName } from "./filePaths";

export const VIDEO_EXT = ["mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "mpg", "mpeg", "ts", "3gp", "ogv"];
export const AUDIO_EXT = ["m4a", "mp3", "aac", "flac", "wav", "ogg", "opus"];
export const IMAGE_EXT = ["jpg", "jpeg", "png", "webp", "gif"];

export const extOf = (path: string) => (path.split(".").pop() ?? "").toLowerCase();
export const isVideoPath = (p: string) => VIDEO_EXT.includes(extOf(p));
export const isAudioPath = (p: string) => AUDIO_EXT.includes(extOf(p));
export const isMediaPath = (p: string) => isVideoPath(p) || isAudioPath(p);

/** The file name without its extension, used as the default track title. */
export const titleFromPath = (path: string) => fileName(path).replace(/\.[^.]+$/, "");

export interface StagedItem {
  /** Unique key: the video (or audio-only) file path. */
  id: string;
  videoPath: string;
  audioPath?: string;
  title: string;
}

const stem = (p: string) => titleFromPath(p).toLowerCase();

/**
 * Turn dropped / chosen files into list items.
 * "video": every video is an item; audio files alone become audio-only items.
 * "pair": videos get a separate audio file, matched by identical base name first, then by order.
 * `ignored` lists files that are not media, or audio files left without a video.
 */
export function stageFiles(paths: string[], mode: "video" | "pair"): { items: StagedItem[]; ignored: string[] } {
  const unique = [...new Set(paths)];
  const videos = unique.filter(isVideoPath);
  const audios = unique.filter(isAudioPath);
  const ignored = unique.filter((p) => !isMediaPath(p));

  if (mode === "video") {
    const items = [...videos, ...audios].map((p) => ({ id: p, videoPath: p, title: titleFromPath(p) }));
    return { items, ignored };
  }

  const freeAudio = [...audios];
  const audioFor = new Map<string, string>();
  for (const v of videos) {
    const i = freeAudio.findIndex((a) => stem(a) === stem(v));
    if (i >= 0) audioFor.set(v, freeAudio.splice(i, 1)[0]);
  }
  for (const v of videos) {
    if (!audioFor.has(v) && freeAudio.length) audioFor.set(v, freeAudio.shift()!);
  }
  const items = videos.map((v) => ({ id: v, videoPath: v, audioPath: audioFor.get(v), title: titleFromPath(v) }));
  return { items, ignored: [...ignored, ...freeAudio] };
}
