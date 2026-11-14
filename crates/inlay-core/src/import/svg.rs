//! SVG import: turns a drawing into filled regions in millimetres.
//!
//! Each filled path becomes one or more regions (one per separate filled
//! area), with overlaps inside the path resolved by its fill rule. A path with
//! an outline but no fill, as CAD exports draw everything, is read as the area
//! its closed outlines enclose, less any smaller outline drawn over it: the
//! areas between the lines, as the drawing reads. Regions from different paths
//! are kept apart so they can be selected separately.

use i_overlay::core::fill_rule::FillRule;
use i_overlay::float::simplify::SimplifyShape;
use serde::Serialize;
use usvg::tiny_skia_path::{PathSegment, Point as SkPoint};

use crate::geom::boolean::difference;
use crate::geom::{distance, ring_area, Point, Region, Ring};
use crate::project::{Design, DesignRegion};

/// SVG user units are CSS pixels: 96 per inch.
const MM_PER_PX: f64 = 25.4 / 96.0;

/// Largest allowed gap between a curve and the polyline that replaces it, mm.
pub const FLATTEN_TOLERANCE: f64 = 0.01;

/// Filled areas smaller than this are specks, not shapes. mm².
const MIN_REGION_AREA: f64 = 0.01;

/// An outline whose ends are this close, mm, is closed even without a close command.
const CLOSED_GAP: f64 = 0.001;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgImport {
    pub design: Design,
    pub report: ImportReport,
}

/// What the import left out, so the user is not surprised by a missing shape.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// Outlines without a fill that do not close, so they enclose no area.
    pub open_outlines: u32,
    /// The drawing contains text that was not converted to outlines.
    pub has_text: bool,
    pub images: u32,
    /// Filled areas too small to cut.
    pub specks: u32,
}

pub fn import_svg(text: &str, source_name: &str) -> Result<SvgImport, String> {
    let tree = usvg::Tree::from_str(text, &usvg::Options::default())
        .map_err(|e| format!("The file could not be read as an SVG drawing: {e}"))?;

    let height_px = tree.size().height() as f64;
    let mut importer = Importer {
        height_px,
        regions: Vec::new(),
        outlines: Vec::new(),
        report: ImportReport::default(),
    };
    // Without font support the parser drops text silently, so look for it in the source.
    importer.report.has_text = text.contains("<text");
    importer.group(tree.root());
    importer.split_nested_outlines();

    Ok(SvgImport {
        design: Design {
            source_name: source_name.to_string(),
            width: tree.size().width() as f64 * MM_PER_PX,
            height: height_px * MM_PER_PX,
            scale: 1.0,
            mirror: false,
            regions: importer.regions,
        },
        report: importer.report,
    })
}

struct Importer {
    height_px: f64,
    regions: Vec<DesignRegion>,
    /// For each region, whether it came from an outline without a fill.
    outlines: Vec<bool>,
    report: ImportReport,
}

impl Importer {
    fn group(&mut self, group: &usvg::Group) {
        for node in group.children() {
            match node {
                usvg::Node::Group(inner) => self.group(inner),
                usvg::Node::Path(path) => self.path(path),
                usvg::Node::Image(_) => self.report.images += 1,
                usvg::Node::Text(_) => self.report.has_text = true,
            }
        }
    }

