//! The stock step by step: what the list of inlays and operations leaves of
//! it, in the order of the list.
//!
//! A file on its own is simulated on a fresh block. Here one block goes
//! through every step: a step with a file cuts it as the step before left
//! it, and a glue-up puts the wood of a plug or of inserts on it. That wood
//! is then there for the steps that follow, to be faced off, cut into, or
//! run into.

use std::collections::HashMap;

use serde::Serialize;

use crate::analysis::PlugFrame;
use crate::build::{self, Built, Part, Preview};
use crate::gcode::Segment;
use crate::geom::{Point, Region};
use crate::project::{InsertStyle, Project, Step, Task};
use crate::sim::{self, HeightMap, SimProblem};
use crate::tools::Tool;

/// Most cells per side of the stock as it is handed out for drawing. The
/// steps are simulated on the finer grid a single file is simulated on.
pub const DISPLAY_CELLS: usize = 600;

/// A glued-in part rests this much higher than designed, mm, before the
/// step says so. Less is what a V-bit's tip flat leaves in sharp corners,
/// which gives when the plug is pressed in.
pub const PROUD: f64 = 0.25;

/// Wood thinner than this, mm, is not there.
const SLIVER: f32 = 1e-4;

/// The wood one glue-up put on the stock: a plug, or the inserts of one
/// inlay. Kept over the cells of a window of the stock's grid.
#[derive(Debug, Clone, PartialEq)]
struct Body {
    /// The window's first cell and its size, in cells.
    x0: usize,
    y0: usize,
    w: usize,
    h: usize,
    /// The wood's underside per cell of the window, in the stock's Z. NaN
    /// where it has no wood.
    under: Vec<f32>,
    /// The stock's surface under it when it was glued in.
    floor: Vec<f32>,
}

/// The stock as the steps so far have left it.
#[derive(Debug, Clone, PartialEq)]
pub struct Workpiece {
    /// Its top surface.
    pub map: HeightMap,
    /// Whose wood the surface is in at each cell: 0 for the stock's own, or
    /// the number of a glue-up, counted from 1 in the order they were done.
    pub owner: Vec<u8>,
    bodies: Vec<Body>,
}

impl Workpiece {
    fn new(width: f64, height: f64, cell: f64) -> Self {
        let map = HeightMap::new(width, height, cell);
        let owner = vec![0; map.z.len()];
        Self {
            map,
            owner,
            bodies: Vec::new(),
        }
    }

    /// Puts wood on the stock: `under` and `top` per cell of the window
    /// from cell (`x0`, `y0`), `w` cells wide; NaN in `under` where there is
    /// none.
    fn glue(&mut self, x0: usize, y0: usize, w: usize, under: Vec<f32>, top: &[f32]) {
        let h = under.len() / w.max(1);
        let number = self.bodies.len() as u8 + 1;
        let mut floor = vec![f32::NAN; under.len()];
        for j in 0..h {
            for i in 0..w {
                let (k, cell) = (j * w + i, (y0 + j) * self.map.nx + x0 + i);
                if !under[k].is_nan() {
                    floor[k] = self.map.z[cell];
                    self.map.z[cell] = top[k];
                    self.owner[cell] = number;
                }
            }
        }
        self.bodies.push(Body {
            x0,
            y0,
            w,
            h,
            under,
            floor,
        });
    }

    /// After a cut: finds whose wood the surface is now in. Where a cut went
    /// right through glued-in wood, the surface is what lies under it.
    fn settle(&mut self) {
        self.owner.fill(0);
        // From the last glue-up down: what was glued in later lies on top.
        for (b, body) in self.bodies.iter().enumerate().rev() {
            for j in 0..body.h {
                for i in 0..body.w {
                    let (k, cell) = (j * body.w + i, (body.y0 + j) * self.map.nx + body.x0 + i);
                    if body.under[k].is_nan() || self.owner[cell] != 0 {
                        continue;
                    }
                    if self.map.z[cell] > body.under[k] + SLIVER {
                        self.owner[cell] = b as u8 + 1;
                    } else {
                        self.map.z[cell] = self.map.z[cell].min(body.floor[k]);
                    }
                }
            }
        }
    }

    /// The cells of the grid that lie within the rectangle, as a window:
    /// first cell and size.
    fn window(&self, [x0, y0, x1, y1]: [f64; 4]) -> Option<(usize, usize, usize, usize)> {
        let cell = self.map.cell;
        let first = |v: f64| (v / cell).floor().max(0.0) as usize;
        let end = |v: f64, n: usize| ((v / cell).ceil().max(0.0) as usize).min(n);
        let (ix0, iy0) = (first(x0), first(y0));
        let (ix1, iy1) = (end(x1, self.map.nx), end(y1, self.map.ny));
        (ix1 > ix0 && iy1 > iy0).then(|| (ix0, iy0, ix1 - ix0, iy1 - iy0))
    }

