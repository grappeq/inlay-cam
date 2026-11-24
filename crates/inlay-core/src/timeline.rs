//! The stock step by step: what the list of inlays and operations leaves of
//! it, in the order of the list.
//!
//! A file on its own is simulated on a fresh block. Here one block goes
//! through every step: a step with a file cuts it as the step before left
//! it, and a glue-up puts the wood of a plug or of inserts on it. That wood
//! is then there for the steps that follow, to be faced off, cut into, or
//! run into.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::rc::Rc;

use serde::Serialize;

use crate::analysis::PlugFrame;
use crate::build::{self, Built, Part, Preview};
use crate::gcode::Segment;
use crate::geom::boolean::union;
use crate::geom::{Point, Region};
use crate::progress::{self, Stage};
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

    /// Saws the wood of one glue-up off level, `leave` above the stock's
    /// surface: what it has above that is gone, and where all of it was
    /// above, as a backer is, the surface is what lay under it. Returns how
    /// far above the saw's level its top stood.
    fn saw(&mut self, body: usize, leave: f32) -> f32 {
        let Some(wood) = self.bodies.get(body) else {
            return 0.0;
        };
        let mut over = 0.0f32;
        for j in 0..wood.h {
            for i in 0..wood.w {
                let (k, cell) = (j * wood.w + i, (wood.y0 + j) * self.map.nx + wood.x0 + i);
                if wood.under[k].is_nan() || self.owner[cell] != body as u8 + 1 {
                    continue;
                }
                over = over.max(self.map.z[cell] - leave);
                self.map.z[cell] = self.map.z[cell].min(leave);
            }
        }
        self.settle();
        over
    }

    /// The highest the surface stands within a rectangle of the stock.
    fn top_in(&self, rect: [f64; 4]) -> Option<f64> {
        let (x0, y0, w, h) = self.window(rect)?;
        let mut top = f32::NEG_INFINITY;
        for j in 0..h {
            for i in 0..w {
                top = top.max(self.map.at(x0 + i, y0 + j));
            }
        }
        Some(top as f64)
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
        let mut unders = Vec::with_capacity(dx * dy);
        let mut floors = Vec::with_capacity(dx * dy);
        for j in 0..dy {
            for i in 0..dx {
                let mut lowest = (f32::INFINITY, 0u8);
                let mut at = 0;
                for jj in j * stride..((j + 1) * stride).min(ny) {
                    for ii in i * stride..((i + 1) * stride).min(nx) {
                        let cell = jj * nx + ii;
                        if self.map.z[cell] < lowest.0 {
                            lowest = (self.map.z[cell], self.owner[cell]);
                            at = cell;
                        }
                    }
                }
                heights.push(lowest.0);
                owners.push(lowest.1);
                // Under glued-in wood: where its underside is, and the surface it was put on.
                let below = (lowest.1 > 0)
                    .then(|| &self.bodies[lowest.1 as usize - 1])
                    .and_then(|wood| {
                        let (x, y) = (at % nx, at / nx);
                        (x >= wood.x0
                            && y >= wood.y0
                            && x < wood.x0 + wood.w
                            && y < wood.y0 + wood.h)
                            .then(|| (y - wood.y0) * wood.w + x - wood.x0)
                            .map(|k| (wood.under[k], wood.floor[k]))
                    })
                    .unwrap_or((f32::NAN, f32::NAN));
                unders.push(below.0);
                floors.push(below.1);
            }
        }
        Snapshot {
            heights,
            owners,
            unders,
            floors,
        }
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
    /// What the step cuts on its own, before it is joined with others into
    /// a file, or why it cannot be made. `None` for a step done by hand.
    pub part: Option<Rc<Result<Built, Vec<String>>>>,
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
    /// A facing that takes the wood above the surface from the list: the
    /// height it was given, as measured on the stock, mm.
    pub starts_above: Option<f64>,
    /// Left out: it has no file and leaves the stock as it was.
    pub suppressed: bool,
}

