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

### Fillet bits, path shapes, dragging, the arranging toolbar (2026-11-16)

Added at the user's request, after trying the above.

- **Corner-rounding bits.** A third kind of tool, `corner_round`, with a corner radius and
  a tip diameter. The simulator's tool profile gained a quarter-circle underside; on a move
  that also changes height its lowest point is found by trying points along the move, as
  there is no slope to solve for. The chamfer operation takes either a V-bit or such a bit
  (`toolId`; `vbitToolId` is still read). `tools.yaml` cutters that were left out as
  corner-rounding are now imported as this kind, with the radius worked out from the body
  and tip diameters.
- **Path shapes.** `pattern` on pockets and facings: `offset` (the rings there were) or
  `raster`, straight passes along the longer side of each area, back and forth, linked
  along the area's edge without lifting where the way is clear. A pocket's raster ends
  each depth with a pass round the walls; a facing's needs none, its area having no
  walls. Facing defaults to `raster`, also for files that say nothing.
- **Dragging.** One hook (`components/sortable.tsx`) for both lists. A line is dragged by
  its grip; on the grip the up and down arrows do the same, which replaces the arrow
  buttons for keyboard use.
- **Symbols.** One line drawing per kind of job (`components/icons.tsx`): cross-sections
  for the inlays, the pocket and the chamfer, views from above for the contour and the
  facing. A chamfer with a corner-rounding bit shows a rounded corner.
- **Arranging.** A bar above the drawing switches between picking shapes and arranging,
  and adds drawings. While arranging, a toolbar under it holds the actions as buttons and
  the selection's position and size as inline fields; the side panel keeps only what is
  selected, the stock and the keys. The six kinds to add became tiles with their symbols,
  with one line of explanation for the kind pointed at.
- Checked by test: the rounded edge against a quarter circle, in the simulator alone and
  through a generated file; a pocket cut side to side against the same pocket cut in
  rings; a facing's passes and its single plunge; old files without `pattern` or with
  `vbitToolId`. 192 core tests, 35 UI tests. Looked at in the browser: the toolbar while
  arranging, dragging a line of the list, a facing's side-to-side path in 3D.
- Not checked: a corner-rounding bit was not entered and used through the screens, only
  through the core's tests; whether the Carvera controller draws a `radius mill`.

### Cut quality, and relief of the plug's ridges (2026-11-16)

Chosen by the user from the list of things put off: what stands between the app and a
good first cut. All of it is in the core.

- **Ramped entry** (`ops::clear::ramp_in`). An end mill no longer plunges into wood. It
  comes down along the stretch of path that leads up to where it starts cutting, at the
  ramp angle, and goes back and forth along that stretch where it is too short. In ring
  clearing the stretch is the ring about to be cut, or the way in from the next ring when
  the innermost is too small; in side-to-side clearing, the first pass; in profiling, the
  outline itself, which also does for a lead-in. Below the top of the tabs it keeps to the
  stretch between the last tab and the start. Along the ramp the tool moves at the cutting
  feed, slowed where that would take it down faster than its plunge feed. A tool already
  in the cut where it must go deeper stays in it. `rampAngle` in the clearances, 5° unless
  set; 0 plunges as before.
- **Finishing pass.** With `finishAllowance` (0.1 mm unless set), the end mills clear a
  pocket short of its walls by that much, and the smallest then follows every wall once
  at full depth, in steps no deeper than its diameter (`ops::clear::finish_walls`). Parts
  the smallest tool only just fits into would be left out by the allowance altogether, so
  they are cleared as they are. A part that is cut out (an insert, a contour) is cut down
  on a track that much further out, to where the tabs start; the outline's own track then
  takes the wall in one pass and cuts the rest, with the tabs, alone. Not where the wider
  track would close the way between two parts. Not for V-carve floors, whose walls the
  V-bit cuts, nor for a plug's cut-out, whose edge is waste.
- **Arcs** (`toolpath::fit_arcs`). Before a program is written, runs of level cuts at one
  feed that lie within 0.008 mm of a circle become arcs of at most 4 radians. The program
  kept for joining files and for tests is the unfitted one. A full bed's largest file went
  from 1.2 million lines to 178 thousand.
- **Relief** (`ops::vcarve::plug_relief`). On the medial axis of the plug's shapes, where
  the inscribed circle is smaller than the bit at the engagement depth, the plug has a
  ridge of height radius / tan(half angle), and the pocket a groove that deep less what
  the tip flat costs. The V-bit is run along those stretches, corner edges included, with
  its tip below the ridge's point by twice the lowering wanted less the tip-flat term: a V
  cut into a ridge of the same slope lowers it by half the depth of the cut. The lowering
  wanted is the glue gap plus the tip-flat term, reduced near the outline so that the cut
  never comes within 0.5 mm of the finished face, and left out where under 0.02 mm.
  `relief` on a V-carve inlay, on unless a file says otherwise.
- Checked by test: slopes and absence of plunges in ring and side-to-side clearing and in
  profiling, with whole tabs; the back-and-forth ramp; roughing keeping off the walls
  until the floor is reached, and the same pocket with and without the allowance; a
  rounded rectangle becoming four arcs and four lines, a disc's pocket written in under a
  third of the lines and simulating round; with relief, less than half the wood in the
  way of the test inlay's plug, the face unchanged. 202 core tests, 35 UI tests. A full
  bed takes 2 to 13 s per file, as before. Looked at in the browser: a V-carve inlay
  generated, simulated without problems and fitted.
