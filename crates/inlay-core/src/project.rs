//! The project: an imported design, the inlay steps made from it, and the
//! tools those steps use. Also the project file.

use serde::{Deserialize, Serialize};

use crate::file::{self, FileError, Migration};
use crate::geom::{Region, Ring};
use std::collections::BTreeMap;

use crate::tools::{validate_tools, CuttingSettings, Material, Profile, StepoverUnit, Tool};

/// Current version of the project file. Raise it, and add a migration,
/// whenever an old file could no longer be read as written.
pub const PROJECT_FORMAT_VERSION: u32 = 3;
pub const PROJECT_KIND: &str = "project";

/// Migrations for project files: entry `i` upgrades version `i + 1`.
const MIGRATIONS: &[Migration] = &[steps_from_jobs, stock_material];

/// Version 1 to 2. What the list holds was called a job and kept what it
/// does under `inlay`, from when the app made inlays only. It holds
/// operations and steps done by hand as well: the list is `steps`, and what
/// a step does is its `task`. Nothing else changes.
fn steps_from_jobs(mut file: serde_json::Value) -> Result<serde_json::Value, String> {
    let project = file
        .get_mut("project")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or("the file has no project")?;
    if let Some(mut jobs) = project.remove("jobs") {
        for job in jobs.as_array_mut().ok_or("the jobs are not a list")? {
            let job = job.as_object_mut().ok_or("a job is not an object")?;
            if let Some(inlay) = job.remove("inlay") {
                job.insert("task".into(), inlay);
            }
        }
        project.insert("steps".into(), jobs);
    }
    file["formatVersion"] = 2.into();
    Ok(file)
}

/// Version 2 to 3. Every step said what it was cut in. The stock is one
/// board: what it is made of is said once, under `base`, and a step's own
/// `material` is left for the wood of an inlay's plug or insert. The stock
/// takes the material of the first operation that cuts it, else of the
/// first inlay, whose pocket was cut in it.
fn stock_material(mut file: serde_json::Value) -> Result<serde_json::Value, String> {
    let project = file
        .get_mut("project")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or("the file has no project")?;
    let kind = |step: &serde_json::Value| step["task"]["type"].as_str().unwrap_or("").to_string();
    let steps = project
        .get("steps")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    // A facing that starts above the surface trims a plug: it was in the plug's wood.
    let cuts_stock = |step: &&serde_json::Value| match kind(step).as_str() {
        "pocket" | "contour" | "chamfer" => true,
        "facing" => {
            let task = &step["task"];
            !(task["above"].as_f64().unwrap_or(0.0) > 0.0
                || task["aboveAuto"].as_bool().unwrap_or(false))
        }
        _ => false,
    };
    let is_inlay = |step: &&serde_json::Value| matches!(kind(step).as_str(), "vcarve" | "flat");
    let material = steps
        .iter()
        .find(cuts_stock)
        .or_else(|| steps.iter().find(is_inlay))
        .and_then(|step| step.get("material").cloned());
    if let Some(material) = material {
        let base = project
            .entry("base")
            .or_insert_with(|| serde_json::json!({ "thickness": BaseStock::default().thickness }));
        if let Some(base) = base.as_object_mut() {
            base.entry("material").or_insert(material);
        }
    }
    file["formatVersion"] = 3.into();
    Ok(file)
}

fn hardwood() -> Material {
    Material::HARDWOOD
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub design: Option<Design>,
    #[serde(default)]
    pub steps: Vec<Step>,
    /// Copies of the tools the steps refer to, so the project opens correctly
    /// on a machine with a different tool list.
    #[serde(default)]
    pub tools: Vec<Tool>,
    /// The number each of the project's tools goes by in every file made
    /// from it, by the tool's id: the machine is loaded once, and each file
    /// calls for the same tool by the same number. A tool without a number
    /// is given one by the file that uses it, among those not taken here.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tool_numbers: BTreeMap<String, u32>,
    /// Copies of the toolpath profiles the steps' row choices name, so the
    /// project knows what each is for wherever it is opened.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub profiles: Vec<Profile>,
    /// The board the pockets are cut into.
    #[serde(default)]
    pub base: BaseStock,
    /// The machine the files are for.
    #[serde(default)]
    pub machine: Machine,
    /// Clearances and tabs for an inlay that has none of its own: one from a
    /// file written before each inlay had them.
    #[serde(default)]
    pub setup: Setup,
}

/// The machine the output is for. The G-code is always written for the
/// Carvera Community Firmware; these are the limits the files are checked
/// against.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Machine {
    pub name: String,
    /// Lowest spindle speed the feeds model suggests, rpm.
    pub min_rpm: u32,
    /// Top spindle speed, rpm. The feeds model runs woods and plastics at it.
    pub max_rpm: u32,
    /// Rapid speed, mm/min, used for time estimates.
    pub rapid_rate: f64,
    /// How far the tool can move in X and Y, mm.
    pub travel: [f64; 2],
    /// Number of the first tool in a file; the rest follow in the order the
    /// tools are used. On a Carvera with a tool rack, T1 to T6 are rack
    /// slots and are loaded automatically, whatever is in them.
    pub first_tool: u32,
    /// Time one tool change takes, seconds, for the time estimates. 0
    /// leaves tool changes out of them.
    #[serde(skip_serializing_if = "is_zero")]
    pub tool_change_seconds: f64,
}

fn is_zero(v: &f64) -> bool {
    *v == 0.0
}

fn is_false(v: &bool) -> bool {
    !*v
}

/// The most a tool change may be said to take, seconds.
pub const MAX_TOOL_CHANGE_SECONDS: f64 = 3600.0;

impl Default for Machine {
    fn default() -> Self {
        Self {
            name: "Carvera Air".into(),
            min_rpm: 5000,
            max_rpm: 13000,
            rapid_rate: 2000.0,
            travel: [300.0, 200.0],
            first_tool: 1,
            tool_change_seconds: 0.0,
        }
    }
}

impl Machine {
    pub fn validate(&self) -> Result<(), String> {
        let ok = |v: f64| v.is_finite() && v > 0.0;
        if self.name.trim().is_empty() {
            return Err("the machine needs a name".into());
        }
        if self.max_rpm == 0 {
            return Err("the machine's top spindle speed must be greater than 0".into());
        }
        // A lowest speed over the top speed is not refused: a file from
        // before the lowest speed was kept may have a slow top speed. The
        // feeds model holds it to the top speed.
        if self.min_rpm == 0 {
            return Err("the machine's lowest spindle speed must be greater than 0".into());
        }
        if !(self.tool_change_seconds.is_finite()
            && self.tool_change_seconds >= 0.0
            && self.tool_change_seconds <= MAX_TOOL_CHANGE_SECONDS)
        {
            return Err("the time for a tool change must be from 0 to 3600 seconds".into());
        }
        if !ok(self.rapid_rate) {
            return Err("the machine's rapid speed must be greater than 0".into());
        }
        if !ok(self.travel[0]) || !ok(self.travel[1]) {
            return Err("the machine's travel must be greater than 0".into());
        }
        if !(1..=99).contains(&self.first_tool) {
            return Err("the first tool number must be from 1 to 99".into());
        }
        Ok(())
    }
}

/// Clearances and tabs: how the files of a project are cut, whatever the
/// inlay. Lengths in mm.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Setup {
    /// Height above the board at which the tool travels between cuts.
    pub safe_height: f64,
    /// Height above already-cut wood at which a rapid descent stops and the
    /// plunge feed takes over.
    pub plunge_clearance: f64,
    /// How far past the bottom of its board a part is cut, so that it comes
    /// free cleanly.
    pub through_cut: f64,
    /// Width of wood left in each tab.
    pub tab_width: f64,
    /// Roughly how far apart tabs are along an outline.
    pub tab_spacing: f64,
    /// Thickness of a tab. Never more than half the board.
    pub tab_thickness: f64,
    /// Board left around a plug that is cut out of it, beyond the width of
    /// the cut.
    pub cut_out_border: f64,
    /// How steeply an end mill goes down into wood, in degrees from level:
    /// it descends along its path instead of plunging. 0 plunges straight.
    pub ramp_angle: f64,
    /// Wood left on walls by the passes that clear or cut out, and taken off
    /// in one light pass at the end. 0 leaves none.
    pub finish_allowance: f64,
}

