//! Limited import of a `cnc-tooling-library` `tools.yaml`.
//!
//! Only what the app can use is read: flat end mills, V-bits and
//! corner-rounding bits. Everything else in the file is ignored.
//! The fields read are listed in `docs/formats.md`.

use serde::Serialize;
use serde_yaml_ng::Value;

use crate::tools::{CuttingSettings, Material, Tool, ToolKind};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsYamlImport {
    /// Imported tools, in file order. Their `id` is empty: the caller assigns ids.
    pub tools: Vec<Tool>,
    pub skipped: Vec<SkippedTool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedTool {
    pub name: String,
    pub reason: String,
}

pub fn import_tools_yaml(text: &str) -> Result<ToolsYamlImport, String> {
    let root: Value =
        serde_yaml_ng::from_str(text).map_err(|e| format!("The file is not valid YAML: {e}"))?;
    let entries = root.get("tools").and_then(Value::as_sequence).ok_or(
        "The file has no \"tools\" list, so it does not look like a tooling-library tools.yaml.",
    )?;

    let mut out = ToolsYamlImport {
        tools: Vec::new(),
        skipped: Vec::new(),
    };
    for (index, entry) in entries.iter().enumerate() {
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("tool {}", index + 1));
        match read_tool(entry, &name) {
            Ok(tool) => out.tools.push(tool),
            Err(reason) => out.skipped.push(SkippedTool { name, reason }),
        }
    }
    Ok(out)
}

fn read_tool(entry: &Value, name: &str) -> Result<Tool, String> {
    let kind = match entry.get("type").and_then(Value::as_str) {
        Some("flat_end") => ToolKind::FlatEnd,
        Some("v_bit") => ToolKind::VBit,
        Some("ball_end") => return Err("ball nose (not used for inlays)".into()),
        Some("drill") => return Err("drill (not used for inlays)".into()),
        Some("thread_mill") => return Err("thread mill (not used for inlays)".into()),
        Some(other) => return Err(format!("unknown type \"{other}\"")),
        None => return Err("no type".into()),
    };

    let geometry = entry.get("geometry").ok_or("no geometry")?;
    let number = |key: &str| geometry.get(key).and_then(Value::as_f64);
    // The tooling library stores 0 for "unknown".
    let known = |key: &str| number(key).filter(|v| *v > 0.0);

    let diameter = known("diameter").ok_or("no diameter")?;
    let mut tool = Tool {
        id: String::new(),
        name: name.to_string(),
        kind,
        diameter,
        tip_diameter: None,
        corner_radius: None,
        tip_angle: None,
        flute_length: known("flute_length"),
        shank_diameter: known("shank_diameter").unwrap_or(diameter),
        length: known("length"),
        flutes: known("flutes").map(|v| v as u32),
        cutting: Vec::new(),
    };

    if kind == ToolKind::VBit {
        // The tooling library's default tip diameter is the body diameter.
        let tip = number("tip_diameter").unwrap_or(diameter);
        tool.tip_diameter = Some(tip);
        if is_corner_rounding(entry, name, tip, diameter) {
            // The tooling library has no field for the radius: it is what the
            // body is wider than the tip by, on each side.
            if tip >= diameter {
                return Err("corner-rounding cutter without a tip diameter".into());
            }
            tool.kind = ToolKind::CornerRound;
            tool.corner_radius = Some(((diameter - tip) / 2.0 * 10_000.0).round() / 10_000.0);
        } else {
            tool.tip_angle = number("tip_angle");
        }
    }

    if let Some(rows) = entry.get("cutting").and_then(Value::as_sequence) {
        for row in rows {
            if let Some(settings) = read_cutting(row, diameter) {
                // The file allows one plain row per material; keep the first if not.
                if tool.cutting_for(settings.material).is_none() {
                    tool.cutting.push(settings);
                }
            }
        }
    }

    tool.validate()?;
    Ok(tool)
}

/// Same rule as the tooling library: an explicit Fusion type, or a telling
/// name on a cutter whose tip is narrower than its body.
fn is_corner_rounding(entry: &Value, name: &str, tip: f64, diameter: f64) -> bool {
    match entry
        .get("fusion")
        .and_then(|f| f.get("type"))
        .and_then(Value::as_str)
    {
        Some("radius mill") => return true,
        Some(_) => return false,
        None => {}
    }
    let lower = name.to_lowercase();
    let named = ["fillet", "corner round", "radius"]
        .iter()
        .any(|word| lower.contains(word));
    named && tip > 0.0 && tip < diameter
}

