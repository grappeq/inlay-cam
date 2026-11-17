//! The standard name for a tool, from its kind, sizes and style word, offered
//! when its name differs. One template per kind, as the tooling library has
//! them: each leads with the size that kind of tool is picked by, then the
//! kind word, the other sizes, the flutes and the style word.

use serde::Serialize;

use crate::tools::{FusionType, MakeraApp, Tool, ToolKind};

/// A V-bit this sharp engraves rather than chamfers.
const ENGRAVER_MAX_ANGLE: f64 = 45.0;
/// A V-bit whose name has one of these, and a pilot narrower than its body,
/// rounds corners.
const RADIUS_WORDS: [&str; 3] = ["fillet", "corner round", "radius"];
/// Recorded so that a tool known to be bare differs from one whose coating
/// is not recorded. Never shown in a name.
const UNCOATED: &str = "uncoated";

/// A number as a name shows it: four decimals at most, none it does not need.
fn n(value: f64) -> String {
    let text = format!("{value:.4}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// The name the Makera apps show: the name with the coating after it, unless
/// there is none, it is `uncoated`, or the name already ends with it.
pub fn display_name(name: &str, coating: Option<&str>) -> String {
    let Some(coating) = coating.filter(|c| !c.is_empty() && *c != UNCOATED) else {
        return name.to_string();
    };
    let (folded, suffix) = (name.to_lowercase(), coating.to_lowercase());
    if folded == suffix || folded.ends_with(&format!(" {suffix}")) {
        name.to_string()
    } else {
        format!("{name} {coating}")
    }
}

/// Makera CAM stops reading a name at a byte of value 13, which some letters
/// have in the form it stores them in.
fn cam_unreadable(text: &str) -> bool {
    let units: Vec<u16> = text.encode_utf16().collect();
    let length = (units.len() as u32 * 2).to_be_bytes();
    length.contains(&13) || units.iter().any(|u| u.to_be_bytes().contains(&13))
}

/// Whether a V-bit rounds corners: it says so, or its name does and it has a
/// pilot narrower than its body. `named` is the name to go by.
fn rounds_corners(tool: &Tool, named: &str) -> bool {
    match tool.kind {
        ToolKind::CornerRound => true,
        ToolKind::VBit => match tool.fusion_type {
            Some(FusionType::RadiusMill) => true,
            Some(FusionType::ChamferMill) => false,
            None => {
                let name = named.to_lowercase();
                let tip = tool.tip_diameter.unwrap_or(0.0);
                RADIUS_WORDS.iter().any(|word| name.contains(word))
                    && 0.0 < tip
                    && tip < tool.diameter
            }
        },
        _ => false,
    }
}

/// The standard name without the style word, or `None` when a size it needs
/// is unknown.
fn base(tool: &Tool, named: &str) -> Option<String> {
    let d = n(tool.diameter);
    let flute = tool.flute_length.filter(|l| *l > 0.0);
    let flutes = tool
        .flutes
        .filter(|z| *z > 0)
        .map_or(String::new(), |z| format!(" {z}F"));
    // The shank, only when it differs from the cutting diameter.
    let shank = if n(tool.shank_diameter) != d {
        format!(" S{}", n(tool.shank_diameter))
    } else {
        String::new()
    };
    match tool.kind {
        ToolKind::FlatEnd => Some(format!("Ø{d}×{}{shank}{flutes}", n(flute?))),
        ToolKind::BallEnd => Some(format!("Ø{d} Ball{shank}{flutes}")),
        ToolKind::Drill => Some(format!("Ø{d}×{} Drill{shank}", n(flute?))),
        ToolKind::ThreadMill => {
            let thread = tool.thread_diameter.filter(|v| *v > 0.0)?;
            let pitch = tool.pitch.filter(|v| *v > 0.0)?;
            Some(format!(
                "M{}×{} Thread Mill {} reach",
                n(thread),
                n(pitch),
                n(flute?)
            ))
        }
        // Chamfers, V-grooves and corner rounding never name their flutes.
        ToolKind::VBit | ToolKind::CornerRound => {
            let tip = tool.tip_diameter.unwrap_or(0.0);
            if rounds_corners(tool, named) {
                if !(0.0 < tip && tip < tool.diameter) {
                    return None;
                }
                return Some(format!(
                    "R{} Corner Round Ø{d}{shank}",
                    n((tool.diameter - tip) / 2.0)
                ));
            }
            let angle = tool.tip_angle.filter(|a| *a > 0.0)?;
            if angle <= ENGRAVER_MAX_ANGLE {
                // A tip of 0, or one as wide as the body, says nothing worth
                // naming. Two engravers often differ only in shank, so it
                // always shows.
                let tip = if 0.0 < tip && tip != tool.diameter {
                    format!("{}×", n(tip))
                } else {
                    String::new()
                };
                return Some(format!(
                    "{tip}{}° Engraver S{}",
                    n(angle),
                    n(tool.shank_diameter)
                ));
            }
            let kind = if tool.diameter > tool.shank_diameter {
                "V-groove"
            } else {
                "Chamfer"
            };
            Some(format!("{}° {kind} Ø{d}{shank}", n(angle)))
        }
    }
}

/// The standard name of a tool, its style word at the end. `named` is the
/// name a V-bit is read by: the one it is saved under, so that the template
/// does not flip while a new name is typed.
pub fn template(tool: &Tool, named: &str) -> Option<String> {
    let base = base(tool, named)?;
    Some(match tool.style.as_deref().filter(|s| !s.is_empty()) {
        Some(style) => format!("{base} {style}"),
        None => base,
    })
}

/// A name to offer for a tool, and the names that count as having it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NameSuggestion {
    pub name: String,
    pub accepted: Vec<String>,
}

/// The name to offer for a tool. `taken` holds every other tool's name and
/// shown name. A template another tool already has gets the overall length
/// after it (" 100L"); if that is unknown or taken too, there is nothing to
/// offer. Nor is there when Makera CAM could not read the name.
pub fn suggest(tool: &Tool, named: &str, taken: &[String]) -> Option<NameSuggestion> {
    let base = template(tool, named)?;
    let coating = tool.coating.as_deref();
    let mut accepted = vec![base.clone()];
    if let Some(length) = tool.length.filter(|l| *l > 0.0) {
        accepted.push(format!("{base} {}L", n(length)));
    }
    let free =
        |name: &String| !taken.contains(name) && !taken.contains(&display_name(name, coating));
    let name = accepted.iter().find(|name| free(name))?.clone();
    let cam = tool
        .apps
        .as_ref()
        .is_none_or(|apps| apps.contains(&MakeraApp::Cam));
    if cam && cam_unreadable(&display_name(&name, coating)) {
        return None;
    }
    Some(NameSuggestion { name, accepted })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(kind: ToolKind, diameter: f64, flute: Option<f64>, shank: f64, flutes: u32) -> Tool {
        let mut t = Tool::new("x", kind, diameter);
        t.flute_length = flute;
        t.shank_diameter = shank;
        t.flutes = Some(flutes);
        t
    }

    fn v_bit(kind: ToolKind, diameter: f64, shank: f64, tip: f64, angle: f64) -> Tool {
        let mut t = tool(kind, diameter, None, shank, 2);
        t.tip_diameter = Some(tip);
        t.tip_angle = Some(angle);
        t
    }

    fn name(t: &Tool) -> Option<String> {
        template(t, &t.name)
    }

    // The tooling library's own examples, one per template.
    #[test]
    fn every_kind_has_its_template() {
        let flat = tool(ToolKind::FlatEnd, 6.0, Some(15.0), 6.0, 2);
        assert_eq!(name(&flat).as_deref(), Some("Ø6×15 2F"));
        let thin = tool(ToolKind::FlatEnd, 2.0, Some(17.0), 3.175, 1);
        assert_eq!(name(&thin).as_deref(), Some("Ø2×17 S3.175 1F"));
        let ball = tool(ToolKind::BallEnd, 1.0, None, 4.0, 2);
        assert_eq!(name(&ball).as_deref(), Some("Ø1 Ball S4 2F"));
        let mut drill = tool(ToolKind::Drill, 2.7, Some(16.0), 4.0, 2);
        drill.tip_angle = Some(118.0);
        assert_eq!(name(&drill).as_deref(), Some("Ø2.7×16 Drill S4"));
        let engraver = v_bit(ToolKind::VBit, 4.0, 4.0, 0.2, 30.0);
        assert_eq!(name(&engraver).as_deref(), Some("0.2×30° Engraver S4"));
        let chamfer = v_bit(ToolKind::VBit, 6.0, 6.0, 0.1, 90.0);
        assert_eq!(name(&chamfer).as_deref(), Some("90° Chamfer Ø6"));
        let groove = v_bit(ToolKind::VBit, 16.0, 6.0, 0.1, 90.0);
        assert_eq!(name(&groove).as_deref(), Some("90° V-groove Ø16 S6"));
        let round = v_bit(ToolKind::CornerRound, 4.0, 4.0, 2.0, 90.0);
        assert_eq!(name(&round).as_deref(), Some("R1 Corner Round Ø4"));
        let mut wide = v_bit(ToolKind::VBit, 6.0, 4.0, 4.0, 90.0);
        wide.fusion_type = Some(FusionType::RadiusMill);
        assert_eq!(name(&wide).as_deref(), Some("R1 Corner Round Ø6 S4"));
        let mut thread = tool(ToolKind::ThreadMill, 4.8, Some(19.0), 6.0, 1);
        thread.thread_diameter = Some(6.0);
        thread.pitch = Some(1.0);
        assert_eq!(name(&thread).as_deref(), Some("M6×1 Thread Mill 19 reach"));

        // The style word ends every template; a size that is not known leaves none.
        let mut styled = flat.clone();
        styled.style = Some("Downcut".into());
        assert_eq!(name(&styled).as_deref(), Some("Ø6×15 2F Downcut"));
        let unknown = tool(ToolKind::FlatEnd, 6.0, None, 6.0, 2);
        assert_eq!(name(&unknown), None);
    }

    #[test]
    fn a_v_bit_named_as_a_fillet_rounds_corners_if_it_has_a_pilot() {
        let bit = v_bit(ToolKind::VBit, 4.0, 4.0, 2.0, 90.0);
        assert_eq!(
            template(&bit, "Fillet D4xR1").as_deref(),
            Some("R1 Corner Round Ø4")
        );
        assert_eq!(
            template(&bit, "Some bit").as_deref(),
            Some("90° Chamfer Ø4")
        );
        let point = v_bit(ToolKind::VBit, 4.0, 4.0, 0.0, 90.0);
        assert_eq!(
            template(&point, "Fillet").as_deref(),
            Some("90° Chamfer Ø4")
        );
    }

    #[test]
    fn a_taken_name_gets_the_length_or_nothing() {
        let mut flat = tool(ToolKind::FlatEnd, 6.0, Some(15.0), 6.0, 2);
        let free = suggest(&flat, "x", &[]).unwrap();
        assert_eq!((free.name.as_str(), free.accepted.len()), ("Ø6×15 2F", 1));
        let taken = vec!["Ø6×15 2F".to_string()];
        assert_eq!(suggest(&flat, "x", &taken), None);
        flat.length = Some(50.0);
        let long = suggest(&flat, "x", &taken).unwrap();
        assert_eq!(long.name, "Ø6×15 2F 50L");
        assert_eq!(long.accepted, ["Ø6×15 2F", "Ø6×15 2F 50L"]);
        // Another tool shown under the same name with its coating takes it too.
        flat.coating = Some("DLC".into());
        let shown = vec!["Ø6×15 2F DLC".to_string(), "Ø6×15 2F 50L DLC".to_string()];
        assert_eq!(suggest(&flat, "x", &shown), None);
    }

    #[test]
    fn the_shown_name_has_the_coating_once() {
        assert_eq!(display_name("Ø6×15 2F", Some("DLC")), "Ø6×15 2F DLC");
        assert_eq!(display_name("Ø6×15 2F dlc", Some("DLC")), "Ø6×15 2F dlc");
        assert_eq!(display_name("Ø6×15 2F", Some("uncoated")), "Ø6×15 2F");
        assert_eq!(display_name("Ø6×15 2F", None), "Ø6×15 2F");
    }

    #[test]
    fn a_name_makera_cam_cannot_read_is_not_offered() {
        // č is U+010D: its second byte is 13.
        assert!(cam_unreadable("č") && !cam_unreadable("Ø6×15 2F"));
        let mut flat = tool(ToolKind::FlatEnd, 6.0, Some(15.0), 6.0, 2);
        flat.style = Some("Načo".into());
        assert_eq!(suggest(&flat, "x", &[]), None);
        flat.apps = Some(vec![MakeraApp::Studio]);
        assert!(suggest(&flat, "x", &[]).is_some());
    }
}