    /// The stock thinned for drawing: of each block of cells the deepest,
    /// so that narrow cuts stay visible, with whose wood that cell is in.
    fn snapshot(&self, stride: usize) -> Snapshot {
        let (nx, ny) = (self.map.nx, self.map.ny);
        let (dx, dy) = (nx.div_ceil(stride), ny.div_ceil(stride));
        let mut heights = Vec::with_capacity(dx * dy);
        let mut owners = Vec::with_capacity(dx * dy);
        for j in 0..dy {
            for i in 0..dx {
                let mut lowest = (f32::INFINITY, 0);
                for jj in j * stride..((j + 1) * stride).min(ny) {
                    for ii in i * stride..((i + 1) * stride).min(nx) {
                        let cell = jj * nx + ii;
                        if self.map.z[cell] < lowest.0 {
                            lowest = (self.map.z[cell], self.owner[cell]);
                        }
                    }
                }
                heights.push(lowest.0);
                owners.push(lowest.1);
            }
        }
        Snapshot { heights, owners }
    }
}

/// How a glued-in part sits. Heights in mm, in the stock's Z.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Seat {
    /// Where the part's face rests: the face of a plug's blank, turned
    /// down, or the underside of the highest insert.
    pub height: f64,
    /// How much higher that is than designed.
    pub proud: f64,
    /// How far the part stands above the stock's surface.
    pub above: f64,
}

/// One entry of the list, as it went.
#[derive(Debug, Clone, PartialEq)]
pub struct StepRun {
    pub step_id: String,
    /// Done by hand: there is no file.
    pub by_hand: bool,
    /// The file the step is cut by: an index into [`Timeline::files`].
    pub file: Option<usize>,
    /// The step's stretch of that file, as it was run on the stock. Its
    /// lines and tool numbers are the file's.
    pub segments: Vec<Segment>,
    /// Problems found while cutting the stock as it was, each with its
    /// G-code line.
    pub problems: Vec<SimProblem>,
    /// Why the step could not be done. The stock is then left as it was.
    pub errors: Vec<String>,
    /// Things worth knowing about how the step went.
    pub warnings: Vec<String>,
    /// A glue-up: how the part sits.
    pub seat: Option<Seat>,
}

impl StepRun {
    fn of(step: &Step, file: Option<usize>) -> Self {
        StepRun {
            step_id: step.id.clone(),
            by_hand: step.task.is_by_hand(),
            file,
            segments: Vec::new(),
            problems: Vec::new(),
            errors: Vec::new(),
            warnings: Vec::new(),
            seat: None,
        }
    }
}

/// One file for the stock: the entries of the list from one step done by
/// hand to the next, which is where the machine stops anyway.
#[derive(Debug, Clone, PartialEq)]
pub struct StockFile {
    /// The ids of its entries, in the order they are cut.
    pub step_ids: Vec<String>,
    /// The file. `None` when nothing of it could be made.
    pub built: Option<Built>,
    /// Every one of its entries is in the file. A file that lacks one is
    /// still run on the stock, to show the rest, but is not one to cut with.
    pub complete: bool,
    /// Why the file could not be put together.
    pub errors: Vec<String>,
    /// Problems found while it cut the stock as it was, each with its
    /// G-code line.
    pub problems: Vec<SimProblem>,
}

/// The second file of an task: its plug or its inserts, cut from a board of
/// their own.
#[derive(Debug, Clone, PartialEq)]
pub struct PartFile {
    /// The id of the inlay.
    pub step_id: String,
    /// The file. `None` when it could not be made.
    pub built: Option<Built>,
    /// Why it could not be made.
    pub errors: Vec<String>,
    /// Problems found while simulating it on its own board.
    pub problems: Vec<SimProblem>,
}

/// The stock at one point of the list, thinned for drawing.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    /// Height per cell, row by row from Y = 0.
    pub heights: Vec<f32>,
    /// Whose wood each cell is in: 0 for the stock's own, else the number
    /// of an entry of [`Timeline::glued`], counted from 1.
    pub owners: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Timeline {
    /// The grid the snapshots are on.
    pub cell: f64,
    pub nx: usize,
    pub ny: usize,
    /// The cell size the steps were simulated at, mm.
    pub simulated_cell: f64,
    pub thickness: f64,
    /// The ids of the inlays that were glued in, in the order of their
    /// glue-ups.
    pub glued: Vec<String>,
    /// The files for the stock, in the order they are run.
    pub files: Vec<StockFile>,
    pub steps: Vec<StepRun>,
    /// The plug or insert file of every inlay, in the order of the list.
    pub parts: Vec<PartFile>,
    /// The fresh stock, then the stock after each step.
    pub snapshots: Vec<Snapshot>,
}

