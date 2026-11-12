mod app_data;
mod youtube;
mod media_server;
mod mp4;

mod native_menu_texts;
use native_menu_texts::{menu_text, MenuTexts, LANGUAGES};

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{AboutMetadataBuilder, CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State};

use mp4::mux::Phase;

/// Register a local media file and get back a streamable http://127.0.0.1 URL.
#[tauri::command]
fn media_url(path: String, server: State<'_, media_server::MediaServer>) -> Result<String, String> {
    server.register(&PathBuf::from(path))
}

/// The real duration (seconds) of a fragmented MP4 whose header may be wrong; None if unknown.
#[tauri::command]
async fn media_duration(path: String) -> Option<f64> {
    mp4::sidx_duration(&PathBuf::from(path))
}

#[derive(Default)]
struct MergeState {
    running: AtomicBool,
    cancel: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
struct MergeProgress {
    phase: &'static str,
    done: u64,
    total: u64,
    /// Bytes per second, averaged over about a second.
    speed: f64,
}

/// Merge a video file and an audio file into one new MP4 (no re-encoding). Emits `merge-progress`.
#[tauri::command]
async fn merge_av(
    app: AppHandle,
    state: State<'_, MergeState>,
    video_path: String,
    audio_path: String,
    output_path: String,
) -> Result<String, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A merge is already running".into());
    }
    state.cancel.store(false, Ordering::SeqCst);
    let cancel = state.cancel.clone();
    let out = output_path.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let (mut win_start, mut win_bytes, mut speed) = (Instant::now(), 0u64, 0f64);
        mp4::mux::merge(
            &PathBuf::from(video_path),
            &PathBuf::from(audio_path),
            &PathBuf::from(out),
            &cancel,
            &mut |phase, done, total| {
                // Throttle to ~10 events per second, but always send phase changes and the end.
                let edge = phase != Phase::Writing || done >= total;
                if !edge && last_emit.elapsed() < Duration::from_millis(100) {
                    return;
                }
                last_emit = Instant::now();
                let dt = win_start.elapsed().as_secs_f64();
                if dt >= 1.0 {
                    speed = done.saturating_sub(win_bytes) as f64 / dt;
                    win_start = Instant::now();
                    win_bytes = done;
                }
                let phase = match phase {
                    Phase::Reading => "reading",
                    Phase::Writing => "writing",
                    Phase::Finishing => "finishing",
                };
                let _ = app.emit("merge-progress", MergeProgress { phase, done, total, speed });
            },
        )
    })
    .await
    .map_err(|e| e.to_string());

    state.running.store(false, Ordering::SeqCst);
    result??;
    Ok(output_path)
}

