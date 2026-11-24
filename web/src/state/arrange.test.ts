import { describe, expect, it } from "vitest";
import type { Design, DesignRegion, Project, Ring } from "../core/types";
import {
  boxOf,
  duplicateShapes,
  emptiedSteps,
  keepOnly,
  mirrorShapes,
  moveShapes,
  partOf,
  removeShapes,
  rotateShapes,
  scaleShapes,
  shapesInBox,
  stretchShapes,
  trimBoard,
  withInside,
} from "./arrange";

const square = (x0: number, y0: number, x1: number, y1: number): Ring => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const hole = (x0: number, y0: number, x1: number, y1: number): Ring => [...square(x0, y0, x1, y1)].reverse();

/** A plate (0) with a ring (1) in it and a disc (2) in the ring, and a second plate (3) beside it. */
function design(): Design {
  return {
    sourceName: "test.dxf",
    width: 130,
    height: 60,
    scale: 1,
    mirror: false,
    regions: [
      { id: 0, outer: square(10, 10, 70, 50), holes: [hole(20, 20, 40, 40)] },
      { id: 1, outer: square(20, 20, 40, 40), holes: [hole(25, 25, 35, 35)] },
      { id: 2, outer: square(25, 25, 35, 35), holes: [] },
      { id: 3, outer: square(80, 10, 120, 50), holes: [] },
    ],
  };
}

const shape = (d: Design, id: number): DesignRegion => d.regions.find((r) => r.id === id)!;
const area = (ring: Ring) => ring.reduce((sum, [x, y], i) => sum + x * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * y, 0) / 2;
const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

function project(): Project {
  return {
    id: "p",
    name: "Test",
    design: design(),
    tools: [],
    base: { thickness: 18, material: "hardwood" },
    machine: { name: "Carvera Air", minRpm: 5000, maxRpm: 13000, rapidRate: 2000, travel: [300, 200], firstTool: 1 },
    setup: { safeHeight: 5, plungeClearance: 1, throughCut: 0.2, tabWidth: 4, tabSpacing: 40, tabThickness: 1, cutOutBorder: 5, rampAngle: 5, finishAllowance: 0.1, insertFitExtra: 0.5 },
    steps: [
      { id: "a", name: "Ring", material: "hardwood", regionIds: [1], task: { type: "flat" } as never },
      { id: "b", name: "Plates", material: "hardwood", regionIds: [0, 3], task: { type: "flat" } as never },
    ],
  };
}

describe("parts", () => {
  it("are an outer outline with everything inside it", () => {
    const d = design();
    expect(sorted(partOf(d, 2))).toEqual([0, 1, 2]);
    expect(partOf(d, 3)).toEqual([3]);
    expect(sorted(withInside(d, [1]))).toEqual([1, 2]);
  });

  it("do not include a loose shape that merely lies in the same rectangle", () => {
    const d = design();
    // An L-shaped plate's bounding box holds the small square, its outline does not.
    d.regions.push({
      id: 4,
      outer: [
        [0, 0],
        [9, 0],
        [9, 5],
        [5, 5],
        [5, 9],
        [0, 9],
      ],
      holes: [],
    });
    d.regions.push({ id: 5, outer: square(6, 6, 8, 8), holes: [] });
    expect(partOf(d, 4)).toEqual([4]);
  });
});

describe("deleting", () => {
  it("of an outline and what is inside it closes the hole they filled", () => {
    const p = removeShapes(project(), [1, 2]);
    expect(sorted(p.design!.regions.map((r) => r.id))).toEqual([0, 3]);
    expect(shape(p.design!, 0).holes).toEqual([]);
  });

  it("of an inner outline makes the shape around it solid", () => {
    const p = removeShapes(project(), [2]);
    expect(shape(p.design!, 1).holes).toEqual([]);
    expect(shape(p.design!, 0).holes.length).toBe(1);
  });

  it("removes an inlay left without shapes and trims the others", () => {
    expect(emptiedSteps(project(), [1])).toEqual(["Ring"]);
    const p = removeShapes(project(), [1]);
    expect(p.steps.map((j) => j.id)).toEqual(["b"]);
    const q = removeShapes(project(), [3]);
    expect(q.steps.find((j) => j.id === "b")!.regionIds).toEqual([0]);
  });

  it("of everything else keeps one part on a board of its own", () => {
    const p = keepOnly(project(), [3], 5);
    expect(p.design!.regions.map((r) => r.id)).toEqual([3]);
    expect([p.design!.width, p.design!.height]).toEqual([50, 50]);
    expect(boxOf(p.design!.regions)).toEqual([5, 5, 45, 45]);
    expect(p.steps.map((j) => [j.id, j.regionIds])).toEqual([["b", [3]]]);
  });
});

