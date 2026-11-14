//! Thin WebAssembly wrapper around `inlay-core`. No logic lives here.

use inlay_core::geom::{medial, Region};
use wasm_bindgen::prelude::*;

/// Version of the core, so the UI can show that the module loaded.
#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    inlay_core::version().to_string()
}

/// Medial axis of one closed ring without holes.
///
/// `ring` is `[x0, y0, x1, y1, ...]` in mm. The result holds six numbers per
/// edge: `[ax, ay, ra, bx, by, rb]`, where `ra` and `rb` are the inscribed
/// radii at the two ends.
#[wasm_bindgen(js_name = medialAxisOfRing)]
pub fn medial_axis_of_ring(ring: &[f64]) -> Result<Vec<f64>, JsError> {
    let (points, rest) = ring.as_chunks::<2>();
    if !rest.is_empty() {
        return Err(JsError::new("ring must hold an even number of coordinates"));
    }
    let outer = points.to_vec();
    let edges =
        medial::medial_axis(&Region::new(outer)).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(edges
        .iter()
        .flat_map(|e| [e.a[0], e.a[1], e.ra, e.b[0], e.b[1], e.rb])
        .collect())
}
