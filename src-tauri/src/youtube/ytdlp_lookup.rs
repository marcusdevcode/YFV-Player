//! YouTube search, video info and the list of formats, read through yt-dlp.
//!
//! One box takes a link or a search text:
//!   a video link        -> the video with all its formats
//!   a playlist link     -> every video of the playlist (all pages)
//!   a channel link      -> every video of the channel's "Videos" tab
//!   anything else       -> a search (videos, playlists and channels, playlists asked for separately)

use std::process::Stdio;

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use super::ytdlp_binary;

#[derive(Debug, Clone, PartialEq)]
pub enum LookupPlan {
    Video(String),
    List(String),
    Search(String),
}

fn is_youtube_host(host: &str) -> bool {
    let host = host.trim_start_matches("www.").trim_start_matches("m.").trim_start_matches("music.");
    host == "youtube.com" || host == "youtu.be" || host == "youtube-nocookie.com"
}

/// What a typed text means.
pub fn plan_lookup(input: &str) -> LookupPlan {
    let text = input.trim();
    let without_scheme = text.strip_prefix("https://").or_else(|| text.strip_prefix("http://"));
    let Some(rest) = without_scheme.or_else(|| {
        let first = text.split('/').next().unwrap_or("");
        if is_youtube_host(first) && text.contains('/') { Some(text) } else { None }
    }) else {
        return LookupPlan::Search(text.to_string());
    };
    let (host, path_and_query) = rest.split_once('/').unwrap_or((rest, ""));
    if !is_youtube_host(host) {
        return LookupPlan::Search(text.to_string());
    }
    let url = format!("https://{rest}");
    let (path, query) = path_and_query.split_once('?').unwrap_or((path_and_query, ""));
    let first_segment = path.split('/').next().unwrap_or("");

    // A playlist link, or a video link that names a playlist ("watch?v=...&list=..."): the whole
    // playlist is listed (the video is one of its items). YouTube's automatic "Mix" playlists
    // (ids starting with RD) have no end, so those stay a single video.
    let list_id = query.split('&').find_map(|p| p.strip_prefix("list=")).filter(|id| !id.is_empty());
    if let Some(id) = list_id.filter(|id| !id.starts_with("RD")) {
        return LookupPlan::List(format!("https://www.youtube.com/playlist?list={id}"));
    }
    if first_segment == "playlist" {
        return LookupPlan::List(url);
    }
    if first_segment.starts_with('@') || matches!(first_segment, "channel" | "c" | "user") {
        // A channel page: its videos tab (unless a tab is already named).
        let last = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
        // A search inside the channel ("<channel>/search?query=..."): kept as it is.
        if last == "search" {
            return LookupPlan::List(url);
        }
        let base = url.split('?').next().unwrap_or(&url).trim_end_matches('/').to_string();
        return LookupPlan::List(if CHANNEL_TABS.contains(&last) { base } else { format!("{base}/videos") });
    }
    LookupPlan::Video(url)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LookupEntry {
    /// "video", "playlist" or "channel".
    pub kind: String,
    pub id: String,
    pub title: String,
    pub url: String,
    pub thumbnail: String,
    /// Seconds, when known.
    pub duration: Option<f64>,
    pub channel: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FormatInfo {
    pub id: String,
    /// "together" (picture and sound), "video" (picture only) or "audio".
    pub kind: String,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub ext: String,
    /// Bytes (exact or approximate), when known.
    pub size: Option<u64>,
    /// Audio bitrate in kbit/s.
    pub audio_bitrate: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum LookupResult {
    Video { entry: LookupEntry, formats: Vec<FormatInfo> },
    /// `channel_url` is set when the list is a channel's tab; the page then offers Videos / Playlists.
    List { title: String, entries: Vec<LookupEntry>, channel_url: Option<String> },
    Search { entries: Vec<LookupEntry> },
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

fn codec(value: &Value, key: &str) -> Option<String> {
    text(value, key).filter(|c| c != "none")
}

/// What a result item is, from its link.
fn entry_kind(url: &str) -> &'static str {
    let path = url.split("://").nth(1).and_then(|r| r.split_once('/')).map(|(_, p)| p).unwrap_or("");
    let first = path.split(['/', '?']).next().unwrap_or("");
    if first == "playlist" {
        "playlist"
    } else if first.starts_with('@') || matches!(first, "channel" | "c" | "user") {
        "channel"
    } else {
        "video"
    }
}

/// The link of a channel without its tab ("/videos", "/playlists" ...), when `url` is a channel link.
fn channel_base(url: &str) -> Option<String> {
    if entry_kind(url) != "channel" {
        return None;
    }
    let url = url.split('?').next().unwrap_or(url).trim_end_matches('/');
    let last = url.rsplit('/').next().unwrap_or("");
    Some(if CHANNEL_TABS.contains(&last) { url[..url.len() - last.len() - 1].to_string() } else { url.to_string() })
}

const CHANNEL_TABS: [&str; 6] = ["videos", "shorts", "streams", "playlists", "featured", "search"];

/// The best picture YouTube gives for a playlist or channel (the last one listed is the largest).
fn picture_of(value: &Value) -> Option<String> {
    value
        .get("thumbnails")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().rev().find_map(|t| t.get("url").and_then(Value::as_str)))
        .map(|u| if u.starts_with("//") { format!("https:{u}") } else { u.to_string() })
}

fn entry_from(value: &Value) -> Option<LookupEntry> {
    let id = text(value, "id")?;
    // Flat playlist entries give a "url" (often the watch link); otherwise build it from the id.
    let url = text(value, "webpage_url")
        .or_else(|| text(value, "url").filter(|u| u.starts_with("http")))
        .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={id}"));
    let kind = entry_kind(&url);
    let thumbnail = if kind == "video" { format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg") } else { picture_of(value).unwrap_or_default() };
    Some(LookupEntry {
        kind: kind.into(),
        thumbnail,
        title: text(value, "title").unwrap_or_else(|| id.clone()),
        duration: value.get("duration").and_then(Value::as_f64),
        channel: text(value, "channel").or_else(|| text(value, "uploader")).filter(|c| c != "Playlist"),
        url,
        id,
    })
}

fn formats_from(value: &Value) -> Vec<FormatInfo> {
    let mut formats: Vec<FormatInfo> = value
        .get("formats")
        .and_then(Value::as_array)
        .map(|list| list.as_slice())
        .unwrap_or(&[])
        .iter()
        .filter_map(|f| {
            let id = text(f, "format_id")?;
            // Storyboards and other non-media entries have neither picture nor sound codecs.
            let video_codec = codec(f, "vcodec");
            let audio_codec = codec(f, "acodec");
            let kind = match (&video_codec, &audio_codec) {
                (Some(_), Some(_)) => "together",
                (Some(_), None) => "video",
                (None, Some(_)) => "audio",
                (None, None) => return None,
            };
            let protocol = text(f, "protocol").unwrap_or_default();
            if protocol.starts_with("m3u8") {
                return None; // streaming playlists cannot be saved as a plain file
            }
            Some(FormatInfo {
                id,
                kind: kind.into(),
                height: f.get("height").and_then(Value::as_u64).map(|h| h as u32),
                fps: f.get("fps").and_then(Value::as_f64),
                video_codec,
                audio_codec,
                ext: text(f, "ext").unwrap_or_default(),
                size: f.get("filesize").and_then(Value::as_u64).or_else(|| f.get("filesize_approx").and_then(Value::as_f64).map(|s| s as u64)),
                audio_bitrate: f.get("abr").and_then(Value::as_f64),
            })
        })
        .collect();
    // Best first: taller pictures, then higher audio bitrate.
    formats.sort_by(|a, b| {
        (b.height.unwrap_or(0), b.audio_bitrate.unwrap_or(0.0) as u64).cmp(&(a.height.unwrap_or(0), a.audio_bitrate.unwrap_or(0.0) as u64))
    });
    formats
}

/// Turn yt-dlp's JSON into the result for the page.
pub fn parse_lookup(plan: &LookupPlan, json: &Value) -> Result<LookupResult, String> {
    match plan {
        LookupPlan::Video(_) => {
            let entry = entry_from(json).ok_or("YouTube did not return a video")?;
            Ok(LookupResult::Video { entry, formats: formats_from(json) })
        }
        LookupPlan::List(_) | LookupPlan::Search(_) => {
            let entries: Vec<LookupEntry> = json
                .get("entries")
                .and_then(Value::as_array)
                .map(|e| e.as_slice())
                .unwrap_or(&[])
                .iter()
                .filter(|e| !e.is_null())
                .filter_map(entry_from)
                .collect();
            if let LookupPlan::Search(_) = plan {
                return Ok(LookupResult::Search { entries });
            }
            let title = text(json, "title").unwrap_or_default();
            let channel_url = match plan {
                LookupPlan::List(url) => channel_base(url),
                _ => None,
            };
            Ok(LookupResult::List { title, entries, channel_url })
        }
    }
}

fn base_command(app: &AppHandle, cookies_browser: Option<&str>) -> Result<std::process::Command, String> {
    let mut command = ytdlp_binary::command(app)?;
    command.args(["-J", "--no-warnings", "--socket-timeout", "20"]);
    if let Some(browser) = cookies_browser.filter(|b| !b.is_empty() && *b != "none") {
        command.args(["--cookies-from-browser", browser]);
    }
    Ok(command)
}

fn run_json(mut command: std::process::Command) -> Result<Value, String> {
    let output = command.stdout(Stdio::piped()).stderr(Stdio::piped()).output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).into_owned();
        return Err(super::download_errors::summary_line(&message));
    }
    serde_json::from_slice(&output.stdout).map_err(|e| format!("Unreadable answer from yt-dlp: {e}"))
}

/// YouTube's own results page: videos, channels and playlists mixed. `playlists_only` asks for the
/// playlists filter (the mixed page rarely contains any).
fn search_page(text: &str, playlists_only: bool) -> String {
    let query: String = text
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    let filter = if playlists_only { "&sp=EgIQAw%253D%253D" } else { "" };
    format!("https://www.youtube.com/results?search_query={query}{filter}")
}

/// How many playlists a search adds at the top.
const SEARCH_PLAYLISTS: u32 = 5;

/// Ask yt-dlp. `count` is how many search results, or how many items of a playlist or channel page
/// (0 = all of them), starting after the first `offset` items. Blocks until yt-dlp answers, so call it
/// from a blocking thread.
pub fn lookup(app: &AppHandle, input: &str, count: u32, offset: u32, cookies_browser: Option<&str>) -> Result<LookupResult, String> {
    let plan = plan_lookup(input);
    if let LookupPlan::Search(text) = &plan {
        let count = count.clamp(1, 100);
        // Two asks at the same time: the mixed results, and the playlists only.
        let playlists = {
            let mut command = base_command(app, cookies_browser)?;
            command.args(["--flat-playlist", "--playlist-end", &SEARCH_PLAYLISTS.to_string(), "--", &search_page(text, true)]);
            std::thread::spawn(move || run_json(command))
        };
        let mut command = base_command(app, cookies_browser)?;
        command.args(["--flat-playlist", "--playlist-end", &count.to_string(), "--", &search_page(text, false)]);
        let mixed = run_json(command)?;
        let playlists = playlists.join().ok().and_then(Result::ok); // playlists are a bonus: no error if they fail
        return Ok(merge_search(&mixed, playlists.as_ref()));
    }
    let mut command = base_command(app, cookies_browser)?;
    match &plan {
        LookupPlan::Video(url) => command.args(["--no-playlist", "--", url]),
        LookupPlan::List(url) => {
            command.arg("--flat-playlist");
            if count > 0 {
                command.args(["--playlist-items", &format!("{}:{}", offset + 1, offset + count)]);
            }
            command.args(["--", url])
        }
        LookupPlan::Search(_) => unreachable!(),
    };
    parse_lookup(&plan, &run_json(command)?)
}

fn entries_of(json: &Value) -> Vec<LookupEntry> {
    json.get("entries").and_then(Value::as_array).map(|e| e.as_slice()).unwrap_or(&[]).iter().filter(|e| !e.is_null()).filter_map(entry_from).collect()
}

/// Search answer: the playlists found, then the mixed results (channels and videos), without doubles.
pub fn merge_search(mixed: &Value, playlists: Option<&Value>) -> LookupResult {
    let mut entries: Vec<LookupEntry> = playlists.map(entries_of).unwrap_or_default().into_iter().filter(|e| e.kind == "playlist").collect();
    for e in entries_of(mixed) {
        if !entries.iter().any(|x| x.id == e.id) {
            entries.push(e);
        }
    }
    LookupResult::Search { entries }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn links_and_searches_are_told_apart() {
        assert_eq!(plan_lookup("https://www.youtube.com/watch?v=abc123"), LookupPlan::Video("https://www.youtube.com/watch?v=abc123".into()));
        assert_eq!(plan_lookup("https://youtu.be/abc123?t=5"), LookupPlan::Video("https://youtu.be/abc123?t=5".into()));
        assert_eq!(plan_lookup("https://www.youtube.com/shorts/abc"), LookupPlan::Video("https://www.youtube.com/shorts/abc".into()));
        assert_eq!(plan_lookup("https://www.youtube.com/playlist?list=PL1"), LookupPlan::List("https://www.youtube.com/playlist?list=PL1".into()));
        // A video link that names a playlist lists the whole playlist.
        assert_eq!(
            plan_lookup("https://www.youtube.com/watch?v=fcakBf0kVys&list=PLBF4873116E525EAD"),
            LookupPlan::List("https://www.youtube.com/playlist?list=PLBF4873116E525EAD".into())
        );
        assert_eq!(plan_lookup("https://youtu.be/abc?list=PL1"), LookupPlan::List("https://www.youtube.com/playlist?list=PL1".into()));
        // An automatic Mix never ends: only the video.
        assert_eq!(
            plan_lookup("https://www.youtube.com/watch?v=abc&list=RDabc"),
            LookupPlan::Video("https://www.youtube.com/watch?v=abc&list=RDabc".into())
        );
        assert_eq!(plan_lookup("cute cats"), LookupPlan::Search("cute cats".into()));
        assert_eq!(plan_lookup("https://example.com/watch?v=1"), LookupPlan::Search("https://example.com/watch?v=1".into()));
    }

    #[test]
    fn channels_open_their_videos_tab() {
        assert_eq!(plan_lookup("https://www.youtube.com/@someone"), LookupPlan::List("https://www.youtube.com/@someone/videos".into()));
        assert_eq!(plan_lookup("https://www.youtube.com/channel/UC123/"), LookupPlan::List("https://www.youtube.com/channel/UC123/videos".into()));
        // A search inside a channel keeps its text and is not turned into the videos tab.
        assert_eq!(
            plan_lookup("https://www.youtube.com/channel/UC1/search?query=xcom%202"),
            LookupPlan::List("https://www.youtube.com/channel/UC1/search?query=xcom%202".into())
        );
        assert_eq!(plan_lookup("https://www.youtube.com/@someone/shorts"), LookupPlan::List("https://www.youtube.com/@someone/shorts".into()));
    }

    #[test]
    fn a_video_with_formats_is_read_and_sorted_best_first() {
        let json = json!({
            "id": "abc", "title": "A video", "duration": 61.0, "channel": "Someone",
            "formats": [
                {"format_id": "sb0", "vcodec": "none", "acodec": "none", "ext": "mhtml"},
                {"format_id": "140", "vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a", "abr": 129.5, "filesize": 1000},
                {"format_id": "137", "vcodec": "avc1", "acodec": "none", "ext": "mp4", "height": 1080, "fps": 30.0, "filesize_approx": 5000.0},
                {"format_id": "18", "vcodec": "avc1", "acodec": "mp4a", "ext": "mp4", "height": 360}
            ]
        });
        let LookupResult::Video { entry, formats } = parse_lookup(&LookupPlan::Video("u".into()), &json).unwrap() else { panic!() };
        assert_eq!(entry.id, "abc");
        assert_eq!(entry.thumbnail, "https://i.ytimg.com/vi/abc/mqdefault.jpg");
        let ids: Vec<&str> = formats.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["137", "18", "140"]);
        assert_eq!(formats[0].kind, "video");
        assert_eq!(formats[0].size, Some(5000));
        assert_eq!(formats[1].kind, "together");
        assert_eq!(formats[2].kind, "audio");
    }

    #[test]
    fn playlist_entries_skip_empty_items() {
        let json = json!({"title": "My list", "entries": [{"id": "a", "title": "One", "url": "https://www.youtube.com/watch?v=a"}, null, {"id": "b", "title": "Two"}]});
        let LookupResult::List { title, entries, .. } = parse_lookup(&LookupPlan::List("u".into()), &json).unwrap() else { panic!() };
        assert_eq!(title, "My list");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].url, "https://www.youtube.com/watch?v=b");
    }

    #[test]
    fn result_items_are_told_apart_by_their_link() {
        assert_eq!(entry_kind("https://www.youtube.com/watch?v=a"), "video");
        assert_eq!(entry_kind("https://www.youtube.com/shorts/a"), "video");
        assert_eq!(entry_kind("https://www.youtube.com/playlist?list=PL1"), "playlist");
        assert_eq!(entry_kind("https://www.youtube.com/channel/UC1"), "channel");
        assert_eq!(entry_kind("https://www.youtube.com/@someone"), "channel");
        assert_eq!(channel_base("https://www.youtube.com/@someone/playlists").as_deref(), Some("https://www.youtube.com/@someone"));
        assert_eq!(channel_base("https://www.youtube.com/channel/UC1/videos").as_deref(), Some("https://www.youtube.com/channel/UC1"));
        assert_eq!(channel_base("https://www.youtube.com/playlist?list=PL1"), None);
    }

    #[test]
    fn a_search_lists_playlists_first_and_skips_doubles() {
        let mixed = json!({"entries": [
            {"id": "v1", "title": "Video", "url": "https://www.youtube.com/watch?v=v1"},
            {"id": "UC1", "title": "A channel", "url": "https://www.youtube.com/channel/UC1"},
            {"id": "PL1", "title": "List", "url": "https://www.youtube.com/playlist?list=PL1"}
        ]});
        let playlists = json!({"entries": [{"id": "PL1", "title": "List", "url": "https://www.youtube.com/playlist?list=PL1", "thumbnails": [{"url": "https://i.ytimg.com/vi/x/a.jpg"}, {"url": "https://i.ytimg.com/vi/x/b.jpg"}]}]});
        let LookupResult::Search { entries } = merge_search(&mixed, Some(&playlists)) else { panic!() };
        let kinds: Vec<(&str, &str)> = entries.iter().map(|e| (e.kind.as_str(), e.id.as_str())).collect();
        assert_eq!(kinds, vec![("playlist", "PL1"), ("video", "v1"), ("channel", "UC1")]);
        assert_eq!(entries[0].thumbnail, "https://i.ytimg.com/vi/x/b.jpg");
    }

    #[test]
    fn search_text_is_escaped_for_the_results_page() {
        assert_eq!(search_page("a b&c", false), "https://www.youtube.com/results?search_query=a%20b%26c");
        assert!(search_page("x", true).ends_with("&sp=EgIQAw%253D%253D"));
    }
}
