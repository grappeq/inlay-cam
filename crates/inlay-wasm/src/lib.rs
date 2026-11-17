//! Thin WebAssembly wrapper around `inlay-core`. No logic lives here.
//!
//! Structured values cross the boundary as JSON text. The matching
//! TypeScript types are in `web/src/core/types.ts`.

use std::cell::RefCell;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::rc::Rc;

use inlay_core::build;
use inlay_core::feeds;
use inlay_core::import::{dxf, svg, tools_yaml};
use inlay_core::project::{self, Project};
use inlay_core::tools::{self, Tool, ToolLibrary};
use wasm_bindgen::prelude::*;

fn to_json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("core values always serialize")
}

fn from_json<T: serde::de::DeserializeOwned>(text: &str, what: &str) -> Result<T, JsError> {
    serde_json::from_str(text)
        .map_err(|e| JsError::new(&format!("Internal error: bad {what} data ({e})")))
}

fn err(e: impl std::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

/// Version of the core, so the UI can show that the module loaded.
#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    inlay_core::version().to_string()
}

/// Imports an SVG drawing. Returns `SvgImport` as JSON.
#[wasm_bindgen(js_name = importSvg)]
pub fn import_svg(text: &str, source_name: &str) -> Result<String, JsError> {
    svg::import_svg(text, source_name)
        .map(|v| to_json(&v))
        .map_err(err)
}

/// Imports a DXF drawing (text form). Returns `SvgImport` as JSON.
#[wasm_bindgen(js_name = importDxf)]
pub fn import_dxf(text: &str, source_name: &str) -> Result<String, JsError> {
    dxf::import_dxf(text, source_name)
        .map(|v| to_json(&v))
        .map_err(err)
}

/// Imports a tooling-library `tools.yaml`. Returns `ToolsYamlImport` as
/// JSON; the tools have empty ids.
#[wasm_bindgen(js_name = importToolsYaml)]
pub fn import_tools_yaml(text: &str) -> Result<String, JsError> {
    tools_yaml::import_tools_yaml(text)
        .map(|v| to_json(&v))
        .map_err(err)
}

/// Reads a project file of any supported version. Returns `Project` as JSON.
#[wasm_bindgen(js_name = projectFromFile)]
pub fn project_from_file(text: &str) -> Result<String, JsError> {
    project::project_from_file_json(text)
        .map(|v| to_json(&v))
        .map_err(err)
}

/// Validates a project and writes it as a project file.
#[wasm_bindgen(js_name = projectToFile)]
pub fn project_to_file(project_json: &str) -> Result<String, JsError> {
    let project: Project = from_json(project_json, "project")?;
    project.validate().map_err(err)?;
    Ok(project::project_to_file_json(&project))
}

/// Reads a tool-library file of any supported version. Returns
/// `ToolLibrary` as JSON.
#[wasm_bindgen(js_name = libraryFromFile)]
pub fn library_from_file(text: &str) -> Result<String, JsError> {
    tools::library_from_file_json(text)
        .map(|v| to_json(&v))
        .map_err(err)
}

/// Validates a tool library and writes it as a tool-library file.
#[wasm_bindgen(js_name = libraryToFile)]
pub fn library_to_file(library_json: &str) -> Result<String, JsError> {
    let library: ToolLibrary = from_json(library_json, "tool library")?;
    library.validate().map_err(err)?;
    Ok(tools::library_to_file_json(&library))
}

/// Validates a tool library and writes it as a tooling-library `tools.yaml`.
#[wasm_bindgen(js_name = libraryToToolsYaml)]
pub fn library_to_tools_yaml(library_json: &str) -> Result<String, JsError> {
    let library: ToolLibrary = from_json(library_json, "tool library")?;
    library.validate().map_err(err)?;
    Ok(tools_yaml::write_tools_yaml(&library))
}

