# Wooden inlays app: architecture and build plan (v1)

Draft, 2026-11-14. Requirements are in [requirements.md](requirements.md).

Library choices marked "to verify" come from research, not from use; milestone 0 exists
to confirm them before anything is built on top.

## 1. Architecture

### 1.1 Shape of the system

A static web app with two halves:

- **Core** (Rust, compiled to WebAssembly): all geometry, toolpath generation, G-code
  writing, G-code interpretation, simulation and fit analysis. No browser dependencies,
  so it is tested natively with `cargo test`.
- **UI** (TypeScript, React, Vite, three.js): import, shape selection, parameters, tool
  list, 3D and 2D views, storage. It calls the core through a Web Worker so long
  computations never freeze the page.

```
web/ (TypeScript UI)                    crates/ (Rust core)
  views, forms, three.js viewer           inlay-core   pure library, native tests
  storage (IndexedDB, file export)        inlay-wasm   thin wasm-bindgen wrapper
  worker.ts  <---- messages ---->         (loaded inside the worker)
```

### 1.2 The pipeline

Every job runs the same one-way pipeline. Each stage has a plain data output that can
be inspected and tested on its own.

1. **Import**: SVG -> closed regions (outer boundary plus holes), in mm.
2. **Selection**: the user picks regions; each selection becomes an inlay job with a type
   (V-carve or flat), tools and parameters.
3. **Part geometry**: the job is turned into two target shapes, pocket and plug/insert
   (mirrored), each with its own stock.
4. **Toolpaths**: operations per part produce a controller-independent list of moves
   (rapid, feed, arc, tool change, spindle).
5. **Post**: the Carvera profile turns moves into `.cnc` text.
6. **Interpret**: a strict G-code interpreter reads that text back into moves. It rejects
   anything it does not know.
7. **Simulate**: the interpreted moves cut a height map of the stock.
8. **Analyse**: fit analysis and safety checks run on the simulated parts.

Stages 6-8 work from the exact text that would be saved, so the preview shows what the
machine will receive, including any mistake in the post.

### 1.3 Core modules

| Module | Responsibility |
|---|---|
| `geom` | Polygons with holes, booleans, round offsets, medial axis, arc fitting |
| `import` | SVG parsing, units, transforms, curve flattening, clean-up into regions |
| `tools` | Tool model, app tool-list format, limited `tools.yaml` import |
| `project` | Project model, versioned file format, migrations |
| `ops::vcarve` | Pocket and plug V-carve paths, narrow-feature detection |
| `ops::clear` | Area clearing with a flat end mill (takes a list of tools) |
| `ops::flat` | Corner rounding, allowance, pocket, insert profile, tabs |
| `toolpath` | The move list shared by ops, post and simulator |
| `post::carvera` | Carvera Community Firmware output |
| `gcode` | Strict interpreter for the dialect the post emits |
| `sim` | Height-map material removal, tool profiles |
| `analysis` | Fit (gap map, section, trimmed face), safety checks, 2D flat-fit check |

### 1.4 Key technical decisions

**Geometry**
- Coordinates are snapped to a 1 µm integer grid for booleans, offsets and the medial
  axis; this is what the robust libraries require.
- Curves are flattened once, in design space. Pocket and plug are both derived from that
  same polyline, so their vertices correspond.
- Offsets and booleans: the `i_overlay` crate (verified in M0).
- Medial axis: segment Voronoi via the `boostvoronoi` crate (verified in M0), filtered to the
  inside of the region, with spurious branches from curve flattening pruned.

**V-carve inlays**
- User parameters map to cut depths as: pocket depth = engagement + glue gap; plug start
  depth = engagement; plug flat depth = saw gap.
- Depth along the medial axis = (inscribed radius - tip flat radius) / tan(half angle),
  clipped at the flat depth. Tip flat comes from the tool's tip diameter.
- Pocket: end-mill clearing of the flat floor first, then the V-bit along the walls and
  corner ramps, in depth passes with a final full-depth pass.
- Plug: same computation on the waste region around the mirrored design, shifted by the
  start depth; the uncut stock underneath is the backer.
- Narrow-feature warning: regions whose inscribed radius is below engagement x tan(half
  angle) are highlighted on the design.
