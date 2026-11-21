//! DXF import: turns a CAD drawing into regions in millimetres.
//!
//! A DXF file has no filled shapes, only lines. Lines, arcs and curves that
//! meet end to end are joined into closed outlines, and the shapes are the
//! areas between those outlines, exactly as for an SVG drawing made of
//! outlines. Both the text (ASCII) and the binary form are read
//! (`dxf_binary.rs`), and blocks placed with INSERT are drawn where they
//! are placed.
//!
//! The drawing's layers are kept: what is drawn on one layer is joined, and
//! cut out of each other, among itself only.

use std::f64::consts::{PI, TAU};

use i_overlay::core::fill_rule::FillRule;
use i_overlay::float::simplify::SimplifyShape;

use super::dxf_binary;
use super::join::{join, joinable, thin, JOIN_GAP};
use super::svg::{
    layers_named, only_used_layers, regions_between_outlines, ImportReport, SvgImport,
    FLATTEN_TOLERANCE,
};
use crate::geom::{distance, ring_area, Point, Ring};
use crate::project::{Design, DesignRegion};

/// Board left around the drawing on every side, mm: a DXF file has no page.
pub const PAGE_MARGIN: f64 = 5.0;

/// Areas smaller than this are specks, not shapes. mm².
const MIN_REGION_AREA: f64 = 0.01;

/// One thing drawn: a run of points, and whether it closes on itself.
struct Curve {
    points: Vec<Point>,
    closed: bool,
}

/// Group codes and values of one entity, in file order.
type Groups<'a> = [(i32, &'a str)];

/// An old-style POLYLINE being read: its vertices with their bulges, whether it closes, and its own groups.
type Heavy<'a> = (Vec<(Point, f64)>, bool, &'a Groups<'a>);

fn number(groups: &Groups, code: i32) -> Option<f64> {
    groups
        .iter()
        .find(|(c, _)| *c == code)
        .and_then(|(_, v)| v.parse().ok())
}

thread_local! {
    /// How far a flattened curve may stray, in the drawing's own units:
    /// `FLATTEN_TOLERANCE` mm, whatever the unit. Set for each file read.
    static TOLERANCE: std::cell::Cell<f64> = const { std::cell::Cell::new(FLATTEN_TOLERANCE) };
}

fn tolerance() -> f64 {
    TOLERANCE.with(std::cell::Cell::get)
}

fn point(groups: &Groups, x: i32, y: i32) -> Option<Point> {
    Some([number(groups, x)?, number(groups, y)?])
}

/// Points along a circular arc from angle `from` through `sweep` radians
/// (positive is counter-clockwise), the start left out and the end included.
fn arc_points(centre: Point, radius: f64, from: f64, sweep: f64, out: &mut Vec<Point>) {
    let tolerance = tolerance();
    let step = if radius > tolerance {
        2.0 * (1.0 - tolerance / radius).acos()
    } else {
        PI / 2.0
    };
    let n = (sweep.abs() / step).ceil().max(1.0) as usize;
    for i in 1..=n {
        let a = from + sweep * i as f64 / n as f64;
        out.push([centre[0] + radius * a.cos(), centre[1] + radius * a.sin()]);
    }
}

/// Points from `a` to `b` along the arc a polyline's bulge describes: the
/// tangent of a quarter of the arc's angle, positive for counter-clockwise.
fn bulge_points(a: Point, b: Point, bulge: f64, out: &mut Vec<Point>) {
    let chord = distance(a, b);
    if bulge.abs() < 1e-9 || chord < 1e-12 {
        out.push(b);
        return;
    }
    let sweep = 4.0 * bulge.atan();
    let radius = chord / (2.0 * (sweep / 2.0).sin().abs());
    // The centre is to the left of the chord for a counter-clockwise arc
    // shorter than half a turn.
    let to_centre = (radius * radius - chord * chord / 4.0).max(0.0).sqrt()
        * if (bulge.abs() < 1.0) == (bulge > 0.0) {
            1.0
        } else {
            -1.0
        };
    let mid = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
    let normal = [-(b[1] - a[1]) / chord, (b[0] - a[0]) / chord];
    let centre = [
        mid[0] + normal[0] * to_centre,
        mid[1] + normal[1] * to_centre,
    ];
    let from = (a[1] - centre[1]).atan2(a[0] - centre[0]);
    arc_points(centre, radius, from, sweep, out);
    // End exactly on the vertex, whatever the rounding.
    if let Some(last) = out.last_mut() {
        *last = b;
    }
}