/// A tool list as a library for Makera CAM (`app` = `cam`) or Makera Studio
/// (`studio`). `now` is the time, ISO-8601 UTC, that Makera Studio's
/// settings without a time of their own are given. Returns
/// `{ bytes, warnings, tools, settings, materials }` as JSON, the bytes as a
/// list of numbers. Fails when Makera CAM could not read the result.
#[wasm_bindgen(js_name = exportMakera)]
pub fn export_makera(library_json: &str, app: &str, now: &str) -> Result<String, JsError> {
    use inlay_core::export::makera;
    let library: ToolLibrary = from_json(library_json, "tool library")?;
    library.validate().map_err(err)?;
    let (built, warnings) = if app == "cam" {
        makera::build_cam(&library).map_err(err)?
    } else {
        makera::build_studio(&library, now)
    };
    let tools: usize = built.groups.iter().map(|g| g.tools.len()).sum();
    let settings: usize = built
        .groups
        .iter()
        .flat_map(|g| &g.tools)
        .map(|t| t.settings.len())
        .sum();
    Ok(serde_json::json!({
        "bytes": makera::write(&built),
        "warnings": warnings,
        "tools": tools,
        "settings": settings,
        "materials": built.materials.len(),
    })
    .to_string())
}

/// A tool list as a Fusion 360 tool library. Returns
/// `{ library, sections: [{ name, text }], warnings, tools, presets }` as
/// JSON: one library with every tool, and the same as one per top-level group.
#[wasm_bindgen(js_name = exportFusion)]
pub fn export_fusion(library_json: &str) -> Result<String, JsError> {
    let library: ToolLibrary = from_json(library_json, "tool library")?;
    library.validate().map_err(err)?;
    let fusion = inlay_core::export::fusion::build_fusion(&library);
    let sections: Vec<serde_json::Value> = fusion
        .sections
        .iter()
        .map(|(name, text)| serde_json::json!({ "name": name, "text": text }))
        .collect();
    Ok(serde_json::json!({
        "library": fusion.library,
        "sections": sections,
        "warnings": fusion.warnings,
        "tools": fusion.tools,
        "presets": fusion.presets,
    })
    .to_string())
}

/// Holds a library that Makera CAM or Makera Studio exported against a tool
/// list. Returns the `MakeraImportPlan` as JSON: what differs, to be ticked.
#[wasm_bindgen(js_name = planMakeraImport)]
pub fn plan_makera_import(library_json: &str, data: &[u8]) -> Result<String, JsError> {
    let library: ToolLibrary = from_json(library_json, "tool library")?;
    let plan = inlay_core::import::makera::plan(&library, data).map_err(err)?;
    Ok(to_json(&plan))
}

/// The tool list with the ticked changes of a plan made to it. `selected_json`
/// is the list of the changes' ids. Returns the `ToolLibrary` as JSON.
#[wasm_bindgen(js_name = applyMakeraImport)]
pub fn apply_makera_import(
    library_json: &str,
    plan_json: &str,
    selected_json: &str,
) -> Result<String, JsError> {
    let library: ToolLibrary = from_json(library_json, "tool library")?;
    let plan: inlay_core::import::makera::Plan = from_json(plan_json, "import plan")?;
    let selected: Vec<String> = from_json(selected_json, "selected changes")?;
    let out = inlay_core::import::makera::apply_plan(&library, &plan, &selected).map_err(err)?;
    Ok(to_json(&out))
}

/// A starting point for a tool's cutting settings in a material, from the
/// feeds model. `options_json` is `FeedOptions`; returns `FeedSuggestion` as
/// JSON, whose status says whether there are values and whether to trust them.
#[wasm_bindgen(js_name = suggestFeeds)]
pub fn suggest_feeds(
    tool_json: &str,
    material: &str,
    options_json: &str,
) -> Result<String, JsError> {
    let tool: Tool = from_json(tool_json, "tool")?;
    let options: feeds::Options = from_json(options_json, "feed options")?;
    Ok(to_json(&feeds::suggest_for(&tool, material, &options)))
}

