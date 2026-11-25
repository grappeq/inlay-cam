//! G-code for the Makera Carvera and Carvera Air running the Carvera
//! Community Firmware (a Smoothieware fork).
//!
//! The dialect rules below come from the firmware source and the community
//! post-processors. Each is enforced here and checked again by [`lint`]:
//!
//! - Millimetres only: `G20` halts the machine.
//! - Arcs as `G2`/`G3` with `I`/`J` in the XY plane; `R` arcs are not read. An
//!   arc may carry a `Z`: the firmware spreads the change of height evenly
//!   along it, which is how a ramp round a curve is written.
//! - No `G43`: tool length is measured automatically after `M6`.
//! - `M6` and `T` on the same line; the spindle is off after a tool change.
//! - Uppercase, words separated by spaces (`Y0X50` is misread as hex).
//! - Lines at most 128 characters; longer ones are silently dropped.
//! - Comments on their own line: text after a comment is dropped.
//! - `F` on the first cutting move after a rapid: a rapid's feed does not carry over.
//! - No homing, probing or offset commands: the controller does those before the step.
//!
//! The header has one comment line per tool, laid out as the Fusion 360 post for
//! the Carvera writes it. The community controller reads those lines to draw each
//! tool in its preview; see [`tool_comment`].

use std::fmt::Write;

use crate::toolpath::{Move, Program, ProgramTool};
use crate::tools::ToolKind;

pub const MAX_LINE_LENGTH: usize = 128;
pub const FILE_EXTENSION: &str = "cnc";

/// Reduces text to characters that cannot upset the parser, single-spaced.
fn comment_text(text: &str) -> String {
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
    clean.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The header line that describes one tool, in the layout of the Fusion 360 post
/// for the Carvera:
///
/// `(T<number>  <name>  D=<diameter> CR=<corner radius> SD=<shank> [TD=<tip>] [FL=<flutes>]
/// [TAPER=<half angle>deg] - <tool type>)`
///
/// The community controller only recognises the line with two spaces on either
/// side of the name, the fields in this order and one of Fusion's tool type names
/// at the end. `TAPER` is the angle between the tool's axis and its cutting edge.
fn tool_comment(t: &ProgramTool) -> String {
    let tool = &t.tool;
    let mut fields = format!(
        "D={} CR={} SD={}",
        number(tool.diameter),
        number(match tool.kind {
            ToolKind::CornerRound => tool.corner_radius.unwrap_or(0.0),
            ToolKind::BallEnd => tool.diameter / 2.0,
            _ => 0.0,
        }),
        number(tool.shank_diameter)
    );
    // Fusion's own names. "radius mill" is what it calls a corner-rounding bit.
    let type_name = match tool.kind {
        ToolKind::FlatEnd => "flat end mill",
        ToolKind::VBit => "chamfer mill",
        ToolKind::CornerRound => "radius mill",
        ToolKind::BallEnd => "ball end mill",
        ToolKind::Drill => "drill",
        ToolKind::ThreadMill => "thread mill",
    };
    if matches!(tool.kind, ToolKind::VBit | ToolKind::CornerRound) {
        write!(fields, " TD={}", number(tool.tip_diameter.unwrap_or(0.0))).unwrap();
    }
    if let Some(flutes) = tool.flute_length {
        write!(fields, " FL={}", number(flutes)).unwrap();
    }
    if let (ToolKind::VBit, Some(angle)) = (tool.kind, tool.tip_angle) {
        write!(fields, " TAPER={}deg", number(angle / 2.0)).unwrap();
    }
    let head = format!("T{}  ", t.number);
    let tail = format!("  {fields} - {type_name}");
    let room = (MAX_LINE_LENGTH - 2).saturating_sub(head.len() + tail.len());
    let name: String = comment_text(&tool.name).chars().take(room).collect();
    format!("({head}{}{tail})", name.trim_end())
}

/// A comment as it is written: on a line of its own, with only the
/// characters that cannot upset the parser, and no longer than a line may be.
pub fn comment_line(text: &str) -> String {
    let clean: String = comment_text(text)
        .chars()
        .take(MAX_LINE_LENGTH - 2)
        .collect();
    format!("({})", clean.trim_end())
}

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
        out.line(&tool_comment(t));
    }
    out.line("G90 G94");
    out.line("G17");
    out.line("G21");

    let mut work_offset_selected = false;
    for m in &program.moves {
        match *m {
            Move::Comment { ref text } => out.comment(text),
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
        self.line(&comment_line(text));
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
    use crate::tools::fixtures::{end_mill, v_bit};

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
(T7  D3.175x22 1F Downcut  D=3.175 CR=0 SD=3.175 FL=22 - flat end mill)
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

    /// The pattern the community controller matches a tool line against
    /// (`TOOL_LINE_RE` in its Fusion 360 parser), checked by hand here: two
    /// spaces after the number, the fields in order, a tool type at the end.
    #[test]
    fn tool_lines_are_laid_out_as_the_controller_reads_them() {
        let line = tool_comment(&ProgramTool {
            number: 2,
            tool: v_bit(),
        });
        assert_eq!(
            line,
            "(T2  60 V-groove D12 S6  D=12 CR=0 SD=6 TD=0.1 FL=15.5 TAPER=30deg - chamfer mill)"
        );

        // A long or odd name is cut to fit; the fields the controller needs stay whole.
        let mut tool = end_mill();
        tool.name = "Żółw (v2)  ".repeat(30);
        tool.flute_length = None;
        let line = tool_comment(&ProgramTool { number: 12, tool });
        assert!(line.len() <= MAX_LINE_LENGTH);
        assert!(line.is_ascii());
        assert!(line.starts_with("(T12  "));
        assert!(line.ends_with("  D=3.175 CR=0 SD=3.175 - flat end mill)"));
        assert!(!line[1..line.len() - 1].contains(['(', ')']));
        let name = &line[6..line.len() - "  D=3.175 CR=0 SD=3.175 - flat end mill)".len()];
        assert!(!name.contains("  ") && !name.ends_with(' '));
        assert_eq!(lint(&line), Vec::<String>::new());
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
