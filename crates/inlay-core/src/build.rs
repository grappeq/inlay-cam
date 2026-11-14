//! Turns an inlay job into a G-code file, and simulates that file.
//!
//! This is the whole pipeline in one place: geometry -> moves -> G-code text
//! -> interpreted moves -> simulated stock.

use std::collections::HashMap;

use serde::Serialize;

use crate::gcode::{self, Interpreted};
use crate::geom::boolean::union;
use crate::geom::offset::total_area;
use crate::geom::Region;
use crate::ops::clear::{clear, ClearError, ClearParams};
use crate::post::carvera;
use crate::project::{Inlay, Project};
use crate::sim::{self, HeightMap};
use crate::toolpath::{PathBuilder, Program, ProgramTool};
use crate::tools::{Material, Tool, ToolKind};

/// The machine the output is for.
pub struct Machine {
    pub name: &'static str,
    pub max_rpm: u32,
    /// Rapid speed, mm/min, used for time estimates.
    pub rapid_rate: f64,
}

pub const CARVERA_AIR: Machine = Machine {
    name: "Carvera Air",
    max_rpm: 13000,
    rapid_rate: 2000.0,
};

/// Height above the stock at which the tool travels between cuts, mm.
pub const SAFE_Z: f64 = 5.0;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Built {
    pub file_name: String,
    pub gcode: String,
    pub stats: Stats,
    /// Things worth knowing that do not stop the job.
    pub warnings: Vec<String>,
    #[serde(skip)]
    pub program: Program,
    #[serde(skip)]
    pub interpreted: Interpreted,
    /// The pocket that results: what the tool's edge can reach.
    #[serde(skip)]
    pub pocket: Vec<Region>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub lines: u32,
    /// Total length of cutting moves, mm.
    pub cutting_length: f64,
    /// Estimated running time, minutes, without tool changes.
    pub minutes: f64,
    /// Names of the tools in the order they are loaded.
    pub tools: Vec<String>,
}

