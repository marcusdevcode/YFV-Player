import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type MergeStatus = "idle" | "running" | "error";
export type MergePhase = "reading" | "writing" | "finishing";

interface MergeState {
  status: MergeStatus;
  phase: MergePhase;
  done: number;
  total: number;
  /** Bytes per second. */
  speed: number;
  error: string | null;
  videoName: string;
  audioName: string;
  /** Runs the merge. Resolves with the output path, or null if cancelled or failed. */
  start: (videoPath: string, audioPath: string, outputPath: string, names: [string, string]) => Promise<string | null>;
  cancel: () => void;
  dismiss: () => void;
}

let listening = false;

export const useMergeStore = create<MergeState>((set, get) => ({
  status: "idle",
  phase: "reading",
  done: 0,
  total: 0,
  speed: 0,
  error: null,
  videoName: "",
  audioName: "",

  async start(videoPath, audioPath, outputPath, [videoName, audioName]) {
    // A second request while one is running is ignored and must not disturb the running one.
    if (get().status === "running") return null;
    if (!listening) {
      listening = true;
      // Progress comes from the backend as events; nothing polls.
      await listen<{ phase: MergePhase; done: number; total: number; speed: number }>("merge-progress", (e) =>
        set({ phase: e.payload.phase, done: e.payload.done, total: e.payload.total, speed: e.payload.speed }),
      );
    }
    set({ status: "running", phase: "reading", done: 0, total: 0, speed: 0, error: null, videoName, audioName });
    try {
      const out = await invoke<string>("merge_av", { videoPath, audioPath, outputPath });
      set({ status: "idle" });
      return out;
    } catch (e) {
      const msg = String(e);
      if (/cancelled/i.test(msg)) set({ status: "idle" });
      else set({ status: "error", error: msg });
      return null;
    }
  },

  cancel() {
    void invoke("merge_cancel");
  },

  dismiss() {
    set({ status: "idle", error: null });
  },
}));
