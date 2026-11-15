//! Boolean operations on regions.

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::simplify::SimplifyShape;
use i_overlay::float::single::SingleFloatOverlay;

use super::{ring_area, Region, Ring};

/// Merges regions into separate, non-overlapping regions. Regions that touch
/// or overlap become one.
pub fn union(regions: &[Region]) -> Vec<Region> {
    // Outer boundaries counter-clockwise and holes clockwise, so that the
    // non-zero rule adds outers and subtracts holes.
    let rings: Vec<Ring> = regions
        .iter()
        .flat_map(|region| {
            std::iter::once(oriented(&region.outer, true))
                .chain(region.holes.iter().map(|h| oriented(h, false)))
        })
        .collect();
    if rings.is_empty() {
        return Vec::new();
    }
    rings
        .simplify_shape(FillRule::NonZero)
        .into_iter()
        .filter(|shape| !shape.is_empty())
        .map(|mut shape| {
            let outer = shape.remove(0);
            Region::with_holes(outer, shape)
        })
        .collect()
}

/// What is left of `subject` after cutting `clips` out of it: none, one or
/// several regions.
pub fn difference(subject: &Region, clips: &[Region]) -> Vec<Region> {
    let shape = |region: &Region| -> Vec<Ring> {
        std::iter::once(oriented(&region.outer, true))
            .chain(region.holes.iter().map(|h| oriented(h, false)))
            .collect()
    };
    let clips: Vec<Vec<Ring>> = clips.iter().map(shape).collect();
    shape(subject)
        .overlay(&clips, OverlayRule::Difference, FillRule::NonZero)
        .into_iter()
        .filter(|shape| !shape.is_empty())
        .map(|mut shape| {
            let outer = shape.remove(0);
            Region::with_holes(outer, shape)
        })
        .collect()
}

/// The part of `subject` that lies inside `clips`: none, one or several regions.
pub fn intersection(subject: &Region, clips: &[Region]) -> Vec<Region> {
    let shape = |region: &Region| -> Vec<Ring> {
        std::iter::once(oriented(&region.outer, true))
            .chain(region.holes.iter().map(|h| oriented(h, false)))
            .collect()
    };
    let clips: Vec<Vec<Ring>> = clips.iter().map(shape).collect();
    if clips.is_empty() {
        return Vec::new();
    }
    shape(subject)
        .overlay(&clips, OverlayRule::Intersect, FillRule::NonZero)
        .into_iter()
        .filter(|shape| !shape.is_empty())
        .map(|mut shape| {
            let outer = shape.remove(0);
            Region::with_holes(outer, shape)
        })
        .collect()
}

fn oriented(ring: &Ring, counter_clockwise: bool) -> Ring {
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

    fn total(regions: &[Region]) -> f64 {
        regions.iter().map(Region::area).sum()
    }

    #[test]
    fn intersection_keeps_the_shared_part() {
        let a = Region::new(rect(0.0, 0.0, 10.0, 10.0));
        let b = Region::new(rect(6.0, 2.0, 20.0, 8.0));
        let out = intersection(&a, std::slice::from_ref(&b));
        assert_eq!(out.len(), 1);
        assert!((total(&out) - 24.0).abs() < 1e-6);
        assert!(intersection(&a, &[]).is_empty());
        assert!(intersection(&a, &[Region::new(rect(20.0, 0.0, 30.0, 10.0))]).is_empty());
    }

    #[test]
    fn overlapping_regions_merge() {
        let out = union(&[
            Region::new(rect(0.0, 0.0, 10.0, 10.0)),
            Region::new(rect(5.0, 0.0, 15.0, 10.0)),
        ]);
        assert_eq!(out.len(), 1);
        assert!((total(&out) - 150.0).abs() < 1e-6);
    }

    #[test]
    fn separate_regions_stay_separate() {
        let out = union(&[
            Region::new(rect(0.0, 0.0, 10.0, 10.0)),
            Region::new(rect(20.0, 0.0, 30.0, 10.0)),
        ]);
        assert_eq!(out.len(), 2);
        assert!((total(&out) - 200.0).abs() < 1e-6);
    }

    #[test]
    fn holes_survive_and_are_filled_by_a_region_placed_in_them() {
        let frame = Region::with_holes(
            rect(0.0, 0.0, 30.0, 30.0),
            vec![rect_cw(10.0, 10.0, 20.0, 20.0)],
        );
        let alone = union(std::slice::from_ref(&frame));
        assert_eq!(alone[0].holes.len(), 1);
        assert!((total(&alone) - 800.0).abs() < 1e-6);

        let plugged = union(&[frame, Region::new(rect(10.0, 10.0, 20.0, 20.0))]);
        assert_eq!(plugged.len(), 1);
        assert!(plugged[0].holes.is_empty());
        assert!((total(&plugged) - 900.0).abs() < 1e-6);
    }

    #[test]
    fn difference_cuts_holes_notches_and_splits() {
        let board = Region::new(rect(0.0, 0.0, 30.0, 10.0));
        // Inside: a hole.
        let holed = difference(&board, &[Region::new(rect(5.0, 2.0, 10.0, 8.0))]);
        assert_eq!(holed.len(), 1);
        assert_eq!(holed[0].holes.len(), 1);
        assert!(ring_area(&holed[0].outer) > 0.0 && ring_area(&holed[0].holes[0]) < 0.0);
        assert!((total(&holed) - 270.0).abs() < 1e-6);
        // Across: two pieces.
        let split = difference(&board, &[Region::new(rect(10.0, -1.0, 20.0, 11.0))]);
        assert_eq!(split.len(), 2);
        assert!((total(&split) - 200.0).abs() < 1e-6);
        // Covering: nothing left. Apart: unchanged.
        assert!(difference(&board, &[Region::new(rect(-1.0, -1.0, 31.0, 11.0))]).is_empty());
        let apart = difference(&board, &[Region::new(rect(40.0, 0.0, 50.0, 10.0))]);
        assert!((total(&apart) - 300.0).abs() < 1e-6);
    }

    #[test]
    fn orientation_of_the_input_does_not_matter() {
        let out = union(&[Region::new(rect_cw(0.0, 0.0, 10.0, 10.0))]);
        assert!((total(&out) - 100.0).abs() < 1e-6);
        assert!(ring_area(&out[0].outer) > 0.0);
    }
}
