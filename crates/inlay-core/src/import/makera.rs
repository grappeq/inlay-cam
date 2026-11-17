//! Sizes and cutting values brought in from a library that Makera CAM or
//! Makera Studio exported.
//!
//! An export is compared with the tool list, and what differs is offered as
//! changes to tick. Only numbers move: names, ids, groups and materials are
//! never written, no tool or material is made, and no text of the export
//! reaches the list. Values are compared as the writers of `export::makera`
//! put them, so a library written from the list shows no differences.

use serde::{Deserialize, Serialize};

use crate::export::makera::{self as lib, tool_id, Format, LibGroup, LibTool, Library, Setting};
use crate::export::{round_to, shown, Entry, Row, Spec};
use crate::tools::{
    CuttingSettings, MakeraApp, Material, StepoverUnit, Tool, ToolKind, ToolLibrary,
};

/// Groups, tools, settings and materials together; a factory export has about 540.
const MAX_RECORDS: usize = 20_000;
const TEXT_MAX: usize = 200;
const NOT_IMPORTED_MAX: usize = 500;
/// Materials named in one reason.
const NAMES_LISTED: usize = 5;
/// Levels of an export's group path shown in a reason.
const GROUP_DEPTH_SHOWN: usize = 16;
const LENGTH_MAX: f64 = 1000.0;
const SPEED_MAX: u32 = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    /// A size of the tool.
    Geometry,
    /// One value of a cutting row the tool has.
    Cutting,
    /// A cutting row for a material the tool has none for.
    New,
}

/// The values of a cutting row an export gives.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowValues {
    pub rpm: u32,
    pub feed: u32,
    pub plunge: u32,
    /// mm, or percent of the diameter, as `stepover_unit` says.
    pub stepover: f64,
    pub stepover_unit: StepoverUnit,
    pub stepdown: f64,
}

/// What a change does to a tool when it is applied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Patch {
    /// `None` puts a tip or shank back to the body's diameter.
    Geometry {
        key: String,
        value: Option<f64>,
    },
    Add {
        material: String,
        values: RowValues,
    },
    Update {
        material: String,
        key: String,
        value: f64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: String,
    pub kind: ChangeKind,
    /// The size or value, such as `flute_length` or `feed`.
    pub key: Option<String>,
    pub material: Option<String>,
    pub material_label: Option<String>,
    pub label: String,
    pub unit: Option<String>,
    pub from: Option<f64>,
    pub to: Option<f64>,
    /// For a new row: its values in words.
    pub values: Option<String>,
    /// Ticked to begin with: a value of a tool that was matched by its id.
    pub selected: bool,
    pub note: Option<String>,
    pub patch: Patch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTool {
    pub tool_id: String,
    pub name: String,
    pub group: String,
    /// Matched by name and group, not by id.
    pub by_name: bool,
    pub notes: Vec<String>,
    /// Values the list keeps because the export has 0, which the apps use for unknown.
    pub kept: Vec<String>,
    pub changes: Vec<Change>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unchanged {
    pub name: String,
    pub group: String,
    pub kept: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotImported {
    pub record: String,
    pub reason: String,
}

/// An export held against the tool list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub format: Format,
    /// "Makera CAM export".
    pub label: String,
    pub export_tools: usize,
    pub matched: usize,
    pub matched_by_name: usize,
    pub tools: Vec<PlanTool>,
    pub unchanged: Vec<Unchanged>,
    /// The first of them; `not_imported_more` counts the rest.
    pub not_imported: Vec<NotImported>,
    pub not_imported_more: usize,
}

// ---- small helpers ----

/// A name from the export, safe to show: never empty, not too long, and
/// without characters that could make it read as another name.
fn text(value: Option<&str>) -> String {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return "(no name)".into();
    };
    let mut out: String = value.chars().take(TEXT_MAX).collect();
    if value.chars().count() > TEXT_MAX {
        out = out.chars().take(TEXT_MAX - 1).collect::<String>() + "…";
    }
    let hidden = |c: char| {
        c.is_control()
            || matches!(c, '\u{ad}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{feff}')
    };
    out.chars()
        .map(|c| if hidden(c) { '\u{fffd}' } else { c })
        .collect()
}

/// A number as the screen shows it: `1720`, `1.5`, `0.1234`.
fn fmt(v: f64) -> String {
    if v.is_nan() {
        return "not a number".into();
    }
    if v.is_infinite() {
        return "infinite".into();
    }
    shown(round_to(v, 4), 4)
}

fn with_unit(v: f64, unit: &str) -> String {
    match unit {
        "°" => format!("{}°", fmt(v)),
        "" => fmt(v),
        unit => format!("{} {unit}", fmt(v)),
    }
}

fn in_range(v: f64, limit: f64) -> bool {
    v.is_finite() && (0.0..=limit).contains(&v)
}

fn geo_label(key: &str) -> (&'static str, &'static str) {
    match key {
        "diameter" => ("Diameter", "mm"),
        "length" => ("Overall length", "mm"),
        "flute_length" => ("Flute length", "mm"),
        "flutes" => ("Flutes", ""),
        "shoulder_length" => ("Shoulder", "mm"),
        "tip_angle" => ("Tip angle", "°"),
        "shank_diameter" => ("Shank Ø", "mm"),
        "tip_diameter" => ("Tip Ø", "mm"),
        "thread_diameter" => ("Thread Ø", "mm"),
        "pitch" => ("Pitch", "mm"),
        _ => ("Drill Ø", "mm"),
    }
}

fn cut_label(key: &str) -> (&'static str, &'static str) {
    match key {
        "rpm" => ("Spindle", "rpm"),
        "feed" => ("Feed", "mm/min"),
        "plunge" => ("Plunge", "mm/min"),
        "stepover_pct" => ("Stepover", "%"),
        "stepover_mm" => ("Stepover", "mm"),
        _ => ("Stepdown", "mm"),
    }
}

/// The sizes each app stores: where, which, and by what they are to be
/// multiplied (the apps keep half the tip angle).
fn geometry_slots(format: Format) -> &'static [(usize, &'static str, f64)] {
    match format {
        Format::Cam => &[
            (lib::CAM_TIP_DIAMETER, "tip_diameter", 1.0),
            (lib::CAM_HALF_ANGLE, "tip_angle", 2.0),
            (lib::CAM_FLUTES, "flutes", 1.0),
        ],
        Format::Studio => &[
            (lib::STUDIO_SHANK_DIAMETER, "shank_diameter", 1.0),
            (lib::STUDIO_SHOULDER_LENGTH, "shoulder_length", 1.0),
            (lib::STUDIO_FLUTE_LENGTH, "flute_length", 1.0),
            (lib::STUDIO_TIP_DIAMETER, "tip_diameter", 1.0),
            (lib::STUDIO_FLUTES, "flutes", 1.0),
            (lib::STUDIO_LENGTH, "length", 1.0),
            (lib::STUDIO_HALF_ANGLE, "tip_angle", 2.0),
            (lib::STUDIO_THREAD_DIAMETER, "thread_diameter", 1.0),
            (lib::STUDIO_PITCH, "pitch", 1.0),
            (lib::STUDIO_DRILL_DIAMETER, "drill_diameter", 1.0),
        ],
    }
}

