//! Turns an inlay step into a G-code file, and simulates that file.
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
use crate::ops::clear::{centres, clear_centres, finish_walls, raster_centres, ClearParams};
use crate::ops::profile::{follow, profile, ProfileError, ProfileParams, Tabs};
use crate::ops::vcarve::{narrow_parts, plug_relief, vcarve, vcarve_plug, VcarveParams};
use crate::post::carvera;
use crate::project::{
    InsertStyle, Machine, PassDirection, Pattern, Project, Setup, Side, Step, Task, VcarveTuning,
};
use crate::sim::{self, HeightMap};
use crate::toolpath::{fit_arcs, Move, PathBuilder, Program, ProgramTool, ARC_FIT_TOLERANCE};
use crate::tools::{CuttingSettings, Material, Profile, Tool, ToolKind};

/// The two halves of an task: each is cut from its own board, with its own file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Part {
    /// The recess in the base board.
    Pocket,
    /// The piece that fills it: carved face down in its own blank, mirrored.
    Plug,
}

/// What a part of this kind of inlay is called.
fn part_name(part: Part, task: &Task) -> &'static str {
    match (part, task) {
        (Part::Pocket, _) => "pocket",
        (Part::Plug, Task::Vcarve { .. }) => "plug",
        (
            Part::Plug,
            Task::Flat {
                insert_style: InsertStyle::Backer,
                ..
            },
        ) => "plug",
        (Part::Plug, Task::Flat { .. }) => "insert",
        (_, Task::Pocket { .. }) => "pocket",
        (_, Task::Facing { .. }) => "facing",
        (_, Task::Contour { .. }) => "contour",
        (_, Task::Chamfer { .. }) => "chamfer",
        (_, Task::Glue { .. }) => "glue-up",
        (_, Task::Saw { .. }) => "sawing",
    }
}

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
    /// The parts follow the drawing: what is left out and added is too
    /// little to say.
    pub as_drawn: bool,
    /// The insert overlaps the base board by more than the rounding of
    /// curves: it will not go in.
    pub interferes: bool,
}

/// A flat inlay follows its drawing while the area the tool leaves out and
/// adds is no more than this share of the drawing's.
const AS_DRAWN_SHARE: f64 = 0.002;

/// Overlap of a flat insert and the base board under this, mm², is the
/// rounding of curves.
const INTERFERENCE_AREA: f64 = 0.01;

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
    /// Things worth knowing that do not stop the step.
    pub warnings: Vec<String>,
    /// For a plug: where its blank lies on the base board once turned over.
    #[serde(skip)]
    pub frame: Option<PlugFrame>,
    /// For loose inserts: where their board's origin lies on the base board.
    /// They go in the way up they were cut.
    #[serde(skip)]
    pub origin: Option<Point>,
    /// For a plug cut out of a larger board: the plug itself on that board,
    /// as `[x0, y0, x1, y1]`.
    pub piece: Option<[f64; 4]>,
    /// Width of the cut that frees that plug: the diameter of the tool.
    pub cut_width: Option<f64>,
    /// The extent of the shapes on the part's board, as `[x0, y0, x1, y1]`:
    /// what is left around it is margin.
    pub shapes: Option<[f64; 4]>,
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
    /// What the tool changes add, minutes, by the machine's time for one. 0
    /// when the machine gives none.
    pub tool_change_minutes: f64,
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

/// Builds the pocket file for a step.
pub fn build_pocket(project: &Project, step_id: &str) -> Result<Built, Vec<String>> {
    build(project, step_id, Part::Pocket)
}

/// Builds the file for one part of a step. On failure returns every reason
/// found, in plain words.
pub fn build(project: &Project, step_id: &str, part: Part) -> Result<Built, Vec<String>> {
    build_with(project, step_id, part, None)
}

