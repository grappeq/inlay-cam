//! Medial axis of a region, from the Voronoi diagram of its boundary segments.
//!
//! Each medial point is the centre of a circle that touches the boundary in two
//! or more places. The circle's radius is what V-carving turns into depth.

use boostvoronoi::prelude::*;

use super::{distance, point_segment_distance, Point, Region, UNITS_PER_MM};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MedialEdge {
    pub a: Point,
    pub b: Point,
    /// Inscribed-circle radius at `a` and `b`, in mm.
    pub ra: f64,
    pub rb: f64,
    /// True when the real edge is a parabolic arc between `a` and `b` (the
    /// bisector of a boundary vertex and a boundary segment). The radius is
    /// then not linear along the edge and the edge must be sampled.
    pub curved: bool,
}

#[derive(Debug)]
pub enum MedialError {
    /// A ring has fewer than three distinct points after snapping to the grid.
    DegenerateRing,
    Voronoi(String),
}

impl std::fmt::Display for MedialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MedialError::DegenerateRing => write!(f, "a ring has fewer than three distinct points"),
            MedialError::Voronoi(msg) => write!(f, "Voronoi diagram failed: {msg}"),
        }
    }
}

impl std::error::Error for MedialError {}

impl From<BvError> for MedialError {
    fn from(e: BvError) -> Self {
        MedialError::Voronoi(format!("{e:?}"))
    }
}

