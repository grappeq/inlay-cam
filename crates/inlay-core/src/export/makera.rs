//! The tool libraries of Makera CAM and Makera Studio: how their
//! `.tlslibrary` files are laid out, and how a tool list is turned into one.
//!
//! Both are dumps of Qt's `QDataStream` with no header, compression or
//! checksum. The layouts were decoded from one export of each app:
//!
//! ```text
//! Makera CAM                              Makera Studio
//! u32 group count, text header (null)     u32 group count
//! group: id, name, parent id, tools       group: id, name, parent id, tools
//! tool:  id, name, u32 number, u32 type,  tool:  id, name, u32 number, u32 type,
//!        8 doubles, settings                     13 doubles, u32 (1), settings
//! setting: id, material id and name,      setting: id, material id and name,
//!        u32 rpm, feed, plunge,                  u32 rpm, feed, plunge,
//!        double stepover %, stepdown,            double stepover %, mm, stepdown,
//!        u32 flag, text extra                    5 bytes (0), text modified
//! material: id, category id, name,        material: id, id, category id, name,
//!        text thumbnail, u32 (123)               text modified, bool builtin
//! ```

use serde::{Deserialize, Serialize};

use super::qdata::{Reader, Writer};
use super::{effective_rows, quoted, shown, stable_id, Entry, Record, Row, Spec};
use crate::tools::{MakeraApp, ToolLibrary};

