//! Core of the wooden inlays app: geometry, toolpaths, G-code, simulation.
//!
//! Pure Rust with no browser dependencies, so everything here is tested natively.

pub mod file;
pub mod geom;
pub mod import;
pub mod project;
pub mod tools;

/// Version of the core, shown in the UI to confirm the WebAssembly module loaded.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