    fn path(&mut self, path: &usvg::Path) {
        if !path.is_visible() {
            return;
        }
        let color = |paint: &usvg::Paint| match paint {
            usvg::Paint::Color(c) => Some(format!("#{:02x}{:02x}{:02x}", c.red, c.green, c.blue)),
            _ => None,
        };
        let outline = path.fill().is_none();
        let (rings, color, rule): (Vec<Ring>, _, _) = if let Some(fill) = path.fill() {
            let rule = match fill.rule() {
                usvg::FillRule::NonZero => FillRule::NonZero,
                usvg::FillRule::EvenOdd => FillRule::EvenOdd,
            };
            // A fill closes every subpath whether or not the path says so.
            let rings = self.rings(path).into_iter().map(|(ring, _)| ring);
            (rings.collect(), color(fill.paint()), rule)
        } else if let Some(stroke) = path.stroke() {
            // An outline drawing: the shape is what the closed outlines enclose.
            // Even-odd makes an outline inside another one a hole, whichever
            // way each was drawn.
            let (closed, open): (Vec<_>, Vec<_>) = self
                .rings(path)
                .into_iter()
                .partition(|(_, closed)| *closed);
            self.report.open_outlines += open.len() as u32;
            let rings = closed.into_iter().map(|(ring, _)| ring);
            (rings.collect(), color(stroke.paint()), FillRule::EvenOdd)
        } else {
            return;
        };
        if rings.is_empty() {
            return;
        }
        // Resolves self-intersections and nesting: every result is one filled
        // area, outer boundary counter-clockwise, holes clockwise.
        for mut shape in rings.simplify_shape(rule) {
            if shape.is_empty() {
                continue;
            }
            let outer = shape.remove(0);
            let area =
                ring_area(&outer).abs() - shape.iter().map(|h| ring_area(h).abs()).sum::<f64>();
            if area < MIN_REGION_AREA {
                self.report.specks += 1;
                continue;
            }
            self.regions.push(DesignRegion {
                id: self.regions.len() as u32,
                color: color.clone(),
                outer,
                holes: shape,
            });
            self.outlines.push(outline);
        }
    }

    /// Outlines carry no fill to say which side of a line belongs to which
    /// shape, so the shapes are the areas between the lines: every smaller
    /// outline is cut out of each larger one it overlaps. A circle around six
    /// shapes becomes the web between them, not a disc underneath.
    fn split_nested_outlines(&mut self) {
        if self.outlines.iter().filter(|&&o| o).count() < 2 {
            return;
        }
        let shapes: Vec<Option<(Region, f64)>> = self
            .regions
            .iter()
            .zip(&self.outlines)
            .map(|(region, &outline)| {
                outline.then(|| {
                    let shape = Region::with_holes(region.outer.clone(), region.holes.clone());
                    let area = shape.area();
                    (shape, area)
                })
            })
            .collect();
        let mut out: Vec<DesignRegion> = Vec::with_capacity(self.regions.len());
        for (i, region) in std::mem::take(&mut self.regions).into_iter().enumerate() {
            let Some((shape, area)) = &shapes[i] else {
                out.push(region);
                continue;
            };
            // Ties go to the later outline, so two identical outlines leave one shape.
            let smaller: Vec<Region> = shapes
                .iter()
                .enumerate()
                .filter_map(|(j, other)| {
                    let (other, other_area) = other.as_ref()?;
                    (j != i && (*other_area < *area || (*other_area == *area && j > i)))
                        .then(|| other.clone())
                })
                .collect();
            for piece in difference(shape, &smaller) {
                if piece.area() >= MIN_REGION_AREA {
                    out.push(DesignRegion {
                        id: 0,
                        color: region.color.clone(),
                        outer: piece.outer,
                        holes: piece.holes,
                    });
                }
            }
        }
        for (id, region) in out.iter_mut().enumerate() {
            region.id = id as u32;
        }
        self.regions = out;
    }

    /// Flattens a path into rings in mm, Y up, each with whether the path
    /// closed it (by a close command or by ending where it started).
    fn rings(&self, path: &usvg::Path) -> Vec<(Ring, bool)> {
        let transform = path.abs_transform();
        let to_mm = |p: SkPoint| -> Point {
            let mut q = p;
            transform.map_point(&mut q);
            [
                q.x as f64 * MM_PER_PX,
                (self.height_px - q.y as f64) * MM_PER_PX,
            ]
        };

        let mut rings: Vec<(Ring, bool)> = Vec::new();
        let mut current: Ring = Vec::new();
        for segment in path.data().segments() {
            match segment {
                PathSegment::MoveTo(p) => {
                    finish(&mut current, false, &mut rings);
                    current.push(to_mm(p));
                }
                PathSegment::LineTo(p) => current.push(to_mm(p)),
                PathSegment::QuadTo(c, p) => {
                    if let Some(&start) = current.last() {
                        flatten_quad(start, to_mm(c), to_mm(p), &mut current);
                    }
                }
                PathSegment::CubicTo(c1, c2, p) => {
                    if let Some(&start) = current.last() {
                        flatten_cubic(start, to_mm(c1), to_mm(c2), to_mm(p), &mut current);
                    }
                }
                PathSegment::Close => finish(&mut current, true, &mut rings),
            }
        }
        finish(&mut current, false, &mut rings);
        rings
    }
}

