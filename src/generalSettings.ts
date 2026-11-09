import { invoke } from "@tauri-apps/api/core";
import settingsSchema from "../schemas/settings.schema.json";
import { LOCALES } from "./locales";
import { validate } from "./jsonSchemaValidator";
import { tr } from "./translate";
import { usePlaylistLibraryStore } from "./store/playlistLibraryStore";
import { usePlayerStore } from "./store/playerStore";
import { useThemeStore } from "./store/themeStore";
import { useInterfaceStore } from "./store/interfaceStore";

/** The general settings file: settings/settings.json in the app data folder (schemas/settings.schema.json). */
const FILE = "settings";

interface Settings {
  schemaVersion: 1;
  language: string;
  theme: string;
  sidebar: { open: boolean; side: "left" | "right" };
  player: { volume: number; muted: boolean; pauseVideoInBackground: boolean };
}

function current(): Settings {
  const ui = useInterfaceStore.getState();
  const player = usePlayerStore.getState();
  return {
    schemaVersion: 1,
    language: ui.language,
    theme: useThemeStore.getState().selected,
    sidebar: { open: ui.sidebarOpen, side: ui.sidebarSide },
    player: { volume: player.volume, muted: player.muted, pauseVideoInBackground: player.pauseVideoInBackground },
  };
}

function apply(s: Partial<Settings>) {
  const ui: Record<string, unknown> = {};
  if (s.language && LOCALES[s.language]) ui.language = s.language;
  if (s.sidebar?.open !== undefined) ui.sidebarOpen = s.sidebar.open;
  if (s.sidebar?.side) ui.sidebarSide = s.sidebar.side;
  useInterfaceStore.setState(ui);
  if (s.player?.volume !== undefined) usePlayerStore.setState({ volume: s.player.volume });
  if (s.player?.muted !== undefined) usePlayerStore.setState({ muted: s.player.muted });
  if (s.player?.pauseVideoInBackground !== undefined) usePlayerStore.setState({ pauseVideoInBackground: s.player.pauseVideoInBackground });
  if (s.theme) useThemeStore.setState({ selected: s.theme });
}

/** Settings saved by earlier versions (one file per store), so nothing is lost on update. */
async function readOldSettings(): Promise<Partial<Settings>> {
  const old: Partial<Settings> = {};
  const read = async (name: string) => {
    try {
      const text = await invoke<string | null>("settings_get", { name: `${__APP_ID__}:${name}` });
      return text ? (JSON.parse(text).state as Record<string, any>) : null;
    } catch {
      return null;
    }
  };
  const ui = await read("ui");
  if (ui) {
    old.language = ui.language;
    old.sidebar = { open: ui.sidebarOpen ?? true, side: ui.sidebarSide === "right" ? "right" : "left" };
  }
  const player = await read("player");
  if (player && typeof player.volume === "number") old.player = { volume: player.volume, muted: !!player.muted, pauseVideoInBackground: true };
  return old;
}

let writing = false;
let again = false;
async function save() {
  if (writing) {
    again = true;
    return;
  }
  writing = true;
  try {
    do {
      again = false;
      await invoke("settings_set", { name: FILE, value: JSON.stringify(current(), null, 2) });
    } while (again);
  } catch (e) {
    usePlaylistLibraryStore.getState().setNotice(tr("notice.saveFailed", { error: String(e) }));
  } finally {
    writing = false;
  }
}

/** Read the general settings into the stores (English, the system theme and a visible panel if there is no file yet). */
export async function loadSettings(): Promise<void> {
  try {
    const text = await invoke<string | null>("settings_get", { name: FILE });
    if (text) {
      const data = JSON.parse(text);
      const errors = validate(settingsSchema, data);
      if (errors.length) {
        usePlaylistLibraryStore.getState().setNotice(tr("settings.invalidFile", { problems: errors.slice(0, 3).join("; ") }));
      } else {
        apply(data as Settings);
      }
    } else {
      apply(await readOldSettings());
    }
  } catch (e) {
    usePlaylistLibraryStore.getState().setNotice(tr("notice.loadFailed", { error: String(e) }));
  }
}

/** From now on, every change of a general setting is written to the settings file. */
let started = false;
export function startSavingSettings() {
  if (started) return; // React may run the startup effect twice in development
  started = true;
  useInterfaceStore.subscribe((s, p) => {
    if (s.language !== p.language || s.sidebarOpen !== p.sidebarOpen || s.sidebarSide !== p.sidebarSide) void save();
  });
  usePlayerStore.subscribe((s, p) => {
    if (s.volume !== p.volume || s.muted !== p.muted || s.pauseVideoInBackground !== p.pauseVideoInBackground) void save();
  });
  useThemeStore.subscribe((s, p) => {
    if (s.selected !== p.selected) void save();
  });
  void save(); // writes the file for the first time (and migrates old settings)
}
