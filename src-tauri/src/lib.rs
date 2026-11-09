mod app_data;
mod media_server;
mod mp4;

/// `LANGUAGES`: (code, name) for every file in src/locales, made by build.rs.
mod languages {
    include!(concat!(env!("OUT_DIR"), "/languages.rs"));
}

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{AboutMetadataBuilder, CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
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

/// Tick the menu entry of the language that is selected in the app.
#[tauri::command]
fn menu_set_language(code: String, menu: State<'_, LanguageMenu>) {
    for (item_code, item) in &menu.0 {
        let _ = item.set_checked(*item_code == code);
    }
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
            let open_video = MenuItemBuilder::with_id("open-video", "Open Video…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let open_video_audio = MenuItemBuilder::with_id("open-video-audio", "Open Video + Separate Audio…")
                .accelerator("CmdOrCtrl+Shift+O")
                .build(app)?;
            let add_videos = MenuItemBuilder::with_id("add-videos", "Add Videos to Playlist…")
                .accelerator("CmdOrCtrl+Shift+A")
                .build(app)?;
            let import_playlist = MenuItemBuilder::with_id("import-playlist", "Import Playlist…").build(app)?;
            let export_playlist = MenuItemBuilder::with_id("export-playlist", "Export Playlist…").build(app)?;
            let merge_av_item = MenuItemBuilder::with_id("merge-av", "Merge Video + Audio…").build(app)?;
            let check_updates = MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;

            let settings_item = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            #[allow(unused_mut)]
            let mut file = SubmenuBuilder::new(app, "File")
                .item(&open_video)
                .item(&open_video_audio)
                .item(&add_videos)
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
            let file = file.close_window().build()?;
            let toggle_sidebar = MenuItemBuilder::with_id("toggle-sidebar", "Show/Hide Playlist Panel")
                .accelerator("CmdOrCtrl+B")
                .build(app)?;
            let themes_item = MenuItemBuilder::with_id("themes", "Themes…").accelerator("CmdOrCtrl+Shift+T").build(app)?;
            // View -> Playlist Position -> Left / Right (the page ticks the current one at startup).
            let sidebar_left = CheckMenuItemBuilder::with_id("sidebar-left", "Left").checked(true).build(app)?;
            let sidebar_right = CheckMenuItemBuilder::with_id("sidebar-right", "Right").build(app)?;
            let position_menu = SubmenuBuilder::new(app, "Playlist Position")
                .item(&sidebar_left)
                .item(&sidebar_right)
                .build()?;
            app.manage(SidebarMenu(sidebar_left, sidebar_right));
            // View -> Language: one tick item per file in src/locales (English is ticked until the
            // page reports the saved language).
            let mut language_items = Vec::new();
            let mut language_menu = SubmenuBuilder::new(app, "Language");
            for (code, name) in languages::LANGUAGES {
                let item = CheckMenuItemBuilder::with_id(format!("language:{code}"), *name)
                    .checked(*code == "en")
                    .build(app)?;
                language_menu = language_menu.item(&item);
                language_items.push((code.to_string(), item));
            }
            let language_menu = language_menu.build()?;
            app.manage(LanguageMenu(language_items));

            let view = SubmenuBuilder::new(app, "View")
                .item(&toggle_sidebar)
                .item(&position_menu)
                .item(&language_menu)
                .item(&themes_item)
                .separator()
                .fullscreen()
                .build()?;
            let window = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;

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
            let about_text = format!("About {}", app.package_info().name);

            #[allow(unused_mut)]
            let mut help = SubmenuBuilder::new(app, "Help").item(&check_updates);
            #[cfg(not(target_os = "macos"))]
            {
                help = help.separator().about_with_text(&about_text, Some(about_meta.clone()));
            }
            let help = help.build()?;

            let mut menu = MenuBuilder::new(app);
            #[cfg(target_os = "macos")]
            {
                let app_menu = SubmenuBuilder::new(app, app.package_info().name.clone())
                    .about_with_text(&about_text, Some(about_meta.clone()))
                    .separator()
                    .item(&settings_item)
                    .separator()
                    // There is no Edit menu, but on macOS Cmd+C / Cmd+V / Cmd+Z in text fields only
                    // work through menu items, so the standard ones live here.
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;
                menu = menu.item(&app_menu);
            }
            let menu = menu.item(&file).item(&view).item(&window).item(&help).build()?;
            app.set_menu(menu)?;
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
            app_data::position_note, menu_set_language, menu_set_sidebar_side])
        .build(tauri::generate_context!())
        .expect("error while building the application")
        .run(|app, event| {
            // The program is closing: write the last reported playback position to disk (once).
            if matches!(event, tauri::RunEvent::Exit) {
                app_data::flush_position(app);
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