impl Default for Setup {
    fn default() -> Self {
        Self {
            safe_height: 5.0,
            plunge_clearance: 1.0,
            through_cut: 0.2,
            tab_width: 4.0,
            tab_spacing: 40.0,
            tab_thickness: 1.0,
            cut_out_border: 5.0,
            ramp_angle: 5.0,
            finish_allowance: 0.1,
        }
    }
}

impl Setup {
    /// The least and the most each may be. The plunge height is also held
    /// to the travel height.
    pub const LOWEST: Setup = Setup {
        safe_height: 1.0,
        plunge_clearance: 0.1,
        through_cut: 0.0,
        tab_width: 0.5,
        tab_spacing: 5.0,
        tab_thickness: 0.1,
        cut_out_border: 0.0,
        ramp_angle: 0.0,
        finish_allowance: 0.0,
    };
    pub const HIGHEST: Setup = Setup {
        safe_height: 50.0,
        plunge_clearance: 50.0,
        through_cut: 2.0,
        tab_width: 50.0,
        tab_spacing: 1000.0,
        tab_thickness: 20.0,
        cut_out_border: 100.0,
        ramp_angle: 45.0,
        finish_allowance: 1.0,
    };

    /// The clearances and tabs a step's files are cut with.
    pub fn of(project: &Project, step: &Step) -> Setup {
        step.setup.unwrap_or(project.setup)
    }

    /// Depth gained per mm of travel while an end mill ramps into wood, or 0
    /// when it plunges straight down.
    pub fn ramp_slope(&self) -> f64 {
        self.ramp_angle.to_radians().tan()
    }

    /// The thickness of the tabs on a board this thick.
    pub fn tab_thickness_on(&self, board: f64) -> f64 {
        (board / 2.0).min(self.tab_thickness)
    }

    pub fn validate(&self) -> Result<(), String> {
        let (low, high) = (Self::LOWEST, Self::HIGHEST);
        let within = |v: f64, low: f64, high: f64| v.is_finite() && v >= low && v <= high;
        if !within(self.safe_height, low.safe_height, high.safe_height) {
            return Err("the travel height must be from 1 to 50 mm".into());
        }
        if !within(
            self.plunge_clearance,
            low.plunge_clearance,
            self.safe_height,
        ) {
            return Err(
                "the plunge height must be at least 0.1 mm and no more than the travel height"
                    .into(),
            );
        }
        if !within(self.through_cut, low.through_cut, high.through_cut) {
            return Err("the cut past the bottom of a board must be from 0 to 2 mm".into());
        }
        if !within(self.tab_width, low.tab_width, high.tab_width) {
            return Err("the tab width must be from 0.5 to 50 mm".into());
        }
        if !within(self.tab_spacing, low.tab_spacing, high.tab_spacing) {
            return Err("the tab spacing must be from 5 to 1000 mm".into());
        }
        if !within(self.tab_thickness, low.tab_thickness, high.tab_thickness) {
            return Err("the tab thickness must be from 0.1 to 20 mm".into());
        }
        if !within(self.cut_out_border, low.cut_out_border, high.cut_out_border) {
            return Err("the board left around a cut-out plug must be from 0 to 100 mm".into());
        }
        if !within(self.ramp_angle, low.ramp_angle, high.ramp_angle) {
            return Err("the ramp angle must be from 0 to 45 degrees".into());
        }
        if !within(
            self.finish_allowance,
            low.finish_allowance,
            high.finish_allowance,
        ) {
            return Err("the finishing allowance must be from 0 to 1 mm".into());
        }
        Ok(())
    }
}

/// The stock: the board that receives the inlays and is cut by the other
/// operations. Its outline is the design's page (after scaling), with the work
/// origin at the page's bottom-left corner and Z0 on its top face.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseStock {
    pub thickness: f64,
    /// What the stock is made of: chooses which cutting settings of each
    /// tool are used wherever the stock is cut.
    #[serde(default = "hardwood")]
    pub material: Material,
    /// The colour of its wood in the app's pictures, as `#rrggbb`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl Default for BaseStock {
    fn default() -> Self {
        Self {
            thickness: 18.0,
            material: Material::HARDWOOD,
            color: None,
        }
    }
}

/// True for a colour written as `#rrggbb`.
fn is_color(text: &str) -> bool {
    text.len() == 7 && text.starts_with('#') && text[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// An imported drawing, reduced to filled regions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Design {
    /// File name the design was imported from.
    pub source_name: String,
    /// Size of the drawing's page as imported, mm, before `scale`.
    pub width: f64,
    pub height: f64,
    /// Uniform scale applied to the regions when they are used.
    #[serde(default = "one")]
    pub scale: f64,
    /// Flip the whole design left to right. This corrects a drawing made
    /// mirrored; plugs are mirrored automatically and do not need this.
    #[serde(default)]
    pub mirror: bool,
    pub regions: Vec<DesignRegion>,
}

fn one() -> f64 {
    1.0
}

/// One filled area of the design: the unit the user selects.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignRegion {
    /// Unique within the design.
    pub id: u32,
    /// Fill colour in the drawing as `#rrggbb`, when it was a plain colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Outer boundary, counter-clockwise, mm, Y up, origin at the page's
    /// bottom-left corner.
    pub outer: Ring,
    /// Holes, clockwise.
    #[serde(default)]
    pub holes: Vec<Ring>,
}

impl Design {
    /// Page size after scaling, mm.
    pub fn placed_size(&self) -> (f64, f64) {
        (self.width * self.scale, self.height * self.scale)
    }

    /// The regions with these ids as they sit on the base board: mirrored if
    /// asked, then scaled. Unknown ids are ignored.
    pub fn placed_regions(&self, ids: &[u32]) -> Vec<Region> {
        let place = |ring: &Ring| -> Ring {
            let mut out: Ring = ring
                .iter()
                .map(|p| {
                    [
                        if self.mirror { self.width - p[0] } else { p[0] } * self.scale,
                        p[1] * self.scale,
                    ]
                })
                .collect();
            if self.mirror {
                // Mirroring flips the winding; restore it.
                out.reverse();
            }
            out
        };
        self.regions
            .iter()
            .filter(|r| ids.contains(&r.id))
            .map(|r| Region::with_holes(place(&r.outer), r.holes.iter().map(place).collect()))
            .collect()
    }
}

impl DesignRegion {
    pub fn to_region(&self) -> Region {
        Region::with_holes(self.outer.clone(), self.holes.clone())
    }
}

/// One thing to cut: an inlay (a pocket in the stock and its matching plug or
/// insert), or a plain operation on the stock.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    pub name: String,
    /// The colour of the inlay's wood in the app's pictures, as `#rrggbb`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// For an inlay: the wood of its plug or insert, which chooses the
    /// cutting settings its board is cut with. Any other step cuts the
    /// stock, in the stock's material ([`Project::cut_material`]).
    #[serde(default = "hardwood")]
    pub material: Material,
    /// The design regions this inlay covers.
    pub region_ids: Vec<u32>,
    /// Clearances and tabs for this inlay's files. Without them the
    /// project's are used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<Setup>,
    /// The flat end mill that cuts a plug out of its board. Without one, the
    /// largest of the inlay's end mills that reaches through the board does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cut_out_tool_id: Option<String>,
    /// By tool id: the toolpath profile whose cutting row the tool runs in
    /// this step. A tool without an entry runs its plain row. Cutting a plug
    /// out of its board is a full-width slot and always runs the plain row.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub row_profiles: BTreeMap<String, String>,
    /// By tool id: the numbers of the tool's cutting row that this step
    /// changes. A number without an entry is the row's own. Cutting a plug
    /// out of its board runs the plain row as it is.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub cut_overrides: BTreeMap<String, CutOverride>,
    pub task: Task,
}

/// The numbers of a cutting row that one step runs a tool with in place of
/// the row's own. `None` leaves the row's.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutOverride {
    /// Spindle speed, rev/min.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rpm: Option<u32>,
    /// Feed rate while cutting sideways, mm/min.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feed: Option<f64>,
    /// Feed rate while cutting straight down, mm/min.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plunge: Option<f64>,
    /// Sideways distance between passes, mm.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stepover: Option<f64>,
    /// Depth per pass, mm.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stepdown: Option<f64>,
}

