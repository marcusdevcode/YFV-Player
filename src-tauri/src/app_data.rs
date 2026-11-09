//! Storage for playlists and thumbnails, plus moving removed files to the system Trash.
//!
//! The page owns the data and sends the whole library as one JSON text; this module only stores
//! it. Writes go to a temporary file first and are then renamed, so a crash cannot leave a
//! half-written library behind.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

const LIBRARY_FILE: &str = "library.json";
const THUMBNAIL_DIR: &str = "thumbnails";
const IMAGE_EXTENSIONS: [&str; 5] = ["jpg", "jpeg", "png", "webp", "gif"];

pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create the data folder: {e}"))?;
    Ok(dir)
}

fn thumbnail_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join(THUMBNAIL_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create the thumbnail folder: {e}"))?;
    Ok(dir)
}

/// Write `bytes` to `path` through a temporary sibling file and a rename.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("Cannot replace {}: {e}", path.display()))
}

/// Keep only characters that are safe in a file name.
pub fn safe_name(id: &str) -> Result<String, String> {
    let clean: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    if clean.is_empty() || clean.len() > 80 {
        Err("Invalid thumbnail id".into())
    } else {
        Ok(clean)
    }
}

fn settings_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("settings");
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create the settings folder: {e}"))?;
    Ok(dir.join(format!("{}.json", safe_name(name)?)))
}

/// A remembered setting (panel open/closed, last video, ...) as saved text, or None if not saved.
/// These are files in the app data folder, written at once, instead of the web view's local
/// storage, which is only flushed to disk after a delay and can lose the last change on quit.
#[tauri::command]
pub fn settings_get(app: AppHandle, name: String) -> Result<Option<String>, String> {
    match fs::read_to_string(settings_file(&app, &name)?) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Cannot read the setting: {e}")),
    }
}

#[tauri::command]
pub fn settings_set(app: AppHandle, name: String, value: String) -> Result<(), String> {
    write_atomic(&settings_file(&app, &name)?, value.as_bytes())
}

#[tauri::command]
pub fn settings_remove(app: AppHandle, name: String) -> Result<(), String> {
    let path = settings_file(&app, &name)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn themes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("themes");
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create the themes folder: {e}"))?;
    Ok(dir)
}

/// The text of every saved custom theme (themes/<id>.json); the page validates them.
#[tauri::command]
pub fn theme_list(app: AppHandle) -> Result<Vec<String>, String> {
    let mut texts = Vec::new();
    for entry in fs::read_dir(themes_dir(&app)?).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Ok(text) = fs::read_to_string(&path) {
                texts.push(text);
            }
        }
    }
    Ok(texts)
}

#[tauri::command]
pub fn theme_save(app: AppHandle, id: String, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("Not valid JSON: {e}"))?;
    write_atomic(&themes_dir(&app)?.join(format!("{}.json", safe_name(&id)?)), json.as_bytes())
}

#[tauri::command]
pub fn theme_delete(app: AppHandle, id: String) -> Result<(), String> {
    let path = themes_dir(&app)?.join(format!("{}.json", safe_name(&id)?));
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The newest playback position the page reported: (settings file name, video path, seconds).
/// It lives in memory only. It is written to the positions file when the program exits, so the
/// position does not have to be saved to disk while a video plays.
#[derive(Default)]
pub struct PositionNote(Mutex<Option<(String, String, f64)>>);

/// Remember where the video is now (memory only, no file is written).
#[tauri::command]
pub fn position_note(note: State<'_, PositionNote>, name: String, path: String, seconds: f64) {
    if let Ok(mut slot) = note.0.lock() {
        *slot = Some((name, path, seconds));
    }
}

const KEEP_POSITIONS: usize = 300;

/// The positions file text (zustand persist format) with `path` set to `seconds`. The entry moves to
/// the end (newest last) and only the newest 300 are kept, like the page does.
fn merge_position(text: Option<&str>, path: &str, seconds: f64) -> Result<String, String> {
    let mut doc: serde_json::Value = match text {
        Some(t) => serde_json::from_str(t).map_err(|e| format!("The positions file is not valid JSON: {e}"))?,
        None => serde_json::json!({ "state": { "positions": {} }, "version": 0 }),
    };
    let positions = doc
        .get_mut("state")
        .and_then(|s| s.as_object_mut())
        .ok_or("The positions file has no state")?
        .entry("positions")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("The positions are not an object")?;
    positions.shift_remove(path);
    positions.insert(path.to_string(), serde_json::json!(seconds));
    while positions.len() > KEEP_POSITIONS {
        let Some(oldest) = positions.keys().next().cloned() else { break };
        positions.shift_remove(&oldest);
    }
    serde_json::to_string(&doc).map_err(|e| e.to_string())
}

/// Write the remembered position to the positions file. Called once, when the program exits.
pub fn flush_position(app: &AppHandle) {
    let Some(note) = app.try_state::<PositionNote>() else { return };
    let taken = note.0.lock().ok().and_then(|mut slot| slot.take());
    let Some((name, path, seconds)) = taken else { return };
    if !seconds.is_finite() {
        return;
    }
    if let Ok(file) = settings_file(app, &name) {
        let current = fs::read_to_string(&file).ok();
        if let Ok(text) = merge_position(current.as_deref(), &path, seconds) {
            let _ = write_atomic(&file, text.as_bytes());
        }
    }
}

/// The saved library as JSON text, or None when nothing was saved yet.
#[tauri::command]
pub fn library_load(app: AppHandle) -> Result<Option<String>, String> {
    let path = data_dir(&app)?.join(LIBRARY_FILE);
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Cannot read the library: {e}")),
    }
}

