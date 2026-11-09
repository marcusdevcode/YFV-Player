//! YouTube search and downloads, done with the bundled yt-dlp program.
//!
//! Everything here runs in Rust: the page only asks for things (search, add to the queue, pause)
//! and shows the state it is sent in events. Downloads therefore never depend on the player or on
//! the window being in front.

pub mod download_errors;
pub mod download_format_rules;
pub mod download_progress_parser;
pub mod download_queue;
pub mod download_worker;
pub mod ytdlp_binary;
pub mod ytdlp_lookup;
pub mod youtube_commands;
