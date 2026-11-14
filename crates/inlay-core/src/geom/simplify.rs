//! Thinning the points of a ring without moving it noticeably.

use super::{point_segment_distance, Point, Region, Ring};

/// Removes points from every ring of `region` so that no removed point was
/// further than `tolerance` from the ring that remains (Douglas-Peucker).
/// Rings that would collapse are kept as they are.
pub fn simplify(region: &Region, tolerance: f64) -> Region {
    Region::with_holes(
        simplify_ring(&region.outer, tolerance),
        region
            .holes
            .iter()
            .map(|h| simplify_ring(h, tolerance))
            .collect(),
    )
}

pub fn simplify_ring(ring: &Ring, tolerance: f64) -> Ring {
    if ring.len() <= 4 {
        return ring.clone();
    }
    // Anchor the ring at two points far apart, then thin each half as an open line.
    let far = (0..ring.len())
        .max_by(|&i, &j| {
            let d = |k: usize| super::distance(ring[0], ring[k]);
            d(i).total_cmp(&d(j))
        })
        .unwrap_or(ring.len() / 2);
    if far == 0 {
        return ring.clone();
    }
    let mut keep = vec![false; ring.len() + 1];
    keep[0] = true;
    keep[far] = true;
    keep[ring.len()] = true;
    let at = |i: usize| -> Point { ring[i % ring.len()] };
    let mut stack = vec![(0, far), (far, ring.len())];
    while let Some((from, to)) = stack.pop() {
        let mut worst = (tolerance, None);
        for i in from + 1..to {
            let d = point_segment_distance(at(i), at(from), at(to));
            if d > worst.0 {
                worst = (d, Some(i));
            }
        }
        if let Some(i) = worst.1 {
            keep[i] = true;
            stack.push((from, i));
            stack.push((i, to));
        }
    }
    let out: Ring = (0..ring.len()).filter(|&i| keep[i]).map(at).collect();
    if out.len() < 3 {
        ring.clone()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::*;
    use super::super::ring_area;
    use super::*;

    #[test]
    fn points_on_straight_sides_are_removed() {
        let mut ring = Vec::new();
        for (a, b) in [
            ([0.0, 0.0], [10.0, 0.0]),
            ([10.0, 0.0], [10.0, 10.0]),
            ([10.0, 10.0], [0.0, 10.0]),
            ([0.0, 10.0], [0.0, 0.0]),
        ] {
            for i in 0..10 {
                let t = i as f64 / 10.0;
                ring.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            }
        }
        let out = simplify_ring(&ring, 0.001);
        assert_eq!(out.len(), 4);
        assert!((ring_area(&out) - 100.0).abs() < 1e-9);
    }

    #[test]
    fn a_circle_stays_within_tolerance_and_keeps_its_direction() {
        let ring = circle(0.0, 0.0, 10.0, 720);
        let out = simplify_ring(&ring, 0.01);
        assert!(out.len() < 200 && out.len() > 20, "{} points", out.len());
        assert!(ring_area(&out) > 0.0);
        for p in &ring {
            let d = (0..out.len())
                .map(|i| point_segment_distance(*p, out[i], out[(i + 1) % out.len()]))
                .fold(f64::INFINITY, f64::min);
            assert!(d <= 0.01 + 1e-9);
        }
    }

    #[test]
    fn small_rings_are_left_alone() {
        let ring = rect(0.0, 0.0, 1.0, 1.0);
        assert_eq!(simplify_ring(&ring, 10.0), ring);
    }
}
