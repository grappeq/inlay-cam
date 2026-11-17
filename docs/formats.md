# File formats

The app writes two kinds of file of its own, both JSON. It reads SVG and DXF drawings, and
reads and writes a `tools.yaml` tool list.

Lengths are millimetres, angles are degrees, feeds are mm/min.

The definitions in code are `crates/inlay-core/src/tools.rs` and `project.rs`. The format
is at version 1 and may still change until the first release; from then on the
compatibility rule below applies.

## Common envelope

Every file is a JSON object that starts with three fields:

```json
{
  "app": "wooden-inlays",
  "kind": "project",
  "formatVersion": 1
}
```

| Field | Meaning |
|---|---|
| `app` | Always `wooden-inlays`. Anything else is rejected as "not a Wooden Inlays file". |
| `kind` | `project` or `tool-library`. |
| `formatVersion` | Whole number, starting at 1. Each kind has its own counter. |

Version 1 of both kinds is frozen: `tests/fixtures/project-v1.json` and
`tool-library-v1.json` in `crates/inlay-core` are files written by the app, and the tests
require every later version of the app to read them back unchanged.
`project-v1-early.json` is a project written before the later fields existed, and
`tool-library-v1-full.json` a tool library that uses every field added since.

### Compatibility rule

A file written by any released version of the app opens in every later version.

- Adding a field that has a default does not change `formatVersion`. Old files simply lack
  the field and get the default.
- Any other change (renaming, removing, changing meaning or units) raises `formatVersion`
  and adds a migration that rewrites the old JSON into the new shape. Loading runs every
  migration between the file's version and the current one, in order.
- A file with a higher `formatVersion` than the app knows is refused with a message saying
  it comes from a newer version. The app never guesses.
- The test suite keeps one fixture file per released version
  (`crates/inlay-core/tests/fixtures/`), and every one of them must keep loading.
- Projects kept in browser storage are stored as this same file text, so they go through
  the same migrations.

## Tool library (`kind: "tool-library"`)

Exported from the Tools page as `tools.inlay-tools.json`. It holds the tools and the
materials, toolpath profiles and groups they refer to. It is the owner's own list, so it
also holds where each tool was bought, what it cost and what was logged about it.

