# Architecture and build plan (v1)

The plan the app was built to, kept as a record of how it is put together and why, with
the results of each milestone. Written 2026-11-14. Requirements are in
[requirements.md](requirements.md).

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

Results (2026-11-14): fit analysis built and checked against known cases; not compared
with a real glue-up.
- "Check fit" on a V-carve inlay simulates both files, turns the plug over, lowers it
  onto the pocket until first contact and reports: how far from the designed depth it
  rests and where it touches first; how much wood would have to crush to press it home;
  share of the wall in contact and the largest wall gap; glue gap under the plug; and
  visible gaps in the finished face, judged 0.1 mm below the surface.
- A Fit view shows the finished face or the gap map from above, with a cross-section
  through any clicked point at true proportions.
- Checked by test: a matching groove and ridge seat exactly with the designed glue gap; a
  plug 0.2 mm too wide rides high by 0.2 / tan(half angle); one too narrow drops to the
  floor and shows the wall gap; pocket left uncovered shows as a gap. A generated inlay
  cut with a perfectly pointed bit fits within 0.03 mm. 135 core tests.
- The plug is sampled between cell centres, so the two grids need not line up.
- Limit: features narrower than about two cells (0.1 mm at best) are only partly seen.
  The 0.09 mm mismatch a 0.1 mm tip flat causes along corner ramps reads as about 0.03.
- Safety checks now in place: rapids through stock, cuts below the board, cuts deeper
  than the flutes (which also keeps the shank out of the wood), spindle speed over the
  machine's limit, and a cut wider than the machine's X or Y travel (300 x 200 mm).
- Not done: holder collisions and Z travel (tool stick-out is not known); the fit view
  for flat inlays (M6); comparison with a real glued-up inlay.
- Fixed on the way: the simulator missed the lowest point under a perfectly pointed bit
  on a sloped move, leaving corner ramps looking 0.2 mm shallow.

**M6. Flat pocket inlays**
- Cuttable shape with deviation view, allowance, pocket, insert profile, tabs, 2D fit
  check.
- Done when: a flat inlay cut on the machine fits with the chosen allowance.

Results (2026-11-15): built and checked in simulation; not cut on the machine.
- A flat inlay generates an insert file as well as a pocket file.
- Cuttable shape: each selected shape is closed then opened by the tool's radius, so
  every corner the end mill cannot cut, inward or outward, is rounded to that radius, and
  anything narrower than the tool is dropped. Both parts are cut to this shape: the
  pocket grown by half the allowance, the insert shrunk by half.
- The outline that will really be cut is drawn dashed on the design after generating,
  and the output says how much of the drawing is left out and how much is added.
- Insert: not mirrored, cut right through its own board (0.2 mm past the bottom) by
  going round each shape in depth passes, holes first. The board is the shapes' outer
  size plus the insert margin.
- Tabs (optional): 4 mm wide, 1 mm thick, about every 40 mm round the outline, at least
  two per insert; inserts too small for two get none and a warning.
- Two new job settings with defaults: insert board thickness (4 mm) and insert margin
  (8 mm).
- 2D fit check, shown with either part: smallest and largest gap between the insert as
  cut and the pocket as cut, any overlap, and how far the insert stands proud.
- Checked by test: the simulated insert is untouched inside its outline and cut through
  all round it; the gap equals the allowance all round on the fixtures; the tool stays
  its radius from every part; tabs are left where expected. 143 core tests.
- Shapes closer together than the tool is wide cannot have their inserts cut apart where
  they are drawn; the job says so and asks for separate inlays.
- Not done: no deviation picture beyond the dashed outline; inserts keep their drawing
  positions (no packing); tabs are placed evenly, not steered onto straight stretches;
  plunges are straight down, no ramping.

**M7. Several clearing tools, in order** (added 2026-11-15)
- A job takes an ordered list of clearing end mills instead of one, for V-carve and flat
  inlays, pocket and plug or insert. The user sets the order; the app suggests largest
  first.
- Each tool after the first cuts only what the tools before it left (rest machining),
  with a tool change between them. The V-bit, where there is one, still comes last.
- Flat inlays: the smallest tool in the list sets the corner radius of the cuttable
  shape and cuts the insert out.
- The output lists time and tool changes per tool, and warns when a tool in the list
  removes nothing or almost nothing.
- Project files written before this open with their one tool as a list of one.
- Done when: a pocket cleared with two end mills simulates to the same shape as with the
  small one alone, in clearly less time, and each later tool stays out of wood already
  removed except where it must pass to reach its work.

Results (2026-11-15): built and checked in simulation; not cut on the machine.
- Both kinds of inlay take an ordered list of end mills. A flat inlay's old single tool
  is read as a list of one; project files keep format version 1.
