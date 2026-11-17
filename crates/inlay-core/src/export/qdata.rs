//! The few pieces of Qt's `QDataStream` that a `.tlslibrary` is made of,
//! all big-endian: unsigned 32-bit numbers, doubles, one-byte truth values,
//! and strings as a byte length followed by UTF-16 text, where a length of
//! `0xFFFFFFFF` is a null string.

const NULL_LENGTH: u32 = 0xFFFF_FFFF;

#[derive(Default)]
pub struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    pub fn raw(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    pub fn u32(&mut self, value: u32) {
        self.buf.extend_from_slice(&value.to_be_bytes());
    }

    pub fn count(&mut self, value: usize) {
        self.u32(value as u32);
    }

    pub fn f64(&mut self, value: f64) {
        self.buf.extend_from_slice(&value.to_be_bytes());
    }

    pub fn bool(&mut self, value: bool) {
        self.buf.push(u8::from(value));
    }

    pub fn string(&mut self, value: Option<&str>) {
        match value {
            None => self.u32(NULL_LENGTH),
            Some(text) => {
                let units: Vec<u16> = text.encode_utf16().collect();
                self.u32(units.len() as u32 * 2);
                for unit in units {
                    self.buf.extend_from_slice(&unit.to_be_bytes());
                }
            }
        }
    }

    pub fn finish(self) -> Vec<u8> {
        self.buf
    }
}

pub struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
    /// How many records all counts together may still announce, so that a
    /// file claiming millions of entries fails at once.
    records_left: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8], max_records: usize) -> Self {
        Reader {
            data,
            pos: 0,
            records_left: max_records,
        }
    }

    pub fn raw(&mut self, n: usize) -> Result<&'a [u8], String> {
        if n > self.data.len() - self.pos {
            return Err(format!(
                "unexpected end of data reading {n} bytes at offset {}",
                self.pos
            ));
        }
        let chunk = &self.data[self.pos..self.pos + n];
        self.pos += n;
        Ok(chunk)
    }

    pub fn u32(&mut self) -> Result<u32, String> {
        let bytes = self.raw(4)?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    /// A record count, charged against the reader's budget.
    pub fn count(&mut self) -> Result<usize, String> {
        let start = self.pos;
        let n = self.u32()? as usize;
        if n > self.records_left {
            return Err(format!("too many records (count {n} at offset {start})"));
        }
        self.records_left -= n;
        Ok(n)
    }

    pub fn f64(&mut self) -> Result<f64, String> {
        let bytes = self.raw(8)?;
        let mut eight = [0u8; 8];
        eight.copy_from_slice(bytes);
        Ok(f64::from_be_bytes(eight))
    }

    pub fn bool(&mut self) -> Result<bool, String> {
        Ok(self.raw(1)?[0] != 0)
    }

    pub fn string(&mut self) -> Result<Option<String>, String> {
        let start = self.pos;
        let n = self.u32()?;
        if n == NULL_LENGTH {
            return Ok(None);
        }
        if n % 2 == 1 {
            return Err(format!("odd text length {n} at offset {start}"));
        }
        let bytes = self.raw(n as usize)?;
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&units)
            .map(Some)
            .map_err(|_| format!("text that is not UTF-16 at offset {start}"))
    }

    pub fn expect_end(&self) -> Result<(), String> {
        if self.pos == self.data.len() {
            Ok(())
        } else {
            Err(format!(
                "{} trailing bytes at offset {}",
                self.data.len() - self.pos,
                self.pos
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_is_written_reads_back() {
        let mut w = Writer::default();
        w.u32(13);
        w.f64(3.175);
        w.bool(true);
        w.string(Some("Ø6×18"));
        w.string(None);
        w.string(Some(""));
        let bytes = w.finish();
        assert_eq!(&bytes[..4], &[0, 0, 0, 13]);
        let mut r = Reader::new(&bytes, 100);
        assert_eq!(r.count(), Ok(13));
        assert_eq!(r.f64(), Ok(3.175));
        assert_eq!(r.bool(), Ok(true));
        assert_eq!(r.string(), Ok(Some("Ø6×18".to_string())));
        assert_eq!(r.string(), Ok(None));
        assert_eq!(r.string(), Ok(Some(String::new())));
        assert_eq!(r.expect_end(), Ok(()));
    }

    #[test]
    fn a_broken_stream_is_refused() {
        // A count beyond the budget, a text of odd length, and data that ends early.
        assert!(Reader::new(&[0, 0, 1, 0], 100).count().is_err());
        assert!(Reader::new(&[0, 0, 0, 3, 0, 65, 0], 100).string().is_err());
        assert!(Reader::new(&[0, 0], 100).u32().is_err());
        assert!(Reader::new(&[0, 0, 0, 1, 9], 100).expect_end().is_err());
    }
}
