import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import CustomTopBar from "./components/CustomTopBar";
import ContextMenu from "./components/ContextMenu";
import DownloadManagerDialog from "./components/DownloadManagerDialog";
import DownloadProgressPopup from "./components/DownloadProgressPopup";
import YouTubeQualityDialog from "./components/YouTubeQualityDialog";
import AddVideosDialog from "./components/AddVideosDialog";
import Icon from "./components/Icon";
import MergeDialog from "./components/MergeDialog";
import Player from "./components/Player";
import PlaylistManager from "./components/PlaylistManager";
import PlaylistBadgeColumn from "./components/PlaylistBadgeColumn";
import SettingsDialog from "./components/SettingsDialog";
import ThemesDialog from "./components/ThemesDialog";
import PlaylistTrackList from "./components/PlaylistTrackList";
import UpdateBanner from "./components/UpdateBanner";
import { useT, tr } from "./translate";
import { LOCALES } from "./locales";
import { AUDIO_EXT, VIDEO_EXT, isMediaPath } from "./mediaFiles";
import { mergeFlow } from "./mergeFlow";
import { exportActivePlaylist, importPlaylists } from "./playlistImportExport";
import { useAddDialogStore } from "./store/addDialogStore";
import { usePlaylistLibraryStore } from "./store/playlistLibraryStore";
import { usePlayerStore } from "./store/playerStore";
import { usePlaybackPositionStore } from "./store/playbackPositionStore";
import { loadImportedLanguages } from "./translationFiles";
import { loadSettings, startSavingSettings } from "./generalSettings";
import { activeTheme, useThemeStore } from "./store/themeStore";
import { IS_MAC, layoutOf } from "./theme/windowLayout";
import { applyThemeToDocument } from "./theme/themeEngine";
import { useInterfaceStore } from "./store/interfaceStore";
import { queueMissingThumbnails } from "./videoThumbnails";
import { fileName } from "./filePaths";
import { reconcileFinishedDownloads, startDownloadListeners } from "./store/downloadQueueStore";
import { pauseAllDownloads, resumeAllDownloads } from "./youtubeApi";
import { openContextMenu } from "./store/contextMenuStore";
import { textFieldAt, textFieldItems } from "./textFieldEditing";

async function pick(kind: "video" | "audio"): Promise<string | null> {
  const res = await open({
    multiple: false,
    filters: [{ name: kind === "video" ? tr("filter.video") : tr("filter.audio"), extensions: kind === "video" ? VIDEO_EXT : AUDIO_EXT }],
  });
  return typeof res === "string" ? res : null;
}

