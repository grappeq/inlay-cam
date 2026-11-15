//! Turns an inlay job into a G-code file, and simulates that file.
//!
//! This is the whole pipeline in one place: geometry -> moves -> G-code text
//! -> interpreted moves -> simulated stock.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::analysis::{self, Fit, PlugFrame};
use crate::gcode::{self, Interpreted};
use crate::geom::boolean::{difference, union};
use crate::geom::offset::{close, offset, open, total_area};
use crate::geom::{distance, Point, Region};
use crate::ops::clear::{centres, clear_centres, ClearParams};
use crate::ops::profile::{profile, ProfileError, ProfileParams, Tabs};
use crate::ops::vcarve::{narrow_parts, vcarve, vcarve_plug, VcarveParams};
use crate::post::carvera;
use crate::project::{Inlay, InsertStyle, Job, Project};
use crate::sim::{self, HeightMap};
use crate::toolpath::{Move, PathBuilder, Program, ProgramTool};
use crate::tools::{CuttingSettings, Material, Tool, ToolKind};

/// The machine the output is for.
pub struct Machine {
    pub name: &'static str,
    pub max_rpm: u32,
    /// Rapid speed, mm/min, used for time estimates.
    pub rapid_rate: f64,
    /// How far the tool can move in X and Y, mm.
    pub travel: [f64; 2],
}

pub const CARVERA_AIR: Machine = Machine {
    name: "Carvera Air",
    max_rpm: 13000,
    rapid_rate: 2000.0,
    travel: [300.0, 200.0],
};

/// Highest ridge the V-bit may leave between passes on a flat floor, mm.
pub const MAX_FLOOR_RIDGE: f64 = 0.1;

/// Height above the stock at which the tool travels between cuts, mm.
pub const SAFE_Z: f64 = 5.0;

/// The two halves of an inlay: each is cut from its own board, with its own file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Part {
    /// The recess in the base board.
    Pocket,
    /// The piece that fills it: carved face down in its own blank, mirrored.
    Plug,
}

/// What a part of this kind of inlay is called.
fn part_name(part: Part, inlay: &Inlay) -> &'static str {
    match (part, inlay) {
        (Part::Pocket, _) => "pocket",
        (Part::Plug, Inlay::Vcarve { .. }) => "plug",
        (
            Part::Plug,
            Inlay::Flat {
                insert_style: InsertStyle::Backer,
                ..
            },
        ) => "plug",
        (Part::Plug, Inlay::Flat { .. }) => "insert",
    }
}

/// How far past the bottom of its board an insert is cut, so that it comes
/// free cleanly, mm.
pub const THROUGH_CUT: f64 = 0.2;

/// How a flat insert and its pocket go together, from the shapes the tool
/// actually leaves. Lengths in mm, areas in mm².
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlatFit {
    /// Smallest and largest gap between the insert's edge and the pocket's wall.
    pub gap_min: f64,
    pub gap_max: f64,
    /// Area where the insert would overlap the base board.
    pub interference_area: f64,
    /// How far the insert stands above the base board's surface.
    pub proud: f64,
    /// Area of the drawing the tool cannot reproduce and leaves out, and
    /// area it has to add, both before the allowance.
    pub removed_area: f64,
    pub added_area: f64,
}

/// The board a part is cut from. The work origin is its bottom-left corner
/// and Z0 its top face.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stock {
    pub width: f64,
    pub height: f64,
    pub thickness: f64,
    /// How far below the board's bottom the file cuts on purpose.
    pub through: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Built {
    pub part: Part,
    pub stock: Stock,
    /// Stretches of the design, as it sits on the base board, too narrow for
    /// the plug to seat. V-carve inlays only.
    pub narrow: Vec<[Point; 2]>,
    /// Flat inlays: the outline both parts are cut to before the allowance,
    /// as it sits on the base board: the drawing with every corner the tool
    /// cannot cut rounded off. One list of points per closed outline.
    pub cuttable: Vec<Vec<Point>>,
    /// Flat inlays: how insert and pocket go together.
    pub flat_fit: Option<FlatFit>,
    pub file_name: String,
    pub gcode: String,
    pub stats: Stats,
    /// Things worth knowing that do not stop the job.
    pub warnings: Vec<String>,
    /// For a plug: where its blank lies on the base board once turned over.
    #[serde(skip)]
    pub frame: Option<PlugFrame>,
    /// For a plug cut out of a larger board: the plug itself on that board,
    /// as `[x0, y0, x1, y1]`.
    #[serde(skip)]
    pub piece: Option<[f64; 4]>,
    #[serde(skip)]
    pub program: Program,
    #[serde(skip)]
    pub interpreted: Interpreted,
    /// The part's outline in its own board's coordinates. For a flat pocket,
    /// what the tool's edge can reach; for a V-carved pocket, the shapes; for
    /// a plug, the mirrored shapes as they are at the engagement depth.
    #[serde(skip)]
    pub pocket: Vec<Region>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub lines: u32,
    /// Total length of cutting moves, mm.
    pub cutting_length: f64,
    /// Estimated running time, minutes, without tool changes.
    pub minutes: f64,
    /// Names of the tools in the order they are loaded.
    pub tools: Vec<String>,
    /// What each tool does, in the order they are first loaded.
    pub per_tool: Vec<ToolStats>,
    /// How many times a tool is put in the spindle, the first included.
    pub tool_changes: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStats {
    /// The tool's number in the file.
    pub number: u32,
    pub name: String,
    /// Length of its cutting moves, mm.
    pub cutting_length: f64,
    /// Its share of the running time, minutes.
    pub minutes: f64,
}

/// Builds the pocket file for a job.
pub fn build_pocket(project: &Project, job_id: &str) -> Result<Built, Vec<String>> {
    build(project, job_id, Part::Pocket)
}

/// Builds the file for one part of a job. On failure returns every reason
/// found, in plain words.
pub fn build(project: &Project, job_id: &str, part: Part) -> Result<Built, Vec<String>> {
    let machine = &CARVERA_AIR;
    let job = project
        .jobs
        .iter()
        .find(|j| j.id == job_id)
        .ok_or_else(|| vec!["This inlay no longer exists.".to_string()])?;
    let design = project
        .design
        .as_ref()
        .ok_or_else(|| vec!["The project has no design.".to_string()])?;

    // How deep the part is cut, and how thick its board is.
    let (depth, thickness) = match (part, &job.inlay) {
        (Part::Pocket, Inlay::Flat { pocket_depth, .. }) => (*pocket_depth, project.base.thickness),
        (
            Part::Pocket,
            Inlay::Vcarve {
                engagement_depth,
                glue_gap,
                ..
            },
        ) => (engagement_depth + glue_gap, project.base.thickness),
        (
            Part::Plug,
            Inlay::Vcarve {
                engagement_depth,
                saw_gap,
                plug_thickness,
                ..
            },
        ) => (engagement_depth + saw_gap, *plug_thickness),
        (
            Part::Plug,
            Inlay::Flat {
                insert_style: InsertStyle::Backer,
                pocket_depth,
                saw_gap,
                insert_thickness,
                ..
            },
        ) => (pocket_depth + saw_gap, *insert_thickness),
        (
            Part::Plug,
            Inlay::Flat {
                insert_thickness, ..
            },
        ) => (insert_thickness + THROUGH_CUT, *insert_thickness),
    };
    // A loose insert is cut right through its board on purpose.
    let loose = matches!(
        (part, &job.inlay),
        (
            Part::Plug,
            Inlay::Flat {
                insert_style: InsertStyle::Loose,
                ..
            }
        )
    );
    let name = part_name(part, &job.inlay);

    let mut errors: Vec<String> = Vec::new();
    let warnings: Vec<String> = Vec::new();

    let regions = union(&design.placed_regions(&job.region_ids));
    if regions.is_empty() {
        errors.push("The inlay has no shapes. Click shapes in the drawing to add them.".into());
    }
    if depth >= thickness && !loose {
        errors.push(match part {
            Part::Pocket => format!(
                "The pocket is {} mm deep but the base board is only {} mm thick.",
                num(depth),
                num(thickness)
            ),
            Part::Plug => format!(
                "The plug is cut {} mm deep but its board is only {} mm thick, which leaves no backer. Use a thicker board.",
                num(depth),
                num(thickness)
            ),
        });
    }

    let mut ctx = Context {
        project,
        job,
        machine,
        depth,
        errors,
        warnings,
    };
    let cut = match (part, &job.inlay) {
        (
            Part::Pocket,
            Inlay::Flat {
                clearing_tool_ids,
                allowance,
                pocket_depth,
                insert_thickness,
                ..
            },
        ) => flat_pocket(
            &mut ctx,
            &regions,
            clearing_tool_ids,
            *allowance,
            insert_thickness - pocket_depth,
        ),
        (
            Part::Plug,
            Inlay::Flat {
                clearing_tool_ids,
                allowance,
                tabs,
                pocket_depth,
                insert_thickness,
                insert_margin,
                insert_style,
                saw_gap,
                cut_out,
            },
        ) => {
            let insert = FlatInsert {
                allowance: *allowance,
                tabs: *tabs,
                pocket_depth: *pocket_depth,
                thickness: *insert_thickness,
                margin: *insert_margin,
                saw_gap: *saw_gap,
            };
            match insert_style {
                InsertStyle::Loose => flat_insert(&mut ctx, &regions, insert, clearing_tool_ids),
                InsertStyle::Backer => {
                    let cut = flat_backer(&mut ctx, &regions, insert, clearing_tool_ids, *cut_out);
                    match cut {
                        Some(cut) if *cut_out => cut_piece_out(
                            &mut ctx,
                            cut,
                            *insert_thickness,
                            *tabs,
                            clearing_tool_ids,
                        ),
                        other => other,
                    }
                }
            }
        }
        (
            Part::Pocket,
            Inlay::Vcarve {
                clearing_tool_ids,
                vbit_tool_id,
                ..
            },
        ) => vcarve_pocket(
            &mut ctx,
            &regions,
            clearing_tool_ids,
            vbit_tool_id.as_deref(),
        ),
        (
            Part::Plug,
            Inlay::Vcarve {
                engagement_depth,
                saw_gap,
                plug_margin,
                plug_thickness,
                clearing_tool_ids,
                vbit_tool_id,
                cut_out,
                tabs,
                ..
            },
        ) => {
            let cut = vcarve_plug_cut(
                &mut ctx,
                &regions,
                PlugShape {
                    engagement: *engagement_depth,
                    saw_gap: *saw_gap,
                    margin: *plug_margin,
                    cut_out: *cut_out,
                },
                clearing_tool_ids,
                vbit_tool_id.as_deref(),
            );
            match cut {
                Some(cut) if *cut_out => {
                    cut_piece_out(&mut ctx, cut, *plug_thickness, *tabs, clearing_tool_ids)
                }
                other => other,
            }
        }
    };
    // Where the pocket ends up shallower than the plug needs to go in.
    let mut narrow: Vec<[Point; 2]> = Vec::new();
    if let (
        Inlay::Vcarve {
            engagement_depth,
            vbit_tool_id,
            ..
        },
        Some(_),
    ) = (&job.inlay, &cut)
    {
        if let Some(vbit) = vbit_tool_id
            .as_deref()
            .and_then(|id| project.tools.iter().find(|t| t.id == id))
        {
            let (half_angle, tip_radius) = vbit_shape(vbit);
            let radius = tip_radius + engagement_depth * half_angle.tan();
            narrow = narrow_parts(&regions, radius).unwrap_or_default();
            let length: f64 = narrow.iter().map(|s| distance(s[0], s[1])).sum();
            if length < 0.5 {
                narrow.clear();
            } else {
                ctx.warnings.push(format!(
                    "About {} mm of the design is too narrow for the plug to seat: the pocket there is shallower than the engagement depth of {} mm. These parts are marked on the drawing.",
                    num(length.round()),
                    num(*engagement_depth)
                ));
            }
        }
    }
    let Context {
        errors,
        mut warnings,
        ..
    } = ctx;
    let (Some(cut), true) = (cut, errors.is_empty()) else {
        return Err(errors);
    };
    let pocket = cut.pocket;
    let frame = cut.frame;
    let flat_fit = cut.flat_fit;
    let cuttable = cut.cuttable;
    let through = cut.through;
    let piece = cut.piece;

    let (width, height) = cut.board.unwrap_or_else(|| design.placed_size());
    if part == Part::Pocket
        && regions
            .iter()
            .flat_map(|r| r.outer.iter())
            .any(|p| p[0] < 0.0 || p[1] < 0.0 || p[0] > width || p[1] > height)
    {
        warnings.push("Part of the inlay lies outside the design's page, which is taken as the edge of the base board.".into());
    }

    let program = Program {
        name: format!("{} - {} - {}", project.name, job.name, name),
        tools: cut.tools,
        safe_z: SAFE_Z,
        moves: cut.moves,
    };
    let gcode = carvera::write(&program);

    // The file must satisfy the firmware's rules and read back cleanly. A
    // failure here is a bug in this app, never the user's doing.
    let lint = carvera::lint(&gcode);
    if !lint.is_empty() {
        return Err(vec![format!(
            "Internal error: the G-code breaks a firmware rule ({}).",
            lint[0]
        )]);
    }
    let interpreted = gcode::interpret(&gcode).map_err(|e| {
        vec![format!(
            "Internal error: the G-code does not read back ({e})."
        )]
    })?;

    // Everything the tool does, from the first move to the last, has to fit
    // within the machine's travel wherever the board is clamped.
    for (axis, name) in [(0, "X"), (1, "Y")] {
        let (low, high) = interpreted
            .segments
            .iter()
            .flat_map(|s| [s.from[axis], s.to[axis]])
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(low, high), v| {
                (low.min(v), high.max(v))
            });
        if high - low > machine.travel[axis] {
            return Err(vec![format!(
                "The {} spans {} mm in {name}, more than the {} can travel ({} mm).",
                name,
                num((high - low).ceil()),
                machine.name,
                num(machine.travel[axis])
            )]);
        }
    }

    Ok(Built {
        part,
        stock: Stock {
            width,
            height,
            thickness,
            through,
        },
        narrow,
        cuttable,
        flat_fit,
        frame,
        piece,
        file_name: format!(
            "{}.{}",
            file_stem(&format!("{} {} {}", project.name, job.name, name)),
            carvera::FILE_EXTENSION
        ),
        stats: Stats {
            lines: interpreted.lines,
            cutting_length: interpreted.cutting_length(),
            minutes: interpreted.minutes(machine.rapid_rate),
            tools: program.tools.iter().map(|t| t.tool.name.clone()).collect(),
            tool_changes: interpreted.tool_changes.len() as u32,
            per_tool: program
                .tools
                .iter()
                .map(|t| {
                    let mine = || interpreted.segments.iter().filter(|s| s.tool == t.number);
                    ToolStats {
                        number: t.number,
                        name: t.tool.name.clone(),
                        cutting_length: mine().filter(|s| !s.rapid).map(|s| s.length()).sum(),
                        minutes: mine()
                            .map(|s| s.length() / if s.rapid { machine.rapid_rate } else { s.feed })
                            .sum(),
                    }
                })
                .collect(),
        },
        gcode,
        warnings,
        program,
        interpreted,
        pocket,
    })
}

