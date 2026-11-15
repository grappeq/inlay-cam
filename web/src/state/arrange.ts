// Moving, resizing, mirroring and deleting shapes of the drawing. Pure
// functions over the design, in the design's own (unscaled) millimetres.

import type { Design, DesignRegion, Project, Ring } from "../core/types";

/** Left, bottom, right, top. */
export type Box = [number, number, number, number];

export function boxOf(regions: DesignRegion[]): Box | null {
  let box: Box | null = null;
  for (const region of regions) {
    for (const [x, y] of region.outer) {
      if (!box) box = [x, y, x, y];
      else box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
    }
  }
  return box;
}

const SLACK = 1e-6;

function within(a: Box, b: Box): boolean {
  return a[0] >= b[0] - SLACK && a[1] >= b[1] - SLACK && a[2] <= b[2] + SLACK && a[3] <= b[3] + SLACK;
}

function areaOf(box: Box): number {
  return (box[2] - box[0]) * (box[3] - box[1]);
}

/**
 * The ids of every shape in the same part of the drawing as `id`: everything
 * that lies within the outermost shape around it.
 */
export function partOf(design: Design, id: number): number[] {
  const boxes = new Map<number, Box>();
  for (const region of design.regions) {
    const box = boxOf([region]);
    if (box) boxes.set(region.id, box);
  }
  const mine = boxes.get(id);
  if (!mine) return [];
  let top = mine;
  for (const box of boxes.values()) if (within(mine, box) && areaOf(box) > areaOf(top)) top = box;
  return design.regions.filter((r) => boxes.has(r.id) && within(boxes.get(r.id)!, top)).map((r) => r.id);
}

/** How many separate parts the drawing has. */
export function countParts(design: Design): number {
  const seen = new Set<number>();
  let parts = 0;
  for (const region of design.regions) {
    if (seen.has(region.id)) continue;
    parts++;
    for (const id of partOf(design, region.id)) seen.add(id);
  }
  return parts;
}

/** Grows the page so that every shape lies on it. Never shrinks it. */
function contain(design: Design): Design {
  const box = boxOf(design.regions);
  if (!box) return design;
  const dx = box[0] < 0 ? -box[0] : 0;
  const dy = box[1] < 0 ? -box[1] : 0;
  const shift = (ring: Ring): Ring => ring.map(([x, y]) => [x + dx, y + dy]);
  const regions =
    dx === 0 && dy === 0 ? design.regions : design.regions.map((r) => ({ ...r, outer: shift(r.outer), holes: r.holes.map(shift) }));
  return {
    ...design,
    regions,
    width: Math.max(design.width + dx, box[2] + dx),
    height: Math.max(design.height + dy, box[3] + dy),
  };
}

function mapShapes(design: Design, ids: number[], f: (p: [number, number]) => [number, number], flips: boolean): Design {
  const chosen = new Set(ids);
  const ring = (r: Ring): Ring => {
    const out = r.map(f);
    // A mirrored ring runs the other way round; put it back.
    return flips ? out.reverse() : out;
  };
  return contain({
    ...design,
    regions: design.regions.map((r) => (chosen.has(r.id) ? { ...r, outer: ring(r.outer), holes: r.holes.map(ring) } : r)),
  });
}

function chosenBox(design: Design, ids: number[]): Box | null {
  return boxOf(design.regions.filter((r) => ids.includes(r.id)));
}

export function moveShapes(design: Design, ids: number[], dx: number, dy: number): Design {
  if ((dx === 0 && dy === 0) || ids.length === 0) return design;
  return mapShapes(design, ids, ([x, y]) => [x + dx, y + dy], false);
}

/** Scales the shapes by `factor`, keeping the corner `anchor` of their box where it is. */
export function scaleShapes(design: Design, ids: number[], factor: number, anchor: "left" | "right"): Design {
  const box = chosenBox(design, ids);
  if (!box || !(factor > 0) || factor === 1) return design;
  const ax = anchor === "left" ? box[0] : box[2];
  return mapShapes(design, ids, ([x, y]) => [ax + (x - ax) * factor, box[1] + (y - box[1]) * factor], false);
}

/** Mirrors the shapes in place: left to right ("x") or top to bottom ("y"). */
export function mirrorShapes(design: Design, ids: number[], axis: "x" | "y"): Design {
  const box = chosenBox(design, ids);
  if (!box) return design;
  return mapShapes(design, ids, ([x, y]) => (axis === "x" ? [box[0] + box[2] - x, y] : [x, box[1] + box[3] - y]), true);
}

/** Removes the shapes from the drawing and from the inlays that used them. */
export function removeShapes(project: Project, ids: number[]): Project {
  if (!project.design || ids.length === 0) return project;
  const gone = new Set(ids);
  return {
    ...project,
    design: { ...project.design, regions: project.design.regions.filter((r) => !gone.has(r.id)) },
    jobs: project.jobs.map((j) => ({ ...j, regionIds: j.regionIds.filter((id) => !gone.has(id)) })),
  };
}

/** Makes the page the extent of the shapes plus `margin` on every side. */
export function trimBoard(design: Design, margin: number): Design {
  const box = boxOf(design.regions);
  if (!box) return design;
  const dx = margin - box[0];
  const dy = margin - box[1];
  const shift = (ring: Ring): Ring => ring.map(([x, y]) => [x + dx, y + dy]);
  return {
    ...design,
    width: box[2] - box[0] + 2 * margin,
    height: box[3] - box[1] + 2 * margin,
    regions: design.regions.map((r) => ({ ...r, outer: shift(r.outer), holes: r.holes.map(shift) })),
  };
}

/** The selection's box as it lies on the board: left, bottom, width, height, in board millimetres. */
export function placedBox(design: Design, ids: number[]): { x: number; y: number; width: number; height: number } | null {
  const box = chosenBox(design, ids);
  if (!box) return null;
  const s = design.scale;
  return {
    x: (design.mirror ? design.width - box[2] : box[0]) * s,
    y: box[1] * s,
    width: (box[2] - box[0]) * s,
    height: (box[3] - box[1]) * s,
  };
}

/** Moves the shapes by a distance given on the board, where the drawing may be scaled and mirrored. */
export function moveOnBoard(design: Design, ids: number[], dx: number, dy: number): Design {
  return moveShapes(design, ids, ((design.mirror ? -1 : 1) * dx) / design.scale, dy / design.scale);
}

/** Scales the shapes, keeping their bottom-left corner on the board where it is. */
export function scaleOnBoard(design: Design, ids: number[], factor: number): Design {
  return scaleShapes(design, ids, factor, design.mirror ? "right" : "left");
}
