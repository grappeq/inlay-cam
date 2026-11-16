//! Core of the wooden inlays app: geometry, toolpaths, G-code, simulation.
//!
//! Pure Rust with no browser dependencies, so everything here is tested natively.

pub mod analysis;
pub mod build;
pub mod feeds;
pub mod file;
pub mod gcode;
pub mod geom;
pub mod import;
pub mod ops;
pub mod post;
pub mod project;
pub mod sim;
pub mod toolpath;
pub mod tools;

/// Version of the core, shown in the UI to confirm the WebAssembly module loaded.
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