/// Computes the medial axis of `region`.
///
/// The rings must not self-intersect or touch each other; segments may only
/// meet at shared endpoints.
pub fn medial_axis(region: &Region) -> Result<Vec<MedialEdge>, MedialError> {
    let mut segments: Vec<[i32; 4]> = Vec::new();
    for ring in region.rings() {
        let mut pts: Vec<[i32; 2]> = Vec::with_capacity(ring.len());
        for p in ring {
            let q = [snap(p[0]), snap(p[1])];
            if pts.last() != Some(&q) {
                pts.push(q);
            }
        }
        if pts.len() > 1 && pts.first() == pts.last() {
            pts.pop();
        }
        if pts.len() < 3 {
            return Err(MedialError::DegenerateRing);
        }
        for i in 0..pts.len() {
            let a = pts[i];
            let b = pts[(i + 1) % pts.len()];
            segments.push([a[0], a[1], b[0], b[1]]);
        }
    }

    let diagram = Builder::<i32>::default()
        .with_segments(segments.iter())?
        .build()?;

    let mut edges = Vec::new();
    for edge in diagram.edges() {
        let id = edge.id();
        let twin = diagram.edge_get_twin(id)?;
        // Every edge exists twice (once per side); keep one of each pair.
        // Secondary edges join a segment to its own endpoint and are not part
        // of the medial axis.
        if twin.usize() < id.usize() || !edge.is_primary() {
            continue;
        }
        let (Some(v0), Some(v1)) = (edge.vertex0(), diagram.edge_get_vertex1(id)?) else {
            continue; // infinite edge, outside the region
        };
        let (v0, v1) = (diagram.vertex(v0)?, diagram.vertex(v1)?);
        let a_units = [v0.x(), v0.y()];
        let b_units = [v1.x(), v1.y()];
        let a = [a_units[0] / UNITS_PER_MM, a_units[1] / UNITS_PER_MM];
        let b = [b_units[0] / UNITS_PER_MM, b_units[1] / UNITS_PER_MM];
        if !region.contains([(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0]) {
            continue;
        }

        let cell = diagram.cell(edge.cell()?)?;
        let (source, category) = cell.source_index_2();
        let s = segments[source.usize()];
        let (s0, s1) = ([s[0] as f64, s[1] as f64], [s[2] as f64, s[3] as f64]);
        let radius = |p: Point| match category {
            SourceCategory::Segment => point_segment_distance(p, s0, s1),
            SourceCategory::SegmentStart | SourceCategory::SinglePoint => distance(p, s0),
            SourceCategory::SegmentEnd => distance(p, s1),
        };
        edges.push(MedialEdge {
            a,
            b,
            ra: radius(a_units) / UNITS_PER_MM,
            rb: radius(b_units) / UNITS_PER_MM,
            curved: edge.is_curved(),
        });
    }
    Ok(edges)
}

fn snap(mm: f64) -> i32 {
    (mm * UNITS_PER_MM).round() as i32
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::*;
    use super::*;

    /// Grid snapping moves points by up to half a unit, so radii agree with the
    /// unsnapped region only to about a micrometre.
    const TOL: f64 = 2.0 / UNITS_PER_MM;

    fn max_radius(edges: &[MedialEdge]) -> f64 {
        edges.iter().flat_map(|e| [e.ra, e.rb]).fold(0.0, f64::max)
    }

    fn straight_length(edges: &[MedialEdge]) -> f64 {
        edges.iter().map(|e| distance(e.a, e.b)).sum()
    }

    /// The defining property: every medial vertex is exactly as far from the
    /// boundary as its reported radius, and lies inside the region.
    fn assert_inscribed(region: &Region, edges: &[MedialEdge]) {
        assert!(!edges.is_empty());
        for e in edges {
            for (p, r) in [(e.a, e.ra), (e.b, e.rb)] {
                let d = region.distance_to_boundary(p);
                assert!(
                    (d - r).abs() < TOL,
                    "radius {r} at {p:?} but boundary is {d} away"
                );
            }
        }
    }

    #[test]
    fn square_has_four_diagonals_meeting_at_centre() {
        let region = Region::new(rect(0.0, 0.0, 10.0, 10.0));
        let edges = medial_axis(&region).unwrap();
        assert_inscribed(&region, &edges);
        assert!((max_radius(&edges) - 5.0).abs() < TOL);
        let diagonals = 4.0 * 5.0 * std::f64::consts::SQRT_2;
        assert!((straight_length(&edges) - diagonals).abs() < 1e-3);
        assert!(edges.iter().all(|e| !e.curved));
    }

    #[test]
    fn rectangle_has_a_spine_of_constant_radius() {
        let region = Region::new(rect(0.0, 0.0, 20.0, 10.0));
        let edges = medial_axis(&region).unwrap();
        assert_inscribed(&region, &edges);
        let spine: f64 = edges
            .iter()
            .filter(|e| (e.ra - 5.0).abs() < TOL && (e.rb - 5.0).abs() < TOL)
            .map(|e| distance(e.a, e.b))
            .sum();
        assert!((spine - 10.0).abs() < 1e-3, "spine length {spine}");
    }

    #[test]
    fn l_shape_has_a_curved_edge_at_the_reflex_corner() {
        let region = Region::new(l_shape());
        let edges = medial_axis(&region).unwrap();
        assert_inscribed(&region, &edges);
        assert!(edges.iter().any(|e| e.curved));
        // Arms are 8 mm wide, so their spines have radius 4. The largest
        // circle sits in the elbow, touching both outer walls and the reflex
        // corner at (8, 8): r = 8 * (2 - sqrt(2)).
        let elbow = 8.0 * (2.0 - std::f64::consts::SQRT_2);
        assert!(
            (max_radius(&edges) - elbow).abs() < TOL,
            "max radius {}",
            max_radius(&edges)
        );
    }

    #[test]
    fn frame_with_hole_stays_between_the_walls() {
        let region = Region::with_holes(
            rect(0.0, 0.0, 30.0, 30.0),
            vec![rect_cw(10.0, 10.0, 20.0, 20.0)],
        );
        let edges = medial_axis(&region).unwrap();
        assert_inscribed(&region, &edges);
        // The frame is 10 mm wide all round, plus slightly more in the corners.
        assert!(max_radius(&edges) < 5.0 * std::f64::consts::SQRT_2);
        for e in &edges {
            assert!(region.contains([(e.a[0] + e.b[0]) / 2.0, (e.a[1] + e.b[1]) / 2.0]));
        }
    }

    #[test]
    fn star_tips_ramp_up_to_zero_radius() {
        let region = Region::new(star(0.0, 0.0, 20.0, 8.0));
        let edges = medial_axis(&region).unwrap();
        assert_inscribed(&region, &edges);
        let tips = edges
            .iter()
            .flat_map(|e| [e.ra, e.rb])
            .filter(|r| *r < TOL)
            .count();
        assert!(
            tips >= 5,
            "expected an edge reaching each of the 5 tips, got {tips}"
        );
    }

    #[test]
    fn flattened_circle_peaks_at_its_centre() {
        let region = Region::new(circle(50.0, 50.0, 25.0, 180));
        let edges = medial_axis(&region).unwrap();
        assert_inscribed(&region, &edges);
        // Inscribed radius of a regular 180-gon with circumradius 25.
        let apothem = 25.0 * (std::f64::consts::PI / 180.0).cos();
        assert!((max_radius(&edges) - apothem).abs() < TOL);
    }

    proptest::proptest! {
        /// Random spiky shapes with a hole: any radii at evenly spaced angles
        /// give a simple polygon, with a mix of sharp and reflex corners.
        #[test]
        fn random_radial_shapes_satisfy_the_inscribed_property(
            radii in proptest::collection::vec(5.0f64..30.0, 5..80),
            with_hole in proptest::bool::ANY,
        ) {
            let n = radii.len();
            let outer: Vec<Point> = radii
                .iter()
                .enumerate()
                .map(|(i, r)| {
                    let a = i as f64 / n as f64 * std::f64::consts::TAU;
                    [r * a.cos(), r * a.sin()]
                })
                .collect();
            let holes = if with_hole { vec![circle(0.0, 0.0, 2.0, 24)] } else { vec![] };
            let region = Region::with_holes(outer, holes);
            let edges = medial_axis(&region).unwrap();
            assert_inscribed(&region, &edges);
        }
    }

    #[test]
    fn degenerate_ring_is_rejected() {
        let region = Region::new(vec![[0.0, 0.0], [1.0, 0.0]]);
        assert!(matches!(
            medial_axis(&region),
            Err(MedialError::DegenerateRing)
        ));
    }
}
