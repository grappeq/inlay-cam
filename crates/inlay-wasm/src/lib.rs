//! Thin WebAssembly wrapper around `inlay-core`. No logic lives here.
//!
//! Structured values cross the boundary as JSON text. The matching
//! TypeScript types are in `web/src/core/types.ts`.

use std::cell::RefCell;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::rc::Rc;

use inlay_core::build;
use inlay_core::import::{dxf, svg, tools_yaml};
use inlay_core::project::{self, Project};
use inlay_core::tools::{self, Tool};
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

/// Imports the useful part of a tooling-library `tools.yaml`. Returns
/// `ToolsYamlImport` as JSON; the tools have empty ids.
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

/// Reads a tool-library file of any supported version. Returns `Tool[]` as JSON.
#[wasm_bindgen(js_name = toolsFromFile)]
pub fn tools_from_file(text: &str) -> Result<String, JsError> {
    tools::tools_from_file_json(text)
        .map(|v| to_json(&v))
        .map_err(err)
}

/// Validates a tool list and writes it as a tool-library file.
#[wasm_bindgen(js_name = toolsToFile)]
pub fn tools_to_file(tools_json: &str) -> Result<String, JsError> {
    let list: Vec<Tool> = from_json(tools_json, "tool list")?;
    tools::validate_tools(&list).map_err(err)?;
    Ok(tools::tools_to_file_json(&list))
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
/// not simulate them a second time. Keyed by the project text and job.
struct Kept {
    key: u64,
    part: build::Part,
    preview: Rc<build::Preview>,
}

thread_local! {
    static KEPT: RefCell<Vec<Kept>> = const { RefCell::new(Vec::new()) };
}

fn key_of(project_json: &str, job_id: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    project_json.hash(&mut hasher);
    job_id.hash(&mut hasher);
    hasher.finish()
}

/// The simulated part for exactly this project and job: the kept one, or a
/// fresh one, which is then kept. At most one of each part is kept.
fn preview_of(
    project: &Project,
    project_json: &str,
    job_id: &str,
    part: build::Part,
) -> Result<Rc<build::Preview>, Vec<String>> {
    let key = key_of(project_json, job_id);
    let kept = KEPT.with(|k| {
        k.borrow()
            .iter()
            .find(|e| e.key == key && e.part == part)
            .map(|e| e.preview.clone())
    });
    if let Some(preview) = kept {
        return Ok(preview);
    }
    let preview = Rc::new(build::preview(project, job_id, part)?);
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
        let problems: Vec<_> = p
            .problems
            .iter()
            .map(|problem| serde_json::json!({ "line": problem.line, "message": problem.message }))
            .collect();
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

    /// The tool's path as read back from the G-code: seven numbers per
    /// straight piece, `x0 y0 z0 x1 y1 z1 rapid` (rapid is 1 or 0).
    #[wasm_bindgen(getter)]
    pub fn path(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.preview.built.interpreted.segments.len() * 7);
        for s in &self.preview.built.interpreted.segments {
            out.extend(s.from.iter().chain(s.to.iter()).map(|v| *v as f32));
            out.push(if s.rapid { 1.0 } else { 0.0 });
        }
        out
    }
}

/// Builds the G-code for one part of a job ("pocket" or "plug") and
/// simulates it. Fails with every reason, one per line.
#[wasm_bindgen(js_name = previewPart)]
pub fn preview_part(
    project_json: &str,
    job_id: &str,
    part: &str,
) -> Result<PocketPreview, JsError> {
    let project: Project = from_json(project_json, "project")?;
    project.validate().map_err(err)?;
    let part = match part {
        "pocket" => build::Part::Pocket,
        "plug" => build::Part::Plug,
        other => return Err(JsError::new(&format!("Unknown part \"{other}\"."))),
    };
    preview_of(&project, project_json, job_id, part)
        .map(|preview| PocketPreview { preview })
        .map_err(reasons)
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
pub fn check_fit(project_json: &str, job_id: &str) -> Result<FitCheck, JsError> {
    let project: Project = from_json(project_json, "project")?;
    project.validate().map_err(err)?;
    let pocket =
        preview_of(&project, project_json, job_id, build::Part::Pocket).map_err(reasons)?;
    let plug = preview_of(&project, project_json, job_id, build::Part::Plug).map_err(reasons)?;
    let fit = build::fit_of(&project, job_id, &pocket, &plug).map_err(reasons)?;
    Ok(FitCheck { fit, pocket, plug })
}
