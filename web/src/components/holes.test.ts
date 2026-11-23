import { describe, expect, it } from "vitest";
import { reliefRange } from "../agent/render";
import { isHole, openSurface } from "./holes";

describe("isHole", () => {
  it("is a cut that reaches the bottom of the board or goes past it", () => {
    expect(isHole(-6.2, 6)).toBe(true);
    expect(isHole(-6, 6)).toBe(true);
    // As the simulation keeps it, in single precision.
    expect(isHole(Math.fround(-0.8), 0.8)).toBe(true);
    expect(isHole(-5.99, 6)).toBe(false);
    expect(isHole(0, 6)).toBe(false);
    expect(isHole(NaN, 6)).toBe(false);
    expect(isHole(-Infinity, 6)).toBe(false);
  });
});

/** The triangles of an index, each as its sorted corners. */
function triangles(index: Uint32Array): string[] {
  const out: string[] = [];
  for (let t = 0; t < index.length; t += 3) out.push([...index.slice(t, t + 3)].sort((a, b) => a - b).join(","));
  return out.sort();
}

/** The rims, each as its sorted ends. */
function edges(rims: number[]): string[] {
  const out: string[] = [];
  for (let r = 0; r < rims.length; r += 2) out.push([rims[r], rims[r + 1]].sort((a, b) => a - b).join(","));
  return out.sort();
}

describe("openSurface", () => {
  it("without holes is every square as two triangles, with no rims", () => {
    const { index, rims } = openSurface(3, 3, new Uint8Array(9));
    expect(index.length).toBe(2 * 2 * 6);
    expect(rims).toEqual([]);
    // Each triangle wound the same way, counter-clockwise from above.
    for (let t = 0; t < index.length; t += 3) {
      const [a, b, c] = [...index.slice(t, t + 3)].map((k) => [k % 3, Math.floor(k / 3)]);
      expect((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])).toBeGreaterThan(0);
    }
  });

  it("leaves out every triangle with a corner in a hole and rims what is left", () => {
    // 3 × 3 vertices, the middle one through.
    const hole = new Uint8Array(9);
    hole[4] = 1;
    const { index, rims } = openSurface(3, 3, hole);
    expect(triangles(index)).toEqual(["0,1,3", "5,7,8"]);
    // Only the diagonals face the hole; the rest lie on the border.
    expect(edges(rims)).toEqual(["1,3", "5,7"]);
  });

  it("rims a hole inside the board all round", () => {
    // 5 × 5 vertices, the middle 3 × 3 through: a ring of wood is left.
    const [dx, dy] = [5, 5];
    const hole = new Uint8Array(dx * dy);
    for (let j = 1; j <= 3; j++) for (let i = 1; i <= 3; i++) hole[j * dx + i] = 1;
    const { index, rims } = openSurface(dx, dy, hole);
    for (const k of index) expect(hole[k]).toBe(0);
    // Every rim joins two vertices of wood, and is an edge of one triangle that is drawn.
    const drawn = new Set<string>();
    for (let t = 0; t < index.length; t += 3) {
      const c = [...index.slice(t, t + 3)];
      for (let e = 0; e < 3; e++) drawn.add([c[e], c[(e + 1) % 3]].sort((a, b) => a - b).join(","));
    }
    const column = (k: number) => k % dx;
    const row = (k: number) => Math.floor(k / dx);
    const sides = new Set<string>();
    for (const rim of edges(rims)) {
      const [p, q] = rim.split(",").map(Number);
      expect(hole[p] + hole[q]).toBe(0);
      expect(drawn.has(rim)).toBe(true);
      // Not along the border of the grid.
      const alongBorder =
        (column(p) === column(q) && [0, dx - 1].includes(column(p))) || (row(p) === row(q) && [0, dy - 1].includes(row(p)));
      expect(alongBorder).toBe(false);
      // Which side of the hole it faces: the corner squares' diagonals face two.
      if (column(p) === 0 || column(q) === 0) sides.add("left");
      if (column(p) === dx - 1 || column(q) === dx - 1) sides.add("right");
      if (row(p) === 0 || row(q) === 0) sides.add("front");
      if (row(p) === dy - 1 || row(q) === dy - 1) sides.add("back");
    }
    expect([...sides].sort()).toEqual(["back", "front", "left", "right"]);
  });

  it("with the whole board through draws nothing", () => {
    const { index, rims } = openSurface(4, 3, new Uint8Array(12).fill(1));
    expect(index.length).toBe(0);
    expect(rims).toEqual([]);
  });
});

describe("reliefRange", () => {
  it("leaves out what is cut right through from the deepest floor, and says it is there", () => {
    const heights = new Float32Array([0, -1.5, -6.2, -6, NaN, 0.4]);
    expect(reliefRange(heights, 6)).toEqual({ lowest: -1.5, highest: Math.fround(0.4), through: true });
    expect(reliefRange(new Float32Array([0, -2]), 6)).toEqual({ lowest: -2, highest: 0, through: false });
  });
});
