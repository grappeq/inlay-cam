# Wooden inlays app

A web app that generates CNC toolpaths for wooden inlays (V-carve and flat pocket),
writes G-code for the Carvera Community Firmware, and simulates the result.

Status: milestone 8 (review of the screens). One button generates both parts of an
inlay, with one or several end mills used in order, and checks how they fit. V-carve inlays have a simulated fit check; flat inlays a 2D one. See
[docs/requirements.md](docs/requirements.md), [docs/plan.md](docs/plan.md) and
[docs/formats.md](docs/formats.md).

## Layout

| Path | What |
|---|---|
| `crates/inlay-core` | Rust core: geometry, data model, file formats, importers; toolpaths, G-code and simulation later |
| `crates/inlay-wasm` | WebAssembly wrapper around the core |
| `web` | TypeScript + React UI; runs the core in a Web Worker |
| `machine-tests` | G-code files to run on the real machine, with checklists |
| `docs` | Requirements, plan and file formats |

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
