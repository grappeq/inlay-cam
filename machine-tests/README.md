# Machine tests

Files to run on the real machine to confirm what the app assumes about the Carvera
Community Firmware. The assumptions come from reading the firmware source and community
post-processors. The air cut below confirmed them on a real machine.

## m0-air-cut.cnc

An air cut: every move stays at least 5 mm above Z0, inside a 40 x 40 mm area, so no
material is cut. It has two tool changes, so it prompts twice on a Carvera Air. Any bit
will do, and the same bit can be re-inserted at the second prompt.

### Before running

- Read the file. It is 37 lines.
- Set the work origin as usual, with at least 40 x 40 mm of free travel to the right of
  and behind it.
- Set Z0 on the stock top or bed as usual. The lowest move is Z5.
- Keep a hand near the stop button for the first run.

### What to check

| # | Lines | Expected | If it differs |
|---|---|---|---|
| 1 | header | No error or halt on `G90 G94`, `G17`, `G21` or the comment lines | Note the error text |
| 2 | `M6 T1` | Prompt to insert tool 1, wait for the button, then a tool-length measurement | Note what the prompt says and whether it measures |
| 3 | `S6000 M3` | Spindle starts and the machine waits a few seconds before moving | If it moves at once, the post must add a dwell |
| 4 | first `G0` | Moves in X/Y, then Z comes down to 15 mm above Z0 | Note the order of moves |
| 5 | square | A 30 x 30 mm square with four rounded corners (5 mm radius), traced counter-clockwise, 5 mm above Z0 | Wrong direction or straight corners mean the arc format is wrong |
| 6 | `M5`, `M6 T2` | Spindle stops, prompt for tool 2, measurement, spindle stays off | Note anything else |
| 7 | `S8000 M3` | Spindle restarts at a higher speed | |
| 8 | circle | One full clockwise circle, 20 mm diameter | A missing circle means full-circle arcs need splitting |
| 9 | sloped moves | Tool rises to 10 mm then drops back to 5 mm while moving left, in two straight lines | |
| 10 | `G28` | Z retracts first, then the machine goes to its clearance position | If it does anything else, the footer changes |
| 11 | `M30` | Job ends cleanly, spindle off | |

Also worth noting: whether the controller shows the tool names from the `(T1 D=...)`
comment lines in its tool-change prompt.

### Result

Run on 2026-11-15 on a Carvera Air with the Community Firmware. Everything went as
expected: all eleven checks passed, so the post needs no changes.

From the controller's log of the run (firmware 2.2.0c):

- Every line was answered with `ok`; no errors or warnings from the firmware.
- The tool-change prompt is "Please change the tool to: T1". It does not show the tool's
  name from the comment lines.
- `M6` measures the tool length itself, returns to the earlier X/Y at the top of Z and
  reports "Done ATC" before the next line runs.
- The controller did not read the tools from the `(T1 D=...)` comment lines ("0/2 used
  tools have geometry from the tool table"), so its preview drew them with a default
  pointed shape. Its parser wants two spaces after the tool number, as Fusion writes.
  This affects only the controller's preview.

Since that run the tool comment lines, in this file and in the app's files, have the
layout the controller reads: `(T1  name  D=3.175 CR=0 SD=3.175 FL=22 - flat end mill)`.
Nothing else in the file changed. Opened in the controller afterwards, its tool list shows
"T1 · Flat End Mill" and "T2 · Flat End Mill" with the name from the comment line.
