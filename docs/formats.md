# File formats

The app writes two kinds of file, both JSON, and reads two foreign formats (SVG drawings
and the tooling library's `tools.yaml`).

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

Exported from the Tools view as `tools.inlay-tools.json`.

```json
{
  "app": "wooden-inlays",
  "kind": "tool-library",
  "formatVersion": 1,
  "tools": [
    {
      "id": "0a6c…",
      "name": "60° V-groove Ø12 S6",
      "kind": "v_bit",
      "diameter": 12.0,
      "tipDiameter": 0.1,
      "tipAngle": 60.0,
      "fluteLength": 15.5,
      "shankDiameter": 6.0,
      "length": 46.5,
      "flutes": 2,
      "cutting": [
        { "material": "hardwood", "rpm": 12000, "feed": 500.0, "plunge": 150.0, "stepover": 0.2, "stepdown": 1.0 }
      ]
    }
  ]
}
```

### Tool

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique within the list. Jobs refer to tools by it. Not shown to the user. |
| `name` | yes | Not empty. |
| `kind` | yes | `flat_end` or `v_bit`. |
| `diameter` | yes | Cutting diameter. For a V-bit, the diameter at the top of the cone. Greater than 0. |
| `tipDiameter` | V-bit, optional | Diameter of the flat at the tip. Missing or 0 means a perfect point. Must be smaller than `diameter`. |
| `tipAngle` | V-bit, required | Included angle between the two cutting edges, between 0 and 180. |
| `fluteLength` | no | Length of the cutting edges along the axis: the deepest the tool can cut. Missing means unknown. |
| `shankDiameter` | yes | Greater than 0. |
| `length` | no | Overall length. Missing means unknown. |
| `flutes` | no | Number of cutting edges. |
| `cutting` | no | List of cutting settings, at most one per material. |

### Cutting settings

| Field | Meaning |
|---|---|
| `material` | `hardwood` or `softwood`. |
| `rpm` | Spindle speed, whole number greater than 0. |
| `feed` | Feed rate while cutting sideways, mm/min. |
| `plunge` | Feed rate while cutting straight down, mm/min. |
| `stepover` | Sideways distance between passes, mm. Not larger than `diameter`. |
| `stepdown` | Depth per pass, mm. |

When a tool file is imported, a tool with the same name as one already in the list
replaces it and keeps the existing id; other tools are added.

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
    "tools": []
  }
}
```

| Field | Meaning |
|---|---|
| `id` | Identifies the project in browser storage. |
| `name` | Shown in the header; used for the export file name. |
| `design` | The imported drawing, or `null`. |
| `jobs` | The inlays. |
| `tools` | Copies of every tool the jobs refer to, in the tool format above. They let the project open correctly in a browser with a different tool list. While a tool with the same id exists in the user's list, the list's version is used and the copy is refreshed from it. |

### Design

| Field | Meaning |
|---|---|
| `sourceName` | File name the drawing was imported from. |
| `width`, `height` | Size of the drawing's page as imported, before `scale`. |
| `scale` | Uniform scale applied when the regions are used. Default 1. |
| `mirror` | Flip the whole design left to right. Default false. Corrects a drawing that was made mirrored; plugs are mirrored automatically and do not use this. |
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

One inlay: a pocket and its matching plug or insert.

| Field | Meaning |
|---|---|
| `id` | Unique within the project. |
| `name` | Shown in the inlay list. |
| `material` | `hardwood` or `softwood`: which cutting settings of each tool are used. |
| `regionIds` | The design regions this inlay covers. Each must exist in the design. |
| `inlay` | Type and parameters, below. |

`inlay` for a V-carve inlay:

| Field | Meaning |
|---|---|
| `type` | `vcarve` |
| `engagementDepth` | How deep the plug sits in the pocket. Greater than 0. |
| `glueGap` | Space left under the plug. 0 or more. Pocket depth = engagement depth + glue gap. |
| `sawGap` | Space between the pocket surface and the plug's backer. Greater than 0. |
| `clearingToolIds` | Flat end mills that clear the pocket floor. A list so several tools can share the work in a later version; version 1 of the app uses the first. |
| `vbitToolId` | The V-bit, or `null` when not chosen yet. |

`inlay` for a flat pocket inlay:

| Field | Meaning |
|---|---|
| `type` | `flat` |
| `pocketDepth` | Greater than 0. |
| `allowance` | Total gap between insert and pocket wall. 0 or more. |
| `tabs` | Hold the insert to its stock with tabs while it is cut out. Default false. |
| `toolId` | The flat end mill, or `null`. Inside corners of both parts cannot be sharper than its radius. |

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
- Left out, and reported after import: paths with a stroke but no fill, text that has not
  been converted to outlines, embedded images, and filled areas under 0.01 mm².
- Clip paths and masks are ignored: the full shape is imported.

## `tools.yaml` import

Read by `crates/inlay-core/src/import/tools_yaml.rs`. Only the fields below are read;
everything else in the file is ignored.

| `tools.yaml` | Becomes | Notes |
|---|---|---|
| `tools[].name` | `name` | |
| `tools[].type` | `kind` | Only `flat_end` and `v_bit` are imported. `ball_end`, `drill` and `thread_mill` are left out. |
| `tools[].fusion.type` | (filter) | A `v_bit` with `radius mill` is a corner-rounding cutter and is left out. Without this key, a `v_bit` whose name contains "fillet", "corner round" or "radius" and whose tip is narrower than its body is left out too, as the tooling library itself decides. |
| `geometry.diameter` | `diameter` | Required. |
| `geometry.tip_diameter` | `tipDiameter` | V-bits only. The tooling library's default (the body diameter) is not a V shape, so a V-bit without it is left out. |
| `geometry.tip_angle` | `tipAngle` | V-bits only. Ignored on flat end mills, where the Makera apps store a meaningless 60. |
| `geometry.flute_length` | `fluteLength` | 0 or missing means unknown. |
| `geometry.shank_diameter` | `shankDiameter` | Defaults to `diameter`. |
| `geometry.length` | `length` | 0 or missing means unknown. |
| `geometry.flutes` | `flutes` | 0 or missing means unknown. |
| `cutting[]` with `material: hardwood` or `softwood` and no `toolpath` | `cutting` | `rpm`, `feed`, `plunge`, `stepdown` as they are. |
| `cutting[].stepover_mm` or `stepover_pct` | `stepover` | Percent is converted to mm from `diameter`. |

Not read: `ids`, `number`, `coating`, `style`, `recommended_for`, `apps`, `source`,
`inventory`, `verify`, cutting rows for other materials, cutting rows with a `toolpath`
(such as adaptive clearing), and the top-level `materials`, `toolpaths` and `groups`.

Imported tools get new ids. A tool with the same name as one already in the list replaces
it and keeps the existing id.
