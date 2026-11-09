//! The download queue: order (= priority), one video at a time, a pause between videos,
//! waiting for the connection, and saving the queue so it survives a restart.
//!
//! All of it runs in Rust on one worker thread. The page only sends commands and receives events:
//!   `download-queue`     the whole queue and history after every change of state
//!   `download-progress`  bytes / speed / time left of the running file (a few times a second)
//!   `download-delay`     seconds left of the pause before the next video
//!   `download-alert`     something the user must know (sign-in needed, disk full)
//!   `download-finished`  one video is complete (the page puts its files into the playlist)

use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::download_errors::{backoff_seconds, classify, FailureKind};
use super::download_format_rules::{format_args, ChosenFormats, DownloadMode, PartKind};
use super::download_progress_parser::Progress;
use super::download_worker::{part_file_prefix, run_part, safe_base_name, Interrupt, PartResult, PartSpec, RunControl};
use super::ytdlp_binary;

const QUEUE_FILE: &str = "downloads/queue.json";
const HISTORY_FILE: &str = "downloads/history.json";
const HISTORY_LIMIT: usize = 500;
/// After this many failed attempts with a working connection, a network error counts as a failure.
const MAX_ATTEMPTS_WITH_CONNECTION: u32 = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Queued,
    Downloading,
    /// Waiting for the connection (or a rate limit) to come back; continues by itself.
    Waiting,
    NeedsSignIn,
    Paused,
    Done,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PartState {
    pub kind: PartKind,
    pub path: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub speed: Option<f64>,
    pub eta: Option<u64>,
    pub done: bool,
}

