// Pictures for an agent, which cannot look at the screen: the drawing with
// each shape's id on it, and a board seen from above with its depths shaded.
// Both are made from the data, not taken from the screen, so they come out
// the same whatever the page is showing, and in a tab that is hidden.

import type { Project } from "../core/types";
import { isHole } from "../components/holes";
import { isInlay, regionOwners, stepColor, stockColor } from "../state/model";

const round = (n: number) => n.toFixed(2);

/** An ink that shows on a wood of this colour. */
function inkOn(color: string): string {
  const n = parseInt(color.slice(1), 16);
  const light = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return light > 0.45 ? "#2b2114" : "#f6ecd8";
}

/** The drawing as an SVG `width` pixels wide: the stock, every shape in its inlay's wood, and each shape's id. */
export function drawingSvg(project: Project, width: number): { svg: string; width: number; height: number } {
  const design = project.design;
  if (!design) throw new Error("The project has no drawing.");
  // Shapes may lie outside the stock: the picture takes in both.
  let [x0, y0, x1, y1] = [0, 0, design.width, design.height];
  const boxes = new Map<number, [number, number, number, number]>();
  for (const r of design.regions) {
    const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of r.outer) {
      box[0] = Math.min(box[0], x);
      box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x);
      box[3] = Math.max(box[3], y);
    }
    boxes.set(r.id, box);
    [x0, y0, x1, y1] = [Math.min(x0, box[0]), Math.min(y0, box[1]), Math.max(x1, box[2]), Math.max(y1, box[3])];
  }
  const pad = 28;
  const s = (width - 2 * pad) / Math.max(x1 - x0, 1e-6);
  const height = Math.ceil((y1 - y0) * s + 2 * pad + 22);
  const px = (x: number) => round(pad + (x - x0) * s);
  // The drawing's Y points up, the picture's down.
  const py = (y: number) => round(pad + 22 + (y1 - y) * s);
  const path = (ring: [number, number][]) => ring.map(([x, y], i) => `${i === 0 ? "M" : "L"}${px(x)} ${py(y)}`).join("") + "Z";

  const owners = regionOwners(project.steps);
  const wood = stockColor(project);
  const area = (id: number) => {
    const b = boxes.get(id)!;
    return (b[2] - b[0]) * (b[3] - b[1]);
  };
  // Large shapes first, so that what lies inside one is drawn over it.
  const regions = [...design.regions].sort((a, b) => area(b.id) - area(a.id));
  const shapes = regions
    .map((r) => {
      const owner = owners.get(r.id);
      const fill = owner && isInlay(owner.task) ? stepColor(owner, project.steps) : "#ffffff";
      return `<path d="${[r.outer, ...r.holes].map(path).join("")}" fill="${fill}" fill-opacity="${owner ? 1 : 0.35}" fill-rule="evenodd" stroke="#2b2114" stroke-width="1.2"/>`;
    })
    .join("");
  const labels = regions
    .map((r) => {
      const b = boxes.get(r.id)!;
      const owner = owners.get(r.id);
      const ink = inkOn(owner && isInlay(owner.task) ? stepColor(owner, project.steps) : wood);
      const size = Math.max(10, Math.min(18, Math.min(b[2] - b[0], b[3] - b[1]) * s * 0.5));
      return `<text x="${px((b[0] + b[2]) / 2)}" y="${py((b[1] + b[3]) / 2)}" font-size="${round(size)}" fill="${ink}" text-anchor="middle" dominant-baseline="central" font-weight="600">${r.id}</text>`;
    })
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif">` +
    `<rect width="${width}" height="${height}" fill="#f4f1ea"/>` +
    `<text x="${pad}" y="20" font-size="13" fill="#2b2114">Stock ${round(design.width)} × ${round(design.height)} mm, origin at its lower left. Numbers are shape ids.</text>` +
    `<rect x="${px(0)}" y="${py(design.height)}" width="${round(design.width * s)}" height="${round(design.height * s)}" fill="${wood}" stroke="#2b2114" stroke-width="1.5"/>` +
    shapes +
    labels +
    `</svg>`;
  return { svg, width, height };
}

