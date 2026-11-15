import { describe, expect, it } from "vitest";
import type { Built } from "../core/types";
import { dimensionMarks, surfaceHit } from "./dimensions";

function built(change: Partial<Built>): Built {
  return {
    part: "plug",
    stock: { width: 100, height: 80, thickness: 10, through: 0 },
    cuttable: [],
    flatFit: null,
    narrow: [],
    fileName: "",
    gcode: "",
    stats: { lines: 0, cuttingLength: 0, minutes: 0, tools: [], toolChanges: 0, perTool: [] },
    warnings: [],
    piece: null,
    cutWidth: null,
    shapes: null,
    ...change,
  };
}

describe("dimensionMarks", () => {
  it("always gives the board's three sizes", () => {
    const { marks, outlines } = dimensionMarks(built({}));
    expect(marks.map((m) => m.text)).toEqual(["X 100", "Y 80", "10 thick"]);
    expect(outlines).toEqual([]);
  });

  it("gives a plug blank's margin once when it is the same all round", () => {
    const { marks, outlines } = dimensionMarks(built({ shapes: [8, 8, 92, 72] }));
    expect(marks.slice(3).map((m) => m.text)).toEqual(["margin 8", "margin 8"]);
    expect(outlines).toEqual([{ rect: [8, 8, 92, 72], text: "shapes 84 × 64", labelInside: true }]);
  });

  it("gives every distance to the edge of a base board when they differ", () => {
    const { marks } = dimensionMarks(built({ part: "pocket", shapes: [10, 20, 70, 75] }));
    expect(marks.slice(3).map((m) => m.text)).toEqual(["10 to edge", "20 to edge", "30 to edge", "5 to edge"]);
  });

  it("measures a cut-out plug's border, cut and margin from the plug", () => {
    const { marks, outlines } = dimensionMarks(built({ piece: [9, 9, 91, 71], cutWidth: 3.175, shapes: [15, 15, 85, 65] }));
    expect(marks.slice(3).map((m) => m.text)).toEqual(["border 9", "margin 6", "cut 3.175"]);
    expect(outlines.map((o) => o.text)).toEqual(["plug 82 × 62", "shapes 70 × 50"]);
    // The cut lies just outside the plug, below the middle of the shapes.
    expect(marks[5].a).toEqual([50, 9 - 3.175, 0]);
    expect(marks[5].b).toEqual([50, 9, 0]);
  });
});

describe("surfaceHit", () => {
  // A 10 x 10 mm board in 1 mm cells with a 2 mm deep pocket over x 4..6, y 4..6.
  const heights = new Float32Array(100);
  for (let iy = 4; iy < 6; iy++) for (let ix = 4; ix < 6; ix++) heights[iy * 10 + ix] = -2;
  const map = { nx: 10, ny: 10, cell: 1, heights };

  it("reads the surface straight down", () => {
    expect(surfaceHit(map, [2.5, 3.5, 50], [0, 0, -1])).toEqual({ x: 2.5, y: 3.5, z: 0 });
    expect(surfaceHit(map, [5, 5, 50], [0, 0, -1])).toEqual({ x: 5, y: 5, z: -2 });
  });

  it("finds where a slanted ray lands", () => {
    // From the front and above, aimed at (5, 1, 0).
    const hit = surfaceHit(map, [5, -9, 10], [0, 1, -1])!;
    expect(hit.x).toBeCloseTo(5, 6);
    expect(hit.y).toBeCloseTo(1, 2);
    expect(hit.z).toBe(0);
  });

  it("looks into a pocket past its near rim", () => {
    // Steep enough to clear the rim at y = 4 and land on the floor.
    const floor = surfaceHit(map, [5, 3.6, 2], [0, 1, -2])!;
    expect(floor.z).toBe(-2);
    expect(floor.y).toBeCloseTo(5.6, 2);
    // Shallower, the ray crosses the pocket and meets its far wall, where the surface is the board's top.
    const wall = surfaceHit(map, [5, 2.5, 2], [0, 1, -1])!;
    expect(wall.y).toBeCloseTo(6, 2);
    expect(wall.z).toBe(0);
    // Shallower still, it lands on the board before the pocket.
    expect(surfaceHit(map, [5, 1, 2], [0, 1, -1])!.y).toBeCloseTo(3, 2);
  });

  it("misses beside the board, looking away, and through a side", () => {
    expect(surfaceHit(map, [20, 5, 50], [0, 0, -1])).toBeNull();
    expect(surfaceHit(map, [5, 5, 50], [0, 0, 1])).toBeNull();
    expect(surfaceHit(map, [5, -9, 10], [0, -1, -1])).toBeNull();
    expect(surfaceHit(map, [5, -5, -1], [0, 1, 0])).toBeNull();
  });
});
