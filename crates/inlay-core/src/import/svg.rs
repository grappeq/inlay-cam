//! SVG import: turns a drawing into filled regions in millimetres.
//!
//! Each filled path becomes one or more regions (one per separate filled
//! area), with overlaps inside the path resolved by its fill rule. A path with
//! an outline but no fill, as CAD exports draw everything, is read as the area
//! its closed outlines enclose, less any outline drawn wholly inside it: the
//! areas between the lines, as the drawing reads. Outlines that cross or touch
//! stay whole. Regions from different paths
//! are kept apart so they can be selected separately.
//!
//! The layers of an Inkscape drawing are kept: its shapes are on the layers
//! they were drawn on, and outlines are joined, and cut out of each other,
//! within a layer only.

use i_overlay::core::fill_rule::FillRule;
use i_overlay::float::simplify::SimplifyShape;
use serde::Serialize;
use std::collections::HashMap;
use usvg::tiny_skia_path::{PathSegment, Point as SkPoint};

use super::join::{join, JOIN_GAP};
use crate::geom::boolean::difference;
use crate::geom::{distance, ring_area, Point, Region, Ring};
use crate::project::{Design, DesignRegion, Layer};

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
    /// Kinds of thing in the file that were not read, by the file's own names.
    pub unsupported: Vec<String>,
    /// DXF: the unit the drawing was in, when it was not millimetres.
    pub unit_note: Option<String>,
    /// SVG: the names of the layers that were hidden in the drawing, and so
    /// were not read.
    pub hidden_layers: Vec<String>,
}

/// The layers of an imported drawing from their names, in the order their
/// first shapes were drawn: a layer's place in `names` is its id. The last
/// drawn is the top one. A drawing on one layer has none. A layer without
/// a name is called by its number, and one whose name is taken gets a number
/// after it.
pub(crate) fn layers_named(names: Vec<String>) -> Vec<Layer> {
    if names.len() < 2 {
        return Vec::new();
    }
    let mut taken: Vec<String> = Vec::new();
    let mut layers: Vec<Layer> = Vec::new();
    for (id, name) in names.into_iter().enumerate() {
        let wanted = if name.trim().is_empty() {
            format!("Layer {}", id + 1)
        } else {
            name.trim().to_string()
        };
        let mut name = wanted.clone();
        let mut n = 2;
        while taken.contains(&name) {
            name = format!("{wanted} {n}");
            n += 1;
        }
        taken.push(name.clone());
        layers.push(Layer {
            id: id as u32,
            name,
            hidden: false,
            locked: false,
            color: None,
        });
    }
    layers.reverse();
    layers
}

/// Leaves out the layers that have no shapes, such as one whose only lines
/// did not close, and numbers the rest from 0 in their order.
pub(crate) fn only_used_layers(regions: &mut [DesignRegion], names: Vec<String>) -> Vec<String> {
    let used: Vec<u32> = (0..names.len() as u32)
        .filter(|id| regions.iter().any(|r| r.layer == *id))
        .collect();
    for region in regions.iter_mut() {
        region.layer = used.iter().position(|l| *l == region.layer).unwrap_or(0) as u32;
    }
    used.iter().map(|l| names[*l as usize].clone()).collect()
}

const SVG: &str = "http://www.w3.org/2000/svg";
const INKSCAPE: &str = "http://www.inkscape.org/namespaces/inkscape";

