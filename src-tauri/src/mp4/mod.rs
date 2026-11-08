//! Minimal MP4 toolkit: inspect files and merge a video file and an audio file into one MP4
//! without re-encoding (stream copy).

pub mod boxes;
pub mod demux;
pub mod mux;
mod sidx;

pub use sidx::sidx_duration;