describe("moving", () => {
  it("takes the hole along while the shape stays inside the plate", () => {
    const d = moveShapes(design(), [1, 2], 5, 0);
    expect(boxOf([shape(d, 2)])).toEqual([30, 25, 40, 35]);
    expect(shape(d, 0).holes.length).toBe(1);
    expect(Math.min(...shape(d, 0).holes[0].map((p) => p[0]))).toBe(25);
    expect(sorted(partOf(d, 1))).toEqual([0, 1, 2]);
  });

  it("into another plate closes the old hole and opens one there", () => {
    const d = moveShapes(design(), [1, 2], 70, 0);
    expect(shape(d, 0).holes).toEqual([]);
    expect(shape(d, 3).holes.length).toBe(1);
    expect(area(shape(d, 3).holes[0])).toBeLessThan(0);
    expect(sorted(partOf(d, 2))).toEqual([1, 2, 3]);
  });

  it("takes a disc for what fills a hole although the two outlines are a rounding error apart", () => {
    // A disc in its hole, the two outlines a rounding error apart.
    const circle = (r: number, turn: number): Ring =>
      Array.from({ length: 64 }, (_, i) => [50 + r * Math.cos((i / 64) * 2 * Math.PI + turn), 30 + r * Math.sin((i / 64) * 2 * Math.PI + turn)]);
    const e = design();
    e.regions = [
      { id: 0, outer: square(10, 5, 90, 55), holes: [[...circle(12 + 1.2e-7, 0)].reverse()] },
      { id: 1, outer: circle(12, 1e-8), holes: [] },
    ];
    expect(sorted(partOf(e, 1))).toEqual([0, 1]);
  });

  it("goes past any edge of the board, which stays the size it was", () => {
    const left = moveShapes(design(), [0], -500, -500);
    expect(boxOf([shape(left, 0)])).toEqual([-490, -490, -430, -450]);
    expect([left.width, left.height]).toEqual([130, 60]);
    const right = moveShapes(design(), [3], 100, 30);
    expect(boxOf([shape(right, 3)])).toEqual([180, 40, 220, 80]);
    expect([right.width, right.height]).toEqual([130, 60]);
  });
});

describe("resizing, mirroring and turning", () => {
  it("keep outlines counter-clockwise and holes clockwise", () => {
    const all = [0, 1, 2];
    for (const d of [mirrorShapes(design(), all, "x"), mirrorShapes(design(), all, "y"), rotateShapes(design(), all, 90), scaleShapes(design(), all, 0.5, "left")]) {
      for (const id of [0, 1, 2]) {
        expect(area(shape(d, id).outer)).toBeGreaterThan(0);
        for (const h of shape(d, id).holes) expect(area(h)).toBeLessThan(0);
      }
      expect(sorted(partOf(d, 2))).toEqual([0, 1, 2]);
    }
  });

  it("mirror in place", () => {
    const d = mirrorShapes(design(), [0, 1, 2], "x");
    expect(boxOf([shape(d, 0)])).toEqual([10, 10, 70, 50]);
    // The ring was 10 from the plate's left edge; now it is 10 from its right.
    expect(boxOf([shape(d, 1)])).toEqual([40, 20, 60, 40]);
  });

  it("turn about the middle, exactly for quarter turns", () => {
    const d = rotateShapes(design(), [0, 1, 2], 90);
    expect(boxOf([shape(d, 0)])).toEqual([20, 0, 60, 60]);
    const back = rotateShapes(d, [0, 1, 2], -90);
    expect(boxOf([shape(back, 1)])).toEqual([20, 20, 40, 40]);
  });

  it("stretch one way only, from any corner or the middle", () => {
    const wide = stretchShapes(design(), [3], 0.5, 1, [1, 1]);
    expect(boxOf([shape(wide, 3)])).toEqual([100, 10, 120, 50]);
    const middle = stretchShapes(design(), [3], 0.5, 0.5, [0.5, 0.5]);
    expect(boxOf([shape(middle, 3)])).toEqual([90, 20, 110, 40]);
    // The ring and the disc in the plate stretch with it, and stay its hole.
    const plate = stretchShapes(design(), [0, 1, 2], 1, 0.5, [0, 1]);
    expect(boxOf([shape(plate, 1)])).toEqual([20, 35, 40, 45]);
    expect(sorted(partOf(plate, 2))).toEqual([0, 1, 2]);
  });

  it("scale from the corner that stays put", () => {
    const d = scaleShapes(design(), [3], 2, "left");
    expect(boxOf([shape(d, 3)])).toEqual([80, 10, 160, 90]);
    expect([d.width, d.height]).toEqual([130, 60]);
  });
});

