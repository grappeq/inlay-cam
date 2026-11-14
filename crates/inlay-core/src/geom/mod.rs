//! 2D geometry: regions, offsets and the medial axis.
//!
//! Public coordinates are millimetres as `f64`. Algorithms that need exact
//! arithmetic snap to an integer grid of [`UNITS_PER_MM`] units per millimetre.

pub mod boolean;
pub mod medial;
pub mod offset;
pub mod simplify;

/// Integer grid resolution: 1 unit = 1 micrometre.
pub const UNITS_PER_MM: f64 = 1000.0;

pub type Point = [f64; 2];

/// A closed ring of points. The closing segment from last to first is implied.
pub type Ring = Vec<Point>;

/// A filled region: one outer boundary and any number of holes.
#[derive(Debug, Clone, PartialEq)]
pub struct Region {
    pub outer: Ring,
    pub holes: Vec<Ring>,
}

impl Region {
    pub fn new(outer: Ring) -> Self {
        Self {
            outer,
            holes: Vec::new(),
        }
    }

    pub fn with_holes(outer: Ring, holes: Vec<Ring>) -> Self {
        Self { outer, holes }
    }

    pub fn rings(&self) -> impl Iterator<Item = &Ring> {
        std::iter::once(&self.outer).chain(self.holes.iter())
    }

    /// Area in mm², holes subtracted. Independent of ring orientation.
    pub fn area(&self) -> f64 {
        ring_area(&self.outer).abs() - self.holes.iter().map(|h| ring_area(h).abs()).sum::<f64>()
    }

    /// True when `p` is strictly inside the region (even-odd rule over all rings).
    pub fn contains(&self, p: Point) -> bool {
        let mut inside = false;
        for ring in self.rings() {
            let n = ring.len();
            for i in 0..n {
                let a = ring[i];
                let b = ring[(i + 1) % n];
                if (a[1] > p[1]) != (b[1] > p[1]) {
                    let x = a[0] + (p[1] - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
                    if p[0] < x {
                        inside = !inside;
                    }
                }
            }
        }
        inside
    }

    /// Distance from `p` to the nearest point of any boundary ring.
    pub fn distance_to_boundary(&self, p: Point) -> f64 {
        let mut best = f64::INFINITY;
        for ring in self.rings() {
            let n = ring.len();
            for i in 0..n {
                best = best.min(point_segment_distance(p, ring[i], ring[(i + 1) % n]));
            }
        }
        best
    }
}

/// Signed area of a ring: positive when counter-clockwise.
pub fn ring_area(ring: &[Point]) -> f64 {
    let n = ring.len();
    let mut twice = 0.0;
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        twice += a[0] * b[1] - b[0] * a[1];
    }
    twice / 2.0
}

pub fn distance(a: Point, b: Point) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

pub fn point_segment_distance(p: Point, a: Point, b: Point) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    if len2 == 0.0 {
        return distance(p, a);
    }
    let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0);
    distance(p, [a[0] + t * dx, a[1] + t * dy])
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Ring {
        vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
    }

    /// Clockwise rectangle, for use as a hole.
    pub fn rect_cw(x0: f64, y0: f64, x1: f64, y1: f64) -> Ring {
        vec![[x0, y0], [x0, y1], [x1, y1], [x1, y0]]
    }

    pub fn l_shape() -> Ring {
        vec![
            [0.0, 0.0],
            [20.0, 0.0],
            [20.0, 8.0],
            [8.0, 8.0],
            [8.0, 20.0],
            [0.0, 20.0],
        ]
    }

    pub fn circle(cx: f64, cy: f64, r: f64, n: usize) -> Ring {
        (0..n)
            .map(|i| {
                let a = i as f64 / n as f64 * std::f64::consts::TAU;
                [cx + r * a.cos(), cy + r * a.sin()]
            })
            .collect()
    }

    /// A five-pointed star: sharp convex tips and reflex inner corners.
    pub fn star(cx: f64, cy: f64, r_out: f64, r_in: f64) -> Ring {
        (0..10)
            .map(|i| {
                let a = i as f64 / 10.0 * std::f64::consts::TAU + std::f64::consts::FRAC_PI_2;
                let r = if i % 2 == 0 { r_out } else { r_in };
                [cx + r * a.cos(), cy + r * a.sin()]
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn area_subtracts_holes() {
        let region = Region::with_holes(
            rect(0.0, 0.0, 10.0, 10.0),
            vec![rect_cw(4.0, 4.0, 6.0, 6.0)],
        );
        assert!((region.area() - 96.0).abs() < 1e-9);
    }

    #[test]
    fn contains_respects_holes() {
        let region = Region::with_holes(
            rect(0.0, 0.0, 10.0, 10.0),
            vec![rect_cw(4.0, 4.0, 6.0, 6.0)],
        );
        assert!(region.contains([1.0, 1.0]));
        assert!(!region.contains([5.0, 5.0]));
        assert!(!region.contains([11.0, 5.0]));
    }
}