```json
{
  "app": "wooden-inlays",
  "kind": "tool-library",
  "formatVersion": 1,
  "materials": [
    { "key": "aluminum", "cam": { "id": "{71a0…}", "name": "Aluminum" } },
    { "key": "oak", "label": "Oak, quarter-sawn" }
  ],
  "profiles": [
    { "key": "face_finish", "label": "Face finish", "note": "One shallow pass at a small stepover." }
  ],
  "groups": [
    { "path": "End mills", "ids": { "cam": "{f0ec…}" } }
  ],
  "tools": [
    {
      "id": "0a6c…",
      "name": "Ø6×18 3F",
      "kind": "flat_end",
      "diameter": 6.0,
      "fluteLength": 18.0,
      "shankDiameter": 6.0,
      "length": 50.0,
      "flutes": 3,
      "cutting": [
        { "material": "hardwood", "rpm": 12000, "feed": 2000.0, "plunge": 180.0, "stepover": 2.4, "stepoverUnit": "percent", "stepdown": 1.75 },
        { "material": "hardwood", "profile": "face_finish", "rpm": 12000, "feed": 700.0, "plunge": 180.0, "stepover": 1.0, "stepdown": 0.2 }
      ]
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `materials` | The materials cutting settings can be given for, in the order they are shown. May be missing. |
| `profiles` | The toolpath profiles a cutting row can belong to. May be missing. |
| `groups` | Groups whose ids in the Makera apps are pinned. May be missing. |
| `tools` | The tools. |

A file is refused when a tool refers to a material or a profile the file does not hold.
`hardwood` and `softwood` are always known and need no entry under `materials`.

A file written before the fields below marked "later" existed lacks them and reads the same
as ever; a tool that uses none of them is written exactly as it was then.

### Tool

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique within the list. Jobs refer to tools by it. Not shown to the user. |
| `name` | yes | Not empty. |
| `kind` | yes | `flat_end`, `v_bit` or `corner_round` (a corner-rounding, or fillet, bit): the kinds the app's operations cut with. Later: `ball_end`, `drill` and `thread_mill`, which are kept in the list and written for other programs, and which no operation accepts. |
| `diameter` | yes | Cutting diameter. For a V-bit, the diameter at the top of the cone; for a corner-rounding bit, that of its body. Greater than 0. |
| `tipDiameter` | no | V-bit: diameter of the flat at the tip; missing or 0 means a perfect point; must be smaller than `diameter`. Corner-rounding bit: diameter across the tip, below the rounded edge; missing means 0. Other kinds: kept for the Makera apps, which store a value here. |
| `cornerRadius` | corner-rounding bit | Radius of the rounded edge the bit cuts. Greater than 0. `tipDiameter` plus twice this must not exceed `diameter`. |
| `tipAngle` | V-bit and drill | Included angle between the two cutting edges, or of the drill point, between 0 and 180. On other kinds it means nothing to this app and is kept for the Makera apps, which store 60 on end mills. |
| `fluteLength` | no | Length of the cutting edges along the axis: the deepest the tool can cut. Missing means unknown. |
| `shoulderLength` | no, later | From the tip to where the body widens to the shank. At least `fluteLength`. Missing means it is the flute length. |
| `shankDiameter` | yes | Greater than 0. |
| `length` | no | Overall length. Missing means unknown. |
| `flutes` | no | Number of cutting edges. |
| `threadDiameter`, `pitch`, `drillDiameter` | no, later | Thread mill: the thread's diameter, its pitch, and the hole drilled before threading. The last two are smaller than the first. |
| `studioUnknown1` | no, later | A value Makera Studio stores and does not show. Kept as it was. |
| `group` | no, later | Where the tool is filed, with `/` between nested groups. |
| `number` | no, later | The tool number other CAM programs list it under. |
| `coating`, `style` | no, later | The coating, and a word or two that sets the tool apart from others of its size. |
| `note` | no, later | One line about the whole tool. |
| `description` | no, later | Longer remarks, of any number of lines. In a `tools.yaml` these are the comment lines directly above the tool. |
| `recommendedFor` | no, later | Keys of the materials the tool suits. Each once. |
| `apps` | no, later | The Makera libraries the tool goes into: `cam`, `studio`, both or none. Missing means both. |
| `fusionType` | no, later | `chamfer_mill` or `radius_mill`: the Fusion 360 tool type of a V-bit, when it was chosen by hand. |
| `ids` | no, later | `{ "cam": …, "studio": … }`: the tool's pinned ids in the Makera apps. |
| `source` | no, later | Where the tool came from: `url`, `invoice`, `sizeNote`, each optional. |
| `inventory` | no, later | `quantity` on hand, `price` per piece with its `currency` (three capital letters; the two come together), `purchased` (a date), and `log`: cutters that broke or wore out, each with a `date`, a `kind` (`broken` or `worn`) and optionally a `material` and a `note`. |
| `verify` | no, later | Things still to check, each a `field` (once per tool) and an optional `note`. |
| `cutting` | no | List of cutting rows, at most one per material and profile. |

Dates are written `YYYY-MM-DD` and must exist in the calendar.

### Cutting row

A tool has at most one **plain** row per material: values safe for any toolpath, a
full-width slot included. It can have one more row per material for each toolpath profile.

| Field | Meaning |
|---|---|
| `material` | The key of a material: `hardwood`, `softwood`, or one under `materials`. |
| `profile` | Later. The key of a profile under `profiles`. Missing for the plain row. |
| `rpm` | Spindle speed, whole number greater than 0. |
| `feed` | Feed rate while cutting sideways, mm/min. |
| `plunge` | Feed rate while cutting straight down, mm/min. |
| `stepover` | Sideways distance between passes, mm. Not larger than `diameter`. For a V-bit it spaces the passes over a flat floor, and the app uses less when this would leave ridges over 0.1 mm. |
| `stepoverUnit` | Later. `mm` or `percent`: the unit the stepover was entered in, and is shown and written to a `tools.yaml` in. The value in `stepover` is mm either way. Missing means `mm`. |
| `stepdown` | Depth per pass, mm. |
| `passes` | Later. Thread mill: radial passes to cut the thread. |
| `log` | Later. What happened when the row was used, in the order written: see below. |
| `ids`, `camFlag`, `camExtra`, `modified` | Later. What the Makera apps store with the setting. Kept as they were. |

A **log entry** has a `date`, a `text`, optionally an `outcome` (`ok`, `provisional` for
"worked, still to confirm", or `failed`), and `at`: the row's numbers for that cut (`rpm`,
`feed`, `plunge`, `stepover`, `stepoverUnit`, `stepdown`, `passes`). An entry counts for the
row only while `at` equals the row's present numbers; the newest such entry (of one date,
the one written last) is the row's current result. Change the row's numbers and it is
untested again.

### Material

| Field | Meaning |
|---|---|
| `key` | How tools and jobs refer to it. Unique. Never changes. |
| `label` | What it is called. Missing: its name in Makera CAM or Makera Studio is shown, else the key. |
| `feedsAs` | The key of the material whose suggested feeds and speeds this one takes, for a material the feeds model does not know by its own key. It changes nothing else. May be missing: no suggestions then. |
| `cam` | Its record in Makera CAM: `id`, `name`. |
| `studio` | Its records in Makera Studio, which splits some materials into several: each `id`, `categoryId`, `name`, and optionally `builtin` and `modified`. |

A material added in the app has a `key` made from its name and no record in either Makera
app.

### Profile

A kind of toolpath a tool can keep a second row for, such as a finishing pass on a faced
surface.

| Field | Meaning |
|---|---|
| `key` | 1 to 40 lowercase letters, digits or `_`. Unique. Never changes. |
| `label` | What is shown. Unique, ignoring case. |
| `note` | Optional. |
| `level` | Optional: `gentle`, `slot_safe`, `standard`, `firm` or `aggressive`. Where the tooling library's suggestions for the profile's rows start. Not used by this app. |
| `ramping`, `lubricated`, `slot` | Optional, default false. Further hints for those suggestions. Not used by this app. |
| `adaptive` | Optional. The rows are for adaptive clearing: a light sideways cut taken deep, which breaks the tool when run as a full-width slot. Missing means true for the key `adaptive` and false for any other. This app has no adaptive toolpath and refuses to cut with such a row. |

### Importing a tool file

A tool with the same name as one already in the list replaces it and keeps the existing id;
other tools are added. Materials, profiles and groups are merged the same way, by key or
path.

## Project (`kind: "project"`)

Exported from the header as `<project name>.inlay.json`.

```json
{
  "app": "wooden-inlays",
  "kind": "project",
  "formatVersion": 1,
  "project": {
    "id": "5f0e…",
    "name": "Coaster",
    "design": { "…": "see below" },
    "jobs": [],
    "tools": [],
    "base": { "thickness": 18.0 }
  }
}
```

| Field | Meaning |
|---|---|
| `id` | Identifies the project in browser storage. |
| `name` | Shown in the header; used for the export file name. |
| `design` | The imported drawing, or `null`. |
| `jobs` | The inlays and the plain operations on the stock, in the order they are listed and, in one file for the stock, cut. |
| `tools` | Copies of every tool the jobs refer to, in the tool format above. They let the project open correctly in a browser with a different tool list. While a tool with the same id exists in the user's list, the list's version is used and the copy is refreshed from it. A project file is made to be passed on, so a copy leaves out what belongs to the owner's own list: `description`, `source`, `inventory`, `verify`, `ids`, and each cutting row's `log`, `ids`, `camFlag`, `camExtra` and `modified`. |
| `profiles` | Copies of the profiles the jobs' `rowProfiles` name, in the profile format above. May be missing. |
| `base` | The stock, the board the pockets and other operations are cut into: `{ "thickness": 18.0 }`. Default thickness 18. Its outline is the design's page after scaling; the work origin is the page's bottom-left corner and Z0 is its top face. Optional `color`: the colour of its wood in the app's pictures, as `#rrggbb`. |
| `machine` | The machine the files are checked against, below. Default: the Carvera Air. The app overwrites it with the machine set in the browser whenever the project is open. |
| `setup` | Clearances and tabs, below, for jobs that have none of their own: those written before each job had them. Default: the values in the table. |

