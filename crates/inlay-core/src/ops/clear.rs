//! Area clearing with a flat end mill: removes everything the tool can reach
//! inside a set of regions, down to a flat floor.
//!
//! The tool follows rings parallel to the boundary, from the middle outwards,
//! one depth pass at a time. The outermost ring puts the tool's edge exactly
//! on the boundary, so inside corners come out rounded to the tool's radius.
//!
//! A second, smaller tool can follow a larger one: it then works only where
//! its edge reaches wood the tools before it left (rest machining).

use crate::geom::boolean::{difference, intersection};
use crate::geom::offset::{offset, open};
use crate::geom::{distance, Point, Region, Ring};
use crate::project::PassDirection;
use crate::toolpath::PathBuilder;

#[derive(Debug, Clone, PartialEq)]
pub struct ClearParams {
    pub tool_diameter: f64,
    /// Depth of the floor below Z0. Positive.
    pub depth: f64,
    /// How deep the first pass starts: the wood above it, where the tool
    /// runs, is gone already. 0 to start at the surface.
    pub start: f64,
    /// Sideways distance between rings, mm.
    pub stepover: f64,
    /// Largest depth per pass, mm.
    pub stepdown: f64,
    /// Feed while cutting sideways, mm/min.
    pub feed: f64,
    /// Feed while cutting straight down, mm/min.
    pub plunge: f64,
    /// Depth gained per mm of travel when the tool goes down into wood along
    /// its path. 0 to plunge straight down.
    pub ramp: f64,
}

impl ClearParams {
    /// How much is cut, from the start down to the floor, mm.
    fn cut(&self) -> f64 {
        self.depth - self.start
    }

