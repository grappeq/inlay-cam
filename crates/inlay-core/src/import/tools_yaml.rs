//! Import of a `cnc-tooling-library` `tools.yaml`.
//!
//! The whole file is read: every tool, cutting row, material, toolpath
//! profile and group. Unknown keys are errors, as in the tooling library
//! itself, so nothing in a file is passed over in silence. Comments are the
//! one thing a YAML reader cannot keep: those directly above a tool go into
//! its note, the rest are counted. How each key is read is in
//! `docs/formats.md`.

use serde::{Deserialize, Serialize};
use serde_yaml_ng::{Mapping, Value};

use crate::tools::{
    AppIds, CamMaterial, CutResult, CutValues, CuttingSettings, FusionType, Group, Inventory,
    Level, MakeraApp, Material, MaterialInfo, Outcome, Profile, Source, StepoverUnit,
    StudioMaterial, Tool, ToolKind, ToolLibrary, VerifyItem, WearEntry, WearKind,
};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsYamlImport {
    /// The file's materials, profiles, groups and tools, in file order. A
    /// tool's `id` is empty: the caller assigns ids.
    #[serde(flatten)]
    pub library: ToolLibrary,
    /// Tools this app cannot hold as they are written, and why.
    pub skipped: Vec<SkippedTool>,
    /// Comment lines that were directly above a tool and are now in its note.
    pub comments_moved: usize,
    /// Comment lines that were not kept.
    pub comments_dropped: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedTool {
    pub name: String,
    pub reason: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YFile {
    format_version: u32,
    #[serde(default)]
    materials: Mapping,
    #[serde(default)]
    toolpaths: Mapping,
    #[serde(default)]
    groups: Vec<YGroup>,
    tools: Vec<YTool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YIds {
    cam: Option<String>,
    studio: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YMaterial {
    cam: Option<YCamMaterial>,
    studio: Option<OneOrMany<YStudioMaterial>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YCamMaterial {
    id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YStudioMaterial {
    id: String,
    category_id: String,
    name: String,
    builtin: Option<bool>,
    modified: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum OneOrMany<T> {
    Many(Vec<T>),
    One(T),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YToolpath {
    label: String,
    note: Option<String>,
    level: Option<Level>,
    ramping: Option<bool>,
    adaptive: Option<bool>,
    lubricated: Option<bool>,
    slot: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YGroup {
    path: String,
    ids: Option<YIds>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YTool {
    name: String,
    group: Option<String>,
    #[serde(rename = "type")]
    kind: String,
    number: Option<u32>,
    coating: Option<String>,
    style: Option<String>,
    recommended_for: Option<Vec<String>>,
    note: Option<String>,
    apps: Option<Vec<MakeraApp>>,
    fusion: Option<YFusion>,
    ids: Option<YIds>,
    source: Option<YSource>,
    inventory: Option<YInventory>,
    geometry: YGeometry,
    verify: Option<Vec<YVerify>>,
    cutting: Option<Vec<YRow>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YFusion {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YSource {
    url: Option<String>,
    invoice: Option<String>,
    size_note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YInventory {
    quantity: Option<u32>,
    price: Option<f64>,
    currency: Option<String>,
    purchased: Option<String>,
    log: Option<Vec<YWear>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YWear {
    date: String,
    kind: WearKind,
    material: Option<String>,
    note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YVerify {
    field: String,
    note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YGeometry {
    diameter: f64,
    tip_diameter: Option<f64>,
    tip_angle: Option<f64>,
    length: Option<f64>,
    flutes: Option<f64>,
    shank_diameter: Option<f64>,
    flute_length: Option<f64>,
    shoulder_length: Option<f64>,
    studio_unknown_1: Option<f64>,
    thread_diameter: Option<f64>,
    pitch: Option<f64>,
    drill_diameter: Option<f64>,
}

/// A cutting row. The numbers are spelt out here and in [`YAt`], since a
/// shared, flattened part would let unknown keys through.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YRow {
    material: String,
    toolpath: Option<String>,
    rpm: u32,
    feed: f64,
    plunge: f64,
    stepover_mm: Option<f64>,
    stepover_pct: Option<f64>,
    stepdown: f64,
    passes: Option<u32>,
    log: Option<Vec<YResult>>,
    cam_flag: Option<i64>,
    cam_extra: Option<String>,
    ids: Option<YIds>,
    modified: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YResult {
    date: String,
    outcome: Option<Outcome>,
    at: Option<YAt>,
    text: String,
}

/// A row's numbers as they were for one logged cut.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct YAt {
    rpm: u32,
    feed: f64,
    plunge: f64,
    stepover_mm: Option<f64>,
    stepover_pct: Option<f64>,
    stepdown: f64,
    passes: Option<u32>,
}

pub fn import_tools_yaml(text: &str) -> Result<ToolsYamlImport, String> {
    let root: Value =
        serde_yaml_ng::from_str(text).map_err(|e| format!("The file is not valid YAML: {e}"))?;
    if root.get("tools").and_then(Value::as_sequence).is_none() {
        return Err(
            "The file has no \"tools\" list, so it does not look like a tooling-library tools.yaml."
                .into(),
        );
    }
    // Read from the text again, not from the value: only then does a mistake
    // come with its place in the file.
    let file: YFile = serde_yaml_ng::from_str(text)
        .map_err(|e| format!("The file is not laid out as a tools.yaml: {e}"))?;
    if file.format_version != 1 {
        return Err(format!(
            "This tools.yaml is format version {}; this app reads version 1.",
            file.format_version
        ));
    }

    let mut library = ToolLibrary::default();
    for (key, value) in file.materials {
        let key = map_key(&key, "materials")?;
        let material: YMaterial = from_value(value, &format!("materials.{key}"))?;
        library.materials.push(MaterialInfo {
            key: Material::new(key),
            cam: material.cam.map(|c| CamMaterial {
                id: c.id,
                name: c.name,
            }),
            studio: match material.studio {
                None => Vec::new(),
                Some(OneOrMany::One(one)) => vec![studio_material(one)],
                Some(OneOrMany::Many(many)) => many.into_iter().map(studio_material).collect(),
            },
        });
    }
    for (key, value) in file.toolpaths {
        let key = map_key(&key, "toolpaths")?;
        let profile: YToolpath = from_value(value, &format!("toolpaths.{key}"))?;
        library.profiles.push(Profile {
            key,
            label: profile.label,
            note: profile.note,
            level: profile.level,
            ramping: profile.ramping.unwrap_or(false),
            adaptive: profile.adaptive,
            lubricated: profile.lubricated.unwrap_or(false),
            slot: profile.slot.unwrap_or(false),
        });
    }
    library.groups = file
        .groups
        .into_iter()
        .map(|g| Group {
            path: g.path,
            ids: g.ids.map(ids),
        })
        .collect();

    let comments = Comments::read(text, file.tools.len());
    let mut skipped = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let mut moved = 0;
    for (index, entry) in file.tools.into_iter().enumerate() {
        let name = entry.name.clone();
        if names.contains(&name) {
            return Err(format!("Two tools are called \"{name}\"."));
        }
        names.push(name.clone());
        let mut tool = read_tool(entry).map_err(|e| format!("tools[{index}] \"{name}\": {e}"))?;
        match tool.validate() {
            Ok(()) => {
                if let Some(above) = comments.above.get(index).filter(|c| !c.text.is_empty()) {
                    tool.note = Some(match tool.note.take() {
                        Some(note) => format!("{note} {}", above.text),
                        None => above.text.clone(),
                    });
                    moved += above.lines;
                }
                library.tools.push(tool);
            }
            Err(reason) => skipped.push(SkippedTool { name, reason }),
        }
    }
    library.validate_lists().map_err(|mut message| {
        if let Some(first) = message.get_mut(0..1) {
            first.make_ascii_uppercase();
        }
        format!("{message}.")
    })?;

    Ok(ToolsYamlImport {
        library,
        skipped,
        comments_moved: moved,
        comments_dropped: comments.total - moved,
    })
}

fn map_key(key: &Value, list: &str) -> Result<String, String> {
    key.as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("{list}: every key must be text"))
}

fn from_value<T: serde::de::DeserializeOwned>(value: Value, place: &str) -> Result<T, String> {
    serde_yaml_ng::from_value(value).map_err(|e| format!("{place}: {e}"))
}

fn ids(y: YIds) -> AppIds {
    AppIds {
        cam: y.cam,
        studio: y.studio,
    }
}

fn studio_material(y: YStudioMaterial) -> StudioMaterial {
    StudioMaterial {
        id: y.id,
        category_id: y.category_id,
        name: y.name,
        builtin: y.builtin,
        modified: y.modified,
    }
}

/// Six decimals: fine enough that a percentage read as mm is the same
/// percentage when written back.
fn round(value: f64) -> f64 {
    (value * 1e6).round() / 1e6
}

fn stepover(
    mm: Option<f64>,
    pct: Option<f64>,
    diameter: f64,
) -> Result<(f64, StepoverUnit), String> {
    match (mm, pct) {
        (Some(mm), None) => Ok((mm, StepoverUnit::Mm)),
        (None, Some(pct)) => Ok((round(pct / 100.0 * diameter), StepoverUnit::Percent)),
        (Some(_), Some(_)) => Err("give stepover_mm or stepover_pct, not both".into()),
        (None, None) => Err("stepover_mm or stepover_pct is missing".into()),
    }
}

fn read_row(y: YRow, diameter: f64) -> Result<CuttingSettings, String> {
    let (stepover_mm, stepover_unit) = stepover(y.stepover_mm, y.stepover_pct, diameter)?;
    let mut log = Vec::new();
    for (i, entry) in y.log.into_iter().flatten().enumerate() {
        let at = match entry.at {
            None => None,
            Some(at) => {
                let (stepover, stepover_unit) = stepover(at.stepover_mm, at.stepover_pct, diameter)
                    .map_err(|e| format!("log[{i}].at: {e}"))?;
                Some(CutValues {
                    rpm: at.rpm,
                    feed: at.feed,
                    plunge: at.plunge,
                    stepover,
                    stepover_unit,
                    stepdown: at.stepdown,
                    passes: at.passes,
                })
            }
        };
        log.push(CutResult {
            date: entry.date,
            outcome: entry.outcome,
            at,
            text: entry.text,
        });
    }
    Ok(CuttingSettings {
        material: Material::new(y.material),
        profile: y.toolpath,
        rpm: y.rpm,
        feed: y.feed,
        plunge: y.plunge,
        stepover: stepover_mm,
        stepover_unit,
        stepdown: y.stepdown,
        passes: y.passes,
        log,
        ids: y.ids.map(ids),
        cam_flag: y.cam_flag,
        cam_extra: y.cam_extra,
        modified: y.modified,
    })
}

fn read_tool(y: YTool) -> Result<Tool, String> {
    let mut kind = match y.kind.as_str() {
        "flat_end" => ToolKind::FlatEnd,
        "v_bit" => ToolKind::VBit,
        "ball_end" => ToolKind::BallEnd,
        "drill" => ToolKind::Drill,
        "thread_mill" => ToolKind::ThreadMill,
        other => return Err(format!("unknown type \"{other}\"")),
    };
    let fusion_type = match y.fusion.as_ref().map(|f| f.kind.as_str()) {
        None => None,
        Some("chamfer mill") => Some(FusionType::ChamferMill),
        Some("radius mill") => Some(FusionType::RadiusMill),
        Some(other) => return Err(format!("unknown fusion type \"{other}\"")),
    };
    if fusion_type.is_some() && kind != ToolKind::VBit {
        return Err("only a v_bit takes a fusion type".into());
    }

    let g = &y.geometry;
    let diameter = g.diameter;
    // The tooling library stores 0 for "unknown" or "not set".
    let known = |value: Option<f64>| value.filter(|v| *v != 0.0);
    // Its default for a tip is the body diameter.
    let tip = g.tip_diameter.unwrap_or(diameter);

    let mut corner_radius = None;
    if kind == ToolKind::VBit && is_corner_rounding(fusion_type, &y.name, tip, diameter) {
        // The tooling library has no field for the radius: it is what the
        // body is wider than the tip by, on each side.
        if tip >= diameter {
            return Err("a corner-rounding cutter needs a tip narrower than its body".into());
        }
        kind = ToolKind::CornerRound;
        corner_radius = Some(round((diameter - tip) / 2.0));
    }
    let flute_length = known(g.flute_length);

    let mut cutting = Vec::new();
    for (i, row) in y.cutting.into_iter().flatten().enumerate() {
        cutting.push(read_row(row, diameter).map_err(|e| format!("cutting[{i}]: {e}"))?);
    }

    Ok(Tool {
        // A V-bit always says where its cone ends; other tools only when
        // the file gives something other than the default.
        tip_diameter: match kind {
            ToolKind::VBit | ToolKind::CornerRound => Some(tip),
            _ => g.tip_diameter.filter(|t| *t != diameter),
        },
        corner_radius,
        tip_angle: known(g.tip_angle),
        flute_length,
        shoulder_length: known(g.shoulder_length).filter(|s| Some(*s) != flute_length),
        shank_diameter: known(g.shank_diameter).unwrap_or(diameter),
        length: known(g.length),
        flutes: known(g.flutes).map(|v| v as u32),
        thread_diameter: known(g.thread_diameter),
        pitch: known(g.pitch),
        drill_diameter: known(g.drill_diameter),
        studio_unknown_1: known(g.studio_unknown_1),
        group: y.group,
        number: y.number,
        coating: y.coating,
        style: y.style,
        note: y.note,
        recommended_for: y
            .recommended_for
            .into_iter()
            .flatten()
            .map(Material::new)
            .collect(),
        apps: y.apps,
        fusion_type,
        ids: y.ids.map(ids),
        source: y.source.map(|s| Source {
            url: s.url,
            invoice: s.invoice,
            size_note: s.size_note,
        }),
        inventory: y.inventory.map(|inv| Inventory {
            quantity: inv.quantity,
            price: inv.price,
            currency: inv.currency,
            purchased: inv.purchased,
            log: inv
                .log
                .into_iter()
                .flatten()
                .map(|entry| WearEntry {
                    date: entry.date,
                    kind: entry.kind,
                    material: entry.material.map(Material::new),
                    note: entry.note,
                })
                .collect(),
        }),
        verify: y
            .verify
            .into_iter()
            .flatten()
            .map(|item| VerifyItem {
                field: item.field,
                note: item.note,
            })
            .collect(),
        cutting,
        ..Tool::new(y.name, kind, diameter)
    })
}

/// Same rule as the tooling library: an explicit Fusion type, or a telling
/// name on a cutter whose tip is narrower than its body.
fn is_corner_rounding(fusion: Option<FusionType>, name: &str, tip: f64, diameter: f64) -> bool {
    match fusion {
        Some(FusionType::RadiusMill) => return true,
        Some(FusionType::ChamferMill) => return false,
        None => {}
    }
    let lower = name.to_lowercase();
    let named = ["fillet", "corner round", "radius"]
        .iter()
        .any(|word| lower.contains(word));
    named && tip > 0.0 && tip < diameter
}

/// The comment lines directly above one tool, as one line of text.
#[derive(Default, Clone)]
struct Above {
    text: String,
    lines: usize,
}

/// The comments of a file, found by reading its lines: a YAML reader drops
/// them.
struct Comments {
    /// Per tool, in file order. Empty when the lines could not be matched to
    /// the tools one to one; no comment is moved then.
    above: Vec<Above>,
    /// Every line that holds only a comment.
    total: usize,
}

impl Comments {
    fn read(text: &str, tools: usize) -> Self {
        let mut above = Vec::new();
        let mut pending = Above::default();
        let mut total = 0;
        let mut in_tools = false;
        // Indentation of the tool list's items, known from its first one.
        let mut item_indent: Option<usize> = None;
        for line in text.lines() {
            let trimmed = line.trim_start();
            let indent = line.len() - trimmed.len();
            if let Some(comment) = trimmed.strip_prefix('#') {
                total += 1;
                let comment = comment.trim_start_matches('#').trim();
                if !comment.is_empty() {
                    if !pending.text.is_empty() {
                        pending.text.push(' ');
                    }
                    pending.text.push_str(comment);
                }
                pending.lines += 1;
                continue;
            }
            let is_item = trimmed.starts_with("- ") || trimmed == "-";
            if indent == 0 && !trimmed.is_empty() && !is_item {
                in_tools = trimmed.starts_with("tools:");
            } else if in_tools && is_item && item_indent.is_none_or(|i| i == indent) {
                item_indent = Some(indent);
                above.push(std::mem::take(&mut pending));
            }
            pending = Above::default();
        }
        if above.len() != tools {
            above.clear();
        }
        Comments { above, total }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every key a tools.yaml can hold, with made-up names, ids and prices.
    pub(crate) const SAMPLE: &str = r#"
# A made-up tool list.
format_version: 1
materials:
  hardwood:
    cam: {id: "{00000000-0000-4000-8000-00000000000a}", name: Hardwood}
    studio: {id: 00000000-0000-7000-8000-00000000000b, category_id: 00000000-0000-7000-8000-00000000000c, name: Hardwood}
  softwood:
    cam: {id: "{00000000-0000-4000-8000-00000000001a}", name: Softwood}
  aluminum:
    cam: {id: "{00000000-0000-4000-8000-00000000002a}", name: Aluminum}
    studio:
      - {id: 00000000-0000-7000-8000-00000000002b, category_id: 00000000-0000-7000-8000-00000000002c, name: 6061 Aluminum}
      - {id: 00000000-0000-7000-8000-00000000002d, category_id: 00000000-0000-7000-8000-00000000002c, name: Hand-made, builtin: false, modified: "2026-01-02T03:04:05Z"}
toolpaths:
  adaptive: {label: Adaptive, note: Stepover is the optimal load., level: standard, ramping: true, lubricated: true}
  finish: {label: Finishing, adaptive: false, slot: true}
groups:
  - path: End mills
    ids: {cam: "{00000000-0000-4000-8000-0000000000e1}"}
tools:
  # The everyday cutter.
  # Sharp until proven otherwise.
  - name: Ø3.175×22 1F Downcut
    group: End mills
    type: flat_end
    number: 1
    coating: DLC
    style: Downcut
    recommended_for: [hardwood, softwood]
    note: Ramp in aluminium.
    apps: [cam]
    ids: {cam: "{00000000-0000-4000-8000-0000000000a1}", studio: "{00000000-0000-4000-8000-0000000000a2}"}
    source: {url: "https://example.com/mill", invoice: 1/2026, size_note: 3.175x22}
    inventory:
      quantity: 2
      price: 35
      currency: EUR
      purchased: 2026-01-15
      log:
        - {date: "2026-02-01", kind: broken, material: aluminum, note: Snapped on a plunge.}
    geometry: {diameter: 3.175, flute_length: 22, shoulder_length: 23, shank_diameter: 3.175, length: 45, flutes: 1, tip_angle: 60, studio_unknown_1: 0.5}
    verify:
      - {field: length, note: Measure it.}
    cutting:
      - material: hardwood
        rpm: 12000
        feed: 600
        plunge: 90
        stepover_pct: 40
        stepdown: 0.62
        cam_flag: 1
        cam_extra: "1"
        ids: {cam: "{00000000-0000-4000-8000-0000000000c1}"}
        modified: "2026-01-02T03:04:05Z"
        log:
          - {date: "2026-03-01", outcome: failed, at: {rpm: 12000, feed: 900, plunge: 90, stepover_pct: 40, stepdown: 0.62}, text: Chatter.}
          - {date: "2026-03-02", outcome: ok, at: {rpm: 12000, feed: 600, plunge: 90, stepover_pct: 40, stepdown: 0.62}, text: Clean.}
          - {date: "2025-12-24", text: From before entries recorded their numbers.}
      - {material: hardwood, toolpath: adaptive, rpm: 12000, feed: 900, plunge: 90, stepover_mm: 0.3, stepdown: 3}
      - {material: softwood, rpm: 12000, feed: 700, plunge: 110, stepover_mm: 1.2, stepdown: 0.8}
      - {material: aluminum, toolpath: finish, rpm: 12000, feed: 250, plunge: 60, stepover_pct: 33.333, stepdown: 0.3}

  - name: Ø2×6 S4 2F
    type: flat_end
    geometry: {diameter: 2, flute_length: 6, shank_diameter: 4, length: 50, flutes: 2}
  - name: Ø1 Ball S4 2F
    type: ball_end
    apps: []
    geometry: {diameter: 1, shank_diameter: 4, length: 50, flutes: 2}
  - name: 60° V-groove Ø12 S6
    type: v_bit
    fusion: {type: chamfer mill}
    geometry: {diameter: 12, tip_diameter: 0.1, tip_angle: 60, flute_length: 15.5, shank_diameter: 6, length: 46.5, flutes: 2}
  - name: 0.2×30° Engraver S3.175
    type: v_bit
    geometry: {diameter: 3.175, tip_diameter: 0.2, tip_angle: 30, flute_length: 0, shank_diameter: 3.175, length: 0}
  - name: R1 Corner Round Ø4
    type: v_bit
    geometry: {diameter: 4, tip_diameter: 2, tip_angle: 90, flute_length: 1, shank_diameter: 4, length: 50, flutes: 4}
  - name: Odd cutter
    type: v_bit
    fusion: {type: radius mill}
    geometry: {diameter: 4, tip_diameter: 2, tip_angle: 90}
  # Stubby.
  - name: Ø2.7×16 Drill S4
    type: drill
    geometry: {diameter: 2.7, tip_diameter: 1, tip_angle: 118, flute_length: 16, shank_diameter: 4}
  - name: M3×0.5 Thread Mill 9 reach
    type: thread_mill
    geometry: {diameter: 2.42, tip_diameter: 1, tip_angle: 60, thread_diameter: 3, pitch: 0.5, drill_diameter: 2.5}
    cutting:
      - {material: aluminum, rpm: 12000, feed: 100, plunge: 50, stepover_pct: 10, stepdown: 0.5, passes: 3}
  - name: Blunt cone
    type: v_bit
    geometry: {diameter: 6, tip_angle: 90}
"#;

    fn import() -> ToolsYamlImport {
        import_tools_yaml(SAMPLE).unwrap()
    }

    fn tool<'a>(import: &'a ToolsYamlImport, name: &str) -> &'a Tool {
        import
            .library
            .tools
            .iter()
            .find(|t| t.name == name)
            .unwrap_or_else(|| panic!("no tool {name}"))
    }

    #[test]
    fn every_kind_of_tool_comes_in() {
        let import = import();
        let kinds: Vec<(&str, ToolKind)> = import
            .library
            .tools
            .iter()
            .map(|t| (t.name.as_str(), t.kind))
            .collect();
        assert_eq!(
            kinds,
            [
                ("Ø3.175×22 1F Downcut", ToolKind::FlatEnd),
                ("Ø2×6 S4 2F", ToolKind::FlatEnd),
                ("Ø1 Ball S4 2F", ToolKind::BallEnd),
                ("60° V-groove Ø12 S6", ToolKind::VBit),
                ("0.2×30° Engraver S3.175", ToolKind::VBit),
                ("R1 Corner Round Ø4", ToolKind::CornerRound),
                ("Odd cutter", ToolKind::CornerRound),
                ("Ø2.7×16 Drill S4", ToolKind::Drill),
                ("M3×0.5 Thread Mill 9 reach", ToolKind::ThreadMill),
            ]
        );
        assert!(import.library.tools.iter().all(|t| t.id.is_empty()));
        // What comes in is a library that only lacks its ids.
        let mut library = import.library.clone();
        for (i, tool) in library.tools.iter_mut().enumerate() {
            tool.id = format!("t{i}");
        }
        assert_eq!(library.validate(), Ok(()));
    }

    #[test]
    fn a_corner_rounding_bit_is_told_by_its_fusion_type_or_its_name() {
        let import = import();
        for name in ["R1 Corner Round Ø4", "Odd cutter"] {
            let bit = tool(&import, name);
            assert_eq!(bit.corner_radius, Some(1.0));
            assert_eq!(bit.tip_diameter, Some(2.0));
            // Kept, since the file needs it back when it is written.
            assert_eq!(bit.tip_angle, Some(90.0));
        }
        // Only a type chosen by hand is remembered as chosen.
        assert_eq!(tool(&import, "R1 Corner Round Ø4").fusion_type, None);
        assert_eq!(
            tool(&import, "Odd cutter").fusion_type,
            Some(FusionType::RadiusMill)
        );
        let groove = tool(&import, "60° V-groove Ø12 S6");
        assert_eq!(groove.fusion_type, Some(FusionType::ChamferMill));
        assert_eq!(
            (groove.tip_angle, groove.tip_diameter, groove.shank_diameter),
            (Some(60.0), Some(0.1), 6.0)
        );
    }

    #[test]
    fn geometry_is_read_whole() {
        let import = import();
        let mill = tool(&import, "Ø3.175×22 1F Downcut");
        assert_eq!(
            (mill.diameter, mill.flute_length, mill.length, mill.flutes),
            (3.175, Some(22.0), Some(45.0), Some(1))
        );
        assert_eq!(
            (mill.shoulder_length, mill.studio_unknown_1),
            (Some(23.0), Some(0.5))
        );
        // The 60 the Makera apps store on end mills is kept for writing back;
        // a tip equal to the body is the default and is not.
        assert_eq!((mill.tip_angle, mill.tip_diameter), (Some(60.0), None));

        let drill = tool(&import, "Ø2.7×16 Drill S4");
        assert_eq!(
            (drill.tip_angle, drill.tip_diameter),
            (Some(118.0), Some(1.0))
        );
        let thread = tool(&import, "M3×0.5 Thread Mill 9 reach");
        assert_eq!(
            (thread.thread_diameter, thread.pitch, thread.drill_diameter),
            (Some(3.0), Some(0.5), Some(2.5))
        );
        assert_eq!(thread.cutting[0].passes, Some(3));
    }

    #[test]
    fn zero_means_unknown() {
        let import = import();
        let engraver = tool(&import, "0.2×30° Engraver S3.175");
        assert_eq!(
            (engraver.flute_length, engraver.length, engraver.flutes),
            (None, None, None)
        );
    }

    #[test]
    fn every_row_comes_in_with_its_profile_and_stepover_unit() {
        let import = import();
        let mill = tool(&import, "Ø3.175×22 1F Downcut");
        let rows: Vec<_> = mill
            .cutting
            .iter()
            .map(|c| (c.material.key(), c.profile.as_deref(), c.stepover_unit))
            .collect();
        assert_eq!(
            rows,
            [
                ("hardwood", None, StepoverUnit::Percent),
                ("hardwood", Some("adaptive"), StepoverUnit::Mm),
                ("softwood", None, StepoverUnit::Mm),
                ("aluminum", Some("finish"), StepoverUnit::Percent),
            ]
        );
        let hard = mill.cutting_for(&Material::HARDWOOD).unwrap();
        assert_eq!(
            (
                hard.rpm,
                hard.feed,
                hard.plunge,
                hard.stepover,
                hard.stepdown
            ),
            (12000, 600.0, 90.0, 1.27, 0.62)
        );
        assert_eq!(
            (
                hard.cam_flag,
                hard.cam_extra.as_deref(),
                hard.modified.as_deref()
            ),
            (Some(1), Some("1"), Some("2026-01-02T03:04:05Z"))
        );
        assert_eq!(mill.cutting_for(&Material::SOFTWOOD).unwrap().stepover, 1.2);
        // A percentage kept as mm is the same percentage when turned back.
        let finish = &mill.cutting[3];
        let percent = (finish.stepover / mill.diameter * 100_000.0).round() / 1000.0;
        assert_eq!(percent, 33.333);
    }

    #[test]
    fn the_field_log_knows_which_entry_is_current() {
        let import = import();
        let mill = tool(&import, "Ø3.175×22 1F Downcut");
        let hard = mill.cutting_for(&Material::HARDWOOD).unwrap();
        assert_eq!(hard.log.len(), 3);
        assert_eq!(hard.log[0].at.as_ref().unwrap().feed, 900.0);
        assert_eq!(hard.log[2].at, None);
        let current = hard.current_result().unwrap();
        assert_eq!(
            (current.outcome, current.text.as_str()),
            (Some(Outcome::Ok), "Clean.")
        );
    }

    #[test]
    fn what_a_tool_is_and_where_it_came_from_is_kept() {
        let import = import();
        let mill = tool(&import, "Ø3.175×22 1F Downcut");
        assert_eq!(mill.group.as_deref(), Some("End mills"));
        assert_eq!(
            (mill.number, mill.coating.as_deref(), mill.style.as_deref()),
            (Some(1), Some("DLC"), Some("Downcut"))
        );
        assert_eq!(
            mill.recommended_for,
            [Material::HARDWOOD, Material::SOFTWOOD]
        );
        assert_eq!(mill.apps, Some(vec![MakeraApp::Cam]));
        assert_eq!(tool(&import, "Ø1 Ball S4 2F").apps, Some(vec![]));
        assert_eq!(tool(&import, "Ø2×6 S4 2F").apps, None);
        let source = mill.source.as_ref().unwrap();
        assert_eq!(source.invoice.as_deref(), Some("1/2026"));
        let inventory = mill.inventory.as_ref().unwrap();
        assert_eq!(
            (
                inventory.quantity,
                inventory.price,
                inventory.currency.as_deref()
            ),
            (Some(2), Some(35.0), Some("EUR"))
        );
        // An unquoted date is still text.
        assert_eq!(inventory.purchased.as_deref(), Some("2026-01-15"));
        assert_eq!(inventory.log[0].kind, WearKind::Broken);
        assert_eq!(inventory.log[0].material, Some(Material::new("aluminum")));
        assert_eq!(mill.verify[0].field, "length");
        let studio_id = mill.ids.as_ref().unwrap().studio.as_deref().unwrap();
        assert!(studio_id.ends_with("a2}"));
    }

    #[test]
    fn materials_profiles_and_groups_come_in_file_order() {
        let library = import().library;
        let keys: Vec<&str> = library.materials.iter().map(|m| m.key.key()).collect();
        assert_eq!(keys, ["hardwood", "softwood", "aluminum"]);
        assert_eq!(library.materials[0].studio.len(), 1);
        assert_eq!(library.materials[1].studio.len(), 0);
        let hand_made = &library.materials[2].studio[1];
        assert_eq!(
            (hand_made.name.as_str(), hand_made.builtin),
            ("Hand-made", Some(false))
        );

        let adaptive = &library.profiles[0];
        assert_eq!(
            (
                adaptive.key.as_str(),
                adaptive.level,
                adaptive.ramping,
                adaptive.lubricated
            ),
            ("adaptive", Some(Level::Standard), true, true)
        );
        assert!(adaptive.is_adaptive() && !adaptive.slot);
        let finish = &library.profiles[1];
        assert!(!finish.is_adaptive() && finish.slot);
        assert_eq!(library.groups[0].path, "End mills");
        assert!(library.groups[0].ids.as_ref().unwrap().studio.is_none());
    }

    #[test]
    fn comments_above_a_tool_go_into_its_note_and_the_rest_are_counted() {
        let import = import();
        assert_eq!(
            tool(&import, "Ø3.175×22 1F Downcut").note.as_deref(),
            Some("Ramp in aluminium. The everyday cutter. Sharp until proven otherwise.")
        );
        assert_eq!(
            tool(&import, "Ø2.7×16 Drill S4").note.as_deref(),
            Some("Stubby.")
        );
        assert_eq!(tool(&import, "Ø2×6 S4 2F").note, None);
        assert_eq!((import.comments_moved, import.comments_dropped), (3, 1));
    }

    #[test]
    fn a_tool_this_app_cannot_hold_is_left_out_with_the_reason() {
        let import = import();
        // No tip diameter means "same as the body" in the tooling library: not a V-bit shape.
        assert_eq!(import.skipped.len(), 1);
        assert_eq!(import.skipped[0].name, "Blunt cone");
        assert!(import.skipped[0].reason.contains("tip diameter"));
    }

    #[test]
    fn a_mistake_in_the_file_is_an_error_that_says_where() {
        let broken = |from: &str, to: &str| {
            assert!(SAMPLE.contains(from), "{from}");
            import_tools_yaml(&SAMPLE.replacen(from, to, 1)).unwrap_err()
        };
        // A misspelt key.
        let e = broken("flute_length: 6,", "flute_lenght: 6,");
        assert!(e.contains("flute_lenght"), "{e}");
        let e = broken("coating: DLC", "coatnig: DLC");
        assert!(e.contains("coatnig"), "{e}");
        let e = broken("stepover_mm: 1.2,", "stepover: 1.2,");
        assert!(e.contains("`stepover`"), "{e}");
        let e = broken(
            "feed: 900, plunge: 90, stepover_pct",
            "fed: 900, plunge: 90, stepover_pct",
        );
        assert!(e.contains("fed"), "{e}");
        let e = broken("label: Finishing", "lable: Finishing");
        assert!(e.contains("toolpaths.finish") && e.contains("lable"), "{e}");
        // A key written twice.
        let e = broken("number: 1\n", "number: 1\n    number: 2\n");
        assert!(e.contains("number"), "{e}");
        // Both stepovers, or neither.
        let e = broken("stepover_mm: 0.3,", "stepover_mm: 0.3, stepover_pct: 10,");
        assert!(e.contains("not both") && e.contains("cutting[1]"), "{e}");
        let e = broken("stepover_mm: 0.3, ", "");
        assert!(
            e.contains("is missing") && e.contains("Ø3.175×22 1F Downcut"),
            "{e}"
        );
        // Something the lists do not hold.
        let e = broken("material: softwood,", "material: oak,");
        assert!(e.contains("\"oak\" is not in the material list"), "{e}");
        let e = broken("toolpath: finish,", "toolpath: rest,");
        assert!(e.contains("\"rest\" is not in the profile list"), "{e}");
        // Others.
        let e = broken("type: drill", "type: laser");
        assert!(e.contains("unknown type \"laser\""), "{e}");
        let e = broken("name: Ø2×6 S4 2F", "name: Ø1 Ball S4 2F");
        assert!(e.contains("Two tools are called"), "{e}");
        let e = broken("format_version: 1", "format_version: 2");
        assert!(e.contains("format version 2"), "{e}");
    }

    #[test]
    fn rejects_files_that_are_not_a_tool_spec() {
        assert!(import_tools_yaml("just: a map").is_err());
        assert!(import_tools_yaml(": : :").is_err());
    }

    /// Optional check against a real file, which is never part of the
    /// repository:
    /// `INLAY_TOOLS_YAML=path/to/tools.yaml cargo test -p inlay-core real_tools_yaml -- --nocapture`
    #[test]
    fn real_tools_yaml_imports_when_provided() {
        let Ok(path) = std::env::var("INLAY_TOOLS_YAML") else {
            return;
        };
        let import = import_tools_yaml(&std::fs::read_to_string(path).unwrap()).unwrap();
        let library = &import.library;
        println!(
            "{} tools, {} left out, {} materials, {} profiles, {} groups; comments: {} moved, {} dropped",
            library.tools.len(),
            import.skipped.len(),
            library.materials.len(),
            library.profiles.len(),
            library.groups.len(),
            import.comments_moved,
            import.comments_dropped
        );
        let mut kinds = std::collections::BTreeMap::new();
        for tool in &library.tools {
            *kinds.entry(format!("{:?}", tool.kind)).or_insert(0) += 1;
        }
        println!("  {kinds:?}");
        println!(
            "  {} cutting rows, {} log entries",
            library.tools.iter().map(|t| t.cutting.len()).sum::<usize>(),
            library
                .tools
                .iter()
                .flat_map(|t| &t.cutting)
                .map(|c| c.log.len())
                .sum::<usize>()
        );
        for skipped in &import.skipped {
            println!("  left out {}: {}", skipped.name, skipped.reason);
        }
        assert!(!library.tools.is_empty());
    }
}