#[tauri::command]
fn merge_cancel(state: State<'_, MergeState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

/// Files handed to the app from outside ("Open with", a second launch) while the page may not be
/// loaded yet. Once the page asked for the launch file (`ready`), new ones are sent as events.
/// The checkable items of the View -> Language menu, so the page can tick the current language.
struct LanguageMenu(Vec<(String, CheckMenuItem<tauri::Wry>)>);

/// The two tick items of View -> Playlist Position: (left, right).
struct SidebarMenu(CheckMenuItem<tauri::Wry>, CheckMenuItem<tauri::Wry>);

/// Tick "Left" or "Right" to match where the playlist panel is.
#[tauri::command]
fn menu_set_sidebar_side(side: String, menu: State<'_, SidebarMenu>) {
    let _ = menu.0.set_checked(side == "left");
    let _ = menu.1.set_checked(side == "right");
}

/// Let the page start media by itself (the next track of a playlist). The system web view refuses that for
/// media nobody started by hand (NotAllowedError), but accepts it from a script that native code runs.
#[tauri::command]
fn playback_allow_start(window: tauri::WebviewWindow) {
    let _ = window.eval("window.__startPlayback && window.__startPlayback()");
}

/// Show or hide the native menu bar of the window. The floating themes without a system title bar have their own
/// menu bar in the page, so the native one is hidden there. (macOS has one menu for the whole screen: nothing to hide.)
#[tauri::command]
fn menu_set_visible(app: AppHandle, visible: bool) {
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window("main") {
        let _ = if visible { window.show_menu() } else { window.hide_menu() };
    }
    #[cfg(target_os = "macos")]
    let _ = (app, visible);
}

/// Tick the menu entry of the language that is selected in the app.
#[tauri::command]
fn menu_set_language(app: AppHandle, code: String, menu: State<'_, LanguageMenu>, texts: State<'_, MenuTexts>) {
    for (item_code, item) in &menu.0 {
        let _ = item.set_checked(*item_code == code);
    }
    // The menu bar itself is translated too.
    texts.apply(&code, &app.package_info().name);
}

#[derive(Default)]
struct OpenState {
    ready: AtomicBool,
    pending: Mutex<Option<String>>,
}

/// A media file was opened from outside: tell the page (or keep it until the page is ready) and
/// bring the window to the front.
fn deliver_open(app: &AppHandle, path: String) {
    let state = app.state::<OpenState>();
    if state.ready.load(Ordering::SeqCst) {
        let _ = app.emit("open-file", &path);
    } else {
        *state.pending.lock().unwrap() = Some(path);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// A media file passed on the command line (or via APP_OPEN), or opened before the page was ready.
#[tauri::command]
fn launch_path(state: State<'_, OpenState>) -> Option<String> {
    state.ready.store(true, Ordering::SeqCst);
    if let Some(path) = state.pending.lock().unwrap().take() {
        return Some(path);
    }
    std::env::var("APP_OPEN")
        .ok()
        .into_iter()
        .chain(std::env::args().skip(1))
        .find(|a| PathBuf::from(a).is_file())
}

/// Audio file to pair with the launch video (APP_OPEN_AUDIO, for testing).
#[tauri::command]
fn launch_audio() -> Option<String> {
    std::env::var("APP_OPEN_AUDIO").ok().filter(|a| PathBuf::from(a).is_file())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let server = media_server::start().expect("failed to start local media server");
    let builder = tauri::Builder::default();
    // A second launch (Windows/Linux "Open with" while the app runs) is handed to the running
    // window instead of starting another copy. It must be the first plugin.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        if let Some(path) = args.into_iter().skip(1).find(|a| PathBuf::from(a).is_file()) {
            deliver_open(app, path);
        }
    }));
    builder
        .manage(server)
        .manage(MergeState::default())
        .manage(OpenState::default())
        .manage(app_data::PositionNote::default())
        .setup(|app| {
            let name = app.package_info().name.clone();
            let texts = MenuTexts::default();
            // A text in English now; the page switches the bar to the saved language at startup
            // (menu_set_language). `tx` makes the text and remembers how to change it later.
            macro_rules! tx {
                ($key:expr, $item:expr) => {{
                    let item = $item.clone();
                    texts.add($key, Box::new(move |s: &str| { let _ = item.set_text(s); }));
                }};
            }
            let en = |key: &str| menu_text("en", key, &name);
            let predefined = |item: tauri::Result<PredefinedMenuItem<tauri::Wry>>, key: &str| -> tauri::Result<PredefinedMenuItem<tauri::Wry>> {
                let item = item?;
                texts.add(key, { let i = item.clone(); Box::new(move |s: &str| { let _ = i.set_text(s); }) });
                Ok(item)
            };

            let open_video = MenuItemBuilder::with_id("open-video", en("openVideo")).accelerator("CmdOrCtrl+O").build(app)?;
            let open_video_audio = MenuItemBuilder::with_id("open-video-audio", en("openVideoAudio"))
                .accelerator("CmdOrCtrl+Shift+O")
                .build(app)?;
            let add_videos = MenuItemBuilder::with_id("add-videos", en("addVideos"))
                .accelerator("CmdOrCtrl+Shift+A")
                .build(app)?;
            let add_youtube = MenuItemBuilder::with_id("add-youtube", en("addFromYoutube")).build(app)?;
            let add_youtube_again = MenuItemBuilder::with_id("add-youtube", en("addFromYoutube")).build(app)?;
            let import_playlist = MenuItemBuilder::with_id("import-playlist", en("importPlaylist")).build(app)?;
            let export_playlist = MenuItemBuilder::with_id("export-playlist", en("exportPlaylist")).build(app)?;
            let merge_av_item = MenuItemBuilder::with_id("merge-av", en("mergeAv")).build(app)?;
            let check_updates = MenuItemBuilder::with_id("check-updates", en("checkUpdates")).build(app)?;
            let settings_item = MenuItemBuilder::with_id("settings", en("settings")).accelerator("CmdOrCtrl+,").build(app)?;
            tx!("openVideo", open_video);
            tx!("openVideoAudio", open_video_audio);
            tx!("addVideos", add_videos);
            tx!("addFromYoutube", add_youtube);
            tx!("addFromYoutube", add_youtube_again);
            tx!("importPlaylist", import_playlist);
            tx!("exportPlaylist", export_playlist);
            tx!("mergeAv", merge_av_item);
            tx!("checkUpdates", check_updates);
            tx!("settings", settings_item);

            #[allow(unused_mut)]
            let mut file = SubmenuBuilder::new(app, en("file"))
                .item(&open_video)
                .item(&open_video_audio)
                .item(&add_videos)
                .item(&add_youtube)
                .separator()
                .item(&import_playlist)
                .item(&export_playlist)
                .separator()
                .item(&merge_av_item)
                .separator();
            // On macOS Settings is in the app menu; elsewhere it is in File.
            #[cfg(not(target_os = "macos"))]
            {
                file = file.item(&settings_item).separator();
            }
            // Minimize and Close are also here, for the frameless experimental window styles (no title bar buttons).
            let file = file
                .item(&predefined(PredefinedMenuItem::minimize(app, Some(&en("minimize"))), "minimize")?)
                .item(&predefined(PredefinedMenuItem::close_window(app, Some(&en("closeWindow"))), "closeWindow")?)
                .build()?;
            tx!("file", file);

            let toggle_sidebar = MenuItemBuilder::with_id("toggle-sidebar", en("togglePanel"))
                .accelerator("CmdOrCtrl+B")
                .build(app)?;
            let themes_item = MenuItemBuilder::with_id("themes", en("themes")).accelerator("CmdOrCtrl+Shift+T").build(app)?;
            tx!("togglePanel", toggle_sidebar);
            tx!("themes", themes_item);
            // View -> Playlist Position -> Left / Right (the page ticks the current one at startup).
            let sidebar_left = CheckMenuItemBuilder::with_id("sidebar-left", en("left")).checked(true).build(app)?;
            let sidebar_right = CheckMenuItemBuilder::with_id("sidebar-right", en("right")).build(app)?;
            tx!("left", sidebar_left);
            tx!("right", sidebar_right);
            let position_menu = SubmenuBuilder::new(app, en("playlistPosition"))
                .item(&sidebar_left)
                .item(&sidebar_right)
                .build()?;
            tx!("playlistPosition", position_menu);
            app.manage(SidebarMenu(sidebar_left, sidebar_right));
            // View -> Language: one tick item per file in src/locales (English is ticked until the
            // page reports the saved language). Language names stay in their own language.
            let mut language_items = Vec::new();
            let mut language_menu = SubmenuBuilder::new(app, en("language"));
            for (code, language_name) in LANGUAGES {
                let item = CheckMenuItemBuilder::with_id(format!("language:{code}"), *language_name)
                    .checked(*code == "en")
                    .build(app)?;
                language_menu = language_menu.item(&item);
                language_items.push((code.to_string(), item));
            }
            let language_menu = language_menu.build()?;
            tx!("language", language_menu);
            app.manage(LanguageMenu(language_items));

            let view = SubmenuBuilder::new(app, en("view"))
                .item(&toggle_sidebar)
                .item(&position_menu)
                .item(&language_menu)
                .item(&themes_item)
                .separator()
                .item(&predefined(PredefinedMenuItem::fullscreen(app, Some(&en("fullscreen"))), "fullscreen")?)
                .build()?;
            tx!("view", view);
            // The top-level "Download Manager" menu.
            let downloads_item = MenuItemBuilder::with_id("downloads", en("openDownloadManager")).accelerator("CmdOrCtrl+J").build(app)?;
            let pause_downloads = MenuItemBuilder::with_id("pause-all-downloads", en("pauseAllDownloads")).build(app)?;
            let resume_downloads = MenuItemBuilder::with_id("resume-all-downloads", en("resumeAllDownloads")).build(app)?;
            tx!("openDownloadManager", downloads_item);
            tx!("pauseAllDownloads", pause_downloads);
            tx!("resumeAllDownloads", resume_downloads);
            let download_menu = SubmenuBuilder::new(app, en("downloadManager"))
                .item(&downloads_item)
                .item(&add_youtube_again)
                .separator()
                .item(&pause_downloads)
                .item(&resume_downloads)
                .build()?;
            tx!("downloadManager", download_menu);
            let window = SubmenuBuilder::new(app, en("window"))
                .item(&predefined(PredefinedMenuItem::minimize(app, Some(&en("minimize"))), "minimize")?)
                .item(&predefined(PredefinedMenuItem::maximize(app, Some(&en("maximize"))), "maximize")?)
                .build()?;
            tx!("window", window);

            // "About": icon, name, version, description and copyright, all from package.json
            // (injected into the Tauri config by scripts/run-tauri.mjs).
            let about_meta = {
                let pkg = app.package_info();
                let bundle = &app.config().bundle;
                AboutMetadataBuilder::new()
                    .name(Some(pkg.name.clone()))
                    .version(Some(pkg.version.to_string()))
                    .short_version(Some(pkg.version.to_string()))
                    .copyright(bundle.copyright.clone())
                    .comments(bundle.short_description.clone()) // Linux
                    .credits(bundle.short_description.clone()) // macOS shows this under the version
                    .icon(Image::from_bytes(include_bytes!("../icons/128x128@2x.png")).ok())
                    .build()
            };

            // The menu entry reads "About <name>".
            #[allow(unused_variables)]
            let about_item = predefined(PredefinedMenuItem::about(app, Some(&en("about")), Some(about_meta.clone())), "about")?;

            #[allow(unused_mut)]
            let mut help = SubmenuBuilder::new(app, en("help")).item(&check_updates);
            #[cfg(not(target_os = "macos"))]
            {
                help = help.separator().item(&about_item);
            }
            let help = help.build()?;
            tx!("help", help);

            let mut menu = MenuBuilder::new(app);
            #[cfg(target_os = "macos")]
            {
                let app_menu = SubmenuBuilder::new(app, name.clone())
                    .item(&about_item)
                    .separator()
                    .item(&settings_item)
                    .separator()
                    // There is no Edit menu, but on macOS Cmd+C / Cmd+V / Cmd+Z in text fields only
                    // work through menu items, so the standard ones live here.
                    .item(&predefined(PredefinedMenuItem::undo(app, Some(&en("undo"))), "undo")?)
                    .item(&predefined(PredefinedMenuItem::redo(app, Some(&en("redo"))), "redo")?)
                    .separator()
                    .item(&predefined(PredefinedMenuItem::cut(app, Some(&en("cut"))), "cut")?)
                    .item(&predefined(PredefinedMenuItem::copy(app, Some(&en("copy"))), "copy")?)
                    .item(&predefined(PredefinedMenuItem::paste(app, Some(&en("paste"))), "paste")?)
                    .item(&predefined(PredefinedMenuItem::select_all(app, Some(&en("selectAll"))), "selectAll")?)
                    .separator()
                    .item(&predefined(PredefinedMenuItem::services(app, Some(&en("services"))), "services")?)
                    .separator()
                    .item(&predefined(PredefinedMenuItem::hide(app, Some(&en("hide"))), "hide")?)
                    .item(&predefined(PredefinedMenuItem::hide_others(app, Some(&en("hideOthers"))), "hideOthers")?)
                    .item(&predefined(PredefinedMenuItem::show_all(app, Some(&en("showAll"))), "showAll")?)
                    .separator()
                    .item(&predefined(PredefinedMenuItem::quit(app, Some(&en("quit"))), "quit")?)
                    .build()?;
                menu = menu.item(&app_menu);
            }
            let menu = menu.item(&file).item(&view).item(&download_menu).item(&window).item(&help).build()?;
            app.set_menu(menu)?;
            app.manage(texts);
            app.manage(youtube::download_queue::DownloadEngine::start(app.handle().clone()));
            Ok(())
        })
        .on_menu_event(|app, event| {
            // Forward our own menu items to the frontend; predefined items handle themselves.
            let id = event.id().as_ref();
            if id.starts_with("language:") || matches!(
                id,
                "open-video"
                    | "open-video-audio"
                    | "merge-av"
                    | "check-updates"
                    | "add-videos"
                    | "add-youtube"
                    | "downloads"
                    | "pause-all-downloads"
                    | "resume-all-downloads"
                    | "import-playlist"
                    | "export-playlist"
                    | "toggle-sidebar"
                    | "settings"
                    | "themes"
                    | "sidebar-left"
                    | "sidebar-right"
            ) {
                let _ = app.emit("menu", id);
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![media_url, media_duration, merge_av, merge_cancel, launch_path, launch_audio,
            app_data::library_load, app_data::library_save, app_data::thumbnail_save, app_data::thumbnail_import,
            app_data::thumbnail_delete, app_data::trash_files, app_data::text_file_read, app_data::text_file_write,
            app_data::settings_get, app_data::settings_set, app_data::settings_remove, app_data::theme_list, app_data::theme_save, app_data::theme_delete,
            app_data::position_note, menu_set_language, menu_set_sidebar_side, menu_set_visible, playback_allow_start,
            youtube::youtube_commands::youtube_lookup, youtube::youtube_commands::downloads_configure,
            youtube::youtube_commands::downloads_snapshot, youtube::youtube_commands::downloads_enqueue,
            youtube::youtube_commands::downloads_move, youtube::youtube_commands::downloads_download_now,
            youtube::youtube_commands::downloads_pause, youtube::youtube_commands::downloads_resume,
            youtube::youtube_commands::downloads_pause_all, youtube::youtube_commands::downloads_resume_all,
            youtube::youtube_commands::downloads_cancel, youtube::youtube_commands::downloads_retry,
            youtube::youtube_commands::downloads_forget, youtube::youtube_commands::ytdlp_version,
            youtube::youtube_commands::ytdlp_update, youtube::youtube_commands::ytdlp_restore])
        .build(tauri::generate_context!())
        .expect("error while building the application")
        .run(|app, event| {
            // The program is closing: write the last reported playback position to disk (once).
            if matches!(event, tauri::RunEvent::Exit) {
                app_data::flush_position(app);
                if let Some(engine) = app.try_state::<youtube::download_queue::DownloadEngine>() {
                    engine.shutdown();
                }
            }
            // macOS delivers "Open with" and double-clicked files as an event, not as arguments.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &event {
                let file = urls.iter().filter_map(|u| u.to_file_path().ok()).find(|p| p.is_file());
                if let Some(path) = file {
                    deliver_open(app, path.to_string_lossy().into_owned());
                }
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            let _ = (app, event);
        });
}
