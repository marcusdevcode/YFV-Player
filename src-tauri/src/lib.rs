mod media_server;
mod mp4;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, State};

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

/// A media file passed on the command line (or via APP_OPEN), if any.
#[tauri::command]
fn launch_path() -> Option<String> {
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
    tauri::Builder::default()
        .manage(server)
        .manage(MergeState::default())
        .setup(|app| {
            let open_video = MenuItemBuilder::with_id("open-video", "Open Video…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let open_video_audio = MenuItemBuilder::with_id("open-video-audio", "Open Video + Separate Audio…")
                .accelerator("CmdOrCtrl+Shift+O")
                .build(app)?;
            let merge_av_item = MenuItemBuilder::with_id("merge-av", "Merge Video + Audio…").build(app)?;
            let check_updates = MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;

            let file = SubmenuBuilder::new(app, "File")
                .item(&open_video)
                .item(&open_video_audio)
                .separator()
                .item(&merge_av_item)
                .separator()
                .close_window()
                .build()?;
            let edit = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let view = SubmenuBuilder::new(app, "View").fullscreen().build()?;
            let window = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;

            // "About": icon, name, version, description and copyright, all from package.json
            // (injected into the Tauri config by scripts/tauri.mjs).
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
            let menu = menu.item(&file).item(&edit).item(&view).item(&window).item(&help).build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            // Forward our own menu items to the frontend; predefined items handle themselves.
            let id = event.id().as_ref();
            if matches!(id, "open-video" | "open-video-audio" | "merge-av" | "check-updates") {
                let _ = app.emit("menu", id);
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![media_url, media_duration, merge_av, merge_cancel, launch_path, launch_audio])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