/// Takes the stock through every inlay and operation of the project, in the
/// order of the list. The entries between two steps done by hand are one
/// file, and it is that file that cuts the stock. A step that cannot be done
/// says why and leaves the stock as it was; the steps after it go on from
/// there.
pub fn timeline(project: &Project) -> Result<Timeline, Vec<String>> {
    let design = project
        .design
        .as_ref()
        .ok_or_else(|| vec!["The project has no design.".to_string()])?;
    let (width, height) = design.placed_size();
    let simulated_cell = HeightMap::cell_for(width, height, 2_000_000.0, 0.05);
    let mut stock = Workpiece::new(width, height, simulated_cell);
    let stride = stock
        .map
        .nx
        .max(stock.map.ny)
        .div_ceil(DISPLAY_CELLS)
        .max(1);
    let several = file_numbers(project).iter().flatten().max() > Some(&1);

    // Every inlay's plug or inserts, simulated on their own board: what a
    // glue-up puts on the stock, and a file to cut either way.
    let mut plugs: HashMap<&str, Result<Preview, Vec<String>>> = project
        .steps
        .iter()
        .filter(|step| step.task.is_inlay())
        .map(|step| {
            (
                step.id.as_str(),
                build::preview(project, &step.id, Part::Plug),
            )
        })
        .collect();

    let mut glued: Vec<String> = Vec::new();
    let mut files: Vec<StockFile> = Vec::new();
    let mut steps: Vec<StepRun> = Vec::new();
    let mut snapshots = vec![stock.snapshot(stride)];
    // The entries since the last step done by hand.
    let mut run: Vec<&Step> = Vec::new();
    for index in 0..=project.steps.len() {
        let step = project.steps.get(index);
        if let Some(step) = step.filter(|j| !j.task.is_by_hand()) {
            run.push(step);
            continue;
        }
        if !run.is_empty() {
            let label = if several {
                format!("stock {}", files.len() + 1)
            } else {
                "stock".to_string()
            };
            let (file, cut) = cut_run(project, &mut stock, &run, &label, files.len(), stride);
            files.push(file);
            for (went, snapshot) in cut {
                steps.push(went);
                snapshots.push(snapshot);
            }
            run.clear();
        }
        let Some(step) = step else { break };
        let Task::Glue { inlay_id } = &step.task else {
            continue;
        };
        let mut went = StepRun::of(step, None);
        let later = project.steps[index..].iter().any(|j| &j.id == inlay_id);
        match glue(
            project,
            &mut stock,
            inlay_id,
            glued.contains(inlay_id),
            &plugs,
        ) {
            Ok(seat) => {
                glued.push(inlay_id.clone());
                let name = name_of(project, inlay_id);
                if later {
                    went.warnings.push(format!(
                        "The pocket of \"{name}\" is cut later in the list, so there is nothing to glue into yet. Move this step below it."
                    ));
                } else if seat.proud > PROUD {
                    went.warnings.push(format!(
                        "It rests {} mm higher than designed: something on the stock holds it up.",
                        num(seat.proud)
                    ));
                }
                went.seat = Some(seat);
            }
            Err(errors) => went.errors = errors,
        }
        steps.push(went);
        snapshots.push(stock.snapshot(stride));
    }

    let parts = project
        .steps
        .iter()
        .filter_map(|step| {
            let part = plugs.remove(step.id.as_str())?;
            Some(match part {
                Ok(preview) => PartFile {
                    step_id: step.id.clone(),
                    built: Some(preview.built),
                    errors: Vec::new(),
                    problems: preview.problems,
                },
                Err(errors) => PartFile {
                    step_id: step.id.clone(),
                    built: None,
                    errors,
                    problems: Vec::new(),
                },
            })
        })
        .collect();

    Ok(Timeline {
        cell: simulated_cell * stride as f64,
        nx: stock.map.nx.div_ceil(stride),
        ny: stock.map.ny.div_ceil(stride),
        simulated_cell,
        thickness: project.base.thickness,
        glued,
        files,
        steps,
        parts,
        snapshots,
    })
}

/// Which file for the stock each entry of the list goes into, counted from
/// 1: the entries from one step done by hand to the next share a file.
/// `None` for a step done by hand.
pub fn file_numbers(project: &Project) -> Vec<Option<usize>> {
    let (mut number, mut open) = (0, false);
    project
        .steps
        .iter()
        .map(|step| {
            if step.task.is_by_hand() {
                open = false;
                return None;
            }
            if !open {
                number += 1;
                open = true;
            }
            Some(number)
        })
        .collect()
}

