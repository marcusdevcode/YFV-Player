//! Tiny loopback HTTP server that streams local media files with Range support.
//!
//! WebKit's media stack is much more reliable with a real HTTP origin than with custom URL
//! schemes. Only files that the app explicitly registered (via `register`) can be requested,
//! each under an unguessable token, and the server listens on 127.0.0.1 only.
//!
//! Every connection gets its own thread and is closed after one response. (The `tiny_http` crate used
//! before has a small pool of threads for connections: a paused video's connection, whose body the player
//! stops reading, kept a thread blocked, and after a few of them a later seek never got its data, so the
//! picture stayed a still image while the audio, already loaded, played on.)

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::fs::File;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;


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

/// The most one response carries. A player asks for "from here to the end of the file"; answering with the whole rest would keep that connection
/// busy for as long as the player reads slowly (a paused video stops reading), and the web view allows only about six connections to one address:
/// when they are all busy like that, the next seek waits for a free one and the picture freezes. A partial answer is valid (206 with its own
/// Content-Range); the player simply asks for the next part when it needs it.
const MAX_CHUNK: u64 = 3 * 1024 * 1024;

fn status_text(code: u16) -> &'static str {
    match code {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        _ => "Internal Server Error",
    }
}

/// Write a response head (status line and headers) to the stream.
fn write_head(out: &mut impl Write, code: u16, headers: &[(String, String)], length: u64) -> std::io::Result<()> {
    write!(out, "HTTP/1.1 {code} {}\r\n", status_text(code))?;
    for (name, value) in headers {
        write!(out, "{name}: {value}\r\n")?;
    }
    write!(out, "Content-Length: {length}\r\nConnection: close\r\n\r\n")
}

fn common_headers() -> Vec<(String, String)> {
    vec![
        ("Access-Control-Allow-Origin".into(), "*".into()),
        ("Access-Control-Expose-Headers".into(), "Content-Range, Content-Length, Accept-Ranges".into()),
        ("Cache-Control".into(), "no-store".into()),
    ]
}

fn respond_empty(out: &mut impl Write, code: u16, extra: &[(String, String)]) {
    let mut headers = common_headers();
    headers.extend_from_slice(extra);
    let _ = write_head(out, code, &headers, 0).and_then(|_| out.flush());
}

/// Answer one request on a connection, then the connection is closed.
fn serve(stream: TcpStream, files: &Mutex<HashMap<String, PathBuf>>) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let Ok(read_half) = stream.try_clone() else { return };
    let mut reader = BufReader::new(read_half);
    let mut out = stream;

    // The request line and the headers (the player only sends GET, HEAD and OPTIONS without a body).
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let mut range_header: Option<String> = None;
    for _ in 0..100 {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.trim().eq_ignore_ascii_case("range") {
                range_header = Some(value.trim().to_string());
            }
        }
    }
    let mut words = request_line.split_whitespace();
    let (Some(method), Some(url)) = (words.next(), words.next()) else { return };

    // /m/<token>/<filename>
    let mut parts = url.trim_start_matches('/').split('/');
    let (prefix, tok) = (parts.next(), parts.next());
    let path = match (prefix, tok) {
        (Some("m"), Some(t)) => files.lock().ok().and_then(|f| f.get(t).cloned()),
        _ => None,
    };
    let Some(path) = path else {
        respond_empty(&mut out, 404, &[]);
        return;
    };
    // The page reads video frames for thumbnails, which needs CORS. Only registered files, under an
    // unguessable token, are ever served, and only on 127.0.0.1.
    if method.eq_ignore_ascii_case("OPTIONS") {
        respond_empty(
            &mut out,
            204,
            &[
                ("Access-Control-Allow-Methods".into(), "GET, HEAD, OPTIONS".into()),
                ("Access-Control-Allow-Headers".into(), "Range".into()),
            ],
        );
        return;
    }
    let is_head = method.eq_ignore_ascii_case("HEAD");
    if !is_head && !method.eq_ignore_ascii_case("GET") {
        respond_empty(&mut out, 405, &[]);
        return;
    }
    let Ok(mut file) = File::open(&path) else {
        respond_empty(&mut out, 404, &[]);
        return;
    };
    let Ok(len) = file.metadata().map(|m| m.len()) else {
        respond_empty(&mut out, 500, &[]);
        return;
    };

    let (status, start, end) = match range_header.as_deref() {
        Some(r) => match parse_range(r, len) {
            Some((s, e)) => (206u16, s, e),
            None => {
                respond_empty(&mut out, 416, &[("Content-Range".into(), format!("bytes */{len}"))]);
                return;
            }
        },
        None => (200u16, 0, len.saturating_sub(1)),
    };
    let end = if status == 206 { end.min(start + MAX_CHUNK - 1) } else { end };
    let body_len = if len == 0 { 0 } else { end - start + 1 };

    let mut headers = common_headers();
    headers.push(("Content-Type".into(), content_type(&path).into()));
    headers.push(("Accept-Ranges".into(), "bytes".into()));
    if status == 206 {
        headers.push(("Content-Range".into(), format!("bytes {start}-{end}/{len}")));
    }
    if write_head(&mut out, status, &headers, body_len).is_err() {
        return;
    }
    if is_head {
        let _ = out.flush();
        return;
    }
    if file.seek(SeekFrom::Start(start)).is_err() {
        return;
    }
    // Errors here are normal: the player closes connections when seeking.
    let _ = std::io::copy(&mut file.take(body_len), &mut out);
    let _ = out.flush();
}

