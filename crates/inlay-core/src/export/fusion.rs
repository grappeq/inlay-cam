//! A tool list as a Fusion 360 tool library (`.json`). Field names and
//! allowed values follow Autodesk's tool library schema. Every tool is
//! written, whatever Makera libraries it goes into, and every cutting row is
//! a preset: per material the plain row first, then its rows on profiles.

use super::{fusion_guid, json_text, quoted, round_to, rows_by_material, Entry, Row, Spec};
use crate::feeds::g;
use crate::tools::ToolLibrary;

/// The schema asks for at least 11; Autodesk's sample metric library with presets uses 14.
const LIBRARY_VERSION: i64 = 14;
/// Flute length when unknown: this many diameters.
const PLACEHOLDER_FLUTE_FACTOR: f64 = 3.0;
/// Overall length when unknown: the shoulder and this much, mm.
const PLACEHOLDER_STICK_OUT: f64 = 20.0;
/// Degrees. Required by the schema; Fusion's usual default.
const RAMP_ANGLE: f64 = 2.0;

/// A piece of JSON whose maps keep the order they are built in.
#[derive(Clone)]
enum J {
    Map(Vec<(&'static str, J)>),
    List(Vec<J>),
    Text(String),
    Int(i64),
    /// Always written with a decimal point.
    Float(f64),
    Bool(bool),
}

fn text(value: &str) -> J {
    J::Text(value.to_string())
}

/// A whole number as one, anything else rounded to four places.
fn num(value: f64) -> J {
    let value = round_to(value, 4);
    if value.fract() == 0.0 {
        J::Int(value as i64)
    } else {
        J::Float(value)
    }
}

fn write_json(out: &mut String, value: &J, indent: usize) {
    let pad = |out: &mut String, n: usize| out.push_str(&" ".repeat(n));
    match value {
        J::Map(entries) if entries.is_empty() => out.push_str("{}"),
        J::Map(entries) => {
            out.push_str("{\n");
            for (i, (key, item)) in entries.iter().enumerate() {
                pad(out, indent + 2);
                out.push_str(&json_text(key));
                out.push_str(": ");
                write_json(out, item, indent + 2);
                out.push_str(if i + 1 < entries.len() { ",\n" } else { "\n" });
            }
            pad(out, indent);
            out.push('}');
        }
        J::List(items) if items.is_empty() => out.push_str("[]"),
        J::List(items) => {
            out.push_str("[\n");
            for (i, item) in items.iter().enumerate() {
                pad(out, indent + 2);
                write_json(out, item, indent + 2);
                out.push_str(if i + 1 < items.len() { ",\n" } else { "\n" });
            }
            pad(out, indent);
            out.push(']');
        }
        J::Text(value) => out.push_str(&json_text(value)),
        J::Int(value) => out.push_str(&value.to_string()),
        J::Float(value) => out.push_str(&format!("{value:?}")),
        J::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
    }
}

/// Flute, shoulder and overall length, with a stand-in for each that is not
/// known and a warning about it. Overall is never under the shoulder, the
/// shoulder never under the flutes, and no known value is lowered.
fn lengths(entry: &Entry, warnings: &mut Vec<String>) -> (f64, f64, f64) {
    let s = &entry.shape;
    let (mut flute, mut shoulder, mut overall) = (s.flute_length, s.shoulder_length, s.length);
    let mut notes = Vec::new();
    if flute <= 0.0 {
        flute = s.diameter * PLACEHOLDER_FLUTE_FACTOR;
        if overall > 0.0 {
            flute = flute.min(overall);
        }
        shoulder = flute.max(shoulder);
        notes.push(format!(
            "has no flute_length; written as {} mm ({} x diameter), shoulder {} mm",
            g(flute),
            g(PLACEHOLDER_FLUTE_FACTOR),
            g(shoulder)
        ));
    }
    shoulder = flute.max(shoulder);
    if overall <= 0.0 {
        overall = shoulder + PLACEHOLDER_STICK_OUT;
        notes.push(format!(
            "has no length; overall length written as {} mm (shoulder + {} mm)",
            g(overall),
            g(PLACEHOLDER_STICK_OUT)
        ));
    } else if overall < shoulder {
        notes.push(format!(
            "length {} mm is shorter than its shoulder; overall length written as {} mm",
            g(overall),
            g(shoulder)
        ));
        overall = shoulder;
    }
    for note in notes {
        warnings.push(format!("Fusion 360: {} {note}", quoted(&entry.tool.name)));
    }
    (flute, shoulder, overall)
}

/// A tool's geometry, its cutting diameter and its flutes, as written.
fn geometry(entry: &Entry, kind: &str, warnings: &mut Vec<String>) -> (J, f64, i64, f64) {
    let s = &entry.shape;
    let (flute, shoulder, overall) = lengths(entry, warnings);
    let mut flutes = s.flutes as i64;
    if flutes <= 0 {
        flutes = 1;
        warnings.push(format!(
            "Fusion 360: {} has no flutes; written as 1",
            quoted(&entry.tool.name)
        ));
    }
    let mut dc = s.diameter;
    let mut extra: Vec<(&'static str, J)> = Vec::new();
    // Required by the schema for the mill types: the shoulder is as wide as the cutter's body.
    if kind != "drill" {
        extra.push(("shoulder-diameter", num(s.diameter)));
    }
    match kind {
        "radius mill" => {
            // Fusion's radius mill is measured at its pilot; the corner radius makes up the rest.
            dc = s.tip_diameter;
            extra.push(("RE", num((s.diameter - dc) / 2.0)));
            extra.push(("tip-length", J::Int(0)));
        }
        "chamfer mill" => {
            extra.push(("TA", num(s.tip_angle / 2.0)));
            extra.push(("tip-diameter", num(s.tip_diameter)));
        }
        "drill" => extra.push(("SIG", num(s.tip_angle))),
        "thread mill" => {
            extra.push(("NT", J::Int(1)));
            if s.pitch > 0.0 {
                extra.push(("TP", num(s.pitch)));
            } else {
                warnings.push(format!(
                    "Fusion 360: {} has no pitch; thread pitch left out",
                    quoted(&entry.tool.name)
                ));
            }
            let angle = if s.tip_angle > 0.0 { s.tip_angle } else { 60.0 };
            extra.push(("thread-profile-angle", num(angle)));
            extra.push(("thread-tip-type", text("point")));
        }
        _ => {}
    }
    let mut map = vec![
        ("CSP", J::Bool(false)),
        ("DC", num(dc)),
        ("HAND", J::Bool(true)),
        // The body below the holder; with no holder known, the whole tool.
        ("LB", num(overall)),
        ("LCF", num(flute)),
        ("NOF", J::Int(flutes)),
        ("OAL", num(overall)),
        ("SFDM", num(s.shank_diameter)),
        ("shoulder-length", num(shoulder)),
        // Required by the schema. No holder is known, so the gauge length is the whole tool.
        ("assemblyGaugeLength", num(overall)),
    ];
    map.extend(extra);
    (J::Map(map), dc, flutes, round_to(flute, 4))
}

/// One cutting preset, with every field the schema requires for its kind
/// of tool. A drill takes a hole-making preset: plunge and retract only.
fn preset(spec: &Spec, entry: &Entry, row: &Row, dc: f64, flutes: i64, kind: &str) -> J {
    let n = f64::from(row.rpm);
    let mut name = spec.material_label(row.material);
    let mut parts = vec!["preset", entry.tool.name.as_str(), row.material];
    if let Some(profile) = row.profile {
        // Keyed by the profile's key, so renaming it keeps the preset's guid.
        name.push_str(&format!(" \u{2013} {}", spec.profile_label(profile)));
        parts.push(profile);
    }
    let feed = J::Int(i64::from(row.feed));
    let plunge = || J::Int(i64::from(row.plunge));
    let mut map = vec![
        ("guid", J::Text(fusion_guid(&parts))),
        ("name", J::Text(name)),
        // Not tied to Fusion's stock materials: every preset shows for every stock.
        (
            "material",
            J::Map(vec![
                ("category", text("all")),
                ("query", text("")),
                ("use-hardness", J::Bool(false)),
            ]),
        ),
        // The machine cuts dry.
        ("tool-coolant", text("disabled")),
        ("n", J::Int(i64::from(row.rpm))),
        (
            "v_c",
            J::Float(round_to(std::f64::consts::PI * dc * n / 1000.0, 3)),
        ),
    ];
    if kind == "drill" {
        // A drill only plunges, so its feed per revolution comes from the plunge rate.
        map.extend([
            ("use-feed-per-revolution", J::Bool(false)),
            ("f_n", J::Float(round_to(f64::from(row.plunge) / n, 4))),
            ("v_f_plunge", plunge()),
            ("v_f_retract", plunge()),
        ]);
        return J::Map(map);
    }
    let per_rev = f64::from(row.feed) / n;
    let same = |_: ()| J::Int(i64::from(row.feed));
    map.extend([
        ("n_ramp", J::Int(i64::from(row.rpm))),
        ("ramp-angle", J::Float(RAMP_ANGLE)),
        ("f_n", J::Float(round_to(per_rev, 4))),
        ("f_z", J::Float(round_to(per_rev / flutes as f64, 4))),
        ("v_f", feed),
        ("v_f_leadIn", same(())),
        ("v_f_leadOut", same(())),
        ("v_f_ramp", same(())),
        ("v_f_transition", same(())),
        ("v_f_plunge", plunge()),
        ("stepover", num(row.stepover_mm)),
        ("stepdown", num(row.stepdown)),
        ("use-stepover", J::Bool(true)),
        ("use-stepdown", J::Bool(true)),
    ]);
    J::Map(map)
}

/// The shop a tool came from, where its product page says so. One shop is
/// known, as in the tooling library; any other address gives no vendor.
fn vendor(url: &str) -> &'static str {
    let rest = url.split_once("://").map_or("", |(_, rest)| rest);
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default()
        .split(':')
        .next()
        .unwrap_or_default()
        .trim_end_matches('.')
        .to_lowercase();
    if host == "kortools.pl" || host.ends_with(".kortools.pl") {
        "Kortools"
    } else {
        ""
    }
}

struct Written<'a> {
    entry: &'a Entry<'a>,
    record: J,
    flute: f64,
}

fn tool<'a>(spec: &Spec, entry: &'a Entry<'a>, warnings: &mut Vec<String>) -> Written<'a> {
    let kind = entry.fusion_type();
    let (geometry, dc, flutes, flute) = geometry(entry, kind, warnings);
    let source = entry.tool.source.as_ref();
    let number = i64::from(entry.number);
    let presets = rows_by_material(&entry.rows)
        .into_iter()
        .flat_map(|(_, plain, tagged)| plain.into_iter().chain(tagged))
        .map(|row| preset(spec, entry, row, dc, flutes, kind))
        .collect();
    let record = J::Map(vec![
        ("guid", J::Text(fusion_guid(&["tool", &entry.tool.name]))),
        ("type", text(kind)),
        ("unit", text("millimeters")),
        ("description", text(&entry.shown_name)),
        (
            "vendor",
            text(vendor(
                source.and_then(|s| s.url.as_deref()).unwrap_or_default(),
            )),
        ),
        (
            "product-id",
            text(
                source
                    .and_then(|s| s.size_note.as_deref())
                    .unwrap_or_default(),
            ),
        ),
        (
            "product-link",
            text(source.and_then(|s| s.url.as_deref()).unwrap_or_default()),
        ),
        ("BMC", text("carbide")),
        ("GRADE", text("Mill Generic")),
        ("geometry", geometry),
        (
            "post-process",
            J::Map(vec![
                ("number", J::Int(number)),
                ("diameter-offset", J::Int(number)),
                ("length-offset", J::Int(number)),
                ("turret", J::Int(0)),
                ("comment", J::Text(entry.group.join("/"))),
                ("break-control", J::Bool(false)),
                ("manual-tool-change", J::Bool(false)),
                ("live", J::Bool(true)),
            ]),
        ),
        ("start-values", J::Map(vec![("presets", J::List(presets))])),
    ]);
    Written {
        entry,
        record,
        flute,
    }
}

/// Top-level groups in the order the list names them: a library's sections.
fn sections(spec: &Spec) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (path, _) in &spec.groups {
        if !out.contains(&path[0]) {
            out.push(path[0].clone());
        }
    }
    out
}

