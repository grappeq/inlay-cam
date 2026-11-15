//! G-code for the Makera Carvera and Carvera Air running the Carvera
//! Community Firmware (a Smoothieware fork).
//!
//! The dialect rules below come from the firmware source and the community
//! post-processors. Each is enforced here and checked again by [`lint`]:
//!
//! - Millimetres only: `G20` halts the machine.
//! - Arcs as `G2`/`G3` with `I`/`J` in the XY plane; `R` arcs are not read.
//! - No `G43`: tool length is measured automatically after `M6`.
//! - `M6` and `T` on the same line; the spindle is off after a tool change.
//! - Uppercase, words separated by spaces (`Y0X50` is misread as hex).
//! - Lines at most 128 characters; longer ones are silently dropped.
//! - Comments on their own line: text after a comment is dropped.
//! - `F` on the first cutting move after a rapid: a rapid's feed does not carry over.
//! - No homing, probing or offset commands: the controller does those before the job.

use std::fmt::Write;

use crate::toolpath::{Move, Program};

pub const MAX_LINE_LENGTH: usize = 128;
pub const FILE_EXTENSION: &str = "cnc";

pub fn write(program: &Program) -> String {
    let mut out = Writer {
        text: String::new(),
        x: None,
        y: None,
        z: None,
        feed: None,
    };

    out.comment(&program.name);
    for t in &program.tools {
        out.comment(&format!(
            "T{} D={} - {}",
            t.number,
            number(t.tool.diameter),
            t.tool.name
        ));
    }
    out.line("G90 G94");
    out.line("G17");
    out.line("G21");

    let mut work_offset_selected = false;
    for m in &program.moves {
        match *m {
            Move::ToolChange { number } => {
                out.line(&format!("M6 T{number}"));
                // The machine moved on its own: position and feed are unknown again.
                (out.x, out.y, out.z, out.feed) = (None, None, None, None);
            }
            Move::SpindleOn { rpm } => {
                out.line(&format!("S{rpm} M3"));
                if !work_offset_selected {
                    out.line("G54");
                    work_offset_selected = true;
                }
            }
            Move::SpindleOff => out.line("M5"),
            Move::RapidXy { to } => out.motion("G0", Some(to[0]), Some(to[1]), None, None, None),
            Move::Rapid { to } => {
                out.motion("G0", Some(to[0]), Some(to[1]), Some(to[2]), None, None)
            }
            Move::Feed { to, feed } => out.motion(
                "G1",
                Some(to[0]),
                Some(to[1]),
                Some(to[2]),
                None,
                Some(feed),
            ),
            Move::Arc {
                to,
                center,
                clockwise,
                feed,
            } => {
                let (x, y) = (out.x.unwrap_or(to[0]), out.y.unwrap_or(to[1]));
                let ij = (round3(center[0]) - x, round3(center[1]) - y);
                out.motion(
                    if clockwise { "G2" } else { "G3" },
                    Some(to[0]),
                    Some(to[1]),
                    Some(to[2]),
                    Some(ij),
                    Some(feed),
                );
            }
        }
    }
    // Clearance position: Z up first, then away from the work.
    out.line("G28");
    out.line("M30");
    out.text
}

struct Writer {
    text: String,
    // Last written position and feed, as written (rounded).
    x: Option<f64>,
    y: Option<f64>,
    z: Option<f64>,
    feed: Option<f64>,
}

impl Writer {
    fn line(&mut self, line: &str) {
        debug_assert!(line.len() <= MAX_LINE_LENGTH);
        self.text.push_str(line);
        self.text.push('\n');
    }

    /// Writes a comment line. Only characters that cannot upset the parser are kept.
    fn comment(&mut self, text: &str) {
        let clean: String = text
            .chars()
            .map(|c| match c {
                'Ø' | 'ø' => 'D',
                '×' => 'x',
                '°' => ' ',
                c if c.is_ascii_alphanumeric() || " .,=+-_/:".contains(c) => c,
                _ => ' ',
            })
            .collect();
        let clean: String = clean.split_whitespace().collect::<Vec<_>>().join(" ");
        let clean: String = clean.chars().take(MAX_LINE_LENGTH - 2).collect();
        self.line(&format!("({clean})"));
    }

