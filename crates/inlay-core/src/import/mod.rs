//! Reading files made by other programs.

pub mod dxf;
mod dxf_binary;
pub mod join;
pub mod makera;
pub mod svg;
pub mod tools_yaml;

#[cfg(test)]
mod corpus_tests;
