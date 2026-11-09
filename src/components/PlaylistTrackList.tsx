import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { IMAGE_EXT } from "../mediaFiles";
import { useAddDialogStore } from "../store/addDialogStore";
import { usePlaylistLibraryStore, type Track } from "../store/playlistLibraryStore";
import { setTrackFrame } from "../videoThumbnails";
import { useDownloadQueueStore, trackDownloadState } from "../store/downloadQueueStore";
import { useT } from "../translate";
import { fileName } from "../filePaths";
import { newId } from "../uniqueIds";
import { openContextMenu } from "../store/contextMenuStore";
import ConfirmDialog from "./ConfirmDialog";
import Icon from "./Icon";
import ThumbnailImage from "./ThumbnailImage";

/** The track list of the active playlist: play, reorder, preview, remove. */
export default function PlaylistTrackList() {
  const playlist = usePlaylistLibraryStore((s) => s.playlists.find((p) => p.id === s.activeId) ?? null);
  const currentTrackId = usePlaylistLibraryStore((s) => s.currentTrackId);
  const loopPlaylist = usePlaylistLibraryStore((s) => s.loopPlaylist);
  const lib = usePlaylistLibraryStore.getState();
  const openAdd = useAddDialogStore((s) => s.openWith);
  const downloadQueue = useDownloadQueueStore((s) => s.queue);
  const downloadHistory = useDownloadQueueStore((s) => s.history);
  const { t: tl, tn } = useT();

  const [menuId, setMenuId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Track | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A click anywhere closes the row menu.
  useEffect(() => {
    if (!menuId) return;
    const close = () => setMenuId(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuId]);

  if (!playlist) {
    return (
      <aside className="sidebar">
        <div className="side-empty">
          <p>{tl("side.none")}</p>
          <button className="primary" onClick={() => openAdd()}>
            {tl("side.addVideos")}
          </button>
          <p className="muted">{tl("side.hint")}</p>
        </div>
      </aside>
    );
  }

  const cover = playlist.cover ?? playlist.tracks.find((t) => t.thumbnail)?.thumbnail;

  // Reorder with pointer events (the window's own drop handling would swallow HTML5 dragging).
  function overIndex(clientY: number): number {
    const rows = Array.from(listRef.current?.children ?? []) as HTMLElement[];
    let over = 0;
    rows.forEach((row, i) => {
      const r = row.getBoundingClientRect();
      if (clientY > r.top + r.height / 2) over = i;
    });
    return over;
  }
  const endDrag = (commit: boolean) => {
    if (drag && commit && drag.from !== drag.over) lib.moveTrack(playlist.id, drag.from, drag.over);
    setDrag(null);
  };

  async function chooseImage(track: Track) {
    const picked = await open({ multiple: false, filters: [{ name: tl("filter.image"), extensions: IMAGE_EXT }] });
    if (typeof picked !== "string") return;
    try {
      const path = await invoke<string>("thumbnail_import", { id: `${track.id}-${newId().slice(0, 8)}`, source: picked });
      usePlaylistLibraryStore.getState().setTrackThumbnail(playlist!.id, track.id, path);
    } catch (e) {
      usePlaylistLibraryStore.getState().setNotice(String(e));
    }
  }

  async function deleteFiles(track: Track) {
    const files = [track.videoPath, ...(track.audioPath ? [track.audioPath] : [])];
    try {
      await invoke("trash_files", { paths: files });
      usePlaylistLibraryStore.getState().removeTrack(playlist!.id, track.id);
      setPendingDelete(null);
      setDeleteError(null);
    } catch (e) {
      setDeleteError(String(e));
    }
  }

  return (
    <aside className="sidebar">
      <header className="side-head">
        <ThumbnailImage className="cover" path={cover} />
        <div className="side-title">
          <strong title={playlist.title}>{playlist.title}</strong>
          <span className="muted">{tn("side.videos", playlist.tracks.length)}</span>
        </div>
        <button
          className={loopPlaylist ? "active" : ""}
          onClick={() => lib.setLoopPlaylist(!loopPlaylist)}
          title={loopPlaylist ? tl("side.loopOn") : tl("side.loopOff")}
        >
          <Icon slot="playlistLoop" />
        </button>
        <button className="primary" onClick={() => openAdd()}>
          {tl("side.add")}
        </button>
      </header>

      <div className="track-list" ref={listRef}>
        {playlist.tracks.length === 0 && <p className="muted pad">{tl("side.empty")}</p>}
        {playlist.tracks.map((t, i) => {
          const cls = [
            "track",
            t.id === currentTrackId ? "current" : "",
            drag?.from === i ? "dragging" : "",
            drag && drag.over === i && drag.from !== i ? (drag.over < drag.from ? "drop-before" : "drop-after") : "",
          ].join(" ");
          return (
            <div
              key={t.id}
              className={cls}
              onContextMenu={(e) =>
                openContextMenu(e, [
                  { label: tl("player.play"), onSelect: () => lib.playTrack(playlist.id, t.id) },
                  "separator",
                  { label: tl("mgr.up"), disabled: i === 0, onSelect: () => lib.moveTrack(playlist.id, i, i - 1) },
                  { label: tl("mgr.down"), disabled: i === playlist.tracks.length - 1, onSelect: () => lib.moveTrack(playlist.id, i, i + 1) },
                  "separator",
                  { label: tl("side.chooseImage"), onSelect: () => void chooseImage(t) },
                  {
                    label: tl("side.resetPreview"),
                    onSelect: () => void setTrackFrame(playlist.id, t.id, t.videoPath).catch(() => lib.setTrackThumbnail(playlist.id, t.id, null)),
                  },
                  "separator",
                  { label: tl("side.remove"), onSelect: () => lib.removeTrack(playlist.id, t.id) },
                  { label: tl("side.removeFiles"), danger: true, onSelect: () => (setDeleteError(null), setPendingDelete(t)) },
                ])
              }
            >
              <span
                className="grip"
                title={tl("side.grip")}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setDrag({ from: i, over: i });
                }}
                onPointerMove={(e) => drag && setDrag({ from: drag.from, over: overIndex(e.clientY) })}
                onPointerUp={() => endDrag(true)}
                onPointerCancel={() => endDrag(false)}
              >
                <Icon slot="grip" />
              </span>
              <button
                className={`track-main${t.download ? " pending" : ""}`}
                disabled={!!t.download}
                onClick={() => lib.playTrack(playlist.id, t.id)}
                title={t.download ? undefined : t.videoPath}
              >
                <ThumbnailImage className="mini" path={t.thumbnail} />
                <span className="track-title">{t.title}</span>
                {t.download && (
                  <span className={trackDownloadState(t, downloadQueue, downloadHistory) === "failed" ? "warn" : "muted"}>
                    {trackDownloadState(t, downloadQueue, downloadHistory) === "failed" ? tl("side.downloadFailed") : tl("side.downloading")}
                  </span>
                )}
              </button>
              <button
                className="track-menu-btn"
                title={tl("side.more")}
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuId(menuId === t.id ? null : t.id);
                }}
              >
                <Icon slot="more" />
              </button>
              {menuId === t.id && (
                <div className="row-menu" onClick={(e) => e.stopPropagation()}>
                  <button disabled={i === 0} onClick={() => (lib.moveTrack(playlist.id, i, i - 1), setMenuId(null))}>
                    {tl("mgr.up")}
                  </button>
                  <button
                    disabled={i === playlist.tracks.length - 1}
                    onClick={() => (lib.moveTrack(playlist.id, i, i + 1), setMenuId(null))}
                  >
                    {tl("mgr.down")}
                  </button>
                  <button onClick={() => (void chooseImage(t), setMenuId(null))}>{tl("side.chooseImage")}</button>
                  <button
                    onClick={() => {
                      setMenuId(null);
                      void setTrackFrame(playlist.id, t.id, t.videoPath).catch(() => lib.setTrackThumbnail(playlist.id, t.id, null));
                    }}
                  >
                    {tl("side.resetPreview")}
                  </button>
                  <button onClick={() => (lib.removeTrack(playlist.id, t.id), setMenuId(null))}>{tl("side.remove")}</button>
                  <button
                    className="danger-text"
                    onClick={() => {
                      setMenuId(null);
                      setDeleteError(null);
                      setPendingDelete(t);
                    }}
                  >
                    {tl("side.removeFiles")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title={tl("side.deleteTitle")}
          confirmLabel={tl("side.trash")}
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void deleteFiles(pendingDelete)}
        >
          <p>{tl("side.deleteBody", { title: pendingDelete.title })}</p>
          <ul className="file-list">
            <li>{fileName(pendingDelete.videoPath)}</li>
            {pendingDelete.audioPath && <li>{fileName(pendingDelete.audioPath)}</li>}
          </ul>
          {deleteError && <p className="error-text">{deleteError}</p>}
        </ConfirmDialog>
      )}
    </aside>
  );
}