/// One cutting setting of a tool in either app. `stepover_mm`, `unknown` and
/// `modified` are Makera Studio's; `flag` and `extra` Makera CAM's.
#[derive(Debug, Clone, PartialEq)]
pub struct Setting {
    pub id: Option<String>,
    pub material_id: Option<String>,
    pub material_name: Option<String>,
    pub rpm: u32,
    pub feed: u32,
    pub plunge: u32,
    pub stepover_pct: f64,
    pub stepover_mm: f64,
    pub stepdown: f64,
    pub flag: u32,
    pub extra: Option<String>,
    pub unknown: [u8; 5],
    pub modified: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LibTool {
    pub id: Option<String>,
    pub name: Option<String>,
    pub number: u32,
    pub type_code: u32,
    /// 8 values in Makera CAM, 13 in Makera Studio.
    pub geometry: Vec<f64>,
    /// Makera Studio only: a number that has always been 1.
    pub unknown: u32,
    pub settings: Vec<Setting>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LibGroup {
    pub id: Option<String>,
    pub name: Option<String>,
    pub parent_id: Option<String>,
    pub tools: Vec<LibTool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LibMaterial {
    pub id: Option<String>,
    /// Makera Studio only: the id once more.
    pub id2: Option<String>,
    pub category_id: Option<String>,
    pub name: Option<String>,
    /// Makera CAM only: a JPEG as base64.
    pub image: Option<String>,
    /// Makera CAM only: a number that has always been 123.
    pub unknown: u32,
    /// Makera Studio only.
    pub modified: Option<String>,
    pub builtin: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Format {
    Cam,
    Studio,
}

impl Format {
    pub fn label(self) -> &'static str {
        match self {
            Format::Cam => "Makera CAM",
            Format::Studio => "Makera Studio",
        }
    }

    fn geometry_size(self) -> usize {
        match self {
            Format::Cam => 8,
            Format::Studio => 13,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Library {
    pub format: Format,
    pub groups: Vec<LibGroup>,
    pub materials: Vec<LibMaterial>,
    /// Makera CAM only; null in every export seen.
    pub header: Option<String>,
}

// Where the sizes sit among a tool's doubles.
pub const CAM_DIAMETER: usize = 0;
pub const CAM_TIP_DIAMETER: usize = 2;
pub const CAM_HALF_ANGLE: usize = 3;
pub const CAM_FLUTES: usize = 4;
pub const STUDIO_SHANK_DIAMETER: usize = 0;
pub const STUDIO_SHOULDER_LENGTH: usize = 2;
pub const STUDIO_FLUTE_LENGTH: usize = 3;
pub const STUDIO_DIAMETER: usize = 4;
pub const STUDIO_TIP_DIAMETER: usize = 5;
pub const STUDIO_FLUTES: usize = 6;
pub const STUDIO_LENGTH: usize = 7;
pub const STUDIO_HALF_ANGLE: usize = 8;
pub const STUDIO_THREAD_DIAMETER: usize = 9;
pub const STUDIO_PITCH: usize = 10;
pub const STUDIO_DRILL_DIAMETER: usize = 12;

/// Reads a library in one app's layout. `max_records` caps groups, tools,
/// settings and materials together.
pub fn read(data: &[u8], format: Format, max_records: usize) -> Result<Library, String> {
    let cam = format == Format::Cam;
    let mut r = Reader::new(data, max_records);
    let group_count = r.count()?;
    let header = if cam { r.string()? } else { None };
    let mut groups = Vec::new();
    for _ in 0..group_count {
        let mut group = LibGroup {
            id: r.string()?,
            name: r.string()?,
            parent_id: r.string()?,
            tools: Vec::new(),
        };
        for _ in 0..r.count()? {
            let id = r.string()?;
            let name = r.string()?;
            let number = r.u32()?;
            let type_code = r.u32()?;
            let mut geometry = Vec::new();
            for _ in 0..format.geometry_size() {
                geometry.push(r.f64()?);
            }
            let unknown = if cam { 1 } else { r.u32()? };
            let mut settings = Vec::new();
            for _ in 0..r.count()? {
                let id = r.string()?;
                let material_id = r.string()?;
                let material_name = r.string()?;
                let (rpm, feed, plunge) = (r.u32()?, r.u32()?, r.u32()?);
                let stepover_pct = r.f64()?;
                let stepover_mm = if cam { 0.0 } else { r.f64()? };
                let stepdown = r.f64()?;
                let mut setting = Setting {
                    id,
                    material_id,
                    material_name,
                    rpm,
                    feed,
                    plunge,
                    stepover_pct,
                    stepover_mm,
                    stepdown,
                    flag: 0,
                    extra: None,
                    unknown: [0; 5],
                    modified: None,
                };
                if cam {
                    setting.flag = r.u32()?;
                    setting.extra = r.string()?;
                } else {
                    setting.unknown.copy_from_slice(r.raw(5)?);
                    setting.modified = r.string()?;
                }
                settings.push(setting);
            }
            group.tools.push(LibTool {
                id,
                name,
                number,
                type_code,
                geometry,
                unknown,
                settings,
            });
        }
        groups.push(group);
    }
    let mut materials = Vec::new();
    for _ in 0..r.count()? {
        materials.push(if cam {
            LibMaterial {
                id: r.string()?,
                id2: None,
                category_id: r.string()?,
                name: r.string()?,
                image: r.string()?,
                unknown: r.u32()?,
                modified: None,
                builtin: true,
            }
        } else {
            LibMaterial {
                id: r.string()?,
                id2: r.string()?,
                category_id: r.string()?,
                name: r.string()?,
                image: None,
                unknown: 123,
                modified: r.string()?,
                builtin: r.bool()?,
            }
        });
    }
    r.expect_end()?;
    Ok(Library {
        format,
        groups,
        materials,
        header,
    })
}

/// Reads a library of either app: whichever layout takes the whole file.
pub fn read_any(data: &[u8], max_records: usize) -> Result<Library, String> {
    let mut errors = Vec::new();
    for format in [Format::Cam, Format::Studio] {
        match read(data, format, max_records) {
            Ok(library) => return Ok(library),
            Err(e) => errors.push(format!("{}: {e}", format.label())),
        }
    }
    Err(format!("not a Makera tool library ({})", errors.join("; ")))
}

pub fn write(library: &Library) -> Vec<u8> {
    let cam = library.format == Format::Cam;
    let mut w = Writer::default();
    w.count(library.groups.len());
    if cam {
        w.string(library.header.as_deref());
    }
    for group in &library.groups {
        w.string(group.id.as_deref());
        w.string(group.name.as_deref());
        w.string(group.parent_id.as_deref());
        w.count(group.tools.len());
        for tool in &group.tools {
            w.string(tool.id.as_deref());
            w.string(tool.name.as_deref());
            w.u32(tool.number);
            w.u32(tool.type_code);
            for value in &tool.geometry {
                w.f64(*value);
            }
            if !cam {
                w.u32(tool.unknown);
            }
            w.count(tool.settings.len());
            for s in &tool.settings {
                w.string(s.id.as_deref());
                w.string(s.material_id.as_deref());
                w.string(s.material_name.as_deref());
                w.u32(s.rpm);
                w.u32(s.feed);
                w.u32(s.plunge);
                w.f64(s.stepover_pct);
                if !cam {
                    w.f64(s.stepover_mm);
                }
                w.f64(s.stepdown);
                if cam {
                    w.u32(s.flag);
                    w.string(s.extra.as_deref());
                } else {
                    w.raw(&s.unknown);
                    w.string(s.modified.as_deref());
                }
            }
        }
    }
    w.count(library.materials.len());
    for m in &library.materials {
        w.string(m.id.as_deref());
        if cam {
            w.string(m.category_id.as_deref());
            w.string(m.name.as_deref());
            w.string(m.image.as_deref());
            w.u32(m.unknown);
        } else {
            w.string(m.id2.as_deref());
            w.string(m.category_id.as_deref());
            w.string(m.name.as_deref());
            w.string(m.modified.as_deref());
            w.bool(m.builtin);
        }
    }
    w.finish()
}

// ---- A tool list as a library ----

fn app_key(app: MakeraApp) -> &'static str {
    match app {
        MakeraApp::Cam => "cam",
        MakeraApp::Studio => "studio",
    }
}

fn app_label(app: MakeraApp) -> &'static str {
    match app {
        MakeraApp::Cam => "Makera CAM",
        MakeraApp::Studio => "Makera Studio",
    }
}

fn pinned(ids: Option<&crate::tools::AppIds>, app: MakeraApp) -> Option<&str> {
    let ids = ids?;
    match app {
        MakeraApp::Cam => ids.cam.as_deref(),
        MakeraApp::Studio => ids.studio.as_deref(),
    }
}

/// The id a tool has in one app's library: the one pinned for it, else one
/// derived from its name.
pub(crate) fn tool_id(tool: &crate::tools::Tool, app: MakeraApp) -> String {
    pinned(tool.ids.as_ref(), app).map_or_else(
        || stable_id(app_key(app), "tool", &[&tool.name]),
        str::to_string,
    )
}

/// The settings of a tool that one app gets: per material its plain row
/// (else its first row on a profile), once for each of the material's
/// records in the app.
fn mapped<'s, 'a>(
    spec: &'s Spec<'a>,
    entry: &'s Entry<'a>,
    app: MakeraApp,
    warnings: &mut Vec<String>,
) -> Vec<(&'s Row<'a>, Record<'a>, String)> {
    let mut out = Vec::new();
    for (row, fallback) in effective_rows(&entry.rows) {
        let records = spec.records(row.material, app);
        if records.is_empty() {
            warnings.push(format!(
                "{}: {} / {} left out: the material is not tied to one of {}'s",
                app_label(app),
                quoted(&entry.tool.name),
                spec.material_label(row.material),
                app_label(app)
            ));
        } else if fallback {
            warnings.push(format!(
                "{}: {} / {} gets the {} row, for want of a plain one: it may be run as a full slot",
                app_label(app),
                quoted(&entry.tool.name),
                spec.material_label(row.material),
                spec.profile_label(row.profile.unwrap_or_default())
            ));
        }
        for (i, record) in records.into_iter().enumerate() {
            let id = if i == 0 {
                // A row on a profile carries no ids of the apps: it reaches them only as a fallback.
                let own = if fallback {
                    None
                } else {
                    pinned(row.row.ids.as_ref(), app)
                };
                own.map_or_else(
                    || stable_id(app_key(app), "cutting", &[&entry.tool.name, row.material]),
                    str::to_string,
                )
            } else {
                // A pinned id belongs to the first record; the others get their own.
                stable_id(
                    app_key(app),
                    "cutting",
                    &[&entry.tool.name, row.material, record.id],
                )
            };
            out.push((row, record, id));
        }
    }
    out
}

/// The groups of one app's library with their tools in them. Only groups
/// that hold a tool for the app, directly or further down, are kept. Both
/// apps import only the first top-level group of a file, so several go under
/// one called "Imported".
fn build_groups(
    spec: &Spec,
    app: MakeraApp,
    mut tool: impl FnMut(&Entry) -> LibTool,
) -> Vec<LibGroup> {
    let key = app_key(app);
    let id_of = |path: &[String]| -> String {
        let ids = spec
            .groups
            .iter()
            .find(|(p, _)| p[..] == *path)
            .and_then(|(_, ids)| *ids);
        pinned(ids, app).map_or_else(
            || {
                let parts: Vec<&str> = path.iter().map(String::as_str).collect();
                stable_id(key, "group", &parts)
            },
            str::to_string,
        )
    };
    let mut groups: Vec<(&Vec<String>, LibGroup)> = spec
        .groups
        .iter()
        .map(|(path, _)| {
            let group = LibGroup {
                id: Some(id_of(path)),
                name: path.last().cloned(),
                parent_id: (path.len() > 1).then(|| id_of(&path[..path.len() - 1])),
                tools: Vec::new(),
            };
            (path, group)
        })
        .collect();
    let mine: Vec<&Entry> = spec
        .tools
        .iter()
        .filter(|t| t.apps.contains(&app))
        .collect();
    for entry in &mine {
        if let Some((_, group)) = groups.iter_mut().find(|(path, _)| **path == entry.group) {
            group.tools.push(tool(entry));
        }
    }
    let used = |path: &[String]| mine.iter().any(|t| t.group.starts_with(path));
    let mut kept: Vec<LibGroup> = groups
        .into_iter()
        .filter(|(path, _)| used(path))
        .map(|(_, group)| group)
        .collect();
    if kept.iter().filter(|g| g.parent_id.is_none()).count() < 2 {
        return kept;
    }
    let root = LibGroup {
        id: Some(stable_id(key, "import group", &[])),
        name: Some("Imported".into()),
        parent_id: None,
        tools: Vec::new(),
    };
    for group in &mut kept {
        if group.parent_id.is_none() {
            group.parent_id.clone_from(&root.id);
        }
    }
    kept.insert(0, root);
    kept
}

/// The records of one app that the tools written for it refer to, in the
/// order they are first used.
fn used_materials<'a>(spec: &Spec<'a>, app: MakeraApp) -> Vec<Record<'a>> {
    let mut seen: Vec<Record> = Vec::new();
    for entry in spec.tools.iter().filter(|t| t.apps.contains(&app)) {
        for (row, _) in effective_rows(&entry.rows) {
            for record in spec.records(row.material, app) {
                if !seen.iter().any(|r| r.id == record.id) {
                    seen.push(record);
                }
            }
        }
    }
    seen
}

fn some(text: &str) -> Option<String> {
    Some(text.to_string())
}

/// A tool list as a Makera CAM library, and what to know about it. Fails
/// when the library would hold a byte the app cannot read and no value can
/// be moved to avoid it.
pub fn build_cam(library: &ToolLibrary) -> Result<(Library, Vec<String>), String> {
    let spec = Spec::new(library);
    let mut warnings = spec.notes.clone();
    let mut setting_warnings = Vec::new();
    // No "All" group as in the app's own exports: importing one adds a group called "All".
    let groups = build_groups(&spec, MakeraApp::Cam, |entry| {
        let g = &entry.shape;
        LibTool {
            id: Some(tool_id(entry.tool, MakeraApp::Cam)),
            name: some(&entry.shown_name),
            number: entry.number,
            type_code: entry.type_code,
            // The second value, the app's "Angle (A)", is 0 on every factory tool; what it means is unknown.
            geometry: vec![
                g.diameter,
                0.0,
                g.tip_diameter,
                g.tip_angle / 2.0,
                g.flutes,
                0.0,
                0.0,
                0.0,
            ],
            unknown: 1,
            settings: mapped(&spec, entry, MakeraApp::Cam, &mut setting_warnings)
                .into_iter()
                .map(|(row, record, id)| Setting {
                    id: Some(id),
                    material_id: some(record.id),
                    material_name: some(record.name),
                    rpm: row.rpm,
                    feed: row.feed,
                    plunge: row.plunge,
                    stepover_pct: row.stepover_pct,
                    stepover_mm: 0.0,
                    stepdown: row.stepdown,
                    flag: row
                        .row
                        .cam_flag
                        .filter(|_| row.profile.is_none())
                        .map_or(0, |flag| flag.max(0) as u32),
                    extra: Some(
                        row.row
                            .cam_extra
                            .clone()
                            .filter(|_| row.profile.is_none())
                            .unwrap_or_else(|| "1".into()),
                    ),
                    unknown: [0; 5],
                    modified: None,
                })
                .collect(),
        }
    });
    warnings.append(&mut setting_warnings);
    let materials = used_materials(&spec, MakeraApp::Cam)
        .into_iter()
        .map(|m| LibMaterial {
            id: some(m.id),
            id2: None,
            category_id: some(m.id),
            name: some(m.name),
            // The app's thumbnails are not kept in a tool list: materials it already has keep theirs.
            image: some(""),
            unknown: 123,
            modified: None,
            builtin: true,
        })
        .collect();
    let mut out = Library {
        format: Format::Cam,
        groups,
        materials,
        header: None,
    };
    avoid_cr(&mut out, &mut warnings)?;
    Ok((out, warnings))
}

/// A tool list as a Makera Studio library. `now` (ISO-8601 UTC) is when a
/// setting without a time of its own is said to have changed.
pub fn build_studio(library: &ToolLibrary, now: &str) -> (Library, Vec<String>) {
    let spec = Spec::new(library);
    let mut warnings = spec.notes.clone();
    let mut setting_warnings = Vec::new();
    let groups = build_groups(&spec, MakeraApp::Studio, |entry| {
        let g = &entry.shape;
        LibTool {
            id: Some(tool_id(entry.tool, MakeraApp::Studio)),
            name: some(&entry.shown_name),
            number: entry.number,
            type_code: entry.type_code,
            geometry: vec![
                g.shank_diameter,
                g.studio_unknown_1,
                g.shoulder_length,
                g.flute_length,
                g.diameter,
                g.tip_diameter,
                g.flutes,
                g.length,
                g.tip_angle / 2.0,
                g.thread_diameter,
                g.pitch,
                0.0,
                g.drill_diameter,
            ],
            unknown: 1,
            settings: mapped(&spec, entry, MakeraApp::Studio, &mut setting_warnings)
                .into_iter()
                .map(|(row, record, id)| Setting {
                    id: Some(id),
                    material_id: some(record.id),
                    material_name: some(record.name),
                    rpm: row.rpm,
                    feed: row.feed,
                    plunge: row.plunge,
                    stepover_pct: row.stepover_pct,
                    stepover_mm: row.stepover_mm,
                    stepdown: row.stepdown,
                    flag: 0,
                    extra: None,
                    unknown: [0; 5],
                    modified: Some(
                        row.row
                            .modified
                            .clone()
                            .filter(|_| row.profile.is_none())
                            .unwrap_or_else(|| now.to_string()),
                    ),
                })
                .collect(),
        }
    });
    warnings.append(&mut setting_warnings);
    let materials = used_materials(&spec, MakeraApp::Studio)
        .into_iter()
        .map(|m| LibMaterial {
            id: some(m.id),
            id2: some(m.id),
            category_id: m.category_id.map(str::to_string),
            name: some(m.name),
            image: None,
            unknown: 123,
            modified: m.modified.map(str::to_string),
            builtin: m.builtin,
        })
        .collect();
    let out = Library {
        format: Format::Studio,
        groups,
        materials,
        header: None,
    };
    (out, warnings)
}

// Makera CAM reads a library as text and drops every carriage-return byte,
// which misreads the rest of the file: a feed of 13 mm/min or 13 groups is
// enough. Makera Studio reads the byte correctly.
const CR: u8 = 0x0D;

/// The largest big-endian value not above `packed` without a CR byte.
fn below_cr<const N: usize>(mut packed: [u8; N]) -> [u8; N] {
    if let Some(i) = packed.iter().position(|b| *b == CR) {
        packed[i] = CR - 1;
        for byte in &mut packed[i + 1..] {
            *byte = 0xFF;
        }
    }
    packed
}

/// The largest whole number not above `value` that Makera CAM reads back.
pub fn cam_readable(value: u32) -> u32 {
    u32::from_be_bytes(below_cr(value.to_be_bytes()))
}

fn text_has_cr(text: Option<&str>) -> bool {
    let Some(text) = text else {
        return false;
    };
    let units: Vec<u16> = text.encode_utf16().collect();
    (units.len() as u32 * 2).to_be_bytes().contains(&CR)
        || units.iter().any(|u| u.to_be_bytes().contains(&CR))
}

fn count_has_cr(n: usize) -> bool {
    (n as u32).to_be_bytes().contains(&CR)
}

/// Moves cutting values down to ones without a CR byte, saying so where it
/// shows; pads a group count of 13 with an empty group the app skips; and
/// refuses the rest, a size that would visibly change among it.
fn avoid_cr(library: &mut Library, warnings: &mut Vec<String>) -> Result<(), String> {
    let mut problems: Vec<String> = Vec::new();
    let whole = |value: u32, what: &str, unit: &str, warnings: &mut Vec<String>| -> u32 {
        let new = cam_readable(value);
        if new != value {
            warnings.push(format!(
                "Makera CAM: {what} {value} written as {new}{unit} (the app can't read a byte of value 13)"
            ));
        }
        new
    };
    let decimal = |value: f64, places: usize| -> (f64, String, String) {
        let new = f64::from_be_bytes(below_cr(value.to_be_bytes()));
        (new, shown(value, places), shown(new, places))
    };
    const SLOTS: [&str; 5] = [
        "diameter",
        "angle (A)",
        "tip diameter",
        "half angle",
        "flutes",
    ];

    for group in &mut library.groups {
        let name = quoted(group.name.as_deref().unwrap_or_default());
        for (text, what) in [
            (&group.id, "its id"),
            (&group.name, "its name"),
            (&group.parent_id, "its parent id"),
        ] {
            if text_has_cr(text.as_deref()) {
                problems.push(format!("group {name}: {what}"));
            }
        }
        if count_has_cr(group.tools.len()) {
            problems.push(format!("group {name}: {} tools", group.tools.len()));
        }
        for tool in &mut group.tools {
            let label = quoted(tool.name.as_deref().unwrap_or_default());
            for (text, what) in [(&tool.id, "its id"), (&tool.name, "its name")] {
                if text_has_cr(text.as_deref()) {
                    problems.push(format!("tool {label}: {what}"));
                }
            }
            for (value, what) in [
                (tool.number, "tool number"),
                (tool.type_code, "type code"),
                (tool.settings.len() as u32, "count of cutting settings"),
            ] {
                if value.to_be_bytes().contains(&CR) {
                    problems.push(format!("tool {label}: {what} {value}"));
                }
            }
            for (i, value) in tool.geometry.iter_mut().enumerate() {
                let (new, before, after) = decimal(*value, 4);
                if before != after {
                    let slot = SLOTS
                        .get(i)
                        .map_or_else(|| format!("geometry slot {i}"), |s| s.to_string());
                    problems.push(format!("tool {label}: {slot} {before}"));
                } else {
                    *value = new;
                }
            }
            for s in &mut tool.settings {
                let what = format!(
                    "{label} / {}",
                    quoted(s.material_name.as_deref().unwrap_or_default())
                );
                for (text, field) in [
                    (&s.id, "id"),
                    (&s.material_id, "material id"),
                    (&s.material_name, "material name"),
                    (&s.extra, "cam_extra"),
                ] {
                    if text_has_cr(text.as_deref()) {
                        problems.push(format!("tool {what}: its {field}"));
                    }
                }
                if s.flag.to_be_bytes().contains(&CR) {
                    problems.push(format!("tool {what}: cam_flag {}", s.flag));
                }
                s.rpm = whole(s.rpm, &format!("{what} spindle"), " rpm", warnings);
                s.feed = whole(s.feed, &format!("{what} feed"), " mm/min", warnings);
                s.plunge = whole(s.plunge, &format!("{what} plunge"), " mm/min", warnings);
                for (value, field, unit, places) in [
                    (&mut s.stepover_pct, "stepover", " %", 3),
                    (&mut s.stepdown, "stepdown", " mm", 4),
                ] {
                    let (new, before, after) = decimal(*value, places);
                    if before != after {
                        warnings.push(format!(
                            "Makera CAM: {what} {field} {before} written as {after}{unit} (the app can't read a byte of value 13)"
                        ));
                    }
                    *value = new;
                }
            }
        }
    }
    for m in &library.materials {
        let name = quoted(m.name.as_deref().unwrap_or_default());
        for (text, field) in [
            (&m.id, "id"),
            (&m.category_id, "category id"),
            (&m.name, "name"),
            (&m.image, "thumbnail"),
        ] {
            if text_has_cr(text.as_deref()) {
                problems.push(format!("material {name}: its {field}"));
            }
        }
        if m.unknown.to_be_bytes().contains(&CR) {
            problems.push(format!("material {name}: unknown value {}", m.unknown));
        }
    }
    if count_has_cr(library.materials.len()) {
        problems.push(format!("{} materials", library.materials.len()));
    }
    if !problems.is_empty() {
        return Err(format!(
            "Makera CAM can't read a library holding a byte of value 13, and these can't be written without one: {}. Change them in the tool list.",
            problems.join("; ")
        ));
    }
    while count_has_cr(library.groups.len()) {
        let n = library.groups.len().to_string();
        library.groups.push(LibGroup {
            id: Some(stable_id("cam", "pad group", &[&n])),
            name: Some("Makera CAM skips this group".into()),
            parent_id: None,
            tools: Vec::new(),
        });
    }
    Ok(())
}
