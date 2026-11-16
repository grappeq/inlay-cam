//! Cutting tools and the tool-library file.
//!
//! Lengths are mm, angles are degrees, feeds are mm/min.

use std::borrow::Cow;

use serde::{Deserialize, Serialize};

use crate::file::{self, FileError, Migration};

/// Current version of the tool-library file. Raise it, and add a migration,
/// whenever an old file could no longer be read as written. Fields added with
/// a default keep the version (see `file.rs`).
pub const TOOL_LIBRARY_FORMAT_VERSION: u32 = 1;
pub const TOOL_LIBRARY_KIND: &str = "tool-library";

/// Migrations for tool-library files: entry `i` upgrades version `i + 1`.
const MIGRATIONS: &[Migration] = &[];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    FlatEnd,
    VBit,
    /// A corner-rounding (fillet) bit: its cutting edge is a quarter circle
    /// that rounds over the top edge it is run along.
    CornerRound,
    /// Kept in the tool list and written for other CAM programs; no operation
    /// of this app cuts with it.
    BallEnd,
    /// As for a ball end mill.
    Drill,
    /// As for a ball end mill.
    ThreadMill,
}

impl ToolKind {
    /// Whether any operation of this app can cut with such a tool.
    pub fn is_used_by_operations(self) -> bool {
        matches!(
            self,
            ToolKind::FlatEnd | ToolKind::VBit | ToolKind::CornerRound
        )
    }
}

/// What is being cut, as a key such as `hardwood` or `aluminum`. It chooses
/// which cutting settings of a tool are used. Hardwood and softwood are always
/// known; any other key is described in the tool library's material list.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Material(Cow<'static, str>);

impl Material {
    pub const HARDWOOD: Material = Material(Cow::Borrowed("hardwood"));
    pub const SOFTWOOD: Material = Material(Cow::Borrowed("softwood"));

    pub fn new(key: impl Into<String>) -> Self {
        Material(Cow::Owned(key.into()))
    }

    pub fn key(&self) -> &str {
        &self.0
    }

    /// Hardwood and softwood need no entry in a library's material list.
    pub fn is_built_in(&self) -> bool {
        *self == Self::HARDWOOD || *self == Self::SOFTWOOD
    }
}

/// How a stepover was entered. The value is always kept in mm; this says
/// which unit to show and write it in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepoverUnit {
    #[default]
    Mm,
    /// A share of the tool's diameter.
    Percent,
}

impl StepoverUnit {
    fn is_mm(&self) -> bool {
        *self == StepoverUnit::Mm
    }
}

/// Ids a group, tool or cutting row has in the Makera apps' own libraries.
/// Kept so that a library written for those apps matches what they hold.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppIds {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cam: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub studio: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Ok,
    /// Worked, still to confirm.
    Provisional,
    Failed,
}

/// The numbers of a cutting row, as they were for one cut.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutValues {
    pub rpm: u32,
    pub feed: f64,
    pub plunge: f64,
    /// mm, whatever the unit.
    pub stepover: f64,
    #[serde(default, skip_serializing_if = "StepoverUnit::is_mm")]
    pub stepover_unit: StepoverUnit,
    pub stepdown: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passes: Option<u32>,
}

/// One dated result of cutting with a row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutResult {
    /// `YYYY-MM-DD`.
    pub date: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
    /// The row's numbers for that cut. `None` for an entry from before
    /// entries recorded them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<CutValues>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuttingSettings {
    pub material: Material,
    /// Key of the toolpath profile this row is tuned for. `None` for the
    /// plain row, which is safe for any toolpath, a full-width slot included.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    /// Spindle speed, rev/min.
    pub rpm: u32,
    /// Feed rate while cutting sideways, mm/min.
    pub feed: f64,
    /// Feed rate while cutting straight down, mm/min.
    pub plunge: f64,
    /// Sideways distance between passes, mm.
    pub stepover: f64,
    #[serde(default, skip_serializing_if = "StepoverUnit::is_mm")]
    pub stepover_unit: StepoverUnit,
    /// Depth per pass, mm.
    pub stepdown: f64,
    /// Thread mill only: radial passes to cut the thread.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passes: Option<u32>,
    /// What happened when this row was used, in the order written.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub log: Vec<CutResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ids: Option<AppIds>,
    /// Makera CAM only: a number the app stores with each setting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cam_flag: Option<i64>,
    /// Makera CAM only: a string the app stores with each setting.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cam_extra: Option<String>,
    /// Makera Studio only: when the setting was changed, ISO-8601 UTC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
}

impl CuttingSettings {
    /// A plain row with a stepover in mm and nothing logged.
    pub fn new(
        material: Material,
        rpm: u32,
        feed: f64,
        plunge: f64,
        stepover: f64,
        stepdown: f64,
    ) -> Self {
        CuttingSettings {
            material,
            profile: None,
            rpm,
            feed,
            plunge,
            stepover,
            stepover_unit: StepoverUnit::Mm,
            stepdown,
            passes: None,
            log: Vec::new(),
            ids: None,
            cam_flag: None,
            cam_extra: None,
            modified: None,
        }
    }