/// Builds the pocket file for a job. On failure returns every reason found,
/// in plain words.
pub fn build_pocket(project: &Project, job_id: &str) -> Result<Built, Vec<String>> {
    let machine = &CARVERA_AIR;
    let job = project
        .jobs
        .iter()
        .find(|j| j.id == job_id)
        .ok_or_else(|| vec!["This inlay no longer exists.".to_string()])?;
    let design = project
        .design
        .as_ref()
        .ok_or_else(|| vec!["The project has no design.".to_string()])?;

    let (depth, tool_id) = match &job.inlay {
        Inlay::Flat {
            pocket_depth,
            tool_id,
            ..
        } => (*pocket_depth, tool_id.as_deref()),
        Inlay::Vcarve { .. } => {
            return Err(vec!["V-carve toolpaths are not available yet.".into()])
        }
    };

    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    let regions = union(&design.placed_regions(&job.region_ids));
    if regions.is_empty() {
        errors.push("The inlay has no shapes. Click shapes in the drawing to add them.".into());
    }
    if depth >= project.base.thickness {
        errors.push(format!(
            "The pocket is {} mm deep but the base board is only {} mm thick.",
            num(depth),
            num(project.base.thickness)
        ));
    }

    let tool = checked_tool(
        project,
        tool_id,
        ToolKind::FlatEnd,
        "an end mill",
        &mut errors,
    );
    let cutting = tool.and_then(|t| {
        let found = t.cutting_for(job.material);
        if found.is_none() {
            errors.push(format!(
                "\"{}\" has no cutting settings for {}. Add them in the tool list.",
                t.name,
                material_name(job.material)
            ));
        }
        found
    });
    if let (Some(tool), Some(cutting)) = (tool, cutting) {
        if cutting.rpm > machine.max_rpm {
            errors.push(format!(
                "\"{}\" is set to {} rpm, but the {} spindle tops out at {} rpm.",
                tool.name, cutting.rpm, machine.name, machine.max_rpm
            ));
        }
        match tool.flute_length {
            Some(flutes) if depth > flutes => errors.push(format!(
                "The pocket is {} mm deep, but the cutting edges of \"{}\" are only {} mm long.",
                num(depth),
                tool.name,
                num(flutes)
            )),
            Some(_) => {}
            None => warnings.push(format!("The flute length of \"{}\" is unknown, so the depth could not be checked against it.", tool.name)),
        }
        if cutting.stepover > tool.diameter * 0.5 {
            warnings.push(format!(
                "The stepover of \"{}\" ({} mm) is more than half its diameter, which can leave thin ridges on the pocket floor.",
                tool.name,
                num(cutting.stepover)
            ));
        }
    }
    let (Some(tool), Some(cutting), true) = (tool, cutting, errors.is_empty()) else {
        return Err(errors);
    };

    let number = carvera::FIRST_TOOL_NUMBER;
    let mut path = PathBuilder::new(SAFE_Z);
    path.start_tool(number, cutting.rpm);
    let params = ClearParams {
        tool_diameter: tool.diameter,
        depth,
        stepover: cutting.stepover,
        stepdown: cutting.stepdown,
        feed: cutting.feed,
        plunge: cutting.plunge,
    };
    let pocket = match clear(&mut path, &regions, &params) {
        Ok(pocket) => pocket,
        Err(ClearError::ToolTooWide) => {
            return Err(vec![format!(
                "\"{}\" ({} mm) is too wide to fit inside any of the selected shapes.",
                tool.name,
                num(tool.diameter)
            )])
        }
    };

    let (wanted, reached) = (total_area(&regions), total_area(&pocket));
    if wanted - reached > 0.005 * wanted {
        warnings.push(format!(
            "The tool cannot reach {} mm² of the shape ({}%): inside corners are rounded to its {} mm radius, and parts narrower than {} mm are left uncut.",
            num(((wanted - reached) * 10.0).round() / 10.0),
            num(((wanted - reached) / wanted * 1000.0).round() / 10.0),
            num(tool.diameter / 2.0),
            num(tool.diameter)
        ));
    }
    let (width, height) = design.placed_size();
    if regions
        .iter()
        .flat_map(|r| r.outer.iter())
        .any(|p| p[0] < 0.0 || p[1] < 0.0 || p[0] > width || p[1] > height)
    {
        warnings.push("Part of the inlay lies outside the design's page, which is taken as the edge of the base board.".into());
    }

    let program = Program {
        name: format!("{} - {} - pocket", project.name, job.name),
        tools: vec![ProgramTool {
            number,
            tool: tool.clone(),
        }],
        safe_z: SAFE_Z,
        moves: path.finish(),
    };
    let gcode = carvera::write(&program);

    // The file must satisfy the firmware's rules and read back cleanly. A
    // failure here is a bug in this app, never the user's doing.
    let lint = carvera::lint(&gcode);
    if !lint.is_empty() {
        return Err(vec![format!(
            "Internal error: the G-code breaks a firmware rule ({}).",
            lint[0]
        )]);
    }
    let interpreted = gcode::interpret(&gcode).map_err(|e| {
        vec![format!(
            "Internal error: the G-code does not read back ({e})."
        )]
    })?;

    Ok(Built {
        file_name: format!(
            "{}.{}",
            file_stem(&format!("{} {} pocket", project.name, job.name)),
            carvera::FILE_EXTENSION
        ),
        stats: Stats {
            lines: interpreted.lines,
            cutting_length: interpreted.cutting_length(),
            minutes: interpreted.minutes(machine.rapid_rate),
            tools: program.tools.iter().map(|t| t.tool.name.clone()).collect(),
        },
        gcode,
        warnings,
        program,
        interpreted,
        pocket,
    })
}

fn checked_tool<'a>(
    project: &'a Project,
    id: Option<&str>,
    kind: ToolKind,
    what: &str,
    errors: &mut Vec<String>,
) -> Option<&'a Tool> {
    let Some(id) = id else {
        errors.push(format!("Choose {what} for this inlay."));
        return None;
    };
    let tool = project.tools.iter().find(|t| t.id == id);
    match tool {
        None => errors.push(format!(
            "The chosen tool is missing from the project. Choose {what} again."
        )),
        Some(t) if t.kind != kind => errors.push(format!("\"{}\" is not {what}.", t.name)),
        Some(_) => {}
    }
    tool.filter(|t| t.kind == kind)
}

