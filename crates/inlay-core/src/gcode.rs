//! A strict interpreter for the G-code this app writes.
//!
//! The simulator works from the text of the file, not from the move list it
//! was written from, so the preview shows what the machine will be told. The
//! interpreter therefore accepts exactly the dialect of [`crate::post::carvera`]
//! and refuses anything else instead of guessing what it means.

use crate::toolpath::P3;

/// Height the tool is taken to be at after a tool change: well above any work.
pub const TOOL_CHANGE_Z: f64 = 100.0;

/// Largest gap between a true arc and the straight pieces that stand in for it, mm.
const ARC_TOLERANCE: f64 = 0.005;

#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub from: P3,
    pub to: P3,
    /// True for a rapid (`G0`), false for a cutting move.
    pub rapid: bool,
    /// mm/min; 0 for a rapid.
    pub feed: f64,
    pub tool: u32,
    pub rpm: u32,
    /// Line of the file this came from, starting at 1.
    pub line: u32,
}

impl Segment {
    pub fn length(&self) -> f64 {
        let d = [
            self.to[0] - self.from[0],
            self.to[1] - self.from[1],
            self.to[2] - self.from[2],
        ];
        (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Interpreted {
    pub segments: Vec<Segment>,
    /// Tool numbers in the order they are loaded.
    pub tool_changes: Vec<u32>,
    pub lines: u32,
}

impl Interpreted {
    /// Total length of cutting moves, mm.
    pub fn cutting_length(&self) -> f64 {
        self.segments
            .iter()
            .filter(|s| !s.rapid)
            .map(Segment::length)
            .sum()
    }

    /// Running time in minutes, not counting tool changes, spindle start or
    /// acceleration (so a real run takes somewhat longer).
    pub fn minutes(&self, rapid_rate: f64) -> f64 {
        self.segments
            .iter()
            .map(|s| s.length() / if s.rapid { rapid_rate } else { s.feed })
            .sum()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GcodeError {
    pub line: u32,
    pub message: String,
}

impl std::fmt::Display for GcodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "line {}: {}", self.line, self.message)
    }
}

impl std::error::Error for GcodeError {}

#[derive(Default)]
struct State {
    // Position; `None` until a move has set that axis after a tool change.
    x: Option<f64>,
    y: Option<f64>,
    z: Option<f64>,
    tool: Option<u32>,
    rpm: u32,
    spindle_on: bool,
    /// Feed in force. Cleared by a rapid, because a rapid's speed does not
    /// carry over to the next cut on this firmware.
    feed: Option<f64>,
    absolute: bool,
    millimetres: bool,
    work_offset: bool,
    ended: bool,
}

pub fn interpret(text: &str) -> Result<Interpreted, GcodeError> {
    let mut out = Interpreted::default();
    let mut s = State::default();

    for (index, raw) in text.lines().enumerate() {
        let line = index as u32 + 1;
        out.lines = line;
        let fail = |message: String| GcodeError { line, message };

        if raw.is_empty() || (raw.starts_with('(') && raw.ends_with(')')) {
            continue;
        }
        if s.ended {
            return Err(fail(
                "there is code after the end of the program (M30)".into(),
            ));
        }

        let mut g: Vec<u32> = Vec::new();
        let mut m: Vec<u32> = Vec::new();
        let mut words: [Option<f64>; 26] = [None; 26];
        for word in raw.split(' ') {
            let mut chars = word.chars();
            let letter = chars.next().filter(char::is_ascii_uppercase);
            let value = chars.as_str().parse::<f64>().ok().filter(|v| v.is_finite());
            let (Some(letter), Some(value)) = (letter, value) else {
                return Err(fail(format!(
                    "\"{word}\" is not a letter followed by a number"
                )));
            };
            match letter {
                'G' | 'M' => {
                    if value.fract() != 0.0 || value < 0.0 {
                        return Err(fail(format!("{word} is not supported")));
                    }
                    if letter == 'G' { &mut g } else { &mut m }.push(value as u32);
                }
                'X' | 'Y' | 'Z' | 'I' | 'J' | 'F' | 'S' | 'T' => {
                    let slot = &mut words[(letter as u8 - b'A') as usize];
                    if slot.replace(value).is_some() {
                        return Err(fail(format!("{letter} appears twice")));
                    }
                }
                _ => return Err(fail(format!("{word} is not supported"))),
            }
        }
        let word = |letter: char| words[(letter as u8 - b'A') as usize];

        let mut motion: Option<u32> = None;
        for code in g {
            match code {
                0..=3 if motion.is_none() => motion = Some(code),
                0..=3 => return Err(fail("two motion commands on one line".into())),
                17 | 94 => {}
                21 => s.millimetres = true,
                90 => s.absolute = true,
                54 => s.work_offset = true,
                28 => {
                    if s.spindle_on {
                        return Err(fail("G28 while the spindle is running".into()));
                    }
                    // The machine goes to its clearance position: off the work.
                    (s.x, s.y, s.z) = (None, None, None);
                }
                other => return Err(fail(format!("G{other} is not supported"))),
            }
        }

        if let Some(rpm) = word('S') {
            if rpm <= 0.0 || rpm.fract() != 0.0 {
                return Err(fail(
                    "spindle speed must be a whole number greater than 0".into(),
                ));
            }
            s.rpm = rpm as u32;
        }
        if let Some(f) = word('F') {
            if f <= 0.0 {
                return Err(fail(
                    "feed must be greater than 0 (F0 halts the machine)".into(),
                ));
            }
            if motion.is_none_or(|code| code == 0) {
                return Err(fail("F is only expected on a cutting move".into()));
            }
            s.feed = Some(f);
        }

        let has_tool_word = word('T').is_some();
        let mut tool_changed = false;
        for code in m {
            match code {
                6 => {
                    let Some(t) = word('T').filter(|t| *t >= 1.0 && t.fract() == 0.0) else {
                        return Err(fail("M6 needs a tool number on the same line".into()));
                    };
                    if s.spindle_on {
                        return Err(fail("tool change while the spindle is running".into()));
                    }
                    s.tool = Some(t as u32);
                    out.tool_changes.push(t as u32);
                    // The machine measures the tool and parks it high above the work.
                    (s.x, s.y, s.z, s.feed) = (None, None, Some(TOOL_CHANGE_Z), None);
                    tool_changed = true;
                }
                3 => {
                    if s.tool.is_none() {
                        return Err(fail("spindle started before a tool was loaded".into()));
                    }
                    if s.rpm == 0 {
                        return Err(fail("spindle started without a speed".into()));
                    }
                    s.spindle_on = true;
                }
                5 => s.spindle_on = false,
                30 => {
                    if s.spindle_on {
                        return Err(fail("program ends with the spindle running".into()));
                    }
                    s.ended = true;
                }
                other => return Err(fail(format!("M{other} is not supported"))),
            }
        }
        if has_tool_word && !tool_changed {
            return Err(fail("T without M6 on the same line does nothing".into()));
        }

        let has_axis = "XYZIJ".chars().any(|c| word(c).is_some());
        let Some(code) = motion else {
            if has_axis {
                return Err(fail(
                    "coordinates without a motion command (G0 to G3)".into(),
                ));
            }
            continue;
        };

        if !(s.millimetres && s.absolute) {
            return Err(fail(
                "motion before G21 (millimetres) and G90 (absolute) were set".into(),
            ));
        }
        let Some(tool) = s.tool else {
            return Err(fail("motion before a tool was loaded".into()));
        };
        if !s.work_offset {
            return Err(fail(
                "motion before the work offset (G54) was selected".into(),
            ));
        }
        if !"XYZ".chars().any(|c| word(c).is_some()) {
            return Err(fail("a motion command with nowhere to go".into()));
        }
        let rapid = code == 0;
        if rapid && (word('I').is_some() || word('J').is_some()) {
            return Err(fail("I and J only belong on an arc".into()));
        }

        // Sideways travel right after a tool change happens at an unknown
        // height far above the work: it sets the position and cuts nothing.
        let Some(z0) = s.z else {
            return Err(fail("the tool's height is unknown here".into()));
        };
        let (Some(x0), Some(y0)) = (s.x, s.y) else {
            let (Some(x), Some(y)) = (word('X'), word('Y')) else {
                return Err(fail(
                    "the first move after a tool change must give both X and Y".into(),
                ));
            };
            if !rapid || word('Z').is_some() {
                return Err(fail(
                    "the first move after a tool change must be a rapid in X and Y only".into(),
                ));
            }
            (s.x, s.y) = (Some(x), Some(y));
            continue;
        };

        let from = [x0, y0, z0];
        let to = [
            word('X').unwrap_or(x0),
            word('Y').unwrap_or(y0),
            word('Z').unwrap_or(z0),
        ];
        let feed = if rapid {
            s.feed = None;
            0.0
        } else {
            if !s.spindle_on {
                return Err(fail("cutting move with the spindle off".into()));
            }
            s.feed
                .ok_or_else(|| fail("cutting move without a feed since the last rapid".into()))?
        };
        let mut push = |from: P3, to: P3| {
            out.segments.push(Segment {
                from,
                to,
                rapid,
                feed,
                tool,
                rpm: s.rpm,
                line,
            })
        };

        if code <= 1 {
            if word('I').is_some() || word('J').is_some() {
                return Err(fail("I and J only belong on an arc".into()));
            }
            push(from, to);
        } else {
            let (Some(i), Some(j)) = (word('I'), word('J')) else {
                return Err(fail("an arc needs both I and J".into()));
            };
            let clockwise = code == 2;
            let centre = [x0 + i, y0 + j];
            let r0 = i.hypot(j);
            let r1 = (to[0] - centre[0]).hypot(to[1] - centre[1]);
            if r0 < 1e-6 {
                return Err(fail("arc with zero radius".into()));
            }
            // Written to 3 decimals, so start and end radius may differ by a few micrometres.
            if (r0 - r1).abs() > 0.005 {
                return Err(fail(format!("arc end point is not on the circle (radius {r0:.3} at the start, {r1:.3} at the end)")));
            }
            let a0 = (y0 - centre[1]).atan2(x0 - centre[0]);
            let a1 = (to[1] - centre[1]).atan2(to[0] - centre[0]);
            let tau = std::f64::consts::TAU;
            let mut sweep = if clockwise { a0 - a1 } else { a1 - a0 };
            // Same start and end point means a full circle.
            if sweep <= 1e-9 {
                sweep += tau;
            }
            let step = 2.0 * (1.0 - (ARC_TOLERANCE / r0).min(1.0)).acos();
            let n = (sweep / step).ceil().max(1.0) as usize;
            let mut previous = from;
            for k in 1..=n {
                let t = k as f64 / n as f64;
                let next = if k == n {
                    to
                } else {
                    let a = if clockwise {
                        a0 - sweep * t
                    } else {
                        a0 + sweep * t
                    };
                    [
                        centre[0] + r0 * a.cos(),
                        centre[1] + r0 * a.sin(),
                        z0 + (to[2] - z0) * t,
                    ]
                };
                push(previous, next);
                previous = next;
            }
        }
        (s.x, s.y, s.z) = (Some(to[0]), Some(to[1]), Some(to[2]));
    }

    if !s.ended {
        return Err(GcodeError {
            line: out.lines,
            message: "the program does not end with M30".into(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str =
        "(test)\nG90 G94\nG17\nG21\nM6 T7\nS12000 M3\nG54\nG0 X10.000 Y5.000\nG0 Z5.000\n";
    const FOOTER: &str = "G0 Z5.000\nM5\nG28\nM30\n";

    fn run(body: &str) -> Result<Interpreted, GcodeError> {
        interpret(&format!("{HEADER}{body}{FOOTER}"))
    }

    fn error(body: &str) -> String {
        run(body).unwrap_err().to_string()
    }

    #[test]
    fn reads_straight_moves_with_modal_position() {
        let out = run("G1 Z-1.000 F90\nG1 X30.000 F600\nG1 Y30.000\n").unwrap();
        let s = &out.segments;
        // Descent from the tool-change height, plunge, two cuts, retract.
        assert_eq!(s.len(), 5);
        assert_eq!(
            (s[0].from, s[0].to, s[0].rapid),
            ([10.0, 5.0, TOOL_CHANGE_Z], [10.0, 5.0, 5.0], true)
        );
        assert_eq!(
            (s[1].to, s[1].feed, s[1].rapid),
            ([10.0, 5.0, -1.0], 90.0, false)
        );
        assert_eq!((s[2].to, s[2].feed), ([30.0, 5.0, -1.0], 600.0));
        assert_eq!(
            (s[3].to, s[3].feed, s[3].line),
            ([30.0, 30.0, -1.0], 600.0, 12)
        );
        assert_eq!((s[4].to, s[4].rapid), ([30.0, 30.0, 5.0], true));
        assert_eq!(out.tool_changes, [7]);
        assert_eq!(s[1].tool, 7);
        assert_eq!(s[1].rpm, 12000);
    }

    #[test]
    fn measures_length_and_time() {
        let out = run("G1 Z-1.000 F100\nG1 X110.000 F600\n").unwrap();
        // 6 mm plunge at 100 and 100 mm at 600; rapids 95 mm down and 6 mm up at 2000.
        assert!((out.cutting_length() - 106.0).abs() < 1e-9);
        let minutes = 6.0 / 100.0 + 100.0 / 600.0 + 101.0 / 2000.0;
        assert!((out.minutes(2000.0) - minutes).abs() < 1e-9);
    }

    #[test]
    fn quarter_arcs_follow_the_circle() {
        // Counter-clockwise quarter from (10,5) around (10,10): ends at (15,10).
        let out = run("G1 Z-1.000 F90\nG3 X15.000 Y10.000 I0.000 J5.000 F600\n").unwrap();
        let arc: Vec<&Segment> = out.segments.iter().filter(|s| s.line == 11).collect();
        assert!(arc.len() > 4);
        assert_eq!(arc.last().unwrap().to, [15.0, 10.0, -1.0]);
        for s in &arc {
            let r = (s.to[0] - 10.0).hypot(s.to[1] - 10.0);
            assert!((r - 5.0).abs() < 1e-6);
            // Counter-clockwise from the bottom: X never decreases.
            assert!(s.to[0] >= s.from[0] - 1e-9);
        }
        let length: f64 = arc.iter().map(|s| s.length()).sum();
        assert!((length - std::f64::consts::FRAC_PI_2 * 5.0).abs() < 0.01);
    }

    #[test]
    fn clockwise_arcs_go_the_other_way() {
        // Clockwise from (10,5) around (10,10) to (15,10) is three quarters of the circle.
        let out = run("G1 Z-1.000 F90\nG2 X15.000 Y10.000 I0.000 J5.000 F600\n").unwrap();
        let length: f64 = out
            .segments
            .iter()
            .filter(|s| s.line == 11)
            .map(|s| s.length())
            .sum();
        assert!((length - 1.5 * std::f64::consts::PI * 5.0).abs() < 0.02);
    }

    #[test]
    fn an_arc_back_to_its_start_is_a_full_circle() {
        let out = run("G1 Z-1.000 F90\nG2 X10.000 Y5.000 I0.000 J5.000 F600\n").unwrap();
        let length: f64 = out
            .segments
            .iter()
            .filter(|s| s.line == 11)
            .map(|s| s.length())
            .sum();
        assert!((length - std::f64::consts::TAU * 5.0).abs() < 0.03);
    }

    #[test]
    fn helical_arcs_change_height_evenly() {
        let out = run("G1 Z0.000 F90\nG3 X15.000 Y10.000 Z-2.000 I0.000 J5.000 F600\n").unwrap();
        let arc: Vec<&Segment> = out.segments.iter().filter(|s| s.line == 11).collect();
        let mid = arc[arc.len() / 2 - 1].to[2];
        assert!((mid + 1.0).abs() < 0.2);
        assert_eq!(arc.last().unwrap().to[2], -2.0);
    }

    #[test]
    fn refuses_what_it_does_not_know() {
        assert!(error("G43 H1\n").contains("H1 is not supported"));
        assert!(error("G20\n").contains("G20 is not supported"));
        assert!(error("G81 X1.000\n").contains("G81 is not supported"));
        assert!(error("M8\n").contains("M8 is not supported"));
        assert!(error("G1 x1\n").contains("not a letter followed by a number"));
        assert!(error("G0 Y0X50\n").contains("not a letter followed by a number"));
        assert!(error("X5.000\n").contains("without a motion command"));
        assert!(error("G1 X1.000 ; note\n").contains("not a letter followed by a number"));
        assert!(error("G2 X15.000 Y10.000 R5.000\n").contains("R5.000 is not supported"));
    }

    #[test]
    fn refuses_unsafe_sequences() {
        assert!(error("G1 X20.000\n").contains("without a feed since the last rapid"));
        assert!(error("G1 X20.000 F600\nG0 Z5.000\nG1 Z-1.000\n")
            .contains("without a feed since the last rapid"));
        assert!(error("G1 X20.000 F0\n").contains("greater than 0"));
        assert!(error("M5\nG1 X20.000 F600\n").contains("spindle off"));
        assert!(error("M6 T8\n").contains("spindle is running"));
        assert!(error("T8\n").contains("without M6"));
        assert!(error("G3 X15.000 Y10.000 I0.000 J4.000 F600\n").contains("not on the circle"));
        assert!(error("G3 X15.000 Y10.000 I0.000 F600\n").contains("both I and J"));

        let no_end = interpret(&format!("{HEADER}G0 Z5.000\nM5\n")).unwrap_err();
        assert!(no_end.message.contains("M30"));
        let after_end = interpret(&format!("{HEADER}{FOOTER}G0 X1.000\n")).unwrap_err();
        assert!(after_end.message.contains("after the end"));
        let no_units = interpret("M6 T7\nS1000 M3\nG54\nG0 X1.000 Y1.000\n").unwrap_err();
        assert!(no_units.message.contains("G21"));
        let no_tool = interpret("G90 G94\nG21\nG54\nG0 X1.000 Y1.000\n").unwrap_err();
        assert!(no_tool.message.contains("before a tool was loaded"));
        let z_first = interpret("G90 G94\nG21\nM6 T7\nS1000 M3\nG54\nG0 Z5.000\n").unwrap_err();
        assert!(z_first.message.contains("both X and Y"));
    }

    #[test]
    fn reports_the_line_number() {
        assert_eq!(run("G1 Z-1.000 F90\nG99\n").unwrap_err().line, 11);
    }

    #[test]
    fn a_second_tool_starts_from_an_unknown_position_again() {
        let out = run("G1 Z-1.000 F90\nG0 Z5.000\nM5\nM6 T8\nS9000 M3\nG0 X50.000 Y50.000\nG0 Z5.000\nG1 Z-2.000 F80\n").unwrap();
        assert_eq!(out.tool_changes, [7, 8]);
        let second: Vec<&Segment> = out.segments.iter().filter(|s| s.tool == 8).collect();
        assert_eq!(second[0].from, [50.0, 50.0, TOOL_CHANGE_Z]);
        assert_eq!((second[1].to, second[1].rpm), ([50.0, 50.0, -2.0], 9000));
    }
}
