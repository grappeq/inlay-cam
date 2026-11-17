import { describe, expect, it } from "vitest";
import type { Design, Step } from "../core/types";
import { DEFAULT_SETUP, addDrawing, fileNumbers, glueOf, glueStep, insertAfter, isByHand, isInlay, stepToolIds, missingFor, newStep, normaliseDesign, regionOwners, standingPart, trimFacing, trimOf, withoutStep, withoutOrphans } from "./model";

const square = (id: number, x: number, y: number, size: number) => ({
  id,
  outer: [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
  ] as [number, number][],
  holes: [],
});

const design = (regions: Design["regions"], width = 100, height = 80): Design => ({ sourceName: "a.svg", width, height, scale: 1, mirror: false, regions });

describe("normaliseDesign", () => {
  it("leaves a drawing that is neither scaled nor mirrored alone", () => {
    const d = design([square(0, 10, 10, 20)]);
    expect(normaliseDesign(d)).toBe(d);
  });

  it("works the scale and the mirroring into the shapes and the stock", () => {
    const d = { ...design([square(0, 10, 10, 20)]), scale: 2, mirror: true };
    const n = normaliseDesign(d);
    expect([n.width, n.height, n.scale, n.mirror]).toEqual([200, 160, 1, false]);
    // Mirrored about the page (x -> 100 - x), then doubled; still counter-clockwise.
    const xs = n.regions[0].outer.map((p) => p[0]);
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([140, 180]);
    const area = n.regions[0].outer.reduce((sum, [x, y], i, ring) => {
      const [x1, y1] = ring[(i + 1) % ring.length];
      return sum + x * y1 - x1 * y;
    }, 0);
    expect(area / 2).toBeCloseTo(1600);
  });
});

describe("addDrawing", () => {
  it("puts the new shapes in the middle of the stock under new ids", () => {
    const base = design([square(0, 10, 10, 20), square(3, 50, 10, 20)]);
    const more = { ...design([square(0, 500, 500, 10)], 1000, 1000), sourceName: "b.dxf" };
    const { design: out, ids } = addDrawing(base, more);
    expect(ids).toEqual([4]);
    expect(out.regions.map((r) => r.id)).toEqual([0, 3, 4]);
    expect(out.sourceName).toBe("a.svg, b.dxf");
    expect([out.width, out.height]).toEqual([100, 80]);
    expect(out.regions[2].outer[0]).toEqual([45, 35]);
  });

  it("grows the stock for shapes larger than it, and takes a scaled drawing at its true size", () => {
    const base = design([square(0, 10, 10, 20)]);
    const more = { ...design([square(0, 0, 0, 100)], 100, 100), scale: 1.5 };
    const { design: out } = addDrawing(base, more);
    expect([out.width, out.height]).toEqual([150, 150]);
    expect(out.regions[1].outer[0]).toEqual([0, 0]);
    expect(out.sourceName).toBe("a.svg");
  });
});

