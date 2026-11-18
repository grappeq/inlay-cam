//! The data folder: the tool file, read, written whole, and backed up before
//! a write; the projects; and the settings.
//!
//! The folder holds `tools.json`, a tool-library file as the app writes it,
//! and `backups/` with the file as it was before each write that changed
//! it. `projects/` holds one project file per project, named by its id, and
//! `settings.json` what the app keeps besides: one text per key. A write goes to a temporary file that is then renamed over
//! `tools.json`, so a reader or a file-level backup never sees half a file.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

pub const FILE_NAME: &str = "tools.json";
const BACKUPS: &str = "backups";
const PROJECTS: &str = "projects";
const SETTINGS: &str = "settings.json";
/// The newest backups, all kept.
pub const KEEP_NEWEST: usize = 30;
/// Of the backups older than those: the last of each day, for this many days.
pub const KEEP_DAYS: usize = 60;

pub struct Store {
    dir: PathBuf,
}

/// The tool file as it is on disk.
pub struct Loaded {
    pub text: String,
    /// SHA-256 of the file's bytes, in hex. A write names the token it read.
    pub token: String,
    /// When the file was last written, ISO-8601 UTC.
    pub saved_at: String,
}

pub struct Saved {
    pub token: String,
    pub saved_at: String,
    /// The name of the backup kept of the file before this write. `None`
    /// when the write changed nothing.
    pub backup: Option<String>,
}

/// A project as it is kept.
pub struct Kept {
    pub id: String,
    /// Project file text.
    pub text: String,
    /// When it was written, in milliseconds since 1970.
    pub modified: u64,
}

pub struct Backup {
    pub name: String,
    pub size: u64,
}

pub fn token_of(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl Store {
    /// Opens the data folder, making it and an empty tool file where there
    /// is none. `empty` is the text of a tool file without tools.
    pub fn open(dir: &Path, empty: &str) -> io::Result<Store> {
        fs::create_dir_all(dir.join(BACKUPS))?;
        fs::create_dir_all(dir.join(PROJECTS))?;
        let store = Store {
            dir: dir.to_path_buf(),
        };
        if !store.path().exists() {
            store.replace(empty)?;
        }
        Ok(store)
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    pub fn load(&self) -> io::Result<Loaded> {
        let bytes = fs::read(self.path())?;
        let modified = fs::metadata(self.path())?.modified()?;
        Ok(Loaded {
            token: token_of(&bytes),
            saved_at: iso(modified),
            text: String::from_utf8(bytes).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "tools.json is not UTF-8")
            })?,
        })
    }

    /// Writes `text` as the tool file, keeping a backup of the file it
    /// replaces. The caller holds the lock that makes read, check and write
    /// one step.
    pub fn save(&self, text: &str, now: SystemTime) -> io::Result<Saved> {
        let before = fs::read(self.path())?;
        if before == text.as_bytes() {
            let loaded = self.load()?;
            return Ok(Saved {
                token: loaded.token,
                saved_at: loaded.saved_at,
                backup: None,
            });
        }
        let backup = self.keep_backup(&before, now)?;
        self.replace(text)?;
        self.prune()?;
        let loaded = self.load()?;
        Ok(Saved {
            token: loaded.token,
            saved_at: loaded.saved_at,
            backup: Some(backup),
        })
    }

    fn replace(&self, text: &str) -> io::Result<()> {
        write_whole(&self.path(), text)
    }

    fn project_path(&self, id: &str) -> PathBuf {
        self.dir.join(PROJECTS).join(format!("{id}.json"))
    }

    /// Every project's id, file text and time of writing, in no order.
    pub fn projects(&self) -> io::Result<Vec<Kept>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(self.dir.join(PROJECTS))? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".json").filter(|id| is_project_id(id));
            if let Some(kept) = id.map(|id| self.project(id)).transpose()?.flatten() {
                out.push(kept);
            }
        }
        Ok(out)
    }

    /// `None` for an id no project has. The id is one `is_project_id` takes.
    pub fn project(&self, id: &str) -> io::Result<Option<Kept>> {
        let path = self.project_path(id);
        match fs::read_to_string(&path) {
            Ok(text) => Ok(Some(Kept {
                id: id.to_string(),
                text,
                modified: millis(fs::metadata(&path)?.modified()?),
            })),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Writes a project, unless it is there as given already. Gives its time
    /// of writing.
    pub fn save_project(&self, id: &str, text: &str) -> io::Result<u64> {
        let path = self.project_path(id);
        if fs::read(&path).ok().as_deref() != Some(text.as_bytes()) {
            write_whole(&path, text)?;
        }
        Ok(millis(fs::metadata(&path)?.modified()?))
    }

    /// Takes a project off the list. Its file is not destroyed: it is moved
    /// to `backups/`. False for an id no project has.
    pub fn delete_project(&self, id: &str, now: SystemTime) -> io::Result<bool> {
        let (y, mo, d, h, mi, s, _) = civil(now);
        let kept = format!("project-{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}-{id}.json");
        match fs::rename(self.project_path(id), self.dir.join(BACKUPS).join(kept)) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// The text of `settings.json`; `{}` while there is none.
    pub fn settings(&self) -> io::Result<String> {
        match fs::read_to_string(self.dir.join(SETTINGS)) {
            Ok(text) => Ok(text),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok("{}".into()),
            Err(e) => Err(e),
        }
    }

    pub fn save_settings(&self, text: &str) -> io::Result<()> {
        write_whole(&self.dir.join(SETTINGS), text)
    }

    fn keep_backup(&self, bytes: &[u8], now: SystemTime) -> io::Result<String> {
        let mut at = now;
        loop {
            let name = backup_name(at);
            let path = self.dir.join(BACKUPS).join(&name);
            if path.exists() {
                // Two writes within a millisecond: the name is the order.
                at += Duration::from_millis(1);
                continue;
            }
            fs::write(&path, bytes)?;
            return Ok(name);
        }
    }

    /// Newest first.
    pub fn backups(&self) -> io::Result<Vec<Backup>> {
        let mut out = Vec::new();
        for entry in fs::read_dir(self.dir.join(BACKUPS))? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_backup_name(&name) {
                out.push(Backup {
                    name,
                    size: entry.metadata()?.len(),
                });
            }
        }
        out.sort_by(|a, b| b.name.cmp(&a.name));
        Ok(out)
    }

    /// The text of a backup, by a name `backups` gave. `None` for any other.
    pub fn backup(&self, name: &str) -> io::Result<Option<String>> {
        if !is_backup_name(name) {
            return Ok(None);
        }
        match fs::read_to_string(self.dir.join(BACKUPS).join(name)) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn prune(&self) -> io::Result<()> {
        let names: Vec<String> = self.backups()?.into_iter().map(|b| b.name).collect();
        for name in dropped(&names) {
            fs::remove_file(self.dir.join(BACKUPS).join(name))?;
        }
        Ok(())
    }
}

/// Writes a file whole: to a temporary file beside it, renamed over it.
fn write_whole(path: &Path, text: &str) -> io::Result<()> {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".writing");
    let mut file = fs::File::create(&temporary)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, path)
}