    /// The height of the floor after `pass` of `passes` equal passes: the
    /// start after none, the floor after all.
    fn level(&self, pass: usize, passes: usize) -> f64 {
        -(self.start + self.cut() * pass as f64 / passes as f64)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClearError {
    /// No part of the regions is wide enough for the tool.
    ToolTooWide,
}

/// Leftover wood thinner than twice this is not worth a visit: it is the
/// rounding of curves, not something a tool before left standing, mm.
const REST_SLIVER: f64 = 0.02;

/// How much further than its radius from leftover wood the tool's centre is
/// still sent, so that rounding never keeps it off a wall it has to follow, mm.
const REST_MARGIN: f64 = 0.05;

/// Appends the clearing moves for `regions` to `path`. The tool must already
/// be loaded and spinning. Returns the area the tool's edge reaches, i.e. the
/// pocket that results.
pub fn clear(
    path: &mut PathBuilder,
    regions: &[Region],
    p: &ClearParams,
) -> Result<Vec<Region>, ClearError> {
    let centres = centres(regions, &[], p.tool_diameter);
    if centres.is_empty() {
        return Err(ClearError::ToolTooWide);
    }
    Ok(clear_centres(path, &centres, p))
}

/// Where the centre of a tool of this diameter has to go to clear `regions`,
/// given that `already` has been cut to full depth by the tools before it.
/// The tool's edge stays inside `regions`. Empty when the tool fits nowhere,
/// or when nothing it can reach is left.
pub fn centres(regions: &[Region], already: &[Region], tool_diameter: f64) -> Vec<Region> {
    let radius = tool_diameter / 2.0;
    let mut out = Vec::new();
    // One separate area at a time, so the tool finishes one before the next.
    for region in regions {
        let allowed = offset(std::slice::from_ref(region), -radius);
        if already.is_empty() || allowed.is_empty() {
            out.extend(allowed);
            continue;
        }
        // What this tool's edge can reach, less what is gone already.
        let rest: Vec<Region> = offset(&allowed, radius)
            .iter()
            .flat_map(|r| difference(r, already))
            .collect();
        let rest = open(&rest, REST_SLIVER);
        if rest.is_empty() {
            continue;
        }
        // The tool only cuts while its centre is within its radius of that.
        let near = offset(&rest, radius + REST_MARGIN);
        out.extend(allowed.iter().flat_map(|a| intersection(a, &near)));
    }
    out
}

/// Clears with the tool's centre kept inside `centres`, one separate area at
/// a time to full depth, so the tool does not hop between areas after every
/// ring. Returns the area the tool's edge reaches.
pub fn clear_centres(path: &mut PathBuilder, centres: &[Region], p: &ClearParams) -> Vec<Region> {
    for area in centres {
        clear_one(path, area, p);
    }
    offset(centres, p.tool_diameter / 2.0)
}

/// A run shorter than this is not worth ramping along: the tool plunges, mm.
const MIN_RAMP_RUN: f64 = 0.5;

/// Takes the tool from `top` down to `z` so that it arrives at the end of
/// `run`, descending along the run instead of straight down: `slope` is the
/// depth gained per mm. Where the run is too short for that, the tool goes
/// back and forth along it. No more than the last `limit` mm of the run are
/// used. With no slope, or hardly any run, the tool plunges at the run's end.
/// Along the ramp it moves at `feed`, or slower where that would take it down
/// faster than `plunge`.
///
/// The run must lie where the tool is about to cut at `z` anyway, and
/// everything along it must already be cut down to `top`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn ramp_in(
    path: &mut PathBuilder,
    run: &[Point],
    top: f64,
    z: f64,
    slope: f64,
    limit: f64,
    feed: f64,
    plunge: f64,
) {
    let Some(&entry) = run.last() else { return };
    let total: f64 = run.windows(2).map(|w| distance(w[0], w[1])).sum();
    let drop = top - z;
    let usable = total.min(limit);
    // Already in the cut at the entry: no need to lift out of it first.
    let continuing = path
        .position()
        .is_some_and(|pos| distance([pos[0], pos[1]], entry) < 1e-6 && pos[2] <= top + 1e-9);
    if slope <= 0.0 || usable < MIN_RAMP_RUN || drop <= 1e-9 {
        if !continuing {
            path.rapid_to(entry, top + path.clearance());
        }
        path.feed_to([entry[0], entry[1], z], plunge);
        return;
    }
    let leg = (drop / slope).min(usable);
    // The last `leg` mm of the run, from its far end to the entry.
    let mut points = vec![entry];
    let mut left = leg;
    for i in (1..run.len()).rev() {
        let (a, b) = (run[i - 1], run[i]);
        let d = distance(a, b);
        if d >= left {
            let t = if d > 0.0 { left / d } else { 0.0 };
            points.push([b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t]);
            break;
        }
        points.push(a);
        left -= d;
    }
    points.reverse();

    // The last leg runs towards the entry. With an even number of legs the
    // first one starts there too, which is where a tool already in the cut is.
    let mut legs = (drop / slope / leg - 1e-9).ceil().max(1.0) as usize;
    if continuing && legs % 2 == 1 {
        legs += 1;
    }
    let mut forward = legs % 2 == 1;
    let first = if forward { points[0] } else { entry };
    if !continuing {
        path.rapid_to(first, top + path.clearance());
    }
    path.feed_to([first[0], first[1], top], plunge);
    let whole = leg * legs as f64;
    // As fast along the ramp as takes the tool down no faster than it plunges.
    let steep = drop / whole;
    let feed = feed.min(plunge * (1.0 + steep * steep).sqrt() / steep);
    let mut done = 0.0;
    for _ in 0..legs {
        let mut order = points.clone();
        if !forward {
            order.reverse();
        }
        for w in order.windows(2) {
            done += distance(w[0], w[1]);
            let height = top - drop * (done / whole).min(1.0);
            path.feed_to([w[1][0], w[1][1], height], feed);
        }
        forward = !forward;
    }
    path.feed_to([entry[0], entry[1], z], plunge);
}

/// The stretch of a ring that leads up to its point `start`, at least `length`
/// long where the ring is, as a run for [`ramp_in`].
pub(crate) fn ring_run(ring: &Ring, start: usize, length: f64) -> Vec<Point> {
    let n = ring.len();
    let mut points = vec![ring[start]];
    let mut reached = 0.0;
    for k in 1..=n {
        let q = ring[(start + n - k) % n];
        reached += distance(points[points.len() - 1], q);
        points.push(q);
        if reached >= length {
            break;
        }
    }
    points.reverse();
    points
}

/// One light pass along the walls: the tool's centre follows every ring of
/// `tracks` down to `p.depth`, in steps no deeper than the tool is wide. For
/// taking off the little that roughing left on the walls.
pub fn finish_walls(path: &mut PathBuilder, tracks: &[Region], p: &ClearParams) {
    let passes = (p.cut() / p.tool_diameter).ceil().max(1.0) as usize;
    for ring in tracks.iter().flat_map(|r| r.rings()) {
        for pass in 1..=passes {
            let z = p.level(pass, passes);
            let above = p.level(pass - 1, passes);
            let start = nearest_vertex(ring, path.position().map(|q| [q[0], q[1]]));
            let run = ring_run(
                ring,
                start,
                if p.ramp > 0.0 {
                    (above - z) / p.ramp
                } else {
                    0.0
                },
            );
            ramp_in(
                path,
                &run,
                above,
                z,
                p.ramp,
                f64::INFINITY,
                p.feed,
                p.plunge,
            );
            for i in 1..=ring.len() {
                let q = ring[(start + i) % ring.len()];
                path.feed_to([q[0], q[1], z], p.feed);
            }
        }
    }
    path.retract();
}

/// Clears with the tool's centre going everywhere inside `allowed`.
fn clear_one(path: &mut PathBuilder, allowed: &Region, p: &ClearParams) {
    let allowed = vec![allowed.clone()];

    // Ring k keeps the tool centre `k * stepover` inside the allowed area.
    // Each is offset from that area, so errors do not build up.
    let mut levels: Vec<Vec<Region>> = vec![allowed.clone()];
    loop {
        let level = offset(&allowed, -(levels.len() as f64 * p.stepover));
        if level.is_empty() {
            break;
        }
        levels.push(level);
    }

    // Innermost first, so each ring cuts into the gap the previous one opened
    // and the last ring of a pass is a light cut along the wall.
    let radius = p.tool_diameter / 2.0;
    let mut rings: Vec<Ring> = Vec::new();
    for k in (0..levels.len()).rev() {
        let inner = levels.get(k + 1).map(Vec::as_slice).unwrap_or(&[]);
        for island in missed(&levels[k], inner, radius, p.stepover) {
            rings.extend(island.rings().cloned());
        }
        rings.extend(levels[k].iter().flat_map(|r| r.rings().cloned()));
    }

    let passes = (p.cut() / p.stepdown).ceil().max(1.0) as usize;
    for pass in 1..=passes {
        let z = p.level(pass, passes);
        let floor_above = p.level(pass - 1, passes);

        for (index, ring) in rings.iter().enumerate() {
            let start = nearest_vertex(ring, path.position().map(|p| [p[0], p[1]]));
            let first = ring[start];

            let linked = match path.position() {
                // Stay down and cut across when the way is clear of the walls.
                Some(pos)
                    if pos[2] == z
                        && stays_inside(&allowed, [pos[0], pos[1]], first, p.stepover / 2.0) =>
                {
                    path.feed_to([first[0], first[1], z], p.feed);
                    true
                }
                _ => false,
            };
            if !linked {
                // Everything the tool can reach was cut to `floor_above` by the
                // previous pass. Down from there along the ring about to be cut.
                let mut run = ring_run(
                    ring,
                    start,
                    if p.ramp > 0.0 {
                        (floor_above - z) / p.ramp
                    } else {
                        0.0
                    },
                );
                // A ring too small to ramp along, as the innermost often is:
                // come in from the next ring, over wood that ring cuts anyway.
                let length: f64 = run.windows(2).map(|w| distance(w[0], w[1])).sum();
                if length < MIN_RAMP_RUN {
                    if let Some(next) = rings.get(index + 1) {
                        let from = next[nearest_vertex(next, Some(first))];
                        if stays_inside(&allowed, from, first, p.stepover / 2.0) {
                            run = vec![from, first];
                        }
                    }
                }
                ramp_in(
                    path,
                    &run,
                    floor_above,
                    z,
                    p.ramp,
                    f64::INFINITY,
                    p.feed,
                    p.plunge,
                );
            }
            for i in 1..=ring.len() {
                let q = ring[(start + i) % ring.len()];
                path.feed_to([q[0], q[1], z], p.feed);
            }
        }
    }
    path.retract();
}

/// How far inside the first and last edge of an area the outermost straight
/// passes run, so that they cross the area instead of grazing its edge, mm.
const RASTER_INSET: f64 = 1e-4;

/// Clears with the tool's centre kept inside `centres` in straight passes
/// side to side, along X or Y or the longer side of each area, one area at a time to
/// full depth. With `walls`, each depth ends with a pass round the edge of
/// the area, which straight passes alone leave scalloped where it is not
/// straight. Returns the area the tool's edge reaches.
pub fn raster_centres(
    path: &mut PathBuilder,
    centres: &[Region],
    p: &ClearParams,
    walls: bool,
    along: PassDirection,
) -> Vec<Region> {
    for area in centres {
        raster_one(path, area, p, walls, along);
    }
    offset(centres, p.tool_diameter / 2.0)
}

fn raster_one(
    path: &mut PathBuilder,
    allowed: &Region,
    p: &ClearParams,
    walls: bool,
    along: PassDirection,
) {
    let (mut low, mut high) = ([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]);
    for q in &allowed.outer {
        for k in 0..2 {
            low[k] = low[k].min(q[k]);
            high[k] = high[k].max(q[k]);
        }
    }
    // Passes run along `u` and step across `v`.
    let along_x = match along {
        PassDirection::X => true,
        PassDirection::Y => false,
        PassDirection::Longer => high[0] - low[0] >= high[1] - low[1],
    };
    let (u, v) = if along_x { (0, 1) } else { (1, 0) };
    let span = (high[v] - low[v] - 2.0 * RASTER_INSET).max(0.0);
    let steps = (span / p.stepover).ceil().max(1.0) as usize;
    // Each row: the stretches of it that lie inside the area.
    let mut rows: Vec<Vec<[Point; 2]>> = Vec::new();
    for i in 0..=steps {
        let at = if span == 0.0 {
            (low[v] + high[v]) / 2.0
        } else {
            low[v] + RASTER_INSET + span * i as f64 / steps as f64
        };
        let mut crossings: Vec<f64> = Vec::new();
        for ring in allowed.rings() {
            for k in 0..ring.len() {
                let (a, b) = (ring[k], ring[(k + 1) % ring.len()]);
                if (a[v] > at) != (b[v] > at) {
                    crossings.push(a[u] + (at - a[v]) / (b[v] - a[v]) * (b[u] - a[u]));
                }
            }
        }
        crossings.sort_by(f64::total_cmp);
        let point = |along: f64| -> Point {
            let mut q = [0.0; 2];
            q[u] = along;
            q[v] = at;
            q
        };
        let mut row: Vec<[Point; 2]> = crossings
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| [point(pair[0]), point(pair[1])])
            .collect();
        // Back and forth: every other row runs the other way.
        if rows.len() % 2 == 1 {
            row.reverse();
            for piece in &mut row {
                piece.reverse();
            }
        }
        if !row.is_empty() {
            rows.push(row);
        }
        if span == 0.0 {
            break;
        }
    }

