//! The tools and profiles a new installation can start with, so that the
//! tool list is not empty.
//!
//! The tools are those of Makera's Essential Milling Bit Set (Standard, 26
//! pieces) that this app cuts with: its flat end mills, its engraving bits
//! and its chamfer bit. Ball-nose bits, drills, corn bits and thread mills
//! are left out, since the app keeps them but does not cut with them.
//!
//! Sizes are as Makera lists them. What the listing does not give (overall
//! lengths, the chamfer bit's diameter and tip) is left unknown or marked to
//! be checked. Cutting rows are not written down here: each is what the
//! feeds model suggests for a Carvera Air, so the set follows the model.

use crate::feeds::{self, Options, Spindle, Status};
use crate::naming;
use crate::project::Machine;
use crate::tools::{
    CuttingSettings, Level, Material, Profile, Source, Tool, ToolKind, ToolLibrary, VerifyItem,
};

const SET_URL: &str = "https://www.makera.com/products/makera-essential-milling-bit-set";
const GROUP: &str = "Makera essential set";
const SHANK: f64 = 3.175;

/// Key of the profile for clearing an area: a cut narrower than the tool.
pub const CLEARING: &str = "clearing";
/// Key of the profile for milling a face flat.
pub const FACING: &str = "facing";

/// The profiles that come with the app.
///
/// A plain row is safe for any cut, a full-width slot with a straight plunge
/// included, so contours and cut-outs need no profile. These two are for
/// the cuts that are not slots, where a plain row is slower than it need be.
pub fn profiles() -> Vec<Profile> {
    vec![
        Profile {
            key: CLEARING.into(),
            label: "Clearing".into(),
            note: Some(
                "Pockets and floors: the tool cuts less than its width and ramps in.".into(),
            ),
            level: Some(Level::Standard),
            ramping: true,
            adaptive: Some(false),
            lubricated: false,
            slot: false,
        },
        Profile {
            key: FACING.into(),
            label: "Facing".into(),
            note: Some("A shallow, light cut for a clean face.".into()),
            level: Some(Level::Gentle),
            ramping: true,
            adaptive: Some(false),
            lubricated: false,
            slot: false,
        },
    ]
}

struct Bit {
    id: &'static str,
    kind: ToolKind,
    diameter: f64,
    /// End mills: length of the flutes.
    flute_length: Option<f64>,
    /// V-bits: included angle and tip flat.
    tip: Option<(f64, f64)>,
    /// A word that sets it apart from another of its size.
    style: Option<&'static str>,
    /// Makera's own name for it.
    listed_as: &'static str,
    note: Option<&'static str>,
    /// What the listing does not give: to be measured.
    verify: &'static [(&'static str, &'static str)],
    /// Profiles it gets a row for, beside its plain one.
    profiles: &'static [&'static str],
}

const LENGTH: (&str, &str) = ("length", "Not in Makera's listing: measure it.");

