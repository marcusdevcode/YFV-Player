//! Writes one regular MP4 (index first, two interleaved tracks) from a video track and an
//! audio track, copying the sample data as-is (no re-encoding).

use std::fs::{self, File};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use super::boxes::*;
use super::demux::{read_track, Kind, Track};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase {
    Reading,
    Writing,
    Finishing,
}

const MOVIE_TIMESCALE: u32 = 1000;
const IDENTITY: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

/// Merge `video_path`'s video track and `audio_path`'s audio track into `out`.
pub fn merge(
    video_path: &Path,
    audio_path: &Path,
    out: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Phase, u64, u64),
) -> Result<(), String> {
    for p in [video_path, audio_path] {
        if same_file(p, out) {
            return Err("The output file must be different from the input files".into());
        }
    }
    progress(Phase::Reading, 0, 0);
    let video = read_track(video_path, Kind::Video)?;
    if cancel.load(Ordering::Relaxed) {
        return Err("Merge cancelled".into());
    }
    let audio = read_track(audio_path, Kind::Audio)?;
    write_merged(&video, &audio, out, cancel, progress)
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

struct Chunk {
    track: usize,
    first: usize,
    count: usize,
    bytes: u64,
    start_s: f64,
}

struct Plan {
    /// All chunks in file order.
    order: Vec<Chunk>,
    /// Samples per chunk, per track.
    counts: [Vec<u32>; 2],
    /// Chunk offsets relative to the start of the media data, per track.
    rel_offsets: [Vec<u64>; 2],
    total_data: u64,
}

/// Group samples into ~1 second chunks per track, then interleave the tracks by time.
fn plan(tracks: [&Track; 2]) -> Plan {
    let mut per_track: [Vec<Chunk>; 2] = [Vec::new(), Vec::new()];
    for (ti, t) in tracks.iter().enumerate() {
        let target = t.timescale as u64;
        let (mut first, mut acc, mut dts, mut chunk_start_dts, mut bytes) = (0usize, 0u64, 0u64, 0u64, 0u64);
        for (i, s) in t.samples.iter().enumerate() {
            if i == first {
                chunk_start_dts = dts;
            }
            acc += s.duration as u64;
            dts += s.duration as u64;
            bytes += s.size as u64;
            if acc >= target || i + 1 == t.samples.len() {
                per_track[ti].push(Chunk {
                    track: ti,
                    first,
                    count: i + 1 - first,
                    bytes,
                    start_s: chunk_start_dts as f64 / t.timescale as f64,
                });
                first = i + 1;
                acc = 0;
                bytes = 0;
            }
        }
    }
    let mut order: Vec<Chunk> = Vec::with_capacity(per_track[0].len() + per_track[1].len());
    let mut all: Vec<Chunk> = per_track.into_iter().flatten().collect();
    // Stable sort: ties keep video before audio, and each track keeps its own order.
    all.sort_by(|a, b| a.start_s.partial_cmp(&b.start_s).unwrap_or(std::cmp::Ordering::Equal).then(a.track.cmp(&b.track)));
    order.append(&mut all);

    let mut counts = [Vec::new(), Vec::new()];
    let mut rel_offsets = [Vec::new(), Vec::new()];
    let mut pos = 0u64;
    for c in &order {
        counts[c.track].push(c.count as u32);
        rel_offsets[c.track].push(pos);
        pos += c.bytes;
    }
    Plan { order, counts, rel_offsets, total_data: pos }
}

// ---- table builders ----

/// Run-length encode `(value)` into `(count, value)` pairs.
fn rle<T: PartialEq + Copy>(vals: impl Iterator<Item = T>) -> Vec<(u32, T)> {
    let mut out: Vec<(u32, T)> = Vec::new();
    for v in vals {
        match out.last_mut() {
            Some((n, last)) if *last == v => *n += 1,
            _ => out.push((1, v)),
        }
    }
    out
}

fn stbl(t: &Track, counts: &[u32], abs_offsets: &[u64], co64: bool) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&t.stsd);

    // stts
    let stts = rle(t.samples.iter().map(|s| s.duration));
    let mut b = Vec::new();
    b.p32(stts.len() as u32);
    for (n, d) in &stts {
        b.p32(*n);
        b.p32(*d);
    }
    body.extend(fbx(b"stts", 0, 0, &b));

    // stss (only when not every sample is a sync sample)
    if t.samples.iter().any(|s| !s.sync) {
        let idx: Vec<u32> = t.samples.iter().enumerate().filter(|(_, s)| s.sync).map(|(i, _)| i as u32 + 1).collect();
        let mut b = Vec::new();
        b.p32(idx.len() as u32);
        for i in idx {
            b.p32(i);
        }
        body.extend(fbx(b"stss", 0, 0, &b));
    }

    // ctts
    if t.samples.iter().any(|s| s.cts_offset != 0) {
        let ctts = rle(t.samples.iter().map(|s| s.cts_offset));
        let version = if ctts.iter().any(|(_, v)| *v < 0) { 1 } else { 0 };
        let mut b = Vec::new();
        b.p32(ctts.len() as u32);
        for (n, v) in &ctts {
            b.p32(*n);
            b.p32(*v as u32);
        }
        body.extend(fbx(b"ctts", version, 0, &b));
    }

    // stsc: one entry per change of samples-per-chunk
    let runs = rle(counts.iter().copied());
    let mut b = Vec::new();
    let mut entries: Vec<(u32, u32)> = Vec::new(); // (first_chunk, samples_per_chunk)
    let mut chunk_no = 1u32;
    for (n, spc) in &runs {
        entries.push((chunk_no, *spc));
        chunk_no += *n;
    }
    b.p32(entries.len() as u32);
    for (first, spc) in &entries {
        b.p32(*first);
        b.p32(*spc);
        b.p32(1);
    }
    body.extend(fbx(b"stsc", 0, 0, &b));

    // stsz
    let mut b = Vec::with_capacity(8 + t.samples.len() * 4);
    b.p32(0);
    b.p32(t.samples.len() as u32);
    for s in &t.samples {
        b.p32(s.size);
    }
    body.extend(fbx(b"stsz", 0, 0, &b));

    // stco / co64
    let mut b = Vec::with_capacity(4 + abs_offsets.len() * 8);
    b.p32(abs_offsets.len() as u32);
    for o in abs_offsets {
        if co64 {
            b.p64(*o);
        } else {
            b.p32(*o as u32);
        }
    }
    body.extend(fbx(if co64 { b"co64" } else { b"stco" }, 0, 0, &b));

    bx(b"stbl", &body)
}

