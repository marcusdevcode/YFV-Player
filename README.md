<p align="center"><img src="assets/icon.svg" width="120" alt="App icon"></p>

# Video player

The app name, version and repository are defined only in [package.json](package.json); everything else reads them from there.

A cross-platform desktop video player with playlists, drag-and-drop, theming, and optional YouTube downloading, so you can keep watching when your internet is unreliable.

**Stack:** Tauri v2 (Rust) · TypeScript · React · Zustand · Vite

**Platforms (64-bit only):** macOS (Apple Silicon + Intel, separate builds) · Windows (x64 + ARM64) · Linux / Ubuntu / Debian (x64 + ARM64)

**Status:** in progress (nothing committed or released yet). This file is the single place to track progress. `[x]` = done and checked, `[~]` = written and checked by me with logs and tools but not yet confirmed by hand (or only partly built), `[ ]` = not started.

---

## How we work

1. This README lists every feature and the order we build them in.
2. We implement one task at a time, test it, and tick it here.
3. Git and GitHub are done by the owner only. Automated tools never run git or `gh`; they give step-by-step instructions instead.
4. **No timers in the UI.** No `setInterval`, `setTimeout` or `requestAnimationFrame`; everything runs from media events (such as `timeupdate`) and input events, for performance.

---

## Development

Full guide, including how to get your own update-signing keys if you copy this repo: **[DEVELOPMENT.md](DEVELOPMENT.md)**.

- `npm start` (or `npm run dev:app`): run the desktop app in development.
- `npm run dev`: web page only, without the desktop features.
- `npm run typecheck` and `cargo test` (in `src-tauri/`): checks.
- `npm run build:app` builds for this machine. Manual releases (macOS natively, Linux and Windows in Docker) are described in DEVELOPMENT.md.
- Builds read the update-signing key from `keys/private.key` automatically (the public half is `keys/public.pub`). The private file is git-ignored; `keys/private.key.example` shows where it goes. Without a key a build still works but has no update files.

---

## Key decisions