    /// The row's numbers as a log entry records them.
    pub fn values(&self) -> CutValues {
        CutValues {
            rpm: self.rpm,
            feed: self.feed,
            plunge: self.plunge,
            stepover: self.stepover,
            stepover_unit: self.stepover_unit,
            stepdown: self.stepdown,
            passes: self.passes,
        }
    }

    /// The newest log entry that was cut at the row's present numbers (of one
    /// date, the one written last). Entries at other numbers, or without
    /// numbers, say nothing about the row as it is now.
    pub fn current_result(&self) -> Option<&CutResult> {
        let now = self.values();
        self.log
            .iter()
            .filter(|entry| entry.at.as_ref() == Some(&now))
            .fold(None, |best: Option<&CutResult>, entry| match best {
                Some(b) if b.date > entry.date => Some(b),
                _ => Some(entry),
            })
    }
}

/// A Makera library a tool can be written into.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MakeraApp {
    Cam,
    Studio,
}

/// The Fusion 360 tool type a V-bit is written as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FusionType {
    ChamferMill,
    RadiusMill,
}

/// Where a tool came from.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invoice: Option<String>,
    /// The size as the shop lists it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_note: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WearKind {
    Broken,
    Worn,
}

/// One cutter that broke or wore out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WearEntry {
    /// `YYYY-MM-DD`.
    pub date: String,
    pub kind: WearKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material: Option<Material>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// How many cutters there are, what one cost, and which ones were lost.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    /// Pieces on hand.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quantity: Option<u32>,
    /// Price per piece, in `currency`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    /// Three capital letters, such as `EUR`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
    /// Date of the most recent purchase, `YYYY-MM-DD`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purchased: Option<String>,
    /// Oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub log: Vec<WearEntry>,
}

/// Something about a tool that is still to be checked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyItem {
    /// A geometry field, or a free label such as "pilot diameter".
    pub field: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    /// Unique within a tool list. Assigned by the app, never shown.
    pub id: String,
    pub name: String,
    pub kind: ToolKind,
    /// Cutting diameter. For a V-bit, the diameter at the top of the cone.
    pub diameter: f64,
    /// V-bit: diameter of the flat at the tip, 0 for a perfect point.
    /// Corner-rounding bit: diameter of the tip below the rounded edge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tip_diameter: Option<f64>,
    /// Corner-rounding bit only: radius of the rounded edge it cuts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub corner_radius: Option<f64>,
    /// V-bit only: included angle between the two cutting edges.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tip_angle: Option<f64>,
    /// Length of the cutting edges along the tool axis. `None` when unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flute_length: Option<f64>,
    /// From the tip to where the body widens to the shank. `None` when it is
    /// the flute length.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shoulder_length: Option<f64>,
    pub shank_diameter: f64,
    /// Overall length. `None` when unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flutes: Option<u32>,
    /// Thread mill only: diameter of the thread, such as 2.5 for M2.5.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_diameter: Option<f64>,
    /// Thread mill only: thread pitch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pitch: Option<f64>,
    /// Thread mill only: diameter of the hole drilled before threading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drill_diameter: Option<f64>,
    /// Makera Studio only: a stored value the app does not show.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub studio_unknown_1: Option<f64>,
    /// Where the tool is filed, with "/" between nested groups.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// The tool number other CAM programs list it under.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coating: Option<String>,
    /// A word or two that sets the tool apart from others of its size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    /// One line about the whole tool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Materials the tool suits.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recommended_for: Vec<Material>,
    /// The Makera libraries the tool goes into. `None` means both.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apps: Option<Vec<MakeraApp>>,
    /// Set only when the Fusion 360 type was chosen by hand.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fusion_type: Option<FusionType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ids: Option<AppIds>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Source>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inventory: Option<Inventory>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verify: Vec<VerifyItem>,
    /// At most one row per material and profile.
    #[serde(default)]
    pub cutting: Vec<CuttingSettings>,
}

impl Tool {
    /// A tool with a shank as wide as its cutting diameter and nothing else
    /// known about it. Its id is empty.
    pub fn new(name: impl Into<String>, kind: ToolKind, diameter: f64) -> Self {
        Tool {
            id: String::new(),
            name: name.into(),
            kind,
            diameter,
            tip_diameter: None,
            corner_radius: None,
            tip_angle: None,
            flute_length: None,
            shoulder_length: None,
            shank_diameter: diameter,
            length: None,
            flutes: None,
            thread_diameter: None,
            pitch: None,
            drill_diameter: None,
            studio_unknown_1: None,
            group: None,
            number: None,
            coating: None,
            style: None,
            note: None,
            recommended_for: Vec::new(),
            apps: None,
            fusion_type: None,
            ids: None,
            source: None,
            inventory: None,
            verify: Vec::new(),
            cutting: Vec::new(),
        }
    }

    /// The plain row for a material: the one safe for any toolpath.
    pub fn cutting_for(&self, material: &Material) -> Option<&CuttingSettings> {
        self.cutting_row(material, None)
    }

    /// The row for a material and a toolpath profile; `None` asks for the
    /// plain row.
    pub fn cutting_row(
        &self,
        material: &Material,
        profile: Option<&str>,
    ) -> Option<&CuttingSettings> {
        self.cutting
            .iter()
            .find(|c| c.material == *material && c.profile.as_deref() == profile)
    }

