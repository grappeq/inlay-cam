//! The tools and profiles a new installation can start with, so that the
//! tool list is not empty.
//!
//! The tools are Makera's own bits, the ones the Makera apps have built in:
//! the Essential Milling Bit Set and what else Makera sells for a 1/8"
//! collet. Their details are in `data/starter-tools.json`, taken from the
//! tooling library's `tools.yaml`, where sizes, lengths, coatings and flute
//! counts were checked against the Makera store and the bits themselves.
//! What is still a guess there is marked on the tool as to be checked.
//!
//! The file holds no cutting rows. Each row is what the feeds model
//! suggests for a Carvera Air, so the set follows the model. Makera's own
//! presets are not used: they are not sized for a full-width slot on a
//! Carvera Air, which a plain row here has to be safe for.

use crate::feeds::{self, Options, Spindle, Status};
use crate::project::Machine;
use crate::tools::{
    library_from_file_json, CuttingSettings, Level, Material, Profile, Tool, ToolKind, ToolLibrary,
};

/// The tools, as a tool file of this app without cutting rows.
const TOOLS: &str = include_str!("../data/starter-tools.json");

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

/// The profiles a tool gets a row for, beside its plain one. Only flat end
/// mills get any: Clearing unless they are long and slender, more than
/// eight diameters of flute, and Facing where they are the set's widest and
/// stiffest.
fn profiles_of(tool: &Tool) -> Vec<&'static str> {
    let Some(flutes) = tool.flute_length.filter(|_| tool.kind == ToolKind::FlatEnd) else {
        return Vec::new();
    };
    let mut keys = Vec::new();
    if flutes <= 8.0 * tool.diameter {
        keys.push(CLEARING);
    }
    if tool.diameter >= 3.0 && flutes <= 4.0 * tool.diameter {
        keys.push(FACING);
    }
    keys
}

/// The starter set: Makera's bits, the two profiles, and for every bit that
/// suits wood a cutting row for hardwood and softwood, with rows on the
/// profiles for the end mills they suit.
pub fn library() -> ToolLibrary {
    let mut library = library_from_file_json(TOOLS).expect("the starter tools are a tool file");
    library.profiles = profiles();
    let spindle = Spindle::of(&Machine::default());
    for tool in &mut library.tools {
        for material in [Material::HARDWOOD, Material::SOFTWOOD] {
            if !tool.recommended_for.contains(&material) {
                continue;
            }
            let plain = row(tool, &material, None, spindle);
            tool.cutting.extend(plain);
            for key in profiles_of(tool) {
                let profile = library.profiles.iter().find(|p| p.key == key);
                let on_profile = profile.and_then(|p| row(tool, &material, Some(p), spindle));
                tool.cutting.extend(on_profile);
            }
        }
    }
    library
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::library_to_file_json;

    #[test]
    fn the_starter_set_is_a_sound_library_with_rows_for_both_woods() {
        let library = library();
        library.validate().unwrap();
        assert_eq!(library.tools.len(), 50);
        let mut ids: Vec<&str> = library.tools.iter().map(|t| t.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 50);
        let mut names: Vec<&str> = library.tools.iter().map(|t| t.name.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 50, "names must tell the tools apart");
        for tool in &library.tools {
            // Nothing of an owner's: what was paid, where, and how many are left.
            assert!(tool.inventory.is_none(), "{}", tool.name);
            assert!(tool.source.as_ref().is_none_or(|s| s.invoice.is_none()));
            // Makera's apps have these built in: they are not written to their libraries.
            assert_eq!(tool.apps.as_deref(), Some(&[][..]), "{}", tool.name);
            let cuts_here = matches!(
                tool.kind,
                ToolKind::FlatEnd | ToolKind::VBit | ToolKind::CornerRound
            );
            for material in [Material::HARDWOOD, Material::SOFTWOOD] {
                if cuts_here && tool.recommended_for.contains(&material) {
                    assert!(tool.cutting_for(&material).is_some(), "{}", tool.name);
                }
            }
            for row in &tool.cutting {
                assert!(row.rpm <= Machine::default().max_rpm);
                assert!(row.stepover <= tool.diameter + 1e-9, "{}", tool.name);
                if let Some(flutes) = tool.flute_length {
                    assert!(row.stepdown <= flutes, "{}", tool.name);
                }
            }
            for key in profiles_of(tool) {
                for material in [Material::HARDWOOD, Material::SOFTWOOD] {
                    if tool.recommended_for.contains(&material) {
                        assert!(tool.cutting_row(&material, Some(key)).is_some());
                    }
                }
            }
        }
        // The short 3.175 mm end mill faces and clears; the 42 mm one does neither.
        let rows = |name: &str| {
            let tool = library.tools.iter().find(|t| t.name == name).unwrap();
            tool.cutting.iter().filter(|r| r.profile.is_some()).count()
        };
        assert_eq!(rows("Ø3.175×12 1F Upcut"), 4);
        assert_eq!(rows("Ø3.175×42 1F Upcut"), 0);
    }

    /// Makes `data/starter-tools.json` from a `tools.yaml` holding the tools
    /// and nothing of their owner's: `STARTER_YAML=<file> cargo test starter
    /// -- --ignored write`.
    #[test]
    #[ignore]
    fn write_the_starter_tools() {
        let Some(path) = std::env::var_os("STARTER_YAML") else {
            return;
        };
        let text = std::fs::read_to_string(path).unwrap();
        let read = crate::import::tools_yaml::import_tools_yaml(&text).unwrap();
        assert_eq!(read.skipped, []);
        let mut library = read.library;
        library.materials.clear();
        library.profiles.clear();
        for (i, tool) in library.tools.iter_mut().enumerate() {
            tool.id = format!("starter-{:02}", i + 1);
            tool.cutting.clear();
            tool.inventory = None;
            if let Some(source) = &mut tool.source {
                source.invoice = None;
            }
            // Only the woods are materials of a new installation.
            tool.recommended_for.retain(Material::is_built_in);
        }
        library.validate().unwrap();
        let out = concat!(env!("CARGO_MANIFEST_DIR"), "/data/starter-tools.json");
        std::fs::write(out, library_to_file_json(&library)).unwrap();
    }

    /// Prints the set as a table: `cargo test starter -- --nocapture --ignored print`.
    #[test]
    #[ignore]
    fn print_the_starter_set() {
        for tool in &library().tools {
            println!("\n{} [{}] {:?}", tool.name, tool.id, tool.kind);
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