fn library_text(records: Vec<J>) -> String {
    let mut out = String::new();
    let library = J::Map(vec![
        ("data", J::List(records)),
        ("version", J::Int(LIBRARY_VERSION)),
    ]);
    write_json(&mut out, &library, 0);
    out.push('\n');
    out
}

/// A name as a file name that is safe on Windows.
fn clean_stem(name: &str) -> String {
    // Invisible characters, which could make one name read as another, are dropped.
    let invisible = |c: char| matches!(c, '\u{ad}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{feff}');
    let unsafe_char = |c: char| "<>:\"/\\|?*".contains(c) || (c as u32) < 0x20 || c as u32 == 0x7f;
    let cleaned: String = name
        .chars()
        .filter(|c| !invisible(*c))
        .map(|c| if unsafe_char(c) { '_' } else { c })
        .collect();
    let mut stem: String = cleaned.trim().chars().take(100).collect();
    while stem.len() > 200 {
        stem.pop();
    }
    let stem = stem.trim_end_matches(['.', ' ']);
    if stem.is_empty() {
        "Tools".into()
    } else {
        stem.into()
    }
}

/// `<section>.json` for each section, unique whatever the case of letters.
fn section_filenames(names: &[String]) -> Vec<String> {
    const RESERVED: [&str; 6] = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];
    let reserved = |stem: &str| {
        let head = stem
            .split('.')
            .next()
            .unwrap_or_default()
            .trim_end()
            .to_uppercase();
        RESERVED.contains(&head.as_str())
            || (head.chars().count() == 4
                && (head.starts_with("COM") || head.starts_with("LPT"))
                && head
                    .chars()
                    .last()
                    .is_some_and(|c| c.is_ascii_digit() || "\u{b9}\u{b2}\u{b3}".contains(c)))
    };
    let mut out = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for name in names {
        let mut stem = clean_stem(name);
        if reserved(&stem) {
            stem = format!("_{stem}");
        }
        let mut candidate = stem.clone();
        let mut n = 2;
        while seen.contains(&candidate.to_lowercase()) {
            candidate = format!("{stem} ({n})");
            n += 1;
        }
        seen.push(candidate.to_lowercase());
        out.push(format!("{candidate}.json"));
    }
    out
}

