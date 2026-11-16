//! The project: an imported design, the inlay jobs made from it, and the
//! tools those jobs use. Also the project file.

use serde::{Deserialize, Serialize};

use crate::file::{self, FileError, Migration};
use crate::geom::{Region, Ring};
use crate::tools::{validate_tools, Material, Tool};

/// Current version of the project file. Raise it, and add a migration,
/// whenever an old file could no longer be read as written.
pub const PROJECT_FORMAT_VERSION: u32 = 1;
pub const PROJECT_KIND: &str = "project";

/// Migrations for project files: entry `i` upgrades version `i + 1`.
const MIGRATIONS: &[Migration] = &[];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub design: Option<Design>,
    #[serde(default)]
    pub jobs: Vec<Job>,
    /// Copies of the tools the jobs refer to, so the project opens correctly
    /// on a machine with a different tool list.
    #[serde(default)]
    pub tools: Vec<Tool>,
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
    /// Top spindle speed, rpm.
    pub max_rpm: u32,
    /// Rapid speed, mm/min, used for time estimates.
    pub rapid_rate: f64,
    /// How far the tool can move in X and Y, mm.
    pub travel: [f64; 2],
    /// Number of the first tool in a file; the rest follow in the order the
    /// tools are used. On a Carvera with a tool rack, T1 to T6 are rack
    /// slots and are loaded automatically, whatever is in them.
    pub first_tool: u32,
}