/// The feeds model's suggestion for a tool and material at each of its five
/// stops, gentlest first. `flags_json` is `{ ramping, adaptive, lubricated }`.
/// Returns `FeedSuggestion[]` as JSON.
#[wasm_bindgen(js_name = suggestStops)]
pub fn suggest_stops(tool_json: &str, material: &str, flags_json: &str) -> Result<String, JsError> {
    #[derive(serde::Deserialize)]
    struct Flags {
        ramping: bool,
        adaptive: bool,
        lubricated: bool,
        #[serde(default)]
        spindle: feeds::Spindle,
    }
    let tool: Tool = from_json(tool_json, "tool")?;
    let flags: Flags = from_json(flags_json, "feed flags")?;
    Ok(to_json(&feeds::suggest_stops(
        &tool,
        material,
        flags.ramping,
        flags.adaptive,
        flags.lubricated,
        flags.spindle,
    )))
}

/// Everything the feeds model has for one cutting row: every stop with and
/// without a ramped entry, adaptive clearing and lubrication, where to start,
/// and what the row's own numbers are checked against. `profile_json` is the
/// row's `Profile`, or `null` for a plain row; `machine_json` the `Machine`
/// whose spindle speeds the suggestions keep to. Returns `FeedEntry` as JSON.
#[wasm_bindgen(js_name = suggestEntry)]
pub fn suggest_entry(
    tool_json: &str,
    material: &str,
    profile_json: &str,
    machine_json: &str,
) -> Result<String, JsError> {
    let tool: Tool = from_json(tool_json, "tool")?;
    let machine: inlay_core::project::Machine = from_json(machine_json, "machine")?;
    let profile: Option<inlay_core::tools::Profile> = from_json(profile_json, "profile")?;
    Ok(to_json(&feeds::suggest_entry(
        &tool,
        material,
        profile.as_ref(),
        feeds::Spindle::of(&machine),
    )))
}

/// Holds a cutting row's numbers against the feeds model. `values_json` is
/// `{ rpm, feed, plunge, stepover, stepdown, adaptive }` and `machine_json`
/// the `Machine`. Returns `RowCheck` as JSON.
#[wasm_bindgen(js_name = checkRow)]
pub fn check_row(
    tool_json: &str,
    material: &str,
    values_json: &str,
    machine_json: &str,
) -> Result<String, JsError> {
    let machine: inlay_core::project::Machine = from_json(machine_json, "machine")?;
    #[derive(serde::Deserialize)]
    struct Numbers {
        rpm: u32,
        feed: f64,
        plunge: f64,
        /// mm.
        stepover: f64,
        stepdown: f64,
        /// The row is for adaptive clearing.
        adaptive: bool,
    }
    let tool: Tool = from_json(tool_json, "tool")?;
    let v: Numbers = from_json(values_json, "row values")?;
    Ok(to_json(&feeds::check_row(
        &tool,
        material,
        v.rpm,
        v.feed,
        v.plunge,
        v.stepover,
        v.stepdown,
        v.adaptive,
        feeds::Spindle::of(&machine),
    )))
}

/// What wants looking at in a tool list: failed and unconfirmed results,
/// things to check, and what is missing. Returns `Attention[]` as JSON.
#[wasm_bindgen(js_name = needsAttention)]
pub fn needs_attention(tools_json: &str) -> Result<String, JsError> {
    let list: Vec<Tool> = from_json(tools_json, "tool list")?;
    Ok(to_json(&tools::needs_attention(&list)))
}

/// The standard name to offer for a tool. `named` is the name a V-bit is read
/// by (the one it is saved under); `taken_json` every other tool's name and
/// shown name. Returns `{ name, accepted }` as JSON, or `null`.
#[wasm_bindgen(js_name = suggestName)]
pub fn suggest_name(tool_json: &str, named: &str, taken_json: &str) -> Result<String, JsError> {
    let tool: Tool = from_json(tool_json, "tool")?;
    let taken: Vec<String> = from_json(taken_json, "taken names")?;
    Ok(to_json(&inlay_core::naming::suggest(&tool, named, &taken)))
}