    /// Writes one motion line with only the axes that change. Arcs always
    /// carry X, Y, I and J.
    fn motion(
        &mut self,
        word: &str,
        x: Option<f64>,
        y: Option<f64>,
        z: Option<f64>,
        ij: Option<(f64, f64)>,
        feed: Option<f64>,
    ) {
        let (x, y, z) = (x.map(round3), y.map(round3), z.map(round3));
        let is_arc = ij.is_some();
        let mut line = String::from(word);
        if let Some(x) = x.filter(|x| is_arc || Some(*x) != self.x) {
            write!(line, " X{}", fixed3(x)).unwrap();
        }
        if let Some(y) = y.filter(|y| is_arc || Some(*y) != self.y) {
            write!(line, " Y{}", fixed3(y)).unwrap();
        }
        if let Some(z) = z.filter(|z| Some(*z) != self.z) {
            write!(line, " Z{}", fixed3(z)).unwrap();
        }
        if let Some((i, j)) = ij {
            write!(line, " I{} J{}", fixed3(i), fixed3(j)).unwrap();
        }
        if line.len() == word.len() {
            return; // nothing moves
        }
        match feed {
            Some(f) => {
                let f = (f * 10.0).round() / 10.0;
                if self.feed != Some(f) {
                    write!(line, " F{}", number(f)).unwrap();
                    self.feed = Some(f);
                }
            }
            // A rapid's speed does not carry over, so the next cut restates its feed.
            None => self.feed = None,
        }
        self.x = x.or(self.x);
        self.y = y.or(self.y);
        self.z = z.or(self.z);
        self.line(&line);
    }
}

fn round3(v: f64) -> f64 {
    let r = (v * 1000.0).round() / 1000.0;
    if r == 0.0 {
        0.0 // never "-0.000"
    } else {
        r
    }
}

fn fixed3(v: f64) -> String {
    format!("{:.3}", round3(v))
}