/// What a tool list comes to for Fusion 360.
pub struct Fusion {
    /// One library with every tool: section by section (top-level group),
    /// and within each by diameter, flute length and name.
    pub library: String,
    /// The same tools as one library per top-level group, with a file name
    /// for each: separate libraries are the only folders Fusion's has.
    pub sections: Vec<(String, String)>,
    pub warnings: Vec<String>,
    pub tools: usize,
    pub presets: usize,
}

pub fn build_fusion(library: &ToolLibrary) -> Fusion {
    let spec = Spec::new(library);
    let mut warnings = spec.notes.clone();
    let names = sections(&spec);
    let mut written: Vec<Written> = spec
        .tools
        .iter()
        .map(|entry| tool(&spec, entry, &mut warnings))
        .collect();
    let section_of = |entry: &Entry| names.iter().position(|n| *n == entry.group[0]);
    written.sort_by(|a, b| {
        section_of(a.entry)
            .cmp(&section_of(b.entry))
            .then(a.entry.shape.diameter.total_cmp(&b.entry.shape.diameter))
            .then(a.flute.total_cmp(&b.flute))
            .then(a.entry.tool.name.cmp(&b.entry.tool.name))
    });
    let tools = written.len();
    let presets = spec.tools.iter().map(|t| t.rows.len()).sum();

    let mut by_section: Vec<Vec<J>> = names.iter().map(|_| Vec::new()).collect();
    let mut all = Vec::new();
    for w in written {
        by_section[section_of(w.entry).unwrap_or(0)].push(w.record.clone());
        all.push(w.record);
    }
    let kept: Vec<(String, Vec<J>)> = names
        .into_iter()
        .zip(by_section)
        .filter(|(_, records)| !records.is_empty())
        .collect();
    let files = section_filenames(&kept.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>());
    Fusion {
        library: library_text(all),
        sections: files
            .into_iter()
            .zip(kept)
            .map(|(file, (_, records))| (file, library_text(records)))
            .collect(),
        warnings,
        tools,
        presets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_one_known_shop_is_named_as_the_vendor() {
        for (url, name) in [
            ("https://kortools.pl/produkt/x", "Kortools"),
            ("https://www.kortools.pl:443/x?y=1", "Kortools"),
            ("https://notkortools.pl/x", ""),
            ("https://example.com/mill/6", ""),
            ("not an address", ""),
            ("", ""),
        ] {
            assert_eq!(vendor(url), name, "{url}");
        }
    }

    #[test]
    fn section_files_are_safe_and_distinct() {
        let names: Vec<String> = ["End mills", "end mills", "A/B: C?", "CON", "com1.x", " . "]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(
            section_filenames(&names),
            [
                "End mills.json",
                "end mills (2).json",
                "A_B_ C_.json",
                "_CON.json",
                "_com1.x.json",
                "Tools.json"
            ]
        );
    }

    #[test]
    fn numbers_are_written_as_the_tooling_library_writes_them() {
        let mut out = String::new();
        write_json(
            &mut out,
            &J::Map(vec![
                ("a", num(12.0)),
                ("b", num(0.123456)),
                ("c", J::Float(12.0)),
                ("d", J::List(vec![])),
                ("e", text("Ø – \"x\"")),
            ]),
            0,
        );
        assert_eq!(
            out,
            "{\n  \"a\": 12,\n  \"b\": 0.1235,\n  \"c\": 12.0,\n  \"d\": [],\n  \"e\": \"\\u00d8 \\u2013 \\\"x\\\"\"\n}"
        );
    }
}