/// A run of vertices with bulges, as LWPOLYLINE and POLYLINE give them.
fn polyline(vertices: &[(Point, f64)], closed: bool) -> Option<Curve> {
    let first = vertices.first()?;
    let mut points = vec![first.0];
    for pair in vertices.windows(2) {
        bulge_points(pair[0].0, pair[1].0, pair[0].1, &mut points);
    }
    if closed && vertices.len() > 1 {
        let last = vertices[vertices.len() - 1];
        bulge_points(last.0, first.0, last.1, &mut points);
    }
    Some(Curve { points, closed })
}

/// A point on a B-spline (rational when `weights` are given) by de Boor's
/// algorithm. `span` is the knot span that contains `t`.
fn de_boor(
    degree: usize,
    knots: &[f64],
    control: &[Point],
    weights: &[f64],
    span: usize,
    t: f64,
) -> Point {
    // Homogeneous points: x w, y w, w.
    let mut d: Vec<[f64; 3]> = (0..=degree)
        .map(|j| {
            let i = span - degree + j;
            let w = weights.get(i).copied().unwrap_or(1.0);
            [control[i][0] * w, control[i][1] * w, w]
        })
        .collect();
    for r in 1..=degree {
        for j in (r..=degree).rev() {
            let i = span - degree + j;
            let denominator = knots[i + degree - r + 1] - knots[i];
            let alpha = if denominator.abs() < 1e-12 {
                0.0
            } else {
                (t - knots[i]) / denominator
            };
            for k in 0..3 {
                d[j][k] = (1.0 - alpha) * d[j - 1][k] + alpha * d[j][k];
            }
        }
    }
    let w = if d[degree][2].abs() < 1e-12 {
        1.0
    } else {
        d[degree][2]
    };
    [d[degree][0] / w, d[degree][1] / w]
}

/// A SPLINE entity as a run of points. Falls back to its fit points, or to
/// its control points, when the spline data is not usable.
fn spline(groups: &Groups) -> Option<Curve> {
    let degree = number(groups, 71).unwrap_or(3.0) as usize;
    let flags = number(groups, 70).unwrap_or(0.0) as i32;
    let knots: Vec<f64> = groups
        .iter()
        .filter(|(c, _)| *c == 40)
        .filter_map(|(_, v)| v.parse().ok())
        .collect();
    let weights: Vec<f64> = groups
        .iter()
        .filter(|(c, _)| *c == 41)
        .filter_map(|(_, v)| v.parse().ok())
        .collect();
    let pairs = |x: i32, y: i32| -> Vec<Point> {
        let xs = groups.iter().filter(|(c, _)| *c == x);
        let ys = groups.iter().filter(|(c, _)| *c == y);
        xs.zip(ys)
            .filter_map(|((_, a), (_, b))| Some([a.parse().ok()?, b.parse().ok()?]))
            .collect()
    };
    let control = pairs(10, 20);
    let fit = pairs(11, 21);
    let n = control.len();

    let usable = degree >= 1 && n > degree && knots.len() == n + degree + 1;
    let mut points = if usable {
        let length: f64 = control.windows(2).map(|w| distance(w[0], w[1])).sum();
        let spans = (degree..n).filter(|&i| knots[i + 1] > knots[i]).count();
        // Close enough together that thinning to the tolerance loses nothing.
        let per_span = ((length / spans.max(1) as f64 / 0.05).ceil() as usize).clamp(8, 2000);
        let mut points = vec![de_boor(
            degree,
            &knots,
            &control,
            &weights,
            degree,
            knots[degree],
        )];
        for span in degree..n {
            let (t0, t1) = (knots[span], knots[span + 1]);
            if t1 <= t0 {
                continue;
            }
            for k in 1..=per_span {
                let t = t0 + (t1 - t0) * k as f64 / per_span as f64;
                points.push(de_boor(degree, &knots, &control, &weights, span, t));
            }
        }
        thin(&points, tolerance() / 4.0)
    } else if fit.len() >= 2 {
        fit
    } else if n >= 2 {
        control
    } else {
        return None;
    };
    let closed = flags & 1 != 0
        || (points.len() > 3 && distance(points[0], points[points.len() - 1]) < 1e-9);
    if closed && distance(points[0], points[points.len() - 1]) < 1e-9 {
        points.pop();
    }
    Some(Curve { points, closed })
}

