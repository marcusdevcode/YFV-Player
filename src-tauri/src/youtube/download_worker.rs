//! Runs yt-dlp for one file of a download and reports what it prints.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;

use super::download_format_rules::{part_suffix, PartKind};
use super::download_progress_parser::{parse_line, FinishedFile, OutputLine, Progress};
use super::ytdlp_binary::stop_process;

/// Why a running download was stopped from outside.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Interrupt {
    None = 0,
    /// The user paused it (the partial file is kept).
    Pause = 1,
    /// The user cancelled it.
    Cancel = 2,
    /// Another video was started "now": this one goes back to the queue.
    Preempt = 3,
    /// The program is closing.
    Shutdown = 4,
}

/// The handle other threads use to stop the yt-dlp process that is running.
#[derive(Default)]
pub struct RunControl {
    pid: Mutex<Option<u32>>,
    interrupt: AtomicU8,
}

impl RunControl {
    pub fn interrupt(&self, why: Interrupt) {
        self.interrupt.store(why as u8, Ordering::SeqCst);
        if let Some(pid) = *self.pid.lock().unwrap() {
            stop_process(pid);
        }
    }

    pub fn why(&self) -> Interrupt {
        match self.interrupt.load(Ordering::SeqCst) {
            1 => Interrupt::Pause,
            2 => Interrupt::Cancel,
            3 => Interrupt::Preempt,
            4 => Interrupt::Shutdown,
            _ => Interrupt::None,
        }
    }
}

pub struct PartSpec {
    pub url: String,
    pub folder: String,
    /// File name without extension, made by `safe_base_name`.
    pub base_name: String,
    pub part: PartKind,
    /// `-f` / `-S` options from download_format_rules.
    pub format_args: Vec<String>,
    /// KiB per second, 0 = unlimited.
    pub speed_limit_kbps: u64,
    pub cookies_browser: String,
}

#[derive(Debug)]
pub enum PartResult {
    Finished(FinishedFile),
    Interrupted(Interrupt),
    /// yt-dlp failed; the text is its error output.
    Failed(String),
}

/// "Title [id]" with characters that no file system allows removed, and `%` doubled because
/// yt-dlp reads the name as a template.
pub fn safe_base_name(title: &str, video_id: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c })
        .collect();
    let short: String = cleaned.trim().chars().take(120).collect();
    format!("{} [{}]", short.trim_end_matches(['.', ' ']), video_id).replace('%', "%%")
}

/// The file name prefix of a part (the extension follows), used to find partial files.
pub fn part_file_prefix(base_name: &str, part: PartKind) -> String {
    format!("{}{}.", base_name.replace("%%", "%"), part_suffix(part))
}

