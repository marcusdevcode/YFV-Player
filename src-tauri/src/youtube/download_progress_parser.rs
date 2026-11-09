//! Reads the lines yt-dlp prints while downloading.
//!
//! The worker asks yt-dlp for two kinds of marked lines (see download_worker.rs):
//!   `@@P|<downloaded>|<total>|<estimated total>|<speed>|<eta>`   progress
//!   `@@F|<final file path>|<height>|<audio bitrate>`             the file is complete

#[derive(Debug, Clone, PartialEq)]
pub struct Progress {
    pub downloaded: u64,
    /// The size in bytes when known (exact, or the estimate).
    pub total: Option<u64>,
    /// Bytes per second.
    pub speed: Option<f64>,
    /// Seconds left.
    pub eta: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FinishedFile {
    pub path: String,
    pub height: Option<u32>,
    pub audio_bitrate: Option<u32>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OutputLine {
    Progress(Progress),
    Finished(FinishedFile),
    Other,
}

fn number(text: &str) -> Option<f64> {
    let value: f64 = text.trim().parse().ok()?;
    if value.is_finite() && value >= 0.0 {
        Some(value)
    } else {
        None
    }
}

pub fn parse_line(line: &str) -> OutputLine {
    let line = line.trim_end();
    if let Some(rest) = line.strip_prefix("@@P|") {
        let parts: Vec<&str> = rest.split('|').collect();
        if parts.len() >= 5 {
            let exact = number(parts[1]);
            let estimate = number(parts[2]);
            return OutputLine::Progress(Progress {
                downloaded: number(parts[0]).unwrap_or(0.0) as u64,
                total: exact.or(estimate).map(|t| t as u64),
                speed: number(parts[3]),
                eta: number(parts[4]).map(|e| e as u64),
            });
        }
    }
    if let Some(rest) = line.strip_prefix("@@F|") {
        // The path may contain "|", so the two numbers are taken from the end.
        let mut parts = rest.rsplitn(3, '|');
        let audio = parts.next().and_then(number);
        let height = parts.next().and_then(number);
        if let Some(path) = parts.next() {
            return OutputLine::Finished(FinishedFile {
                path: path.to_string(),
                height: height.map(|h| h as u32),
                audio_bitrate: audio.map(|a| a as u32),
            });
        }
    }
    // A file that was fully downloaded before: yt-dlp only says so.
    if let Some(rest) = line.strip_prefix("[download] ") {
        if let Some(path) = rest.strip_suffix(" has already been downloaded") {
            return OutputLine::Finished(FinishedFile { path: path.to_string(), height: None, audio_bitrate: None });
        }
    }
    OutputLine::Other
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_line_with_exact_total() {
        assert_eq!(
            parse_line("@@P|1048576|4194304|NA|524288.5|6"),
            OutputLine::Progress(Progress { downloaded: 1048576, total: Some(4194304), speed: Some(524288.5), eta: Some(6) })
        );
    }

    #[test]
    fn progress_line_falls_back_to_the_estimate_and_ignores_missing_values() {
        assert_eq!(
            parse_line("@@P|100|NA|2000|NA|NA"),
            OutputLine::Progress(Progress { downloaded: 100, total: Some(2000), speed: None, eta: None })
        );
        assert_eq!(
            parse_line("@@P|None|None|None|None|None"),
            OutputLine::Progress(Progress { downloaded: 0, total: None, speed: None, eta: None })
        );
    }

    #[test]
    fn finished_line_keeps_pipes_in_the_path() {
        assert_eq!(
            parse_line("@@F|/videos/a|b [id] (video).mp4|1080|NA"),
            OutputLine::Finished(FinishedFile { path: "/videos/a|b [id] (video).mp4".into(), height: Some(1080), audio_bitrate: None })
        );
    }

    #[test]
    fn already_downloaded_counts_as_finished() {
        assert_eq!(
            parse_line("[download] /v/x.mp4 has already been downloaded"),
            OutputLine::Finished(FinishedFile { path: "/v/x.mp4".into(), height: None, audio_bitrate: None })
        );
    }

    #[test]
    fn other_lines_are_ignored() {
        assert_eq!(parse_line("[youtube] Extracting URL"), OutputLine::Other);
        assert_eq!(parse_line("@@P|broken"), OutputLine::Other);
    }
}