/** An SVG as a PNG, base64. */
export async function svgToPng(svg: string, width: number, height: number): Promise<string> {
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser gave no canvas to draw on.");
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/png").split(",")[1];
}

function rgb(color: string): [number, number, number] {
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export interface Relief {
  nx: number;
  ny: number;
  cell: number;
  /** Height per cell, 0 at the uncut top, row by row from Y = 0. */
  heights: Float32Array;
  /** Whose wood each cell is in: an index into `colors`. Absent: all the first. */
  owners?: Uint8Array;
  colors: string[];
  thickness: number;
}

/**
 * A board seen from above as a PNG, base64: each cell in its wood's colour,
 * darker the deeper it is cut, lit from the upper left; clear where it is
 * cut right through. `lowest` is the deepest floor left, `through` whether
 * any of it is cut right through.
 */
export function reliefPng(
  relief: Relief,
  width: number,
): { data: string; width: number; height: number; lowest: number; highest: number; through: boolean } {
  const { nx, ny, cell, heights, owners, thickness } = relief;
  const colors = relief.colors.map(rgb);
  const small = document.createElement("canvas");
  small.width = nx;
  small.height = ny;
  const ctx = small.getContext("2d");
  if (!ctx) throw new Error("This browser gave no canvas to draw on.");
  const pixels = ctx.createImageData(nx, ny);
  const at = (x: number, y: number) => {
    const h = heights[Math.max(0, Math.min(ny - 1, y)) * nx + Math.max(0, Math.min(nx - 1, x))];
    return Number.isFinite(h) ? h : 0;
  };
  const { lowest, highest, through } = reliefRange(heights, thickness);
  // The deepest cut is the darkest, however shallow it is on a thick board.
  const deepest = Math.max(-lowest, Math.min(thickness, 0.5), 1e-6);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const h = at(x, y);
      // The slope, for the light: from the upper left, as on a map.
      const gx = (at(x + 1, y) - at(x - 1, y)) / (2 * cell);
      const gy = (at(x, y + 1) - at(x, y - 1)) / (2 * cell);
      const length = Math.hypot(gx, gy, 1);
      const lit = (gx * 0.41 - gy * 0.41 + 0.82) / length;
      const depth = Math.max(0, Math.min(1, -h / deepest));
      const shade = (1 - 0.4 * depth) * (0.45 + 0.67 * lit);
      const [r, g, b] = colors[owners?.[y * nx + x] ?? 0] ?? colors[0];
      // The top row of the picture is the far edge of the board.
      const i = ((ny - 1 - y) * nx + x) * 4;
      pixels.data[i] = Math.max(0, Math.min(255, r * shade));
      pixels.data[i + 1] = Math.max(0, Math.min(255, g * shade));
      pixels.data[i + 2] = Math.max(0, Math.min(255, b * shade));
      pixels.data[i + 3] = isHole(h, thickness) ? 0 : 255;
    }
  }
  ctx.putImageData(pixels, 0, 0);
  const height = Math.max(1, Math.round((width * ny) / nx));
  const large = document.createElement("canvas");
  large.width = width;
  large.height = height;
  const out = large.getContext("2d");
  if (!out) throw new Error("This browser gave no canvas to draw on.");
  out.imageSmoothingEnabled = width < nx;
  out.drawImage(small, 0, 0, width, height);
  return { data: large.toDataURL("image/png").split(",")[1], width, height, lowest, highest, through };
}

/** The deepest floor and the highest top of a board's cells, leaving out where it is cut right through; and whether any is. */
export function reliefRange(heights: Float32Array, thickness: number): { lowest: number; highest: number; through: boolean } {
  let lowest = 0;
  let highest = 0;
  let through = false;
  for (const h of heights) {
    if (!Number.isFinite(h)) continue;
    if (isHole(h, thickness)) {
      through = true;
      continue;
    }
    lowest = Math.min(lowest, h);
    highest = Math.max(highest, h);
  }
  return { lowest, highest, through };
}