fn to_movie_ts(units: u64, timescale: u32) -> u64 {
    (units as u128 * MOVIE_TIMESCALE as u128 / timescale as u128) as u64
}

fn trak(t: &Track, track_id: u32, counts: &[u32], abs_offsets: &[u64], co64: bool) -> Vec<u8> {
    let media_dur = t.duration();
    let presented = media_dur.saturating_sub(t.media_time.max(0) as u64);
    let movie_dur = to_movie_ts(presented, t.timescale);

    // tkhd (version 0): enabled | in movie
    let mut b = Vec::new();
    b.p32(0);
    b.p32(0);
    b.p32(track_id);
    b.p32(0);
    b.p32(movie_dur as u32);
    b.p64(0);
    b.p16(0); // layer
    b.p16(0); // alternate group
    b.p16(if t.kind == Kind::Audio { 0x0100 } else { 0 });
    b.p16(0);
    b.extend_from_slice(&t.matrix);
    if t.kind == Kind::Video {
        b.p32(t.width);
        b.p32(t.height);
    } else {
        b.p32(0);
        b.p32(0);
    }
    let tkhd = fbx(b"tkhd", 0, 3, &b);

    // edts/elst: keeps the source start offset (e.g. B-frame delay)
    let mut b = Vec::new();
    b.p32(1);
    b.p32(movie_dur as u32);
    b.p32(t.media_time.max(0) as u32);
    b.p16(1);
    b.p16(0);
    let edts = bx(b"edts", &fbx(b"elst", 0, 0, &b));

    // mdhd
    let v1 = media_dur > u32::MAX as u64;
    let mut b = Vec::new();
    if v1 {
        b.p64(0);
        b.p64(0);
        b.p32(t.timescale);
        b.p64(media_dur);
    } else {
        b.p32(0);
        b.p32(0);
        b.p32(t.timescale);
        b.p32(media_dur as u32);
    }
    b.p16(0x55C4); // language "und"
    b.p16(0);
    let mdhd = fbx(b"mdhd", if v1 { 1 } else { 0 }, 0, &b);

    // hdlr
    let mut b = Vec::new();
    b.p32(0);
    b.extend_from_slice(t.kind.handler());
    b.extend_from_slice(&[0u8; 12]);
    b.extend_from_slice(if t.kind == Kind::Video { b"VideoHandler\0" } else { b"SoundHandler\0" });
    let hdlr = fbx(b"hdlr", 0, 0, &b);

    // minf
    let media_header = if t.kind == Kind::Video {
        fbx(b"vmhd", 0, 1, &[0u8; 8])
    } else {
        fbx(b"smhd", 0, 0, &[0u8; 4])
    };
    let dinf = bx(b"dinf", &fbx(b"dref", 0, 0, &[&1u32.to_be_bytes()[..], &fbx(b"url ", 0, 1, &[])[..]].concat()));
    let mut minf_body = Vec::new();
    minf_body.extend(media_header);
    minf_body.extend(dinf);
    minf_body.extend(stbl(t, counts, abs_offsets, co64));
    let minf = bx(b"minf", &minf_body);

    let mut mdia_body = Vec::new();
    mdia_body.extend(mdhd);
    mdia_body.extend(hdlr);
    mdia_body.extend(minf);
    let mdia = bx(b"mdia", &mdia_body);

    let mut body = Vec::new();
    body.extend(tkhd);
    body.extend(edts);
    body.extend(mdia);
    bx(b"trak", &body)
}

