//! DXF import: turns a CAD drawing into regions in millimetres.
//!
//! A DXF file has no filled shapes, only lines. Lines, arcs and curves that
//! meet end to end are joined into closed outlines, and the shapes are the
//! areas between those outlines, exactly as for an SVG drawing made of
//! outlines. Only the text (ASCII) form of DXF is read.

use std::f64::consts::{PI, TAU};

use i_overlay::core::fill_rule::FillRule;
use i_overlay::float::simplify::SimplifyShape;

use super::join::{join, thin, JOIN_GAP};
use super::svg::{regions_between_outlines, ImportReport, SvgImport, FLATTEN_TOLERANCE};
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

fn number(groups: &Groups, code: i32) -> Option<f64> {
    groups
        .iter()
        .find(|(c, _)| *c == code)
        .and_then(|(_, v)| v.parse().ok())
}

fn point(groups: &Groups, x: i32, y: i32) -> Option<Point> {
    Some([number(groups, x)?, number(groups, y)?])
}

/// Points along a circular arc from angle `from` through `sweep` radians
/// (positive is counter-clockwise), the start left out and the end included.
fn arc_points(centre: Point, radius: f64, from: f64, sweep: f64, out: &mut Vec<Point>) {
    let step = if radius > FLATTEN_TOLERANCE {
        2.0 * (1.0 - FLATTEN_TOLERANCE / radius).acos()
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
        thin(&points, FLATTEN_TOLERANCE / 4.0)
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
            let step = if a > FLATTEN_TOLERANCE {
                2.0 * (1.0 - FLATTEN_TOLERANCE / a).acos()
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

pub fn import_dxf(text: &str, source_name: &str) -> Result<SvgImport, String> {
    if text.starts_with("AutoCAD Binary DXF") {
        return Err(
            "This is a binary DXF file. Save it as a text (ASCII) DXF and try again.".into(),
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
    if !groups.contains(&(0, "SECTION")) {
        return Err("The file could not be read as a DXF drawing.".into());
    }

    let mut report = ImportReport::default();
    let mut unit_code: Option<i32> = None;
    let mut curves: Vec<Curve> = Vec::new();
    // An old-style POLYLINE is spread over entities: its vertices follow it.
    let mut heavy: Option<(Vec<(Point, f64)>, bool)> = None;

    let mut section = "";
    let mut i = 0;
    while i < groups.len() {
        let (code, value) = groups[i];
        if code == 0 && value == "SECTION" {
            section = groups.get(i + 1).map_or("", |g| g.1);
            i += 2;
            continue;
        }
        if code == 0 && value == "ENDSEC" {
            section = "";
            i += 1;
            continue;
        }
        if section == "HEADER" && code == 9 && value == "$INSUNITS" {
            unit_code = groups.get(i + 1).and_then(|g| g.1.parse().ok());
        }
        if section != "ENTITIES" || code != 0 {
            i += 1;
            continue;
        }
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
                    heavy = Some((Vec::new(), flags & 1 != 0));
                }
            }
            "VERTEX" => {
                if let (Some((vertices, _)), Some(p)) = (&mut heavy, point(body, 10, 20)) {
                    vertices.push((p, number(body, 42).unwrap_or(0.0)));
                }
            }
            "SEQEND" => {
                if let Some((vertices, closed)) = heavy.take() {
                    curves.extend(polyline(&vertices, closed));
                }
            }
            kind => curves.extend(entity(kind, body, &mut report)),
        }
        i = end;
    }
    report.unsupported.sort();
    report.unsupported.dedup();

    let (scale, unit_note) = units(unit_code);
    report.unit_note = unit_note;
    let mut rings: Vec<Ring> = Vec::new();
    let mut pieces: Vec<Vec<Point>> = Vec::new();
    for mut curve in curves {
        for p in &mut curve.points {
            *p = [p[0] * scale, p[1] * scale];
        }
        curve.points.dedup_by(|a, b| distance(*a, *b) < 1e-9);
        if curve.closed {
            if curve.points.len() >= 3 {
                rings.push(curve.points);
            }
        } else {
            pieces.push(curve.points);
        }
    }
    if rings.is_empty() && pieces.is_empty() {
        return Err(
            "No lines, arcs, circles, polylines or splines were found in the DXF file.".into(),
        );
    }
    let joined = join(pieces, JOIN_GAP);
    report.open_outlines = joined.open;
    rings.extend(joined.closed);

    // Every outline is a shape of its own; where one crosses itself, its
    // loops are.
    let mut regions: Vec<DesignRegion> = Vec::new();
    for ring in rings {
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
            regions.push(DesignRegion {
                id: regions.len() as u32,
                color: None,
                outer,
                holes: shape,
            });
        }
    }
    let mut regions = regions_between_outlines(regions);

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
        },
        report,
    })
}
