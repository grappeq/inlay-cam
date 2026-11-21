//! Joining separate lines and curves, as CAD programs export them, into
//! closed outlines.

use serde::Serialize;

use crate::geom::{distance, Point, Ring};

/// Ends closer together than this are the same point, mm.
pub const JOIN_GAP: f64 = 0.01;

#[derive(Debug, Default, PartialEq)]
pub struct Joined {
    /// Outlines that closed, each from one or more pieces.
    pub closed: Vec<Ring>,
    /// Chains of pieces that did not close.
    pub open: u32,
}

/// Chains `pieces` end to end wherever two ends are within `gap` of each
/// other, in either direction, and returns the chains that close. Where more
/// than two ends meet at a point, the nearest is taken.
pub fn join(pieces: Vec<Vec<Point>>, gap: f64) -> Joined {
    let pieces: Vec<Vec<Point>> = pieces.into_iter().filter(|p| p.len() >= 2).collect();
    // A gap of exactly `gap`, as drawn, may measure a hair over it: an SVG's
    // points are read in single precision, a few millionths of a mm off.
    let gap = gap + 1e-5;
    let mut used = vec![false; pieces.len()];
    let mut out = Joined::default();

    // The unused piece with an end nearest to `at`, and whether that end is its last point.
    let nearest = |at: Point, used: &[bool]| -> Option<(usize, bool)> {
        let mut best: Option<(usize, bool, f64)> = None;
        for (j, piece) in pieces.iter().enumerate() {
            if used[j] {
                continue;
            }
            for (end, from_last) in [(piece[0], false), (piece[piece.len() - 1], true)] {
                let d = distance(at, end);
                if d <= gap && best.is_none_or(|(_, _, b)| d < b) {
                    best = Some((j, from_last, d));
                }
            }
        }
        best.map(|(j, from_last, _)| (j, from_last))
    };

    for i in 0..pieces.len() {
        if used[i] {
            continue;
        }
        used[i] = true;
        let mut chain = pieces[i].clone();
        let closed = loop {
            if chain.len() >= 3 && distance(chain[0], chain[chain.len() - 1]) <= gap {
                break true;
            }
            if let Some((j, from_last)) = nearest(chain[chain.len() - 1], &used) {
                used[j] = true;
                // The shared point is in the chain already.
                if from_last {
                    chain.extend(pieces[j].iter().rev().skip(1));
                } else {
                    chain.extend(pieces[j].iter().skip(1));
                }
                continue;
            }
            if let Some((j, from_last)) = nearest(chain[0], &used) {
                used[j] = true;
                let mut front: Vec<Point> = if from_last {
                    pieces[j].clone()
                } else {
                    pieces[j].iter().rev().copied().collect()
                };
                front.pop();
                front.extend(chain);
                chain = front;
                continue;
            }
            break false;
        };
        if closed {
            chain.pop();
            chain.dedup_by(|a, b| distance(*a, *b) < 1e-9);
        }
        if closed && chain.len() >= 3 {
            out.closed.push(chain);
        } else {
            out.open += 1;
        }
    }
    out
}

/// The gaps, mm, that a drawing with open outlines is offered to be joined
/// at again, in place of a setting for the distance.
pub const LARGER_GAPS: [f64; 7] = [0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0];

/// More pieces than this are not tried at larger gaps: joining is quadratic.
const MOST_PIECES_TRIED: usize = 4000;

/// A larger gap that more of a drawing's open outlines would close at.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Joinable {
    /// mm.
    pub gap: f64,
    /// How many of the outlines that are open now would close.
    pub closes: u32,
}

/// The smallest of `LARGER_GAPS` above `gap` at which the most of the open
/// chains close, trying the pieces of each layer by themselves as an import
/// joins them. `open` is how many are open at `gap`. `None` when no larger
/// gap closes any.
pub fn joinable(layers: &[Vec<Vec<Point>>], gap: f64, open: u32) -> Option<Joinable> {
    if open == 0 || layers.iter().map(Vec::len).sum::<usize>() > MOST_PIECES_TRIED {
        return None;
    }
    let mut best: Option<Joinable> = None;
    for wider in LARGER_GAPS.into_iter().filter(|g| *g > gap) {
        let left: u32 = layers
            .iter()
            .map(|pieces| join(pieces.clone(), wider).open)
            .sum();
        let closes = open.saturating_sub(left);
        if closes > best.map_or(0, |b| b.closes) {
            best = Some(Joinable { gap: wider, closes });
        }
        if left == 0 {
            break;
        }
    }
    best
}