/// A tip diameter of 0 is a real value, a pointed V-bit; for the rest the
/// apps store 0 when they do not know, and that never replaces a known one.
fn zero_means_unknown(key: &str) -> bool {
    key != "tip_diameter"
}

fn current(entry: &Entry, key: &str) -> f64 {
    let s = &entry.shape;
    match key {
        "tip_diameter" => s.tip_diameter,
        "tip_angle" => s.tip_angle,
        "flutes" => s.flutes,
        "shank_diameter" => s.shank_diameter,
        "shoulder_length" => s.shoulder_length,
        "flute_length" => s.flute_length,
        "length" => s.length,
        "thread_diameter" => s.thread_diameter,
        "pitch" => s.pitch,
        _ => s.drill_diameter,
    }
}

fn type_name(code: u32) -> String {
    match code {
        0 => "ball end".into(),
        1 => "flat end".into(),
        3 => "v bit".into(),
        5 => "drill".into(),
        6 => "thread mill".into(),
        other => format!("unknown type {other}"),
    }
}

fn kind_name(kind: ToolKind) -> &'static str {
    match kind {
        ToolKind::BallEnd => "ball end",
        ToolKind::FlatEnd => "flat end",
        ToolKind::VBit | ToolKind::CornerRound => "v bit",
        ToolKind::Drill => "drill",
        ToolKind::ThreadMill => "thread mill",
    }
}

// ---- applying a patch to a tool ----

fn apply(tool: &mut Tool, patch: &Patch) {
    match patch {
        Patch::Geometry { key, value } => {
            let known = value.filter(|v| *v != 0.0);
            match key.as_str() {
                "tip_diameter" => {
                    let cone = matches!(tool.kind, ToolKind::VBit | ToolKind::CornerRound);
                    // A V-bit always says where its cone ends.
                    tool.tip_diameter = match value {
                        None if cone => Some(tool.diameter),
                        other => *other,
                    };
                }
                "shank_diameter" => tool.shank_diameter = value.unwrap_or(tool.diameter),
                "tip_angle" => tool.tip_angle = known,
                "flutes" => tool.flutes = known.map(|v| v as u32),
                "shoulder_length" => tool.shoulder_length = known,
                "flute_length" => tool.flute_length = known,
                "length" => tool.length = known,
                "thread_diameter" => tool.thread_diameter = known,
                "pitch" => tool.pitch = known,
                "drill_diameter" => tool.drill_diameter = known,
                _ => {}
            }
        }
        Patch::Add { material, values } => {
            let mm = match values.stepover_unit {
                StepoverUnit::Mm => values.stepover,
                StepoverUnit::Percent => round_to(values.stepover / 100.0 * tool.diameter, 6),
            };
            let mut row = CuttingSettings::new(
                Material::new(material.clone()),
                values.rpm,
                f64::from(values.feed),
                f64::from(values.plunge),
                mm,
                values.stepdown,
            );
            row.stepover_unit = values.stepover_unit;
            tool.cutting.push(row);
        }
        Patch::Update {
            material,
            key,
            value,
        } => {
            let diameter = tool.diameter;
            // Only plain rows are touched: they are the ones the apps hold.
            let Some(row) = tool
                .cutting
                .iter_mut()
                .find(|c| c.material.key() == material && c.profile.is_none())
            else {
                return;
            };
            match key.as_str() {
                "rpm" => row.rpm = *value as u32,
                "feed" => row.feed = *value,
                "plunge" => row.plunge = *value,
                "stepdown" => row.stepdown = *value,
                "stepover_mm" => {
                    row.stepover = *value;
                    row.stepover_unit = StepoverUnit::Mm;
                }
                "stepover_pct" => {
                    row.stepover = round_to(*value / 100.0 * diameter, 6);
                    row.stepover_unit = StepoverUnit::Percent;
                }
                _ => {}
            }
        }
    }
}

