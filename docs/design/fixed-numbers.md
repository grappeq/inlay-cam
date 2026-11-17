# Fixed numbers in the core

Numbers that are written into the code of `crates/inlay-core` and change how a part is
cut, simulated or checked: which were made settings, which were left fixed and why, and
which are meant to stay fixed.

Made on 2026-11-17 by reading the core's non-test code. What was only searched and not
read line by line is named at the end.

Left out: about 56 rounding guards of the `1e-9` kind, which nothing visible depends on;
numbers set by an outside file format (Fusion, Makera, SVG and DXF units); and the
defaults of fields that are settings already.

## Made settings

Each has a default that keeps what the app did before, and is left out of a file while it
has it.

| Number | Now | Where it is set |
|---|---|---|
| Spindle speed range | The machine's lowest and top speed. The feeds model keeps within them and runs woods and plastics at the top: 13000 rpm on a Carvera Air, where it used 12000. | Settings, Machine: one row, lowest and top. `minRpm`, default 5000. |
| Time per tool change | Added to a file's time for each tool it loads. | Settings, Machine. `toolChangeSeconds`, default 0, which gives the time without tool changes as before. |
| V-bit floor ridge | The file says when it puts the V-bit's passes closer than its cutting settings do. | The V-carve panel, under "Finer points". `floorRidge`, default 0.1 mm. |
| Relief stays below the face | | "Finer points". `reliefKeep`, default 0.5 mm. |
| Face judged below the surface | | "Finer points". `trimDepth`, default 0.1 mm. |
| A chamfer's tip clearance | | The chamfer panel. `tipClearance`, default 0.2 mm. |

Spindle power stays fixed at 200 W: it is the same on the Carvera and the Carvera Air,
the only machines the app writes for.

## Left fixed for now

| Number | Where | Now | What it does | Why not yet |
|---|---|---|---|---|
| Simulation grid | `build.rs`, the call of `cell_for` | about 2 million cells, none finer than 0.05 mm | How fine the simulation is, and so how exact the fit check is. | The roadmap's tiles and finer pass over a region replace it. |
| Join gap on import | `import/join.rs` `JOIN_GAP` | 0.01 mm | Line ends closer than this are joined into closed outlines. | Better offered when outlines were left out than kept as a setting. On the roadmap. |
| Border round a DXF | `import/dxf.rs` `PAGE_MARGIN` | 5 mm | A DXF has no page, so the stock is the drawing plus this on every side. | The stock's size can be changed after import. |
| Finishing pass stepdown | `ops/clear.rs` `finish_walls` | one tool diameter | The pass that finishes walls goes down in steps as deep as the tool is wide, not by the tool's own stepdown. | To decide with "cutting settings shown in the operation". |
| Fewest tabs | `ops/profile.rs` | 3 | An outline gets at least three tabs however far apart they are set. | No one has needed otherwise. |
| Arc fitting | `toolpath.rs` `ARC_FIT_TOLERANCE` | 0.008 mm | Runs of short straight cuts this close to a circle are written as one arc. | Belongs with a second controller, if there is one. |

## Numbers in two places

Put right:

- **Fit verdicts** are the core's: `analysis.rs` holds what counts as seated, pressing
  home and good, as named numbers, and gives a verdict with each fit. The screens put it
  into words.
- **"As drawn"** and "the insert overlaps" for a flat inlay are the core's too, by the
  rule its warnings use.
- **Defaults and limits** of the clearances, the machine, a chamfer's tip clearance and
  a V-carve's finer points are read by the screens from `web/src/core/core-values.json`.
  A test of the core holds that file to what the core says, and writes it afresh when
  run with `UPDATE_CORE_VALUES=1`.
- **The relief's 0.5 mm** in the plug's warning and in the panel is the inlay's value.
- **A V-bit without an angle** cannot be saved: the tool check already refused one, so
  the 90° written in several places is never reached.

Still in two places:

- **An engraver is a V-bit of 45° or less** in both `feeds.rs` and `naming.rs`.
- **The smallest region kept**, 0.01 mm², is defined in both `import/svg.rs` and
  `import/dxf.rs`.
- **Chip thinning** is worked out in `feeds.rs` and again in
  `web/src/state/feedsView.ts`.
- **Curve flattening**, 0.01 mm, is `FLATTEN_TOLERANCE` in `import/svg.rs` and `FLATTEN`
  in `web/src/state/shapes.ts`, which makes the outlines of shapes drawn in the app.
- **A new cutting row** starts at 12000 rpm, feed 500, plunge 150, stepdown 0.5 and a
  stepover by kind of tool, set in `ToolCard.tsx` only. A row added and not edited cuts
  with these.

## Suggested to stay fixed

Thresholds and tolerances that a user has no reason to turn.

**Toolpaths**

