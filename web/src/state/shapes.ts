// Shapes drawn in the app: rectangles, ellipses and regular polygons.
// Each is made as an outline of straight runs, like an imported one, in the
// design's millimetres with Y up, counter-clockwise.

import type { Ring } from "../core/types";

type Point = [number, number];

/** How closely straight runs follow a curve, mm. The core's `FLATTEN_TOLERANCE`, which imported curves get. */
export const FLATTEN = 0.01;
/** The smallest a drawn shape can be, across and up, mm. */
export const SMALLEST_DRAWN = 0.5;
/** Shift turns a polygon in steps of this, degrees. */
export const TURN_STEP = 15;

export type DrawTool = "rectangle" | "ellipse" | "polygon";

/** What the drawing tools take besides the drag. */
export interface DrawOptions {
  /** Radius of a rectangle's corners, mm. 0 leaves them sharp. */
  corner: number;
  /** Sides of a polygon. */
  sides: number;
}

export const DEFAULT_DRAW_OPTIONS: DrawOptions = { corner: 0, sides: 6 };

/** Limits of the options: the fewest and the most sides of a polygon. */
export const DRAW_LIMITS = { sides: [3, 100] } as const;

/** How many straight runs an arc of this radius and sweep (radians) takes. */
function arcSteps(radius: number, sweep: number): number {
  if (!(radius > FLATTEN)) return 1;
  return Math.max(1, Math.ceil(sweep / (2 * Math.acos(1 - FLATTEN / radius))));
}

/** Drops points that repeat the one before them, and a last one that repeats the first. */
function tidy(ring: Ring): Ring {
  const out: Ring = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-9) out.pop();
  return out;
}

/** A rectangle from its left, bottom, right and top. `corner` rounds its corners, by no more than half its shorter side. */
export function rectangleRing(x0: number, y0: number, x1: number, y1: number, corner = 0): Ring {
  const r = Math.max(0, Math.min(corner, (x1 - x0) / 2, (y1 - y0) / 2));
  if (!(r > 0)) {
    return [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ];
  }
  const steps = arcSteps(r, Math.PI / 2);
  // The middle of each corner's arc, and the angle the arc starts at, in quarter turns.
  const corners: [number, number, number][] = [
    [x1 - r, y0 + r, 3],
    [x1 - r, y1 - r, 0],
    [x0 + r, y1 - r, 1],
    [x0 + r, y0 + r, 2],
  ];
  const ring: Ring = [];
  for (const [cx, cy, quarter] of corners) {
    // The ends of an arc are put on the sides exactly, so that the sides run dead straight.
    const unit = (k: number): Point => [[1, 0, -1, 0][k % 4], [0, 1, 0, -1][k % 4]];
    for (let i = 0; i <= steps; i++) {
      const [ux, uy] =
        i === 0 ? unit(quarter) : i === steps ? unit(quarter + 1) : [Math.cos(((quarter + i / steps) * Math.PI) / 2), Math.sin(((quarter + i / steps) * Math.PI) / 2)];
      ring.push([cx + r * ux, cy + r * uy]);
    }
  }
  return tidy(ring);
}

/** An ellipse that fills the box from its left, bottom, right and top. */
export function ellipseRing(x0: number, y0: number, x1: number, y1: number): Ring {
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  // A multiple of four, so that the outline touches all four sides of its box.
  const quarter = Math.max(3, arcSteps(Math.max(rx, ry), Math.PI / 2));
  const ring: Ring = [];
  for (let i = 0; i < 4 * quarter; i++) {
    const k = i % quarter;
    const q = Math.floor(i / quarter);
    const t = (i * Math.PI) / (2 * quarter);
    const cos = k === 0 ? [1, 0, -1, 0][q] : Math.cos(t);
    const sin = k === 0 ? [0, 1, 0, -1][q] : Math.sin(t);
    ring.push([cx + rx * cos, cy + ry * sin]);
  }
  return ring;
}

/** A regular polygon: `sides` corners at `radius` from the middle, the first in the direction `angle` (radians, counter-clockwise from +X). */
export function polygonRing(cx: number, cy: number, radius: number, sides: number, angle: number): Ring {
  const n = Math.max(3, Math.round(sides));
  return Array.from({ length: n }, (_, i): Point => {
    const t = angle + (2 * Math.PI * i) / n;
    return [cx + radius * Math.cos(t), cy + radius * Math.sin(t)];
  });
}

/**
 * The outline a drag from `from` to `to` draws with a tool, or null while it
 * is too small to be a shape.
 *
 * A rectangle or an ellipse fills the box between the two points; `even`
 * (Shift) makes it a square or a circle, and `centred` (Ctrl) draws it about
 * `from`. A polygon has its middle at `from` and its first corner at `to`;
 * `even` turns it in steps of 15°.
 */
export function drawnRing(tool: DrawTool, options: DrawOptions, from: Point, to: Point, even: boolean, centred: boolean): Ring | null {
  const [ax, ay] = from;
  const dx = to[0] - ax;
  const dy = to[1] - ay;

  if (tool === "polygon") {
    const radius = Math.hypot(dx, dy);
    if (radius < SMALLEST_DRAWN / 2) return null;
    let angle = Math.atan2(dy, dx);
    if (even) {
      const step = (TURN_STEP * Math.PI) / 180;
      angle = Math.round(angle / step) * step;
    }
    return polygonRing(ax, ay, radius, options.sides, angle);
  }

  // How far the shape reaches from `from`, across and up.
  let w = Math.abs(dx);
  let h = Math.abs(dy);
  if (even) w = h = Math.max(w, h);
  const x0 = centred || dx < 0 ? ax - w : ax;
  const y0 = centred || dy < 0 ? ay - h : ay;
  const x1 = centred || dx >= 0 ? ax + w : ax;
  const y1 = centred || dy >= 0 ? ay + h : ay;
  if (x1 - x0 < SMALLEST_DRAWN || y1 - y0 < SMALLEST_DRAWN) return null;
  return tool === "rectangle" ? rectangleRing(x0, y0, x1, y1, options.corner) : ellipseRing(x0, y0, x1, y1);
}
