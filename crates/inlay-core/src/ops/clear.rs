//! Area clearing with a flat end mill: removes everything the tool can reach
//! inside a set of regions, down to a flat floor.
//!
//! The tool follows rings parallel to the boundary, from the middle outwards,
//! one depth pass at a time. The outermost ring puts the tool's edge exactly
//! on the boundary, so inside corners come out rounded to the tool's radius.

use crate::geom::offset::offset;
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

/// Appends the clearing moves for `regions` to `path`. The tool must already
/// be loaded and spinning. Returns the area the tool's edge reaches, i.e. the
/// pocket that results.
pub fn clear(
    path: &mut PathBuilder,
    regions: &[Region],
    p: &ClearParams,
) -> Result<Vec<Region>, ClearError> {
    // One separate area at a time, to full depth, so the tool does not hop
    // between pockets after every ring.
    let mut pocket = Vec::new();
    for region in regions {
        pocket.extend(clear_one(path, region, p));
    }
    if pocket.is_empty() {
        return Err(ClearError::ToolTooWide);
    }
    Ok(pocket)
}

/// Clears one connected region. Returns the pocket that results, which is
/// empty when the tool does not fit anywhere in it.
fn clear_one(path: &mut PathBuilder, region: &Region, p: &ClearParams) -> Vec<Region> {
    let radius = p.tool_diameter / 2.0;
    let region = std::slice::from_ref(region);

    // Ring k keeps the tool centre `radius + k * stepover` inside the boundary.
    // Each is offset from the original, so errors do not build up.
    let mut levels: Vec<Vec<Region>> = Vec::new();
    loop {
        let level = offset(region, -(radius + levels.len() as f64 * p.stepover));
        if level.is_empty() {
            break;
        }
        levels.push(level);
    }
    let Some(allowed) = levels.first().cloned() else {
        return Vec::new();
    };

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

    offset(&allowed, radius)
}

fn nearest_vertex(ring: &Ring, from: Option<Point>) -> usize {
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
fn stays_inside(allowed: &[Region], a: Point, b: Point, step: f64) -> bool {
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