| Topic | Decision |
|---|---|
| YouTube backend | A bundled helper program (Tauri "sidecar") running `youtubei.js`, the same library [FreeTube](https://github.com/FreeTubeApp/FreeTube) uses. Nothing for the user to install. |
| Separate video and audio | Kept as two files (e.g. `.mp4` + `.m4a`). The player plays them together, or File → Merge combines them into one MP4 with pure Rust (no re-encoding, no ffmpeg). |
| Icons | The whole UI is switchable. Every icon slot can be remapped to any icon from your icomoon pack; built-in fallbacks for slots the pack doesn't cover. |
| macOS | Two separate builds (Apple Silicon and Intel), not a universal binary. |
| Updates | Auto-update from GitHub Releases (repository from package.json). |
| Default language | English. Others are added later as files in `src/locales/`. |

---

## Features and tasks

### Foundation
- [x] **1. Scaffold**: Tauri v2 + Vite + React + TypeScript + Zustand inside this repo, `.gitignore`, window title taken from package.json.
- [x] **1a. App icon**: optimise `assets/icon.svg` (the PNG is only 300×300) into a 1024px master and generate every platform icon (`.icns`, `.ico`, PNG sizes) with `tauri icon`.
- [~] **2. Player** *(the 855 MB video and the m4a load and play in the app, checked by logs; needs your check by eye and ear)*: port of the old `index.html` player: video + optional separate audio, play/pause, seek, loop, fullscreen (whole window), auto-hiding controls, remembers position per video, keyboard shortcuts (Space, ←/→ 5s, Shift+←/→ 30s, hold to scrub). Files stream from disk through a small local server (`127.0.0.1`, only files you opened), so large files are never loaded into memory. Opens automatically when playback is ready. A file path passed on the command line plays immediately.
- [~] **2a. Separate audio sync without timers**: when a video and an audio file are played separately, they are aligned only when you play, pause, seek, rewind/forward or loop (audio starts first, video follows; the start offset is measured and remembered). When the window is hidden or you switch to another app, the audio keeps playing and the video rejoins it when you come back. No `setInterval`, `setTimeout` or `requestAnimationFrame` anywhere in the UI: everything runs from media events such as `timeupdate`. *(measured drift after each start/seek: about 0.00-0.08 s on the Silent Hill pair; needs your ears to confirm)*
- [~] **2b. Real duration for files with wrong headers**: fragmented MP4s whose headers claim a doubled length (13:49:50 instead of 6:54:55) now show and end at the real length, read from the file's segment index.
- [~] **2c. Merge video + audio into one MP4 (pure Rust, no re-encoding)**: File → Merge Video + Audio… (if a video + separate audio pair is already open, it merges that pair; otherwise it asks for both files). Asks where to save, shows a progress window (percent, size, speed, time left, Cancel), then plays the merged file. Originals are never touched. Works with fragmented (DASH) and regular MP4/M4A. *(verified on your 1.25 GB pair: 2 tracks, 6:54:55, macOS reports 0 errors, plays in the app; the buttons and dialog have not been clicked by a human yet)*
- [~] **2d. Volume**: mute/unmute button and a volume slider in the control bar; both are remembered between runs. With a separate audio file the volume applies to the audio, otherwise to the video. *(verified: values reach the right element and survive a restart; needs your ears)*
- [ ] **3. Layout**: sidebar exactly 320px, video takes the rest; both 100vh.

### Opening files
- [~] **4. "Open with" support** *(only the first step exists: a file passed on launch plays right away; file associations for Finder/Explorer/Files, single-window reuse and the install-time registration are not done)*: The app appears in the right-click "Open with" list for video and audio files in Finder, Windows Explorer and Ubuntu Files (mp4, m4v, mov, mkv, webm, avi, wmv, flv, mpg, ts, 3gp, ogv, m4a, mp3, aac, flac, wav, ogg, opus). Opening a second file while the app runs reuses the existing window. Clear message for unsupported codecs. *Only works in an installed build, not in dev mode.*

### Playlists
- [ ] **5. Playlist model + JSON**: title, color, cover, tracks (video path, optional audio path, thumbnail, source). Save, load, import and export as `.json`; autosaved.
- [ ] **5a. Reorder tracks**: drag and drop plus move up/down.
- [ ] **5b. Looping, two independent switches**:
  - *Video loop*: repeats the current video forever, in or out of a playlist.
  - *Playlist loop*: after the last video, starts again from the first. Off = stops at the end.
- [ ] **5c. Playlists menu (second side panel)**: compact circular badges with initials ("Best movies collection" → **BMC**), custom color per playlist, default color from settings, tooltip with full name.
- [ ] **5d. Playlist manager** (settings button in that panel): add, rename, recolor, delete, reorder playlists.
- [ ] **5e. Remove tracks**: remove from the playlist only, or remove and delete the video and audio files (moved to the system Trash, with a confirmation listing the files).

### Adding videos
- [ ] **6. Drag and drop**: drop videos and audio onto the window; they appear as a list you tick and add to the playlist.
- [ ] **7. "Add videos" dialog**:
  - big drag-and-drop area in the center,
  - dropdown: **Video only** (default) or **Video + separate audio**,
  - optional YouTube section: paste a video / playlist / channel link, or type a search.
- [ ] **8. Thumbnails**: first frame by default for each video and playlist; optionally choose your own preview (a frame or an image file).

### Look and settings
- [ ] **9. Themes**: complete dark and complete light.
- [~] **10. Native menu** *(partly built)*: done: File (Open Video, Open Video + Separate Audio, Merge Video + Audio, Close Window), Edit, View (fullscreen), Window, Help → Check for Updates, and the macOS app menu. Still to do: save/load playlist, sidebar left/right, theme, language, settings.
- [ ] **11. Languages**: `src/locales/` folder, English by default, language switcher; adding a language means adding a file.
- [ ] **12. Settings page**: colors of UI elements, icon mapping from your icomoon pack, default playlist color, **default YouTube video quality** and **default audio quality**, download limits, reset to defaults.

### YouTube (optional feature)
- [ ] **13. YouTube helper**: search, video info, and the list of available formats (video + audio together, video only, audio only; quality, codec, size).
- [ ] **13a. Playlists and channels**: fetch every video of a playlist or channel, including all pages.
- [ ] **14. YouTube in the Add dialog**: link or search, choose formats (or use the defaults from settings), add to a playlist.
- [ ] **14a. One-click playlist/channel download**: creates a new playlist with the YouTube playlist's title, queues all videos in order, and fills the playlist as downloads finish. One failed video doesn't stop the rest.
- [ ] **15. Download manager page**: its own page with **Queue** and **History**; per-video progress (video and audio separately), speed, ETA; **cancel** any download; **change priority** (drag to reorder, "move to top", "download now"); pause/resume; survives restarts.

### Release
- [ ] **16. Polish**: error handling, shortcut help, check "Open with" on each OS.
- [~] **17. Builds for all platforms** *(manual local releases: macOS builds natively and was built and signed; the Docker builds for Linux x64/arm64 and Windows x64/arm64 are written but never run, because Docker isn't installed here yet)*: `npm run build:mac*`, `npm run docker:*`, `npm run release:collect` (macOS arm64 + x64, Windows x64 + arm64, Linux x64 + arm64; `.deb`, `.rpm`, `.AppImage`; no 32-bit). No CI.
- [~] **18. Auto-update from GitHub Releases** *(code and signing written; untested until the first release is published)*: signed updates, check on startup and from the menu, progress and "install and restart".

---

## Known risks

- **YouTube changes often.** The downloader may need library updates over time; we validate it early with a real video.
- **Video codecs.** The built-in web engine on each OS decides what plays. H.264/AAC works everywhere; MKV/AVI and VP9/AV1 may not on some systems. Linux needs GStreamer codec packages.
- **Unsigned builds.** Without Apple/Microsoft code-signing certificates, macOS and Windows show a security warning on first launch.
- **Updater key.** The update-signing private key must be backed up; if it is lost, installed apps can no longer update.
- **Auto-update on Linux** works for AppImage only; `.deb`/`.rpm` users install new versions manually.

## Credits and license

- Licensed under GPL-3.0 (see [LICENSE](LICENSE)).
- YouTube features are modelled on [FreeTube](https://github.com/FreeTubeApp/FreeTube) (AGPL-3.0) and use the [youtubei.js](https://github.com/LuanRT/YouTube.js) library. Any code adapted from FreeTube will be attributed here.
- Player icons from your IcoMoon selection; app icon in `assets/`.