    /// The tool as a project file carries it: what is needed to cut with it,
    /// without where it was bought, what it cost, how many are left, what
    /// was logged about it, or its ids in other programs. A project file is
    /// made to be passed on; those belong to the owner's tool list.
    pub fn for_sharing(&self) -> Tool {
        let mut tool = self.clone();
        tool.source = None;
        tool.inventory = None;
        tool.verify.clear();
        tool.ids = None;
        for row in &mut tool.cutting {
            row.log.clear();
            row.ids = None;
            row.cam_flag = None;
            row.cam_extra = None;
            row.modified = None;
        }
        tool
    }

    /// Checks that the tool describes something that can exist and cut.
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("name must not be empty".into());
        }
        positive(self.diameter, "diameter")?;
        positive(self.shank_diameter, "shank diameter")?;
        if let Some(v) = self.flute_length {
            positive(v, "flute length")?;
        }
        if let Some(v) = self.length {
            positive(v, "overall length")?;
        }
        if let Some(v) = self.shoulder_length {
            positive(v, "shoulder length")?;
            if self.flute_length.is_some_and(|flutes| v < flutes) {
                return Err("shoulder length must be at least the flute length".into());
            }
        }
        for (value, what) in [
            (self.thread_diameter, "thread diameter"),
            (self.pitch, "pitch"),
            (self.drill_diameter, "drill diameter"),
        ] {
            if let Some(v) = value {
                positive(v, what)?;
            }
        }
        match self.kind {
            ToolKind::FlatEnd | ToolKind::BallEnd => {}
            ToolKind::Drill => {
                let angle = self.tip_angle.ok_or("a drill needs a tip angle")?;
                if !(angle.is_finite() && angle > 0.0 && angle < 180.0) {
                    return Err("tip angle must be between 0 and 180 degrees".into());
                }
            }
            ToolKind::ThreadMill => {
                if let Some(thread) = self.thread_diameter {
                    for (value, what) in [
                        (self.pitch, "pitch"),
                        (self.drill_diameter, "drill diameter"),
                    ] {
                        if value.is_some_and(|v| v >= thread) {
                            return Err(format!("{what} must be smaller than the thread diameter"));
                        }
                    }
                }
            }
            ToolKind::VBit => {
                let angle = self.tip_angle.ok_or("a V-bit needs a tip angle")?;
                if !(angle.is_finite() && angle > 0.0 && angle < 180.0) {
                    return Err("tip angle must be between 0 and 180 degrees".into());
                }
                let tip = self.tip_diameter.unwrap_or(0.0);
                if !(tip.is_finite() && tip >= 0.0 && tip < self.diameter) {
                    return Err(
                        "tip diameter must be 0 or more and smaller than the diameter".into(),
                    );
                }
            }
            ToolKind::CornerRound => {
                let radius = self
                    .corner_radius
                    .ok_or("a corner-rounding bit needs a corner radius")?;
                positive(radius, "corner radius")?;
                let tip = self.tip_diameter.unwrap_or(0.0);
                if !(tip.is_finite() && tip >= 0.0) {
                    return Err("tip diameter must be 0 or more".into());
                }
                if tip + 2.0 * radius > self.diameter + 1e-6 {
                    return Err(
                        "the diameter must be at least the tip diameter plus twice the corner radius"
                            .into(),
                    );
                }
            }
        }
        if has_duplicates(&self.recommended_for) {
            return Err("a material is listed twice under recommended for".into());
        }
        if let Some(inventory) = &self.inventory {
            inventory.validate()?;
        }
        for (i, item) in self.verify.iter().enumerate() {
            if item.field.trim().is_empty() {
                return Err("an item to verify needs a field".into());
            }
            if self.verify[..i].iter().any(|o| o.field == item.field) {
                return Err(format!("\"{}\" is listed twice to verify", item.field));
            }
        }
        for (i, c) in self.cutting.iter().enumerate() {
            if c.material.key().trim().is_empty() {
                return Err("cutting settings need a material".into());
            }
            if c.rpm == 0 {
                return Err("spindle speed must be greater than 0".into());
            }
            positive(c.feed, "feed")?;
            positive(c.plunge, "plunge")?;
            positive(c.stepover, "stepover")?;
            positive(c.stepdown, "stepdown")?;
            // A percentage that comes to exactly the diameter may be off by rounding.
            if c.stepover > self.diameter * (1.0 + 1e-9) {
                return Err("stepover must not be larger than the diameter".into());
            }
            if c.passes == Some(0) {
                return Err("passes must be greater than 0".into());
            }
            if self.cutting[..i]
                .iter()
                .any(|other| other.material == c.material && other.profile == c.profile)
            {
                return Err(match &c.profile {
                    None => "only one set of cutting settings per material".into(),
                    Some(profile) => format!(
                        "only one set of cutting settings per material for the profile \"{profile}\""
                    ),
                });
            }
            for entry in &c.log {
                real_date(&entry.date)?;
                if entry.text.trim().is_empty() {
                    return Err("a log entry needs a text".into());
                }
            }
        }
        Ok(())
    }
}

