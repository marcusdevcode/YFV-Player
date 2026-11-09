import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { usePlayerStore, type Source } from "./playerStore";
import { tr } from "../translate";
import { newId } from "../uniqueIds";

export const DEFAULT_PLAYLIST_COLOR = "#8b0000";

export interface Track {
  id: string;
  videoPath: string;
  audioPath?: string;
  title: string;
  /** Path of the preview image. undefined = not made yet, null = could not be made. */
  thumbnail?: string | null;
  /** Set while the video is still being downloaded from YouTube: the track cannot be played yet. */
  download?: { jobId: string; videoId: string };
}

export interface Playlist {
  id: string;
  title: string;
  color?: string;
  /** A custom cover image; without one the first track's preview is used. */
  cover?: string | null;
  tracks: Track[];
}

/** What is saved to disk (and exported). */
interface Saved {
  version: 1;
  playlists: Playlist[];
  activeId: string | null;
  loopPlaylist: boolean;
}

interface PlaylistLibraryState {
  loaded: boolean;
  playlists: Playlist[];
  activeId: string | null;
  loopPlaylist: boolean;
  /** The track that is playing now, when it was started from a playlist. */
  currentTrackId: string | null;
  managerOpen: boolean;
  /** A message for the user (import errors and the like), shown until closed. */
  notice: string | null;

  load: () => Promise<void>;
  setNotice: (n: string | null) => void;
  setManagerOpen: (open: boolean) => void;

  createPlaylist: (title?: string) => string;
  renamePlaylist: (id: string, title: string) => void;
  recolorPlaylist: (id: string, color: string) => void;
  deletePlaylist: (id: string) => void;
  movePlaylist: (id: string, delta: number) => void;
  setActive: (id: string) => void;
  setCover: (id: string, cover: string | null) => void;
  setLoopPlaylist: (v: boolean) => void;

  addTracks: (playlistId: string, tracks: Track[]) => void;
  /** A YouTube download finished: the track gets its files and becomes playable. */
  completeDownloadedTrack: (playlistId: string, trackId: string, videoPath: string, audioPath?: string) => void;
  removeTrack: (playlistId: string, trackId: string) => void;
  moveTrack: (playlistId: string, from: number, to: number) => void;
  /** Turn the whole order around: the last video becomes the first. */
  reverseTracks: (playlistId: string) => void;
  setTrackThumbnail: (playlistId: string, trackId: string, path: string | null) => void;

  playTrack: (playlistId: string, trackId: string) => void;
  /** Play something that is not part of a playlist (File -> Open, drops, "Open with"). */
  playSource: (source: Source) => void;
  /** Start the next track of the current playlist. False when there is none (playback stops). */
  playNext: () => boolean;
  /** After a restart: find the restored video in the playlists and mark it as the current track. */
  restoreCurrent: () => void;

  exportText: (playlistId: string) => string | null;
  importText: (text: string) => number;
}

const sourceOf = (t: Track): Source => ({ videoPath: t.videoPath, audioPath: t.audioPath, title: t.title });

/** Delete a thumbnail file we own (the backend refuses anything outside its thumbnail folder). */
const dropFile = (path?: string | null) => {
  if (path) void invoke("thumbnail_delete", { path }).catch(() => {});
};

