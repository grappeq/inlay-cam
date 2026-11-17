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
//! The cutting rows are Makera's presets wherever Makera has one, as the
//! Makera apps hold them, and so are the materials beside the two woods.
//! Makera has none for its thread mills, nor for PCB on the uncoated
//! engraving bits: those rows are the tooling library's own, sized for a
//! full-width slot. Makera's presets are not sized so: they are Makera's
//! word for its machines, not the feeds model's for a Carvera Air.

use crate::tools::{library_from_file_json, Level, Profile, ToolLibrary};

/// The materials, groups and tools, as a tool file of this app.
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

/// The starter set: Makera's bits with their cutting rows, the materials
/// those rows are for, and the two profiles. No tool has a row on a
/// profile yet: Makera has one preset for each tool and material.
pub fn library() -> ToolLibrary {
    let mut library = library_from_file_json(TOOLS).expect("the starter tools are a tool file");
    library.profiles = profiles();
    library
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::Machine;
    use crate::tools::{library_to_file_json, Material};

    #[test]
    fn the_starter_set_is_a_sound_library_of_makeras_bits_and_presets() {
        let library = library();
        library.validate().unwrap();
        assert_eq!(library.tools.len(), 50);
        // The two woods and seven more.
        assert_eq!(library.materials.len(), 9);
        let mut ids: Vec<&str> = library.tools.iter().map(|t| t.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), 50);
        let mut names: Vec<&str> = library.tools.iter().map(|t| t.name.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), 50, "names must tell the tools apart");
        let top = Machine::default().max_rpm;
        for tool in &library.tools {
            // Nothing of an owner's: what was paid, where, and how many are left.
            assert!(tool.inventory.is_none(), "{}", tool.name);
            assert!(tool.source.as_ref().is_none_or(|s| s.invoice.is_none()));
            // Makera's apps have these built in: they are not written to their libraries.
            assert_eq!(tool.apps.as_deref(), Some(&[][..]), "{}", tool.name);
            assert!(!tool.cutting.is_empty(), "{}", tool.name);
            for row in &tool.cutting {
                assert!(row.profile.is_none(), "{}", tool.name);
                assert!(row.rpm <= top, "{}", tool.name);
                assert!(row.stepover <= tool.diameter + 1e-9, "{}", tool.name);
                // A row is for a material the tool is said to suit.
                assert!(
                    tool.recommended_for.contains(&row.material),
                    "{}",
                    tool.name
                );
            }
        }
        // Makera's preset for its 3.175 mm end mill in hardwood.
        let tool = library
            .tools
            .iter()
            .find(|t| t.name == "Ø3.175×12 1F Upcut");
        let row = tool.unwrap().cutting_for(&Material::HARDWOOD).unwrap();
        assert_eq!(
            (row.rpm, row.feed, row.plunge, row.stepdown),
            (10000, 1000.0, 300.0, 1.0)
        );
        assert!((row.stepover - 2.0).abs() < 1e-3);
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
        library.profiles.clear();
        for (i, tool) in library.tools.iter_mut().enumerate() {
            tool.id = format!("starter-{:02}", i + 1);
            // A row on a profile is its owner's, not Makera's.
            tool.cutting.retain(|row| row.profile.is_none());
            tool.inventory = None;
            if let Some(source) = &mut tool.source {
                source.invoice = None;
            }
        }
        library.validate().unwrap();
        let out = concat!(env!("CARGO_MANIFEST_DIR"), "/data/starter-tools.json");
        std::fs::write(out, library_to_file_json(&library)).unwrap();
    }

    /// Prints the set as a table, with what the feeds model says of each
    /// row on a Carvera Air: `cargo test starter -- --nocapture --ignored print`.
    #[test]
    #[ignore]
    fn print_the_starter_set() {
        use crate::feeds::{check_row, Spindle};
        let spindle = Spindle::of(&Machine::default());
        let (mut rows, mut warned) = (0, 0);
        for tool in &library().tools {
            println!("\n{} [{}] {:?}", tool.name, tool.id, tool.kind);
            for r in &tool.cutting {
                let check = check_row(
                    tool,
                    r.material.key(),
                    r.rpm,
                    r.feed,
                    r.plunge,
                    r.stepover,
                    r.stepdown,
                    false,
                    spindle,
                );
                rows += 1;
                warned += usize::from(!check.warnings.is_empty());
                println!(
                    "  {:12} {:5} rpm  feed {:5}  plunge {:4}  stepover {:.3}  stepdown {:.2}  {}",
                    r.material.key(),
                    r.rpm,
                    r.feed,
                    r.plunge,
                    r.stepover,
                    r.stepdown,
                    check.warnings.join(" | ")
                );
            }
        }
        println!("\n{warned} of {rows} rows have a warning from the feeds model");
    }
}
