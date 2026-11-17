//! A tool list written for other programs: the libraries of Makera CAM and
//! Makera Studio (`.tlslibrary`) and of Fusion 360 (`.json`). They are made
//! as the tooling library makes them from a `tools.yaml` of the same tools,
//! byte for byte; `tests/fixtures/export-*` hold what its generators wrote
//! for a made-up list.

pub mod fusion;
pub mod makera;
pub mod qdata;

use crate::naming::display_name;
use crate::tools::{
    AppIds, CuttingSettings, FusionType, MakeraApp, MaterialInfo, StepoverUnit, Tool, ToolKind,
    ToolLibrary,
};

/// Rounds as the decimal expansion of the number says, ties to even.
pub(crate) fn round_to(value: f64, decimals: usize) -> f64 {
    format!("{value:.decimals$}").parse().unwrap_or(value)
}

/// A number with at most `decimals` places and none it does not need.
pub(crate) fn shown(value: f64, decimals: usize) -> String {
    let text = format!("{value:.decimals$}");
    if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        text
    }
}

/// A name in single quotes, as the tooling library's messages have it.
pub(crate) fn quoted(text: &str) -> String {
    if text.contains('\'') && !text.contains('"') {
        format!("\"{}\"", text.replace('\\', "\\\\"))
    } else {
        format!("'{}'", text.replace('\\', "\\\\").replace('\'', "\\'"))
    }
}

// ---- Ids that stay the same from one export to the next ----

fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&(data.len() as u64 * 8).to_be_bytes());
    for block in message.as_chunks::<64>().0 {
        let mut w = [0u32; 80];
        for (i, word) in block.as_chunks::<4>().0.iter().enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, word) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | (!b & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let next = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = next;
        }
        for (sum, value) in h.iter_mut().zip([a, b, c, d, e]) {
            *sum = sum.wrapping_add(value);
        }
    }
    let mut out = [0u8; 20];
    for (i, word) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

/// The namespace of every derived id: the tooling library's, so that a list
/// moved from it keeps its ids.
const ID_NAMESPACE: [u8; 16] = [
    0x5f, 0x0b, 0x8f, 0x39, 0x2a, 0x51, 0x4f, 0x63, 0x9a, 0x43, 0x7d, 0x1b, 0x6c, 0x3e, 0x9a, 0x10,
];