/// Removes points from an open run of points so that none removed was more
/// than `tolerance` from the run that remains. The ends stay.
pub fn thin(points: &[Point], tolerance: f64) -> Vec<Point> {
    if points.len() < 3 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![(0usize, points.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        let (pa, pb) = (points[a], points[b]);
        let length = distance(pa, pb);
        let mut worst = (0.0, a);
        for (k, p) in points.iter().enumerate().take(b).skip(a + 1) {
            let d = if length < 1e-12 {
                distance(*p, pa)
            } else {
                ((pb[0] - pa[0]) * (pa[1] - p[1]) - (pa[0] - p[0]) * (pb[1] - pa[1])).abs() / length
            };
            if d > worst.0 {
                worst = (d, k);
            }
        }
        if worst.0 > tolerance {
            keep[worst.1] = true;
            stack.push((a, worst.1));
            stack.push((worst.1, b));
        }
    }
    points
        .iter()
        .zip(&keep)
        .filter_map(|(p, k)| k.then_some(*p))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pieces_in_any_order_and_direction_make_one_outline() {
        // A square as four lines: shuffled, two of them backwards.
        let pieces = vec![
            vec![[10.0, 10.0], [0.0, 10.0]],
            vec![[0.0, 0.0], [10.0, 0.0]],
            vec![[0.0, 0.0], [0.0, 10.0]],
            vec![[10.0, 10.0], [10.0, 0.0]],
        ];
        let out = join(pieces, JOIN_GAP);
        assert_eq!(out.open, 0);
        assert_eq!(out.closed.len(), 1);
        assert_eq!(out.closed[0].len(), 4);
    }

    #[test]
    fn a_gap_wider_than_the_tolerance_leaves_the_outline_open() {
        let pieces = vec![
            vec![[0.0, 0.0], [10.0, 0.0]],
            vec![[10.0, 0.0], [10.0, 10.0]],
            vec![[10.0, 10.0], [0.0, 10.0]],
            vec![[0.0, 10.0], [0.0, 0.5]],
        ];
        let out = join(pieces, JOIN_GAP);
        assert_eq!((out.closed.len(), out.open), (0, 1));
    }

    #[test]
    fn separate_outlines_stay_separate() {
        let square = |x: f64| {
            vec![
                vec![[x, 0.0], [x + 5.0, 0.0], [x + 5.0, 5.0]],
                vec![[x + 5.0, 5.0], [x, 5.0], [x, 0.004]],
            ]
        };
        let mut pieces = square(0.0);
        pieces.extend(square(20.0));
        pieces.push(vec![[50.0, 0.0], [60.0, 0.0]]);
        let out = join(pieces, JOIN_GAP);
        assert_eq!((out.closed.len(), out.open), (2, 1));
    }

    #[test]
    fn a_larger_gap_that_closes_outlines_is_found() {
        let open_square = |x: f64, gap: f64| {
            vec![
                vec![[x, 0.0], [x + 10.0, 0.0], [x + 10.0, 10.0]],
                vec![[x + 10.0, 10.0], [x, 10.0], [x, gap]],
            ]
        };
        // One square open by 0.15 mm, one by 0.4: 0.5 closes both.
        let layers = vec![open_square(0.0, 0.15), open_square(20.0, 0.4)];
        let open: u32 = layers.iter().map(|p| join(p.clone(), JOIN_GAP).open).sum();
        assert_eq!(open, 2);
        assert_eq!(
            joinable(&layers, JOIN_GAP, open),
            Some(Joinable {
                gap: 0.5,
                closes: 2
            })
        );
        // Past the largest gap offered, nothing.
        let far = vec![open_square(0.0, 3.0)];
        assert_eq!(joinable(&far, JOIN_GAP, 1), None);
        assert_eq!(joinable(&layers, JOIN_GAP, 0), None);
        // A gap drawn as the largest offered, that measures a hair over it, closes at it.
        let edge = open_square(0.0, 2.0 + 3e-6);
        assert_eq!(join(edge, 2.0).open, 0);
    }

    #[test]
    fn thinning_keeps_the_ends_and_the_corners() {
        let mut run: Vec<Point> = (0..=100).map(|i| [i as f64 * 0.1, 0.0]).collect();
        run.extend((1..=100).map(|i| [10.0, i as f64 * 0.1]));
        assert_eq!(
            thin(&run, 0.001),
            vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]]
        );
    }
}
