import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePlaylistLibraryStore, type Track } from "./playlistLibraryStore";
import type { DownloadMode } from "./downloadSettingsStore";
import type { ChosenFormats } from "../youtubeApi";
import { queueThumbnails } from "../videoThumbnails";

export type JobStatus = "queued" | "downloading" | "waiting" | "needsSignIn" | "paused" | "done" | "failed" | "cancelled";

export interface PartState {
  kind: "together" | "video" | "audio";
  path: string | null;
  downloaded: number;
  total: number | null;
  speed: number | null;
  eta: number | null;
  done: boolean;
}

/** A video in the download queue or history (the shape the Rust side sends). */
export interface DownloadJob {
  id: string;
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
  status: JobStatus;
  message: string | null;
  parts: PartState[];
  gotHeight: number | null;
  addedAt: number;
  finishedAt: number | null;
}

interface Snapshot {
  queue: DownloadJob[];
  history: DownloadJob[];
  holdAll: boolean;
}

interface Alert {
  kind: "signIn" | "disk";
  message: string;
}

interface Live {
  part: number;
  downloaded: number;
  total: number | null;
  speed: number | null;
  eta: number | null;
}

interface DownloadQueueState extends Snapshot {
  /// The newest progress of the running file, between two snapshots.
  live: Record<string, Live>;
  /** Seconds until the next video starts (0 = not waiting). */
  delaySeconds: number;
  alert: Alert | null;
  popupCollapsed: boolean;
  dismissAlert: () => void;
  setPopupCollapsed: (collapsed: boolean) => void;
}

export const useDownloadQueueStore = create<DownloadQueueState>()((set) => ({
  queue: [],
  history: [],
  holdAll: false,
  live: {},
  delaySeconds: 0,
  alert: null,
  popupCollapsed: false,
  dismissAlert: () => set({ alert: null }),
  setPopupCollapsed: (popupCollapsed) => set({ popupCollapsed }),
}));

/** Overall progress of the current batch of downloads (the queue plus what finished since it began). */
export interface BatchSummary {
  videosDone: number;
  videosTotal: number;
  audiosDone: number;
  audiosTotal: number;
  /** 0..1 over all files. */
  fraction: number;
}

export function summarizeBatch(queue: DownloadJob[], history: DownloadJob[], live: Record<string, Live>): BatchSummary {
  const batchStart = Math.min(...queue.map((j) => j.addedAt));
  const jobs = [...history.filter((j) => j.status === "done" && (j.finishedAt ?? 0) >= batchStart), ...queue];
  const s: BatchSummary = { videosDone: 0, videosTotal: 0, audiosDone: 0, audiosTotal: 0, fraction: 0 };
  let files = 0;
  let progress = 0;
  for (const job of jobs) {
    job.parts.forEach((part, index) => {
      const isAudio = part.kind === "audio";
      const done = job.status === "done" || part.done;
      const now = live[job.id]?.part === index && job.status === "downloading" ? live[job.id] : part;
      if (isAudio) {
        s.audiosTotal++;
        if (done) s.audiosDone++;
      } else {
        s.videosTotal++;
        if (done) s.videosDone++;
      }
      files++;
      progress += done ? 1 : now.total ? Math.min(1, now.downloaded / now.total) : 0;
    });
  }
  s.fraction = files ? progress / files : 0;
  return s;
}

/** The path of the video file (or the audio file of an audio-only download) of a finished job. */
export function finishedPaths(job: DownloadJob): { videoPath: string; audioPath?: string } | null {
  const path = (kind: PartState["kind"]) => job.parts.find((p) => p.kind === kind && p.done)?.path ?? undefined;
  const videoPath = path("together") ?? path("video") ?? path("audio");
  if (!videoPath) return null;
  const audioPath = job.mode === "separate" ? path("audio") : undefined;
  return { videoPath, audioPath };
}

/** Put the files of a finished download into the playlist track that was waiting for it. */
function fillTrackFromJob(job: DownloadJob) {
  if (job.status !== "done" || !job.playlistId || !job.trackId) return;
  const paths = finishedPaths(job);
  if (!paths) return;
  const lib = usePlaylistLibraryStore.getState();
  const track = lib.playlists.find((p) => p.id === job.playlistId)?.tracks.find((t) => t.id === job.trackId);
  if (!track?.download) return; // already filled, or the track was removed
  lib.completeDownloadedTrack(job.playlistId, job.trackId, paths.videoPath, paths.audioPath);
  queueThumbnails([job.trackId]);
}

/** Fill every playlist track whose download finished while the page was not looking. */
export function reconcileFinishedDownloads() {
  if (!usePlaylistLibraryStore.getState().loaded) return;
  useDownloadQueueStore.getState().history.forEach(fillTrackFromJob);
}

export type TrackDownloadState = "downloading" | "failed" | null;

/** What is happening to a playlist track that is still waiting for its download. */
export function trackDownloadState(track: Track, queue: DownloadJob[], history: DownloadJob[]): TrackDownloadState {
  if (!track.download) return null;
  if (queue.some((j) => j.id === track.download!.jobId)) return "downloading";
  const finished = history.find((j) => j.id === track.download!.jobId);
  return finished?.status === "done" ? null : "failed";
}

/** Listen to the download engine (Rust). Call once at startup. */
let listening = false;
export async function startDownloadListeners() {
  if (listening) return;
  listening = true;
  const store = useDownloadQueueStore;
  await listen<Snapshot>("download-queue", (e) => {
    store.setState((s) => ({
      ...e.payload,
      // progress of jobs that are gone is dropped
      live: Object.fromEntries(Object.entries(s.live).filter(([id]) => e.payload.queue.some((j) => j.id === id))),
    }));
    reconcileFinishedDownloads();
  });
  await listen<Live & { id: string }>("download-progress", (e) => {
    const { id, ...live } = e.payload;
    store.setState((s) => ({ live: { ...s.live, [id]: live } }));
  });
  await listen<number>("download-delay", (e) => store.setState({ delaySeconds: e.payload }));
  await listen<Alert>("download-alert", (e) => store.setState({ alert: e.payload }));
  await listen<DownloadJob>("download-finished", (e) => fillTrackFromJob({ ...e.payload, status: "done" }));
  const snapshot = await invoke<Snapshot>("downloads_snapshot");
  store.setState(snapshot);
}
