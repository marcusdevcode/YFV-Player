//! Tells what went wrong from yt-dlp's error text, so each kind of failure gets the right
//! reaction: wait and retry, ask for a sign-in, update the downloader, or give up on that video.

#[derive(Debug, Clone, PartialEq)]
pub enum FailureKind {
    /// No connection, timeout, DNS, server error: wait for the connection and continue.
    Network,
    /// Too many requests: wait longer, and slow down.
    RateLimited,
    /// "Sign in to confirm you're not a bot", age-restricted, members-only.
    NeedsSignIn,
    /// yt-dlp no longer understands YouTube: update the downloader.
    Outdated,
    /// Private, removed, blocked in the region: this video cannot be downloaded.
    Unavailable(String),
    /// Disk full or the folder cannot be written.
    Disk(String),
    /// The wanted format is not offered any more.
    FormatGone,
    /// Anything else (the connection is checked before giving up).
    Other(String),
}

fn has(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| text.contains(n))
}

/// The most useful line of yt-dlp's error output ("ERROR: ..."), for showing to the user.
pub fn summary_line(output: &str) -> String {
    output
        .lines()
        .rev()
        .find(|l| l.contains("ERROR:"))
        .or_else(|| output.lines().rev().find(|l| !l.trim().is_empty()))
        .map(|l| l.trim().trim_start_matches("ERROR:").trim().to_string())
        .unwrap_or_default()
}

pub fn classify(output: &str) -> FailureKind {
    let low = output.to_lowercase().replace('\u{2019}', "'");
    let line = summary_line(output);

    if has(&low, &["no space left", "disk quota", "read-only file system", "errno 28", "errno 13", "permission denied"]) {
        return FailureKind::Disk(line);
    }
    if has(
        &low,
        &[
            "sign in to confirm",
            "confirm you're not a bot",
            "age-restricted",
            "confirm your age",
            "members-only",
            "join this channel",
            "login required",
            "use --cookies",
        ],
    ) {
        return FailureKind::NeedsSignIn;
    }
    if has(
        &low,
        &[
            "video unavailable",
            "private video",
            "this video is private",
            "has been removed",
            "this video is not available",
            "who has blocked it",
            "not available in your country",
            "has been terminated",
            "not made this video available",
            "this video has been",
            "live event will begin",
            "premieres in",
        ],
    ) {
        return FailureKind::Unavailable(line);
    }
    if has(&low, &["requested format is not available", "no video formats found"]) {
        return FailureKind::FormatGone;
    }
    if has(&low, &["http error 429", "too many requests", "rate-limited", "rate limited"]) {
        return FailureKind::RateLimited;
    }
    if has(
        &low,
        &[
            "unable to download",
            "timed out",
            "timeout",
            "connection reset",
            "connection refused",
            "connection aborted",
            "temporary failure in name resolution",
            "network is unreachable",
            "no route to host",
            "name or service not known",
            "nodename nor servname",
            "getaddrinfo",
            "remote end closed",
            "incompleteread",
            "transporterror",
            "urlopen error",
            "ssl:",
            "http error 5",
            "unexpected eof",
            "read error",
        ],
    ) {
        return FailureKind::Network;
    }
    if has(&low, &["unable to extract", "nsig extraction failed", "http error 403", "please report this issue", "sabr"]) {
        return FailureKind::Outdated;
    }
    FailureKind::Other(line)
}

/// Seconds to wait before retry number `attempt` (0, 1, 2, ...): 2 s doubling up to 60 s, and for
/// rate limiting 30 s doubling up to 10 minutes.
pub fn backoff_seconds(kind: &FailureKind, attempt: u32) -> u64 {
    let (start, cap) = if *kind == FailureKind::RateLimited { (30, 600) } else { (2, 60) };
    (start << attempt.min(10)).min(cap)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_problems_are_network() {
        for text in [
            "ERROR: unable to download video data: <urlopen error [Errno 8] nodename nor servname provided, or not known>",
            "ERROR: [download] Got error: The read operation timed out",
            "ERROR: unable to download webpage: HTTP Error 503: Service Unavailable",
            "ERROR: Connection reset by peer",
        ] {
            assert_eq!(classify(text), FailureKind::Network, "{text}");
        }
    }

    #[test]
    fn bot_check_and_age_restriction_need_a_sign_in() {
        assert_eq!(classify("ERROR: [youtube] abc: Sign in to confirm you\u{2019}re not a bot. Use --cookies-from-browser"), FailureKind::NeedsSignIn);
        assert_eq!(classify("ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate"), FailureKind::NeedsSignIn);
        assert_eq!(classify("ERROR: This video is age-restricted"), FailureKind::NeedsSignIn);
    }

    #[test]
    fn removed_private_and_blocked_videos_are_unavailable() {
        assert!(matches!(classify("ERROR: [youtube] abc: Video unavailable"), FailureKind::Unavailable(_)));
        assert!(matches!(classify("ERROR: [youtube] abc: Private video. Sign in if you've been granted access"), FailureKind::Unavailable(_)));
        assert!(matches!(classify("ERROR: The uploader has not made this video available in your country"), FailureKind::Unavailable(_)));
        assert!(matches!(classify("ERROR: This video is not available in your country"), FailureKind::Unavailable(_)));
    }

    #[test]
    fn rate_limit_disk_format_and_outdated() {
        assert_eq!(classify("ERROR: unable to download video data: HTTP Error 429: Too Many Requests"), FailureKind::RateLimited);
        assert!(matches!(classify("OSError: [Errno 28] No space left on device"), FailureKind::Disk(_)));
        assert_eq!(classify("ERROR: [youtube] abc: Requested format is not available. Use --list-formats"), FailureKind::FormatGone);
        assert_eq!(classify("ERROR: [youtube] abc: Unable to extract initial player response; please report this issue"), FailureKind::Outdated);
        assert_eq!(classify("WARNING: nsig extraction failed: Some formats may be missing\nERROR: HTTP Error 403: Forbidden"), FailureKind::Outdated);
    }

    #[test]
    fn unknown_errors_keep_their_message() {
        assert_eq!(classify("something odd\nERROR: strange thing"), FailureKind::Other("strange thing".into()));
    }

    #[test]
    fn backoff_doubles_up_to_the_cap() {
        let waits: Vec<u64> = (0..7).map(|a| backoff_seconds(&FailureKind::Network, a)).collect();
        assert_eq!(waits, vec![2, 4, 8, 16, 32, 60, 60]);
        assert_eq!(backoff_seconds(&FailureKind::RateLimited, 0), 30);
        assert_eq!(backoff_seconds(&FailureKind::RateLimited, 9), 600);
    }
}