/// Makes the one file of a run of entries and cuts the stock with it, entry
/// by entry. Returns the file, and each entry as it went with the stock
/// after it.
fn cut_run(
    project: &Project,
    stock: &mut Workpiece,
    run: &[&Step],
    label: &str,
    file: usize,
    stride: usize,
) -> (StockFile, Vec<(StepRun, Snapshot)>) {
    let parts: Vec<Result<Built, Vec<String>>> = run
        .iter()
        .map(|step| build::build(project, &step.id, Part::Pocket))
        .collect();
    let good: Vec<(&str, &Built)> = run
        .iter()
        .zip(&parts)
        .filter_map(|(step, part)| part.as_ref().ok().map(|built| (step.name.as_str(), built)))
        .collect();
    let mut record = StockFile {
        step_ids: run.iter().map(|step| step.id.clone()).collect(),
        built: None,
        complete: good.len() == parts.len(),
        errors: Vec::new(),
        problems: Vec::new(),
    };
    let tools_of = |built: &Built| -> HashMap<u32, Tool> {
        built
            .program
            .tools
            .iter()
            .map(|t| (t.number, t.tool.clone()))
            .collect()
    };

    // What each part that could be made cuts the stock with: its stretch of
    // the joined file, or its own file when they could not be joined.
    let mut stretches: Vec<(Vec<Segment>, HashMap<u32, Tool>, f64)> = Vec::new();
    match (!good.is_empty()).then(|| build::join(project, &good, label)) {
        Some(Ok(joined)) => {
            let tools = tools_of(&joined.built);
            let thickness = joined.built.stock.thickness + joined.built.stock.through;
            for (k, from) in joined.starts.iter().enumerate() {
                let to = joined.starts.get(k + 1).copied().unwrap_or(u32::MAX);
                let segments = joined
                    .built
                    .interpreted
                    .segments
                    .iter()
                    .filter(|s| s.line >= *from && s.line < to)
                    .cloned()
                    .collect();
                stretches.push((segments, tools.clone(), thickness));
            }
            record.built = Some(joined.built);
        }
        Some(Err(errors)) => {
            record.errors = errors;
            record.complete = false;
            for (_, built) in &good {
                stretches.push((
                    built.interpreted.segments.clone(),
                    tools_of(built),
                    built.stock.thickness + built.stock.through,
                ));
            }
        }
        None => {}
    }

    let mut stretches = stretches.into_iter();
    let mut cut: Vec<(StepRun, Snapshot)> = Vec::new();
    for (step, part) in run.iter().zip(&parts) {
        let mut went = StepRun::of(step, Some(file));
        match (part, stretches.next()) {
            (Ok(_), Some((segments, tools, thickness))) => {
                went.warnings
                    .extend(facing_start_warning(project, stock, step));
                went.problems =
                    sim::simulate_segments(&mut stock.map, &segments, &tools, thickness);
                stock.settle();
                record.problems.extend(went.problems.iter().cloned());
                went.segments = segments;
            }
            (Err(errors), _) => went.errors = errors.clone(),
            (Ok(_), None) => {}
        }
        cut.push((went, stock.snapshot(stride)));
    }
    (record, cut)
}

/// For a facing: what there is to say when more wood stands where it cuts
/// than it starts above.
fn facing_start_warning(project: &Project, stock: &Workpiece, step: &Step) -> Option<String> {
    let (rect, above) = build::facing_start(project, &step.id)?;
    let (x0, y0, w, h) = stock.window(rect)?;
    let mut top = f32::NEG_INFINITY;
    for j in 0..h {
        for i in 0..w {
            top = top.max(stock.map.at(x0 + i, y0 + j));
        }
    }
    let top = top as f64;
    (top > above + PROUD).then(|| {
        format!(
            "Wood stands {} mm above the surface where this facing cuts, but its first pass starts {} mm above it: the tool would go {} mm into the wood at once.",
            num(top),
            num(above),
            num(top - above)
        )
    })
}

fn name_of<'a>(project: &'a Project, step_id: &str) -> &'a str {
    project
        .steps
        .iter()
        .find(|j| j.id == step_id)
        .map_or("?", |j| j.name.as_str())
}

/// Glues the plug or the inserts of an inlay onto the stock as it is.
fn glue(
    project: &Project,
    stock: &mut Workpiece,
    inlay_id: &str,
    done: bool,
    plugs: &HashMap<&str, Result<Preview, Vec<String>>>,
) -> Result<Seat, Vec<String>> {
    let step: &Step = project
        .steps
        .iter()
        .find(|j| j.id == inlay_id)
        .ok_or_else(|| vec!["The inlay it glues in no longer exists.".to_string()])?;
    if done {
        return Err(vec![format!(
            "\"{}\" is glued in already, further up the list.",
            step.name
        )]);
    }
    if stock.bodies.len() >= u8::MAX as usize {
        return Err(vec!["There are too many glue-ups in the list.".to_string()]);
    }
    let not_an_inlay = || {
        vec![format!(
            "\"{}\" is not an inlay: it has nothing to glue in.",
            step.name
        )]
    };
    let plug = plugs
        .get(inlay_id)
        .ok_or_else(not_an_inlay)?
        .as_ref()
        .map_err(|errors| -> Vec<String> {
            errors
                .iter()
                .map(|e| format!("{}: {e}", step.name))
                .collect()
        })?;
    match &step.task {
        Task::Vcarve {
            engagement_depth, ..
        } => seat_plug(stock, plug, -engagement_depth),
        Task::Flat {
            insert_style: InsertStyle::Backer,
            pocket_depth,
            ..
        } => seat_plug(stock, plug, -pocket_depth),
        Task::Flat { pocket_depth, .. } => seat_inserts(stock, &plug.built, -pocket_depth),
        _ => Err(not_an_inlay()),
    }
}

