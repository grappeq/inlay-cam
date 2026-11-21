//! The binary form of DXF: the same group codes and values as the text form,
//! written as numbers and zero-ended strings. Read into the text form's
//! pairs, so that one reader serves both.
//!
//! Each value's type follows from its group code, as the DXF reference
//! gives them. Files of AutoCAD R12 and before give a group code in one
//! byte (255 for a longer one that follows in two), later files in two.

/// What every binary DXF file starts with.
pub const SENTINEL: &[u8] = b"AutoCAD Binary DXF\r\n\x1a\x00";

enum Kind {
    Text,
    Double,
    Int16,
    Int32,
    Int64,
    Byte,
    Chunk,
}

fn kind(code: i32) -> Kind {
    match code {
        310..=319 | 1004 => Kind::Chunk,
        290..=299 => Kind::Byte,
        60..=79 | 170..=179 | 270..=289 | 370..=389 | 400..=409 | 1060..=1070 => Kind::Int16,
        90..=99 | 420..=429 | 440..=459 | 1071 => Kind::Int32,
        160..=169 => Kind::Int64,
        10..=59 | 110..=149 | 210..=239 | 460..=469 | 1010..=1059 => Kind::Double,
        _ => Kind::Text,
    }
}

/// The value of a `$` header variable that is a text, as a first look
/// before the file is read: the version and the code page.
fn header_text(bytes: &[u8], name: &[u8]) -> Option<String> {
    let head = &bytes[..bytes.len().min(2048)];
    let at = head.windows(name.len()).position(|w| w == name)? + name.len() + 1;
    // After the name's zero come the group code (one or two bytes) and the value.
    let start = (at..at + 3).find(|&i| head.get(i).is_some_and(|b| b.is_ascii_alphabetic()))?;
    let end = head[start..].iter().position(|&b| b == 0)? + start;
    String::from_utf8(head[start..end].to_vec()).ok()
}

/// Windows-1252, the code page of most DXF files before AutoCAD 2007.
fn cp1252(bytes: &[u8]) -> String {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž',
        '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}',
        'ž', 'Ÿ',
    ];
    bytes
        .iter()
        .map(|&b| match b {
            0x80..=0x9f => HIGH[(b - 0x80) as usize],
            _ => b as char,
        })
        .collect()
}

/// The group codes and values of a binary DXF file, as the text form would
/// have them.
pub fn groups(bytes: &[u8]) -> Result<Vec<(i32, String)>, String> {
    let broken = || "The binary DXF file is cut short or damaged.".to_string();
    if !bytes.starts_with(SENTINEL) {
        return Err("This is not a binary DXF file.".into());
    }
    let version = header_text(bytes, b"$ACADVER").unwrap_or_else(|| "AC1009".into());
    let short_codes = version.as_str() <= "AC1009";
    let utf8 = version.as_str() >= "AC1021";
    let take = |at: &mut usize, n: usize| -> Result<&[u8], String> {
        let slice = bytes.get(*at..*at + n).ok_or_else(broken)?;
        *at += n;
        Ok(slice)
    };
    let mut out = Vec::new();
    let mut at = SENTINEL.len();
    while at < bytes.len() {
        let code = if short_codes {
            match take(&mut at, 1)?[0] {
                255 => i16::from_le_bytes(take(&mut at, 2)?.try_into().unwrap()) as i32,
                code => code as i32,
            }
        } else {
            i16::from_le_bytes(take(&mut at, 2)?.try_into().unwrap()) as i32
        };
        let value = match kind(code) {
            Kind::Chunk => {
                let n = take(&mut at, 1)?[0] as usize;
                take(&mut at, n)?
                    .iter()
                    .map(|b| format!("{b:02X}"))
                    .collect()
            }
            Kind::Byte => take(&mut at, 1)?[0].to_string(),
            Kind::Int16 => i16::from_le_bytes(take(&mut at, 2)?.try_into().unwrap()).to_string(),
            Kind::Int32 => i32::from_le_bytes(take(&mut at, 4)?.try_into().unwrap()).to_string(),
            Kind::Int64 => i64::from_le_bytes(take(&mut at, 8)?.try_into().unwrap()).to_string(),
            Kind::Double => f64::from_le_bytes(take(&mut at, 8)?.try_into().unwrap()).to_string(),
            Kind::Text => {
                let n = bytes[at..]
                    .iter()
                    .position(|&b| b == 0)
                    .ok_or_else(broken)?;
                let text = take(&mut at, n)?;
                at += 1;
                if utf8 {
                    String::from_utf8_lossy(text).into_owned()
                } else {
                    cp1252(text)
                }
            }
        };
        let end = code == 0 && value == "EOF";
        out.push((code, value));
        if end {
            break;
        }
    }
    Ok(out)
}
