//! Turns "what the user wants" into yt-dlp format options.
//!
//! No ffmpeg is bundled, so yt-dlp can never join streams: every file is one stream. A video with
//! separate audio is therefore two downloads (a video file, an audio file), which the player already
//! plays together. For playlists the choice is a rule ("up to 1080p"), and yt-dlp's format sorting
//! picks, per video, the best format at or below it (or the closest one above if none is lower).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadMode {
    /// One file with picture and sound (YouTube only offers this up to about 720p).
    Together,
    /// A video file and an audio file.
    Separate,
    AudioOnly,
}

/// One file of a job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PartKind {
    Together,
    Video,
    Audio,
}

impl DownloadMode {
    pub fn parts(self) -> &'static [PartKind] {
        match self {
            DownloadMode::Together => &[PartKind::Together],
            DownloadMode::Separate => &[PartKind::Video, PartKind::Audio],
            DownloadMode::AudioOnly => &[PartKind::Audio],
        }
    }
}

/// Exact formats picked for a single video; without them the quality rule decides.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChosenFormats {
    pub together: Option<String>,
    pub video: Option<String>,
    pub audio: Option<String>,
}

/// The yt-dlp options (`-f`, `-S`) for one file.
pub fn format_args(part: PartKind, video_quality: &str, audio_quality: &str, chosen: &ChosenFormats) -> Vec<String> {
    let exact = match part {
        PartKind::Together => &chosen.together,
        PartKind::Video => &chosen.video,
        PartKind::Audio => &chosen.audio,
    };
    if let Some(id) = exact.as_ref().filter(|id| !id.is_empty()) {
        return vec!["-f".into(), id.clone()];
    }
    let height = video_quality.parse::<u32>().ok();
    match part {
        PartKind::Together | PartKind::Video => {
            let selector = if part == PartKind::Together { "b" } else { "bv" };
            // "res:N" prefers the best at or below N; h264 first because every system plays it.
            let sort = match height {
                Some(h) => format!("res:{h},vcodec:h264"),
                None => "res,vcodec:h264".to_string(),
            };
            vec!["-f".into(), selector.into(), "-S".into(), sort]
        }
        PartKind::Audio => {
            let sort = match audio_quality {
                "medium" => "abr:128,acodec:aac",
                "low" => "abr:64,acodec:aac",
                _ => "abr,acodec:aac",
            };
            vec!["-f".into(), "ba".into(), "-S".into(), sort.into()]
        }
    }
}

/// The part of the file name that tells the files of one video apart.
pub fn part_suffix(part: PartKind) -> &'static str {
    match part {
        PartKind::Together => "",
        PartKind::Video => " (video)",
        PartKind::Audio => " (audio)",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn none() -> ChosenFormats {
        ChosenFormats::default()
    }

    #[test]
    fn separate_mode_is_a_video_file_then_an_audio_file() {
        assert_eq!(DownloadMode::Separate.parts(), &[PartKind::Video, PartKind::Audio]);
        assert_eq!(DownloadMode::Together.parts(), &[PartKind::Together]);
        assert_eq!(DownloadMode::AudioOnly.parts(), &[PartKind::Audio]);
    }

    #[test]
    fn video_quality_becomes_a_sort_limit() {
        assert_eq!(format_args(PartKind::Video, "1080", "best", &none()), vec!["-f", "bv", "-S", "res:1080,vcodec:h264"]);
        assert_eq!(format_args(PartKind::Together, "720", "best", &none()), vec!["-f", "b", "-S", "res:720,vcodec:h264"]);
        assert_eq!(format_args(PartKind::Video, "best", "best", &none()), vec!["-f", "bv", "-S", "res,vcodec:h264"]);
    }

    #[test]
    fn audio_quality_levels() {
        assert_eq!(format_args(PartKind::Audio, "best", "medium", &none())[3], "abr:128,acodec:aac");
        assert_eq!(format_args(PartKind::Audio, "best", "low", &none())[3], "abr:64,acodec:aac");
        assert_eq!(format_args(PartKind::Audio, "best", "best", &none())[3], "abr,acodec:aac");
    }

    #[test]
    fn an_exact_format_wins_over_the_rule() {
        let chosen = ChosenFormats { video: Some("137".into()), ..Default::default() };
        assert_eq!(format_args(PartKind::Video, "360", "best", &chosen), vec!["-f", "137"]);
        assert_eq!(format_args(PartKind::Audio, "360", "best", &chosen)[1], "ba");
    }
}
