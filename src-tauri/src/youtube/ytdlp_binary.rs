//! Finds, starts, stops and updates the yt-dlp program.
//!
//! The program is bundled with the app as a sidecar (a file named `yt-dlp` next to the app's own
//! executable). The bundle cannot be written to, so updating copies it to the app data folder
//! (`tools/`) first and lets that copy update itself. A copy that is at least as new as the bundled
//! file is preferred, so an app update that ships a newer yt-dlp is not hidden by an old copy.

use std::path::PathBuf;
use std::process::{Command, Stdio};

use tauri::AppHandle;

fn file_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}

fn bundled_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(exe.parent().ok_or("no program folder")?.join(file_name()))
}

fn updated_copy_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::app_data::data_dir(app)?.join("tools").join(file_name()))
}

/// The yt-dlp file to run.
pub fn locate(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = bundled_path()?;
    let copy = updated_copy_path(app)?;
    let modified = |p: &PathBuf| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    match (copy.is_file(), bundled.is_file()) {
        (true, true) if modified(&copy) >= modified(&bundled) => Ok(copy),
        (_, true) => Ok(bundled),
        (true, false) => Ok(copy),
        _ => Err("yt-dlp is missing. Reinstall the app, or use Settings -> Downloads -> Restore the downloader.".into()),
    }
}

/// A yt-dlp command that does not read the user's own yt-dlp config, runs at a low priority (so
/// playback stays smooth while downloading) and, on Windows, shows no console window.
pub fn command(app: &AppHandle) -> Result<Command, String> {
    let program = locate(app)?;
    #[cfg(unix)]
    let mut command = {
        let mut c = Command::new("nice");
        c.arg("-n").arg("10").arg(&program);
        c
    };
    #[cfg(windows)]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new(&program);
        // BELOW_NORMAL_PRIORITY_CLASS | CREATE_NO_WINDOW
        c.creation_flags(0x0000_4000 | 0x0800_0000);
        c
    };
    command.arg("--ignore-config").stdin(Stdio::null());
    Ok(command)
}

/// Stop a running yt-dlp and everything it started. The program is a self-extracting bundle that
/// starts a second process, so the whole group is stopped, politely first.
pub fn stop_process(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// The version text of the yt-dlp that would run now.
pub fn version(app: &AppHandle) -> Result<String, String> {
    let output = command(app)?.arg("--version").output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Update yt-dlp to the newest release (in the app data copy) and return the new version.
pub fn update(app: &AppHandle) -> Result<String, String> {
    let bundled = bundled_path()?;
    let copy = updated_copy_path(app)?;
    if !copy.is_file() {
        if !bundled.is_file() {
            return Err("yt-dlp is missing".into());
        }
        std::fs::create_dir_all(copy.parent().ok_or("no tools folder")?).map_err(|e| e.to_string())?;
        std::fs::copy(&bundled, &copy).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&copy, std::fs::Permissions::from_mode(0o755));
        }
    }
    let output = Command::new(&copy)
        .arg("--ignore-config")
        .arg("-U")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    version(app)
}

/// Throw away the updated copy so the bundled yt-dlp is used again.
pub fn restore_bundled(app: &AppHandle) -> Result<(), String> {
    let copy = updated_copy_path(app)?;
    if copy.is_file() {
        std::fs::remove_file(copy).map_err(|e| e.to_string())?;
    }
    Ok(())
}
