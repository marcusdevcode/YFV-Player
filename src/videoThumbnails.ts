import { invoke } from "@tauri-apps/api/core";
import { isAudioPath } from "./mediaFiles";
import { tr } from "./translate";
import { locateTrack, usePlaylistLibraryStore } from "./store/playlistLibraryStore";
import { newId } from "./uniqueIds";

const urlCache = new Map<string, string>();

/** A streamable http://127.0.0.1 address for a local file (cached for this run). */
export async function mediaUrl(path: string): Promise<string> {
  const known = urlCache.get(path);
  if (known) return known;
  const url = await invoke<string>("media_url", { path });
  urlCache.set(path, url);
  return url;
}

const once = (el: HTMLMediaElement, ok: string) =>
  new Promise<void>((resolve, reject) => {
    el.addEventListener(ok, () => resolve(), { once: true });
    el.addEventListener("error", () => reject(new Error(tr("thumb.unreadable"))), { once: true });
  });

/** A JPEG of one frame of a video file (the very start by default). Driven by media events only. */
export async function captureFrame(path: string, at?: number): Promise<Uint8Array> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous"; // the local media server sends CORS headers; needed to read pixels
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  try {
    const loaded = once(video, "loadeddata");
    video.src = await mediaUrl(path);
    await loaded;

    const time = Math.max(0, Math.min(at ?? 0.1, (video.duration || 1) / 2 || 0));
    if (time > 0) {
      const seeked = once(video, "seeked");
      video.currentTime = time;
      await seeked;
    }

    const width = 320;
    const height = Math.max(1, Math.round((width * (video.videoHeight || 9)) / (video.videoWidth || 16)));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
    if (!blob) throw new Error(tr("thumb.frameFailed"));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

/** Save a captured frame as the preview of a track (replacing the old one). */
export async function setTrackFrame(playlistId: string, trackId: string, path: string, at?: number) {
  const bytes = await captureFrame(path, at);
  const saved = await invoke<string>("thumbnail_save", { id: `${trackId}-${newId().slice(0, 8)}`, bytes: Array.from(bytes) });
  usePlaylistLibraryStore.getState().setTrackThumbnail(playlistId, trackId, saved);
}

let chain: Promise<void> = Promise.resolve();

/** Make the default (first frame) previews for tracks that have none, one after the other. */
export function queueThumbnails(trackIds: string[]) {
  for (const id of trackIds) {
    chain = chain.then(async () => {
      const found = locateTrack(id);
      if (!found || found.track.thumbnail !== undefined) return;
      const { playlist, track } = found;
      const store = usePlaylistLibraryStore.getState();
      if (isAudioPath(track.videoPath)) {
        store.setTrackThumbnail(playlist.id, track.id, null);
        return;
      }
      try {
        await setTrackFrame(playlist.id, track.id, track.videoPath);
      } catch {
        usePlaylistLibraryStore.getState().setTrackThumbnail(playlist.id, track.id, null);
      }
    });
  }
}

/** Tracks without a preview that were never tried (for example after a crash). */
export function queueMissingThumbnails() {
  const ids = usePlaylistLibraryStore
    .getState()
    .playlists.flatMap((p) => p.tracks.filter((t) => t.thumbnail === undefined).map((t) => t.id));
  queueThumbnails(ids);
}
