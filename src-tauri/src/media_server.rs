//! Tiny loopback HTTP server that streams local media files with Range support.
//!
//! WebKit's media stack is much more reliable with a real HTTP origin than with custom URL
//! schemes. Only files that the app explicitly registered (via `register`) can be requested,
//! each under an unguessable token, and the server listens on 127.0.0.1 only.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::fs::File;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

pub struct MediaServer {
    pub port: u16,
    files: Arc<Mutex<HashMap<String, PathBuf>>>,
}

fn token() -> String {
    let mut out = String::new();
    for _ in 0..2 {
        out.push_str(&format!("{:016x}", RandomState::new().build_hasher().finish()));
    }
    out
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("avi") => "video/x-msvideo",
        Some("ogv") => "video/ogg",
        Some("ts") => "video/mp2t",
        Some("m4a") => "audio/mp4",
        Some("mp3") => "audio/mpeg",
        Some("aac") => "audio/aac",
        Some("flac") => "audio/flac",
        Some("wav") => "audio/wav",
        Some("ogg") | Some("opus") => "audio/ogg",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

/// Parse a single `bytes=a-b` range. Returns (start, end_inclusive).
fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let spec = value.trim().strip_prefix("bytes=")?;
    let spec = spec.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 || len == 0 {
            return None;
        }
        return Some((len.saturating_sub(n), len - 1));
    }
    let start: u64 = a.parse().ok()?;
    let end: u64 = if b.is_empty() { len.checked_sub(1)? } else { b.parse().ok()? };
    if start >= len {
        return None;
    }
    Some((start, end.min(len - 1)))
}

fn handle(req: Request, files: &Mutex<HashMap<String, PathBuf>>) {
    let url = req.url().to_string();
    // /m/<token>/<filename>
    let mut parts = url.trim_start_matches('/').split('/');
    let (prefix, tok) = (parts.next(), parts.next());
    let path = match (prefix, tok) {
        (Some("m"), Some(t)) => files.lock().ok().and_then(|f| f.get(t).cloned()),
        _ => None,
    };
    let Some(path) = path else {
        let _ = req.respond(Response::empty(StatusCode(404)));
        return;
    };
    // The page reads video frames for thumbnails, which needs CORS. Only registered files, under an
    // unguessable token, are ever served, and only on 127.0.0.1.
    if *req.method() == Method::Options {
        let resp = Response::empty(StatusCode(204))
            .with_header(header("Access-Control-Allow-Origin", "*"))
            .with_header(header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"))
            .with_header(header("Access-Control-Allow-Headers", "Range"));
        let _ = req.respond(resp);
        return;
    }
    let Ok(mut file) = File::open(&path) else {
        let _ = req.respond(Response::empty(StatusCode(404)));
        return;
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        let _ = req.respond(Response::empty(StatusCode(500)));
        return;
    };

    let range_header = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    let (status, start, end) = match range_header.as_deref() {
        Some(r) => match parse_range(r, len) {
            Some((s, e)) => (206u16, s, e),
            None => {
                let resp = Response::empty(StatusCode(416))
                    .with_header(header("Content-Range", &format!("bytes */{len}")));
                let _ = req.respond(resp);
                return;
            }
        },
        None => (200u16, 0, len.saturating_sub(1)),
    };
    let body_len = if len == 0 { 0 } else { end - start + 1 };

    let mut headers = vec![
        header("Content-Type", content_type(&path)),
        header("Accept-Ranges", "bytes"),
        header("Cache-Control", "no-store"),
        header("Access-Control-Allow-Origin", "*"),
        header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges"),
    ];
    if status == 206 {
        headers.push(header("Content-Range", &format!("bytes {start}-{end}/{len}")));
    }

    if *req.method() == Method::Head {
        // tiny_http fills Content-Length from the given length and sends no body for HEAD.
        let resp = Response::new(StatusCode(status), headers, std::io::empty(), Some(body_len as usize), None);
        let _ = req.respond(resp);
        return;
    }

    if file.seek(SeekFrom::Start(start)).is_err() {
        let _ = req.respond(Response::empty(StatusCode(500)));
        return;
    }
    let reader = file.take(body_len);
    let resp = Response::new(StatusCode(status), headers, reader, Some(body_len as usize), None);
    // Errors here are normal: the player closes connections when seeking.
    let _ = req.respond(resp);
}

pub fn start() -> std::io::Result<MediaServer> {
    let server = Server::http("127.0.0.1:0").map_err(|e| std::io::Error::other(e.to_string()))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| std::io::Error::other("no ip address"))?;
    let files: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::default();
    let shared = files.clone();
    thread::spawn(move || {
        for req in server.incoming_requests() {
            let shared = shared.clone();
            thread::spawn(move || handle(req, &shared));
        }
    });
    Ok(MediaServer { port, files })
}

impl MediaServer {
    /// Register a file and return the URL the web view can load it from.
    pub fn register(&self, path: &Path) -> Result<String, String> {
        let meta = std::fs::metadata(path).map_err(|e| format!("Cannot open file: {e}"))?;
        if !meta.is_file() {
            return Err("Not a file".into());
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("media");
        let encoded: String = name
            .bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect();
        let tok = token();
        self.files.lock().map_err(|e| e.to_string())?.insert(tok.clone(), path.to_path_buf());
        Ok(format!("http://127.0.0.1:{}/m/{}/{}", self.port, tok, encoded))
    }
}