/// Moves `current` into `rings` if it is a usable ring, dropping repeated points.
fn finish(current: &mut Ring, close_command: bool, rings: &mut Vec<(Ring, bool)>) {
    let mut ring: Ring = Vec::with_capacity(current.len());
    for &p in current.iter() {
        if ring.last().is_none_or(|&last| distance(last, p) > 1e-9) {
            ring.push(p);
        }
    }
    let mut closed = close_command;
    if ring.len() > 1 && distance(ring[0], ring[ring.len() - 1]) <= CLOSED_GAP {
        ring.pop();
        closed = true;
    }
    if ring.len() >= 3 {
        rings.push((ring, closed));
    } else if ring.len() == 2 && !closed {
        // A lone line: nothing to fill, but worth reporting as an open outline.
        rings.push((ring, false));
    }
    current.clear();
}

fn flatten_quad(p0: Point, p1: Point, p2: Point, out: &mut Ring) {
    // Distance from an evenly split quadratic to its chords is at most d / (4 n²),
    // where d is the length of the second difference.
    let d = (p0[0] - 2.0 * p1[0] + p2[0]).hypot(p0[1] - 2.0 * p1[1] + p2[1]);
    let n = (d / (4.0 * FLATTEN_TOLERANCE)).sqrt().ceil().max(1.0) as usize;
    for i in 1..=n {
        let t = i as f64 / n as f64;
        let u = 1.0 - t;
        out.push([
            u * u * p0[0] + 2.0 * u * t * p1[0] + t * t * p2[0],
            u * u * p0[1] + 2.0 * u * t * p1[1] + t * t * p2[1],
        ]);
    }
}

