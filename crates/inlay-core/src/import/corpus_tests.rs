//! Runs the test drawings in `tests/drawings` through the app: each must
//! import as its manifest entry says, and every shape must either build or
//! say plainly why not. The drawings and the manifest are written by
//! `tools/make_test_drawings.py`, which works the expected numbers out from
//! the geometry.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;

use serde::Deserialize;

use super::dxf::import_dxf;
use super::svg::{import_svg, SvgImport};
use crate::build::{build, check_fit, preview, Part};
use crate::geom::ring_area;
use crate::project::{BaseStock, InsertStyle, Project, Step, Task};
use crate::tools::fixtures::{end_mill, v_bit};
use crate::tools::{CuttingSettings, Material};

#[derive(Debug, Deserialize)]
struct Case {
    file: String,
    regions: usize,
    /// Total area of all regions, mm².
    area: f64,
    /// Allowed error in the area, as a share of it.
    #[serde(default)]
    tolerance: Option<f64>,
    #[serde(default)]
    open: u32,
    #[serde(default)]
    has_text: bool,
    #[serde(default)]
    images: u32,
    #[serde(default)]
    specks: u32,
    #[serde(default)]
    unsupported: Vec<String>,
    /// Page width and height, mm.
    #[serde(default)]
    page: Option<[f64; 2]>,
    /// What the unit note must mention.
    #[serde(default)]
    unit: Option<String>,
    /// "all": every part of every kind of inlay must build for its shapes.
    #[serde(default)]
    build: Option<String>,
    #[serde(default)]
    simulate: bool,
}

fn directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/drawings")
}