/// What is known while a job is turned into moves, and what has been found
/// wrong with it so far.
struct Context<'a> {
    project: &'a Project,
    job: &'a Job,
    machine: &'a Machine,
    /// Depth of the pocket floor, mm.
    depth: f64,
    errors: Vec<String>,
    warnings: Vec<String>,
}

/// The moves that cut one part, and the tools they use.
#[derive(Default)]
struct Cut {
    tools: Vec<ProgramTool>,
    moves: Vec<Move>,
    pocket: Vec<Region>,
    /// Size of the board when it is not the base board.
    board: Option<(f64, f64)>,
    /// For a plug: where its blank lies on the base board once turned over.
    frame: Option<PlugFrame>,
    flat_fit: Option<FlatFit>,
    cuttable: Vec<Vec<Point>>,
    /// How far below the board's bottom the moves cut on purpose.
    through: f64,
    /// The plug on its board, when it is cut out of a larger one.
    piece: Option<[f64; 4]>,
}

impl<'a> Context<'a> {
    /// Looks up a tool for the job and checks it can do the work: right kind,
    /// cutting settings for the wood, speed within the machine's range and
    /// cutting edges long enough for the depth.
    fn tool(
        &mut self,
        id: Option<&str>,
        kind: ToolKind,
        what: &str,
    ) -> Option<(&'a Tool, &'a CuttingSettings)> {
        let tool = checked_tool(self.project, id, kind, what, &mut self.errors)?;
        let Some(cutting) = tool.cutting_for(self.job.material) else {
            self.errors.push(format!(
                "\"{}\" has no cutting settings for {}. Add them in the tool list.",
                tool.name,
                material_name(self.job.material)
            ));
            return None;
        };
        if cutting.rpm > self.machine.max_rpm {
            self.errors.push(format!(
                "\"{}\" is set to {} rpm, but the {} spindle tops out at {} rpm.",
                tool.name, cutting.rpm, self.machine.name, self.machine.max_rpm
            ));
        }
        match tool.flute_length {
            Some(flutes) if self.depth > flutes => self.errors.push(format!(
                "The pocket is {} mm deep, but the cutting edges of \"{}\" are only {} mm long.",
                num(self.depth),
                tool.name,
                num(flutes)
            )),
            Some(_) => {}
            None => self.warnings.push(format!(
                "The flute length of \"{}\" is unknown, so the depth could not be checked against it.",
                tool.name
            )),
        }
        if kind == ToolKind::FlatEnd && cutting.stepover > tool.diameter * 0.5 {
            self.warnings.push(format!(
                "The stepover of \"{}\" ({} mm) is more than half its diameter, which can leave thin ridges on the pocket floor.",
                tool.name,
                num(cutting.stepover)
            ));
        }
        Some((tool, cutting))
    }
}

/// A clearing tool that removes less than this share of the floor is hardly
/// worth its tool change when a V-bit finishes the floor anyway.
const SMALL_SHARE: f64 = 0.01;

impl<'a> Context<'a> {
    /// Looks up and checks every clearing end mill of the job, in the order
    /// given. `None` when any of them cannot be used.
    fn end_mills(&mut self, ids: &[String]) -> Option<Vec<(&'a Tool, &'a CuttingSettings)>> {
        let found: Vec<_> = ids
            .iter()
            .map(|id| self.tool(Some(id), ToolKind::FlatEnd, "an end mill"))
            .collect();
        found.into_iter().collect()
    }

    /// Clears `area` to the job's depth with the end mills in the order
    /// given: each cuts only what those before it left. A tool that fits
    /// nowhere, or finds nothing left, is not loaded at all, with a warning.
    /// Tools are numbered from `number` on, which is advanced. Returns the
    /// area cut and the tools used.
    fn clear_in_order(
        &mut self,
        path: &mut PathBuilder,
        area: &[Region],
        end_mills: &[(&Tool, &CuttingSettings)],
        number: &mut u32,
        what: &str,
        vbit_follows: bool,
    ) -> (Vec<Region>, Vec<ProgramTool>) {
        let whole = total_area(area);
        let mut cleared: Vec<Region> = Vec::new();
        let mut tools = Vec::new();
        for (tool, cutting) in end_mills {
            let fits = !offset(area, -tool.diameter / 2.0).is_empty();
            let where_to = centres(area, &cleared, tool.diameter);
            if where_to.is_empty() {
                if area.is_empty() {
                    continue;
                }
                self.warnings.push(if !fits {
                    format!(
                        "\"{}\" ({} mm) is too wide to fit anywhere in {what}, so it is not used.",
                        tool.name,
                        num(tool.diameter)
                    )
                } else {
                    format!(
                        "\"{}\" finds nothing left to cut in {what} after the tools before it, so it is not used. Put larger tools first.",
                        tool.name
                    )
                });
                continue;
            }
            path.start_tool(*number, cutting.rpm);
            let swept = clear_centres(path, &where_to, &clear_params(tool, cutting, self.depth));
            let fresh: f64 = swept
                .iter()
                .flat_map(|r| difference(r, &cleared))
                .map(|r| r.area())
                .sum();
            if vbit_follows && !cleared.is_empty() && fresh < SMALL_SHARE * whole {
                self.warnings.push(format!(
                    "\"{}\" removes only {} mm² of {what}. The V-bit could do that without the extra tool change.",
                    tool.name,
                    num((fresh * 10.0).round() / 10.0)
                ));
            }
            cleared.extend(swept);
            cleared = union(&cleared);
            tools.push(ProgramTool {
                number: *number,
                tool: (*tool).clone(),
            });
            *number += 1;
        }
        (cleared, tools)
    }
}

/// The id of the smallest end mill among `ids`, which is the one that sets
/// the corner radius of a flat inlay and cuts its insert out. When none of
/// the ids is an end mill of the project, the first id, so that looking it
/// up says what is wrong.
fn smallest_end_mill<'a>(project: &Project, ids: &'a [String]) -> Option<&'a str> {
    ids.iter()
        .filter_map(|id| {
            project
                .tools
                .iter()
                .find(|t| &t.id == id && t.kind == ToolKind::FlatEnd)
                .map(|t| (id, t.diameter))
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(id, _)| id.as_str())
        .or(ids.first().map(String::as_str))
}

fn clear_params(tool: &Tool, cutting: &CuttingSettings, depth: f64) -> ClearParams {
    ClearParams {
        tool_diameter: tool.diameter,
        depth,
        stepover: cutting.stepover,
        stepdown: cutting.stepdown,
        feed: cutting.feed,
        plunge: cutting.plunge,
    }
}

/// The shapes of a flat inlay as an end mill can cut them.
struct FlatShapes {
    /// The drawing with every corner the tool cannot cut rounded to its
    /// radius: inward corners for the pocket's sake, outward ones for the
    /// insert's. Both parts are cut to this, less the allowance.
    cuttable: Vec<Region>,
    /// The pocket: the cuttable shape grown by half the allowance.
    pocket: Vec<Region>,
    /// The insert: the cuttable shape shrunk by half the allowance, as the
    /// tool leaves it.
    insert: Vec<Region>,
}

fn flat_shapes(regions: &[Region], radius: f64, allowance: f64) -> FlatShapes {
    // One shape at a time: closing them together would join shapes that are
    // closer than the tool is wide, which is a matter for laying the inserts
    // out, not a reason to change the design.
    let cuttable: Vec<Region> = regions
        .iter()
        .flat_map(|r| open(&close(std::slice::from_ref(r), radius), radius))
        .collect();
    let pocket = open(&offset(&cuttable, allowance / 2.0), radius);
    // Cutting round the outside leaves inward corners rounded once more.
    let insert: Vec<Region> = offset(&cuttable, -allowance / 2.0)
        .iter()
        .flat_map(|r| close(std::slice::from_ref(r), radius))
        .collect();
    FlatShapes {
        cuttable,
        pocket,
        insert,
    }
}

