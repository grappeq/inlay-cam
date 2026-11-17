# Roadmap

What is still to do, in one place. An item leaves this list when it is done; what was done,
and why it was done that way, is in [design/plan.md](design/plan.md).

Within a section the order is the order to take things in, where there is one.

## Joining with the tooling library

The app is taking over the work of the tooling library, a separate Python program. Three
of five phases are done: one tool model, the feeds model with the tool sheet, and the
libraries for other programs.

**To check with the real programs**

- Import the libraries the app writes into Makera CAM, Makera Studio and Fusion 360. They
  match the tooling library's output byte for byte for a made-up list, but have not been
  opened in the programs themselves.
- Run a real, full-size tool list through the list, the sheet and the writers. Everything
  so far was checked with made-up lists of about ten tools.

**Phase 4: a server**

- The same build served with one shared tool file, so that the list is no longer kept in
  one browser.
- An HTTP API for agents, with writes checked by a token, and backups.
- Then the Python repository is archived.

**Phase 5: what only the joined app can do**

- Log a run from a project's files: which cutting rows ran, and for how long.
- Hours in cut per row, and wear from simulated time.
- A calibration coupon per bit and material: one shape cut at several allowances, with
  the results kept.
- A starter set of tools, so that a new user does not begin with an empty list. The list
  is made: `crates/inlay-core/src/starter.rs` holds nine tools of Makera's Essential
  Milling Bit Set, the ones this app cuts with, and two profiles, Clearing and Facing.
  Their cutting rows for hardwood and softwood are what the feeds model suggests. Still
  to do: offer it in the app. To decide: whether an empty list is filled by itself or on
  a click, and how the set merges with tools already there.
- To check on the bits themselves: overall lengths, and the chamfer bit's diameter and
  tip, which Makera's listing does not give. Each is marked on its tool as to be checked.
- The set's engraving bits are as wide as their shank, 3.175 mm, so the 60° one reaches
  about 2.6 mm deep: less than a new V-carve inlay's 3 mm engagement plus glue gap. To
  decide: a wider V-bit in the set, or a shallower engagement for a new inlay.

**Left over from the phases that are done**

- Suggestions while reading a tool's sheet. They show only while it is edited.
- A check, while a name is typed by hand, for letters Makera CAM cannot read. Only the
  suggested name is checked.
- Makera CAM's material thumbnails. A tool list holds none, so materials are written
  without them.
- The Fusion 360 libraries by group as one `.zip`. They are saved as separate files.
- File names for those libraries with look-alike letters folded, as Unicode's NFKC does.
- A `.tlslibrary` dropped on the window. It can only be picked from the menu.
- A warning when a corner-rounding bit's radius is not what its body and tip diameters
  give, since a `tools.yaml` keeps the diameters only.

## Operations and cutting settings

- **Profiles that come with the app**, each the default for the operations it suits. The
  two are chosen, in `starter.rs`: Clearing for pockets and floors, Facing for facing;
  contours and cut-outs keep the plain row, which is safe for a full-width cut. Still to
  do: a new operation starts on its profile's row where the tool has one.
- **A profile chosen for each of an operation's bits.** Today a bit's row can be picked
  only where the bit already has rows on profiles for the material (`RowPicker`, kept in
  a job's `rowProfiles`). This is to be a plain choice for every bit of every operation.
- **Cutting settings shown in the operation**: the numbers it will run with, able to be
  overridden there for that operation alone.
- **Joining larger gaps on import.** Line ends are joined into closed outlines when they
  meet within 0.01 mm. When outlines were left out, offer to join larger gaps, in place
  of a setting for the distance.
- **Numbers still kept in two places**, and those left fixed for now with the reason for
  each, are listed in [design/fixed-numbers.md](design/fixed-numbers.md).

## The screens

- **Text that explains how things work.** Go through the app, find the blocks of it, and
  get rid of them: by a screen that needs no explaining, or by one shared way of showing
  help on demand. A tooltip with a small picture of the thing (what "plunge from" is,
  what a tab is, what stepover means on a V-bit) would say more than bare text. The
  Settings pages keep one line per setting and put the rest in the `title` of a column
  heading, which is a stopgap. Facing and chamfer already show their options as pictures.
  A chamfer's numbers are a case for it. Its width, the tip's clearance, the bit's tip
  flat and its angle give how far outside the outline the bit runs and how deep, and the
  panel says so in a sentence that is hard to follow. A picture of the bit against the
  edge in section, with those numbers marked on it, would show it: the bevel's width and
  height, the gap between the tip and the wall, and the room the bit needs beside the
  edge.
- **A design pass over the Design tab**, which has not had what the Tools and Settings
  tabs got. Known from testing: at 800 px wide the drawing is small beside the panel.
- **Whether "Cancel" on a tool's sheet should ask** before it drops changes. It does not.
- **Undo after deleting a shape that an inlay used**, with the inlay changed since: the
  code keeps the inlay's present settings, but this has not been tried in the app.

## Documentation

- Clean up the docs, and add screenshots to the README.

## Toolpaths and checks

Recorded as limits when version 1 was finished, and not looked at again since.

- Holder collisions and Z travel are not checked: a tool's stick-out is not known.
- Inserts are not packed to save wood.
- DXF blocks and binary DXF are not read.
- The simulation uses one grid of about 2 million cells. Tiles, and a finer pass over a
  chosen region, were planned and not built.
- Tapered ball-nose bits for deep, steep-walled V inlays.

## Further out

From the original requirements' list of what version 1 would not do.

- Uploading jobs to the machine over WiFi or USB.
- Output for other controllers: GRBL, LinuxCNC, Mach.
- A Carvera's tool rack: tool numbers T1 to T6 mapped to its slots. Today the first tool
  number can be set, and that is all.
- Drawing in the app, and text (fonts to outlines).
- Sequenced work in several colours: an inlay into an inlay, flattening again between
  colours, boundaries shared by two inlay woods.