/// A name-based UUID (version 5) in the namespace above.
fn uuid5(name: &str) -> String {
    let mut data = ID_NAMESPACE.to_vec();
    data.extend_from_slice(name.as_bytes());
    let digest = sha1(&data);
    let mut b = [0u8; 16];
    b.copy_from_slice(&digest[..16]);
    b[6] = (b[6] & 0x0f) | 0x50;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// A list of texts as JSON on one line, anything beyond ASCII escaped: what
/// an id is derived from, so that parts stay apart even when a name has a
/// "/" in it.
fn json_list(parts: &[&str]) -> String {
    let items: Vec<String> = parts.iter().map(|part| json_text(part)).collect();
    format!("[{}]", items.join(", "))
}

/// A text as a JSON string with everything beyond ASCII escaped.
pub(crate) fn json_text(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || (c as u32) > 0x7e && (c as u32) != 0x7f => {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{unit:04x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The id something gets in one app's library unless the list pins one.
pub(crate) fn stable_id(app: &str, kind: &str, parts: &[&str]) -> String {
    let mut all = vec![app, kind];
    all.extend_from_slice(parts);
    format!("{{{}}}", uuid5(&json_list(&all)))
}

/// A Fusion 360 guid: bare and lower case, as its presets' are.
pub(crate) fn fusion_guid(parts: &[&str]) -> String {
    let mut all = vec!["fusion"];
    all.extend_from_slice(parts);
    uuid5(&json_list(&all))
}

// ---- The list as the generators read it ----

/// The group a tool without one is filed under.
pub fn kind_group(kind: ToolKind) -> &'static str {
    match kind {
        ToolKind::FlatEnd => "End mills",
        ToolKind::BallEnd => "Ball end mills",
        ToolKind::VBit => "V-bits",
        ToolKind::CornerRound => "Corner-rounding bits",
        ToolKind::Drill => "Drills",
        ToolKind::ThreadMill => "Thread mills",
    }
}

/// A tool's shape with every size it does not give filled in as the Makera
/// apps store it: 0 for unknown, the body's diameter for a tip or shank.
pub(crate) struct Shape {
    pub diameter: f64,
    pub tip_diameter: f64,
    pub shank_diameter: f64,
    pub length: f64,
    pub flutes: f64,
    pub tip_angle: f64,
    pub flute_length: f64,
    pub shoulder_length: f64,
    pub studio_unknown_1: f64,
    pub thread_diameter: f64,
    pub pitch: f64,
    pub drill_diameter: f64,
}

pub(crate) struct Row<'a> {
    pub row: &'a CuttingSettings,
    pub material: &'a str,
    pub profile: Option<&'a str>,
    pub rpm: u32,
    pub feed: u32,
    pub plunge: u32,
    pub stepover_mm: f64,
    pub stepover_pct: f64,
    pub stepdown: f64,
}

pub(crate) struct Entry<'a> {
    pub tool: &'a Tool,
    pub group: Vec<String>,
    pub number: u32,
    pub type_code: u32,
    pub apps: Vec<MakeraApp>,
    pub shown_name: String,
    pub shape: Shape,
    pub rows: Vec<Row<'a>>,
}

impl Entry<'_> {
    /// The Fusion 360 type of the tool.
    pub fn fusion_type(&self) -> &'static str {
        match self.tool.kind {
            ToolKind::FlatEnd => "flat end mill",
            ToolKind::BallEnd => "ball end mill",
            ToolKind::Drill => "drill",
            ToolKind::ThreadMill => "thread mill",
            ToolKind::CornerRound => "radius mill",
            ToolKind::VBit => match self.tool.fusion_type {
                Some(FusionType::RadiusMill) => "radius mill",
                Some(FusionType::ChamferMill) => "chamfer mill",
                None => {
                    let name = self.tool.name.to_lowercase();
                    let named = ["fillet", "corner round", "radius"]
                        .iter()
                        .any(|word| name.contains(word));
                    if named
                        && 0.0 < self.shape.tip_diameter
                        && self.shape.tip_diameter < self.shape.diameter
                    {
                        "radius mill"
                    } else {
                        "chamfer mill"
                    }
                }
            },
        }
    }
}

/// One material record of an app: its id there, its name, and for Makera
/// Studio what else it stores.
pub(crate) struct Record<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub category_id: Option<&'a str>,
    pub modified: Option<&'a str>,
    pub builtin: bool,
}

pub(crate) struct Spec<'a> {
    pub library: &'a ToolLibrary,
    /// Every group and the groups above it, in the order the list first
    /// names them, with the ids pinned for them.
    pub groups: Vec<(Vec<String>, Option<&'a AppIds>)>,
    pub tools: Vec<Entry<'a>>,
    /// What had to be changed to fit the formats, such as a feed that is
    /// not a whole number.
    pub notes: Vec<String>,
}

fn whole(value: f64, what: &str, tool: &str, notes: &mut Vec<String>) -> u32 {
    let rounded = value.round().max(1.0);
    if rounded != value {
        notes.push(format!(
            "{}: {what} {} written as {} (the libraries hold whole numbers)",
            quoted(tool),
            shown(value, 4),
            rounded
        ));
    }
    rounded as u32
}

