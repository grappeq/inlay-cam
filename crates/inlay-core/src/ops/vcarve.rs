//! V-carving a pocket: sloped walls that meet the surface exactly on the
//! shape's outline, sharp inside corners, and a flat floor at a set depth.
//!
//! A V-bit cuts wider the deeper it goes, so the depth at each place follows
//! from how far the walls are: at a point of the medial axis whose inscribed
//! circle has radius r, the bit sits at depth (r - tip radius) / tan(half
//! angle) and touches both walls at the surface. Where the shape is wide
//! enough to reach the full depth, the bit instead runs along the walls at
//! that depth, a fixed distance inside the outline, and the floor between is
//! flat.
//!
//! The work is done in three kinds of cut:
//! - wall rings: the outline moved inwards by the bit's radius at each pass depth;
//! - ramps: the medial axis where the shape is narrower than the bit at full
//!   depth, which is every inside corner and every narrow part;
//! - floor rings: at full depth, over whatever floor the end mill left.

use std::collections::HashMap;

use crate::geom::boolean::difference;
use crate::geom::medial::medial_axis;
use crate::geom::offset::offset;
use crate::geom::simplify::simplify;
use crate::geom::{distance, Point, Region};
use crate::ops::clear::{nearest_vertex, stays_inside};
use crate::toolpath::PathBuilder;

#[derive(Debug, Clone, PartialEq)]
pub struct VcarveParams {
    /// Half the bit's included angle, radians.
    pub half_angle: f64,
    /// Radius of the flat at the bit's tip, mm. 0 for a perfect point.
    pub tip_radius: f64,
    /// Depth of the flat floor below Z0. Positive.
    pub depth: f64,
    /// Largest depth per pass, mm.
    pub stepdown: f64,
    /// Sideways distance between floor rings, mm.
    pub stepover: f64,
    /// Feed while cutting, mm/min.
    pub feed: f64,
    /// Feed while cutting straight down, mm/min.
    pub plunge: f64,
}

impl VcarveParams {
    fn tan(&self) -> f64 {
        self.half_angle.tan()
    }

    /// Radius of the bit at the surface when its tip is `depth` deep: how far
    /// inside the outline its centre must stay.
    pub fn radius_at(&self, depth: f64) -> f64 {
        self.tip_radius + depth * self.tan()
    }

