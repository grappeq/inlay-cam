//! Cutting tools and the tool-library file.
//!
//! Lengths are mm, angles are degrees, feeds are mm/min.

use serde::{Deserialize, Serialize};

use crate::file::{self, FileError, Migration};

/// Current version of the tool-library file. Raise it, and add a migration,
/// whenever an old file could no longer be read as written.
pub const TOOL_LIBRARY_FORMAT_VERSION: u32 = 1;
pub const TOOL_LIBRARY_KIND: &str = "tool-library";

/// Migrations for tool-library files: entry `i` upgrades version `i + 1`.
const MIGRATIONS: &[Migration] = &[];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    FlatEnd,
    VBit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Material {
    Hardwood,
    Softwood,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuttingSettings {
    pub material: Material,
    /// Spindle speed, rev/min.
    pub rpm: u32,
    /// Feed rate while cutting sideways, mm/min.
    pub feed: f64,
    /// Feed rate while cutting straight down, mm/min.
    pub plunge: f64,
    /// Sideways distance between passes, mm.
    pub stepover: f64,
    /// Depth per pass, mm.
    pub stepdown: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    /// Unique within a tool list. Assigned by the app, never shown.
    pub id: String,
    pub name: String,
    pub kind: ToolKind,
    /// Cutting diameter. For a V-bit, the diameter at the top of the cone.
    pub diameter: f64,
    /// V-bit only: diameter of the flat at the tip. 0 for a perfect point.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tip_diameter: Option<f64>,
    /// V-bit only: included angle between the two cutting edges.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tip_angle: Option<f64>,
    /// Length of the cutting edges along the tool axis. `None` when unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flute_length: Option<f64>,
    pub shank_diameter: f64,
    /// Overall length. `None` when unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flutes: Option<u32>,
    /// At most one entry per material.
    #[serde(default)]
    pub cutting: Vec<CuttingSettings>,
}

impl Tool {
    pub fn cutting_for(&self, material: Material) -> Option<&CuttingSettings> {
        self.cutting.iter().find(|c| c.material == material)
    }

    /// Checks that the tool describes something that can exist and cut.
    pub fn validate(&self) -> Result<(), String> {
        fn positive(value: f64, what: &str) -> Result<(), String> {
            if value.is_finite() && value > 0.0 {
                Ok(())
            } else {
                Err(format!("{what} must be greater than 0"))
            }
        }

        if self.name.trim().is_empty() {
            return Err("name must not be empty".into());
        }
        positive(self.diameter, "diameter")?;
        positive(self.shank_diameter, "shank diameter")?;
        if let Some(v) = self.flute_length {
            positive(v, "flute length")?;
        }
        if let Some(v) = self.length {
            positive(v, "overall length")?;
        }
        match self.kind {
            ToolKind::FlatEnd => {}
            ToolKind::VBit => {
                let angle = self.tip_angle.ok_or("a V-bit needs a tip angle")?;
                if !(angle.is_finite() && angle > 0.0 && angle < 180.0) {
                    return Err("tip angle must be between 0 and 180 degrees".into());
                }
                let tip = self.tip_diameter.unwrap_or(0.0);
                if !(tip.is_finite() && tip >= 0.0 && tip < self.diameter) {
                    return Err(
                        "tip diameter must be 0 or more and smaller than the diameter".into(),
                    );
                }
            }
        }
        for (i, c) in self.cutting.iter().enumerate() {
            if c.rpm == 0 {
                return Err("spindle speed must be greater than 0".into());
            }
            positive(c.feed, "feed")?;
            positive(c.plunge, "plunge")?;
            positive(c.stepover, "stepover")?;
            positive(c.stepdown, "stepdown")?;
            if c.stepover > self.diameter {
                return Err("stepover must not be larger than the diameter".into());
            }
            if self.cutting[..i]
                .iter()
                .any(|other| other.material == c.material)
            {
                return Err("only one set of cutting settings per material".into());
            }
        }
        Ok(())
    }
}

/// Checks every tool and that ids are unique.
pub fn validate_tools(tools: &[Tool]) -> Result<(), String> {
    for (i, tool) in tools.iter().enumerate() {
        tool.validate()
            .map_err(|e| format!("tool \"{}\": {e}", tool.name))?;
        if tool.id.is_empty() {
            return Err(format!("tool \"{}\" has no id", tool.name));
        }
        if tools[..i].iter().any(|other| other.id == tool.id) {
            return Err(format!("two tools share the id \"{}\"", tool.id));
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct LibraryBody {
    tools: Vec<Tool>,
}

/// Writes a tool list as a tool-library file.
pub fn tools_to_file_json(tools: &[Tool]) -> String {
    file::write(
        TOOL_LIBRARY_KIND,
        TOOL_LIBRARY_FORMAT_VERSION,
        &LibraryBody {
            tools: tools.to_vec(),
        },
    )
}

/// Reads a tool-library file written by this or any earlier version of the app.
pub fn tools_from_file_json(text: &str) -> Result<Vec<Tool>, FileError> {
    let body: LibraryBody = file::read(
        text,
        TOOL_LIBRARY_KIND,
        TOOL_LIBRARY_FORMAT_VERSION,
        MIGRATIONS,
    )?;
    validate_tools(&body.tools).map_err(FileError::Invalid)?;
    Ok(body.tools)
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub fn end_mill() -> Tool {
        Tool {
            id: "t-endmill".into(),
            name: "Ø3.175×22 1F Downcut".into(),
            kind: ToolKind::FlatEnd,
            diameter: 3.175,
            tip_diameter: None,
            tip_angle: None,
            flute_length: Some(22.0),
            shank_diameter: 3.175,
            length: Some(45.0),
            flutes: Some(1),
            cutting: vec![CuttingSettings {
                material: Material::Hardwood,
                rpm: 12000,
                feed: 600.0,
                plunge: 90.0,
                stepover: 1.27,
                stepdown: 0.62,
            }],
        }
    }

    pub fn v_bit() -> Tool {
        Tool {
            id: "t-vbit".into(),
            name: "60° V-groove Ø12 S6".into(),
            kind: ToolKind::VBit,
            diameter: 12.0,
            tip_diameter: Some(0.1),
            tip_angle: Some(60.0),
            flute_length: Some(15.5),
            shank_diameter: 6.0,
            length: Some(46.5),
            flutes: Some(2),
            cutting: vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn valid_tools_pass() {
        assert_eq!(end_mill().validate(), Ok(()));
        assert_eq!(v_bit().validate(), Ok(()));
    }

    #[test]
    fn v_bit_needs_an_angle_and_a_tip_smaller_than_the_body() {
        let mut tool = v_bit();
        tool.tip_angle = None;
        assert!(tool.validate().is_err());

        let mut tool = v_bit();
        tool.tip_diameter = Some(12.0);
        assert!(tool.validate().is_err());

        let mut tool = v_bit();
        tool.tip_diameter = None;
        assert_eq!(
            tool.validate(),
            Ok(()),
            "a missing tip means a perfect point"
        );
    }

    #[test]
    fn duplicate_material_rows_are_rejected() {
        let mut tool = end_mill();
        tool.cutting.push(tool.cutting[0].clone());
        assert!(tool.validate().is_err());
    }

    #[test]
    fn library_round_trips() {
        let tools = vec![end_mill(), v_bit()];
        let text = tools_to_file_json(&tools);
        assert_eq!(tools_from_file_json(&text).unwrap(), tools);
    }

    #[test]
    fn duplicate_ids_are_rejected_on_load() {
        let text = tools_to_file_json(&[end_mill(), end_mill()]);
        assert!(matches!(
            tools_from_file_json(&text),
            Err(FileError::Invalid(_))
        ));
    }

    /// Files from every released format version must keep loading.
    #[test]
    fn version_1_fixture_loads() {
        let tools =
            tools_from_file_json(include_str!("../tests/fixtures/tool-library-v1.json")).unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[1].tip_angle, Some(60.0));
        assert_eq!(
            tools[0].cutting_for(Material::Hardwood).unwrap().feed,
            600.0
        );
    }
}