impl CutOverride {
    pub fn is_empty(&self) -> bool {
        *self == CutOverride::default()
    }

    /// The row with this step's numbers in place of its own.
    pub fn apply(&self, row: &CuttingSettings) -> CuttingSettings {
        let mut out = row.clone();
        if let Some(rpm) = self.rpm {
            out.rpm = rpm;
        }
        if let Some(feed) = self.feed {
            out.feed = feed;
        }
        if let Some(plunge) = self.plunge {
            out.plunge = plunge;
        }
        if let Some(stepover) = self.stepover {
            out.stepover = stepover;
            out.stepover_unit = StepoverUnit::Mm;
        }
        if let Some(stepdown) = self.stepdown {
            out.stepdown = stepdown;
        }
        out
    }

    fn validate(&self) -> Result<(), String> {
        let positive = |v: Option<f64>| v.is_none_or(|v| v.is_finite() && v > 0.0);
        if self.rpm == Some(0) {
            return Err("a changed spindle speed must be greater than 0".into());
        }
        if !positive(self.feed) || !positive(self.plunge) {
            return Err("a changed feed or plunge must be greater than 0".into());
        }
        if !positive(self.stepover) || !positive(self.stepdown) {
            return Err("a changed stepover or stepdown must be greater than 0".into());
        }
        Ok(())
    }
}

impl Step {
    /// Ids of every tool this inlay refers to.
    pub fn tool_ids(&self) -> Vec<&str> {
        let mut ids = self.task.tool_ids();
        if let Some(id) = &self.cut_out_tool_id {
            if !ids.contains(&id.as_str()) {
                ids.push(id);
            }
        }
        ids
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Task {
    #[serde(rename_all = "camelCase")]
    Vcarve {
        /// How deep the plug sits in the pocket, mm.
        engagement_depth: f64,
        /// Space left under the plug for glue, mm.
        glue_gap: f64,
        /// Space between the pocket surface and the plug's backer, mm.
        saw_gap: f64,
        /// Flat end mills that clear the flat floor, in the order they are
        /// used. Each cuts only what those before it left.
        #[serde(default)]
        clearing_tool_ids: Vec<String>,
        #[serde(default)]
        vbit_tool_id: Option<String>,
        /// Width of blank left around the shapes on the plug, mm. The plug
        /// blank is the shapes' bounding box grown by this on every side.
        #[serde(default = "default_plug_margin")]
        plug_margin: f64,
        /// Thickness of the plug blank, mm.
        #[serde(default = "default_plug_thickness")]
        plug_thickness: f64,
        /// Cut the finished plug out of a larger board, as one piece.
        #[serde(default)]
        cut_out: bool,
        /// When cutting the plug out, hold it to the board with tabs.
        #[serde(default)]
        tabs: bool,
        /// Cut back the tips of the plug's narrow ridges and corner edges by
        /// the glue gap, so that they cannot hold the plug up.
        #[serde(default = "yes")]
        relief: bool,
        /// Finer points that are seldom changed.
        #[serde(flatten)]
        tuning: VcarveTuning,
    },
    #[serde(rename_all = "camelCase")]
    Flat {
        pocket_depth: f64,
        /// Total gap between insert and pocket wall, split between the two, mm.
        allowance: f64,
        /// Hold whatever is cut out of the insert board to it with tabs.
        #[serde(default)]
        tabs: bool,
        /// How the insert is made: loose pieces, or one plug on a backer.
        #[serde(default)]
        insert_style: InsertStyle,
        /// Backer plugs: space between the base board's surface and the
        /// backer, for sawing it off, mm.
        #[serde(default = "default_saw_gap")]
        saw_gap: f64,
        /// Backer plugs: cut the finished plug out of a larger board, as one
        /// piece. Loose inserts are always cut out.
        #[serde(default)]
        cut_out: bool,
        /// Flat end mills that cut the pocket, in the order they are used.
        /// Each cuts only what those before it left. The smallest sets the
        /// corner radius and cuts the insert out. Files written when an inlay
        /// had one tool give it as `toolId`.
        #[serde(default, alias = "toolId", deserialize_with = "one_or_many_tool_ids")]
        clearing_tool_ids: Vec<String>,
        /// Thickness of the board the insert is cut from, mm. The insert is
        /// cut right through it.
        #[serde(default = "default_insert_thickness")]
        insert_thickness: f64,
        /// Width of board left around the shapes on the insert board, mm.
        #[serde(default = "default_plug_margin")]
        insert_margin: f64,
    },
    /// A plain operation: the shapes cleared to a flat floor.
    #[serde(rename_all = "camelCase")]
    Pocket {
        depth: f64,
        /// The shape of the tool's path. Rings by default.
        #[serde(default)]
        pattern: Pattern,
        /// Which way side-to-side passes run, in each shape. Along its longer
        /// side by default. Rings take no direction.
        #[serde(default, skip_serializing_if = "PassDirection::is_longer")]
        direction: PassDirection,
        /// Flat end mills, in the order they are used. Each cuts only what
        /// those before it left.
        #[serde(default)]
        clearing_tool_ids: Vec<String>,
    },
    /// A plain operation: an area milled flat. Without shapes the area is
    /// the whole stock; with shapes, the rectangle around them grown by
    /// `margin`.
    #[serde(rename_all = "camelCase")]
    Facing {
        /// Wood standing above the stock's surface that is milled away
        /// first, such as the backer of a glued-in plug, mm.
        #[serde(default)]
        above: f64,
        /// Take that height from the list instead: how far the plugs and
        /// inserts glued in before this facing, where it cuts, stand above
        /// the surface by their inlays' numbers. `above` is then not used.
        #[serde(default, skip_serializing_if = "is_false")]
        above_auto: bool,
        /// How far below the stock's surface the area ends up, mm. Less
        /// than 0 ends it that far above the surface, in the wood that
        /// stands there, and leaves the rest of it proud.
        #[serde(default)]
        depth: f64,
        /// How far beyond the rectangle around the chosen shapes the area reaches, mm.
        #[serde(default)]
        margin: f64,
        /// Take the margin from the inlays instead: the widest plug margin
        /// of the inlays the facing's shapes belong to, so that the area is
        /// their blank whatever that is changed to. `margin` is used while
        /// its shapes belong to no such inlay.
        #[serde(default, skip_serializing_if = "is_false")]
        margin_auto: bool,
        /// The shape of the tool's path. Side to side by default.
        #[serde(default = "Pattern::raster")]
        pattern: Pattern,
        /// Which way side-to-side passes run. Along the longer side by
        /// default. Rings take no direction.
        #[serde(default, skip_serializing_if = "PassDirection::is_longer")]
        direction: PassDirection,
        #[serde(default)]
        tool_id: Option<String>,
    },
    /// A plain operation: a cut along the outlines of the shapes.
    #[serde(rename_all = "camelCase")]
    Contour {
        #[serde(default)]
        side: Side,
        /// How deep the cut goes. Without a depth it goes right through the
        /// stock.
        #[serde(default)]
        depth: Option<f64>,
        /// How deep the cut starts: the wood above it, where the tool runs,
        /// is gone already, as in a pocket. 0 to start at the surface.
        #[serde(default, skip_serializing_if = "is_zero")]
        start_depth: f64,
        /// Leave tabs across the cut.
        #[serde(default)]
        tabs: bool,
        #[serde(default)]
        tool_id: Option<String>,
    },
    /// A plain operation: the top edge along the outlines of the shapes is
    /// bevelled with a V-bit, or rounded over with a corner-rounding bit.
    #[serde(rename_all = "camelCase")]
    Chamfer {
        /// Where the wood has been cut away: outside the shapes or inside.
        #[serde(default)]
        side: Side,
        /// Width of the bevel, seen from above, mm. A corner-rounding bit
        /// cuts its own radius, whatever this says.
        width: f64,
        /// How far beyond its tip flat a V-bit's axis is kept from the edge,
        /// mm. The tip, which hardly cuts, then runs in the air beside the
        /// edge instead of rubbing along the wall under the chamfer. Not
        /// used with a corner-rounding bit.
        #[serde(
            default = "default_tip_clearance",
            skip_serializing_if = "is_default_tip_clearance"
        )]
        tip_clearance: f64,
        /// The V-bit or corner-rounding bit. Files written when a chamfer
        /// took a V-bit only give it as `vbitToolId`.
        #[serde(default, alias = "vbitToolId")]
        tool_id: Option<String>,
    },
    /// A step done by hand, with no file: the plug or the inserts of an
    /// inlay glued into its pocket. From here on the stock has their wood
    /// on it, for the steps after it in the list.
    #[serde(rename_all = "camelCase")]
    Glue {
        /// The id of the step whose plug or inserts are glued in.
        inlay_id: String,
    },
    /// A step done by hand, with no file: the backer of a glued-in plug
    /// sawn off, which leaves the plug standing a little above the stock
    /// and nothing of its blank around it.
    #[serde(rename_all = "camelCase")]
    Saw {
        /// The id of the step whose plug is sawn off.
        inlay_id: String,
        /// How far above the stock's surface the saw leaves the plug
        /// standing, mm.
        leave: f64,
    },
}