impl StepRun {
    fn of(step: &Step, file: Option<usize>) -> Self {
        StepRun {
            step_id: step.id.clone(),
            by_hand: step.task.is_by_hand(),
            file,
            part: None,
            segments: Vec::new(),
            problems: Vec::new(),
            errors: Vec::new(),
            warnings: Vec::new(),
            seat: None,
            starts_above: None,
            suppressed: false,
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
#[derive(Debug, Clone)]
pub struct Snapshot {
    /// Height per cell, row by row from Y = 0.
    pub heights: Vec<f32>,
    /// Whose wood each cell is in: 0 for the stock's own, else the number
    /// of an entry of [`Timeline::glued`], counted from 1.
    pub owners: Vec<u8>,
    /// Where a cell is in glued-in wood: the height of that wood's
    /// underside there. NaN elsewhere.
    pub unders: Vec<f32>,
    /// And the surface that wood was put on, which shows where it stands
    /// off it. NaN elsewhere.
    pub floors: Vec<f32>,
}

/// Two are the same when every cell is: "no wood here" is the same as itself.
impl PartialEq for Snapshot {
    fn eq(&self, other: &Self) -> bool {
        let same = |a: &[f32], b: &[f32]| {
            a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.to_bits() == y.to_bits())
        };
        same(&self.heights, &other.heights)
            && self.owners == other.owners
            && same(&self.unders, &other.unders)
            && same(&self.floors, &other.floors)
    }
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
    pub snapshots: Vec<Rc<Snapshot>>,
}

/// The stock is kept after each of this many steps at the end of the list,
/// to go on from when the list is taken through again. Each is a copy of
/// the whole block.
const KEPT_STOCKS: usize = 24;

/// What one step came to, kept to be used again while nothing before the
/// step, and nothing of it, has changed.
#[derive(Debug, Clone)]
struct Outcome {
    /// Problems found while cutting, each with its line counted from where
    /// the step begins in its file.
    problems: Vec<(u32, String)>,
    /// What a step done by hand could not do.
    errors: Vec<String>,
    warnings: Vec<String>,
    seat: Option<Seat>,
    starts_above: Option<f64>,
    snapshot: Rc<Snapshot>,
    /// The stock after the step.
    after: Option<Rc<Workpiece>>,
}

/// What taking a project's stock through its list came to last time. Given
/// to [`timeline_with`] again, only the steps from the first that changed
/// are built, glued and cut anew.
#[derive(Debug, Default)]
pub struct Cache {
    plugs: HashMap<u64, Rc<Result<Preview, Vec<String>>>>,
    builds: HashMap<u64, Rc<Result<Built, Vec<String>>>>,
    outcomes: HashMap<u64, Outcome>,
    /// How many steps the last call did anew.
    pub redone: usize,
}

/// A number for what something hangs on: `seed` for what came before, and
/// the texts that come with it.
fn hash_of(seed: u64, parts: &[&str]) -> u64 {
    let mut hasher = DefaultHasher::new();
    seed.hash(&mut hasher);
    for part in parts {
        part.hash(&mut hasher);
    }
    hasher.finish()
}

/// Takes the stock through every inlay and operation of the project, in the
/// order of the list. The entries between two steps done by hand are one
/// file, and it is that file that cuts the stock. A step that cannot be done
/// says why and leaves the stock as it was; the steps after it go on from
/// there.
pub fn timeline(project: &Project) -> Result<Timeline, Vec<String>> {
    timeline_with(project, &mut Cache::default())
}

/// As [`timeline`], going on from what `cache` holds of the last time: the
/// steps up to the first that has changed are not done again.
pub fn timeline_with(project: &Project, cache: &mut Cache) -> Result<Timeline, Vec<String>> {
    let design = project
        .design
        .as_ref()
        .ok_or_else(|| vec!["The project has no design.".to_string()])?;
    let (width, height) = design.placed_size();
    let simulated_cell = HeightMap::cell_for(width, height, 2_000_000.0, 0.05);
    let fresh = Workpiece::new(width, height, simulated_cell);
    let (nx, ny) = (fresh.map.nx, fresh.map.ny);
    let stride = nx.max(ny).div_ceil(DISPLAY_CELLS).max(1);
    let count = project.steps.len();

    // What a step's outcome hangs on: everything that is not a step, then
    // every step up to it. A glue-up or a sawing also hangs on its inlay,
    // wherever in the list that is.
    let text = |step: &Step| serde_json::to_string(step).unwrap_or_default();
    let base = {
        let mut bare = project.clone();
        bare.steps.clear();
        hash_of(0, &[&serde_json::to_string(&bare).unwrap_or_default()])
    };
    let texts: Vec<String> = project.steps.iter().map(text).collect();
    let mut keys: Vec<u64> = Vec::with_capacity(count);
    for (index, step) in project.steps.iter().enumerate() {
        let before = keys.last().copied().unwrap_or(base);
        let other: String = match &step.task {
            Task::Glue { inlay_id } | Task::Saw { inlay_id, .. } => project
                .steps
                .iter()
                .position(|s| &s.id == inlay_id)
                .map_or(String::new(), |at| texts[at].clone()),
            // Its margin is that of the inlays its shapes belong to.
            Task::Facing {
                margin_auto: true, ..
            } => project
                .steps
                .iter()
                .enumerate()
                .filter(|(_, other)| {
                    other.task.is_inlay()
                        && other
                            .region_ids
                            .iter()
                            .any(|id| step.region_ids.contains(id))
                })
                .map(|(at, _)| texts[at].as_str())
                .collect(),
            _ => String::new(),
        };
        keys.push(hash_of(before, &[texts[index].as_str(), other.as_str()]));
    }

    // Every inlay's plug or inserts, simulated on their own board: what a
    // glue-up puts on the stock, and a file to cut either way.
    let mut used_plugs: HashSet<u64> = HashSet::new();
    let mut plugs: HashMap<&str, Rc<Result<Preview, Vec<String>>>> = HashMap::new();
    for (index, step) in project.steps.iter().enumerate() {
        if !step.task.is_inlay() || project.is_suppressed(step) {
            continue;
        }
        let key = hash_of(base, &[texts[index].as_str()]);
        used_plugs.insert(key);
        let plug = cache
            .plugs
            .entry(key)
            .or_insert_with(|| {
                progress::report(Stage::Plug, index, count);
                Rc::new(build::preview(project, &step.id, Part::Plug))
            })
            .clone();
        plugs.insert(step.id.as_str(), plug);
    }

    // Where to go on from: after the last step that is known and has its
    // stock kept. Everything before it is taken as it came out last time.
    let known = keys
        .iter()
        .take_while(|key| cache.outcomes.contains_key(key))
        .count();
    let resume = (0..=known)
        .rev()
        .find(|&r| r == 0 || cache.outcomes[&keys[r - 1]].after.is_some())
        .unwrap_or(0);
    cache.redone = count - resume;
    if resume < count {
        progress::report(Stage::List, resume, count);
    }
    let stock = if resume == 0 {
        fresh
    } else {
        (**cache.outcomes[&keys[resume - 1]].after.as_ref().unwrap()).clone()
    };

    let mut pass = Pass {
        project,
        base,
        texts: &texts,
        keys: &keys,
        resume,
        stride,
        stock,
        cache,
        used_builds: HashSet::new(),
    };
    let mut glued: Vec<String> = Vec::new();
    let mut files: Vec<StockFile> = Vec::new();
    let mut steps: Vec<StepRun> = Vec::new();
    let flat = (nx.div_ceil(stride)) * (ny.div_ceil(stride));
    let mut snapshots = vec![Rc::new(Snapshot {
        heights: vec![0.0; flat],
        owners: vec![0; flat],
        unders: vec![f32::NAN; flat],
        floors: vec![f32::NAN; flat],
    })];
    // The entries since the last step done by hand. One that is suppressed
    // is among them wherever it stands, the machine does not stop for it.
    let mut run: Vec<usize> = Vec::new();
    for index in 0..=count {
        let step = project.steps.get(index);
        if step.is_some_and(|s| !s.task.is_by_hand() || project.is_suppressed(s)) {
            run.push(index);
            continue;
        }
        if !run.is_empty() {
            let (file, cut) = pass.cut_run(&run, files.len());
            files.extend(file);
            for (went, snapshot) in cut {
                steps.push(went);
                snapshots.push(snapshot);
            }
            run.clear();
        }
        let Some(step) = step else { break };
        if index >= resume {
            progress::report(Stage::Step, index, count);
        }
        let (went, snapshot) = pass.by_hand(index, step, &glued, &plugs);
        if let (Task::Glue { inlay_id }, Some(_)) = (&step.task, &went.seat) {
            glued.push(inlay_id.clone());
        }
        steps.push(went);
        snapshots.push(snapshot);
    }

    progress::report(Stage::List, count, count);

    // What is not part of this list any more is let go.
    let Pass {
        cache, used_builds, ..
    } = pass;
    cache.outcomes.retain(|key, _| keys.contains(key));
    cache.builds.retain(|key, _| used_builds.contains(key));
    cache.plugs.retain(|key, _| used_plugs.contains(key));

    let parts = project
        .steps
        .iter()
        .filter_map(|step| {
            let part = plugs.get(step.id.as_str())?;
            Some(match part.as_ref() {
                Ok(preview) => PartFile {
                    step_id: step.id.clone(),
                    // Named as every file is, by its inlay's place in the
                    // list now, next to the pocket it fills: the plug kept
                    // from an earlier working out may have stood elsewhere.
                    built: Some(Built {
                        file_name: build::project_file_name(
                            project,
                            build::place_of(project, &step.id),
                            &build::cut_label(step, Part::Plug),
                        ),
                        ..preview.built.clone()
                    }),
                    errors: Vec::new(),
                    problems: preview.problems.clone(),
                },
                Err(errors) => PartFile {
                    step_id: step.id.clone(),
                    built: None,
                    errors: errors.clone(),
                    problems: Vec::new(),
                },
            })
        })
        .collect();

    Ok(Timeline {
        cell: simulated_cell * stride as f64,
        nx: nx.div_ceil(stride),
        ny: ny.div_ceil(stride),
        simulated_cell,
        thickness: project.base.thickness,
        glued,
        files,
        steps,
        parts,
        snapshots,
    })
}

/// One file for the entries of the list that are picked, in the order of the
/// list: what [`timeline_with`] joins from one step done by hand to the
/// next, but of these entries only. They have to stand between the same two
/// steps done by hand, since the machine stops there anyway. All the entries
/// of such a stretch give the file the timeline has for it; fewer give a
/// file named after the first of them.
pub fn export(
    project: &Project,
    step_ids: &[String],
    cache: &mut Cache,
) -> Result<Built, Vec<String>> {
    let timeline = timeline_with(project, cache)?;
    let (left_out, picked): (Vec<&StepRun>, Vec<&StepRun>) = timeline
        .steps
        .iter()
        .filter(|step| step_ids.contains(&step.step_id))
        .partition(|step| step.suppressed);
    let Some(first) = picked.first() else {
        return Err(vec![match left_out.first() {
            Some(step) => format!(
                "\"{}\" is suppressed: there is no file for it.",
                name_of(project, &step.step_id)
            ),
            None => "Nothing is picked.".to_string(),
        }]);
    };
    let Some(file) = first.file else {
        return Err(vec![format!(
            "\"{}\" is done by hand: there is no file for it.",
            name_of(project, &first.step_id)
        )]);
    };
    if picked.iter().any(|step| step.file != Some(file)) {
        return Err(vec![
            "A step done by hand stands between these: they cannot be one file.".to_string(),
        ]);
    }
    let mut errors: Vec<String> = Vec::new();
    let mut parts: Vec<(&str, &Built)> = Vec::new();
    for step in &picked {
        let name = name_of(project, &step.step_id);
        match step.part.as_deref() {
            Some(Ok(built)) => parts.push((name, built)),
            Some(Err(reasons)) => errors.extend(reasons.iter().map(|e| format!("{name}: {e}"))),
            None => {}
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    // Named as every file of the project is, by the place of its first entry.
    let whole = picked.len() == timeline.files[file].step_ids.len();
    let ids: Vec<&str> = picked.iter().map(|step| step.step_id.as_str()).collect();
    let (at, what) = build::stock_file_label(project, &ids, whole);
    build::join(project, &parts, at, &what).map(|joined| joined.built)
}

/// Which file for the stock each entry of the list goes into, counted from
/// 1: the entries from one step done by hand to the next share a file.
/// `None` for a step done by hand, and for one that is suppressed.
pub fn file_numbers(project: &Project) -> Vec<Option<usize>> {
    let (mut number, mut open) = (0, false);
    project
        .steps
        .iter()
        .map(|step| {
            // Left out, it neither has a file nor ends one.
            if project.is_suppressed(step) {
                return None;
            }
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

/// What one part cuts the stock with: its moves, the tools by their
/// numbers, how deep the stock goes, and the line of its file it begins on.
type Stretch = (Vec<Segment>, HashMap<u32, Tool>, f64, u32);

/// One going through the list: the stock as it stands, and what is known
/// from the last time.
struct Pass<'a> {
    project: &'a Project,
    base: u64,
    texts: &'a [String],
    keys: &'a [u64],
    /// The first step that is done anew. The stock is the one after the
    /// step before it.
    resume: usize,
    stride: usize,
    stock: Workpiece,
    cache: &'a mut Cache,
    used_builds: HashSet<u64>,
}

impl Pass<'_> {
    /// Keeps what a step came to, with the stock after it if the step is
    /// near enough to the end of the list.
    fn keep(&mut self, index: usize, went: &StepRun, start: u32) -> Rc<Snapshot> {
        let snapshot = Rc::new(self.stock.snapshot(self.stride));
        let after = (index + KEPT_STOCKS >= self.keys.len()).then(|| Rc::new(self.stock.clone()));
        self.cache.outcomes.insert(
            self.keys[index],
            Outcome {
                problems: went
                    .problems
                    .iter()
                    .map(|p| (p.line.saturating_sub(start), p.message.clone()))
                    .collect(),
                errors: if went.by_hand {
                    went.errors.clone()
                } else {
                    Vec::new()
                },
                warnings: went.warnings.clone(),
                seat: went.seat,
                starts_above: went.starts_above,
                snapshot: snapshot.clone(),
                after,
            },
        );
        snapshot
    }

    /// A step as it came out last time. `start` is where it begins in its
    /// file now.
    fn known(&self, index: usize, went: &mut StepRun, start: u32) -> Rc<Snapshot> {
        let outcome = &self.cache.outcomes[&self.keys[index]];
        went.problems = outcome
            .problems
            .iter()
            .map(|(line, message)| SimProblem {
                line: start + line,
                message: message.clone(),
            })
            .collect();
        if went.by_hand {
            went.errors = outcome.errors.clone();
        }
        went.warnings = outcome.warnings.clone();
        went.seat = outcome.seat;
        went.starts_above = outcome.starts_above;
        outcome.snapshot.clone()
    }

    /// A step done by hand: a glue-up, or the sawing off of a backer.
    fn by_hand(
        &mut self,
        index: usize,
        step: &Step,
        glued: &[String],
        plugs: &HashMap<&str, Rc<Result<Preview, Vec<String>>>>,
    ) -> (StepRun, Rc<Snapshot>) {
        let mut went = StepRun::of(step, None);
        if index < self.resume {
            let snapshot = self.known(index, &mut went, 0);
            return (went, snapshot);
        }
        let project = self.project;
        match &step.task {
            Task::Glue { inlay_id } => {
                let later = project.steps[index..].iter().any(|j| &j.id == inlay_id);
                match glue(
                    project,
                    &mut self.stock,
                    inlay_id,
                    glued.contains(inlay_id),
                    plugs,
                ) {
                    Ok(seat) => {
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
            }
            Task::Saw { inlay_id, leave } => {
                let name = name_of(project, inlay_id);
                match glued.iter().position(|id| id == inlay_id) {
                    None => went.errors.push(format!(
                        "\"{name}\" is not glued in when the list gets here, so there is no backer to saw off. Put this step below its glue-up."
                    )),
                    Some(body) => {
                        let over = self.stock.saw(body, *leave as f32);
                        if over <= SLIVER {
                            went.warnings.push(format!(
                                "Nothing of \"{name}\" stands more than {} mm above the surface any more: there is nothing to saw off.",
                                num(*leave)
                            ));
                        }
                    }
                }
            }
            _ => {}
        }
        let snapshot = self.keep(index, &went, 0);
        (went, snapshot)
    }

    /// The file of one part cut from the stock, as it was built last time
    /// or anew. A facing that takes the wood above the surface from the
    /// list is given what stands on `on`, the stock as it is when the
    /// facing gets to it.
    fn part(
        &mut self,
        index: usize,
        on: Option<&Workpiece>,
    ) -> (Rc<Result<Built, Vec<String>>>, Option<f64>) {
        let step = &self.project.steps[index];
        let listed = matches!(
            step.task,
            Task::Facing {
                above_auto: true,
                ..
            }
        );
        // A facing that takes something from the list hangs on what the
        // step's own key hangs on; any other part on itself alone.
        let hangs = matches!(
            step.task,
            Task::Facing {
                margin_auto: true,
                ..
            }
        );
        let key = if listed || hangs {
            hash_of(self.keys[index], &["part"])
        } else {
            hash_of(self.base, &[self.texts[index].as_str(), "part"])
        };
        self.used_builds.insert(key);
        let standing = (listed && index >= self.resume)
            .then(|| build::facing_start(self.project, &step.id))
            .flatten()
            .and_then(|(rect, _)| on.unwrap_or(&self.stock).top_in(rect))
            // A hair over, so that the first pass starts in the air.
            .map(|top| (top.max(0.0) * 100.0).ceil() / 100.0);
        if !self.cache.builds.contains_key(&key) || (listed && index >= self.resume) {
            progress::report(Stage::Build, index, self.project.steps.len());
            let built = build::build_with(self.project, &step.id, Part::Pocket, standing);
            self.cache.builds.insert(key, Rc::new(built));
        }
        (self.cache.builds[&key].clone(), standing)
    }

    /// Makes the one file of a run of entries and cuts the stock with it,
    /// entry by entry. Returns the file, and each entry as it went with the
    /// stock after it.
    /// The file of the entries of `run`, and how each of them went. There
    /// is no file when every one of them is suppressed.
    fn cut_run(
        &mut self,
        run: &[usize],
        file: usize,
    ) -> (Option<StockFile>, Vec<(StepRun, Rc<Snapshot>)>) {
        let project = self.project;
        // What is suppressed keeps its place in the list, but not in the file.
        let cutting: Vec<usize> = run
            .iter()
            .copied()
            .filter(|&index| !project.is_suppressed(&project.steps[index]))
            .collect();
        let tools_of = |built: &Built| -> HashMap<u32, Tool> {
            built
                .program
                .tools
                .iter()
                .map(|t| (t.number, t.tool.clone()))
                .collect()
        };
        let listed = |index: usize| {
            matches!(
                project.steps[index].task,
                Task::Facing {
                    above_auto: true,
                    ..
                }
            )
        };

        // The parts, in order. A facing that takes its height from the
        // stock needs the stock as the parts before it in this file leave
        // it: those are run on a copy, each from its own file, which cuts
        // the same wood as its stretch of the joined one.
        let mut ahead: Option<Workpiece> = None;
        let mut parts: Vec<Rc<Result<Built, Vec<String>>>> = Vec::new();
        let mut starts_above: Vec<Option<f64>> = Vec::new();
        for (k, &index) in cutting.iter().enumerate() {
            let (part, standing) = self.part(index, ahead.as_ref());
            let more = cutting[k + 1..]
                .iter()
                .any(|&later| later >= self.resume && listed(later));
            if let (true, true, Ok(built)) = (more, index >= self.resume, part.as_ref()) {
                progress::report(Stage::Ahead, index, project.steps.len());
                let copy = ahead.get_or_insert_with(|| self.stock.clone());
                sim::simulate_segments(
                    &mut copy.map,
                    &built.interpreted.segments,
                    &tools_of(built),
                    built.stock.thickness + built.stock.through,
                );
                copy.settle();
            }
            parts.push(part);
            starts_above.push(standing);
        }
        drop(ahead);

        let good: Vec<(&str, &Built)> = cutting
            .iter()
            .zip(&parts)
            .filter_map(|(&index, part)| {
                part.as_ref()
                    .as_ref()
                    .ok()
                    .map(|built| (project.steps[index].name.as_str(), built))
            })
            .collect();
        let mut record = StockFile {
            step_ids: cutting
                .iter()
                .map(|&index| project.steps[index].id.clone())
                .collect(),
            built: None,
            complete: good.len() == parts.len(),
            errors: Vec::new(),
            problems: Vec::new(),
        };

        // What each part that could be made cuts the stock with: its
        // stretch of the joined file and the line that begins on, or its
        // own file when they could not be joined.
        let mut stretches: Vec<Stretch> = Vec::new();
        match (!good.is_empty()).then(|| {
            let ids: Vec<&str> = cutting
                .iter()
                .map(|&i| project.steps[i].id.as_str())
                .collect();
            let (at, what) = build::stock_file_label(project, &ids, true);
            build::join(project, &good, at, &what)
        }) {
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
                    stretches.push((segments, tools.clone(), thickness, *from));
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
                        0,
                    ));
                }
            }
            None => {}
        }

        let mut stretches = stretches.into_iter();
        let mut cut: Vec<(StepRun, Rc<Snapshot>)> = Vec::new();
        let mut k = 0;
        for &index in run {
            let step = &project.steps[index];
            if project.is_suppressed(step) {
                let mut went = StepRun::of(step, None);
                went.suppressed = true;
                let snapshot = if index < self.resume {
                    self.known(index, &mut went, 0)
                } else {
                    progress::report(Stage::Step, index, project.steps.len());
                    self.keep(index, &went, 0)
                };
                cut.push((went, snapshot));
                continue;
            }
            let mut went = StepRun::of(step, Some(file));
            went.part = Some(parts[k].clone());
            let stretch = match parts[k].as_ref() {
                Ok(_) => stretches.next(),
                Err(errors) => {
                    went.errors = errors.clone();
                    None
                }
            };
            let start = stretch.as_ref().map_or(0, |s| s.3);
            let snapshot = if index < self.resume {
                let snapshot = self.known(index, &mut went, start);
                if let Some((segments, ..)) = stretch {
                    went.segments = segments;
                }
                snapshot
            } else {
                progress::report(Stage::Step, index, project.steps.len());
                if let Some((segments, tools, thickness, _)) = stretch {
                    went.starts_above = starts_above[k];
                    if went.starts_above.is_none() {
                        went.warnings
                            .extend(facing_start_warning(project, &self.stock, step));
                    }
                    went.problems =
                        sim::simulate_segments(&mut self.stock.map, &segments, &tools, thickness);
                    self.stock.settle();
                    went.segments = segments;
                }
                self.keep(index, &went, start)
            };
            record.problems.extend(went.problems.iter().cloned());
            cut.push((went, snapshot));
            k += 1;
        }
        ((!cutting.is_empty()).then_some(record), cut)
    }
}

/// For a facing that takes the wood above the surface from the list: the
/// height its file is to start at, as it stands on the stock when the list
/// gets to it. Takes the stock through the list for it, going on from what
/// `cache` holds. `None` for any other step.
pub fn starts_above(project: &Project, step_id: &str, cache: &mut Cache) -> Option<f64> {
    let step = project.steps.iter().find(|s| s.id == step_id)?;
    if !matches!(
        step.task,
        Task::Facing {
            above_auto: true,
            ..
        }
    ) {
        return None;
    }
    let timeline = timeline_with(project, cache).ok()?;
    timeline
        .steps
        .iter()
        .find(|went| went.step_id == step_id)?
        .starts_above
}

/// For a facing: what there is to say when more wood stands where it cuts
/// than it starts above.
fn facing_start_warning(project: &Project, stock: &Workpiece, step: &Step) -> Option<String> {
    let (rect, above) = build::facing_start(project, &step.id)?;
    // A facing that starts below the surface starts there, whatever `above` says.
    let start = match &step.task {
        Task::Facing { start_depth, .. } if *start_depth > 0.0 => -start_depth,
        _ => above,
    };
    let top = stock.top_in(rect)?;
    let level = |z: f64| {
        if z < 0.0 {
            format!("{} mm below", num(-z))
        } else {
            format!("{} mm above", num(z))
        }
    };
    (top > start + PROUD).then(|| {
        format!(
            "The wood stands {} the surface where this facing cuts, but its first pass starts {} it: the tool would go {} mm into the wood at once.",
            level(top),
            level(start),
            num(top - start)
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
    plugs: &HashMap<&str, Rc<Result<Preview, Vec<String>>>>,
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
        .as_ref()
        .map_err(|errors| -> Vec<String> {
            errors
                .iter()
                .map(|e| format!("{}: {e}", step.name))
                .collect()
        })?;
    // Its pocket may be cut into a surface below the stock's.
    let start = step.task.inlay_start();
    match &step.task {
        Task::Vcarve {
            engagement_depth, ..
        } => seat_plug(stock, plug, -engagement_depth - start),
        Task::Flat {
            insert_style: InsertStyle::Backer,
            pocket_depth,
            ..
        } => seat_plug(stock, plug, -pocket_depth - start),
        Task::Flat { pocket_depth, .. } => seat_inserts(stock, &plug.built, -pocket_depth - start),
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
/// it was cut, or turned over where it was cut mirrored, resting on the
/// highest wood under it. Each stands as a plain block of its outline.
fn seat_inserts(
    stock: &mut Workpiece,
    inserts: &Built,
    intended: f64,
) -> Result<Seat, Vec<String>> {
    let off = || vec!["The inserts do not lie over the stock at all.".to_string()];
    // Cut the way up they go in, or mirrored and turned over.
    let on_stock: Box<dyn Fn(&Point) -> Point> = match (inserts.origin, inserts.frame) {
        (Some([ox, oy]), _) => Box::new(move |p| [p[0] + ox, p[1] + oy]),
        (None, Some(PlugFrame { mirror_x, offset_y })) => {
            Box::new(move |p| [mirror_x - p[0], p[1] + offset_y])
        }
        (None, None) => {
            return Err(vec![
                "Internal error: the inserts have no position on the stock.".to_string(),
            ])
        }
    };
    let thickness = inserts.stock.thickness;
    // Turning a piece over turns its rings round: the union turns them back.
    let pieces: Vec<Region> = inserts
        .pocket
        .iter()
        .flat_map(|r| {
            union(&[Region::with_holes(
                r.outer.iter().map(&on_stock).collect(),
                r.holes
                    .iter()
                    .map(|ring| ring.iter().map(&on_stock).collect())
                    .collect(),
            )])
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
    use crate::build::tests::{backer_project, project, short_and_long, vcarve_project};
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
            cut_overrides: Default::default(),
            suppressed: false,
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
                    start_depth: 0.0,
                    above,
                    above_auto: false,
                    depth: 0.0,
                    margin,
                    margin_auto: false,
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
    fn a_plug_seats_in_a_pocket_cut_into_a_lower_surface() {
        let mut p = vcarve_project(true);
        p.base.thickness = 12.0;
        if let Task::Vcarve { start_depth, .. } = &mut p.steps[0].task {
            *start_depth = 3.0;
        }
        // The whole stock faced 3 mm down first.
        p.steps.insert(0, lowered(3.0));
        p.steps.push(glue_up());
        // Trimmed with the height from the list, down to the lower surface.
        let mut flush = trim(0.0, 6.0);
        if let Task::Facing {
            above_auto, depth, ..
        } = &mut flush.task
        {
            *above_auto = true;
            *depth = 3.0;
        }
        p.steps.push(flush);
        p.validate().unwrap();

        // 8 mm blank, 2 mm in, 3 mm down: 3 mm stands above the surface.
        assert_eq!(
            crate::build::facing_start(&p, "trim").map(|(_, above)| above),
            Some(3.0)
        );
        let t = timeline(&p).unwrap();
        for s in &t.steps {
            assert!(s.errors.is_empty(), "{:?}", s.errors);
            assert!(s.problems.is_empty(), "{:?}", s.problems);
        }
        let seat = t.steps[2].seat.unwrap();
        assert!(seat.proud > -0.02 && seat.proud < PROUD, "{seat:?}");
        assert!((seat.above - 3.0).abs() < PROUD, "{seat:?}");
        // Trimmed: the plug's wood at the lower surface, the stock's around it.
        let (z, owner) = at(&t, 4, 20.0, 15.0);
        assert!((z + 3.0).abs() < 0.02 && owner == 1, "{z} {owner}");
        let (z, owner) = at(&t, 4, 37.5, 30.0);
        assert!((z + 3.0).abs() < 0.02 && owner == 0, "{z} {owner}");
    }

    /// The whole stock faced `depth` down.
    fn lowered(depth: f64) -> Step {
        let mut down = trim(0.0, 0.0);
        down.id = "down".into();
        down.region_ids = vec![];
        if let Task::Facing { depth: d, .. } = &mut down.task {
            *d = depth;
        }
        down
    }

    #[test]
    fn plugs_and_inserts_seat_in_pockets_cut_into_a_lower_surface() {
        for backer in [false, true] {
            let mut p = if backer { backer_project() } else { project() };
            p.base.thickness = 12.0;
            if let Task::Flat { start_depth, .. } = &mut p.steps[0].task {
                *start_depth = 1.0;
            }
            p.steps.insert(0, lowered(1.0));
            p.steps.push(glue_up());
            let t = timeline(&p).unwrap();
            for s in &t.steps {
                assert!(s.errors.is_empty(), "{backer}: {:?}", s.errors);
                assert!(s.problems.is_empty(), "{backer}: {:?}", s.problems);
            }
            // A 4 mm board on the floor of a 2 mm pocket 1 mm down: its top
            // stands 1 mm above the stock's surface.
            let seat = t.steps[2].seat.unwrap();
            assert!(seat.proud.abs() < 0.02, "{backer}: {seat:?}");
            assert!((seat.above - 1.0).abs() < 0.02, "{backer}: {seat:?}");
            let (z, owner) = at(&t, 3, 20.0, 15.0);
            assert!(
                (z - 1.0).abs() < 0.02 && owner == 1,
                "{backer}: {z} {owner}"
            );
        }
    }

    #[test]
    fn a_facing_that_starts_below_the_surface_says_when_wood_stands_higher() {
        let mut p = vcarve_project(true);
        p.base.thickness = 12.0;
        p.steps.push(glue_up());
        // 6 mm of plug stands above the surface; the facing starts 1 mm below it.
        let mut low = trim(0.0, 6.0);
        if let Task::Facing {
            start_depth, depth, ..
        } = &mut low.task
        {
            *start_depth = 1.0;
            *depth = 2.0;
        }
        p.steps.push(low);
        let t = timeline(&p).unwrap();
        let warnings = t.steps[2].warnings.join(" | ");
        assert!(
            warnings.contains("starts 1 mm below it") && warnings.contains("into the wood at once"),
            "{warnings}"
        );
        // It takes nothing off what stands above it, for the steps after it.
        let mut after = trim(0.0, 6.0);
        after.id = "after".into();
        if let Task::Facing { above_auto, .. } = &mut after.task {
            *above_auto = true;
        }
        p.steps.push(after);
        assert_eq!(
            crate::build::facing_start(&p, "after").map(|(_, above)| above),
            Some(6.0)
        );
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
    fn inserts_cut_mirrored_by_a_longer_end_mill_stand_where_they_were_drawn() {
        let mut p = short_and_long();
        p.steps.push(glue_up());
        let t = timeline(&p).unwrap();
        assert!(t.steps[1].errors.is_empty(), "{:?}", t.steps[1].errors);
        let seat = t.steps[1].seat.unwrap();
        assert!(
            seat.proud.abs() < 1e-3 && (seat.above - 2.0).abs() < 1e-3,
            "{seat:?}"
        );
        // The rectangle and the L's upright, on the side they were drawn.
        for (x, y) in [(20.0, 15.0), (43.5, 30.0)] {
            let (z, owner) = at(&t, 2, x, y);
            assert!(
                (z - 2.0).abs() < 1e-3 && owner == 1,
                "({x}, {y}): {z} {owner}"
            );
        }
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
                    start_depth: 0.0,
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
        assert_eq!(plug.file_name, "Test-board-01-Flat-inlay-1-plug.cnc");
        // Every file is named the same from the Files tab as from its own step.
        let own = |id: &str, part: Part| build::build(&p, id, part).unwrap().file_name;
        assert_eq!(plug.file_name, own("j", Part::Plug));
        // Moved down the list, the inlay's plug kept from before takes its new number.
        {
            let mut cache = Cache::default();
            timeline_with(&p, &mut cache).unwrap();
            let mut moved = p.clone();
            let j = moved.steps.remove(0);
            moved.steps.insert(1, j);
            let again = timeline_with(&moved, &mut cache).unwrap();
            let plug = again.parts[0].built.as_ref().unwrap();
            assert_eq!(plug.file_name, "Test-board-02-Flat-inlay-1-plug.cnc");
            assert_eq!(
                plug.file_name,
                build::build(&moved, "j", Part::Plug).unwrap().file_name
            );
        }
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
        assert_eq!(first.file_name, "Test-board-01-stock.cnc");
        assert_eq!(
            t.files[1].built.as_ref().unwrap().file_name,
            "Test-board-04-trim.cnc"
        );
        // A stretch of one entry is that entry's file, named as in its own panel.
        assert_eq!(
            t.files[1].built.as_ref().unwrap().file_name,
            build::build(&p, "trim", Part::Pocket).unwrap().file_name
        );
        assert!(first.gcode.contains("\n(Step 1: Flat inlay 1)\n"));
        assert!(first.gcode.contains("\n(Step 2: extra)\n"));
        // One tool for both: it is loaded once.
        assert_eq!(first.stats.tool_changes, 1);

        // Picked entries make a file of their own. All of a stretch is the
        // file the timeline has; one alone is named after itself.
        let ids = |ids: &[&str]| ids.iter().map(|id| id.to_string()).collect::<Vec<_>>();
        let mut cache = Cache::default();
        let whole = export(&p, &ids(&["extra", "j"]), &mut cache).unwrap();
        assert_eq!(whole.gcode, first.gcode);
        assert_eq!(whole.file_name, first.file_name);
        let one = export(&p, &ids(&["extra"]), &mut cache).unwrap();
        assert_eq!(one.file_name, "Test-board-02-extra.cnc");
        assert_eq!(one.file_name, own("extra", Part::Pocket));
        let pocket = export(&p, &ids(&["j"]), &mut cache).unwrap();
        assert_eq!(pocket.file_name, "Test-board-01-Flat-inlay-1-pocket.cnc");
        assert_eq!(pocket.file_name, own("j", Part::Pocket));
        assert!(one.gcode.contains("\n(Step 1: extra)\n"));
        assert!(!one.gcode.contains("Flat inlay 1)"));
        // Across the glue-up there is no one file, and none for the glue-up.
        assert!(export(&p, &ids(&["j", "trim"]), &mut cache).unwrap_err()[0]
            .contains("cannot be one file"));
        assert!(export(&p, &ids(&["glue"]), &mut cache).is_err());
        assert!(export(&p, &[], &mut cache).is_err());
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

        // Without a glue-up there is one file, numbered all the same.
        p.steps.retain(|j| j.id != "glue" && j.id != "trim");
        let t = timeline(&p).unwrap();
        assert_eq!(t.files.len(), 1);
        assert_eq!(
            t.files[0].built.as_ref().unwrap().file_name,
            "Test-board-01-stock.cnc"
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
    fn a_suppressed_step_keeps_its_place_but_cuts_nothing() {
        let mut p = backer_project();
        p.steps.push(Step {
            region_ids: vec![1],
            ..step(
                "extra",
                Task::Pocket {
                    start_depth: 0.0,
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
        let ids = |ids: &[&str]| ids.iter().map(|id| id.to_string()).collect::<Vec<_>>();

        // A plain pocket left out: it has no file, the stock is as the inlay
        // left it, and the files keep the names they had.
        p.steps[1].suppressed = true;
        assert_eq!(file_numbers(&p), vec![Some(1), None, None, Some(2)]);
        let t = timeline(&p).unwrap();
        assert_eq!(t.steps.len(), 4);
        assert_eq!(t.snapshots.len(), 5);
        assert!(t.steps[1].suppressed && t.steps[1].file.is_none());
        assert!(t.steps[1].segments.is_empty() && t.steps[1].part.is_none());
        assert_eq!(t.snapshots[2], t.snapshots[1]);
        assert_eq!(at(&t, 2, 43.5, 30.0), (0.0, 0));
        assert_eq!(t.files.len(), 2);
        assert_eq!(t.files[0].step_ids, ids(&["j"]));
        assert!(t.files[0].complete);
        assert_eq!(
            t.files[1].built.as_ref().unwrap().file_name,
            "Test-board-04-trim.cnc"
        );
        let mut cache = Cache::default();
        assert!(export(&p, &ids(&["extra"]), &mut cache).unwrap_err()[0].contains("suppressed"));
        // Picked with the rest of its stretch, it is left out of the file,
        // which has the inlay's pocket alone and its name.
        let rest = export(&p, &ids(&["j", "extra"]), &mut cache).unwrap();
        assert_eq!(rest.file_name, "Test-board-01-Flat-inlay-1-pocket.cnc");
        assert_eq!(rest.file_name, t.files[0].built.as_ref().unwrap().file_name);
        assert!(!rest.gcode.contains("extra)"));

        // The inlay left out: no pocket, no plug, and its glue-up goes with
        // it, so the facing is in the same file as the pocket before it.
        p.steps[1].suppressed = false;
        p.steps[0].suppressed = true;
        assert!(p.is_suppressed(&p.steps[2]) && !p.steps[2].suppressed);
        assert_eq!(file_numbers(&p), vec![None, Some(1), None, Some(1)]);
        let t = timeline(&p).unwrap();
        assert!(t.parts.is_empty() && t.glued.is_empty());
        assert!(t.steps[2].suppressed && t.steps[2].errors.is_empty());
        assert_eq!(t.files.len(), 1);
        assert_eq!(t.files[0].step_ids, ids(&["extra", "trim"]));
        assert_eq!(at(&t, 1, 20.0, 15.0), (0.0, 0));

        // Everything that was there comes back as it was.
        p.steps[0].suppressed = false;
        let mut cache = Cache::default();
        let before = timeline_with(&p, &mut cache).unwrap();
        p.steps[3].suppressed = true;
        let without = timeline_with(&p, &mut cache).unwrap();
        assert_eq!(cache.redone, 1);
        assert_eq!(without.files.len(), 1);
        p.steps[3].suppressed = false;
        assert_eq!(timeline_with(&p, &mut cache).unwrap(), before);
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

    fn saw(leave: f64) -> Step {
        step(
            "saw",
            Task::Saw {
                inlay_id: "j".into(),
                leave,
            },
        )
    }

    fn listed_trim(margin: f64) -> Step {
        let mut step = trim(0.0, margin);
        if let Task::Facing { above_auto, .. } = &mut step.task {
            *above_auto = true;
        }
        step
    }

    #[test]
    fn a_backer_is_sawn_off_and_the_rest_faced_flush() {
        let mut p = backer_project();
        p.steps.push(glue_up());
        p.steps.push(saw(0.5));
        p.steps.push(listed_trim(8.0));
        p.validate().unwrap();
        assert_eq!(file_numbers(&p), vec![Some(1), None, None, Some(2)]);
        // By the list, half a millimetre is left for the facing.
        assert!((build::facing_start(&p, "trim").unwrap().1 - 0.5).abs() < 1e-9);
        let t = timeline(&p).unwrap();
        for s in &t.steps {
            assert!(s.errors.is_empty(), "{:?}", s.errors);
            assert!(s.problems.is_empty(), "{:?}", s.problems);
            assert!(s.warnings.is_empty(), "{:?}", s.warnings);
        }
        // Glued in: the backer covers shapes and margin alike, 2 mm up, and
        // stands off the stock around the shapes.
        let glued = &t.snapshots[2];
        let cell = |x: f64, y: f64| (y / t.cell) as usize * t.nx + (x / t.cell) as usize;
        assert_eq!(at(&t, 2, 2.0, 2.0).1, 1);
        assert!(glued.unders[cell(2.0, 2.0)] > 1.0 && glued.floors[cell(2.0, 2.0)] == 0.0);
        assert!(glued.unders[cell(20.0, 15.0)] < -1.9);
        assert!(glued.unders[cell(58.0, 38.0)].is_nan() == (at(&t, 2, 58.0, 38.0).1 == 0));
        // Sawn off: the backer is gone, and the plug stands half a millimetre.
        assert_eq!(at(&t, 3, 2.0, 2.0), (0.0, 0));
        assert_eq!(at(&t, 3, 37.5, 30.0), (0.0, 0));
        let (z, owner) = at(&t, 3, 20.0, 15.0);
        assert!((z - 0.5).abs() < 1e-6 && owner == 1, "{z} {owner}");
        // Faced: flush, from where the stock says the wood stands.
        assert!((t.steps[3].starts_above.unwrap() - 0.5).abs() < 0.011);
        let (z, owner) = at(&t, 4, 20.0, 15.0);
        assert!(z.abs() < 0.02 && owner == 1, "{z} {owner}");

        // Sawn before it is glued in, and sawn where nothing stands any more.
        let mut early = backer_project();
        early.steps.push(saw(0.5));
        early.steps.push(glue_up());
        let t = timeline(&early).unwrap();
        assert!(t.steps[1].errors[0].contains("not glued in"));
        assert_eq!(t.snapshots[1], t.snapshots[2]);
        let mut twice = p.clone();
        twice.steps.push(Step {
            id: "again".into(),
            ..saw(0.5)
        });
        let t = timeline(&twice).unwrap();
        assert!(t.steps[4].warnings[0].contains("nothing to saw off"));
    }

    #[test]
    fn a_facing_starts_where_the_wood_stands_on_the_stock() {
        // Glued in before its pocket is cut, the plug lies on the surface:
        // 4 mm up, where the inlay's numbers say 2.
        let mut p = backer_project();
        p.steps.insert(0, glue_up());
        p.steps.insert(1, listed_trim(8.0));
        assert!((build::facing_start(&p, "trim").unwrap().1 - 2.0).abs() < 1e-9);
        let t = timeline(&p).unwrap();
        let went = &t.steps[1];
        assert!(went.errors.is_empty(), "{:?}", went.errors);
        assert!((went.starts_above.unwrap() - 4.0).abs() < 0.03, "{went:?}");
        // The file was made for that height: nothing runs into the plug.
        assert!(went.problems.is_empty(), "{:?}", went.problems);
        assert!(went.warnings.is_empty(), "{:?}", went.warnings);
        assert!(at(&t, 2, 20.0, 15.0).0.abs() < 0.02);

        // In one file with a facing before it, it starts where that one left the wood.
        let mut p = backer_project();
        p.steps.push(glue_up());
        if let Task::Facing { depth, .. } = &mut p.steps.last_mut().unwrap().task {
            *depth = 0.0;
        }
        let mut rough = trim(2.0, 8.0);
        rough.id = "rough".into();
        if let Task::Facing { depth, .. } = &mut rough.task {
            *depth = -1.0;
        }
        p.steps.push(rough);
        p.steps.push(listed_trim(8.0));
        let t = timeline(&p).unwrap();
        assert_eq!(
            t.files[1].step_ids,
            vec!["rough".to_string(), "trim".to_string()]
        );
        assert!(
            (t.steps[3].starts_above.unwrap() - 1.0).abs() < 0.03,
            "{:?}",
            t.steps[3]
        );
        assert!(t.files[1].problems.is_empty(), "{:?}", t.files[1].problems);
        assert!(at(&t, 4, 20.0, 15.0).0.abs() < 0.02);
    }

    #[test]
    fn a_trim_follows_its_inlays_margin_and_its_own_file_starts_on_the_stock() {
        let mut p = backer_project();
        p.steps.push(glue_up());
        let mut follows = listed_trim(1.0);
        if let Task::Facing { margin_auto, .. } = &mut follows.task {
            *margin_auto = true;
        }
        p.steps.push(follows);
        p.validate().unwrap();
        // The inlay's margin is 8, whatever the facing's own number says.
        assert_eq!(build::facing_margin(&p, &p.steps[2]), 8.0);
        assert_eq!(
            build::facing_start(&p, "trim").unwrap().0,
            [-3.0, -3.0, 63.0, 43.0]
        );
        let mut cache = Cache::default();
        let t = timeline_with(&p, &mut cache).unwrap();
        // The whole blank is faced off: nothing of the backer is left at its rim.
        assert_eq!(at(&t, 3, 0.5, 0.5).1, 0);
        assert!(at(&t, 3, 0.5, 0.5).0.abs() < 0.02);

        // The inlay's margin changes: the facing follows, and is done again.
        if let Task::Flat { insert_margin, .. } = &mut p.steps[0].task {
            *insert_margin = 10.0;
        }
        assert_eq!(build::facing_margin(&p, &p.steps[2]), 10.0);
        let t = timeline_with(&p, &mut cache).unwrap();
        assert_eq!(cache.redone, 3);
        assert_eq!(t, timeline(&p).unwrap());

        // Shapes of no inlay: its own number.
        let mut alone = p.clone();
        alone.steps[2].region_ids.clear();
        assert_eq!(build::facing_margin(&alone, &alone.steps[2]), 1.0);

        // Its own file starts where its part of the stock's file does: on a
        // plug glued in before its pocket, 4 mm up and not the 2 of the numbers.
        let mut p = backer_project();
        p.steps.insert(0, glue_up());
        p.steps.insert(1, listed_trim(8.0));
        let mut cache = Cache::default();
        let standing = starts_above(&p, "trim", &mut cache).unwrap();
        assert!((standing - 4.0).abs() < 0.03, "{standing}");
        assert_eq!(starts_above(&p, "j", &mut cache), None);
        let own = build::preview_with(&p, "trim", Part::Pocket, Some(standing)).unwrap();
        let top = own
            .built
            .interpreted
            .segments
            .iter()
            .filter(|s| !s.rapid)
            .map(|s| s.from[2].max(s.to[2]))
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(top > 3.0, "the own file cuts no higher than {top}");
    }

    #[test]
    fn only_the_steps_from_the_first_that_changed_are_done_again() {
        let mut p = backer_project();
        p.steps.push(glue_up());
        p.steps.push(listed_trim(8.0));
        let mut cache = Cache::default();
        let first = timeline_with(&p, &mut cache).unwrap();
        assert_eq!(cache.redone, 3);
        assert_eq!(first, timeline(&p).unwrap());
        // Nothing changed: nothing is done, and nothing comes out different.
        let again = timeline_with(&p, &mut cache).unwrap();
        assert_eq!(cache.redone, 0);
        assert_eq!(again, first);

        // The last step changed: it alone is done again.
        if let Task::Facing { depth, .. } = &mut p.steps[2].task {
            *depth = 0.5;
        }
        let changed = timeline_with(&p, &mut cache).unwrap();
        assert_eq!(cache.redone, 1);
        assert_eq!(changed, timeline(&p).unwrap());
        assert_ne!(changed.snapshots[3], first.snapshots[3]);

        // A step added at the end; then the inlay changed, which the glue-up hangs on too.
        p.steps.push(Step {
            region_ids: vec![1],
            ..step(
                "extra",
                Task::Pocket {
                    start_depth: 0.0,
                    depth: 1.0,
                    pattern: Pattern::Offset,
                    direction: PassDirection::Longer,
                    clearing_tool_ids: vec!["t-endmill".into()],
                },
            )
        });
        let longer = timeline_with(&p, &mut cache).unwrap();
        assert_eq!(cache.redone, 1);
        assert_eq!(longer, timeline(&p).unwrap());
        if let Task::Flat { pocket_depth, .. } = &mut p.steps[0].task {
            *pocket_depth = 1.5;
        }
        let deeper = timeline_with(&p, &mut cache).unwrap();
        assert_eq!(cache.redone, 4);
        assert_eq!(deeper, timeline(&p).unwrap());

        // Something that is not a step: everything again.
        p.base.thickness = 20.0;
        timeline_with(&p, &mut cache).unwrap();
        assert_eq!(cache.redone, 4);
        // What is kept is for this list only.
        assert_eq!(cache.outcomes.len(), 4);
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
                    start_depth: 0.0,
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

    #[test]
    fn a_pocket_deeper_than_the_stock_cuts_a_hole_in_it() {
        let mut p = backer_project();
        p.base.thickness = 2.0;
        p.steps = vec![Step {
            region_ids: vec![0],
            ..step(
                "hole",
                Task::Pocket {
                    start_depth: 0.0,
                    depth: 2.5,
                    pattern: Pattern::Offset,
                    direction: PassDirection::Longer,
                    clearing_tool_ids: vec!["t-endmill".into()],
                },
            )
        }];
        let t = timeline(&p).unwrap();
        let s = &t.steps[0];
        assert!(s.errors.is_empty(), "{:?}", s.errors);
        assert!(s.problems.is_empty(), "{:?}", s.problems);
        // Down past the bottom of the stock, which it is drawn open at.
        let (z, _) = at(&t, 1, 20.0, 15.0);
        assert!((z + 2.5).abs() < 0.02, "{z}");
    }

    /// What the work of `work` reports, with what it gives.
    fn watched<T>(work: impl FnOnce() -> T) -> (T, Vec<progress::Report>) {
        let seen = Rc::new(std::cell::RefCell::new(Vec::new()));
        let into = seen.clone();
        let result = progress::watch(move |r| into.borrow_mut().push(r), work);
        let reports = seen.borrow().clone();
        (result, reports)
    }

    fn of(reports: &[progress::Report], stage: Stage) -> Vec<u32> {
        reports
            .iter()
            .filter(|r| r.stage == stage)
            .map(|r| r.done)
            .collect()
    }

    /// Every cutting is of something the list has just named: a plug's own
    /// board, a copy cut ahead, or the stock at a step. Never straight
    /// after a file was only worked out.
    fn every_cut_is_named(reports: &[progress::Report]) {
        let mut last = None;
        for r in reports {
            match r.stage {
                Stage::Cut => assert!(
                    matches!(last, Some(Stage::Plug | Stage::Ahead | Stage::Step)),
                    "a cut after {last:?}"
                ),
                Stage::Paths | Stage::Write | Stage::Fit => {}
                stage => last = Some(stage),
            }
        }
    }

    #[test]
    fn a_file_cut_ahead_is_said_to_be_also_when_it_was_kept() {
        let mut p = backer_project();
        p.steps.push(glue_up());
        // In one stretch of the list: a facing, then one that takes its
        // height from the stock as the first leaves it.
        p.steps.push(trim(2.0, 8.0));
        p.steps.push(Step {
            id: "trim2".into(),
            name: "trim2".into(),
            ..listed_trim(8.0)
        });
        p.validate().unwrap();
        let mut cache = Cache::default();
        let (_, first) = watched(|| timeline_with(&p, &mut cache).unwrap());
        every_cut_is_named(&first);
        assert_eq!(of(&first, Stage::Ahead), vec![2]);
        assert_eq!(of(&first, Stage::Build), vec![0, 2, 3]);
        assert_eq!(of(&first, Stage::Step), vec![0, 1, 2, 3]);

        // The inlay changed: the list is gone through again from the start.
        // The first facing's file is kept, and is still cut ahead.
        p.steps[0].name = "renamed".into();
        let (_, again) = watched(|| timeline_with(&p, &mut cache).unwrap());
        every_cut_is_named(&again);
        assert_eq!(of(&again, Stage::List), vec![0, 4]);
        assert_eq!(of(&again, Stage::Ahead), vec![2]);
        assert!(!of(&again, Stage::Build).contains(&2));
        assert_eq!(of(&again, Stage::Step), vec![0, 1, 2, 3]);
        // The cutting ahead comes before the stock is at the step after the glue-up.
        let ahead = again.iter().position(|r| r.stage == Stage::Ahead).unwrap();
        let at_two = again
            .iter()
            .position(|r| r.stage == Stage::Step && r.done == 2)
            .unwrap();
        assert!(ahead < at_two);
    }

    #[test]
    fn a_suppressed_step_is_reached_like_any_other() {
        let mut p = backer_project();
        p.steps.push(glue_up());
        let mut left_out = trim(2.0, 8.0);
        left_out.suppressed = true;
        p.steps.push(left_out);
        p.validate().unwrap();
        let (_, reports) = watched(|| timeline(&p).unwrap());
        assert_eq!(of(&reports, Stage::Step), vec![0, 1, 2]);
        // Nothing is worked out or cut for it.
        assert_eq!(of(&reports, Stage::Build), vec![0]);
        every_cut_is_named(&reports);
    }

    #[test]
    fn a_list_with_nothing_to_do_says_only_that_it_is_done() {
        let mut p = backer_project();
        p.steps.clear();
        let (_, reports) = watched(|| timeline(&p).unwrap());
        assert_eq!(
            reports,
            vec![progress::Report {
                stage: Stage::List,
                done: 0,
                total: 0
            }]
        );
    }

    #[test]
    fn the_list_says_which_step_it_is_at_as_it_goes() {
        let mut p = backer_project();
        p.steps.push(glue_up());
        p.steps.push(trim(2.0, 8.0));
        p.validate().unwrap();
        let (t, reports) = watched(|| timeline(&p).unwrap());
        // Watching changes nothing of what comes out.
        assert_eq!(t, timeline(&p).unwrap());

        // Every step is reached once, in the order of the list, counted in its steps.
        assert_eq!(of(&reports, Stage::Step), vec![0, 1, 2]);
        // It goes on from the start, once the plugs are made, and ends with all done.
        assert_eq!(of(&reports, Stage::List), vec![0, 3]);
        assert_eq!(reports.last().unwrap().stage, Stage::List);
        every_cut_is_named(&reports);
        // The inlay's plug is made first, then the files of the two steps that are cut.
        assert_eq!(of(&reports, Stage::Plug), vec![0]);
        assert_eq!(of(&reports, Stage::Build), vec![0, 2]);
        assert_eq!(reports[0].stage, Stage::Plug);
        for r in reports.iter().filter(|r| {
            matches!(
                r.stage,
                Stage::Step | Stage::Plug | Stage::Build | Stage::List
            )
        }) {
            assert_eq!(r.total, 3);
        }

        // A file is worked out, then written, then cut with: three files here, the plug and two on the stock.
        assert_eq!(of(&reports, Stage::Paths).len(), 3);
        assert!(of(&reports, Stage::Write).len() >= 3);
        // Each cutting starts at nothing and only goes on, short of its end.
        let mut cuts = 0;
        let mut last: Option<progress::Report> = None;
        for r in reports.iter().filter(|r| r.stage == Stage::Cut) {
            assert!(r.total > 0 && r.done < r.total, "{r:?}");
            match last {
                Some(before) if r.done != 0 => {
                    assert!(
                        r.done > before.done && r.total == before.total,
                        "{before:?} then {r:?}"
                    )
                }
                _ => {
                    assert_eq!(r.done, 0);
                    cuts += 1;
                }
            }
            last = Some(*r);
        }
        // The plug on its board, and the two steps on the stock.
        assert_eq!(cuts, 3);
        // The stock is cut with a step after the list says it is at that step.
        let first_step = reports.iter().position(|r| r.stage == Stage::Step).unwrap();
        assert!(reports[first_step + 1..]
            .iter()
            .any(|r| r.stage == Stage::Cut));
    }

    #[test]
    fn what_is_kept_from_last_time_is_not_reported_again() {
        let mut p = backer_project();
        p.steps.push(glue_up());
        p.steps.push(listed_trim(8.0));
        let mut cache = Cache::default();
        let (_, first) = watched(|| timeline_with(&p, &mut cache).unwrap());
        assert_eq!(of(&first, Stage::Step), vec![0, 1, 2]);

        // Nothing changed: no step is done again. The files of the list are
        // still joined and written anew, and that is all that is said.
        let (_, again) = watched(|| timeline_with(&p, &mut cache).unwrap());
        assert!(
            again
                .iter()
                .all(|r| matches!(r.stage, Stage::Write | Stage::List)),
            "{again:?}"
        );
        // It says only that all of it is done.
        assert_eq!(of(&again, Stage::List), vec![3]);

        // The last step changed: the list starts at it.
        if let Task::Facing { depth, .. } = &mut p.steps[2].task {
            *depth = 0.5;
        }
        let (_, changed) = watched(|| timeline_with(&p, &mut cache).unwrap());
        assert_eq!(of(&changed, Stage::Step), vec![2]);
        assert_eq!(of(&changed, Stage::List), vec![2, 3]);
        assert_eq!(of(&changed, Stage::Build), vec![2]);
        assert_eq!(of(&changed, Stage::Plug), Vec::<u32>::new());
    }
}