fn moov(tracks: [&Track; 2], plan: &Plan, data_start: u64, co64: bool) -> Vec<u8> {
    let mut movie_dur = 0u64;
    for t in tracks {
        let presented = t.duration().saturating_sub(t.media_time.max(0) as u64);
        movie_dur = movie_dur.max(to_movie_ts(presented, t.timescale));
    }
    let mut b = Vec::new();
    b.p32(0);
    b.p32(0);
    b.p32(MOVIE_TIMESCALE);
    b.p32(movie_dur as u32);
    b.p32(0x0001_0000); // rate 1.0
    b.p16(0x0100); // volume 1.0
    b.extend_from_slice(&[0u8; 10]);
    for m in IDENTITY {
        b.p32(m);
    }
    b.extend_from_slice(&[0u8; 24]);
    b.p32(3); // next track id
    let mvhd = fbx(b"mvhd", 0, 0, &b);

    let mut body = mvhd;
    for (i, t) in tracks.iter().enumerate() {
        let abs: Vec<u64> = plan.rel_offsets[i].iter().map(|o| o + data_start).collect();
        body.extend(trak(t, i as u32 + 1, &plan.counts[i], &abs, co64));
    }
    bx(b"moov", &body)
}

fn part_path(out: &Path) -> PathBuf {
    let mut s = out.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

pub fn write_merged(
    video: &Track,
    audio: &Track,
    out: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Phase, u64, u64),
) -> Result<(), String> {
    let part = part_path(out);
    let result = write_inner(video, audio, out, &part, cancel, progress);
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result
}