- Rest machining: a later tool's centre goes only where it is within its radius of wood
  the earlier tools left (plus 0.05 mm), and never closer to a wall than its radius.
  Leftovers thinner than 0.04 mm count as rounding and are not visited.
- A tool that fits nowhere, or finds nothing left, is not loaded at all and the output
  says why. With a V-bit to follow, a tool that removes under 1% of the floor is used
  but flagged as hardly worth its tool change.
- Flat inlays: the smallest end mill in the list, whatever its place, sets the corner
  radius and cuts the insert out on its own.
- The output lists each tool's number and its share of the time, and counts the tool
  changes.
- In the app the list can be added to, reordered and trimmed; when a smaller tool comes
  before a larger one it says so and offers to put the largest first.
- Checked by test: a flat pocket cut with a 6 mm and a 3.175 mm end mill simulates to
  the same board as with the 3.175 mm alone (under 0.2% of cells differ by more than
  0.05 mm) in under 80% of the time; the small tool's moves stay within its radius of
  leftover wood; a V-carve pocket and plug cut with two end mills and the V-bit still
  fit as designed. 151 core tests.
- Not done: walls are not given a finishing pass by a single tool, so a faint step can
  show where two tools' cuts meet; plunges are still straight down; the larger tools do
  not help cut the insert out.

**M8. Review of the app's screens** (added 2026-11-15)
- Go through the whole flow as a first-time user: new project, import, select shapes,
  set up tools, generate, check, download. Note every point of confusion, every step
  that could be dropped and every number that needs explaining.
- Make it simpler and nicer to use without removing any feature: sensible defaults,
  settings grouped by how often they are changed, plain wording, clearer state (what is
  out of date, what is running, what to do next), consistent layout, keyboard and
  screen-reader use.
- Includes the error messages and empty states first listed under the finishing
  milestone.
- Done when: the coaster can be taken from SVG to both files and a fit check without
  reading documentation, and you agree with the list of changes before they are made.

Results (2026-11-15): done on the developer's own judgement, at the user's request,
without the list being agreed first; checked in the browser on the coaster and the
sample drawing. No feature was removed.
- Found on the walk-through: nothing said what to do first or that tools were needed;
  the header's four file buttons were hard to tell apart; settings, output and results
  were one long scroll with the generate buttons below the fold; each part and the fit
  check had its own button and replaced the others' results; a hint under every field;
  a missing tool only showed up as an error after generating.
- Start screen for a project without a drawing: the four steps from tools to files,
  with the tool list's state, the import button and a sample drawing to try.
- One button, "Generate files", makes the pocket, the plug or insert and (V-carve) the
  fit check together. Each simulated part is kept in the core, so the fit check no
  longer simulates them again: about 14 s for the coaster where it was 17 s for the fit
  check alone. Results stay side by side: a card per file with its checks, time per
  tool, things to know and download, and a card for the fit with a one-line verdict.
- The button sits in a bar at the foot of the panel with the current state: what is
  still to choose, which step is running, whether the files match the settings.
- An inlay opens as its own panel, grouped as depths and fit, wood and tools, and the
  plug blank or insert board (folded away). A cross-section drawn from the current
  numbers replaces most of the hints.
- A new inlay takes the V-bit or end mill by itself when the tool list has only one.
- The drawing area's tabs are Drawing, Pocket in 3D, Plug or Insert in 3D, and Fit.
- Header: views first; "New project", "Projects…", "Open file…", "Save to file".
- Look: cool greys with one blue for what can be acted on, so the wood colours of the
  board and plug are the only warm things on screen; IBM Plex Sans, bundled with the
  app so it still works offline.
- Also: dialogs close on Escape; replacing a drawing that has inlays asks first; the
  fit verdict treats gaps under 0.1 mm as hairlines.
- Not done: no walk-through with a second person; dark colours are defined but were
  not looked at; the tool editor dialog is unchanged.

**M9. Finish**
- Wider set of SVG test files (exports from Fusion, Inkscape, Illustrator and others;
  open paths, overlaps, transforms, units).
- Documentation, performance on a full-bed job, format fixtures frozen as version 1.
- Added at the user's request on 2026-11-15: DXF import; a set of generated test files
  and the app tested against them; both kinds of plug can be cut out of their board as
  one piece, with or without tabs.

Results (2026-11-15): built and checked in simulation and in the browser; not cut on
the machine.
- DXF import (text DXF): lines, arcs, circles, ellipses, polylines with bulges and
  splines; units from the file; separate pieces joined into closed outlines where their
  ends meet within 0.01 mm. The same joining now applies to SVG outlines drawn as
  separate segments. See docs/formats.md.
