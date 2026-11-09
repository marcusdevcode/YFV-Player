// Playlist export to and import from a .json file (File menu and the playlist manager).
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { tr, trn } from "./translate";
import { usePlaylistLibraryStore } from "./store/playlistLibraryStore";
import { queueMissingThumbnails } from "./videoThumbnails";

const filters = () => [{ name: tr("filter.playlist"), extensions: ["json"] }];

/** Export the active playlist to a .json file the user picks. */
export async function exportActivePlaylist() {
  const { activeId, playlists, exportText, setNotice } = usePlaylistLibraryStore.getState();
  const playlist = playlists.find((p) => p.id === activeId);
  if (!playlist) {
    setNotice(tr("notice.noExport"));
    return;
  }
  try {
    const path = await save({ defaultPath: `${playlist.title}.json`, filters: filters() });
    const text = exportText(playlist.id);
    if (path && text) await invoke("text_file_write", { path, text });
  } catch (e) {
    setNotice(tr("notice.exportFailed", { error: String(e) }));
  }
}

/** Import playlists from a .json file the user picks. */
export async function importPlaylists() {
  const { importText, setNotice } = usePlaylistLibraryStore.getState();
  try {
    const picked = await open({ multiple: false, filters: filters() });
    if (typeof picked !== "string") return;
    const count = importText(await invoke<string>("text_file_read", { path: picked }));
    queueMissingThumbnails();
    setNotice(trn("notice.imported", count));
  } catch (e) {
    setNotice(tr("notice.importFailed", { error: e instanceof Error ? e.message : String(e) }));
  }
}
