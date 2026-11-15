import { describe, expect, it } from "vitest";
import type { Design, Job } from "../core/types";
import { DEFAULT_SETUP, addDrawing, isInlay, jobToolIds, missingFor, newJob, normaliseDesign, regionOwners } from "./model";

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

describe("jobs", () => {
  const job = (type: Parameters<typeof newJob>[0], regionIds: number[], existing: Job[] = []) => newJob(type, regionIds, existing, DEFAULT_SETUP);

  it("only inlays own shapes and have a colour", () => {
    const inlay = job("vcarve", [1, 2]);
    const contour = job("contour", [2, 3], [inlay]);
    expect(isInlay(inlay.inlay) && !isInlay(contour.inlay)).toBe(true);
    expect(inlay.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(contour.color).toBeUndefined();
    const owners = regionOwners([inlay, contour]);
    expect([...owners.keys()]).toEqual([1, 2]);
    expect(contour.name).toBe("Contour 1");
  });

  it("gives new inlays different woods", () => {
    const a = job("vcarve", [1]);
    const b = job("flat", [2], [a]);
    expect(b.color).not.toBe(a.color);
  });

  it("says what an operation still needs", () => {
    const facing = job("facing", []);
    expect(missingFor(facing)).toMatch(/end mill/);
    if (facing.inlay.type === "facing") facing.inlay.toolId = "t";
    expect(missingFor(facing)).toBeNull();
    expect(jobToolIds(facing)).toEqual(["t"]);
    const chamfer = job("chamfer", []);
    expect(missingFor(chamfer)).toMatch(/shapes/);
    chamfer.regionIds = [1];
    expect(missingFor(chamfer)).toMatch(/corner-rounding/);
    // Facing goes side to side unless asked otherwise; a pocket follows its outline.
    expect(facing.inlay.type === "facing" && facing.inlay.pattern).toBe("raster");
    const pocket = job("pocket", [1]);
    expect(pocket.inlay.type === "pocket" && pocket.inlay.pattern).toBe("offset");
  });
});