- Clearing takes a list of tools from day one; v1 UI fills it with one.

**Flat pocket inlays**
- Both parts come from one "cuttable shape": the design opened then closed by a radius
  >= the finishing tool radius. This is where the tool diameter limits corner radius.
- The UI shows the design against the cuttable shape and the largest deviation, and the
  result changes live when a different tool is picked.
- Allowance is split between pocket (grown) and insert (shrunk).
- Wall fit is checked in exact 2D (insert outline vs pocket outline), not on the height
  map, because vertical walls blur on a grid.

**G-code (Carvera profile)**
- One file per part per job (pocket file, plug file), with `M6 Tn` between tools; on the
  Air that is a manual change prompt.
- Work coordinates G54, Z0 at stock top, XY origin at the lower-left of the stock. The
  file never homes, probes or sets offsets.
- All firmware rules from requirements are enforced by the writer and asserted in tests
  (line length, spacing, uppercase, I/J arcs, F after rapids, no G20/G43/canned cycles).
- Tool numbers: a per-project mapping, numbers above 6 by default so the same file is
  also correct on a Carvera with a rack.

**Simulation**
- Height map (one height per grid cell), stored in tiles allocated only where cutting
  happens. Default cell 0.05 mm; an "inspect" action recomputes a chosen region finer.
- Each tool is a radial profile (flat, V with tip flat), extended with shank and holder
  as non-cutting parts for collision checks.
- Each move is evaluated analytically per cell, not stamped at sub-steps.
- The simulation is authoritative on the CPU; the GPU only draws the result.

**Fit analysis (V-carve)**
- Mirror the simulated plug, lower it onto the simulated pocket until first contact,
  then report: seat height vs intended, glue gap under the plug, wall contact, where it
  touched first, and the face as it will look after trimming flush (with any visible
  voids measured).

**Safety checks**
- Rapids through remaining stock, cuts below stock bottom, machine travel (300 x 200 x
  130 mm), cut depth beyond flute length, shank or holder touching stock, spindle speed
  above the machine maximum.

**Storage and formats**
- Project and tool list are JSON with a `formatVersion` number.
- Loading runs a chain of migrations (v1 -> v2 -> ...). Each released version gets a
  fixture file in the test suite that must keep loading forever.
- Browser storage is IndexedDB; export and import use the same JSON.
- The project file embeds the tools it uses, so it opens correctly on a browser with a
  different tool list.
- Formats are documented in `docs/formats.md`, including which `tools.yaml` fields the
  import reads.

## 2. Testing

- **Analytic cases**: a straight V-groove, a circle and a square have exact answers for
  depth, cross-section and seat height; the generator and simulator must match them.
- **Property tests**: tool never leaves the allowed region; depth formula holds; no move
  outside machine travel; simulated heights never rise.
- **Round trip**: post -> interpreter returns the original moves within tolerance.
- **Golden files**: G-code per fixture design, compared by interpreted moves; firmware
  rules checked on the raw text.
- **Fit fixtures**: each sample design has bounds for seat height, glue gap and surface
  void width.
- **Format fixtures**: project and tool files from every released version.
- **UI**: a small end-to-end test of import -> generate -> export in a real browser.

## 3. Milestones

Each milestone ends with something you can try.

**M0. Foundations and risk checks**
- Repository, build, CI, Rust-to-WASM in a worker, an empty app that loads.
- Verify the library choices: medial axis on test shapes (letters, shapes with holes,
  curves), offsets and booleans, licences.
- A hand-written minimal `.cnc` file for you to run as an air cut on the Carvera Air.
  This confirms the firmware findings on the real machine before the post is written.
- Done when: the three checks pass or the plan is adjusted.

Results so far (2026-11-14):
- Medial axis: `boostvoronoi` 0.12.1 (BSL-1.0) works. Square, rectangle, L, frame with
  hole, star and a 180-segment circle match their exact answers, and 2000 random spiky
  shapes with a hole all satisfy the inscribed-circle property to within 2 µm.
- Offsets: `i_overlay` 9.1.0 (MIT or Apache-2.0, pure Rust) is used instead of the
  `clipper2` crate, which wraps C++ and would complicate the WebAssembly build. Inset,
  outset, opening and closing match exact areas; a shape opened then closed is stable
  under re-opening to within 0.02 mm.