const BITS: [Bit; 9] = [
    Bit {
        id: "starter-flat-3175-12",
        kind: ToolKind::FlatEnd,
        diameter: 3.175,
        flute_length: Some(12.0),
        tip: None,
        style: None,
        listed_as: "Spiral 'O' Single Flute Bit for Metal, 3.175 × 12 mm",
        note: Some("The stiffest of the set: first choice for pockets, contours and facing."),
        verify: &[LENGTH],
        profiles: &[CLEARING, FACING],
    },
    Bit {
        id: "starter-flat-3175-25",
        kind: ToolKind::FlatEnd,
        diameter: 3.175,
        flute_length: Some(25.0),
        tip: None,
        style: None,
        listed_as: "Spiral 'O' Single Flute Bit, 3.175 × 25 mm",
        note: Some("For cuts deeper than 12 mm, such as cutting a part out of a thick board."),
        verify: &[LENGTH],
        profiles: &[CLEARING],
    },
    Bit {
        id: "starter-flat-3175-42",
        kind: ToolKind::FlatEnd,
        diameter: 3.175,
        flute_length: Some(42.0),
        tip: None,
        style: None,
        listed_as: "Spiral 'O' Single Flute Bit, 3.175 × 42 mm",
        note: Some("Long and slender: only where the 25 mm one does not reach."),
        verify: &[LENGTH],
        profiles: &[],
    },
    Bit {
        id: "starter-flat-2-8",
        kind: ToolKind::FlatEnd,
        diameter: 2.0,
        flute_length: Some(8.0),
        tip: None,
        style: None,
        listed_as: "Spiral 'O' Single Flute Bit for Metal, 2 × 8 mm",
        note: Some("After the 3.175 mm one, for the corners and narrow parts it left."),
        verify: &[LENGTH],
        profiles: &[CLEARING],
    },
    Bit {
        id: "starter-flat-1-3",
        kind: ToolKind::FlatEnd,
        diameter: 1.0,
        flute_length: Some(3.0),
        tip: None,
        style: None,
        listed_as: "Spiral 'O' Single Flute Bit for Metal, 1 × 3 mm",
        note: Some("For the finest corners of a flat inlay. It cuts 3 mm deep at most."),
        verify: &[LENGTH],
        profiles: &[CLEARING],
    },
    Bit {
        id: "starter-v-60-01",
        kind: ToolKind::VBit,
        diameter: SHANK,
        flute_length: None,
        tip: Some((60.0, 0.1)),
        style: None,
        listed_as: "Single Flute Engraving Bit for Metal, 60° × 0.1 mm",
        note: Some(
            "V-carve inlays and chamfers. As wide as its shank, so it reaches about 2.6 mm deep.",
        ),
        verify: &[LENGTH],
        profiles: &[],
    },
    Bit {
        id: "starter-v-30-02",
        kind: ToolKind::VBit,
        diameter: SHANK,
        flute_length: None,
        tip: Some((30.0, 0.2)),
        style: None,
        listed_as: "Single Flute Engraving Bit for Metal, 30° × 0.2 mm",
        note: Some("Steep walls for a deep, narrow V-carve inlay."),
        verify: &[LENGTH],
        profiles: &[],
    },
    Bit {
        id: "starter-v-30-03",
        kind: ToolKind::VBit,
        diameter: SHANK,
        flute_length: None,
        tip: Some((30.0, 0.3)),
        style: None,
        listed_as: "Single Flute Engraving Bit for Metal, 30° × 0.3 mm",
        note: Some("As the 0.2 mm one, with a sturdier tip."),
        verify: &[LENGTH],
        profiles: &[],
    },
    Bit {
        id: "starter-v-90",
        kind: ToolKind::VBit,
        diameter: SHANK,
        flute_length: None,
        tip: Some((90.0, 0.0)),
        style: None,
        listed_as: "Chamfering Bit, 90°",
        note: Some("For chamfers: a 90° bit bevels an edge at 45°."),
        verify: &[
            (
                "diameter",
                "Makera lists the angle only: measure it. Taken as the shank's.",
            ),
            (
                "tipDiameter",
                "Makera lists the angle only: measure it. Taken as a point.",
            ),
            LENGTH,
        ],
        profiles: &[],
    },
];

/// What the feeds model suggests for a row of `tool`, or `None` where it
/// has nothing to stand behind.
fn row(
    tool: &Tool,
    material: &Material,
    profile: Option<&Profile>,
    spindle: Spindle,
) -> Option<CuttingSettings> {
    let options = profile.map_or(
        Options {
            spindle,
            ..Options::default()
        },
        |p| Options {
            level: p.level.unwrap_or(Level::SlotSafe),
            ramping: p.ramping,
            adaptive: p.is_adaptive(),
            lubricated: p.lubricated,
            spindle,
        },
    );
    let mut suggestion = feeds::suggest_for(tool, material.key(), &options);
    if profile.is_some_and(|p| p.slot) {
        let (_, geometry) = feeds::cutter_of(tool);
        suggestion = feeds::as_slot(suggestion, &geometry);
    }
    if suggestion.status == Status::None {
        return None;
    }
    let v = suggestion.values?;
    Some(CuttingSettings {
        profile: profile.map(|p| p.key.clone()),
        ..CuttingSettings::new(
            material.clone(),
            v.rpm as u32,
            v.feed as f64,
            v.plunge as f64,
            v.stepover_mm,
            v.stepdown,
        )
    })
}