- Known limits: ramps along curves are straight cuts, not helical arcs; the finishing
  pass goes round every wall, also walls an earlier tool never touched; relief treats a
  corner edge as it does a ridge, which lowers it somewhat more than needed; nothing here
  has been cut in wood.

### One tool model with the tooling library (2026-11-16)

The first step towards making this app and `cnc-tooling-library` one: the app holds, reads
and writes everything that project's `tools.yaml` holds. The feeds model, the libraries for
Makera CAM, Makera Studio and Fusion 360, and a server with an API are later steps.

- **Tool model** (`tools.rs`). Three more kinds, which no operation accepts. A material is
  a key, not one of two woods. A cutting row can belong to a toolpath profile, remembers
  whether its stepover was given in mm or percent, and carries a field log; its current
  result is the newest entry cut at its present numbers. Tools gain group, number,
  coating, style, note, recommended materials, source, inventory, things to verify and
  Makera ids. A tool file also holds materials, profiles and groups, and is refused when
  a tool refers to one it lacks. Everything is additive: both file versions stay at 1,
  and a tool that uses none of it is written as before.
- **`tools.yaml`** (`import/tools_yaml.rs`). Read whole and strictly; written one key per
  line. Comments directly above a tool go into its note. A percentage is kept as mm to six
  decimals, which gives the same percentage back at three.
- **Row choice** (`Job.row_profiles`, `Project.profiles`). Per tool and job. Any profile
  may be chosen for any operation, since the tooling library's own flags do not say which
  cuts a profile suits; only adaptive clearing is refused. A cut-out keeps the plain row.
- **Materials**. A job takes any material; outside wood the build warns. The list has a
  page of its own in the settings.
- **Project files** leave out what is the owner's: source, inventory, logs, ids.
- Checked by test: a made-up `tools.yaml` with every key read, written and read again to
  the same library; mistakes reported with their place; the frozen tool file read and
  written unchanged; a chosen row's feed in the G-code; an adaptive row refused. 227 core
  tests, 35 UI tests. Checked outside the repository, on the author's real file: 98 tools
  and 530 rows in, none left out, and the tooling library's generator makes byte-identical
  Makera CAM, Makera Studio (with the clock held) and Fusion 360 libraries from the
  original and from the file written by this app. Looked at in the browser with a pocket:
  import, export, the row list, a job in aluminium, the materials page.
- Known limits: the tool editor edits plain rows only, and none of the new tool fields;
  field logs and inventory are kept and not shown; the simulator would draw the three new
  kinds as cylinders, which nothing can reach yet; a material added in the app has no
  record in the Makera apps, and the tooling library refuses a `tools.yaml` that lists
  it; a corner-rounding bit's radius is not in a `tools.yaml`; nothing has been cut in a
  material other than wood, and no row of a profile has been run.

### The feeds model and the tool sheet (2026-11-16)

The second step of joining with `cnc-tooling-library`: its feeds model and its tool sheet.

- **Feeds model** (`feeds.rs`). The tooling library's model, number for number: nine
  material classes, five stops, the power cap that falls with spindle speed, the
  long-reach rules, the field rules for aluminium, the reshaping for adaptive clearing and
  the cautions. `tests/fixtures/feeds-reference.json` holds that model's answers for 38
  made-up tools in 11 materials at every stop, 3002 cases, and the test requires the same
  here; with one constant changed on purpose, 170 of them fail.
- **Row check** (`feeds::check_row`). A row's chip load against the material's band and a
  full slot's power against the hardest stop's cap, with a warning in words. An adaptive
  row is judged at its own stepover. The limits are the tooling library's; the wording
  and what is flagged are this app's.
- **Tool sheet** (`ToolSheet.tsx`). A page per tool in place of the dialog: every field,
  every row, the row check, the five stops with "Use these values", the field log, stock
  and source. A result or a lost cutter can be logged.
- **Needs attention** (`tools::needs_attention`). Failed and unconfirmed rows, things to
  check, tools without cutting settings or flute length, worst first.
- A material of the user's can name the material it cuts like (`feedsAs`).
- Checked by test: the reference cases; a suggested row passing its own check; the chip
  band and the cap; the attention list through a failure, a later ok and changed numbers.
  235 core tests, 35 UI tests. Looked at in the browser with made-up tools: the sheet,
  taking a suggestion, logging a failure and a broken cutter, the list.
- Known limits: profiles cannot be added or edited yet; the stops are a row of buttons,
  not the tooling library's ruler; no drawing of the cutter; the suggestions are for a
  Carvera Air and say nothing of the machine set in the app; nothing here has been cut.

### Joining with the tooling library: the phases

The phases of the join, and what was done in each. What is still to do, of this and of
everything else, is in [../roadmap.md](../roadmap.md): an item is moved from there to here
when it is done.

1. **One tool model.** Done.
2. **Feeds model and tool sheet.** Done, with the workbench's tool list and sheet matched
   as told below.
3. **Libraries for other programs.** Done on 2026-11-17. `export/makera.rs` and
   `export/fusion.rs` write what the tooling library's generators write for the same
   tools, byte for byte, with its warnings; `import/makera.rs` reads an app's export and
   offers its differences to tick. The fixtures were made by running the tooling
   library's own generators on the made-up list; the scripts that do so are kept with the
   tooling library (`scripts/inlay_cam_*.py`), since they need its code.
4. **A server.** Begun on 2026-11-18, as told under "A server" below: the server, the
   shared tool file, the API and the backups are built. Not done: it is not deployed, and
   the Python repository is not archived.