/// As [`build`], for a facing that takes the wood above the surface from
/// the list: with `standing`, that height is the one given, as measured on
/// the stock, in place of the one the inlays' numbers come to.
pub fn build_with(
    project: &Project,
    step_id: &str,
    part: Part,
    standing: Option<f64>,
) -> Result<Built, Vec<String>> {
    let machine = &project.machine;
    let step = project
        .steps
        .iter()
        .find(|j| j.id == step_id)
        .ok_or_else(|| vec!["This inlay no longer exists.".to_string()])?;
    if step.task.is_by_hand() {
        return Err(vec![format!(
            "\"{}\" is done by hand: it has no file.",
            step.name
        )]);
    }
    let through_cut = Setup::of(project, step).through_cut;
    let design = project
        .design
        .as_ref()
        .ok_or_else(|| vec!["The project has no design.".to_string()])?;

    let plain = !step.task.is_inlay();
    if plain && part == Part::Plug {
        return Err(vec![
            "Only an inlay has a second part. This operation has one file.".to_string(),
        ]);
    }

    // How deep the part is cut, and how thick its board is.
    let (depth, thickness) = match (part, &step.task) {
        (_, Task::Pocket { depth, .. }) => (*depth, project.base.thickness),
        (_, Task::Facing { depth, .. }) => (*depth, project.base.thickness),
        (_, Task::Contour { depth, .. }) => (
            depth.unwrap_or(project.base.thickness + through_cut),
            project.base.thickness,
        ),
        // Worked out from the V-bit once it is known.
        (_, Task::Chamfer { .. } | Task::Glue { .. } | Task::Saw { .. }) => {
            (0.0, project.base.thickness)
        }
        (Part::Pocket, Task::Flat { pocket_depth, .. }) => (*pocket_depth, project.base.thickness),
        (
            Part::Pocket,
            Task::Vcarve {
                engagement_depth,
                glue_gap,
                ..
            },
        ) => (engagement_depth + glue_gap, project.base.thickness),
        (
            Part::Plug,
            Task::Vcarve {
                engagement_depth,
                saw_gap,
                plug_thickness,
                ..
            },
        ) => (engagement_depth + saw_gap, *plug_thickness),
        (
            Part::Plug,
            Task::Flat {
                insert_style: InsertStyle::Backer,
                pocket_depth,
                saw_gap,
                insert_thickness,
                ..
            },
        ) => (pocket_depth + saw_gap, *insert_thickness),
        (
            Part::Plug,
            Task::Flat {
                insert_thickness, ..
            },
        ) => (insert_thickness + through_cut, *insert_thickness),
    };
    // A loose insert is cut right through its board on purpose.
    let loose = matches!(
        (part, &step.task),
        (
            Part::Plug,
            Task::Flat {
                insert_style: InsertStyle::Loose,
                ..
            }
        )
    );
    let name = part_name(part, &step.task);
    // A contour without a depth goes right through the stock on purpose.
    let through_stock = matches!(&step.task, Task::Contour { depth: None, .. });

    let mut errors: Vec<String> = Vec::new();
    let warnings: Vec<String> = Vec::new();

    let regions = union(&design.placed_regions(&step.region_ids));
    if regions.is_empty() && !matches!(&step.task, Task::Facing { .. }) {
        errors.push(if plain {
            "The operation has no shapes. Click shapes in the drawing to add them.".into()
        } else {
            "The inlay has no shapes. Click shapes in the drawing to add them.".into()
        });
    }
    if depth >= thickness && !loose && !through_stock {
        errors.push(match part {
            _ if plain => format!(
                "The cut is {} mm deep but the stock is only {} mm thick.{}",
                num(depth),
                num(thickness),
                if matches!(&step.task, Task::Contour { .. }) {
                    " To cut right through, choose \"through the stock\"."
                } else {
                    ""
                }
            ),
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
        step,
        machine,
        depth,
        pattern: match &step.task {
            Task::Pocket { pattern, .. } | Task::Facing { pattern, .. } => *pattern,
            _ => Pattern::Offset,
        },
        direction: match &step.task {
            Task::Pocket { direction, .. } | Task::Facing { direction, .. } => *direction,
            _ => PassDirection::Longer,
        },
        errors,
        warnings,
    };
    if !step.material.is_built_in() {
        ctx.warnings.push(format!(
            "This is cut in {}. The app's toolpaths have only been proven in wood: check the simulation, and cut a test piece first.",
            material_name(&step.material)
        ));
    }
    let cut = match (part, &step.task) {
        // Turned away above.
        (_, Task::Glue { .. } | Task::Saw { .. }) => None,
        (
            _,
            Task::Pocket {
                clearing_tool_ids, ..
            },
        ) => plain_pocket(&mut ctx, &regions, clearing_tool_ids),
        (
            _,
            Task::Facing {
                above_auto,
                tool_id,
                ..
            },
        ) => {
            let above = standing
                .filter(|_| *above_auto)
                .or_else(|| facing_start(project, step_id).map(|(_, above)| above))
                .unwrap_or(0.0);
            if *above_auto && above + depth <= 0.0 {
                ctx.errors.push(
                    "There is nothing to face: when the list gets to this facing, nothing glued in stands above the surface where it cuts. Put it below the glue-up, or give the wood above the surface by hand."
                        .into(),
                );
                None
            } else {
                facing(
                    &mut ctx,
                    &regions,
                    design.placed_size(),
                    above,
                    facing_margin(project, step),
                    tool_id.as_deref(),
                )
            }
        }
        (
            _,
            Task::Contour {
                side,
                tabs,
                tool_id,
                ..
            },
        ) => contour(
            &mut ctx,
            &regions,
            *side,
            through_stock,
            *tabs,
            tool_id.as_deref(),
        ),
        (
            _,
            Task::Chamfer {
                side,
                width,
                tip_clearance,
                tool_id,
            },
        ) => chamfer(
            &mut ctx,
            &regions,
            *side,
            *width,
            *tip_clearance,
            tool_id.as_deref(),
        ),
        (
            Part::Pocket,
            Task::Flat {
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
            Task::Flat {
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
            Task::Vcarve {
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
            Task::Vcarve {
                engagement_depth,
                saw_gap,
                glue_gap,
                relief,
                tuning,
                plug_margin,
                plug_thickness,
                clearing_tool_ids,
                vbit_tool_id,
                cut_out,
                tabs,
            },
        ) => {
            let cut = vcarve_plug_cut(
                &mut ctx,
                &regions,
                PlugShape {
                    engagement: *engagement_depth,
                    glue_gap: *glue_gap,
                    relief: *relief,
                    relief_keep: tuning.relief_keep,
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
        Task::Vcarve {
            engagement_depth,
            vbit_tool_id,
            ..
        },
        Some(_),
    ) = (&step.task, &cut)
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
    let origin = cut.origin;
    let flat_fit = cut.flat_fit;
    let cuttable = cut.cuttable;
    let through = cut.through;
    let piece = cut.piece;
    let cut_width = cut.cut_width;
    let shapes = extent(&pocket);

    let (width, height) = cut.board.unwrap_or_else(|| design.placed_size());
    if part == Part::Pocket
        && regions
            .iter()
            .flat_map(|r| r.outer.iter())
            .any(|p| p[0] < 0.0 || p[1] < 0.0 || p[0] > width || p[1] > height)
    {
        warnings.push(
            "Some of the shapes lie outside the stock. Move them, or make the stock larger.".into(),
        );
    }

    // An operation is named by the user; an inlay's two files also say which part they are.
    let title = if plain {
        format!("{} - {}", project.name, step.name)
    } else {
        format!("{} - {} - {}", project.name, step.name, name)
    };
    let program = Program {
        name: title.clone(),
        tools: cut.tools,
        safe_z: Setup::of(project, step).safe_height,
        moves: cut.moves,
    };
    let (gcode, interpreted, stats) = finish(&program, machine, name)?;

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
        origin,
        piece,
        cut_width,
        shapes,
        file_name: format!(
            "{}.{}",
            file_stem(&title.replace(" - ", " ")),
            carvera::FILE_EXTENSION
        ),
        stats,
        gcode,
        warnings,
        program,
        interpreted,
        pocket,
    })
}

/// Writes a program as G-code, checks the text and reads it back. `name` is
/// what the file cuts, for messages.
fn finish(
    program: &Program,
    machine: &Machine,
    name: &str,
) -> Result<(String, Interpreted, Stats), Vec<String>> {
    // Curves are worked out as short straight cuts; they are written as arcs.
    let gcode = carvera::write(&Program {
        moves: fit_arcs(&program.moves, ARC_FIT_TOLERANCE),
        ..program.clone()
    });

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
    for (axis, along) in [(0, "X"), (1, "Y")] {
        let (low, high) = interpreted
            .segments
            .iter()
            .flat_map(|s| [s.from[axis], s.to[axis]])
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(low, high), v| {
                (low.min(v), high.max(v))
            });
        if high - low > machine.travel[axis] {
            return Err(vec![format!(
                "The {} spans {} mm in {along}, more than the {} can travel ({} mm).",
                name,
                num((high - low).ceil()),
                machine.name,
                num(machine.travel[axis])
            )]);
        }
    }

    let stats = Stats {
        lines: interpreted.lines,
        cutting_length: interpreted.cutting_length(),
        minutes: interpreted.minutes(machine.rapid_rate),
        tool_change_minutes: interpreted.tool_changes.len() as f64 * machine.tool_change_seconds
            / 60.0,
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
    };
    Ok((gcode, interpreted, stats))
}

/// What is known while a step is turned into moves, and what has been found
/// wrong with it so far.
struct Context<'a> {
    project: &'a Project,
    step: &'a Step,
    machine: &'a Machine,
    /// Depth of the pocket floor, mm.
    depth: f64,
    /// The shape of the path an end mill clears an area along.
    pattern: Pattern,
    /// Which way its side-to-side passes run.
    direction: PassDirection,
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
    /// For loose inserts: where their board's origin lies on the base board.
    origin: Option<Point>,
    flat_fit: Option<FlatFit>,
    cuttable: Vec<Vec<Point>>,
    /// How far below the board's bottom the moves cut on purpose.
    through: f64,
    /// The plug on its board, when it is cut out of a larger one.
    piece: Option<[f64; 4]>,
    /// Width of the cut that frees that plug.
    cut_width: Option<f64>,
    /// How far beyond the plug's edge the end mills cleared, when the plug
    /// is cut out of a larger board.
    overrun: f64,
}

/// How far beyond the edge of a plug an end mill this wide may clear when the
/// plug is cut out of a larger board. The wood there is waste, and the cut
/// that frees the plug goes through it anyway.
///
/// Half the tool is always enough to take the blank's corners. More is needed
/// where the strip between the shapes and the edge is narrower than the tool:
/// then the tool hangs over the edge by what it lacks, so that it clears the
/// strip instead of leaving it to a smaller tool or the V-bit, and no sliver
/// of wood is left standing along the edge.
fn edge_overrun(diameter: f64, strip: f64) -> f64 {
    (diameter - strip + 0.25).clamp(diameter / 2.0, diameter)
}

/// The smallest upright rectangle around some regions, as `[x0, y0, x1, y1]`.
fn extent(regions: &[Region]) -> Option<[f64; 4]> {
    let mut points = regions.iter().flat_map(|r| r.outer.iter());
    let first = points.next()?;
    Some(
        points.fold([first[0], first[1], first[0], first[1]], |b, p| {
            [
                b[0].min(p[0]),
                b[1].min(p[1]),
                b[2].max(p[0]),
                b[3].max(p[1]),
            ]
        }),
    )
}

impl<'a> Context<'a> {
    /// The inlay's clearances and tabs.
    fn setup(&self) -> Setup {
        Setup::of(self.project, self.step)
    }

    /// An empty path that travels and plunges at the inlay's heights.
    fn path(&self) -> PathBuilder {
        let setup = self.setup();
        PathBuilder::new(setup.safe_height).with_clearance(setup.plunge_clearance)
    }

    /// Looks up a tool for the step and checks it can do the work: right kind,
    /// cutting settings for the wood, speed within the machine's range and
    /// cutting edges long enough for the depth.
    fn tool(
        &mut self,
        id: Option<&str>,
        kind: ToolKind,
        what: &str,
    ) -> Option<(&'a Tool, &'a CuttingSettings)> {
        let tool = checked_tool(self.project, id, kind, what, &mut self.errors)?;
        let profile = self.step.row_profiles.get(&tool.id).map(String::as_str);
        let label = profile.map(|key| {
            let known = self.project.profiles.iter().find(|p| p.key == key);
            known.map_or(key, |p| p.label.as_str())
        });
        if let (Some(key), Some(label)) = (profile, label) {
            let known = self.project.profiles.iter().find(|p| p.key == key);
            // The app has no adaptive toolpath: its pockets start with a
            // full-width cut, which is what such a row must never be run as.
            if known.map_or(key == "adaptive", Profile::is_adaptive) {
                self.errors.push(format!(
                    "\"{}\" is set to its {label} row, which is for adaptive clearing. This app has no such toolpath and would bury the tool at full width. Choose another row.",
                    tool.name
                ));
                return None;
            }
        }
        let Some(cutting) = tool.cutting_row(&self.step.material, profile) else {
            self.errors.push(match label {
                None => format!(
                    "\"{}\" has no cutting settings for {}. Add them in the tool list.",
                    tool.name,
                    material_name(&self.step.material)
                ),
                Some(label) => format!(
                    "\"{}\" has no {label} row for {}. Choose another row, or add it in the tool list.",
                    tool.name,
                    material_name(&self.step.material)
                ),
            });
            return None;
        };
        if let Some(label) = label {
            let note = format!(
                "\"{}\" runs its {label} row: {} rpm, feed {} mm/min, {} mm per pass.",
                tool.name,
                cutting.rpm,
                num(cutting.feed),
                num(cutting.stepdown)
            );
            if !self.warnings.contains(&note) {
                self.warnings.push(note);
            }
        }
        if cutting.rpm > self.machine.max_rpm {
            self.errors.push(format!(
                "\"{}\" is set to {} rpm, but the {} spindle tops out at {} rpm.",
                tool.name, cutting.rpm, self.machine.name, self.machine.max_rpm
            ));
        }
        match tool.flute_length {
            Some(flutes) if self.depth > flutes => self.errors.push(format!(
                "The {} {} mm deep, but the cutting edges of \"{}\" are only {} mm long.",
                if self.step.task.is_inlay() {
                    "pocket is"
                } else {
                    "cut goes"
                },
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
        Some((tool, cutting))
    }
}

/// A clearing tool that removes less than this share of the floor is hardly
/// worth its tool change when a V-bit finishes the floor anyway.
const SMALL_SHARE: f64 = 0.01;

impl<'a> Context<'a> {
    /// Looks up and checks every clearing end mill of the step, in the order
    /// given. `None` when any of them cannot be used.
    fn end_mills(&mut self, ids: &[String]) -> Option<Vec<(&'a Tool, &'a CuttingSettings)>> {
        let found: Vec<_> = ids
            .iter()
            .map(|id| self.tool(Some(id), ToolKind::FlatEnd, "an end mill"))
            .collect();
        found.into_iter().collect()
    }

    /// Clears `area` to the step's depth with the end mills in the order
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
        let setup = self.setup();
        let ramp = setup.ramp_slope();
        // The smallest end mill reaches every wall the others do, so it is
        // the one that finishes them. A V-bit that follows cuts the walls itself.
        let finisher = end_mills
            .iter()
            .min_by(|a, b| a.0.diameter.total_cmp(&b.0.diameter))
            .filter(|_| !vbit_follows && setup.finish_allowance > 0.0);
        let wanted = area;
        let tracks = finisher.map_or(Vec::new(), |(tool, _)| offset(wanted, -tool.diameter / 2.0));
        let kept;
        let area = match finisher {
            Some((tool, _)) if !tracks.is_empty() => {
                let (radius, allowance) = (tool.diameter / 2.0, setup.finish_allowance);
                // Everything is cleared short of the walls by the allowance.
                // Where the tool only just fits, that would leave it out
                // altogether: those parts are cleared as they are. The margin
                // keeps the corners, which the tool rounds, from counting.
                let margin = allowance / 2.0 + 0.02;
                let reached = offset(
                    &offset(wanted, -(radius + allowance)),
                    radius + allowance + margin,
                );
                let tight: Vec<Region> = wanted
                    .iter()
                    .flat_map(|r| difference(r, &reached))
                    .collect();
                let mut rough = offset(wanted, -allowance);
                rough.extend(tight);
                kept = union(&rough);
                &kept[..]
            }
            _ => wanted,
        };
        let whole = total_area(area);
        let mut cleared: Vec<Region> = Vec::new();
        let mut tools: Vec<ProgramTool> = Vec::new();
        // The id of the tool in the spindle.
        let mut loaded: Option<&str> = None;
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
            loaded = Some(&tool.id);
            let params = clear_params(tool, cutting, self.depth, ramp);
            let swept = match self.pattern {
                Pattern::Offset => clear_centres(path, &where_to, &params),
                Pattern::Raster => raster_centres(path, &where_to, &params, true, self.direction),
            };
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
        if let (Some((tool, cutting)), false) = (finisher, tracks.is_empty()) {
            // It keeps its number if it has been in the spindle before.
            if loaded != Some(tool.id.as_str()) {
                let known = tools
                    .iter()
                    .find(|t| t.tool.id == tool.id)
                    .map(|t| t.number);
                let its = known.unwrap_or(*number);
                if known.is_none() {
                    tools.push(ProgramTool {
                        number: its,
                        tool: (*tool).clone(),
                    });
                    *number += 1;
                }
                path.start_tool(its, cutting.rpm);
            }
            finish_walls(
                path,
                &tracks,
                &clear_params(tool, cutting, self.depth, ramp),
            );
            cleared.extend(offset(&tracks, tool.diameter / 2.0));
            cleared = union(&cleared);
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

fn clear_params(tool: &Tool, cutting: &CuttingSettings, depth: f64, ramp: f64) -> ClearParams {
    ClearParams {
        ramp,
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
    let as_drawn = removed_area + added_area <= AS_DRAWN_SHARE * wanted;
    let interferes = interference_area > INTERFERENCE_AREA;
    if !as_drawn {
        ctx.warnings.push(format!(
            "The parts cannot follow the drawing exactly: \"{}\" rounds every corner to its {} mm radius and cannot enter anything narrower than {} mm. {} mm² of the drawing is left out and {} mm² is added. The outline that will be cut is dashed on the drawing.",
            tool.name,
            num(tool.diameter / 2.0),
            num(tool.diameter),
            num((removed_area * 10.0).round() / 10.0),
            num((added_area * 10.0).round() / 10.0)
        ));
    }
    if interferes {
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
        as_drawn,
        interferes,
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

    let mut number = ctx.project.machine.first_tool;
    let mut path = ctx.path();
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

/// The insert of a flat task: the shapes, less the allowance, cut right out
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

    let setup = ctx.setup();
    let number = ctx.project.machine.first_tool;
    let mut path = ctx.path();
    path.start_tool(number, cutting.rpm);
    let params = ProfileParams {
        tool_diameter: tool.diameter,
        depth: ctx.depth,
        stepdown: cutting.stepdown,
        feed: cutting.feed,
        plunge: cutting.plunge,
        tabs: insert.tabs.then_some(Tabs {
            // The thickness asked for, or half the board if that is less.
            height: setup.through_cut + setup.tab_thickness_on(insert.thickness),
            width: setup.tab_width,
            spacing: setup.tab_spacing,
        }),
        ramp: setup.ramp_slope(),
        finish: setup.finish_allowance,
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
                num(setup.tab_width),
                num(setup.tab_thickness_on(insert.thickness)),
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
        num(setup.through_cut)
    ));
    Some(Cut {
        tools: vec![ProgramTool {
            number,
            tool: tool.clone(),
        }],
        moves: path.finish(),
        pocket: parts,
        board: Some((width, height)),
        origin: Some([x0 - insert.margin, y0 - insert.margin]),
        flat_fit: Some(fit),
        cuttable: outlines(&shapes.cuttable),
        through: setup.through_cut,
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
    // corner of the blank is left standing as high as the inserts. Further
    // still on a plug that is cut out of a larger board, where needed.
    let overrun = if cut_out {
        edge_overrun(largest, insert.margin)
    } else {
        largest / 2.0
    };
    let reach = offset(std::slice::from_ref(&blank), overrun);
    let floor: Vec<Region> = reach
        .iter()
        .flat_map(|r| difference(r, &standing))
        .collect();

    let mut number = ctx.project.machine.first_tool;
    let mut path = ctx.path();
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
        frame: Some(PlugFrame {
            mirror_x: x1 + insert.margin,
            offset_y: y0 - insert.margin,
        }),
        flat_fit: Some(fit),
        cuttable: outlines(&shapes.cuttable),
        overrun: if cut_out { overrun } else { 0.0 },
        ..Cut::default()
    })
}

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
    let setup = ctx.setup();
    let depth = thickness + setup.through_cut;
    let tool: &Tool = if let Some(id) = ctx.step.cut_out_tool_id.as_deref() {
        // The tool chosen for the cut-out, whatever else it does.
        let tool = checked_tool(
            ctx.project,
            Some(id),
            ToolKind::FlatEnd,
            "an end mill to cut the plug out",
            &mut ctx.errors,
        )?;
        if let Some(flutes) = tool.flute_length.filter(|flutes| *flutes < depth) {
            ctx.errors.push(format!(
                "The cutting edges of \"{}\" are {} mm long, too short to cut the plug out of a {} mm board: {} mm are needed.",
                tool.name,
                num(flutes),
                num(thickness),
                num(depth)
            ));
            return None;
        }
        tool
    } else {
        // The largest of the inlay's end mills that reaches through the board.
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
                "Cutting the plug out of its board needs an end mill. Choose one for the cut-out."
                    .into(),
            );
            return None;
        }
        let Some(tool) = candidates
            .iter()
            .find(|t| t.flute_length.is_none_or(|flutes| flutes >= depth))
        else {
            ctx.errors.push(format!(
                "None of the chosen end mills has cutting edges long enough to cut the plug out of a {} mm board: {} mm are needed. Choose a longer one for the cut-out.",
                num(thickness),
                num(depth)
            ));
            return None;
        };
        tool
    };
    let Some(cutting) = tool.cutting_for(&ctx.step.material) else {
        ctx.errors.push(format!(
            "\"{}\" has no cutting settings for {}. Add them in the tool list.",
            tool.name,
            material_name(&ctx.step.material)
        ));
        return None;
    };
    if cutting.rpm > ctx.machine.max_rpm {
        ctx.errors.push(format!(
            "\"{}\" is set to {} rpm, but the {} spindle tops out at {} rpm.",
            tool.name, cutting.rpm, ctx.machine.name, ctx.machine.max_rpm
        ));
        return None;
    }
    if tool.flute_length.is_none() {
        let note = format!(
            "The flute length of \"{}\" is unknown, so the depth could not be checked against it.",
            tool.name
        );
        if !ctx.warnings.contains(&note) {
            ctx.warnings.push(note);
        }
    }

    // A whole number of millimetres, so the plug keeps its place on the
    // simulation's grid and its fit reads the same cut out or not.
    // The border starts beyond the widest thing cut outside the plug.
    let border = (tool.diameter.max(cut.overrun) + setup.cut_out_border).ceil();
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
            Move::ToolChange { .. }
            | Move::SpindleOn { .. }
            | Move::SpindleOff
            | Move::Comment { .. } => {}
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
                .map_or(ctx.project.machine.first_tool, |n| n + 1);
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
    let tab_height = setup.tab_thickness_on(thickness);
    let mut path = ctx.path();
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
                height: setup.through_cut + tab_height,
                width: setup.tab_width,
                spacing: setup.tab_spacing,
            }),
            ramp: setup.ramp_slope(),
            finish: 0.0,
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
            "{} tabs {} mm wide and {} mm thick hold the plug to its board. Cut them and trim the edge before use.",
            report.tabs.iter().sum::<usize>(),
            num(setup.tab_width),
            num(tab_height)
        )
    } else {
        "Without tabs the plug comes loose on the last pass. Hold it down with tape or it can be thrown by the tool.".into()
    });
    ctx.warnings.push(format!(
        "The cut goes {} mm past the bottom of the board: put a spoilboard under it.",
        num(setup.through_cut)
    ));
    cut.board = Some((board_width, board_height));
    cut.through = setup.through_cut;
    cut.piece = Some([border, border, border + width, border + height]);
    cut.cut_width = Some(tool.diameter);
    Some(cut)
}

/// Half angle in radians and tip flat radius in mm of a V-bit.
/// A V-carve inlay's finer points, or the usual ones for anything else.
fn vcarve_tuning(task: &Task) -> VcarveTuning {
    match task {
        Task::Vcarve { tuning, .. } => *tuning,
        _ => VcarveTuning::default(),
    }
}

fn vbit_shape(vbit: &Tool) -> (f64, f64) {
    (
        (vbit.tip_angle.unwrap_or(90.0) / 2.0).to_radians(),
        vbit.tip_diameter.unwrap_or(0.0) / 2.0,
    )
}

/// The tools of a V-carve step, checked, and how the V-bit is to be run.
struct VcarveSetup<'a> {
    vbit: &'a Tool,
    vbit_rpm: u32,
    end_mills: Vec<(&'a Tool, &'a CuttingSettings)>,
    params: VcarveParams,
}

/// Looks up and checks the tools of a V-carve step. `flat_depth` is how far the
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
    // this leave ridges higher than the inlay allows whatever the tool's own
    // stepover says (tool libraries often give a share of the body diameter).
    let (half_angle, tip_radius) = vbit_shape(vbit);
    let floor_ridge = vcarve_tuning(&ctx.step.task).floor_ridge;
    let floor_stepover = 2.0 * tip_radius + 2.0 * floor_ridge * half_angle.tan();
    if vcutting.stepover > floor_stepover + 0.005 {
        ctx.warnings.push(format!(
            "On the flat floor \"{}\" takes passes {} mm apart, not the {} mm of its cutting settings: only its tip cuts there, and the ridges between passes are kept to {} mm. The ridge height is under \"Finer points\".",
            vbit.name,
            num((floor_stepover * 100.0).round() / 100.0),
            num(vcutting.stepover),
            num(floor_ridge)
        ));
    }
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
    let mut number = ctx.project.machine.first_tool;
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
    let mut path = ctx.path();
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
    /// Space the pocket leaves under the plug.
    glue_gap: f64,
    /// Cut the tips of narrow ridges back by the glue gap.
    relief: bool,
    /// How far below the finished face a relief cut stays.
    relief_keep: f64,
    saw_gap: f64,
    margin: f64,
    /// The plug will be cut out of a larger board afterwards.
    cut_out: bool,
}

