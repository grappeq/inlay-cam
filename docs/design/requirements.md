# Requirements (v1)

The requirements the app was built to, agreed 2026-11-14 and kept as a record.

## Purpose

A web app that generates CNC toolpaths for wooden inlays (V-carve and flat pocket),
outputs G-code for a Carvera Air running the Carvera Community Firmware, and simulates
the toolpaths against a stock to check that the inlay will fit.

Started as a personal tool. No GPL code is copied, so that the licence could be chosen
freely; the app is released under the MIT licence.

## V1 scope

### Platform
- Web app, frontend-only (static files, no backend). Geometry and simulation run in the
  browser.
- Output: save `.cnc` files. No connection to the machine.
- Projects are saved in browser storage and can be exported to and imported from a file.
- The project file carries a format version. Every later version of the app must open
  files written by earlier versions (migrate on load; never drop support for an old
  version).

### Machine and G-code
- Target: Carvera Air, Carvera Community Firmware. Every tool change is a manual prompt.
- V1 writes Carvera G-code only. Output profiles are pluggable (one module per controller
  dialect) so other controllers can be added later.
- Firmware rules the Carvera profile must follow: mm only (never G20), arcs as I/J in the
  XY plane, no G43, no canned cycles, `M6 Tn` on one line and spindle restarted after it,
  uppercase, spaces between words, lines under 128 characters, comments only at end of
  line, F on the first feed move after a rapid, no homing/probing/offset commands (the
  controller does those).

### Design input
- SVG import, and DXF import (added later at the user's request; text DXF only); place,
  scale and mirror in the app. No drawing or text tools.
- The user selects which shapes of the design become inlays. Each selection is cut as its
  own pocket + plug job, so several selections can use different materials.

### Tools
- The app keeps its own tool list, which the user manages in the app (add, edit, delete).
  It is stored with the app's data in the browser and can be exported to and imported
  from a file. That file format is documented and versioned like the project file.
- Limited import from the `tools.yaml` of `cnc-tooling-library` (the author's own tool
  list, not published): only what inlays need, the rest is skipped.
  - Tools: `flat_end` and `v_bit` (not corner-rounding cutters). Drills, thread mills and
    ball noses are skipped.
  - Per tool: name, type, and geometry (diameter, tip diameter, tip angle, flute length,
    shank diameter, overall length, flutes).
  - Cutting settings: the plain rows for hardwood and softwood (rpm, feed, plunge,
    stepover, stepdown). Toolpath-profile rows (e.g. adaptive) and other materials are
    skipped.
  - Skipped entirely: ids, source, inventory, coating, style, recommended_for, verify,
    groups, material records.
  - The documentation states which `tools.yaml` fields are read.
- V-bits are modelled with their tip flat (`tip_diameter`), not as a perfect point.
- Cut depth is checked against the tool's flute length (cone height for V-bits).

### V-carve inlays
- Parameters shown to the user: engagement depth, glue gap, saw gap. Start/flat depths are
  derived from these.
- One or several flat end mills for clearing, used in the order the user sets (rest
  machining), plus one V-bit. (Several tools were added after the first version of
  these requirements; see milestone 7 in the plan.)
- Plug is mirrored automatically and stays linked to its pocket.
- Features too narrow for the chosen depth: warn in v1. Automatic relief is planned for
  the version after (see below), so plug toolpath generation should leave room for it.

### Flat pocket inlays
- An end mill cannot cut an inside corner sharper than its own radius. The corner radius
  of both parts is therefore limited by the tool diameter. The app must account for this:
  both pocket and insert are generated from a corner-rounded version of the design
  (radius >= tool radius), the user sees what was rounded and by how much, and choosing a
  smaller tool gives sharper corners.
- Fit allowance is a user setting.
- Insert holding: tabs or no tabs.

### Simulation
- Simulates the emitted G-code (not internal toolpath data) against a defined stock.
- Level (c): 3D preview of each part; fit analysis (gap map, cross-section, appearance
  after trimming flush); safety checks (rapids through stock, travel limits, flute length,
  shank collision).
- Only this app's own G-code is accepted.

### Order of work
- V-carve inlays first, then flat pocket inlays.

## Added after v1 (2026-11-15)

At the user's request; how they were built is in the plan.

- Stock dimensions: the base board has a width, height and thickness of its own, and the
  imported shapes are placed within it. It applies to the base board only; plugs and
  inserts keep boards worked out from the shapes and the inlay's settings.
- Shapes can be imported from several files onto one stock.
- Other operations on the stock: pocket, facing, contour and chamfer. Facing serves both
  to flatten the stock and to mill a glued-in plug's backer off, so it can start above the
  stock's surface.
- Each inlay and operation has its own file; several can also be put into one file for
  the stock, chosen per download.
- The colour of each inlay's wood, and of the stock's, can be chosen. It is used in the
  drawing, the 3D view and the fit view.

## Out of scope for v1 (future)

- A curated list of default tools that can be loaded into the app's tool list: common end
  mills and V-bits with sensible cutting settings for hardwood and softwood, so that a new
  user does not start from an empty list. Asked for by the user on 2026-11-15, to be done
  later. To decide then: which tools, where the list lives (bundled with the app or
  fetched), and how loading it merges with tools the user already has.
- Automatic relief of narrow plug features: shave the tips of narrow plug ridges by the
  glue gap so they cannot bottom out. Definitely wanted; first candidate after v1.
- Uploading jobs to the machine over WiFi/USB.
- Reading tools live from the tooling library's API instead of importing the file.
- Several clearing tools with rest machining (v1 data model must already allow it).
- Rest machining of flat-pocket corners with a smaller tool, for sharper corners on both
  parts without cutting everything with the small tool.
- Tapered ball-nose bits for deep, steep-walled V inlays.
- Facing toolpath that mills the plug backer off after glue-up. (Done: see "Added after
  v1".)
- Calibration coupon (one shape cut at several allowances) with results stored per bit
  and material.
- Output profiles for other controllers: GRBL, LinuxCNC, Mach.
- Carvera (C1) tool-rack support: tool numbers T1-T6 mapped to rack slots.
- In-app drawing and text (fonts to outlines).
- Sequenced multi-colour workflows: inlay into inlay, re-flattening between colours,
  shared boundaries between two inlay materials.
- Onion-skin and tape/CA holding strategies for flat inserts.
- Simulating G-code from other CAM programs.
- Squareness-robust "diagonal flip" mirroring and splitting large inlays.
- Stepped (push-through) flat inserts and tapered straight inlays.
- Sensitivity analysis in the fit check (bit angle error, Z-zero error, runout).