/// The finer points of a V-carve inlay. Each has a usual value, is left out
/// of a file while it has it, and is read as it when missing. Lengths in mm.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VcarveTuning {
    /// The highest ridge the V-bit may leave between passes on a flat
    /// floor. On a floor only the bit's tip cuts, so its passes are put
    /// close enough for this, whatever stepover its cutting row gives.
    #[serde(skip_serializing_if = "VcarveTuning::usual_floor_ridge")]
    pub floor_ridge: f64,
    /// How far below the finished face a relief cut stays: the face is
    /// trimmed and sanded, and must not reach the cut.
    #[serde(skip_serializing_if = "VcarveTuning::usual_relief_keep")]
    pub relief_keep: f64,
    /// How far below the base board's surface the fit check judges the
    /// finished face: about what flattening and sanding take off.
    #[serde(skip_serializing_if = "VcarveTuning::usual_trim_depth")]
    pub trim_depth: f64,
}

impl Default for VcarveTuning {
    fn default() -> Self {
        VcarveTuning {
            floor_ridge: 0.1,
            relief_keep: 0.5,
            trim_depth: 0.1,
        }
    }
}

impl VcarveTuning {
    /// The range each may take.
    pub const FLOOR_RIDGE: [f64; 2] = [0.01, 1.0];
    pub const RELIEF_KEEP: [f64; 2] = [0.0, 5.0];
    pub const TRIM_DEPTH: [f64; 2] = [0.0, 2.0];

    fn usual_floor_ridge(v: &f64) -> bool {
        *v == Self::default().floor_ridge
    }
    fn usual_relief_keep(v: &f64) -> bool {
        *v == Self::default().relief_keep
    }
    fn usual_trim_depth(v: &f64) -> bool {
        *v == Self::default().trim_depth
    }

    fn validate(&self) -> Result<(), String> {
        let within = |v: f64, [low, high]: [f64; 2]| v.is_finite() && v >= low && v <= high;
        if !within(self.floor_ridge, Self::FLOOR_RIDGE) {
            return Err("the floor's ridge height must be from 0.01 to 1 mm".into());
        }
        if !within(self.relief_keep, Self::RELIEF_KEEP) {
            return Err("the relief must stay from 0 to 5 mm below the face".into());
        }
        if !within(self.trim_depth, Self::TRIM_DEPTH) {
            return Err("the face must be judged from 0 to 2 mm below the surface".into());
        }
        Ok(())
    }
}

/// How far a chamfering V-bit's tip is kept clear of the edge unless a
/// chamfer says otherwise, mm.
pub const DEFAULT_TIP_CLEARANCE: f64 = 0.2;

/// The most a chamfering V-bit's tip may be kept clear of the edge, mm.
pub const MAX_TIP_CLEARANCE: f64 = 5.0;

fn default_tip_clearance() -> f64 {
    DEFAULT_TIP_CLEARANCE
}

fn is_default_tip_clearance(v: &f64) -> bool {
    *v == DEFAULT_TIP_CLEARANCE
}

/// The defaults and limits the screens show, as JSON. The screens read them
/// from `web/src/core/core-values.json`, which a test holds to this.
pub fn values_for_screens() -> serde_json::Value {
    let tuning = VcarveTuning::default();
    serde_json::json!({
        "setup": {
            "defaults": Setup::default(),
            "lowest": Setup::LOWEST,
            "highest": Setup::HIGHEST,
        },
        "machine": {
            "defaults": Machine::default(),
            "maxToolChangeSeconds": MAX_TOOL_CHANGE_SECONDS,
        },
        "chamfer": {
            "tipClearance": { "default": DEFAULT_TIP_CLEARANCE, "max": MAX_TIP_CLEARANCE },
        },
        "vcarve": {
            "floorRidge": { "default": tuning.floor_ridge, "range": VcarveTuning::FLOOR_RIDGE },
            "reliefKeep": { "default": tuning.relief_keep, "range": VcarveTuning::RELIEF_KEEP },
            "trimDepth": { "default": tuning.trim_depth, "range": VcarveTuning::TRIM_DEPTH },
        },
    })
}

/// The shape of the path a tool clears an area along.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Pattern {
    /// Rings that follow the outline of the area, from the middle outwards.
    #[default]
    Offset,
    /// Straight passes side to side.
    Raster,
}

impl Pattern {
    fn raster() -> Self {
        Pattern::Raster
    }
}

/// Which way side-to-side passes run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PassDirection {
    /// Along the longer side of the area: the fewest turns.
    #[default]
    Longer,
    /// Along X: left and right as the stock lies on the machine.
    X,
    /// Along Y: to and from the front of the machine.
    Y,
}

impl PassDirection {
    fn is_longer(&self) -> bool {
        *self == PassDirection::Longer
    }
}

/// Which side of the shapes' outlines a tool runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    /// Outside the shapes: the shapes are what is kept.
    #[default]
    Outside,
    /// Inside the shapes: the shapes are what is cut away.
    Inside,
    /// With the tool's centre on the outline. Contours only.
    On,
}

/// How the insert of a flat inlay is made.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InsertStyle {
    /// Each shape is cut right out of the insert board as a loose piece,
    /// the same way up as it goes in.
    #[default]
    Loose,
    /// The shapes are left standing on a shared backer, mirrored, like a
    /// V-carve plug: glued in face down, then the backer is removed.
    Backer,
}

fn yes() -> bool {
    true
}

fn default_saw_gap() -> f64 {
    1.5
}

/// Reads a list of tool ids, or the single optional id older files have.
fn one_or_many_tool_ids<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Ids {
        Many(Vec<String>),
        One(Option<String>),
    }
    Ok(match Ids::deserialize(d)? {
        Ids::Many(ids) => ids,
        Ids::One(id) => id.into_iter().collect(),
    })
}

fn default_insert_thickness() -> f64 {
    4.0
}

fn default_plug_margin() -> f64 {
    8.0
}

fn default_plug_thickness() -> f64 {
    10.0
}

impl Task {
    pub fn default_vcarve() -> Self {
        Task::Vcarve {
            engagement_depth: 3.0,
            glue_gap: 0.3,
            saw_gap: 1.5,
            plug_margin: 8.0,
            plug_thickness: 10.0,
            cut_out: false,
            tabs: false,
            clearing_tool_ids: Vec::new(),
            vbit_tool_id: None,
            relief: true,
            tuning: VcarveTuning::default(),
        }
    }

    pub fn default_flat() -> Self {
        Task::Flat {
            pocket_depth: 3.0,
            allowance: 0.1,
            tabs: false,
            clearing_tool_ids: Vec::new(),
            insert_thickness: 4.0,
            insert_margin: 8.0,
            insert_style: InsertStyle::Loose,
            saw_gap: 1.5,
            cut_out: false,
        }
    }