fn millis(at: SystemTime) -> u64 {
    at.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Whether an id can name a project's file: 1 to 64 letters, digits, `-`
/// or `_`, as the app's own ids are.
pub fn is_project_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Of backup names, newest first, the ones that are not kept.
fn dropped(names: &[String]) -> Vec<&String> {
    let mut days: Vec<&str> = Vec::new();
    let mut out = Vec::new();
    for name in names.iter().skip(KEEP_NEWEST) {
        let day = &name[6..14];
        if days.last() == Some(&day) || days.len() == KEEP_DAYS {
            out.push(name);
        } else {
            days.push(day);
        }
    }
    out
}

/// `tools-YYYYMMDD-HHMMSS-mmm.json`, UTC: names sort in the order of time.
fn backup_name(at: SystemTime) -> String {
    let (y, mo, d, h, mi, s, ms) = civil(at);
    format!("tools-{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}-{ms:03}.json")
}

fn is_backup_name(name: &str) -> bool {
    let shape = b"tools-dddddddd-dddddd-ddd.json";
    name.len() == shape.len()
        && name.bytes().zip(shape).all(|(b, s)| match s {
            b'd' => b.is_ascii_digit(),
            _ => b == *s,
        })
}

/// ISO-8601 UTC to the second, as `2026-11-18T09:12:03Z`.
pub fn iso(at: SystemTime) -> String {
    let (y, mo, d, h, mi, s, _) = civil(at);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Year, month, day, hour, minute, second and millisecond of a time, UTC.
fn civil(at: SystemTime) -> (i64, i64, i64, i64, i64, i64, i64) {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since.as_secs() as i64;
    let (days, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Days to a date in the Gregorian calendar, counting in 400-year eras
    // from 1 March of year 0.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (
        year,
        month,
        day,
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60,
        i64::from(since.subsec_millis()),
    )
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A fresh folder under the system's temporary one, removed when dropped.
    pub struct Scratch(pub PathBuf);

    impl Scratch {
        pub fn new() -> Scratch {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "inlay-server-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn times_are_written_in_utc() {
        assert_eq!(iso(at(0)), "1970-01-01T00:00:00Z");
        // 2026-11-18 09:12:03 UTC.
        assert_eq!(iso(at(1_794_993_123)), "2026-11-18T09:12:03Z");
        // The last second of a leap day, and the first after it.
        assert_eq!(iso(at(1_709_251_199)), "2024-02-29T23:59:59Z");
        assert_eq!(iso(at(1_709_251_200)), "2024-03-01T00:00:00Z");
        assert_eq!(
            backup_name(at(1_794_993_123) + Duration::from_millis(7)),
            "tools-20261118-091203-007.json"
        );
    }

    #[test]
    fn a_new_folder_gets_the_empty_file() {
        let scratch = Scratch::new();
        let store = Store::open(&scratch.0.join("data"), "{}").unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.text, "{}");
        assert_eq!(loaded.token, token_of(b"{}"));
        // Opened again, the file is left as it is.
        store.save("{\"a\":1}", at(10)).unwrap();
        let again = Store::open(&scratch.0.join("data"), "{}").unwrap();
        assert_eq!(again.load().unwrap().text, "{\"a\":1}");
    }

    #[test]
    fn a_write_keeps_the_file_it_replaces() {
        let scratch = Scratch::new();
        let store = Store::open(&scratch.0, "one").unwrap();
        let saved = store.save("two", at(1_794_993_123)).unwrap();
        assert_eq!(saved.token, token_of(b"two"));
        assert_eq!(
            saved.backup.as_deref(),
            Some("tools-20261118-091203-000.json")
        );
        assert_eq!(
            store
                .backup("tools-20261118-091203-000.json")
                .unwrap()
                .as_deref(),
            Some("one")
        );
        // The same second again: a name of its own, and the newer one first.
        let next = store.save("three", at(1_794_993_123)).unwrap();
        assert_eq!(
            next.backup.as_deref(),
            Some("tools-20261118-091203-001.json")
        );
        let names: Vec<String> = store
            .backups()
            .unwrap()
            .into_iter()
            .map(|b| b.name)
            .collect();
        assert_eq!(
            names,
            [
                "tools-20261118-091203-001.json",
                "tools-20261118-091203-000.json"
            ]
        );
    }

    #[test]
    fn a_write_that_changes_nothing_keeps_no_backup() {
        let scratch = Scratch::new();
        let store = Store::open(&scratch.0, "one").unwrap();
        let saved = store.save("one", at(5)).unwrap();
        assert!(saved.backup.is_none());
        assert_eq!(saved.token, token_of(b"one"));
        assert!(store.backups().unwrap().is_empty());
    }

    #[test]
    fn projects_are_kept_by_id_and_a_deleted_one_is_moved_away() {
        let scratch = Scratch::new();
        let store = Store::open(&scratch.0, "one").unwrap();
        assert!(store.projects().unwrap().is_empty());
        let written = store.save_project("a-1", "first").unwrap();
        // The same text again is not a write.
        assert_eq!(store.save_project("a-1", "first").unwrap(), written);
        store.save_project("b_2", "second").unwrap();
        let mut ids: Vec<String> = store
            .projects()
            .unwrap()
            .into_iter()
            .map(|p| p.id)
            .collect();
        ids.sort();
        assert_eq!(ids, ["a-1", "b_2"]);
        assert_eq!(store.project("a-1").unwrap().unwrap().text, "first");
        assert!(store.project("c").unwrap().is_none());

        assert!(store.delete_project("a-1", at(1_794_993_123)).unwrap());
        assert!(!store.delete_project("a-1", at(1_794_993_123)).unwrap());
        assert!(store.project("a-1").unwrap().is_none());
        let moved = scratch.0.join("backups/project-20261118-091203-a-1.json");
        assert_eq!(fs::read_to_string(moved).unwrap(), "first");
        // It is not taken for a backup of the tool file.
        assert!(store.backups().unwrap().is_empty());

        assert!(is_project_id("0b9f6c1e-8a55-4d0b-9d0e-3f3f2a1c7e11"));
        for id in ["", "../x", "a/b", "a.b", &"x".repeat(65)] {
            assert!(!is_project_id(id), "{id}");
        }
    }

    #[test]
    fn settings_are_an_empty_object_until_written() {
        let scratch = Scratch::new();
        let store = Store::open(&scratch.0, "one").unwrap();
        assert_eq!(store.settings().unwrap(), "{}");
        store.save_settings("{\"machine\":\"x\"}").unwrap();
        assert_eq!(store.settings().unwrap(), "{\"machine\":\"x\"}");
    }

    #[test]
    fn only_a_backup_is_read_by_name() {
        let scratch = Scratch::new();
        let store = Store::open(&scratch.0, "one").unwrap();
        assert!(store.backup("../tools.json").unwrap().is_none());
        assert!(store
            .backup("tools-20261118-091203-000.json")
            .unwrap()
            .is_none());
    }

    #[test]
    fn old_backups_thin_out_to_one_a_day() {
        // Three days of forty backups each, newest first.
        let names: Vec<String> = (0..120)
            .map(|i| {
                format!(
                    "tools-202611{:02}-0000{:02}-000.json",
                    18 - i / 40,
                    59 - i % 40
                )
            })
            .collect();
        let gone = dropped(&names);
        // The newest 30 stay, all of the 18th. Of the rest, the newest of
        // each day: the 18th's 31st, and the first of the 17th and the 16th.
        assert_eq!(gone.len(), 120 - 30 - 3);
        assert!(!gone.contains(&&names[29]));
        assert!(!gone.contains(&&names[30]));
        assert!(gone.contains(&&names[31]));
        assert!(!gone.contains(&&names[40]));
        assert!(!gone.contains(&&names[80]));
        assert!(gone.contains(&&names[119]));
    }

    #[test]
    fn no_more_days_are_kept_than_the_limit() {
        // One backup a day for 100 days.
        let names: Vec<String> = (0..100)
            .map(|i| format!("tools-2026{:04}-000000-000.json", 9999 - i))
            .collect();
        assert_eq!(dropped(&names).len(), 100 - KEEP_NEWEST - KEEP_DAYS);
    }
}