/// Turns a simulated plug over and lowers it onto the stock until it
/// touches. Its blank's back is then the surface there.
fn seat_plug(stock: &mut Workpiece, plug: &Preview, intended: f64) -> Result<Seat, Vec<String>> {
    let off = || vec!["The plug does not lie over the stock at all.".to_string()];
    let PlugFrame { mirror_x, offset_y } = plug.built.frame.ok_or_else(|| {
        vec!["Internal error: the plug has no position on the stock.".to_string()]
    })?;
    let board = plug.built.stock;
    // A plug cut out of a larger board is only what lies inside the cut.
    let [px0, py0, px1, py1] = plug
        .built
        .piece
        .unwrap_or([0.0, 0.0, board.width, board.height]);
    let (x0, y0, w, h) = stock
        .window([
            mirror_x - px1,
            py0 + offset_y,
            mirror_x - px0,
            py1 + offset_y,
        ])
        .ok_or_else(off)?;

    // The plug's cut surface over each cell, in the plug's own terms: 0 at
    // its face, negative where it was cut. NaN where it has no wood.
    let mut over = vec![f32::NAN; w * h];
    let mut seat = f64::NEG_INFINITY;
    for j in 0..h {
        for i in 0..w {
            let [x, y] = stock.map.centre(x0 + i, y0 + j);
            let (px, py) = (mirror_x - x, y - offset_y);
            if px < px0 || px > px1 || py < py0 || py > py1 {
                continue;
            }
            let Some(cut) = plug.map.interpolate(px, py) else {
                continue;
            };
            // Cut right through: there is no wood here.
            if cut <= -board.thickness + SLIVER as f64 {
                continue;
            }
            over[j * w + i] = cut as f32;
            seat = seat.max(stock.map.at(x0 + i, y0 + j) as f64 + cut);
        }
    }
    if !seat.is_finite() {
        return Err(off());
    }
    // Turned over, a point cut to height `cut` sits at seat - cut.
    let top = (seat + board.thickness) as f32;
    let under: Vec<f32> = over.iter().map(|cut| seat as f32 - cut).collect();
    stock.glue(x0, y0, w, under, &vec![top; w * h]);
    Ok(Seat {
        height: seat,
        proud: seat - intended,
        above: seat + board.thickness,
    })
}

/// Puts loose inserts into the stock where they were drawn, each the way up
/// it was cut, resting on the highest wood under it.
fn seat_inserts(
    stock: &mut Workpiece,
    inserts: &Built,
    intended: f64,
) -> Result<Seat, Vec<String>> {
    let off = || vec!["The inserts do not lie over the stock at all.".to_string()];
    let [ox, oy] = inserts.origin.ok_or_else(|| {
        vec!["Internal error: the inserts have no position on the stock.".to_string()]
    })?;
    let thickness = inserts.stock.thickness;
    let on_stock = |p: &Point| [p[0] + ox, p[1] + oy];
    let pieces: Vec<Region> = inserts
        .pocket
        .iter()
        .map(|r| {
            Region::with_holes(
                r.outer.iter().map(on_stock).collect(),
                r.holes
                    .iter()
                    .map(|ring| ring.iter().map(on_stock).collect())
                    .collect(),
            )
        })
        .collect();
    let mut all = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for p in pieces.iter().flat_map(|r| r.outer.iter()) {
        all = [
            all[0].min(p[0]),
            all[1].min(p[1]),
            all[2].max(p[0]),
            all[3].max(p[1]),
        ];
    }
    let (x0, y0, w, h) = stock.window(all).ok_or_else(off)?;

    let mut under = vec![f32::NAN; w * h];
    let mut top = vec![f32::NAN; w * h];
    let mut highest = f64::NEG_INFINITY;
    for piece in &pieces {
        let mut cells: Vec<usize> = Vec::new();
        let mut seat = f32::NEG_INFINITY;
        for j in 0..h {
            for i in 0..w {
                if piece.contains(stock.map.centre(x0 + i, y0 + j)) {
                    cells.push(j * w + i);
                    seat = seat.max(stock.map.at(x0 + i, y0 + j));
                }
            }
        }
        for k in cells {
            under[k] = seat;
            top[k] = seat + thickness as f32;
        }
        highest = highest.max(seat as f64);
    }
    if !highest.is_finite() {
        return Err(off());
    }
    stock.glue(x0, y0, w, under, &top);
    Ok(Seat {
        height: highest,
        proud: highest - intended,
        above: highest + thickness,
    })
}