impl Inventory {
    fn validate(&self) -> Result<(), String> {
        if let Some(price) = self.price {
            if !(price.is_finite() && price >= 0.0) {
                return Err("price must be 0 or more".into());
            }
        }
        match (&self.price, &self.currency) {
            (Some(_), None) => return Err("a price needs a currency".into()),
            (None, Some(_)) => return Err("a currency needs a price".into()),
            _ => {}
        }
        if let Some(currency) = &self.currency {
            if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
                return Err("currency must be three capital letters, such as EUR".into());
            }
        }
        if let Some(date) = &self.purchased {
            real_date(date)?;
        }
        for entry in &self.log {
            real_date(&entry.date)?;
        }
        Ok(())
    }
}

fn positive(value: f64, what: &str) -> Result<(), String> {
    if value.is_finite() && value > 0.0 {
        Ok(())
    } else {
        Err(format!("{what} must be greater than 0"))
    }
}

fn has_duplicates<T: PartialEq>(items: &[T]) -> bool {
    items
        .iter()
        .enumerate()
        .any(|(i, item)| items[..i].contains(item))
}

/// Checks a `YYYY-MM-DD` date that exists in the calendar.
fn real_date(text: &str) -> Result<(), String> {
    let wrong = || format!("\"{text}\" is not a date written as YYYY-MM-DD");
    let bytes = text.as_bytes();
    let shaped = bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| match i {
            4 | 7 => *b == b'-',
            _ => b.is_ascii_digit(),
        });
    if !shaped {
        return Err(wrong());
    }
    let number = |range: std::ops::Range<usize>| text[range].parse::<u32>().unwrap_or(0);
    let (year, month, day) = (number(0..4), number(5..7), number(8..10));
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return Err(wrong()),
    };
    if day == 0 || day > days {
        return Err(wrong());
    }
    Ok(())
}

/// Checks every tool and that ids are unique.
pub fn validate_tools(tools: &[Tool]) -> Result<(), String> {
    for (i, tool) in tools.iter().enumerate() {
        tool.validate()
            .map_err(|e| format!("tool \"{}\": {e}", tool.name))?;
        if tool.id.is_empty() {
            return Err(format!("tool \"{}\" has no id", tool.name));
        }
        if tools[..i].iter().any(|other| other.id == tool.id) {
            return Err(format!("two tools share the id \"{}\"", tool.id));
        }
    }
    Ok(())
}

/// A material's record in Makera CAM.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CamMaterial {
    pub id: String,
    pub name: String,
}

/// A material's record in Makera Studio.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioMaterial {
    pub id: String,
    pub category_id: String,
    pub name: String,
    /// `Some(false)` for a material added in the app by hand.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builtin: Option<bool>,
    /// For a material added by hand: its creation time, ISO-8601 UTC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
}

/// A material that cutting settings can be given for, and the records the
/// Makera apps hold for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterialInfo {
    pub key: Material,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cam: Option<CamMaterial>,
    /// Makera Studio splits some materials into several.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub studio: Vec<StudioMaterial>,
}

/// How hard a suggested cut is, from the feeds model's five stops.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Gentle,
    SlotSafe,
    Standard,
    Firm,
    Aggressive,
}

/// A kind of toolpath a tool can keep a second row per material for, such as
/// adaptive clearing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// 1 to 40 lowercase letters, digits or `_`. Never changes.
    pub key: String,
    /// What is shown, such as "Adaptive".
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Where suggestions for this profile's rows start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<Level>,
    /// The suggested plunge is for a ramped entry.
    #[serde(default, skip_serializing_if = "is_false")]
    pub ramping: bool,
    /// Suggestions are shaped for adaptive clearing: a light sideways cut
    /// and a deep stepdown, unsafe as a full-width slot. `None` means yes for
    /// the key `adaptive` and no for any other.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive: Option<bool>,
    /// The cut gets light lubrication.
    #[serde(default, skip_serializing_if = "is_false")]
    pub lubricated: bool,
    /// A full-width cut, such as a slot or a contour.
    #[serde(default, skip_serializing_if = "is_false")]
    pub slot: bool,
}

impl Profile {
    pub fn is_adaptive(&self) -> bool {
        self.adaptive.unwrap_or(self.key == "adaptive")
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// A group whose ids in the Makera apps are pinned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ids: Option<AppIds>,
}

/// Everything a tool-library file holds.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLibrary {
    /// In the order they are shown. Hardwood and softwood need no entry.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub materials: Vec<MaterialInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub profiles: Vec<Profile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub groups: Vec<Group>,
    pub tools: Vec<Tool>,
}

impl ToolLibrary {
    pub fn knows_material(&self, material: &Material) -> bool {
        material.is_built_in() || self.materials.iter().any(|m| m.key == *material)
    }

