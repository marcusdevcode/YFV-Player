//! Minimal MP4 inspection: the real duration of fragmented ("DASH") files.
//!
//! Some downloaders write a wrong (e.g. doubled) duration into the headers of fragmented MP4
//! files, and the browser trusts it. The segment index (`sidx`) lists every fragment's real
//! duration, so summing it gives the true length.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Real duration in seconds from the file's `sidx` box(es), if it has them.
pub fn sidx_duration(path: &Path) -> Option<f64> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut pos = 0u64;
    let mut total = 0f64;
    let mut found = false;

    while pos + 8 <= len {
        f.seek(SeekFrom::Start(pos)).ok()?;
        let mut h = [0u8; 8];
        f.read_exact(&mut h).ok()?;
        let size32 = u32::from_be_bytes(h[0..4].try_into().ok()?) as u64;
        let kind = &h[4..8];
        let (hdr, size) = match size32 {
            1 => {
                let mut b = [0u8; 8];
                f.read_exact(&mut b).ok()?;
                (16, u64::from_be_bytes(b))
            }
            0 => (8, len - pos),
            n => (8, n),
        };
        if size < hdr {
            return None;
        }

        match kind {
            b"sidx" => {
                let body_len = (size - hdr).min(4 << 20) as usize;
                let mut body = vec![0u8; body_len];
                f.read_exact(&mut body).ok()?;
                total += parse_sidx(&body)?;
                found = true;
            }
            // Media data starts: the index (if any) has been seen.
            b"moof" | b"mdat" => break,
            _ => {}
        }
        pos += size;
    }
    found.then_some(total)
}

fn parse_sidx(b: &[u8]) -> Option<f64> {
    let version = *b.first()?;
    let timescale = u32::from_be_bytes(b.get(8..12)?.try_into().ok()?) as f64;
    let mut o = if version == 0 { 12 + 8 } else { 12 + 16 };
    o += 2; // reserved
    let count = u16::from_be_bytes(b.get(o..o + 2)?.try_into().ok()?) as usize;
    o += 2;
    if timescale == 0.0 {
        return None;
    }
    let mut sum = 0u64;
    for _ in 0..count {
        let e = b.get(o..o + 12)?;
        let first = u32::from_be_bytes(e[0..4].try_into().ok()?);
        if first >> 31 == 1 {
            return None; // points to another index (hierarchical): not handled
        }
        sum += u32::from_be_bytes(e[4..8].try_into().ok()?) as u64;
        o += 12;
    }
    Some(sum as f64 / timescale)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Prints the result for a real file: APP_TEST_MP4=/path/file.mp4 cargo test -- --nocapture
    #[test]
    fn reads_real_file_if_provided() {
        if let Ok(p) = std::env::var("APP_TEST_MP4") {
            let d = sidx_duration(Path::new(&p));
            println!("sidx duration: {d:?}");
        }
    }
}