fn num(v: f64) -> String {
    let s = format!("{:.2}", v);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::tests::{backer_project, project, vcarve_project};
    use crate::project::{PassDirection, Pattern};
    use crate::tools::Material;

    fn step(id: &str, task: Task) -> Step {
        Step {
            id: id.into(),
            name: id.into(),
            material: Material::HARDWOOD,
            region_ids: vec![],
            color: None,
            setup: None,
            cut_out_tool_id: None,
            row_profiles: Default::default(),
            task,
        }
    }

    fn glue_up() -> Step {
        step(
            "glue",
            Task::Glue {
                inlay_id: "j".into(),
            },
        )
    }

    /// A facing over the inlay's shapes and `margin` around them, from
    /// `above` the surface down to it.
    fn trim(above: f64, margin: f64) -> Step {
        Step {
            region_ids: vec![0, 1],
            ..step(
                "trim",
                Task::Facing {
                    above,
                    above_auto: false,
                    depth: 0.0,
                    margin,
                    pattern: Pattern::Raster,
                    direction: PassDirection::Longer,
                    tool_id: Some("t-endmill".into()),
                },
            )
        }
    }

    /// The snapshot's cell at a point of the stock: height and owner.
    fn at(t: &Timeline, snapshot: usize, x: f64, y: f64) -> (f32, u8) {
        let (ix, iy) = ((x / t.cell) as usize, (y / t.cell) as usize);
        let s = &t.snapshots[snapshot];
        (s.heights[iy * t.nx + ix], s.owners[iy * t.nx + ix])
    }

    #[test]
    fn a_plug_on_a_backer_is_glued_in_and_faced_flush() {
        let mut p = backer_project();
        // 4 mm board in a 2 mm pocket: the backer's back is 2 mm above the surface.
        p.steps.push(glue_up());
        p.steps.push(trim(2.0, 8.0));
        p.validate().unwrap();
        let t = timeline(&p).unwrap();
        assert_eq!(t.steps.len(), 3);
        assert_eq!(t.snapshots.len(), 4);
        assert_eq!(t.glued, vec!["j".to_string()]);
        for s in &t.steps {
            assert!(s.errors.is_empty(), "{:?}", s.errors);
            assert!(s.problems.is_empty(), "{:?}", s.problems);
        }

        // Fresh, then the pocket: 2 mm deep inside the rectangle, in the stock's own wood.
        assert_eq!(at(&t, 0, 20.0, 15.0), (0.0, 0));
        assert_eq!(at(&t, 1, 20.0, 15.0), (-2.0, 0));
        assert_eq!(at(&t, 1, 2.0, 2.0), (0.0, 0));

        // Glued in: the plug sits at its depth, and its backer is the
        // surface over the shapes and the margin around them.
        let seat = t.steps[1].seat.unwrap();
        assert!(seat.proud.abs() < 0.02, "{seat:?}");
        assert!((seat.above - 2.0).abs() < 0.02, "{seat:?}");
        assert!(t.steps[1].warnings.is_empty(), "{:?}", t.steps[1].warnings);
        for (x, y) in [(20.0, 15.0), (2.0, 2.0), (37.5, 30.0)] {
            let (z, owner) = at(&t, 2, x, y);
            assert!(
                (z - 2.0).abs() < 0.02 && owner == 1,
                "({x}, {y}): {z} {owner}"
            );
        }

        // Faced off: flat at the surface, the plug's wood showing inside
        // the shapes and the stock's own around them.
        for (x, y, owner) in [
            (20.0, 15.0, 1),
            (43.5, 30.0, 1),
            (2.0, 2.0, 0),
            (37.5, 30.0, 0),
        ] {
            let (z, is) = at(&t, 3, x, y);
            assert!(z.abs() < 0.02, "({x}, {y}): {z}");
            assert_eq!(is, owner, "({x}, {y})");
        }
    }

    #[test]
    fn a_v_carved_plug_seats_in_its_pocket() {
        let mut p = vcarve_project(true);
        p.steps.push(glue_up());
        // 8 mm blank, 2 mm in: 6 mm stands above the surface.
        p.steps.push(trim(6.0, 6.0));
        let t = timeline(&p).unwrap();
        for s in &t.steps {
            assert!(s.errors.is_empty(), "{:?}", s.errors);
        }
        let seat = t.steps[1].seat.unwrap();
        assert!(seat.proud > -0.02 && seat.proud < PROUD, "{seat:?}");
        assert!((seat.above - 6.0).abs() < PROUD, "{seat:?}");
        assert!(t.steps[1].warnings.is_empty(), "{:?}", t.steps[1].warnings);
        let (z, owner) = at(&t, 2, 20.0, 15.0);
        assert!((z as f64 - seat.above).abs() < 1e-3 && owner == 1);
        // Trimmed: the middle of the rectangle is the plug's wood, at the surface.
        let (z, owner) = at(&t, 3, 20.0, 15.0);
        assert!(z.abs() < 0.02 && owner == 1, "{z} {owner}");
        assert_eq!(at(&t, 3, 2.0, 2.0).1, 0);
    }

    #[test]
    fn loose_inserts_stand_in_their_pockets() {
        let mut p = project();
        p.steps.push(glue_up());
        let t = timeline(&p).unwrap();
        assert!(t.steps[1].errors.is_empty(), "{:?}", t.steps[1].errors);
        let seat = t.steps[1].seat.unwrap();
        // A 4 mm insert on the floor of a 2 mm pocket.
        assert!(
            seat.proud.abs() < 1e-3 && (seat.above - 2.0).abs() < 1e-3,
            "{seat:?}"
        );
        let (z, owner) = at(&t, 2, 20.0, 15.0);
        assert!((z - 2.0).abs() < 1e-3 && owner == 1, "{z} {owner}");
        let (z, owner) = at(&t, 2, 43.5, 30.0);
        assert!((z - 2.0).abs() < 1e-3 && owner == 1, "{z} {owner}");
        // Between the two shapes, and outside them, nothing was put down.
        assert_eq!(at(&t, 2, 37.5, 30.0), (0.0, 0));
        assert_eq!(at(&t, 2, 52.0, 30.0), (0.0, 0));
    }

    #[test]
    fn a_glue_up_out_of_place_says_so_and_a_cut_into_the_plug_is_a_problem() {
        // Glued before its pocket is cut: the plug lies on the surface.
        let mut p = backer_project();
        p.steps.insert(0, glue_up());
        let t = timeline(&p).unwrap();
        let seat = t.steps[0].seat.unwrap();
        assert!((seat.proud - 2.0).abs() < 0.02, "{seat:?}");
        assert!(t.steps[0].warnings[0].contains("later in the list"));
        // The pocket's file then travels as if the surface were clear, and
        // cuts into the plug on its way.
        assert!(t.steps[1]
            .problems
            .iter()
            .any(|p| p.message.contains("rapid move goes through")));

        // Glued in twice.
        let mut p = backer_project();
        p.steps.push(glue_up());
        p.steps.push(Step {
            id: "again".into(),
            ..glue_up()
        });
        let t = timeline(&p).unwrap();
        assert!(t.steps[2].errors[0].contains("glued in already"));
        assert_eq!(t.snapshots[2], t.snapshots[3]);

        // An inlay that cannot be built stops its glue-up, not the list.
        let mut p = backer_project();
        p.steps.push(glue_up());
        p.tools.clear();
        let t = timeline(&p).unwrap();
        assert!(!t.steps[0].errors.is_empty() && !t.steps[1].errors.is_empty());
        assert_eq!(t.snapshots[0], t.snapshots[2]);
    }

    #[test]
    fn the_lines_between_glue_ups_are_one_file_each() {
        let mut p = backer_project();
        // A plain pocket in the same run as the inlay's own, then the glue-up, then the trim.
        p.steps.push(Step {
            region_ids: vec![1],
            ..step(
                "extra",
                Task::Pocket {
                    depth: 1.0,
                    pattern: Pattern::Offset,
                    direction: PassDirection::Longer,
                    clearing_tool_ids: vec!["t-endmill".into()],
                },
            )
        });
        if let Task::Flat { .. } = &p.steps[0].task {
            p.steps[0].region_ids = vec![0];
        }
        p.steps.push(glue_up());
        p.steps.push(Step {
            region_ids: vec![0],
            ..trim(2.0, 8.0)
        });
        assert_eq!(file_numbers(&p), vec![Some(1), Some(1), None, Some(2)]);
        let t = timeline(&p).unwrap();
        assert_eq!(t.files.len(), 2);
        // The inlay's plug comes with them: the one file that is not cut from the stock.
        assert_eq!(t.parts.len(), 1);
        assert_eq!(t.parts[0].step_id, "j");
        let plug = t.parts[0].built.as_ref().unwrap();
        assert!(plug.part == Part::Plug && t.parts[0].problems.is_empty());
        assert_eq!(
            t.files[0].step_ids,
            vec!["j".to_string(), "extra".to_string()]
        );
        assert_eq!(t.files[1].step_ids, vec!["trim".to_string()]);
        let steps: Vec<Option<usize>> = t.steps.iter().map(|s| s.file).collect();
        assert_eq!(steps, vec![Some(0), Some(0), None, Some(1)]);
        for file in &t.files {
            assert!(file.complete && file.errors.is_empty() && file.problems.is_empty());
        }

        // The first file names its parts where they begin, and is run in two
        // stretches: the stock after the first has the first pocket only.
        let first = t.files[0].built.as_ref().unwrap();
        assert_eq!(first.file_name, "Test-board-stock-1.cnc");
        assert_eq!(
            t.files[1].built.as_ref().unwrap().file_name,
            "Test-board-stock-2.cnc"
        );
        assert!(first.gcode.contains("\n(Step 1: Flat inlay 1)\n"));
        assert!(first.gcode.contains("\n(Step 2: extra)\n"));
        // One tool for both: it is loaded once.
        assert_eq!(first.stats.tool_changes, 1);
        assert_eq!(at(&t, 1, 20.0, 15.0), (-2.0, 0));
        assert_eq!(at(&t, 1, 43.5, 30.0), (0.0, 0));
        assert_eq!(at(&t, 2, 43.5, 30.0), (-1.0, 0));
        // Every cutting line of the file is in one stretch or the other.
        let lines = |i: usize| -> (u32, u32) {
            let s = &t.steps[i].segments;
            (s.first().unwrap().line, s.last().unwrap().line)
        };
        assert!(lines(0).1 < lines(1).0);
        assert_eq!(
            t.steps[0].segments.len() + t.steps[1].segments.len(),
            first.interpreted.segments.len()
        );

        // Without a glue-up there is one file, called after the stock alone.
        p.steps.retain(|j| j.id != "glue" && j.id != "trim");
        let t = timeline(&p).unwrap();
        assert_eq!(t.files.len(), 1);
        assert_eq!(
            t.files[0].built.as_ref().unwrap().file_name,
            "Test-board-stock.cnc"
        );

        // A line that cannot be made leaves its file incomplete; the rest is still shown.
        if let Task::Pocket {
            clearing_tool_ids, ..
        } = &mut p.steps[1].task
        {
            clearing_tool_ids.clear();
        }
        let t = timeline(&p).unwrap();
        assert!(!t.files[0].complete && t.files[0].built.is_some());
        assert!(!t.steps[1].errors.is_empty());
        assert_eq!(at(&t, 2, 20.0, 15.0), (-2.0, 0));
    }

    #[test]
    fn a_facing_takes_its_height_from_the_list() {
        let auto = |p: &mut Project| {
            let mut step = trim(0.0, 8.0);
            if let Task::Facing { above_auto, .. } = &mut step.task {
                *above_auto = true;
            }
            p.steps.push(step);
        };
        // After the glue-up: the 2 mm the backer stands above the surface.
        let mut p = backer_project();
        p.steps.push(glue_up());
        auto(&mut p);
        p.validate().unwrap();
        let (rect, above) = build::facing_start(&p, "trim").unwrap();
        assert_eq!(rect, [-3.0, -3.0, 63.0, 43.0]);
        assert!((above - 2.0).abs() < 1e-9);
        let t = timeline(&p).unwrap();
        assert!(t.steps[2].errors.is_empty(), "{:?}", t.steps[2].errors);
        assert!(t.steps[2].warnings.is_empty(), "{:?}", t.steps[2].warnings);
        assert!(t.steps[2].problems.is_empty(), "{:?}", t.steps[2].problems);
        let (z, owner) = at(&t, 3, 20.0, 15.0);
        assert!(z.abs() < 0.02 && owner == 1, "{z} {owner}");

        // A second facing over it finds it flush already, and has nothing to do.
        let mut again = p.clone();
        let mut second = again.steps[2].clone();
        second.id = "second".into();
        again.steps.push(second);
        assert_eq!(build::facing_start(&again, "second").unwrap().1, 0.0);
        let reasons = build::build(&again, "second", Part::Pocket).unwrap_err();
        assert!(
            reasons[0].contains("nothing glued in stands above"),
            "{reasons:?}"
        );

        // Before the glue-up nothing stands there.
        let mut p = backer_project();
        auto(&mut p);
        p.steps.push(glue_up());
        assert_eq!(build::facing_start(&p, "trim").unwrap().1, 0.0);

        // A height given by hand that is too low is found on the stock itself.
        let mut p = backer_project();
        p.steps.push(glue_up());
        p.steps.push(trim(0.5, 8.0));
        let t = timeline(&p).unwrap();
        assert!(
            t.steps[2].warnings[0].contains("1.5 mm into the wood at once"),
            "{:?}",
            t.steps[2].warnings
        );
    }

    #[test]
    fn a_pocket_cut_through_a_plug_ends_in_the_wood_under_it() {
        // A second inlay's worth: a plain pocket deeper than the plug goes in.
        let mut p = backer_project();
        p.steps.push(glue_up());
        p.steps.push(trim(2.0, 8.0));
        p.steps.push(Step {
            region_ids: vec![0],
            ..step(
                "deep",
                Task::Pocket {
                    depth: 3.0,
                    pattern: Pattern::Offset,
                    direction: PassDirection::Longer,
                    clearing_tool_ids: vec!["t-endmill".into()],
                },
            )
        });
        let t = timeline(&p).unwrap();
        for s in &t.steps {
            assert!(s.errors.is_empty(), "{:?}", s.errors);
        }
        assert_eq!(at(&t, 4, 20.0, 15.0), (-3.0, 0));
        // The other shape's plug is untouched.
        let (z, owner) = at(&t, 4, 43.5, 30.0);
        assert!(z.abs() < 0.02 && owner == 1);
    }
}