### Machine

| Field | Meaning |
|---|---|
| `name` | Used in messages. Not empty. Default `Carvera Air`. |
| `maxRpm` | Top spindle speed. A tool set to run faster is refused. Default 13000. |
| `rapidRate` | Rapid speed in mm/min, for time estimates only. Default 2000. |
| `travel` | `[x, y]`: how far the tool can move. Default `[300, 200]`. |
| `firstTool` | Number of the first tool in a file, 1 to 99. Default 1. |

### Setup

Clearances and tabs. Every field has the default given, so any may be left out.

| Field | Meaning |
|---|---|
| `safeHeight` | Height above the board at which the tool travels between cuts. 1 to 50. Default 5. |
| `plungeClearance` | Height above wood already cut at which the plunge feed takes over. 0.1 up to `safeHeight`. Default 1. |
| `throughCut` | How far past the bottom of its board a part is cut out. 0 to 2. Default 0.2. |
| `tabWidth` | 0.5 to 50. Default 4. |
| `tabSpacing` | An outline gets a tab about every this far, and at least three. 5 to 1000. Default 40. |
| `tabThickness` | 0.1 to 20, and never more than half the board. Default 1. |
| `cutOutBorder` | Board left around a plug that is cut out of it, beyond the width of the cut. 0 to 100. Default 5. |
| `rampAngle` | How steeply an end mill goes down into wood along its path, in degrees from level. 0 to 45; 0 plunges straight down. Default 5. |
| `finishAllowance` | Wood left on walls while a flat pocket is cleared or a part is cut out, and taken off in one pass at the end. 0 to 1; 0 leaves none. Default 0.1. |

