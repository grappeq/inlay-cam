//! Turns an inlay job into a G-code file, and simulates that file.
//!
//! This is the whole pipeline in one place: geometry -> moves -> G-code text
//! -> interpreted moves -> simulated stock.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::analysis::{self, Fit, PlugFrame};
use crate::gcode::{self, Interpreted};
use crate::geom::boolean::{difference, union};
use crate::geom::offset::{offset, total_area};
use crate::geom::{distance, Point, Region};
use crate::ops::clear::{clear, ClearError, ClearParams};
use crate::ops::vcarve::{narrow_parts, vcarve, vcarve_plug, VcarveParams};
use crate::post::carvera;
use crate::project::{Inlay, Job, Project};
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

impl Part {
    fn name(self) -> &'static str {
        match self {
            Part::Pocket => "pocket",
            Part::Plug => "plug",
        }
    }
}

/// The board a part is cut from. The work origin is its bottom-left corner
/// and Z0 its top face.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stock {
    pub width: f64,
    pub height: f64,
    pub thickness: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Built {
    pub part: Part,
    pub stock: Stock,
    /// Stretches of the design, as it sits on the base board, too narrow for
    /// the plug to seat. V-carve inlays only.
    pub narrow: Vec<[Point; 2]>,
    pub file_name: String,
    pub gcode: String,
    pub stats: Stats,
    /// Things worth knowing that do not stop the job.
    pub warnings: Vec<String>,
    /// For a plug: where its blank lies on the base board once turned over.
    #[serde(skip)]
    pub frame: Option<PlugFrame>,
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
        (Part::Plug, Inlay::Flat { .. }) => {
            return Err(vec![
                "The insert of a flat inlay cannot be generated yet.".into()
            ])
        }
    };

    let mut errors: Vec<String> = Vec::new();
    let warnings: Vec<String> = Vec::new();

    let regions = union(&design.placed_regions(&job.region_ids));
    if regions.is_empty() {
        errors.push("The inlay has no shapes. Click shapes in the drawing to add them.".into());
    }
    if depth >= thickness {
        errors.push(match part {
            Part::Pocket => format!(
                "The pocket is {} mm deep but the base board is only {} mm thick.",
                num(depth),
                num(thickness)
            ),
            Part::Plug => format!(
                "The plug is cut {} mm deep but the plug blank is only {} mm thick.",
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
        (_, Inlay::Flat { tool_id, .. }) => flat_pocket(&mut ctx, &regions, tool_id.as_deref()),
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
            clearing_tool_ids.first().map(String::as_str),
            vbit_tool_id.as_deref(),
        ),
        (
            Part::Plug,
            Inlay::Vcarve {
                engagement_depth,
                saw_gap,
                plug_margin,
                clearing_tool_ids,
                vbit_tool_id,
                ..
            },
        ) => vcarve_plug_cut(
            &mut ctx,
            &regions,
            PlugShape {
                engagement: *engagement_depth,
                saw_gap: *saw_gap,
                margin: *plug_margin,
            },
            clearing_tool_ids.first().map(String::as_str),
            vbit_tool_id.as_deref(),
        ),
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
        name: format!("{} - {} - {}", project.name, job.name, part.name()),
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
                part.name(),
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
        },
        narrow,
        frame,
        file_name: format!(
            "{}.{}",
            file_stem(&format!("{} {} {}", project.name, job.name, part.name())),
            carvera::FILE_EXTENSION
        ),
        stats: Stats {
            lines: interpreted.lines,
            cutting_length: interpreted.cutting_length(),
            minutes: interpreted.minutes(machine.rapid_rate),
            tools: program.tools.iter().map(|t| t.tool.name.clone()).collect(),
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
struct Cut {
    tools: Vec<ProgramTool>,
    moves: Vec<Move>,
    pocket: Vec<Region>,
    /// Size of the board when it is not the base board.
    board: Option<(f64, f64)>,
    /// For a plug: where its blank lies on the base board once turned over.
    frame: Option<PlugFrame>,
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

/// A flat-floored pocket with upright walls, cut with one end mill.
fn flat_pocket(ctx: &mut Context, regions: &[Region], tool_id: Option<&str>) -> Option<Cut> {
    let (tool, cutting) = ctx.tool(tool_id, ToolKind::FlatEnd, "an end mill")?;
    if !ctx.errors.is_empty() {
        return None;
    }

    let number = carvera::FIRST_TOOL_NUMBER;
    let mut path = PathBuilder::new(SAFE_Z);
    path.start_tool(number, cutting.rpm);
    let pocket = match clear(&mut path, regions, &clear_params(tool, cutting, ctx.depth)) {
        Ok(pocket) => pocket,
        Err(ClearError::ToolTooWide) => {
            ctx.errors.push(format!(
                "\"{}\" ({} mm) is too wide to fit inside any of the selected shapes.",
                tool.name,
                num(tool.diameter)
            ));
            return None;
        }
    };

    let (wanted, reached) = (total_area(regions), total_area(&pocket));
    if wanted - reached > 0.005 * wanted {
        ctx.warnings.push(format!(
            "The tool cannot reach {} mm² of the shape ({}%): inside corners are rounded to its {} mm radius, and parts narrower than {} mm are left uncut.",
            num(((wanted - reached) * 10.0).round() / 10.0),
            num(((wanted - reached) / wanted * 1000.0).round() / 10.0),
            num(tool.diameter / 2.0),
            num(tool.diameter)
        ));
    }
    Some(Cut {
        tools: vec![ProgramTool {
            number,
            tool: tool.clone(),
        }],
        moves: path.finish(),
        pocket,
        board: None,
        frame: None,
    })
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
    end_mill: Option<(&'a Tool, &'a CuttingSettings)>,
    params: VcarveParams,
}

/// Looks up and checks the tools of a V-carve job. `flat_depth` is how far the
/// floor is below the level where the outline is met; `ctx.depth` is how far
/// it is below the surface.
fn vcarve_setup<'a>(
    ctx: &mut Context<'a>,
    flat_depth: f64,
    end_mill_id: Option<&str>,
    vbit_id: Option<&str>,
) -> Option<VcarveSetup<'a>> {
    let vbit = ctx.tool(vbit_id, ToolKind::VBit, "a V-bit");
    let end_mill = match end_mill_id {
        Some(id) => Some(ctx.tool(Some(id), ToolKind::FlatEnd, "an end mill")?),
        None => None,
    };
    let (vbit, vcutting) = vbit?;
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
        end_mill,
        params,
    })
}