- WebAssembly: both libraries build for the browser (209 kB module). `boostvoronoi`
  needs a random source, selected in `.cargo/config.toml`.
- App shell: the core loads in a Web Worker and computes a medial axis in the browser.
- Air cut: `machine-tests/m0-air-cut.cnc` is written but not yet run on the machine.
- Not done: CI (no remote repository yet).

**M1. Projects, tools, design import**
- Project model with versioned save, load, export, import.
- Tool list: manage, export, import, limited `tools.yaml` import; format documentation.
- SVG import with clean-up; 2D view; select regions and create inlay jobs.
- Done when: you can import an SVG and your tools, pick shapes and reload the project.

Results (2026-11-14): done.
- Core: tool and project models with validation; versioned file envelope with a
  migration chain (tested with fake migrations) and a version 1 fixture per file kind;
  SVG import via `usvg`; limited `tools.yaml` import. 54 tests.
- The real tooling library imports as 51 tools (36 end mills, 15 V-bits), 47 left out.
- UI: design view with clickable shapes, scale and mirror, inlay list and editor, tool
  list with editor, project open/new/import/export, autosave to IndexedDB, and
  drag-and-drop for every file type.
- Formats are documented in `docs/formats.md`.
- The WebAssembly module grew to 1.2 MB (about 0.5 MB compressed) because of the SVG
  parser.
- Region rule chosen here: shapes from different SVG paths stay separate regions even if
  they overlap; an inlay's geometry will be the union of its regions (M3).

**M2. G-code and simulation backbone**
- Move list, Carvera post, strict interpreter, height-map simulator, 3D viewer.
- Proven with the simplest operation: clearing a pocket with a flat end mill.
- Done when: a simple pocket exports as `.cnc` and shows correctly in the 3D preview.

Results (2026-11-14): done, with the caveats below.
- Move list, clearing operation, Carvera writer with a firmware-rule lint, strict
  interpreter, height-map simulator and 3D viewer are in place. 100 core tests.
- Checked by test: the written file reads back to the same moves; the simulated pocket is
  at full depth everywhere the tool can reach and untouched everywhere outside the shape;
  the simulator matches exact answers for a flat slot, a V-groove and a sloped V-bit move.
- In the app a flat inlay generates its pocket file: the sample design (4 pockets, 3 mm
  deep) builds and simulates in about a second.
- Tool numbers start at T1, in the order the tools are used. On the Carvera Air every
  change is a manual prompt. (A Carvera with a tool rack would auto-load slots T1 to T6;
  rack support is out of scope for v1.)
- Arcs are written, read and simulated, but no operation produces them yet: curves go out
  as short straight moves. Arc fitting is still to do.
- The simulation uses one dense grid sized to about 2 million cells (0.05 mm at best);
  tiles and a finer "inspect" pass are still to do.
- Caveat: the writer follows the firmware rules as read from source. The air cut
  (`machine-tests/m0-air-cut.cnc`) has still not been run, so no generated file should
  cut wood until it has.

**M3. V-carve pocket**
- Medial-axis V-carving with tip flat, flat-depth clipping, clearing plus V-bit, depth
  passes.
- Done when: the simulated pocket matches the ideal surface within tolerance on the
  fixtures, and a test pocket cut on the machine looks right.

Results (2026-11-14): built and checked in simulation; not cut on the machine.
- A V-carve inlay generates its pocket file: the end mill (T1) clears the flat floor,
  then the V-bit (T2) cuts wall rings at each pass depth, ramps along the medial axis
  into every inside corner and narrow part, and rings over the floor the end mill left.
- Checked by test: the simulated pocket is never more than 0.02 mm deeper than the ideal
  surface (depth = distance to the outline / tan(half angle), down to the floor) and
  never more than 0.12 mm higher, with and without an end mill. 120 core tests.
- The end mill is optional. Without one, or when it does not fit the floor, the V-bit
  clears the floor alone and the job says so.
- On the floor the V-bit's passes are spaced to leave ridges of at most 0.1 mm, even when
  the tool's own stepover is larger (tool libraries give a share of the body diameter).
- Outlines made of short segments have a medial branch at every vertex. Branches at
  nearly straight joints are left out when that leaves under 0.005 mm of material.