### Design

| Field | Meaning |
|---|---|
| `sourceName` | File names the shapes were imported from, separated by `, `. Empty for a stock started without a drawing. |
| `width`, `height` | Size of the page, which is the stock, before `scale`. Both greater than 0. The first drawing sets them; the user can change them. |
| `scale` | Uniform scale applied when the regions are used. Default 1. The app now writes 1: on opening a project it works any other scale into the regions and the page size. |
| `mirror` | Flip the whole design left to right. Default false. The app now writes false: on opening a project it works a mirrored design into the regions. |
| `regions` | The filled areas of the drawing. |

### Region

One filled area: the unit the user selects.

| Field | Meaning |
|---|---|
| `id` | Whole number, unique within the design. |
| `color` | Fill colour in the drawing as `#rrggbb`, when it was a plain colour. |
| `outer` | Outer boundary: a list of `[x, y]` points, counter-clockwise. The closing segment is implied. |
| `holes` | Holes, each a list of points, clockwise. |

Coordinates are unscaled millimetres with Y pointing up and the origin at the page's
bottom-left corner. Curves have already been replaced by straight segments no further than
0.01 mm from the original curve.

### Job

One inlay (a pocket and its matching plug or insert), or one plain operation on the stock
(a pocket, a facing, a contour or a chamfer). The field that says which is called `inlay`
in both cases, from when the app made inlays only.

| Field | Meaning |
|---|---|
| `id` | Unique within the project. |
| `name` | Shown in the list. |
| `color` | Optional. The colour of an inlay's wood in the app's pictures, as `#rrggbb`. It changes nothing in the G-code. |
| `material` | The key of a material: which cutting rows of each tool are used. `hardwood`, `softwood`, or any other key the tools have rows for. Outside those two the build warns that the app's toolpaths have only been proven in wood. |
| `regionIds` | The design regions this job covers. Each must exist in the design. The app keeps a region in one inlay at most; plain operations may use any regions, also those of an inlay or of each other. A facing may have none. |
| `setup` | Clearances and tabs for this inlay's files, as above. Optional: without it the project's `setup` is used. The app gives every new inlay its own. |
| `cutOutToolId` | The flat end mill that cuts a plug out of its board, when `cutOut` is set. Optional: without it, the largest of the inlay's `clearingToolIds` whose flutes reach through the board is used. A file is refused when the chosen tool's flutes are shorter than the board plus `throughCut`. |
| `rowProfiles` | By tool id, the key of the profile whose cutting row the tool runs in this job: `{ "0a6c…": "face_finish" }`. A tool without an entry runs its plain row. May be missing. A build is refused when the tool has no such row for the job's material, or when the profile is for adaptive clearing (as its copy under the project's `profiles` says, or, without a copy, a key of `adaptive`). Cutting a plug or insert out of its board is a full-width slot and always runs the plain row. |
| `inlay` | Type and parameters, below. |

`inlay` for a V-carve inlay:

| Field | Meaning |
|---|---|
| `type` | `vcarve` |
| `engagementDepth` | How deep the plug sits in the pocket. Greater than 0. |
| `glueGap` | Space left under the plug. 0 or more. Pocket depth = engagement depth + glue gap. |
| `sawGap` | Space between the pocket surface and the plug's backer. Greater than 0. |
| `clearingToolIds` | Flat end mills that clear the flat floor, in the order they are used. Each cuts only what those before it left. May be empty: the V-bit then clears the floor too. |
| `vbitToolId` | The V-bit, or `null` when not chosen yet. |
| `plugMargin` | Width of blank left around the shapes on the plug. Greater than 0. Default 8. The plug blank is the shapes' bounding box grown by this on every side. |
| `plugThickness` | Thickness of the plug blank. Greater than 0. Default 10. Must exceed engagement depth + saw gap. |
| `cutOut` | Cut the finished plug out of a larger board as one piece, round the edge of its blank. Default false. Needs an end mill in `clearingToolIds` with cutting edges at least 0.2 mm longer than the board is thick; the largest such is used. The board is then the blank plus that tool's diameter and 5 mm, rounded up to a whole millimetre, on every side. |
| `tabs` | When cutting the plug out, leave tabs that hold it to the board. Default false. |
| `relief` | Cut the tips of the plug's narrow ridges and corner edges back by the glue gap, so that they cannot hold the plug up. Default true, also for files that do not say. |

`inlay` for a flat pocket inlay:

| Field | Meaning |
|---|---|
| `type` | `flat` |
| `pocketDepth` | Greater than 0. |
| `allowance` | Gap between insert and pocket wall all round. 0 or more. Half is added to the pocket and half taken off the insert. |
| `tabs` | Leave tabs that hold whatever is cut out of the insert board (the loose inserts, or the plug) to it. Default false. |
| `insertStyle` | `loose` (default): each shape is cut right through the board as its own piece, the same way up as it goes in. `backer`: the shapes are left standing on a shared backer as one plug, mirrored, to be glued in face down. |
| `sawGap` | Backer plugs only: space between the base board's surface and the backer. 0 or more. Default 1.5. The plug is cut `pocketDepth` + `sawGap` deep. |
| `cutOut` | Backer plugs only: cut the finished plug out of a larger board as one piece, as for a V-carve plug. Default false. Loose inserts are always cut out. |
| `clearingToolIds` | Flat end mills that cut the pocket, in the order they are used. Each cuts only what those before it left. Corners of both parts cannot be sharper than the radius of the smallest, which also cuts the insert out. Files written before inlays took several tools have `toolId` instead (one id or `null`); it is read as a list of one or none. |
| `insertThickness` | Thickness of the board the insert or plug is cut from. Greater than 0. Default 4. Loose inserts: at least `pocketDepth`. Backer plugs: more than `pocketDepth` + `sawGap`. |
| `insertMargin` | Width of board left around the shapes on the insert board. Greater than 0. Default 8. |

`inlay` for a plain pocket: the regions cleared to a flat floor.

| Field | Meaning |
|---|---|
| `type` | `pocket` |
| `depth` | Greater than 0, and less than the stock's thickness. |
| `pattern` | The shape of the tool's path. `offset` (default): rings that follow the outline, from the middle outwards. `raster`: straight passes side to side, then once round the edge of each area at each depth. |
| `direction` | Which way `raster` passes run: `longer` (default; may be missing), along the longer side of each area; `x`, left and right; `y`, to and from the front. Rings take no direction. |
| `clearingToolIds` | Flat end mills, in the order they are used. Each cuts only what those before it left. Inside corners are left rounded to the smallest. |

`inlay` for a facing: an area milled flat.

| Field | Meaning |
|---|---|
| `type` | `facing` |
| `above` | Wood standing above the stock's surface (Z0) that is milled away first, such as the backer of a glued-in plug. 0 or more. Default 0. |
| `depth` | How far below the stock's surface the area ends up. 0 or more. Default 0. `above` + `depth` must be greater than 0. |
| `margin` | How far beyond the rectangle around the regions the area reaches. 0 or more. Default 0. Not used without regions. |
| `pattern` | The shape of the tool's path, as for a pocket, but `raster` is the default and has no pass round the edge. |
| `direction` | Which way `raster` passes run: `longer` (default; may be missing), along the longer side of the area; `x`, left and right; `y`, to and from the front. Rings take no direction. |
| `toolId` | The flat end mill, or `null` when not chosen yet. |

Without regions the area is the whole stock; with regions it is the upright rectangle
around them, grown by `margin`. The tool's centre goes to the edge of the area, so it cuts
half its diameter beyond it. The tool travels `safeHeight` above the standing wood, that is
`safeHeight` + `above` over the surface.

