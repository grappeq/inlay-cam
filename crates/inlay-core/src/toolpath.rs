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
