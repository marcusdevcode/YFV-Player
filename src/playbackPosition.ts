import { invoke } from "@tauri-apps/api/core";
import { POSITIONS_STORE_NAME, usePlaybackPositionStore } from "./store/playbackPositionStore";

/**
 * Remember where a video is, in memory only. Nothing is written to disk: the program writes the last
 * remembered position to the positions file when it exits. Used while a video plays.
 */
export function notePosition(path: string, t: number) {
  void invoke("position_note", { name: POSITIONS_STORE_NAME, path, seconds: t }).catch(() => {});
}

/** Save a position to the positions file now (on pause, or when a video is replaced). */
export function savePosition(path: string, t: number) {
  usePlaybackPositionStore.getState().setPosition(path, t);
  notePosition(path, t); // so the exit write never puts an older position over this one
}

export function loadPosition(path: string): number {
  const v = usePlaybackPositionStore.getState().positions[path];
  return Number.isFinite(v) ? v : 0;
}