/// Measures how the insert sits in the pocket and how far both are from the
/// drawing, and warns about what the user should know.
fn flat_fit(
    ctx: &mut Context,
    regions: &[Region],
    shapes: &FlatShapes,
    tool: &Tool,
    proud: f64,
) -> FlatFit {
    let area_outside = |of: &[Region], clip: &[Region]| -> f64 {
        of.iter()
            .flat_map(|r| difference(r, clip))
            .map(|r| r.area())
            .sum()
    };
    let removed_area = area_outside(regions, &shapes.cuttable);
    let added_area = area_outside(&shapes.cuttable, regions);
    // Overlap thinner than a hundredth is the rounding of curves, not wood.
    let interference_area = area_outside(&offset(&shapes.insert, -0.01), &shapes.pocket);

    // Walk the insert's edge and measure to the pocket's wall.
    let boxes: Vec<[f64; 4]> = shapes
        .pocket
        .iter()
        .map(|r| {
            r.outer.iter().fold(
                [
                    f64::INFINITY,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    f64::NEG_INFINITY,
                ],
                |b, q| {
                    [
                        b[0].min(q[0]),
                        b[1].min(q[1]),
                        b[2].max(q[0]),
                        b[3].max(q[1]),
                    ]
                },
            )
        })
        .collect();
    let (mut gap_min, mut gap_max) = (f64::INFINITY, f64::NEG_INFINITY);
    for ring in shapes.insert.iter().flat_map(|r| r.rings()) {
        for i in 0..ring.len() {
            let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
            let steps = (distance(a, b) / 0.5).ceil().max(1.0) as usize;
            for k in 0..steps {
                let t = k as f64 / steps as f64;
                let q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
                // Only pockets the point is in or right beside can matter.
                let near = || {
                    shapes
                        .pocket
                        .iter()
                        .zip(&boxes)
                        .filter(|(_, b)| {
                            q[0] > b[0] - 2.0
                                && q[1] > b[1] - 2.0
                                && q[0] < b[2] + 2.0
                                && q[1] < b[3] + 2.0
                        })
                        .map(|(r, _)| r)
                };
                if near().next().is_none() {
                    continue;
                }
                let to_wall = near()
                    .map(|r| r.distance_to_boundary(q))
                    .fold(f64::INFINITY, f64::min);
                let gap = if near().any(|r| r.contains(q)) {
                    to_wall
                } else {
                    -to_wall
                };
                gap_min = gap_min.min(gap);
                gap_max = gap_max.max(gap);
            }
        }
    }
    if !gap_min.is_finite() {
        (gap_min, gap_max) = (0.0, 0.0);
    }

    let wanted = total_area(regions);
    if removed_area + added_area > 0.002 * wanted {
        ctx.warnings.push(format!(
            "The parts cannot follow the drawing exactly: \"{}\" rounds every corner to its {} mm radius and cannot enter anything narrower than {} mm. {} mm² of the drawing is left out and {} mm² is added. The outline that will be cut is dashed on the drawing.",
            tool.name,
            num(tool.diameter / 2.0),
            num(tool.diameter),
            num((removed_area * 10.0).round() / 10.0),
            num((added_area * 10.0).round() / 10.0)
        ));
    }
    if interference_area > 0.01 {
        ctx.warnings.push(format!(
            "The insert overlaps the base board by {} mm²: it will not go in without trimming.",
            num((interference_area * 100.0).round() / 100.0)
        ));
    }
    FlatFit {
        gap_min,
        gap_max,
        interference_area,
        proud,
        removed_area,
        added_area,
    }
}

fn outlines(regions: &[Region]) -> Vec<Vec<Point>> {
    regions.iter().flat_map(|r| r.rings().cloned()).collect()
}

/// A flat-floored pocket with upright walls, cut with one end mill or with
/// several in order, each clearing what those before it left. The smallest
/// decides how sharp the corners can be.
fn flat_pocket(
    ctx: &mut Context,
    regions: &[Region],
    tool_ids: &[String],
    allowance: f64,
    proud: f64,
) -> Option<Cut> {
    if tool_ids.is_empty() {
        ctx.errors.push("Choose an end mill for this inlay.".into());
        return None;
    }
    let end_mills = ctx.end_mills(tool_ids)?;
    if !ctx.errors.is_empty() {
        return None;
    }
    let smallest = end_mills
        .iter()
        .map(|(tool, _)| *tool)
        .min_by(|a, b| a.diameter.total_cmp(&b.diameter))?;
    let shapes = flat_shapes(regions, smallest.diameter / 2.0, allowance);
    if shapes.pocket.is_empty() || shapes.insert.is_empty() {
        ctx.errors.push(format!(
            "\"{}\" ({} mm) is too wide to fit inside any of the selected shapes.",
            smallest.name,
            num(smallest.diameter)
        ));
        return None;
    }

    let mut number = carvera::FIRST_TOOL_NUMBER;
    let mut path = PathBuilder::new(SAFE_Z);
    let (_, tools) = ctx.clear_in_order(
        &mut path,
        &shapes.pocket,
        &end_mills,
        &mut number,
        "the pocket",
        false,
    );
    let fit = flat_fit(ctx, regions, &shapes, smallest, proud);
    Some(Cut {
        tools,
        moves: path.finish(),
        pocket: shapes.pocket,
        flat_fit: Some(fit),
        cuttable: outlines(&shapes.cuttable),
        ..Cut::default()
    })
}

struct FlatInsert {
    allowance: f64,
    tabs: bool,
    pocket_depth: f64,
    thickness: f64,
    margin: f64,
    saw_gap: f64,
}

/// The insert of a flat inlay: the shapes, less the allowance, cut right out
/// of their own board. Not mirrored: it goes into the pocket the way up it
/// was cut.
fn flat_insert(
    ctx: &mut Context,
    regions: &[Region],
    insert: FlatInsert,
    tool_ids: &[String],
) -> Option<Cut> {
    // The smallest end mill of the list cuts the insert out: the pocket's
    // corners are as sharp as that tool makes them.
    let tool_id = smallest_end_mill(ctx.project, tool_ids);
    let (tool, cutting) = ctx.tool(tool_id, ToolKind::FlatEnd, "an end mill")?;
    if insert.thickness < insert.pocket_depth {
        ctx.errors.push(format!(
            "The insert board is {} mm thick but the pocket is {} mm deep, so the insert would sit below the surface.",
            num(insert.thickness),
            num(insert.pocket_depth)
        ));
    }
    let needed = tool.diameter + 1.0;
    if insert.margin < needed {
        ctx.errors.push(format!(
            "The insert margin of {} mm is too small: \"{}\" needs {} mm around the shapes to cut them out.",
            num(insert.margin),
            tool.name,
            num((needed * 10.0).ceil() / 10.0)
        ));
    }
    if !ctx.errors.is_empty() || regions.is_empty() {
        return None;
    }
    let shapes = flat_shapes(regions, tool.diameter / 2.0, insert.allowance);
    if shapes.insert.is_empty() || shapes.pocket.is_empty() {
        ctx.errors.push(format!(
            "\"{}\" ({} mm) is too wide to fit inside any of the selected shapes.",
            tool.name,
            num(tool.diameter)
        ));
        return None;
    }

    // The board is the inserts' bounding box plus the margin, with its
    // bottom-left corner at the work origin.
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for q in shapes.insert.iter().flat_map(|r| r.outer.iter()) {
        x0 = x0.min(q[0]);
        y0 = y0.min(q[1]);
        x1 = x1.max(q[0]);
        y1 = y1.max(q[1]);
    }
    let (width, height) = (x1 - x0 + 2.0 * insert.margin, y1 - y0 + 2.0 * insert.margin);
    let place = |ring: &Vec<Point>| -> Vec<Point> {
        ring.iter()
            .map(|q| [q[0] - (x0 - insert.margin), q[1] - (y0 - insert.margin)])
            .collect()
    };
    let parts: Vec<Region> = shapes
        .insert
        .iter()
        .map(|r| Region::with_holes(place(&r.outer), r.holes.iter().map(place).collect()))
        .collect();

    let number = carvera::FIRST_TOOL_NUMBER;
    let mut path = PathBuilder::new(SAFE_Z);
    path.start_tool(number, cutting.rpm);
    let params = ProfileParams {
        tool_diameter: tool.diameter,
        depth: ctx.depth,
        stepdown: cutting.stepdown,
        feed: cutting.feed,
        plunge: cutting.plunge,
        tabs: insert.tabs.then_some(Tabs {
            // A millimetre of wood, or half the board if it is thinner than two.
            height: THROUGH_CUT + (insert.thickness / 2.0).min(1.0),
            width: 4.0,
            spacing: 40.0,
        }),
    };
    let report = match profile(&mut path, &parts, &params) {
        Ok(report) => report,
        Err(ProfileError::PartsTooClose) => {
            ctx.errors.push(format!(
                "Some of the shapes are closer together than \"{}\" is wide ({} mm), so their inserts cannot be cut apart where they are drawn. Put them in separate inlays.",
                tool.name,
                num(tool.diameter)
            ));
            return None;
        }
    };

    let fit = flat_fit(
        ctx,
        regions,
        &shapes,
        tool,
        insert.thickness - insert.pocket_depth,
    );
    if insert.tabs {
        let without = report.tabs.iter().filter(|n| **n == 0).count();
        if without > 0 {
            ctx.warnings.push(format!(
                "{} too small for tabs and will come loose on the last pass. Hold {} down with tape.",
                if parts.len() == 1 {
                    "The insert is".to_string()
                } else {
                    format!("{without} of the {} inserts are", parts.len())
                },
                if without == 1 { "it" } else { "them" }
            ));
        }
        if without < parts.len() {
            ctx.warnings.push(format!(
                "Tabs {} mm wide and {} mm thick hold each insert to its board: {} in all. Cut them and sand the edge flush before fitting.",
                num(4.0),
                num((insert.thickness / 2.0).min(1.0)),
                report.tabs.iter().sum::<usize>()
            ));
        }
    } else {
        ctx.warnings.push(
            "Without tabs the inserts come loose on the last pass. Hold them down with tape or they can be thrown by the tool.".into(),
        );
    }
    ctx.warnings.push(format!(
        "The cut goes {} mm past the bottom of the insert board: put a spoilboard under it.",
        num(THROUGH_CUT)
    ));
    Some(Cut {
        tools: vec![ProgramTool {
            number,
            tool: tool.clone(),
        }],
        moves: path.finish(),
        pocket: parts,
        board: Some((width, height)),
        flat_fit: Some(fit),
        cuttable: outlines(&shapes.cuttable),
        through: THROUGH_CUT,
        ..Cut::default()
    })
}

/// The insert of a flat inlay as one plug: the shapes, less the allowance,
/// left standing on a shared backer in a blank that is otherwise cut down to
/// a flat floor. Mirrored, because it is glued in face down; the backer then
/// ends up `saw_gap` above the base board and is sawn or planed off.
fn flat_backer(
    ctx: &mut Context,
    regions: &[Region],
    insert: FlatInsert,
    tool_ids: &[String],
    cut_out: bool,
) -> Option<Cut> {
    if tool_ids.is_empty() {
        ctx.errors.push("Choose an end mill for this inlay.".into());
        return None;
    }
    let end_mills = ctx.end_mills(tool_ids)?;
    let smallest = end_mills
        .iter()
        .map(|(tool, _)| *tool)
        .min_by(|a, b| a.diameter.total_cmp(&b.diameter))?;
    let largest = end_mills
        .iter()
        .map(|(tool, _)| tool.diameter)
        .fold(0.0, f64::max);
    let needed = largest + 1.0;
    if insert.margin < needed {
        ctx.errors.push(format!(
            "The insert margin of {} mm is too small: the tools need {} mm around the shapes.",
            num(insert.margin),
            num((needed * 10.0).ceil() / 10.0)
        ));
    }
    if !ctx.errors.is_empty() || regions.is_empty() {
        return None;
    }
    let shapes = flat_shapes(regions, smallest.diameter / 2.0, insert.allowance);
    if shapes.insert.is_empty() || shapes.pocket.is_empty() {
        ctx.errors.push(format!(
            "\"{}\" ({} mm) is too wide to fit inside any of the selected shapes.",
            smallest.name,
            num(smallest.diameter)
        ));
        return None;
    }

    // The blank is the inserts' bounding box plus the margin, mirrored left
    // to right because the plug goes in face down.
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for q in shapes.insert.iter().flat_map(|r| r.outer.iter()) {
        x0 = x0.min(q[0]);
        y0 = y0.min(q[1]);
        x1 = x1.max(q[0]);
        y1 = y1.max(q[1]);
    }
    let (width, height) = (x1 - x0 + 2.0 * insert.margin, y1 - y0 + 2.0 * insert.margin);
    let place = |ring: &Vec<Point>| -> Vec<Point> {
        ring.iter()
            .map(|q| [x1 + insert.margin - q[0], q[1] - (y0 - insert.margin)])
            .collect()
    };
    // The union also puts the rings the right way round again.
    let standing = union(
        &shapes
            .insert
            .iter()
            .map(|r| Region::with_holes(place(&r.outer), r.holes.iter().map(place).collect()))
            .collect::<Vec<_>>(),
    );
    let blank = Region::new(vec![
        [0.0, 0.0],
        [width, 0.0],
        [width, height],
        [0.0, height],
    ]);
    // The blank's edge is not a wall: the tools run over it, so that no
    // corner of the blank is left standing as high as the inserts.
    let reach = offset(std::slice::from_ref(&blank), largest / 2.0);
    let floor: Vec<Region> = reach
        .iter()
        .flat_map(|r| difference(r, &standing))
        .collect();

    let mut number = carvera::FIRST_TOOL_NUMBER;
    let mut path = PathBuilder::new(SAFE_Z);
    let (cleared, tools) = ctx.clear_in_order(
        &mut path,
        &floor,
        &end_mills,
        &mut number,
        "the plug's floor",
        false,
    );
    // Wood left standing between two inserts would keep the plug out.
    let left: f64 = open(
        &difference(&blank, &standing)
            .iter()
            .flat_map(|r| difference(r, &cleared))
            .collect::<Vec<_>>(),
        0.05,
    )
    .iter()
    .map(|r| r.area())
    .sum();
    if left > 0.5 {
        ctx.errors.push(format!(
            "Some of the shapes are closer together than \"{}\" is wide ({} mm), so the wood between their inserts cannot be removed. Put them in separate inlays or use a smaller end mill.",
            smallest.name,
            num(smallest.diameter)
        ));
        return None;
    }

    let fit = flat_fit(ctx, regions, &shapes, smallest, insert.saw_gap);
    ctx.warnings.push(format!(
        "The plug is mirrored: glue it in face down, then saw or plane off the backer, which sits {} mm above the surface.",
        num(insert.saw_gap)
    ));
    if !cut_out {
        ctx.warnings.push(format!(
            "The tools run up to {} mm beyond the edges of the plug blank. Keep clamps and stops clear, and do not use a board larger than {} × {} mm unless you trim it to that size afterwards.",
            num((largest / 2.0 * 10.0).ceil() / 10.0),
            num((width * 100.0).round() / 100.0),
            num((height * 100.0).round() / 100.0)
        ));
    }
    Some(Cut {
        tools,
        moves: path.finish(),
        pocket: standing,
        board: Some((width, height)),
        flat_fit: Some(fit),
        cuttable: outlines(&shapes.cuttable),
        ..Cut::default()
    })
}

