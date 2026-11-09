import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_PLAYLIST_COLOR, usePlaylistLibraryStore, type Playlist } from "../store/playlistLibraryStore";
import { IMAGE_EXT } from "../mediaFiles";
import { exportActivePlaylist, importPlaylists } from "../playlistImportExport";
import { useT } from "../translate";
import { newId } from "../uniqueIds";
import { cancelDownload } from "../youtubeApi";
import ConfirmDialog from "./ConfirmDialog";
import ThumbnailImage from "./ThumbnailImage";

/** Add, rename, recolor, reorder and delete playlists; import and export. */
export default function PlaylistManager() {
  const isOpen = usePlaylistLibraryStore((s) => s.managerOpen);
  const playlists = usePlaylistLibraryStore((s) => s.playlists);
  const activeId = usePlaylistLibraryStore((s) => s.activeId);
  const lib = usePlaylistLibraryStore.getState();
  const { t, tn } = useT();
  const [newName, setNewName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Playlist | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [alsoDeleteFiles, setAlsoDeleteFiles] = useState(false);

  if (!isOpen) return null;
  const close = () => {
    setPendingDelete(null);
    lib.setManagerOpen(false);
  };

  /** Delete a playlist and its previews and cover; optionally its video and audio files too (to the Trash). Unfinished downloads of it are cancelled. */
  async function deletePlaylistAndMore(playlist: Playlist, withFiles: boolean) {
    const files = !withFiles ? [] : playlist.tracks.flatMap((track) => (track.download ? [] : [track.videoPath, ...(track.audioPath ? [track.audioPath] : [])])).filter(Boolean);
    try {
      if (files.length) await invoke("trash_files", { paths: files });
    } catch (e) {
      setDeleteError(String(e)); // nothing was removed from the playlist
      return;
    }
    // A video that is still downloading is cancelled (its partial files go too when the files are deleted).
    playlist.tracks.forEach((track) => track.download && void cancelDownload(track.download.jobId, withFiles).catch(() => {}));
    usePlaylistLibraryStore.getState().deletePlaylist(playlist.id); // also removes the previews and the cover
    setPendingDelete(null);
    setDeleteError(null);
  }

  async function chooseCover(id: string) {
    const picked = await open({ multiple: false, filters: [{ name: t("filter.image"), extensions: IMAGE_EXT }] });
    if (typeof picked !== "string") return;
    try {
      const path = await invoke<string>("thumbnail_import", { id: `cover-${id}-${newId().slice(0, 8)}`, source: picked });
      usePlaylistLibraryStore.getState().setCover(id, path);
    } catch (e) {
      usePlaylistLibraryStore.getState().setNotice(String(e));
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal wide" role="dialog" aria-label={t("mgr.title")} onClick={(e) => e.stopPropagation()}>
        <h2>{t("mgr.title")}</h2>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (newName.trim()) lib.createPlaylist(newName);
            setNewName("");
          }}
        >
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("mgr.newName")} autoFocus />
          <button type="submit" className="primary">
            {t("common.add")}
          </button>
        </form>

        <div className="manager-list">
          {playlists.length === 0 && <p className="muted">{t("mgr.none")}</p>}
          {playlists.map((p, i) => (
            <div key={p.id} className={`manager-row${p.id === activeId ? " active" : ""}`}>
              <input
                type="color"
                value={p.color ?? DEFAULT_PLAYLIST_COLOR}
                title={t("mgr.color")}
                onChange={(e) => lib.recolorPlaylist(p.id, e.target.value)}
              />
              <input
                key={p.title}
                className="name"
                defaultValue={p.title}
                aria-label={t("mgr.name")}
                onBlur={(e) => lib.renamePlaylist(p.id, e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
              <ThumbnailImage className="mini" path={p.cover ?? p.tracks.find((t) => t.thumbnail)?.thumbnail} />
              <button title={t("mgr.chooseCover")} onClick={() => void chooseCover(p.id)}>
                {t("mgr.cover")}
              </button>
              {p.cover && (
                <button title={t("mgr.resetCover")} onClick={() => lib.setCover(p.id, null)}>
                  {t("common.reset")}
                </button>
              )}
              <button disabled={i === 0} title={t("mgr.up")} onClick={() => lib.movePlaylist(p.id, -1)}>
                ↑
              </button>
              <button disabled={i === playlists.length - 1} title={t("mgr.down")} onClick={() => lib.movePlaylist(p.id, 1)}>
                ↓
              </button>
              <button
                title={t("mgr.deleteHint")}
                onClick={() => {
                  setDeleteError(null);
                  setAlsoDeleteFiles(false);
                  setPendingDelete(p);
                }}
              >
                {t("common.delete")}
              </button>
            </div>
          ))}
        </div>

        {pendingDelete && (
          <ConfirmDialog
            title={t("mgr.deleteTitle")}
            confirmLabel={alsoDeleteFiles ? t("mgr.deleteWithFiles") : t("common.delete")}
            danger
            onCancel={() => setPendingDelete(null)}
            onConfirm={() => void deletePlaylistAndMore(pendingDelete, alsoDeleteFiles)}
          >
            <p>{t("mgr.deleteBody", { title: pendingDelete.title })}</p>
            <p className="muted">{tn("mgr.deleteCount", pendingDelete.tracks.length)}</p>
            <label className="field check">
              <span>{t("mgr.alsoDeleteFiles")}</span>
              <input type="checkbox" checked={alsoDeleteFiles} onChange={(e) => setAlsoDeleteFiles(e.target.checked)} />
            </label>
            {deleteError && <p className="modal-error">{deleteError}</p>}
          </ConfirmDialog>
        )}

        <div className="modal-actions">
          <button onClick={() => void importPlaylists()}>{t("mgr.import")}</button>
          <button disabled={!activeId} onClick={() => void exportActivePlaylist()} title={t("mgr.exportHint")}>
            {t("mgr.export")}
          </button>
          <span className="spacer" />
          <button className="primary" onClick={close}>
            {t("common.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
