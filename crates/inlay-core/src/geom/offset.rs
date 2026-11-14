//! Round offsets of regions, and the opening/closing built from them.
//!
//! Opening by a tool radius gives the shape a round tool can cut from inside
//! (inside corners rounded); closing gives the shape it can cut from outside.

use i_overlay::mesh::float::outline::offset::OutlineOffset;
use i_overlay::mesh::float::style::{LineJoin, OutlineStyle};

use super::{ring_area, Region, Ring};

/// Largest allowed gap between a true arc and the polyline that replaces it, in mm.
pub const ARC_TOLERANCE: f64 = 0.005;

/// Offsets `regions` by `delta` mm with round joins: positive grows, negative
/// shrinks. Regions that vanish are dropped; regions that split or merge come
/// back as the resulting separate regions.
pub fn offset(regions: &[Region], delta: f64) -> Vec<Region> {
    if delta == 0.0 {
        return regions.to_vec();
    }
    let shapes: Vec<Vec<Ring>> = regions.iter().map(oriented).collect();
    let radius = delta.abs();
    // The join parameter is segment length / radius; pick it from the chord error.
    let step = 2.0 * (1.0 - (ARC_TOLERANCE / radius).min(1.0)).acos();
    let style = OutlineStyle::new(delta).line_join(LineJoin::Round(step.max(0.01)));
    shapes
        .outline(&style)
        .into_iter()
        .filter(|shape| !shape.is_empty())
        .map(|mut shape| {
            let outer = shape.remove(0);
            Region::with_holes(outer, shape)
        })
        .collect()
}

/// Shrinks then grows by `radius`: removes everything a round tool of that
/// radius cannot reach from inside, rounding convex-to-the-tool corners.
pub fn open(regions: &[Region], radius: f64) -> Vec<Region> {
    offset(&offset(regions, -radius), radius)
}

/// Grows then shrinks by `radius`: fills everything a round tool of that
/// radius cannot reach from outside.
pub fn close(regions: &[Region], radius: f64) -> Vec<Region> {
    offset(&offset(regions, radius), -radius)
}

pub fn total_area(regions: &[Region]) -> f64 {
    regions.iter().map(Region::area).sum()
}

/// Outer ring counter-clockwise, holes clockwise, as the offset library requires.
fn oriented(region: &Region) -> Vec<Ring> {
    let mut rings = Vec::with_capacity(1 + region.holes.len());
    rings.push(with_orientation(&region.outer, true));
    rings.extend(region.holes.iter().map(|h| with_orientation(h, false)));
    rings
}

fn with_orientation(ring: &Ring, counter_clockwise: bool) -> Ring {
    let mut ring = ring.clone();
    if (ring_area(&ring) > 0.0) != counter_clockwise {
        ring.reverse();
    }
    ring
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::*;
    use super::*;
    use std::f64::consts::PI;

    /// Arcs are replaced by inscribed polylines, so areas come out slightly small.
    fn assert_area(regions: &[Region], expected: f64) {
        let area = total_area(regions);
        assert!(
            (area - expected).abs() < 0.05,
            "area {area}, expected {expected}"
        );
    }

    #[test]
    fn inset_square_stays_square() {
        let out = offset(&[Region::new(rect(0.0, 0.0, 10.0, 10.0))], -2.0);
        assert_eq!(out.len(), 1);
        assert_area(&out, 36.0);
    }

    #[test]
    fn outset_square_gets_round_corners() {
        let out = offset(&[Region::new(rect(0.0, 0.0, 10.0, 10.0))], 2.0);
        assert_area(&out, 100.0 + 4.0 * 10.0 * 2.0 + PI * 4.0);
    }

    #[test]
    fn inset_past_half_width_removes_the_region() {
        let out = offset(&[Region::new(rect(0.0, 0.0, 10.0, 10.0))], -6.0);
        assert_area(&out, 0.0);
    }

    #[test]
    fn ring_orientation_does_not_matter() {
        let clockwise = Region::new(rect_cw(0.0, 0.0, 10.0, 10.0));
        assert_area(&offset(&[clockwise], -2.0), 36.0);
    }

    #[test]
    fn inset_frame_shrinks_outer_and_grows_hole() {
        let frame = Region::with_holes(
            rect(0.0, 0.0, 30.0, 30.0),
            vec![rect_cw(10.0, 10.0, 20.0, 20.0)],
        );
        let out = offset(&[frame], -1.0);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].holes.len(), 1);
        // The hole grows with round corners: 12x12 minus the four corner cut-offs.
        assert_area(&out, 28.0 * 28.0 - (144.0 - (4.0 - PI)));
    }

    #[test]
    fn opening_rounds_the_corners_a_tool_cannot_reach() {
        let r = 2.0;
        let out = open(&[Region::new(rect(0.0, 0.0, 10.0, 10.0))], r);
        assert_area(&out, 100.0 - (4.0 - PI) * r * r);
    }

    #[test]
    fn opening_removes_a_neck_narrower_than_the_tool() {
        // Two 10 mm squares joined by a 2 mm wide neck.
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
        let out = open(&[dumbbell], 1.5);
        assert_eq!(
            out.len(),
            2,
            "the neck should vanish and leave two separate squares"
        );
    }

    #[test]
    fn closing_fills_the_inside_corner_of_an_l() {
        let r = 2.0;
        let l = Region::new(l_shape());
        let before = l.area();
        let out = close(&[l], r);
        assert_area(&out, before + (1.0 - PI / 4.0) * r * r);
    }

    #[test]
    fn a_shape_opened_then_closed_can_be_cut_from_both_sides() {
        // The "cuttable shape" for flat inlays: opening it again changes nothing.
        let r = 1.5;
        let cuttable = close(&open(&[Region::new(star(0.0, 0.0, 20.0, 8.0))], r), r);
        let reopened = open(&cuttable, r);
        // Each offset replaces arcs with polylines, so compare boundaries by
        // distance, with a few arc tolerances of slack for the four extra offsets.
        let limit = 4.0 * ARC_TOLERANCE;
        let moved =
            boundary_deviation(&cuttable, &reopened).max(boundary_deviation(&reopened, &cuttable));
        assert!(moved < limit, "re-opening moved the boundary by {moved} mm");
    }

    /// Largest distance from any vertex of `from` to the boundary of `to`.
    fn boundary_deviation(from: &[Region], to: &[Region]) -> f64 {
        from.iter()
            .flat_map(|region| region.rings())
            .flatten()
            .map(|p| {
                to.iter()
                    .map(|region| region.distance_to_boundary(*p))
                    .fold(f64::INFINITY, f64::min)
            })
            .fold(0.0, f64::max)
    }
}
