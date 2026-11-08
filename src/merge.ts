import { save } from "@tauri-apps/plugin-dialog";
import { useMergeStore } from "./store/mergeStore";
import { usePlayerStore } from "./store/playerStore";
import { dirName, fileName, stem } from "./utils";

/**
 * Merge a video and an audio file into one new MP4: ask where to save it, run the merge with a
 * progress dialog, then play the result.
 */
export async function mergeFlow(videoPath: string, audioPath: string): Promise<void> {
  if (useMergeStore.getState().status === "running") return;
  const dir = dirName(videoPath);
  const sep = videoPath.includes("\\") ? "\\" : "/";
  const suggested = `${stem(videoPath)} (merged).mp4`;
  const outputPath = await save({
    defaultPath: dir ? `${dir}${sep}${suggested}` : suggested,
    filters: [{ name: "MP4 video", extensions: ["mp4"] }],
  });
  if (!outputPath) return;

  const result = await useMergeStore.getState().start(videoPath, audioPath, outputPath, [
    fileName(videoPath),
    fileName(audioPath),
  ]);
  if (result) usePlayerStore.getState().setSource({ videoPath: result, title: fileName(result) });
}
