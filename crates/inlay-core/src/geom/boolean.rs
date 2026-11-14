//! Boolean operations on regions.

use i_overlay::core::fill_rule::FillRule;
use i_overlay::float::simplify::SimplifyShape;

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
    fn orientation_of_the_input_does_not_matter() {
        let out = union(&[Region::new(rect_cw(0.0, 0.0, 10.0, 10.0))]);
        assert!((total(&out) - 100.0).abs() < 1e-6);
        assert!(ring_area(&out[0].outer) > 0.0);
    }
}