describe("copying", () => {
  it("makes a second part beside the first, with new ids", () => {
    const { design: d, ids } = duplicateShapes(design(), [0, 1, 2], 5);
    expect(ids.length).toBe(3);
    expect(new Set([...ids, 0, 1, 2, 3]).size).toBe(7);
    const outerCopy = d.regions.find((r) => ids.includes(r.id) && r.outer.length === 4 && boxOf([r])![2] - boxOf([r])![0] === 60)!;
    expect(boxOf([outerCopy])).toEqual([75, 10, 135, 50]);
    expect(sorted(partOf(d, outerCopy.id))).toEqual(sorted(ids));
  });
});

describe("the board", () => {
  it("is trimmed to the shapes plus a margin", () => {
    const d = trimBoard(design(), 2);
    expect([d.width, d.height]).toEqual([114, 44]);
    expect(boxOf(d.regions)).toEqual([2, 2, 112, 42]);
    expect(sorted(partOf(d, 2))).toEqual([0, 1, 2]);
  });

  it("finds the shapes inside a dragged box", () => {
    expect(sorted(shapesInBox(design(), [15, 15, 45, 45]))).toEqual([1, 2]);
  });
});

describe("an outline without what is inside it", () => {
  it("moves without what is inside it, and the holes follow where everything lies", () => {
    // The ring leaves the first plate for the second; its disc stays behind.
    const d = moveShapes(design(), [1], 65, 0);
    expect(boxOf([shape(d, 1)])).toEqual([85, 20, 105, 40]);
    expect(boxOf([shape(d, 2)])).toEqual([25, 25, 35, 35]);
    expect(shape(d, 1).holes).toEqual([]);
    // The first plate's hole is now the disc's; the second plate has one for the ring.
    expect(shape(d, 0).holes.length).toBe(1);
    expect(area(shape(d, 0).holes[0])).toBe(-100);
    expect(shape(d, 3).holes.length).toBe(1);
    expect(area(shape(d, 3).holes[0])).toBe(-400);
    expect(sorted(partOf(d, 2))).toEqual([0, 2]);
    expect(sorted(partOf(d, 1))).toEqual([1, 3]);
  });

  it("is resized about what stays inside it", () => {
    const d = stretchShapes(design(), [1], 1.2, 1.2, [0.5, 0.5]);
    expect(boxOf([shape(d, 1)])).toEqual([18, 18, 42, 42]);
    expect(boxOf([shape(d, 2)])).toEqual([25, 25, 35, 35]);
    expect(shape(d, 1).holes.length).toBe(1);
    expect(area(shape(d, 1).holes[0])).toBe(-100);
    expect(area(shape(d, 0).holes[0])).toBeCloseTo(-576, 9);
    expect(sorted(partOf(d, 2))).toEqual([0, 1, 2]);
  });

  it("is deleted without what is inside it", () => {
    const p = removeShapes(project(), [1]);
    expect(sorted(p.design!.regions.map((r) => r.id))).toEqual([0, 2, 3]);
    expect(shape(p.design!, 0).holes.length).toBe(1);
    expect(area(shape(p.design!, 0).holes[0])).toBe(-100);
    // The outermost outline goes, and what was in it is a part of its own.
    const q = removeShapes(project(), [0]);
    expect(sorted(q.design!.regions.map((r) => r.id))).toEqual([1, 2, 3]);
    expect(sorted(partOf(q.design!, 2))).toEqual([1, 2]);
  });

  it("is copied without the holes of what is inside it", () => {
    const { design: d, ids } = duplicateShapes(design(), [1], 100);
    expect(ids.length).toBe(1);
    expect(shape(d, ids[0]).holes).toEqual([]);
    expect(shape(d, 1).holes.length).toBe(1);
  });
});