    /// Ids of every tool this inlay refers to.
    pub fn tool_ids(&self) -> Vec<&str> {
        match self {
            Task::Vcarve {
                clearing_tool_ids,
                vbit_tool_id,
                ..
            } => clearing_tool_ids
                .iter()
                .chain(vbit_tool_id.iter())
                .map(String::as_str)
                .collect(),
            Task::Flat {
                clearing_tool_ids, ..
            }
            | Task::Pocket {
                clearing_tool_ids, ..
            } => clearing_tool_ids.iter().map(String::as_str).collect(),
            Task::Facing { tool_id, .. }
            | Task::Contour { tool_id, .. }
            | Task::Chamfer { tool_id, .. } => tool_id.iter().map(String::as_str).collect(),
            Task::Glue { .. } | Task::Saw { .. } => Vec::new(),
        }
    }

    /// True for an inlay whose second part is one plug on a backer: a
    /// V-carve inlay, or a flat one made that way.
    pub fn has_backer(&self) -> bool {
        matches!(
            self,
            Task::Vcarve { .. }
                | Task::Flat {
                    insert_style: InsertStyle::Backer,
                    ..
                }
        )
    }

    /// True for a step done by hand, which has no file.
    pub fn is_by_hand(&self) -> bool {
        matches!(self, Task::Glue { .. } | Task::Saw { .. })
    }

    /// True for an inlay, which has a second part; false for a plain
    /// operation on the stock.
    pub fn is_inlay(&self) -> bool {
        matches!(self, Task::Vcarve { .. } | Task::Flat { .. })
    }

    fn validate(&self) -> Result<(), String> {
        fn check(ok: bool, message: &str) -> Result<(), String> {
            if ok {
                Ok(())
            } else {
                Err(message.into())
            }
        }
        match *self {
            // What it refers to is checked with the rest of the project.
            Task::Glue { .. } => Ok(()),
            Task::Saw { leave, .. } => check(
                leave.is_finite() && leave >= 0.0,
                "what the saw leaves standing must be 0 or more",
            ),
            Task::Vcarve {
                engagement_depth,
                glue_gap,
                saw_gap,
                plug_margin,
                plug_thickness,
                tuning,
                ..
            } => {
                tuning.validate()?;
                check(
                    plug_margin.is_finite() && plug_margin > 0.0,
                    "plug margin must be greater than 0",
                )?;
                check(
                    plug_thickness.is_finite() && plug_thickness > 0.0,
                    "plug blank thickness must be greater than 0",
                )?;
                check(
                    engagement_depth.is_finite() && engagement_depth > 0.0,
                    "engagement depth must be greater than 0",
                )?;
                check(
                    glue_gap.is_finite() && glue_gap >= 0.0,
                    "glue gap must be 0 or more",
                )?;
                check(
                    saw_gap.is_finite() && saw_gap > 0.0,
                    "saw gap must be greater than 0",
                )
            }
            Task::Flat {
                pocket_depth,
                allowance,
                insert_thickness,
                insert_margin,
                saw_gap,
                ..
            } => {
                check(
                    saw_gap.is_finite() && saw_gap >= 0.0,
                    "saw gap must be 0 or more",
                )?;
                check(
                    insert_thickness.is_finite() && insert_thickness > 0.0,
                    "insert board thickness must be greater than 0",
                )?;
                check(
                    insert_margin.is_finite() && insert_margin > 0.0,
                    "insert margin must be greater than 0",
                )?;
                check(
                    pocket_depth.is_finite() && pocket_depth > 0.0,
                    "pocket depth must be greater than 0",
                )?;
                check(
                    allowance.is_finite() && allowance >= 0.0,
                    "allowance must be 0 or more",
                )
            }
            Task::Pocket { depth, .. } => check(
                depth.is_finite() && depth > 0.0,
                "depth must be greater than 0",
            ),
            Task::Facing {
                above,
                above_auto,
                depth,
                margin,
                ..
            } => {
                check(
                    above.is_finite() && above >= 0.0,
                    "the wood above the surface must be 0 or more",
                )?;
                // With the height taken from the list, where the cut may
                // end is known only when the file is made.
                check(
                    depth.is_finite() && (above_auto || depth >= -above),
                    "a facing cannot end higher than the wood above the surface it starts on",
                )?;
                check(
                    margin.is_finite() && margin >= 0.0,
                    "the margin must be 0 or more",
                )
            }
            Task::Contour {
                depth, start_depth, ..
            } => {
                check(
                    depth.is_none_or(|d| d.is_finite() && d > 0.0),
                    "depth must be greater than 0",
                )?;
                // A start at or below the end is refused when the file is
                // made, with the numbers: a project in the middle of being
                // changed passes through it, and has to be kept all the same.
                check(
                    start_depth.is_finite() && start_depth >= 0.0,
                    "the depth a contour starts at must be 0 or more",
                )
            }
            Task::Chamfer {
                width,
                side,
                tip_clearance,
                ..
            } => {
                check(
                    width.is_finite() && width > 0.0,
                    "chamfer width must be greater than 0",
                )?;
                check(
                    tip_clearance.is_finite() && (0.0..=MAX_TIP_CLEARANCE).contains(&tip_clearance),
                    "a chamfer's tip clearance must be from 0 to 5 mm",
                )?;
                check(
                    side != Side::On,
                    "a chamfer runs outside or inside the shapes",
                )
            }
        }
    }
}

/// The highest number a tool can go by in a file.
pub const MAX_TOOL_NUMBER: u32 = 999;

impl Project {
    /// The number the project has given a tool: its own, or that of the
    /// same bit carried under another id.
    pub fn tool_number(&self, tool: &Tool) -> Option<u32> {
        self.tool_numbers.get(&tool.id).copied().or_else(|| {
            self.tools
                .iter()
                .filter(|t| t.same_bit(tool))
                .find_map(|t| self.tool_numbers.get(&t.id).copied())
        })
    }

    /// What a step cuts, which chooses the cutting settings of its tools.
    /// The plug or insert of an inlay (`plug`) is in the inlay's own wood.
    /// So is a facing that starts above the surface over an inlay's shapes:
    /// it trims the glued-in plug. Everything else is the stock.
    pub fn cut_material<'a>(&'a self, step: &'a Step, plug: bool) -> &'a Material {
        if step.task.is_inlay() {
            return if plug {
                &step.material
            } else {
                &self.base.material
            };
        }
        let trims = matches!(
            &step.task,
            Task::Facing { above, above_auto, .. } if *above_auto || *above > 0.0
        );
        if trims {
            let owner = self.steps.iter().find(|other| {
                other.task.is_inlay()
                    && other
                        .region_ids
                        .iter()
                        .any(|id| step.region_ids.contains(id))
            });
            if let Some(owner) = owner {
                return &owner.material;
            }
        }
        &self.base.material
    }

    /// Checks the project is consistent: valid numbers, unique ids, and no
    /// reference to a region that does not exist.
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty() {
            return Err("the project has no id".into());
        }
        validate_tools(&self.tools)?;
        let mut numbers: Vec<u32> = self.tool_numbers.values().copied().collect();
        if numbers.iter().any(|n| !(1..=MAX_TOOL_NUMBER).contains(n)) {
            return Err(format!(
                "a tool's number must be from 1 to {MAX_TOOL_NUMBER}"
            ));
        }
        numbers.sort_unstable();
        if let Some(pair) = numbers.windows(2).find(|w| w[0] == w[1]) {
            return Err(format!("two tools share the number {}", pair[0]));
        }
        self.machine.validate()?;
        self.setup.validate()?;
        if !(self.base.thickness.is_finite() && self.base.thickness > 0.0) {
            return Err("base board thickness must be greater than 0".into());
        }
        if self.base.color.as_deref().is_some_and(|c| !is_color(c)) {
            return Err("the base board's colour must be written as #rrggbb".into());
        }

        let region_ids: Vec<u32> = self
            .design
            .iter()
            .flat_map(|d| d.regions.iter().map(|r| r.id))
            .collect();
        if let Some(design) = &self.design {
            if !(design.scale.is_finite() && design.scale > 0.0) {
                return Err("design scale must be greater than 0".into());
            }
            let positive = |v: f64| v.is_finite() && v > 0.0;
            if !positive(design.width) || !positive(design.height) {
                return Err("the stock's width and height must be greater than 0".into());
            }
            for (i, id) in region_ids.iter().enumerate() {
                if region_ids[..i].contains(id) {
                    return Err(format!("two design regions share the id {id}"));
                }
            }
            for region in &design.regions {
                if region.outer.len() < 3 || region.holes.iter().any(|h| h.len() < 3) {
                    return Err(format!(
                        "design region {} has a boundary with fewer than 3 points",
                        region.id
                    ));
                }
            }
        }