/// Reads one entity. `None` is an entity that draws nothing to cut.
fn entity(kind: &str, groups: &Groups, report: &mut ImportReport) -> Option<Curve> {
    // Arcs, circles and light polylines lie in their own plane, which is
    // mirrored when the drawing's Z axis points away from the viewer.
    let mirrored = number(groups, 230).is_some_and(|z| z < 0.0);
    let mut curve = match kind {
        "LINE" => Curve {
            points: vec![point(groups, 10, 20)?, point(groups, 11, 21)?],
            closed: false,
        },
        "CIRCLE" => {
            let centre = point(groups, 10, 20)?;
            let radius = number(groups, 40)?;
            let mut points = Vec::new();
            arc_points(centre, radius, 0.0, TAU, &mut points);
            points.pop();
            points.insert(0, [centre[0] + radius, centre[1]]);
            Curve {
                points,
                closed: true,
            }
        }
        "ARC" => {
            let centre = point(groups, 10, 20)?;
            let radius = number(groups, 40)?;
            let from = number(groups, 50)?.to_radians();
            let to = number(groups, 51)?.to_radians();
            let sweep = (to - from).rem_euclid(TAU);
            let sweep = if sweep < 1e-9 { TAU } else { sweep };
            let mut points = vec![[
                centre[0] + radius * from.cos(),
                centre[1] + radius * from.sin(),
            ]];
            arc_points(centre, radius, from, sweep, &mut points);
            Curve {
                points,
                closed: false,
            }
        }
        "ELLIPSE" => {
            let centre = point(groups, 10, 20)?;
            let major = point(groups, 11, 21)?;
            let ratio = number(groups, 40)?;
            let from = number(groups, 41).unwrap_or(0.0);
            let to = number(groups, 42).unwrap_or(TAU);
            let sweep = (to - from).rem_euclid(TAU);
            let full = sweep < 1e-9 || (TAU - sweep) < 1e-9;
            let sweep = if full { TAU } else { sweep };
            let a = major[0].hypot(major[1]);
            let minor = [-major[1] * ratio, major[0] * ratio];
            // As fine as a circle of the larger radius needs.
            let tolerance = tolerance();
            let step = if a > tolerance {
                2.0 * (1.0 - tolerance / a).acos()
            } else {
                PI / 2.0
            };
            let n = (sweep / step).ceil().max(4.0) as usize;
            let mut points: Vec<Point> = (0..=n)
                .map(|k| {
                    let t = from + sweep * k as f64 / n as f64;
                    [
                        centre[0] + major[0] * t.cos() + minor[0] * t.sin(),
                        centre[1] + major[1] * t.cos() + minor[1] * t.sin(),
                    ]
                })
                .collect();
            if full {
                points.pop();
            }
            // An ELLIPSE is given in the drawing's own coordinates already.
            return Some(Curve {
                points,
                closed: full,
            });
        }
        "LWPOLYLINE" => {
            let mut vertices: Vec<(Point, f64)> = Vec::new();
            let mut x: Option<f64> = None;
            for (code, value) in groups {
                match code {
                    10 => x = value.parse().ok(),
                    20 => {
                        if let (Some(x), Ok(y)) = (x.take(), value.parse()) {
                            vertices.push(([x, y], 0.0));
                        }
                    }
                    42 => {
                        if let (Some(last), Ok(bulge)) = (vertices.last_mut(), value.parse()) {
                            last.1 = bulge;
                        }
                    }
                    _ => {}
                }
            }
            let closed = number(groups, 70).is_some_and(|f| f as i32 & 1 != 0);
            polyline(&vertices, closed)?
        }
        "SPLINE" => return spline(groups),
        "TEXT" | "MTEXT" | "ATTRIB" | "ATTDEF" => {
            report.has_text = true;
            return None;
        }
        "IMAGE" => {
            report.images += 1;
            return None;
        }
        // Nothing to cut, and nothing the user would miss.
        "POINT" | "VIEWPORT" | "SEQEND" | "VERTEX" => return None,
        other => {
            if !report.unsupported.iter().any(|k| k == other) {
                report.unsupported.push(other.to_string());
            }
            return None;
        }
    };
    if mirrored {
        for p in &mut curve.points {
            p[0] = -p[0];
        }
    }
    Some(curve)
}

/// Millimetres per drawing unit for a `$INSUNITS` value, and the unit's name.
fn units(code: Option<i32>) -> (f64, Option<String>) {
    match code {
        Some(1) => (25.4, Some("inches".into())),
        Some(2) => (304.8, Some("feet".into())),
        Some(4) => (1.0, None),
        Some(5) => (10.0, Some("centimetres".into())),
        Some(6) => (1000.0, Some("metres".into())),
        _ => (1.0, Some("no unit, taken as millimetres".into())),
    }
}