/// A shoulder equal to the flute length it ends up with is the default: left unset.
fn settle(tool: &mut Tool) {
    if tool.shoulder_length.is_some() && tool.shoulder_length == tool.flute_length {
        tool.shoulder_length = None;
    }
}

fn first_error(tool: &Tool, patch: &Patch) -> Option<String> {
    let mut patched = tool.clone();
    apply(&mut patched, patch);
    settle(&mut patched);
    patched
        .validate()
        .err()
        .map(|e| format!("Would fail validation: {e}."))
}

// ---- planning ----

struct Planning {
    plan: Plan,
    next: usize,
    skipped: usize,
}

impl Planning {
    fn skip(&mut self, record: String, reason: String) {
        self.skipped += 1;
        if self.plan.not_imported.len() < NOT_IMPORTED_MAX {
            self.plan.not_imported.push(NotImported { record, reason });
        }
    }

    fn id(&mut self) -> String {
        self.next += 1;
        format!("c{}", self.next)
    }
}

/// The names from an export's top-level group down to `group`, at most
/// `limit` of them, and whether there were more. An export's groups can be
/// deep or run in a circle, so no more than that is walked.
fn group_names(groups: &[LibGroup], group: &LibGroup, limit: usize) -> (Vec<String>, bool) {
    let mut names = Vec::new();
    let mut seen: Vec<*const LibGroup> = Vec::new();
    let mut at = Some(group);
    while let Some(g) = at {
        if seen.contains(&(g as *const LibGroup)) || names.len() > limit {
            break;
        }
        seen.push(g);
        names.push(g.name.clone().unwrap_or_default());
        at = g
            .parent_id
            .as_ref()
            .and_then(|parent| groups.iter().find(|o| o.id.as_ref() == Some(parent)));
    }
    let more = names.len() > limit;
    names.reverse();
    let from = names.len().saturating_sub(limit);
    (names[from..].to_vec(), more)
}

fn app_of(format: Format) -> MakeraApp {
    match format {
        Format::Cam => MakeraApp::Cam,
        Format::Studio => MakeraApp::Studio,
    }
}

/// The export's tools that are tools of the list: by id, else by exact name
/// and group.
fn matched_tools<'e>(
    spec: &Spec,
    export: &'e Library,
    p: &mut Planning,
) -> Vec<(&'e LibTool, usize, bool)> {
    let app = app_of(export.format);
    let all: Vec<(&LibGroup, &LibTool)> = export
        .groups
        .iter()
        .flat_map(|g| g.tools.iter().map(move |t| (g, t)))
        .collect();
    let count = |f: &dyn Fn(&LibTool) -> bool| all.iter().filter(|(_, t)| f(t)).count();
    let by_id = |id: &str| spec.tools.iter().position(|t| tool_id(t.tool, app) == id);
    // The shown name (with the coating) first, then the bare name an older export may carry.
    let by_name = |name: &str| {
        spec.tools
            .iter()
            .position(|t| t.shown_name == name)
            .or_else(|| spec.tools.iter().position(|t| t.tool.name == name))
    };
    let mut matched = Vec::new();
    let mut taken: Vec<(usize, &str)> = Vec::new();
    let mut rest = Vec::new();
    for (group, t) in &all {
        let id = t.id.as_deref().filter(|id| !id.is_empty());
        if id.is_some_and(|id| count(&|o| o.id.as_deref() == Some(id)) > 1) {
            p.skip(text(t.name.as_deref()), "The export has more than one tool with this id, so it can't tell which one to use.".into());
        } else if let Some(i) = id.and_then(by_id) {
            matched.push((*t, i, false));
            taken.push((i, "by id"));
        } else {
            rest.push((*group, *t));
        }
    }
    for (group, t) in rest {
        let name = t.name.as_deref().filter(|n| !n.is_empty());
        let shown = text(t.name.as_deref());
        let found = name.and_then(by_name);
        if name.is_some_and(|n| count(&|o| o.name.as_deref() == Some(n)) > 1) {
            p.skip(shown, "The export has more than one tool with this name, so it can't tell which one to use.".into());
        } else if let Some(i) = found {
            let entry = &spec.tools[i];
            if let Some((_, how)) = taken.iter().find(|(at, _)| *at == i) {
                p.skip(
                    shown,
                    format!(
                        "Another tool in the export already matched {} {how}.",
                        text(Some(&entry.shown_name))
                    ),
                );
            // Groups above the list's own do not count: the apps import a library under whatever group is selected there.
            } else if group_names(&export.groups, group, entry.group.len()).0 != entry.group {
                let (names, more) = group_names(&export.groups, group, GROUP_DEPTH_SHOWN);
                let path = names
                    .iter()
                    .map(|n| text(Some(n)))
                    .collect::<Vec<_>>()
                    .join(" / ");
                p.skip(
                    shown,
                    format!(
                        "Same name as a tool of yours, but in group {}{path} instead of {}. Tools are matched by exact name and group (groups above it, such as Imported, are ignored).",
                        if more { "… / " } else { "" },
                        entry.group.join(" / ")
                    ),
                );
            } else {
                matched.push((t, i, true));
                taken.push((i, "by name"));
            }
        } else {
            p.skip(
                shown,
                "Not one of your tools. Add it to the list first to import its values.".into(),
            );
        }
    }
    matched
}

