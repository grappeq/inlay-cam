import { describe, expect, it } from "vitest";
import type { Design, Ring } from "../core/types";
import { addShape, partOf, removeShapes } from "./arrange";
import { DEFAULT_DRAW_OPTIONS, FLATTEN, drawnRing, ellipseRing, polygonRing, rectangleRing } from "./shapes";

const area = (ring: Ring) => ring.reduce((sum, [x, y], i) => sum + x * ring[(i + 1) % ring.length][1] - ring[(i + 1) % ring.length][0] * y, 0) / 2;
const box = (ring: Ring) => [Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1])), Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1]))];
const close = (got: number[], want: number[]) => got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 9));
/** The longest run of an outline. */
const longest = (ring: Ring) => Math.max(...ring.map((p, i) => Math.hypot(ring[(i + 1) % ring.length][0] - p[0], ring[(i + 1) % ring.length][1] - p[1])));

describe("drawn outlines", () => {
  it("a rectangle is four corners, counter-clockwise", () => {
    const ring = rectangleRing(10, 20, 40, 30);
    expect(ring).toEqual([
      [10, 20],
      [40, 20],
      [40, 30],
      [10, 30],
    ]);
    expect(area(ring)).toBe(300);
  });

  it("a rounded rectangle fills its box and loses its corners", () => {
    const ring = rectangleRing(10, 20, 40, 30, 3);
    expect(box(ring)).toEqual([10, 20, 40, 30]);
    // Four squares of side r become four quarter discs.
    const exact = 300 - (4 - Math.PI) * 9;
    expect(area(ring)).toBeLessThanOrEqual(exact);
    expect(area(ring)).toBeGreaterThan(exact - 0.2);
    // Its straight sides are single runs.
    expect(longest(ring)).toBeCloseTo(24, 9);
  });

  it("a corner radius is held to half the shorter side, without repeated points", () => {
    const ring = rectangleRing(0, 0, 30, 10, 99);
    expect(box(ring)).toEqual([0, 0, 30, 10]);
    expect(longest(ring)).toBeCloseTo(20, 9);
    ring.forEach((p, i) => expect(Math.hypot(p[0] - ring[(i + 1) % ring.length][0], p[1] - ring[(i + 1) % ring.length][1])).toBeGreaterThan(1e-6));
  });

  it("an ellipse touches its box and stays within the flattening tolerance", () => {
    const ring = ellipseRing(5, 5, 65, 45);
    expect(box(ring)).toEqual([5, 5, 65, 45]);
    expect(area(ring)).toBeGreaterThan(0);
    // The middle of every run is no further inside the true ellipse than the tolerance.
    ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length];
      const mx = ((p[0] + q[0]) / 2 - 35) / 30;
      const my = ((p[1] + q[1]) / 2 - 25) / 20;
      expect((1 - Math.hypot(mx, my)) * 30).toBeLessThanOrEqual(FLATTEN + 1e-9);
    });
    // Inscribed, so a little smaller than the true ellipse: by under a thousandth.
    expect(area(ring) / (Math.PI * 30 * 20)).toBeGreaterThan(0.999);
    expect(area(ring) / (Math.PI * 30 * 20)).toBeLessThanOrEqual(1);
  });

  it("a small circle still looks round", () => {
    expect(ellipseRing(0, 0, 0.5, 0.5).length).toBeGreaterThanOrEqual(12);
  });

  it("a polygon has its first corner where it is pointed", () => {
    const ring = polygonRing(50, 50, 10, 6, Math.PI / 2);
    expect(ring.length).toBe(6);
    close(ring[0], [50, 60]);
    expect(area(ring)).toBeCloseTo(((3 * Math.sqrt(3)) / 2) * 100, 9);
  });

});