pub fn run_part(
    mut command: Command,
    spec: &PartSpec,
    control: &RunControl,
    on_progress: &mut dyn FnMut(Progress),
) -> PartResult {
    let template = format!("{}/{}{}.%(ext)s", spec.folder.trim_end_matches(['/', '\\']), spec.base_name, part_suffix(spec.part));
    command
        .args(["--no-playlist", "--newline", "--no-colors", "--continue", "--windows-filenames", "--no-mtime"])
        .args(["--retries", "5", "--fragment-retries", "5", "--retry-sleep", "2", "--socket-timeout", "20"])
        .arg("--progress-template")
        .arg("download:@@P|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s")
        .arg("--print")
        .arg("after_move:@@F|%(filepath)s|%(height)s|%(abr)s")
        .arg("--no-quiet")
        .args(&spec.format_args)
        .arg("-o")
        .arg(&template);
    if spec.speed_limit_kbps > 0 {
        command.arg("--limit-rate").arg(format!("{}K", spec.speed_limit_kbps));
    }
    if !spec.cookies_browser.is_empty() && spec.cookies_browser != "none" {
        command.arg("--cookies-from-browser").arg(&spec.cookies_browser);
    }
    command.arg("--").arg(&spec.url);

    let mut child = match command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(child) => child,
        Err(e) => return PartResult::Failed(format!("ERROR: cannot start yt-dlp: {e}")),
    };
    *control.pid.lock().unwrap() = Some(child.id());
    // A stop that arrived before the process existed.
    if control.why() != Interrupt::None {
        stop_process(child.id());
    }

    let stderr = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut last: Vec<String> = Vec::new();
        if let Some(stderr) = stderr {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                last.push(line);
                if last.len() > 40 {
                    last.remove(0);
                }
            }
        }
        last.join("\n")
    });

    let mut finished: Option<FinishedFile> = None;
    let mut printed_errors = String::new();
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            match parse_line(&line) {
                OutputLine::Progress(p) => on_progress(p),
                OutputLine::Finished(f) => finished = Some(f),
                OutputLine::Other => {
                    if line.contains("ERROR:") {
                        printed_errors.push_str(&line);
                        printed_errors.push('\n');
                    }
                }
            }
        }
    }
    let status = child.wait();
    *control.pid.lock().unwrap() = None;
    let error_text = stderr_reader.join().unwrap_or_default();

    let why = control.why();
    if why != Interrupt::None {
        return PartResult::Interrupted(why);
    }
    match (status, finished) {
        (Ok(s), Some(file)) if s.success() => PartResult::Finished(file),
        (Ok(s), None) if s.success() => PartResult::Failed("ERROR: yt-dlp finished but did not report a file".into()),
        _ => PartResult::Failed(format!("{printed_errors}{error_text}")),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A pretend yt-dlp: a shell script that prints what the real one prints.
    fn fake_program(dir: &std::path::Path, body: &str) -> Command {
        let path = dir.join("fake-yt-dlp.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        Command::new(path)
    }

    fn spec() -> PartSpec {
        PartSpec {
            url: "https://www.youtube.com/watch?v=abc".into(),
            folder: "/tmp".into(),
            base_name: "Title [abc]".into(),
            part: PartKind::Video,
            format_args: vec!["-f".into(), "bv".into()],
            speed_limit_kbps: 0,
            cookies_browser: String::new(),
        }
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("worker-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_download_reports_progress_and_the_finished_file() {
        let dir = temp_dir("ok");
        let command = fake_program(&dir, "echo '@@P|50|100|NA|10|5'; echo '@@P|100|100|NA|10|0'; echo '@@F|/tmp/Title [abc] (video).mp4|1080|NA'");
        let mut seen = Vec::new();
        let result = run_part(command, &spec(), &RunControl::default(), &mut |p| seen.push(p.downloaded));
        assert_eq!(seen, vec![50, 100]);
        assert!(matches!(result, PartResult::Finished(f) if f.height == Some(1080)));
    }

    #[test]
    fn a_lost_connection_is_reported_with_the_error_text() {
        let dir = temp_dir("net");
        let command = fake_program(&dir, "echo 'ERROR: unable to download video data: timed out' 1>&2; exit 1");
        let result = run_part(command, &spec(), &RunControl::default(), &mut |_| {});
        let PartResult::Failed(text) = result else { panic!("expected a failure") };
        assert_eq!(super::super::download_errors::classify(&text), super::super::download_errors::FailureKind::Network);
    }

    #[test]
    fn a_stop_before_the_start_is_reported_as_interrupted() {
        let dir = temp_dir("stop");
        let command = fake_program(&dir, "sleep 5");
        let control = RunControl::default();
        control.interrupt(Interrupt::Pause);
        let result = run_part(command, &spec(), &control, &mut |_| {});
        assert!(matches!(result, PartResult::Interrupted(Interrupt::Pause)));
    }

    #[test]
    fn names_are_made_safe_for_files_and_templates() {
        assert_eq!(safe_base_name("A/B: C? 100%", "id1"), "A_B_ C_ 100%% [id1]");
        assert_eq!(part_file_prefix("A_B 100%% [id1]", PartKind::Audio), "A_B 100% [id1] (audio).");
    }
}
