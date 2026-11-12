<p align="center"><img src="assets/icon.svg" width="120" alt="App icon"></p>

# Video player

A cross-platform desktop video player (macOS, Windows, Linux) that plays video and audio from your disk and, optionally, downloads from YouTube so you can keep watching when your internet is unreliable.

**What it does**
- **Plays** video files, or a video with a separate audio file (the two play in sync, or File → Merge joins them into one MP4 without re-encoding). Remembers the position of every video, volume and settings; large files stream from disk, never loaded into memory.
- **Playlists:** many named, colored playlists, drag and drop to add files, reorder (and reverse) tracks, loop a video or a whole playlist, thumbnails, import/export as `.json`. A playlist keeps playing to the next track even while the window is in the background.
- **YouTube (optional):** search or paste a video, playlist or channel link, browse a channel's videos and playlists, pick the quality, and download. Downloads run in a queue in the background, one at a time, with priority, pause/resume, progress and automatic continuation after a lost connection.
- **Looks:** themes (colors, icons, window style), including floating transparent rounded designs with their own menu bar; every theme exports and imports as a `.json` file. Several interface languages (English, Hebrew with right-to-left).
- **Updates:** signed automatic updates from GitHub Releases.

**Stack:** Tauri v2 (Rust) · TypeScript · React · Zustand · Vite

**Platforms (64-bit only):** macOS (Apple Silicon + Intel, separate builds) · Windows (x64 + ARM64) · Linux / Ubuntu / Debian (x64 + ARM64)

**Status:** in progress (v0.1.x releases are published on GitHub). This file is the single place to track progress. `[x]` = done and checked, `[~]` = written and checked by me with logs and tools but not yet confirmed by hand (or only partly built), `[ ]` = not started. What each version delivered is listed at the end of this file.

The app name, version and repository are defined only in [package.json](package.json); everything else reads them from there.

---

## How we work

1. This README lists every feature and the order we build them in.
2. We implement one task at a time, test it, and tick it here.
3. Git and GitHub are done by the owner only. Automated tools never run git or `gh`; they give step-by-step instructions instead.
4. **No timers in the UI.** No `setInterval`, `setTimeout` or `requestAnimationFrame`; everything runs from media events (such as `timeupdate`) and input events, for performance.

---

## Development

Full guide, including how to get your own update-signing keys if you copy this repo: **[DEVELOPMENT.md](DEVELOPMENT.md)**.

- `npm run dev`: run the desktop app in development (it fetches the yt-dlp program for your machine first).
- `npm run typecheck` and `cargo test` (in `src-tauri/`): checks.
- `npm run build:app` builds for this machine. Every build (`build:mac*`, `build:app`, `docker:*`) moves its installers into one folder, `builds/v<version>/` (with the update signatures and `latest.json`), and leaves no installers in `src-tauri/target`.
- `npm run build` removes every earlier build, then builds all six platforms from scratch into `builds/v<version>/`, without publishing. Linux and Windows are built in Docker: start Colima (or Docker Desktop) first.
- `npm run clean:rust` empties the Rust build folder (`src-tauri/target`); development builds keep little debug information, so it stays small.
- `npm run release` is `npm run build` followed by publishing `builds/v<version>/` as the GitHub release (the owner runs it). `npm run build` only builds (after removing all earlier builds); `npm run release:publish` only publishes. Details in DEVELOPMENT.md.
- Builds read the update-signing key from `keys/private.key` automatically (the public half is `keys/public.pub`). The private file is git-ignored; `keys/private.key.example` shows where it goes. Without a key a build still works but has no update files.

---

## Key decisions