impl Default for Machine {
    fn default() -> Self {
        Self {
            name: "Carvera Air".into(),
            max_rpm: 13000,
            rapid_rate: 2000.0,
            travel: [300.0, 200.0],
            first_tool: 1,
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
    /// The clearances and tabs a job's files are cut with.
    pub fn of(project: &Project, job: &Job) -> Setup {
        job.setup.unwrap_or(project.setup)
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
        let within = |v: f64, low: f64, high: f64| v.is_finite() && v >= low && v <= high;
        if !within(self.safe_height, 1.0, 50.0) {
            return Err("the travel height must be from 1 to 50 mm".into());
        }
        if !within(self.plunge_clearance, 0.1, self.safe_height) {
            return Err(
                "the plunge height must be at least 0.1 mm and no more than the travel height"
                    .into(),
            );
        }
        if !within(self.through_cut, 0.0, 2.0) {
            return Err("the cut past the bottom of a board must be from 0 to 2 mm".into());
        }
        if !within(self.tab_width, 0.5, 50.0) {
            return Err("the tab width must be from 0.5 to 50 mm".into());
        }
        if !within(self.tab_spacing, 5.0, 1000.0) {
            return Err("the tab spacing must be from 5 to 1000 mm".into());
        }
        if !within(self.tab_thickness, 0.1, 20.0) {
            return Err("the tab thickness must be from 0.1 to 20 mm".into());
        }
        if !within(self.cut_out_border, 0.0, 100.0) {
            return Err("the board left around a cut-out plug must be from 0 to 100 mm".into());
        }
        if !within(self.ramp_angle, 0.0, 45.0) {
            return Err("the ramp angle must be from 0 to 45 degrees".into());
        }
        if !within(self.finish_allowance, 0.0, 1.0) {
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
    /// The colour of its wood in the app's pictures, as `#rrggbb`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl Default for BaseStock {
    fn default() -> Self {
        Self {
            thickness: 18.0,
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
pub struct Job {
    pub id: String,
    pub name: String,
    /// The colour of the inlay's wood in the app's pictures, as `#rrggbb`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Chooses which cutting settings of each tool are used.
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
    pub inlay: Inlay,
}

impl Job {
    /// Ids of every tool this inlay refers to.
    pub fn tool_ids(&self) -> Vec<&str> {
        let mut ids = self.inlay.tool_ids();
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
pub enum Inlay {
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
        /// How far below the stock's surface the area ends up, mm.
        #[serde(default)]
        depth: f64,
        /// How far beyond the rectangle around the chosen shapes the area reaches, mm.
        #[serde(default)]
        margin: f64,
        /// The shape of the tool's path. Side to side by default.
        #[serde(default = "Pattern::raster")]
        pattern: Pattern,
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
        /// The V-bit or corner-rounding bit. Files written when a chamfer
        /// took a V-bit only give it as `vbitToolId`.
        #[serde(default, alias = "vbitToolId")]
        tool_id: Option<String>,
    },
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

impl Inlay {
    pub fn default_vcarve() -> Self {
        Inlay::Vcarve {
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
        }
    }

    pub fn default_flat() -> Self {
        Inlay::Flat {
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
            Inlay::Vcarve {
                clearing_tool_ids,
                vbit_tool_id,
                ..
            } => clearing_tool_ids
                .iter()
                .chain(vbit_tool_id.iter())
                .map(String::as_str)
                .collect(),
            Inlay::Flat {
                clearing_tool_ids, ..
            }
            | Inlay::Pocket {
                clearing_tool_ids, ..
            } => clearing_tool_ids.iter().map(String::as_str).collect(),
            Inlay::Facing { tool_id, .. }
            | Inlay::Contour { tool_id, .. }
            | Inlay::Chamfer { tool_id, .. } => tool_id.iter().map(String::as_str).collect(),
        }
    }

    /// True for an inlay, which has a second part; false for a plain
    /// operation on the stock.
    pub fn is_inlay(&self) -> bool {
        matches!(self, Inlay::Vcarve { .. } | Inlay::Flat { .. })
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
            Inlay::Vcarve {
                engagement_depth,
                glue_gap,
                saw_gap,
                plug_margin,
                plug_thickness,
                ..
            } => {
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
            Inlay::Flat {
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
            Inlay::Pocket { depth, .. } => check(
                depth.is_finite() && depth > 0.0,
                "depth must be greater than 0",
            ),
            Inlay::Facing {
                above,
                depth,
                margin,
                ..
            } => {
                check(
                    above.is_finite() && above >= 0.0,
                    "the wood above the surface must be 0 or more",
                )?;
                check(
                    depth.is_finite() && depth >= 0.0,
                    "the depth below the surface must be 0 or more",
                )?;
                check(
                    margin.is_finite() && margin >= 0.0,
                    "the margin must be 0 or more",
                )
            }
            Inlay::Contour { depth, .. } => check(
                depth.is_none_or(|d| d.is_finite() && d > 0.0),
                "depth must be greater than 0",
            ),
            Inlay::Chamfer { width, side, .. } => {
                check(
                    width.is_finite() && width > 0.0,
                    "chamfer width must be greater than 0",
                )?;
                check(
                    side != Side::On,
                    "a chamfer runs outside or inside the shapes",
                )
            }
        }
    }
}

impl Project {
    /// Checks the project is consistent: valid numbers, unique ids, and no
    /// reference to a region that does not exist.
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty() {
            return Err("the project has no id".into());
        }
        validate_tools(&self.tools)?;
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

        for (i, job) in self.jobs.iter().enumerate() {
            let fail = |e: String| format!("inlay \"{}\": {e}", job.name);
            if job.id.is_empty() || self.jobs[..i].iter().any(|other| other.id == job.id) {
                return Err(fail("its id is missing or used twice".into()));
            }
            job.inlay.validate().map_err(fail)?;
            if job.color.as_deref().is_some_and(|c| !is_color(c)) {
                return Err(fail("its colour must be written as #rrggbb".into()));
            }
            if let Some(setup) = &job.setup {
                setup.validate().map_err(fail)?;
            }
            if let Some(missing) = job.region_ids.iter().find(|id| !region_ids.contains(id)) {
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
            jobs: vec![
                Job {
                    id: "j1".into(),
                    name: "Walnut square".into(),
                    material: Material::HARDWOOD,
                    region_ids: vec![0],
                    color: None,
                    setup: None,
                    cut_out_tool_id: None,
                    inlay: Inlay::Vcarve {
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
                    },
                },
                Job {
                    id: "j2".into(),
                    name: "Maple triangle".into(),
                    material: Material::SOFTWOOD,
                    region_ids: vec![1],
                    color: None,
                    setup: None,
                    cut_out_tool_id: None,
                    inlay: Inlay::Flat {
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

        p.jobs[0].setup = Some(Setup {
            safe_height: 9.0,
            ..Setup::default()
        });
        p.jobs[0].cut_out_tool_id = Some("t-endmill".into());
        let read = project_from_file_json(&project_to_file_json(&p)).unwrap();
        assert_eq!(read, p);
        assert_eq!(Setup::of(&read, &read.jobs[0]).safe_height, 9.0);
        assert_eq!(Setup::of(&read, &read.jobs[1]), read.setup);
        // A tool named twice is listed once.
        assert_eq!(read.jobs[0].tool_ids(), vec!["t-endmill", "t-vbit"]);

        p.jobs[0].setup.as_mut().unwrap().plunge_clearance = 20.0;
        assert!(p.validate().unwrap_err().contains("plunge height"));
    }

    #[test]
    fn plain_operations_and_colours_round_trip() {
        let mut p = sample();
        p.base.color = Some("#d9b98a".into());
        p.jobs[0].color = Some("#5b3a1e".into());
        let mut op = |id: &str, inlay: Inlay| {
            p.jobs.push(Job {
                id: id.into(),
                name: id.into(),
                material: Material::HARDWOOD,
                region_ids: vec![0],
                color: None,
                setup: None,
                cut_out_tool_id: None,
                inlay,
            })
        };
        op(
            "pocket",
            Inlay::Pocket {
                pattern: Pattern::Offset,
                depth: 2.0,
                clearing_tool_ids: vec!["t-endmill".into()],
            },
        );
        op(
            "facing",
            Inlay::Facing {
                pattern: Pattern::Raster,
                above: 6.0,
                depth: 0.0,
                margin: 9.0,
                tool_id: Some("t-endmill".into()),
            },
        );
        op(
            "contour",
            Inlay::Contour {
                side: Side::Inside,
                depth: None,
                tabs: true,
                tool_id: Some("t-endmill".into()),
            },
        );
        op(
            "chamfer",
            Inlay::Chamfer {
                side: Side::Outside,
                width: 1.0,
                tool_id: Some("t-vbit".into()),
            },
        );
        let text = project_to_file_json(&p);
        assert!(text.contains("\"type\": \"contour\"") || text.contains("\"type\":\"contour\""));
        let read = project_from_file_json(&text).unwrap();
        assert_eq!(read, p);
        assert_eq!(read.jobs[4].tool_ids(), vec!["t-endmill"]);
        assert_eq!(read.jobs[5].tool_ids(), vec!["t-vbit"]);
        assert!(!read.jobs[2].inlay.is_inlay() && read.jobs[0].inlay.is_inlay());

        // A facing without a pattern goes side to side, a pocket in rings, and
        // a chamfer's tool may still be called its V-bit.
        let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
        for job in value["project"]["jobs"].as_array_mut().unwrap() {
            let inlay = job["inlay"].as_object_mut().unwrap();
            inlay.remove("pattern");
            if inlay["type"] == "chamfer" {
                let id = inlay.remove("toolId").unwrap();
                inlay.insert("vbitToolId".into(), id);
            }
        }
        let old = project_from_file_json(&value.to_string()).unwrap();
        assert!(matches!(
            old.jobs[2].inlay,
            Inlay::Pocket {
                pattern: Pattern::Offset,
                ..
            }
        ));
        assert!(matches!(
            old.jobs[3].inlay,
            Inlay::Facing {
                pattern: Pattern::Raster,
                ..
            }
        ));
        assert_eq!(old.jobs[5].tool_ids(), vec!["t-vbit"]);

        // A chamfer has no "on the line", and a colour is #rrggbb.
        let mut bad = p.clone();
        bad.jobs[5].inlay = Inlay::Chamfer {
            side: Side::On,
            width: 1.0,
            tool_id: None,
        };
        assert!(bad.validate().unwrap_err().contains("outside or inside"));
        let mut bad = p.clone();
        bad.jobs[0].color = Some("walnut".into());
        assert!(bad.validate().unwrap_err().contains("#rrggbb"));
    }

    #[test]
    fn empty_project_round_trips() {
        let project = Project {
            id: "p".into(),
            name: "New".into(),
            design: None,
            jobs: vec![],
            tools: vec![],
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
    fn a_job_pointing_at_a_missing_region_is_rejected() {
        let mut project = sample();
        project.jobs[0].region_ids.push(99);
        assert!(project.validate().is_err());
        assert!(matches!(
            project_from_file_json(&project_to_file_json(&project)),
            Err(FileError::Invalid(_))
        ));
    }

    #[test]
    fn negative_depths_are_rejected() {
        let mut project = sample();
        project.jobs[1].inlay = Inlay::Flat {
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
            project.jobs[0].inlay.tool_ids(),
            vec!["t-endmill", "t-vbit"]
        );
        assert_eq!(project.jobs[1].inlay.tool_ids(), vec!["t-endmill"]);
    }

    /// Files from every released format version must keep loading, and
    /// mean what they meant.
    #[test]
    fn version_1_fixture_loads() {
        let project =
            project_from_file_json(include_str!("../tests/fixtures/project-v1.json")).unwrap();
        assert_eq!(project, sample());
    }

    /// A file written while version 1 was still growing: a flat inlay with a
    /// single `toolId`, and none of the fields added later.
    #[test]
    fn early_version_1_fixture_loads_with_defaults() {
        let project =
            project_from_file_json(include_str!("../tests/fixtures/project-v1-early.json"))
                .unwrap();
        assert_eq!(project.name, "Coaster");
        assert_eq!(project.jobs.len(), 2);
        assert_eq!(project.design.as_ref().unwrap().regions.len(), 2);
        assert_eq!(project.jobs[1].inlay.tool_ids(), vec!["t-endmill"]);
        assert!(matches!(
            project.jobs[1].inlay,
            Inlay::Flat {
                tabs: true,
                insert_style: InsertStyle::Loose,
                cut_out: false,
                ..
            }
        ));
        assert!(matches!(
            project.jobs[0].inlay,
            Inlay::Vcarve {
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
        assert!(project.jobs[1].inlay.tool_ids().is_empty());
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
}