        for (i, step) in self.steps.iter().enumerate() {
            let fail = |e: String| format!("inlay \"{}\": {e}", step.name);
            if step.id.is_empty() || self.steps[..i].iter().any(|other| other.id == step.id) {
                return Err(fail("its id is missing or used twice".into()));
            }
            step.task.validate().map_err(fail)?;
            if step.color.as_deref().is_some_and(|c| !is_color(c)) {
                return Err(fail("its colour must be written as #rrggbb".into()));
            }
            if let Some(setup) = &step.setup {
                setup.validate().map_err(fail)?;
            }
            for change in step.cut_overrides.values() {
                change.validate().map_err(fail)?;
            }
            if let Task::Glue { inlay_id } = &step.task {
                let glued = self.steps.iter().find(|other| &other.id == inlay_id);
                if !glued.is_some_and(|other| other.task.is_inlay()) {
                    return Err(fail(
                        "it glues in an inlay that is not in the project".into(),
                    ));
                }
            }
            if let Task::Saw { inlay_id, .. } = &step.task {
                let sawn = self.steps.iter().find(|other| &other.id == inlay_id);
                if !sawn.is_some_and(|other| other.task.has_backer()) {
                    return Err(fail(
                        "it saws the backer off an inlay that is not in the project, or has no backer".into(),
                    ));
                }
            }
            if let Some(missing) = step.region_ids.iter().find(|id| !region_ids.contains(id)) {
                return Err(fail(format!(
                    "it refers to region {missing}, which is not in the design"
                )));
            }
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
struct ProjectBody {
    project: Project,
}

/// Writes a project as a project file. Its tools are written as
/// [`Tool::for_sharing`] leaves them.
pub fn project_to_file_json(project: &Project) -> String {
    let mut project = project.clone();
    project.tools = project.tools.iter().map(Tool::for_sharing).collect();
    file::write(
        PROJECT_KIND,
        PROJECT_FORMAT_VERSION,
        &ProjectBody { project },
    )
}

/// Reads a project file written by this or any earlier version of the app.
pub fn project_from_file_json(text: &str) -> Result<Project, FileError> {
    let body: ProjectBody = file::read(text, PROJECT_KIND, PROJECT_FORMAT_VERSION, MIGRATIONS)?;
    body.project.validate().map_err(FileError::Invalid)?;
    Ok(body.project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::fixtures::{end_mill, v_bit};

    fn sample() -> Project {
        Project {
            id: "p1".into(),
            name: "Coaster".into(),
            design: Some(Design {
                source_name: "coaster.svg".into(),
                width: 100.0,
                height: 100.0,
                scale: 1.0,
                mirror: false,
                regions: vec![
                    DesignRegion {
                        id: 0,
                        color: Some("#000000".into()),
                        outer: vec![[10.0, 10.0], [40.0, 10.0], [40.0, 40.0], [10.0, 40.0]],
                        holes: vec![vec![[20.0, 20.0], [20.0, 30.0], [30.0, 30.0], [30.0, 20.0]]],
                    },
                    DesignRegion {
                        id: 1,
                        color: None,
                        outer: vec![[60.0, 60.0], [90.0, 60.0], [75.0, 90.0]],
                        holes: vec![],
                    },
                ],
            }),
            steps: vec![
                Step {
                    id: "j1".into(),
                    name: "Walnut square".into(),
                    material: Material::HARDWOOD,
                    region_ids: vec![0],
                    color: None,
                    setup: None,
                    cut_out_tool_id: None,
                    row_profiles: Default::default(),
                    cut_overrides: Default::default(),
                    task: Task::Vcarve {
                        engagement_depth: 3.0,
                        glue_gap: 0.3,
                        saw_gap: 1.5,
                        plug_margin: 8.0,
                        plug_thickness: 10.0,
                        cut_out: false,
                        tabs: false,
                        clearing_tool_ids: vec!["t-endmill".into()],
                        vbit_tool_id: Some("t-vbit".into()),
                        relief: true,
                        tuning: VcarveTuning::default(),
                    },
                },
                Step {
                    id: "j2".into(),
                    name: "Maple triangle".into(),
                    material: Material::SOFTWOOD,
                    region_ids: vec![1],
                    color: None,
                    setup: None,
                    cut_out_tool_id: None,
                    row_profiles: Default::default(),
                    cut_overrides: Default::default(),
                    task: Task::Flat {
                        pocket_depth: 2.5,
                        allowance: 0.1,
                        tabs: true,
                        clearing_tool_ids: vec!["t-endmill".into()],
                        insert_thickness: 8.0,
                        insert_margin: 8.0,
                        insert_style: InsertStyle::Backer,
                        saw_gap: 1.0,
                        cut_out: true,
                    },
                },
            ],
            tools: vec![end_mill(), v_bit()],
            tool_numbers: BTreeMap::new(),
            profiles: Vec::new(),
            base: BaseStock::default(),
            machine: Machine::default(),
            setup: Setup::default(),
        }
    }

    #[test]
    fn project_round_trips() {
        let project = sample();
        let text = project_to_file_json(&project);
        assert_eq!(project_from_file_json(&text).unwrap(), project);
    }

    #[test]
    fn a_file_without_machine_or_setup_gets_the_defaults() {
        let text = project_to_file_json(&sample());
        let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
        let body = value["project"].as_object_mut().unwrap();
        assert!(body.remove("machine").is_some() && body.remove("setup").is_some());
        let read = project_from_file_json(&value.to_string()).unwrap();
        assert_eq!(read.machine, Machine::default());
        assert_eq!(read.setup, Setup::default());
    }

    #[test]
    fn bad_machine_or_setup_is_refused() {
        let mut p = sample();
        p.setup.plunge_clearance = 6.0;
        assert!(p.validate().unwrap_err().contains("plunge height"));
        let mut p = sample();
        p.machine.first_tool = 0;
        assert!(p.validate().unwrap_err().contains("first tool number"));
        let mut p = sample();
        p.machine.travel = [300.0, 0.0];
        assert!(p.validate().unwrap_err().contains("travel"));
    }

    #[test]
    fn an_inlay_keeps_its_own_clearances_and_cut_out_tool() {
        let mut p = sample();
        // Nothing extra is written for an inlay that has neither.
        let plain = project_to_file_json(&p);
        assert!(!plain.contains("cutOutToolId") && !plain.contains("\"setup\":null"));

        p.steps[0].setup = Some(Setup {
            safe_height: 9.0,
            ..Setup::default()
        });
        p.steps[0].cut_out_tool_id = Some("t-endmill".into());
        let read = project_from_file_json(&project_to_file_json(&p)).unwrap();
        assert_eq!(read, p);
        assert_eq!(Setup::of(&read, &read.steps[0]).safe_height, 9.0);
        assert_eq!(Setup::of(&read, &read.steps[1]), read.setup);
        // A tool named twice is listed once.
        assert_eq!(read.steps[0].tool_ids(), vec!["t-endmill", "t-vbit"]);

        p.steps[0].setup.as_mut().unwrap().plunge_clearance = 20.0;
        assert!(p.validate().unwrap_err().contains("plunge height"));
    }

    #[test]
    fn plain_operations_and_colours_round_trip() {
        let mut p = sample();
        p.base.color = Some("#d9b98a".into());
        p.steps[0].color = Some("#5b3a1e".into());
        let mut op = |id: &str, task: Task| {
            p.steps.push(Step {
                id: id.into(),
                name: id.into(),
                material: Material::HARDWOOD,
                region_ids: vec![0],
                color: None,
                setup: None,
                cut_out_tool_id: None,
                row_profiles: Default::default(),
                cut_overrides: Default::default(),
                task,
            })
        };
        op(
            "pocket",
            Task::Pocket {
                pattern: Pattern::Offset,
                direction: PassDirection::Longer,
                depth: 2.0,
                clearing_tool_ids: vec!["t-endmill".into()],
            },
        );
        op(
            "facing",
            Task::Facing {
                pattern: Pattern::Raster,
                direction: PassDirection::Longer,
                above: 6.0,
                above_auto: false,
                depth: 0.0,
                margin: 9.0,
                margin_auto: false,
                tool_id: Some("t-endmill".into()),
            },
        );
        op(
            "contour",
            Task::Contour {
                side: Side::Inside,
                depth: None,
                start_depth: 0.0,
                tabs: true,
                tool_id: Some("t-endmill".into()),
            },
        );
        op(
            "chamfer",
            Task::Chamfer {
                side: Side::Outside,
                width: 1.0,
                tip_clearance: DEFAULT_TIP_CLEARANCE,
                tool_id: Some("t-vbit".into()),
            },
        );
        let text = project_to_file_json(&p);
        assert!(text.contains("\"type\": \"contour\"") || text.contains("\"type\":\"contour\""));
        let read = project_from_file_json(&text).unwrap();
        assert_eq!(read, p);
        assert_eq!(read.steps[4].tool_ids(), vec!["t-endmill"]);
        assert_eq!(read.steps[5].tool_ids(), vec!["t-vbit"]);
        assert!(!read.steps[2].task.is_inlay() && read.steps[0].task.is_inlay());

        // A facing without a pattern goes side to side, a pocket in rings, and
        // a chamfer's tool may still be called its V-bit.
        let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
        for step in value["project"]["steps"].as_array_mut().unwrap() {
            let inlay = step["task"].as_object_mut().unwrap();
            inlay.remove("pattern");
            if inlay["type"] == "chamfer" {
                let id = inlay.remove("toolId").unwrap();
                inlay.insert("vbitToolId".into(), id);
            }
        }
        let old = project_from_file_json(&value.to_string()).unwrap();
        assert!(matches!(
            old.steps[2].task,
            Task::Pocket {
                pattern: Pattern::Offset,
                ..
            }
        ));
        assert!(matches!(
            old.steps[3].task,
            Task::Facing {
                pattern: Pattern::Raster,
                ..
            }
        ));
        assert_eq!(old.steps[5].tool_ids(), vec!["t-vbit"]);

        // A facing may end above the surface, but not above where it starts.
        let mut proud = p.clone();
        let facing = |above: f64, depth: f64| Task::Facing {
            pattern: Pattern::Raster,
            direction: PassDirection::Longer,
            above,
            above_auto: false,
            depth,
            margin: 9.0,
            margin_auto: false,
            tool_id: None,
        };
        proud.steps[3].task = facing(6.0, -0.2);
        assert_eq!(
            project_from_file_json(&project_to_file_json(&proud)).unwrap(),
            proud
        );
        proud.steps[3].task = facing(6.0, -6.5);
        assert!(proud.validate().unwrap_err().contains("cannot end higher"));
        proud.steps[3].task = facing(0.0, -0.1);
        assert!(proud.validate().unwrap_err().contains("cannot end higher"));

        // A chamfer has no "on the line", and a colour is #rrggbb.
        let mut bad = p.clone();
        bad.steps[5].task = Task::Chamfer {
            side: Side::On,
            width: 1.0,
            tip_clearance: DEFAULT_TIP_CLEARANCE,
            tool_id: None,
        };
        assert!(bad.validate().unwrap_err().contains("outside or inside"));
        bad.steps[5].task = Task::Chamfer {
            side: Side::Outside,
            width: 1.0,
            tip_clearance: -0.1,
            tool_id: None,
        };
        assert!(bad.validate().unwrap_err().contains("tip clearance"));
        let mut bad = p.clone();
        bad.steps[0].color = Some("walnut".into());
        assert!(bad.validate().unwrap_err().contains("#rrggbb"));
    }

    #[test]
    fn a_glue_up_round_trips_and_must_name_an_inlay() {
        let mut p = sample();
        let glue = |of: &str| Step {
            id: "glue".into(),
            name: "Glue in Walnut square".into(),
            material: Material::HARDWOOD,
            region_ids: vec![],
            color: None,
            setup: None,
            cut_out_tool_id: None,
            row_profiles: Default::default(),
            cut_overrides: Default::default(),
            task: Task::Glue {
                inlay_id: of.into(),
            },
        };
        p.steps.insert(1, glue("j1"));
        let text = project_to_file_json(&p);
        assert!(text.contains("\"inlayId\": \"j1\""));
        let read = project_from_file_json(&text).unwrap();
        assert_eq!(read, p);
        assert!(read.steps[1].task.is_by_hand() && !read.steps[1].task.is_inlay());
        assert!(read.steps[1].tool_ids().is_empty());

        p.steps[1] = glue("gone");
        assert!(p.validate().unwrap_err().contains("not in the project"));
        // A glue-up glues in an inlay, not another glue-up.
        p.steps[1] = glue("glue");
        assert!(p.validate().unwrap_err().contains("not in the project"));

        // Sawing the backer off is a step by hand too, for an inlay that has a backer.
        let saw = |of: &str, leave: f64| Step {
            id: "saw".into(),
            task: Task::Saw {
                inlay_id: of.into(),
                leave,
            },
            ..glue("j1")
        };
        p.steps[1] = glue("j1");
        p.steps.insert(2, saw("j1", 1.5));
        let text = project_to_file_json(&p);
        assert!(text.contains("\"type\": \"saw\"") && text.contains("\"leave\": 1.5"));
        let read = project_from_file_json(&text).unwrap();
        assert_eq!(read, p);
        assert!(read.steps[2].task.is_by_hand() && read.steps[2].tool_ids().is_empty());
        p.steps[2] = saw("j1", -1.0);
        assert!(p.validate().unwrap_err().contains("0 or more"));
        // The sample's second inlay is flat with a backer; make it loose, and it has none.
        p.steps[2] = saw("j2", 1.0);
        p.validate().unwrap();
        if let Task::Flat { insert_style, .. } = &mut p.steps[3].task {
            *insert_style = InsertStyle::Loose;
        }
        assert!(p.validate().unwrap_err().contains("has no backer"));
    }

    #[test]
    fn empty_project_round_trips() {
        let project = Project {
            id: "p".into(),
            name: "New".into(),
            design: None,
            steps: vec![],
            tools: vec![],
            tool_numbers: BTreeMap::new(),
            profiles: Vec::new(),
            base: BaseStock::default(),
            machine: Machine::default(),
            setup: Setup::default(),
        };
        assert_eq!(
            project_from_file_json(&project_to_file_json(&project)).unwrap(),
            project
        );
    }

    #[test]
    fn a_step_pointing_at_a_missing_region_is_rejected() {
        let mut project = sample();
        project.steps[0].region_ids.push(99);
        assert!(project.validate().is_err());
        assert!(matches!(
            project_from_file_json(&project_to_file_json(&project)),
            Err(FileError::Invalid(_))
        ));
    }

    #[test]
    fn negative_depths_are_rejected() {
        let mut project = sample();
        project.steps[1].task = Task::Flat {
            pocket_depth: -1.0,
            allowance: 0.1,
            tabs: false,
            clearing_tool_ids: vec![],
            insert_thickness: 4.0,
            insert_margin: 8.0,
            insert_style: InsertStyle::Loose,
            saw_gap: 1.5,
            cut_out: false,
        };
        assert!(project.validate().is_err());
    }

    #[test]
    fn inlay_lists_its_tools() {
        let project = sample();
        assert_eq!(
            project.steps[0].task.tool_ids(),
            vec!["t-endmill", "t-vbit"]
        );
        assert_eq!(project.steps[1].task.tool_ids(), vec!["t-endmill"]);
    }

    /// Files from every released format version must keep loading, and
    /// mean what they meant.
    #[test]
    fn version_1_fixture_loads() {
        let project =
            project_from_file_json(include_str!("../tests/fixtures/project-v1.json")).unwrap();
        assert_eq!(project, sample());
    }

    /// Version 2 names the list `steps` and what a step does its `task`.
    #[test]
    fn version_2_fixture_loads_and_is_what_version_1_becomes() {
        let text = include_str!("../tests/fixtures/project-v2.json");
        assert!(text.contains("\"steps\"") && text.contains("\"task\""));
        assert!(!text.contains("\"jobs\"") && !text.contains("\"inlay\""));
        let project = project_from_file_json(text).unwrap();
        assert_eq!(project, sample());
        // A version 1 file comes out the same, and is written back as version 2.
        let old =
            project_from_file_json(include_str!("../tests/fixtures/project-v1.json")).unwrap();
        assert_eq!(project_to_file_json(&old), project_to_file_json(&project));
        assert!(project_to_file_json(&old).contains("\"formatVersion\": 3"));
    }

    /// Version 3 says what the stock is made of, once.
    #[test]
    fn version_3_fixture_loads_and_is_what_version_2_becomes() {
        let text = include_str!("../tests/fixtures/project-v3.json");
        let project = project_from_file_json(text).unwrap();
        assert_eq!(project, sample());
        assert_eq!(project_to_file_json(&project).trim(), text.trim());
        let old =
            project_from_file_json(include_str!("../tests/fixtures/project-v2.json")).unwrap();
        assert_eq!(project_to_file_json(&old), project_to_file_json(&project));
    }

    /// A version 2 file said the material on every step: the stock takes
    /// that of the first operation that cuts it, else of the first inlay.
    #[test]
    fn a_version_2_stock_takes_the_material_its_steps_were_cut_in() {
        let v2 = include_str!("../tests/fixtures/project-v2.json");
        // Two inlays, the first in hardwood and the second in softwood.
        let soft_first = v2.replacen(
            "\"material\": \"hardwood\"",
            "\"material\": \"softwood\"",
            1,
        );
        assert_ne!(soft_first, v2);
        let project = project_from_file_json(&soft_first).unwrap();
        assert_eq!(project.base.material, Material::SOFTWOOD);
        let plain = project_from_file_json(v2).unwrap();
        assert_eq!(plain.base.material, Material::HARDWOOD);
        // Each inlay keeps its own for its plug.
        assert_eq!(plain.steps[1].material, Material::SOFTWOOD);
        assert_eq!(
            plain.cut_material(&plain.steps[1], false),
            &Material::HARDWOOD
        );
        assert_eq!(
            plain.cut_material(&plain.steps[1], true),
            &Material::SOFTWOOD
        );
    }

    #[test]
    fn a_step_can_change_numbers_of_a_tools_row() {
        let mut project = sample();
        let change = CutOverride {
            feed: Some(900.0),
            stepover: Some(1.0),
            ..Default::default()
        };
        let row = end_mill().cutting[0].clone();
        let run = change.apply(&row);
        assert_eq!((run.feed, run.stepover), (900.0, 1.0));
        assert_eq!(
            (run.rpm, run.plunge, run.stepdown),
            (row.rpm, row.plunge, row.stepdown)
        );
        project.steps[1]
            .cut_overrides
            .insert("t-endmill".into(), change);
        let read = project_from_file_json(&project_to_file_json(&project)).unwrap();
        assert_eq!(read, project);
        project.steps[1]
            .cut_overrides
            .get_mut("t-endmill")
            .unwrap()
            .feed = Some(0.0);
        assert!(project.validate().unwrap_err().contains("feed"));
    }

    /// A file from a newer version of the app is refused, not guessed at.
    #[test]
    fn a_newer_project_file_is_refused() {
        let text = include_str!("../tests/fixtures/project-v3.json")
            .replace("\"formatVersion\": 3", "\"formatVersion\": 4");
        assert!(matches!(
            project_from_file_json(&text),
            Err(FileError::NewerVersion {
                found: 4,
                supported: 3
            })
        ));
    }

    /// A file written while version 1 was still growing: a flat inlay with a
    /// single `toolId`, and none of the fields added later.
    #[test]
    fn early_version_1_fixture_loads_with_defaults() {
        let project =
            project_from_file_json(include_str!("../tests/fixtures/project-v1-early.json"))
                .unwrap();
        assert_eq!(project.name, "Coaster");
        assert_eq!(project.steps.len(), 2);
        assert_eq!(project.design.as_ref().unwrap().regions.len(), 2);
        assert_eq!(project.steps[1].task.tool_ids(), vec!["t-endmill"]);
        assert!(matches!(
            project.steps[1].task,
            Task::Flat {
                tabs: true,
                insert_style: InsertStyle::Loose,
                cut_out: false,
                ..
            }
        ));
        assert!(matches!(
            project.steps[0].task,
            Task::Vcarve {
                cut_out: false,
                tabs: false,
                ..
            }
        ));
    }

    #[test]
    fn a_flat_inlay_without_a_tool_in_an_old_file_has_an_empty_list() {
        let text = include_str!("../tests/fixtures/project-v1-early.json")
            .replace("\"toolId\": \"t-endmill\"", "\"toolId\": null");
        assert!(text.contains("\"toolId\": null"));
        let project = project_from_file_json(&text).unwrap();
        assert!(project.steps[1].task.tool_ids().is_empty());
    }

    /// A project file is passed on; prices, invoices and logs are not.
    #[test]
    fn a_project_file_leaves_out_what_belongs_to_the_owners_tool_list() {
        let mut project = sample();
        let full = crate::tools::fixtures::full_library().tools.remove(0);
        let slot = project
            .tools
            .iter_mut()
            .find(|t| t.id == "t-endmill")
            .unwrap();
        *slot = Tool {
            id: "t-endmill".into(),
            ..full
        };
        let kept = slot.clone();
        let text = project_to_file_json(&project);
        for private in [
            "example.com",
            "invoice",
            "inventory",
            "price",
            "\"log\"",
            "camFlag",
            "Snapped",
            "Spindle alarm",
        ] {
            assert!(!text.contains(private), "{private}");
        }
        let read = project_from_file_json(&text).unwrap();
        let tool = read.tools.iter().find(|t| t.id == "t-endmill").unwrap();
        assert_eq!(*tool, kept.for_sharing());
        assert_eq!(tool.cutting.len(), 2);
    }

    /// Regenerates the fixtures from the samples above. Run by hand, once per
    /// format version, never to "fix" a failing fixture test:
    /// `cargo test -p inlay-core write_fixtures -- --ignored`
    #[test]
    #[ignore]
    fn write_fixtures() {
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            format!("{dir}/project-v{PROJECT_FORMAT_VERSION}.json"),
            project_to_file_json(&sample()),
        )
        .unwrap();
        std::fs::write(
            format!(
                "{dir}/tool-library-v{}.json",
                crate::tools::TOOL_LIBRARY_FORMAT_VERSION
            ),
            crate::tools::tools_to_file_json(&[end_mill(), v_bit()]),
        )
        .unwrap();
    }

    /// The screens' copy of the core's defaults and limits is the core's.
    /// Run with `UPDATE_CORE_VALUES=1` to write it afresh.
    #[test]
    fn the_screens_values_are_the_cores() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../web/src/core/core-values.json"
        );
        let ours = serde_json::to_string_pretty(&values_for_screens()).unwrap() + "\n";
        if std::env::var_os("UPDATE_CORE_VALUES").is_some() {
            std::fs::write(path, &ours).unwrap();
        }
        let theirs = std::fs::read_to_string(path).unwrap_or_default();
        assert_eq!(
            theirs, ours,
            "web/src/core/core-values.json is out of date: run this test with UPDATE_CORE_VALUES=1"
        );
    }

    #[test]
    fn a_vcarves_finer_points_are_left_out_of_a_file_at_their_usual_values() {
        let mut p = sample();
        let text = project_to_file_json(&p);
        for name in ["floorRidge", "reliefKeep", "trimDepth", "toolChangeSeconds"] {
            assert!(!text.contains(name), "{name}");
        }
        assert_eq!(project_from_file_json(&text).unwrap(), p);
        if let Task::Vcarve { tuning, .. } = &mut p.steps[0].task {
            tuning.floor_ridge = 0.05;
            tuning.trim_depth = 0.3;
        }
        p.machine.tool_change_seconds = 45.0;
        let text = project_to_file_json(&p);
        assert!(text.contains("\"floorRidge\": 0.05") && text.contains("\"trimDepth\": 0.3"));
        assert!(!text.contains("reliefKeep") && text.contains("\"toolChangeSeconds\": 45.0"));
        assert_eq!(project_from_file_json(&text).unwrap(), p);
        if let Task::Vcarve { tuning, .. } = &mut p.steps[0].task {
            tuning.relief_keep = 9.0;
        }
        assert!(p.validate().unwrap_err().contains("relief"));
    }
}