- Curved medial edges (between a vertex and a segment) are split into short straight
  pieces in `geom::medial`.
- Warning when a whole shape is too narrow to reach full depth. Narrow parts of a shape
  that is wide elsewhere are not reported yet; that comes with the plug in M4.
- Not done: the V-bit takes each wall ring as a full-width cut at its pass depth; there
  is no arc fitting; the test cut on the machine waits for the air cut.

**M4. V-carve plug**
- Mirroring, start depth, waste boundary, plug stock, engagement / glue gap / saw gap
  parameters, narrow-feature warnings.
- Done when: pocket and plug files are generated together from one job.

Results (2026-11-14): built and checked in simulation; not cut on the machine.
- A V-carve inlay generates a plug file as well as a pocket file, each with its own
  board, preview and download. They are generated one at a time from the same job.
- The plug is the shapes mirrored left to right, left standing in a blank that is
  otherwise cut to a flat floor. The outline is met at the engagement depth, so the
  shapes are narrower than drawn at the top and wider at the floor; the floor is
  engagement + saw gap deep.
- The plug blank is the shapes' bounding box plus the plug margin on every side. Its
  edge is not a wall: the floor runs out to it, so nothing stands proud around the plug.
  The end mill stays inside the blank; the V-bit's flank passes slightly beyond it.
- Two new job settings, both with defaults so older files still open: plug margin
  (8 mm) and plug blank thickness (10 mm).
- Checked by test: the simulated plug is never more than 0.02 mm lower than the ideal
  shape and never more than 0.12 mm higher, with and without an end mill; the bit never
  cuts closer to a shape than its depth allows, including in narrow gaps between shapes.
  127 core tests.
- Narrow parts: stretches where the pocket is shallower than the engagement depth are
  found from the medial axis, reported with their total length, and drawn in red on the
  design after generating.
- Fixed on the way: along a medial edge between two corners the inscribed radius was
  taken as changing evenly, which let the bit cut 0.15 mm into a shape beside a narrow
  gap. Such edges are now split finely, like the curved ones.
- Known limit, to be measured in M5: with a tip flat the pocket's corner ramps and
  narrow grooves are shallower than the plug's matching ridges by tip radius / tan(half
  angle), 0.09 mm for a 0.1 mm tip on a 60° bit.
- Not done: pocket and plug are separate buttons rather than one action; plug parts keep
  their drawing positions (no packing); no cut-out or trimming path for the blank.

**M5. Fit analysis and safety checks**
- Seating, gap map, cross-section view, trimmed-face view, all safety checks.
- Done when: the app predicts the fit of an M4 job, and a real glued-up test inlay agrees
  with the prediction.

**M6. Flat pocket inlays**
- Cuttable shape with deviation view, allowance, pocket, insert profile, tabs, 2D fit
  check.
- Done when: a flat inlay cut on the machine fits with the chosen allowance.

**M7. Finish**
- Error messages, empty states, documentation, performance on a full-bed job, format
  fixtures frozen as version 1.

## 4. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Medial-axis library is not robust on real SVGs | V-carve paths wrong or missing | Checked in M0; fallback is a per-point inscribed-circle method (as F-Engrave uses), slower but simple |
| Firmware behaves differently from the source reading | Bad first cut | Air-cut test in M0; conservative header and footer |
| Simulation too slow or memory-heavy at fine resolution | Sluggish preview | Tiles, coarse-then-fine, worker threads; measured in M2 |
| Fit prediction disagrees with real wood | False confidence | M5 compares against a real cut; tool tip and angle are editable per tool |
| Dirty SVG input (open paths, overlaps) | Import failures | Clean-up stage reports what it fixed and what it could not |

## 5. Decided: core language

Rust core compiled to WebAssembly (decided 2026-11-14).

- Why: robust geometry libraries exist (segment Voronoi, Clipper2), the simulation is
  fast, and the core is tested natively.
- Rejected: an all-TypeScript core. One language and no new toolchain, but no solid
  segment-Voronoi library, so the medial axis would have to be written here or replaced
  by a slower per-point method.
- Setup needed on a development machine: rustup, the `wasm32-unknown-unknown` target, a
  C++ linker for native tests, and `wasm-pack` (or `wasm-bindgen-cli`).