    pub fn profile(&self, key: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| p.key == key)
    }

    /// Checks the tools, and that everything they refer to is in the library.
    pub fn validate(&self) -> Result<(), String> {
        for (i, material) in self.materials.iter().enumerate() {
            let key = material.key.key();
            if key.trim().is_empty() || key != key.trim() {
                return Err("a material needs a key without spaces around it".into());
            }
            if self.materials[..i].iter().any(|o| o.key == material.key) {
                return Err(format!("the material \"{key}\" is listed twice"));
            }
        }
        for (i, profile) in self.profiles.iter().enumerate() {
            let key = &profile.key;
            let well_formed = (1..=40).contains(&key.len())
                && key
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
            if !well_formed {
                return Err(format!(
                    "the profile key \"{key}\" must be 1 to 40 lowercase letters, digits or _"
                ));
            }
            if profile.label.trim().is_empty() {
                return Err(format!("the profile \"{key}\" needs a label"));
            }
            for other in &self.profiles[..i] {
                if other.key == *key {
                    return Err(format!("the profile \"{key}\" is listed twice"));
                }
                if other.label.to_lowercase() == profile.label.to_lowercase() {
                    return Err(format!("two profiles are labelled \"{}\"", profile.label));
                }
            }
        }
        for (i, group) in self.groups.iter().enumerate() {
            if self.groups[..i].iter().any(|o| o.path == group.path) {
                return Err(format!("the group \"{}\" is listed twice", group.path));
            }
        }
        validate_tools(&self.tools)?;
        for tool in &self.tools {
            let wear = tool.inventory.iter().flat_map(|inventory| &inventory.log);
            let materials = tool
                .cutting
                .iter()
                .map(|c| &c.material)
                .chain(&tool.recommended_for)
                .chain(wear.filter_map(|entry| entry.material.as_ref()));
            for material in materials {
                if !self.knows_material(material) {
                    return Err(format!(
                        "tool \"{}\": the material \"{}\" is not in the material list",
                        tool.name,
                        material.key()
                    ));
                }
            }
            for profile in tool.cutting.iter().filter_map(|c| c.profile.as_deref()) {
                if self.profile(profile).is_none() {
                    return Err(format!(
                        "tool \"{}\": the profile \"{profile}\" is not in the profile list",
                        tool.name
                    ));
                }
            }
        }
        Ok(())
    }
}

/// Writes a tool library as a tool-library file.
pub fn library_to_file_json(library: &ToolLibrary) -> String {
    file::write(TOOL_LIBRARY_KIND, TOOL_LIBRARY_FORMAT_VERSION, library)
}

/// Reads a tool-library file written by this or any earlier version of the app.
pub fn library_from_file_json(text: &str) -> Result<ToolLibrary, FileError> {
    let library: ToolLibrary = file::read(
        text,
        TOOL_LIBRARY_KIND,
        TOOL_LIBRARY_FORMAT_VERSION,
        MIGRATIONS,
    )?;
    library.validate().map_err(FileError::Invalid)?;
    Ok(library)
}

/// Writes a tool list alone as a tool-library file.
pub fn tools_to_file_json(tools: &[Tool]) -> String {
    library_to_file_json(&ToolLibrary {
        tools: tools.to_vec(),
        ..ToolLibrary::default()
    })
}