/// Board left around a plug that is cut out of it, beyond the width of the
/// cut, mm.
const CUT_OUT_BORDER: f64 = 5.0;

/// Takes a finished plug, whose blank so far was the whole board, and cuts it
/// out of a larger board as one piece: the board grows by a border all round,
/// everything moves over by that border, and the largest end mill that is
/// long enough goes round the blank's edge until it is through.
fn cut_piece_out(
    ctx: &mut Context,
    mut cut: Cut,
    thickness: f64,
    tabs: bool,
    tool_ids: &[String],
) -> Option<Cut> {
    let (width, height) = cut.board?;
    let depth = thickness + THROUGH_CUT;
    let mut candidates: Vec<&Tool> = tool_ids
        .iter()
        .filter_map(|id| {
            ctx.project
                .tools
                .iter()
                .find(|t| &t.id == id && t.kind == ToolKind::FlatEnd)
        })
        .collect();
    candidates.sort_by(|a, b| b.diameter.total_cmp(&a.diameter));
    if candidates.is_empty() {
        ctx.errors.push(
            "Cutting the plug out of its board needs an end mill. Choose one for this inlay."
                .into(),
        );
        return None;
    }
    let Some(tool) = candidates
        .iter()
        .find(|t| t.flute_length.is_none_or(|flutes| flutes >= depth))
    else {
        ctx.errors.push(format!(
            "None of the chosen end mills has cutting edges long enough to cut the plug out of a {} mm board: {} mm are needed.",
            num(thickness),
            num(depth)
        ));
        return None;
    };
    let Some(cutting) = tool.cutting_for(ctx.job.material) else {
        ctx.errors.push(format!(
            "\"{}\" has no cutting settings for {}. Add them in the tool list.",
            tool.name,
            material_name(ctx.job.material)
        ));
        return None;
    };

    // A whole number of millimetres, so the plug keeps its place on the
    // simulation's grid and its fit reads the same cut out or not.
    let border = (tool.diameter + CUT_OUT_BORDER).ceil();
    let shift = |q: &mut [f64]| {
        q[0] += border;
        q[1] += border;
    };
    for m in &mut cut.moves {
        match m {
            Move::RapidXy { to } => shift(to),
            Move::Rapid { to } | Move::Feed { to, .. } => shift(to),
            Move::Arc { to, center, .. } => {
                shift(to);
                shift(center);
            }
            Move::ToolChange { .. } | Move::SpindleOn { .. } | Move::SpindleOff => {}
        }
    }
    for region in &mut cut.pocket {
        for q in region
            .outer
            .iter_mut()
            .chain(region.holes.iter_mut().flatten())
        {
            shift(q);
        }
    }
    if let Some(frame) = &mut cut.frame {
        frame.mirror_x += border;
        frame.offset_y -= border;
    }

    // The same tool keeps its number if it was used before.
    let number = match cut.tools.iter().find(|t| t.tool.id == tool.id) {
        Some(used) => used.number,
        None => {
            let number = cut
                .tools
                .iter()
                .map(|t| t.number)
                .max()
                .map_or(carvera::FIRST_TOOL_NUMBER, |n| n + 1);
            cut.tools.push(ProgramTool {
                number,
                tool: (*tool).clone(),
            });
            number
        }
    };
    let piece = Region::new(vec![
        [border, border],
        [border + width, border],
        [border + width, border + height],
        [border, border + height],
    ]);
    let tab_height = (thickness / 2.0).min(1.0);
    let mut path = PathBuilder::new(SAFE_Z);
    path.start_tool(number, cutting.rpm);
    let report = profile(
        &mut path,
        std::slice::from_ref(&piece),
        &ProfileParams {
            tool_diameter: tool.diameter,
            depth,
            stepdown: cutting.stepdown,
            feed: cutting.feed,
            plunge: cutting.plunge,
            tabs: tabs.then_some(Tabs {
                height: THROUGH_CUT + tab_height,
                width: 4.0,
                spacing: 40.0,
            }),
        },
    )
    .ok()?;
    cut.moves.extend(path.finish());

    let (board_width, board_height) = (width + 2.0 * border, height + 2.0 * border);
    let round = |v: f64| num((v * 100.0).round() / 100.0);
    ctx.warnings.push(format!(
        "The plug, {} × {} mm, is cut out of its board last, with \"{}\". The board must be at least {} × {} mm: {} mm more than the plug on every side.",
        round(width),
        round(height),
        tool.name,
        round(board_width),
        round(board_height),
        round(border)
    ));
    ctx.warnings.push(if tabs {
        format!(
            "{} tabs 4 mm wide and {} mm thick hold the plug to its board. Cut them and trim the edge before use.",
            report.tabs.iter().sum::<usize>(),
            num(tab_height)
        )
    } else {
        "Without tabs the plug comes loose on the last pass. Hold it down with tape or it can be thrown by the tool.".into()
    });
    ctx.warnings.push(format!(
        "The cut goes {} mm past the bottom of the board: put a spoilboard under it.",
        num(THROUGH_CUT)
    ));
    cut.board = Some((board_width, board_height));
    cut.through = THROUGH_CUT;
    cut.piece = Some([border, border, border + width, border + height]);
    Some(cut)
}

/// Half angle in radians and tip flat radius in mm of a V-bit.
fn vbit_shape(vbit: &Tool) -> (f64, f64) {
    (
        (vbit.tip_angle.unwrap_or(90.0) / 2.0).to_radians(),
        vbit.tip_diameter.unwrap_or(0.0) / 2.0,
    )
}

/// The tools of a V-carve job, checked, and how the V-bit is to be run.
struct VcarveSetup<'a> {
    vbit: &'a Tool,
    vbit_rpm: u32,
    end_mills: Vec<(&'a Tool, &'a CuttingSettings)>,
    params: VcarveParams,
}

/// Looks up and checks the tools of a V-carve job. `flat_depth` is how far the
/// floor is below the level where the outline is met; `ctx.depth` is how far
/// it is below the surface.
fn vcarve_setup<'a>(
    ctx: &mut Context<'a>,
    flat_depth: f64,
    end_mill_ids: &[String],
    vbit_id: Option<&str>,
) -> Option<VcarveSetup<'a>> {
    let vbit = ctx.tool(vbit_id, ToolKind::VBit, "a V-bit");
    let end_mills = ctx.end_mills(end_mill_ids);
    let (vbit, vcutting) = vbit?;
    let end_mills = end_mills?;
    if !ctx.errors.is_empty() {
        return None;
    }

    // On a flat floor only the bit's tip cuts, so passes further apart than
    // this leave ridges higher than MAX_FLOOR_RIDGE whatever the tool's own
    // stepover says (tool libraries often give a share of the body diameter).
    let (half_angle, tip_radius) = vbit_shape(vbit);
    let floor_stepover = 2.0 * tip_radius + 2.0 * MAX_FLOOR_RIDGE * half_angle.tan();
    let params = VcarveParams {
        half_angle,
        tip_radius,
        depth: flat_depth,
        stepdown: vcutting.stepdown,
        stepover: vcutting.stepover.min(floor_stepover),
        feed: vcutting.feed,
        plunge: vcutting.plunge,
    };
    let reach = params.radius_at(ctx.depth);
    if reach > vbit.diameter / 2.0 + 1e-9 {
        ctx.errors.push(format!(
            "At {} mm deep \"{}\" would have to be {} mm wide, but it is {} mm. Use a wider V-bit or a shallower cut.",
            num(ctx.depth),
            vbit.name,
            num(reach * 2.0),
            num(vbit.diameter)
        ));
        return None;
    }
    Some(VcarveSetup {
        vbit,
        vbit_rpm: vcutting.rpm,
        end_mills,
        params,
    })
}

/// Clears `floor` with the end mills that are chosen, in order, then loads
/// the V-bit. Returns the floor the end mills cut and the tools used so far;
/// the V-bit is the last of them.
fn clear_floor_then_load_vbit(
    ctx: &mut Context,
    setup: &VcarveSetup,
    path: &mut PathBuilder,
    floor: &[Region],
    whose: &str,
) -> (Vec<Region>, Vec<ProgramTool>) {
    let mut number = carvera::FIRST_TOOL_NUMBER;
    let (cleared, mut tools) = ctx.clear_in_order(
        path,
        floor,
        &setup.end_mills,
        &mut number,
        &format!("the {whose} flat floor"),
        true,
    );
    if !floor.is_empty() && tools.is_empty() {
        ctx.warnings.push(if setup.end_mills.is_empty() {
            format!("No end mill is chosen, so the V-bit clears the {whose} flat floor on its own, which takes much longer.")
        } else {
            format!("The V-bit clears the {whose} flat floor on its own, which takes much longer.")
        });
    }
    path.start_tool(number, setup.vbit_rpm);
    tools.push(ProgramTool {
        number,
        tool: setup.vbit.clone(),
    });
    (cleared, tools)
}

fn carving_failed(ctx: &mut Context, e: impl std::fmt::Debug) {
    ctx.errors.push(format!(
        "A shape could not be carved: its outline may cross itself or be too small to work out ({e:?})."
    ));
}

/// A V-carved pocket: an end mill (when one is chosen and fits) clears the
/// flat floor, then the V-bit cuts the sloped walls, the corners and whatever
/// floor is left.
fn vcarve_pocket(
    ctx: &mut Context,
    regions: &[Region],
    end_mill_ids: &[String],
    vbit_id: Option<&str>,
) -> Option<Cut> {
    let setup = vcarve_setup(ctx, ctx.depth, end_mill_ids, vbit_id)?;
    let floor = setup.params.floor(regions);
    let mut path = PathBuilder::new(SAFE_Z);
    let (cleared, tools) = clear_floor_then_load_vbit(ctx, &setup, &mut path, &floor, "pocket's");
    if let Err(e) = vcarve(&mut path, regions, &cleared, &setup.params) {
        carving_failed(ctx, e);
        return None;
    }
    Some(Cut {
        tools,
        moves: path.finish(),
        pocket: regions.to_vec(),
        board: None,
        ..Cut::default()
    })
}

