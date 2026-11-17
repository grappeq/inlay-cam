//! The move list: what a machine should do, independent of any controller's
//! G-code dialect. Operations produce it, a post-processor writes it out.
//!
//! Coordinates are work coordinates in mm: X/Y from the base board's
//! bottom-left corner, Z0 on the stock's top face, Z up.

use crate::tools::Tool;

pub type P3 = [f64; 3];

#[derive(Debug, Clone, PartialEq)]
pub enum Move {
    /// Put this tool in the spindle. The spindle is off afterwards.
    ToolChange {
        number: u32,
    },
    SpindleOn {
        rpm: u32,
    },
    SpindleOff,
    /// First move after a tool change: travel sideways at whatever height
    /// the machine left the tool at, which is high above the work.
    RapidXy {
        to: [f64; 2],
    },
    /// Move at full speed, not cutting.
    Rapid {
        to: P3,
    },
    /// Cut in a straight line. `feed` is mm/min.
    Feed {
        to: P3,
        feed: f64,
    },
    /// Cut along a circular arc in the XY plane around `center`. Z may change
    /// linearly along the arc.
    Arc {
        to: P3,
        center: [f64; 2],
        clockwise: bool,
        feed: f64,
    },
    /// A comment on a line of its own. Nothing moves.
    Comment {
        text: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProgramTool {
    /// The number the program calls the tool by (the `T` word).
    pub number: u32,
    pub tool: Tool,
}

/// Everything needed to cut one part.
#[derive(Debug, Clone, PartialEq)]
pub struct Program {
    /// Shown in the file's first comment.
    pub name: String,
    pub tools: Vec<ProgramTool>,
    /// Height above the stock at which the tool may travel freely.
    pub safe_z: f64,
    pub moves: Vec<Move>,
}

impl Program {
    pub fn tool(&self, number: u32) -> Option<&Tool> {
        self.tools
            .iter()
            .find(|t| t.number == number)
            .map(|t| &t.tool)
    }
}

/// Appends moves while remembering where the tool is, so operations do not
/// repeat positions or lose track of the current height.
#[derive(Debug)]
pub struct PathBuilder {
    moves: Vec<Move>,
    position: Option<P3>,
    safe_z: f64,
    clearance: f64,
}

/// The usual height above already-cut material at which a rapid descent
/// stops and the plunge feed takes over, mm.
pub const PLUNGE_CLEARANCE: f64 = 1.0;

impl PathBuilder {
    pub fn new(safe_z: f64) -> Self {
        Self {
            moves: Vec::new(),
            position: None,
            safe_z,
            clearance: PLUNGE_CLEARANCE.min(safe_z),
        }
    }

    /// Sets the height above already-cut material at which rapid descents stop.
    pub fn with_clearance(mut self, clearance: f64) -> Self {
        self.clearance = clearance;
        self
    }

    /// Height above already-cut material at which a rapid descent stops and
    /// the plunge feed takes over.
    pub fn clearance(&self) -> f64 {
        self.clearance
    }

    pub fn position(&self) -> Option<P3> {
        self.position
    }

    /// Changes tool and starts the spindle. The tool position is unknown afterwards.
    pub fn start_tool(&mut self, number: u32, rpm: u32) {
        if !self.moves.is_empty() {
            self.retract();
            self.moves.push(Move::SpindleOff);
        }
        self.moves.push(Move::ToolChange { number });
        self.moves.push(Move::SpindleOn { rpm });
        self.position = None;
    }

    /// Lifts to the safe height (if not there), travels above `xy`, then comes
    /// down at full speed to `z`.
    pub fn rapid_to(&mut self, xy: [f64; 2], z: f64) {
        match self.position {
            Some(p) => {
                let travel_z = p[2].max(self.safe_z);
                self.push_rapid([p[0], p[1], travel_z]);
                self.push_rapid([xy[0], xy[1], travel_z]);
            }
            None => {
                self.moves.push(Move::RapidXy { to: xy });
                let above = [xy[0], xy[1], self.safe_z];
                self.moves.push(Move::Rapid { to: above });
                self.position = Some(above);
            }
        }
        if z < self.safe_z {
            self.push_rapid([xy[0], xy[1], z]);
        }
    }

    pub fn feed_to(&mut self, to: P3, feed: f64) {
        if self.position != Some(to) {
            self.moves.push(Move::Feed { to, feed });
            self.position = Some(to);
        }
    }

    /// Lifts straight up to the safe height.
    pub fn retract(&mut self) {
        if let Some(p) = self.position {
            if p[2] < self.safe_z {
                self.push_rapid([p[0], p[1], self.safe_z]);
            }
        }
    }

    pub fn finish(mut self) -> Vec<Move> {
        self.retract();
        self.moves.push(Move::SpindleOff);
        self.moves
    }

    fn push_rapid(&mut self, to: P3) {
        if self.position != Some(to) {
            self.moves.push(Move::Rapid { to });
            self.position = Some(to);
        }
    }
}

/// How far the straight pieces of a path may lie from the arc that replaces
/// them, mm. Round offsets are made of pieces up to 0.005 mm off their arc.
pub const ARC_FIT_TOLERANCE: f64 = 0.008;

/// The largest sweep of one fitted arc, radians. Longer curves become
/// several arcs, so that none comes near a full circle.
const MAX_SWEEP: f64 = 4.0;

/// Replaces runs of short straight cuts that lie on a circle by arcs. Only
/// level cuts at one feed are looked at; everything else is passed through.
/// A curve then takes a line or two of G-code instead of dozens.
pub fn fit_arcs(moves: &[Move], tolerance: f64) -> Vec<Move> {
    let mut out: Vec<Move> = Vec::with_capacity(moves.len());
    let mut at: Option<P3> = None;
    let mut i = 0;
    while i < moves.len() {
        let (Some(from), Move::Feed { to, feed }) = (at, &moves[i]) else {
            match &moves[i] {
                Move::Rapid { to } | Move::Feed { to, .. } | Move::Arc { to, .. } => at = Some(*to),
                Move::ToolChange { .. } | Move::RapidXy { .. } => at = None,
                Move::SpindleOn { .. } | Move::SpindleOff | Move::Comment { .. } => {}
            }
            out.push(moves[i].clone());
            i += 1;
            continue;
        };
        // The run of level cuts at this feed that starts here.
        let level = |q: &P3| (q[2] - from[2]).abs() < 1e-9;
        let mut points: Vec<[f64; 2]> = vec![[from[0], from[1]]];
        let mut j = i;
        while let Some(Move::Feed { to: next, feed: f }) = moves.get(j) {
            if f != feed || !level(next) {
                break;
            }
            points.push([next[0], next[1]]);
            j += 1;
        }
        if j == i {
            // A cut that changes height: as it is.
            at = Some(*to);
            out.push(moves[i].clone());
            i += 1;
            continue;
        }
        let mut s = 0;
        while s + 1 < points.len() {
            // The longest stretch from here that is one arc, of three pieces or more.
            let mut best: Option<(usize, [f64; 2], bool)> = None;
            let mut e = s + 3;
            while e < points.len() {
                match arc_through(&points[s..=e], tolerance) {
                    Some((center, clockwise)) => best = Some((e, center, clockwise)),
                    None => break,
                }
                e += 1;
            }
            match best {
                Some((e, center, clockwise)) => {
                    out.push(Move::Arc {
                        to: [points[e][0], points[e][1], from[2]],
                        center,
                        clockwise,
                        feed: *feed,
                    });
                    s = e;
                }
                None => {
                    out.push(Move::Feed {
                        to: [points[s + 1][0], points[s + 1][1], from[2]],
                        feed: *feed,
                    });
                    s += 1;
                }
            }
        }
        at = Some([
            points[points.len() - 1][0],
            points[points.len() - 1][1],
            from[2],
        ]);
        i = j;
    }
    out
}

/// The circle through the first, middle and last of `points`, when every
/// point and the middle of every piece lies within `tolerance` of it and the
/// points go round it one way. Returns its centre and whether they go
/// clockwise.
fn arc_through(points: &[[f64; 2]], tolerance: f64) -> Option<([f64; 2], bool)> {
    let (a, b, c) = (
        points[0],
        points[points.len() / 2],
        points[points.len() - 1],
    );
    // Circumcentre of the three.
    let d = 2.0 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    let chord = ((c[0] - a[0]).powi(2) + (c[1] - a[1]).powi(2)).sqrt();
    if d.abs() < 1e-9 * (1.0 + chord * chord) {
        return None;
    }
    let sq = |p: [f64; 2]| p[0] * p[0] + p[1] * p[1];
    let center = [
        (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d,
        (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d,
    ];
    let from_center =
        |p: [f64; 2]| ((p[0] - center[0]).powi(2) + (p[1] - center[1]).powi(2)).sqrt();
    let radius = from_center(a);
    if !(0.05..=2000.0).contains(&radius) {
        return None;
    }
    let mut sweep = 0.0;
    let mut clockwise: Option<bool> = None;
    for w in points.windows(2) {
        let (p, q) = (w[0], w[1]);
        let middle = [(p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0];
        if (from_center(q) - radius).abs() > tolerance
            || (from_center(middle) - radius).abs() > tolerance
        {
            return None;
        }
        // The angle this piece turns through, seen from the centre.
        let cross =
            (p[0] - center[0]) * (q[1] - center[1]) - (p[1] - center[1]) * (q[0] - center[0]);
        let dot = (p[0] - center[0]) * (q[0] - center[0]) + (p[1] - center[1]) * (q[1] - center[1]);
        let turn = cross.atan2(dot);
        if turn.abs() < 1e-9 || clockwise.is_some_and(|cw| cw != (turn < 0.0)) {
            return None;
        }
        clockwise = Some(turn < 0.0);
        sweep += turn.abs();
    }
    (sweep <= MAX_SWEEP).then_some((center, clockwise?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feeds(points: &[[f64; 3]]) -> Vec<Move> {
        let mut moves = vec![Move::Rapid { to: points[0] }];
        moves.extend(points[1..].iter().map(|to| Move::Feed {
            to: *to,
            feed: 600.0,
        }));
        moves
    }

    /// Points on a circle of radius 10 about (5, 5), from angle `a0` to `a1` in degrees.
    fn on_circle(a0: f64, a1: f64, pieces: usize, z: f64) -> Vec<[f64; 3]> {
        (0..=pieces)
            .map(|i| {
                let a = (a0 + (a1 - a0) * i as f64 / pieces as f64).to_radians();
                [5.0 + 10.0 * a.cos(), 5.0 + 10.0 * a.sin(), z]
            })
            .collect()
    }

    #[test]
    fn straight_pieces_on_a_circle_become_an_arc() {
        for (a0, a1, clockwise) in [(10.0, 100.0, false), (100.0, 10.0, true)] {
            let points = on_circle(a0, a1, 40, -2.0);
            let fitted = fit_arcs(&feeds(&points), ARC_FIT_TOLERANCE);
            assert_eq!(fitted.len(), 2, "{fitted:?}");
            let Move::Arc {
                to,
                center,
                clockwise: cw,
                feed,
            } = &fitted[1]
            else {
                panic!("not an arc: {:?}", fitted[1]);
            };
            assert_eq!(*to, points[40]);
            assert!((center[0] - 5.0).abs() < 1e-6 && (center[1] - 5.0).abs() < 1e-6);
            assert_eq!((*cw, *feed), (clockwise, 600.0));
        }
    }

    #[test]
    fn a_whole_circle_becomes_a_few_arcs_and_corners_stay_corners() {
        let points = on_circle(0.0, 360.0, 180, -1.0);
        let fitted = fit_arcs(&feeds(&points), ARC_FIT_TOLERANCE);
        let arcs = fitted
            .iter()
            .filter(|m| matches!(m, Move::Arc { .. }))
            .count();
        assert_eq!(fitted.len(), 1 + arcs);
        assert!((2..=3).contains(&arcs), "{arcs} arcs");

        // A rounded rectangle: four sides, four quarter circles.
        let mut outline: Vec<[f64; 3]> = Vec::new();
        for (cx, cy, a0) in [
            (20.0, 10.0, -90.0),
            (20.0, 20.0, 0.0),
            (0.0, 20.0, 90.0),
            (0.0, 10.0, 180.0),
        ] {
            outline.extend((0..=12).map(|i| {
                let a = (a0 + 90.0 * i as f64 / 12.0_f64).to_radians();
                [cx + 3.0 * a.cos(), cy + 3.0 * a.sin(), -1.0]
            }));
        }
        outline.push(outline[0]);
        let fitted = fit_arcs(&feeds(&outline), ARC_FIT_TOLERANCE);
        let arcs = fitted
            .iter()
            .filter(|m| matches!(m, Move::Arc { .. }))
            .count();
        let lines = fitted
            .iter()
            .filter(|m| matches!(m, Move::Feed { .. }))
            .count();
        assert_eq!((arcs, lines), (4, 4), "{fitted:?}");
    }

    #[test]
    fn straight_runs_ramps_and_other_moves_pass_through() {
        // A zigzag, a cut that changes height along a curve, and a tool change in between.
        let mut moves = feeds(&[
            [0.0, 0.0, -1.0],
            [10.0, 0.0, -1.0],
            [10.0, 1.0, -1.0],
            [0.0, 1.0, -1.0],
            [0.0, 2.0, -1.0],
        ]);
        moves.push(Move::ToolChange { number: 2 });
        moves.push(Move::SpindleOn { rpm: 9000 });
        let spiral: Vec<[f64; 3]> = on_circle(0.0, 90.0, 30, 0.0)
            .iter()
            .enumerate()
            .map(|(i, q)| [q[0], q[1], -(i as f64) * 0.01])
            .collect();
        moves.push(Move::RapidXy { to: [15.0, 5.0] });
        moves.extend(feeds(&spiral));
        assert_eq!(fit_arcs(&moves, ARC_FIT_TOLERANCE), moves);
    }
}
