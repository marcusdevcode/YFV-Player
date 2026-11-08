//! Reads the samples (frames / audio packets) of one track from an MP4 file.
//! Works for regular MP4s (sample tables in `moov`) and fragmented ("DASH") MP4s (`moof` boxes).

use std::fs::File;
use std::path::{Path, PathBuf};

use super::boxes::*;

const MAX_SAMPLES: usize = 50_000_000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Video,
    Audio,
}

impl Kind {
    pub fn handler(self) -> &'static [u8; 4] {
        match self {
            Kind::Video => b"vide",
            Kind::Audio => b"soun",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Kind::Video => "video",
            Kind::Audio => "audio",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    /// Byte offset of the sample data in the source file.
    pub offset: u64,
    pub size: u32,
    /// Duration in track timescale units.
    pub duration: u32,
    /// Composition time offset (presentation minus decode time).
    pub cts_offset: i32,
    pub sync: bool,
}

#[derive(Debug)]
pub struct Track {
    pub path: PathBuf,
    pub kind: Kind,
    pub timescale: u32,
    /// The complete `stsd` box (codec configuration), copied verbatim into the output.
    pub stsd: Vec<u8>,
    pub matrix: [u8; 36],
    /// 16.16 fixed point, as stored in `tkhd`.
    pub width: u32,
    pub height: u32,
    /// Start offset from the source edit list (e.g. B-frame delay), in track timescale units.
    pub media_time: i64,
    pub samples: Vec<Sample>,
}

impl Track {
    /// Sum of all sample durations, in track timescale units.
    pub fn duration(&self) -> u64 {
        self.samples.iter().map(|s| s.duration as u64).sum()
    }
}

fn ioe(e: std::io::Error) -> String {
    format!("Cannot read file: {e}")
}

fn name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.display().to_string())
}

pub fn read_track(path: &Path, kind: Kind) -> Result<Track, String> {
    let mut f = File::open(path).map_err(|e| format!("Cannot open {}: {e}", name(path)))?;
    let len = f.metadata().map_err(ioe)?.len();
    let top = children(&mut f, 0, len).map_err(ioe)?;
    let moov = find(&top, b"moov")
        .ok_or_else(|| format!("{} is not an MP4/MOV file (it has no 'moov' box)", name(path)))?;
    let moov_kids = children(&mut f, moov.body_start(), moov.end()).map_err(ioe)?;

    // Pick the first track of the wanted kind.
    let mut picked = None;
    for trak in moov_kids.iter().filter(|b| &b.kind == b"trak") {
        let kids = children(&mut f, trak.body_start(), trak.end()).map_err(ioe)?;
        let Some(mdia) = find(&kids, b"mdia") else { continue };
        let mkids = children(&mut f, mdia.body_start(), mdia.end()).map_err(ioe)?;
        let Some(hdlr) = find(&mkids, b"hdlr") else { continue };
        let hb = read_body(&mut f, &hdlr).map_err(ioe)?;
        if hb.get(8..12) == Some(&kind.handler()[..]) {
            picked = Some((kids, mkids));
            break;
        }
    }
    let (tkids, mkids) =
        picked.ok_or_else(|| format!("No {} track found in {}", kind.label(), name(path)))?;

    // tkhd: track id, matrix, size.
    let tkhd = find(&tkids, b"tkhd").ok_or("damaged file (track has no 'tkhd')")?;
    let tb = read_body(&mut f, &tkhd).map_err(ioe)?;
    let v1 = tb.first() == Some(&1);
    let (id_off, mat_off) = if v1 { (20, 52) } else { (12, 40) };
    let track_id = rd32(&tb, id_off)?;
    let mut matrix = [0u8; 36];
    matrix.copy_from_slice(tb.get(mat_off..mat_off + 36).ok_or("damaged file (short 'tkhd')")?);
    let width = rd32(&tb, mat_off + 36)?;
    let height = rd32(&tb, mat_off + 40)?;

    // mdhd: timescale.
    let mdhd = find(&mkids, b"mdhd").ok_or("damaged file (track has no 'mdhd')")?;
    let mb = read_body(&mut f, &mdhd).map_err(ioe)?;
    let timescale = rd32(&mb, if mb.first() == Some(&1) { 20 } else { 12 })?;
    if timescale == 0 {
        return Err("damaged file (timescale is zero)".into());
    }

    // Edit list start offset.
    let mut media_time = 0i64;
    if let Some(edts) = find(&tkids, b"edts") {
        let ek = children(&mut f, edts.body_start(), edts.end()).map_err(ioe)?;
        if let Some(elst) = find(&ek, b"elst") {
            let eb = read_body(&mut f, &elst).map_err(ioe)?;
            let ver = eb.first().copied().unwrap_or(0);
            let count = rd32(&eb, 4).unwrap_or(0) as usize;
            let (entry_len, mt_off) = if ver == 1 { (20, 8) } else { (12, 4) };
            for i in 0..count {
                let o = 8 + i * entry_len + mt_off;
                let mt = if ver == 1 { rd64(&eb, o)? as i64 } else { rd32(&eb, o)? as i32 as i64 };
                if mt >= 0 {
                    media_time = mt;
                    break;
                }
            }
        }
    }

    // stsd and the sample tables.
    let minf = find(&mkids, b"minf").ok_or("damaged file (track has no 'minf')")?;
    let minf_kids = children(&mut f, minf.body_start(), minf.end()).map_err(ioe)?;
    let stbl = find(&minf_kids, b"stbl").ok_or("damaged file (track has no 'stbl')")?;
    let stbl_kids = children(&mut f, stbl.body_start(), stbl.end()).map_err(ioe)?;
    let stsd_h = find(&stbl_kids, b"stsd").ok_or("damaged file (track has no 'stsd')")?;
    let stsd = read_whole(&mut f, &stsd_h).map_err(ioe)?;

    let mut samples = read_flat(&mut f, &stbl_kids)?;

    // Fragmented files: samples live in moof boxes.
    if let Some(mvex) = find(&moov_kids, b"mvex") {
        let mk = children(&mut f, mvex.body_start(), mvex.end()).map_err(ioe)?;
        let mut defaults = (0u32, 0u32, 0u32); // duration, size, flags
        for trex in mk.iter().filter(|b| &b.kind == b"trex") {
            let b = read_body(&mut f, trex).map_err(ioe)?;
            if rd32(&b, 4)? == track_id {
                defaults = (rd32(&b, 12)?, rd32(&b, 16)?, rd32(&b, 20)?);
            }
        }
        for moof in top.iter().filter(|b| &b.kind == b"moof") {
            read_moof(&mut f, moof, track_id, defaults, &mut samples)?;
        }
    }

    if samples.is_empty() {
        return Err(format!("The {} track in {} has no samples", kind.label(), name(path)));
    }
    if samples.len() > MAX_SAMPLES {
        return Err("file has too many samples".into());
    }
    if let Some(bad) = samples.iter().find(|s| s.offset + s.size as u64 > len) {
        let _ = bad;
        return Err(format!("{} looks truncated or damaged (data is missing)", name(path)));
    }

    Ok(Track { path: path.to_path_buf(), kind, timescale, stsd, matrix, width, height, media_time, samples })
}