/// The starter set: its tools with a cutting row for hardwood and softwood
/// each, and the two profiles with their rows on the end mills they suit.
pub fn library() -> ToolLibrary {
    let profiles = profiles();
    let spindle = Spindle::of(&Machine::default());
    let tools = BITS
        .iter()
        .map(|bit| {
            let mut tool = Tool::new("", bit.kind, bit.diameter);
            tool.id = bit.id.into();
            tool.shank_diameter = SHANK;
            tool.flute_length = bit.flute_length;
            tool.flutes = Some(1);
            if let Some((angle, flat)) = bit.tip {
                tool.tip_angle = Some(angle);
                tool.tip_diameter = Some(flat);
            }
            tool.style = bit.style.map(Into::into);
            tool.group = Some(GROUP.into());
            tool.note = bit.note.map(Into::into);
            tool.recommended_for = vec![Material::HARDWOOD, Material::SOFTWOOD];
            tool.source = Some(Source {
                url: Some(SET_URL.into()),
                invoice: None,
                size_note: Some(bit.listed_as.into()),
            });
            tool.verify = bit
                .verify
                .iter()
                .map(|(field, note)| VerifyItem {
                    field: (*field).into(),
                    note: Some((*note).into()),
                })
                .collect();
            tool.name = naming::template(&tool, "").unwrap_or_else(|| bit.listed_as.into());
            for material in [Material::HARDWOOD, Material::SOFTWOOD] {
                tool.cutting.extend(row(&tool, &material, None, spindle));
                for key in bit.profiles {
                    let profile = profiles.iter().find(|p| p.key == *key);
                    tool.cutting
                        .extend(profile.and_then(|p| row(&tool, &material, Some(p), spindle)));
                }
            }
            tool
        })
        .collect();
    ToolLibrary {
        materials: Vec::new(),
        profiles,
        groups: Vec::new(),
        tools,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_starter_set_is_a_sound_library_with_rows_for_both_woods() {
        let library = library();
        library.validate().unwrap();
        assert_eq!(library.tools.len(), 9);
        let mut names: Vec<&str> = library.tools.iter().map(|t| t.name.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 9, "names must tell the tools apart: {names:?}");
        for tool in &library.tools {
            for material in [Material::HARDWOOD, Material::SOFTWOOD] {
                assert!(tool.cutting_for(&material).is_some(), "{}", tool.name);
            }
            for row in &tool.cutting {
                assert!(row.rpm <= Machine::default().max_rpm);
                assert!(row.stepover <= tool.diameter + 1e-9);
                if let Some(flutes) = tool.flute_length {
                    assert!(row.stepdown <= flutes, "{}", tool.name);
                }
            }
        }
        // Every tool the set gives a profile row has one for both woods.
        for (bit, tool) in BITS.iter().zip(&library.tools) {
            for key in bit.profiles {
                for material in [Material::HARDWOOD, Material::SOFTWOOD] {
                    assert!(
                        tool.cutting_row(&material, Some(key)).is_some(),
                        "{} {key}",
                        tool.name
                    );
                }
            }
        }
    }

    /// Prints the set as a table: `cargo test starter -- --nocapture --ignored`.
    #[test]
    #[ignore]
    fn print_the_starter_set() {
        for tool in &library().tools {
            println!("\n{} [{}]", tool.name, tool.id);
            for r in &tool.cutting {
                println!(
                    "  {:9} {:9} {:5} rpm  feed {:5}  plunge {:4}  stepover {:.3}  stepdown {:.2}",
                    r.material.key(),
                    r.profile.as_deref().unwrap_or("plain"),
                    r.rpm,
                    r.feed,
                    r.plunge,
                    r.stepover,
                    r.stepdown
                );
            }
        }
    }
}