describe("a drag with a drawing tool", () => {
  const options = { ...DEFAULT_DRAW_OPTIONS };
  const draw = (tool: Parameters<typeof drawnRing>[0], from: [number, number], to: [number, number], even = false, centred = false) =>
    drawnRing(tool, options, from, to, even, centred);

  it("fills the box between its ends, whichever way it goes", () => {
    expect(box(draw("rectangle", [10, 10], [40, 30])!)).toEqual([10, 10, 40, 30]);
    expect(box(draw("rectangle", [40, 30], [10, 10])!)).toEqual([10, 10, 40, 30]);
    expect(box(draw("ellipse", [40, 10], [10, 30])!)).toEqual([10, 10, 40, 30]);
    expect(area(draw("rectangle", [40, 30], [10, 10])!)).toBe(600);
  });

  it("with Shift makes a square or a circle, from the longer side", () => {
    expect(box(draw("rectangle", [10, 10], [40, 30], true)!)).toEqual([10, 10, 40, 40]);
    expect(box(draw("ellipse", [50, 50], [45, 20], true)!)).toEqual([20, 20, 50, 50]);
  });

  it("with Ctrl draws about where it began", () => {
    expect(box(draw("rectangle", [50, 50], [60, 55], false, true)!)).toEqual([40, 45, 60, 55]);
    expect(box(draw("ellipse", [50, 50], [60, 55], true, true)!)).toEqual([40, 40, 60, 60]);
  });

  it("stops at the stock's left and bottom edges", () => {
    expect(box(draw("rectangle", [10, 10], [-20, -5])!)).toEqual([0, 0, 10, 10]);
    expect(box(draw("rectangle", [-3, -3], [20, 10])!)).toEqual([0, 0, 20, 10]);
    // A square stays a square, and a shape drawn from its middle stays about it.
    expect(box(draw("rectangle", [10, 30], [-20, 0], true)!)).toEqual([0, 20, 10, 30]);
    expect(box(draw("ellipse", [10, 30], [60, 80], false, true)!)).toEqual([0, 0, 20, 60]);
    const hexagon = box(draw("polygon", [8, 30], [80, 30])!);
    expect(hexagon[0]).toBeCloseTo(0, 9);
    expect(hexagon[2]).toBeCloseTo(16, 9);
  });

  it("puts a polygon's first corner under the pointer", () => {
    close(draw("polygon", [50, 50], [50, 70])![0], [50, 70]);
    expect(draw("polygon", [50, 50], [50, 70])!.length).toBe(6);
  });

  it("with Shift turns a polygon in steps of 15 degrees", () => {
    const first = draw("polygon", [50, 50], [51, 70], true)![0];
    expect(first[0]).toBeCloseTo(50, 9);
    expect(first[1]).toBeCloseTo(50 + Math.hypot(1, 20), 9);
  });

  it("draws nothing while it is too small", () => {
    expect(draw("rectangle", [10, 10], [10.2, 40])).toBeNull();
    expect(draw("ellipse", [10, 10], [10, 10])).toBeNull();
    expect(draw("polygon", [10, 10], [10.1, 10.1])).toBeNull();
    expect(draw("rectangle", [0, 10], [-5, 40])).toBeNull();
  });
});

describe("a drawn shape joins the drawing", () => {
  const square = (x0: number, y0: number, x1: number, y1: number) => rectangleRing(x0, y0, x1, y1);
  const design = (): Design => ({
    sourceName: "",
    width: 100,
    height: 80,
    scale: 1,
    mirror: false,
    regions: [
      { id: 0, outer: square(10, 10, 50, 50), holes: [] },
      { id: 4, outer: square(60, 10, 70, 20), holes: [] },
    ],
  });
  const shape = (d: Design, id: number) => d.regions.find((r) => r.id === id)!;

  it("as a new shape with the next id", () => {
    const { design: d, id } = addShape(design(), ellipseRing(60, 40, 80, 60));
    expect(id).toBe(5);
    expect(d.regions.length).toBe(3);
    expect(shape(d, 5).holes).toEqual([]);
  });

  it("on an empty stock", () => {
    const { design: d, id } = addShape({ ...design(), regions: [] }, square(10, 10, 20, 20));
    expect(id).toBe(0);
    expect(d.regions.length).toBe(1);
  });

  it("counter-clockwise, however it was drawn", () => {
    const { design: d, id } = addShape(design(), [...square(60, 40, 80, 60)].reverse());
    expect(area(shape(d, id).outer)).toBe(400);
  });

  it("as a hole in the shape it lies inside", () => {
    const { design: d, id } = addShape(design(), ellipseRing(20, 20, 40, 40));
    expect(shape(d, 0).holes.length).toBe(1);
    expect(area(shape(d, 0).holes[0])).toBeCloseTo(-area(shape(d, id).outer), 9);
    expect(partOf(d, id).sort()).toEqual([0, id]);
    // Deleting it closes the hole again.
    const project = { design: d, steps: [] } as unknown as Parameters<typeof removeShapes>[0];
    expect(shape(removeShapes(project, [id]).design!, 0).holes).toEqual([]);
  });

  it("with holes for the parts that lie inside it", () => {
    const { design: d, id } = addShape(design(), square(5, 5, 75, 55));
    expect(shape(d, id).holes.length).toBe(2);
    expect(partOf(d, 0).sort()).toEqual([0, 4, id]);
  });

  it("and is left whole, like the other, when it only partly covers it", () => {
    const { design: d, id } = addShape(design(), square(40, 40, 60, 60));
    expect(shape(d, id).holes).toEqual([]);
    expect(shape(d, 0).holes).toEqual([]);
  });

  it("and makes the stock grow to hold it", () => {
    const { design: d } = addShape(design(), square(90, 70, 120, 95));
    expect([d.width, d.height]).toEqual([120, 95]);
  });
});
