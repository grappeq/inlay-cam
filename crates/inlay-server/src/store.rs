//! The data folder: the tool file, read, written whole, and backed up before
//! a write; the projects; and the settings.
//!
//! The folder holds `tools.json`, a tool-library file as the app writes it,
//! and `backups/` with the file as it was before each write that changed
//! it. `projects/` holds one project file per project, named by its id, in
//! the folders the user files them in: a folder of the app is a folder
//! there, and a project is moved by renaming its file. `settings.json`
//! holds what the app keeps besides: one text per key. A write goes to a
//! temporary file that is then renamed over the file it replaces, so a
//! reader or a file-level backup never sees half a file.

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

/// How deep folders go: `a/b/c/d` is the deepest.
pub const MAX_FOLDER_DEPTH: usize = 4;
/// Characters in one folder's name.
pub const MAX_FOLDER_NAME: usize = 60;

/// A project as it is kept.
pub struct Kept {
    pub id: String,
    /// The folder it is filed in, with `/` between nested ones; empty for
    /// a project in none.
    pub folder: String,
    /// Project file text.
    pub text: String,
    /// When it was written, in milliseconds since 1970.
    pub modified: u64,
}

/// What is under `projects/`: the folders, and the project files as
/// (folder, id).
type Walked = (Vec<String>, Vec<(String, String)>);

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
        // The write is done: a backup that cannot be thinned is no reason
        // to call it failed.
        let _ = self.prune(&backup);
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

    /// The folder on disk for a folder of the app; `projects/` itself for
    /// the empty path.
    fn folder_dir(&self, folder: &str) -> PathBuf {
        let mut dir = self.dir.join(PROJECTS);
        for name in folder.split('/').filter(|name| !name.is_empty()) {
            dir.push(name);
        }
        dir
    }

    fn project_path(&self, folder: &str, id: &str) -> PathBuf {
        self.folder_dir(folder).join(format!("{id}.json"))
    }

    /// Every folder under `projects/`, a folder before the ones in it, and
    /// every project file as its folder and id. Files come before folders
    /// and both in the order of their names, so that of two files with one
    /// id (one copied by hand) the same one is found every time. What is
    /// not a project file or a folder the app could have made is passed
    /// over: a link, a name that is not UTF-8, and a folder that cannot
    /// be read as well, so that one of those does not hide all the rest.
    fn walk(&self) -> io::Result<Walked> {
        fn into(
            dir: &Path,
            folder: &str,
            depth: usize,
            folders: &mut Vec<String>,
            files: &mut Vec<(String, String)>,
        ) -> io::Result<()> {
            let mut inner = Vec::new();
            let mut ids = Vec::new();
            let entries = match fs::read_dir(dir) {
                Ok(entries) => entries,
                Err(_) if depth > 0 => return Ok(()),
                Err(e) => return Err(e),
            };
            for entry in entries.flatten() {
                let name = entry.file_name();
                let (Some(name), Ok(kind)) = (name.to_str(), entry.file_type()) else {
                    continue;
                };
                if kind.is_dir() {
                    if depth < MAX_FOLDER_DEPTH && is_folder_name(name) {
                        inner.push(name.to_string());
                    }
                } else if kind.is_file() {
                    if let Some(id) = name.strip_suffix(".json").filter(|id| is_project_id(id)) {
                        ids.push(id.to_string());
                    }
                }
            }
            ids.sort();
            inner.sort();
            files.extend(ids.into_iter().map(|id| (folder.to_string(), id)));
            for name in inner {
                let path = if folder.is_empty() {
                    name.clone()
                } else {
                    format!("{folder}/{name}")
                };
                folders.push(path.clone());
                into(&dir.join(&name), &path, depth + 1, folders, files)?;
            }
            Ok(())
        }
        let (mut folders, mut files) = (Vec::new(), Vec::new());
        into(&self.dir.join(PROJECTS), "", 0, &mut folders, &mut files)?;
        let mut seen = std::collections::HashSet::new();
        files.retain(|(_, id)| seen.insert(id.clone()));
        Ok((folders, files))
    }

    /// The folder a project's file is in; `None` for an id no project has.
    fn locate(&self, id: &str) -> io::Result<Option<String>> {
        if self.project_path("", id).is_file() {
            return Ok(Some(String::new()));
        }
        let (_, files) = self.walk()?;
        Ok(files
            .into_iter()
            .find(|(_, other)| other == id)
            .map(|(folder, _)| folder))
    }

    /// A folder path as it is on disk: a folder that is there under a name
    /// that differs only in case is the one meant, since on some systems
    /// the two are one folder and on others they would be two that look
    /// alike. Names that are not there stay as given. `InvalidInput` when
    /// one of the names is there as something other than a folder: through
    /// a link a project would leave `projects/`.
    fn resolve(&self, folder: &str) -> io::Result<String> {
        let mut dir = self.dir.join(PROJECTS);
        let mut out: Vec<String> = Vec::new();
        for name in folder.split('/').filter(|name| !name.is_empty()) {
            let mut found = name.to_string();
            if dir.is_dir() {
                let mut same: Vec<String> = Vec::new();
                for entry in fs::read_dir(&dir)?.flatten() {
                    let other = entry.file_name();
                    let (Some(other), Ok(kind)) = (other.to_str(), entry.file_type()) else {
                        continue;
                    };
                    if kind.is_dir() && other.to_lowercase() == name.to_lowercase() {
                        same.push(other.to_string());
                    }
                }
                same.sort();
                if !same.iter().any(|other| other == name) {
                    if let Some(other) = same.into_iter().next() {
                        found = other;
                    }
                }
            }
            dir.push(&found);
            if fs::symlink_metadata(&dir).is_ok_and(|there| !there.is_dir()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("\"{found}\" is there already, and is not a folder of this app's."),
                ));
            }
            out.push(found);
        }
        Ok(out.join("/"))
    }

    /// The folders, each with `/` between nested ones, in the order of
    /// their names, a folder before the ones in it.
    pub fn folders(&self) -> io::Result<Vec<String>> {
        Ok(self.walk()?.0)
    }

    /// Every project's id, folder, file text and time of writing, in no
    /// order.
    pub fn projects(&self) -> io::Result<Vec<Kept>> {
        let mut out = Vec::new();
        for (folder, id) in self.walk()?.1 {
            if let Some(kept) = self.read_project(&folder, &id)? {
                out.push(kept);
            }
        }
        Ok(out)
    }

    fn read_project(&self, folder: &str, id: &str) -> io::Result<Option<Kept>> {
        let path = self.project_path(folder, id);
        match fs::read_to_string(&path) {
            Ok(text) => Ok(Some(Kept {
                id: id.to_string(),
                folder: folder.to_string(),
                text,
                modified: millis(fs::metadata(&path)?.modified()?),
            })),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// `None` for an id no project has. The id is one `is_project_id` takes.
    pub fn project(&self, id: &str) -> io::Result<Option<Kept>> {
        match self.locate(id)? {
            Some(folder) => self.read_project(&folder, id),
            None => Ok(None),
        }
    }

    /// Writes a project, unless it is there as given already. A project
    /// that is kept stays in the folder it is in; one that is new goes to
    /// `folder`, which is made when it is not there. Gives its time of
    /// writing and the folder it is in. `AlreadyExists` for a new project
    /// whose id differs only in case from one that is kept: on a disk that
    /// takes the two names for one, its file would go over the other's.
    pub fn save_project(&self, id: &str, text: &str, folder: &str) -> io::Result<(u64, String)> {
        let folder = match self.locate(id)? {
            Some(folder) => folder,
            None => {
                let (_, files) = self.walk()?;
                if let Some((_, other)) = files
                    .iter()
                    .find(|(_, other)| other.eq_ignore_ascii_case(id))
                {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        format!("A project \"{other}\" is kept: an id that differs from it only in case cannot be kept beside it."),
                    ));
                }
                let folder = self.resolve(folder)?;
                fs::create_dir_all(self.folder_dir(&folder))?;
                folder
            }
        };
        let path = self.project_path(&folder, id);
        if fs::read(&path).ok().as_deref() != Some(text.as_bytes()) {
            write_whole(&path, text)?;
        }
        Ok((millis(fs::metadata(&path)?.modified()?), folder))
    }

    /// Files a project in another folder, made when it is not there: its
    /// file is renamed, so its text and its time of writing stay. Gives the
    /// folder as it is on disk; `None` for an id no project has.
    pub fn move_project(&self, id: &str, folder: &str) -> io::Result<Option<String>> {
        let Some(from) = self.locate(id)? else {
            return Ok(None);
        };
        let to = self.resolve(folder)?;
        if from == to {
            return Ok(Some(to));
        }
        let target = self.project_path(&to, id);
        if target.exists() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("a file named {id}.json is in that folder already"),
            ));
        }
        fs::create_dir_all(self.folder_dir(&to))?;
        fs::rename(self.project_path(&from, id), target)?;
        Ok(Some(to))
    }

    /// Makes a folder, and the ones it is in. `AlreadyExists` when it is
    /// there, under this name or one that differs only in case.
    pub fn create_folder(&self, folder: &str) -> io::Result<String> {
        let folder = self.resolve(folder)?;
        let dir = self.folder_dir(&folder);
        if dir.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("There is a folder \"{folder}\" already."),
            ));
        }
        fs::create_dir_all(dir)?;
        Ok(folder)
    }

    /// Renames a folder, or moves it into another: `to` is its whole new
    /// path. What is in it goes along. `NotFound` for a folder that is not
    /// there, `AlreadyExists` when `to` is, `InvalidInput` for a move into
    /// itself or one that would nest folders deeper than they go.
    pub fn rename_folder(&self, from: &str, to: &str) -> io::Result<String> {
        let from = self.resolve(from)?;
        let folders = self.folders()?;
        if !folders.contains(&from) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("There is no folder \"{from}\"."),
            ));
        }
        let invalid = |message: &str| io::Error::new(io::ErrorKind::InvalidInput, message);
        let lower = |path: &str| path.to_lowercase();
        if lower(to).starts_with(&format!("{}/", lower(&from))) {
            return Err(invalid("A folder cannot be moved into itself."));
        }
        // The folder's own new name is kept as given, so that a rename can
        // change its case; the folders it goes into are the ones on disk.
        let (parent, name) = to.rsplit_once('/').unwrap_or(("", to));
        let parent = self.resolve(parent)?;
        let to = if parent.is_empty() {
            name.to_string()
        } else {
            format!("{parent}/{name}")
        };
        if from == to {
            return Ok(to);
        }
        let below = folders
            .iter()
            .filter_map(|path| path.strip_prefix(&format!("{from}/")))
            .map(|rest| rest.split('/').count())
            .max()
            .unwrap_or(0);
        if to.split('/').count() + below > MAX_FOLDER_DEPTH {
            return Err(invalid(
                "Folders go four deep: this one holds folders that would end up deeper.",
            ));
        }
        if lower(&from) != lower(&to) && folders.iter().any(|path| lower(path) == lower(&to)) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("There is a folder \"{to}\" already."),
            ));
        }
        fs::create_dir_all(self.folder_dir(&parent))?;
        fs::rename(self.folder_dir(&from), self.folder_dir(&to))?;
        Ok(to)
    }

    /// Takes a folder away, and the folders in it. The projects in them
    /// are not deleted: they are moved out, to no folder. Gives the folder
    /// as it was on disk and how many projects were moved. `NotFound` for
    /// a folder that is not there. A folder that holds something the app
    /// did not put there is left as it is, with its projects where they
    /// are: `DirectoryNotEmpty`. What a system leaves in a folder by
    /// itself (`is_litter`) does not count, and goes with the folder.
    pub fn delete_folder(&self, folder: &str) -> io::Result<(String, usize)> {
        let folder = self.resolve(folder)?;
        let (folders, files) = self.walk()?;
        if !folders.contains(&folder) {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("There is no folder \"{folder}\"."),
            ));
        }
        let within = |path: &str| path == folder || path.starts_with(&format!("{folder}/"));
        let mut inner: Vec<&String> = folders.iter().filter(|path| within(path)).collect();
        // Looked at before anything is moved: everything in the folders
        // must be a project that can go to no folder, a folder that goes
        // too, or litter.
        let going: Vec<PathBuf> = files
            .iter()
            .filter(|(from, id)| within(from) && !self.project_path("", id).exists())
            .map(|(from, id)| self.project_path(from, id))
            .collect();
        let dirs: Vec<PathBuf> = inner.iter().map(|path| self.folder_dir(path)).collect();
        let mut litter = Vec::new();
        for dir in &dirs {
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                let path = entry.path();
                let name = entry.file_name();
                if going.contains(&path) || dirs.contains(&path) {
                    continue;
                }
                if entry.file_type()?.is_file() && name.to_str().is_some_and(is_litter) {
                    litter.push(path);
                    continue;
                }
                return Err(io::Error::new(
                    io::ErrorKind::DirectoryNotEmpty,
                    format!(
                        "The folder \"{folder}\" holds \"{}\", which is not a project of this app. Nothing was changed.",
                        name.to_string_lossy()
                    ),
                ));
            }
        }
        for path in &going {
            let file = path.file_name().expect("a project file has a name");
            fs::rename(path, self.folder_dir("").join(file))?;
        }
        for path in litter {
            fs::remove_file(path)?;
        }
        // The deepest first: a folder is removed only once it is empty.
        inner.sort_by_key(|path| std::cmp::Reverse(path.split('/').count()));
        for path in inner {
            fs::remove_dir(self.folder_dir(path))?;
        }
        Ok((folder, going.len()))
    }

    /// Takes a project off the list. Its file is not destroyed: it is moved
    /// to `backups/`. False for an id no project has.
    pub fn delete_project(&self, id: &str, now: SystemTime) -> io::Result<bool> {
        let Some(folder) = self.locate(id)? else {
            return Ok(false);
        };
        let (y, mo, d, h, mi, s, ms) = civil(now);
        let kept = format!("project-{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}-{ms:03}-{id}.json");
        match fs::rename(
            self.project_path(&folder, id),
            self.dir.join(BACKUPS).join(kept),
        ) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Moves a `settings.json` that cannot be read out of the way, to
    /// `backups/`, so that settings can be kept again.
    pub fn set_settings_aside(&self, now: SystemTime) -> io::Result<()> {
        let (y, mo, d, h, mi, s, ms) = civil(now);
        let kept = format!("settings-{y:04}{mo:02}{d:02}-{h:02}{mi:02}{s:02}-{ms:03}.json");
        fs::rename(self.dir.join(SETTINGS), self.dir.join(BACKUPS).join(kept))
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

    /// Thins the backups, all but the one `just_kept`: with a clock set
    /// back, the newest by name is not the one just made.
    fn prune(&self, just_kept: &str) -> io::Result<()> {
        let names: Vec<String> = self.backups()?.into_iter().map(|b| b.name).collect();
        for name in dropped(&names)
            .into_iter()
            .filter(|n| n.as_str() != just_kept)
        {
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

pub fn millis(at: SystemTime) -> u64 {
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

/// Whether a name can be one folder's: 1 to 60 characters that every file
/// system takes. Not `.` or `..` or anything else that starts with a dot,
/// no `/ \ : * ? " < > |` or control characters, no space at either end,
/// no dot at the end, none of the names Windows keeps for devices, and no
/// character that is not seen or that turns the text around, with which
/// two folders would look like one.
pub fn is_folder_name(name: &str) -> bool {
    const KEPT: [&str; 7] = ["con", "prn", "aux", "nul", "conin$", "conout$", "clock$"];
    // Windows reads a device's name up to the first dot, spaces before it left out.
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_lowercase();
    let numbered = |port: &str| {
        let mut rest = stem.strip_prefix(port).unwrap_or("").chars();
        matches!(
            (rest.next(), rest.next()),
            (Some('1'..='9' | '¹' | '²' | '³'), None)
        )
    };
    let device = KEPT.contains(&stem.as_str()) || numbered("com") || numbered("lpt");
    let unseen = |c: char| matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2069}' | '\u{feff}');
    (1..=MAX_FOLDER_NAME).contains(&name.chars().count())
        && !name.starts_with('.')
        && !name.ends_with('.')
        && name.trim() == name
        && !name
            .chars()
            .any(|c| c.is_control() || unseen(c) || r#"/\:*?"<>|"#.contains(c))
        && !device
}

/// Whether a file is one a system leaves in a folder by itself, or this
/// server left when it was stopped in the middle of a write: nothing a
/// folder has to be kept for.
fn is_litter(name: &str) -> bool {
    [".ds_store", "thumbs.db", "desktop.ini"].contains(&name.to_lowercase().as_str())
        || name.ends_with(".json.writing")
}

/// Whether a path can name a folder: one to four names `is_folder_name`
/// takes, with `/` between them.
pub fn is_folder_path(path: &str) -> bool {
    path.split('/').count() <= MAX_FOLDER_DEPTH && path.split('/').all(is_folder_name)
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
        let written = store.save_project("a-1", "first", "").unwrap();
        // The same text again is not a write.
        assert_eq!(store.save_project("a-1", "first", "").unwrap(), written);
        store.save_project("b_2", "second", "").unwrap();
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
        let moved = scratch
            .0
            .join("backups/project-20261118-091203-000-a-1.json");
        assert_eq!(fs::read_to_string(moved).unwrap(), "first");
        // It is not taken for a backup of the tool file.
        assert!(store.backups().unwrap().is_empty());

        assert!(is_project_id("0b9f6c1e-8a55-4d0b-9d0e-3f3f2a1c7e11"));
        for id in ["", "../x", "a/b", "a.b", &"x".repeat(65)] {
            assert!(!is_project_id(id), "{id}");
        }
    }

    #[test]
    fn a_project_is_filed_in_a_folder_and_moved_without_being_written() {
        let scratch = Scratch::new();
        let store = Store::open(&scratch.0, "one").unwrap();
        // A new project goes to the folder named, which is made for it.
        let (_, folder) = store
            .save_project("a-1", "first", "Gifts/Christmas")
            .unwrap();
        assert_eq!(folder, "Gifts/Christmas");
        assert!(scratch
            .0
            .join("projects/Gifts/Christmas/a-1.json")
            .is_file());
        assert_eq!(store.folders().unwrap(), ["Gifts", "Gifts/Christmas"]);
        let kept = store.project("a-1").unwrap().unwrap();
        assert_eq!(kept.folder, "Gifts/Christmas");
        assert_eq!(kept.text, "first");
        // Kept, it stays where it is whatever folder a later write names.
        let (_, folder) = store.save_project("a-1", "second", "Orders").unwrap();
        assert_eq!(folder, "Gifts/Christmas");
        assert_eq!(store.folders().unwrap(), ["Gifts", "Gifts/Christmas"]);
        assert_eq!(store.projects().unwrap().len(), 1);

        // Moved: the file is renamed, text and time of writing as they were.
        let before = store.project("a-1").unwrap().unwrap().modified;
        assert_eq!(
            store.move_project("a-1", "Orders").unwrap().as_deref(),
            Some("Orders")
        );
        assert!(!scratch.0.join("projects/Gifts/Christmas/a-1.json").exists());
        let kept = store.project("a-1").unwrap().unwrap();
        assert_eq!(kept.folder, "Orders");
        assert_eq!(kept.text, "second");
        assert_eq!(kept.modified, before);
        // To no folder, to where it is already, and an id nobody has.
        assert_eq!(store.move_project("a-1", "").unwrap().as_deref(), Some(""));
        assert_eq!(store.move_project("a-1", "").unwrap().as_deref(), Some(""));
        assert!(scratch.0.join("projects/a-1.json").is_file());
        assert!(store.move_project("zz", "Orders").unwrap().is_none());
        // The folders it left are still there, empty.
        assert_eq!(
            store.folders().unwrap(),
            ["Gifts", "Gifts/Christmas", "Orders"]
        );

        // Deleted from a folder, it goes to the backups like any other.
        store.move_project("a-1", "Gifts").unwrap();
        assert!(store.delete_project("a-1", at(1_794_993_123)).unwrap());
        assert!(scratch
            .0
            .join("backups/project-20261118-091203-000-a-1.json")
            .is_file());
        assert!(store.projects().unwrap().is_empty());
    }

    #[test]
    fn an_id_that_differs_only_in_case_is_not_kept_beside_the_other() {
        let scratch = Scratch::new();
        let store = Store::open(&scratch.0, "one").unwrap();
        store.save_project("a3", "first", "Gifts").unwrap();
        // Wherever it would go: on some disks a3.json and A3.json are one file.
        for folder in ["", "Gifts", "Orders"] {
            let refused = store.save_project("A3", "second", folder).unwrap_err();
            assert_eq!(refused.kind(), io::ErrorKind::AlreadyExists, "{folder}");
        }
        assert_eq!(store.project("a3").unwrap().unwrap().text, "first");
        assert_eq!(store.projects().unwrap().len(), 1);
        assert_eq!(store.folders().unwrap(), ["Gifts"]);
        // The one that is kept is still written.
        store.save_project("a3", "third", "").unwrap();
        assert_eq!(store.project("a3").unwrap().unwrap().text, "third");
    }

    #[test]
    fn a_folder_that_differs_only_in_case_is_the_one_there() {
        let scratch = Scratch::new();
        let store = Store::open(&scratch.0, "one").unwrap();
        assert_eq!(store.create_folder("Gifts").unwrap(), "Gifts");
        for again in ["Gifts", "gifts", "GIFTS"] {
            let refused = store.create_folder(again).unwrap_err();
            assert_eq!(refused.kind(), io::ErrorKind::AlreadyExists, "{again}");
        }
        assert_eq!(
            store.create_folder("gifts/Christmas").unwrap(),
            "Gifts/Christmas"
        );
        let (_, folder) = store
            .save_project("a-1", "first", "GIFTS/christmas")
            .unwrap();
        assert_eq!(folder, "Gifts/Christmas");
        assert_eq!(
            store.move_project("a-1", "gifts").unwrap().as_deref(),
            Some("Gifts")
        );
        assert_eq!(store.folders().unwrap(), ["Gifts", "Gifts/Christmas"]);
    }

    #[test]
    fn a_folder_is_renamed_and_moved_with_what_is_in_it() {
        let scratch = Scratch::new();
        let store = Store::open(&scratch.0, "one").unwrap();
        store
            .save_project("a-1", "first", "Gifts/Christmas")
            .unwrap();
        store.save_project("b-2", "second", "Gifts").unwrap();
        store.create_folder("Orders").unwrap();

        assert_eq!(
            store.rename_folder("Gifts", "Presents").unwrap(),
            "Presents"
        );
        assert_eq!(
            store.folders().unwrap(),
            ["Orders", "Presents", "Presents/Christmas"]
        );
        assert_eq!(
            store.project("a-1").unwrap().unwrap().folder,
            "Presents/Christmas"
        );
        assert_eq!(store.project("b-2").unwrap().unwrap().folder, "Presents");
        // Only its case changed.
        assert_eq!(
            store.rename_folder("Presents", "presents").unwrap(),
            "presents"
        );
        assert_eq!(store.project("b-2").unwrap().unwrap().folder, "presents");
        // Into another folder, named in another case than it has.
        assert_eq!(
            store.rename_folder("presents", "orders/Presents").unwrap(),
            "Orders/Presents"
        );
        assert_eq!(
            store.folders().unwrap(),
            ["Orders", "Orders/Presents", "Orders/Presents/Christmas"]
        );

        let kind = |result: io::Result<String>| result.unwrap_err().kind();
        assert_eq!(
            kind(store.rename_folder("Nothing", "X")),
            io::ErrorKind::NotFound
        );
        assert_eq!(
            kind(store.rename_folder("Orders", "Orders/Presents/Orders")),
            io::ErrorKind::InvalidInput
        );
        store.create_folder("Tests").unwrap();
        assert_eq!(
            kind(store.rename_folder("Tests", "orders")),
            io::ErrorKind::AlreadyExists
        );
        // Four deep is as deep as folders go: under a/b, Orders/Presents/Christmas would be five.
        store.create_folder("a/b").unwrap();
        assert_eq!(
            kind(store.rename_folder("Orders", "a/b/Orders")),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            store.project("a-1").unwrap().unwrap().folder,
            "Orders/Presents/Christmas"
        );
    }

    #[test]
    fn a_deleted_folder_leaves_its_projects_in_no_folder() {
        let scratch = Scratch::new();
        let store = Store::open(&scratch.0, "one").unwrap();
        store
            .save_project("a-1", "first", "Gifts/Christmas")
            .unwrap();
        store.save_project("b-2", "second", "Gifts").unwrap();
        store.save_project("c-3", "third", "Orders").unwrap();
        assert_eq!(
            store.delete_folder("gifts").unwrap(),
            ("Gifts".to_string(), 2)
        );
        assert_eq!(store.folders().unwrap(), ["Orders"]);
        assert_eq!(store.project("a-1").unwrap().unwrap().folder, "");
        assert_eq!(store.project("b-2").unwrap().unwrap().folder, "");
        assert_eq!(store.project("c-3").unwrap().unwrap().folder, "Orders");
        assert!(!scratch.0.join("projects/Gifts").exists());
        assert_eq!(
            store.delete_folder("Gifts").unwrap_err().kind(),
            io::ErrorKind::NotFound
        );

        // A folder with a file of someone else's is left, and the file with it.
        let notes = scratch.0.join("projects/Orders/notes.txt");
        fs::write(&notes, "mine").unwrap();
        store.create_folder("Orders/2026").unwrap();
        assert_eq!(
            store.delete_folder("Orders").unwrap_err().kind(),
            io::ErrorKind::DirectoryNotEmpty
        );
        assert_eq!(fs::read_to_string(&notes).unwrap(), "mine");
        // Nothing of it was done: the project and the folder in it are where they were.
        assert_eq!(store.project("c-3").unwrap().unwrap().folder, "Orders");
        assert_eq!(store.folders().unwrap(), ["Orders", "Orders/2026"]);

        // What a system leaves behind, or a write that was cut short, does not keep a folder.
        fs::remove_file(&notes).unwrap();
        for litter in [".DS_Store", "Thumbs.db", "desktop.ini", "c-3.json.writing"] {
            fs::write(scratch.0.join("projects/Orders").join(litter), "x").unwrap();
        }
        fs::write(scratch.0.join("projects/Orders/2026/.DS_Store"), "x").unwrap();
        assert_eq!(
            store.delete_folder("Orders").unwrap(),
            ("Orders".to_string(), 1)
        );
        assert!(!scratch.0.join("projects/Orders").exists());
        assert_eq!(store.project("c-3").unwrap().unwrap().text, "third");
    }

    #[test]
    fn a_folder_goes_into_folders_that_are_made_for_it() {
        let scratch = Scratch::new();
        let store = Store::open(&scratch.0, "one").unwrap();
        store.save_project("a-1", "first", "Gifts").unwrap();
        assert_eq!(
            store.rename_folder("Gifts", "Years/2026/Gifts").unwrap(),
            "Years/2026/Gifts"
        );
        assert_eq!(
            store.folders().unwrap(),
            ["Years", "Years/2026", "Years/2026/Gifts"]
        );
        assert_eq!(
            store.project("a-1").unwrap().unwrap().folder,
            "Years/2026/Gifts"
        );
    }

    #[test]
    fn a_file_where_a_folder_is_asked_for_is_not_gone_through() {
        let scratch = Scratch::new();
        let store = Store::open(&scratch.0, "one").unwrap();
        fs::write(scratch.0.join("projects/Notes"), "a file").unwrap();
        store.save_project("a-1", "first", "").unwrap();
        let kind = |e: io::Error| e.kind();
        assert_eq!(
            kind(store.create_folder("Notes").unwrap_err()),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            kind(store.create_folder("notes/Inner").unwrap_err()),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            kind(store.move_project("a-1", "Notes").unwrap_err()),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            kind(store.save_project("b-2", "second", "Notes").unwrap_err()),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(store.project("a-1").unwrap().unwrap().folder, "");
        assert!(store.project("b-2").unwrap().is_none());
        assert_eq!(
            fs::read_to_string(scratch.0.join("projects/Notes")).unwrap(),
            "a file"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_link_or_a_name_that_is_not_text_does_not_hide_the_rest() {
        use std::os::unix::ffi::OsStrExt;
        let scratch = Scratch::new();
        let store = Store::open(&scratch.0, "one").unwrap();
        store.save_project("a-1", "first", "Gifts").unwrap();
        let projects = scratch.0.join("projects");
        // A folder whose name is Latin-1, as from an old archive.
        let odd = projects.join(std::ffi::OsStr::from_bytes(b"\xafolw"));
        fs::create_dir(&odd).unwrap();
        fs::write(odd.join("o-1.json"), "odd").unwrap();
        // A link to a folder outside projects/.
        let outside = scratch.0.join("outside");
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, projects.join("Link")).unwrap();

        assert_eq!(store.folders().unwrap(), ["Gifts"]);
        assert_eq!(store.projects().unwrap().len(), 1);
        // Nothing is put through the link.
        for refused in [
            store.create_folder("Link").map(|_| ()),
            store.move_project("a-1", "Link").map(|_| ()),
            store.save_project("b-2", "second", "link").map(|_| ()),
        ] {
            assert_eq!(refused.unwrap_err().kind(), io::ErrorKind::InvalidInput);
        }
        assert!(fs::read_dir(&outside).unwrap().next().is_none());
        assert_eq!(store.project("a-1").unwrap().unwrap().folder, "Gifts");
    }

    #[test]
    fn only_what_the_app_could_have_made_is_listed() {
        let scratch = Scratch::new();
        let store = Store::open(&scratch.0, "one").unwrap();
        let projects = scratch.0.join("projects");
        fs::create_dir_all(projects.join(".hidden")).unwrap();
        fs::create_dir_all(projects.join("a/b/c/d/e")).unwrap();
        fs::write(projects.join(".hidden/h-1.json"), "hidden").unwrap();
        fs::write(projects.join("a/b/c/d/e/deep.json"), "deep").unwrap();
        fs::write(projects.join("a/not a project.json"), "x").unwrap();
        fs::write(projects.join("a/readme.txt"), "x").unwrap();
        // The same id twice, as when a file is copied by hand: one of them, the same every time.
        fs::write(projects.join("twin.json"), "outer").unwrap();
        fs::write(projects.join("a/twin.json"), "inner").unwrap();
        assert_eq!(store.folders().unwrap(), ["a", "a/b", "a/b/c", "a/b/c/d"]);
        let kept = store.projects().unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id, "twin");
        assert_eq!(kept[0].text, "outer");
        assert!(store.project("h-1").unwrap().is_none());
        assert!(store.project("deep").unwrap().is_none());
    }

    #[test]
    fn folder_names_are_ones_every_file_system_takes() {
        let long = "x".repeat(60);
        for name in [
            "Gifts",
            "Test cuts",
            "Zlecenia 2026",
            "Żółw & co",
            "a.b",
            long.as_str(),
        ] {
            assert!(is_folder_name(name), "{name}");
        }
        let longer = "x".repeat(61);
        for name in [
            "",
            ".",
            "..",
            ".git",
            "a/b",
            "a\\b",
            "a:b",
            "a*b",
            "a?b",
            "a\"b",
            "a<b",
            "a>b",
            "a|b",
            " a",
            "a ",
            "a.",
            "a\tb",
            "CON",
            "con",
            "nul.txt",
            "COM1",
            "lpt9",
            longer.as_str(),
            "CON .txt",
            "COM¹",
            "lpt²",
            "CLOCK$",
            "conin$",
            "a\u{200b}b",
            "a\u{202e}b",
            "\u{feff}a",
        ] {
            assert!(!is_folder_name(name), "{name:?}");
        }
        // Not devices: only COM1 to COM9 and LPT1 to LPT9 are.
        for name in ["COM0", "COM10", "console", "lpt"] {
            assert!(is_folder_name(name), "{name}");
        }
        assert!(is_folder_path("a/b/c/d"));
        for path in ["", "a/b/c/d/e", "a//b", "/a", "a/", "a/../b"] {
            assert!(!is_folder_path(path), "{path:?}");
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