- Test drawings: 14 SVG and 10 DXF files with a manifest of what each must import as,
  both written by `tools/make_test_drawings.py`. All 24 import as expected. From the
  three largest shapes of each, every kind of inlay is built (over 200 files): each
  builds, or is refused with a plain reason (the thin letters, for the flat inlay).
  Three drawings are simulated in full with no problems found.
- Found and fixed through the test drawings: shrinking then growing an outline made of
  very many short pieces (a spline) left slivers of no area that stopped a flat insert
  from being cut out; shrinking a shape by more than its width was correct but very
  slow.
- Cut-out: a V-carve plug, or a flat inlay's plug, can be cut out of a larger board as
  one piece after it is carved, round the edge of its blank, with or without tabs. The
  largest chosen end mill that is long enough does it and keeps its tool number.
- Flat inlays have a second way to make the insert: one plug with the shapes standing
  on a shared backer, mirrored, glued in face down. The loose-pieces way remains.
- Performance, full bed (290 x 190 mm, 40 shapes, natively compiled; the browser is
  somewhat slower): 2 to 6 s per file to generate and simulate, 13 s for the flat plug
  on a backer, whose file is 1.2 million lines because a 3.175 mm tool clears the whole
  board. The flat pocket took 20 s before the slow shrinking was fixed.
- File format version 1 is frozen, with fixtures that every later version must read.
- User guide: docs/guide.md.
- Known limits: the fit check works on a grid, so gaps and heights under about one cell
  (0.05 to 0.2 mm, coarser for larger boards) are noise; a V-bit with a tip flat makes
  a plug with sharp corners ride high by about 0.1 mm until pressed, which the fit
  check reports; DXF blocks and binary DXF are not read; no arc fitting; no holder or
  Z-travel checks; inserts are not packed to save wood.
- Still to do by the user: the air cut in `machine-tests`, and a first real cut.

### After milestone 9: first use on the user's own DXF (2026-11-15)

Found by the user and fixed:
- Bits of wood were left standing on a plug's floor. An end mill whose stepover is more
  than its radius misses an island in the middle of an area where the next ring in no
  longer fits, and at some corners. Clearing now finds those islands and cuts them. The
  warning about a stepover above half the diameter is gone, since it no longer applies.
- In the fit view, clicks landed in the wrong place whenever the picture did not fill
  its frame.
- The fit verdict now allows for the V-bit: a plug held off by no more than the bit's tip
  flat explains (its radius over the tangent of the half angle) "seats once pressed".

Found on the way, with a new test drawing of several parts (`dxf-11-several-parts.dxf`):
- Two shapes that share an edge, chosen together, could stop the carving: merging them
  left a hair-thin sliver along the edge. Merging and cutting shapes now drop these.

Added at the user's request: arranging the drawing. Parts or single shapes can be
selected, moved (dragging, arrow keys or typed position), resized, mirrored and deleted,
with undo; the board grows with the shapes and can be trimmed to them. See docs/guide.md.

The first version was tested hands-on by a separate agent, which found it clumsy and
limited (2026-11-15). Reworked from its report:
- It edited filled areas, so deleting or moving an inner outline left a hole behind. It
  now works on outlines: an outline takes along what is inside it, the hole it makes in
  the shape around it follows, closes when the outline is deleted, and opens where the
  outline is dropped wholly inside another shape. Parts are found from these links, not
  from bounding boxes.
- Selection: a click replaces it, Shift-click adds or removes, empty board or Escape
  clears, dragging across empty board selects what the box encloses. Shapes that belong
  to an inlay show as selected too.
- Typed numbers apply on Enter or on leaving the field, as one undo step. Undo and redo
  (50 steps, kept after "Done"), the arrow keys, Delete, Ctrl+A and Ctrl+D work wherever
  the focus is; a run of arrow keys is one undo step. The Delete key asks and refuses
  exactly as the button does, and an inlay left without shapes is removed.
- New: turn (90° and any angle), scale by percent, centre on the board, copy, "keep only
  this" (one part on a board of its own), zoom and pan, a live read-out of size and
  position while dragging, Shift to drag straight, Escape to abandon a drag.
- Shapes stop at the board's left and bottom edges instead of shifting everything else.
  Shapes lying partly on each other are outlined in red and listed.
- Not done: snapping, aligning or spacing parts against each other.
- Added afterwards at the user's request: resizing by dragging handles on the selection's
  frame (corners keep the proportions, sides stretch one way, Ctrl resizes about the
  middle), and typed sizes from any corner, with or without the proportions.