5. **What only the joined app can do.** Not started.

Parity with the workbench, reached on 2026-11-16: the list's search, chips with "only"
and "hide", four sort orders and the Needs attention kinds (`toolFind.ts`, ported with its
tests); the drawing; editing in place; the suggestion at the foot of an edited table; tool
settings at the foot of the sheet; a tool's description kept and written back as comments.

Reached on 2026-11-17:

- The suggestion's reasoning, one to one. The core gives a row everything at once
  (`feeds::suggest_entry`: every stop with and without a ramped entry, adaptive clearing
  and lubrication, the default combination, and `feeds::limits`). The reference fixture
  now holds every combination for every made-up tool and material, 16 720 answers and the
  limits, and the core must give the same. On the screen, `state/feedsView.ts` is the
  workbench's `ruler.js` and the suggestion part of its `app.js`: a row is placed by
  volume per revolution (a drill by plunge per revolution), flagged for a chip outside
  the class's band or power over the hardest stop's cap, and matched against every
  combination. Its tests are the workbench's own smoke-test cases. Differences that
  remain, on purpose: a row here always has numbers, so there is no "empty" row and no
  fill-in of blank fields; and a suggestion's stepover goes into the row in the row's own
  unit, which the workbench also does.
- Name templates (`naming.rs`, the workbench's examples as its tests), offered under the
  name while a tool is edited.
- A logged result and a wear entry can be corrected or removed.
- "Goes to" for a cutting row, and the warnings for a material a Makera app does not have
  and for a profile row an app gets for want of a plain one. Shown only once a material
  is tied to a Makera material.
- The known coatings as a pick list, and items to check added by hand.
- The Settings pages, redone as a list of four beside the page picked, each setting on
  one line with what it does beside it.

Found by testing on 2026-11-17, and since done:

- "Generate" is off, with the reason under it, while a tool of the job has no cutting
  settings for its material.
- In the arrange bar, Ctrl+Z in a field with something typed takes the typing back and
  leaves the drawing. Undo and redo put the drawing back and the inlays a deleted shape
  took along; an inlay made or changed since keeps what it has now.
- A resize the stock's edge holds back says so under the numbers. The line under the
  canvas says it gives the bottom-left corner.
- A number that is not kept says why under its field. A stepover wider than a diameter
  made smaller is marked, and the save error names its row.
- A tool's edited cutting table fits its sheet: at 900 px and under it drops the scale
  while it is edited.
- "Delete this tool…" is in Tool settings without editing too.
- The tools list is as it was left when another tab was visited.
- 300 lines of rules for replaced screens are out of `app.css`.

Facing and chamfer show their options as small pictures to pick from, in place of
dropdowns, and so does a pocket's path (2026-11-17, `PictureChoice.tsx`).

A pocket cleared side to side takes the same choice of pass direction as facing, per
shape. A chamfer's tip clearance, 0.2 mm in the code until now, is a field of the chamfer:
it is a choice about one cut and one bit, so it sits with the width and not in the
clearances. Neither is written to a file at its default, so files from before read the
same. The core's other fixed numbers were listed, in
[fixed-numbers.md](fixed-numbers.md) (2026-11-17).

Of the core's fixed numbers, five were made settings, each with the old value as its
default and left out of a file at it (2026-11-17). The machine has a lowest spindle speed
and a time per tool change, and the feeds model keeps to the machine's speeds instead of
its own 5000 to 12000 rpm. A V-carve inlay has three "finer points", closed until asked
for: the V-bit's ridge height on a flat floor, how far a relief stays below the face, and
where the fit check judges the face. Spindle power was to be a setting and is not: both
Carveras have 200 W. What counts as a good fit moved from the screens into the core, and
the screens read the core's defaults and limits from a file a test keeps true.

Drawing in the app, a first part (2026-11-17). Asked for as "vector drawing features";
of basic shapes, a pen, point editing and combining shapes, the basic shapes were chosen,
kept as plain outlines.

- Rectangle (with a corner radius), ellipse, regular polygon and star, as tools of the
  arrange toolbar: a drag on the stock draws one. The shape comes in selected with the
  tool put away, so the fields that were there already give its exact size and place.
- A drawn shape is a region like an imported one from the moment it is finished
  (`state/shapes.ts` makes the outline, `addShape` in `state/arrange.ts` puts it in).
  The project file is unchanged, and everything after the drawing takes it as it takes
  any shape. The price: a circle cannot later be edited as a circle.
- Curves are straight runs within 0.01 mm, the tolerance imported curves get. The number
  is now in the screens' code as well as the core's.
- It joins the drawing by the rule arranging already had, in both directions: inside
  another shape it is a hole there, and around parts it gets a hole for each. The second
  direction is new, and only drawing has it: a shape *moved* over a smaller one still
  only reports the overlap.
- "Arrange" can be chosen on a stock without shapes, which it could not.
- Not done: a pen, editing points, combining shapes, text, snapping. On the roadmap.

Changed the same day, at the user's request. The star tool is out: rectangle, ellipse and
polygon remain. "Arrange" is called "Edit" on the screens and in the guide, since it draws
as well; the code still says `arranging`. And the toolbar keeps its height: the
selection's numbers are always there, empty without a selection, and a drawing tool's
options lie over them. Before, the bar changed height with every selection, and the
drawing under it moved.

Found by the user the same day: a rectangle drawn around a picture could not be selected
without the shapes in it, so it could not be moved, resized or deleted by itself. Since a
drawn shape gets holes for what it is drawn around, it was the outside of those shapes,
and an outline always took along what is inside it.

A choice of three ways to select was built first (whole parts, an outline with what is
inside it, one outline alone) and found too much: the user asked for the last as the only
one. So selecting changed for imported drawings too. A click selects one outline, and the
functions of `state/arrange.ts` act on the outlines they are given and nothing else: they
let go of what is inside (`release`), act, and cut the holes again from where everything
then lies (`settle`). "Select whole parts" is gone; a part with everything in it is
selected by dragging a box around it. Outlines selected together still move as one, holes
and all.

Not done: an outline moved or resized gets no holes for shapes it newly comes to lie
around; only what it held before is looked at. Such shapes are reported as overlapping.

The red marking of shapes that lie on top of each other is gone, with its warning
(2026-11-17). It asked the user to move such shapes apart "before making inlays from
them", and nothing after the drawing needed that: an inlay is the union of its shapes,
and the core never looked at the check. A filled drawing of a disc with a star on it came
in all red, though the star cut into the glued-in disc is an inlay in an inlay. The one
case it could have warned of, two inlays cut in one go over the same wood, cannot be told
from the drawing.

A facing that trims a glued-in plug, from the inlay (2026-11-17). Facing could do this
already (wood above the surface, and an offer to fill the fields in), but the way there
was to add a facing, Shift-click the inlay's shapes and find the offer. An inlay with a
plug on a backer now has "After the glue-up" in its panel, with one button: it adds the
facing to the list as an operation of its own, set to the plug's blank, from the top of
the backer down to flush, in the plug's wood. Decided with the user: one number says
where the cut starts, the whole backer by default and to be lowered when the backer is
sawn off first; flush, with nothing left proud; not for loose inserts; an operation in
the list, not a third file of the inlay. The numbers are copies: after a change to the
inlay the facing's panel offers to set them again, as before. `trimFacing` and `trimOf`
in `state/model.ts`.

A facing may end above the surface (2026-11-17): its depth below the surface can be less
than 0, down to the wood above the surface with the sign turned, so that a plug is left a
little proud for sanding. The user proposed the negative depth; a second field for it was
weighed and left, since one number already says where the cut ends. The check in
`project.rs` took the place of "0 or more"; files from before read the same.

The glue-up as a step, and the stock step by step (2026-11-17). The user asked to see
glued-in plugs: a glue operation that adds the plug to the stock in its own colour, a list
that can be reordered, and a 3D view to step through. What was missing under that: every
file was simulated on a fresh block, so nothing carried the stock from one line of the
list to the next, and gluing is the one thing that changes the stock without the machine.

- **The model.** `timeline.rs` holds a `Workpiece`: the height map, plus one body per
  glue-up (the wood's underside, and the surface it was put on, over a window of the
  grid) and, per cell, whose wood the surface is in. A cut lowers the surface
  (`sim::simulate_onto`, the old `simulate` without the fresh block); `settle` then finds
  the owner of every cell from the last glue-up down, and where a cut went right through
  a body the surface drops to what lay under it. One height per cell is still enough: a
  3-axis cut from above sees the top only, and what is under a body is kept with the body.
- **A glue-up is a job**: `Inlay::Glue { inlay_id }`, a line of the list like the others,
  so the list is the order the stock goes through and reordering needed nothing new. It
  has no file (`build` refuses it by name). No new version of the project file: a new
  `type` is an addition. Renaming `Job` and `Inlay`, which now also hold a step done by
  hand, is left for a version 2 file.
- **Seating.** A plug on a backer is turned over and lowered until it touches the stock
  as it is at that step, by the fit check's rule (seat = highest of surface + cut). It
  rests where it rests: not pressed to the designed depth, so that a plug held up shows
  as standing proud. Over 0.25 mm proud the step says so; less is what a tip flat leaves.
  Loose inserts are rasterised from their outlines and rest on the highest wood under
  each. For this a flat plug on a backer now has a `frame`, and loose inserts an `origin`,
  in `Built`.
- **What comes out.** `timeline(project)` builds each line's stock file, runs it on the
  one block, and keeps a snapshot after each line: heights and owners thinned to 600
  cells a side, the way the 3D view thinned them. A line that cannot be built leaves the
  block as it was and the rest go on. The simulation's own check, "a rapid move goes
  through the stock", now also finds a file that travels through a glued-in plug.
- **The screens.** "The stock, step by step" in the panel; a stage tab with the list as
  buttons and a slider over the 3D view. `Viewer3D` takes owners and colours, and keeps
  its camera in an object its parent holds, so that stepping does not reset the view. An
  inlay's "After the glue-up" became "The glue-up, and after it", with the glue-up first.
- Checked by test: a backer plug glued in and faced flush, with the plug's wood inside
  the shapes and the stock's around them; a V-carved plug's seat; loose inserts; a pocket
  cut through a plug into the stock; a glue-up before its pocket, twice, and of an inlay
  that cannot be built. In the app: a V-carve inlay with glue-up and trim, stepped
  through.

Not done, and on the roadmap: files from the order of the list in place of the tick
boxes; the trim's height read from the stock; only the changed line and those after it
worked out again; the backer's overhang drawn as it is.

Files from the order of the list, and a facing that takes its height from it
(2026-11-17). The second stage of the above.

- **One file per run.** The jobs from one step done by hand to the next are one file,
  since the machine stops there anyway; `timeline::file_numbers` says which. The tick
  boxes and "One file for the stock" are gone, with `previewCombined`. What they could do
  that this cannot is leave a line out of the file; a line still has its own file.
- **The file that is shown is the file that is cut.** The timeline no longer runs each
  job's own file: it joins a run (`build::join`, the body of the old `build_combined`,
  which is kept for its tests) and runs that. To stop after every line it has to find the
  lines of each part again, which arc fitting and the dropping of a tool change make
  impossible to count. So the joined program has a comment where each part begins
  (`Move::Comment`, "Step 2: name"), and the part is every line from its comment to the
  next. The comment is also what someone reading the file at the machine wants. A run
  with a line that cannot be built is joined from the rest, to show them, and marked not
  complete, so that it is not offered for download.