#[tauri::command]
pub fn library_save(app: AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("Not valid JSON: {e}"))?;
    write_atomic(&data_dir(&app)?.join(LIBRARY_FILE), json.as_bytes())
}

/// Save a captured frame (JPEG bytes) as the thumbnail `<id>.jpg`; returns its path.
#[tauri::command]
pub fn thumbnail_save(app: AppHandle, id: String, bytes: Vec<u8>) -> Result<String, String> {
    let path = thumbnail_dir(&app)?.join(format!("{}.jpg", safe_name(&id)?));
    write_atomic(&path, &bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Copy a user-chosen image file in as the thumbnail `<id>.<ext>`; returns its path.
#[tauri::command]
pub fn thumbnail_import(app: AppHandle, id: String, source: String) -> Result<String, String> {
    let source = PathBuf::from(source);
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| IMAGE_EXTENSIONS.contains(&e.as_str()))
        .ok_or("Choose a jpg, png, webp or gif image")?;
    let path = thumbnail_dir(&app)?.join(format!("{}.{}", safe_name(&id)?, ext));
    fs::copy(&source, &path).map_err(|e| format!("Cannot copy the image: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Read a text file the user chose (import). Limited to 20 MB.
#[tauri::command]
pub fn text_file_read(path: String) -> Result<String, String> {
    let meta = fs::metadata(&path).map_err(|e| format!("Cannot open the file: {e}"))?;
    if meta.len() > 20 * 1024 * 1024 {
        return Err("The file is too large".into());
    }
    fs::read_to_string(&path).map_err(|e| format!("Cannot read the file: {e}"))
}

/// Write a text file at a location the user chose in a save dialog (export).
#[tauri::command]
pub fn text_file_write(path: String, text: String) -> Result<(), String> {
    write_atomic(Path::new(&path), text.as_bytes())
}

/// Delete a thumbnail file. Only files inside the thumbnail folder can be deleted.
#[tauri::command]
pub fn thumbnail_delete(app: AppHandle, path: String) -> Result<(), String> {
    let dir = thumbnail_dir(&app)?;
    let path = PathBuf::from(path);
    if path.parent() == Some(dir.as_path()) && path.is_file() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Move files to the system Trash (not a permanent delete). Missing files are skipped.
#[tauri::command]
pub fn trash_files(paths: Vec<String>) -> Result<(), String> {
    let existing: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).filter(|p| p.exists()).collect();
    if existing.is_empty() {
        return Ok(());
    }
    trash::delete_all(existing).map_err(|e| format!("Could not move the files to the Trash: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_round_trip_and_replace() {
        let dir = std::env::temp_dir().join(format!("library-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("library.json");
        write_atomic(&file, b"{\"a\":1}").unwrap();
        write_atomic(&file, b"{\"a\":2}").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"a\":2}");
        assert!(!file.with_extension("tmp").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn merge_position_updates_moves_last_and_keeps_the_rest() {
        let before = r#"{"state":{"positions":{"/b.mp4":5.0,"/a.mp4":10.0,"/c.mp4":7.5}},"version":0}"#;
        let after: serde_json::Value = serde_json::from_str(&merge_position(Some(before), "/b.mp4", 42.0).unwrap()).unwrap();
        let keys: Vec<&String> = after["state"]["positions"].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["/a.mp4", "/c.mp4", "/b.mp4"]); // updated one is now last, the order of the others is kept
        assert_eq!(after["state"]["positions"]["/b.mp4"], 42.0);
        assert_eq!(after["state"]["positions"]["/a.mp4"], 10.0);
        assert_eq!(after["version"], 0);
    }

    #[test]
    fn merge_position_creates_the_file_and_prunes_the_oldest() {
        let created: serde_json::Value = serde_json::from_str(&merge_position(None, "/a.mp4", 1.0).unwrap()).unwrap();
        assert_eq!(created["state"]["positions"]["/a.mp4"], 1.0);

        let mut text = merge_position(None, "/0.mp4", 0.0).unwrap();
        for i in 1..=KEEP_POSITIONS {
            text = merge_position(Some(&text), &format!("/{i}.mp4"), i as f64).unwrap();
        }
        let doc: serde_json::Value = serde_json::from_str(&text).unwrap();
        let positions = doc["state"]["positions"].as_object().unwrap();
        assert_eq!(positions.len(), KEEP_POSITIONS);
        assert!(!positions.contains_key("/0.mp4")); // the oldest was dropped
        assert!(positions.contains_key(&format!("/{KEEP_POSITIONS}.mp4")));
    }

    #[test]
    fn safe_name_strips_path_tricks() {
        assert_eq!(safe_name("../a b/c-1_d").unwrap(), "abc-1_d");
        assert!(safe_name("../../").is_err());
        assert!(safe_name("").is_err());
    }
}