    // Links between passes run along the edge of the area, which counts as inside.
    let inside = offset(std::slice::from_ref(allowed), 0.01);
    let passes = (p.cut() / p.stepdown).ceil().max(1.0) as usize;
    for pass in 1..=passes {
        let z = p.level(pass, passes);
        let floor_above = p.level(pass - 1, passes);
        // Gets the tool to `first` at this depth: across, when it is down and
        // the way is clear, else down along `run`, which ends at `first`.
        let reach = |path: &mut PathBuilder, first: Point, run: &[Point]| {
            let linked = matches!(path.position(), Some(pos) if pos[2] == z
                && distance([pos[0], pos[1]], first) <= 2.0 * p.tool_diameter
                && stays_inside(&inside, [pos[0], pos[1]], first, p.stepover / 2.0));
            if linked {
                path.feed_to([first[0], first[1], z], p.feed);
            } else {
                ramp_in(
                    path,
                    run,
                    floor_above,
                    z,
                    p.ramp,
                    f64::INFINITY,
                    p.feed,
                    p.plunge,
                );
            }
        };
        for [from, to] in rows.iter().flatten() {
            reach(path, *from, &[*to, *from]);
            path.feed_to([to[0], to[1], z], p.feed);
        }
        if walls {
            for ring in allowed.rings() {
                let start = nearest_vertex(ring, path.position().map(|q| [q[0], q[1]]));
                let run = ring_run(
                    ring,
                    start,
                    if p.ramp > 0.0 {
                        (floor_above - z) / p.ramp
                    } else {
                        0.0
                    },
                );
                reach(path, ring[start], &run);
                for i in 1..=ring.len() {
                    let q = ring[(start + i) % ring.len()];
                    path.feed_to([q[0], q[1], z], p.feed);
                }
            }
        }
    }
    path.retract();
}

