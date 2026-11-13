import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useT } from "../translate";
import { useYouTubeDownloadStore } from "../store/youtubeDownloadStore";
import { usePlaylistLibraryStore, type Track } from "../store/playlistLibraryStore";
import { useAddDialogStore } from "../store/addDialogStore";
import {
  AUDIO_QUALITIES,
  VIDEO_QUALITIES,
  useDownloadSettingsStore,
  type DownloadMode,
} from "../store/downloadSettingsStore";
import { enqueueDownloads, resolveDownloadFolder, youtubeLookup, type ChosenFormats, type YouTubeFormat } from "../youtubeApi";
import { formatBytes } from "../textFormatting";
import { newId } from "../uniqueIds";
import ScrollArea from "./ScrollArea";
import DropdownSelect from "./DropdownSelect";

function formatLabel(f: YouTubeFormat): string {
  const parts = [
    f.kind === "audio" ? (f.audioBitrate ? `${Math.round(f.audioBitrate)} kbit/s` : "") : `${f.height ?? "?"}p${f.fps && f.fps > 30 ? Math.round(f.fps) : ""}`,
    f.ext,
    (f.kind === "audio" ? f.audioCodec : f.videoCodec)?.split(".")[0] ?? "",
    f.size ? formatBytes(f.size) : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

/**
 * Asked before every YouTube download: how to download (one file, separate video and audio, or
 * audio only), the quality, the playlist and the folder. It opens with the saved defaults selected.
 */
export default function YouTubeQualityDialog() {
  const request = useYouTubeDownloadStore((s) => s.request);
  if (!request) return null;
  return <QualityForm key={request.entries.map((e) => e.id).join(",")} />;
}

function QualityForm() {
  const request = useYouTubeDownloadStore((s) => s.request)!;
  const close = useYouTubeDownloadStore.getState().close;
  const defaults = useDownloadSettingsStore.getState();
  const playlists = usePlaylistLibraryStore((s) => s.playlists);
  const activeId = usePlaylistLibraryStore((s) => s.activeId);
  const { t, tn } = useT();

  const [mode, setMode] = useState<DownloadMode>(defaults.mode);
  const [videoQuality, setVideoQuality] = useState(defaults.videoQuality);
  const [audioQuality, setAudioQuality] = useState(defaults.audioQuality);
  const [folder, setFolder] = useState(defaults.folder);
  const [remember, setRemember] = useState(false);
  const newTitle = request.newPlaylistTitle;
  const [target, setTarget] = useState<string>(newTitle ? "new" : (activeId ?? "new"));
  const [formats, setFormats] = useState<YouTubeFormat[] | null>(request.formats);
  const [exact, setExact] = useState<ChosenFormats>({});
  const [busy, setBusy] = useState(false);
  const single = request.entries.length === 1 ? request.entries[0] : null;

  // The real formats of a single video, for choosing an exact one.
  useEffect(() => {
    if (!single || formats) return;
    let cancelled = false;
    youtubeLookup(single.url)
      .then((r) => !cancelled && r.type === "video" && setFormats(r.formats))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [single, formats]);

  const kinds = mode === "together" ? { video: "together" as const } : { video: "video" as const };
  const videoFormats = useMemo(() => (formats ?? []).filter((f) => f.kind === kinds.video), [formats, kinds.video]);
  const audioFormats = useMemo(() => (formats ?? []).filter((f) => f.kind === "audio"), [formats]);

  async function chooseFolder() {
    const picked = await open({ directory: true, multiple: false, defaultPath: folder || undefined });
    if (typeof picked === "string") setFolder(picked);
  }

  async function start() {
    setBusy(true);
    try {
      const lib = usePlaylistLibraryStore.getState();
      const dir = await resolveDownloadFolder(folder);
      const playlistId = target === "new" || !playlists.some((p) => p.id === target) ? lib.createPlaylist(newTitle ?? t("youtube.defaultPlaylist")) : target;
      const trackIds = request.entries.map(() => newId());
      const formatsChosen: ChosenFormats = single
        ? {
            ...(mode === "together" ? { together: exact.together } : { video: exact.video }),
            ...(mode !== "together" ? { audio: exact.audio } : {}),
          }
        : {};
      const jobIds = await enqueueDownloads(
        request.entries.map((e, i) => ({
          videoId: e.id,
          url: e.url,
          title: e.title,
          thumbnail: e.thumbnail,
          duration: e.duration,
          channel: e.channel,
          mode,
          videoQuality,
          audioQuality,
          formats: formatsChosen,
          folder: dir,
          playlistId,
          trackId: trackIds[i],
        })),
      );
      // The tracks exist at once, greyed, and become playable as each download finishes.
      const tracks: Track[] = request.entries.map((e, i) => ({
        id: trackIds[i],
        videoPath: "",
        title: e.title,
        download: { jobId: jobIds[i], videoId: e.id },
      }));
      lib.addTracks(playlistId, tracks);
      lib.setActive(playlistId);
      if (remember) useDownloadSettingsStore.getState().change({ mode, videoQuality, audioQuality, folder });
      useAddDialogStore.getState().close();
      close();
    } catch (e) {
      lib0().setNotice(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <ScrollArea className="modal wide" role="dialog" aria-label={t("quality.title")} onClick={(e) => e.stopPropagation()}>
        <h2>{t("quality.title")}</h2>
        <p className="modal-sub">{single ? single.title : tn("quality.count", request.entries.length)}</p>

        <label className="field">
          <span>{t("quality.how")}</span>
          <DropdownSelect value={mode} onChange={(e) => setMode(e.target.value as DownloadMode)}>
            <option value="separate">{t("quality.modeSeparate")}</option>
            <option value="together">{t("quality.modeTogether")}</option>
            <option value="audioOnly">{t("quality.modeAudio")}</option>
          </DropdownSelect>
        </label>

        <label className="field">
          <span>{t("quality.video")}</span>
          <DropdownSelect value={videoQuality} disabled={mode === "audioOnly"} onChange={(e) => setVideoQuality(e.target.value)}>
            {VIDEO_QUALITIES.map((q) => (
              <option key={q} value={q}>
                {q === "best" ? t("quality.best") : `${q}p`}
              </option>
            ))}
          </DropdownSelect>
        </label>

        <label className="field">
          <span>{t("quality.audio")}</span>
          <DropdownSelect value={audioQuality} disabled={mode === "together"} onChange={(e) => setAudioQuality(e.target.value)}>
            {AUDIO_QUALITIES.map((q) => (
              <option key={q} value={q}>
                {t(q === "best" ? "quality.audioBest" : q === "medium" ? "quality.audioMedium" : "quality.audioLow")}
              </option>
            ))}
          </DropdownSelect>
        </label>
        {!single && <p className="muted">{t("quality.ruleNote")}</p>}

        {single && formats && (mode === "together" ? videoFormats.length > 0 : videoFormats.length + audioFormats.length > 0) && (
          <>
            <p className="muted">{t("quality.specific")}</p>
            {mode !== "audioOnly" && (
              <label className="field">
                <span>{mode === "together" ? t("quality.formatTogether") : t("quality.formatVideo")}</span>
                <DropdownSelect
                  value={(mode === "together" ? exact.together : exact.video) ?? ""}
                  onChange={(e) => setExact({ ...exact, [mode === "together" ? "together" : "video"]: e.target.value || undefined })}
                >
                  <option value="">{t("quality.auto")}</option>
                  {videoFormats.map((f) => (
                    <option key={f.id} value={f.id}>
                      {formatLabel(f)}
                    </option>
                  ))}
                </DropdownSelect>
              </label>
            )}
            {mode !== "together" && (
              <label className="field">
                <span>{t("quality.formatAudio")}</span>
                <DropdownSelect value={exact.audio ?? ""} onChange={(e) => setExact({ ...exact, audio: e.target.value || undefined })}>
                  <option value="">{t("quality.auto")}</option>
                  {audioFormats.map((f) => (
                    <option key={f.id} value={f.id}>
                      {formatLabel(f)}
                    </option>
                  ))}
                </DropdownSelect>
              </label>
            )}
          </>
        )}

        <label className="field">
          <span>{t("quality.playlist")}</span>
          <DropdownSelect value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="new">{t("quality.newPlaylist", { name: newTitle ?? t("youtube.defaultPlaylist") })}</option>
            {playlists.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </DropdownSelect>
        </label>

        <div className="row">
          <span className="muted">{t("quality.folder")}</span>
          <input type="text" value={folder} placeholder={t("quality.folderDefault")} onChange={(e) => setFolder(e.target.value)} />
          <button onClick={() => void chooseFolder()}>{t("quality.browse")}</button>
        </div>

        <label className="field check">
          <span>{t("quality.remember")}</span>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        </label>

        <div className="modal-actions">
          <button onClick={close}>{t("common.cancel")}</button>
          <button className="primary" disabled={busy} onClick={() => void start()}>
            {t("quality.start")}
          </button>
        </div>
      </ScrollArea>
    </div>
  );
}

const lib0 = () => usePlaylistLibraryStore.getState();
