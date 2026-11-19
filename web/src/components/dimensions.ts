// What the 3D view can measure: the dimension lines of a built part, and the
// point of the simulated surface under the cursor. No drawing here.

import type { Built, PocketPreview, ToolProfile } from "../core/types";

export type Vec3 = [number, number, number];

/** One dimension line: the two points it measures between, and what it says. */
export interface Mark {
  a: Vec3;
  b: Vec3;
  /**
   * The direction the line is drawn away from the points, so that it stands
   * clear of the board. All zeros for a line drawn where it measures.
   */
  out: Vec3;
  text: string;
}

/** A rectangle drawn on the board's surface, named at its far edge: just outside it, or just inside. */
export interface Outline {
  rect: [number, number, number, number];
  text: string;
  labelInside: boolean;
}

/** Up to 2 decimals, or as many as asked for, with no trailing zeros. */
export function mm(value: number, decimals = 2): string {
  const scale = 10 ** decimals;
  return String(Math.round(value * scale) / scale);
}

/**
 * The dimensions of a part: its board, the plug on that board when it is cut
 * out of a larger one, and what is left around the shapes.
 */
export function dimensionMarks(built: Built): { marks: Mark[]; outlines: Outline[] } {
  const { width, height, thickness } = built.stock;
  const flat: Vec3 = [0, 0, 0];
  const marks: Mark[] = [
    { a: [0, 0, 0], b: [width, 0, 0], out: [0, -1, 0], text: `X ${mm(width)}` },
    { a: [width, 0, 0], b: [width, height, 0], out: [1, 0, 0], text: `Y ${mm(height)}` },
    { a: [width, 0, 0], b: [width, 0, -thickness], out: [Math.SQRT1_2, -Math.SQRT1_2, 0], text: `${mm(thickness)} thick` },
  ];
  const outlines: Outline[] = [];
  const piece = built.piece ?? null;
  const shapes = built.shapes ?? null;
  // What the shapes' margins are measured from: the plug when it is cut out, else the board.
  const frame = piece ?? [0, 0, width, height];
  const inside = shapes ?? frame;
  const [midX, midY] = [(inside[0] + inside[2]) / 2, (inside[1] + inside[3]) / 2];
  const along = (a: Vec3, b: Vec3, text: (length: number) => string) => {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > 0.05) marks.push({ a, b, out: flat, text: text(length) });
  };

  if (piece) {
    outlines.push({ rect: piece, text: `plug ${mm(piece[2] - piece[0])} × ${mm(piece[3] - piece[1])}`, labelInside: false });
    along([0, midY, 0], [piece[0], midY, 0], (d) => `border ${mm(d)}`);
  }
  // The cut that frees the plug, measured below the shapes. Listed after the border and the margin beside it,
  // which lie end to end: the view puts the labels of neighbours in the list on opposite sides of their lines.
  const cut = () => {
    if (piece) along([midX, piece[1] - (built.cutWidth ?? 0), 0], [midX, piece[1], 0], (d) => `cut ${mm(d, 3)}`);
  };
  if (shapes) {
    outlines.push({ rect: shapes, text: `shapes ${mm(shapes[2] - shapes[0])} × ${mm(shapes[3] - shapes[1])}`, labelInside: true });
    // On a plug the space around the shapes is its margin; on the base board it is the distance to the edge.
    const [left, bottom, right, top] = [shapes[0] - frame[0], shapes[1] - frame[1], frame[2] - shapes[2], frame[3] - shapes[3]];
    // Shapes may lie over the board's edge: the distance is then how far beyond it they go, and is said so.
    const name = (signed: number) =>
      built.part === "plug" ? (d: number) => `margin ${mm(d)}` : (d: number) => (signed < 0 ? `${mm(d)} over edge` : `${mm(d)} to edge`);
    along([frame[0], midY, 0], [shapes[0], midY, 0], name(left));
    cut();
    // A plug that is cut out has its cut measured below the shapes; the margin there is the one on the left.
    if (!piece || Math.abs(bottom - left) > 0.05) along([midX, frame[1], 0], [midX, shapes[1], 0], name(bottom));
    if (Math.abs(right - left) > 0.05) along([shapes[2], midY, 0], [frame[2], midY, 0], name(right));
    if (Math.abs(top - bottom) > 0.05) along([midX, shapes[3], 0], [midX, frame[3], 0], name(top));
  }
  if (!shapes) cut();
  return { marks, outlines };
}

/** Numbers per straight piece of a tool path: x0 y0 z0 x1 y1 z1 rapid tool line. */
const PIECE = 9;

/** The points the tools cut closest to each edge of the board, as X and Y. */
export interface Reach {
  left: [number, number];
  bottom: [number, number];
  right: [number, number];
  top: [number, number];
}

/** How far from its axis a tool cuts at the board's top, with its tip `depth` below it. */
export function radiusAt(tool: ToolProfile, depth: number): number {
  const d = Math.max(0, depth);
  if (tool.round > 0) {
    const short = Math.sqrt(Math.max(0, tool.round * tool.round - d * d));
    return Math.min(tool.radius, tool.tipRadius + tool.round - short);
  }
  if (tool.slope > 0) return Math.min(tool.radius, tool.tipRadius + d / tool.slope);
  return tool.radius;
}