/// The plug of a V-carve task: the shapes mirrored, left standing in a blank
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

    // On a plug cut out of a larger board, the end mills clear out over its
    // edge: see `edge_overrun`.
    let largest = setup
        .end_mills
        .iter()
        .map(|(tool, _)| tool.diameter)
        .fold(0.0, f64::max);
    let overrun = if plug.cut_out && largest > 0.0 {
        edge_overrun(largest, plug.margin - plug.saw_gap * p.tan())
    } else {
        0.0
    };
    let ground = if overrun > 0.0 {
        offset(std::slice::from_ref(&blank), overrun)
    } else {
        vec![blank.clone()]
    };
    let standing = offset(&shapes, plug.saw_gap * p.tan());
    let floor: Vec<Region> = ground
        .iter()
        .flat_map(|r| difference(r, &standing))
        .collect();
    let mut path = ctx.path();
    let (cleared, tools) = clear_floor_then_load_vbit(ctx, &setup, &mut path, &floor, "plug's");
    if let Err(e) = vcarve_plug(&mut path, &shapes, &blank, &cleared, plug.engagement, p) {
        carving_failed(ctx, e);
        return None;
    }
    if plug.relief {
        match plug_relief(
            &mut path,
            &shapes,
            plug.engagement,
            plug.glue_gap,
            plug.relief_keep,
            p,
        ) {
            Ok(length) if length >= 0.5 => ctx.warnings.push(format!(
                "The tips of the plug's narrow ridges and corner edges are cut back along {} mm, by up to {} mm, so that they leave room for glue and cannot hold the plug up. The cut stays {} mm below the finished face.",
                num(length.round()),
                num(((plug.glue_gap + p.tip_radius / p.tan()) * 100.0).round() / 100.0),
                num(plug.relief_keep)
            )),
            Ok(_) => {}
            Err(e) => {
                carving_failed(ctx, e);
                return None;
            }
        }
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
        overrun,
        ..Cut::default()
    })
}

/// A plain pocket: the shapes cleared to a flat floor with one end mill, or
/// with several in order. Inside corners are left rounded to the smallest.
fn plain_pocket(ctx: &mut Context, regions: &[Region], tool_ids: &[String]) -> Option<Cut> {
    if tool_ids.is_empty() {
        ctx.errors
            .push("Choose an end mill for this pocket.".into());
        return None;
    }
    let end_mills = ctx.end_mills(tool_ids)?;
    if !ctx.errors.is_empty() || regions.is_empty() {
        return None;
    }
    let smallest = end_mills
        .iter()
        .map(|(tool, _)| *tool)
        .min_by(|a, b| a.diameter.total_cmp(&b.diameter))?;
    if offset(regions, -smallest.diameter / 2.0).is_empty() {
        ctx.errors.push(format!(
            "\"{}\" ({} mm) is too wide to fit inside any of the selected shapes.",
            smallest.name,
            num(smallest.diameter)
        ));
        return None;
    }

    let mut number = ctx.project.machine.first_tool;
    let mut path = ctx.path();
    let (cleared, tools) = ctx.clear_in_order(
        &mut path,
        regions,
        &end_mills,
        &mut number,
        "the pocket",
        false,
    );
    let wanted = total_area(regions);
    let left = wanted - total_area(&cleared);
    if left > 0.002 * wanted && left > 0.05 {
        ctx.warnings.push(format!(
            "{} mm² of the shapes is not cut: \"{}\" rounds inside corners to its {} mm radius and cannot enter anything narrower than {} mm. What is cut is dashed on the drawing.",
            num((left * 10.0).round() / 10.0),
            smallest.name,
            num(smallest.diameter / 2.0),
            num(smallest.diameter)
        ));
    }
    Some(Cut {
        tools,
        moves: path.finish(),
        cuttable: outlines(&cleared),
        pocket: cleared,
        ..Cut::default()
    })
}

/// The rectangle a facing covers: the whole stock without shapes, else the
/// rectangle around the shapes grown by the margin.
fn facing_rect(regions: &[Region], stock: (f64, f64), margin: f64) -> [f64; 4] {
    match extent(regions) {
        Some(b) => [b[0] - margin, b[1] - margin, b[2] + margin, b[3] + margin],
        None => [0.0, 0.0, stock.0, stock.1],
    }
}

/// How far beyond the rectangle around its shapes a facing reaches: its own
/// margin, or, when it takes it from the inlays, the widest plug margin of
/// the inlays its shapes belong to. 0 for any other step.
pub fn facing_margin(project: &Project, step: &Step) -> f64 {
    let Task::Facing {
        margin,
        margin_auto,
        ..
    } = &step.task
    else {
        return 0.0;
    };
    if !*margin_auto {
        return *margin;
    }
    project
        .steps
        .iter()
        .filter(|other| {
            other
                .region_ids
                .iter()
                .any(|id| step.region_ids.contains(id))
        })
        .filter_map(|other| match &other.task {
            Task::Vcarve { plug_margin, .. } => Some(*plug_margin),
            Task::Flat {
                insert_margin,
                insert_style: InsertStyle::Backer,
                ..
            } => Some(*insert_margin),
            _ => None,
        })
        .reduce(f64::max)
        .unwrap_or(*margin)
}

/// Where a facing cuts and where it starts: its rectangle on the stock, and
/// how far above the surface its first pass begins. That height is the one
/// the facing gives, or the one the list gives when it is to be taken from
/// there. `None` for any other step.
pub fn facing_start(project: &Project, step_id: &str) -> Option<([f64; 4], f64)> {
    let design = project.design.as_ref()?;
    let index = project.steps.iter().position(|j| j.id == step_id)?;
    let step = &project.steps[index];
    let Task::Facing {
        above, above_auto, ..
    } = &step.task
    else {
        return None;
    };
    let rect = facing_rect(
        &design.placed_regions(&step.region_ids),
        design.placed_size(),
        facing_margin(project, step),
    );
    let above = if *above_auto {
        standing_in(project, index, rect)
    } else {
        *above
    };
    Some((rect, above))
}

/// How far glued-in wood stands above the surface within `rect` when the
/// list has got to entry `index`, by the inlays' own numbers: the highest of
/// the plugs and inserts glued in before it whose blanks reach into the
/// rectangle, each as an earlier facing over it has left it.
fn standing_in(project: &Project, index: usize, rect: [f64; 4]) -> f64 {
    let Some(design) = &project.design else {
        return 0.0;
    };
    let overlap =
        |a: &[f64; 4], b: &[f64; 4]| a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    let mut standing: Vec<(&str, [f64; 4], f64)> = Vec::new();
    for step in &project.steps[..index] {
        match &step.task {
            Task::Glue { inlay_id } => {
                let Some(inlay) = project.steps.iter().find(|j| &j.id == inlay_id) else {
                    continue;
                };
                let (height, margin) = match &inlay.task {
                    Task::Vcarve {
                        plug_thickness,
                        engagement_depth,
                        plug_margin,
                        ..
                    } => (plug_thickness - engagement_depth, *plug_margin),
                    Task::Flat {
                        insert_thickness,
                        pocket_depth,
                        insert_margin,
                        insert_style,
                        ..
                    } => (
                        insert_thickness - pocket_depth,
                        // Loose inserts have no blank around them.
                        if *insert_style == InsertStyle::Backer {
                            *insert_margin
                        } else {
                            0.0
                        },
                    ),
                    _ => continue,
                };
                if let Some(b) = extent(&design.placed_regions(&inlay.region_ids)) {
                    if height > 0.0 {
                        standing.push((
                            inlay_id.as_str(),
                            [b[0] - margin, b[1] - margin, b[2] + margin, b[3] + margin],
                            height,
                        ));
                    }
                }
            }
            Task::Facing { depth, .. } => {
                let faced = facing_rect(
                    &design.placed_regions(&step.region_ids),
                    design.placed_size(),
                    facing_margin(project, step),
                );
                for (_, blank, height) in &mut standing {
                    if overlap(blank, &faced) {
                        *height = height.min((-depth).max(0.0));
                    }
                }
            }
            // Sawn off: what the saw left is what stands.
            Task::Saw { inlay_id, leave } => {
                for (id, _, height) in &mut standing {
                    if *id == inlay_id.as_str() {
                        *height = height.min(*leave);
                    }
                }
            }
            _ => {}
        }
    }
    standing
        .iter()
        .filter(|(_, blank, _)| overlap(blank, &rect))
        .map(|(_, _, height)| *height)
        .fold(0.0, f64::max)
}

/// Facing: an area milled flat with an end mill, from `above` the stock's
/// surface down to the step's depth below it. Without shapes the area is the
/// whole stock; with shapes, the rectangle around them grown by `margin`. The
/// tool's centre
/// goes right to the edge of the area, so no wall is left around it above the
/// surface.
fn facing(
    ctx: &mut Context,
    regions: &[Region],
    stock: (f64, f64),
    above: f64,
    margin: f64,
    tool_id: Option<&str>,
) -> Option<Cut> {
    let depth = ctx.depth;
    let total = above + depth;
    if total <= 0.0 {
        ctx.errors.push(
            "There is nothing to face: give the wood above the surface, a depth below it, or both."
                .into(),
        );
        return None;
    }
    let (tool, cutting) = ctx.tool(tool_id, ToolKind::FlatEnd, "an end mill")?;
    if !ctx.errors.is_empty() {
        return None;
    }
    let radius = tool.diameter / 2.0;
    // With shapes, the rectangle around them: a plug's blank is one, whatever
    // the shapes on it.
    let whole = regions.is_empty();
    let [x0, y0, x1, y1] = facing_rect(regions, stock, margin);
    let wanted = vec![Region::new(vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]])];
    // Cleared as an area one radius larger, the tool's centre covers `wanted`.
    let where_to = centres(&offset(&wanted, radius), &[], tool.diameter);
    if where_to.is_empty() {
        return None;
    }

    let safe = ctx.setup().safe_height;
    let number = ctx.project.machine.first_tool;
    let mut path = ctx.path();
    path.start_tool(number, cutting.rpm);
    // The area has no walls: straight passes need no pass round its edge.
    let params = clear_params(tool, cutting, total, ctx.setup().ramp_slope());
    match ctx.pattern {
        Pattern::Offset => clear_centres(&mut path, &where_to, &params),
        Pattern::Raster => raster_centres(&mut path, &where_to, &params, false, ctx.direction),
    };
    let mut moves = path.finish();
    // Worked out as if the top of the standing wood were the surface: lift it there.
    if above > 0.0 {
        for m in &mut moves {
            match m {
                Move::Rapid { to } | Move::Feed { to, .. } | Move::Arc { to, .. } => to[2] += above,
                Move::RapidXy { .. }
                | Move::ToolChange { .. }
                | Move::SpindleOn { .. }
                | Move::SpindleOff
                | Move::Comment { .. } => {}
            }
        }
        ctx.warnings.push(if depth < 0.0 {
            format!(
                "All {} mm are cut above the stock's surface, and the cut ends {} mm above it. The tool travels {} mm above the surface.",
                num(total),
                num(-depth),
                num(safe + above)
            )
        } else {
            format!(
                "The first {} mm are cut above the stock's surface. The tool travels {} mm above the surface.",
                num(above),
                num(safe + above)
            )
        });
    }
    ctx.warnings.push(if whole {
        format!(
            "The tool runs {} mm out over every edge of the stock. Keep clamps below the surface or out of its way.",
            num(radius)
        )
    } else {
        format!(
            "The tool's centre goes to the edge of the area, so it cuts up to {} mm beyond it.",
            num(radius)
        )
    });
    Some(Cut {
        tools: vec![ProgramTool {
            number,
            tool: tool.clone(),
        }],
        moves,
        pocket: wanted,
        ..Cut::default()
    })
}

/// A contour: an end mill taken along the outlines of the shapes, outside
/// them, inside them or on them, down to the step's depth or right through
/// the stock.
fn contour(
    ctx: &mut Context,
    regions: &[Region],
    side: Side,
    through: bool,
    tabs: bool,
    tool_id: Option<&str>,
) -> Option<Cut> {
    let (tool, cutting) = ctx.tool(tool_id, ToolKind::FlatEnd, "an end mill")?;
    if !ctx.errors.is_empty() || regions.is_empty() {
        return None;
    }
    let radius = tool.diameter / 2.0;
    let delta = match side {
        Side::Outside => radius,
        Side::Inside => -radius,
        Side::On => 0.0,
    };
    if side == Side::Outside && offset(regions, radius).len() < regions.len() {
        ctx.errors.push(format!(
            "Two of the shapes are closer together than \"{}\" is wide ({} mm), so it cannot pass between them. Move them apart, use a smaller tool, or cut them in separate operations.",
            tool.name,
            num(tool.diameter)
        ));
        return None;
    }
    let tracks: Vec<Vec<Region>> = regions
        .iter()
        .map(|r| offset(std::slice::from_ref(r), delta))
        .collect();
    if tracks.iter().any(Vec::is_empty) {
        ctx.errors.push(format!(
            "\"{}\" ({} mm) is too wide to run inside {}.",
            tool.name,
            num(tool.diameter),
            if regions.len() == 1 {
                "the shape"
            } else {
                "one of the shapes"
            }
        ));
        return None;
    }

    let setup = ctx.setup();
    let depth = ctx.depth;
    let thickness = ctx.project.base.thickness;
    let tab_thickness = if through {
        setup.tab_thickness_on(thickness)
    } else {
        setup.tab_thickness.min(depth / 2.0)
    };
    // Cutting down a little further from the wood that stays leaves its edge
    // for one clean pass. Not where that would close the way between two
    // shapes, or leave the tool no room inside one.
    let allowance = setup.finish_allowance;
    let further: Option<Vec<Vec<Region>>> = match side {
        _ if allowance <= 0.0 => None,
        Side::On => None,
        Side::Outside => (offset(regions, radius + allowance).len() >= regions.len()).then(|| {
            regions
                .iter()
                .map(|r| offset(std::slice::from_ref(r), radius + allowance))
                .collect()
        }),
        Side::Inside => {
            let inner: Vec<Vec<Region>> = regions
                .iter()
                .map(|r| offset(std::slice::from_ref(r), -(radius + allowance)))
                .collect();
            inner.iter().all(|t| !t.is_empty()).then_some(inner)
        }
    };
    let number = ctx.project.machine.first_tool;
    let mut path = ctx.path();
    path.start_tool(number, cutting.rpm);
    let report = follow(
        &mut path,
        &tracks,
        further.as_deref(),
        &ProfileParams {
            tool_diameter: tool.diameter,
            depth,
            stepdown: cutting.stepdown,
            feed: cutting.feed,
            plunge: cutting.plunge,
            tabs: tabs.then_some(Tabs {
                height: tab_thickness + if through { setup.through_cut } else { 0.0 },
                width: setup.tab_width,
                spacing: setup.tab_spacing,
            }),
            ramp: setup.ramp_slope(),
            finish: allowance,
        },
    );
    let left: usize = report.tabs.iter().sum();
    if tabs && left > 0 {
        ctx.warnings.push(format!(
            "{} tabs {} mm wide and {} mm thick are left across the cut. Cut them and trim the edge afterwards.",
            left,
            num(setup.tab_width),
            num(tab_thickness)
        ));
    } else if tabs {
        ctx.warnings
            .push("The outlines are too short for tabs, so none are left.".into());
    }
    if through {
        if !tabs || left == 0 {
            ctx.warnings.push("Without tabs, what the cut frees comes loose on the last pass. Hold it down with tape or it can be thrown by the tool.".into());
        }
        ctx.warnings.push(format!(
            "The cut goes {} mm past the bottom of the stock: put a spoilboard under it.",
            num(setup.through_cut)
        ));
    }
    Some(Cut {
        tools: vec![ProgramTool {
            number,
            tool: tool.clone(),
        }],
        moves: path.finish(),
        pocket: regions.to_vec(),
        through: if through { setup.through_cut } else { 0.0 },
        ..Cut::default()
    })
}