/// Reads a DXF file in either form: binary, or text.
pub fn import_dxf_bytes(bytes: &[u8], source_name: &str, gap: f64) -> Result<SvgImport, String> {
    if bytes.starts_with(dxf_binary::SENTINEL) {
        let owned = dxf_binary::groups(bytes)?;
        let groups: Vec<(i32, &str)> = owned.iter().map(|(c, v)| (*c, v.as_str())).collect();
        return from_groups(&groups, source_name, gap);
    }
    import_dxf_joined(&String::from_utf8_lossy(bytes), source_name, gap)
}

pub fn import_dxf(text: &str, source_name: &str) -> Result<SvgImport, String> {
    import_dxf_joined(text, source_name, JOIN_GAP)
}

/// Reads a text DXF, with the ends of lines joined across gaps up to `gap`, mm.
pub fn import_dxf_joined(text: &str, source_name: &str, gap: f64) -> Result<SvgImport, String> {
    if text.starts_with("AutoCAD Binary DXF") {
        return Err(
            "This is a binary DXF file, which has to be read as bytes, not as text.".into(),
        );
    }
    // The file is pairs of lines: a group code, then its value.
    let mut lines = text.lines();
    let mut groups: Vec<(i32, &str)> = Vec::new();
    while let (Some(code), Some(value)) = (lines.next(), lines.next()) {
        let Ok(code) = code.trim().parse::<i32>() else {
            return Err("The file could not be read as a DXF drawing.".into());
        };
        groups.push((code, value.trim()));
    }
    from_groups(&groups, source_name, gap)
}

/// What a run of entities draws: curves, each on the layer it names, and
/// blocks placed by INSERT.
enum Item<'a> {
    Curve(Curve, &'a str),
    Insert(Insert<'a>),
}

/// A block placed: where, how large, turned how far, and in how many copies.
struct Insert<'a> {
    block: &'a str,
    layer: &'a str,
    at: Point,
    scale: [f64; 2],
    /// Radians.
    rotation: f64,
    mirrored: bool,
    columns: u32,
    rows: u32,
    spacing: [f64; 2],
}

/// An affine map of the plane: `[a, b, c, d, e, f]` takes (x, y) to
/// (a x + b y + e, c x + d y + f).
type Affine = [f64; 6];
const IDENTITY: Affine = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `outer` after `inner`.
fn compose(outer: &Affine, inner: &Affine) -> Affine {
    let [a, b, c, d, e, f] = *outer;
    let [p, q, r, s, t, u] = *inner;
    [
        a * p + b * r,
        a * q + b * s,
        c * p + d * r,
        c * q + d * s,
        a * t + b * u + e,
        c * t + d * u + f,
    ]
}

fn apply(m: &Affine, p: Point) -> Point {
    [
        m[0] * p[0] + m[1] * p[1] + m[4],
        m[2] * p[0] + m[3] * p[1] + m[5],
    ]
}

/// A block defined in the BLOCKS section: its base point and what it draws.
struct Block<'a> {
    base: Point,
    items: Vec<Item<'a>>,
}

/// Blocks placed inside blocks, at most this deep: deeper is taken to be a
/// block that places itself.
const MOST_NESTED: usize = 16;

/// Copies of blocks placed in all, and curves drawn in all, at most: past
/// them a block that places itself several times, or a vast array, would
/// take the page's memory and time.
const MOST_COPIES: usize = 10_000;
const MOST_CURVES: usize = 100_000;

/// What `place` has placed so far, against `MOST_COPIES` and `MOST_CURVES`.
#[derive(Default)]
struct Placed {
    copies: usize,
}

type Blocks<'a> = std::collections::HashMap<String, Block<'a>>;