export default function App() {
  const source = usePlayerStore((s) => s.source);
  const playId = usePlayerStore((s) => s.playId);
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const setSource = usePlaylistLibraryStore((s) => s.playSource);
  const notice = usePlaylistLibraryStore((s) => s.notice);
  const sidebarOpen = useInterfaceStore((s) => s.sidebarOpen);
  const sidebarSide = useInterfaceStore((s) => s.sidebarSide);
  const language = useInterfaceStore((s) => s.language);
  // The experimental window style drops its frame, margin and shadow while the video is full screen.
  useEffect(() => {
    document.documentElement.dataset.fullscreen = fullscreen ? "yes" : "no";
  }, [fullscreen]);
  const { t } = useT();
  const customTopbar = useThemeStore((s) => {
    const th = activeTheme(s);
    return th.windowStyle === "experimental" && !layoutOf(th).titleBar;
  });
  const dragStrip = useThemeStore((s) => {
    const th = activeTheme(s);
    return IS_MAC && th.windowStyle === "experimental" && !layoutOf(th).titleBar;
  });

  // The remembered settings (panel, last video, positions, volume) load from files at startup.
  // Nothing is shown or opened before they are in, so the panel does not flash open and close.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const stores = [usePlayerStore, usePlaybackPositionStore];
    let settingsLoaded = false;
    const check = () => {
      if (settingsLoaded && stores.every((s) => s.persist.hasHydrated())) setReady(true);
    };
    // The general settings file and the custom themes, then the theme goes on before the first draw.
    void loadImportedLanguages().then(() => Promise.all([loadSettings(), useThemeStore.getState().load()])).then(() => {
      applyThemeToDocument(activeTheme(useThemeStore.getState()));
      startSavingSettings();
      settingsLoaded = true;
      check();
    });
    const offs = stores.map((s) => s.persist.onFinishHydration(check));
    return () => offs.forEach((off) => off());
  }, []);

  // The theme in use: applied whenever it changes, and "system" follows the operating system live.
  const theme = useThemeStore((s) => activeTheme(s));
  useEffect(() => {
    applyThemeToDocument(theme);
  }, [theme]);
  useEffect(() => {
    const query = matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => useThemeStore.getState().setSystemDark(e.matches);
    useThemeStore.getState().setSystemDark(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const [dragging, setDragging] = useState(false);

  const openVideo = useCallback(
    async (withAudio: boolean) => {
      const videoPath = await pick("video");
      if (!videoPath) return;
      const audioPath = withAudio ? await pick("audio") : null;
      setSource({ videoPath, audioPath: audioPath ?? undefined, title: fileName(videoPath) });
    },
    [setSource],
  );

  // A file passed on the command line or from "Open with" at launch starts playing right away.
  // The selected language: page language and direction, and the tick in the native Language menu.
  useEffect(() => {
    if (!ready) return;
    document.documentElement.lang = language;
    document.documentElement.dir = LOCALES[language]?.dir ?? "ltr";
    void invoke("menu_set_language", { code: language }).catch(() => {});
  }, [language, ready]);

  // Tick Left or Right in View -> Playlist Position.
  useEffect(() => {
    if (ready) void invoke("menu_set_sidebar_side", { side: sidebarSide }).catch(() => {});
  }, [sidebarSide, ready]);

  // Files opened from outside while the app runs (Finder, Explorer, a second launch) arrive as
  // "open-file" events and replace what is playing. The listener is registered first, so no file
  // can arrive between asking for the launch file and listening.
  useEffect(() => {
    if (!ready) return;
    const unlisten = listen<string>("open-file", (e) => {
      setSource({ videoPath: e.payload, title: fileName(e.payload) });
    });
    void unlisten
      .then(() => Promise.all([invoke<string | null>("launch_path"), invoke<string | null>("launch_audio")]))
      .then(([p, a]) => p && setSource({ videoPath: p, audioPath: a ?? undefined, title: fileName(p) }))
      .catch(() => {});
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [setSource, ready]);

  // Drag and drop files onto the window. The window reports drops as events, not as web page drops.
  useEffect(() => {
    const subs = [
      listen("tauri://drag-enter", () => setDragging(true)),
      listen("tauri://drag-leave", () => setDragging(false)),
      listen<{ paths: string[] }>("tauri://drag-drop", (e) => {
        setDragging(false);
        // Dropped files go to the Add dialog, where they are ticked and added to a playlist
        // (or played right away).
        const media = (e.payload.paths ?? []).filter(isMediaPath);
        if (media.length) useAddDialogStore.getState().openWith(media);
      }),
    ];
    return () => {
      subs.forEach((s) => void s.then((fn) => fn()));
    };
  }, [setSource]);

  // Listen to the download engine (Rust): the queue, progress and finished downloads.
  useEffect(() => {
    if (ready) void startDownloadListeners();
  }, [ready]);

  // Load the saved playlists once, then make any missing previews.
  useEffect(() => {
    if (!ready) return; // the restored video must be known before it is matched to a track
    void usePlaylistLibraryStore
      .getState()
      .load()
      .then(() => {
        usePlaylistLibraryStore.getState().restoreCurrent();
        reconcileFinishedDownloads();
        queueMissingThumbnails();
      });
  }, [ready]);

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
      if (e.payload === "settings") useInterfaceStore.getState().setSettingsOpen(true);
      if (e.payload === "themes") useInterfaceStore.getState().setThemesOpen(true);
      if (e.payload === "downloads") useInterfaceStore.getState().setDownloadsOpen(true);
      if (e.payload === "pause-all-downloads") void pauseAllDownloads();
      if (e.payload === "resume-all-downloads") void resumeAllDownloads();
      if (e.payload === "add-youtube") useAddDialogStore.getState().openYouTube();
      if (e.payload.startsWith("language:")) {
        useInterfaceStore.getState().setLanguage(e.payload.slice("language:".length));
        // A click on the ticked entry un-ticks it natively: put the tick back on the real language.
        void invoke("menu_set_language", { code: useInterfaceStore.getState().language }).catch(() => {});
      }
      if (e.payload === "toggle-sidebar") useInterfaceStore.getState().toggleSidebar();
      if (e.payload === "sidebar-left" || e.payload === "sidebar-right") {
        useInterfaceStore.getState().setSidebarSide(e.payload === "sidebar-left" ? "left" : "right");
        // Clicking the ticked entry un-ticks it natively: put the tick back on the real side.
        void invoke("menu_set_sidebar_side", { side: useInterfaceStore.getState().sidebarSide }).catch(() => {});
      }
      if (e.payload === "add-videos") useAddDialogStore.getState().openWith();
      if (e.payload === "import-playlist") void importPlaylists();
      if (e.payload === "export-playlist") void exportActivePlaylist();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [openVideo, mergeFromMenu]);

  // Right-click anywhere that has no menu of its own: Cut / Copy / Paste in a text box, otherwise
  // the common actions. Areas with their own menu (player, tracks, badges) stop the event first.
  const showGeneralMenu = (e: React.MouseEvent) => {
    const field = textFieldAt(e.target);
    if (field) {
      openContextMenu(e, textFieldItems(field, {
        cut: t("context.cut"), copy: t("context.copy"), paste: t("context.paste"), selectAll: t("context.selectAll"),
      }));
      return;
    }
    const selected = window.getSelection()?.toString() ?? "";
    openContextMenu(e, [
      ...(selected ? [{ label: t("context.copy"), onSelect: () => void document.execCommand("copy") }, "separator" as const] : []),
      { label: t("app.openVideo"), onSelect: () => void openVideo(false) },
      { label: t("app.openVideoAudio"), onSelect: () => void openVideo(true) },
      { label: t("app.addToPlaylist"), onSelect: () => useAddDialogStore.getState().openWith() },
      "separator",
      { label: sidebarOpen ? t("app.hidePanel") : t("app.showPanel"), onSelect: () => useInterfaceStore.getState().toggleSidebar() },
    ]);
  };

  if (!ready) return <div className="app" onContextMenu={(e) => e.preventDefault()} />;

  return (
    <div className="app" onContextMenu={showGeneralMenu}>
      {/* Floating themes without the system title bar get their own menu bar (hidden in full screen). */}
      {customTopbar && !IS_MAC && !fullscreen && <CustomTopBar />}
      {/* macOS keeps its native menu at the top of the screen: only a strip to drag the window. */}
      {dragStrip && !fullscreen && <div className="window-drag-strip" data-tauri-drag-region />}
      <ContextMenu />
      <UpdateBanner />
      <MergeDialog />
      <AddVideosDialog />
      <PlaylistManager />
      <SettingsDialog />
      <ThemesDialog />
      <DownloadManagerDialog />
      <YouTubeQualityDialog />
      <DownloadProgressPopup />
      {dragging && <div className="drop-hint">{t("app.dropToAdd")}</div>}
      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button onClick={() => usePlaylistLibraryStore.getState().setNotice(null)}>{t("common.close")}</button>
        </div>
      )}
      <div className={`shell side-${sidebarSide}${fullscreen ? " is-fullscreen" : ""}`}>
        <div className={`dock${sidebarOpen ? "" : " closed"}`}>
          <div className="dock-inner">
            <PlaylistBadgeColumn />
            <PlaylistTrackList />
          </div>
        </div>
        <main className="stage">
          <button
            className={`edge-tab ${sidebarSide}`}
            onClick={() => useInterfaceStore.getState().toggleSidebar()}
            title={sidebarOpen ? t("app.hidePanel") : t("app.showPanel")}
            aria-label={sidebarOpen ? t("app.hidePanel") : t("app.showPanel")}
          >
            <Icon
              slot={
                sidebarSide === "left"
                  ? sidebarOpen ? "panelHideLeft" : "panelShowLeft"
                  : sidebarOpen ? "panelHideRight" : "panelShowRight"
              }
            />
          </button>
          {source ? (
            <Player key={playId} />
          ) : (
            <div className="empty">
              <img src="/icon.svg" width={96} height={96} alt="" />
              <h1>{__APP_NAME__}</h1>
              <div className="empty-actions">
                <button className="primary" onClick={() => void openVideo(false)}>
                  {t("app.openVideo")}
                </button>
                <button onClick={() => void openVideo(true)}>{t("app.openVideoAudio")}</button>
                <button onClick={() => useAddDialogStore.getState().openWith()}>{t("app.addToPlaylist")}</button>
                <button onClick={() => useAddDialogStore.getState().openYouTube()}>{t("app.addFromYouTube")}</button>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