/// What the page sends to add a video to the queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewDownload {
    pub video_id: String,
    pub url: String,
    pub title: String,
    pub thumbnail: String,
    pub duration: Option<f64>,
    pub channel: Option<String>,
    pub mode: DownloadMode,
    pub video_quality: String,
    pub audio_quality: String,
    #[serde(default)]
    pub formats: ChosenFormats,
    pub folder: String,
    /// The app playlist and track this download fills in when it is complete.
    pub playlist_id: Option<String>,
    pub track_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadJob {
    pub id: String,
    #[serde(flatten)]
    pub request: NewDownload,
    pub status: JobStatus,
    pub message: Option<String>,
    pub parts: Vec<PartState>,
    /// The picture height that was really downloaded.
    pub got_height: Option<u32>,
    pub added_at: u64,
    pub finished_at: Option<u64>,
    #[serde(skip)]
    pub attempt: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EngineConfig {
    /// Seconds to wait between two videos.
    pub delay_seconds: u64,
    /// KiB per second, 0 = unlimited.
    pub speed_limit_kbps: u64,
    /// Browser to take the YouTube sign-in from ("" = none).
    pub cookies_browser: String,
    /// Start the downloads that were unfinished when the program was closed.
    pub auto_resume: bool,
}

impl Default for EngineConfig {
    fn default() -> Self {
        EngineConfig { delay_seconds: 3, speed_limit_kbps: 0, cookies_browser: String::new(), auto_resume: true }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub queue: Vec<DownloadJob>,
    pub history: Vec<DownloadJob>,
    /// Nothing starts until "resume all" (after a disk problem, or before the settings arrived).
    pub hold_all: bool,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn new_job(request: NewDownload, serial: u64) -> DownloadJob {
    let parts = request
        .mode
        .parts()
        .iter()
        .map(|kind| PartState { kind: *kind, path: None, downloaded: 0, total: None, speed: None, eta: None, done: false })
        .collect();
    DownloadJob {
        id: format!("dl-{}-{}", now_ms(), serial),
        request,
        status: JobStatus::Queued,
        message: None,
        parts,
        got_height: None,
        added_at: now_ms(),
        finished_at: None,
        attempt: 0,
    }
}

/// Everything the worker and the commands share. Pure data: no program is started from here, so
/// the ordering rules can be tested.
pub struct State {
    pub queue: Vec<DownloadJob>,
    pub history: Vec<DownloadJob>,
    pub config: EngineConfig,
    pub hold_all: bool,
    /// The page has sent its settings at least once.
    pub configured: bool,
    running: Option<(String, Arc<RunControl>)>,
    skip_delay: bool,
    delay_until: Option<Instant>,
    /// Extra seconds between videos after YouTube asked to slow down (this session only).
    extra_delay: u64,
    updated_ytdlp: bool,
    shutting_down: bool,
    delete_partial_on_cancel: bool,
    serial: u64,
    folder: Option<PathBuf>,
}

impl State {
    pub fn new(folder: Option<PathBuf>) -> State {
        State {
            queue: Vec::new(),
            history: Vec::new(),
            config: EngineConfig::default(),
            hold_all: true, // until the page has sent the settings
            configured: false,
            running: None,
            skip_delay: false,
            delay_until: None,
            extra_delay: 0,
            updated_ytdlp: false,
            shutting_down: false,
            delete_partial_on_cancel: false,
            serial: 0,
            folder,
        }
    }

    fn index_of(&self, id: &str) -> Option<usize> {
        self.queue.iter().position(|j| j.id == id)
    }

    pub fn enqueue(&mut self, requests: Vec<NewDownload>) -> Vec<String> {
        requests
            .into_iter()
            .map(|r| {
                self.serial += 1;
                let job = new_job(r, self.serial);
                let id = job.id.clone();
                self.queue.push(job);
                id
            })
            .collect()
    }

    /// Put a job at a place in the queue (0 = next).
    pub fn move_job(&mut self, id: &str, to: usize) {
        if let Some(from) = self.index_of(id) {
            let job = self.queue.remove(from);
            self.queue.insert(to.min(self.queue.len()), job);
        }
    }

    /// Start this video now: it goes first, the pause is skipped, and the running one waits behind it.
    pub fn download_now(&mut self, id: &str) {
        let Some(from) = self.index_of(id) else { return };
        if matches!(self.queue[from].status, JobStatus::Done | JobStatus::Failed | JobStatus::Cancelled) {
            return;
        }
        let running_id = self.running.as_ref().map(|(rid, _)| rid.clone());
        self.move_job(id, 0);
        self.queue[0].status = JobStatus::Queued;
        self.queue[0].message = None;
        self.queue[0].attempt = 0;
        if let Some(rid) = running_id.filter(|r| r != id) {
            // The running video goes right behind the new one.
            self.move_job(&rid, 1);
            if let Some((_, control)) = &self.running {
                control.interrupt(Interrupt::Preempt);
            }
        } else if let Some(waiting) = self.queue.iter_mut().skip(1).find(|j| j.status == JobStatus::Waiting) {
            waiting.status = JobStatus::Queued; // stop waiting for the connection; the new one goes first
        }
        self.skip_delay = true;
        self.hold_all = false;
    }

    pub fn pause(&mut self, id: &str) {
        let running = self.running.as_ref().filter(|(rid, _)| rid == id).map(|(_, c)| c.clone());
        if let Some(job) = self.queue.iter_mut().find(|j| j.id == id) {
            if matches!(job.status, JobStatus::Queued | JobStatus::Downloading | JobStatus::Waiting | JobStatus::NeedsSignIn) {
                job.status = JobStatus::Paused;
                job.message = None;
            }
        }
        if let Some(control) = running {
            control.interrupt(Interrupt::Pause);
        }
    }

    pub fn resume(&mut self, id: &str) {
        if let Some(job) = self.queue.iter_mut().find(|j| j.id == id) {
            if matches!(job.status, JobStatus::Paused | JobStatus::NeedsSignIn) {
                job.status = JobStatus::Queued;
                job.message = None;
                job.attempt = 0;
            }
        }
    }

    pub fn pause_all(&mut self) {
        self.hold_all = true;
        // A video that is waiting for the connection stops waiting; it continues on "resume all".
        for job in self.queue.iter_mut().filter(|j| j.status == JobStatus::Waiting) {
            job.status = JobStatus::Queued;
            job.message = None;
        }
        if let Some((_, control)) = &self.running {
            control.interrupt(Interrupt::Preempt); // back to the queue, to continue on "resume all"
        }
    }

    pub fn resume_all(&mut self) {
        self.hold_all = false;
        for job in self.queue.iter_mut().filter(|j| j.status == JobStatus::Paused) {
            job.status = JobStatus::Queued;
        }
    }

    /// Cancel a job. Returns the files to delete when asked to remove the partial files.
    pub fn cancel(&mut self, id: &str, delete_partial: bool) -> Vec<(PathBuf, String)> {
        let running = self.running.as_ref().filter(|(rid, _)| rid == id).map(|(_, c)| c.clone());
        if let Some(control) = running {
            self.delete_partial_on_cancel = delete_partial;
            if let Some(job) = self.queue.iter_mut().find(|j| j.id == id) {
                job.status = JobStatus::Cancelled;
            }
            control.interrupt(Interrupt::Cancel); // the worker moves it to the history
            return Vec::new();
        }
        let Some(index) = self.index_of(id) else { return Vec::new() };
        let mut job = self.queue.remove(index);
        job.status = JobStatus::Cancelled;
        job.finished_at = Some(now_ms());
        let leftovers = if delete_partial { partial_file_prefixes(&job) } else { Vec::new() };
        self.add_to_history(job);
        leftovers
    }

    /// Put a failed or cancelled video back at the end of the queue.
    pub fn retry(&mut self, id: &str) {
        if let Some(index) = self.history.iter().position(|j| j.id == id) {
            let mut job = self.history.remove(index);
            if matches!(job.status, JobStatus::Failed | JobStatus::Cancelled) {
                job.status = JobStatus::Queued;
                job.message = None;
                job.attempt = 0;
                job.finished_at = None;
                self.queue.push(job);
            } else {
                self.history.insert(index, job);
            }
        } else {
            self.resume(id);
        }
    }

    pub fn add_to_history(&mut self, job: DownloadJob) {
        self.history.insert(0, job);
        self.history.truncate(HISTORY_LIMIT);
    }

    fn next_queued(&self) -> Option<usize> {
        if self.hold_all {
            return None;
        }
        self.queue.iter().position(|j| j.status == JobStatus::Queued)
    }

    /// Jobs that were unfinished when the program was closed start again (or stay paused).
    pub fn after_restart(&mut self) {
        let auto = self.config.auto_resume;
        for job in &mut self.queue {
            if matches!(job.status, JobStatus::Downloading | JobStatus::Waiting) {
                job.status = if auto { JobStatus::Queued } else { JobStatus::Paused };
            }
            if !auto && job.status == JobStatus::Queued {
                job.status = JobStatus::Paused;
            }
            job.attempt = 0;
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot { queue: self.queue.clone(), history: self.history.clone(), hold_all: self.hold_all }
    }

    pub fn save(&self) {
        let Some(folder) = &self.folder else { return };
        let write = |file: &str, jobs: &Vec<DownloadJob>| {
            if let Ok(text) = serde_json::to_string_pretty(&serde_json::json!({ "version": 1, "jobs": jobs })) {
                let path = folder.join(file);
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = crate::app_data::write_atomic(&path, text.as_bytes());
            }
        };
        write(QUEUE_FILE, &self.queue);
        write(HISTORY_FILE, &self.history);
    }

    pub fn load(&mut self) {
        let Some(folder) = &self.folder else { return };
        let read = |file: &str| -> Vec<DownloadJob> {
            std::fs::read_to_string(folder.join(file))
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .and_then(|v| serde_json::from_value(v.get("jobs")?.clone()).ok())
                .unwrap_or_default()
        };
        self.queue = read(QUEUE_FILE);
        self.history = read(HISTORY_FILE);
    }
}

/// The folder and file-name prefix of every part of a job, to find its partial files.
fn partial_file_prefixes(job: &DownloadJob) -> Vec<(PathBuf, String)> {
    let base = safe_base_name(&job.request.title, &job.request.video_id);
    job.request
        .mode
        .parts()
        .iter()
        .map(|part| (PathBuf::from(&job.request.folder), part_file_prefix(&base, *part)))
        .collect()
}

/// Delete the partial files (`<name>.f137.mp4.part` and similar) of the given prefixes, never a
/// finished download.
fn delete_partial_files(prefixes: &[(PathBuf, String)]) {
    for (folder, prefix) in prefixes {
        let Ok(entries) = std::fs::read_dir(folder) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(prefix.as_str()) && (name.ends_with(".part") || name.ends_with(".ytdl") || name.contains(".part-")) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Can we reach YouTube at all? (A short TCP connection, no download.)
pub fn connection_works() -> bool {
    ["www.youtube.com:443", "i.ytimg.com:443"].iter().any(|host| {
        host.to_socket_addrs()
            .ok()
            .and_then(|mut addrs| addrs.next())
            .map(|addr| TcpStream::connect_timeout(&addr, Duration::from_secs(5)).is_ok())
            .unwrap_or(false)
    })
}

pub struct Shared {
    app: AppHandle,
    state: Mutex<State>,
    wake: Condvar,
}

#[derive(Clone)]
pub struct DownloadEngine {
    shared: Arc<Shared>,
}

enum Outcome {
    Done,
    Interrupted(Interrupt),
    Failed(FailureKind),
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    id: String,
    part: usize,
    downloaded: u64,
    total: Option<u64>,
    speed: Option<f64>,
    eta: Option<u64>,
}

impl DownloadEngine {
    pub fn start(app: AppHandle) -> DownloadEngine {
        let folder = crate::app_data::data_dir(&app).ok();
        let mut state = State::new(folder);
        state.load();
        let shared = Arc::new(Shared { app, state: Mutex::new(state), wake: Condvar::new() });
        let worker = shared.clone();
        std::thread::Builder::new()
            .name("download-queue".into())
            .spawn(move || worker_loop(worker))
            .expect("cannot start the download thread");
        DownloadEngine { shared }
    }

    /// Run `change` on the state, then save, tell the page and wake the worker.
    pub fn update<R>(&self, change: impl FnOnce(&mut State) -> R) -> R {
        let mut state = self.shared.state.lock().unwrap();
        let result = change(&mut state);
        self.shared.publish(&state);
        self.shared.wake.notify_all();
        result
    }

    pub fn read<R>(&self, read: impl FnOnce(&State) -> R) -> R {
        read(&self.shared.state.lock().unwrap())
    }

    /// The page sent its settings (also the first sign that the page is ready).
    pub fn configure(&self, config: EngineConfig) {
        self.update(|state| {
            state.config = config;
            // The first time: unfinished downloads of the last run start again (or stay paused).
            if !state.configured {
                state.configured = true;
                state.after_restart();
                state.hold_all = false;
            }
        });
    }

    pub fn delete_partial(&self, prefixes: Vec<(PathBuf, String)>) {
        delete_partial_files(&prefixes);
    }

    /// The program is closing: stop the running download, keep its partial file and the queue.
    pub fn shutdown(&self) {
        let mut state = self.shared.state.lock().unwrap();
        state.shutting_down = true;
        if let Some((_, control)) = &state.running {
            control.interrupt(Interrupt::Shutdown);
        }
        for job in &mut state.queue {
            if matches!(job.status, JobStatus::Downloading | JobStatus::Waiting) {
                job.status = JobStatus::Queued;
            }
        }
        state.save();
        self.shared.wake.notify_all();
    }
}

impl Shared {
    fn publish(&self, state: &State) {
        state.save();
        let _ = self.app.emit("download-queue", state.snapshot());
    }
}

fn wait_step<'a>(shared: &'a Shared, guard: MutexGuard<'a, State>, max: Duration) -> MutexGuard<'a, State> {
    shared.wake.wait_timeout(guard, max.min(Duration::from_secs(1))).unwrap().0
}

fn worker_loop(shared: Arc<Shared>) {
    let mut state = shared.state.lock().unwrap();
    loop {
        if state.shutting_down {
            return;
        }
        let Some(index) = state.next_queued() else {
            state = shared.wake.wait(state).unwrap();
            continue;
        };

        // The pause between two videos (skipped by "download now").
        if !state.skip_delay {
            if let Some(until) = state.delay_until {
                let now = Instant::now();
                if now < until {
                    let left = until - now;
                    let _ = shared.app.emit("download-delay", left.as_secs() + 1);
                    state = wait_step(&shared, state, left);
                    continue;
                }
            }
        }
        state.delay_until = None;
        state.skip_delay = false;
        let _ = shared.app.emit("download-delay", 0u64);

        let control = Arc::new(RunControl::default());
        state.queue[index].status = JobStatus::Downloading;
        state.queue[index].message = None;
        let job = state.queue[index].clone();
        state.running = Some((job.id.clone(), control.clone()));
        shared.publish(&state);
        let config = state.config.clone();
        drop(state);

        let outcome = run_job(&shared, &job, &control, &config);
        // An unknown error while YouTube cannot be reached is a lost connection.
        let outcome = match outcome {
            Outcome::Failed(FailureKind::Other(_)) if !connection_works() => Outcome::Failed(FailureKind::Network),
            other => other,
        };

        state = shared.state.lock().unwrap();
        state.running = None;
        state = handle_outcome(&shared, state, &job.id, outcome);
        shared.publish(&state);
    }
}

fn run_job(shared: &Arc<Shared>, job: &DownloadJob, control: &Arc<RunControl>, config: &EngineConfig) -> Outcome {
    let base = safe_base_name(&job.request.title, &job.request.video_id);
    for (index, part) in job.request.mode.parts().iter().enumerate() {
        if job.parts.get(index).map(|p| p.done).unwrap_or(false) {
            continue;
        }
        if control.why() != Interrupt::None {
            return Outcome::Interrupted(control.why());
        }
        let command = match ytdlp_binary::command(&shared.app) {
            Ok(c) => c,
            Err(e) => return Outcome::Failed(FailureKind::Other(e)),
        };
        let spec = PartSpec {
            url: job.request.url.clone(),
            folder: job.request.folder.clone(),
            base_name: base.clone(),
            part: *part,
            format_args: format_args(*part, &job.request.video_quality, &job.request.audio_quality, &job.request.formats),
            speed_limit_kbps: config.speed_limit_kbps,
            cookies_browser: config.cookies_browser.clone(),
        };
        let mut last_event = Instant::now() - Duration::from_secs(1);
        let id = job.id.clone();
        let app = shared.app.clone();
        let mut on_progress = |p: Progress| {
            // A few updates a second are plenty to look at.
            if last_event.elapsed() < Duration::from_millis(250) {
                return;
            }
            last_event = Instant::now();
            let _ = app.emit(
                "download-progress",
                ProgressEvent { id: id.clone(), part: index, downloaded: p.downloaded, total: p.total, speed: p.speed, eta: p.eta },
            );
        };
        match run_part(command, &spec, control, &mut on_progress) {
            PartResult::Finished(file) => {
                let mut state = shared.state.lock().unwrap();
                if let Some(stored) = state.queue.iter_mut().find(|j| j.id == job.id) {
                    if let Some(p) = stored.parts.get_mut(index) {
                        p.done = true;
                        p.path = Some(file.path.clone());
                        p.speed = None;
                        p.eta = None;
                        if let Some(total) = p.total {
                            p.downloaded = total;
                        }
                    }
                    if file.height.is_some() {
                        stored.got_height = file.height;
                    }
                }
                shared.publish(&state); // a finished part survives a restart
            }
            PartResult::Interrupted(why) => return Outcome::Interrupted(why),
            PartResult::Failed(text) => return Outcome::Failed(classify(&text)),
        }
    }
    Outcome::Done
}

fn set_status(state: &mut State, id: &str, status: JobStatus, message: Option<String>) {
    if let Some(job) = state.queue.iter_mut().find(|j| j.id == id) {
        job.status = status;
        job.message = message;
    }
}

fn handle_outcome<'a>(
    shared: &'a Arc<Shared>,
    mut state: MutexGuard<'a, State>,
    id: &str,
    outcome: Outcome,
) -> MutexGuard<'a, State> {
    match outcome {
        Outcome::Done => {
            if let Some(index) = state.index_of(id) {
                let mut job = state.queue.remove(index);
                job.status = JobStatus::Done;
                job.message = None;
                job.finished_at = Some(now_ms());
                let _ = shared.app.emit("download-finished", &job);
                state.add_to_history(job);
            }
            let wait = state.config.delay_seconds + state.extra_delay;
            if wait > 0 {
                state.delay_until = Some(Instant::now() + Duration::from_secs(wait));
            }
        }
        Outcome::Interrupted(why) => match why {
            Interrupt::Cancel => {
                if let Some(index) = state.index_of(id) {
                    let mut job = state.queue.remove(index);
                    job.status = JobStatus::Cancelled;
                    job.finished_at = Some(now_ms());
                    if state.delete_partial_on_cancel {
                        delete_partial_files(&partial_file_prefixes(&job));
                    }
                    state.add_to_history(job);
                }
            }
            Interrupt::Preempt => set_status(&mut state, id, JobStatus::Queued, None),
            // Pause already set the status; shutdown keeps it queued.
            Interrupt::Pause | Interrupt::Shutdown | Interrupt::None => {
                if state.shutting_down {
                    set_status(&mut state, id, JobStatus::Queued, None);
                }
            }
        },
        Outcome::Failed(kind) => {
            match kind {
                FailureKind::Network | FailureKind::RateLimited => {
                    state = wait_for_connection(shared, state, id, kind);
                }
                FailureKind::NeedsSignIn => {
                    let message = "Sign in to YouTube is needed for this video".to_string();
                    set_status(&mut state, id, JobStatus::NeedsSignIn, Some(message.clone()));
                    let _ = shared.app.emit("download-alert", serde_json::json!({ "kind": "signIn", "message": message }));
                }
                FailureKind::Outdated => {
                    if state.updated_ytdlp {
                        fail_job(&mut state, id, "The downloader is out of date. Update it in Settings -> Downloads.".into());
                    } else {
                        state.updated_ytdlp = true;
                        set_status(&mut state, id, JobStatus::Waiting, Some("Updating the downloader".into()));
                        shared.publish(&state);
                        drop(state);
                        let result = ytdlp_binary::update(&shared.app);
                        state = shared.state.lock().unwrap();
                        match result {
                            Ok(_) => set_status(&mut state, id, JobStatus::Queued, None),
                            Err(e) => fail_job(&mut state, id, format!("The downloader is out of date and could not be updated: {e}")),
                        }
                    }
                }
                FailureKind::Disk(message) => {
                    set_status(&mut state, id, JobStatus::Queued, None);
                    state.hold_all = true;
                    let _ = shared.app.emit("download-alert", serde_json::json!({ "kind": "disk", "message": message }));
                }
                FailureKind::Unavailable(message) | FailureKind::Other(message) => fail_job(&mut state, id, message),
                FailureKind::FormatGone => fail_job(&mut state, id, "The chosen quality is not available for this video".into()),
            }
        }
    }
    state
}

fn fail_job(state: &mut State, id: &str, message: String) {
    if let Some(index) = state.index_of(id) {
        let mut job = state.queue.remove(index);
        job.status = JobStatus::Failed;
        job.message = Some(message);
        job.finished_at = Some(now_ms());
        state.add_to_history(job);
    }
}

/// Keep the queue still until the connection (or the rate limit) is OK again, then let the job
/// continue from its partial file. Interrupted by pause, cancel, "download now" and closing.
fn wait_for_connection<'a>(
    shared: &'a Arc<Shared>,
    mut state: MutexGuard<'a, State>,
    id: &str,
    kind: FailureKind,
) -> MutexGuard<'a, State> {
    if kind == FailureKind::RateLimited {
        state.extra_delay = (state.extra_delay + 2).min(30);
    }
    loop {
        let attempt = match state.queue.iter_mut().find(|j| j.id == id) {
            Some(job) => {
                job.attempt += 1;
                job.status = JobStatus::Waiting;
                job.message = Some(if kind == FailureKind::RateLimited {
                    "YouTube asked to slow down; continuing soon".to_string()
                } else {
                    "Waiting for the connection".to_string()
                });
                job.attempt
            }
            None => return state,
        };
        shared.publish(&state);

        let deadline = Instant::now() + Duration::from_secs(backoff_seconds(&kind, attempt - 1));
        while Instant::now() < deadline {
            let still_waiting = state.queue.iter().any(|j| j.id == id && j.status == JobStatus::Waiting);
            if !still_waiting || state.shutting_down {
                return state; // paused, cancelled, moved aside by "download now", or closing
            }
            state = wait_step(shared, state, deadline - Instant::now());
        }

        drop(state);
        let online = connection_works();
        state = shared.state.lock().unwrap();
        if !state.queue.iter().any(|j| j.id == id && j.status == JobStatus::Waiting) {
            return state;
        }
        if online {
            let attempts = state.queue.iter().find(|j| j.id == id).map(|j| j.attempt).unwrap_or(0);
            if kind == FailureKind::Network && attempts >= MAX_ATTEMPTS_WITH_CONNECTION {
                fail_job(&mut state, id, "YouTube kept refusing the connection for this video".into());
            } else {
                set_status(&mut state, id, JobStatus::Queued, None);
            }
            return state;
        }
        // Still offline: wait again, longer.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(title: &str) -> NewDownload {
        NewDownload {
            video_id: title.to_lowercase(),
            url: format!("https://www.youtube.com/watch?v={title}"),
            title: title.into(),
            thumbnail: String::new(),
            duration: None,
            channel: None,
            mode: DownloadMode::Separate,
            video_quality: "1080".into(),
            audio_quality: "best".into(),
            formats: ChosenFormats::default(),
            folder: "/tmp".into(),
            playlist_id: None,
            track_id: None,
        }
    }

    fn state_with(titles: &[&str]) -> (State, Vec<String>) {
        let mut state = State::new(None);
        state.hold_all = false;
        let ids = state.enqueue(titles.iter().map(|t| request(t)).collect());
        (state, ids)
    }

    fn order(state: &State) -> Vec<String> {
        state.queue.iter().map(|j| j.request.title.clone()).collect()
    }

    #[test]
    fn jobs_have_one_part_per_file() {
        let (state, _) = state_with(&["A"]);
        assert_eq!(state.queue[0].parts.len(), 2);
        assert_eq!(state.queue[0].status, JobStatus::Queued);
    }

    #[test]
    fn the_queue_order_is_the_priority() {
        let (mut state, ids) = state_with(&["A", "B", "C"]);
        assert_eq!(state.next_queued(), Some(0));
        state.move_job(&ids[2], 0);
        assert_eq!(order(&state), vec!["C", "A", "B"]);
        state.move_job(&ids[2], 2);
        assert_eq!(order(&state), vec!["A", "B", "C"]);
    }

    #[test]
    fn download_now_goes_first_skips_the_pause_and_the_running_one_waits_behind() {
        let (mut state, ids) = state_with(&["A", "B", "C"]);
        let control = Arc::new(RunControl::default());
        state.queue[0].status = JobStatus::Downloading;
        state.running = Some((ids[0].clone(), control.clone()));
        state.download_now(&ids[2]);
        assert_eq!(order(&state), vec!["C", "A", "B"]);
        assert!(state.skip_delay);
        assert_eq!(control.why(), Interrupt::Preempt);
        assert_eq!(state.queue[0].status, JobStatus::Queued);
    }

    #[test]
    fn paused_videos_are_skipped_and_resume_puts_them_back() {
        let (mut state, ids) = state_with(&["A", "B"]);
        state.pause(&ids[0]);
        assert_eq!(state.next_queued(), Some(1));
        state.resume(&ids[0]);
        assert_eq!(state.next_queued(), Some(0));
    }

    #[test]
    fn nothing_starts_while_everything_is_on_hold() {
        let (mut state, _) = state_with(&["A"]);
        state.pause_all();
        assert_eq!(state.next_queued(), None);
        state.resume_all();
        assert_eq!(state.next_queued(), Some(0));
    }

    #[test]
    fn cancel_moves_to_history_and_retry_brings_it_back_to_the_end() {
        let (mut state, ids) = state_with(&["A", "B"]);
        state.cancel(&ids[0], false);
        assert_eq!(order(&state), vec!["B"]);
        assert_eq!(state.history[0].status, JobStatus::Cancelled);
        state.retry(&ids[0]);
        assert_eq!(order(&state), vec!["B", "A"]);
        assert_eq!(state.queue[1].status, JobStatus::Queued);
        assert!(state.history.is_empty());
    }

    #[test]
    fn unfinished_videos_resume_after_a_restart_or_stay_paused() {
        let (mut state, _) = state_with(&["A", "B"]);
        state.queue[0].status = JobStatus::Downloading;
        state.queue[1].status = JobStatus::Waiting;
        state.after_restart();
        assert!(state.queue.iter().all(|j| j.status == JobStatus::Queued));
        state.config.auto_resume = false;
        state.after_restart();
        assert!(state.queue.iter().all(|j| j.status == JobStatus::Paused));
    }

    #[test]
    fn the_queue_is_saved_and_loaded_again() {
        let folder = std::env::temp_dir().join(format!("queue-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        let mut state = State::new(Some(folder.clone()));
        state.enqueue(vec![request("A"), request("B")]);
        state.queue[0].parts[0].done = true;
        state.queue[0].parts[0].path = Some("/tmp/a.mp4".into());
        state.save();

        let mut loaded = State::new(Some(folder.clone()));
        loaded.load();
        assert_eq!(order(&loaded), vec!["A", "B"]);
        assert!(loaded.queue[0].parts[0].done);
        assert_eq!(loaded.queue[0].request.mode, DownloadMode::Separate);
        let _ = std::fs::remove_dir_all(&folder);
    }
}