Also added at the user's request: a fuller tool-path view in the 3D preview. The path was
already there as a tick box under the view, easily missed. It is now above the view, each
tool has its own colour, the board can be hidden, the moves in the air switched off, and
a slider draws the path up to any move, naming the G-code line and the tool. For this the
core hands over each move's tool number and line.
- The logic is in `web/src/state/arrange.ts` with tests (`npm test` in `web`).

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

Also added at the user's request: settings for values that were fixed in the code.

- The machine (name, travel in X and Y, top spindle speed, rapid speed, first tool number)
  is set under "Tools and machine" (now "Tools and settings"), kept in the browser like the tool list and copied into
  the open project, so the core reads it from the project. Presets: Carvera Air, Carvera.
- "Clearances and tabs" are per project: travel height, plunge height, tab width, spacing
  and thickness, the cut past the bottom of a board, and the board left around a cut-out
  plug. Project files without them read with the old fixed values.
- Later, at the user's request after the first air cut:
  - Clearances and tabs moved from the project to each inlay (`Job.setup`; the project's
    remain for inlays from older files). Their defaults for new inlays are kept in the
    browser, like the tools and the machine.
  - The end mill that cuts a plug out of its board can be chosen per inlay
    (`Job.cutOutToolId`). Left alone it is the largest of the inlay's end mills that
    reaches through the board, as before. A chosen tool whose flutes are shorter than
    the cut is refused.
  - The tools view became "Tools and settings": three pages (tools, machine, new inlays)
    with a list of the pages beside them.
- Still fixed: the least number of tabs (3), the V-bit's floor ridge (0.1 mm), the
  simulation's detail, the import tolerances. No ramped entry or choice of cut direction.

### Stock, several drawings, other operations, colours (2026-11-15)

Added at the user's request. Three things were asked of the user first: operations get a
file each and can be put into one file per download; facing must serve both to flatten the
stock and to remove a plug's backer; an inlay's colour is its wood's colour everywhere.

- **Stock.** The drawing's page already was the base board; it is now called the stock and
  sized by typing. The drawing-wide scale and mirror are gone from the screens: on opening
  a project they are worked into the shapes (`normaliseDesign` in the UI; the core still
  reads them), so a shape's numbers are where it lies on the stock. Scaling and mirroring
  are done on selected shapes, under arranging. No new fields: the project file keeps
  format version 1.
- **Several drawings.** A further file's shapes are given new ids and put in the middle of
  the stock, selected, with arranging switched on; the stock grows when they do not fit.
  Several files can be picked or dropped at once. `sourceName` lists the files.
- **Operations.** Pocket, facing, contour and chamfer are further variants of a job's
  `inlay`, so they share its name, wood, shapes, clearances and place in the list, and go
  through the same pipeline: moves, G-code, read back, simulated. An operation has one
  part. Only inlays own shapes; operations use any.
  - Pocket: the existing clearing with several tools in order.
  - Facing: clearing with the tool's centre taken to the edge of the area (the stock, or
    the rectangle around the shapes plus a margin, which is what a plug's blank is). It is
    worked out as if the top of the standing wood were the surface, then lifted by that
    much, so it starts above Z0 and travels above the wood.
  - Contour: the insert's profiling, opened up to tracks outside, inside or on the
    outlines (`ops::profile::follow`), to a depth or through the stock, with tabs.
  - Chamfer: the same along tracks beside the outline, with a V-bit, at the depth that
    gives the bevel its width. The tip is kept 0.2 mm beyond its flat from the edge.
- **One file for the stock** (`build::build_combined`): the programs of the ticked jobs'
  stock parts joined in list order. Tools are numbered once for the file by tool id. Where
  the next program starts with the tool already in the spindle, the stop, the `M6` and the
  restart are left out, the tool crosses at the higher of the two travel heights, and only
  a changed speed is written. The joined file is written, linted, read back and simulated
  like any other.
- **Colours.** `color` on a job and on `base`. A new inlay is given a wood not yet used;
  inlays from older files keep the colours they were drawn in. The drawing's page is
  filled with the stock's colour and the outlines take an ink that shows on it.
- Checked by test: each operation against the shape it should leave in simulation
  (pocket depth and untouched surround, facing level and start height, the tool's side
  and distance for the three kinds of contour, through cut with tabs, the bevel's slope
  and width on both sides); the one file against the files it joins; the new jobs through
  the project file. 186 core tests, 35 UI tests. Looked at in the browser: a contour
  round an inlay's shape, a facing set from an inlay's plug, one file from two jobs, a
  second drawing added.
- Known limits: wood above the surface is not simulated, and jobs that come before a
  facing in one file do not allow for it (the file says so); no ramped entry or lead-in
  on contours; tabs are placed evenly; a chamfer does not check that its edge has been
  cut; facing follows rings, not straight passes.
- Recorded for later: a curated list of default tools (see requirements).
