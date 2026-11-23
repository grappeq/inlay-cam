//! A small picture of a design, for the list of projects: the stock's
//! outline and the shapes on it as one SVG path, in a box whose longer side
//! is [`SIDE`]. Points closer than a fraction of the box are left out, so
//! that a drawing of any size gives a path of a few kilobytes at most.

use serde::Serialize;

use crate::geom::{Point, Ring};
use crate::project::Design;

/// The longer side of the picture's box.
pub const SIDE: f64 = 100.0;
/// At most this many points in the path: past it, more are left out.
const MOST_POINTS: usize = 1200;
/// Points nearer than this to the last one kept are left out, at first.
const FIRST_STEP: f64 = 0.5;

/// The picture: the stock is `w` by `h`, the shapes are `d`, Y down, the
/// outer rings one way round and the holes the other, so that the nonzero
/// rule fills them as the drawing is.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Thumbnail {
    pub w: f64,
    pub h: f64,
    pub d: String,
}

/// The picture of a design; none for one without a size. The shapes of
/// hidden layers are left out, as the screens leave them out.
pub fn thumbnail(design: &Design) -> Option<Thumbnail> {
    let (width, height) = design.placed_size();
    if !(width.is_finite() && height.is_finite() && width > 0.0 && height > 0.0) {
        return None;
    }
    let k = SIDE / width.max(height);
    let (w, h) = (width * k, height * k);
    let hidden: Vec<u32> = design.layers.iter().filter(|l| l.hidden).map(|l| l.id).collect();
    let place = |p: &Point| -> Point {
        let x = if design.mirror { design.width - p[0] } else { p[0] };
        [x * design.scale * k, h - p[1] * design.scale * k]
    };
    // Each ring turned the way the nonzero rule needs it, whichever way it
    // came: outers one way, holes the other.
    let rings: Vec<Ring> = design
        .regions
        .iter()
        .filter(|r| !hidden.contains(&r.layer))
        .flat_map(|r| std::iter::once((&r.outer, false)).chain(r.holes.iter().map(|hole| (hole, true))))
        .map(|(ring, hole)| {
            let mut placed: Ring = ring.iter().map(place).collect();
            if (area(&placed) > 0.0) != hole {
                placed.reverse();
            }
            placed
        })
        .collect();
    let mut step = FIRST_STEP;
    loop {
        let (d, points) = path(&rings, step);
        if points <= MOST_POINTS || step > SIDE {
            return Some(Thumbnail { w: round(w), h: round(h), d });
        }
        step *= 2.0;
    }
}

/// The rings as one path, each point nearer than `step` to the last one
/// kept left out, and a ring that comes to less than three points or fits
/// in a `step` left out whole. Gives the path and how many points it has.
fn path(rings: &[Ring], step: f64) -> (String, usize) {
    let mut d = String::new();
    let mut count = 0;
    for ring in rings {
        let kept = thin(ring, step);
        if kept.len() < 3 {
            continue;
        }
        for (i, p) in kept.iter().enumerate() {
            d.push(if i == 0 { 'M' } else { 'L' });
            d.push_str(&number(p[0]));
            d.push(' ');
            d.push_str(&number(p[1]));
        }
        d.push('Z');
        count += kept.len();
    }
    (d, count)
}

fn thin(ring: &[Point], step: f64) -> Vec<Point> {
    let (lo, hi) = ring.iter().fold(([f64::MAX; 2], [f64::MIN; 2]), |(lo, hi), p| {
        ([lo[0].min(p[0]), lo[1].min(p[1])], [hi[0].max(p[0]), hi[1].max(p[1])])
    });
    if ring.is_empty() || (hi[0] - lo[0]).max(hi[1] - lo[1]) < step {
        return Vec::new();
    }
    let mut kept: Vec<Point> = Vec::new();
    for p in ring {
        if !p[0].is_finite() || !p[1].is_finite() {
            continue;
        }
        match kept.last() {
            Some(last) if (p[0] - last[0]).hypot(p[1] - last[1]) < step => {}
            _ => kept.push(*p),
        }
    }
    // The ring closes on its first point: a last one on top of it adds nothing.
    while kept.len() > 1 {
        let (first, last) = (kept[0], kept[kept.len() - 1]);
        if (first[0] - last[0]).hypot(first[1] - last[1]) < step {
            kept.pop();
        } else {
            break;
        }
    }
    kept
}

/// Twice the signed area of a ring: below zero for an outer ring of the
/// picture, above for a hole, with Y down.
fn area(ring: &[Point]) -> f64 {
    (0..ring.len())
        .map(|i| {
            let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
            a[0] * b[1] - b[0] * a[1]
        })
        .sum()
}