fn flatten_cubic(p0: Point, p1: Point, p2: Point, p3: Point, out: &mut Ring) {
    // Same bound for a cubic: at most 3 d / (4 n²), with d the larger second difference.
    let d1 = (p0[0] - 2.0 * p1[0] + p2[0]).hypot(p0[1] - 2.0 * p1[1] + p2[1]);
    let d2 = (p1[0] - 2.0 * p2[0] + p3[0]).hypot(p1[1] - 2.0 * p2[1] + p3[1]);
    let n = (3.0 * d1.max(d2) / (4.0 * FLATTEN_TOLERANCE))
        .sqrt()
        .ceil()
        .max(1.0) as usize;
    for i in 1..=n {
        let t = i as f64 / n as f64;
        let u = 1.0 - t;
        let (a, b, c, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
        out.push([
            a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
            a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
        ]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn import(svg: &str) -> SvgImport {
        import_svg(svg, "test.svg").unwrap()
    }

    fn area(region: &DesignRegion) -> f64 {
        region.to_region().area()
    }

    fn bounds(region: &DesignRegion) -> [f64; 4] {
        let xs = region.outer.iter().map(|p| p[0]);
        let ys = region.outer.iter().map(|p| p[1]);
        [
            xs.clone().fold(f64::INFINITY, f64::min),
            ys.clone().fold(f64::INFINITY, f64::min),
            xs.fold(f64::NEG_INFINITY, f64::max),
            ys.fold(f64::NEG_INFINITY, f64::max),
        ]
    }

    fn assert_close(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() < tolerance,
            "{actual} is not within {tolerance} of {expected}"
        );
    }

    #[test]
    fn millimetre_page_keeps_its_size_and_flips_y() {
        // A 100 x 50 mm page; a 20 x 10 mm rectangle 5 mm from the left, 5 mm from the top.
        let out = import(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50">
                 <rect x="5" y="5" width="20" height="10" fill="#ff0000"/></svg>"##,
        );
        assert_close(out.design.width, 100.0, 1e-3);
        assert_close(out.design.height, 50.0, 1e-3);
        assert_eq!(out.design.regions.len(), 1);
        let region = &out.design.regions[0];
        assert_eq!(region.color.as_deref(), Some("#ff0000"));
        let [x0, y0, x1, y1] = bounds(region);
        // Top of the page is Y = 50 in machine-style coordinates.
        for (actual, expected) in [(x0, 5.0), (y0, 35.0), (x1, 25.0), (y1, 45.0)] {
            assert_close(actual, expected, 1e-3);
        }
        assert!(
            ring_area(&region.outer) > 0.0,
            "outer boundary is counter-clockwise"
        );
    }

    #[test]
    fn unitless_sizes_are_pixels_at_96_per_inch() {
        let out = import(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
                 <rect width="96" height="96"/></svg>"#,
        );
        assert_close(out.design.width, 25.4, 1e-3);
        assert_close(area(&out.design.regions[0]), 25.4 * 25.4, 1e-2);
    }

    #[test]
    fn transforms_and_groups_are_applied() {
        let out = import(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
                 <g transform="translate(10 20) scale(2)"><rect width="10" height="10"/></g></svg>"#,
        );
        let [x0, y0, x1, y1] = bounds(&out.design.regions[0]);
        for (actual, expected) in [(x0, 10.0), (y0, 60.0), (x1, 30.0), (y1, 80.0)] {
            assert_close(actual, expected, 1e-3);
        }
    }

    #[test]
    fn circles_are_flattened_within_tolerance() {
        let out = import(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
                 <circle cx="50" cy="50" r="40"/></svg>"#,
        );
        let region = &out.design.regions[0];
        for p in &region.outer {
            // Four cubic arcs approximate a circle to about 0.03 % of its radius.
            assert_close(distance(*p, [50.0, 50.0]), 40.0, 0.02);
        }
        assert_close(area(region), PI * 1600.0, 2.0);
        // Chords must stay within tolerance of the arc: check the midpoints.
        let n = region.outer.len();
        for i in 0..n {
            let (a, b) = (region.outer[i], region.outer[(i + 1) % n]);
            let mid = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
            assert!(40.0 - distance(mid, [50.0, 50.0]) < FLATTEN_TOLERANCE + 0.02);
        }
    }

    #[test]
    fn a_path_with_a_hole_becomes_one_region_with_a_hole() {
        // Outer square and inner square wound the opposite way: a frame.
        let out = import(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40">
                 <path d="M0 0H40V40H0Z M10 10V30H30V10Z"/></svg>"#,
        );
        assert_eq!(out.design.regions.len(), 1);
        let region = &out.design.regions[0];
        assert_eq!(region.holes.len(), 1);
        assert_close(area(region), 1600.0 - 400.0, 1e-2);
        assert!(ring_area(&region.holes[0]) < 0.0, "holes are clockwise");
    }

    #[test]
    fn even_odd_fill_makes_a_hole_whatever_the_winding() {
        let same_winding = r#"<path fill-rule="RULE" d="M0 0H40V40H0Z M10 10H30V30H10Z"/>"#;
        let wrap = |rule: &str| {
            format!(
                r#"<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40">{}</svg>"#,
                same_winding.replace("RULE", rule)
            )
        };
        assert_close(
            area(&import(&wrap("evenodd")).design.regions[0]),
            1200.0,
            1e-2,
        );
        assert_close(
            area(&import(&wrap("nonzero")).design.regions[0]),
            1600.0,
            1e-2,
        );
    }

    #[test]
    fn separate_islands_in_one_path_become_separate_regions() {
        let out = import(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="20mm" viewBox="0 0 50 20">
                 <path d="M0 0H10V10H0Z M30 0H40V10H30Z"/></svg>"#,
        );
        assert_eq!(out.design.regions.len(), 2);
        assert_eq!(
            out.design.regions.iter().map(|r| r.id).collect::<Vec<_>>(),
            [0, 1]
        );
    }

    #[test]
    fn a_self_crossing_path_is_untangled() {
        // A bow tie: two triangles meeting at a point.
        let out = import(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20">
                 <path d="M0 0L20 20L20 0L0 20Z"/></svg>"#,
        );
        let total: f64 = out.design.regions.iter().map(area).sum();
        assert_close(total, 200.0, 1e-2);
        for region in &out.design.regions {
            // Every resulting region is simple enough for the medial axis.
            crate::geom::medial::medial_axis(&Region::with_holes(
                region.outer.clone(),
                region.holes.clone(),
            ))
            .unwrap();
        }
    }

    #[test]
    fn open_filled_paths_are_closed() {
        let out = import(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="20mm" viewBox="0 0 20 20">
                 <path d="M0 0H10V10" fill="black"/></svg>"#,
        );
        assert_close(area(&out.design.regions[0]), 50.0, 1e-2);
    }

    #[test]
    fn reports_what_was_left_out() {
        let out = import(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="50mm" viewBox="0 0 50 50">
                 <path d="M0 0H10V10" fill="none" stroke="black"/>
                 <rect width="0.05" height="0.05"/>
                 <text x="5" y="20">Hello</text>
                 <rect x="20" y="20" width="5" height="5" display="none"/>
                 <rect x="30" y="30" width="10" height="10"/></svg>"#,
        );
        assert_eq!(
            out.design.regions.len(),
            1,
            "only the visible, filled, cuttable rectangle"
        );
        assert_eq!(
            out.report,
            ImportReport {
                open_outlines: 1,
                has_text: true,
                images: 0,
                specks: 1
            }
        );
    }

    #[test]
    fn closed_outlines_without_a_fill_become_shapes() {
        // As a CAD export draws things: stroke only, one closed by a command,
        // one by returning to its start, one left open.
        let out = import(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="60mm" height="20mm" viewBox="0 0 60 20">
                 <path d="M0 0H10V10H0Z" style="fill:none;stroke:#0000ff"/>
                 <path d="M20 0H30V10H20V0" fill="none" stroke="black"/>
                 <path d="M40 0H50V10H40" fill="none" stroke="black"/></svg>"##,
        );
        assert_eq!(out.design.regions.len(), 2);
        assert_eq!(out.design.regions[0].color.as_deref(), Some("#0000ff"));
        for region in &out.design.regions {
            assert_close(area(region), 100.0, 1e-2);
            assert!(ring_area(&region.outer) > 0.0);
        }
        assert_eq!(out.report.open_outlines, 1);
    }

    #[test]
    fn an_outline_inside_another_in_the_same_path_is_a_hole() {
        let out = import(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40">
                 <path d="M0 0H40V40H0Z M10 10H30V30H10Z" fill="none" stroke="black"/></svg>"#,
        );
        assert_eq!(out.design.regions.len(), 1);
        assert_close(area(&out.design.regions[0]), 1200.0, 1e-2);
    }

    #[test]
    fn a_cad_export_drawn_as_outlines_imports_every_shape() {
        // A coaster sketch exported from CAD through DXF: two circles and six
        // rounded shapes, all stroke only, on an 88.26 mm page.
        let out = import(include_str!("../../tests/svg/cad-outlines.svg"));
        assert_eq!(out.design.regions.len(), 8);
        assert_eq!(out.report, ImportReport::default());
        assert_close(out.design.width, 88.264, 1e-2);
        let mut regions: Vec<&DesignRegion> = out.design.regions.iter().collect();
        regions.sort_by(|a, b| area(a).total_cmp(&area(b)));
        let areas: Vec<f64> = regions.iter().map(|r| area(r)).collect();
        // The six inner shapes are the same shape turned in steps of 60 degrees.
        assert!(areas[5] - areas[0] < 0.05, "{areas:?}");
        let wedges: f64 = areas[..6].iter().sum();
        // The rim between the two circles, and the web between the inner
        // circle and the six shapes: the areas between the lines.
        let (rim, web) = if regions[6].holes.len() == 1 {
            (6, 7)
        } else {
            (7, 6)
        };
        assert_eq!(regions[rim].holes.len(), 1);
        assert_eq!(regions[web].holes.len(), 6);
        assert_close(areas[rim], PI * (44.0 * 44.0 - 40.0 * 40.0), 2.0);
        assert_close(areas[web], PI * 40.0 * 40.0 - wedges, 2.0);
        // Together they tile the outer disc without overlap.
        assert_close(areas.iter().sum::<f64>(), PI * 44.0 * 44.0, 2.0);
    }

    #[test]
    fn filled_shapes_are_not_cut_by_shapes_drawn_over_them() {
        let out = import(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40">
                 <rect width="40" height="40"/><rect x="10" y="10" width="10" height="10"/></svg>"#,
        );
        assert_eq!(out.design.regions.len(), 2);
        assert_close(area(&out.design.regions[0]), 1600.0, 1e-2);
    }

    #[test]
    fn rejects_files_that_are_not_svg() {
        assert!(import_svg("not an svg", "x.svg").is_err());
        assert!(import_svg("<html></html>", "x.svg").is_err());
    }
}