pub fn start() -> std::io::Result<MediaServer> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    let files: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::default();
    let shared = files.clone();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let shared = shared.clone();
            // One thread per connection, no limit: a connection whose reader has stopped must never keep others waiting.
            thread::spawn(move || serve(stream, &shared));
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


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=-100", 1000), Some((900, 999)));
        assert_eq!(parse_range("bytes=2000-", 1000), None);
    }

    /// An open-ended range is answered with a bounded part, with a correct Content-Range.
    #[test]
    fn open_ended_ranges_are_chunked() {
        let dir = std::env::temp_dir().join(format!("media-server-chunk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big.mp4");
        std::fs::write(&file, vec![1u8; 8 * 1024 * 1024]).unwrap();
        let server = start().unwrap();
        let url = server.register(&file).unwrap();
        let path = url.split_once(&format!("127.0.0.1:{}", server.port)).unwrap().1.to_string();
        let mut s = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        write!(s, "GET {path} HTTP/1.1\r\nHost: x\r\nRange: bytes=1000-\r\n\r\n").unwrap();
        let mut reply = Vec::new();
        s.read_to_end(&mut reply).unwrap();
        let head_end = reply.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        let head = String::from_utf8_lossy(&reply[..head_end]).to_string();
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.contains(&format!("Content-Range: bytes 1000-{}/{}", 1000 + MAX_CHUNK - 1, 8 * 1024 * 1024)), "{head}");
        assert_eq!((reply.len() - head_end) as u64, MAX_CHUNK);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A stalled reader (it asks for a big range and never reads) must not stop later requests from being answered.
    #[test]
    fn stalled_readers_do_not_block_others() {
        let dir = std::env::temp_dir().join(format!("media-server-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("big.mp4");
        std::fs::write(&file, vec![7u8; 8 * 1024 * 1024]).unwrap();
        let server = start().unwrap();
        let url = server.register(&file).unwrap();
        let path = url.split_once(&format!("127.0.0.1:{}", server.port)).unwrap().1.to_string();

        let mut stalled = Vec::new();
        for _ in 0..20 {
            let mut s = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
            write!(s, "GET {path} HTTP/1.1\r\nHost: x\r\nRange: bytes=0-\r\n\r\n").unwrap();
            stalled.push(s); // never read: the server's write blocks once the socket buffers are full
        }
        let mut s = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        write!(s, "GET {path} HTTP/1.1\r\nHost: x\r\nRange: bytes=100-199\r\n\r\n").unwrap();
        let mut reply = Vec::new();
        s.read_to_end(&mut reply).unwrap();
        let text = String::from_utf8_lossy(&reply[..60]).to_string();
        assert!(text.starts_with("HTTP/1.1 206"), "{text}");
        assert!(reply.ends_with(&[7u8; 100]));
        drop(stalled);
        let _ = std::fs::remove_dir_all(dir);
    }
}