- **Names.** `<project> stock.cnc` for one file, `stock 1`, `stock 2` for several.
- **A facing's height from the list** (`aboveAuto`, `build::facing_start`). The trim held
  a copy of the inlay's numbers and offered to set them again. Now it can take the height
  from the jobs before it: by the inlays' own numbers, not from the simulated stock.
  Decided so because a file must not depend on a simulation having been run, and because
  the two differ only when a plug does not seat, which is then a matter for the user. The
  simulated stock is still asked: a facing that starts lower than the wood stands gets a
  warning with the difference. The trim an inlay adds has it switched on. The margin is
  still a copy.
- The sentence "the simulation shows the stock only" is out of a facing's warnings: it is
  not true of the stock step by step.
- Checked by test: a run of two jobs as one file with one tool change, its two stretches
  cut apart at the comment, the stock after each; file names; an incomplete run; a
  facing's height after, before and without a glue-up and after an earlier facing; the
  warning for a start that is too low. In the app: two files around a glue-up, and the
  facing's panel.

The stock step by step is a tab, and the panel's section for it is gone (2026-11-17). The
user found the way in hidden: a button far down the panel, and a glue-up that could only
be added from the foot of an inlay's panel. Now "Stock, step by step" is a tab beside
"Drawing" as soon as the list has a line, and works the stock out the first time it is
opened; "Glue-up" is a tile under "Steps done by hand" where inlays and operations are
added. The user then asked whether the panel's section was still needed. It was not: what
it held went into the view. The lines of a file stand in a frame with the file's download,
"Generate again" is beside the slider, and the file's time, tools and warnings open under
the line that is shown. A result that is out of date is not made again by itself, since
that takes seconds: the view says so and holds the downloads back.