impl<'a> Spec<'a> {
    pub fn new(library: &'a ToolLibrary) -> Self {
        let mut groups: Vec<(Vec<String>, Option<&AppIds>)> = Vec::new();
        fn add<'g>(
            groups: &mut Vec<(Vec<String>, Option<&'g AppIds>)>,
            path: &[String],
            ids: Option<&'g AppIds>,
        ) {
            for depth in 1..=path.len() {
                if !groups.iter().any(|(p, _)| p[..] == path[..depth]) {
                    groups.push((path[..depth].to_vec(), None));
                }
            }
            if let (Some(ids), Some(entry)) = (ids, groups.iter_mut().find(|(p, _)| p[..] == *path))
            {
                entry.1 = Some(ids);
            }
        }
        let split = |text: &str| -> Vec<String> {
            text.split('/')
                .map(|part| part.trim().to_string())
                .collect()
        };
        for group in &library.groups {
            add(&mut groups, &split(&group.path), group.ids.as_ref());
        }

        let mut notes = Vec::new();
        let mut tools = Vec::new();
        for tool in &library.tools {
            let group = split(tool.group.as_deref().unwrap_or(kind_group(tool.kind)));
            add(&mut groups, &group, None);
            let d = tool.diameter;
            let flute_length = tool.flute_length.unwrap_or(0.0);
            let shape = Shape {
                diameter: d,
                tip_diameter: tool.tip_diameter.unwrap_or(d),
                shank_diameter: tool.shank_diameter,
                length: tool.length.unwrap_or(0.0),
                flutes: tool.flutes.map_or(0.0, f64::from),
                // The quarter circle of a corner-rounding bit is stored as the 90° cone of its height.
                tip_angle: tool
                    .tip_angle
                    .unwrap_or(if tool.kind == ToolKind::CornerRound {
                        90.0
                    } else {
                        0.0
                    }),
                flute_length,
                shoulder_length: tool.shoulder_length.unwrap_or(flute_length),
                studio_unknown_1: tool.studio_unknown_1.unwrap_or(0.0),
                thread_diameter: tool.thread_diameter.unwrap_or(0.0),
                pitch: tool.pitch.unwrap_or(0.0),
                drill_diameter: tool.drill_diameter.unwrap_or(0.0),
            };
            let rows = tool
                .cutting
                .iter()
                .map(|row| {
                    let (stepover_mm, stepover_pct) = match row.stepover_unit {
                        StepoverUnit::Mm => (row.stepover, round_to(row.stepover / d * 100.0, 3)),
                        StepoverUnit::Percent => {
                            let pct = (row.stepover / d * 100_000.0).round() / 1000.0;
                            (round_to(pct * d / 100.0, 4), pct)
                        }
                    };
                    Row {
                        row,
                        material: row.material.key(),
                        profile: row.profile.as_deref(),
                        rpm: row.rpm,
                        feed: whole(row.feed, "feed", &tool.name, &mut notes),
                        plunge: whole(row.plunge, "plunge", &tool.name, &mut notes),
                        stepover_mm,
                        stepover_pct,
                        stepdown: row.stepdown,
                    }
                })
                .collect();
            let apps = [MakeraApp::Cam, MakeraApp::Studio]
                .into_iter()
                .filter(|app| tool.apps.as_ref().is_none_or(|apps| apps.contains(app)))
                .collect();
            tools.push(Entry {
                tool,
                group,
                number: tool.number.unwrap_or(1),
                type_code: match tool.kind {
                    ToolKind::BallEnd => 0,
                    ToolKind::FlatEnd => 1,
                    ToolKind::VBit | ToolKind::CornerRound => 3,
                    ToolKind::Drill => 5,
                    ToolKind::ThreadMill => 6,
                },
                apps,
                shown_name: display_name(&tool.name, tool.coating.as_deref()),
                shape,
                rows,
            });
        }
        Spec {
            library,
            groups,
            tools,
            notes,
        }
    }