fn identity_problem(et: &LibTool, entry: &Entry, format: Format) -> Option<String> {
    if et.type_code != entry.type_code {
        return Some(format!(
            "Type differs: {} in your list, {} in the export. Check it is the same tool.",
            kind_name(entry.tool.kind),
            type_name(et.type_code)
        ));
    }
    let slot = match format {
        Format::Cam => lib::CAM_DIAMETER,
        Format::Studio => lib::STUDIO_DIAMETER,
    };
    let d = et.geometry.get(slot).copied().unwrap_or(f64::NAN);
    if !(in_range(d, LENGTH_MAX) && round_to(d, 4) == round_to(entry.shape.diameter, 4)) {
        return Some(format!(
            "Diameter differs: {} mm in your list, {} mm in the export. Check it is the same tool.",
            fmt(entry.shape.diameter),
            fmt(d)
        ));
    }
    None
}

/// The values of one setting of the export as a row would hold them, with
/// the stepover in `unit`; or why they cannot be used.
fn proposal(
    s: &Setting,
    format: Format,
    unit: StepoverUnit,
    diameter: f64,
) -> Result<Vec<(&'static str, f64)>, String> {
    for (key, v) in [("rpm", s.rpm), ("feed", s.feed), ("plunge", s.plunge)] {
        if v > SPEED_MAX {
            let (label, unit) = cut_label(key);
            return Err(format!(
                "Value out of range: {label} {}.",
                with_unit(f64::from(v), unit)
            ));
        }
    }
    for (key, v) in [
        ("stepover_pct", s.stepover_pct),
        ("stepdown", s.stepdown),
        ("stepover_mm", s.stepover_mm),
    ] {
        if !in_range(v, LENGTH_MAX) {
            let (label, unit) = cut_label(key);
            return Err(format!(
                "Value out of range: {label} {}.",
                with_unit(v, unit)
            ));
        }
    }
    let stepover = match unit {
        StepoverUnit::Mm => {
            let mm = if format == Format::Studio {
                s.stepover_mm
            } else {
                s.stepover_pct * diameter / 100.0
            };
            ("stepover_mm", round_to(mm, 4))
        }
        StepoverUnit::Percent => ("stepover_pct", round_to(s.stepover_pct, 3)),
    };
    Ok(vec![
        ("rpm", f64::from(s.rpm)),
        ("feed", f64::from(s.feed)),
        ("plunge", f64::from(s.plunge)),
        stepover,
        ("stepdown", round_to(s.stepdown, 4)),
    ])
}

/// Whether a value an export gives differs from the row's, at the rounding
/// the writers use. A Makera CAM stepover on a row in mm matches in percent,
/// as written, or in mm, as applied.
fn differs(row: &Row, key: &str, v: f64, s: &Setting, format: Format) -> bool {
    let cur = row_value(row, key);
    let same_stepover = key.starts_with("stepover")
        && if format == Format::Studio && key == "stepover_mm" {
            round_to(s.stepover_mm, 4) == round_to(row.stepover_mm, 4)
        } else {
            round_to(s.stepover_pct, 3) == round_to(row.stepover_pct, 3)
        };
    !(round_to(v, 4) == round_to(cur, 4) || same_stepover)
}

fn row_value(row: &Row, key: &str) -> f64 {
    match key {
        "rpm" => f64::from(row.rpm),
        "feed" => f64::from(row.feed),
        "plunge" => f64::from(row.plunge),
        "stepdown" => row.stepdown,
        "stepover_mm" => row.stepover_mm,
        _ => row.stepover_pct,
    }
}