/// How much closer than its radius the tool's edge is taken to pass, when
/// working out what two neighbouring rings leave standing between them, mm.
const MISSED_OVERLAP: f64 = 0.01;

/// The islands that rings along the edges of `level` and of `inner`, the next
/// level in, leave standing between them, as further rings to cut. With a
/// stepover of more than the tool's radius there are such islands: in the
/// middle of an area where the next ring no longer fits, and at corners.
/// Each island gets a ring round its edge, and rings inside that while it is
/// wider than the tool.
fn missed(level: &[Region], inner: &[Region], radius: f64, stepover: f64) -> Vec<Region> {
    if stepover <= radius {
        return Vec::new();
    }
    let reach = radius - MISSED_OVERLAP;
    let covered = offset(inner, reach);
    let mut islands: Vec<Region> = offset(level, -reach)
        .iter()
        .flat_map(|r| difference(r, &covered))
        .collect();
    let mut out = Vec::new();
    while !islands.is_empty() {
        let next = offset(&islands, -reach);
        // Innermost first, like the rings themselves.
        out.splice(0..0, islands);
        islands = next;
    }
    out
}

pub(crate) fn nearest_vertex(ring: &Ring, from: Option<Point>) -> usize {
    let Some(from) = from else { return 0 };
    let mut best = 0;
    for (i, p) in ring.iter().enumerate() {
        if distance(*p, from) < distance(ring[best], from) {
            best = i;
        }
    }
    best
}