    /// The flat floor of the finished pocket: everything further from the
    /// outline than the walls' run.
    pub fn floor(&self, regions: &[Region]) -> Vec<Region> {
        offset(regions, -self.depth * self.tan())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum VcarveError {
    /// The medial axis of a shape could not be computed.
    Geometry(String),
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct VcarveReport {
    /// For each region too narrow to reach the full depth anywhere: the
    /// deepest the bit gets in it, mm.
    pub shallow: Vec<f64>,
    /// Area of floor the V-bit had to clear itself, mm².
    pub floor_cleared_by_bit: f64,
}

/// Height above the surface at which a rapid descent stops and the plunge
/// feed takes over.
const PLUNGE_CLEARANCE: f64 = 1.0;

/// Largest sideways error accepted from leaving out a ramp, mm. Outlines made
/// of many short segments have a medial branch at every vertex; those at
/// nearly straight joints change nothing the wall rings do not already cut.
const RAMP_TOLERANCE: f64 = 0.005;

/// Floor left over in strips thinner than twice this is ignored, mm.
const SLIVER: f64 = 0.01;

/// How far a floor ring may stray when its points are thinned, mm.
const RING_TOLERANCE: f64 = 0.002;

/// Ramps shallower than this everywhere are not worth a move, mm.
const MIN_RAMP_DEPTH: f64 = 0.005;

/// One straight cut with its depth (positive, below Z0) at each end.
#[derive(Debug, Clone, Copy)]
struct Ramp {
    a: Point,
    da: f64,
    b: Point,
    db: f64,
}

/// Appends the V-bit moves for `regions` to `path`. The bit must already be
/// loaded and spinning. `cleared` is the part of the floor already cut to full
/// depth by another tool.
pub fn vcarve(
    path: &mut PathBuilder,
    regions: &[Region],
    cleared: &[Region],
    p: &VcarveParams,
) -> Result<VcarveReport, VcarveError> {
    let mut report = VcarveReport::default();
    let passes = (p.depth / p.stepdown).ceil().max(1.0) as usize;
    let full_radius = p.radius_at(p.depth);

    for region in regions {
        let one = std::slice::from_ref(region);
        let ramps = ramps(region, p)?;
        let deepest = ramps.iter().map(|r| r.da.max(r.db)).fold(0.0, f64::max);
        let allowed = offset(one, -full_radius);
        if allowed.is_empty() {
            report.shallow.push(deepest);
        }

        for pass in 1..=passes {
            let z = p.depth * pass as f64 / passes as f64;
            let above = p.depth * (pass - 1) as f64 / passes as f64;

            for level in offset(one, -p.radius_at(z)) {
                for ring in level.rings() {
                    let start = nearest_vertex(ring, path.position().map(|q| [q[0], q[1]]));
                    plunge_to(path, ring[start], z, p);
                    for i in 1..=ring.len() {
                        let q = ring[(start + i) % ring.len()];
                        path.feed_to([q[0], q[1], -z], p.feed);
                    }
                }
            }

            let cuts: Vec<Ramp> = ramps.iter().flat_map(|r| pass_cuts(r, above, z)).collect();
            for chain in chains(cuts, path.position().map(|q| [q[0], q[1]])) {
                plunge_to(path, chain[0].0, chain[0].1, p);
                for (q, depth) in &chain[1..] {
                    path.feed_to([q[0], q[1], height(*depth)], p.feed);
                }
            }
        }

        // Floor the end mill could not reach: the corners of the floor it
        // rounded off, and floor too narrow for it.
        let margin = (2.0 * p.tip_radius).max(0.02);
        let inner = offset(one, -(p.depth * p.tan() + margin));
        let rest: Vec<Region> = inner.iter().flat_map(|r| difference(r, cleared)).collect();
        for piece in &rest {
            // Starting a hair inside drops the hair-thin leftovers where the
            // two boundaries run side by side.
            let mut level = offset(std::slice::from_ref(piece), -SLIVER);
            report.floor_cleared_by_bit += level.iter().map(Region::area).sum::<f64>();
            // Each ring is offset from the one before: offsetting the first by
            // ever larger amounts gets slow, and exact spacing does not matter here.
            let mut area = f64::INFINITY;
            loop {
                // A shrinking shape must lose area; one that does not has
                // collapsed into something the offset can no longer shrink.
                let now: f64 = level.iter().map(Region::area).sum();
                if level.is_empty() || now >= area || now < SLIVER * SLIVER {
                    break;
                }
                area = now;
                floor_rings(path, &level, &allowed, p);

                // Thinning the points matters: otherwise every ring's rounded
                // corners are rounded again by the next and the count explodes.
                let inwards = |from: &[Region], by: f64| -> Vec<Region> {
                    offset(from, -by)
                        .iter()
                        .map(|r| simplify(r, RING_TOLERANCE))
                        .collect()
                };
                let half = inwards(&level, p.stepover / 2.0);
                let next = inwards(&half, p.stepover / 2.0);
                // Where the area is between one and two stepovers wide the
                // next ring does not exist, and the middle would be left
                // standing. Those stretches get a ring half a step in.
                let continuing = offset(&next, p.stepover / 2.0);
                let thin: Vec<Region> = half
                    .iter()
                    .flat_map(|r| difference(r, &continuing))
                    .collect();
                floor_rings(path, &offset(&thin, -SLIVER), &allowed, p);
                level = next;
            }
        }
        path.retract();
    }
    Ok(report)
}

/// Cuts along every ring of `level` at full depth, staying down between
/// rings that are close together when the way is clear of the walls.
fn floor_rings(path: &mut PathBuilder, level: &[Region], allowed: &[Region], p: &VcarveParams) {
    for ring in level.iter().flat_map(|r| r.rings()) {
        let start = nearest_vertex(ring, path.position().map(|q| [q[0], q[1]]));
        let first = ring[start];
        let linked = path.position().is_some_and(|pos| {
            pos[2] == -p.depth
                && distance([pos[0], pos[1]], first) <= 4.0 * p.stepover
                && stays_inside(allowed, [pos[0], pos[1]], first, p.stepover / 2.0)
        });
        if linked {
            path.feed_to([first[0], first[1], -p.depth], p.feed);
        } else {
            plunge_to(path, first, p.depth, p);
        }
        for i in 1..=ring.len() {
            let q = ring[(start + i) % ring.len()];
            path.feed_to([q[0], q[1], -p.depth], p.feed);
        }
    }
}

fn height(depth: f64) -> f64 {
    // Avoids a negative zero, which would be written as "-0.000".
    if depth.abs() < 1e-9 {
        0.0
    } else {
        -depth
    }
}

/// Travels to above `xy` and cuts straight down to `depth`, unless the tool
/// is already there.
fn plunge_to(path: &mut PathBuilder, xy: Point, depth: f64, p: &VcarveParams) {
    let target = [xy[0], xy[1], height(depth)];
    if path.position().is_some_and(|pos| {
        distance([pos[0], pos[1]], xy) < 1e-6 && (pos[2] - target[2]).abs() < 1e-6
    }) {
        return;
    }
    path.rapid_to(xy, PLUNGE_CLEARANCE);
    path.feed_to(target, p.plunge);
}

/// The parts of a region's medial axis the bit follows, with the final depth
/// at each end: everywhere the shape is narrower than the bit at full depth.
fn ramps(region: &Region, p: &VcarveParams) -> Result<Vec<Ramp>, VcarveError> {
    let edges = medial_axis(region).map_err(|e| VcarveError::Geometry(e.to_string()))?;
    let (low, high) = (p.tip_radius, p.radius_at(p.depth));
    // Along the bisector of two walls meeting at a joint that turns by d, the
    // radius grows by cos(d / 2) per mm, and leaving the bisector out leaves
    // (1 / cos(d / 2) - 1) x radius of material in the corner.
    let steepest = 1.0 / (1.0 + RAMP_TOLERANCE / high);

    let mut out = Vec::new();
    for e in edges {
        let length = distance(e.a, e.b);
        if length < 1e-9 || (e.rb - e.ra).abs() / length > steepest {
            continue;
        }
        // Keep the stretch where the radius is between the tip flat and the
        // bit's radius at full depth.
        let Some((t0, t1)) = clip(e.ra, e.rb, low, high) else {
            continue;
        };
        let at = |t: f64| -> (Point, f64) {
            let r = e.ra + (e.rb - e.ra) * t;
            (
                [
                    e.a[0] + (e.b[0] - e.a[0]) * t,
                    e.a[1] + (e.b[1] - e.a[1]) * t,
                ],
                ((r - p.tip_radius) / p.tan()).clamp(0.0, p.depth),
            )
        };
        let ((a, da), (b, db)) = (at(t0), at(t1));
        if da.max(db) >= MIN_RAMP_DEPTH && distance(a, b) > 1e-6 {
            out.push(Ramp { a, da, b, db });
        }
    }
    Ok(out)
}

/// The stretch of 0..=1 over which a value going linearly from `v0` to `v1`
/// lies within `low..=high`.
fn clip(v0: f64, v1: f64, low: f64, high: f64) -> Option<(f64, f64)> {
    if (v0 < low && v1 < low) || (v0 > high && v1 > high) {
        return None;
    }
    if (v1 - v0).abs() < 1e-12 {
        return Some((0.0, 1.0));
    }
    let cross = |v: f64| ((v - v0) / (v1 - v0)).clamp(0.0, 1.0);
    let (a, b) = (cross(low), cross(high));
    let (t0, t1) = (a.min(b), a.max(b));
    (t1 > t0).then_some((t0, t1))
}

/// What one depth pass cuts of a ramp: the part not already finished by the
/// passes above, no deeper than this pass goes.
fn pass_cuts(ramp: &Ramp, above: f64, z: f64) -> Vec<Ramp> {
    let Some((t0, t1)) = clip(ramp.da, ramp.db, above, f64::INFINITY) else {
        return Vec::new();
    };
    if ramp.da.max(ramp.db) <= above + 1e-9 {
        return Vec::new();
    }
    let at = |t: f64| -> (Point, f64) {
        (
            [
                ramp.a[0] + (ramp.b[0] - ramp.a[0]) * t,
                ramp.a[1] + (ramp.b[1] - ramp.a[1]) * t,
            ],
            ramp.da + (ramp.db - ramp.da) * t,
        )
    };
    // Split where the ramp passes this pass's depth, so the part below it is
    // cut level at that depth.
    let mut stops = vec![t0];
    let (d0, d1) = (at(t0).1, at(t1).1);
    if (d0 - z) * (d1 - z) < 0.0 {
        stops.push(t0 + (t1 - t0) * (z - d0) / (d1 - d0));
    }
    stops.push(t1);
    stops
        .windows(2)
        .filter_map(|w| {
            let ((a, da), (b, db)) = (at(w[0]), at(w[1]));
            (distance(a, b) > 1e-6).then_some(Ramp {
                a,
                da: da.min(z),
                b,
                db: db.min(z),
            })
        })
        .collect()
}

/// Joins cuts that share end points into continuous runs, starting each run
/// at the free end nearest to where the previous one stopped.
fn chains(cuts: Vec<Ramp>, mut from: Option<Point>) -> Vec<Vec<(Point, f64)>> {
    type Key = (i64, i64);
    let key = |p: Point| -> Key { ((p[0] * 1e4).round() as i64, (p[1] * 1e4).round() as i64) };

    // For each end point, the cuts that end there: (cut, which end).
    let mut at: HashMap<Key, Vec<(usize, bool)>> = HashMap::new();
    for (i, c) in cuts.iter().enumerate() {
        at.entry(key(c.a)).or_default().push((i, false));
        at.entry(key(c.b)).or_default().push((i, true));
    }
    let mut used = vec![false; cuts.len()];
    let mut left = cuts.len();
    let mut out = Vec::new();

    while left > 0 {
        // Prefer a free end, so runs are not started in their middle.
        let mut best: Option<(bool, f64, usize, bool)> = None;
        for (i, c) in cuts.iter().enumerate() {
            if used[i] {
                continue;
            }
            for (end, p) in [(false, c.a), (true, c.b)] {
                let open_ends = at[&key(p)].iter().filter(|(j, _)| !used[*j]).count();
                let candidate = (open_ends != 1, from.map_or(0.0, |f| distance(f, p)), i, end);
                if best.is_none_or(|b| (candidate.0, candidate.1) < (b.0, b.1)) {
                    best = Some(candidate);
                }
            }
        }
        let (_, _, mut cut, mut from_b) = best.expect("there are cuts left");

        let mut chain: Vec<(Point, f64)> = Vec::new();
        loop {
            let c = cuts[cut];
            let (start, end) = if from_b {
                ((c.b, c.db), (c.a, c.da))
            } else {
                ((c.a, c.da), (c.b, c.db))
            };
            if chain.is_empty() {
                chain.push(start);
            }
            chain.push(end);
            used[cut] = true;
            left -= 1;
            let Some(&(next, at_b)) = at[&key(end.0)].iter().find(|(j, _)| !used[*j]) else {
                break;
            };
            cut = next;
            from_b = at_b;
        }
        from = chain.last().map(|(p, _)| *p);
        out.push(chain);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::fixtures::*;
    use crate::toolpath::Move;

    fn params() -> VcarveParams {
        VcarveParams {
            half_angle: 30f64.to_radians(),
            tip_radius: 0.05,
            depth: 3.0,
            stepdown: 1.0,
            stepover: 0.2,
            feed: 500.0,
            plunge: 150.0,
        }
    }

    fn run(regions: &[Region], cleared: &[Region], p: &VcarveParams) -> (Vec<Move>, VcarveReport) {
        let mut path = PathBuilder::new(5.0);
        path.start_tool(1, 12000);
        let report = vcarve(&mut path, regions, cleared, p).unwrap();
        (path.finish(), report)
    }

    fn feeds(moves: &[Move]) -> Vec<[f64; 3]> {
        moves
            .iter()
            .filter_map(|m| match m {
                Move::Feed { to, .. } => Some(*to),
                _ => None,
            })
            .collect()
    }

    /// The rule everything else rests on: at every cut point the bit is no
    /// wider at the surface than the distance to the nearest wall.
    fn assert_never_wider_than_the_shape(region: &Region, moves: &[Move], p: &VcarveParams) {
        let cuts = feeds(moves);
        assert!(!cuts.is_empty());
        for q in cuts {
            let xy = [q[0], q[1]];
            assert!(region.contains(xy), "bit left the shape at {xy:?}");
            let room = region.distance_to_boundary(xy);
            let width = if q[2] < 0.0 { p.radius_at(-q[2]) } else { 0.0 };
            assert!(
                width <= room + 0.01,
                "bit is {width} wide at {q:?} but the wall is {room} away"
            );
            assert!(q[2] >= -p.depth - 1e-9, "cut below the floor at {q:?}");
        }
    }

    #[test]
    fn the_bit_is_never_wider_than_the_shape_allows() {
        let p = params();
        for region in [
            Region::new(rect(0.0, 0.0, 30.0, 20.0)),
            Region::new(l_shape()),
            Region::new(star(0.0, 0.0, 20.0, 8.0)),
            Region::new(circle(0.0, 0.0, 10.0, 180)),
            Region::with_holes(
                rect(0.0, 0.0, 30.0, 30.0),
                vec![rect_cw(10.0, 10.0, 20.0, 20.0)],
            ),
        ] {
            let (moves, _) = run(std::slice::from_ref(&region), &[], &p);
            assert_never_wider_than_the_shape(&region, &moves, &p);
        }
    }

    #[test]
    fn corners_are_carved_up_to_the_surface() {
        let p = params();
        let region = Region::new(rect(0.0, 0.0, 30.0, 20.0));
        let (moves, report) = run(std::slice::from_ref(&region), &[], &p);
        assert!(report.shallow.is_empty());
        // Each corner has a ramp ending within the tip flat's reach of it.
        for corner in [[0.0, 0.0], [30.0, 0.0], [30.0, 20.0], [0.0, 20.0]] {
            let nearest = feeds(&moves)
                .iter()
                .map(|q| distance([q[0], q[1]], corner))
                .fold(f64::INFINITY, f64::min);
            assert!(nearest < 0.1, "no ramp reaches the corner at {corner:?}");
        }
        // And the walls are run at full depth, the bit's radius inside.
        let inset = p.radius_at(3.0);
        assert!(feeds(&moves).iter().any(|q| (q[2] + 3.0).abs() < 1e-9
            && (q[0] - inset).abs() < 1e-6
            && (q[1] - inset).abs() < 1e-6));
    }

    #[test]
    fn a_narrow_shape_is_carved_as_deep_as_it_allows_and_reported() {
        let p = params();
        // 2 mm wide: the bit bottoms out at (1 - 0.05) / tan 30 = 1.645 mm.
        let region = Region::new(rect(0.0, 0.0, 30.0, 2.0));
        let (moves, report) = run(std::slice::from_ref(&region), &[], &p);
        assert_never_wider_than_the_shape(&region, &moves, &p);
        let expected = 0.95 / 30f64.to_radians().tan();
        assert_eq!(report.shallow.len(), 1);
        assert!((report.shallow[0] - expected).abs() < 1e-3);
        let deepest = feeds(&moves).iter().map(|q| q[2]).fold(0.0, f64::min);
        assert!((deepest + expected).abs() < 1e-3, "deepest cut {deepest}");
    }

    #[test]
    fn no_pass_cuts_more_than_the_stepdown_below_the_one_before() {
        let p = params();
        let region = Region::new(rect(0.0, 0.0, 30.0, 2.0));
        let (moves, _) = run(std::slice::from_ref(&region), &[], &p);
        // Along the spine the groove goes down in steps of 1 mm, then the rest.
        let mut depths: Vec<f64> = feeds(&moves)
            .iter()
            .filter(|q| (q[1] - 1.0).abs() < 1e-6 && q[0] > 0.5 && q[0] < 29.5)
            .map(|q| -q[2])
            .collect();
        depths.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
        assert_eq!(depths.len(), 2, "{depths:?}");
        assert!((depths[0] - 1.0).abs() < 1e-6 && depths[1] > 1.6);
    }

    #[test]
    fn a_circle_made_of_short_segments_needs_no_ramps() {
        let p = params();
        let region = Region::new(circle(0.0, 0.0, 10.0, 360));
        let (moves, _) = run(std::slice::from_ref(&region), &[], &p);
        // Wall rings and floor rings only: nothing between the wall ring and
        // the outline.
        let inset = p.radius_at(3.0);
        for q in feeds(&moves) {
            if (q[2] + 3.0).abs() < 1e-9 {
                assert!(distance([q[0], q[1]], [0.0, 0.0]) <= 10.0 - inset + 0.01);
            }
        }
        let sloped = moves.windows(2).any(|w| match (&w[0], &w[1]) {
            (Move::Feed { to: a, .. }, Move::Feed { to: b, .. }) => {
                a[2] != b[2] && distance([a[0], a[1]], [b[0], b[1]]) > 1e-6
            }
            _ => false,
        });
        assert!(!sloped, "a smooth circle has no corners to ramp into");
    }

    #[test]
    fn floor_already_cleared_is_left_to_the_other_tool() {
        let p = params();
        let region = Region::new(rect(0.0, 0.0, 30.0, 20.0));
        let floor = p.floor(std::slice::from_ref(&region));
        let cleared = crate::geom::offset::open(&floor, 1.5875);
        let (_, some) = run(std::slice::from_ref(&region), &cleared, &p);
        let (_, all) = run(std::slice::from_ref(&region), &[], &p);
        assert!(some.floor_cleared_by_bit < 0.05 * all.floor_cleared_by_bit);
        assert!(
            some.floor_cleared_by_bit > 0.0,
            "the floor's corners remain"
        );
    }

    #[test]
    fn rapids_stay_above_the_surface() {
        let (moves, _) = run(&[Region::new(star(0.0, 0.0, 20.0, 8.0))], &[], &params());
        for m in &moves {
            if let Move::Rapid { to } = m {
                assert!(to[2] >= PLUNGE_CLEARANCE - 1e-9, "rapid to {to:?}");
            }
        }
        assert_eq!(moves.last(), Some(&Move::SpindleOff));
    }
}