fn round(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// A number with one decimal at most, as short as it goes: "12", "3.5", "-0.2".
fn number(v: f64) -> String {
    let r = round(v);
    let r = if r == 0.0 { 0.0 } else { r };
    if r.fract() == 0.0 {
        format!("{}", r as i64)
    } else {
        format!("{r:.1}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{DesignRegion, Layer};

    fn square(id: u32, x: f64, y: f64, side: f64) -> DesignRegion {
        DesignRegion {
            id,
            color: None,
            layer: 0,
            outer: vec![[x, y], [x + side, y], [x + side, y + side], [x, y + side]],
            holes: vec![],
        }
    }

    fn design(regions: Vec<DesignRegion>) -> Design {
        Design { source_name: "t.svg".into(), width: 200.0, height: 100.0, scale: 1.0, mirror: false, regions, layers: vec![] }
    }

    #[test]
    fn fits_the_longer_side_and_turns_y_down() {
        let t = thumbnail(&design(vec![square(1, 0.0, 0.0, 20.0)])).unwrap();
        assert_eq!((t.w, t.h), (100.0, 50.0));
        // Y up at the bottom left becomes Y down: the square sits at the foot of the box.
        assert_eq!(t.d, "M0 50L10 50L10 40L0 40Z");
    }

    #[test]
    fn scales_and_mirrors_as_the_stock_does() {
        let mut d = design(vec![square(1, 0.0, 0.0, 20.0)]);
        d.scale = 2.0;
        d.mirror = true;
        let t = thumbnail(&d).unwrap();
        assert_eq!((t.w, t.h), (100.0, 50.0));
        // Mirrored, the square is at the right end of the stock, and turned as one that is not.
        assert_eq!(t.d, "M100 40L90 40L90 50L100 50Z");
    }

    #[test]
    fn keeps_holes_and_leaves_out_hidden_layers_and_specks() {
        let mut framed = square(1, 0.0, 0.0, 100.0);
        framed.holes = vec![vec![[25.0, 25.0], [25.0, 75.0], [75.0, 75.0], [75.0, 25.0]]];
        let mut hidden = square(2, 150.0, 0.0, 20.0);
        hidden.layer = 7;
        let speck = square(3, 120.0, 0.0, 0.1);
        let mut d = design(vec![framed, hidden, speck]);
        d.layers = vec![Layer { id: 7, name: "Hidden".into(), hidden: true, locked: false, color: None }];
        let t = thumbnail(&d).unwrap();
        assert_eq!(t.d.matches('M').count(), 2, "{}", t.d);
        assert!(t.d.contains("M12.5 37.5L12.5 12.5L37.5 12.5L37.5 37.5Z"), "{}", t.d);
    }

    #[test]
    fn turns_rings_the_way_the_fill_needs_whichever_way_they_came() {
        // A hole wound as its outer ring is, and an outer ring wound as a hole.
        let mut framed = square(1, 0.0, 0.0, 100.0);
        framed.holes = vec![vec![[25.0, 25.0], [75.0, 25.0], [75.0, 75.0], [25.0, 75.0]]];
        let mut backwards = square(2, 150.0, 0.0, 20.0);
        backwards.outer.reverse();
        let t = thumbnail(&design(vec![framed, backwards])).unwrap();
        let rings: Vec<Vec<Point>> = t
            .d
            .split('Z')
            .filter(|ring| !ring.is_empty())
            .map(|ring| {
                ring.split(['M', 'L'])
                    .filter(|p| !p.is_empty())
                    .map(|p| {
                        let v: Vec<f64> = p.split(' ').map(|n| n.parse().unwrap()).collect();
                        [v[0], v[1]]
                    })
                    .collect()
            })
            .collect();
        let signs: Vec<bool> = rings.iter().map(|ring| area(ring) > 0.0).collect();
        // The outer rings one way, the hole the other.
        assert_eq!(signs, vec![false, true, false], "{}", t.d);
    }

    #[test]
    fn a_dense_outline_stays_small() {
        let circle: Ring = (0..20_000)
            .map(|i| {
                let a = i as f64 / 20_000.0 * std::f64::consts::TAU;
                [100.0 + 50.0 * a.cos(), 50.0 + 50.0 * a.sin()]
            })
            .collect();
        let region = DesignRegion { id: 1, color: None, layer: 0, outer: circle, holes: vec![] };
        let t = thumbnail(&design(vec![region])).unwrap();
        let points = t.d.matches(['M', 'L']).count();
        assert!(points > 50 && points <= MOST_POINTS, "{points}");
        assert!(t.d.len() < 16_000);
    }

    #[test]
    fn many_shapes_are_thinned_until_they_fit_and_the_smallest_go() {
        let regions: Vec<DesignRegion> = (0..3000).map(|i| square(i, (i % 60) as f64 * 3.0, (i / 60) as f64 * 2.0, 1.5)).collect();
        let t = thumbnail(&design(regions)).unwrap();
        assert!(t.d.matches(['M', 'L']).count() <= MOST_POINTS);
    }

    #[test]
    fn none_without_a_size() {
        let mut d = design(vec![]);
        d.width = 0.0;
        assert_eq!(thumbnail(&d), None);
        assert_eq!(thumbnail(&design(vec![])).map(|t| t.d), Some(String::new()));
    }
}
