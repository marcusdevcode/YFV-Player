import { DEFAULT_PLAYLIST_COLOR, usePlaylistLibraryStore } from "../store/playlistLibraryStore";
import { useT } from "../translate";
import { openContextMenu } from "../store/contextMenuStore";
import Icon from "./Icon";
import { initials } from "../textFormatting";
import ScrollArea from "./ScrollArea";

/** The narrow column of round playlist badges ("Best movies collection" -> BMC). */
export default function PlaylistBadgeColumn() {
  const playlists = usePlaylistLibraryStore((s) => s.playlists);
  const activeId = usePlaylistLibraryStore((s) => s.activeId);
  const setActive = usePlaylistLibraryStore((s) => s.setActive);
  const createPlaylist = usePlaylistLibraryStore((s) => s.createPlaylist);
  const setManagerOpen = usePlaylistLibraryStore((s) => s.setManagerOpen);
  const { t } = useT();

  return (
    <ScrollArea className="badges" role="navigation" aria-label={t("panel.aria")}>
      {playlists.map((p) => (
        <button
          key={p.id}
          className={`badge${p.id === activeId ? " active" : ""}`}
          style={{ background: p.color ?? DEFAULT_PLAYLIST_COLOR }}
          title={p.title}
          onClick={() => setActive(p.id)}
          onContextMenu={(e) => {
            setActive(p.id);
            openContextMenu(e, [
              { label: t("panel.manage"), onSelect: () => setManagerOpen(true) },
              { label: t("panel.new"), onSelect: () => (createPlaylist(), setManagerOpen(true)) },
            ]);
          }}
        >
          {initials(p.title)}
        </button>
      ))}
      <button
        className="badge tool"
        title={t("panel.new")}
        onClick={() => {
          createPlaylist();
          setManagerOpen(true);
        }}
      >
        <Icon slot="addPlaylist" />
      </button>
      <button className="badge tool" title={t("panel.manage")} onClick={() => setManagerOpen(true)}>
        <Icon slot="settings" />
      </button>
    </ScrollArea>
  );
}