The files are a tab of the panel (2026-11-17). Download buttons among the step buttons
made the stock's view look poor, the user said, and asked where else they could go. Three
places were built and looked at in turn: a tab of the stage with a sheet of cards, a menu
at the end of the row of tabs ("better"), and then, at the user's wish, a tab of the
panel on the right, beside "Inlays and operations". "Files" lists in the order things are
done: the files for the stock, the glue-ups, and now also every inlay's plug or insert
file, placed before the glue-up that needs it, which until then could only be had from
the inlay's own panel. For that `timeline` returns `parts`: it simulated the plugs it
glued in anyway, and now does so for every inlay. A row has the file's time, tool changes
and checks, its warnings folded away, and its download; the tools by name and the board's
size are left to the inlay's or operation's own panel. The files are made the first time
the tab is shown. The stock's view keeps the frames around the lines of a file and nothing
to press but the steps.

Jobs are steps, and a project file is version 2 (2026-11-17). The third stage of the
stock step by step. What the list holds was a `Job` with what it does under `inlay`,
names from when the app made inlays only; by now it also held plain operations and
glue-ups, and `Inlay::Facing` read badly. In the core and on the screens it is a `Step`
with a `task` (`Task::Vcarve` … `Task::Glue`), and a project has `steps`. "Inlay" is left
for what is one: `isInlay`, `TrueInlay`, the inlay a glue-up names by `inlayId`. The
timeline's record of how a step went is a `StepRun`.

The project file follows, which is not an addition: `formatVersion` 2, with the first
migration the format has had (`project::steps_from_jobs`: `jobs` to `steps`, each `inlay`
to `task`). Projects in browser storage are file text and go through it when opened; they
are written back as version 2. `project-v2.json` is the fixture for it, and the two
version 1 fixtures still have to load: one test holds that the version 1 fixture comes
out as the version 2 one. An older build of the app refuses a version 2 file.

Done as one mechanical renaming with the compilers and the tests as the check, and by hand
where a name stood for two things: a step of the list and its run in the timeline. The
names of CSS classes were left (`job-row`), since the stylesheet has a `.step` of its own.


Four things left over from the stock step by step (2026-11-17).

- **Sawing the backer off is a step** (`Task::Saw { inlay_id, leave }`), done by hand like
  a glue-up, so it splits the files too. On the stock it lowers the plug's wood to `leave`
  above the surface; where all of that wood was higher, as the backer is over the saw
  gap, nothing is left and the surface is what lay under it. `leave` starts at the
  inlay's saw gap, the most a saw running in the gap can leave. The height a facing takes
  from the list goes down to it.
- **A facing's height from the stock.** `aboveAuto` went by the inlays' numbers, and the
  simulation warned when a plug stood higher. In a file for the stock the facing is now
  built for what stands on the stock where it cuts (`build_with`, `Workpiece::top_in`),
  rounded up to 0.01 so that the first pass starts in the air. For a facing that is not
  the first part of its file, the parts before it are run on a copy of the stock first,
  each from its own file. The facing's own file keeps the inlays' numbers: it is made
  without the stock.