/// The groups an Inkscape drawing marks as layers, by id, with their names;
/// and the names of those that are hidden, which the reader leaves out.
fn inkscape_layers(text: &str) -> (HashMap<String, String>, Vec<String>) {
    let options = usvg::roxmltree::ParsingOptions {
        allow_dtd: true,
        ..Default::default()
    };
    let Ok(document) = usvg::roxmltree::Document::parse_with_options(text, options) else {
        return (HashMap::new(), Vec::new());
    };
    let mut layers = HashMap::new();
    let mut hidden = Vec::new();
    let groups = document
        .descendants()
        .filter(|node| node.has_tag_name((SVG, "g")))
        .filter(|node| node.attribute((INKSCAPE, "groupmode")) == Some("layer"));
    for node in groups {
        let id = node.attribute("id").unwrap_or_default();
        let name = node.attribute((INKSCAPE, "label")).unwrap_or(id);
        let style: String = node
            .attribute("style")
            .unwrap_or_default()
            .split_whitespace()
            .collect();
        if node.attribute("display") == Some("none") || style.contains("display:none") {
            hidden.push(name.to_string());
        }
        if !id.is_empty() {
            layers.insert(id.to_string(), name.to_string());
        }
    }
    (layers, hidden)
}

/// The areas between outlines that carry no fill: every outline that lies
/// wholly inside another is cut out of it.
pub(crate) fn regions_between_outlines(regions: Vec<DesignRegion>) -> Vec<DesignRegion> {
    let mut importer = Importer {
        height_px: 0.0,
        outlines: vec![true; regions.len()],
        regions,
        open: Vec::new(),
        report: ImportReport::default(),
        layer_groups: HashMap::new(),
        layer_names: Vec::new(),
        layer_ids: HashMap::new(),
        within: None,
    };
    importer.split_nested_outlines();
    importer.regions
}

pub fn import_svg(text: &str, source_name: &str) -> Result<SvgImport, String> {
    let tree = usvg::Tree::from_str(text, &usvg::Options::default())
        .map_err(|e| format!("The file could not be read as an SVG drawing: {e}"))?;

    let height_px = tree.size().height() as f64;
    let (layer_groups, hidden_layers) = inkscape_layers(text);
    let mut importer = Importer {
        height_px,
        regions: Vec::new(),
        outlines: Vec::new(),
        open: Vec::new(),
        report: ImportReport::default(),
        layer_groups,
        layer_names: Vec::new(),
        layer_ids: HashMap::new(),
        within: None,
    };
    // Without font support the parser drops text silently, so look for it in the source.
    importer.report.has_text = text.contains("<text");
    importer.report.hidden_layers = hidden_layers;
    importer.group(tree.root());
    importer.join_open_outlines();
    importer.split_nested_outlines();
    let names = only_used_layers(&mut importer.regions, importer.layer_names);

    Ok(SvgImport {
        design: Design {
            source_name: source_name.to_string(),
            width: tree.size().width() as f64 * MM_PER_PX,
            height: height_px * MM_PER_PX,
            scale: 1.0,
            mirror: false,
            regions: importer.regions,
            layers: layers_named(names),
        },
        report: importer.report,
    })
}

struct Importer {
    height_px: f64,
    regions: Vec<DesignRegion>,
    /// For each region, whether it came from an outline without a fill.
    outlines: Vec<bool>,
    /// Outlines without a fill that do not close on their own. CAD exports
    /// often draw each line and arc of a shape as a path of its own.
    open: Vec<(Ring, u32)>,
    report: ImportReport,
    /// The groups that are layers, by id, with their names.
    layer_groups: HashMap<String, String>,
    /// The names of the layers that have shapes: a layer's place is its id.
    layer_names: Vec<String>,
    /// The id of each such layer, by its group's id; "" for what is on no layer.
    layer_ids: HashMap<String, u32>,
    /// The id of the layer group being read, if any.
    within: Option<String>,
}

impl Importer {
    fn group(&mut self, group: &usvg::Group) {
        for node in group.children() {
            match node {
                usvg::Node::Group(inner) => {
                    if self.layer_groups.contains_key(inner.id()) {
                        let outside = self.within.replace(inner.id().to_string());
                        self.group(inner);
                        self.within = outside;
                    } else {
                        self.group(inner);
                    }
                }
                usvg::Node::Path(path) => self.path(path),
                usvg::Node::Image(_) => self.report.images += 1,
                usvg::Node::Text(_) => self.report.has_text = true,
            }
        }
    }