/// True when the straight line from `a` to `b` keeps the tool centre inside
/// the area it is allowed in, checked every `step` mm.
pub(crate) fn stays_inside(allowed: &[Region], a: Point, b: Point, step: f64) -> bool {
    let n = (distance(a, b) / step).ceil().max(1.0) as usize;
    (1..n).all(|i| {
        let t = i as f64 / n as f64;
        let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        allowed.iter().any(|region| region.contains(p))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::fixtures::*;
    use crate::geom::offset::total_area;
    use crate::toolpath::Move;
    use crate::toolpath::PLUNGE_CLEARANCE;
    use std::f64::consts::PI;

    fn params() -> ClearParams {
        ClearParams {
            tool_diameter: 4.0,
            depth: 3.0,
            start: 0.0,
            stepover: 1.6,
            stepdown: 1.0,
            feed: 600.0,
            plunge: 100.0,
            ramp: 0.0,
        }
    }

    fn run(regions: &[Region], p: &ClearParams) -> (Vec<Move>, Vec<Region>) {
        let mut path = PathBuilder::new(5.0);
        path.start_tool(7, 12000);
        let pocket = clear(&mut path, regions, p).unwrap();
        (path.finish(), pocket)
    }

    fn feeds(moves: &[Move]) -> Vec<[f64; 3]> {
        moves
            .iter()
            .filter_map(|m| {
                if let Move::Feed { to, .. } = m {
                    Some(*to)
                } else {
                    None
                }
            })
            .collect()
    }

    #[test]
    fn the_tool_ramps_down_along_its_path_instead_of_plunging() {
        let region = Region::with_holes(
            rect(0.0, 0.0, 40.0, 30.0),
            vec![rect_cw(15.0, 10.0, 25.0, 20.0)],
        );
        // About 5 degrees.
        let p = ClearParams {
            ramp: 0.0875,
            ..params()
        };
        for raster in [false, true] {
            let centres = centres(std::slice::from_ref(&region), &[], p.tool_diameter);
            let mut path = PathBuilder::new(5.0);
            path.start_tool(7, 12000);
            if raster {
                raster_centres(&mut path, &centres, &p, true, PassDirection::Longer);
            } else {
                clear_centres(&mut path, &centres, &p);
            }
            let moves = path.finish();
            let mut at: Option<[f64; 3]> = None;
            let (mut steepest, mut lowest) = (0.0_f64, 0.0_f64);
            for m in &moves {
                let to = match m {
                    Move::Feed { to, .. } | Move::Rapid { to } => *to,
                    _ => continue,
                };
                if let (Some(a), Move::Feed { .. }) = (at, m) {
                    let across = distance([a[0], a[1]], [to[0], to[1]]);
                    let down = a[2] - to[2];
                    // Straight down only through what the pass before cut: from
                    // where the rapid stopped, no further than the clearance.
                    if down > 1e-9 && across < 1e-9 {
                        assert!(
                            down <= PLUNGE_CLEARANCE + 1e-9,
                            "raster {raster}: a straight plunge of {down} mm to {to:?}"
                        );
                    } else if down > 1e-9 {
                        steepest = steepest.max(down / across);
                    }
                    // Still where it is allowed to be.
                    let xy = [to[0], to[1]];
                    assert!(region.contains(xy) && region.distance_to_boundary(xy) > 2.0 - 0.02);
                    lowest = lowest.min(to[2]);
                }
                at = Some(to);
            }
            assert!(
                steepest <= 0.0875 + 1e-6,
                "raster {raster}: slope {steepest}"
            );
            assert!((lowest + 3.0).abs() < 1e-9);
        }
    }

    #[test]
    fn a_ramp_too_long_for_its_run_goes_back_and_forth() {
        let mut path = PathBuilder::new(5.0);
        path.start_tool(1, 12000);
        // 2 mm down at 1 in 10 needs 20 mm; the run is 6 mm long.
        ramp_in(
            &mut path,
            &[[0.0, 0.0], [6.0, 0.0]],
            0.0,
            -2.0,
            0.1,
            f64::INFINITY,
            600.0,
            100.0,
        );
        let cuts = feeds(&path.finish());
        assert_eq!(cuts.last(), Some(&[6.0, 0.0, -2.0]));
        // Four legs of 6 mm, half a millimetre down on each.
        let turns: Vec<f64> = cuts.iter().map(|q| q[2]).collect();
        assert_eq!(turns, [0.0, -0.5, -1.0, -1.5, -2.0]);
        assert!(cuts
            .iter()
            .all(|q| q[0] >= 0.0 && q[0] <= 6.0 && q[1] == 0.0));

        // A tool already in the cut at the entry stays in it.
        let mut path = PathBuilder::new(5.0);
        path.start_tool(1, 12000);
        path.rapid_to([6.0, 0.0], 1.0);
        path.feed_to([6.0, 0.0, 0.0], 100.0);
        ramp_in(
            &mut path,
            &[[0.0, 0.0], [6.0, 0.0]],
            0.0,
            -0.4,
            0.1,
            f64::INFINITY,
            600.0,
            100.0,
        );
        let moves = path.finish();
        let rapids = moves
            .iter()
            .filter(|m| matches!(m, Move::Rapid { .. }))
            .count();
        // Down to the start, and up at the end: none in between.
        assert_eq!(rapids, 3);
        assert_eq!(feeds(&moves).last(), Some(&[6.0, 0.0, -0.4]));
    }

    #[test]
    fn side_to_side_passes_cover_the_area_and_stay_in_it() {
        let region = Region::with_holes(
            rect(0.0, 0.0, 40.0, 30.0),
            vec![rect_cw(15.0, 10.0, 25.0, 20.0)],
        );
        let p = ClearParams {
            depth: 1.0,
            ..params()
        };
        let centres = centres(std::slice::from_ref(&region), &[], p.tool_diameter);
        let mut path = PathBuilder::new(5.0);
        path.start_tool(7, 12000);
        let pocket = raster_centres(&mut path, &centres, &p, true, PassDirection::Longer);
        let moves = path.finish();
        let cuts = feeds(&moves);
        for q in &cuts {
            let xy = [q[0], q[1]];
            assert!(
                region.contains(xy) && region.distance_to_boundary(xy) > 2.0 - 0.02,
                "tool cut into the wall at {xy:?}"
            );
        }
        // Most of the cutting is straight across, along the longer side.
        let (mut across, mut all) = (0.0, 0.0);
        for pair in cuts.windows(2) {
            let d = distance([pair[0][0], pair[0][1]], [pair[1][0], pair[1][1]]);
            all += d;
            if (pair[0][1] - pair[1][1]).abs() < 1e-9 {
                across += d;
            }
        }
        assert!(across > 0.6 * all, "{across} of {all} mm across");
        // Nothing the tool can reach is left standing.
        let (mut x, mut worst) = (0.05, 0.0_f64);
        while x < 40.0 {
            let mut y = 0.05;
            while y < 30.0 {
                if pocket.iter().any(|r| r.contains([x, y])) {
                    worst = worst.max(distance_to_cuts(&moves, 1.0, [x, y]));
                }
                y += 0.25;
            }
            x += 0.25;
        }
        assert!(worst < 2.0 + 0.02, "{worst} mm from the nearest cut");
    }

    #[test]
    fn tool_centre_never_comes_closer_to_the_wall_than_its_radius() {
        let region = Region::with_holes(
            rect(0.0, 0.0, 40.0, 30.0),
            vec![rect_cw(15.0, 10.0, 25.0, 20.0)],
        );
        let (moves, _) = run(std::slice::from_ref(&region), &params());
        let cuts = feeds(&moves);
        assert!(!cuts.is_empty());
        for p in cuts {
            let xy = [p[0], p[1]];
            assert!(region.contains(xy), "tool centre left the region at {xy:?}");
            assert!(
                region.distance_to_boundary(xy) > 2.0 - 0.01,
                "tool cut into the wall at {xy:?}"
            );
        }
    }

    /// Distance from `q` to the nearest cut at full depth.
    fn distance_to_cuts(moves: &[Move], depth: f64, q: Point) -> f64 {
        let mut best = f64::INFINITY;
        let mut from: Option<[f64; 3]> = None;
        for m in moves {
            let to = match m {
                Move::Feed { to, .. } | Move::Rapid { to } => *to,
                _ => continue,
            };
            if let (Some(a), Move::Feed { .. }) = (from, m) {
                if (a[2] + depth).abs() < 1e-9 && (to[2] + depth).abs() < 1e-9 {
                    let (dx, dy) = (to[0] - a[0], to[1] - a[1]);
                    let len2 = dx * dx + dy * dy;
                    let t = if len2 > 0.0 {
                        (((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len2).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    best = best.min(distance(q, [a[0] + t * dx, a[1] + t * dy]));
                }
            }
            from = Some(to);
        }
        best
    }

    #[test]
    fn a_stepover_above_the_radius_leaves_nothing_standing() {
        // A square whose middle the next ring in no longer fits, a ring-shaped
        // area, and a shape with sharp corners.
        let shapes = [
            Region::new(rect(0.0, 0.0, 8.4, 8.4)),
            Region::with_holes(
                rect(0.0, 0.0, 30.0, 22.0),
                vec![rect_cw(9.0, 8.0, 21.0, 14.0)],
            ),
            Region::new(star(0.0, 0.0, 30.0, 14.0)),
        ];
        for stepover in [2.1, 2.4, 3.0, 3.9] {
            let p = ClearParams {
                stepover,
                depth: 1.0,
                ..params()
            };
            for shape in &shapes {
                let (moves, pocket) = run(std::slice::from_ref(shape), &p);
                let (mut x, mut worst) = (-32.0, 0.0_f64);
                while x < 32.0 {
                    let mut y = -32.0;
                    while y < 32.0 {
                        if pocket.iter().any(|r| r.contains([x, y])) {
                            worst = worst.max(distance_to_cuts(&moves, 1.0, [x, y]));
                        }
                        y += 0.1;
                    }
                    x += 0.1;
                }
                assert!(
                    worst < 2.0 + 0.02,
                    "stepover {stepover}: wood left {worst} mm from the nearest cut"
                );
            }
        }
    }

    #[test]
    fn depth_is_reached_in_even_passes_no_deeper_than_the_stepdown() {
        let (moves, _) = run(
            &[Region::new(rect(0.0, 0.0, 20.0, 20.0))],
            &ClearParams {
                depth: 2.5,
                ..params()
            },
        );
        let mut depths: Vec<f64> = feeds(&moves).iter().map(|p| p[2]).collect();
        depths.sort_by(|a, b| b.partial_cmp(a).unwrap());
        depths.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        // 2.5 mm at up to 1 mm per pass is three passes of 0.833 mm.
        let expected = [-2.5 / 3.0, -5.0 / 3.0, -2.5];
        assert_eq!(depths.len(), 3);
        for (d, e) in depths.iter().zip(expected) {
            assert!((d - e).abs() < 1e-9);
        }
    }

    #[test]
    fn rapids_never_go_below_the_floor_cut_by_the_previous_pass() {
        let (moves, _) = run(&[Region::new(star(0.0, 0.0, 30.0, 14.0))], &params());
        let mut lowest_cut: f64 = 0.0;
        for m in &moves {
            match m {
                Move::Feed { to, .. } => lowest_cut = lowest_cut.min(to[2]),
                // A rapid may only descend into space already cleared, and stops short of it.
                Move::Rapid { to } => assert!(
                    to[2] >= lowest_cut + PLUNGE_CLEARANCE - 1e-9,
                    "rapid to {to:?}"
                ),
                _ => {}
            }
        }
        assert!((lowest_cut + 3.0).abs() < 1e-9);
    }

    #[test]
    fn ends_at_safe_height_with_the_spindle_off() {
        let (moves, _) = run(&[Region::new(rect(0.0, 0.0, 20.0, 20.0))], &params());
        assert_eq!(moves.last(), Some(&Move::SpindleOff));
        let last_position = moves.iter().rev().find_map(|m| {
            if let Move::Rapid { to } = m {
                Some(*to)
            } else {
                None
            }
        });
        assert_eq!(last_position.unwrap()[2], 5.0);
    }

    #[test]
    fn resulting_pocket_has_corners_rounded_to_the_tool_radius() {
        let (_, pocket) = run(&[Region::new(rect(0.0, 0.0, 20.0, 20.0))], &params());
        // A 20 mm square opened by a 2 mm radius.
        assert!((total_area(&pocket) - (400.0 - (4.0 - PI) * 4.0)).abs() < 0.05);
    }

    #[test]
    fn a_tool_wider_than_the_shape_is_an_error() {
        let mut path = PathBuilder::new(5.0);
        assert_eq!(
            clear(
                &mut path,
                &[Region::new(rect(0.0, 0.0, 3.0, 3.0))],
                &params()
            ),
            Err(ClearError::ToolTooWide)
        );
    }

    /// An L-shaped pocket: a 6 mm tool leaves the inside corners and cannot
    /// enter the 4 mm wide arm at all.
    fn pocket_with_a_narrow_arm() -> Region {
        Region::new(vec![
            [0.0, 0.0],
            [30.0, 0.0],
            [30.0, 20.0],
            [20.0, 20.0],
            [20.0, 40.0],
            [16.0, 40.0],
            [16.0, 20.0],
            [0.0, 20.0],
        ])
    }

    #[test]
    fn a_smaller_tool_goes_only_where_wood_is_left() {
        let pocket = pocket_with_a_narrow_arm();
        let regions = std::slice::from_ref(&pocket);
        let big = ClearParams {
            tool_diameter: 6.0,
            stepover: 2.4,
            ..params()
        };
        let small = ClearParams {
            tool_diameter: 2.0,
            stepover: 0.8,
            ..params()
        };
        let mut path = PathBuilder::new(5.0);
        path.start_tool(1, 12000);
        let already = clear(&mut path, regions, &big).unwrap();
        let big_moves = path.finish().len();

        let where_to = centres(regions, &already, small.tool_diameter);
        assert!(!where_to.is_empty());
        let mut path = PathBuilder::new(5.0);
        path.start_tool(2, 12000);
        let swept = clear_centres(&mut path, &where_to, &small);
        let moves = path.finish();
        let cuts = feeds(&moves);
        assert!(!cuts.is_empty());

        // Never into a wall, and never far from wood the big tool left.
        let left: Vec<Region> = difference(&pocket, &already);
        for q in &cuts {
            let xy = [q[0], q[1]];
            assert!(pocket.contains(xy) && pocket.distance_to_boundary(xy) > 1.0 - 0.01);
            let to_wood = left
                .iter()
                .map(|r| {
                    if r.contains(xy) {
                        0.0
                    } else {
                        r.distance_to_boundary(xy)
                    }
                })
                .fold(f64::INFINITY, f64::min);
            assert!(
                to_wood < 1.0 + REST_MARGIN + 0.05,
                "{xy:?} is {to_wood} from any wood"
            );
        }
        // The arm is cleared along its whole length.
        assert!(cuts.iter().any(|q| q[1] > 38.5));

        // Together the two reach all that the small tool reaches alone.
        let mut alone = PathBuilder::new(5.0);
        alone.start_tool(2, 12000);
        let wanted = clear(&mut alone, regions, &small).unwrap();
        let both: Vec<Region> = already.iter().chain(swept.iter()).cloned().collect();
        let missed: f64 = wanted
            .iter()
            .flat_map(|r| difference(r, &both))
            .map(|r| r.area())
            .sum();
        assert!(missed < 0.05, "{missed} mm² not reached");
        // And the small tool has far less to do than on its own.
        assert!(moves.len() * 2 < alone.finish().len());
        assert!(big_moves > 0);
    }

    #[test]
    fn a_tool_with_nothing_left_to_cut_gets_nowhere_to_go() {
        let pocket = pocket_with_a_narrow_arm();
        let regions = std::slice::from_ref(&pocket);
        let small = ClearParams {
            tool_diameter: 2.0,
            stepover: 0.8,
            ..params()
        };
        let mut path = PathBuilder::new(5.0);
        path.start_tool(1, 12000);
        let already = clear(&mut path, regions, &small).unwrap();
        // A larger tool after a smaller one, and the same tool twice.
        assert!(centres(regions, &already, 6.0).is_empty());
        assert!(centres(regions, &already, 2.0).is_empty());
    }

    #[test]
    fn parts_the_tool_cannot_enter_are_left_alone() {
        // Two squares joined by a neck narrower than the tool.
        let dumbbell = Region::new(vec![
            [0.0, 0.0],
            [10.0, 0.0],
            [10.0, 4.0],
            [14.0, 4.0],
            [14.0, 0.0],
            [24.0, 0.0],
            [24.0, 10.0],
            [14.0, 10.0],
            [14.0, 6.0],
            [10.0, 6.0],
            [10.0, 10.0],
            [0.0, 10.0],
        ]);
        let (moves, pocket) = run(&[dumbbell], &params());
        assert_eq!(pocket.len(), 2);
        for p in feeds(&moves) {
            assert!(
                !(10.5..13.5).contains(&p[0]),
                "tool cut through the neck at {p:?}"
            );
        }
    }
}