describe("steps", () => {
  const step = (type: Parameters<typeof newStep>[0], regionIds: number[], existing: Step[] = []) => newStep(type, regionIds, existing, DEFAULT_SETUP);

  it("only inlays own shapes and have a colour", () => {
    const inlay = step("vcarve", [1, 2]);
    const contour = step("contour", [2, 3], [inlay]);
    expect(isInlay(inlay.task) && !isInlay(contour.task)).toBe(true);
    expect(inlay.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(contour.color).toBeUndefined();
    const owners = regionOwners([inlay, contour]);
    expect([...owners.keys()]).toEqual([1, 2]);
    expect(contour.name).toBe("Contour 1");
  });

  it("gives new inlays different woods", () => {
    const a = step("vcarve", [1]);
    const b = step("flat", [2], [a]);
    expect(b.color).not.toBe(a.color);
  });

  it("says what an operation still needs", () => {
    const facing = step("facing", []);
    expect(missingFor(facing)).toMatch(/end mill/);
    if (facing.task.type === "facing") facing.task.toolId = "t";
    expect(missingFor(facing)).toBeNull();
    expect(stepToolIds(facing)).toEqual(["t"]);
    const chamfer = step("chamfer", []);
    expect(missingFor(chamfer)).toMatch(/shapes/);
    chamfer.regionIds = [1];
    expect(missingFor(chamfer)).toMatch(/corner-rounding/);
    // Facing goes side to side unless asked otherwise; a pocket follows its outline.
    expect(facing.task.type === "facing" && facing.task.pattern).toBe("raster");
    const pocket = step("pocket", [1]);
    expect(pocket.task.type === "pocket" && pocket.task.pattern).toBe("offset");
  });

  it("makes a facing that trims a glued-in plug flush", () => {
    const inlay = { ...step("vcarve", [1, 2]), name: "Walnut star", material: "softwood" };
    // 10 mm of plug, 3 mm of it in the pocket.
    expect(standingPart(inlay)).toEqual({ above: 7, margin: 8, what: "plug" });
    const trim = trimFacing(inlay, [inlay], DEFAULT_SETUP)!;
    expect(trim.name).toBe("Trim Walnut star");
    expect(trim.material).toBe("softwood");
    expect(trim.regionIds).toEqual([1, 2]);
    expect(trim.task).toEqual({ type: "facing", above: 7, aboveAuto: true, depth: 0, margin: 8, pattern: "raster", toolId: null });
    // Its height comes from the list, so it has nothing left to choose but its tool.
    expect(missingFor({ ...trim, task: { ...trim.task, above: 0, toolId: "t" } as Step["task"] })).toBeNull();
    expect(trim.color).toBeUndefined();
    // It is found again as the inlay's trim, also with a lower start, until its shapes or its start say otherwise.
    expect(trimOf(inlay, [inlay, trim])).toBe(trim);
    const lower: Step = { ...trim, task: { ...trim.task, above: 1.5 } as Step["task"] };
    expect(trimOf(inlay, [inlay, lower])).toBe(lower);
    expect(trimOf(inlay, [inlay, { ...trim, regionIds: [1] }])).toBeUndefined();
    expect(trimOf(inlay, [inlay, { ...trim, task: { ...trim.task, above: 0, aboveAuto: false } as Step["task"] }])).toBeUndefined();
    expect(trimOf(inlay, [inlay, step("facing", [1, 2])])).toBeUndefined();
    // A second one gets a name of its own.
    expect(trimFacing(inlay, [inlay, trim], DEFAULT_SETUP)!.name).toBe("Trim Walnut star 2");
  });

  it("offers the trim for a plug on a backer only", () => {
    const flat = step("flat", [3]);
    // Loose inserts are not one plug.
    expect(trimFacing(flat, [flat], DEFAULT_SETUP)).toBeNull();
    if (flat.task.type === "flat") Object.assign(flat.task, { insertStyle: "backer", insertThickness: 8, insertMargin: 6 });
    const trim = trimFacing(flat, [flat], DEFAULT_SETUP)!;
    expect(trim.task.type === "facing" && [trim.task.above, trim.task.margin]).toEqual([5, 6]);
    // No plug above the surface, no shapes, or no inlay: nothing to trim.
    if (flat.task.type === "flat") flat.task.insertThickness = 3;
    expect(trimFacing(flat, [flat], DEFAULT_SETUP)).toBeNull();
    expect(trimFacing(step("vcarve", []), [], DEFAULT_SETUP)).toBeNull();
    expect(trimFacing(step("pocket", [1]), [], DEFAULT_SETUP)).toBeNull();
  });

  it("makes a glue-up for an inlay, which goes when the inlay goes", () => {
    const inlay = { ...step("vcarve", [1]), name: "Walnut star" };
    const pocket = step("pocket", [2], [inlay]);
    expect(glueStep(pocket, [inlay, pocket])).toBeNull();
    const glue = glueStep(inlay, [inlay, pocket])!;
    expect(glue.name).toBe("Glue in Walnut star");
    expect(glue.task).toEqual({ type: "glue", inlayId: inlay.id });
    expect(isByHand(glue.task) && !isInlay(glue.task)).toBe(true);
    // Done by hand: no shapes, no tools, nothing to choose.
    expect([glue.regionIds, stepToolIds(glue), missingFor(glue)]).toEqual([[], [], null]);
    expect(regionOwners([inlay, glue]).size).toBe(1);

    // It goes in right after its inlay, and the trim after it.
    const list = insertAfter([inlay, pocket], inlay.id, glue);
    expect(list).toEqual([inlay, glue, pocket]);
    expect(glueOf(inlay, list)).toBe(glue);
    expect(insertAfter(list, undefined, pocket).length).toBe(4);

    expect(withoutStep(list, pocket.id)).toEqual([inlay, glue]);
    expect(withoutStep(list, glue.id)).toEqual([inlay, pocket]);
    expect(withoutStep(list, inlay.id)).toEqual([pocket]);
    // A list with nothing orphaned comes back as it is.
    expect(withoutOrphans(list)).toBe(list);

    // The lines from one glue-up to the next share a file; the glue-up is in none.
    const trim = trimFacing(inlay, list, DEFAULT_SETUP)!;
    expect(fileNumbers(list)).toEqual([1, null, 2]);
    expect(fileNumbers([inlay, pocket, glue, trim, pocket])).toEqual([1, 1, null, 2, 2]);
    expect(fileNumbers([glue, glue, inlay])).toEqual([null, null, 1]);
    expect(fileNumbers([inlay, pocket])).toEqual([1, 1]);
    // A trim that takes its height from the list is still found as the inlay's.
    expect(trimOf(inlay, [inlay, { ...trim, task: { ...trim.task, above: 0 } as Step["task"] }])).toBeDefined();
  });
});
