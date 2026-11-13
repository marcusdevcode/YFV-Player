import { useMemo } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AUDIO_EXT, VIDEO_EXT, stageFiles } from "../mediaFiles";
import { useAddDialogStore, type AddMode } from "../store/addDialogStore";
import { usePlaylistLibraryStore, type Track } from "../store/playlistLibraryStore";
import { queueThumbnails } from "../videoThumbnails";
import { useT } from "../translate";
import { fileName } from "../filePaths";
import YouTubeSearchPanel from "./YouTubeSearchPanel";
import { newId } from "../uniqueIds";
import ScrollArea from "./ScrollArea";
import DropdownSelect from "./DropdownSelect";

/** "Add videos": a drop area, a list you tick, and a button that adds the ticked ones. */
export default function AddVideosDialog() {
  const { open: isOpen, tab, mode, paths, unchecked, targetId } = useAddDialogStore();
  const { t, tn } = useT();
  const add = useAddDialogStore.getState();
  const playlists = usePlaylistLibraryStore((s) => s.playlists);
  const activeId = usePlaylistLibraryStore((s) => s.activeId);

  const { items, ignored } = useMemo(() => stageFiles(paths, mode), [paths, mode]);
  if (!isOpen) return null;

  const ticked = items.filter((i) => !unchecked.includes(i.id));
  const target = targetId && playlists.some((p) => p.id === targetId) ? targetId : (activeId ?? "");

  async function browse() {
    const picked = await open({
      multiple: true,
      filters: [{ name: t("filter.media"), extensions: [...VIDEO_EXT, ...AUDIO_EXT] }],
    });
    if (Array.isArray(picked)) useAddDialogStore.getState().addPaths(picked);
  }

  function addToPlaylist() {
    const lib = usePlaylistLibraryStore.getState();
    const playlistId = target || lib.createPlaylist(t("add.defaultName"));
    const tracks: Track[] = ticked.map((i) => ({ id: newId(), videoPath: i.videoPath, audioPath: i.audioPath, title: i.title }));
    lib.addTracks(playlistId, tracks);
    lib.setActive(playlistId);
    queueThumbnails(tracks.map((t) => t.id));
    add.close();
  }

  function playNow() {
    const first = ticked[0];
    if (first) usePlaylistLibraryStore.getState().playSource({ videoPath: first.videoPath, audioPath: first.audioPath, title: first.title });
    add.close();
  }

  return (
    <div className="modal-backdrop" onClick={add.close}>
      <ScrollArea className="modal wide" role="dialog" aria-label={t("add.title")} onClick={(e) => e.stopPropagation()}>
        <h2>{t("add.title")}</h2>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "files"} className={tab === "files" ? "active" : ""} onClick={() => add.setTab("files")}>
            {t("add.tabFiles")}
          </button>
          <button role="tab" aria-selected={tab === "youtube"} className={tab === "youtube" ? "active" : ""} onClick={() => add.setTab("youtube")}>
            {t("add.tabYouTube")}
          </button>
        </div>

        {tab === "youtube" ? (
          <>
            <YouTubeSearchPanel />
            <div className="modal-actions">
              <button onClick={add.close}>{t("common.close")}</button>
            </div>
          </>
        ) : (
          <>
        <div className="row">
          <label>
            {t("add.addAs")}{" "}
            <DropdownSelect value={mode} onChange={(e) => add.setMode(e.target.value as AddMode)}>
              <option value="video">{t("add.modeVideo")}</option>
              <option value="pair">{t("add.modePair")}</option>
            </DropdownSelect>
          </label>
          <label>
            {t("add.toPlaylist")}{" "}
            <DropdownSelect value={target} onChange={(e) => add.setTarget(e.target.value)}>
              {playlists.length === 0 && <option value="">{t("add.newDefault", { name: t("add.defaultName") })}</option>}
              {playlists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </DropdownSelect>
          </label>
        </div>

        <div className="drop-area">
          <p>{mode === "pair" ? t("add.dropPair") : t("add.dropVideo")}</p>
          <button onClick={() => void browse()}>{t("add.browse")}</button>
        </div>

        {items.length > 0 && (
          <ScrollArea className="staged">
            {items.map((i) => (
              <label key={i.id} className="staged-row">
                <input type="checkbox" checked={!unchecked.includes(i.id)} onChange={() => add.toggle(i.id)} />
                <span className="staged-title">{i.title}</span>
                {mode === "pair" && (
                  <span className={i.audioPath ? "muted" : "warn"}>{i.audioPath ? `+ ${fileName(i.audioPath)}` : t("add.noAudio")}</span>
                )}
              </label>
            ))}
          </ScrollArea>
        )}
        {ignored.length > 0 && (
          <p className="muted">
            {tn("add.ignored", ignored.length)}
          </p>
        )}

        <div className="modal-actions">
          <button onClick={add.close}>{t("common.cancel")}</button>
          <span className="spacer" />
          <button disabled={ticked.length === 0} onClick={playNow} title={t("add.playNowHint")}>
            {t("add.playNow")}
          </button>
          <button className="primary" disabled={ticked.length === 0} onClick={addToPlaylist}>
            {ticked.length ? t("add.addN", { count: ticked.length }) : t("add.add")}
          </button>
        </div>
          </>
        )}
      </ScrollArea>
    </div>
  );
}
