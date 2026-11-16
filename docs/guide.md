# Using the app

The app turns shapes from drawings into G-code for a Carvera Air running the Carvera
Community Firmware. For each inlay it writes two files: one cuts the pocket into the stock,
the other cuts the piece that fills it. It simulates both files and reports how the two
parts will fit. It also cuts plain pockets, contours and chamfers into the stock, and faces
it.

**Check every file before you run it.** The app is new: its G-code has been run on a real
machine only as an air cut, and no inlay has been cut with it yet. Look at the simulation,
read the file, and run it above the board first. You use the app and its files at your own
risk; see [Before you cut](#6-cut).

Everything runs in the browser. Projects and tools are stored in that browser only; use
"Save to file" to keep a copy or move a project to another computer.

## 1. List your tools

The header has three tabs. **Design** is the project you are working on. **Tools** holds
your tools with the materials and profiles they refer to, and **Machine** your machine and
what a new inlay starts with. What is under Tools and Machine is kept in this browser and
used by every project.

### The list

Under **Tools** your tools are listed on the left, in their groups, and the one you pick
is shown on the right.

- **Find a tool** takes any words from a tool's name, size, group, coating or kind:
  `1/8 2f`, `60 v`, `upcut`. Every word must match.
- **Needs attention** shows only the tools with something to look at: a cutting row whose
  latest result is a failure or still to confirm, something noted as still to check, no
  cutting settings at all, or no known flute length. A mark after a tool's name counts
  them, in red when a row failed. A failed row stops counting when a later cut at the
  same numbers is logged as ok, or when its numbers are changed.
- The chips narrow the list to kinds of tool, and the choice beside them to tools with
  cutting settings for one material.
- A group's heading folds it away. "in use" marks the tools the open project cuts with.

**Add a tool** offers an end mill, a V-bit and a corner-rounding bit, which the app cuts
with, and a ball end mill, a drill and a thread mill, which it keeps and writes for other
programs and cuts nothing with.

**Import and export**, at the top right, brings in and saves whole tool lists. A tool file
is this app's own: everything under Tools, to keep or to move to another browser. A
`tools.yaml` is the tooling library's list; its layout, and what is and is not kept, is in
[formats.md](formats.md#toolsyaml). Either can also be dropped onto the window. An
imported tool with the name of one you have replaces it.

### A tool's sheet

Picking a tool shows it drawn to scale from the side, with what is known about it. A
length that is not known is drawn dashed, at a guess.

**Cutting settings** has one line per row: what it is for, its speed, feed, plunge,
stepover and depth, and **How hard** it cuts: a small scale of the feeds model's five
stops, from Gentle to Aggressive, with a mark where the row sits by how much it removes.
The taller tick is Slot-safe, the reviewed stop. Clicking a line opens it:

- what its numbers come to: the chip per tooth with the band it should stay in, the speed
  at the edge, and the power a full-width cut would take, with a warning when the chip is
  thin enough to rub or the power is over what the spindle gives. A "!" on the line says
  there is such a warning;
- its **field log**: the latest result and the entries behind it. A result counts only for
  the numbers it was cut at: change the row and it is untested again;
- **Log a result…**, for after a cut: ok, worked but still to confirm, or failed, with a
  line on what happened. It is recorded at the numbers the row has at that moment, and
  kept at once;
- **What the feeds model would start from**: the five stops, and "Use these values" to
  copy one into the row. They are rough starting points for a dry Carvera Air with a
  spindle of about 200 W, where any cut may be a full slot. The model knows nothing of
  your coating, workholding or coolant, and several stops are marked untested: read the
  notes under them.

Under **Stock and source**, "A cutter broke or wore out…" notes the loss and takes one off
the count on hand.

### Editing a tool

**Edit** turns the sheet into a form; nothing is kept until you press "Save tool".

- A **corner-rounding bit** (fillet bit) rounds an edge over. It is used by the chamfer
  operation only. Give the radius it cuts and the diameter across its tip, below the
  rounded edge.
- **Flute length** is the deepest the tool can cut. The app refuses a cut deeper than
  that. Leave it empty if unknown and the app warns instead.
- **Tip flat diameter** of a V-bit: measure it. A bit sold as pointed often has a flat of
  0.1 mm or more, and the app's geometry depends on it.
- **Cutting settings** are per material. A tool cannot be used on a material it has no
  settings for. Each material has one *plain* row, safe for any cut, and can have further
  rows made for one kind of toolpath, such as a finishing pass ("For").
- A **stepover** can be given in mm or in percent of the diameter. A V-bit's spaces its
  passes over a flat floor, where only the tip cuts; the app caps it so that ridges stay
  under 0.1 mm.

Tools are shared by all projects. A project keeps its own copy of the tools it uses, so it
opens correctly elsewhere; the copy leaves out your stock, prices, sources and logs.

### Your materials

**Materials**, beside the tools, lists what you cut. Hardwood and softwood are always there. Add a
material by name, such as oak or acrylic, then give your tools cutting settings for it. A
material can be renamed at any time, and deleted once no cutting settings, tool or part
of the open project uses it. Materials that came with an imported tool list are here too.
For a material of your own, "Suggested feeds as" says which known material it cuts like,
so that the tool sheet can suggest starting values for it.

The app's toolpaths have only been proven in wood. A part in any other material builds
with a warning that says so: check its simulation with care and cut a test piece first.

### Your profiles

A profile names one kind of toolpath, such as a finishing pass or a slot, so that a tool
can keep a further cutting row tuned for it beside its plain one. You need none to cut.
**Profiles**, beside the tools, adds, renames and deletes them; deleting one also deletes its rows
from your tools, after asking. The ticks on a profile and its starting stop only say where
the suggested values on a tool's sheet begin for its rows.

A profile ticked **Adaptive clearing** is for other CAM programs: this app has no such
toolpath and does not cut with its rows.

### Your machine

The **Machine** page holds the limits every file is checked against. They start as those
of the Carvera Air; "Fill in for" sets them for the Carvera.

- **Travel in X and Y**: a file whose moves span more is refused.
- **Top spindle speed**: a tool set to run faster is refused.
- **Rapid speed** is only used for the time estimates.
- **First tool number**: the tools of a file are numbered from here, in the order they are
  used. On a Carvera with a tool rack, T1 to T6 are the rack's slots and are loaded
  automatically, whatever is in them; start at 7 to be asked for each tool by hand.

The files are always written for the Carvera Community Firmware, whatever is set here.

### Defaults for new inlays

The **New inlays** page holds the clearances and tabs a new inlay starts with: travel
height, plunge height, the tabs, and how parts are cut out. They are described under
"Clearances and tabs" below. Each inlay keeps its own copy, so changing a default does not
alter inlays you have already made.

## 2. Bring in a drawing

Use **Import drawing** or drop the files on the window. The app reads SVG and DXF, and
takes several files at once.

- Shapes must be filled, or drawn as lines that join into closed outlines. Lines are
  joined where their ends meet within 0.01 mm.
- In a drawing made of outlines only, as CAD programs export, the shapes are the areas
  between the lines. A circle drawn around six shapes is the web between them.
- Text must be converted to outlines first. Images are ignored.
- After the import the app lists what it left out.

### The stock

The stock is the board the pockets and the other operations are cut into. Its bottom-left
corner is the work origin, with Z0 on its top face. The first drawing sets its size: the
drawing's page, or for a DXF file, which has no page, the shapes' extent plus 5 mm on every
side.

Under **Stock and drawings** you set the stock's width, height and thickness, and the
colour of its wood. Changing the size leaves the shapes where they are and as large as they
are; the app says so when shapes end up outside the stock. "Fit the stock to the shapes",
under "More", makes it the shapes' extent plus 5 mm.

The stock applies to this board only. A plug or an insert is cut from a board of its own,
whose size follows from the shapes and the inlay's settings.

**Add drawing**, in the bar above the drawing, puts the shapes of further files on the
same stock; so does dropping files on the window. The shapes come in at their own size, in
the middle of the stock, selected and with arranging switched on: drag them to their
place. The stock grows when they do not fit. "Replace the drawing",
under "More", starts over with one file; what was made from the old drawing is removed.

"Start with an empty stock", on the start screen, gives a stock of 200 x 150 mm without a
drawing, to face it or to add drawings to.

If a DXF or an Illustrator SVG comes in at the wrong size, the file's unit was not what
the app took it for: switch to "Arrange", select its shapes and type the right width.

### Arranging the drawing

A drawing often holds several parts, or parts you do not want. The bar above the drawing
switches between two things a click on the drawing can do: **Pick shapes**, for making
inlays and operations, and **Arrange**, for changing the drawing itself.

While arranging, a toolbar above the drawing holds what can be done to the selected
shapes, as buttons with a symbol each (point at one to read what it does) and, under them,
the selection's position and size as numbers. The panel at the side shows what is
selected, the stock's size and the keys. "Pick shapes", or "Done arranging" in the panel,
goes back.

The app treats the drawing as outlines here: an outline takes along everything inside it, the hole it makes in the
shape around it moves with it, and the hole closes when the outline is deleted.

Selecting:

- Click a part to select it. A part is an outer outline with everything inside it. Untick
  "Select whole parts" to pick an outline inside a part, such as a hole or a letter.
- Shift-click adds to the selection or takes away from it. Drag across empty board to
  select what the box encloses. Click empty board, or press Escape, to clear it.
- The size and position of the selection are shown under the drawing, and in the fields
  X, Y, W and H of the toolbar. X and Y are the distances of its bottom-left corner from
  the stock's.

Changing the selection:

- Drag it; hold Shift to keep the move straight. The arrow keys move it by 1 mm, or by
  0.1 mm with Shift. Or type X and Y.
- Drag the squares on its frame to resize it. A corner keeps the proportions, unless
  Shift is held; a side stretches it one way. The opposite corner or side stays where it
  is; with Ctrl held, the middle does.
- Type W or H, or a percentage under "Scale to". "Keep proportions" decides whether the
  other size follows. The small grid of five squares beside it chooses which point of the
  selection stays where it is: a corner, or the middle.
- Turn it by 90° either way or by any angle, or mirror it.
- Centre it on the stock, across or up and down.
- Copy it (Ctrl+D): the copy lands to its right.
- "Keep only" deletes every other shape and fits the stock to what is left: the way to
  put one part of a sketch on a stock of its own.
- Delete it (Delete key). An inlay that loses all its shapes is removed; the app asks
  first.

Typed numbers apply when you press Enter or leave the field. Ctrl+Z undoes and Ctrl+Y
redoes, up to 50 steps, also after arranging.

The board and the view:

- The work origin stays at the board's bottom-left corner, so shapes stop at its left and
  bottom edges. The board grows when shapes are moved past its right or top edge. "Fit
  board to shapes" makes it the shapes' extent plus a margin.
- The mouse wheel zooms, also outside arranging. Drag with the middle button to move the
  view; double-click empty board, or press "Whole board", to see all of it.

Shapes keep their inlays when they are moved, resized or turned. A shape dropped wholly
inside another becomes a hole in it, as if it had been drawn there. Shapes that lie
partly on top of each other are outlined in red and listed; move them apart before making
inlays from them. There is no snapping or aligning of one part to another.

## 3. Make an inlay

Click the shapes that will be cut from one wood, then choose the kind of inlay. Each
inlay is edited in its own panel; "All inlays and operations" takes you back.

Under "Material and tools", **Material** picks which of each tool's cutting settings are
used. When a chosen tool has rows for a kind of toolpath in that material, a **Cutting
row** list appears under it: the plain row, or one of those. The numbers of the row are
shown below the list, and the generated file's notes say which row each tool ran. Leave
it on the plain row unless you know the other suits the cut: the app does not check a row
against the kind of cut, except that it refuses rows for adaptive clearing, which it has
no toolpath for. Cutting a plug or insert out of its board always uses the plain row.

There too, an inlay has a **colour** for its wood: one of the woods offered, or
any other colour. The drawing shows each inlay in its colour on the colour of the stock, so
it previews the finished piece; the 3D view of the plug and the fit view use the same
colours. Colours change nothing in the files.

### V-carve inlay

The pocket and the plug both have sloped walls cut with a V-bit, so corners stay sharp.
The plug is glued in face down and its backer is sawn off.

- **Engagement**: how deep the plug goes into the pocket.
- **Glue gap**: space left under the plug.
- **Saw gap**: space between the board's surface and the plug's backer, for the saw.
- **End mills for the flat floor**: optional. They clear the flat floor before the V-bit,
  which is much quicker than the V-bit alone.

Parts of the design too narrow for the plug to reach the engagement depth are marked red
on the drawing after generating.

**Relieve the plug's narrow ridges and corner edges** is ticked for a new inlay. Where a
shape is narrower than the V-bit is wide at the engagement depth, the plug has a ridge that
comes to a point and fills the pocket's groove to the bottom. The same happens along the
edge that runs into every corner. There is no room for glue under such a point, and a bit
with a tip flat cuts the groove a little shallower than the point is high, so the point
holds the whole plug up. With relief, the plug file ends with the V-bit running along
those ridges and cutting their points back by the glue gap, plus what the tip flat costs.
The cut is hidden inside the joint: it stays 0.5 mm below the finished face, so very
shallow parts, right at the outline, are not relieved. The plug file says how much was cut
back.

### Flat inlay

Upright walls cut with an end mill. Corners are rounded to the radius of the smallest end
mill chosen; the outline that will really be cut is drawn dashed after generating.

- **Pocket depth** and **fit allowance**. The allowance is the gap all round: half comes
  off the insert and half is added to the pocket.
- The insert can be made two ways, under "Insert":
  - **Loose pieces**: each shape is cut right through its board as its own piece, the same
    way up as it goes in. A board thicker than the pocket is deep leaves the insert proud,
    to sand flush.
  - **One plug**: the shapes stay together on a shared backer, mirrored. Glue it in face
    down, then saw or plane the backer off. This keeps many small shapes in their places.

### Several end mills

Add more than one end mill and they are used in the order listed; drag one by its grip to
change the order. Each cuts only what the
ones before it left, so put the largest first; the app says so when the order wastes a
tool. A tool that fits nowhere, or has nothing left to cut, is left out of the file.

### Cutting the plug out

A V-carve plug, or a flat inlay's plug, is carved into a blank the size of the shapes plus
the margin. Under "Plug blank and cut-out" you can instead have the file cut the plug out
of a larger board as its last step, as one piece, with or without tabs. The file then says
how large the board must be.

- With tabs, the plug stays attached until you cut the tabs.
- Without tabs it comes loose on the last pass: hold it down with tape.
- Either way the cut goes 0.2 mm past the bottom of the board. Put a spoilboard under it.
- The end mills clear the floor out over the plug's edge, into the border, which is waste.
  So a margin narrower than an end mill is still cleared by it and not left to a smaller
  tool or the V-bit, and no thin wall of wood is left standing along the edge. The board
  the file asks for allows for this.
- **End mill for the cut-out**: left alone, the largest of the inlay's end mills that
  reaches through the board does it. Choose another to cut the plug out with a tool the
  inlay does not otherwise use, such as a longer one. The app shows how deep the cut is
  beside the tool's flute length, and refuses the file when the flutes are too short.

### Clearances and tabs

"Clearances and tabs", at the bottom of an inlay's panel, holds how that inlay's two files
are cut. A new inlay starts with your defaults from the **Machine** tab; "Back to your
defaults" returns to them. The app's own values are in brackets.

- **Travel height** (5 mm): how high above the board the tool moves between cuts. Raise it
  to clear clamps.
- **Plunge from** (1 mm): the tool drops fast to this height above wood already cut, then
  goes down at the plunge feed.
- **Tab width** (4 mm), **spacing** (40 mm) and **thickness** (1 mm). An outline gets a
  tab about every spacing, and at least three, where it is long enough. A tab is never
  thicker than half the board.
- **Cut past the bottom** (0.2 mm): how far into the spoilboard a part is cut out.
- **Board around a cut-out plug** (5 mm): what is left of the board on every side, beyond
  the cut.
- **Ramp angle** (5°): an end mill does not plunge into wood. It goes down along the path
  it is about to cut, at this slope, and back and forth where the path is too short. Set 0
  to plunge straight down. V-bits and corner-rounding bits are not affected: they plunge,
  or start in the air.
- **Left for a finishing pass** (0.1 mm): end mills clear a flat pocket, and cut an insert
  or a contour out, this far short of the walls. The smallest end mill then goes once
  along every wall at full depth and takes the rest off, so that the walls are cut in one
  light pass by one tool and show no step where two tools met. Set 0 for none. A V-carve
  inlay's walls are cut by the V-bit, so it has no such pass.

## 4. Other operations on the stock

Pockets, contours, chamfers and facing are made like inlays: click shapes, then choose the
operation. They are listed with the inlays, and each has a panel and a file of its own.

A shape is one wood, so it belongs to one inlay at most. Operations are not bound by that:
they use any shapes, also those of an inlay or of another operation. Clicking a shape that
has an inlay opens the inlay; Shift-click selects it instead. With an operation open, any
click adds a shape to it or takes it away.

- **Pocket**: clears the shapes to a flat floor, at the depth given, with one end mill or
  several in order. Inside corners are rounded to the smallest; what is really cut is drawn
  dashed after generating. "The tool's path" chooses between rings that follow the outline
  (the usual way) and straight passes side to side, which end with a pass round the walls
  at each depth.
- **Contour**: takes an end mill along the outlines. *Outside the shapes* keeps the shapes:
  the tool runs round them, and inside their holes. To cut round the outside of a part
  only, add everything inside it to the operation too. *Inside the shapes* cuts them away,
  leaving an opening of their size. *On the line* puts the tool's centre on the outline.
  The cut goes to a depth, or right through the stock and a little into the spoilboard,
  with or without tabs.
- **Chamfer**: shapes the top edge along the outlines. With a V-bit the edge is bevelled
  to the width given. With a corner-rounding (fillet) bit it is rounded over to the bit's
  own radius, and there is no width to give. Choose the side where the wood has been cut
  away: round the shapes, or inside them. Run it after that edge has been cut. The bit's
  tip runs beside the edge, where it expects air; in uncut wood it would leave a groove.
- **Facing**: mills an area flat with an end mill. Without shapes that is the whole stock,
  and the tool runs out over every edge. With shapes it is the rectangle around them plus
  a margin. Give a *depth below the surface* to flatten the stock, and the *wood above the
  surface* to remove what stands on it. The tool goes side to side in straight passes
  along the longer side of the area; "The tool's path" can make it go in rings instead.

### Trimming a plug flush

Facing over the shapes of an inlay removes its plug's backer after the glue-up. The panel
says how far that plug stands above the surface and offers to fill in the fields: that
height above, 0 below, and the plug's own margin, so that the area is the plug's blank.
The file starts cutting at that height and travels above it. Z0 is still the stock's
surface, so set it beside the plug, not on it. The 3D view shows the stock only, not the
wood standing on it.

### One file for the stock

The list of inlays and operations has a grip and a tick box on every line. Drag a line by
its grip to put the list in the order to cut in (or select the grip and press the up or
down arrow), tick what one file should cut, and press **Generate one file**.
The file cuts each ticked inlay's pocket and each ticked operation, in the order of the
list. Tools keep one number each through the file, and a tool that the next line also
starts with stays in the spindle. The file is simulated as a whole and shown in 3D.

An inlay's plug or insert always has its own file: it is cut from another board.

## 5. Generate and check

**Generate files** makes both files of an inlay, or the one file of an operation, and
checks them. For each file the panel shows:

- whether the simulation found a problem (a rapid move through wood, a cut below the
  board, a cut deeper than the tool's flutes). Do not run a file that has one;
- the size of board it needs, the time per tool and the number of tool changes;
- things to know before cutting, such as clamps to keep clear.

**Show in 3D** shows the simulated part. The simulation is run on the text of the G-code
file itself, so what you see is what the file does. Curves are written as arcs (G2 and
G3), which keeps the files short.

Tick **Show dimensions**, above the 3D view, to measure the part. All numbers are in mm.

- The board's size in X and Y and its thickness are drawn along its edges.
- Arrows mark the work origin and the directions of X, Y and Z, as the machine must be
  zeroed.
- On the surface: the extent of the shapes and what is left around them. On a plug that is
  its margin; on the base board, the distance to each edge.
- A plug cut out of a larger board also shows its own size, the border of board left
  around it and the width of the cut that frees it.
- Point at the board to read the position under the cursor and the depth of the simulated
  surface there.

Tick **Show tool path**, above the 3D view, to see where the tool goes:

- Each tool's cutting moves have their own colour; moves in the air are red and can be
  switched off.
- "Hide the board" leaves only the path, so that the passes inside the wood can be seen.
- The "Path shown" slider draws the path up to any point of the file. A cone marks where
  the tool is, and the line of the file and the tool are named beside the slider. With
  the slider selected, the arrow keys step one move at a time.

### Fit

For a V-carve inlay the app turns the simulated plug over, lowers it into the simulated
pocket and reports where it rests, how much of the wall touches, the glue gap and any gaps
in the finished face. **Show fit** opens a map; click anywhere to see a cross-section and
the exact heights there.

For a flat inlay the fit is worked out from the outlines: the gap at the wall and how far
the insert stands above the surface.

The fit check works on a grid of 0.05 to 0.2 mm, coarser for larger boards. Differences
smaller than a cell are noise. A plug that "seats once pressed" is held off by a little
wood in sharp corners, which a V-bit with a tip flat always leaves: the pocket's corner
is rounded to the flat's radius and the plug's is not. The sharper the bit and the larger
its flat, the more: a 0.2 mm flat on a 30° bit can hold a plug up by 0.37 mm. Clamp the
plug down firmly, or use a bit with a smaller flat.

## 6. Cut

Download each file and run it on its own board.

- Set the work origin at the board's bottom-left corner, Z0 on its top face.
- Tool numbers in the file start at T1, or at the first tool number set for your machine,
  in the order the tools are used. The firmware asks for each tool in turn.
- The pocket file, the files of the other operations and the one file for the stock are
  for the stock. The plug or insert file is for its own board, of the size the app gives.

Before the first real cut, run `machine-tests/m0-air-cut.cnc` as an air cut. It confirms
that the machine reads this app's G-code as intended.

The simulation checks the file against the board and the tools you described, not against
your machine as it stands. It cannot see clamps, a wrong work origin, a tool that differs
from its entry in the tool list, or a board of another size. Run a new file once with Z0
set well above the board, keep a hand near the stop button, and wear eye protection. The
app comes with no warranty: what a file does on your machine is your responsibility.

## What the app does not do

- It does not read DXF blocks or binary DXF, or text that is not outlines.
- It does not write a curve that changes height, such as a ramp along an arc, as an arc:
  only level curves are.
- It checks every cut against the length of the tool's cutting edges, so nothing above
  them ever goes below the board's surface. It does not check the tool holder against
  clamps, or the machine's Z travel.
- It does not pack inserts to save wood.
- It does not simulate wood standing above the stock's surface, such as a glued-in plug.
- It does not snap or align shapes, so a second drawing is placed by eye or by typed
  position.
