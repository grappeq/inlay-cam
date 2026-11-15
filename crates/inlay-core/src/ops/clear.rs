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
use crate::toolpath::PathBuilder;

#[derive(Debug, Clone, PartialEq)]
pub struct ClearParams {
    pub tool_diameter: f64,
    /// Depth of the floor below Z0. Positive.
    pub depth: f64,
    /// Sideways distance between rings, mm.
    pub stepover: f64,
    /// Largest depth per pass, mm.
    pub stepdown: f64,
    /// Feed while cutting sideways, mm/min.
    pub feed: f64,
    /// Feed while cutting straight down, mm/min.
    pub plunge: f64,
}

/// Height above already-cut material at which a rapid descent stops and the
/// plunge feed takes over.
const PLUNGE_CLEARANCE: f64 = 1.0;

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
    let rings: Vec<Ring> = levels
        .iter()
        .rev()
        .flat_map(|level| level.iter().flat_map(|r| r.rings().cloned()))
        .collect();

    let passes = (p.depth / p.stepdown).ceil().max(1.0) as usize;
    for pass in 1..=passes {
        let z = -p.depth * pass as f64 / passes as f64;
        let floor_above = -p.depth * (pass - 1) as f64 / passes as f64;

        for ring in &rings {
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
                // Everything the tool can reach was cut to `floor_above` by the previous pass.
                path.rapid_to(first, floor_above + PLUNGE_CLEARANCE);
                path.feed_to([first[0], first[1], z], p.plunge);
            }
            for i in 1..=ring.len() {
                let q = ring[(start + i) % ring.len()];
                path.feed_to([q[0], q[1], z], p.feed);
            }
        }
    }
    path.retract();
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
    use std::f64::consts::PI;

    fn params() -> ClearParams {
        ClearParams {
            tool_diameter: 4.0,
            depth: 3.0,
            stepover: 1.6,
            stepdown: 1.0,
            feed: 600.0,
            plunge: 100.0,
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