fn read_moof(
    f: &mut File,
    moof: &BoxHeader,
    track_id: u32,
    defaults: (u32, u32, u32),
    out: &mut Vec<Sample>,
) -> Result<(), String> {
    let kids = children(f, moof.body_start(), moof.end()).map_err(ioe)?;
    for traf in kids.iter().filter(|b| &b.kind == b"traf") {
        let tk = children(f, traf.body_start(), traf.end()).map_err(ioe)?;
        let Some(tfhd) = find(&tk, b"tfhd") else { continue };
        let b = read_body(f, &tfhd).map_err(ioe)?;
        let flags = rd32(&b, 0)? & 0x00ff_ffff;
        if rd32(&b, 4)? != track_id {
            continue;
        }
        let mut o = 8;
        let mut base = moof.start;
        if flags & 0x01 != 0 {
            base = rd64(&b, o)?;
            o += 8;
        }
        if flags & 0x02 != 0 {
            o += 4;
        }
        let (mut def_dur, mut def_size, mut def_flags) = defaults;
        if flags & 0x08 != 0 {
            def_dur = rd32(&b, o)?;
            o += 4;
        }
        if flags & 0x10 != 0 {
            def_size = rd32(&b, o)?;
            o += 4;
        }
        if flags & 0x20 != 0 {
            def_flags = rd32(&b, o)?;
        }

        let mut next_offset = base;
        for trun in tk.iter().filter(|b| &b.kind == b"trun") {
            let b = read_body(f, trun).map_err(ioe)?;
            let ver = b.first().copied().unwrap_or(0);
            let flags = rd32(&b, 0)? & 0x00ff_ffff;
            let count = rd32(&b, 4)? as usize;
            if count > MAX_SAMPLES {
                return Err("damaged file (too many samples in a fragment)".into());
            }
            let mut o = 8;
            let mut cursor = next_offset;
            if flags & 0x1 != 0 {
                cursor = (base as i64 + rd32(&b, o)? as i32 as i64) as u64;
                o += 4;
            }
            let mut first_flags = None;
            if flags & 0x4 != 0 {
                first_flags = Some(rd32(&b, o)?);
                o += 4;
            }
            for i in 0..count {
                let mut duration = def_dur;
                let mut size = def_size;
                let mut sflags = if i == 0 { first_flags.unwrap_or(def_flags) } else { def_flags };
                let mut cts = 0i32;
                if flags & 0x100 != 0 {
                    duration = rd32(&b, o)?;
                    o += 4;
                }
                if flags & 0x200 != 0 {
                    size = rd32(&b, o)?;
                    o += 4;
                }
                if flags & 0x400 != 0 {
                    sflags = rd32(&b, o)?;
                    o += 4;
                }
                if flags & 0x800 != 0 {
                    cts = rd32(&b, o)? as i32; // v0 is unsigned but values fit in i32 in practice
                    o += 4;
                }
                let _ = ver;
                out.push(Sample { offset: cursor, size, duration, cts_offset: cts, sync: sflags & 0x1_0000 == 0 });
                cursor += size as u64;
            }
            next_offset = cursor;
        }
    }
    Ok(())
}

