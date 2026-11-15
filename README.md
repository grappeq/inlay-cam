# Wooden inlays app

A web app that generates CNC toolpaths for wooden inlays (V-carve and flat pocket),
writes G-code for the Carvera Community Firmware, and simulates the result.

Status: all planned milestones are built and checked in simulation; nothing has been cut
on the machine yet. To use the app, read [docs/guide.md](docs/guide.md). For what it is
meant to do and how it is built, see [docs/requirements.md](docs/requirements.md),
[docs/plan.md](docs/plan.md) and [docs/formats.md](docs/formats.md).

## Layout

| Path | What |
|---|---|
| `crates/inlay-core` | Rust core: geometry, data model, file formats, SVG and DXF import, toolpaths, G-code, simulation and fit check |
| `crates/inlay-wasm` | WebAssembly wrapper around the core |
| `web` | TypeScript + React UI; runs the core in a Web Worker |
| `machine-tests` | G-code files to run on the real machine, with checklists |
| `docs` | User guide, requirements, plan and file formats |
| `web` tests | `npm test` in `web` runs the tests of the drawing-arranging logic |
| `tools` | The script that writes the test drawings |

## Setup

Needs Rust (with the `wasm32-unknown-unknown` target), `wasm-pack` and Node.

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked
cd web && npm install
```

## Commands

```bash
cargo test --workspace          # core tests
cd web && npm run wasm          # build the core to WebAssembly into web/src/wasm
cd web && npm run dev           # dev server on http://localhost:5173
cd web && npm run build         # type-check and build static files into web/dist
```

`npm run wasm` must be run once before `dev` or `build`, and again after changing Rust
code.
