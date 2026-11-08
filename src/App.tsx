import { useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Player from "./components/Player";
import MergeDialog from "./components/MergeDialog";
import UpdateBanner from "./components/UpdateBanner";
import { mergeFlow } from "./merge";
import { usePlayerStore } from "./store/playerStore";
import { fileName } from "./utils";

const VIDEO_EXT = ["mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "mpg", "mpeg", "ts", "3gp", "ogv"];
const AUDIO_EXT = ["m4a", "mp3", "aac", "flac", "wav", "ogg", "opus"];

async function pick(kind: "video" | "audio"): Promise<string | null> {
  const res = await open({
    multiple: false,
    filters: [{ name: kind === "video" ? "Video" : "Audio", extensions: kind === "video" ? VIDEO_EXT : AUDIO_EXT }],
  });
  return typeof res === "string" ? res : null;
}

export default function App() {
  const source = usePlayerStore((s) => s.source);
  const setSource = usePlayerStore((s) => s.setSource);

  const openVideo = useCallback(
    async (withAudio: boolean) => {
      const videoPath = await pick("video");
      if (!videoPath) return;
      const audioPath = withAudio ? await pick("audio") : null;
      setSource({ videoPath, audioPath: audioPath ?? undefined, title: fileName(videoPath) });
    },
    [setSource],
  );

  // A file passed on the command line (or "Open with") starts playing right away.
  useEffect(() => {
    Promise.all([invoke<string | null>("launch_path"), invoke<string | null>("launch_audio")])
      .then(([p, a]) => p && setSource({ videoPath: p, audioPath: a ?? undefined, title: fileName(p) }))
      .catch(() => {});
  }, [setSource]);

  // File → Merge Video + Audio…: merge the open pair, or pick both files; then save dialog + progress window.
  const mergeFromMenu = useCallback(async () => {
    // A video + separate audio pair is already open: merge that pair without asking again.
    const current = usePlayerStore.getState().source;
    if (current?.audioPath) {
      await mergeFlow(current.videoPath, current.audioPath);
      return;
    }
    const videoPath = await pick("video");
    if (!videoPath) return;
    const audioPath = await pick("audio");
    if (!audioPath) return;
    await mergeFlow(videoPath, audioPath);
  }, []);

  // Native menu: File → Open Video…, Open Video + Separate Audio…, Merge Video + Audio…
  useEffect(() => {
    const unlisten = listen<string>("menu", (e) => {
      if (e.payload === "open-video") void openVideo(false);
      if (e.payload === "open-video-audio") void openVideo(true);
      if (e.payload === "merge-av") void mergeFromMenu();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [openVideo, mergeFromMenu]);

  return (
    <div className="app">
      <UpdateBanner />
      <MergeDialog />
      {source ? (
        <Player />
      ) : (
        <div className="empty">
          <img src="/icon.svg" width={96} height={96} alt="" />
          <h1>{__APP_NAME__}</h1>
          <div className="empty-actions">
            <button className="primary" onClick={() => void openVideo(false)}>
              Open video
            </button>
            <button onClick={() => void openVideo(true)}>Open video + separate audio</button>
          </div>
        </div>
      )}
    </div>
  );
}
