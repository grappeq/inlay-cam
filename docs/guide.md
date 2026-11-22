# Using the app

The app turns shapes from drawings into G-code for a Carvera Air running the Carvera
Community Firmware. For each inlay it writes two files: one cuts the pocket into the stock,
the other cuts the piece that fills it. It simulates both files and reports how the two
parts will fit. It also cuts plain pockets, contours and chamfers into the stock, and faces
it.

**Check every file before you run it.** The app is experimental: a few jobs have been
machined with it on a Carvera Air, with success, and that is all. Look at the simulation,
read the file, and run it above the board first. You use the app and its files at your own
risk; see [Before you cut](#6-cut).

Everything runs in the browser. Projects and tools are stored in that browser only; use
"Save to file" to keep a copy or move a project to another computer. When the app is opened
from a server set up to hold them (the README's "With a server"), everything is kept there
instead, projects included, and every browser that opens it sees the same; where this
guide says "in this browser", read "on the server". The header says which it is: "Saved in
this browser" or "Saved on this server". When the server cannot be reached the header says
"Server out of reach: changes wait here", and they are saved when it answers. If a project
was saved from another window or browser while you changed it here, the app stops saving it
and asks: keep both (yours becomes a copy under Projects), use the other, or keep yours.

## Your projects

The **Projects** tab lists every project kept, with its folders on the left.

- **Folders.** "+ New folder" makes one; a folder's "⋯" renames it, makes a folder inside
  it (up to four deep), moves it into another or deletes it. Deleting a folder deletes no
  project: the ones in it go to **Unfiled**.
- **All projects** shows every project, **Unfiled** the ones in no folder, and a folder
  its own and those of the folders in it, each with where it is.
- **A project's row** opens it. Its "⋯" renames, duplicates, moves it to a folder, saves
  it to a file or deletes it. The open project is not deleted from here.
- **Several at once.** Tick projects to move them, save them (as one `.zip` of project
  files) or delete them together. Rows can be dragged onto a folder.
- **New project** starts one in the folder shown, and **Open file…** opens a project file
  from disk. A project is kept as soon as it has a drawing.
- **Search** finds by name in what is shown; the list is in order of last change or name.

Moving a project to a folder does not change it, nor when it was last changed. The
folder of the open project is shown before its name at the top, and leads to it.

## 1. List your tools

The header has four tabs. **Projects** is the list of what you have made, **Design** the
project you are working on. **Tools** holds
your tools, and **Settings** the materials and profiles they refer to, your machine, and
what a new inlay starts with. What is under Tools and Settings is kept in this browser and
used by every project.

### The list

Under **Tools** your tools are listed on the left and the one you pick is shown on the
right.

- The **filter** box reads sizes however they are typed: `1/8 2f`, `6x18`, `ø6`, `m3`,
  `r1`, `s4` for a 4 mm shank. Words find a tool by its name, group, kind, style, coating,
  the materials it suits, or the shop it came from. Every word must match.
- The chips below narrow the list by **shank**, **flutes** and **style**, and the
  **Material** choice by what a tool is recommended for. A press shows *only* tools with
  that option; a second press *hides* them, and the chip is struck through; a third
  clears it. Within one row "only" options add up; rows combine. "Reset" clears the
  filter box and every chip. The chips are remembered.
- **Sort** orders the list by group (in groups, by size within each), by diameter, by
  flute length or by name. Outside "Group" the list is one run without headings.
- **Needs attention** shows only the tools with something to look at, and lets you pick
  one kind: a cutting row whose latest result is a failure or still to confirm, something
  noted as still to check, no cutting settings at all, or no known flute length. A mark
  after a tool's name counts them, in red when a row failed.
- A group's heading folds it away. "in use" marks the tools the open project cuts with.

**Add a tool** offers an end mill, a V-bit and a corner-rounding bit, which the app cuts
with, and a ball end mill, a drill and a thread mill, which it keeps and writes for other
programs and cuts nothing with.

**Add the starter set**, on an empty list and under "Import and export", or **Use the
starter tools** on the start page while the list is empty, adds 50 bits for a
1/8" collet with cutting settings to start from, and the materials those are for. It adds
only tools the list does not have, and changes none that it has. The settings are a
starting point and untested here: check them before you cut, and delete the bits you do
not own.

**Import and export**, at the foot of the list, brings in and saves whole tool lists. A
tool file is this app's own: your tools, materials and profiles, to keep or to move to
another browser. A `tools.yaml` is the tooling library's list; its layout, and what is and
is not kept, is in [formats.md](formats.md#toolsyaml). Either can also be dropped onto the
window. An imported tool with the name of one you have replaces it.

The same menu writes your tools for other programs. After each, the app says what the
file holds and what to know about it.

- **Export for Makera CAM** and **Export for Makera Studio** write a `.tlslibrary`. In
  the app, select the group the tools should go under and import the file. Both apps add
  what they import as new tools, also when it is there already, so delete the old ones
  first. A tool goes to the apps ticked under its Tool settings, "Goes to". Each app gets
  one setting per material: the plain row, or for want of one the first row on a profile,
  which the export warns about since the app may run it as a full slot. A material only
  goes where it is tied to one of the app's own materials, which it is after a `tools.yaml`
  with those ties was imported; materials added here have none. Makera CAM cannot read a
  file with a byte of value 13 in it: a feed of 13 mm/min is written as 12, with a note,
  and what cannot be moved that way is refused with the reason.
- **Export for Fusion 360** writes a `.json` tool library with every tool, each cutting
  row as a preset. "By group" writes one library per top group, since libraries are the
  only folders Fusion's tool library has, as one `.zip` to unpack: each file is named
  after its group, with look-alike letters such as full-width ones made plain. A length
  that is not known is written as a stand-in (flutes three diameters long, the tool 20 mm
  beyond its shoulder), and said so.
- **Take values from a Makera export…** reads a `.tlslibrary` that Makera CAM or Makera
  Studio exported and shows where its numbers differ from yours: sizes, cutting values,
  and settings for a material a tool has no row for. Tick what to take. Tools are matched
  by their id, else by exact name and group; one matched by name comes unticked. Only
  numbers are taken: no name, group or material changes, and no tool is added. A 0 in
  the export, which the apps use for "unknown", never replaces a value you have. A
  `.tlslibrary` dropped on the window does the same.

### A tool's sheet

Picking a tool shows it drawn to scale, from the side and from its tip, with what is
known about it. A length that is not known is drawn dashed, at a guess. The style word
(Upcut, Downcut, Compression, Straight, Roughing, Corn, PCB) sets how the flutes are
drawn.

**Cutting settings** has one line per row: what it is for, its speed, feed, plunge,
stepover and depth, and **How hard** it cuts: a small scale of the feeds model's five
stops, from gentle to aggressive, with a mark where the row sits. A row is measured by
what it removes per turn of the spindle (feed over speed, times stepover, times depth),
which is what the cutting force follows; a drill by how far it goes down per turn. The
taller tick is the stop the row's suggestions start at: slot-safe, the reviewed stop, for
a plain row. The word beside it says where the mark is: "slot-safe" on a stop, "≈ firm"
near one, "below gentle", "above aggressive". For a tool whose five stops are all the
same cut, as a corner-rounding bit's are (its whole radius deep, at the same capped feed),
it says how far the row is from that cut instead: "8% over every stop". Under the scale, "chip thick", "chip thin"
or "power high" says that the row's own numbers are outside anything the model allows;
hold the pointer over one for the numbers. Clicking a line opens it:

- what its numbers come to: the chip per tooth with the band it should stay in, the speed
  at the edge, and the power a full-width cut would take, with the same warnings in full;
- where the row goes when the list is written for the Makera apps, once your materials
  are tied to theirs (they are after a `tools.yaml` is imported);
- its **field log**: the latest result and the entries behind it. A result counts only for
  the numbers it was cut at: change the row and it is untested again. "Correct" beside an
  entry changes its result, words or date, and gives an entry recorded without numbers the
  row's present ones when you tick that it was cut at them; "Remove" takes it out;
- **Log a result…**, for after a cut: ok, worked but still to confirm, or failed, with a
  line on what happened. It is recorded at the numbers the row has at that moment, and
  kept at once.

A tool's **remarks**, when it has any, are folded under its name: longer notes of any
length, which in a `tools.yaml` are the comment lines above the tool.

Under **Stock and source**, "A cutter broke or wore out…" notes the loss and takes one off
the count on hand; such an entry can be corrected or removed too. **Tool settings**, folded
at the foot, holds the tool's group, kind and number, and which other programs' libraries
it is meant for.

### Editing a tool

**Edit tool** turns the sheet's values into fields where they stand: the name, the facts,
every cell of the cutting rows, the stock and the source. The drawing follows as you type.
A bar at the bottom counts what you have changed; nothing is kept until you press "Save
changes", and "Cancel" puts everything back. Picking another tool with unsaved changes
asks first.

In a cutting row, the two choices at the left say which material the row is for and which
kind of cut ("any cut" is the plain row). The button beside the stepover switches it
between mm and percent of the diameter. The × at the right deletes the row, and "Add a
row" adds one for the next material without settings.

Under the name, **Suggested** offers the standard name for a tool of its kind and sizes
when the name is another: `Ø6×15 2F`, `Ø1 Ball S4 2F`, `90° Chamfer Ø6`, `R1 Corner Round
Ø4`, `M6×1 Thread Mill 19 reach`, with the style word at the end. "Use" takes it. A name
another tool has gets the overall length after it. The coating beside the name offers the
common ones; any other can be typed. "Add something to check" under the remarks notes
what is still to measure or try; it then shows under Needs attention until you press
"Checked" on the sheet.

Under the rows, **Suggestion** shows what the feeds model would start from for the row
you are working on: the one you last clicked into, and to begin with the first plain row
that holds none of the model's suggestions. A row that differs from every suggestion says
"differs" beside its material.

- The slider picks one of the five stops. A row on a profile starts at its profile's
  stop, marked under the slider; a plain row starts where you left the last plain row.
- **Ramped entry** suggests the plunge for a tool that goes down along a ramp.
  **Adaptive** reshapes the suggestion for adaptive clearing: a light sideways cut taken
  deep. It can be looked at for any row, but taken only into a row on a profile, since a
  plain row may be run as a full slot. **Lubricated** changes the answer for titanium and
  aluminium only.
- "This row" and "Suggested" stand one above the other under the columns they belong to,
  with what differs in bold. What the model does not stand behind for the kind of tool (a
  drill's feed, stepover and depth) is in italics, and left as the row has it.
- The line under them says where the numbers come from, and then how the row stands:
  "✓ matches slot-safe · ramped" when it holds a suggestion exactly, whichever stop and
  ways of cutting that is, or else where it sits, as its scale shows it.
- "Use suggestion" copies the suggested values into the row. The stepover stays in the
  unit the row has.

The suggestion shows too while the sheet is only read, for the row whose numbers you
opened; "Use suggestion" there starts editing with the values taken. While a tool goes
to Makera CAM, its name is checked as you type for letters that app cannot read.

Slot-safe is the reviewed stop: values for a dry Carvera Air with a spindle of about
200 W, where any cut may be a full slot. The others are rough starting points or
untested, and say so. The model knows nothing of your coating, workholding or coolant:
read the notes under it.

**Tool settings** has "Delete this tool…"; while editing it also changes the tool's kind.

A number that cannot be used is marked, and says why under its field: the value the
field had is kept, and comes back when you leave it.

- A **corner-rounding bit** (fillet bit) rounds an edge over. It is used by the chamfer
  operation only. Give the radius it cuts and the diameter across its tip, below the
  rounded edge. Its sheet warns when the radius is not half the body less the tip, since
  a `tools.yaml` keeps the two diameters only.
- **Flute length** is the deepest the tool can cut. The app refuses a cut deeper than
  that. Leave it empty if unknown and the app warns instead.
- **Tip flat diameter** of a V-bit: measure it. A bit sold as pointed often has a flat of
  0.1 mm or more, and the app's geometry depends on it.
- **Cutting settings** are per material. A tool cannot be used on a material it has no
  settings for. Each material has one *plain* row, safe for any cut, and can have further
  rows made for one kind of toolpath, such as a finishing pass ("For").
- A V-bit's **stepover** spaces its passes over a flat floor, where only the tip cuts;
  the app caps it so that ridges stay under 0.1 mm.

Tools are shared by all projects. A project keeps its own copy of the tools it uses, so it
opens correctly elsewhere; the copy leaves out your stock, prices, sources and logs.

### Settings

**Settings** lists four pages on the left, each with a line on what it holds now, and
shows the one you pick. A column heading with a dotted line under it says more when the
pointer is held over it.

**Materials** lists what you cut. Hardwood and softwood are always there. Add a material
by name, such as oak or acrylic, then give your tools cutting settings for it. A material
can be renamed at any time, and deleted (the × at the right) once no cutting settings,
tool or part of the open project uses it. Materials that came with an imported tool list
are here too, with the materials of the Makera apps they are tied to. For a material of
your own, "Suggestions as" says which known material it cuts like, so that a tool's sheet
can suggest starting values for it and place its rows.

The app's toolpaths have only been proven in wood. A part in any other material builds
with a warning that says so: check its simulation with care and cut a test piece first.

**Profiles**: a profile names one kind of toolpath, such as a finishing pass or a slot, so
that a tool can keep a further cutting row tuned for it beside its plain one. You need
none to cut. The page adds, renames and deletes them; deleting one also deletes its rows
from your tools, after asking. "Suggestions start at" and the four marks under "Cut"
(ramped, lubricated, full width, adaptive) only say where the suggestion on a tool's
sheet begins for the profile's rows. A profile marked **Adaptive** is for other CAM
programs: this app has no such toolpath and does not cut with its rows. A profile's name
matters in one place: it says which operations start a bit on it (see
[Make an inlay](#3-make-an-inlay)), so "Face finish" is where a facing's bit starts.

**Machine** holds the limits every file is checked against. They start as those of the
Carvera Air; "Fill in for" sets them for the Carvera.

- **Travel** in X and Y: a file whose moves span more is refused.
- **Spindle speed**, lowest and top: a tool set to turn faster than the top is refused.
  Suggested cutting settings keep within the two, and run wood at the top.
- **Rapid speed** is only used for the time estimates.
- **A tool change takes**: added to a file's time for each tool it loads. At 0, as it
  starts, the time is given without tool changes.
- **First tool number**: the tools of a file are numbered from here, in the order they are
  used. On a Carvera with a tool rack, T1 to T6 are the rack's slots and are loaded
  automatically, whatever is in them; start at 7 to be asked for each tool by hand.

The files are always written for the Carvera Community Firmware, whatever is set here.

**New inlays** holds the clearances and tabs a new inlay starts with: travel height,
plunge height, the ramp, the finishing pass, the tabs, and how parts are cut out. They are
described under "Clearances and tabs" below. Each inlay keeps its own copy, so changing a
value here does not alter inlays you have already made. A value of your own has "Put back
the app's" beside it, and "Back to the app's values" puts them all back.

## 2. Bring in a drawing

Use **Import drawing** or drop the files on the window. The app reads SVG and DXF, and
takes several files at once.

- Shapes must be filled, or drawn as lines that join into closed outlines. Lines are
  joined where their ends meet within 0.01 mm. When outlines were left out because they
  do not close, the notes after the import offer to join larger gaps, up to 2 mm, and say
  how many outlines that closes.
- In a drawing made of outlines only, as CAD programs export, the shapes are the areas
  between the lines. A circle drawn around six shapes is the web between them. Outlines
  that cross or touch each other stay whole, one lying on the other.
- Text must be converted to outlines first. Images are ignored.
- After the import the app lists what it left out.

### The stock

The stock is the board the pockets and the other operations are cut into. Its bottom-left
corner is the work origin, with Z0 on its top face. The first drawing sets its size: the
drawing's page, or for a DXF file, which has no page, the shapes' extent plus 5 mm on every
side.

Under **Stock and drawings** you set the stock's width, height and thickness, its material, and the
colour of its wood. Changing the size leaves the shapes where they are and as large as they
are. Shapes may lie outside the stock or run over its edges: a mark for a positioning pin
beside the board, say, or a pocket that runs off its edge. The app says so when there are
such shapes, and a step that uses one cuts outside the stock as well: keep clamps, stops
and pins out of the tool's way, and mind that left of the stock and below it X and Y are
negative. A shape no step uses is never cut. "Fit the stock to the shapes",
under "More", makes it the shapes' extent plus 5 mm.

The stock applies to this board only. A plug or an insert is cut from a board of its own,
whose size follows from the shapes and the inlay's settings.

**Add drawing**, in the bar above the drawing, puts the shapes of further files on the
same stock; so does dropping files on the window. The shapes come in at their own size, in
the middle of the stock, selected and with "Edit" switched on: drag them to their
place. The stock keeps its size: shapes too large for it reach over its edges. "Replace the drawing",
under "More", starts over with one file; what was made from the old drawing is removed.

"Start with an empty stock", on the start screen, gives a stock of 200 x 150 mm without a
drawing, to face it, to draw shapes on or to add drawings to.

If a DXF or an Illustrator SVG comes in at the wrong size, the file's unit was not what
the app took it for: switch to "Edit", select its shapes and type the right width.

### Editing the drawing

A drawing often holds several parts, or parts you do not want. The bar above the drawing
switches between two things a click on the drawing can do: **Pick shapes**, for making
inlays and operations, and **Edit**, for changing the drawing itself: drawing shapes
on the stock, and moving, resizing, turning and deleting them.

While editing, a toolbar above the drawing holds what can be done to the selected
shapes, as buttons with a symbol each (point at one to read what it does) and, under them,
the selection's position and size as numbers. The panel at the side shows what is
selected, the stock's size and the keys. "Pick shapes", or "Done editing" in the panel,
goes back.

The app treats the drawing as outlines here, and each outline is a shape of its own. A
shape that lies inside another, such as the disc in a ring, is not part of it: moving,
resizing or deleting the ring leaves the disc where it is. The hole a shape makes in the
shape around it follows the shape, and closes when the shape is deleted or moved out.

Selecting:

- Click a shape to select it: that one outline, without what lies inside it. To take a
  part with everything in it, drag a box around it, or Shift-click its shapes. Shapes
  selected together move together.
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
- Type W or H, or a percentage under "Scale by", which scales what is selected as it is now. "Keep proportions" decides whether the
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
redoes, up to 50 steps, also after editing.

The board and the view:

- The work origin stays at the board's bottom-left corner. Shapes can be moved, resized
  and drawn past any of its edges, and the board keeps its size; the view shows them. "Fit
  board to shapes" makes it the shapes' extent plus a margin.
- The mouse wheel zooms, also outside editing. Drag with the middle button to move the
  view; double-click empty board, or press "Whole board", to see all of it.

Shapes keep their inlays when they are moved, resized or turned. A shape dropped wholly
inside another on its layer becomes a hole in it, as if it had been drawn there. Shapes may lie
partly on top of each other, and filled shapes of an imported drawing stay whole where
one covers another: the app does not cut one around the other. Shapes of one inlay are
merged; two inlays over the same wood only work cut one after the other, the second into
the first once it is glued in. There is no snapping or aligning of one part to another.

In a narrow window the toolbar is shorter: turning by a typed angle and scaling by a
percentage are behind its **⋯** button, and the "mm" after the number boxes is left out.

### Drawing shapes

While editing, the toolbar's **Draw** group holds three shapes: rectangle, ellipse and
polygon. Choose one and drag on the stock. The line under the drawing gives the shape's
size as you drag.

- **Rectangle** and **ellipse** fill the box you drag out. Shift makes a square or a
  circle; Ctrl draws from the middle instead of from a corner. A rectangle takes a
  *corner radius*, which rounds its corners by no more than half its shorter side.
- **Polygon** is dragged from its middle to one of its corners, so the drag sets both
  the size and which way the shape points. Shift turns it in steps of 15°. It takes its
  number of *sides*.
- Escape during a drag abandons the shape; Escape otherwise puts the tool away.

The shape comes in selected and the tool is put away, so that its exact size and place
can be typed in W, H, X and Y at once. Choose the tool again for the next one, or copy
the shape with Ctrl+D.

A drawn shape is an outline like any imported one, and from then on it is nothing more:
a circle is not kept as a circle, and its curve is made of straight runs that stay within
0.01 mm of it, as imported curves are. It joins the drawing as outlines do: drawn wholly
inside another shape it is a hole in that shape and the piece that fills it, and drawn
around other parts it gets a hole for each. It stays a shape of its own either way: a
click selects it without what is inside it. Drawn partly over another shape, both
stay whole. A shape can be drawn over the stock's edges or beside it.

### Layers

A drawing can be kept in layers: shapes that are named, shown, locked and coloured
together. **Layers**, at the top left of the drawing, opens their list, the top layer
first. A drawing starts with one. With more than one, each layer's shapes are outlined
in its colour.

- The number on a layer's line is how many shapes it holds, and is blue when some of the
  selection is on it. Click it to select them all: the quick way to make an inlay or an
  operation from a whole layer.
- The eye hides a layer. A hidden layer's shapes cannot be picked, but the inlays and
  operations that use them cut them all the same, and say how many of their shapes are
  hidden.
- Drag the list by its heading to where it is not in the way; a double click on the
  heading puts it back in the corner. The cross folds it away.

The rest is there while the drawing is edited:

- **+** adds a layer above the one that is drawn on. Click a layer's name to draw on it:
  new shapes go there. Double-click the name, or press F2 on it, to rename it.
- Drag a layer by its grip, or press the up or down arrow on the grip, to put it higher
  or lower.
- The lock keeps a layer's shapes from being selected, moved or deleted while editing.
  They can still be picked for inlays and operations.
- The square before the name sets the colour of the layer's lines.
- The bin, which shows when a line is pointed at, deletes the layer with its shapes.

To put the selected shapes on another layer, right-click one of them and choose the
layer under **Move to layer**, or use the toolbar's button of that name, or the arrow on
the layer's line in the list. "New layer" there makes one for them. A hidden or locked
layer takes none. The same right-click menu selects everything on the shape's layer,
copies and deletes.

**Holes are a matter of one layer.** A shape wholly inside another on the same layer is a
hole in it; on different layers both stay whole, whatever lies inside what. So a recess
on one layer and an inlay inside it on another are two whole shapes: the recess is
pocketed right across, and the inlay is cut into its floor with a *start depth*. Moving a
shape to another layer closes the hole it filled and opens one where it now lies inside
a shape. One case is left as it is, here as when a shape is drawn or dragged: a shape
that comes between another and what is already a hole in that one lies on top, and cuts
no holes.

A drawing brought in with **Add drawing…** comes onto a layer of its own, named after
its file, or onto the layers it has. The layers of a DXF file and of an Inkscape SVG are
kept; a layer hidden in Inkscape is left out, and the import says so.

## 3. Make an inlay

Click the shapes that will be cut from one wood, then choose the kind of inlay. Each
inlay is edited in its own panel; "All operations" takes you back.

What the stock is made of is set once, as its **Material** under "Stock and drawings":
every pocket and operation cut in the stock uses its tools' cutting settings for that
material. An inlay has one choice of its own under "Wood and tools", the **Wood of the
inlay**, for the board its plug or insert is cut from. A facing that trims a glued-in
plug is cut in that inlay's wood.

Under each chosen bit a card says how it cuts in this step: the speed, feed, plunge,
stepover and stepdown of the cutting row it runs.

- When the bit has rows on **profiles** for the material, the card begins with a button
  for each: "Plain", the row that is safe for any cut, then one per profile. The one in
  use is marked; click another to run that row. A bit with only its plain row has no
  buttons. A profile for adaptive clearing is shown and cannot be chosen: the app has no
  such toolpath.
- A bit you choose starts on the profile for what it is chosen for, when it has such a
  row. The app goes by the profile's name: one named for facing in a facing, for clearing,
  pockets or roughing where it clears, for chamfers, bevels or edges in a chamfer, for
  carving or engraving as the V-bit of an inlay, and one marked "Full width" (or named for
  slots or contours) in a contour. Otherwise it starts on the plain row. A bit that was
  chosen before keeps the row it had. The app does not check a row against the kind of
  cut.
- **Edit** opens a field for each number. Type one to change it for this step only; it is
  then shown in blue, the link reads "Edit (1)", and the arrow beside the field puts the
  row's own back. A field left empty follows the row, also when you tune it in the tool
  list later. "Reset all" empties them.
- In an inlay whose wood is not the stock's, the card has two lines, "Pocket" and "Plug",
  one for each material's row. A number you change is changed for both.

Cutting a plug or insert out of its board always uses the plain row, unchanged.

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
- **Start depth**: for a pocket cut into a surface below the stock's, such as the floor of
  an earlier pocket or facing. The pocket is cut as it would be at the top, that much
  lower; the plug is cut as before. The wood above must be gone over the plug's blank,
  which the cross-section shows dashed. The fit check measures from that surface, and the
  glue-up seats the plug on it.
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

**Finer points** holds three numbers that seldom need changing, and says "(changed)" when
one is not the usual:

- *Ridges on the floor, at most* (0.1 mm): on a flat floor only the V-bit's tip cuts, so
  its passes are put close enough to leave ridges no higher than this, whatever stepover
  its cutting settings give. The file says when it does. Lower is smoother and slower.
- *Relief stays below the face by* (0.5 mm): how close to the finished face a relief cut
  may come.
- *Fit check judges the face at* (0.1 mm): how far below the surface the fit check looks
  for gaps, which is about what sanding takes off once the plug is in.

### Flat inlay

Upright walls cut with an end mill. Corners are rounded to the radius of the smallest end
mill chosen; the outline that will really be cut is drawn dashed after generating.

- **Pocket depth** and **fit allowance**. The allowance is the gap all round: half comes
  off the insert and half is added to the pocket.
- **Start depth**, as for a V-carve inlay: the pocket cut into a lower surface. The wood
  above must be gone over the plug's blank, or over loose inserts.
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
are cut. A new inlay starts with your defaults from **Settings**, "New inlays"; "Back to your
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
  at each depth. For straight passes, "The passes run" chooses their direction as it does
  for facing: along the longer side of each shape, along X, or along Y. "Start depth"
  begins the clearing below the surface, for a deeper pocket in the floor of another:
  nothing is cut above it, and the wood there must be gone over the shapes. Its file alone
  is simulated with that wood taken out.
- **Contour**: takes an end mill along the outlines. *Outside the shapes* keeps the shapes:
  the tool runs round them, and inside their holes. To cut round the outside of a part
  only, add everything inside it to the operation too. *Inside the shapes* cuts them away,
  leaving an opening of their size. *On the line* puts the tool's centre on the outline.
  The cut goes to a depth, or right through the stock and a little into the spoilboard,
  with or without tabs. "Start depth" begins the cut below the surface, for a cut on the
  floor of a pocket or one that goes on where another stopped: nothing is cut above it,
  and the wood there must be gone where the tool runs. Its file alone is simulated with
  that wood taken out.
- **Chamfer**: shapes the top edge along the outlines. With a V-bit the edge is bevelled
  to the width given. With a corner-rounding (fillet) bit it is rounded over to the bit's
  own radius, and there is no width to give. Choose the side where the wood has been cut
  away: round the shapes, or inside them. Run it after that edge has been cut. The bit's
  tip runs beside the edge, where it expects air; in uncut wood it would leave a groove.
  The panel draws the edge in section with the bit against it, to scale: the bevel's width
  and height, the tip's depth, and the room the bit needs beside the edge, where the wood
  must be gone (dashed). "Tip clearance" is how far out a V-bit's tip runs, 0.2 mm
  unless changed. The
  bevel stays as wide; more clearance takes the bit deeper and cuts the bevel higher up
  its flutes, where it cuts better, and needs that much more room beside the edge.
  "Edge depth" is for an edge below the surface, such as that of an opening in a pocket's
  floor: the same bevel, that much lower. The wood above the edge must be gone on both
  sides of it.

  The edge is cut in passes, each a band of its own in the drawing. No pass goes deeper
  than the cutting row's stepdown, or takes more wood than a full groove that deep, which
  is the cut the row is set for. The edge widens as it deepens, so the passes get
  shallower going down: full stepdowns while the edge is narrow, then less and less. A
  deeper stepdown in the row gives fewer passes. A corner-rounding bit is held to the
  groove of a 90° V-bit as deep, flat tip and all, as the feeds model reads it.

  A bevel wider than the V-bit's flank, or than its cutting edges reach, is cut in layers
  from the top: in each layer the bit runs first with its flank on the bevel, then in
  steps out to the edge, so that the uncut part of the bit above the flank only ever
  meets wood already taken away. That goes round the outline many times; the panel and
  the file say how many, and name a larger V-bit of the same angle in the list that would
  cut it from one track.
- **Facing**: mills an area flat with an end mill. Without shapes that is the whole stock,
  and the tool runs out over every edge. With shapes it is the rectangle around them plus
  a margin. Give a *depth below the surface* to flatten the stock, and *start above the
  surface* to remove what stands on it, such as a glued-in plug. With a start above the
  surface, the depth may be less than 0: the cut then ends that far above the surface. A
  start under 0 begins the facing below the surface instead, for one in the floor of
  another: nothing is cut above it, and the wood there must be gone over the area. The
  panel draws it in section: where the cut starts, what comes off, and the margin. The tool goes side to side in straight passes;
  "The passes run" chooses along the longer side of the area (the fewest turns), left and
  right along X, or to and from the front along Y, which matters for the look of a faced
  surface in wood. "The tool's path" can make it go in rings instead.

### Trimming a plug flush

An inlay with a plug on a backer (a V-carve inlay, or a flat inlay made as "One plug")
has a line "Trim the plug flush" under **After the cut** in its panel, with what the
facing will take off. Its **Add** adds a facing to the list as an operation of its own, named "Trim" and the
inlay's name, over the inlay's shapes and in its wood, and opens it. It goes in after the
inlay's glue-up when the list has one, else at the end:

- *Take the start from the wood the list leaves above the surface* is ticked. The height the cut starts at
  is then how far the plug stands above the stock by the inlay's own numbers, as long as
  the inlay's glue-up is above the facing in the list; it follows when the inlay changes.
  That is the number the panel shows. The facing's files, its own and its part of a file
  for the stock, start where the wood stands on the stock itself, which is worked out
  when they are made: a plug that rests a little high is then not run into. If you saw
  the backer off first, add that as a step, below; the facing then starts at what the
  saw left.
- *Depth below the surface* is 0, so the cut ends flush with the stock. A depth under 0
  stops that far above the surface: -0.2 leaves the plug 0.2 mm proud, to sand flush.
- *Take the margin from the inlay's plug* is ticked: the margin is the plug's own, so that
  the area is the plug's blank, and stays so when the inlay's margin is changed. Untick
  it to type another.

Choose its end mill and generate its file like any other operation's; run it once the
glue has set. Once an inlay has such a facing, its panel leads to it instead of offering
another. Loose inserts are not offered one.

A facing made by hand over an inlay's shapes does the same: its panel says how far that
plug stands above the surface and offers to fill in the fields. Any facing can take its
height from the list: it is the highest of the plugs and inserts glued in above it whose
blanks reach into its area, each as an earlier facing over it left it. Without a glue-up
above it there is nothing to take, and the panel says so.

The file starts cutting at that height and travels above it. Z0 is still the stock's
surface, so set it beside the plug, not on it. The 3D view of the file alone shows the
stock only, not the wood standing on it; "Stock, step by step" shows the plug too.

### The glue-up as a step

Gluing a plug or inserts in is done by hand, and has no file. It can still be a line of
the list: **Glue-up**, under "Steps done by hand" where inlays and operations are added,
adds it. With one inlay that has none yet it is for that one; with several it asks which,
by name and wood, or takes all of them; with shapes selected it is for their inlays. An
inlay's own panel has it as well: **After the cut** lists what is done with the inlay once
it is cut, the glue-up first, each line with **Add** while it is not in the list and
**Open** once it is. The step goes in right after its inlay, drawn with a dashed edge.

Its place in the list is what it says. The lines above it find the stock without the plug;
the lines below it find the plug on the stock. Drag it like any other line. Deleting an
inlay deletes its glue-up with it.

**Saw off the backer**, beside it, is the other step done by hand, for a plug on a backer
that has its glue-up in the list; it asks which plug in the same way, and the inlay's
panel offers it too. It goes in after the
glue-up. Its one number is how far above the surface the saw leaves the plug standing,
which starts at the inlay's saw gap: the most the saw can leave. From that step on the
backer is gone, with all of the blank around the shapes, and the plug stands that high.

A glue-up is also where the machine stops, so no file goes across one: what is cut before
it and what is cut after it are always separate files.

### The stock, step by step

Every line of the list has a grip: drag it to put the list in the order to cut in, or
select the grip and press the up or down arrow.

Each inlay and operation can make a file of its own, simulated on a fresh board. The tab
**Stock, step by step**, beside "Drawing" above the drawing, takes one board through the
whole list instead, from top to bottom: each line is cut into the board as the line before
left it, and a glue-up puts the plug or the inserts on it, in their wood. It is there as
soon as the list has a line, and works the stock out the first time it is opened. The
panel on the right has a tab of its own for getting the files, **Export**, beside
"Operations".

**Export** lists everything there is to cut, each line with a tick, its tools by their
numbers and its time. Under "The stock" are every inlay's pocket and every operation, in
the order of the list. The lines from one step done by hand to the next stand in a frame,
and the steps done by hand stand between the frames. Under "Plugs and inserts" each
inlay's plug or inserts has a frame of its own, since it is cut from another board. "3D"
at the end of a line, or the name of a step done by hand, goes to the stock in 3D as it
is after it. A line that cannot be made says why and cannot be ticked; one the simulation
found problems in says so.

Tick what you want to cut now; everything is ticked to start with, and **All** and
**None** are at the top. Each frame comes to **one file**, shown at its foot with its
name and its time: the frame's ticked lines, in the order of the list. What there is to
do before cutting stands beside "Before cutting" as small marks, one for each kind of
thing (a spoilboard, tape, clamps, the size of the board); point at a mark, or click it,
for a picture and a line on it. Notes on what a line cuts are in its own panel. Tools go by their numbers in the project (the **Tools**
tab, below), and a tool that the next line also starts with stays in the spindle. A
comment in the file, "Step 2:" and the line's name, stands where each line begins. A
frame with nothing ticked makes no file.

A file's name is the project's name, then a two-digit number, then what it is:
"Coaster-01-stock", "Coaster-01-Leaf-plug", "Coaster-03-stock". The number is the place in
the list of the file's first line, and a plug or insert has the number of its inlay, so
the machine's file list shows the files in the order they are cut. A file keeps its number
whatever else is ticked. A file that cuts one line only is named after that line, as
"Coaster-02-Trim" or "Coaster-01-Leaf-pocket", the same name the file has when it is made
in that inlay's or operation's own panel.

**Download**, which stays at the foot of the tab, saves every file. After a change to
the project the tab says so, and works the list out again when asked. While an inlay or
operation is open, the panel shows that one; its back link returns to the tabs.

**Tools**, between the two, is the list of the project's tools, each drawn under the
number it goes by. A tool gets the lowest free number when an inlay or operation first
uses it, and keeps it: every file of the project, for the stock or for a plug, calls for
the tool by that number, so the machine is loaded once. A tool's name goes to it in your
tool list, where its sizes and cutting settings are. Each line of **Export** shows the
tools it needs. Choose another number for a tool to move it; if the number is taken, the two
tools change places. Files made before that are out of date. A tool that nothing uses
any more keeps its number until it is taken off the list. The numbers are saved with the
project.

An inlay's plug or insert always has its own file: it is cut from another board. Its 3D
view and its fit are in the inlay's own panel.

In **Stock, step by step**, above the 3D view is the list again, as a row of buttons with
a slider: pick a line to see the stock after it, or step through with the arrows. Under
the buttons is what happened at the line that is shown. The view keeps its angle while you
step. "Show tool path" draws the path of the line that is shown, with the line numbers of
its file.

- A plug is put where the fit check puts it: turned over and lowered until it touches.
  The line under the buttons says how far it stands above the surface, and how much
  higher than designed it rests when that is more than a hair. Loose inserts rest on the
  floor of their pockets.
- Wood that is glued in is cut like the stock's own. A facing after the glue-up leaves the
  inlay flush, in its own colour; a pocket cut into a glued-in plug is an inlay in an
  inlay, and where it goes deeper than the plug, the stock's wood shows again.
- A line that cannot be made says why and leaves the board as it was; the lines after it
  go on from there.
- A line that runs into wood it did not expect is marked with "!": an operation put
  before the facing that trims a plug travels through the plug, and the simulation says
  so with the G-code line. A facing with a height typed in that starts lower than the wood
  stands is told how far the tool would go into it at once.

After a change to the project the tab and the view say so, and the downloads wait until
the files are generated again. Generating again does only what the change touches: the
lines up to the first one that changed are taken as they came out, so a change near the
end of the list is quick, and one at its top does everything anew.

Glued-in wood is drawn as a body of its own, underside included: a backer stands off the
stock by the saw gap, and the stock shows under its edge. Apart from where a facing starts, the cuts are
the ones the lines make on their own: nothing else is recalculated for the wood that is
on the stock.

## 5. Generate and check

**Generate files** makes both files of an inlay, or the one file of an operation, and
checks them. For each file the panel shows:

- whether the simulation found a problem (a rapid move through wood, a cut below the
  board, a cut deeper than the tool's flutes). Do not run a file that has one;
- the size of board it needs, the time per tool and the number of tool changes;
- **Before cutting**: what the file asks of you before it is run, each line one thing to
  do, such as a spoilboard to put under the board, a part to hold down with tape or
  clamps to keep clear;
- notes on what it cuts, closed until opened: what a tool could not reach, how many tabs
  are left, which row a tool runs.

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
- With **Show dimensions** ticked as well, a line runs from each edge of the board to
  where the moves drawn cut closest to it, as "cut … to edge". It measures to the tool's
  edge at the top of the board, so a V-bit counts as wide as it is at its depth. An edge
  the cut reaches has none.

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
- The pocket file, the files of the other operations and the files for the stock are
  for the stock. The plug or insert file is for its own board, of the size the app gives.

Before the first real cut, run `machine-tests/m0-air-cut.cnc` as an air cut. It confirms
that the machine reads this app's G-code as intended.

The simulation checks the file against the board and the tools you described, not against
your machine as it stands. It cannot see clamps, a wrong work origin, a tool that differs
from its entry in the tool list, or a board of another size. Run a new file once with Z0
set well above the board, keep a hand near the stop button, and wear eye protection. The
app comes with no warranty: what a file does on your machine is your responsibility.

## What the app does not do

- It does not read text that is not outlines.
- It does not write a curve that changes height, such as a ramp along an arc, as an arc:
  only level curves are.
- It checks every cut against the length of the tool's cutting edges, so nothing above
  them ever goes below the board's surface. It does not check the tool holder against
  clamps, or the machine's Z travel.
- It does not pack inserts to save wood.
- A file's own 3D view does not show wood standing above the stock's surface, such as a
  glued-in plug. "Stock, step by step" does, once the glue-up is a step of the list.
- It does not snap or align shapes, so a second drawing is placed by eye or by typed
  position.
- It draws rectangles, ellipses and polygons, and nothing freer: no pen, no
  editing of an outline's points, no joining or cutting of one shape with another, and no
  text.