/// How an edge-shaping bit is run along an outline: how far its axis is from
/// the outline, on the side where the wood is gone, and how deep its tip is.
struct EdgeCut {
    aside: f64,
    depth: f64,
}

/// How a V-bit is run to bevel an edge `width` wide, its axis `tip_clearance`
/// beyond its tip flat from the edge, or a corner-rounding bit to round it
/// over to its own radius. `None` for any other tool.
fn edge_cut(bit: &Tool, width: f64, tip_clearance: f64) -> Option<EdgeCut> {
    match bit.kind {
        ToolKind::VBit => {
            let (half_angle, tip_radius) = vbit_shape(bit);
            Some(EdgeCut {
                aside: tip_radius + tip_clearance,
                depth: (width + tip_clearance) / half_angle.tan(),
            })
        }
        // The tip's side runs along the wall, and the quarter circle above it
        // ends level with the surface.
        ToolKind::CornerRound => Some(EdgeCut {
            aside: bit.tip_diameter.unwrap_or(0.0) / 2.0,
            depth: bit.corner_radius.unwrap_or(0.0),
        }),
        ToolKind::FlatEnd | ToolKind::BallEnd | ToolKind::Drill | ToolKind::ThreadMill => None,
    }
}

/// A chamfer or a rounded edge: a V-bit or a corner-rounding bit taken along
/// the outlines of the shapes, on the side where the wood has been cut away,
/// so that it shapes the top edge.
fn chamfer(
    ctx: &mut Context,
    regions: &[Region],
    side: Side,
    width: f64,
    tip_clearance: f64,
    tool_id: Option<&str>,
) -> Option<Cut> {
    // The depth follows from the bit, and the bit is checked against the depth.
    let chosen = tool_id.and_then(|id| ctx.project.tools.iter().find(|t| t.id == id));
    let rounding = chosen.is_some_and(|t| t.kind == ToolKind::CornerRound);
    if let Some(cut) = chosen.and_then(|bit| edge_cut(bit, width, tip_clearance)) {
        ctx.depth = cut.depth;
    }
    let (bit, cutting) = ctx.tool(
        tool_id,
        if rounding {
            ToolKind::CornerRound
        } else {
            ToolKind::VBit
        },
        "a V-bit or a corner-rounding bit",
    )?;
    if !ctx.errors.is_empty() || regions.is_empty() {
        return None;
    }
    let EdgeCut { aside, depth } = edge_cut(bit, width, tip_clearance)?;
    if !rounding {
        let widest = bit.diameter / 2.0 - aside;
        if width > widest + 1e-9 {
            ctx.errors.push(format!(
                "\"{}\" is too narrow for a chamfer {} mm wide: it can cut one of {} mm at most.",
                bit.name,
                num(width),
                num((widest * 100.0).floor() / 100.0)
            ));
            return None;
        }
    }
    if depth >= ctx.project.base.thickness {
        ctx.errors.push(format!(
            "The bit's tip would run {} mm deep, but the stock is only {} mm thick.",
            num((depth * 100.0).round() / 100.0),
            num(ctx.project.base.thickness)
        ));
        return None;
    }
    let delta = if side == Side::Inside { -aside } else { aside };
    let tracks: Vec<Vec<Region>> = regions
        .iter()
        .map(|r| offset(std::slice::from_ref(r), delta))
        .collect();
    if tracks.iter().any(Vec::is_empty) {
        ctx.errors
            .push("One of the shapes is too small for the bit to run inside it.".into());
        return None;
    }

    let number = ctx.project.machine.first_tool;
    let mut path = ctx.path();
    path.start_tool(number, cutting.rpm);
    follow(
        &mut path,
        &tracks,
        None,
        &ProfileParams {
            tool_diameter: bit.diameter,
            depth,
            stepdown: cutting.stepdown,
            feed: cutting.feed,
            plunge: cutting.plunge,
            tabs: None,
            // The bit's tip runs in the air: nothing to ramp into or to finish.
            ramp: 0.0,
            finish: 0.0,
        },
    );
    let where_to = format!(
        "{} mm {} the outline, {} mm deep",
        num((aside * 100.0).round() / 100.0),
        if side == Side::Inside {
            "inside"
        } else {
            "outside"
        },
        num((depth * 100.0).round() / 100.0)
    );
    ctx.warnings.push(if rounding {
        format!(
            "Run this after the edge has been cut. The bit rounds the edge to its {} mm radius; its tip runs {where_to}, where it expects the wood to be gone already. In uncut wood it cuts a groove as wide as the bit instead.",
            num(depth)
        )
    } else {
        format!(
            "Run this after the edge has been cut. The V-bit's tip runs {where_to}, where it expects the wood to be gone already; in uncut wood it leaves a V-groove instead."
        )
    });
    Some(Cut {
        tools: vec![ProgramTool {
            number,
            tool: bit.clone(),
        }],
        moves: path.finish(),
        pocket: regions.to_vec(),
        ..Cut::default()
    })
}