    /// The id of the layer being read. It is counted among the drawing's
    /// layers from its first shape on.
    fn layer(&mut self) -> u32 {
        let key = self.within.clone().unwrap_or_default();
        if let Some(&id) = self.layer_ids.get(&key) {
            return id;
        }
        let id = self.layer_names.len() as u32;
        let name = self.layer_groups.get(&key).cloned();
        self.layer_names
            .push(name.unwrap_or_else(|| "No layer".into()));
        self.layer_ids.insert(key, id);
        id
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
            if !open.is_empty() {
                let layer = self.layer();
                self.open
                    .extend(open.into_iter().map(|(ring, _)| (ring, layer)));
            }
            let rings = closed.into_iter().map(|(ring, _)| ring);
            (rings.collect(), color(stroke.paint()), FillRule::EvenOdd)
        } else {
            return;
        };
        if rings.is_empty() {
            return;
        }
        let layer = self.layer();
        self.add_shapes(rings, color, rule, outline, layer);
    }

    /// Joins the outlines that do not close on their own end to end. Those
    /// that close that way become shapes; the rest are reported.
    fn join_open_outlines(&mut self) {
        let open = std::mem::take(&mut self.open);
        let mut layers: Vec<u32> = open.iter().map(|(_, layer)| *layer).collect();
        layers.sort_unstable();
        layers.dedup();
        for layer in layers {
            let pieces = open
                .iter()
                .filter(|(_, on)| *on == layer)
                .map(|(ring, _)| ring.clone())
                .collect();
            let joined = join(pieces, JOIN_GAP);
            self.report.open_outlines += joined.open;
            for ring in joined.closed {
                self.add_shapes(vec![ring], None, FillRule::EvenOdd, true, layer);
            }
        }
    }

    fn add_shapes(
        &mut self,
        rings: Vec<Ring>,
        color: Option<String>,
        rule: FillRule,
        outline: bool,
        layer: u32,
    ) {
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
                layer,
                outer,
                holes: shape,
            });
            self.outlines.push(outline);
        }
    }

    /// Outlines carry no fill to say which side of a line belongs to which
    /// shape, so the shapes are the areas between the lines: an outline that
    /// lies wholly inside another is cut out of it. A circle around six
    /// shapes becomes the web between them, not a disc underneath. An outline
    /// that crosses or touches another is not inside it, and both stay whole:
    /// shapes may lie on top of each other. So do outlines on different
    /// layers, whatever lies inside what.
    fn split_nested_outlines(&mut self) {
        if self.outlines.iter().filter(|&&o| o).count() < 2 {
            return;
        }
        let on: Vec<u32> = self.regions.iter().map(|r| r.layer).collect();
        let on = &on;
        let shapes: Vec<Option<Outline>> = self
            .regions
            .iter()
            .zip(&self.outlines)
            .map(|(region, &outline)| {
                outline.then(|| {
                    let shape = Region::with_holes(region.outer.clone(), region.holes.clone());
                    Outline {
                        area: shape.area(),
                        bounds: ring_bounds(&region.outer),
                        shape,
                    }
                })
            })
            .collect();
        let mut out: Vec<DesignRegion> = Vec::with_capacity(self.regions.len());
        for (i, region) in std::mem::take(&mut self.regions).into_iter().enumerate() {
            let Some(around) = &shapes[i] else {
                out.push(region);
                continue;
            };
            let others = || {
                shapes
                    .iter()
                    .enumerate()
                    .filter_map(move |(j, other)| Some((j, other.as_ref()?)))
                    .filter(move |&(j, _)| j != i && on[j] == on[i])
            };
            // The same outline drawn twice is one shape: the later one.
            if others().any(|(j, other)| j > i && around.same_as(other)) {
                continue;
            }
            let inside: Vec<Region> = others()
                .filter(|(_, other)| other.lies_inside(around))
                .map(|(_, other)| other.shape.clone())
                .collect();
            if inside.is_empty() {
                out.push(region);
                continue;
            }
            for piece in difference(&around.shape, &inside) {
                if piece.area() >= MIN_REGION_AREA {
                    out.push(DesignRegion {
                        id: 0,
                        color: region.color.clone(),
                        layer: region.layer,
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

/// How far inside another outline's area an outline has to stay, mm, to
/// count as lying inside it. The app's drawing tools use the same distance.
const INSIDE: f64 = 0.01;

/// A shape read from an outline without a fill.
struct Outline {
    shape: Region,
    area: f64,
    /// Left, bottom, right, top.
    bounds: [f64; 4],
}

impl Outline {
    /// True when the whole of this outline lies in `around`'s area, clear of
    /// its edges.
    fn lies_inside(&self, around: &Outline) -> bool {
        let (a, b) = (&self.bounds, &around.bounds);
        if self.area >= around.area || a[0] < b[0] || a[1] < b[1] || a[2] > b[2] || a[3] > b[3] {
            return false;
        }
        let clear = |p: &Point| {
            around.shape.contains(*p) && around.shape.distance_to_boundary(*p) >= INSIDE
        };
        // The corners first; then the lines between them, which may cross a
        // notch that no corner lies in.
        self.shape.outer.iter().all(clear)
            && difference(&self.shape, std::slice::from_ref(&around.shape))
                .iter()
                .all(|piece| piece.area() < MIN_REGION_AREA)
    }

    fn same_as(&self, other: &Outline) -> bool {
        let near = |a: &Outline, b: &Outline| {
            a.shape
                .rings()
                .flatten()
                .all(|p| b.shape.distance_to_boundary(*p) < CLOSED_GAP)
        };
        self.bounds
            .iter()
            .zip(&other.bounds)
            .all(|(a, b)| (a - b).abs() < CLOSED_GAP)
            && near(self, other)
            && near(other, self)
    }
}

fn ring_bounds(ring: &[Point]) -> [f64; 4] {
    let mut b = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for p in ring {
        b = [
            b[0].min(p[0]),
            b[1].min(p[1]),
            b[2].max(p[0]),
            b[3].max(p[1]),
        ];
    }
    b
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

    /// A square on one Inkscape layer, and on another a circle inside it and a small square beside it.
    const LAYERED: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="100mm" height="100mm" viewBox="0 0 100 100">
        <g inkscape:groupmode="layer" id="layer1" inkscape:label="Outline" fill="none" stroke="black">
            <rect x="10" y="10" width="60" height="60"/>
        </g>
        <g inkscape:groupmode="layer" id="layer2" inkscape:label="Leaves" fill="none" stroke="black">
            <circle cx="40" cy="40" r="10"/>
            <rect x="80" y="80" width="10" height="10"/>
        </g></svg>"#;

    #[test]
    fn inkscape_layers_are_kept_and_outlines_nest_within_one_only() {
        let out = import(LAYERED);
        // The last drawn layer is the top one.
        let names: Vec<&str> = out.design.layers.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["Leaves", "Outline"]);
        assert_eq!(out.design.regions.len(), 3);
        let outline = out.design.layers[1].id;
        let square = out
            .design
            .regions
            .iter()
            .find(|r| r.layer == outline)
            .unwrap();
        // The circle is on another layer: it cuts no hole in the square.
        assert!(square.holes.is_empty());
        assert_close(area(square), 3600.0, 1e-2);
        assert_eq!(
            out.design
                .regions
                .iter()
                .filter(|r| r.layer != outline)
                .count(),
            2
        );
    }

    #[test]
    fn a_layer_without_shapes_is_left_out_and_names_are_told_apart() {
        // The first layer holds only a line that does not close: the drawing is on one layer.
        let open = LAYERED.replace(
            r#"<rect x="10" y="10" width="60" height="60"/>"#,
            r#"<path d="M10 10 L50 10 L50 50"/>"#,
        );
        let out = import(&open);
        assert_eq!(out.report.open_outlines, 1);
        assert!(out.design.layers.is_empty());
        assert_eq!(out.design.regions.len(), 2);
        assert!(out.design.regions.iter().all(|r| r.layer == 0));

        let twice = LAYERED.replace("Outline", "Leaves");
        let names: Vec<String> = import(&twice)
            .design
            .layers
            .into_iter()
            .map(|l| l.name)
            .collect();
        assert_eq!(names, ["Leaves 2", "Leaves"]);
    }

    #[test]
    fn a_hidden_layer_is_left_out_and_said_so() {
        let hidden = LAYERED.replace(
            r#"inkscape:label="Leaves""#,
            r#"inkscape:label="Leaves" style="display: none""#,
        );
        let out = import(&hidden);
        assert_eq!(out.report.hidden_layers, ["Leaves"]);
        assert_eq!(out.design.regions.len(), 1);
        assert!(out.design.layers.is_empty());
        assert!(import(LAYERED).report.hidden_layers.is_empty());
    }

    #[test]
    fn a_drawing_on_one_layer_has_no_layers() {
        let one = LAYERED.replace(
            r#"</g>
        <g inkscape:groupmode="layer" id="layer2" inkscape:label="Leaves" fill="none" stroke="black">"#,
            "",
        );
        let out = import(&one);
        assert!(out.design.layers.is_empty());
        assert!(out.design.regions.iter().all(|r| r.layer == 0));
        // On one layer the circle is cut out of the square.
        assert!(out.design.regions.iter().any(|r| r.holes.len() == 1));
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
                specks: 1,
                ..ImportReport::default()
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
    fn outlines_that_touch_or_cross_stay_whole() {
        // A blank with a rounded square on it, and a circle that touches the
        // square's four sides from inside: reference outlines for two parts.
        let out = import(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="108mm" height="108mm" viewBox="0 0 108 108">
                 <g fill="none" stroke="black">
                 <rect width="108" height="108"/>
                 <circle cx="5" cy="14.5" r="2.05"/>
                 <circle cx="49.25" cy="58.75" r="44"/>
                 <rect x="5.25" y="14.75" width="88" height="88" rx="7.25"/>
                 <rect x="80" y="2" width="20" height="20"/></g></svg>"#,
        );
        let corners = 7.25 * 7.25 * (4.0 - PI);
        let square = 88.0 * 88.0 - corners;
        let mut areas: Vec<f64> = out.design.regions.iter().map(area).collect();
        areas.sort_by(f64::total_cmp);
        assert_eq!(areas.len(), 5, "{areas:?}");
        assert_close(areas[0], PI * 2.05 * 2.05, 0.1);
        // The small square crosses the rounded one's corner: both whole.
        assert_close(areas[1], 400.0, 1e-2);
        assert_close(areas[3], PI * 44.0 * 44.0, 2.0);
        assert_close(areas[4], square, 0.5);
        // The blank loses what lies wholly inside it: the bore, and the two
        // squares with the circle as one hole.
        let blank = out.design.regions.iter().find(|r| r.outer.len() == 4);
        assert_eq!(blank.unwrap().holes.len(), 2);
        let overlap = 13.25 * 7.25 - corners / 4.0;
        let cut = PI * 2.05 * 2.05 + square + 400.0 - overlap;
        assert_close(areas[2], 108.0 * 108.0 - cut, 2.0);
    }

    #[test]
    fn the_same_outline_drawn_twice_is_one_shape() {
        let out = import(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40">
                 <g fill="none" stroke="black"><rect x="5" y="5" width="20" height="20"/>
                 <path d="M25 5V25H5V5Z"/></g></svg>"#,
        );
        assert_eq!(out.design.regions.len(), 1);
        assert_close(area(&out.design.regions[0]), 400.0, 1e-2);
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