struct PlugShape {
    engagement: f64,
    saw_gap: f64,
    margin: f64,
    /// The plug will be cut out of a larger board afterwards.
    cut_out: bool,
}

/// The plug of a V-carve inlay: the shapes mirrored, left standing in a blank
/// that is otherwise cut down to a flat floor. Turned over, the shapes go
/// `engagement` deep into the pocket and the floor ends up `saw_gap` above
/// the base board.
fn vcarve_plug_cut(
    ctx: &mut Context,
    regions: &[Region],
    plug: PlugShape,
    end_mill_ids: &[String],
    vbit_id: Option<&str>,
) -> Option<Cut> {
    let setup = vcarve_setup(ctx, plug.saw_gap, end_mill_ids, vbit_id)?;
    let p = &setup.params;
    if regions.is_empty() {
        return None;
    }

    // The bit runs this far outside the shapes at floor depth.
    let needed = p.radius_at(plug.saw_gap) + 0.5;
    if plug.margin < needed {
        ctx.errors.push(format!(
            "The plug margin of {} mm is too small: the V-bit needs {} mm around the shapes.",
            num(plug.margin),
            num((needed * 10.0).ceil() / 10.0)
        ));
        return None;
    }

    // The blank is the shapes' bounding box plus the margin. Mirrored left to
    // right, because the plug goes in face down.
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for q in regions.iter().flat_map(|r| r.outer.iter()) {
        x0 = x0.min(q[0]);
        y0 = y0.min(q[1]);
        x1 = x1.max(q[0]);
        y1 = y1.max(q[1]);
    }
    let (width, height) = (x1 - x0 + 2.0 * plug.margin, y1 - y0 + 2.0 * plug.margin);
    let place = |ring: &Vec<Point>| -> Vec<Point> {
        ring.iter()
            .map(|q| [x1 + plug.margin - q[0], q[1] - (y0 - plug.margin)])
            .collect()
    };
    // The union also puts the rings the right way round again.
    let shapes = union(
        &regions
            .iter()
            .map(|r| Region::with_holes(place(&r.outer), r.holes.iter().map(place).collect()))
            .collect::<Vec<_>>(),
    );
    let blank = Region::new(vec![
        [0.0, 0.0],
        [width, 0.0],
        [width, height],
        [0.0, height],
    ]);

    let floor = difference(&blank, &offset(&shapes, plug.saw_gap * p.tan()));
    let mut path = PathBuilder::new(SAFE_Z);
    let (cleared, tools) = clear_floor_then_load_vbit(ctx, &setup, &mut path, &floor, "plug's");
    if let Err(e) = vcarve_plug(&mut path, &shapes, &blank, &cleared, plug.engagement, p) {
        carving_failed(ctx, e);
        return None;
    }
    if !plug.cut_out {
        ctx.warnings.push(format!(
            "The tools cut right up to the edges of the plug blank, and the V-bit's flank passes up to {} mm beyond them. Keep clamps and stops clear, and do not use a blank larger than {} × {} mm unless you trim it to that size afterwards.",
            num((p.radius_at(ctx.depth) * 10.0).ceil() / 10.0),
            num((width * 100.0).round() / 100.0),
            num((height * 100.0).round() / 100.0)
        ));
    }
    Some(Cut {
        tools,
        moves: path.finish(),
        pocket: shapes,
        board: Some((width, height)),
        frame: Some(PlugFrame {
            mirror_x: x1 + plug.margin,
            offset_y: y0 - plug.margin,
        }),
        ..Cut::default()
    })
}

fn checked_tool<'a>(
    project: &'a Project,
    id: Option<&str>,
    kind: ToolKind,
    what: &str,
    errors: &mut Vec<String>,
) -> Option<&'a Tool> {
    let Some(id) = id else {
        errors.push(format!("Choose {what} for this inlay."));
        return None;
    };
    let tool = project.tools.iter().find(|t| t.id == id);
    match tool {
        None => errors.push(format!(
            "The chosen tool is missing from the project. Choose {what} again."
        )),
        Some(t) if t.kind != kind => errors.push(format!("\"{}\" is not {what}.", t.name)),
        Some(_) => {}
    }
    tool.filter(|t| t.kind == kind)
}