export const usePlaylistLibraryStore = create<PlaylistLibraryState>()((set, get) => {
  const save = () => {
    const { playlists, activeId, loopPlaylist } = get();
    const data: Saved = { version: 1, playlists, activeId, loopPlaylist };
    void invoke("library_save", { json: JSON.stringify(data) }).catch((e) =>
      set({ notice: tr("notice.saveFailed", { error: String(e) }) }),
    );
  };
  const update = (fn: (playlists: Playlist[]) => Playlist[]) => {
    set((s) => ({ playlists: fn(s.playlists) }));
    save();
  };
  const patch = (id: string, fn: (p: Playlist) => Playlist) =>
    update((list) => list.map((p) => (p.id === id ? fn(p) : p)));

  return {
    loaded: false,
    playlists: [],
    activeId: null,
    loopPlaylist: false,
    currentTrackId: null,
    managerOpen: false,
    notice: null,

    load: async () => {
      try {
        const text = await invoke<string | null>("library_load");
        if (text) {
          const saved = JSON.parse(text) as Partial<Saved>;
          const playlists = Array.isArray(saved.playlists) ? saved.playlists : [];
          const activeId = playlists.some((p) => p.id === saved.activeId) ? saved.activeId! : (playlists[0]?.id ?? null);
          set({ playlists, activeId, loopPlaylist: !!saved.loopPlaylist, loaded: true });
          return;
        }
      } catch (e) {
        set({ notice: tr("notice.loadFailed", { error: String(e) }) });
      }
      set({ loaded: true });
    },
    setNotice: (notice) => set({ notice }),
    setManagerOpen: (managerOpen) => set({ managerOpen }),

    createPlaylist: (title) => {
      const id = newId();
      const name = title?.trim() || tr("playlist.defaultName", { n: get().playlists.length + 1 });
      set((s) => ({ playlists: [...s.playlists, { id, title: name, tracks: [] }], activeId: id }));
      save();
      return id;
    },
    renamePlaylist: (id, title) => {
      const name = title.trim();
      if (name) patch(id, (p) => ({ ...p, title: name }));
    },
    recolorPlaylist: (id, color) => patch(id, (p) => ({ ...p, color })),
    deletePlaylist: (id) => {
      const gone = get().playlists.find((p) => p.id === id);
      gone?.tracks.forEach((t) => dropFile(t.thumbnail));
      dropFile(gone?.cover);
      set((s) => {
        const playlists = s.playlists.filter((p) => p.id !== id);
        const activeId = s.activeId === id ? (playlists[0]?.id ?? null) : s.activeId;
        const inGone = gone?.tracks.some((t) => t.id === s.currentTrackId);
        return { playlists, activeId, currentTrackId: inGone ? null : s.currentTrackId };
      });
      save();
    },
    movePlaylist: (id, delta) =>
      update((list) => {
        const from = list.findIndex((p) => p.id === id);
        const to = Math.max(0, Math.min(list.length - 1, from + delta));
        if (from < 0 || from === to) return list;
        const next = [...list];
        next.splice(to, 0, next.splice(from, 1)[0]);
        return next;
      }),
    setActive: (id) => {
      set({ activeId: id });
      save();
    },
    setCover: (id, cover) => {
      const old = get().playlists.find((p) => p.id === id)?.cover;
      if (old && old !== cover) dropFile(old);
      patch(id, (p) => ({ ...p, cover }));
    },
    setLoopPlaylist: (loopPlaylist) => {
      set({ loopPlaylist });
      save();
    },

    addTracks: (playlistId, tracks) => patch(playlistId, (p) => ({ ...p, tracks: [...p.tracks, ...tracks] })),
    completeDownloadedTrack: (playlistId, trackId, videoPath, audioPath) =>
      patch(playlistId, (p) => ({
        ...p,
        tracks: p.tracks.map((t) => {
          if (t.id !== trackId) return t;
          const { download: _download, ...rest } = t;
          return { ...rest, videoPath, audioPath, thumbnail: undefined };
        }),
      })),
    removeTrack: (playlistId, trackId) => {
      const track = get().playlists.find((p) => p.id === playlistId)?.tracks.find((t) => t.id === trackId);
      dropFile(track?.thumbnail);
      if (get().currentTrackId === trackId) set({ currentTrackId: null });
      patch(playlistId, (p) => ({ ...p, tracks: p.tracks.filter((t) => t.id !== trackId) }));
    },
    moveTrack: (playlistId, from, to) =>
      patch(playlistId, (p) => {
        if (from === to || from < 0 || from >= p.tracks.length) return p;
        const tracks = [...p.tracks];
        tracks.splice(Math.max(0, Math.min(tracks.length, to)), 0, tracks.splice(from, 1)[0]);
        return { ...p, tracks };
      }),
    reverseTracks: (playlistId) => patch(playlistId, (p) => ({ ...p, tracks: [...p.tracks].reverse() })),
    setTrackThumbnail: (playlistId, trackId, path) => {
      const old = get().playlists.find((p) => p.id === playlistId)?.tracks.find((t) => t.id === trackId)?.thumbnail;
      if (old && old !== path) dropFile(old);
      patch(playlistId, (p) => ({ ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, thumbnail: path } : t)) }));
    },

    playTrack: (playlistId, trackId) => {
      const track = get().playlists.find((p) => p.id === playlistId)?.tracks.find((t) => t.id === trackId);
      if (!track || track.download) return; // a video that is still downloading cannot be played
      set({ currentTrackId: trackId, activeId: playlistId });
      // Picked in a playlist (by click or as the next track): always from the beginning.
      usePlayerStore.getState().setSource(sourceOf(track), true);
    },
    playSource: (source) => {
      set({ currentTrackId: null });
      usePlayerStore.getState().setSource(source);
    },
    playNext: () => {
      const { playlists, currentTrackId, loopPlaylist } = get();
      const list = playlists.find((p) => p.tracks.some((t) => t.id === currentTrackId));
      if (!list) return false;
      const at = list.tracks.findIndex((t) => t.id === currentTrackId);
      // Videos that are still downloading are skipped.
      const playable = (t: Track) => !t.download;
      const next = list.tracks.slice(at + 1).find(playable) ?? (loopPlaylist ? list.tracks.find(playable) : undefined);
      if (!next) return false;
      get().playTrack(list.id, next.id);
      return true;
    },

    restoreCurrent: () => {
      const source = usePlayerStore.getState().source;
      if (!source) return;
      const { playlists, activeId } = get();
      const ordered = [playlists.find((p) => p.id === activeId), ...playlists];
      for (const playlist of ordered) {
        const track = playlist?.tracks.find((t) => t.videoPath === source.videoPath && t.audioPath === source.audioPath);
        if (playlist && track) {
          set({ currentTrackId: track.id, activeId: playlist.id });
          return;
        }
      }
    },

    exportText: (playlistId) => {
      const playlist = get().playlists.find((p) => p.id === playlistId);
      if (!playlist) return null;
      const exported = { ...playlist, tracks: playlist.tracks.filter((t) => !t.download) }; // not yet downloaded videos have no file
      const data: Saved = { version: 1, playlists: [exported], activeId: playlist.id, loopPlaylist: false };
      return JSON.stringify(data, null, 2);
    },
    importText: (text) => {
      const data = JSON.parse(text) as Partial<Saved>;
      if (!Array.isArray(data.playlists)) throw new Error(tr("notice.notExport"));
      // New ids, and no previews: those files belong to the machine that made the export.
      const incoming: Playlist[] = data.playlists
        .filter((p) => p && typeof p.title === "string" && Array.isArray(p.tracks))
        .map((p) => ({
          id: newId(),
          title: p.title,
          color: p.color,
          tracks: p.tracks
            .filter((t) => t && typeof t.videoPath === "string")
            .map((t) => ({ id: newId(), videoPath: t.videoPath, audioPath: t.audioPath, title: t.title || t.videoPath })),
        }));
      if (incoming.length === 0) throw new Error(tr("notice.noPlaylists"));
      set((s) => ({ playlists: [...s.playlists, ...incoming], activeId: incoming[0].id }));
      save();
      return incoming.length;
    },
  };
});

/** Where a track lives: its playlist and position. */
export function locateTrack(trackId: string | null) {
  if (!trackId) return null;
  const { playlists } = usePlaylistLibraryStore.getState();
  for (const playlist of playlists) {
    const index = playlist.tracks.findIndex((t) => t.id === trackId);
    if (index >= 0) return { playlist, index, track: playlist.tracks[index] };
  }
  return null;
}