    pub fn material(&self, key: &str) -> Option<&'a MaterialInfo> {
        self.library.materials.iter().find(|m| m.key.key() == key)
    }

    /// A material's records in one app; none when it is not tied to one there.
    pub fn records(&self, key: &str, app: MakeraApp) -> Vec<Record<'a>> {
        let Some(info) = self.material(key) else {
            return Vec::new();
        };
        match app {
            MakeraApp::Cam => info
                .cam
                .iter()
                .map(|c| Record {
                    id: &c.id,
                    name: &c.name,
                    category_id: None,
                    modified: None,
                    builtin: true,
                })
                .collect(),
            MakeraApp::Studio => info
                .studio
                .iter()
                .map(|s| Record {
                    id: &s.id,
                    name: &s.name,
                    category_id: Some(&s.category_id),
                    modified: s.modified.as_deref(),
                    builtin: s.builtin.unwrap_or(true),
                })
                .collect(),
        }
    }

    /// What a material is called: its name in Makera CAM, else its one name
    /// in Makera Studio, else its own.
    pub fn material_label(&self, key: &str) -> String {
        let info = self.material(key);
        if let Some(cam) = info.and_then(|m| m.cam.as_ref()) {
            return cam.name.clone();
        }
        if let Some([only]) = info.map(|m| &m.studio[..]) {
            return only.name.clone();
        }
        if let Some(label) = info.and_then(|m| m.label.clone()) {
            return label;
        }
        // The key with each word capitalised.
        key.split('_')
            .map(|word| {
                let mut chars = word.chars();
                match chars.next() {
                    Some(first) => {
                        first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
                    }
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn profile_label(&self, key: &str) -> String {
        self.library
            .profile(key)
            .map_or(key.to_string(), |p| p.label.clone())
    }
}

/// A tool's rows by material, in the order the materials are first used:
/// the plain row if there is one, and the rows on profiles.
pub(crate) fn rows_by_material<'r, 'a>(
    rows: &'r [Row<'a>],
) -> Vec<(&'a str, Option<&'r Row<'a>>, Vec<&'r Row<'a>>)> {
    let mut out: Vec<(&str, Option<&Row>, Vec<&Row>)> = Vec::new();
    for row in rows {
        let at = match out.iter().position(|(m, _, _)| *m == row.material) {
            Some(at) => at,
            None => {
                out.push((row.material, None, Vec::new()));
                out.len() - 1
            }
        };
        if row.profile.is_some() {
            out[at].2.push(row);
        } else if out[at].1.is_none() {
            out[at].1 = Some(row);
        }
    }
    out
}

/// The one row per material the Makera apps get, and whether it is a
/// fallback: the plain row, else the material's first row on a profile,
/// which they may run as a full-width slot.
pub(crate) fn effective_rows<'r, 'a>(rows: &'r [Row<'a>]) -> Vec<(&'r Row<'a>, bool)> {
    rows_by_material(rows)
        .into_iter()
        .filter_map(|(_, plain, tagged)| match plain {
            Some(row) => Some((row, false)),
            None => tagged.first().map(|row| (*row, true)),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_and_the_ids_derived_with_it() {
        let hex = |d: [u8; 20]| d.iter().map(|b| format!("{b:02x}")).collect::<String>();
        assert_eq!(
            hex(sha1(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(hex(sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        // Longer than one block.
        assert_eq!(
            hex(sha1(&[b'a'; 200])),
            "e61cfffe0d9195a525fc6cf06ca2d77119c24a40"
        );
        assert_eq!(
            json_list(&["cam", "tool", "Ø6×18 \"x\""]),
            "[\"cam\", \"tool\", \"\\u00d86\\u00d718 \\\"x\\\"\"]"
        );
        let id = stable_id("cam", "tool", &["Ø6×18 3F Alu"]);
        assert_eq!((id.len(), &id[..1], &id[15..16]), (38, "{", "5"));
    }

    #[test]
    fn numbers_and_names_as_the_messages_show_them() {
        assert_eq!(round_to(2.675, 2), 2.67);
        assert_eq!(round_to(0.125, 2), 0.12);
        assert_eq!(
            (shown(12.0, 4), shown(3.6250, 3), shown(0.1, 0)),
            ("12".into(), "3.625".into(), "0".into())
        );
        assert_eq!(quoted("Ø6"), "'Ø6'");
        assert_eq!(quoted("it's"), "\"it's\"");
    }

    const LIBRARY: &str = include_str!("../../tests/fixtures/export-library.json");
    const EXPECTED: &str = include_str!("../../tests/fixtures/export-expected.json");
    const CAM: &[u8] = include_bytes!("../../tests/fixtures/export-makera-cam.tlslibrary");
    const STUDIO: &[u8] = include_bytes!("../../tests/fixtures/export-makera-studio.tlslibrary");
    const FUSION: &str = include_str!("../../tests/fixtures/export-fusion.json");

    fn fixture() -> ToolLibrary {
        crate::tools::library_from_file_json(LIBRARY).unwrap()
    }

    fn expected(key: &str) -> Vec<String> {
        let all: serde_json::Value = serde_json::from_str(EXPECTED).unwrap();
        serde_json::from_value(all[key].clone()).unwrap()
    }

    /// The same warnings, in the same order, as the tooling library gives. Two
    /// kinds are worded for this app, which has no "mapping" and no
    /// "slot-safe row"; the rest are word for word.
    fn same_warnings(got: &[String], want: &[String]) {
        assert_eq!(got.len(), want.len(), "{got:#?}\n{want:#?}");
        for (g, w) in got.iter().zip(want) {
            if w.contains(": skipped ") {
                assert!(
                    g.contains(" left out: the material is not tied"),
                    "{g} / {w}"
                );
            } else if w.contains("(no slot-safe row)") {
                assert!(
                    g.contains(", for want of a plain one: it may be run as a full slot"),
                    "{g} / {w}"
                );
            } else {
                assert_eq!(g, w);
            }
            // The same tool in both.
            assert_eq!(g.split('\'').nth(1), w.split('\'').nth(1));
        }
    }

    /// Where two byte strings first differ, with what is around it.
    fn first_difference(got: &[u8], want: &[u8]) -> String {
        let at = got
            .iter()
            .zip(want)
            .position(|(a, b)| a != b)
            .unwrap_or(got.len().min(want.len()));
        let from = at.saturating_sub(24);
        let show = |b: &[u8]| {
            String::from_utf8_lossy(&b[from.min(b.len())..(at + 24).min(b.len())]).into_owned()
        };
        format!(
            "lengths {} and {}, first differ at {at}: got {:?}, want {:?}",
            got.len(),
            want.len(),
            show(got),
            show(want)
        )
    }

    /// The fixtures are what the tooling library's own generators write for
    /// the `tools.yaml` this app writes for the made-up list. To make them
    /// again: run this test with `INLAY_EXPORT_YAML_OUT=path` to get that
    /// file, then the tooling library's generators on it.
    #[test]
    fn the_libraries_are_the_tooling_librarys_byte_for_byte() {
        let library = fixture();
        if let Ok(out) = std::env::var("INLAY_EXPORT_YAML_OUT") {
            std::fs::write(out, crate::import::tools_yaml::write_tools_yaml(&library)).unwrap();
            return;
        }
        let (cam, cam_warnings) = makera::build_cam(&library).unwrap();
        let bytes = makera::write(&cam);
        assert!(
            bytes == CAM,
            "Makera CAM: {}",
            first_difference(&bytes, CAM)
        );
        same_warnings(&cam_warnings, &expected("cam"));
        // The app would misread a byte of value 13 anywhere outside the thumbnails.
        assert!(!bytes.contains(&13));

        let (studio, studio_warnings) = makera::build_studio(&library, "2026-11-17T08:00:00Z");
        let bytes = makera::write(&studio);
        assert!(
            bytes == STUDIO,
            "Makera Studio: {}",
            first_difference(&bytes, STUDIO)
        );
        same_warnings(&studio_warnings, &expected("studio"));

        let fusion = fusion::build_fusion(&library);
        assert!(
            fusion.library == FUSION,
            "Fusion 360: {}",
            first_difference(fusion.library.as_bytes(), FUSION.as_bytes())
        );
        same_warnings(&fusion.warnings, &expected("fusion"));
        let all: serde_json::Value = serde_json::from_str(EXPECTED).unwrap();
        let sections: Vec<(String, String)> =
            serde_json::from_value(all["sections"].clone()).unwrap();
        assert_eq!(fusion.sections.len(), sections.len());
        for (got, want) in fusion.sections.iter().zip(&sections) {
            assert_eq!(got.0, want.0);
            assert!(
                got.1 == want.1,
                "section {}: {}",
                got.0,
                first_difference(got.1.as_bytes(), want.1.as_bytes())
            );
        }
        assert_eq!((fusion.tools, fusion.presets), (10, 19));
    }

    #[test]
    fn a_written_library_reads_back_the_same() {
        let library = fixture();
        let (cam, _) = makera::build_cam(&library).unwrap();
        assert_eq!(makera::read_any(&makera::write(&cam), 20_000).unwrap(), cam);
        let (studio, _) = makera::build_studio(&library, "2026-11-17T08:00:00Z");
        assert_eq!(
            makera::read_any(&makera::write(&studio), 20_000).unwrap(),
            studio
        );
        // Neither layout takes the other's file, nor anything else.
        assert!(makera::read(&makera::write(&cam), makera::Format::Studio, 20_000).is_err());
        assert!(makera::read_any(b"not a library", 20_000).is_err());
    }
}
