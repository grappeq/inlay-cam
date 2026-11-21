# Roadmap

What is still to do, in one place. An item leaves this list when it is done; what was done,
and why it was done that way, is in [design/plan.md](design/plan.md).

Within a section the order is the order to take things in, where there is one.

## Joining with the tooling library

The app has taken over the work of the tooling library, a separate Python program, which
is retired. Four of five phases are done: one tool model, the feeds model with the tool
sheet, the libraries for other programs, and a server, `inlay-server`, which is in use in
the workbench's place ([server.md](server.md)).

**To check with the real programs**

- Import the libraries the app writes into Makera CAM, Makera Studio and Fusion 360. They
  match the tooling library's output byte for byte for a made-up list, but have not been
  opened in the programs themselves.
- Run a real, full-size tool list through the list, the sheet and the writers. Everything
  so far was checked with made-up lists of about ten tools.

**Phase 5: what only the joined app can do**

- Log a run from a project's files: which cutting rows ran, and for how long.
- Hours in cut per row, and wear from simulated time.
- A calibration coupon per bit and material: one shape cut at several allowances, with
  the results kept.
- A starter set of tools, so that a new user does not begin with an empty list. The list
  is made: `crates/inlay-core/src/starter.rs` gives the 50 bits of Makera's that the
  tooling library holds, the ones the Makera apps have built in, with the sizes, lengths,
  coatings and flute counts checked there; the seven materials beside the two woods; and
  two profiles, Clearing and Facing. The cutting rows are Makera's presets wherever
  Makera has one. It is offered in the app: "Add the starter set", on the empty Tools tab
  and under "Import and export", adds the tools the list does not have and changes none
  that it has. Still to do: a way to pick which of the 50 to take, by group, in place of
  all of them.
- Makera's presets are not sized for a full-width slot on a Carvera Air, which the app
  takes a plain row to be safe for. The feeds model has no warning for any wood row of
  the set, and one for 19 of its 246 rows, all in aluminium, brass or copper on the
  small end mills and engravers: the chip is over what the model allows. To decide:
  whether a starter row says it is Makera's and untested here.
- No tool of the set has a row on Clearing or Facing: Makera has one preset for each
  tool and material. So the two profiles are not added with the set, and a bit of the
  set starts every operation on its plain row. To decide: whether
  those rows come from the feeds model, which would in places be slower than Makera's
  plain row.
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

## Agents in the open page

An agent can drive the page open in a browser through `inlay-cam-mcp`
([mcp/README.md](../mcp/README.md)); the commands are `web/src/agent/commands.ts`. It was
checked against a page on this computer. Still to do:

- Check it from the hosted page in Chrome, Edge and Firefox, where the browser asks
  whether the site may reach this computer.
- A release tag, so that the install line can name a version.
- Changes to steps are not in the undo history, which is the drawing's. To decide: one
  history for both.
- The tool list is read only. Logging a cut and changing a row from the page, with the
  care the server's API takes.
- A picture of a part in 3D, and of the fit. The pictures are from above.
- A list of the commands in the server for the first start, before any page has connected.

## Operations and cutting settings

- **Which profile a bit starts on is read from the profile's name.** A bit chosen for an
  operation starts on the first profile whose key or name has a word for that operation
  (`USE_WORDS` in `model.ts`), where the bit has such a row. To decide: a setting on the
  profile, "starts in", in place of the words, which a name in another language misses.
  Nothing moves a bit that was chosen before, and the core does not do this: a project
  written by hand or by an agent says its `rowProfiles` itself.
- **The card of a bit, to try with real tools.** Its profile buttons were looked at with
  made-up profiles only: the lists the app was tried with have no row on a profile.
- **Numbers a step changes**, what is left: the cut that frees a plug cannot be changed,
  it runs the plain row as it is; an inlay's pocket and plug take the same changes,
  though they may be in two woods; changes for a bit taken out of a step stay in the
  file; a changed number is checked against the machine's top speed and the bit's width
  and not by the feeds model, which a tool's sheet asks about its rows.
- **Chamfers in passes, to try.** A chamfer's passes are planned against the row's
  groove, and wide bevels are cut in layers; this was checked in the core's section and
  simulation and in rendered drawings, not yet in the running app or on the machine.
  To watch for: a layered bevel's time, and how a corner-rounding bit's shallower last
  passes cut.
- **Joining larger gaps on import.** Line ends are joined into closed outlines when they
  meet within 0.01 mm. When outlines were left out, offer to join larger gaps, in place
  of a setting for the distance.
- **Numbers still kept in two places**, and those left fixed for now with the reason for
  each, are listed in [design/fixed-numbers.md](design/fixed-numbers.md).

## The stock, step by step

The list of inlays and operations is the order the stock goes through, with glue-ups as
steps done by hand. The lines between two of them are one file, and the stock can be
looked at in 3D after each line. What that makes possible, and is not built:

- **Sawing as the machine would see it.** What the saw leaves is one typed height, level;
  a hand saw leaves neither.

## The screens

- **Text that explains how things work, on the Tools tab.** The Design tab and the
  Settings are done; the Tools tab is put off. Its tool sheet has not been gone through:
  cut what repeats or points at the screen, and move what explains to a "?" (`help.tsx`,
  `HelpTip`) only where the label does not already say it. What stepover means on a
  V-bit belongs there, with a picture. The rule to keep: a line that is always on screen
  reports something, and never explains.
- **A design pass over the Design tab**, which has not had what the Tools and Settings
  tabs got. Known from testing: at 800 px wide the drawing is small beside the panel.
- **Whether "Cancel" on a tool's sheet should ask** before it drops changes. It does not.
- **Undo after deleting a shape that an inlay used**, with the inlay changed since: the
  code keeps the inlay's present settings, but this has not been tried in the app.

## Documentation

- The README's screenshots are taken by a script that drives a browser, which is not in
  the repository, and so is their drawing. To decide: keep both here, so that the
  pictures can be taken again when the screens change.
- [design/plan.md](design/plan.md) has the later work of 2026-11-18 from the commits
  alone, without the reasons, for all but the stock's material and the bits' cards.

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
- More drawing in the app. Rectangles, ellipses and polygons can be drawn, and
  are kept as plain outlines. Not built: a pen for free outlines with curves, editing the
  points of an outline, and joining, subtracting and intersecting shapes, for which the
  core's `geom/boolean.rs` is there. Also to decide then: whether a drawn shape keeps
  what it was drawn as, so that a circle's radius or a rectangle's corners can be changed
  later, which needs a new version of the project file.
- Layers, further. Built: the list, colours, moving shapes between layers, and the
  layers of DXF and Inkscape files. Not built: a shape that comes between another and its
  hole lies on top instead of taking the hole over (also when drawn or dragged); layers
  from the top-level groups of Illustrator and other SVGs; a DXF layer's own colour; an
  inlay or operation that follows a layer, so that shapes added to it later are cut too.
- Text (fonts to outlines).
- Snapping and aligning one shape to another. A drawn shape is placed by eye or by typed
  position, like a second drawing.
- Sequenced work in several colours. An inlay into an inlay can be put in order and
  looked at: pocket, glue-up, trim, then the second pocket into the plug. A cut takes
  the stock's material, a plug its inlay's wood and a trim the wood of the plug it trims.
  Not built: a pocket or contour cut into a glued-in plug still takes the stock's
  material, and boundaries shared by two inlay woods.