fn cases() -> Vec<Case> {
    let text = std::fs::read_to_string(directory().join("manifest.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn import(case: &Case) -> Result<SvgImport, String> {
    let text = std::fs::read_to_string(directory().join(&case.file)).unwrap();
    if case.file.ends_with(".dxf") {
        import_dxf(&text, &case.file)
    } else {
        import_svg(&text, &case.file)
    }
}

#[test]
fn every_drawing_imports_as_its_manifest_entry_says() {
    let mut wrong: Vec<String> = Vec::new();
    let cases = cases();
    assert!(cases.len() >= 20);
    for case in &cases {
        let mut fail = |what: String| wrong.push(format!("{}: {what}", case.file));
        let out = match import(case) {
            Ok(out) => out,
            Err(e) => {
                fail(format!("did not import: {e}"));
                continue;
            }
        };
        let (design, report) = (&out.design, &out.report);
        if design.regions.len() != case.regions {
            fail(format!(
                "{} shapes, expected {}",
                design.regions.len(),
                case.regions
            ));
        }
        let area: f64 = design.regions.iter().map(|r| r.to_region().area()).sum();
        let tolerance = case.tolerance.unwrap_or(0.005);
        if (area - case.area).abs() > tolerance * case.area {
            fail(format!("area {area:.3} mm², expected {:.3}", case.area));
        }
        if report.open_outlines != case.open {
            fail(format!(
                "{} open outlines, expected {}",
                report.open_outlines, case.open
            ));
        }
        if report.has_text != case.has_text {
            fail(format!("text reported: {}", report.has_text));
        }
        if report.images != case.images {
            fail(format!(
                "{} images, expected {}",
                report.images, case.images
            ));
        }
        if report.specks != case.specks {
            fail(format!(
                "{} specks, expected {}",
                report.specks, case.specks
            ));
        }
        if report.unsupported != case.unsupported {
            fail(format!("left out {:?}", report.unsupported));
        }
        if let Some([width, height]) = case.page {
            if (design.width - width).abs() > 0.01 || (design.height - height).abs() > 0.01 {
                fail(format!(
                    "page {:.3} x {:.3} mm, expected {width:.3} x {height:.3}",
                    design.width, design.height
                ));
            }
        }
        match (&case.unit, &report.unit_note) {
            (Some(wanted), Some(note)) if note.contains(wanted.as_str()) => {}
            (None, None) => {}
            (wanted, note) => fail(format!("unit note {note:?}, expected {wanted:?}")),
        }
        // Every shape is well formed and lies on the page.
        for region in &design.regions {
            let on_page = region.outer.iter().all(|p| {
                p[0].is_finite()
                    && p[1].is_finite()
                    && p[0] > -0.01
                    && p[1] > -0.01
                    && p[0] < design.width + 0.01
                    && p[1] < design.height + 0.01
            });
            if region.outer.len() < 3 || ring_area(&region.outer) <= 0.0 || !on_page {
                fail(format!("shape {} is malformed or off the page", region.id));
            }
        }
        if let Err(e) = project_of(&out, &[], Kind::Flat).validate() {
            fail(format!("does not make a valid project: {e}"));
        }
    }
    assert!(wrong.is_empty(), "\n{}", wrong.join("\n"));
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Flat,
    /// One plug on a backer, cut out of its board with tabs.
    FlatBacker,
    /// With the plug cut out of its board, no tabs.
    Vcarve,
}

fn project_of(import: &SvgImport, region_ids: &[u32], kind: Kind) -> Project {
    let mut vbit = v_bit();
    vbit.cutting = vec![CuttingSettings::new(
        Material::HARDWOOD,
        12000,
        500.0,
        150.0,
        0.2,
        1.0,
    )];
    let tools = vec!["t-endmill".to_string()];
    let inlay = match kind {
        Kind::Vcarve => Task::Vcarve {
            engagement_depth: 2.0,
            glue_gap: 0.3,
            saw_gap: 1.5,
            plug_margin: 6.0,
            plug_thickness: 8.0,
            cut_out: true,
            tabs: false,
            clearing_tool_ids: tools,
            vbit_tool_id: Some("t-vbit".into()),
            relief: false,
            tuning: Default::default(),
        },
        Kind::Flat | Kind::FlatBacker => Task::Flat {
            pocket_depth: 2.0,
            allowance: 0.1,
            tabs: true,
            clearing_tool_ids: tools,
            insert_thickness: 5.0,
            insert_margin: 8.0,
            insert_style: if kind == Kind::Flat {
                InsertStyle::Loose
            } else {
                InsertStyle::Backer
            },
            saw_gap: 1.5,
            cut_out: true,
        },
    };
    Project {
        id: "p".into(),
        name: "Test".into(),
        design: Some(import.design.clone()),
        steps: vec![Step {
            id: "j".into(),
            name: "Inlay".into(),
            material: Material::HARDWOOD,
            region_ids: region_ids.to_vec(),
            setup: None,
            color: None,
            cut_out_tool_id: None,
            row_profiles: Default::default(),
            task: inlay,
        }],
        tools: vec![end_mill(), vbit],
        profiles: Vec::new(),
        base: BaseStock::default(),
        machine: Default::default(),
        setup: Default::default(),
    }
}

/// The ids of a drawing's largest shapes, largest first.
fn largest(import: &SvgImport, count: usize) -> Vec<u32> {
    let mut regions: Vec<(u32, f64)> = import
        .design
        .regions
        .iter()
        .map(|r| (r.id, r.to_region().area()))
        .collect();
    regions.sort_by(|a, b| b.1.total_cmp(&a.1));
    regions.into_iter().take(count).map(|r| r.0).collect()
}

const KINDS: [Kind; 3] = [Kind::Flat, Kind::FlatBacker, Kind::Vcarve];

#[test]
fn every_shape_builds_or_says_plainly_why_not() {
    let mut wrong: Vec<String> = Vec::new();
    let mut built = 0;
    let mut refused = 0;
    for case in cases() {
        let Ok(import) = import(&case) else { continue };
        let must = case.build.as_deref() == Some("all");
        for id in largest(&import, 3) {
            for kind in KINDS {
                let project = project_of(&import, &[id], kind);
                for part in [Part::Pocket, Part::Plug] {
                    let what = format!("{}: shape {id}, {kind:?} {part:?}", case.file);
                    match catch_unwind(AssertUnwindSafe(|| build(&project, "j", part))) {
                        Err(_) => wrong.push(format!("{what}: the app crashed")),
                        Ok(Ok(file)) => {
                            built += 1;
                            if file.gcode.is_empty() || file.stats.cutting_length <= 0.0 {
                                wrong.push(format!("{what}: an empty file"));
                            }
                        }
                        Ok(Err(reasons)) => {
                            refused += 1;
                            let text = reasons.join(" | ");
                            if must || reasons.is_empty() || text.contains("Internal error") {
                                wrong.push(format!("{what}: {text}"));
                            }
                        }
                    }
                }
            }
        }
    }
    assert!(wrong.is_empty(), "\n{}", wrong.join("\n"));
    // Most shapes build; the thin letters are the ones that cannot.
    assert!(
        built > 200 && refused > 0,
        "{built} built, {refused} refused"
    );
}

#[test]
fn chosen_drawings_simulate_without_problems_and_fit() {
    for case in cases().into_iter().filter(|c| c.simulate) {
        let import = import(&case).unwrap();
        let id = largest(&import, 1)[0];
        for kind in KINDS {
            let project = project_of(&import, &[id], kind);
            for part in [Part::Pocket, Part::Plug] {
                let preview = preview(&project, "j", part)
                    .unwrap_or_else(|e| panic!("{}: {kind:?} {part:?}: {e:?}", case.file));
                assert_eq!(preview.problems, vec![], "{}: {kind:?} {part:?}", case.file);
            }
            if kind == Kind::Vcarve {
                let fit = check_fit(&project, "j").unwrap().fit.report;
                // Seated as designed, or held off only by the bit's tip flat
                // at sharp corners: a little wood to crush, in very few places.
                let seated = fit.proud.abs() < 0.05 && fit.wall_contact > 0.9;
                let corners_only = fit.press_overlap < 0.15 && fit.press_overlap_area < 2.0;
                assert!(
                    (seated || corners_only) && fit.void_width < 0.15,
                    "{}: {fit:?}",
                    case.file
                );
            }
        }
    }
}

/// A sketch of several parts, the figures on the house chosen, a 2 mm end
/// mill stepping over by more than its radius and a 30° engraving bit with a
/// tip flat: the end mill must leave nothing standing on the plug's floor,
/// and the plug must be held off by no more than the tip flat explains.
#[test]
fn a_wide_stepover_leaves_no_wood_standing_on_a_plug() {
    let case = cases()
        .into_iter()
        .find(|c| c.file == "dxf-11-several-parts.dxf")
        .unwrap();
    let import = import(&case).unwrap();
    // The three figures, without the hole in the first.
    let figures: Vec<u32> = import
        .design
        .regions
        .iter()
        .filter(|r| {
            let ys = r.outer.iter().map(|q| q[1]);
            let top = ys.clone().fold(f64::MIN, f64::max);
            let bottom = ys.fold(f64::MAX, f64::min);
            let right = r.outer.iter().map(|q| q[0]).fold(f64::MIN, f64::max);
            bottom > 10.0 && top < 32.0 && right < 70.0 && r.to_region().area() > 40.0
        })
        .map(|r| r.id)
        .collect();
    assert_eq!(figures.len(), 3);

    let mut project = project_of(&import, &figures, Kind::Vcarve);
    project.tools[0].diameter = 2.0;
    project.tools[0].cutting[0].stepover = 1.26;
    project.tools[1].tip_angle = Some(30.0);
    project.tools[1].tip_diameter = Some(0.2);
    project.tools[1].diameter = 4.0;
    if let Task::Vcarve { cut_out, .. } = &mut project.steps[0].task {
        *cut_out = false;
    }

    let plug = preview(&project, "j", Part::Plug).unwrap();
    assert_eq!(plug.problems, vec![]);
    // The floor is the engagement depth plus the saw gap down; the walls
    // reach less than 1 mm out from the shapes there.
    let floor = -(2.0 + 1.5);
    let shapes = &plug.built.pocket;
    let mut standing = 0;
    for iy in 0..plug.map.ny {
        for ix in 0..plug.map.nx {
            if f64::from(plug.map.at(ix, iy)) < floor + 0.05 {
                continue;
            }
            let q = plug.map.centre(ix, iy);
            let clear_of_shapes = !shapes.iter().any(|r| r.contains(q))
                && shapes.iter().all(|r| r.distance_to_boundary(q) > 1.0);
            if clear_of_shapes {
                standing += 1;
            }
        }
    }
    assert_eq!(standing, 0, "cells of wood left standing on the floor");

    let fit = check_fit(&project, "j").unwrap().fit.report;
    // A 0.2 mm flat on a 30° bit can hold a sharp corner 0.1 / tan 15° up.
    let tip_rise = 0.1 / 15f64.to_radians().tan();
    assert!(
        fit.proud < tip_rise + 0.05 && fit.press_overlap_area < 5.0,
        "{fit:?}"
    );
}

/// Shapes that share an edge, such as a figure and the hole in it, or a
/// plate and a figure on it, can be chosen together: merging them must not
/// leave a sliver along the shared edge that stops the carving.
#[test]
fn any_two_shapes_of_a_drawing_can_be_carved_together() {
    let case = cases()
        .into_iter()
        .find(|c| c.file == "dxf-11-several-parts.dxf")
        .unwrap();
    let import = import(&case).unwrap();
    let ids: Vec<u32> = import.design.regions.iter().map(|r| r.id).collect();
    let mut wrong = Vec::new();
    for (i, a) in ids.iter().enumerate() {
        for b in &ids[i + 1..] {
            let project = project_of(&import, &[*a, *b], Kind::Vcarve);
            if let Err(e) = build(&project, "j", Part::Pocket) {
                wrong.push(format!("shapes {a} and {b}: {e:?}"));
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "
{}",
        wrong.join(
            "
"
        )
    );
}

/// How long a full bed of shapes takes. Run by hand:
/// `cargo test -p inlay-core --release full_bed -- --ignored --nocapture`
#[test]
#[ignore]
fn full_bed_step_timing() {
    let case = cases()
        .into_iter()
        .find(|c| c.file == "svg-14-full-bed.svg")
        .unwrap();
    let import = import(&case).unwrap();
    let all: Vec<u32> = import.design.regions.iter().map(|r| r.id).collect();
    for kind in KINDS {
        let project = project_of(&import, &all, kind);
        for part in [Part::Pocket, Part::Plug] {
            let start = std::time::Instant::now();
            match preview(&project, "j", part) {
                Ok(p) => println!(
                    "{kind:?} {part:?}: {:.1} s to generate and simulate, {} lines, {:.0} min of cutting, {} problems, cell {} mm",
                    start.elapsed().as_secs_f64(),
                    p.built.stats.lines,
                    p.built.stats.minutes,
                    p.problems.len(),
                    p.map.cell
                ),
                Err(e) => println!("{kind:?} {part:?}: {:.1} s, refused: {e:?}", start.elapsed().as_secs_f64()),
            }
        }
    }
}