/// Reads the entities of a section or a block, `groups` starting at the
/// first entity's group 0.
fn read_items<'a>(groups: &'a Groups<'a>, report: &mut ImportReport) -> Vec<Item<'a>> {
    let layer = |body: &'a Groups<'a>| -> &'a str {
        // An entity that names no layer is on layer "0", as in a CAD program.
        body.iter().find(|(c, _)| *c == 8).map_or("0", |(_, v)| *v)
    };
    let mut items = Vec::new();
    // An old-style POLYLINE is spread over entities: its vertices follow it.
    let mut heavy: Option<Heavy> = None;
    let mut i = 0;
    while i < groups.len() {
        if groups[i].0 != 0 {
            i += 1;
            continue;
        }
        let value = groups[i].1;
        // One entity: everything up to the next group 0.
        let end = groups[i + 1..]
            .iter()
            .position(|g| g.0 == 0)
            .map_or(groups.len(), |n| i + 1 + n);
        let body = &groups[i + 1..end];
        match value {
            "POLYLINE" => {
                let flags = number(body, 70).unwrap_or(0.0) as i32;
                // Meshes and 3D polylines are not outlines.
                if flags & (8 | 16 | 64) != 0 {
                    report.unsupported.push("POLYLINE (3D)".into());
                } else {
                    heavy = Some((Vec::new(), flags & 1 != 0, body));
                }
            }
            "VERTEX" => {
                if let (Some((vertices, _, _)), Some(p)) = (&mut heavy, point(body, 10, 20)) {
                    vertices.push((p, number(body, 42).unwrap_or(0.0)));
                }
            }
            "SEQEND" => {
                if let Some((vertices, closed, of)) = heavy.take() {
                    if let Some(curve) = polyline(&vertices, closed) {
                        items.push(Item::Curve(curve, layer(of)));
                    }
                }
            }
            "INSERT" => {
                let text = |code: i32| body.iter().find(|(c, _)| *c == code).map(|(_, v)| *v);
                if let Some(block) = text(2) {
                    let count = |code: i32| {
                        (number(body, code).unwrap_or(1.0) as i64).clamp(1, MOST_COPIES as i64)
                            as u32
                    };
                    items.push(Item::Insert(Insert {
                        block,
                        layer: layer(body),
                        at: point(body, 10, 20).unwrap_or([0.0, 0.0]),
                        scale: [
                            number(body, 41).unwrap_or(1.0),
                            number(body, 42).unwrap_or(1.0),
                        ],
                        rotation: number(body, 50).unwrap_or(0.0).to_radians(),
                        mirrored: number(body, 230).is_some_and(|z| z < 0.0),
                        columns: count(70),
                        rows: count(71),
                        spacing: [
                            number(body, 44).unwrap_or(0.0),
                            number(body, 45).unwrap_or(0.0),
                        ],
                    }));
                }
            }
            kind => {
                if let Some(curve) = entity(kind, body, report) {
                    items.push(Item::Curve(curve, layer(body)));
                }
            }
        }
        i = end;
    }
    items
}

/// The blocks of the BLOCKS section, by name.
fn read_blocks<'a>(groups: &'a Groups<'a>, report: &mut ImportReport) -> Blocks<'a> {
    // Block names are told apart whatever the case of their letters, as in AutoCAD.
    let mut blocks = Blocks::new();
    let mut i = 0;
    while i < groups.len() {
        if groups[i] != (0, "BLOCK") {
            i += 1;
            continue;
        }
        let head_end = groups[i + 1..]
            .iter()
            .position(|g| g.0 == 0)
            .map_or(groups.len(), |n| i + 1 + n);
        let head = &groups[i + 1..head_end];
        let end = groups[head_end..]
            .iter()
            .position(|g| *g == (0, "ENDBLK"))
            .map_or(groups.len(), |n| head_end + n);
        if let Some((_, name)) = head.iter().find(|(c, _)| *c == 2) {
            blocks.insert(
                name.to_uppercase(),
                Block {
                    base: point(head, 10, 20).unwrap_or([0.0, 0.0]),
                    items: read_items(&groups[head_end..end], report),
                },
            );
        }
        i = end + 1;
    }
    blocks
}

/// Every curve that `items` draw, with blocks placed where their INSERTs
/// say, in the drawing's coordinates, each with its layer's name. What a
/// block draws on layer "0" is on the layer of the INSERT that places it.
fn place<'a>(
    items: &'a [Item<'a>],
    blocks: &'a Blocks<'a>,
    map: &Affine,
    layer_0: &'a str,
    depth: usize,
    placed: &mut Placed,
    report: &mut ImportReport,
    out: &mut Vec<(Curve, &'a str)>,
) {
    let mut note = |report: &mut ImportReport, note: String| {
        if !report.unsupported.contains(&note) {
            report.unsupported.push(note);
        }
    };
    for item in items {
        if out.len() >= MOST_CURVES {
            note(report, format!("all past the first {MOST_CURVES} curves"));
            return;
        }
        match item {
            Item::Curve(curve, layer) => out.push((
                Curve {
                    points: curve.points.iter().map(|p| apply(map, *p)).collect(),
                    closed: curve.closed,
                },
                if *layer == "0" { layer_0 } else { layer },
            )),
            Item::Insert(insert) => {
                let Some(block) = blocks.get(&insert.block.to_uppercase()) else {
                    note(
                        report,
                        format!("INSERT of a block not in the file ({})", insert.block),
                    );
                    continue;
                };
                if depth >= MOST_NESTED {
                    note(report, "INSERT nested too deep".to_string());
                    continue;
                }
                let layer = if insert.layer == "0" {
                    layer_0
                } else {
                    insert.layer
                };
                let (sin, cos) = insert.rotation.sin_cos();
                let mirror = if insert.mirrored { -1.0 } else { 1.0 };
                for row in 0..insert.rows {
                    for column in 0..insert.columns {
                        if placed.copies >= MOST_COPIES {
                            note(
                                report,
                                format!("copies of blocks past the first {MOST_COPIES}"),
                            );
                            return;
                        }
                        placed.copies += 1;
                        // Copies of an array step along the block's own turned axes.
                        let step = [
                            column as f64 * insert.spacing[0],
                            row as f64 * insert.spacing[1],
                        ];
                        let local: Affine = compose(
                            &[mirror, 0.0, 0.0, 1.0, 0.0, 0.0],
                            &compose(
                                &[cos, -sin, sin, cos, insert.at[0], insert.at[1]],
                                &[
                                    insert.scale[0],
                                    0.0,
                                    0.0,
                                    insert.scale[1],
                                    step[0] - insert.scale[0] * block.base[0],
                                    step[1] - insert.scale[1] * block.base[1],
                                ],
                            ),
                        );
                        place(
                            &block.items,
                            blocks,
                            &compose(map, &local),
                            layer,
                            depth + 1,
                            placed,
                            report,
                            out,
                        );
                    }
                }
            }
        }
    }
}