/// Checks one tool. Returns the problem as text, or nothing when it is valid.
#[wasm_bindgen(js_name = validateTool)]
pub fn validate_tool(tool_json: &str) -> Result<Option<String>, JsError> {
    let tool: Tool = from_json(tool_json, "tool")?;
    Ok(tool.validate().err())
}

/// The result of building one part's file and simulating it.
#[wasm_bindgen]
pub struct PocketPreview {
    preview: Rc<build::Preview>,
}

/// The last simulated pocket and plug, kept so that checking their fit does
/// not simulate them a second time. Keyed by the project text and step.
struct Kept {
    key: u64,
    part: build::Part,
    preview: Rc<build::Preview>,
}

thread_local! {
    static KEPT: RefCell<Vec<Kept>> = const { RefCell::new(Vec::new()) };
}

fn key_of(project_json: &str, step_id: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    project_json.hash(&mut hasher);
    step_id.hash(&mut hasher);
    hasher.finish()
}

/// The simulated part for exactly this project and step: the kept one, or a
/// fresh one, which is then kept. At most one of each part is kept.
fn preview_of(
    project: &Project,
    project_json: &str,
    step_id: &str,
    part: build::Part,
) -> Result<Rc<build::Preview>, Vec<String>> {
    let key = key_of(project_json, step_id);
    let kept = KEPT.with(|k| {
        k.borrow()
            .iter()
            .find(|e| e.key == key && e.part == part)
            .map(|e| e.preview.clone())
    });
    if let Some(preview) = kept {
        return Ok(preview);
    }
    let preview = Rc::new(build::preview(project, step_id, part)?);
    KEPT.with(|k| {
        let mut k = k.borrow_mut();
        k.retain(|e| e.part != part);
        k.push(Kept {
            key,
            part,
            preview: preview.clone(),
        });
    });
    Ok(preview)
}

fn reasons(reasons: Vec<String>) -> JsError {
    JsError::new(&reasons.join("\n"))
}

#[wasm_bindgen]
impl PocketPreview {
    /// `PreviewInfo` as JSON: the G-code, statistics, warnings, problems and
    /// the height map's dimensions.
    #[wasm_bindgen(getter)]
    pub fn info(&self) -> String {
        let p = &self.preview;
        let problems = problems_json(&p.problems);
        serde_json::json!({
            "built": p.built,
            "problems": problems,
            "cell": p.map.cell,
            "nx": p.map.nx,
            "ny": p.map.ny,
        })
        .to_string()
    }

    /// Stock height per cell, row by row from Y = 0, each row from X = 0.
    #[wasm_bindgen(getter)]
    pub fn heights(&self) -> Vec<f32> {
        self.preview.map.z.clone()
    }

    /// The tool's path as read back from the G-code: nine numbers per
    /// straight piece, `x0 y0 z0 x1 y1 z1 rapid tool line` (rapid is 1 or
    /// 0, tool the tool's number, line the line of the file).
    #[wasm_bindgen(getter)]
    pub fn path(&self) -> Vec<f32> {
        path_of(&self.preview.built.interpreted.segments)
    }
}

/// A tool path as nine numbers per straight piece.
fn path_of(segments: &[inlay_core::gcode::Segment]) -> Vec<f32> {
    let mut out = Vec::with_capacity(segments.len() * 9);
    for s in segments {
        out.extend(s.from.iter().chain(s.to.iter()).map(|v| *v as f32));
        out.push(if s.rapid { 1.0 } else { 0.0 });
        out.push(s.tool as f32);
        out.push(s.line as f32);
    }
    out
}

fn problems_json(problems: &[inlay_core::sim::SimProblem]) -> Vec<serde_json::Value> {
    problems
        .iter()
        .map(|problem| serde_json::json!({ "line": problem.line, "message": problem.message }))
        .collect()
}

/// The stock taken through every inlay and operation of a project, in the
/// order of the list.
#[wasm_bindgen]
pub struct StockTimeline {
    timeline: inlay_core::timeline::Timeline,
}