/// Clears `floor` with the end mill when one is chosen and fits, then loads
/// the V-bit. Returns the floor the end mill cut and the tools used so far;
/// the V-bit is the last of them.
fn clear_floor_then_load_vbit(
    ctx: &mut Context,
    setup: &VcarveSetup,
    path: &mut PathBuilder,
    floor: &[Region],
    whose: &str,
) -> (Vec<Region>, Vec<ProgramTool>) {
    let mut number = carvera::FIRST_TOOL_NUMBER;
    let mut tools = Vec::new();
    let mut cleared = Vec::new();
    match setup.end_mill {
        Some((tool, cutting)) if !offset(floor, -tool.diameter / 2.0).is_empty() => {
            path.start_tool(number, cutting.rpm);
            cleared =
                clear(path, floor, &clear_params(tool, cutting, ctx.depth)).unwrap_or_default();
            tools.push(ProgramTool {
                number,
                tool: tool.clone(),
            });
            number += 1;
        }
        Some((tool, _)) if !floor.is_empty() => ctx.warnings.push(format!(
            "\"{}\" is too wide for the {whose} flat floor, so it is not used: the V-bit clears the floor on its own.",
            tool.name
        )),
        None if !floor.is_empty() => ctx.warnings.push(format!(
            "No end mill is chosen, so the V-bit clears the {whose} flat floor on its own, which takes much longer."
        )),
        _ => {}
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
    end_mill_id: Option<&str>,
    vbit_id: Option<&str>,
) -> Option<Cut> {
    let setup = vcarve_setup(ctx, ctx.depth, end_mill_id, vbit_id)?;
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
        frame: None,
    })
}

struct PlugShape {
    engagement: f64,
    saw_gap: f64,
    margin: f64,
}