fn write_inner(
    video: &Track,
    audio: &Track,
    out: &Path,
    part: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(Phase, u64, u64),
) -> Result<(), String> {
    let tracks = [video, audio];
    let plan = plan(tracks);
    let co64 = plan.total_data > 4_000_000_000;

    let ftyp = {
        let mut b = Vec::new();
        b.extend_from_slice(b"isom");
        b.p32(512);
        for brand in [b"isom", b"iso2", b"mp41"] {
            b.extend_from_slice(brand);
        }
        bx(b"ftyp", &b)
    };
    // Offsets have a fixed width, so the index size does not depend on their values.
    let moov_size = moov(tracks, &plan, 0, co64).len() as u64;
    let big_mdat = plan.total_data + 8 > u32::MAX as u64;
    let mdat_header_len = if big_mdat { 16 } else { 8 };
    let data_start = ftyp.len() as u64 + moov_size + mdat_header_len;
    let moov = moov(tracks, &plan, data_start, co64);
    debug_assert_eq!(moov.len() as u64, moov_size);

    let file = File::create(part).map_err(|e| format!("Cannot create the output file: {e}"))?;
    let mut w = BufWriter::with_capacity(4 << 20, file);
    let werr = |e: std::io::Error| match e.raw_os_error() {
        Some(28) => "Not enough free disk space for the merged file".to_string(),
        _ => format!("Cannot write the output file: {e}"),
    };

    w.write_all(&ftyp).map_err(werr)?;
    w.write_all(&moov).map_err(werr)?;
    if big_mdat {
        let mut h = Vec::new();
        h.p32(1);
        h.extend_from_slice(b"mdat");
        h.p64(plan.total_data + 16);
        w.write_all(&h).map_err(werr)?;
    } else {
        let mut h = Vec::new();
        h.p32((plan.total_data + 8) as u32);
        h.extend_from_slice(b"mdat");
        w.write_all(&h).map_err(werr)?;
    }

    let mut sources = [
        File::open(&video.path).map_err(|e| format!("Cannot open the video file: {e}"))?,
        File::open(&audio.path).map_err(|e| format!("Cannot open the audio file: {e}"))?,
    ];
    let mut buf: Vec<u8> = Vec::new();
    let mut done = 0u64;
    progress(Phase::Writing, 0, plan.total_data);
    for chunk in &plan.order {
        if cancel.load(Ordering::Relaxed) {
            return Err("Merge cancelled".into());
        }
        let samples = &tracks[chunk.track].samples[chunk.first..chunk.first + chunk.count];
        let src = &mut sources[chunk.track];
        let mut i = 0;
        while i < samples.len() {
            // Copy runs of back-to-back samples with a single read.
            let start = samples[i].offset;
            let mut len = samples[i].size as u64;
            let mut j = i + 1;
            while j < samples.len() && samples[j].offset == start + len {
                len += samples[j].size as u64;
                j += 1;
            }
            buf.resize(len as usize, 0);
            src.seek(SeekFrom::Start(start)).map_err(|e| format!("Cannot read the source file: {e}"))?;
            src.read_exact(&mut buf).map_err(|e| format!("Cannot read the source file: {e}"))?;
            w.write_all(&buf).map_err(werr)?;
            done += len;
            i = j;
        }
        progress(Phase::Writing, done, plan.total_data);
    }

    progress(Phase::Finishing, done, plan.total_data);
    w.flush().map_err(werr)?;
    drop(w);
    fs::rename(part, out).map_err(|e| format!("Cannot save the output file: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mp4::demux::Sample;

    fn stsd_box() -> Vec<u8> {
        let entry = bx(b"avc1", &[0u8; 78]);
        let mut b = Vec::new();
        b.p32(1);
        b.extend(entry);
        fbx(b"stsd", 0, 0, &b)
    }

    fn make_track(dir: &Path, name: &str, kind: Kind, n: usize, ts: u32, dur: u32) -> Track {
        // Source file with recognisable bytes; samples are laid out back to back.
        let mut data = Vec::new();
        let mut samples = Vec::new();
        for i in 0..n {
            let size = 40 + (i % 7) as u32;
            samples.push(Sample {
                offset: data.len() as u64,
                size,
                duration: dur,
                cts_offset: if kind == Kind::Video { (i % 3) as i32 * 512 } else { 0 },
                sync: kind == Kind::Audio || i % 10 == 0,
            });
            data.extend((0..size).map(|k| (i as u32 * 31 + k) as u8));
        }
        let path = dir.join(name);
        fs::write(&path, &data).unwrap();
        Track { path, kind, timescale: ts, stsd: stsd_box(), matrix: [0; 36], width: 640 << 16, height: 360 << 16, media_time: 0, samples }
    }

    #[test]
    fn rle_and_roundtrip() {
        assert_eq!(rle([1, 1, 2, 2, 2, 3].into_iter()), vec![(2, 1), (3, 2), (1, 3)]);

        let dir = std::env::temp_dir().join(format!("mux-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let v = make_track(&dir, "v.bin", Kind::Video, 100, 15360, 512);
        let a = make_track(&dir, "a.bin", Kind::Audio, 200, 44100, 1024);
        let out = dir.join("out.mp4");

        let cancel = AtomicBool::new(false);
        let mut last = (0, 0);
        write_merged(&v, &a, &out, &cancel, &mut |_, d, t| last = (d, t)).unwrap();
        assert_eq!(last.0, last.1, "progress must reach 100%");
        assert!(!part_path(&out).exists(), "no .part file left behind");

        for (orig, kind) in [(&v, Kind::Video), (&a, Kind::Audio)] {
            let t = read_track(&out, kind).unwrap();
            assert_eq!(t.timescale, orig.timescale);
            assert_eq!(t.samples.len(), orig.samples.len());
            assert_eq!(t.duration(), orig.duration());
            let src = fs::read(&orig.path).unwrap();
            let dst = fs::read(&out).unwrap();
            for (x, y) in orig.samples.iter().zip(&t.samples) {
                assert_eq!((x.size, x.duration, x.cts_offset, x.sync), (y.size, y.duration, y.cts_offset, y.sync));
                let a = &src[x.offset as usize..x.offset as usize + x.size as usize];
                let b = &dst[y.offset as usize..y.offset as usize + y.size as usize];
                assert_eq!(a, b, "sample bytes must be copied unchanged");
            }
        }

        // Cancelling removes the partial file and leaves no output.
        let out2 = dir.join("cancelled.mp4");
        let cancel = AtomicBool::new(true);
        assert!(write_merged(&v, &a, &out2, &cancel, &mut |_, _, _| {}).is_err());
        assert!(!out2.exists() && !part_path(&out2).exists());

        let _ = fs::remove_dir_all(&dir);
    }

    /// Real files: APP_MERGE_V=… APP_MERGE_A=… APP_MERGE_OUT=… cargo test real_merge -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_merge() {
        let (v, a, out) = (
            std::env::var("APP_MERGE_V").unwrap(),
            std::env::var("APP_MERGE_A").unwrap(),
            std::env::var("APP_MERGE_OUT").unwrap(),
        );
        let start = std::time::Instant::now();
        let mut events = 0u32;
        let mut last_done = 0u64;
        let mut monotonic = true;
        merge(Path::new(&v), Path::new(&a), Path::new(&out), &AtomicBool::new(false), &mut |ph, d, t| {
            events += 1;
            if d < last_done {
                monotonic = false;
            }
            last_done = d;
            if events % 2000 == 1 {
                println!("{ph:?} {d}/{t}");
            }
        })
        .unwrap();
        println!("done in {:?}, {events} progress calls, monotonic={monotonic}, bytes={last_done}", start.elapsed());
    }
}