- **Only what changed is done again** (`timeline::Cache`, held by the wasm module). A
  step's outcome hangs on everything that is not a step and on every step up to it, a
  glue-up or sawing also on its inlay; that chain is hashed into one key per step. What
  is kept per key: the step's problems (lines counted from where it begins, since a tool
  added later in the same file moves them), warnings, seat, snapshot, and for the last
  24 steps the stock after it. A new pass finds the first step whose key is unknown,
  goes back to the nearest kept stock, and goes on from there. Builds and plugs are kept
  by what they hang on. The files are joined every time: their names and tool lists hang
  on the whole list, and joining is cheap beside cutting.
- **Glued-in wood as a body of its own in 3D.** A snapshot also has, per cell in such
  wood, its underside and the surface it was put on. The board is drawn as what lies
  under the wood; the wood's top is drawn over it, level to its edge where it stands off
  what is beside it, with a wall down to its underside, and running on into the board
  where it sits in it. So the saw gap shows under a backer, and a V-carved plug sawn off
  above the surface shows the wedge under its rim.
- Checked by test: sawing, before and after its glue-up and twice; a facing's start on a
  plug that lies 2 mm high, and after a facing before it in the same file; a second pass
  with nothing changed, the last step changed, a step added, the inlay changed and the
  stock changed, each against a pass from nothing. In the app: glue-up, sawing and trim
  stepped through and turned.

Three more of them (2026-11-18).

- **A trim's margin follows its inlay** (`marginAuto`, `build::facing_margin`): the widest
  plug margin of the inlays the facing's shapes belong to, in place of a copy made when
  the trim was added. The trim an inlay adds has it switched on. Such a facing hangs on
  those inlays, so they are in its key, and it is done again when they change.
- **A facing's own file starts on the stock too.** `previewPart` asks
  `timeline::starts_above`, which takes the stock through the list from what the cache
  holds, and builds the file for that height. The first time that costs what the whole
  list costs; after it, and after "Stock, step by step" has been opened, next to nothing.
  The panel still shows the number the inlays give, which needs no simulation.
- **The underside of glued-in wood** is drawn, a shade darker, and its walls end on it
  corner by corner in place of the lowest point of the square.

### Text that explained (2026-11-18)

The roadmap's item on the blocks of text in the panels. Counted before: 144 blocks of
hint, muted or warning text in the components, about 1,870 words, 1,040 of them in
`DesignPanel.tsx`. Read one by one they were seven things in one grey style: what a word
means, what the numbers give, why an option exists, how the order of the list works,
where something is on screen, something said before, and something wrong. Each has its
own cure, so there are four of them and not one.

- **Cut.** Pointers to what is on screen and repeats are gone, and what was left is a
  sentence each. The rule kept since: a line that is always on screen reports something
  (a number worked out, a warning, a thing to do), and never explains.
- **Help on demand** (`HelpTip`, `help.tsx`). A "?" beside a label opens a card: a
  title, a line or two, and a small picture where one says more. It shows while pointed
  at or focused, stays on a click, and goes on Escape, a click elsewhere or scrolling.
  The entries are in one file, keyed as the setup's fields are where they are a setup's,
  so the "New inlays" page of the Settings reads its lines from them too. The column
  headings of Materials and Profiles use it in place of a `title`. `NumberField` takes
  `help` for what explains and keeps `hint` for what the number gives; it is a `div`
  with a `label` for its input now, so that the mark is not part of the field's name.
  A strip at the foot of the panel showing the help of the focused field was mocked up
  too and not built: nothing on a field says it has help, and there is no foot outside
  the panel.
- **Drawn.** A chamfer is a section through the edge with the bit against it, to scale
  (`ChamferDiagram`, with `edge_cut`'s numbers): width and height of the bevel, the
  tip's clearance and depth, the room beside the edge, the wood that must be gone dashed;
  a corner-rounding bit with its radius. The field being typed in marks its numbers
  (`onFocusChange`), and the inlay's cross-section does the same.
- **Said by the screen.** "After the cut" in an inlay's panel is a row for each step that
  follows (glue-up, sawing the backer off, the trim), each in the list or offered, in
  place of three paragraphs round a button.
- **Before cutting, and notes.** A file's "things to know before cutting" were two kinds
  in one list. The core now keeps them apart (`Built.before`, `Built.warnings`): what
  to do before the file is run, each line one thing to do and said first (a spoilboard,
  tape, clamps, the size of board, a test piece in a material other than wood), and
  notes on what it cuts, which ask for nothing. The panel shows the first and keeps the
  second closed. The texts are shorter; none was dropped.
- Not built: an "Explain" switch that hides every explanation, which hides the wall and
  leaves it the explanation.
- Checked: 277 core tests, 89 UI tests. In the app: the tips on an inlay's panel and the
  Materials page, the rows, the marked dimension, and a chamfer with a 60° V-bit. The
  two lists of a file were looked at with made-up lines only, not on a generated file.

The rest of it, the same day.

- **Less, not more.** Tips and hints that said what a label already says are gone: the
  material, the wood's colour, the order of end mills, which bit bevels and which
  rounds, the cut past the bottom, the board round a cut-out plug, and the Makera, Note
  and Rows headings of the Settings tables. A tip is for what a label cannot say.
- **Facing in section** (`FacingDiagram`): the wood above the surface, what comes off
  and the margin, with the field being typed in marked. Heights follow the numbers,
  widths are a sketch. It takes the place of two lines of text.
- **Steps done by hand** have one line, "By hand, with no file", and a "?" for what
  their place in the list means. A step in the wrong place still says so.
- The mark follows the last word of a label that takes two lines, and fields side by
  side keep their boxes on one line.
- Notes for after the cut (tabs to cut, a plug to glue in face down) stay with the notes
  on a file: a third list was weighed and not made, for two kinds of line.
- Put off: the Tools tab. On the roadmap.
- Checked in the app with made-up tools: every picture card, the Profiles headings, a
  chamfer with a corner-rounding bit, the facing drawing, the glue-up and sawing panels,
  and both lists on generated files, in an operation's panel and in the list of files.

### The starter set, offered (2026-11-18)

- "Add the starter set" on the empty Tools tab and under "Import and export"
  (`starterLibrary` in the wrapper, `addStarter` in `model.ts`). It adds a tool only
  when the list has none of its id or name, and a material or group only when the list
  has none of its key: nothing that is there is changed, and a second click adds nothing.
- Each added tool carries a line saying its cutting settings are a starting point,
  untested here, unless it had a line of its own.
- The two profiles are left out: no starter tool has a row on one.
- The app does not name the maker of the bits in what it says about the set. Ten
  remarks in `starter-tools.json` that did were reworded; the product pages the tools
  link to are as they were.
- Filling an empty list by itself was weighed and not done: the list would then claim
  tools its owner may not have.
- Checked: 2 UI tests of `addStarter`; in the app, 50 tools added to an empty list and
  none on a second click.

### Chamfers in passes the row is set for (2026-11-18)

- **What was wrong.** A chamfer went down in equal steps of the row's stepdown on one
  track. A V-bit's row is sized for a full groove one stepdown deep (`slot_area` in the
  feeds model), but a chamfer's pass takes a strip as wide as the bevel already is, so
  the last passes took 1.5 to 3 times that: 2.9 times on the last of six passes of a
  2.5 mm bevel with a Ø6 90° bit at 0.5 mm. And a bevel wider than the flank was refused.
