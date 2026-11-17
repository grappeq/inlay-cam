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
use crate::geom::{Point, Region};
use crate::project::{Inlay, InsertStyle, Job, Project};
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
pub struct Step {
    pub job_id: String,
    /// Done by hand: there is no file.
    pub by_hand: bool,
    /// The file that was run on the stock.
    pub built: Option<Built>,
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
    pub steps: Vec<Step>,
    /// The fresh stock, then the stock after each step.
    pub snapshots: Vec<Snapshot>,
}

/// Takes the stock through every inlay and operation of the project, in the
/// order of the list. A step that cannot be done says why and leaves the
/// stock as it was; the steps after it go on from there.
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

    let mut glued: Vec<String> = Vec::new();
    let mut steps: Vec<Step> = Vec::new();
    let mut snapshots = vec![stock.snapshot(stride)];
    for (index, job) in project.jobs.iter().enumerate() {
        let mut step = Step {
            job_id: job.id.clone(),
            by_hand: job.inlay.is_by_hand(),
            built: None,
            problems: Vec::new(),
            errors: Vec::new(),
            warnings: Vec::new(),
            seat: None,
        };
        match &job.inlay {
            Inlay::Glue { inlay_id } => {
                let later = project.jobs[index..].iter().any(|j| &j.id == inlay_id);
                match glue(project, &mut stock, inlay_id, glued.contains(inlay_id)) {
                    Ok(seat) => {
                        glued.push(inlay_id.clone());
                        let name = name_of(project, inlay_id);
                        if later {
                            step.warnings.push(format!(
                                "The pocket of \"{name}\" is cut later in the list, so there is nothing to glue into yet. Move this step below it."
                            ));
                        } else if seat.proud > PROUD {
                            step.warnings.push(format!(
                                "It rests {} mm higher than designed: something on the stock holds it up.",
                                num(seat.proud)
                            ));
                        }
                        step.seat = Some(seat);
                    }
                    Err(errors) => step.errors = errors,
                }
            }
            _ => match build::build(project, &job.id, Part::Pocket) {
                Ok(built) => {
                    let tools: HashMap<u32, Tool> = built
                        .program
                        .tools
                        .iter()
                        .map(|t| (t.number, t.tool.clone()))
                        .collect();
                    step.problems = sim::simulate_onto(
                        &mut stock.map,
                        &built.interpreted,
                        &tools,
                        built.stock.thickness + built.stock.through,
                    );
                    stock.settle();
                    step.built = Some(built);
                }
                Err(errors) => step.errors = errors,
            },
        }
        steps.push(step);
        snapshots.push(stock.snapshot(stride));
    }

    Ok(Timeline {
        cell: simulated_cell * stride as f64,
        nx: stock.map.nx.div_ceil(stride),
        ny: stock.map.ny.div_ceil(stride),
        simulated_cell,
        thickness: project.base.thickness,
        glued,
        steps,
        snapshots,
    })
}

fn name_of<'a>(project: &'a Project, job_id: &str) -> &'a str {
    project
        .jobs
        .iter()
        .find(|j| j.id == job_id)
        .map_or("?", |j| j.name.as_str())
}

/// Glues the plug or the inserts of an inlay onto the stock as it is.
fn glue(
    project: &Project,
    stock: &mut Workpiece,
    inlay_id: &str,
    done: bool,
) -> Result<Seat, Vec<String>> {
    let job: &Job = project
        .jobs
        .iter()
        .find(|j| j.id == inlay_id)
        .ok_or_else(|| vec!["The inlay it glues in no longer exists.".to_string()])?;
    if done {
        return Err(vec![format!(
            "\"{}\" is glued in already, further up the list.",
            job.name
        )]);
    }
    if stock.bodies.len() >= u8::MAX as usize {
        return Err(vec!["There are too many glue-ups in the list.".to_string()]);
    }
    let from_part = |errors: Vec<String>| -> Vec<String> {
        errors
            .into_iter()
            .map(|e| format!("{}: {e}", job.name))
            .collect()
    };
    match &job.inlay {
        Inlay::Vcarve {
            engagement_depth, ..
        } => {
            let plug = build::preview(project, inlay_id, Part::Plug).map_err(from_part)?;
            seat_plug(stock, &plug, -engagement_depth)
        }
        Inlay::Flat {
            insert_style: InsertStyle::Backer,
            pocket_depth,
            ..
        } => {
            let plug = build::preview(project, inlay_id, Part::Plug).map_err(from_part)?;
            seat_plug(stock, &plug, -pocket_depth)
        }
        Inlay::Flat { pocket_depth, .. } => {
            let inserts = build::build(project, inlay_id, Part::Plug).map_err(from_part)?;
            seat_inserts(stock, &inserts, -pocket_depth)
        }
        _ => Err(vec![format!(
            "\"{}\" is not an inlay: it has nothing to glue in.",
            job.name
        )]),
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

    fn step(id: &str, inlay: Inlay) -> Job {
        Job {
            id: id.into(),
            name: id.into(),
            material: Material::HARDWOOD,
            region_ids: vec![],
            color: None,
            setup: None,
            cut_out_tool_id: None,
            row_profiles: Default::default(),
            inlay,
        }
    }

    fn glue_up() -> Job {
        step(
            "glue",
            Inlay::Glue {
                inlay_id: "j".into(),
            },
        )
    }

    /// A facing over the inlay's shapes and `margin` around them, from
    /// `above` the surface down to it.
    fn trim(above: f64, margin: f64) -> Job {
        Job {
            region_ids: vec![0, 1],
            ..step(
                "trim",
                Inlay::Facing {
                    above,
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
        p.jobs.push(glue_up());
        p.jobs.push(trim(2.0, 8.0));
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
        p.jobs.push(glue_up());
        // 8 mm blank, 2 mm in: 6 mm stands above the surface.
        p.jobs.push(trim(6.0, 6.0));
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
        p.jobs.push(glue_up());
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
        p.jobs.insert(0, glue_up());
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
        p.jobs.push(glue_up());
        p.jobs.push(Job {
            id: "again".into(),
            ..glue_up()
        });
        let t = timeline(&p).unwrap();
        assert!(t.steps[2].errors[0].contains("glued in already"));
        assert_eq!(t.snapshots[2], t.snapshots[3]);

        // An inlay that cannot be built stops its glue-up, not the list.
        let mut p = backer_project();
        p.jobs.push(glue_up());
        p.tools.clear();
        let t = timeline(&p).unwrap();
        assert!(!t.steps[0].errors.is_empty() && !t.steps[1].errors.is_empty());
        assert_eq!(t.snapshots[0], t.snapshots[2]);
    }

    #[test]
    fn a_pocket_cut_through_a_plug_ends_in_the_wood_under_it() {
        // A second inlay's worth: a plain pocket deeper than the plug goes in.
        let mut p = backer_project();
        p.jobs.push(glue_up());
        p.jobs.push(trim(2.0, 8.0));
        p.jobs.push(Job {
            region_ids: vec![0],
            ..step(
                "deep",
                Inlay::Pocket {
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