/// Reads a plain hardwood or softwood row. Rows for other materials and rows
/// tied to a toolpath profile (such as adaptive clearing) return `None`.
fn read_cutting(row: &Value, diameter: f64) -> Option<CuttingSettings> {
    if row.get("toolpath").is_some() {
        return None;
    }
    let material = match row.get("material").and_then(Value::as_str)? {
        "hardwood" => Material::Hardwood,
        "softwood" => Material::Softwood,
        _ => return None,
    };
    let number = |key: &str| row.get(key).and_then(Value::as_f64);
    let stepover = number("stepover_mm")
        .or_else(|| number("stepover_pct").map(|pct| pct / 100.0 * diameter))?;
    Some(CuttingSettings {
        material,
        rpm: number("rpm")? as u32,
        feed: number("feed")?,
        plunge: number("plunge")?,
        stepover: (stepover * 10_000.0).round() / 10_000.0,
        stepdown: number("stepdown")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
format_version: 1
materials:
  hardwood: {cam: {id: "{x}", name: Hardwood}}
toolpaths:
  adaptive: {label: Adaptive}
groups:
  - path: End mills
tools:
  - name: Ø3.175×22 1F Downcut
    group: End mills
    type: flat_end
    number: 1
    coating: DLC
    recommended_for: [hardwood, softwood]
    ids: {cam: "{1850693c}"}
    source: {url: "https://example.com", invoice: 1/2025}
    inventory: {quantity: 1, price: 35, currency: PLN}
    geometry: {diameter: 3.175, flute_length: 22, shank_diameter: 3.175, length: 45, flutes: 1, tip_angle: 60}
    cutting:
      - {material: hardwood, rpm: 12000, feed: 600, plunge: 90, stepover_pct: 40, stepdown: 0.62}
      - {material: hardwood, toolpath: adaptive, rpm: 12000, feed: 900, plunge: 90, stepover_mm: 0.3, stepdown: 3}
      - {material: softwood, rpm: 12000, feed: 700, plunge: 110, stepover_mm: 1.2, stepdown: 0.8}
      - {material: aluminum, rpm: 12000, feed: 250, plunge: 60, stepover_pct: 30, stepdown: 0.3}
  - name: Ø2×6 S4 2F
    type: flat_end
    geometry: {diameter: 2, flute_length: 6, shank_diameter: 4, length: 50, flutes: 2}
  - name: Ø1 Ball S4 2F
    type: ball_end
    geometry: {diameter: 1, shank_diameter: 4, length: 50, flutes: 2}
  - name: 60° V-groove Ø12 S6
    type: v_bit
    geometry: {diameter: 12, tip_diameter: 0.1, tip_angle: 60, flute_length: 15.5, shank_diameter: 6, length: 46.5, flutes: 2}
  - name: 0.2×30° Engraver S3.175
    type: v_bit
    geometry: {diameter: 3.175, tip_diameter: 0.2, tip_angle: 30, flute_length: 0, shank_diameter: 3.175, length: 0}
  - name: R1 Corner Round Ø4
    type: v_bit
    geometry: {diameter: 4, tip_diameter: 2, tip_angle: 90, flute_length: 1, shank_diameter: 4, length: 50, flutes: 4}
  - name: Odd cutter
    type: v_bit
    fusion: {type: radius mill}
    geometry: {diameter: 4, tip_diameter: 2, tip_angle: 90}
  - name: Ø2.7×16 Drill S4
    type: drill
    geometry: {diameter: 2.7, tip_diameter: 1, tip_angle: 118}
  - name: M3×0.5 Thread Mill 9 reach
    type: thread_mill
    geometry: {diameter: 2.42, tip_diameter: 1, tip_angle: 60}
  - name: Blunt cone
    type: v_bit
    geometry: {diameter: 6, tip_angle: 90}
"#;

    #[test]
    fn imports_end_mills_v_bits_and_corner_rounding_bits() {
        let import = import_tools_yaml(SAMPLE).unwrap();
        let names: Vec<&str> = import.tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Ø3.175×22 1F Downcut",
                "Ø2×6 S4 2F",
                "60° V-groove Ø12 S6",
                "0.2×30° Engraver S3.175",
                "R1 Corner Round Ø4",
                "Odd cutter"
            ]
        );
        // A corner-rounding bit comes as a V-bit whose name or Fusion type
        // gives it away; its radius is what the body is wider than the tip by.
        for bit in &import.tools[4..] {
            assert_eq!(bit.kind, ToolKind::CornerRound);
            assert_eq!(bit.corner_radius, Some(1.0));
            assert_eq!(bit.tip_diameter, Some(2.0));
            assert_eq!(bit.tip_angle, None);
        }
        assert!(import.tools.iter().all(|t| t.id.is_empty()));
    }

    #[test]
    fn reads_geometry_and_ignores_the_stray_tip_angle_on_end_mills() {
        let import = import_tools_yaml(SAMPLE).unwrap();
        let mill = &import.tools[0];
        assert_eq!(mill.kind, ToolKind::FlatEnd);
        assert_eq!(
            (mill.diameter, mill.flute_length, mill.length, mill.flutes),
            (3.175, Some(22.0), Some(45.0), Some(1))
        );
        assert_eq!((mill.tip_angle, mill.tip_diameter), (None, None));

        let vbit = &import.tools[2];
        assert_eq!(
            (vbit.tip_angle, vbit.tip_diameter, vbit.shank_diameter),
            (Some(60.0), Some(0.1), 6.0)
        );
    }

    #[test]
    fn zero_means_unknown() {
        let import = import_tools_yaml(SAMPLE).unwrap();
        let engraver = &import.tools[3];
        assert_eq!(
            (engraver.flute_length, engraver.length, engraver.flutes),
            (None, None, None)
        );
    }

    #[test]
    fn keeps_plain_wood_rows_and_converts_percent_stepover() {
        let import = import_tools_yaml(SAMPLE).unwrap();
        let mill = &import.tools[0];
        assert_eq!(
            mill.cutting.len(),
            2,
            "adaptive and aluminium rows are skipped"
        );
        let hard = mill.cutting_for(Material::Hardwood).unwrap();
        assert_eq!(
            (
                hard.rpm,
                hard.feed,
                hard.plunge,
                hard.stepover,
                hard.stepdown
            ),
            (12000, 600.0, 90.0, 1.27, 0.62)
        );
        assert_eq!(mill.cutting_for(Material::Softwood).unwrap().stepover, 1.2);
    }

    #[test]
    fn reports_what_it_skipped_and_why() {
        let import = import_tools_yaml(SAMPLE).unwrap();
        let reason = |name: &str| {
            import
                .skipped
                .iter()
                .find(|s| s.name == name)
                .map(|s| s.reason.as_str())
        };
        assert_eq!(
            reason("Ø1 Ball S4 2F"),
            Some("ball nose (not used for inlays)")
        );
        assert_eq!(reason("R1 Corner Round Ø4"), None);
        assert_eq!(
            reason("Ø2.7×16 Drill S4"),
            Some("drill (not used for inlays)")
        );
        assert_eq!(
            reason("M3×0.5 Thread Mill 9 reach"),
            Some("thread mill (not used for inlays)")
        );
        // No tip diameter means "same as the body" in the tooling library: not a V-bit shape.
        assert!(reason("Blunt cone").unwrap().contains("tip diameter"));
        assert_eq!(import.skipped.len(), 4);
    }

    #[test]
    fn rejects_files_that_are_not_a_tool_spec() {
        assert!(import_tools_yaml("just: a map").is_err());
        assert!(import_tools_yaml(": : :").is_err());
    }

    /// Optional check against a real file:
    /// `INLAY_TOOLS_YAML=path/to/tools.yaml cargo test -p inlay-core real_tools_yaml -- --nocapture`
    #[test]
    fn real_tools_yaml_imports_when_provided() {
        let Ok(path) = std::env::var("INLAY_TOOLS_YAML") else {
            return;
        };
        let import = import_tools_yaml(&std::fs::read_to_string(path).unwrap()).unwrap();
        println!(
            "imported {} tools, skipped {}",
            import.tools.len(),
            import.skipped.len()
        );
        for tool in &import.tools {
            println!(
                "  {:?} {} ({} cutting rows)",
                tool.kind,
                tool.name,
                tool.cutting.len()
            );
        }
        for skipped in &import.skipped {
            println!("  skipped {}: {}", skipped.name, skipped.reason);
        }
        assert!(!import.tools.is_empty());
    }
}