/**
 * How far the cutting moves among the first `moves` pieces of a tool path
 * reach towards each edge, at the board's top. Each tool cuts as far from
 * the path as it is wide there; one that `tools` does not have is taken as
 * its centre line. Null when none of those pieces cuts.
 */
export function pathReach(path: Float32Array, tools: { number: number; profile: ToolProfile }[] = [], moves = Infinity): Reach | null {
  let reach: Reach | null = null;
  const profiles = new Map(tools.map((t) => [t.number, t.profile]));
  const end = Math.min(path.length, moves * PIECE);
  for (let i = 0; i + PIECE <= end; i += PIECE) {
    if (path[i + 6] === 1) continue;
    const tool = profiles.get(path[i + 7]);
    // The tool's width at the top changes evenly along a straight piece, so its ends reach furthest.
    for (const at of [i, i + 3]) {
      const [x, y] = [path[at], path[at + 1]];
      const r = tool ? radiusAt(tool, -path[at + 2]) : 0;
      if (!reach) reach = { left: [x - r, y], bottom: [x, y - r], right: [x + r, y], top: [x, y + r] };
      if (x - r < reach.left[0]) reach.left = [x - r, y];
      if (y - r < reach.bottom[1]) reach.bottom = [x, y - r];
      if (x + r > reach.right[0]) reach.right = [x + r, y];
      if (y + r > reach.top[1]) reach.top = [x, y + r];
    }
  }
  return reach;
}

/**
 * From each edge of the board to where the tools cut closest to it,
 * each line drawn at that place. An edge the cut reaches or crosses has none.
 */
export function edgeMarks(stock: { width: number; height: number }, reach: Reach | null): Mark[] {
  if (!reach) return [];
  const { width, height } = stock;
  const marks: Mark[] = [];
  const within = (v: number, size: number) => Math.min(size, Math.max(0, v));
  const add = (a: Vec3, b: Vec3, distance: number) => {
    if (distance > 0.005) marks.push({ a, b, out: [0, 0, 0], text: `cut ${mm(distance)} to edge` });
  };
  const [lx, ly] = [reach.left[0], within(reach.left[1], height)];
  add([0, ly, 0], [lx, ly, 0], lx);
  const [bx, by] = [within(reach.bottom[0], width), reach.bottom[1]];
  add([bx, 0, 0], [bx, by, 0], by);
  const [rx, ry] = [reach.right[0], within(reach.right[1], height)];
  add([rx, ry, 0], [width, ry, 0], width - rx);
  const [tx, ty] = [within(reach.top[0], width), reach.top[1]];
  add([tx, ty, 0], [tx, height, 0], height - ty);
  return marks;
}

/**
 * Where a ray first meets the simulated surface from above: the point's X and
 * Y on the board and the height of the surface there. Null when the ray
 * misses the board's top, such as when it meets a side first.
 */
export function surfaceHit(preview: Pick<PocketPreview, "nx" | "ny" | "cell" | "heights">, origin: Vec3, direction: Vec3): { x: number; y: number; z: number } | null {
  const { nx, ny, cell, heights } = preview;
  const [width, depth] = [nx * cell, ny * cell];
  const heightAt = (x: number, y: number) => {
    const ix = Math.min(nx - 1, Math.max(0, Math.floor(x / cell)));
    const iy = Math.min(ny - 1, Math.max(0, Math.floor(y / cell)));
    return heights[iy * nx + ix];
  };

  // The stretch of the ray that lies over the board.
  let [near, far] = [0, Infinity];
  for (const [o, d, size] of [
    [origin[0], direction[0], width],
    [origin[1], direction[1], depth],
  ]) {
    if (Math.abs(d) < 1e-12) {
      if (o < 0 || o > size) return null;
    } else {
      const [t0, t1] = [(0 - o) / d, (size - o) / d];
      near = Math.max(near, Math.min(t0, t1));
      far = Math.min(far, Math.max(t0, t1));
    }
  }
  if (!(near <= far)) return null;
  const sideways = Math.hypot(direction[0], direction[1]);
  if (far === Infinity) {
    // Straight down: the board is where the ray stands.
    if (direction[2] >= 0) return null;
    return { x: origin[0], y: origin[1], z: heightAt(origin[0], origin[1]) };
  }

  const at = (t: number): Vec3 => [origin[0] + direction[0] * t, origin[1] + direction[1] * t, origin[2] + direction[2] * t];
  const below = (t: number) => {
    const p = at(t);
    return p[2] <= heightAt(p[0], p[1]);
  };
  // Already under the surface where it comes over the board: it came in through a side.
  if (below(near)) return null;
  const step = Math.max((cell * 0.5) / sideways, (far - near) / 20000);
  for (let t = near + step; t <= far + step; t += step) {
    const reached = Math.min(t, far);
    if (below(reached)) {
      let [above, under] = [reached - step, reached];
      for (let i = 0; i < 12; i++) {
        const middle = (above + under) / 2;
        if (below(middle)) under = middle;
        else above = middle;
      }
      const p = at(under);
      const x = Math.min(width, Math.max(0, p[0]));
      const y = Math.min(depth, Math.max(0, p[1]));
      return { x, y, z: heightAt(x, y) };
    }
    if (reached === far) break;
  }
  return null;
}