#[wasm_bindgen]
impl StockTimeline {
    /// `TimelineInfo` as JSON: the grid, the inlays glued in, the files
    /// for the stock, and each step with its problems, errors and seat.
    #[wasm_bindgen(getter)]
    pub fn info(&self) -> String {
        let t = &self.timeline;
        let files: Vec<_> = t
            .files
            .iter()
            .map(|file| {
                serde_json::json!({
                    "stepIds": file.step_ids,
                    "built": file.built,
                    "complete": file.complete,
                    "errors": file.errors,
                    "problems": problems_json(&file.problems),
                })
            })
            .collect();
        let parts: Vec<_> = t
            .parts
            .iter()
            .map(|part| {
                serde_json::json!({
                    "stepId": part.step_id,
                    "built": part.built,
                    "errors": part.errors,
                    "problems": problems_json(&part.problems),
                })
            })
            .collect();
        let steps: Vec<_> = t
            .steps
            .iter()
            .map(|step| {
                serde_json::json!({
                    "stepId": step.step_id,
                    "byHand": step.by_hand,
                    "file": step.file,
                    "problems": problems_json(&step.problems),
                    "errors": step.errors,
                    "warnings": step.warnings,
                    "seat": step.seat,
                    "startsAbove": step.starts_above,
                })
            })
            .collect();
        serde_json::json!({
            "cell": t.cell,
            "nx": t.nx,
            "ny": t.ny,
            "simulatedCell": t.simulated_cell,
            "thickness": t.thickness,
            "glued": t.glued,
            "files": files,
            "parts": parts,
            "steps": steps,
        })
        .to_string()
    }

    /// Stock height per cell at a point of the list: 0 for the fresh
    /// stock, `n` for the stock after step `n`.
    pub fn heights(&self, at: usize) -> Vec<f32> {
        self.timeline
            .snapshots
            .get(at)
            .map(|s| s.heights.clone())
            .unwrap_or_default()
    }

    /// Whose wood each cell is in at that point: 0 for the stock's own,
    /// else the number of a glued-in inlay, counted from 1.
    pub fn owners(&self, at: usize) -> Vec<u8> {
        self.timeline
            .snapshots
            .get(at)
            .map(|s| s.owners.clone())
            .unwrap_or_default()
    }

    /// Where a cell is in glued-in wood at that point: the height of that
    /// wood's underside. NaN elsewhere.
    pub fn unders(&self, at: usize) -> Vec<f32> {
        self.timeline
            .snapshots
            .get(at)
            .map(|s| s.unders.clone())
            .unwrap_or_default()
    }

    /// And the surface that wood was put on. NaN elsewhere.
    pub fn floors(&self, at: usize) -> Vec<f32> {
        self.timeline
            .snapshots
            .get(at)
            .map(|s| s.floors.clone())
            .unwrap_or_default()
    }

    /// The tool path of a step: its stretch of its file, as a preview's
    /// path, with the file's lines and tool numbers. Empty for a step
    /// without a file.
    pub fn path(&self, step: usize) -> Vec<f32> {
        self.timeline
            .steps
            .get(step)
            .map(|s| path_of(&s.segments))
            .unwrap_or_default()
    }
}

thread_local! {
    static TIMELINE: RefCell<inlay_core::timeline::Cache> = RefCell::new(Default::default());
}

/// Takes the stock through every inlay and operation of the project.
#[wasm_bindgen(js_name = stockTimeline)]
pub fn stock_timeline(project_json: &str) -> Result<StockTimeline, JsError> {
    let project: Project = from_json(project_json, "project")?;
    project.validate().map_err(err)?;
    // What the last call came to is kept, so that only the steps from the
    // first that changed are done again.
    TIMELINE.with(|kept| {
        inlay_core::timeline::timeline_with(&project, &mut kept.borrow_mut())
            .map(|timeline| StockTimeline { timeline })
            .map_err(reasons)
    })
}

