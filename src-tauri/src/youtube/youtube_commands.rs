//! The commands the page calls for YouTube search and downloads.

use tauri::{AppHandle, State};

use super::download_queue::{DownloadEngine, EngineConfig, NewDownload, Snapshot};
use super::ytdlp_binary;
use super::ytdlp_lookup::{self, LookupResult};

/// Search, or look up a video / playlist / channel link.
#[tauri::command]
pub async fn youtube_lookup(
    app: AppHandle,
    engine: State<'_, DownloadEngine>,
    input: String,
    count: Option<u32>,
    offset: Option<u32>,
) -> Result<LookupResult, String> {
    let cookies = engine.read(|s| s.config.cookies_browser.clone());
    tauri::async_runtime::spawn_blocking(move || ytdlp_lookup::lookup(&app, &input, count.unwrap_or(30), offset.unwrap_or(0), Some(&cookies)))
        .await
        .map_err(|e| e.to_string())?
}

/// The settings that the download engine needs; sent at startup and when they change.
#[tauri::command]
pub fn downloads_configure(engine: State<'_, DownloadEngine>, config: EngineConfig) {
    engine.configure(config);
}

#[tauri::command]
pub fn downloads_snapshot(engine: State<'_, DownloadEngine>) -> Snapshot {
    engine.read(|s| s.snapshot())
}

#[tauri::command]
pub fn downloads_enqueue(engine: State<'_, DownloadEngine>, downloads: Vec<NewDownload>) -> Vec<String> {
    engine.update(|s| s.enqueue(downloads))
}

#[tauri::command]
pub fn downloads_move(engine: State<'_, DownloadEngine>, id: String, to: usize) {
    engine.update(|s| s.move_job(&id, to));
}

#[tauri::command]
pub fn downloads_download_now(engine: State<'_, DownloadEngine>, id: String) {
    engine.update(|s| s.download_now(&id));
}

#[tauri::command]
pub fn downloads_pause(engine: State<'_, DownloadEngine>, id: String) {
    engine.update(|s| s.pause(&id));
}

#[tauri::command]
pub fn downloads_resume(engine: State<'_, DownloadEngine>, id: String) {
    engine.update(|s| s.resume(&id));
}

#[tauri::command]
pub fn downloads_pause_all(engine: State<'_, DownloadEngine>) {
    engine.update(|s| s.pause_all());
}

#[tauri::command]
pub fn downloads_resume_all(engine: State<'_, DownloadEngine>) {
    engine.update(|s| s.resume_all());
}

#[tauri::command]
pub fn downloads_cancel(engine: State<'_, DownloadEngine>, id: String, delete_partial: bool) {
    let leftovers = engine.update(|s| s.cancel(&id, delete_partial));
    engine.delete_partial(leftovers);
}

#[tauri::command]
pub fn downloads_retry(engine: State<'_, DownloadEngine>, id: String) {
    engine.update(|s| s.retry(&id));
}

/// Remove one entry from the history, or all of them when `id` is empty.
#[tauri::command]
pub fn downloads_forget(engine: State<'_, DownloadEngine>, id: String) {
    engine.update(|s| {
        if id.is_empty() {
            s.history.clear();
        } else {
            s.history.retain(|j| j.id != id);
        }
    });
}

/// The version of the downloader that is in use.
#[tauri::command]
pub async fn ytdlp_version(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ytdlp_binary::version(&app)).await.map_err(|e| e.to_string())?
}

/// Update the downloader to the newest release; returns the new version.
#[tauri::command]
pub async fn ytdlp_update(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ytdlp_binary::update(&app)).await.map_err(|e| e.to_string())?
}

/// Go back to the downloader that came with the app.
#[tauri::command]
pub fn ytdlp_restore(app: AppHandle) -> Result<(), String> {
    ytdlp_binary::restore_bundled(&app)
}
