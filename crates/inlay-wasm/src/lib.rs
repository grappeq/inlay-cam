//! Thin WebAssembly wrapper around `inlay-core`. No logic lives here.
//!
//! Structured values cross the boundary as JSON text. The matching
//! TypeScript types are in `web/src/core/types.ts`.

use inlay_core::build;
use inlay_core::import::{svg, tools_yaml};
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

/// The result of building a job's pocket file and simulating it.
#[wasm_bindgen]
pub struct PocketPreview {
    preview: build::Preview,
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

/// Builds the pocket G-code for a job and simulates it on the base board.
/// On failure the error message lists every reason, one per line.
#[wasm_bindgen(js_name = previewPocket)]
pub fn preview_pocket(project_json: &str, job_id: &str) -> Result<PocketPreview, JsError> {
    let project: Project = from_json(project_json, "project")?;
    project.validate().map_err(err)?;
    build::preview_pocket(&project, job_id)
        .map(|preview| PocketPreview { preview })
        .map_err(|reasons| {
            JsError::new(&reasons.join(
                "
",
            ))
        })
}
