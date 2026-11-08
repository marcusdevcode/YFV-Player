//! ISO-BMFF box reading/writing helpers.

use std::io::{self, Read, Seek, SeekFrom};

pub type Fourcc = [u8; 4];

#[derive(Clone, Copy, Debug)]
pub struct BoxHeader {
    pub kind: Fourcc,
    pub start: u64,
    pub header_len: u64,
    /// Total size including the header.
    pub size: u64,
}

impl BoxHeader {
    pub fn body_start(&self) -> u64 {
        self.start + self.header_len
    }
    pub fn end(&self) -> u64 {
        self.start + self.size
    }
    pub fn body_len(&self) -> u64 {
        self.size - self.header_len
    }
}

pub fn read_header<R: Read + Seek>(r: &mut R, pos: u64, limit: u64) -> io::Result<Option<BoxHeader>> {
    if pos + 8 > limit {
        return Ok(None);
    }
    r.seek(SeekFrom::Start(pos))?;
    let mut h = [0u8; 8];
    r.read_exact(&mut h)?;
    let size32 = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as u64;
    let kind = [h[4], h[5], h[6], h[7]];
    let (header_len, size) = match size32 {
        1 => {
            let mut b = [0u8; 8];
            r.read_exact(&mut b)?;
            (16, u64::from_be_bytes(b))
        }
        0 => (8, limit - pos),
        n => (8, n),
    };
    if size < header_len {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid box size"));
    }
    Ok(Some(BoxHeader { kind, start: pos, header_len, size: size.min(limit - pos) }))
}

/// Headers of all boxes directly inside `[start, end)`.
pub fn children<R: Read + Seek>(r: &mut R, start: u64, end: u64) -> io::Result<Vec<BoxHeader>> {
    let mut out = Vec::new();
    let mut pos = start;
    while let Some(h) = read_header(r, pos, end)? {
        pos = h.end();
        out.push(h);
    }
    Ok(out)
}

pub fn find(list: &[BoxHeader], kind: &[u8; 4]) -> Option<BoxHeader> {
    list.iter().find(|b| &b.kind == kind).copied()
}

const MAX_BODY: u64 = 512 << 20;

pub fn read_body<R: Read + Seek>(r: &mut R, h: &BoxHeader) -> io::Result<Vec<u8>> {
    if h.body_len() > MAX_BODY {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "box too large"));
    }
    r.seek(SeekFrom::Start(h.body_start()))?;
    let mut v = vec![0u8; h.body_len() as usize];
    r.read_exact(&mut v)?;
    Ok(v)
}

/// The whole box including its header.
pub fn read_whole<R: Read + Seek>(r: &mut R, h: &BoxHeader) -> io::Result<Vec<u8>> {
    if h.size > MAX_BODY {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "box too large"));
    }
    r.seek(SeekFrom::Start(h.start))?;
    let mut v = vec![0u8; h.size as usize];
    r.read_exact(&mut v)?;
    Ok(v)
}

fn short() -> String {
    "damaged file (a box is too short)".to_string()
}

pub fn rd32(b: &[u8], o: usize) -> Result<u32, String> {
    b.get(o..o + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(short)
}
pub fn rd64(b: &[u8], o: usize) -> Result<u64, String> {
    b.get(o..o + 8)
        .map(|s| u64::from_be_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
        .ok_or_else(short)
}

// ---- writing ----

pub trait Put {
    fn p16(&mut self, v: u16);
    fn p32(&mut self, v: u32);
    fn p64(&mut self, v: u64);
}
impl Put for Vec<u8> {
    fn p16(&mut self, v: u16) {
        self.extend_from_slice(&v.to_be_bytes());
    }
    fn p32(&mut self, v: u32) {
        self.extend_from_slice(&v.to_be_bytes());
    }
    fn p64(&mut self, v: u64) {
        self.extend_from_slice(&v.to_be_bytes());
    }
}

/// A box: size + type + body.
pub fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(8 + body.len());
    v.p32((8 + body.len()) as u32);
    v.extend_from_slice(kind);
    v.extend_from_slice(body);
    v
}

/// A "full box": version + 24-bit flags + body.
pub fn fbx(kind: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(4 + body.len());
    b.push(version);
    b.extend_from_slice(&flags.to_be_bytes()[1..]);
    b.extend_from_slice(body);
    bx(kind, &b)
}