fn material_name(material: Material) -> &'static str {
    match material {
        Material::Hardwood => "hardwood",
        Material::Softwood => "softwood",
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Preview {
    pub map: HeightMap,
    /// Problems found while cutting, each with its G-code line.
    pub problems: Vec<sim::SimProblem>,
    pub built: Built,
}

/// Builds a job's pocket file and simulates that file on the base board.
pub fn preview_pocket(project: &Project, job_id: &str) -> Result<Preview, Vec<String>> {
    preview(project, job_id, Part::Pocket)
}

/// Builds the file for one part of a job and simulates that file on the
/// part's board.
pub fn preview(project: &Project, job_id: &str, part: Part) -> Result<Preview, Vec<String>> {
    let built = build(project, job_id, part)?;
    let Stock {
        width,
        height,
        thickness,
        through,
    } = built.stock;
    let tools: HashMap<u32, Tool> = built
        .program
        .tools
        .iter()
        .map(|t| (t.number, t.tool.clone()))
        .collect();
    let cell = HeightMap::cell_for(width, height, 2_000_000.0, 0.05);
    // Simulate what the file says, read back from its text.
    let simulation = sim::simulate(
        &built.interpreted,
        &tools,
        width,
        height,
        thickness + through,
        cell,
    );
    Ok(Preview {
        map: simulation.map,
        problems: simulation.problems,
        built,
    })
}

/// Both parts of a V-carve inlay, simulated, and how they fit together.
#[derive(Debug, Clone, PartialEq)]
pub struct FitCheck {
    pub fit: Fit,
    pub pocket: Preview,
    pub plug: Preview,
}

/// Builds and simulates the pocket and the plug of a V-carve inlay, then
/// lowers the plug into the pocket and measures the fit.
pub fn check_fit(project: &Project, job_id: &str) -> Result<FitCheck, Vec<String>> {
    // Fail early for a flat inlay, before anything is simulated.
    fit_settings(project, job_id)?;
    let pocket = preview(project, job_id, Part::Pocket)?;
    let plug = preview(project, job_id, Part::Plug)?;
    let fit = fit_of(project, job_id, &pocket, &plug)?;
    Ok(FitCheck { fit, pocket, plug })
}

/// Engagement depth and pocket depth of a V-carve inlay.
fn fit_settings(project: &Project, job_id: &str) -> Result<(f64, f64), Vec<String>> {
    let job = project
        .jobs
        .iter()
        .find(|j| j.id == job_id)
        .ok_or_else(|| vec!["This inlay no longer exists.".to_string()])?;
    let Inlay::Vcarve {
        engagement_depth,
        glue_gap,
        ..
    } = &job.inlay
    else {
        return Err(vec![
            "A flat inlay's fit is worked out from its outlines when a part is generated.".into(),
        ]);
    };
    Ok((*engagement_depth, engagement_depth + glue_gap))
}

/// Lowers an already simulated plug into an already simulated pocket of the
/// same V-carve inlay and measures the fit.
pub fn fit_of(
    project: &Project,
    job_id: &str,
    pocket: &Preview,
    plug: &Preview,
) -> Result<Fit, Vec<String>> {
    let (engagement, pocket_depth) = fit_settings(project, job_id)?;
    let frame = plug.built.frame.ok_or_else(|| {
        vec!["Internal error: the plug has no position on the base board.".to_string()]
    })?;
    // A plug cut out of a larger board is only what lies inside the cut: the
    // rest of that board is not there when the plug goes in.
    let masked;
    let plug_map = match plug.built.piece {
        Some([x0, y0, x1, y1]) => {
            let mut map = plug.map.clone();
            for iy in 0..map.ny {
                for ix in 0..map.nx {
                    let [x, y] = map.centre(ix, iy);
                    if x < x0 || x > x1 || y < y0 || y > y1 {
                        map.z[iy * map.nx + ix] = f32::NAN;
                    }
                }
            }
            masked = map;
            &masked
        }
        None => &plug.map,
    };
    analysis::fit(&pocket.map, plug_map, frame, engagement, pocket_depth)
        .ok_or_else(|| vec!["The plug does not lie over the base board at all.".to_string()])
}

fn num(v: f64) -> String {
    let s = format!("{:.3}", (v * 1000.0).round() / 1000.0);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Letters, digits, dashes and underscores only, so the name is safe on the
/// machine's SD card and in its file list.
fn file_stem(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "inlay".into()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{BaseStock, Design, DesignRegion, Job};
    use crate::tools::fixtures::{end_mill, v_bit};
    use crate::tools::CuttingSettings;

    /// A 60 x 40 mm page with a 30 x 20 mm rectangle and an L shape.
    fn project() -> Project {
        Project {
            id: "p".into(),
            name: "Test board".into(),
            design: Some(Design {
                source_name: "t.svg".into(),
                width: 60.0,
                height: 40.0,
                scale: 1.0,
                mirror: false,
                regions: vec![
                    DesignRegion {
                        id: 0,
                        color: None,
                        outer: vec![[5.0, 5.0], [35.0, 5.0], [35.0, 25.0], [5.0, 25.0]],
                        holes: vec![],
                    },
                    DesignRegion {
                        id: 1,
                        color: None,
                        outer: vec![
                            [40.0, 5.0],
                            [55.0, 5.0],
                            [55.0, 12.0],
                            [47.0, 12.0],
                            [47.0, 35.0],
                            [40.0, 35.0],
                        ],
                        holes: vec![],
                    },
                ],
            }),
            jobs: vec![Job {
                id: "j".into(),
                name: "Flat inlay 1".into(),
                material: Material::Hardwood,
                region_ids: vec![0, 1],
                inlay: Inlay::Flat {
                    pocket_depth: 2.0,
                    allowance: 0.1,
                    tabs: false,
                    clearing_tool_ids: vec!["t-endmill".into()],
                    insert_thickness: 4.0,
                    insert_margin: 8.0,
                    insert_style: InsertStyle::Loose,
                    saw_gap: 1.5,
                    cut_out: false,
                },
            }],
            tools: vec![end_mill(), v_bit()],
            base: BaseStock { thickness: 18.0 },
        }
    }

    fn with_inlay(inlay: Inlay) -> Project {
        let mut p = project();
        p.jobs[0].inlay = inlay;
        p
    }

    #[test]
    fn builds_a_file_that_obeys_the_firmware_rules_and_reads_back() {
        let built = build_pocket(&project(), "j").unwrap();
        assert_eq!(built.file_name, "Test-board-Flat-inlay-1-pocket.cnc");
        assert!(built.gcode.starts_with("(Test board - Flat inlay 1 - pocket)\n(T1 D=3.175 - D3.175x22 1F Downcut)\nG90 G94\nG17\nG21\nM6 T1\nS12000 M3\nG54\n"));
        assert!(built.gcode.ends_with("M5\nG28\nM30\n"));
        assert_eq!(carvera::lint(&built.gcode), Vec::<String>::new());
        assert_eq!(built.stats.tools, ["Ø3.175×22 1F Downcut"]);
        assert!(built.stats.cutting_length > 500.0);
        assert!(built.stats.minutes > 1.0);
    }

    /// The move list survives being written as G-code and read back.
    #[test]
    fn interpreted_file_matches_the_moves_it_was_written_from() {
        use crate::toolpath::Move;
        let built = build_pocket(&project(), "j").unwrap();
        let cuts: Vec<[f64; 3]> = built
            .program
            .moves
            .iter()
            .filter_map(|m| {
                if let Move::Feed { to, .. } = m {
                    Some(*to)
                } else {
                    None
                }
            })
            .collect();
        let read: Vec<[f64; 3]> = built
            .interpreted
            .segments
            .iter()
            .filter(|s| !s.rapid)
            .map(|s| s.to)
            .collect();
        assert_eq!(cuts.len(), read.len());
        for (a, b) in cuts.iter().zip(&read) {
            for axis in 0..3 {
                assert!(
                    (a[axis] - b[axis]).abs() <= 0.0005 + 1e-9,
                    "{a:?} was read back as {b:?}"
                );
            }
        }
    }

    /// The simulated pocket matches the shape the tool can reach: full depth
    /// everywhere inside it, untouched everywhere outside.
    #[test]
    fn simulated_pocket_has_no_gouges_and_no_leftover_material() {
        let project = project();
        let preview = preview_pocket(&project, "j").unwrap();
        assert_eq!(preview.problems, []);

        // The pocket the tool is asked for: the cuttable shape plus half the
        // allowance. Nothing may be cut outside it, and all of it must be cut.
        let wanted = preview.built.pocket.clone();
        let reachable = wanted.clone();
        let map = &preview.map;
        // A cell's centre can sit up to 0.71 cells from a boundary it straddles.
        let margin = map.cell;
        let (mut inside, mut outside) = (0, 0);
        for iy in 0..map.ny {
            for ix in 0..map.nx {
                let p = map.centre(ix, iy);
                let z = map.at(ix, iy) as f64;
                let in_design = wanted.iter().any(|r| r.contains(p));
                let edge_distance = wanted
                    .iter()
                    .map(|r| r.distance_to_boundary(p))
                    .fold(f64::INFINITY, f64::min);
                if !in_design && edge_distance > margin {
                    assert_eq!(z, 0.0, "gouge outside the shape at {p:?}");
                    outside += 1;
                }
                let reach = reachable.iter().any(|r| r.contains(p));
                let reach_edge = reachable
                    .iter()
                    .map(|r| r.distance_to_boundary(p))
                    .fold(f64::INFINITY, f64::min);
                if reach && reach_edge > margin {
                    assert!((z + 2.0).abs() < 1e-4, "material left at {p:?}: height {z}");
                    inside += 1;
                }
                assert!(z >= -2.0 - 1e-4, "cut too deep at {p:?}");
            }
        }
        assert!(inside > 10_000 && outside > 10_000);
    }

    #[test]
    fn flat_parts_are_cut_to_a_shape_the_tool_can_make_and_say_how_it_differs() {
        let built = build_pocket(&project(), "j").unwrap();
        assert!(
            built
                .warnings
                .iter()
                .any(|w| w.contains("cannot follow the drawing exactly")
                    && w.contains("1.588 mm radius")),
            "{:?}",
            built.warnings
        );
        let fit = built.flat_fit.unwrap();
        // Five sharp outward corners of the rectangle and four of the L are
        // rounded off; the L's one inward corner is filled in.
        let corner = (1.0 - std::f64::consts::FRAC_PI_4) * 1.5875 * 1.5875;
        assert!(
            (fit.removed_area - 9.0 * corner).abs() < 0.1,
            "removed {}",
            fit.removed_area
        );
        assert!(
            (fit.added_area - corner).abs() < 0.05,
            "added {}",
            fit.added_area
        );
        assert_eq!(built.cuttable.len(), 2);
        // The insert is 0.1 mm smaller than the pocket all round and stands
        // 2 mm proud of a 2 mm deep pocket in a 4 mm board.
        assert!((fit.gap_min - 0.1).abs() < 0.02, "gap min {}", fit.gap_min);
        assert!((fit.gap_max - 0.1).abs() < 0.02, "gap max {}", fit.gap_max);
        assert!(fit.interference_area < 1e-6);
        assert!((fit.proud - 2.0).abs() < 1e-9);
    }

    #[test]
    fn insert_is_cut_out_of_its_own_board_and_fits_the_pocket() {
        let project = project();
        let built = build(&project, "j", Part::Plug).unwrap();
        assert_eq!(built.file_name, "Test-board-Flat-inlay-1-insert.cnc");
        // Shapes span X 5..55 and Y 5..35, less 0.05 allowance each side,
        // plus an 8 mm margin all round.
        assert!((built.stock.width - 65.9).abs() < 0.01, "{:?}", built.stock);
        assert!((built.stock.height - 45.9).abs() < 0.01);
        assert_eq!(built.stock.thickness, 4.0);
        assert_eq!(carvera::lint(&built.gcode), Vec::<String>::new());
        assert!(built.warnings.iter().any(|w| w.contains("Without tabs")));
        assert!(built.warnings.iter().any(|w| w.contains("spoilboard")));
        // The same fit either way round.
        let pocket = build_pocket(&project, "j").unwrap();
        assert_eq!(built.flat_fit, pocket.flat_fit);

        // Simulated: the inserts stand untouched, the tool went right through
        // around them, and going through is not reported as a problem.
        let preview = preview(&project, "j", Part::Plug).unwrap();
        assert_eq!(preview.problems, []);
        let map = &preview.map;
        let (mut kept, mut through) = (0, 0);
        for iy in 0..map.ny {
            for ix in 0..map.nx {
                let p = map.centre(ix, iy);
                let z = map.at(ix, iy) as f64;
                let inside = built.pocket.iter().any(|r| r.contains(p));
                let edge = built
                    .pocket
                    .iter()
                    .map(|r| r.distance_to_boundary(p))
                    .fold(f64::INFINITY, f64::min);
                if inside && edge > map.cell {
                    assert_eq!(z, 0.0, "insert cut into at {p:?}");
                    kept += 1;
                }
                if !inside && edge > map.cell && edge < 3.175 - map.cell {
                    assert!((z + 4.2).abs() < 1e-4, "not cut through at {p:?}: {z}");
                    through += 1;
                }
            }
        }
        assert!(kept > 10_000 && through > 1_000);
    }

    #[test]
    fn insert_tabs_and_reasons() {
        let mut p = project();
        if let Inlay::Flat { tabs, .. } = &mut p.jobs[0].inlay {
            *tabs = true;
        }
        let built = build(&p, "j", Part::Plug).unwrap();
        assert!(
            built
                .warnings
                .iter()
                .any(|w| w.contains("Tabs 4 mm wide and 1 mm thick")),
            "{:?}",
            built.warnings
        );
        // Tabs: level moves 1 mm above the bottom of the board.
        assert!(built.gcode.contains("Z-3.000"));

        let reasons = |p: &Project| build(p, "j", Part::Plug).unwrap_err().join(" | ");
        let mut p = project();
        if let Inlay::Flat {
            insert_thickness, ..
        } = &mut p.jobs[0].inlay
        {
            *insert_thickness = 1.0;
        }
        assert!(reasons(&p).contains("would sit below the surface"));
        let mut p = project();
        if let Inlay::Flat { insert_margin, .. } = &mut p.jobs[0].inlay {
            *insert_margin = 2.0;
        }
        assert!(reasons(&p).contains("insert margin of 2 mm is too small"));
        // Rectangle and L are 5 mm apart: fine for a 3.175 mm tool, not for 6.
        let mut p = project();
        p.tools[0].diameter = 6.0;
        if let Inlay::Flat { insert_margin, .. } = &mut p.jobs[0].inlay {
            *insert_margin = 10.0;
        }
        assert!(
            reasons(&p).contains("cannot be cut apart"),
            "{}",
            reasons(&p)
        );
    }

    #[test]
    fn explains_every_reason_a_job_cannot_be_built() {
        let reasons = |p: &Project| build_pocket(p, "j").unwrap_err().join(" | ");

        let p = with_inlay(Inlay::Flat {
            pocket_depth: 2.0,
            allowance: 0.1,
            tabs: false,
            clearing_tool_ids: vec![],
            insert_thickness: 4.0,
            insert_margin: 8.0,
            insert_style: InsertStyle::Loose,
            saw_gap: 1.5,
            cut_out: false,
        });
        assert!(reasons(&p).contains("Choose an end mill"));

        let p = with_inlay(Inlay::Flat {
            pocket_depth: 2.0,
            allowance: 0.1,
            tabs: false,
            clearing_tool_ids: vec!["t-vbit".into()],
            insert_thickness: 4.0,
            insert_margin: 8.0,
            insert_style: InsertStyle::Loose,
            saw_gap: 1.5,
            cut_out: false,
        });
        assert!(reasons(&p).contains("is not an end mill"));

        let p = with_inlay(Inlay::Flat {
            pocket_depth: 25.0,
            allowance: 0.1,
            tabs: false,
            clearing_tool_ids: vec!["t-endmill".into()],
            insert_thickness: 4.0,
            insert_margin: 8.0,
            insert_style: InsertStyle::Loose,
            saw_gap: 1.5,
            cut_out: false,
        });
        let text = reasons(&p);
        assert!(
            text.contains("only 18 mm thick") && text.contains("only 22 mm long"),
            "{text}"
        );

        let mut p = project();
        p.jobs[0].material = Material::Softwood;
        assert!(reasons(&p).contains("no cutting settings for softwood"));

        let mut p = project();
        p.tools[0].cutting[0].rpm = 15000;
        assert!(reasons(&p).contains("tops out at 13000 rpm"));

        let mut p = project();
        p.jobs[0].region_ids.clear();
        assert!(reasons(&p).contains("has no shapes"));

        let mut p = project();
        p.tools[0].diameter = 30.0;
        p.tools[0].cutting[0].stepover = 10.0;
        assert!(reasons(&p).contains("too wide to fit"));

        assert!(reasons(&with_inlay(Inlay::default_vcarve())).contains("Choose a V-bit"));
        assert!(build_pocket(&project(), "nope").unwrap_err()[0].contains("no longer exists"));
    }

    #[test]
    fn scale_and_mirror_are_applied_before_cutting() {
        let mut p = project();
        let design = p.design.as_mut().unwrap();
        design.scale = 2.0;
        design.mirror = true;
        p.jobs[0].region_ids = vec![0];
        let built = build_pocket(&p, "j").unwrap();
        // The rectangle spans X 5..35 of a 60 mm page: mirrored 25..55, doubled 50..110.
        let xs: Vec<f64> = built
            .interpreted
            .segments
            .iter()
            .filter(|s| !s.rapid)
            .map(|s| s.to[0])
            .collect();
        let (min, max) = (
            xs.iter().cloned().fold(f64::INFINITY, f64::min),
            xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
        );
        // The pocket is half the 0.1 mm allowance larger all round.
        let r = 3.175 / 2.0 - 0.05;
        assert!(
            (min - (50.0 + r)).abs() < 0.01 && (max - (110.0 - r)).abs() < 0.01,
            "cut spans X {min}..{max}"
        );
    }

    /// 2 mm engagement plus 0.3 mm glue gap with the 60 degree bit and the
    /// 3.175 mm end mill.
    fn vcarve_project(clearing: bool) -> Project {
        let mut p = with_inlay(Inlay::Vcarve {
            engagement_depth: 2.0,
            glue_gap: 0.3,
            saw_gap: 1.5,
            plug_margin: 6.0,
            plug_thickness: 8.0,
            cut_out: false,
            tabs: false,
            clearing_tool_ids: if clearing {
                vec!["t-endmill".into()]
            } else {
                vec![]
            },
            vbit_tool_id: Some("t-vbit".into()),
        });
        p.tools[1].cutting = vec![CuttingSettings {
            material: Material::Hardwood,
            rpm: 12000,
            feed: 500.0,
            plunge: 150.0,
            stepover: 0.2,
            stepdown: 1.0,
        }];
        p
    }

    /// Compares the simulated V-carved pocket with the surface it should be:
    /// at each point as deep as its distance to the outline allows, down to
    /// the floor. Returns the largest amount cut too deep and left too high.
    fn deviation_from_ideal(project: &Project, preview: &Preview) -> (f64, f64) {
        let design = project.design.as_ref().unwrap();
        let shapes = union(&design.placed_regions(&[0, 1]));
        let tan = 30f64.to_radians().tan();
        let map = &preview.map;
        let (mut too_deep, mut too_high): (f64, f64) = (0.0, 0.0);
        for iy in 0..map.ny {
            for ix in 0..map.nx {
                let p = map.centre(ix, iy);
                let z = map.at(ix, iy) as f64;
                let inside = shapes.iter().any(|r| r.contains(p));
                let d = shapes
                    .iter()
                    .map(|r| r.distance_to_boundary(p))
                    .fold(f64::INFINITY, f64::min);
                let ideal = if inside { -(d / tan).min(2.3) } else { 0.0 };
                too_deep = too_deep.max(ideal - z);
                too_high = too_high.max(z - ideal);
            }
        }
        (too_deep, too_high)
    }

    #[test]
    fn vcarve_pocket_uses_the_end_mill_then_the_v_bit() {
        let built = build_pocket(&vcarve_project(true), "j").unwrap();
        assert_eq!(
            built.stats.tools,
            ["Ø3.175×22 1F Downcut", "60° V-groove Ø12 S6"]
        );
        assert!(built.gcode.contains("M6 T1\nS12000 M3\nG54\n"));
        assert!(built.gcode.contains("M5\nM6 T2\nS12000 M3\n"));
        assert_eq!(carvera::lint(&built.gcode), Vec::<String>::new());
        assert_eq!(built.warnings, Vec::<String>::new());
        assert!(built.narrow.is_empty());
    }

    #[test]
    fn simulated_vcarve_pocket_matches_the_ideal_surface() {
        let project = vcarve_project(true);
        let preview = preview_pocket(&project, "j").unwrap();
        assert_eq!(preview.problems, []);
        let (too_deep, too_high) = deviation_from_ideal(&project, &preview);
        // Nothing may be cut that should stay. What is left over is bounded by
        // the ridges between the V-bit's floor rings (0.2 mm apart with a
        // 0.1 mm tip: 0.087 mm) and the tip flat's reach into sharp corners.
        assert!(too_deep < 0.02, "cut {too_deep} mm too deep");
        assert!(too_high < 0.12, "left {too_high} mm too high");
    }

    #[test]
    fn vcarve_pocket_without_an_end_mill_is_cut_by_the_v_bit_alone() {
        let project = vcarve_project(false);
        let preview = preview_pocket(&project, "j").unwrap();
        assert_eq!(preview.problems, []);
        assert_eq!(preview.built.stats.tools, ["60° V-groove Ø12 S6"]);
        assert!(preview
            .built
            .warnings
            .iter()
            .any(|w| w.contains("No end mill is chosen")));
        let (too_deep, too_high) = deviation_from_ideal(&project, &preview);
        assert!(too_deep < 0.02, "cut {too_deep} mm too deep");
        assert!(too_high < 0.12, "left {too_high} mm too high");
    }

    #[test]
    fn a_coarse_v_bit_stepover_does_not_leave_a_ridged_floor() {
        // As imported from a tool library: 40% of the 12 mm body.
        let mut project = vcarve_project(true);
        project.tools[1].cutting[0].stepover = 4.8;
        let preview = preview_pocket(&project, "j").unwrap();
        let (too_deep, too_high) = deviation_from_ideal(&project, &preview);
        assert!(too_deep < 0.02, "cut {too_deep} mm too deep");
        assert!(
            too_high < MAX_FLOOR_RIDGE + 0.03,
            "left {too_high} mm too high"
        );
    }

    #[test]
    fn vcarve_reports_what_stops_or_limits_it() {
        let reasons = |p: &Project| build_pocket(p, "j").unwrap_err().join(" | ");

        let mut p = vcarve_project(true);
        p.tools[1].cutting.clear();
        assert!(reasons(&p).contains("no cutting settings for hardwood"));

        // 2.3 mm deep needs a bit 2.756 mm wide at the surface.
        let mut p = vcarve_project(true);
        p.tools[1].diameter = 2.0;
        assert!(
            reasons(&p).contains("would have to be 2.756 mm wide"),
            "{}",
            reasons(&p)
        );

        // A 2 mm strip lets the 60 degree bit down only 1.65 mm.
        let mut p = vcarve_project(true);
        p.design.as_mut().unwrap().regions[0].outer =
            vec![[5.0, 5.0], [35.0, 5.0], [35.0, 7.0], [5.0, 7.0]];
        p.jobs[0].region_ids = vec![0];
        let built = build_pocket(&p, "j").unwrap();
        assert!(
            built
                .warnings
                .iter()
                .any(|w| w.contains("too narrow for the plug to seat")),
            "{:?}",
            built.warnings
        );
        assert_eq!(built.stats.tools, ["60° V-groove Ø12 S6"]);
    }

    /// Compares the simulated plug with the shape it should be: narrower
    /// than the outline at the top, the outline at the engagement depth, wider
    /// at the floor. Returns the most cut too deep and left too high.
    fn plug_deviation(preview: &Preview) -> (f64, f64) {
        let shapes = &preview.built.pocket;
        let tan = 30f64.to_radians().tan();
        let map = &preview.map;
        let (mut too_deep, mut too_high): (f64, f64) = (0.0, 0.0);
        for iy in 0..map.ny {
            for ix in 0..map.nx {
                let p = map.centre(ix, iy);
                let z = map.at(ix, iy) as f64;
                let d = shapes
                    .iter()
                    .map(|r| r.distance_to_boundary(p))
                    .fold(f64::INFINITY, f64::min);
                let outside = if shapes.iter().any(|r| r.contains(p)) {
                    -d
                } else {
                    d
                };
                let ideal = -(2.0 + outside / tan).clamp(0.0, 3.5);
                too_deep = too_deep.max(ideal - z);
                too_high = too_high.max(z - ideal);
            }
        }
        (too_deep, too_high)
    }

    #[test]
    fn plug_is_mirrored_in_a_blank_sized_from_the_shapes() {
        let built = build(&vcarve_project(true), "j", Part::Plug).unwrap();
        assert_eq!(built.file_name, "Test-board-Flat-inlay-1-plug.cnc");
        assert_eq!(built.part, Part::Plug);
        // Shapes span X 5..55 and Y 5..35; 6 mm margin all round.
        assert_eq!(
            built.stock,
            Stock {
                width: 62.0,
                height: 42.0,
                thickness: 8.0,
                through: 0.0,
            }
        );
        // The rectangle is on the left of the design, so on the right of the plug.
        let rectangle = built
            .pocket
            .iter()
            .find(|r| (r.area() - 600.0).abs() < 1e-6)
            .unwrap();
        let xs: Vec<f64> = rectangle.outer.iter().map(|q| q[0]).collect();
        assert!(xs.iter().all(|x| *x > 25.9 && *x < 56.1), "{xs:?}");
        assert_eq!(carvera::lint(&built.gcode), Vec::<String>::new());
        assert_eq!(
            built.stats.tools,
            ["Ø3.175×22 1F Downcut", "60° V-groove Ø12 S6"]
        );
    }

    #[test]
    fn simulated_plug_matches_the_ideal_shape() {
        for clearing in [true, false] {
            let preview = preview(&vcarve_project(clearing), "j", Part::Plug).unwrap();
            assert_eq!(preview.problems, []);
            let (too_deep, too_high) = plug_deviation(&preview);
            assert!(too_deep < 0.02, "cut {too_deep} mm too deep");
            assert!(too_high < 0.12, "left {too_high} mm too high");
        }
    }

    #[test]
    fn plug_reports_what_stops_it() {
        let reasons = |p: &Project| build(p, "j", Part::Plug).unwrap_err().join(" | ");

        let mut p = vcarve_project(true);
        if let Inlay::Vcarve { plug_margin, .. } = &mut p.jobs[0].inlay {
            *plug_margin = 1.0;
        }
        assert!(
            reasons(&p).contains("plug margin of 1 mm is too small"),
            "{}",
            reasons(&p)
        );

        let mut p = vcarve_project(true);
        if let Inlay::Vcarve { plug_thickness, .. } = &mut p.jobs[0].inlay {
            *plug_thickness = 3.0;
        }
        assert!(reasons(&p).contains("its board is only 3 mm thick"));
    }

    #[test]
    fn fit_of_a_generated_inlay_is_as_designed_with_a_pointed_bit() {
        // A perfect point: pocket and plug match exactly.
        let mut project = vcarve_project(true);
        project.tools[1].tip_diameter = Some(0.0);
        let check = check_fit(&project, "j").unwrap();
        let r = &check.fit.report;
        assert!(r.proud.abs() < 0.03, "proud {}", r.proud);
        assert!(
            (r.glue_gap_mean.unwrap() - 0.3).abs() < 0.03,
            "{:?}",
            r.glue_gap_mean
        );
        assert!(r.wall_contact > 0.9, "wall contact {}", r.wall_contact);
        assert!(r.void_width < 0.15, "void width {}", r.void_width);
        // The face shows plug inside the rectangle and base outside it.
        let at = |x: f64, y: f64| {
            let map = &check.pocket.map;
            check.fit.face[(y / map.cell) as usize * map.nx + (x / map.cell) as usize]
        };
        assert_eq!(at(20.0, 15.0), analysis::Face::Plug as u8);
        assert_eq!(at(2.0, 2.0), analysis::Face::Base as u8);
        assert_eq!(
            at(51.0, 25.0),
            analysis::Face::Base as u8,
            "inside the L's notch"
        );
    }

    #[test]
    fn fit_shows_what_a_tip_flat_costs() {
        // With a 0.1 mm tip flat the pocket's corner ramps are shallower than
        // the plug's corner ridges by 0.05 / tan 30 = 0.087 mm. The strip is
        // only 0.1 mm wide, two cells of the simulation, so part of it is seen.
        let check = check_fit(&vcarve_project(true), "j").unwrap();
        let r = &check.fit.report;
        assert!(r.proud > 0.01 && r.proud < 0.13, "proud {}", r.proud);
        assert!(r.press_overlap > 0.01 && r.press_overlap < 0.13);
        assert!(
            r.press_overlap_area < 5.0,
            "overlap area {}",
            r.press_overlap_area
        );
    }

    #[test]
    fn fit_is_only_for_v_carve_inlays_and_cuts_must_fit_the_machine() {
        assert!(check_fit(&project(), "j").unwrap_err()[0].contains("flat inlay"));
        let mut p = project();
        p.design.as_mut().unwrap().scale = 8.0;
        p.jobs[0].region_ids = vec![0, 1];
        let reasons = build_pocket(&p, "j").unwrap_err().join(" | ");
        assert!(
            reasons.contains("more than the Carvera Air can travel"),
            "{reasons}"
        );
    }

    /// The 3.175 mm end mill's 6 mm big brother.
    fn big_end_mill() -> Tool {
        let mut big = end_mill();
        big.id = "t-big".into();
        big.name = "Big 6 mm".into();
        big.diameter = 6.0;
        big.shank_diameter = 6.0;
        big.cutting[0].stepover = 2.4;
        big
    }

    fn set_clearing(p: &mut Project, ids: &[&str]) {
        let ids: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
        match &mut p.jobs[0].inlay {
            Inlay::Flat {
                clearing_tool_ids, ..
            }
            | Inlay::Vcarve {
                clearing_tool_ids, ..
            } => *clearing_tool_ids = ids,
        }
    }

    /// Largest difference in height between two simulated boards, mm, and
    /// the share of cells that differ by more than `tolerance`.
    fn compare(a: &HeightMap, b: &HeightMap, tolerance: f32) -> (f32, f64) {
        assert_eq!((a.nx, a.ny), (b.nx, b.ny));
        let mut worst: f32 = 0.0;
        let mut differing = 0;
        for (x, y) in a.z.iter().zip(&b.z) {
            let d = (x - y).abs();
            worst = worst.max(d);
            if d > tolerance {
                differing += 1;
            }
        }
        (worst, differing as f64 / a.z.len() as f64)
    }

    #[test]
    fn two_end_mills_cut_the_same_flat_pocket_as_the_small_one_alone_in_less_time() {
        let mut p = project();
        p.tools.push(big_end_mill());
        let alone = preview(&p, "j", Part::Pocket).unwrap();

        set_clearing(&mut p, &["t-big", "t-endmill"]);
        let both = preview(&p, "j", Part::Pocket).unwrap();
        assert_eq!(both.problems, vec![]);
        assert_eq!(both.built.stats.tools, ["Big 6 mm", "Ø3.175×22 1F Downcut"]);
        assert!(both.built.gcode.contains("M6 T1\n") && both.built.gcode.contains("M6 T2\n"));
        assert!(both.built.warnings.iter().all(|w| !w.contains("not used")));

        // Same pocket: walls where the two tools meet may differ by a cell.
        let (_, differing) = compare(&alone.map, &both.map, 0.05);
        assert!(differing < 0.002, "{differing} of the cells differ");
        // Same fit and the same outline to cut to.
        assert_eq!(alone.built.cuttable, both.built.cuttable);
        assert_eq!(alone.built.flat_fit, both.built.flat_fit);

        // Clearly quicker, and the times per tool add up.
        assert!(
            both.built.stats.minutes < 0.8 * alone.built.stats.minutes,
            "{} against {}",
            both.built.stats.minutes,
            alone.built.stats.minutes
        );
        let per_tool = &both.built.stats.per_tool;
        assert_eq!(per_tool.len(), 2);
        assert_eq!((per_tool[0].number, per_tool[1].number), (1, 2));
        let sum: f64 = per_tool.iter().map(|t| t.minutes).sum();
        assert!((sum - both.built.stats.minutes).abs() < 1e-6);
        // The small tool does the lesser share.
        assert!(per_tool[1].cutting_length < alone.built.stats.cutting_length * 0.5);
    }

    #[test]
    fn a_tool_with_nothing_to_do_is_left_out_with_a_reason() {
        // Small before large: the large one finds nothing left.
        let mut p = project();
        p.tools.push(big_end_mill());
        set_clearing(&mut p, &["t-endmill", "t-big"]);
        let built = build_pocket(&p, "j").unwrap();
        assert_eq!(built.stats.tools, ["Ø3.175×22 1F Downcut"]);
        assert!(!built.gcode.contains("M6 T2"));
        assert!(
            built
                .warnings
                .iter()
                .any(|w| w.contains("\"Big 6 mm\" finds nothing left")
                    && w.contains("Put larger tools first")),
            "{:?}",
            built.warnings
        );

        // A tool wider than every shape: the L is 7 mm wide, the rectangle 20.
        let mut p = project();
        let mut huge = big_end_mill();
        huge.diameter = 25.0;
        p.tools.push(huge);
        set_clearing(&mut p, &["t-big", "t-endmill"]);
        let built = build_pocket(&p, "j").unwrap();
        assert_eq!(built.stats.tools, ["Ø3.175×22 1F Downcut"]);
        assert!(built
            .warnings
            .iter()
            .any(|w| w.contains("too wide to fit anywhere in the pocket")));
    }

    #[test]
    fn the_smallest_end_mill_sets_the_corners_and_cuts_the_insert() {
        let mut p = project();
        p.tools.push(big_end_mill());
        let alone = build(&p, "j", Part::Plug).unwrap();
        // Whatever the order.
        for ids in [["t-big", "t-endmill"], ["t-endmill", "t-big"]] {
            set_clearing(&mut p, &ids);
            let insert = build(&p, "j", Part::Plug).unwrap();
            assert_eq!(insert.stats.tools, ["Ø3.175×22 1F Downcut"]);
            assert_eq!(insert.gcode, alone.gcode);
        }
    }

    #[test]
    fn several_end_mills_clear_a_v_carved_floor_before_the_v_bit() {
        let mut p = vcarve_project(true);
        p.tools.push(big_end_mill());
        let one = preview(&p, "j", Part::Pocket).unwrap();
        set_clearing(&mut p, &["t-big", "t-endmill"]);
        for part in [Part::Pocket, Part::Plug] {
            let both = preview(&p, "j", part).unwrap();
            assert_eq!(both.problems, vec![], "{part:?}");
            assert_eq!(
                both.built.stats.tools,
                ["Big 6 mm", "Ø3.175×22 1F Downcut", "60° V-groove Ø12 S6"],
                "{part:?}"
            );
            assert_eq!(both.built.stats.per_tool[2].number, 3);
            if part == Part::Pocket {
                // The V-bit finishes everything, so the result is the same.
                let (worst, differing) = compare(&one.map, &both.map, 0.05);
                assert!(
                    differing < 0.002,
                    "{differing} of the cells differ, worst {worst}"
                );
            }
        }
        // The fit is still as designed.
        let check = check_fit(&p, "j").unwrap();
        assert!(
            check.fit.report.proud.abs() < 0.03,
            "{:?}",
            check.fit.report
        );
        assert!(check.fit.report.wall_contact > 0.95);
    }

    fn set_cut_out(p: &mut Project, on: bool, with_tabs: bool) {
        match &mut p.jobs[0].inlay {
            Inlay::Flat { cut_out, tabs, .. } | Inlay::Vcarve { cut_out, tabs, .. } => {
                *cut_out = on;
                *tabs = with_tabs;
            }
        }
    }

    /// The board grown by the 3.175 mm end mill's width plus the border,
    /// rounded up to a millimetre, on both sides.
    const GROWN: f64 = 2.0 * 9.0;

    #[test]
    fn a_v_carve_plug_can_be_cut_out_as_one_piece_and_still_fits() {
        let mut p = vcarve_project(true);
        let plain = preview(&p, "j", Part::Plug).unwrap();
        for tabs in [true, false] {
            set_cut_out(&mut p, true, tabs);
            let cut = preview(&p, "j", Part::Plug).unwrap();
            assert_eq!(cut.problems, vec![], "tabs: {tabs}");
            let (a, b) = (plain.built.stock, cut.built.stock);
            assert!((b.width - a.width - GROWN).abs() < 1e-9);
            assert!((b.height - a.height - GROWN).abs() < 1e-9);
            assert_eq!(b.through, THROUGH_CUT);
            // The end mill comes back after the V-bit, under its own number.
            assert_eq!(cut.built.stats.tools, plain.built.stats.tools);
            assert_eq!(cut.built.stats.tool_changes, 3);
            assert_eq!(cut.built.gcode.matches("M6 T1\n").count(), 2);
            assert!(cut
                .built
                .warnings
                .iter()
                .any(|w| w.contains("is cut out of its board last")));
            assert_eq!(
                cut.built
                    .warnings
                    .iter()
                    .any(|w| w.contains("tabs 4 mm wide")),
                tabs
            );

            // One cut right round the plug, through the board except at tabs.
            let [x0, y0, x1, y1] = cut.built.piece.unwrap();
            let map = &cut.map;
            let bottom = -(b.thickness + THROUGH_CUT) as f32;
            let track_y = y0 - 3.175 / 2.0;
            let through = (0..map.nx)
                .filter(|ix| {
                    let x = map.centre(*ix, 0)[0];
                    x > x0 && x < x1
                })
                .map(|ix| map.at(ix, (track_y / map.cell) as usize))
                .filter(|z| *z < bottom + 0.05)
                .count() as f64
                * map.cell;
            if tabs {
                assert!(
                    through < (x1 - x0) - 3.0 && through > (x1 - x0) * 0.5,
                    "{through}"
                );
            } else {
                assert!(through > (x1 - x0) - 0.5, "{through}");
            }
            // The board outside the cut is untouched.
            assert_eq!(map.at(2, 2), 0.0);
            let _ = y1;

            // The plug still seats: what is outside the cut is not part of it.
            let check = check_fit(&p, "j").unwrap();
            assert!(
                check.fit.report.proud.abs() < 0.03,
                "{:?}",
                check.fit.report
            );
            assert!(check.fit.report.wall_contact > 0.95);
        }

        // Without an end mill there is nothing to cut it out with.
        let mut p = vcarve_project(false);
        set_cut_out(&mut p, true, true);
        assert!(build(&p, "j", Part::Plug).unwrap_err()[0].contains("needs an end mill"));
    }

    fn backer_project() -> Project {
        let mut p = project();
        if let Inlay::Flat { insert_style, .. } = &mut p.jobs[0].inlay {
            *insert_style = InsertStyle::Backer;
        }
        p
    }

    #[test]
    fn a_flat_insert_can_be_one_mirrored_plug_on_a_backer() {
        let p = backer_project();
        let plug = preview(&p, "j", Part::Plug).unwrap();
        assert_eq!(plug.problems, vec![]);
        let stock = plug.built.stock;
        // Shapes span x 5..55 and y 5..35 less half the allowance, plus 8 mm all round.
        assert!(
            (stock.width - 65.9).abs() < 0.01 && (stock.height - 45.9).abs() < 0.01,
            "{stock:?}"
        );
        assert_eq!(stock.through, 0.0);
        assert_eq!(stock.thickness, 4.0);
        assert!(plug
            .built
            .warnings
            .iter()
            .any(|w| w.contains("glue it in face down")));

        // Pocket 2 mm deep plus the 1.5 mm saw gap.
        let floor = -3.5;
        let map = &plug.map;
        let at = |x: f64, y: f64| map.at((x / map.cell) as usize, (y / map.cell) as usize) as f64;
        // Mirrored: the 30 x 20 rectangle drawn on the left stands on the right.
        assert_eq!(at(65.9 - 8.0 - 15.0, 8.0 + 10.0), 0.0);
        // The L drawn on the right stands on the left; its notch is floor.
        assert_eq!(at(19.0, 33.0), 0.0);
        assert_eq!(at(11.0, 11.0), 0.0);
        // Its notch, between the shapes, round them, and the blank's very corners.
        for (x, y) in [
            (11.0, 33.0),
            (25.5, 20.0),
            (32.9, 4.0),
            (0.3, 0.3),
            (65.6, 45.6),
        ] {
            assert!(
                (at(x, y) - floor).abs() < 0.01,
                "({x}, {y}) is at {}",
                at(x, y)
            );
        }
        // Standing wood is the insert, exactly: the same area as the loose inserts.
        let standing = map.z.iter().filter(|z| **z > -0.01).count() as f64 * map.cell * map.cell;
        let loose = build(&project(), "j", Part::Plug).unwrap();
        let wanted: f64 = loose.pocket.iter().map(|r| r.area()).sum();
        assert!(
            (standing - wanted).abs() < 0.01 * wanted,
            "{standing} against {wanted}"
        );
        assert_eq!(
            plug.built.flat_fit.unwrap().gap_min,
            loose.flat_fit.unwrap().gap_min
        );
    }

    #[test]
    fn a_backer_plug_can_be_cut_out_with_and_without_tabs() {
        let mut p = backer_project();
        let plain = build(&p, "j", Part::Plug).unwrap();
        for tabs in [true, false] {
            set_cut_out(&mut p, true, tabs);
            let cut = preview(&p, "j", Part::Plug).unwrap();
            assert_eq!(cut.problems, vec![], "tabs: {tabs}");
            assert!((cut.built.stock.width - plain.stock.width - GROWN).abs() < 1e-9);
            assert_eq!(cut.built.stock.through, THROUGH_CUT);
            assert_eq!(cut.built.stats.tool_changes, 2);
            assert_eq!(
                cut.built
                    .warnings
                    .iter()
                    .any(|w| w.contains("tabs 4 mm wide")),
                tabs
            );
            assert!(cut
                .built
                .warnings
                .iter()
                .all(|w| !w.contains("beyond the edges")));
            // One piece: the inserts inside it still stand at full height.
            let [x0, y0, ..] = cut.built.piece.unwrap();
            let map = &cut.map;
            let at = |x: f64, y: f64| map.at((x / map.cell) as usize, (y / map.cell) as usize);
            assert_eq!(at(x0 + 19.0, y0 + 33.0), 0.0);
            assert!(at(x0 + 11.0, y0 + 33.0) < -3.4);
        }
    }

    #[test]
    fn a_backer_plug_says_when_wood_would_be_left_between_shapes() {
        // Rectangle and L are 5 mm apart: no room for a 6 mm tool.
        let mut p = backer_project();
        p.tools[0].diameter = 6.0;
        if let Inlay::Flat { insert_margin, .. } = &mut p.jobs[0].inlay {
            *insert_margin = 10.0;
        }
        let reasons = build(&p, "j", Part::Plug).unwrap_err().join(" | ");
        assert!(reasons.contains("wood between their inserts"), "{reasons}");

        // A board too thin to leave a backer.
        let mut p = backer_project();
        if let Inlay::Flat {
            insert_thickness, ..
        } = &mut p.jobs[0].inlay
        {
            *insert_thickness = 3.0;
        }
        let reasons = build(&p, "j", Part::Plug).unwrap_err().join(" | ");
        assert!(reasons.contains("leaves no backer"), "{reasons}");
    }

    #[test]
    fn file_names_are_safe_for_the_machine() {
        assert_eq!(file_stem("Żółw / coaster #2 (final)"), "w-coaster-2-final");
        assert_eq!(file_stem("???"), "inlay");
    }
}