| Topic | Decision |
|---|---|
| YouTube backend | The [yt-dlp](https://github.com/yt-dlp/yt-dlp) program, bundled with the app as a Tauri "sidecar" (no API keys, nothing for the user to install). It can update itself when YouTube changes. All downloading runs in the Rust part of the app, one video at a time, independent of the player. |
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
- [~] **2e. Save resources in the background** *(written and type-checked, not yet tried by hand)*: when the window loses focus (you switch to another program) and the video has a separate audio file, the picture pauses and only the audio keeps playing; when you come back the video continues from where the audio is. Setting in Settings (on by default, `player.pauseVideoInBackground`). When a track ends while the window is in the background, the next playlist track starts by itself (the end is read from the real track length, because an audio file's header can claim a longer file than there is; the player reuses one video and one audio element for every track, and starts the next one from the backend, because the system refuses to start brand-new media without a click). Videos without a separate audio file are not affected: their sound lives in the picture.
- [~] **2a. Separate audio sync without timers**: when a video and an audio file are played separately, they are aligned only when you play, pause, seek, rewind/forward or loop (audio starts first, video follows; the start offset is measured and remembered). When the window is hidden or you switch to another app, the audio keeps playing and the video rejoins it when you come back. No `setInterval`, `setTimeout` or `requestAnimationFrame` anywhere in the UI: everything runs from media events such as `timeupdate`. *(measured drift after each start/seek: about 0.00-0.08 s on the Silent Hill pair; needs your ears to confirm)*
- [~] **2b. Real duration for files with wrong headers**: fragmented MP4s whose headers claim a doubled length (13:49:50 instead of 6:54:55) now show and end at the real length, read from the file's segment index.
- [~] **2c. Merge video + audio into one MP4 (pure Rust, no re-encoding)**: File → Merge Video + Audio… (if a video + separate audio pair is already open, it merges that pair; otherwise it asks for both files). Asks where to save, shows a progress window (percent, size, speed, time left, Cancel), then plays the merged file. Originals are never touched. Works with fragmented (DASH) and regular MP4/M4A. *(verified on your 1.25 GB pair: 2 tracks, 6:54:55, macOS reports 0 errors, plays in the app; the buttons and dialog have not been clicked by a human yet)*
- [~] **2d. Volume**: mute/unmute button and a volume slider in the control bar; both are remembered between runs. With a separate audio file the volume applies to the audio, otherwise to the video. *(verified: values reach the right element and survive a restart; needs your ears)*
- [~] **3. Layout** *(written and type/compile-checked, not yet tried by hand)*: sidebar exactly 320px (plus the 64px playlist badge column), video takes the rest; both 100vh. The whole playlist panel slides in and out from the edge it sits on (left or right, remembered), with a tab on the video edge and a View menu item.

### Opening files
- [x] **4. "Open with" support and drag and drop** *("Open with" only works in an installed build)*: the app is registered for video and audio files (mp4, m4v, mov, mkv, webm, avi, wmv, flv, mpg/mpeg, ts, 3gp, ogv, m4a, mp3, aac, flac, wav, ogg, opus) so it appears in the right-click "Open with" list in Finder, Windows Explorer and Ubuntu Files. Opening a file while the app runs plays it in the existing window (macOS: open event; Windows/Linux: a second launch is forwarded to the running copy). Dropping files on the window opens the Add videos dialog (see task 6). Unsupported codecs show a clear message.

### Playlists
- [~] **5. Playlist model + JSON** *(written and type/compile-checked, not yet tried by hand)*: title, color, cover, tracks (video path, optional audio path, thumbnail, source). Save, load, import and export as `.json`; autosaved.
- [~] **5a. Reorder tracks** *(written and type/compile-checked, not yet tried by hand)*: drag and drop plus move up/down, and a **⇅** button in the playlist header that reverses the whole order (for playlists that come in reverse).
- [~] **5b. Looping, two independent switches** *(written and type/compile-checked, not yet tried by hand)*:
  - *Video loop*: repeats the current video forever, in or out of a playlist.
  - *Playlist loop*: after the last video, starts again from the first. Off = stops at the end.
- [~] **5c. Playlists menu (second side panel)** *(written and type/compile-checked, not yet tried by hand)*: compact circular badges with initials ("Best movies collection" → **BMC**), custom color per playlist, default color from settings, tooltip with full name.
- [~] **5d. Playlist manager** *(written and type/compile-checked, not yet tried by hand)* (settings button in that panel): add, rename, recolor, reorder playlists, and delete a playlist (its previews go with it; ticking a box in the confirmation also moves its video and audio files to the Trash; running downloads of it are cancelled).
- [~] **5e. Remove tracks** *(written and type/compile-checked, not yet tried by hand)*: remove from the playlist only, or remove and delete the video and audio files (moved to the system Trash, with a confirmation listing the files).

### Adding videos
- [~] **6. Drag and drop** *(written and type/compile-checked, not yet tried by hand)*: drop videos and audio onto the window; they appear as a list you tick and add to the playlist.
- [~] **7. "Add videos" dialog** *(written and type/compile-checked, not yet tried by hand; the YouTube section comes with the YouTube work)*:
  - big drag-and-drop area in the center,
  - dropdown: **Video only** (default) or **Video + separate audio**,
  - optional YouTube section: paste a video / playlist / channel link, or type a search.
- [~] **8. Thumbnails** *(written and type/compile-checked, not yet tried by hand)*: first frame by default for each video and playlist; optionally choose your own preview (a frame or an image file).

### Look and settings
- [~] **9. Themes** *(written and type/compile-checked, not yet tried by hand)*: built-in themes: **Dark** and **Light** (the normal window), and fifteen floating designs: **Studio**, **Studio dark**, **Espresso**, **Latte**, **Midnight**, **Glass**, **Glass blur** (see-through window, heavily blurred control bar and playlist), **Detroit** (blue sci-fi interface: square navy panels with a thin double-line border, white corner brackets on the selected entry, upper-case spaced text, and a light that travels around the border of every button; it comes from the theme's **Frame style** setting), **RPG style** (fantasy game look: carved wood frames with gold scroll-work corners, parchment panels, gold and brown gradient buttons, capitals in a serif face; Frame style "RPG"), **Rose gold** (graphite with a glowing gradient progress bar), and five squared retro ones: **Cyberpunk**, **Fallout 2**, **Townfall CRT**, **Green console** and **Cream keys** (terminal font, glowing text, scanlines, bordered panels). A floating design has no title bar and no window buttons: the window is transparent and rounded with a shadow, the control bar and the playlist float over the video (drag the top edge or the control bar to move the window; File also has Minimize and Close Window). On Windows and Linux a floating design without the system title bar gets its own menu bar at the top (File, View, Download manager, Window, Help, plus minimize, maximize and close buttons) that hides in full screen; macOS keeps its menu at the top of the screen. In the Themes dialog, **Window** sets the window style (regular or floating) and, for floating ones: system title bar on/off, resizable, window corner radius, window shadow, window opacity, panel corner radius, panel opacity, panel blur (frosted glass), panel border and glow, text glow, scanlines (on the panels only, never over the video), terminal font, progress glow and gloss, and the distance of the control bar and of the playlist from the edges. Changing anything on a built-in theme makes your own copy; every theme, with its window layout, exports and imports as a `.json` file (the layout is described by `schemas/theme.schema.json`). By default the theme follows the system setting (and switches live when the system changes) until you choose one; the choice is saved in the general settings. View → Themes… opens the theme popup: create a new theme based on dark or light, change the color of every element (35 color tokens in 7 groups, each with an opacity slider: every color can be transparent), pick any icon for each of 20 interface slots from the built-in set or the IcoMoon pack (131 icons), rename, delete, and export/import a theme as a `.json` file (checked against its JSON Schema on import). Built-in themes are read-only; "Create a theme from this one" copies them. The player's position and volume sliders and the download bars use the **Progress track**, **Progress bar** and **Progress bar gradient end** colors (a theme that sets only the bar color gets a flat bar), with optional glow and gloss (Themes → Progress bar). Buttons without a face (playlist rows, menus, control bar) use the panel's text color so they stay readable on any theme.
- [~] **10. Native menu** *(partly built)*: done: the menu bar is File, View, Window, Help (no Edit menu; on macOS the copy/paste items sit in the app menu so the shortcuts keep working). File: (Open Video, Open Video + Separate Audio, Merge Video + Audio, Close Window), Edit, View (fullscreen), Window, Help → Check for Updates, and the macOS app menu. Also done: File has Minimize and Close Window (for the floating, title-bar-less windows), Add Videos, Import/Export Playlist, View → Show/Hide Playlist Panel (Cmd/Ctrl+B) and Playlist Panel on the Left/Right. Still to do: theme, language, settings.
- [~] **11. Languages** *(JSON standard: schemas/locale.schema.json; written and type/compile-checked, not yet tried by hand)*: every language is a file in `src/locales/` (`en.json` is the base, `he.json` is a Hebrew example with right-to-left text). Adding a language means adding a file; missing texts fall back to English. English is the default and the choice is remembered. Chosen in Settings (app menu on macOS, File elsewhere) or View → Language. Each file also holds the default side of the playlist panel (Hebrew: right); changing the language resets the panel to that default, and a side you pick by hand stays until the language changes. The native menu is translated from the same files. **Ukrainian** (`uk.json`) is built in. **Translation files:** Settings → Export this language… saves the current language as `<code>.json` (every text, English for the ones the language lacks, ready to translate); Settings → Import a language… reads such a file (the file name is the language code, for example `fr.json`; checked before it is accepted), saves it in the app data folder and selects it. An imported file adds a new language or replaces a built-in one, and can be removed again in Settings. Imported languages appear in Settings and in the custom menu bar; the native menu list only shows the built-in ones.
- [~] **12. Settings** *(partly done)*: done: Settings dialog (language, playlist panel side), the Themes popup (colors, icon mapping from the IcoMoon pack), general settings file with a JSON Schema. Also done: Settings → YouTube downloads (default mode, video and audio quality, folder, pause between videos, speed limit, continue after restart, browser sign-in, update/restore the downloader, reset). Still to do: default playlist color.

### YouTube (optional feature)
*All of it is written, compiles and its logic is unit-tested (progress parsing, failure classification, queue order, saving, a fake yt-dlp that loses its connection). It has not been tried with the real yt-dlp or by hand yet.*
- [~] **13. YouTube helper**: search, video info, and the list of available formats (video + audio together, video only, audio only; quality, codec, size). One box takes a link or a search text. A search lists matching playlists first (as one box each: tick it to download all its videos), then channels and videos; nothing is ticked by default (except a single pasted video).
- [~] **13a. Playlists and channels**: every video of a playlist or of a channel's Videos tab (all pages). Opening a channel (click its box in the results, or paste its link) shows its videos as boxes, with a top bar to switch between **Videos** and **Playlists**, a search field for that channel's videos and playlists, and pages of 24 (Previous / Next) so not everything loads at once; ticks are kept across pages, and "Download all as a new playlist…" still takes the whole list.
- [~] **14. YouTube in the Add dialog**: the "YouTube" tab: search or paste a link, tick videos, **Download…**. A quality dialog always opens first (download as video + audio / separate files / audio only, video and audio quality, playlist, folder); it starts with your saved defaults (Settings → YouTube downloads) selected.
- [~] **14a. One-click playlist/channel download**: "Download all as a new playlist…" creates a playlist titled like the YouTube one; its videos appear greyed at once and become playable as each download finishes. A failed video does not stop the rest.
- [~] **15. Download manager and progress popup**: the **Download Manager** menu → Open Download Manager… (Cmd/Ctrl+J; the menu also has Add from YouTube, Pause All and Resume All). **Queue**: drag to change priority, move to top, **download now**, pause/resume, cancel (optionally deleting partial files). **History**: retry, play, remove. A small popup in the corner shows progress (video and audio separately, speed, time left, "next download in N s"). Videos download **one at a time**, with a pause between them (default 3 s, Settings).
- [~] **15a. Failures and reconnecting**: a lost connection or a rate limit is waited out and the same partial file continues when YouTube is reachable again (also after closing and reopening the app); "sign in to confirm you're not a bot" and age-restricted videos ask for a browser sign-in (Settings) instead of failing; an out-of-date downloader updates itself once and retries; private/removed videos fail on their own; a full disk holds the queue.

### Release
- [ ] **16. Polish**: error handling, shortcut help, check "Open with" on each OS.
- [~] **17. Builds for all platforms** *(all six builds were produced and signed locally at v0.1.1 and published; the Windows and Linux installers have not been tried on real machines; the macOS app is ad-hoc signed only, with no Apple notarization)*: `npm run build:mac*`, `npm run docker:*`, `npm run release` (macOS arm64 + x64, Windows x64 + arm64, Linux x64 + arm64; `.dmg`, `.exe` installer, `.deb`, `.rpm`, `.AppImage`; no 32-bit). Manual and local, no CI. The macOS builds carry `src-tauri/macos-entitlements.plist` so the signed app may run the bundled yt-dlp (it unpacks its own Python at run time); the window is created transparent (macOS private API) for the floating themes.
- [~] **18. Auto-update from GitHub Releases** *(code, signing and published releases exist; the update check said "up to date" while a newer release was live, so it is not confirmed to work yet)*: signed updates, check on startup and from the menu, progress and "install and restart".

---

## Known risks

- **YouTube changes often.** The downloader may need library updates over time; we validate it early with a real video.
- **Video codecs.** The built-in web engine on each OS decides what plays. H.264/AAC works everywhere; MKV/AVI and VP9/AV1 may not on some systems. Linux needs GStreamer codec packages.
- **Unsigned builds.** Without Apple/Microsoft code-signing certificates, macOS and Windows show a security warning on first launch.
- **Updater key.** The update-signing private key must be backed up; if it is lost, installed apps can no longer update.
- **Auto-update on Linux** works for AppImage only; `.deb`/`.rpm` users install new versions manually.

## Credits and license

- Licensed under GPL-3.0 (see [LICENSE](LICENSE)).
- YouTube search and downloads use [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense). Downloading is for personal use; YouTube's terms restrict downloading, and that responsibility is the user's.
- Player icons from your IcoMoon selection; app icon in `assets/`.

---

## Version history

What each released version delivered. The first versions were not written down while they were made, so for v0.1.2 to v0.1.4 only what is known is listed.

- **v0.1.0:** the first working app. Player for video with an optional separate audio file, playlists, drag and drop, the Add dialog, thumbnails, themes, the native menu, English and Hebrew, settings saved to files.
- **v0.1.1:** the first signed build for all six platforms, published on GitHub, with the automatic update check. No YouTube features yet.
- **v0.1.2:** a new release to test the automatic update from v0.1.1 (the check said "up to date" while v0.1.2 was already published).
- **v0.1.3:** release tooling: after publishing, older releases can be removed so only the newest stays.
- **v0.1.4:** a further release step on the same road (no new app feature is recorded for it).
- **v0.1.5:** YouTube search and downloads with the bundled yt-dlp, the download queue and manager with progress popup, and the Settings → YouTube downloads page. The Windows installers were rebuilt because the first v0.1.5 files carried an old v0.1.1 installer.
- **v0.1.6:** every build goes into one folder `builds/v<version>/`; `npm run build` builds all six platforms from scratch; `npm run release` publishes from there; no installers are left in `src-tauri/target`. Fix for yt-dlp being refused on signed macOS builds (entitlements), and clearer update handling on Windows.
- **v0.1.7:** YouTube search listing playlists, channels and videos; channel view with Videos and Playlists tabs, channel search and paging; a button that reverses a playlist; floating transparent themes (twelve designs, window settings, progress bar glow and gloss) with their own menu bar on Windows and Linux; Minimize and Close Window in File; the next track now starts by itself when the window is in the background, even when an audio file's header claims a longer length than it has; faster, smaller development builds.
- **v0.1.8 (current):** the **Glass blur**, **Detroit** and **RPG style** themes (with a new Frame style setting, shown in Themes → Window); Ukrainian language; export and import of translations as `.json` files (Settings → Translation files); fix for playlists that stopped at the end of a track while the window was in the background (the real end of the track is now detected from the audio, and the next track is started reliably); scanlines (Cyberpunk, Fallout 2, Townfall CRT, Green console) are drawn only on the panels and the control bar, no longer over the video picture; RPG style fixes (readable parchment panels, the play button has the same corners as the other buttons).