/// Builds one file that runs the stock's part of several steps one after the
/// other, in the order given: an inlay's pocket, or a plain operation. A tool
/// that the next step also starts with stays in the spindle, and tools keep
/// one number each through the whole file.
pub fn build_combined(project: &Project, step_ids: &[String]) -> Result<Built, Vec<String>> {
    if step_ids.is_empty() {
        return Err(vec!["Tick what the file should cut.".to_string()]);
    }
    let name_of = |id: &str| {
        project
            .steps
            .iter()
            .find(|j| j.id == id)
            .map_or("?", |j| j.name.as_str())
    };

    let mut parts: Vec<(&str, Built)> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for id in step_ids {
        match build(project, id, Part::Pocket) {
            Ok(built) => parts.push((name_of(id), built)),
            Err(reasons) => errors.extend(
                reasons
                    .into_iter()
                    .map(|reason| format!("{}: {reason}", name_of(id))),
            ),
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let borrowed: Vec<(&str, &Built)> = parts.iter().map(|(name, b)| (*name, b)).collect();
    let mut built = join(project, &borrowed, "stock")?.built;

    let mut warnings: Vec<String> = Vec::new();
    // Wood standing above the surface is only allowed for by the step that faces it off.
    for (i, id) in step_ids.iter().enumerate().skip(1) {
        if let Some((_, above)) = facing_start(project, id) {
            if above > 0.0 {
                warnings.push(format!(
                    "\"{}\" faces off {} mm of wood standing above the surface, but {} before it in this file {} as if the surface were clear. Make sure nothing stands in {} way, or put the facing first.",
                    name_of(id),
                    num(above),
                    if i == 1 { "the step" } else { "the steps" },
                    if i == 1 { "travels" } else { "travel" },
                    if i == 1 { "its" } else { "their" }
                ));
            }
        }
    }
    warnings.append(&mut built.warnings);
    built.warnings = warnings;
    Ok(built)
}

/// What the comment says that stands where a part begins in a joined file.
fn marker_text(index: usize, name: &str) -> String {
    format!("Step {}: {name}", index + 1)
}

/// Several parts cut from the stock, joined into one file.
#[derive(Debug, Clone, PartialEq)]
pub struct Joined {
    pub built: Built,
    /// For each part, the line of the file its comment stands on: the part
    /// is every line from there to the next part's.
    pub starts: Vec<u32>,
}

/// Joins the files of several parts cut from the stock into one, in the
/// order given; each comes with the name of its step. A tool that the next
/// part also starts with stays in the spindle, and tools keep one number
/// each through the whole file. `label` is what the file is called after
/// the project's name: "stock", or "stock 2".
pub fn join(
    project: &Project,
    parts: &[(&str, &Built)],
    label: &str,
) -> Result<Joined, Vec<String>> {
    let design = project
        .design
        .as_ref()
        .ok_or_else(|| vec!["The project has no design.".to_string()])?;

    let mut tools: Vec<ProgramTool> = Vec::new();
    let mut moves: Vec<Move> = Vec::new();
    // The tool in the spindle and its speed, and where the tool is.
    let mut loaded: Option<(u32, u32)> = None;
    let mut at: Option<[f64; 3]> = None;
    for (index, (name, built)) in parts.iter().enumerate() {
        // Says where the part begins, for whoever reads the file and for
        // finding the part's lines again.
        let mut marker = Some(Move::Comment {
            text: marker_text(index, name),
        });
        // This part's tool numbers as they are in the whole file.
        let mut numbers: HashMap<u32, u32> = HashMap::new();
        for t in &built.program.tools {
            let number = match tools.iter().find(|known| known.tool.id == t.tool.id) {
                Some(known) => known.number,
                None => {
                    let number = project.machine.first_tool + tools.len() as u32;
                    tools.push(ProgramTool {
                        number,
                        tool: t.tool.clone(),
                    });
                    number
                }
            };
            numbers.insert(t.number, number);
        }

        let part = &built.program.moves;
        let mut i = 0;
        while i < part.len() {
            match &part[i] {
                Move::ToolChange { number } => {
                    let number = numbers[number];
                    let rpm = match part.get(i + 1) {
                        Some(Move::SpindleOn { rpm }) => *rpm,
                        _ => 0,
                    };
                    match (loaded, at) {
                        (Some((have, have_rpm)), Some(from)) if have == number && rpm > 0 => {
                            // The same tool again: it stays in, still turning.
                            if matches!(moves.last(), Some(Move::SpindleOff)) {
                                moves.pop();
                            }
                            moves.extend(marker.take());
                            if rpm != have_rpm {
                                moves.push(Move::SpindleOn { rpm });
                            }
                            loaded = Some((number, rpm));
                            i += 2;
                            // It is not parked high above the work this time: travel at
                            // the higher of the two parts' travel heights.
                            if let Some(Move::RapidXy { to }) = part.get(i) {
                                let next = match part.get(i + 1) {
                                    Some(Move::Rapid { to }) => to[2],
                                    _ => from[2],
                                };
                                let z = from[2].max(next);
                                moves.push(Move::Rapid {
                                    to: [from[0], from[1], z],
                                });
                                moves.push(Move::Rapid {
                                    to: [to[0], to[1], z],
                                });
                                at = Some([to[0], to[1], z]);
                                i += 1;
                            }
                            continue;
                        }
                        _ => {
                            moves.extend(marker.take());
                            moves.push(Move::ToolChange { number });
                            loaded = Some((number, rpm));
                            at = None;
                        }
                    }
                }
                m @ (Move::Rapid { to } | Move::Feed { to, .. } | Move::Arc { to, .. }) => {
                    at = Some(*to);
                    moves.extend(marker.take());
                    moves.push(m.clone());
                }
                m => {
                    moves.extend(marker.take());
                    moves.push(m.clone());
                }
            }
            i += 1;
        }
    }

    let names: Vec<&str> = parts.iter().map(|(name, _)| *name).collect();
    let program = Program {
        name: format!("{} - {label} - {}", project.name, names.join(", ")),
        tools,
        safe_z: parts
            .iter()
            .map(|(_, b)| b.program.safe_z)
            .fold(0.0, f64::max),
        moves,
    };
    let (gcode, interpreted, stats) = finish(&program, &project.machine, "file")?;

    // Where each part's comment came to stand.
    let mut starts: Vec<u32> = Vec::with_capacity(parts.len());
    let mut lines = gcode.lines().enumerate();
    for (index, (name, _)) in parts.iter().enumerate() {
        let wanted = carvera::comment_line(&marker_text(index, name));
        let line = lines
            .find(|(_, text)| *text == wanted)
            .map(|(at, _)| at as u32 + 1)
            .ok_or_else(|| {
                vec!["Internal error: a part of the joined file was not found again.".to_string()]
            })?;
        starts.push(line);
    }

    let mut warnings: Vec<String> = Vec::new();
    for (name, built) in parts {
        warnings.extend(built.warnings.iter().map(|w| format!("{name}: {w}")));
    }
    let pocket: Vec<Region> = parts.iter().flat_map(|(_, b)| b.pocket.clone()).collect();
    let (width, height) = design.placed_size();
    let built = Built {
        part: Part::Pocket,
        stock: Stock {
            width,
            height,
            thickness: project.base.thickness,
            through: parts
                .iter()
                .map(|(_, b)| b.stock.through)
                .fold(0.0, f64::max),
        },
        narrow: parts.iter().flat_map(|(_, b)| b.narrow.clone()).collect(),
        cuttable: parts.iter().flat_map(|(_, b)| b.cuttable.clone()).collect(),
        flat_fit: None,
        frame: None,
        origin: None,
        piece: None,
        cut_width: None,
        shapes: extent(&pocket),
        file_name: format!(
            "{}.{}",
            file_stem(&format!("{} {label}", project.name)),
            carvera::FILE_EXTENSION
        ),
        stats,
        gcode,
        warnings,
        program,
        interpreted,
        pocket,
    };
    Ok(Joined { built, starts })
}

fn checked_tool<'a>(
    project: &'a Project,
    id: Option<&str>,
    kind: ToolKind,
    what: &str,
    errors: &mut Vec<String>,
) -> Option<&'a Tool> {
    let Some(id) = id else {
        errors.push(format!("Choose {what}."));
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

fn material_name(material: &Material) -> &str {
    material.key()
}

#[derive(Debug, Clone, PartialEq)]
pub struct Preview {
    pub map: HeightMap,
    /// Problems found while cutting, each with its G-code line.
    pub problems: Vec<sim::SimProblem>,
    pub built: Built,
}

/// Builds a step's pocket file and simulates that file on the base board.
pub fn preview_pocket(project: &Project, step_id: &str) -> Result<Preview, Vec<String>> {
    preview(project, step_id, Part::Pocket)
}

/// Builds the file for one part of a step and simulates that file on the
/// part's board.
pub fn preview(project: &Project, step_id: &str, part: Part) -> Result<Preview, Vec<String>> {
    Ok(simulated(build(project, step_id, part)?))
}

/// As [`preview`], with the height a facing that takes it from the list is
/// to start at, as [`build_with`] takes it.
pub fn preview_with(
    project: &Project,
    step_id: &str,
    part: Part,
    standing: Option<f64>,
) -> Result<Preview, Vec<String>> {
    Ok(simulated(build_with(project, step_id, part, standing)?))
}

/// Builds one file that runs several steps on the stock, and simulates it.
pub fn preview_combined(project: &Project, step_ids: &[String]) -> Result<Preview, Vec<String>> {
    Ok(simulated(build_combined(project, step_ids)?))
}

/// Simulates a built file on its board.
fn simulated(built: Built) -> Preview {
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
    Preview {
        map: simulation.map,
        problems: simulation.problems,
        built,
    }
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
pub fn check_fit(project: &Project, step_id: &str) -> Result<FitCheck, Vec<String>> {
    // Fail early for a flat inlay, before anything is simulated.
    fit_settings(project, step_id)?;
    let pocket = preview(project, step_id, Part::Pocket)?;
    let plug = preview(project, step_id, Part::Plug)?;
    let fit = fit_of(project, step_id, &pocket, &plug)?;
    Ok(FitCheck { fit, pocket, plug })
}

/// What a V-carve inlay's fit is measured against: all of
/// [`analysis::FitSettings`] but the problems of its two files.
fn fit_settings(project: &Project, step_id: &str) -> Result<analysis::FitSettings, Vec<String>> {
    let step = project
        .steps
        .iter()
        .find(|j| j.id == step_id)
        .ok_or_else(|| vec!["This inlay no longer exists.".to_string()])?;
    let Task::Vcarve {
        engagement_depth,
        glue_gap,
        vbit_tool_id,
        tuning,
        ..
    } = &step.task
    else {
        return Err(vec![
            "A flat inlay's fit is worked out from its outlines when a part is generated.".into(),
        ]);
    };
    // How high a V-bit's tip flat can hold a plug off at a sharp corner: the
    // pocket's corner is rounded to the flat's radius while the plug's stays
    // sharp, and the plug has to rise by that radius over the wall's slope
    // to clear it. 0 for a pointed bit.
    let tip_rise = vbit_tool_id
        .as_deref()
        .and_then(|id| project.tools.iter().find(|t| t.id == id))
        .map_or(0.0, |bit| {
            let (half_angle, tip_radius) = vbit_shape(bit);
            tip_radius / half_angle.tan()
        });
    Ok(analysis::FitSettings {
        engagement: *engagement_depth,
        pocket_depth: engagement_depth + glue_gap,
        trim_depth: tuning.trim_depth,
        tip_rise,
        problems: 0,
    })
}

/// Lowers an already simulated plug into an already simulated pocket of the
/// same V-carve inlay and measures the fit.
pub fn fit_of(
    project: &Project,
    step_id: &str,
    pocket: &Preview,
    plug: &Preview,
) -> Result<Fit, Vec<String>> {
    let settings = analysis::FitSettings {
        problems: pocket.problems.len() + plug.problems.len(),
        ..fit_settings(project, step_id)?
    };
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
    analysis::fit(&pocket.map, plug_map, frame, &settings)
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
pub(crate) mod tests {
    use super::*;
    use crate::project::{BaseStock, Design, DesignRegion, Step, DEFAULT_TIP_CLEARANCE};
    use crate::tools::fixtures::{end_mill, v_bit};
    use crate::tools::CuttingSettings;

    /// A 60 x 40 mm page with a 30 x 20 mm rectangle and an L shape.
    pub(crate) fn project() -> Project {
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
            steps: vec![Step {
                id: "j".into(),
                name: "Flat inlay 1".into(),
                material: Material::HARDWOOD,
                region_ids: vec![0, 1],
                setup: None,
                color: None,
                cut_out_tool_id: None,
                row_profiles: Default::default(),
                task: Task::Flat {
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
            profiles: Vec::new(),
            base: BaseStock::default(),
            machine: Machine::default(),
            setup: Setup::default(),
        }
    }

    fn with_inlay(task: Task) -> Project {
        let mut p = project();
        p.steps[0].task = task;
        p
    }

    #[test]
    fn builds_a_file_that_obeys_the_firmware_rules_and_reads_back() {
        let built = build_pocket(&project(), "j").unwrap();
        assert_eq!(built.file_name, "Test-board-Flat-inlay-1-pocket.cnc");
        assert!(built.gcode.starts_with("(Test board - Flat inlay 1 - pocket)\n(T1  D3.175x22 1F Downcut  D=3.175 CR=0 SD=3.175 FL=22 - flat end mill)\nG90 G94\nG17\nG21\nM6 T1\nS12000 M3\nG54\n"));
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
        // Moves too short to show in three decimals are not written, so the
        // count may differ; the cutting done may not.
        let mut written = 0.0;
        let mut at: Option<[f64; 3]> = None;
        for m in &built.program.moves {
            let to = match m {
                Move::Feed { to, .. } | Move::Rapid { to } => *to,
                Move::ToolChange { .. } => {
                    at = None;
                    continue;
                }
                _ => continue,
            };
            if let (Some(a), Move::Feed { .. }) = (at, m) {
                written += (0..3).map(|k| (to[k] - a[k]).powi(2)).sum::<f64>().sqrt();
            }
            at = Some(to);
        }
        let read = built.interpreted.cutting_length();
        assert!(written > 500.0);
        // Curves are written as arcs, a hair longer than the straight cuts they replace.
        assert!(
            (written - read).abs() < 2e-3 * written,
            "{written} mm written, {read} mm read back"
        );
        // The file ends where the moves end, and goes no deeper.
        let last = built
            .interpreted
            .segments
            .iter()
            .rfind(|s| !s.rapid)
            .unwrap();
        let end = built
            .program
            .moves
            .iter()
            .rev()
            .find_map(|m| match m {
                Move::Feed { to, .. } => Some(*to),
                _ => None,
            })
            .unwrap();
        for k in 0..3 {
            assert!((last.to[k] - end[k]).abs() <= 0.0005 + 1e-9);
        }
        let lowest = |zs: &mut dyn Iterator<Item = f64>| zs.fold(f64::INFINITY, f64::min);
        let deepest_read = lowest(&mut built.interpreted.segments.iter().map(|s| s.to[2]));
        assert!((deepest_read + 2.0).abs() < 1e-9);
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
        if let Task::Flat { tabs, .. } = &mut p.steps[0].task {
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
        if let Task::Flat {
            insert_thickness, ..
        } = &mut p.steps[0].task
        {
            *insert_thickness = 1.0;
        }
        assert!(reasons(&p).contains("would sit below the surface"));
        let mut p = project();
        if let Task::Flat { insert_margin, .. } = &mut p.steps[0].task {
            *insert_margin = 2.0;
        }
        assert!(reasons(&p).contains("insert margin of 2 mm is too small"));
        // Rectangle and L are 5 mm apart: fine for a 3.175 mm tool, not for 6.
        let mut p = project();
        p.tools[0].diameter = 6.0;
        if let Task::Flat { insert_margin, .. } = &mut p.steps[0].task {
            *insert_margin = 10.0;
        }
        assert!(
            reasons(&p).contains("cannot be cut apart"),
            "{}",
            reasons(&p)
        );
    }

    #[test]
    fn explains_every_reason_a_step_cannot_be_built() {
        let reasons = |p: &Project| build_pocket(p, "j").unwrap_err().join(" | ");

        let p = with_inlay(Task::Flat {
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

        let p = with_inlay(Task::Flat {
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

        let p = with_inlay(Task::Flat {
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
        p.steps[0].material = Material::SOFTWOOD;
        assert!(reasons(&p).contains("no cutting settings for softwood"));

        let mut p = project();
        p.tools[0].cutting[0].rpm = 15000;
        assert!(reasons(&p).contains("tops out at 13000 rpm"));

        let mut p = project();
        p.steps[0].region_ids.clear();
        assert!(reasons(&p).contains("has no shapes"));

        let mut p = project();
        p.tools[0].diameter = 30.0;
        p.tools[0].cutting[0].stepover = 10.0;
        assert!(reasons(&p).contains("too wide to fit"));

        assert!(reasons(&with_inlay(Task::default_vcarve())).contains("Choose a V-bit"));
        assert!(build_pocket(&project(), "nope").unwrap_err()[0].contains("no longer exists"));
    }

    #[test]
    fn scale_and_mirror_are_applied_before_cutting() {
        let mut p = project();
        let design = p.design.as_mut().unwrap();
        design.scale = 2.0;
        design.mirror = true;
        p.steps[0].region_ids = vec![0];
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
    pub(crate) fn vcarve_project(clearing: bool) -> Project {
        let mut p = with_inlay(Task::Vcarve {
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
            relief: false,
            tuning: Default::default(),
        });
        p.tools[1].cutting = vec![CuttingSettings::new(
            Material::HARDWOOD,
            12000,
            500.0,
            150.0,
            0.2,
            1.0,
        )];
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
            too_high < VcarveTuning::default().floor_ridge + 0.03,
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
        p.steps[0].region_ids = vec![0];
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
        if let Task::Vcarve { plug_margin, .. } = &mut p.steps[0].task {
            *plug_margin = 1.0;
        }
        assert!(
            reasons(&p).contains("plug margin of 1 mm is too small"),
            "{}",
            reasons(&p)
        );

        let mut p = vcarve_project(true);
        if let Task::Vcarve { plug_thickness, .. } = &mut p.steps[0].task {
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
    fn the_machine_and_the_setup_shape_the_files() {
        let mut p = project();
        if let Task::Flat { tabs, .. } = &mut p.steps[0].task {
            *tabs = true;
        }
        p.machine.first_tool = 7;
        p.setup = Setup {
            safe_height: 8.0,
            plunge_clearance: 2.0,
            through_cut: 0.5,
            tab_width: 6.0,
            tab_spacing: 20.0,
            tab_thickness: 1.5,
            cut_out_border: 5.0,
            ..Setup::default()
        };
        let insert = preview(&p, "j", Part::Plug).unwrap();
        assert_eq!(insert.problems, vec![]);
        let built = &insert.built;
        assert!(built.gcode.contains("M6 T7") && !built.gcode.contains("M6 T1"));
        assert_eq!(built.stats.per_tool[0].number, 7);
        // Travel at 8 mm, never at the usual 5.
        assert!(built.gcode.contains("Z8.000") && !built.gcode.contains("Z5.000"));
        // A 4 mm board cut 0.5 mm past its bottom, with tabs 1.5 mm thick.
        assert_eq!(built.stock.through, 0.5);
        assert!(built.gcode.contains("Z-4.500") && built.gcode.contains("Z-2.500"));
        assert!(
            built
                .warnings
                .iter()
                .any(|w| w.contains("Tabs 6 mm wide and 1.5 mm thick")),
            "{:?}",
            built.warnings
        );
        let usual = {
            let mut q = p.clone();
            q.setup.tab_spacing = 40.0;
            build(&q, "j", Part::Plug).unwrap()
        };
        let tabs = |b: &Built| b.gcode.matches("Z-2.500").count();
        assert!(tabs(built) > tabs(&usual), "closer tabs, more of them");

        // The pocket: rapid descents stop 2 mm above the wood.
        let pocket = preview(&p, "j", Part::Pocket).unwrap();
        assert_eq!(pocket.problems, vec![]);
        assert!(
            pocket.built.gcode.contains("G0 Z2.000"),
            "{}",
            pocket.built.gcode
        );

        // The machine's limits and name are the project's.
        p.machine.name = "Small mill".into();
        p.machine.travel = [20.0, 200.0];
        let reasons = build_pocket(&p, "j").unwrap_err().join(" | ");
        assert!(
            reasons.contains("The pocket spans")
                && reasons.contains("more than the Small mill can travel (20 mm)"),
            "{reasons}"
        );
        p.machine.travel = [300.0, 200.0];
        p.machine.max_rpm = 8000;
        let reasons = build_pocket(&p, "j").unwrap_err().join(" | ");
        assert!(
            reasons.contains("Small mill spindle tops out at 8000 rpm"),
            "{reasons}"
        );
    }

    #[test]
    fn a_wider_border_makes_a_larger_board_for_a_cut_out_plug() {
        let mut p = vcarve_project(true);
        set_cut_out(&mut p, true, true);
        let usual = build(&p, "j", Part::Plug).unwrap();
        p.setup.cut_out_border = 10.0;
        let wide = build(&p, "j", Part::Plug).unwrap();
        assert_eq!(wide.stock.width, usual.stock.width + 10.0);
        assert_eq!(wide.stock.height, usual.stock.height + 10.0);
    }

    #[test]
    fn an_inlay_cuts_with_its_own_clearances() {
        let mut p = vcarve_project(true);
        set_cut_out(&mut p, true, true);
        let usual = build(&p, "j", Part::Plug).unwrap();
        assert!(usual.gcode.contains("Z5.000") && !usual.gcode.contains("Z8.000"));

        // The inlay's own values win over the project's, which stay for
        // inlays that have none.
        p.setup.safe_height = 12.0;
        p.steps[0].setup = Some(Setup {
            safe_height: 8.0,
            cut_out_border: 10.0,
            through_cut: 0.5,
            ..Setup::default()
        });
        let own = build(&p, "j", Part::Plug).unwrap();
        assert!(own.gcode.contains("Z8.000"));
        assert!(!own.gcode.contains("Z5.000") && !own.gcode.contains("Z12.000"));
        assert_eq!(own.stock.width, usual.stock.width + 10.0);
        assert_eq!(own.stock.through, 0.5);
        let pocket = build(&p, "j", Part::Pocket).unwrap();
        assert!(pocket.gcode.contains("Z8.000") && !pocket.gcode.contains("Z12.000"));

        p.steps[0].setup = None;
        let inherited = build(&p, "j", Part::Plug).unwrap();
        assert!(inherited.gcode.contains("Z12.000"));

        p.steps[0].setup = Some(Setup {
            tab_width: 0.0,
            ..Setup::default()
        });
        assert!(p.validate().unwrap_err().contains("tab width"));
    }

    #[test]
    fn end_mills_clear_over_the_edge_of_a_plug_that_is_cut_out() {
        assert_eq!(edge_overrun(6.0, 10.0), 3.0);
        assert_eq!(edge_overrun(6.0, 2.0), 4.25);
        assert_eq!(edge_overrun(6.0, 0.1), 6.0);

        // A margin too narrow for the end mill: 2 mm, less the 0.87 mm the
        // shapes' walls spread at the floor.
        let narrow = |cut_out: bool| {
            let mut p = vcarve_project(true);
            if let Task::Vcarve { plug_margin, .. } = &mut p.steps[0].task {
                *plug_margin = 2.0;
            }
            set_cut_out(&mut p, cut_out, false);
            p
        };
        let vbit_length = |b: &Built| b.stats.per_tool.last().unwrap().cutting_length;

        // Cut to size beforehand, the blank's edge bounds every tool, so the
        // strip along it is left to the V-bit.
        let plain = build(&narrow(false), "j", Part::Plug).unwrap();
        // Cut out of a larger board, the end mill takes the strip, hanging
        // over the edge into wood that is waste.
        let p = narrow(true);
        let cut = preview(&p, "j", Part::Plug).unwrap();
        assert_eq!(cut.problems, vec![]);
        assert!(
            vbit_length(&cut.built) < 0.8 * vbit_length(&plain),
            "{} against {}",
            vbit_length(&cut.built),
            vbit_length(&plain)
        );

        // Nothing is left standing along the plug's edge: from 2 mm outside
        // it to well into the strip, all is down to the floor or below.
        let [x0, y0, x1, _] = cut.built.piece.unwrap();
        let map = &cut.map;
        let floor = -(2.0 + 1.5) as f32;
        let mut checked = 0;
        for iy in 0..map.ny {
            for ix in 0..map.nx {
                let [x, y] = map.centre(ix, iy);
                if x > x0 + 1.0 && x < x1 - 1.0 && y > y0 - 2.0 && y < y0 + 0.8 {
                    assert!(
                        map.at(ix, iy) <= floor + 0.02,
                        "{} at {x}, {y}",
                        map.at(ix, iy)
                    );
                    checked += 1;
                }
            }
        }
        assert!(checked > 1000);
        // The plug still seats.
        let check = check_fit(&p, "j").unwrap();
        assert!(
            check.fit.report.proud.abs() < 0.03,
            "{:?}",
            check.fit.report
        );
        assert!(check.fit.report.wall_contact > 0.95);

        // A wide end mill hangs further over the edge than the cut that frees
        // the plug is wide. The border then starts beyond its reach.
        let mut q = narrow(true);
        let mut wide = end_mill();
        wide.id = "t-wide".into();
        wide.name = "6 mm".into();
        wide.diameter = 6.0;
        q.tools.push(wide);
        if let Task::Vcarve {
            clearing_tool_ids, ..
        } = &mut q.steps[0].task
        {
            *clearing_tool_ids = vec!["t-wide".into(), "t-endmill".into()];
        }
        q.steps[0].cut_out_tool_id = Some("t-endmill".into());
        let wide_cut = preview(&q, "j", Part::Plug).unwrap();
        assert_eq!(wide_cut.problems, vec![]);
        assert_eq!(wide_cut.built.cut_width, Some(3.175));
        // 6 - (2 - 0.87) + 0.25 = 5.12 mm over the edge, plus the 5 mm border, rounded up.
        assert_eq!(wide_cut.built.piece.unwrap()[0], 11.0);
        assert_eq!(wide_cut.built.stock.width, plain.stock.width + 22.0);
        // The board's outermost millimetres are untouched.
        assert_eq!(wide_cut.map.at(2, 2), 0.0);
    }

    #[test]
    fn the_tool_that_cuts_a_plug_out_can_be_chosen() {
        // A second, larger end mill that does nothing else in the inlay.
        let wide = |flutes: Option<f64>| {
            let mut tool = end_mill();
            tool.id = "t-wide".into();
            tool.name = "6 mm upcut".into();
            tool.diameter = 6.0;
            tool.shank_diameter = 6.0;
            tool.flute_length = flutes;
            tool
        };
        let reasons = |p: &Project| build(p, "j", Part::Plug).unwrap_err().join(" | ");

        // Without clearing end mills there is nothing to fall back on.
        let mut p = vcarve_project(false);
        set_cut_out(&mut p, true, true);
        assert!(reasons(&p).contains("Choose one for the cut-out"));

        p.tools.push(wide(Some(20.0)));
        p.steps[0].cut_out_tool_id = Some("t-wide".into());
        assert_eq!(p.steps[0].tool_ids(), vec!["t-vbit", "t-wide"]);
        let cut = preview(&p, "j", Part::Plug).unwrap();
        assert_eq!(cut.problems, vec![]);
        assert_eq!(cut.built.stats.tools.len(), 2);
        assert!(cut
            .built
            .warnings
            .iter()
            .any(|w| w.contains("is cut out of its board last, with \"6 mm upcut\"")));
        // The board grows by the chosen tool's width plus the border.
        let plain = {
            let mut q = p.clone();
            set_cut_out(&mut q, false, false);
            build(&q, "j", Part::Plug).unwrap()
        };
        assert_eq!(cut.built.stock.width, plain.stock.width + 2.0 * 11.0);

        // Chosen over a clearing end mill that would otherwise do it.
        let mut q = vcarve_project(true);
        set_cut_out(&mut q, true, false);
        q.tools.push(wide(Some(20.0)));
        q.steps[0].cut_out_tool_id = Some("t-wide".into());
        let both = build(&q, "j", Part::Plug).unwrap();
        assert_eq!(both.stats.tools.len(), 3);
        assert!(both
            .warnings
            .iter()
            .any(|w| w.contains("with \"6 mm upcut\"")));

        // The 8 mm board needs 8.2 mm of cutting edge.
        p.tools[2] = wide(Some(8.0));
        let why = reasons(&p);
        assert!(
            why.contains("\"6 mm upcut\" are 8 mm long, too short")
                && why.contains("8.2 mm are needed"),
            "{why}"
        );
        p.tools[2] = wide(Some(8.2));
        assert!(build(&p, "j", Part::Plug).is_ok());
        p.tools[2] = wide(None);
        let unknown = build(&p, "j", Part::Plug).unwrap();
        assert_eq!(
            unknown
                .warnings
                .iter()
                .filter(|w| w.contains("flute length of \"6 mm upcut\" is unknown"))
                .count(),
            1
        );

        // It must be an end mill, in the project, with settings for the wood
        // and a speed the spindle reaches.
        p.steps[0].cut_out_tool_id = Some("t-vbit".into());
        assert!(reasons(&p).contains("is not an end mill to cut the plug out"));
        p.steps[0].cut_out_tool_id = Some("gone".into());
        assert!(reasons(&p).contains("missing from the project"));
        p.steps[0].cut_out_tool_id = Some("t-wide".into());
        p.tools[2] = wide(Some(20.0));
        p.tools[2].cutting[0].rpm = 20000;
        assert!(reasons(&p).contains("tops out at 13000 rpm"));
        p.tools[2].cutting.clear();
        assert!(reasons(&p).contains("no cutting settings for hardwood"));
    }

    #[test]
    fn fit_is_only_for_v_carve_inlays_and_cuts_must_fit_the_machine() {
        assert!(check_fit(&project(), "j").unwrap_err()[0].contains("flat inlay"));
        let mut p = project();
        p.design.as_mut().unwrap().scale = 8.0;
        p.steps[0].region_ids = vec![0, 1];
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
        match &mut p.steps[0].task {
            Task::Flat {
                clearing_tool_ids, ..
            }
            | Task::Vcarve {
                clearing_tool_ids, ..
            } => *clearing_tool_ids = ids,
            _ => panic!("not an inlay"),
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
        match &mut p.steps[0].task {
            Task::Flat { cut_out, tabs, .. } | Task::Vcarve { cut_out, tabs, .. } => {
                *cut_out = on;
                *tabs = with_tabs;
            }
            _ => panic!("not an inlay"),
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
            assert_eq!(b.through, Setup::default().through_cut);
            // Where things are on the board, for the view's dimensions: the
            // plug 9 mm in, cut free with the 3.175 mm tool, and the shapes
            // inside it by about the 6 mm margin.
            let [x0, y0, x1, y1] = cut.built.piece.unwrap();
            assert_eq!([x0, y0], [9.0, 9.0]);
            assert_eq!(cut.built.cut_width, Some(3.175));
            let shapes = cut.built.shapes.unwrap();
            assert!(shapes[0] > x0 && shapes[1] > y0 && shapes[2] < x1 && shapes[3] < y1);
            assert!((shapes[0] - x0 - 6.0).abs() < 1.5, "{shapes:?}");
            assert_eq!(plain.built.piece, None);
            assert_eq!(plain.built.cut_width, None);
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
            let bottom = -(b.thickness + Setup::default().through_cut) as f32;
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

    pub(crate) fn backer_project() -> Project {
        let mut p = project();
        if let Task::Flat { insert_style, .. } = &mut p.steps[0].task {
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
            assert_eq!(cut.built.stock.through, Setup::default().through_cut);
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
        if let Task::Flat { insert_margin, .. } = &mut p.steps[0].task {
            *insert_margin = 10.0;
        }
        let reasons = build(&p, "j", Part::Plug).unwrap_err().join(" | ");
        assert!(reasons.contains("wood between their inserts"), "{reasons}");

        // A board too thin to leave a backer.
        let mut p = backer_project();
        if let Task::Flat {
            insert_thickness, ..
        } = &mut p.steps[0].task
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

    // Plain operations on the stock.

    /// The test board with one plain operation on the rectangle, and the
    /// V-bit given cutting settings.
    fn op_project(task: Task) -> Project {
        let mut p = with_inlay(task);
        p.steps[0].name = "Op".into();
        p.steps[0].region_ids = vec![0];
        p.tools[1].cutting = vec![CuttingSettings::new(
            Material::HARDWOOD,
            12000,
            500.0,
            150.0,
            0.2,
            1.0,
        )];
        p
    }

    fn cuts(built: &Built) -> Vec<[f64; 3]> {
        built
            .interpreted
            .segments
            .iter()
            .filter(|s| !s.rapid)
            .flat_map(|s| [s.from, s.to])
            .collect()
    }

    /// The rectangle of the test board.
    fn rectangle() -> Region {
        Region::new(vec![[5.0, 5.0], [35.0, 5.0], [35.0, 25.0], [5.0, 25.0]])
    }

    /// A pocket whose end mill also has a row for the profile `key`, with a
    /// feed of 250, and is set to run it.
    fn pocket_on_profile(key: &str, adaptive: Option<bool>) -> Project {
        let mut p = op_project(Task::Pocket {
            pattern: Pattern::Offset,
            direction: PassDirection::Longer,
            depth: 2.5,
            clearing_tool_ids: vec!["t-endmill".into()],
        });
        let mut row = p.tools[0].cutting[0].clone();
        row.profile = Some(key.into());
        row.feed = 250.0;
        p.tools[0].cutting.push(row);
        p.profiles = vec![Profile {
            key: key.into(),
            label: "Face finish".into(),
            note: None,
            level: None,
            ramping: false,
            adaptive,
            lubricated: false,
            slot: false,
        }];
        p.steps[0]
            .row_profiles
            .insert("t-endmill".into(), key.into());
        p
    }

    #[test]
    fn a_tool_runs_the_row_of_the_profile_chosen_for_it() {
        let chosen = pocket_on_profile("face_finish", None);
        let built = build(&chosen, "j", Part::Pocket).unwrap();
        assert!(built.gcode.contains("F250") && !built.gcode.contains("F600"));
        assert!(built
            .warnings
            .iter()
            .any(|w| w.contains("runs its Face finish row") && w.contains("feed 250")));

        // Without a choice it runs the plain row, as before.
        let mut plain = chosen.clone();
        plain.steps[0].row_profiles.clear();
        let built = build(&plain, "j", Part::Pocket).unwrap();
        assert!(built.gcode.contains("F600") && !built.gcode.contains("F250"));
        assert!(!built.warnings.iter().any(|w| w.contains("runs its")));

        // A choice for a tool the step does not use changes nothing.
        let key = "t-endmill".to_string();
        let choice = plain.steps[0].row_profiles.insert("t-other".into(), key);
        assert_eq!(choice, None);
        assert!(build(&plain, "j", Part::Pocket)
            .unwrap()
            .gcode
            .contains("F600"));

        // The file keeps the choice and the profile it names.
        let read =
            crate::project::project_from_file_json(&crate::project::project_to_file_json(&chosen))
                .unwrap();
        assert_eq!(read.steps[0].row_profiles, chosen.steps[0].row_profiles);
        assert_eq!(read.profiles, chosen.profiles);
    }

    #[test]
    fn a_row_for_adaptive_clearing_is_refused() {
        // Told by the profile, or by its key when the project has no copy.
        let by_flag = pocket_on_profile("fast", Some(true));
        let mut by_key = pocket_on_profile("adaptive", None);
        by_key.profiles.clear();
        for p in [by_flag, by_key] {
            let errors = build(&p, "j", Part::Pocket).unwrap_err();
            assert!(errors[0].contains("adaptive clearing"), "{errors:?}");
        }
        // A profile called adaptive that says it is not one may be used.
        let allowed = pocket_on_profile("adaptive", Some(false));
        assert!(build(&allowed, "j", Part::Pocket).is_ok());
    }

    #[test]
    fn a_chosen_row_the_tool_lacks_is_an_error_that_names_it() {
        let mut p = pocket_on_profile("face_finish", None);
        p.tools[0].cutting.pop();
        let errors = build(&p, "j", Part::Pocket).unwrap_err();
        assert!(
            errors[0].contains("has no Face finish row for hardwood"),
            "{errors:?}"
        );
    }

    #[test]
    fn a_step_in_another_material_uses_its_rows_and_says_it_is_unproven() {
        let mut p = op_project(Task::Pocket {
            pattern: Pattern::Offset,
            direction: PassDirection::Longer,
            depth: 2.5,
            clearing_tool_ids: vec!["t-endmill".into()],
        });
        let aluminum = Material::new("aluminum");
        p.steps[0].material = aluminum.clone();
        let errors = build(&p, "j", Part::Pocket).unwrap_err();
        assert!(errors[0].contains("no cutting settings for aluminum"));

        let mut row = p.tools[0].cutting[0].clone();
        row.material = aluminum;
        row.feed = 180.0;
        p.tools[0].cutting.push(row);
        let built = build(&p, "j", Part::Pocket).unwrap();
        assert!(built.gcode.contains("F180") && !built.gcode.contains("F600"));
        assert!(built
            .warnings
            .iter()
            .any(|w| w.contains("cut in aluminum") && w.contains("only been proven in wood")));
    }

    #[test]
    fn a_plain_pocket_is_cleared_to_its_depth_and_nothing_else_is_touched() {
        let p = op_project(Task::Pocket {
            pattern: Pattern::Offset,
            direction: PassDirection::Longer,
            depth: 2.5,
            clearing_tool_ids: vec!["t-endmill".into()],
        });
        let preview = preview(&p, "j", Part::Pocket).unwrap();
        assert_eq!(preview.problems, []);
        assert_eq!(preview.built.file_name, "Test-board-Op.cnc");
        let map = &preview.map;
        let shape = rectangle();
        for iy in 0..map.ny {
            for ix in 0..map.nx {
                let q = map.centre(ix, iy);
                let z = map.at(ix, iy) as f64;
                let edge = shape.distance_to_boundary(q);
                if shape.contains(q) && edge > 1.6 {
                    assert!((z + 2.5).abs() < 1e-4, "not at depth at {q:?}: {z}");
                } else if !shape.contains(q) && edge > map.cell {
                    assert_eq!(z, 0.0, "cut outside the shape at {q:?}");
                }
            }
        }
        // The corners the tool cannot reach are reported.
        assert!(preview
            .built
            .warnings
            .iter()
            .any(|w| w.contains("is not cut")));
        // Only inlays have a second part.
        assert!(build(&p, "j", Part::Plug).is_err());
    }

    #[test]
    fn facing_the_whole_stock_starts_above_the_surface_and_leaves_it_flat() {
        let mut p = op_project(Task::Facing {
            pattern: Pattern::Raster,
            direction: PassDirection::Longer,
            above: 2.0,
            above_auto: false,
            depth: 0.5,
            margin: 0.0,
            margin_auto: false,
            tool_id: Some("t-endmill".into()),
        });
        p.steps[0].region_ids = vec![];
        let preview = preview(&p, "j", Part::Pocket).unwrap();
        assert_eq!(preview.problems, []);
        // Every cell of the stock ends up at the depth.
        for z in &preview.map.z {
            assert!((*z + 0.5).abs() < 1e-4, "left at {z}");
        }
        let cuts = cuts(&preview.built);
        let top = cuts.iter().map(|q| q[2]).fold(f64::NEG_INFINITY, f64::max);
        let bottom = cuts.iter().map(|q| q[2]).fold(f64::INFINITY, f64::min);
        assert!(top > 1.0, "nothing is cut above the surface: {top}");
        assert!((bottom + 0.5).abs() < 1e-9);
        // Travel is above the wood that stands on the surface.
        let travel = preview
            .built
            .interpreted
            .segments
            .iter()
            .filter(|s| s.rapid && s.from[2] == s.to[2] && s.length() > 1.0)
            .map(|s| s.to[2])
            .fold(f64::INFINITY, f64::min);
        assert!(travel >= 7.0 - 1e-9, "travels at {travel}");
    }

    #[test]
    fn facing_over_shapes_covers_them_and_their_margin_only() {
        let p = op_project(Task::Facing {
            pattern: Pattern::Raster,
            direction: PassDirection::Longer,
            above: 3.0,
            above_auto: false,
            depth: 0.0,
            margin: 2.0,
            margin_auto: false,
            tool_id: Some("t-endmill".into()),
        });
        let built = build(&p, "j", Part::Pocket).unwrap();
        // The rectangle is 5..35 by 5..25; the area reaches 2 mm beyond it.
        let (mut low, mut high) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
        for q in cuts(&built) {
            for k in 0..2 {
                low[k] = low[k].min(q[k]);
                high[k] = high[k].max(q[k]);
            }
            assert!(q[2] >= -1e-9, "cut below the surface at {q:?}");
        }
        for (got, wanted) in low.iter().chain(&high).zip([3.0, 3.0, 37.0, 27.0]) {
            assert!(
                (got - wanted).abs() < 0.02,
                "the tool's centre went to {got}, not {wanted}"
            );
        }
        // A depth under 0 ends the cut that far above the surface.
        let mut proud = p.clone();
        proud.steps[0].task = Task::Facing {
            pattern: Pattern::Raster,
            direction: PassDirection::Longer,
            above: 3.0,
            above_auto: false,
            depth: -0.4,
            margin: 2.0,
            margin_auto: false,
            tool_id: Some("t-endmill".into()),
        };
        let built = build(&proud, "j", Part::Pocket).unwrap();
        let heights: Vec<f64> = cuts(&built).iter().map(|q| q[2]).collect();
        let lowest = heights.iter().copied().fold(f64::INFINITY, f64::min);
        let highest = heights.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        assert!((lowest - 0.4).abs() < 1e-9, "ends at {lowest}");
        // The plunge begins its feed 1 mm above the wood.
        assert!(highest <= 4.0 + 1e-9, "starts at {highest}");
        assert!(built
            .warnings
            .iter()
            .any(|w| w.contains("ends 0.4 mm above")));
        // Nothing to do at all is refused.
        let mut none = p.clone();
        none.steps[0].task = Task::Facing {
            pattern: Pattern::Raster,
            direction: PassDirection::Longer,
            above: 0.0,
            above_auto: false,
            depth: 0.0,
            margin: 0.0,
            margin_auto: false,
            tool_id: Some("t-endmill".into()),
        };
        assert!(build(&none, "j", Part::Pocket).unwrap_err()[0].contains("nothing to face"));
    }

    #[test]
    fn a_contour_keeps_the_tool_on_its_side_of_the_outline() {
        let shape = rectangle();
        for (side, inside, away) in [
            (Side::Outside, false, 1.5875),
            (Side::Inside, true, 1.5875),
            (Side::On, true, 0.0),
        ] {
            let p = op_project(Task::Contour {
                side,
                depth: Some(3.0),
                tabs: false,
                tool_id: Some("t-endmill".into()),
            });
            let preview = preview(&p, "j", Part::Pocket).unwrap();
            assert_eq!(preview.problems, []);
            assert_eq!(preview.built.stock.through, 0.0);
            let cuts = cuts(&preview.built);
            assert!(cuts.iter().any(|q| (q[2] + 3.0).abs() < 1e-9));
            for q in cuts {
                let xy = [q[0], q[1]];
                let edge = shape.distance_to_boundary(xy);
                // On its track, or 0.1 mm further from the wood that stays
                // while cutting down, before the edge is finished.
                assert!(
                    (edge - away).abs() < 0.01 || (away > 0.0 && (edge - away - 0.1).abs() < 0.01),
                    "{side:?}: {edge} from the outline"
                );
                if away > 0.0 {
                    assert_eq!(shape.contains(xy), inside, "{side:?}: wrong side at {xy:?}");
                }
                assert!(q[2] >= -3.0 - 1e-9);
            }
        }
    }

    #[test]
    fn a_contour_without_a_depth_goes_through_the_stock_and_can_leave_tabs() {
        let mut p = op_project(Task::Contour {
            side: Side::Outside,
            depth: None,
            tabs: true,
            tool_id: Some("t-endmill".into()),
        });
        p.base.thickness = 6.0;
        let preview = preview(&p, "j", Part::Pocket).unwrap();
        assert_eq!(preview.problems, []);
        assert_eq!(preview.built.stock.through, 0.2);
        let cuts = cuts(&preview.built);
        let bottom = cuts.iter().map(|q| q[2]).fold(f64::INFINITY, f64::min);
        assert!((bottom + 6.2).abs() < 1e-9, "bottom at {bottom}");
        let notes = preview.built.warnings.join(" | ");
        assert!(notes.contains("tabs 4 mm wide and 1 mm thick"), "{notes}");
        assert!(notes.contains("spoilboard"), "{notes}");
        // Tabs: level cuts 1.2 mm above the bottom of the cut.
        assert!(cuts.iter().any(|q| (q[2] + 5.0).abs() < 1e-9));

        // A depth of the whole stock or more is not a through cut by accident.
        p.steps[0].task = Task::Contour {
            side: Side::Outside,
            depth: Some(6.0),
            tabs: false,
            tool_id: Some("t-endmill".into()),
        };
        let reasons = build(&p, "j", Part::Pocket).unwrap_err().join(" | ");
        assert!(reasons.contains("through the stock"), "{reasons}");
    }

    #[test]
    fn a_chamfer_bevels_the_edge_to_its_width() {
        let width = 1.5;
        let tan = 30f64.to_radians().tan();
        for side in [Side::Outside, Side::Inside] {
            let p = op_project(Task::Chamfer {
                side,
                width,
                tip_clearance: DEFAULT_TIP_CLEARANCE,
                tool_id: Some("t-vbit".into()),
            });
            let preview = preview(&p, "j", Part::Pocket).unwrap();
            assert_eq!(preview.problems, []);
            let shape = rectangle();
            let map = &preview.map;
            let mut checked = 0;
            for iy in 0..map.ny {
                for ix in 0..map.nx {
                    let q = map.centre(ix, iy);
                    // Away from the corners, where the bevels of two edges meet.
                    if !(q[0] > 12.0 && q[0] < 28.0) {
                        continue;
                    }
                    // On the side of the outline where the wood stays.
                    if shape.contains(q) != (side == Side::Outside) {
                        continue;
                    }
                    let d = shape.distance_to_boundary(q);
                    let z = map.at(ix, iy) as f64;
                    let ideal = if d < width { -(width - d) / tan } else { 0.0 };
                    assert!(
                        (z - ideal).abs() < 0.15,
                        "{side:?}: {z} at {d} mm from the edge, wanted {ideal}"
                    );
                    checked += 1;
                }
            }
            assert!(checked > 1000);
        }
        // A bevel wider than the bit can cut is refused.
        let p = op_project(Task::Chamfer {
            side: Side::Outside,
            width: 6.0,
            tip_clearance: DEFAULT_TIP_CLEARANCE,
            tool_id: Some("t-vbit".into()),
        });
        let reasons = build(&p, "j", Part::Pocket).unwrap_err().join(" | ");
        assert!(reasons.contains("too narrow for a chamfer"), "{reasons}");
    }

    /// A pocket in the rectangle, a contour round it and a chamfer on it.
    fn three_ops() -> Project {
        let mut p = op_project(Task::Pocket {
            pattern: Pattern::Offset,
            direction: PassDirection::Longer,
            depth: 2.0,
            clearing_tool_ids: vec!["t-endmill".into()],
        });
        p.base.thickness = 6.0;
        p.steps[0].name = "Recess".into();
        let mut outline = p.steps[0].clone();
        outline.id = "c".into();
        outline.name = "Outline".into();
        outline.region_ids = vec![0, 1];
        outline.task = Task::Contour {
            side: Side::Outside,
            depth: None,
            tabs: true,
            tool_id: Some("t-endmill".into()),
        };
        let mut bevel = p.steps[0].clone();
        bevel.id = "v".into();
        bevel.name = "Bevel".into();
        bevel.task = Task::Chamfer {
            side: Side::Inside,
            width: 1.0,
            tip_clearance: DEFAULT_TIP_CLEARANCE,
            tool_id: Some("t-vbit".into()),
        };
        p.steps.push(outline);
        p.steps.push(bevel);
        p
    }

    #[test]
    fn several_steps_go_into_one_file_and_a_shared_tool_stays_in() {
        let p = three_ops();
        let ids = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        // Pocket then contour, both with the end mill: one tool, loaded once.
        let two = preview_combined(&p, &ids(&["j", "c"])).unwrap();
        assert_eq!(two.problems, []);
        assert_eq!(two.built.interpreted.tool_changes, [1]);
        assert_eq!(two.built.gcode.matches("M6").count(), 1);
        assert_eq!(two.built.file_name, "Test-board-stock.cnc");
        assert_eq!(two.built.stock.through, 0.2);
        assert!(two
            .built
            .warnings
            .iter()
            .any(|w| w.starts_with("Outline: ")));
        // The file cuts what the two files cut one after the other.
        let alone: f64 = ["j", "c"]
            .iter()
            .map(|id| build(&p, id, Part::Pocket).unwrap().stats.cutting_length)
            .sum();
        assert!((two.built.stats.cutting_length - alone).abs() < 1e-6);
        let lowest = two.map.z.iter().fold(f32::INFINITY, |a, b| a.min(*b));
        assert!((lowest + 6.2).abs() < 1e-4);

        // With the chamfer between them the end mill is loaded twice, under one number.
        let three = preview_combined(&p, &ids(&["j", "v", "c"])).unwrap();
        assert_eq!(three.problems, []);
        assert_eq!(three.built.interpreted.tool_changes, [1, 2, 1]);
        assert_eq!(three.built.stats.per_tool.len(), 2);

        // One step that cannot be built stops the file, and says which.
        let mut bad = p.clone();
        bad.steps[2].task = Task::Chamfer {
            side: Side::Inside,
            width: 1.0,
            tip_clearance: DEFAULT_TIP_CLEARANCE,
            tool_id: None,
        };
        let reasons = build_combined(&bad, &ids(&["j", "v"]))
            .unwrap_err()
            .join(" | ");
        assert!(reasons.starts_with("Bevel: "), "{reasons}");
        assert!(build_combined(&p, &[]).is_err());
    }

    #[test]
    fn a_file_warns_when_wood_above_the_surface_is_faced_after_other_steps() {
        let mut p = three_ops();
        p.steps[2].task = Task::Facing {
            pattern: Pattern::Raster,
            direction: PassDirection::Longer,
            above: 4.0,
            above_auto: false,
            depth: 0.0,
            margin: 3.0,
            margin_auto: false,
            tool_id: Some("t-endmill".into()),
        };
        let ids = vec!["j".to_string(), "v".to_string()];
        let built = build_combined(&p, &ids).unwrap();
        assert!(built.warnings[0].contains("standing above the surface"));
        // The end mill stays in, and crosses to the facing above that wood.
        assert_eq!(built.interpreted.tool_changes, [1]);
        let reversed = build_combined(&p, &["v".to_string(), "j".to_string()]).unwrap();
        assert!(!reversed
            .warnings
            .iter()
            .any(|w| w.contains("standing above")));
    }

    #[test]
    fn a_corner_rounding_bit_rounds_the_edge_to_its_radius() {
        use crate::tools::fixtures::fillet_bit;
        for side in [Side::Outside, Side::Inside] {
            let mut p = op_project(Task::Chamfer {
                side,
                // Ignored: the bit cuts its own radius.
                width: 0.5,
                tip_clearance: DEFAULT_TIP_CLEARANCE,
                tool_id: Some("t-fillet".into()),
            });
            p.tools.push(fillet_bit());
            let preview = preview(&p, "j", Part::Pocket).unwrap();
            assert_eq!(preview.problems, []);
            assert!(preview
                .built
                .gcode
                .contains("CR=3 SD=6 TD=2 FL=6 - radius mill"));
            let shape = rectangle();
            let map = &preview.map;
            let mut checked = 0;
            for iy in 0..map.ny {
                for ix in 0..map.nx {
                    let q = map.centre(ix, iy);
                    if !(q[0] > 12.0 && q[0] < 28.0) || shape.contains(q) != (side == Side::Outside)
                    {
                        continue;
                    }
                    let d = shape.distance_to_boundary(q);
                    let z = map.at(ix, iy) as f64;
                    // A quarter circle of radius 3 from the wall up to the surface.
                    let ideal = if d < 3.0 {
                        -3.0 + (9.0 - (3.0 - d) * (3.0 - d)).sqrt()
                    } else {
                        0.0
                    };
                    // Steep at the wall, so a cell's width counts for much there.
                    let slack = if d < 0.3 { 0.8 } else { 0.15 };
                    assert!(
                        (z - ideal).abs() < slack,
                        "{side:?}: {z} at {d} mm from the edge, wanted {ideal}"
                    );
                    checked += 1;
                }
            }
            assert!(checked > 1000);
        }
        // An end mill shapes no edges.
        let p = op_project(Task::Chamfer {
            side: Side::Outside,
            width: 1.0,
            tip_clearance: DEFAULT_TIP_CLEARANCE,
            tool_id: Some("t-endmill".into()),
        });
        let reasons = build(&p, "j", Part::Pocket).unwrap_err().join(" | ");
        assert!(
            reasons.contains("is not a V-bit or a corner-rounding bit"),
            "{reasons}"
        );
    }

    #[test]
    fn a_pocket_cut_side_to_side_matches_one_cut_in_rings() {
        let mut p = op_project(Task::Pocket {
            pattern: Pattern::Offset,
            direction: PassDirection::Longer,
            depth: 2.5,
            clearing_tool_ids: vec!["t-endmill".into()],
        });
        p.steps[0].region_ids = vec![0, 1];
        let rings = preview(&p, "j", Part::Pocket).unwrap();
        if let Task::Pocket { pattern, .. } = &mut p.steps[0].task {
            *pattern = Pattern::Raster;
        }
        let across = preview(&p, "j", Part::Pocket).unwrap();
        assert_eq!(across.problems, []);
        let (worst, share) = compare(&rings.map, &across.map, 0.05);
        assert!(
            share < 0.002,
            "{share} of the cells differ, by up to {worst} mm"
        );
        // Straight passes along X make up most of the cutting.
        let (mut level, mut all) = (0.0, 0.0);
        for s in across
            .built
            .interpreted
            .segments
            .iter()
            .filter(|s| !s.rapid)
        {
            all += s.length();
            if s.from[1] == s.to[1] && s.from[2] == s.to[2] {
                level += s.length();
            }
        }
        assert!(level > 0.5 * all, "{level} of {all} mm");
    }

    #[test]
    fn pocket_passes_run_the_way_that_is_asked_for() {
        // The test rectangle is wider than it is deep, so its longer side is X.
        let pocket = |direction| {
            let p = op_project(Task::Pocket {
                pattern: Pattern::Raster,
                direction,
                depth: 2.5,
                clearing_tool_ids: vec!["t-endmill".into()],
            });
            let preview = preview(&p, "j", Part::Pocket).unwrap();
            assert_eq!(preview.problems, []);
            // How far the level cuts travel along X only, and along Y only.
            let level = |axis: usize| {
                preview
                    .built
                    .interpreted
                    .segments
                    .iter()
                    .filter(|s| {
                        !s.rapid && s.from[2] == s.to[2] && s.from[1 - axis] == s.to[1 - axis]
                    })
                    .map(|s| (s.to[axis] - s.from[axis]).abs())
                    .sum::<f64>()
            };
            (level(0), level(1), preview.map)
        };
        let (x, y, longer) = pocket(PassDirection::Longer);
        assert!(
            x > 2.0 * y,
            "along the longer side: {x} along X, {y} along Y"
        );
        let (x2, y2, _) = pocket(PassDirection::X);
        assert_eq!((x2, y2), (x, y));
        let (x, y, across) = pocket(PassDirection::Y);
        assert!(y > 2.0 * x, "along Y: {x} along X, {y} along Y");
        // Either way the same wood is gone.
        let (worst, share) = compare(&longer, &across, 0.05);
        assert!(
            share < 0.002,
            "{share} of the cells differ, by up to {worst} mm"
        );

        // A file without a direction means the longer side, and one with it keeps it.
        let mut p = op_project(Task::Pocket {
            pattern: Pattern::Raster,
            direction: PassDirection::Y,
            depth: 2.5,
            clearing_tool_ids: vec!["t-endmill".into()],
        });
        let text = crate::project::project_to_file_json(&p);
        assert!(text.contains("\"direction\": \"y\""));
        assert_eq!(crate::project::project_from_file_json(&text).unwrap(), p);
        if let Task::Pocket { direction, .. } = &mut p.steps[0].task {
            *direction = PassDirection::Longer;
        }
        assert!(!crate::project::project_to_file_json(&p).contains("direction"));
    }

    #[test]
    fn a_chamfers_tip_clearance_moves_the_bit_and_not_the_bevel() {
        // A 60 degree V-bit with a pointed tip: its axis runs the clearance
        // from the edge, with the tip (width + clearance) / tan 30 deep.
        let tan = 30f64.to_radians().tan();
        let chamfer = |tip_clearance: f64| {
            let p = op_project(Task::Chamfer {
                side: Side::Outside,
                width: 1.5,
                tip_clearance,
                tool_id: Some("t-vbit".into()),
            });
            let preview = preview(&p, "j", Part::Pocket).unwrap();
            assert_eq!(preview.problems, []);
            let deepest = preview
                .built
                .interpreted
                .segments
                .iter()
                .map(|s| s.to[2])
                .fold(0.0, f64::min);
            assert!(
                (deepest + (1.5 + tip_clearance) / tan).abs() < 1e-3,
                "clearance {tip_clearance}: tip at {deepest}"
            );
            (p, preview.map)
        };
        let (p, usual) = chamfer(DEFAULT_TIP_CLEARANCE);
        let (wide, far) = chamfer(1.0);
        // The bevel on the wood that stays is the same.
        let shape = rectangle();
        for iy in 0..usual.ny {
            for ix in 0..usual.nx {
                let q = usual.centre(ix, iy);
                if shape.contains(q) {
                    let (a, b) = (usual.at(ix, iy), far.at(ix, iy));
                    assert!((a - b).abs() < 0.1, "{a} and {b} at {q:?}");
                }
            }
        }
        // The usual clearance is not written to a file, another is, and a
        // file without one means the usual.
        let text = crate::project::project_to_file_json(&p);
        assert!(!text.contains("tipClearance"));
        assert_eq!(crate::project::project_from_file_json(&text).unwrap(), p);
        let text = crate::project::project_to_file_json(&wide);
        assert!(text.contains("\"tipClearance\": 1.0"), "{text}");
        assert_eq!(crate::project::project_from_file_json(&text).unwrap(), wide);
    }

    #[test]
    fn facing_passes_run_the_way_that_is_asked_for() {
        // The test board is wider than it is deep, so the longer side is X.
        let facing = |direction| {
            let mut p = op_project(Task::Facing {
                pattern: Pattern::Raster,
                direction,
                above: 0.0,
                above_auto: false,
                depth: 0.5,
                margin: 0.0,
                margin_auto: false,
                tool_id: Some("t-endmill".into()),
            });
            p.steps[0].region_ids = vec![];
            let preview = preview(&p, "j", Part::Pocket).unwrap();
            assert_eq!(preview.problems, []);
            for z in &preview.map.z {
                assert!((*z + 0.5).abs() < 1e-4, "left at {z}");
            }
            // How far the level cuts travel along X, and along Y.
            let level = |axis: usize| {
                preview
                    .built
                    .interpreted
                    .segments
                    .iter()
                    .filter(|s| !s.rapid && s.from[2] == s.to[2])
                    .map(|s| (s.to[axis] - s.from[axis]).abs())
                    .sum::<f64>()
            };
            (level(0), level(1))
        };
        let (x, y) = facing(PassDirection::Longer);
        assert!(
            x > 5.0 * y,
            "along the longer side: {x} along X, {y} along Y"
        );
        assert_eq!(facing(PassDirection::X), (x, y));
        let (x, y) = facing(PassDirection::Y);
        assert!(y > 5.0 * x, "along Y: {x} along X, {y} along Y");

        // A file without a direction means the longer side, and one with it keeps it.
        let mut p = op_project(Task::Facing {
            pattern: Pattern::Raster,
            direction: PassDirection::Y,
            above: 0.0,
            above_auto: false,
            depth: 0.5,
            margin: 0.0,
            margin_auto: false,
            tool_id: Some("t-endmill".into()),
        });
        let text = crate::project::project_to_file_json(&p);
        assert!(text.contains("\"direction\": \"y\""));
        assert_eq!(crate::project::project_from_file_json(&text).unwrap(), p);
        if let Task::Facing { direction, .. } = &mut p.steps[0].task {
            *direction = PassDirection::Longer;
        }
        assert!(!crate::project::project_to_file_json(&p).contains("direction"));
    }

    #[test]
    fn facing_goes_side_to_side_unless_rings_are_asked_for() {
        let facing = |pattern| {
            let mut p = op_project(Task::Facing {
                pattern,
                direction: PassDirection::Longer,
                above: 0.0,
                above_auto: false,
                depth: 0.5,
                margin: 0.0,
                margin_auto: false,
                tool_id: Some("t-endmill".into()),
            });
            p.steps[0].region_ids = vec![];
            preview(&p, "j", Part::Pocket).unwrap()
        };
        let across = facing(Pattern::Raster);
        let rings = facing(Pattern::Offset);
        for preview in [&across, &rings] {
            assert_eq!(preview.problems, []);
            for z in &preview.map.z {
                assert!((*z + 0.5).abs() < 1e-4, "left at {z}");
            }
        }
        // Side to side: the passes run along X, the stock's longer side, and
        // the tool goes down once.
        let cuts = &across.built.interpreted.segments;
        let along_y: f64 = cuts
            .iter()
            .filter(|s| !s.rapid && s.from[0] == s.to[0] && s.from[2] == s.to[2])
            .map(|s| s.length())
            .sum();
        let along_x: f64 = cuts
            .iter()
            .filter(|s| !s.rapid && s.from[1] == s.to[1] && s.from[2] == s.to[2])
            .map(|s| s.length())
            .sum();
        assert!(
            along_x > 20.0 * along_y,
            "{along_x} mm along X, {along_y} along Y"
        );
        // It comes down from above the surface once.
        let entries = cuts
            .iter()
            .filter(|s| !s.rapid && s.from[2] > 0.0 && s.to[2] < s.from[2])
            .count();
        assert_eq!(entries, 1);
    }

    #[test]
    fn curves_are_written_as_arcs() {
        // A disc of 30 mm in the middle of the board, as a flat pocket.
        let mut p = project();
        let circle: Vec<[f64; 2]> = (0..240)
            .map(|i| {
                let a = (i as f64 * 1.5).to_radians();
                [30.0 + 15.0 * a.cos(), 20.0 + 15.0 * a.sin()]
            })
            .collect();
        p.design.as_mut().unwrap().regions[0].outer = circle;
        p.steps[0].region_ids = vec![0];
        let preview = preview(&p, "j", Part::Pocket).unwrap();
        assert_eq!(preview.problems, []);
        let built = &preview.built;
        let arcs = built
            .gcode
            .lines()
            .filter(|l| l.starts_with("G2 ") || l.starts_with("G3 "))
            .count();
        assert!(arcs > 20, "{arcs} arcs");
        // Far fewer lines than the same moves written straight.
        let straight = carvera::write(&built.program).lines().count();
        assert!(
            (built.stats.lines as usize) < straight / 3,
            "{} lines against {straight}",
            built.stats.lines
        );
        // The same cutting, and the same pocket: round, 2 mm deep.
        let written: f64 = gcode::interpret(&carvera::write(&built.program))
            .unwrap()
            .cutting_length();
        assert!((built.stats.cutting_length - written).abs() < 2e-3 * written);
        let map = &preview.map;
        for iy in 0..map.ny {
            for ix in 0..map.nx {
                let q = map.centre(ix, iy);
                let d = ((q[0] - 30.0).powi(2) + (q[1] - 20.0).powi(2)).sqrt();
                let z = map.at(ix, iy) as f64;
                if d < 15.0 - 2.0 * map.cell {
                    assert!((z + 2.0).abs() < 1e-4, "{z} at {d} mm from the middle");
                } else if d > 15.05 + 2.0 * map.cell {
                    assert_eq!(z, 0.0, "cut {d} mm from the middle");
                }
            }
        }
    }

    #[test]
    fn walls_are_left_for_one_pass_at_the_end_and_come_out_the_same() {
        let finished = preview(&project(), "j", Part::Pocket).unwrap();
        let mut plain = project();
        plain.setup.finish_allowance = 0.0;
        let unfinished = preview(&plain, "j", Part::Pocket).unwrap();
        assert_eq!(finished.problems, []);
        // The same pocket either way.
        let (worst, share) = compare(&finished.map, &unfinished.map, 0.05);
        assert!(
            share < 0.002,
            "{share} of the cells differ, by up to {worst} mm"
        );
        assert_eq!(finished.built.cuttable, unfinished.built.cuttable);
        // With the allowance, clearing keeps 0.1 mm from the walls until the
        // floor is reached; only the pass at full depth touches them.
        let wanted = &finished.built.pocket;
        let reach = |q: [f64; 3]| {
            wanted
                .iter()
                .map(|r| r.distance_to_boundary([q[0], q[1]]))
                .fold(f64::INFINITY, f64::min)
        };
        let radius = 3.175 / 2.0;
        let (mut at_wall, mut short) = (0, 0);
        for s in finished
            .built
            .interpreted
            .segments
            .iter()
            .filter(|s| !s.rapid)
        {
            let d = reach(s.to);
            if d < radius + 0.05 {
                at_wall += 1;
                // The way down to the floor is a ramp along the wall: its
                // steps are not level cuts, though the shortest round to one height.
                if s.to[2] > -2.0 + 1e-6 && s.from[2] == s.to[2] && s.length() > 0.05 {
                    short += 1;
                }
            }
        }
        assert!(at_wall > 20);
        assert_eq!(short, 0, "level cuts along the wall above the floor");
        // Without it, every depth pass runs along the walls.
        let passes_at_wall = unfinished
            .built
            .interpreted
            .segments
            .iter()
            .filter(|s| {
                !s.rapid
                    && s.from[2] == s.to[2]
                    && s.to[2] > -2.0 + 1e-6
                    && reach(s.to) < radius + 0.05
            })
            .count();
        assert!(passes_at_wall > 20);
    }

    #[test]
    fn relief_keeps_a_tip_flat_from_holding_the_plug_up() {
        // The same inlay as in "fit shows what a tip flat costs", where the
        // plug's corner edges ride on the pocket's rounded corners.
        let mut p = vcarve_project(true);
        let before = check_fit(&p, "j").unwrap().fit.report;
        if let Task::Vcarve { relief, .. } = &mut p.steps[0].task {
            *relief = true;
        }
        let check = check_fit(&p, "j").unwrap();
        assert_eq!(check.plug.problems, []);
        let after = &check.fit.report;
        assert!(
            after.press_overlap_area < 0.5 * before.press_overlap_area,
            "{} mm² in the way against {}",
            after.press_overlap_area,
            before.press_overlap_area
        );
        assert!(after.proud <= before.proud + 1e-9);
        // The face is as it was: the cut stays below it.
        assert!(after.void_width < 0.1, "void {}", after.void_width);
        assert!((after.void_area - before.void_area).abs() < 0.05);
        // The file says so, and the V-bit does the cutting.
        let notes = check.plug.built.warnings.join(" | ");
        assert!(notes.contains("cut back along"), "{notes}");
        let plain = build(&vcarve_project(true), "j", Part::Plug).unwrap();
        assert!(check.plug.built.stats.cutting_length > plain.stats.cutting_length);
        assert_eq!(check.plug.built.stats.tools, plain.stats.tools);
    }

    #[test]
    fn a_vcarves_finer_points_change_the_cut_and_the_check() {
        // No end mill: the V-bit clears the flat floor itself.
        let usual = vcarve_project(false);
        let before = preview(&usual, "j", Part::Pocket).unwrap();
        assert!(!before.built.warnings.iter().any(|w| w.contains("apart")));

        // A lower ridge puts the passes on the floor closer, and says so.
        let mut fine = usual.clone();
        if let Task::Vcarve { tuning, .. } = &mut fine.steps[0].task {
            tuning.floor_ridge = 0.02;
        }
        let after = preview(&fine, "j", Part::Pocket).unwrap();
        assert!(
            after.built.stats.cutting_length > 1.2 * before.built.stats.cutting_length,
            "{} mm, was {} mm",
            after.built.stats.cutting_length,
            before.built.stats.cutting_length
        );
        let said = after.built.warnings.join(" | ");
        assert!(
            said.contains("0.02 mm") && said.contains("Finer points"),
            "{said}"
        );

        // The face is judged where the inlay says.
        let mut deep = usual.clone();
        if let Task::Vcarve { tuning, .. } = &mut deep.steps[0].task {
            tuning.trim_depth = 0.4;
        }
        assert_eq!(check_fit(&usual, "j").unwrap().fit.report.trim_depth, 0.1);
        assert_eq!(check_fit(&deep, "j").unwrap().fit.report.trim_depth, 0.4);

        // A tool change counts for what the machine says it takes.
        assert_eq!(before.built.stats.tool_change_minutes, 0.0);
        let mut timed = usual.clone();
        timed.machine.tool_change_seconds = 90.0;
        let stats = preview(&timed, "j", Part::Pocket).unwrap().built.stats;
        assert_eq!(stats.tool_change_minutes, 1.5 * stats.tool_changes as f64);
        assert_eq!(stats.minutes, before.built.stats.minutes);
    }
}