/// The plug of a V-carve inlay: the shapes mirrored, left standing in a blank
/// that is otherwise cut down to a flat floor. Turned over, the shapes go
/// `engagement` deep into the pocket and the floor ends up `saw_gap` above
/// the base board.
fn vcarve_plug_cut(
    ctx: &mut Context,
    regions: &[Region],
    plug: PlugShape,
    end_mill_id: Option<&str>,
    vbit_id: Option<&str>,
) -> Option<Cut> {
    let setup = vcarve_setup(ctx, plug.saw_gap, end_mill_id, vbit_id)?;
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
    ctx.warnings.push(format!(
        "The tools cut right up to the edges of the plug blank, and the V-bit's flank passes up to {} mm beyond them. Keep clamps and stops clear, and do not use a blank larger than {} × {} mm unless you trim it to that size afterwards.",
        num((p.radius_at(ctx.depth) * 10.0).ceil() / 10.0),
        num((width * 100.0).round() / 100.0),
        num((height * 100.0).round() / 100.0)
    ));
    Some(Cut {
        tools,
        moves: path.finish(),
        pocket: shapes,
        board: Some((width, height)),
        frame: Some(PlugFrame {
            mirror_x: x1 + plug.margin,
            offset_y: y0 - plug.margin,
        }),
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
    } = built.stock;
    let tools: HashMap<u32, Tool> = built
        .program
        .tools
        .iter()
        .map(|t| (t.number, t.tool.clone()))
        .collect();
    let cell = HeightMap::cell_for(width, height, 2_000_000.0, 0.05);
    // Simulate what the file says, read back from its text.
    let simulation = sim::simulate(&built.interpreted, &tools, width, height, thickness, cell);
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
        return Err(vec!["The fit of a flat inlay cannot be checked yet.".into()]);
    };
    let pocket = preview(project, job_id, Part::Pocket)?;
    let plug = preview(project, job_id, Part::Plug)?;
    let frame = plug.built.frame.expect("a plug has a frame");
    let fit = analysis::fit(
        &pocket.map,
        &plug.map,
        frame,
        *engagement_depth,
        engagement_depth + glue_gap,
    )
    .ok_or_else(|| vec!["The plug does not lie over the base board at all.".to_string()])?;
    Ok(FitCheck { fit, pocket, plug })
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
    use crate::geom::offset::open;
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
                    tool_id: Some("t-endmill".into()),
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

        let design = project.design.as_ref().unwrap();
        let wanted = union(&design.placed_regions(&[0, 1]));
        let reachable = open(&wanted, 3.175 / 2.0);
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
    fn warns_about_corners_the_tool_cannot_reach() {
        let built = build_pocket(&project(), "j").unwrap();
        assert!(
            built
                .warnings
                .iter()
                .any(|w| w.contains("cannot reach") && w.contains("mm radius")),
            "{:?}",
            built.warnings
        );
    }

    #[test]
    fn explains_every_reason_a_job_cannot_be_built() {
        let reasons = |p: &Project| build_pocket(p, "j").unwrap_err().join(" | ");

        let p = with_inlay(Inlay::Flat {
            pocket_depth: 2.0,
            allowance: 0.1,
            tabs: false,
            tool_id: None,
        });
        assert!(reasons(&p).contains("Choose an end mill"));

        let p = with_inlay(Inlay::Flat {
            pocket_depth: 2.0,
            allowance: 0.1,
            tabs: false,
            tool_id: Some("t-vbit".into()),
        });
        assert!(reasons(&p).contains("is not an end mill"));

        let p = with_inlay(Inlay::Flat {
            pocket_depth: 25.0,
            allowance: 0.1,
            tabs: false,
            tool_id: Some("t-endmill".into()),
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
        let r = 3.175 / 2.0;
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
                thickness: 8.0
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
        assert!(reasons(&p).contains("plug blank is only 3 mm thick"));

        assert!(reasons(&project()).contains("cannot be generated yet"));
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

    #[test]
    fn file_names_are_safe_for_the_machine() {
        assert_eq!(file_stem("Żółw / coaster #2 (final)"), "w-coaster-2-final");
        assert_eq!(file_stem("???"), "inlay");
    }
}
