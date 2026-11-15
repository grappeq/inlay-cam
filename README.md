# inlay-cam

[![CI](https://github.com/grappeq/inlay-cam/actions/workflows/ci.yml/badge.svg)](https://github.com/grappeq/inlay-cam/actions/workflows/ci.yml)

A web app that turns a drawing into the two G-code files of a wooden inlay: one cuts the
pocket into the base board, the other cuts the piece that fills it. It simulates both
files and reports how the two parts will fit before any wood is cut.

- **V-carve inlays**, with sloped walls and sharp corners, and **flat inlays**, with
  upright walls, as loose pieces or as one plug.
- Reads **SVG and DXF** drawings; shapes can be moved, resized, turned and deleted in the
  app.
- Writes G-code for a **Carvera Air running the
  [Carvera Community Firmware](https://github.com/Carvera-Community/Carvera_Community_Firmware)**.
  No other controller is supported yet.
- The simulation runs on the text of the G-code file itself, and the **fit check** lowers
  the simulated plug into the simulated pocket.
- Everything runs in the browser. There is no server: drawings, projects and tools stay
  on your computer.

Try it at <https://grappeq.github.io/inlay-cam/>, and read the
[user guide](docs/guide.md).

## Status and safety

The app is new. All of its planned features are built and checked in simulation, and an
air cut on a Carvera Air confirmed that the firmware reads its G-code as intended (see
[machine-tests](machine-tests/README.md)). **No inlay has been cut with it yet.**

G-code moves a spinning tool. The simulation checks a file against the board and tools you
described, not against your machine as it stands: it cannot see clamps, a wrong work
origin or a tool that differs from its entry in the tool list. Check every file, run it
above the board first, and keep a hand near the stop button. The app comes with no
warranty (see [LICENSE](LICENSE)); what a file does on your machine is your
responsibility.

## Layout

| Path | What |
|---|---|
| `crates/inlay-core` | Rust core: geometry, data model, file formats, SVG and DXF import, toolpaths, G-code, simulation and fit check |
| `crates/inlay-wasm` | WebAssembly wrapper around the core |
| `web` | TypeScript + React UI; runs the core in a Web Worker |
| `machine-tests` | G-code files to run on the real machine, with checklists |
| `docs` | [User guide](docs/guide.md) and [file formats](docs/formats.md); `docs/design` holds the original [requirements](docs/design/requirements.md) and [build plan](docs/design/plan.md) |
| `tools` | The script that writes the test drawings |

## Building

Needs Rust (with the `wasm32-unknown-unknown` target), `wasm-pack` and Node.

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack --locked
cd web && npm install
```

```bash
cargo test --workspace          # core tests
cd web && npm run wasm          # build the core to WebAssembly into web/src/wasm
cd web && npm test              # tests of the drawing-arranging logic
cd web && npm run dev           # dev server on http://localhost:5173
cd web && npm run build         # type-check and build static files into web/dist
```

`npm run wasm` must be run once before `dev` or `build`, and again after changing Rust
code. The built app in `web/dist` is static files that work from any folder on any web
host.

## Contributing

Issues and pull requests are welcome, most of all reports from real cuts and drawings
that import wrongly (attach the file). Run `cargo test --workspace` and, in `web`,
`npm test` and `npm run build` before sending a change.

## Licence

[MIT](LICENSE). The interface uses IBM Plex Sans, under the SIL Open Font License.