fn material_name(material: Material) -> &'static str {
    match material {
        Material::Hardwood => "hardwood",
        Material::Softwood => "softwood",
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Preview {
    pub map: HeightMap,
    /// Problems found while cutting, each with its G-code line.
    pub problems: Vec<sim::SimProblem>,
    pub built: Built,
}

/// Builds a job's pocket file and simulates that file on the base board.
pub fn preview_pocket(project: &Project, job_id: &str) -> Result<Preview, Vec<String>> {
    let built = build_pocket(project, job_id)?;
    let design = project
        .design
        .as_ref()
        .expect("build_pocket checked the design");
    let (width, height) = design.placed_size();
    let tools: HashMap<u32, Tool> = built
        .program
        .tools
        .iter()
        .map(|t| (t.number, t.tool.clone()))
        .collect();
    let cell = HeightMap::cell_for(width, height, 2_000_000.0, 0.05);
    // Simulate what the file says, read back from its text.
    let simulation = sim::simulate(
        &built.interpreted,
        &tools,
        width,
        height,
        project.base.thickness,
        cell,
    );
    Ok(Preview {
        map: simulation.map,
        problems: simulation.problems,
        built,
    })
}

fn num(v: f64) -> String {
    let s = format!("{:.3}", (v * 1000.0).round() / 1000.0);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Letters, digits, dashes and underscores only, so the name is safe on the
/// machine's SD card and in its file list.
fn file_stem(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "inlay".into()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::offset::open;
    use crate::project::{BaseStock, Design, DesignRegion, Job};
    use crate::tools::fixtures::{end_mill, v_bit};

    /// A 60 x 40 mm page with a 30 x 20 mm rectangle and an L shape.
    fn project() -> Project {
        Project {
            id: "p".into(),
            name: "Test board".into(),
            design: Some(Design {
                source_name: "t.svg".into(),
                width: 60.0,
                height: 40.0,
                scale: 1.0,
                mirror: false,
                regions: vec![
                    DesignRegion {
                        id: 0,
                        color: None,
                        outer: vec![[5.0, 5.0], [35.0, 5.0], [35.0, 25.0], [5.0, 25.0]],
                        holes: vec![],
                    },
                    DesignRegion {
                        id: 1,
                        color: None,
                        outer: vec![
                            [40.0, 5.0],
                            [55.0, 5.0],
                            [55.0, 12.0],
                            [47.0, 12.0],
                            [47.0, 35.0],
                            [40.0, 35.0],
                        ],
                        holes: vec![],
                    },
                ],
            }),
            jobs: vec![Job {
                id: "j".into(),
                name: "Flat inlay 1".into(),
                material: Material::Hardwood,
                region_ids: vec![0, 1],
                inlay: Inlay::Flat {
                    pocket_depth: 2.0,
                    allowance: 0.1,
                    tabs: false,
                    tool_id: Some("t-endmill".into()),
                },
            }],
            tools: vec![end_mill(), v_bit()],
            base: BaseStock { thickness: 18.0 },
        }
    }

    fn with_inlay(inlay: Inlay) -> Project {
        let mut p = project();
        p.jobs[0].inlay = inlay;
        p
    }

    #[test]
    fn builds_a_file_that_obeys_the_firmware_rules_and_reads_back() {
        let built = build_pocket(&project(), "j").unwrap();
        assert_eq!(built.file_name, "Test-board-Flat-inlay-1-pocket.cnc");
        assert!(built.gcode.starts_with("(Test board - Flat inlay 1 - pocket)\n(T1 D=3.175 - D3.175x22 1F Downcut)\nG90 G94\nG17\nG21\nM6 T1\nS12000 M3\nG54\n"));
        assert!(built.gcode.ends_with("M5\nG28\nM30\n"));
        assert_eq!(carvera::lint(&built.gcode), Vec::<String>::new());
        assert_eq!(built.stats.tools, ["Ø3.175×22 1F Downcut"]);
        assert!(built.stats.cutting_length > 500.0);
        assert!(built.stats.minutes > 1.0);
    }

    /// The move list survives being written as G-code and read back.
    #[test]
    fn interpreted_file_matches_the_moves_it_was_written_from() {
        use crate::toolpath::Move;
        let built = build_pocket(&project(), "j").unwrap();
        let cuts: Vec<[f64; 3]> = built
            .program
            .moves
            .iter()
            .filter_map(|m| {
                if let Move::Feed { to, .. } = m {
                    Some(*to)
                } else {
                    None
                }
            })
            .collect();
        let read: Vec<[f64; 3]> = built
            .interpreted
            .segments
            .iter()
            .filter(|s| !s.rapid)
            .map(|s| s.to)
            .collect();
        assert_eq!(cuts.len(), read.len());
        for (a, b) in cuts.iter().zip(&read) {
            for axis in 0..3 {
                assert!(
                    (a[axis] - b[axis]).abs() <= 0.0005 + 1e-9,
                    "{a:?} was read back as {b:?}"
                );
            }
        }
    }

    /// The simulated pocket matches the shape the tool can reach: full depth
    /// everywhere inside it, untouched everywhere outside.
    #[test]
    fn simulated_pocket_has_no_gouges_and_no_leftover_material() {
        let project = project();
        let preview = preview_pocket(&project, "j").unwrap();
        assert_eq!(preview.problems, []);

        let design = project.design.as_ref().unwrap();
        let wanted = union(&design.placed_regions(&[0, 1]));
        let reachable = open(&wanted, 3.175 / 2.0);
        let map = &preview.map;
        // A cell's centre can sit up to 0.71 cells from a boundary it straddles.
        let margin = map.cell;
        let (mut inside, mut outside) = (0, 0);
        for iy in 0..map.ny {
            for ix in 0..map.nx {
                let p = map.centre(ix, iy);
                let z = map.at(ix, iy) as f64;
                let in_design = wanted.iter().any(|r| r.contains(p));
                let edge_distance = wanted
                    .iter()
                    .map(|r| r.distance_to_boundary(p))
                    .fold(f64::INFINITY, f64::min);
                if !in_design && edge_distance > margin {
                    assert_eq!(z, 0.0, "gouge outside the shape at {p:?}");
                    outside += 1;
                }
                let reach = reachable.iter().any(|r| r.contains(p));
                let reach_edge = reachable
                    .iter()
                    .map(|r| r.distance_to_boundary(p))
                    .fold(f64::INFINITY, f64::min);
                if reach && reach_edge > margin {
                    assert!((z + 2.0).abs() < 1e-4, "material left at {p:?}: height {z}");
                    inside += 1;
                }
                assert!(z >= -2.0 - 1e-4, "cut too deep at {p:?}");
            }
        }
        assert!(inside > 10_000 && outside > 10_000);
    }

    #[test]
    fn warns_about_corners_the_tool_cannot_reach() {
        let built = build_pocket(&project(), "j").unwrap();
        assert!(
            built
                .warnings
                .iter()
                .any(|w| w.contains("cannot reach") && w.contains("mm radius")),
            "{:?}",
            built.warnings
        );
    }

    #[test]
    fn explains_every_reason_a_job_cannot_be_built() {
        let reasons = |p: &Project| build_pocket(p, "j").unwrap_err().join(" | ");

        let p = with_inlay(Inlay::Flat {
            pocket_depth: 2.0,
            allowance: 0.1,
            tabs: false,
            tool_id: None,
        });
        assert!(reasons(&p).contains("Choose an end mill"));

        let p = with_inlay(Inlay::Flat {
            pocket_depth: 2.0,
            allowance: 0.1,
            tabs: false,
            tool_id: Some("t-vbit".into()),
        });
        assert!(reasons(&p).contains("is not an end mill"));

        let p = with_inlay(Inlay::Flat {
            pocket_depth: 25.0,
            allowance: 0.1,
            tabs: false,
            tool_id: Some("t-endmill".into()),
        });
        let text = reasons(&p);
        assert!(
            text.contains("only 18 mm thick") && text.contains("only 22 mm long"),
            "{text}"
        );

        let mut p = project();
        p.jobs[0].material = Material::Softwood;
        assert!(reasons(&p).contains("no cutting settings for softwood"));

        let mut p = project();
        p.tools[0].cutting[0].rpm = 15000;
        assert!(reasons(&p).contains("tops out at 13000 rpm"));

        let mut p = project();
        p.jobs[0].region_ids.clear();
        assert!(reasons(&p).contains("has no shapes"));

        let mut p = project();
        p.tools[0].diameter = 30.0;
        p.tools[0].cutting[0].stepover = 10.0;
        assert!(reasons(&p).contains("too wide to fit"));

        assert!(reasons(&with_inlay(Inlay::default_vcarve())).contains("not available yet"));
        assert!(build_pocket(&project(), "nope").unwrap_err()[0].contains("no longer exists"));
    }

    #[test]
    fn scale_and_mirror_are_applied_before_cutting() {
        let mut p = project();
        let design = p.design.as_mut().unwrap();
        design.scale = 2.0;
        design.mirror = true;
        p.jobs[0].region_ids = vec![0];
        let built = build_pocket(&p, "j").unwrap();
        // The rectangle spans X 5..35 of a 60 mm page: mirrored 25..55, doubled 50..110.
        let xs: Vec<f64> = built
            .interpreted
            .segments
            .iter()
            .filter(|s| !s.rapid)
            .map(|s| s.to[0])
            .collect();
        let (min, max) = (
            xs.iter().cloned().fold(f64::INFINITY, f64::min),
            xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
        );
        let r = 3.175 / 2.0;
        assert!(
            (min - (50.0 + r)).abs() < 0.01 && (max - (110.0 - r)).abs() < 0.01,
            "cut spans X {min}..{max}"
        );
    }

    #[test]
    fn file_names_are_safe_for_the_machine() {
        assert_eq!(file_stem("Żółw / coaster #2 (final)"), "w-coaster-2-final");
        assert_eq!(file_stem("???"), "inlay");
    }
}