/// Reads the tools of a tool-library file.
pub fn tools_from_file_json(text: &str) -> Result<Vec<Tool>, FileError> {
    library_from_file_json(text).map(|library| library.tools)
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub fn end_mill() -> Tool {
        Tool {
            id: "t-endmill".into(),
            flute_length: Some(22.0),
            length: Some(45.0),
            flutes: Some(1),
            cutting: vec![CuttingSettings::new(
                Material::HARDWOOD,
                12000,
                600.0,
                90.0,
                1.27,
                0.62,
            )],
            ..Tool::new("Ø3.175×22 1F Downcut", ToolKind::FlatEnd, 3.175)
        }
    }

    /// A 3 mm corner-rounding bit with a 2 mm tip.
    pub fn fillet_bit() -> Tool {
        Tool {
            id: "t-fillet".into(),
            tip_diameter: Some(2.0),
            corner_radius: Some(3.0),
            flute_length: Some(6.0),
            shank_diameter: 6.0,
            length: Some(40.0),
            flutes: Some(2),
            cutting: vec![CuttingSettings::new(
                Material::HARDWOOD,
                12000,
                500.0,
                150.0,
                0.5,
                1.5,
            )],
            ..Tool::new("R3 corner rounding", ToolKind::CornerRound, 8.0)
        }
    }

    pub fn v_bit() -> Tool {
        Tool {
            id: "t-vbit".into(),
            tip_diameter: Some(0.1),
            tip_angle: Some(60.0),
            flute_length: Some(15.5),
            shank_diameter: 6.0,
            length: Some(46.5),
            flutes: Some(2),
            ..Tool::new("60° V-groove Ø12 S6", ToolKind::VBit, 12.0)
        }
    }

    /// A library that uses every field a tool-library file can hold. The
    /// names, ids, shop and prices are made up.
    pub fn full_library() -> ToolLibrary {
        let aluminum = Material::new("aluminum");
        let slot_safe = CuttingSettings {
            stepover: 2.4,
            stepover_unit: StepoverUnit::Percent,
            ids: Some(AppIds {
                cam: Some("{00000000-0000-4000-8000-0000000000c1}".into()),
                studio: Some("00000000-0000-7000-8000-0000000000d1".into()),
            }),
            cam_flag: Some(1),
            cam_extra: Some("1".into()),
            modified: Some("2026-01-02T03:04:05Z".into()),
            ..CuttingSettings::new(Material::HARDWOOD, 12000, 2000.0, 180.0, 2.4, 1.75)
        };
        let mut adaptive = CuttingSettings::new(aluminum.clone(), 12000, 800.0, 180.0, 0.72, 3.0);
        adaptive.profile = Some("adaptive".into());
        adaptive.log = vec![
            CutResult {
                date: "2026-02-01".into(),
                outcome: Some(Outcome::Failed),
                at: Some(CutValues {
                    feed: 550.0,
                    stepdown: 6.0,
                    ..adaptive.values()
                }),
                text: "Spindle alarm after a few minutes.".into(),
            },
            CutResult {
                date: "2026-02-02".into(),
                outcome: Some(Outcome::Provisional),
                at: Some(adaptive.values()),
                text: "Edges clean.".into(),
            },
            CutResult {
                date: "2025-12-24".into(),
                outcome: None,
                at: None,
                text: "From before entries recorded their numbers.".into(),
            },
        ];
        let end_mill = Tool {
            id: "t-alu".into(),
            flute_length: Some(18.0),
            shoulder_length: Some(19.0),
            length: Some(50.0),
            flutes: Some(3),
            studio_unknown_1: Some(0.5),
            group: Some("End mills/Metal".into()),
            number: Some(4),
            coating: Some("DLC".into()),
            style: Some("Alu".into()),
            note: Some("Ramp every aluminium operation.".into()),
            recommended_for: vec![Material::HARDWOOD, aluminum.clone()],
            apps: Some(vec![MakeraApp::Cam]),
            ids: Some(AppIds {
                cam: Some("{00000000-0000-4000-8000-0000000000a1}".into()),
                studio: None,
            }),
            source: Some(Source {
                url: Some("https://example.com/end-mill".into()),
                invoice: Some("1/2026".into()),
                size_note: Some("6x18x6Dx50L".into()),
            }),
            inventory: Some(Inventory {
                quantity: Some(1),
                price: Some(24.5),
                currency: Some("EUR".into()),
                purchased: Some("2026-01-15".into()),
                log: vec![WearEntry {
                    date: "2026-02-01".into(),
                    kind: WearKind::Broken,
                    material: Some(aluminum.clone()),
                    note: Some("Snapped on a plunge.".into()),
                }],
            }),
            verify: vec![VerifyItem {
                field: "length".into(),
                note: Some("The shop lists two lengths. Measure it.".into()),
            }],
            cutting: vec![slot_safe, adaptive],
            ..Tool::new("Ø6×18 3F Alu", ToolKind::FlatEnd, 6.0)
        };
        let chamfer = Tool {
            id: "t-chamfer".into(),
            tip_diameter: Some(0.0),
            tip_angle: Some(90.0),
            fusion_type: Some(FusionType::ChamferMill),
            apps: Some(vec![]),
            ..Tool::new("90° Chamfer Ø6", ToolKind::VBit, 6.0)
        };
        ToolLibrary {
            materials: vec![MaterialInfo {
                key: aluminum,
                cam: Some(CamMaterial {
                    id: "{00000000-0000-4000-8000-0000000000b1}".into(),
                    name: "Aluminum".into(),
                }),
                studio: vec![StudioMaterial {
                    id: "00000000-0000-7000-8000-0000000000b2".into(),
                    category_id: "00000000-0000-7000-8000-0000000000b3".into(),
                    name: "6061 Aluminum".into(),
                    builtin: Some(false),
                    modified: Some("2026-01-02T03:04:05Z".into()),
                }],
            }],
            profiles: vec![Profile {
                key: "adaptive".into(),
                label: "Adaptive".into(),
                note: Some("Stepover is the optimal load.".into()),
                level: Some(Level::Standard),
                ramping: true,
                adaptive: Some(true),
                lubricated: true,
                slot: false,
            }],
            groups: vec![Group {
                path: "End mills".into(),
                ids: Some(AppIds {
                    cam: Some("{00000000-0000-4000-8000-0000000000e1}".into()),
                    studio: None,
                }),
            }],
            tools: vec![end_mill, chamfer],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn a_corner_rounding_bit_needs_a_radius_that_fits_its_body() {
        let mut bit = fillet_bit();
        assert_eq!(bit.validate(), Ok(()));
        let text = tools_to_file_json(std::slice::from_ref(&bit));
        assert!(text.contains("corner_round") && text.contains("cornerRadius"));
        assert_eq!(tools_from_file_json(&text).unwrap(), vec![bit.clone()]);
        bit.corner_radius = Some(4.0);
        assert!(bit
            .validate()
            .unwrap_err()
            .contains("twice the corner radius"));
        bit.corner_radius = None;
        assert!(bit
            .validate()
            .unwrap_err()
            .contains("needs a corner radius"));
    }

    #[test]
    fn valid_tools_pass() {
        assert_eq!(end_mill().validate(), Ok(()));
        assert_eq!(v_bit().validate(), Ok(()));
    }

    #[test]
    fn v_bit_needs_an_angle_and_a_tip_smaller_than_the_body() {
        let mut tool = v_bit();
        tool.tip_angle = None;
        assert!(tool.validate().is_err());

        let mut tool = v_bit();
        tool.tip_diameter = Some(12.0);
        assert!(tool.validate().is_err());

        let mut tool = v_bit();
        tool.tip_diameter = None;
        assert_eq!(
            tool.validate(),
            Ok(()),
            "a missing tip means a perfect point"
        );
    }

    #[test]
    fn duplicate_material_rows_are_rejected() {
        let mut tool = end_mill();
        tool.cutting.push(tool.cutting[0].clone());
        assert!(tool.validate().is_err());
    }

    #[test]
    fn a_material_takes_one_plain_row_and_one_per_profile() {
        let mut tool = end_mill();
        let mut adaptive = tool.cutting[0].clone();
        adaptive.profile = Some("adaptive".into());
        adaptive.feed = 900.0;
        tool.cutting.insert(0, adaptive.clone());
        assert_eq!(tool.validate(), Ok(()));

        // The plain row is the one used unless a profile is asked for.
        assert_eq!(tool.cutting_for(&Material::HARDWOOD).unwrap().feed, 600.0);
        let row = tool.cutting_row(&Material::HARDWOOD, Some("adaptive"));
        assert_eq!(row.unwrap().feed, 900.0);
        assert_eq!(tool.cutting_row(&Material::HARDWOOD, Some("finish")), None);
        assert_eq!(tool.cutting_for(&Material::SOFTWOOD), None);

        tool.cutting.push(adaptive);
        assert!(tool.validate().unwrap_err().contains("adaptive"));
    }

    #[test]
    fn the_current_result_is_the_newest_one_at_the_rows_numbers() {
        let mut row = end_mill().cutting.remove(0);
        assert_eq!(row.current_result(), None);
        let entry = |date: &str, outcome, at, text: &str| CutResult {
            date: date.into(),
            outcome: Some(outcome),
            at,
            text: text.into(),
        };
        let faster = CutValues {
            feed: 900.0,
            ..row.values()
        };
        row.log = vec![
            entry("2026-03-02", Outcome::Failed, Some(row.values()), "first"),
            entry("2026-03-02", Outcome::Ok, Some(row.values()), "second"),
            entry("2026-03-01", Outcome::Failed, Some(row.values()), "older"),
            entry("2026-03-09", Outcome::Failed, Some(faster), "other numbers"),
            entry("2026-03-10", Outcome::Failed, None, "numbers unknown"),
        ];
        assert_eq!(row.current_result().unwrap().text, "second");

        // Changing the row's numbers leaves it untested.
        row.feed = 900.0;
        assert_eq!(row.current_result().unwrap().text, "other numbers");
        row.stepover_unit = StepoverUnit::Percent;
        assert_eq!(row.current_result(), None);
    }

    #[test]
    fn dates_must_exist() {
        for good in ["2026-01-31", "2024-02-29", "2000-02-29"] {
            assert_eq!(real_date(good), Ok(()), "{good}");
        }
        for bad in [
            "2026-02-29",
            "1900-02-29",
            "2026-13-01",
            "2026-04-31",
            "2026-00-10",
            "2026-01-00",
            "2026-1-1",
            "26-01-01",
            "2026/01/01",
            "",
        ] {
            assert!(real_date(bad).is_err(), "{bad}");
        }
        let mut tool = end_mill();
        tool.cutting[0].log.push(CutResult {
            date: "yesterday".into(),
            outcome: None,
            at: None,
            text: "Fine.".into(),
        });
        assert!(tool.validate().unwrap_err().contains("yesterday"));
    }

    #[test]
    fn a_price_and_its_currency_come_together() {
        let mut tool = end_mill();
        tool.inventory = Some(Inventory {
            price: Some(10.0),
            ..Inventory::default()
        });
        assert!(tool.validate().unwrap_err().contains("currency"));
        tool.inventory.as_mut().unwrap().currency = Some("eur".into());
        assert!(tool.validate().unwrap_err().contains("capital"));
        tool.inventory.as_mut().unwrap().currency = Some("EUR".into());
        assert_eq!(tool.validate(), Ok(()));
        tool.inventory.as_mut().unwrap().price = None;
        assert!(tool.validate().unwrap_err().contains("price"));
    }

    #[test]
    fn a_library_must_hold_what_its_tools_refer_to() {
        assert_eq!(full_library().validate(), Ok(()));

        let mut library = full_library();
        library.materials.clear();
        assert!(library
            .validate()
            .unwrap_err()
            .contains("\"aluminum\" is not in the material list"));

        let mut library = full_library();
        library.profiles.clear();
        assert!(library
            .validate()
            .unwrap_err()
            .contains("\"adaptive\" is not in the profile list"));

        let mut library = full_library();
        library.profiles.push(Profile {
            key: "rest".into(),
            label: "ADAPTIVE".into(),
            ..library.profiles[0].clone()
        });
        assert!(library.validate().unwrap_err().contains("labelled"));
        library.profiles[1].label = "Rest".into();
        assert_eq!(library.validate(), Ok(()));
        library.profiles[1].key = "Rest machining".into();
        assert!(library.validate().unwrap_err().contains("profile key"));
    }

    #[test]
    fn a_profile_called_adaptive_is_adaptive_unless_it_says_otherwise() {
        let mut profile = full_library().profiles.remove(0);
        profile.adaptive = None;
        assert!(profile.is_adaptive());
        profile.adaptive = Some(false);
        assert!(!profile.is_adaptive());
        profile.adaptive = None;
        profile.key = "finish".into();
        assert!(!profile.is_adaptive());
    }

    #[test]
    fn ball_end_mills_drills_and_thread_mills_are_kept_but_not_cut_with() {
        let ball = Tool::new("Ø1 Ball", ToolKind::BallEnd, 1.0);
        let mut drill = Tool::new("Ø2.7 Drill", ToolKind::Drill, 2.7);
        let mut thread = Tool::new("M3 Thread Mill", ToolKind::ThreadMill, 2.42);
        assert_eq!(ball.validate(), Ok(()));
        assert!(drill.validate().unwrap_err().contains("tip angle"));
        drill.tip_angle = Some(118.0);
        assert_eq!(drill.validate(), Ok(()));
        assert_eq!(thread.validate(), Ok(()));
        thread.thread_diameter = Some(3.0);
        thread.pitch = Some(0.5);
        thread.drill_diameter = Some(2.5);
        assert_eq!(thread.validate(), Ok(()));
        thread.pitch = Some(3.0);
        assert!(thread.validate().unwrap_err().contains("pitch"));
        thread.pitch = Some(0.5);

        let mut tools = vec![ball, drill, thread];
        for (i, tool) in tools.iter_mut().enumerate() {
            tool.id = format!("t{i}");
            assert!(!tool.kind.is_used_by_operations());
        }
        let text = tools_to_file_json(&tools);
        assert!(["ball_end", "drill", "thread_mill"]
            .iter()
            .all(|kind| text.contains(&format!("\"kind\": \"{kind}\""))));
        assert_eq!(tools_from_file_json(&text).unwrap(), tools);
        assert!(ToolKind::CornerRound.is_used_by_operations());
    }

    #[test]
    fn a_shared_tool_keeps_what_cuts_and_drops_what_is_the_owners() {
        let full = full_library().tools.remove(0);
        let shared = full.for_sharing();
        assert_eq!(
            (&shared.source, &shared.inventory, &shared.ids),
            (&None, &None, &None)
        );
        assert!(shared.verify.is_empty());
        assert!(shared.cutting.iter().all(|row| row.log.is_empty()
            && row.ids.is_none()
            && row.cam_flag.is_none()
            && row.cam_extra.is_none()
            && row.modified.is_none()));

        // Geometry, the note and every row's numbers stay.
        assert_eq!(shared.note, full.note);
        assert_eq!(shared.shoulder_length, full.shoulder_length);
        let values = |tool: &Tool| {
            tool.cutting
                .iter()
                .map(|row| (row.material.clone(), row.profile.clone(), row.values()))
                .collect::<Vec<_>>()
        };
        assert_eq!(values(&shared), values(&full));
        assert_eq!(end_mill().for_sharing(), end_mill());
    }

    #[test]
    fn library_round_trips() {
        let tools = vec![end_mill(), v_bit()];
        let text = tools_to_file_json(&tools);
        assert_eq!(tools_from_file_json(&text).unwrap(), tools);

        let library = full_library();
        let text = library_to_file_json(&library);
        assert_eq!(library_from_file_json(&text).unwrap(), library);
    }

    #[test]
    fn duplicate_ids_are_rejected_on_load() {
        let text = tools_to_file_json(&[end_mill(), end_mill()]);
        assert!(matches!(
            tools_from_file_json(&text),
            Err(FileError::Invalid(_))
        ));
    }

    /// Files from every released format version must keep loading.
    #[test]
    fn version_1_fixture_loads() {
        let text = include_str!("../tests/fixtures/tool-library-v1.json");
        let tools = tools_from_file_json(text).unwrap();
        assert_eq!(tools, vec![end_mill(), v_bit()]);
        assert_eq!(
            tools[0].cutting_for(&Material::HARDWOOD).unwrap().feed,
            600.0
        );
    }

    /// Tools that use none of the fields added later are written exactly as
    /// they were before those fields existed.
    #[test]
    fn plain_tools_are_written_as_before() {
        let text = include_str!("../tests/fixtures/tool-library-v1.json");
        let lines = |text: &str| text.lines().map(str::to_string).collect::<Vec<_>>();
        assert_eq!(
            lines(&tools_to_file_json(&[end_mill(), v_bit()])),
            lines(text)
        );
    }

    /// A version 1 file from after materials, profiles, logs and the rest
    /// were added.
    #[test]
    fn full_version_1_fixture_loads() {
        let text = include_str!("../tests/fixtures/tool-library-v1-full.json");
        assert_eq!(library_from_file_json(text).unwrap(), full_library());
    }

    /// Writes the full fixture from the sample. Run by hand, once, never to
    /// "fix" a failing fixture test:
    /// `cargo test -p inlay-core write_full_tool_fixture -- --ignored`
    #[test]
    #[ignore]
    fn write_full_tool_fixture() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
        std::fs::write(
            format!("{dir}/tool-library-v1-full.json"),
            library_to_file_json(&full_library()),
        )
        .unwrap();
    }
}
