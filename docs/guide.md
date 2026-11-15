# Using the app

The app turns shapes from a drawing into G-code for a Carvera Air running the Carvera
Community Firmware. For each inlay it writes two files: one cuts the pocket into the base
board, the other cuts the piece that fills it. It simulates both files and reports how the
two parts will fit.

Everything runs in the browser. Projects and tools are stored in that browser only; use
"Save to file" to keep a copy or move a project to another computer.

## 1. List your tools

Open **Tools**. Add each end mill and V-bit you will use, or import the `tools.yaml` of
your tooling library (only end mills and V-bits are taken from it).

- **Flute length** is the deepest the tool can cut. The app refuses a cut deeper than
  that. Leave it empty if unknown and the app warns instead.
- **Tip flat diameter** of a V-bit: measure it. A bit sold as pointed often has a flat of
  0.1 mm or more, and the app's geometry depends on it.
- **Cutting settings** are per wood (hardwood, softwood). A tool cannot be used on a wood
  it has no settings for.
- A V-bit's **stepover** spaces its passes over a flat floor, where only the tip cuts.
  The app caps it so that ridges stay under 0.1 mm.

Tools are shared by all projects. A project keeps its own copy of the tools it uses, so it
opens correctly elsewhere.

## 2. Bring in a drawing

Use **Import drawing** or drop the file on the window. The app reads SVG and DXF.

- Shapes must be filled, or drawn as lines that join into closed outlines. Lines are
  joined where their ends meet within 0.01 mm.
- In a drawing made of outlines only, as CAD programs export, the shapes are the areas
  between the lines. A circle drawn around six shapes is the web between them.
- Text must be converted to outlines first. Images are ignored.
- After the import the app lists what it left out.

The drawing's page is the base board. Its bottom-left corner is the work origin, with Z0
on the board's top face. A DXF file has no page, so the board is the shapes' extent plus
5 mm on every side. Set the board's width or height to scale the drawing, and its
thickness.

If a DXF or an Illustrator SVG comes in at the wrong size, the file's unit was not what
the app took it for: type the right width.

## 3. Make an inlay

Click the shapes that will be cut from one wood, then choose the kind of inlay. Each
inlay is edited in its own panel; "All inlays" takes you back.

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

Add more than one end mill and they are used in the order listed. Each cuts only what the
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

## 4. Generate and check

**Generate files** makes both files and checks them. For each file the panel shows:

- whether the simulation found a problem (a rapid move through wood, a cut below the
  board, a cut deeper than the tool's flutes). Do not run a file that has one;
- the size of board it needs, the time per tool and the number of tool changes;
- things to know before cutting, such as clamps to keep clear.

**Show in 3D** shows the simulated part. The simulation is run on the text of the G-code
file itself, so what you see is what the file does.

### Fit

For a V-carve inlay the app turns the simulated plug over, lowers it into the simulated
pocket and reports where it rests, how much of the wall touches, the glue gap and any gaps
in the finished face. **Show fit** opens a map; click anywhere to see a cross-section and
the exact heights there.

For a flat inlay the fit is worked out from the outlines: the gap at the wall and how far
the insert stands above the surface.

The fit check works on a grid of 0.05 to 0.2 mm, coarser for larger boards. Differences
smaller than a cell are noise. A plug that "seats once pressed" is held off by a little
wood in sharp corners, which a V-bit with a tip flat always leaves.

## 5. Cut

Download each file and run it on its own board.

- Set the work origin at the board's bottom-left corner, Z0 on its top face.
- Tool numbers in the file start at T1, in the order the tools are used. The firmware asks
  for each tool in turn.
- The pocket file is for the base board. The plug or insert file is for its own board, of
  the size the app gives.

Before the first real cut, run `machine-tests/m0-air-cut.cnc` as an air cut. It confirms
that the machine reads this app's G-code as intended.

## What the app does not do

- It does not read DXF blocks or binary DXF, or text that is not outlines.
- It does not fit arcs: curves are written as short straight moves.
- It does not check the tool holder or the Z travel.
- It does not pack inserts to save wood, or surface the board.