- **Planned in section** (`ops/chamfer.rs`). The edge is cut in a section square to the
  outline, column by column, and every plan is run there: what each pass takes, and
  whether the bit's uncut part above its cutting edges would meet wood. Above the
  flutes the bit keeps its shape: a V-bit's cone goes on to its diameter, a
  corner-rounding bit's quarter circle to its top. Two limits, both the row's: no pass
  more than a stepdown deeper, and none taking more than the groove
  (`feeds::groove_area`). Equal steps were not kept as an option: the choice would be
  between within the row and up to three times over it.
- **One track** where the bit can: full stepdowns while the edge is narrow, then
  shallower, as evenly loaded as that number of passes allows, so that the last is not a
  sliver. The same for corner-rounding bits, whose groove is the quarter-round corner.
- **Layers** where it cannot: a bevel wider than the flank, or than short flutes reach.
  Layers of equal depth, at most a stepdown; in each, tracks from the one whose flank
  lies on the bevel out to the one beside the edge, close enough that the ridges they
  leave stay below the next layer's uncut part. The layer depth is the deepest at which
  every pass fits, found by trying. About 1.5 to 1.8 times the fewest passes the wood
  would allow, so the file and the panel name a V-bit of the same angle in the list that
  would cut it from one track. A corner-rounding bit whose flutes stop short of its
  radius is refused.
- **Shown.** The chamfer's drawing has a band for the wood each pass takes, from the
  core's plan (`chamferPlan` in the wrapper); the caption says how many passes and how
  far they go down, or how many layers, with a "?" for the rule. The error that a bit
  is too narrow is gone.
- **Paths.** `follow_depths` in `ops/profile.rs` runs the planned depths round each
  track, straight down at the start of each round; between tracks the bit lifts.
- Checked: 8 core tests of the plan (both limits, the uncut part clear, the bevel or the
  rounding to 0.02 mm, short flutes, layers), 2 of the files (the steps from the G-code;
  a 6 mm bevel in layers, against the simulated stock); 91 UI tests; the drawing and
  the picture card rendered for a one-track bevel, a layered one and a rounding. Not
  yet cut on the machine, and not looked at in the running app.
- **After a browser test and a review, the same day.**
  - The simulation refused every layered bevel deeper than the bit's flutes: it held
    the tip's depth against the flutes. For V-bits and corner-rounding bits it now
    asks what the planner asks, whether the part of the bit above its flutes would
    have to take wood (`HeightMap::rubbed`), allowing a cell's width up the flank. End
    mills keep the plain check. A V-bit plunged past its flutes into solid wood is
    still reported; a chamfer run on its own over a fresh block, with wood beside the
    edge where the cut is meant to have been, is reported too, rightly.
  - The groove follows the kind of bit (`feeds::groove_area`), not its shape: a V-bit
    with a 1 mm flat was taken for a corner rounder and given a tenth of its groove.
  - Layered bevels take the layer depth with the fewest passes that fits, not the
    first. Where a layer's tracks leave ridges, a pass over one cuts deeper than a
    stepdown in that column; it takes a sliver there, within the groove, and was left
    so: holding every column to the stepdown put a pointed bit's tracks 0.17 mm apart.
    The rule is that each layer is at most a stepdown below the last.
  - A larger bit is named from its geometry alone (`one_track_width`), without
    planning it; the panel plans again only when the chamfer's task, wood, rows or bit
    change, and shows no plan for numbers it was not made for.
  - A corner-rounding bit's groove is that of a 90° cone of its height, flat tip and
    all, as the feeds model reads the bit, not the quarter-round corner: held to that
    corner, an R3 bit on a 1 mm stepdown took 10 passes and an R6 one on 0.2 mm 894,
    against 3 and 30 in equal steps. Now 3, and about the stepdown's count where the
    stepdown is shallow, with the load spread over them.