/// The groups of one section: from its first entity to its ENDSEC.
fn section<'a>(groups: &'a Groups<'a>, name: &str) -> &'a Groups<'a> {
    let Some(start) = groups
        .windows(2)
        .position(|w| w[0] == (0, "SECTION") && w[1] == (2, name))
    else {
        return &[];
    };
    let end = groups[start..]
        .iter()
        .position(|g| *g == (0, "ENDSEC"))
        .map_or(groups.len(), |n| start + n);
    &groups[start + 2..end]
}

fn from_groups(groups: &Groups, source_name: &str, gap: f64) -> Result<SvgImport, String> {
    let gap = gap.max(JOIN_GAP);
    if !groups.contains(&(0, "SECTION")) {
        return Err("The file could not be read as a DXF drawing.".into());
    }

    let mut report = ImportReport::default();
    let header = section(groups, "HEADER");
    let unit_code: Option<i32> = header
        .iter()
        .position(|g| *g == (9, "$INSUNITS"))
        .and_then(|i| header.get(i + 1))
        .and_then(|g| g.1.parse().ok());
    let (scale, unit_note) = units(unit_code);
    TOLERANCE.with(|t| t.set(FLATTEN_TOLERANCE / scale));
    let blocks = read_blocks(section(groups, "BLOCKS"), &mut report);
    let items = read_items(section(groups, "ENTITIES"), &mut report);
    TOLERANCE.with(|t| t.set(FLATTEN_TOLERANCE));
    let mut placed: Vec<(Curve, &str)> = Vec::new();
    place(
        &items,
        &blocks,
        &IDENTITY,
        "0",
        0,
        &mut Placed::default(),
        &mut report,
        &mut placed,
    );

    // Each with the id of the layer it is on: the layer's place in `names`.
    let mut names: Vec<String> = Vec::new();
    let curves: Vec<(Curve, u32)> = placed
        .into_iter()
        .map(|(curve, name)| {
            let id = names.iter().position(|n| n == name).unwrap_or_else(|| {
                names.push(name.to_string());
                names.len() - 1
            });
            (curve, id as u32)
        })
        .collect();
    report.unsupported.sort();
    report.unsupported.dedup();

    report.unit_note = unit_note;
    let mut rings: Vec<(Ring, u32)> = Vec::new();
    let mut pieces: Vec<(Vec<Point>, u32)> = Vec::new();
    for (mut curve, layer) in curves {
        for p in &mut curve.points {
            *p = [p[0] * scale, p[1] * scale];
        }
        curve.points.dedup_by(|a, b| distance(*a, *b) < 1e-9);
        if curve.closed {
            if curve.points.len() >= 3 {
                rings.push((curve.points, layer));
            }
        } else {
            pieces.push((curve.points, layer));
        }
    }
    if rings.is_empty() && pieces.is_empty() {
        let left_out = if report.unsupported.is_empty() {
            String::new()
        } else {
            format!(" Left out: {}.", report.unsupported.join(", "))
        };
        return Err(format!(
            "No lines, arcs, circles, polylines or splines were found in the DXF file.{left_out}"
        ));
    }

    // Layer by layer: lines are joined, and outlines cut out of each other,
    // within a layer only.
    let mut regions: Vec<DesignRegion> = Vec::new();
    let mut open_by_layer: Vec<Vec<Vec<Point>>> = Vec::new();
    for layer in 0..names.len() as u32 {
        let mut closed: Vec<Ring> = rings
            .iter()
            .filter(|(_, on)| *on == layer)
            .map(|(ring, _)| ring.clone())
            .collect();
        let open: Vec<Vec<Point>> = pieces
            .iter()
            .filter(|(_, on)| *on == layer)
            .map(|(piece, _)| piece.clone())
            .collect();
        let joined = join(open.clone(), gap);
        report.open_outlines += joined.open;
        if joined.open > 0 {
            open_by_layer.push(open);
        }
        closed.extend(joined.closed);

        // Every outline is a shape of its own; where one crosses itself, its
        // loops are.
        let mut shapes: Vec<DesignRegion> = Vec::new();
        for ring in closed {
            for mut shape in vec![ring].simplify_shape(FillRule::NonZero) {
                if shape.is_empty() {
                    continue;
                }
                let outer = shape.remove(0);
                let area =
                    ring_area(&outer).abs() - shape.iter().map(|h| ring_area(h).abs()).sum::<f64>();
                if area < MIN_REGION_AREA {
                    report.specks += 1;
                    continue;
                }
                shapes.push(DesignRegion {
                    id: shapes.len() as u32,
                    color: None,
                    layer,
                    outer,
                    holes: shape,
                });
            }
        }
        regions.extend(regions_between_outlines(shapes));
    }
    for (id, region) in regions.iter_mut().enumerate() {
        region.id = id as u32;
    }
    report.joinable = joinable(&open_by_layer, gap, report.open_outlines);
    if gap > JOIN_GAP {
        report.joined_at = Some(gap);
    }
    let layers = layers_named(only_used_layers(&mut regions, names));

    // The page is the drawing's extent plus a margin, with its bottom-left
    // corner at the origin.
    let (mut x0, mut y0, mut x1, mut y1) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for p in regions.iter().flat_map(|r| r.outer.iter()) {
        x0 = x0.min(p[0]);
        y0 = y0.min(p[1]);
        x1 = x1.max(p[0]);
        y1 = y1.max(p[1]);
    }
    let (width, height) = if regions.is_empty() {
        (2.0 * PAGE_MARGIN, 2.0 * PAGE_MARGIN)
    } else {
        (x1 - x0 + 2.0 * PAGE_MARGIN, y1 - y0 + 2.0 * PAGE_MARGIN)
    };
    for region in &mut regions {
        for p in region
            .outer
            .iter_mut()
            .chain(region.holes.iter_mut().flatten())
        {
            *p = [p[0] - x0 + PAGE_MARGIN, p[1] - y0 + PAGE_MARGIN];
        }
    }

    Ok(SvgImport {
        design: Design {
            source_name: source_name.to_string(),
            width,
            height,
            scale: 1.0,
            mirror: false,
            regions,
            layers,
        },
        report,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn circle(layer: Option<&str>, x: f64, radius: f64) -> String {
        let on = layer.map_or(String::new(), |name| format!("8\n{name}\n"));
        format!("0\nCIRCLE\n{on}10\n{x}\n20\n0\n40\n{radius}\n")
    }

    fn drawing(entities: &[String]) -> SvgImport {
        let text = format!(
            "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n{}0\nENDSEC\n0\nEOF\n",
            entities.concat()
        );
        import_dxf(&text, "test.dxf").unwrap()
    }

    #[test]
    fn layers_are_kept_and_outlines_nest_within_one_only() {
        let out = drawing(&[
            circle(Some("PLATE"), 0.0, 30.0),
            circle(Some("HOLES"), 0.0, 5.0),
            circle(Some("PLATE"), 0.0, 10.0),
        ]);
        // The last drawn layer is the top one.
        let names: Vec<&str> = out.design.layers.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, ["HOLES", "PLATE"]);
        let plate = out.design.layers[1].id;
        let on = |layer: u32| -> Vec<&DesignRegion> {
            out.design
                .regions
                .iter()
                .filter(|r| r.layer == layer)
                .collect()
        };
        // The plate's own inner circle is cut out of it; the one on the other layer is not.
        assert_eq!(on(plate).len(), 2);
        assert_eq!(on(plate).iter().map(|r| r.holes.len()).sum::<usize>(), 1);
        assert_eq!(on(out.design.layers[0].id).len(), 1);
        let mut ids: Vec<u32> = out.design.regions.iter().map(|r| r.id).collect();
        ids.sort_unstable();
        assert_eq!(ids, [0, 1, 2]);
    }

    #[test]
    fn a_circle_in_metres_is_as_fine_as_one_in_millimetres() {
        let circle = |unit: u32, r: f64| {
            let text = format!(
                "0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n{unit}\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nCIRCLE\n10\n0\n20\n0\n40\n{r}\n0\nENDSEC\n0\nEOF\n"
            );
            let out = import_dxf(&text, "test.dxf").unwrap();
            ring_area(&out.design.regions[0].outer).abs()
        };
        let exact = PI * 50.0 * 50.0;
        for (unit, r) in [(4, 50.0), (5, 5.0), (6, 0.05), (1, 50.0 / 25.4)] {
            let area = circle(unit, r);
            assert!((area - exact).abs() / exact < 1e-3, "unit {unit}: {area}");
        }
    }

    #[test]
    fn a_block_that_places_itself_many_times_stops_with_a_note() {
        // Block R draws a square and places itself three times: 3^16 copies, unbounded.
        let text = "0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\nR\n10\n0\n20\n0\n\
            0\nLWPOLYLINE\n90\n4\n70\n1\n10\n0\n20\n0\n10\n1\n20\n0\n10\n1\n20\n1\n10\n0\n20\n1\n\
            0\nINSERT\n2\nR\n10\n2\n20\n0\n0\nINSERT\n2\nR\n10\n0\n20\n2\n0\nINSERT\n2\nr\n10\n2\n20\n2\n\
            0\nENDBLK\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nINSERT\n2\nR\n10\n0\n20\n0\n0\nENDSEC\n0\nEOF\n";
        let out = import_dxf(text, "test.dxf").unwrap();
        assert!(!out.design.regions.is_empty());
        assert!(
            out.report
                .unsupported
                .iter()
                .any(|n| n.contains("copies of blocks past")),
            "{:?}",
            out.report.unsupported
        );
    }

    #[test]
    fn a_block_is_found_whatever_the_case_and_a_missing_one_is_named() {
        let text = |name: &str| {
            format!(
                "0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n2\nDOOR\n10\n0\n20\n0\n0\nCIRCLE\n10\n0\n20\n0\n40\n5\n0\nENDBLK\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nINSERT\n2\n{name}\n10\n0\n20\n0\n0\nENDSEC\n0\nEOF\n"
            )
        };
        assert_eq!(
            import_dxf(&text("door"), "test.dxf")
                .unwrap()
                .design
                .regions
                .len(),
            1
        );
        let error = import_dxf(&text("WINDOW"), "test.dxf").unwrap_err();
        assert!(error.contains("WINDOW"), "{error}");
    }

    #[test]
    fn a_larger_gap_is_offered_and_closes_the_outline() {
        let line = |a: [f64; 2], b: [f64; 2]| {
            format!(
                "0\nLINE\n10\n{}\n20\n{}\n11\n{}\n21\n{}\n",
                a[0], a[1], b[0], b[1]
            )
        };
        let square = [
            line([0.0, 0.0], [20.0, 0.0]),
            line([20.0, 0.0], [20.0, 20.0]),
            line([20.0, 20.0], [0.0, 20.0]),
            line([0.0, 20.0], [0.0, 0.3]),
        ];
        let out = drawing(&square);
        assert_eq!(out.report.open_outlines, 1);
        assert!(out.design.regions.is_empty());
        let offer = out.report.joinable.unwrap();
        assert_eq!((offer.gap, offer.closes), (0.5, 1));
        assert_eq!(out.report.joined_at, None);

        let text = format!(
            "0\nSECTION\n2\nENTITIES\n{}0\nENDSEC\n0\nEOF\n",
            square.concat()
        );
        let again = import_dxf_joined(&text, "test.dxf", offer.gap).unwrap();
        assert_eq!(again.report.open_outlines, 0);
        assert_eq!(again.design.regions.len(), 1);
        assert_eq!(again.report.joined_at, Some(0.5));
        assert_eq!(again.report.joinable, None);
    }

    #[test]
    fn a_binary_file_read_as_text_says_how_to_read_it() {
        assert!(import_dxf("AutoCAD Binary DXF\r\n", "x.dxf")
            .unwrap_err()
            .contains("binary"));
    }

    #[test]
    fn a_drawing_on_one_layer_has_no_layers() {
        for layer in [None, Some("0"), Some("CUT")] {
            let out = drawing(&[circle(layer, 0.0, 30.0), circle(layer, 0.0, 5.0)]);
            assert!(out.design.layers.is_empty());
            assert!(out.design.regions.iter().all(|r| r.layer == 0));
            assert_eq!(out.design.regions.len(), 2);
        }
    }
}