`inlay` for a contour: a cut along the outlines of the regions.

| Field | Meaning |
|---|---|
| `type` | `contour` |
| `side` | `outside` (default): the tool runs its radius outside the regions, and inside their holes. `inside`: its radius inside the regions. `on`: its centre on the outlines. |
| `depth` | How deep the cut goes, greater than 0 and less than the stock's thickness; or `null` (default) for right through the stock, `throughCut` past its bottom. |
| `tabs` | Leave tabs across the cut, on the outer outline of each region. Default false. Their size is in the job's `setup`; in a cut that is not through they are no thicker than half its depth. |
| `toolId` | The flat end mill, or `null` when not chosen yet. |

`inlay` for a chamfer: the top edge along the outlines of the regions, bevelled with a
V-bit or rounded over with a corner-rounding bit.

| Field | Meaning |
|---|---|
| `type` | `chamfer` |
| `side` | `outside` (default): the wood outside the regions has been cut away, and the bit runs there. `inside`: the regions are pockets or openings, and the bit runs inside them. |
| `width` | Width of the bevel seen from above. Greater than 0. Not used with a corner-rounding bit, which cuts its own radius. |
| `tipClearance` | How far beyond its tip flat a V-bit's axis is kept from the outline. 0 to 5. Default 0.2; may be missing, and is not written when it is 0.2. Not used with a corner-rounding bit. |
| `toolId` | The V-bit or corner-rounding bit, or `null` when not chosen yet. Files written when a chamfer took a V-bit only have `vbitToolId` instead, which is read the same. |