/// Builds the G-code for one part of a step ("pocket" or "plug") and
/// simulates it. Fails with every reason, one per line.
#[wasm_bindgen(js_name = previewPart)]
pub fn preview_part(
    project_json: &str,
    step_id: &str,
    part: &str,
) -> Result<PocketPreview, JsError> {
    let project: Project = from_json(project_json, "project")?;
    project.validate().map_err(err)?;
    let part = match part {
        "pocket" => build::Part::Pocket,
        "plug" => build::Part::Plug,
        other => return Err(JsError::new(&format!("Unknown part \"{other}\"."))),
    };
    // A facing that takes the wood above the surface from the list starts
    // where that wood stands on the stock, as its part of the stock's file
    // does: the stock is taken through the list for it, from what is kept.
    let standing = (part == build::Part::Pocket)
        .then(|| {
            TIMELINE.with(|kept| {
                inlay_core::timeline::starts_above(&project, step_id, &mut kept.borrow_mut())
            })
        })
        .flatten();
    if standing.is_some() {
        return build::preview_with(&project, step_id, part, standing)
            .map(|preview| PocketPreview {
                preview: Rc::new(preview),
            })
            .map_err(reasons);
    }
    preview_of(&project, project_json, step_id, part)
        .map(|preview| PocketPreview { preview })
        .map_err(reasons)
}

/// For a facing: how far above the surface its first pass begins, as given
/// or as the list gives it. `None` for any other step.
#[wasm_bindgen(js_name = facingStart)]
pub fn facing_start(project_json: &str, step_id: &str) -> Result<Option<f64>, JsError> {
    let project: Project = from_json(project_json, "project")?;
    Ok(build::facing_start(&project, step_id).map(|(_, above)| above))
}

/// Both parts of a V-carve inlay simulated and fitted together.
#[wasm_bindgen]
pub struct FitCheck {
    fit: inlay_core::analysis::Fit,
    pocket: Rc<build::Preview>,
    plug: Rc<build::Preview>,
}

#[wasm_bindgen]
impl FitCheck {
    /// The fit report and the grid's dimensions, as JSON.
    #[wasm_bindgen(getter)]
    pub fn info(&self) -> String {
        let fit = &self.fit;
        serde_json::json!({
            "report": fit.report,
            "verdict": fit.verdict,
            "cell": fit.cell,
            "nx": fit.nx,
            "ny": fit.ny,
            "problems": self.pocket.problems.len() + self.plug.problems.len(),
        })
        .to_string()
    }

    /// Space between pocket and plug per cell, mm; NaN where no plug lies
    /// over the base board. Row by row from Y = 0.
    #[wasm_bindgen(getter)]
    pub fn gap(&self) -> Vec<f32> {
        self.fit.gap.clone()
    }

    /// Underside of the resting plug per cell, in the base board's Z; NaN
    /// where there is no plug.
    #[wasm_bindgen(getter, js_name = plugUnder)]
    pub fn plug_under(&self) -> Vec<f32> {
        self.fit.plug_under.clone()
    }

    /// The finished face per cell: 0 base board, 1 plug, 2 gap.
    #[wasm_bindgen(getter)]
    pub fn face(&self) -> Vec<u8> {
        self.fit.face.clone()
    }

    /// The simulated base board per cell.
    #[wasm_bindgen(getter)]
    pub fn base(&self) -> Vec<f32> {
        self.pocket.map.z.clone()
    }
}

/// Builds and simulates both parts of a V-carve inlay and measures how the
/// plug fits the pocket. Fails with every reason, one per line.
#[wasm_bindgen(js_name = checkFit)]
pub fn check_fit(project_json: &str, step_id: &str) -> Result<FitCheck, JsError> {
    let project: Project = from_json(project_json, "project")?;
    project.validate().map_err(err)?;
    let pocket =
        preview_of(&project, project_json, step_id, build::Part::Pocket).map_err(reasons)?;
    let plug = preview_of(&project, project_json, step_id, build::Part::Plug).map_err(reasons)?;
    let fit = build::fit_of(&project, step_id, &pocket, &plug).map_err(reasons)?;
    Ok(FitCheck { fit, pocket, plug })
}