fn values_text(values: &[(&'static str, f64)]) -> String {
    values
        .iter()
        .map(|(key, v)| {
            let (label, unit) = cut_label(key);
            format!("{label} {}", with_unit(*v, unit))
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

fn conflict_reason(
    settings: &[&Setting],
    proposals: &[Vec<(&'static str, f64)>],
    key: &str,
    format: Format,
) -> String {
    let mut names = settings
        .iter()
        .take(NAMES_LISTED)
        .map(|s| text(s.material_name.as_deref()))
        .collect::<Vec<_>>()
        .join(", ");
    if settings.len() > NAMES_LISTED {
        names.push_str(&format!(" and {} more", settings.len() - NAMES_LISTED));
    }
    let mut diffs = Vec::new();
    for (i, (value_key, _)) in proposals[0].iter().enumerate() {
        let mut seen: Vec<f64> = Vec::new();
        for proposal in proposals {
            if !seen.contains(&proposal[i].1) {
                seen.push(proposal[i].1);
            }
        }
        if seen.len() > 1 {
            let (label, unit) = cut_label(value_key);
            let shown = seen
                .iter()
                .take(NAMES_LISTED)
                .map(|v| fmt(*v))
                .collect::<Vec<_>>()
                .join(" · ");
            diffs.push(format!(
                "{label} {shown}{}{}",
                if seen.len() > NAMES_LISTED {
                    " · …"
                } else {
                    ""
                },
                if unit.is_empty() {
                    String::new()
                } else {
                    format!(" {unit}")
                }
            ));
        }
    }
    format!(
        "Conflicting values across {} {} materials ({names}) that all map to {key}: {}.",
        settings.len(),
        format.label(),
        diffs.join("; ")
    )
}

fn plan_geometry(
    p: &mut Planning,
    out: &mut PlanTool,
    et: &LibTool,
    entry: &Entry,
    format: Format,
) {
    for (slot, key, factor) in geometry_slots(format) {
        let (label, unit) = geo_label(key);
        let v = et.geometry.get(*slot).copied().unwrap_or(f64::NAN) * factor;
        if !in_range(v, LENGTH_MAX) {
            p.skip(
                format!("{} · {label}", out.name),
                format!("Value out of range: {label} {}.", with_unit(v, unit)),
            );
            continue;
        }
        let v = round_to(v, 4);
        let cur = current(entry, key);
        if v == round_to(cur, 4) {
            continue;
        }
        if v == 0.0 && zero_means_unknown(key) {
            out.kept.push(format!(
                "{label} {} (the export has 0, which the apps use for unknown)",
                with_unit(cur, unit)
            ));
            continue;
        }
        // Equal to the diameter it defaults to: the size goes back to following it.
        let value = (!(matches!(*key, "tip_diameter" | "shank_diameter")
            && v == entry.shape.diameter))
            .then_some(v);
        let patch = Patch::Geometry {
            key: (*key).into(),
            value,
        };
        if let Some(error) = first_error(entry.tool, &patch) {
            p.skip(format!("{} · {label}", out.name), error);
            continue;
        }
        out.changes.push(Change {
            id: p.id(),
            kind: ChangeKind::Geometry,
            key: Some((*key).into()),
            material: None,
            material_label: None,
            label: label.into(),
            unit: Some(unit.into()),
            from: Some(cur),
            to: Some(v),
            values: None,
            selected: false,
            note: None,
            patch,
        });
    }
}

fn plan_cutting(
    p: &mut Planning,
    out: &mut PlanTool,
    et: &LibTool,
    entry: &Entry,
    spec: &Spec,
    format: Format,
) {
    let app = app_of(format);
    // Which material of the list a record of the app belongs to.
    let key_of = |id: &str| {
        spec.library
            .materials
            .iter()
            .find(|m| spec.records(m.key.key(), app).iter().any(|r| r.id == id))
            .map(|m| m.key.key().to_string())
    };
    let mut groups: Vec<(String, Vec<&Setting>)> = Vec::new();
    for s in &et.settings {
        let Some(key) = s.material_id.as_deref().and_then(key_of) else {
            let name = text(s.material_name.as_deref());
            p.skip(
                format!("{} · {name}", out.name),
                format!("Material not mapped: {name} isn't tied to one of your materials."),
            );
            continue;
        };
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, list)) => list.push(s),
            None => groups.push((key, vec![s])),
        }
    }
    for (key, settings) in groups {
        let label = spec.material_label(&key);
        // An export holds the plain rows only; rows on profiles are never matched or changed.
        let row = entry
            .rows
            .iter()
            .find(|r| r.material == key && r.profile.is_none());
        let unit = row.map_or(StepoverUnit::Percent, |r| r.row.stepover_unit);
        let first = text(settings[0].material_name.as_deref());
        let record = if settings.len() > 1 {
            format!(
                "{} · {first} … {}",
                out.name,
                text(settings[settings.len() - 1].material_name.as_deref())
            )
        } else {
            format!("{} · {first}", out.name)
        };
        let mut proposals = Vec::new();
        let mut refused = false;
        for s in &settings {
            match proposal(s, format, unit, entry.shape.diameter) {
                Ok(values) => proposals.push(values),
                Err(reason) => {
                    p.skip(
                        format!("{} · {}", out.name, text(s.material_name.as_deref())),
                        reason,
                    );
                    refused = true;
                    break;
                }
            }
        }
        if refused {
            continue;
        }
        if proposals.iter().any(|other| *other != proposals[0]) {
            p.skip(record, conflict_reason(&settings, &proposals, &key, format));
            continue;
        }
        let total = spec.records(&key, app).len();
        let mut ids: Vec<&str> = settings
            .iter()
            .filter_map(|s| s.material_id.as_deref())
            .collect();
        ids.sort_unstable();
        ids.dedup();
        let note = (total > 1 && ids.len() < total).then(|| {
            format!(
                "From {} of {total} {} materials.",
                ids.len(),
                format.label()
            )
        });
        let values = &proposals[0];
        let Some(row) = row else {
            // The material has rows on profiles only, and the app got the first of them as a fallback:
            // the same values coming back are no new setting.
            let fallback = entry
                .rows
                .iter()
                .find(|r| r.material == key && r.profile.is_some());
            if fallback.is_some_and(|f| {
                values
                    .iter()
                    .all(|(k, v)| !differs(f, k, *v, settings[0], format))
            }) {
                continue;
            }
            let unknown: Vec<&str> = values
                .iter()
                .filter(|(_, v)| *v == 0.0)
                .map(|(k, _)| cut_label(k).0)
                .collect();
            if !unknown.is_empty() {
                p.skip(
                    record,
                    format!(
                        "The export has 0 (unknown) for {}, so there is no setting to add.",
                        unknown.join(", ")
                    ),
                );
                continue;
            }
            let get = |k: &str| {
                values
                    .iter()
                    .find(|(key, _)| *key == k)
                    .map_or(0.0, |(_, v)| *v)
            };
            let patch = Patch::Add {
                material: key.clone(),
                values: RowValues {
                    rpm: get("rpm") as u32,
                    feed: get("feed") as u32,
                    plunge: get("plunge") as u32,
                    stepover: values[3].1,
                    stepover_unit: unit,
                    stepdown: get("stepdown"),
                },
            };
            if let Some(error) = first_error(entry.tool, &patch) {
                p.skip(record, error);
                continue;
            }
            out.changes.push(Change {
                id: p.id(),
                kind: ChangeKind::New,
                key: None,
                material: Some(key.clone()),
                material_label: Some(label.clone()),
                label: "New setting".into(),
                unit: None,
                from: None,
                to: None,
                values: Some(values_text(values)),
                selected: false,
                note,
                patch,
            });
            continue;
        };
        let s = settings[0];
        for (value_key, v) in values {
            let (value_label, value_unit) = cut_label(value_key);
            let cur = row_value(row, value_key);
            if *v == 0.0 {
                out.kept.push(format!(
                    "{label} · {value_label} {} (the export has 0, which the apps use for unknown)",
                    with_unit(cur, value_unit)
                ));
                continue;
            }
            if !differs(row, value_key, *v, s, format) {
                continue;
            }
            let patch = Patch::Update {
                material: key.clone(),
                key: (*value_key).into(),
                value: *v,
            };
            if let Some(error) = first_error(entry.tool, &patch) {
                p.skip(format!("{record} · {value_label}"), error);
                continue;
            }
            out.changes.push(Change {
                id: p.id(),
                kind: ChangeKind::Cutting,
                key: Some((*value_key).into()),
                material: Some(key.clone()),
                material_label: Some(label.clone()),
                label: value_label.into(),
                unit: Some(value_unit.into()),
                from: Some(cur),
                to: Some(*v),
                values: None,
                selected: !out.by_name,
                note: note.clone(),
                patch,
            });
        }
    }
}

/// Reads a library exported by Makera CAM or Makera Studio and holds it
/// against the tool list.
pub fn plan(library: &ToolLibrary, data: &[u8]) -> Result<Plan, String> {
    let export = lib::read_any(data, MAX_RECORDS)?;
    let format = export.format;
    let app = app_of(format);
    let spec = Spec::new(library);
    let mut p = Planning {
        plan: Plan {
            format,
            label: format!("{} export", format.label()),
            export_tools: export.groups.iter().map(|g| g.tools.len()).sum(),
            matched: 0,
            matched_by_name: 0,
            tools: Vec::new(),
            unchanged: Vec::new(),
            not_imported: Vec::new(),
            not_imported_more: 0,
        },
        next: 0,
        skipped: 0,
    };
    for (et, index, by_name) in matched_tools(&spec, &export, &mut p) {
        let entry = &spec.tools[index];
        let name = text(Some(&entry.shown_name));
        if !entry.apps.contains(&app) {
            p.skip(
                name,
                format!(
                    "Kept out of {} in your list (Tool settings, Goes to).",
                    format.label()
                ),
            );
            continue;
        }
        if let Some(problem) = identity_problem(et, entry, format) {
            p.skip(name, problem);
            continue;
        }
        p.plan.matched += 1;
        p.plan.matched_by_name += usize::from(by_name);
        let mut out = PlanTool {
            tool_id: entry.tool.id.clone(),
            name,
            group: entry.group.join(" / "),
            by_name,
            notes: Vec::new(),
            kept: Vec::new(),
            changes: Vec::new(),
        };
        if et.name.as_deref() != Some(entry.shown_name.as_str()) {
            out.notes
                .push(format!("Named {} in the export.", text(et.name.as_deref())));
        }
        plan_geometry(&mut p, &mut out, et, entry, format);
        plan_cutting(&mut p, &mut out, et, entry, &spec, format);
        if out.changes.is_empty() {
            p.plan.unchanged.push(Unchanged {
                name: out.name,
                group: out.group,
                kept: out.kept,
            });
        } else {
            p.plan.tools.push(out);
        }
    }
    p.plan.not_imported_more = p.skipped - p.plan.not_imported.len();
    Ok(p.plan)
}

/// The tool list with the ticked changes of a plan made to it.
pub fn apply_plan(
    library: &ToolLibrary,
    plan: &Plan,
    selected: &[String],
) -> Result<ToolLibrary, String> {
    let mut out = library.clone();
    for planned in &plan.tools {
        let changes: Vec<&Change> = planned
            .changes
            .iter()
            .filter(|c| selected.contains(&c.id))
            .collect();
        if changes.is_empty() {
            continue;
        }
        let tool = out
            .tools
            .iter_mut()
            .find(|t| t.id == planned.tool_id)
            .ok_or_else(|| format!("{} is no longer in the tool list.", planned.name))?;
        for change in changes {
            apply(tool, &change.patch);
        }
        settle(tool);
        // Each change was valid alone; together they must be too.
        tool.validate().map_err(|e| {
            format!(
                "{}: the ticked changes together give a tool that cannot be kept ({e}).",
                planned.name
            )
        })?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::makera::{build_cam, build_studio, write};

    const LIBRARY: &str = include_str!("../../tests/fixtures/export-library.json");
    const NOW: &str = "2026-11-17T08:00:00Z";

    fn library() -> ToolLibrary {
        crate::tools::library_from_file_json(LIBRARY).unwrap()
    }

    fn tool<'a>(lib: &'a mut Library, name: &str) -> &'a mut LibTool {
        lib.groups
            .iter_mut()
            .flat_map(|g| g.tools.iter_mut())
            .find(|t| t.name.as_deref() == Some(name))
            .unwrap()
    }

    #[test]
    fn a_library_written_from_the_list_shows_no_differences() {
        let list = library();
        let (cam, _) = build_cam(&list).unwrap();
        let plan_cam = plan(&list, &write(&cam)).unwrap();
        assert_eq!(plan_cam.format, Format::Cam);
        // The tool with a feed of 13, which Makera CAM gets as 12, is the one difference.
        let changed: Vec<&str> = plan_cam.tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(changed, ["Ø3.175×12 2F"]);
        assert_eq!(plan_cam.tools[0].changes.len(), 1);
        assert_eq!(
            (
                plan_cam.tools[0].changes[0].from,
                plan_cam.tools[0].changes[0].to
            ),
            (Some(13.0), Some(12.0))
        );
        assert_eq!(plan_cam.matched, 9);
        assert!(
            plan_cam.not_imported.is_empty(),
            "{:?}",
            plan_cam.not_imported
        );

        let (studio, _) = build_studio(&list, NOW);
        let plan_studio = plan(&list, &write(&studio)).unwrap();
        assert_eq!(plan_studio.format, Format::Studio);
        assert!(plan_studio.tools.is_empty(), "{:?}", plan_studio.tools);
        assert_eq!((plan_studio.matched, plan_studio.unchanged.len()), (9, 9));
        // The profile row that Makera Studio got as a fallback is not offered back as a new setting.
        assert!(
            plan_studio.not_imported.is_empty(),
            "{:?}",
            plan_studio.not_imported
        );
    }

    #[test]
    fn what_differs_is_offered_and_what_is_ticked_is_applied() {
        let list = library();
        let (mut studio, _) = build_studio(&list, NOW);
        {
            let t = tool(&mut studio, "Ø6×18 3F Alu DLC");
            t.geometry[lib::STUDIO_FLUTE_LENGTH] = 19.0;
            t.geometry[lib::STUDIO_LENGTH] = 0.0;
            t.settings[0].feed = 1800;
            t.settings[0].stepover_pct = 35.0;
            t.settings[0].stepover_mm = 2.1;
        }
        {
            // A setting for a material the tool has no row for, and one for a material the list does not know.
            let t = tool(&mut studio, "60° V-groove Ø12");
            let mut extra = t.settings[0].clone();
            extra.material_id = Some("00000000-0000-7000-8000-0000000000b2".into());
            extra.material_name = Some("6061 Aluminum".into());
            extra.feed = 300;
            t.settings.push(extra.clone());
            extra.material_id = Some("unknown".into());
            extra.material_name = Some("Titanium".into());
            t.settings.push(extra);
        }
        // A tool that is not in the list, and one whose diameter is another.
        let mut stranger = tool(&mut studio, "Ø2.7×16 Drill").clone();
        stranger.id = Some("{other}".into());
        stranger.name = Some("Somebody else's drill".into());
        studio.groups[0].tools.push(stranger);
        tool(&mut studio, "M3 thread mill").geometry[lib::STUDIO_DIAMETER] = 2.5;

        let p = plan(&list, &write(&studio)).unwrap();
        let alu = p
            .tools
            .iter()
            .find(|t| t.name == "Ø6×18 3F Alu DLC")
            .unwrap();
        let summary: Vec<(String, Option<f64>, Option<f64>, bool)> = alu
            .changes
            .iter()
            .map(|c| (c.key.clone().unwrap_or_default(), c.from, c.to, c.selected))
            .collect();
        // Matched by a derived id, so the cutting values come ticked; sizes never do.
        assert_eq!(
            summary,
            [
                ("flute_length".to_string(), Some(18.0), Some(19.0), false),
                ("feed".to_string(), Some(2000.0), Some(1800.0), true),
                ("stepover_pct".to_string(), Some(40.0), Some(35.0), true),
            ]
        );
        assert_eq!(
            alu.kept,
            ["Overall length 50 mm (the export has 0, which the apps use for unknown)"]
        );

        let vee = p
            .tools
            .iter()
            .find(|t| t.name == "60° V-groove Ø12")
            .unwrap();
        assert_eq!(vee.changes.len(), 1);
        assert_eq!(
            (vee.changes[0].kind, vee.changes[0].material.as_deref()),
            (ChangeKind::New, Some("aluminum"))
        );
        let reasons: Vec<&str> = p.not_imported.iter().map(|n| n.reason.as_str()).collect();
        assert!(
            reasons
                .iter()
                .any(|r| r.starts_with("Not one of your tools")),
            "{reasons:?}"
        );
        assert!(
            reasons
                .iter()
                .any(|r| r.starts_with("Material not mapped: Titanium")),
            "{reasons:?}"
        );
        assert!(
            reasons
                .iter()
                .any(|r| r.starts_with("Diameter differs: 2.42 mm in your list, 2.5 mm")),
            "{reasons:?}"
        );

        // Only what is ticked is applied.
        let ticked = vec![alu.changes[0].id.clone(), alu.changes[1].id.clone()];
        let after = apply_plan(&list, &p, &ticked).unwrap();
        let tool = after.tools.iter().find(|t| t.id == "t-alu").unwrap();
        assert_eq!(tool.flute_length, Some(19.0));
        // The shoulder was 19 and now equals the flutes: it follows them again.
        assert_eq!(tool.shoulder_length, None);
        assert_eq!(
            (tool.cutting[0].feed, tool.cutting[0].stepover),
            (1800.0, 2.4)
        );
        assert_eq!(tool.name, "Ø6×18 3F Alu");
        // Applying the rest leaves nothing to offer for that tool.
        let all: Vec<String> = alu.changes.iter().map(|c| c.id.clone()).collect();
        let done = apply_plan(&list, &p, &all).unwrap();
        let again = plan(&done, &write(&studio)).unwrap();
        assert!(again.tools.iter().all(|t| t.name != "Ø6×18 3F Alu DLC"));
    }

    #[test]
    fn a_new_setting_is_offered_for_a_material_the_tool_has_no_row_for() {
        let list = library();
        let (mut cam, _) = build_cam(&list).unwrap();
        let t = tool(&mut cam, "Ø6 Ball 2F");
        let mut extra = t.settings[0].clone();
        extra.material_id = Some("{00000000-0000-4000-8000-0000000000b1}".into());
        extra.material_name = Some("Aluminum".into());
        extra.feed = 300;
        extra.stepover_pct = 10.0;
        t.settings.push(extra);
        let p = plan(&list, &write(&cam)).unwrap();
        let ball = p.tools.iter().find(|t| t.name == "Ø6 Ball 2F").unwrap();
        assert_eq!(ball.changes.len(), 1);
        let change = &ball.changes[0];
        assert_eq!((change.kind, change.selected), (ChangeKind::New, false));
        assert_eq!(change.values.as_deref(), Some("Spindle 12000 rpm · Feed 300 mm/min · Plunge 300 mm/min · Stepover 10 % · Stepdown 1 mm"));
        let after = apply_plan(&list, &p, std::slice::from_ref(&change.id)).unwrap();
        let rows = &after
            .tools
            .iter()
            .find(|t| t.id == "t-ball")
            .unwrap()
            .cutting;
        assert_eq!(rows.len(), 2);
        assert_eq!(
            (
                rows[1].material.key(),
                rows[1].stepover,
                rows[1].stepover_unit
            ),
            ("aluminum", 0.6, StepoverUnit::Percent)
        );
    }

    #[test]
    fn a_file_that_is_no_library_is_refused() {
        assert!(plan(&library(), b"{\"kind\": \"tool-library\"}")
            .unwrap_err()
            .starts_with("not a Makera tool library"));
    }
}