/// Shortest decimal form, up to 3 places: `600`, `3.175`.
fn number(v: f64) -> String {
    let s = format!("{:.3}", v);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Checks text against the firmware's parsing rules, whatever produced it.
/// Returns one message per problem, with the line number.
pub fn lint(gcode: &str) -> Vec<String> {
    let mut problems = Vec::new();
    for (index, line) in gcode.lines().enumerate() {
        let n = index + 1;
        let mut fail = |what: &str| problems.push(format!("line {n}: {what}"));
        if line.len() > MAX_LINE_LENGTH {
            fail("longer than 128 characters; the firmware would drop it");
        }
        if !line.is_ascii() {
            fail("contains a non-ASCII character");
        }
        if let Some(start) = line.find('(') {
            if start != 0 || !line.ends_with(')') || line[1..line.len() - 1].contains(['(', ')']) {
                fail("a comment must be the whole line");
            }
            continue;
        }
        if line.is_empty() {
            continue;
        }
        if line.contains([';', '#', '[', ']', '%']) {
            fail("contains a character the firmware treats specially");
        }
        if line.chars().any(|c| c.is_ascii_lowercase()) {
            fail("contains a lowercase letter");
        }
        for word in line.split(' ') {
            let mut chars = word.chars();
            let letter_ok = chars.next().is_some_and(|c| c.is_ascii_uppercase());
            let rest = chars.as_str();
            if !letter_ok || rest.is_empty() || rest.parse::<f64>().is_err() {
                fail("words must be one letter and a number, separated by single spaces");
                break;
            }
        }
        if line.starts_with('O') {
            fail("a line starting with O is read as a subroutine");
        }
        for banned in ["G20", "G43", "G81", "G82", "G83", "G30", "G92", "G10"] {
            if line.split(' ').any(|w| w == banned) {
                fail(&format!(
                    "{banned} is not supported or not safe on this firmware"
                ));
            }
        }
        if (line.contains("G2 ") || line.contains("G3 "))
            && line.split(' ').any(|w| w.starts_with('R'))
        {
            fail("arcs must use I and J, not R");
        }
        if line.split(' ').any(|w| w == "M6") != line.split(' ').any(|w| w.starts_with('T')) {
            fail("M6 and T must be on the same line");
        }
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::toolpath::ProgramTool;
    use crate::tools::fixtures::end_mill;

    fn program(moves: Vec<Move>) -> Program {
        Program {
            name: "Coaster - Flat inlay 1 - pocket".into(),
            tools: vec![ProgramTool {
                number: 7,
                tool: end_mill(),
            }],
            safe_z: 5.0,
            moves,
        }
    }

    fn sample() -> Program {
        program(vec![
            Move::ToolChange { number: 7 },
            Move::SpindleOn { rpm: 12000 },
            Move::RapidXy { to: [10.0, 5.0] },
            Move::Rapid {
                to: [10.0, 5.0, 5.0],
            },
            Move::Rapid {
                to: [10.0, 5.0, 1.0],
            },
            Move::Feed {
                to: [10.0, 5.0, -1.0],
                feed: 90.0,
            },
            Move::Feed {
                to: [30.0, 5.0, -1.0],
                feed: 600.0,
            },
            Move::Arc {
                to: [35.0, 10.0, -1.0],
                center: [30.0, 10.0],
                clockwise: false,
                feed: 600.0,
            },
            Move::Feed {
                to: [35.0, 30.0, -1.0],
                feed: 600.0,
            },
            Move::Rapid {
                to: [35.0, 30.0, 5.0],
            },
            Move::Rapid {
                to: [10.0, 5.0, 5.0],
            },
            Move::Feed {
                to: [10.0, 5.0, -2.0],
                feed: 90.0,
            },
            Move::Rapid {
                to: [10.0, 5.0, 5.0],
            },
            Move::SpindleOff,
        ])
    }

    #[test]
    fn writes_the_expected_file() {
        let expected = "\
(Coaster - Flat inlay 1 - pocket)
(T7 D=3.175 - D3.175x22 1F Downcut)
G90 G94
G17
G21
M6 T7
S12000 M3
G54
G0 X10.000 Y5.000
G0 Z5.000
G0 Z1.000
G1 Z-1.000 F90
G1 X30.000 F600
G3 X35.000 Y10.000 I0.000 J5.000
G1 Y30.000
G0 Z5.000
G0 X10.000 Y5.000
G1 Z-2.000 F90
G0 Z5.000
M5
G28
M30
";
        assert_eq!(write(&sample()), expected);
    }

    #[test]
    fn output_passes_the_firmware_lint() {
        assert_eq!(lint(&write(&sample())), Vec::<String>::new());
    }

    #[test]
    fn feed_is_restated_after_every_rapid_and_tool_change() {
        let text = write(&program(vec![
            Move::ToolChange { number: 7 },
            Move::SpindleOn { rpm: 12000 },
            Move::RapidXy { to: [0.0, 0.0] },
            Move::Rapid {
                to: [0.0, 0.0, 5.0],
            },
            Move::Feed {
                to: [0.0, 0.0, -1.0],
                feed: 600.0,
            },
            Move::Feed {
                to: [5.0, 0.0, -1.0],
                feed: 600.0,
            },
            Move::Rapid {
                to: [5.0, 0.0, 5.0],
            },
            Move::Feed {
                to: [5.0, 0.0, -1.0],
                feed: 600.0,
            },
            Move::SpindleOff,
            Move::ToolChange { number: 8 },
            Move::SpindleOn { rpm: 10000 },
            Move::RapidXy { to: [5.0, 0.0] },
            Move::Rapid {
                to: [5.0, 0.0, 5.0],
            },
            Move::Feed {
                to: [5.0, 0.0, -1.0],
                feed: 600.0,
            },
        ]));
        let with_feed: Vec<&str> = text
            .lines()
            .filter(|l| l.starts_with("G1") && l.contains(" F"))
            .collect();
        assert_eq!(
            with_feed,
            ["G1 Z-1.000 F600", "G1 Z-1.000 F600", "G1 Z-1.000 F600"]
        );
        // After the second tool change the position is unknown, so it is written in full.
        assert!(text.contains("M6 T8\nS10000 M3\nG0 X5.000 Y0.000\nG0 Z5.000\n"));
        assert_eq!(text.matches("G54").count(), 1);
    }

    #[test]
    fn tiny_negative_values_are_not_written_as_minus_zero() {
        let text = write(&program(vec![Move::Rapid {
            to: [-0.0001, 0.0, 5.0],
        }]));
        assert!(text.contains("G0 X0.000 Y0.000 Z5.000"));
    }

    #[test]
    fn comments_are_reduced_to_safe_ascii() {
        let mut p = sample();
        p.name = "Żółw (v2) #1; [x] 50%".into();
        let text = write(&p);
        let first = text.lines().next().unwrap();
        assert!(first.is_ascii());
        assert!(!first[1..first.len() - 1].contains(['(', ')', '#', ';', '[', ']', '%']));
        assert_eq!(lint(&text), Vec::<String>::new());
    }

    #[test]
    fn lint_catches_what_the_firmware_would_misread() {
        let cases = [
            ("G0 Y0X50", "single spaces"),
            ("g0 x1", "lowercase"),
            ("G20", "G20"),
            ("G43 H1", "G43"),
            ("G1 X1 (note) Y2", "comment must be the whole line"),
            ("G2 X1 Y1 R5", "I and J"),
            ("M6", "same line"),
            ("T1", "same line"),
            ("O1000", "subroutine"),
            ("G1 X1 ; note", "specially"),
        ];
        for (line, expected) in cases {
            let problems = lint(line);
            assert!(
                problems.iter().any(|p| p.contains(expected)),
                "{line:?} gave {problems:?}"
            );
        }
        let long = format!("G1 X1.000 {}", "Y1.000 ".repeat(20));
        assert!(lint(long.trim_end())[0].contains("128"));
    }
}