A V-bit's axis runs its tip-flat radius plus `tipClearance` from the outline, on the side
named, with the tip (`width` + `tipClearance`) / tan(half the bit's angle) below the
surface. The bevel is then `width` wide whatever the clearance, and the tip, which hardly
cuts, is in the air beside the edge. A larger clearance takes the bit deeper and further
out, so the bevel is cut higher up the flutes.

A corner-rounding bit's axis runs half its `tipDiameter` from the outline, so that the
side of its tip is on the outline, with the tip `cornerRadius` below the surface. The edge
is then a quarter circle of that radius, ending level with the surface.

In the G-code's header a corner-rounding bit is written as Fusion writes one: type
`radius mill`, with `CR=` its corner radius and `TD=` its tip diameter. Whether the
Carvera controller draws that type has not been checked.

## SVG import

Read by `crates/inlay-core/src/import/svg.rs`.

- Units: `mm`, `in`, `px` and the rest are honoured, as is `viewBox`. A size without a unit
  is in CSS pixels, 96 to the inch.
- Transforms, groups, `<use>`, basic shapes and CSS styles are resolved.
- Each filled path becomes one region per separate filled area, with its fill rule
  (`nonzero` or `evenodd`) applied, so self-crossing paths are untangled and nested
  subpaths become holes.
- Regions from different paths are kept separate, even where they overlap.
- A filled path that is not closed is closed, as a fill would paint it.
- A path with a stroke but no fill, as CAD and DXF exports draw everything, becomes the
  area its closed outlines enclose. An outline counts as closed when the path closes it or
  it ends within 0.001 mm of its start. Outlines that do not close on their own are joined
  end to end wherever two ends are within 0.01 mm, in either direction, so a shape drawn
  as separate lines and arcs is read as one outline.
- Outlines have no fill to say which side of a line belongs to which shape, so the shapes
  are the areas between the lines: every smaller outline is cut out of each larger one it
  overlaps. A circle drawn around six shapes becomes the web between them.
- Filled shapes are not cut this way: a filled shape drawn over another leaves both whole.
- Left out, and reported after import: outlines without a fill that do not close, text
  that has not been converted to outlines, embedded images, and filled areas under
  0.01 mm².
- Clip paths and masks are ignored: the full shape is imported.

## DXF import

Read by `crates/inlay-core/src/import/dxf.rs`. Only the text (ASCII) form is read.

- Entities read: `LINE`, `ARC`, `CIRCLE`, `ELLIPSE`, `LWPOLYLINE` and old-style
  `POLYLINE` with their bulges, and `SPLINE` (any degree, with weights; a spline given
  only by fit points is read as straight runs between them). Arcs and polylines drawn in a
  mirrored plane (extrusion direction pointing down) are turned the right way.
- Only the `ENTITIES` section is read. Blocks are not: an `INSERT` is left out and
  reported, as are `HATCH`, dimensions and anything else not listed above. Text is
  reported as text.
- Units come from `$INSUNITS`: inches, feet, millimetres, centimetres and metres. Without
  it the numbers are taken as millimetres and the import says so.
- Lines, arcs and curves are joined end to end where their ends are within 0.01 mm, and
  the shapes are the areas between the closed outlines, exactly as for an SVG drawing
  made of outlines. Chains that do not close are left out and counted.
- A DXF file has no page. The base board is the extent of the shapes plus 5 mm on every
  side, with the work origin at its bottom-left corner.
- Layers, colours and line types are ignored.

## Test drawings

`crates/inlay-core/tests/drawings` holds 14 SVG and 11 DXF files, each exercising one
way real files differ, and `manifest.json`, which says what the import of each must find.
Both are written by `tools/make_test_drawings.py`, which works the expected numbers out
from the geometry. The tests in `crates/inlay-core/src/import/corpus_tests.rs` import
every drawing, build every kind of inlay from its largest shapes, and simulate a few.

## `tools.yaml`

`tools.yaml` is the tool list of `cnc-tooling-library`, a separate project of the author's
that is not published. Reading and writing it is of use to others only as a way to move
tools through a YAML file laid out as below; "the tooling library" means that project.

Read and written by `crates/inlay-core/src/import/tools_yaml.rs`.

### Reading

The whole file is read: every tool, cutting row, material, toolpath profile and group.

- An unknown key, a key written twice, a missing value or a `format_version` other than 1
  stops the import, with the place in the file. So does a row for a material or a
  toolpath the file does not list, and two tools with one name.
- A tool this app cannot hold as it is written is left out and named with the reason, and
  the rest come in. The one known case is a `v_bit` without a `tip_diameter`: the tooling
  library's default, the body diameter, is not a V shape.
- Comment lines directly above a tool, with no empty line between, become its
  `description`, line for line. Other comments cannot be kept and are dropped. The import
  reports how many of each.

| `tools.yaml` | Becomes | Notes |
|---|---|---|
| `materials.<key>` | a material with that `key` | `cam` and `studio` as they are. One `studio` record or a list of them. |
| `toolpaths.<key>` | a profile with that `key` | `label`, `note`, `level`, `ramping`, `adaptive`, `lubricated`, `slot`. |
| `groups[]` | `groups` | `path`, `ids`. |
| `tools[].name`, `group`, `number`, `coating`, `style`, `note`, `apps`, `ids`, `source`, `inventory`, `verify` | the fields of the same name | `recommended_for` becomes `recommendedFor`, `size_note` becomes `sizeNote`. |
| `tools[].type` | `kind` | `flat_end`, `ball_end`, `drill`, `thread_mill` as they are. `v_bit` becomes `v_bit` or `corner_round`: see the next row. |
| `tools[].fusion.type` | `fusionType`, and `kind` | A `v_bit` with `radius mill` is a corner-rounding cutter and becomes `corner_round`. Without this key, so does a `v_bit` whose name contains "fillet", "corner round" or "radius" and whose tip is narrower than its body, as the tooling library itself decides. Its `cornerRadius` is half of what `diameter` exceeds `tip_diameter` by, since the file has no key for it. |
| `geometry.diameter` | `diameter` | Required. |
| `geometry.tip_diameter` | `tipDiameter` | Always kept for a V-bit and a corner-rounding bit. For other kinds, only when it differs from `diameter`, which is the tooling library's default. |
| `geometry.tip_angle` | `tipAngle` | 0 or missing means none. Kept on every kind, the 60 the Makera apps store on end mills included. |
| `geometry.flute_length`, `length`, `flutes`, `thread_diameter`, `pitch`, `drill_diameter`, `studio_unknown_1` | the fields of the same name | 0 or missing means unknown or not set. |
| `geometry.shoulder_length` | `shoulderLength` | Left out when it equals the flute length, its default. |
| `geometry.shank_diameter` | `shankDiameter` | Defaults to `diameter`. |
| `cutting[]` | `cutting` | `material`, `rpm`, `feed`, `plunge`, `stepdown`, `passes`, `log`, `ids`, `cam_flag`, `cam_extra`, `modified` as they are. `toolpath` becomes `profile`. |
| `cutting[].stepover_mm` or `stepover_pct` | `stepover`, `stepoverUnit` | Exactly one of the two. Percent is turned into mm from `diameter`, to six decimals, and remembered as percent. The same holds for a log entry's `at`. |

Imported tools get new ids. A tool with the same name as one already in the list replaces
it and keeps the existing id. Materials, profiles and groups replace those of the same key
or path, and new ones are added.

### Writing

"Export tools.yaml" on the Tools page writes the tool list in the same format: one key per
line, in the order the tooling library's description gives them. Reading the written file
gives the same tools, rows, materials, profiles and groups.

- A tool's `description` is written as comment lines directly above it. There are no
  other comments.
- Every tool is written with a `group`: one without is written under its kind ("End
  mills", "V-bits"), since the format requires one, and reads back with that group.
- A corner-rounding bit whose name does not say what it is gets `fusion: {type: radius
  mill}`, and a `tip_angle` of 90 when it has none, so that it reads back as one.
- A value equal to its default is left out: an unknown length, a shank as wide as the
  body, a shoulder equal to the flute length.
- Text that a YAML reader of any version could take for a number, a date or a truth value
  is put in double quotes. Dates and times always are.
- A stepover entered in percent is written as `stepover_pct`, to three decimals.
- A corner-rounding bit is written as a `v_bit`; its radius is not written. A radius that
  was changed in the app to something other than half of body minus tip does not survive.
- A material's `label` and `feedsAs` are not written: the format has no key for them. A material without a
  record in either Makera app is written as `<key>: {}`, which the tooling library does
  not accept until the material is given a record there.

The author's real `tools.yaml` is never part of this repository. The tests use a made-up
file that holds every key. `INLAY_TOOLS_YAML=path cargo test -p inlay-core real_tools_yaml`
reads a real file from outside the repository, checks that it comes back the same when
written and read again, and with `INLAY_TOOLS_YAML_OUT=path` keeps the written file, to
run the tooling library's own checks on it.

## Libraries for other programs

Written from the tool list by `inlay-core::export`. They are made as the tooling library
makes them from the `tools.yaml` of the same tools, byte for byte: the fixtures
`crates/inlay-core/tests/fixtures/export-*` are what its generators wrote for the made-up
list `export-library.json`, and the tests require the same bytes.

### Makera CAM and Makera Studio (`.tlslibrary`)

Both are dumps of Qt's `QDataStream` with no header, compression or checksum, all
big-endian: unsigned 32-bit numbers, doubles, one-byte truth values, and text as a byte
length followed by UTF-16, where a length of `0xFFFFFFFF` is null. The layouts, decoded
from one export of each app, are at the top of `export/makera.rs`.

- A tool's id in a library is the one pinned in `ids`, else derived from its name, so
  that the same list gives the same file. Groups and settings likewise.
- Makera CAM: 8 doubles per tool (diameter, 0, tip diameter, half the tip angle, flutes,
  0, 0, 0). No "All" group is written, since importing one adds a group called "All".
  Materials go without their thumbnails, which a tool list does not hold.
- Makera Studio: 13 doubles per tool (shank, `studioUnknown1`, shoulder, flute length,
  diameter, tip diameter, flutes, length, half the tip angle, thread diameter, pitch, 0,
  drill diameter). A setting without a `modified` time gets the time of the export.
- Both apps import only the first top-level group of a file, so several are put under
  one called "Imported".
- Makera CAM drops every byte of value 13 when it reads a library and misreads the rest.
  Cutting values are lowered to the nearest value without one; a count of 13 groups is
  padded with an empty group the app skips; anything else that would hold one (a size
  that would visibly change, a name with `č` in it) is refused.

### Fusion 360 (`.json`)

Autodesk's tool library schema, version 14. An end mill is a `flat end mill`, a ball end
mill a `ball end mill`, a V-bit a `chamfer mill`, a corner-rounding bit a `radius mill`
measured at its pilot, and so on. Every cutting row is a preset named after its material,
with " – " and the profile for a row on one. Tools are ordered by top group, diameter,
flute length and name. Guids are derived from names, so the same list gives the same file.

### Reading an app's export back

`inlay-core::import::makera` reads either layout (whichever takes the whole file) and
compares it with the list at the rounding the writers use, so a library written from the
list shows no differences, except where a value had to be moved for Makera CAM.