### The starter set from the start page (2026-11-18)

- The first step of the start page, "List your tools", has "Use the starter tools"
  beside "Add tools" while the list is empty. It adds the set as the Tools tab does
  (`addStarterSetHere` in `files.ts`) but stays on the start page, where the step is
  then ticked and the next one, the drawing, is the one marked to do.
- Checked in the browser: on a fresh start the button adds 50 tools and the step is
  ticked; with tools in the list the button is gone and "Open tool list" is as before.

### A server (2026-11-18)

Phase 4 of joining with the tooling library, whose workbench was a Python server with the
tool list in a `tools.yaml` on it. Here the app stays what it is, static files that work
from any web host, and a server is something the same build can be served by.

- **The server** (`crates/inlay-server`). A small Rust program on the core: it serves
  `web/dist` and keeps `tools.json` in a data folder. Rust, so that the file is checked,
  the libraries for other programs written and the feeds model asked by the same code the
  page runs as WebAssembly; nothing of them is written twice. `tiny_http` and threads, no
  async runtime: the load is one household.
- **The file is the app's own tool file**, the text that "Export a tool file" writes and
  that browser storage held. No new format, and the page needs no second way to read or
  write its list. The Python workbench edited the lines of a YAML file in place to keep its
  comments and layout; a JSON file written whole by one writer has neither to keep, so a
  write here is: read, change the tool list, check, write.
- **The page finds the server** by asking `api/health` at start. With the server's answer,
  everything is read from and written to the server in place of browser storage; on a
  static host the question gets a 404 and nothing changes.
- **One or the other, never a mix.** First built with only the tool list on the server,
  as the roadmap had it, and projects, machine and defaults left in the browser. The user
  asked for no such hybrid, the same day: where things are kept is one answer for all of
  them. `storage/home.ts` is that answer, asked once, and the one way to storage for the
  store, the header and the file actions: `db.ts` under it in a browser, `server.ts` on a
  server. Projects are project files in `projects/`, by id; the machine, the inlay
  defaults and the last open project are texts in `settings.json`, as they were in the
  browser's store. What the screens remember (the tool list's sort and chips, where a
  suggestion was left) was in local storage from three places: it goes through
  `storage/view.ts`, and on a server is one more setting, read at start. Checked in two
  browsers that share nothing: the second opens the project the first renamed, with the
  first's sort order, and neither has anything in its own storage.
- **Projects are not checked by a token.** The last write is kept, as between two tabs of
  one browser before. A project saves itself three times a second while it is worked on,
  and a refused save would have to be merged or dropped in the middle of drawing; the
  tool list is where two writers are expected, since agents write to it. A project
  deleted is moved to `backups/`, since "this cannot be undone" is harder to stand behind
  on a server others use.
- **Writes are checked by a token**: the SHA-256 of the file. A write names the token of
  the file it changed, and is refused with `409` when the file is no longer that one. This
  is the tooling library's rule. The page, refused, reads the list again and says that its
  last change was not kept; it also looks for a newer list when it is come back to, and
  once a minute, so that this is rare.
- **The API** (`api.rs`, [../api.md](../api.md)). For the page: the whole file, read and
  replaced. For agents and scripts: a compact tool list with a word search, one tool, a
  patch of one tool, add and delete, a row's log entry, the feeds model's numbers for a
  row, what needs attention, and the libraries for the other programs made on the spot.
  Every write takes a dry run and answers a diff of the file on request, since the agent
  brief's rule is that the owner approves the exact diff. A patch is a JSON merge patch of
  the tool as the file holds it, with cutting rows by key; a key the model does not have is
  refused (`serde_ignored`), because a misspelt key would otherwise vanish in silence.
  The tooling library's `/check` routes, its `generate` with a `build/` folder, its import
  routes and its patch grammar of `op`s are not here: a dry run flag, libraries on demand,
  the app's own import, and the merge patch take their places.
- **Backups.** The file as it was, before every write that changes it. The page saves on
  every change, so "the last 20" of the tooling library would be gone in an afternoon: the
  newest 30 are kept, and of older ones the last of each day, for 60 days. Putting one
  back is a `GET` of it and a `PUT` of the file.
- **No login**, like the workbench, with its guards: only `localhost` is answered unless
  told otherwise, and a write needs a header that another site's page cannot send.
- `Dockerfile` and `compose.yaml` build and run it with the data folder as a volume.
  [../agent-brief.md](../agent-brief.md) is the workbench's agent prompt for this API.
- Checked by test: 31 in the server, on the routes as functions over a folder with the
  starter set (reads, patch, misspelt keys, conflict, dry run, backup and putting it back,
  log, add and delete, suggestions against the core, the exports against the core, the
  guards, projects, settings) and on the store (backup names, thinning, UTC dates). In a browser against the
  running server: the starter set added in the page and found on the server; a tool
  renamed through the API shown in the page when it is come back to; a change made in the
  page over a list changed meanwhile refused, said, and the next one kept.
- Known limits: nothing moves what a browser holds to a server but files, by hand; a
  project open in two browsers is the last one saved; saving a project reads it back from
  the server first, to tell a change from none; a refused change is dropped, not merged, though two changes to different
  tools could both be kept; materials, profiles and groups are changed through the API
  only by replacing the whole file; the server's suggestions are for a Carvera Air's
  spindle, since the machine is a browser's setting; the page does not say when the
  server is out of reach until something is saved; the Docker image was built once and not
  run behind a proxy.