| Number | Where | Value | What it does |
|---|---|---|---|
| Narrow parts | `ops/vcarve.rs` `NARROW_TAPER`; `build.rs` | 0.17 (about 20°); 0.5 mm | Which parts of a V-carve count as too narrow for the plug to seat, and the least length that is warned about. |
| Smallest relief | `ops/vcarve.rs` `MIN_RELIEF`; `build.rs` | 0.02 mm; 0.5 mm | Reliefs smaller than this are skipped; the warning needs this much ridge. |
| Smallest margins | `build.rs` | saw-gap radius + 0.5 mm; tool + 1 mm | The least plug margin and insert margin before an error. |
| Run past a blank's edge | `build.rs` `edge_overrun` | 0.25 mm | How far an end mill runs past a cut-out plug's blank when the strip is narrower than the tool. |
| Border rounded up | `build.rs` | whole mm | The cut-out border is rounded up so the plug sits on the simulation's grid. |
| Tab rules | `ops/profile.rs`; `build.rs` | as much cut as tab; fewer than 2 means none; half the depth | Where tabs fit, and their thickness in a cut that is not through. |
| Chamfer and V-bit entry | `build.rs`; `ops/vcarve.rs` | straight plunge | These bits never ramp; the ramp angle is for end mills. |
| Shortest ramp | `ops/clear.rs` `MIN_RAMP_RUN` | 0.5 mm | Shorter runs are plunged. |
| Staying down between passes | `ops/clear.rs`; `ops/vcarve.rs` | within 2 tool diameters; within 4 stepovers | When the tool stays in the wood to reach the next pass instead of lifting. |
| Rest machining | `ops/clear.rs` `REST_SLIVER`, `REST_MARGIN`, `MISSED_OVERLAP` | 0.02, 0.05, 0.01 mm | What a later tool treats as left over. |
| Small-share warning | `build.rs` `SMALL_SHARE` | 1 % | Warns that an end mill before a V-bit removes almost nothing. |
| Finisher only just fits | `build.rs` | 0.02 mm | Where the finishing pass barely fits, the area is cleared without the allowance. |
| V-carve thinning | `ops/vcarve.rs` `RAMP_TOLERANCE`, `MIN_RAMP_DEPTH`, `SLIVER`, `RING_TOLERANCE` | 0.005, 0.005, 0.01, 0.002 mm | Corner ramps and floor rings too small to matter are dropped. |
| Round joins | `geom/offset.rs` `ARC_TOLERANCE` | 0.005 mm | How closely an offset's rounded corners follow a true arc. |

**G-code**

| Number | Where | Value | What it does |
|---|---|---|---|
| Arc limits | `toolpath.rs` | sweep up to 4 rad; radius 0.05 to 2000 mm; 3 pieces at least | Which runs can become an arc. |
| Rounding | `post/carvera.rs` | 0.001 mm; 0.1 mm/min | Coordinates and feeds as written. |
| Line length | `post/carvera.rs` `MAX_LINE_LENGTH` | 128 | The firmware's limit. |
| Height after a tool change | `gcode.rs` `TOOL_CHANGE_Z` | 100 mm | Where the simulation takes the tool to be after M6. |
| Fallback plunge clearance | `toolpath.rs` `PLUNGE_CLEARANCE` | 1 mm | Always overridden by the setting; only tests reach it. It could be removed. |
| Spindle power | `feeds.rs` `SPINDLE_W` | 200 W | Quoted in the feeds notes. The same on both Carveras. |

**Simulation and fit check**

| Number | Where | Value | What it does |
|---|---|---|---|
| Touching | `analysis.rs` `CONTACT` | 0.05 mm | A wall gap up to this counts as contact. |
| Floor and wall bands | `analysis.rs` | 0.01 to 0.02 mm | Sort cells into floor, wall and full height. |
| Problems listed | `sim/mod.rs` | 50 | The list of simulation problems stops there. |
| Corner-rounding bit | `sim/mod.rs` | 16 samples | How finely its profile is sampled on a sloped move. |
| Flat inlay checks | `build.rs` | 0.01 mm, 0.01 mm²; 0.2 %; 0.5 mm² | Overlap that is ignored, the "cannot follow the drawing" warning, and wood left between inserts on a backer, which is an error. |

**Feeds model.** `feeds.rs` holds a table of nine material classes with about fourteen
numbers each, five aggressiveness stops, and rules for particular cutters (engravers,
corner rounders, large V-bits, small drills, thread mills, adaptive clearing). They were
kept number for number with the tooling library. Once that program is retired they are
the app's own to change, but as a model, not as settings.

**Import**

| Number | Where | Value | What it does |
|---|---|---|---|
| Curve flattening | `import/svg.rs` `FLATTEN_TOLERANCE` | 0.01 mm | How closely lines follow a curve; DXF arcs and splines use it too. |
| Smallest region | `import/svg.rs`, `import/dxf.rs` `MIN_REGION_AREA` | 0.01 mm² | Smaller regions are dropped as specks. |
| Closed without saying so | `import/svg.rs` `CLOSED_GAP` | 0.001 mm | An SVG path whose ends meet this closely is closed. |
| Spline sampling | `import/dxf.rs` | 0.05 mm, 8 to 2000 points | Before thinning. |

**Limits on settings.** `Setup::validate` in `project.rs`: safe height 1 to 50 mm, plunge
clearance from 0.1 mm to the safe height, cut past the bottom 0 to 2, tab width 0.5 to 50,
tab spacing 5 to 1000, tab thickness 0.1 to 20, cut-out border 0 to 100, ramp angle 0 to
45°, finish allowance 0 to 1. First tool number 1 to 99. Tip clearance of a chamfer 0 to
5. A V-carve's floor ridge 0.01 to 1, relief below the face 0 to 5, face judged 0 to 2
below the surface. A tool change 0 to 3600 s. An operation's own lengths have no upper limits. The feeds model suggests nothing
outside a diameter of 0.1 to 25 mm, 1 to 8 flutes, and lengths to 500 mm.

## What was not read line by line

Read in full: `ops/clear.rs`, `ops/profile.rs`, `ops/vcarve.rs`, `toolpath.rs`,
`gcode.rs`, `post/carvera.rs`, `sim/mod.rs`, `analysis.rs`, `geom/offset.rs`. In
`build.rs` every operation was read, and its first 460 lines and the code for combined
files were searched for numbers only. In `feeds.rs` the adaptive section and what follows
it were searched only, as were `tools.rs`, `naming.rs`, `file.rs`, `geom/medial.rs`,
`geom/simplify.rs`, the tool-library readers and the export writers. `web/src` was
searched for likely values, so a number there under an unexpected name could be missing.