/// Samples from the regular sample tables (empty for purely fragmented files).
fn read_flat(f: &mut File, stbl: &[BoxHeader]) -> Result<Vec<Sample>, String> {
    let Some(stsz_h) = find(stbl, b"stsz") else { return Ok(vec![]) };
    let stsz = read_body(f, &stsz_h).map_err(ioe)?;
    let const_size = rd32(&stsz, 4)?;
    let count = rd32(&stsz, 8)? as usize;
    if count == 0 {
        return Ok(vec![]);
    }
    if count > MAX_SAMPLES {
        return Err("file has too many samples".into());
    }
    let mut sizes = Vec::with_capacity(count);
    for i in 0..count {
        sizes.push(if const_size != 0 { const_size } else { rd32(&stsz, 12 + i * 4)? });
    }

    // Durations.
    let mut durations = Vec::with_capacity(count);
    if let Some(h) = find(stbl, b"stts") {
        let b = read_body(f, &h).map_err(ioe)?;
        for i in 0..rd32(&b, 4)? as usize {
            let n = rd32(&b, 8 + i * 8)? as usize;
            let d = rd32(&b, 12 + i * 8)?;
            if durations.len() + n > count {
                break;
            }
            durations.extend(std::iter::repeat(d).take(n));
        }
    }
    durations.resize(count, 0);

    // Composition offsets.
    let mut cts = vec![0i32; count];
    if let Some(h) = find(stbl, b"ctts") {
        let b = read_body(f, &h).map_err(ioe)?;
        let mut idx = 0;
        for i in 0..rd32(&b, 4)? as usize {
            let n = rd32(&b, 8 + i * 8)? as usize;
            let v = rd32(&b, 12 + i * 8)? as i32;
            for _ in 0..n {
                if idx < count {
                    cts[idx] = v;
                    idx += 1;
                }
            }
        }
    }

    // Sync samples.
    let mut sync = vec![true; count];
    if let Some(h) = find(stbl, b"stss") {
        let b = read_body(f, &h).map_err(ioe)?;
        sync = vec![false; count];
        for i in 0..rd32(&b, 4)? as usize {
            let n = rd32(&b, 8 + i * 4)? as usize;
            if n >= 1 && n <= count {
                sync[n - 1] = true;
            }
        }
    }

    // Chunk layout.
    let stsc = read_body(f, &find(stbl, b"stsc").ok_or("damaged file (no 'stsc')")?).map_err(ioe)?;
    let mut runs = Vec::new(); // (first_chunk, samples_per_chunk)
    for i in 0..rd32(&stsc, 4)? as usize {
        runs.push((rd32(&stsc, 8 + i * 12)? as usize, rd32(&stsc, 12 + i * 12)? as usize));
    }
    let mut chunk_offsets: Vec<u64> = Vec::new();
    if let Some(h) = find(stbl, b"stco") {
        let b = read_body(f, &h).map_err(ioe)?;
        for i in 0..rd32(&b, 4)? as usize {
            chunk_offsets.push(rd32(&b, 8 + i * 4)? as u64);
        }
    } else if let Some(h) = find(stbl, b"co64") {
        let b = read_body(f, &h).map_err(ioe)?;
        for i in 0..rd32(&b, 4)? as usize {
            chunk_offsets.push(rd64(&b, 8 + i * 8)?);
        }
    } else {
        return Err("damaged file (no chunk offsets)".into());
    }

    let mut out = Vec::with_capacity(count);
    let mut idx = 0usize;
    for (ci, &chunk_off) in chunk_offsets.iter().enumerate() {
        let chunk_no = ci + 1;
        let spc = runs.iter().rev().find(|(first, _)| *first <= chunk_no).map(|r| r.1).unwrap_or(0);
        let mut off = chunk_off;
        for _ in 0..spc {
            if idx >= count {
                break;
            }
            out.push(Sample { offset: off, size: sizes[idx], duration: durations[idx], cts_offset: cts[idx], sync: sync[idx] });
            off += sizes[idx] as u64;
            idx += 1;
        }
    }
    if idx != count {
        return Err("damaged file (sample tables disagree)".into());
    }
    Ok(out)
}
