// Moving, resizing, turning, mirroring, copying and deleting shapes of the
// drawing. Pure functions over the design, in the design's own (unscaled)
// millimetres.
//
// A drawing made of outlines is stored as the areas between them: a plate
// with a circle drawn on it is the plate with a hole, and the disc that fills
// the hole. To the user these are two outlines, one inside the other, and
// each is selected and changed by itself. So the functions here act on the
// outlines they are given and on nothing else, and keep the stored areas in
// step: the hole an outline fills in the shape around it moves with it, and
// is closed when the outline is deleted or leaves. What lies inside an
// outline and is not given with it stays where it is, and gets its hole in
// whatever is around it afterwards. Outlines given together move together.

import type { Design, DesignRegion, Project, Ring } from "../core/types";

type Point = [number, number];
/** Left, bottom, right, top. */
export type Box = [number, number, number, number];

function ringBox(ring: Ring): Box {
  let box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of ring) box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
  return box;
}

export function boxOf(regions: DesignRegion[]): Box | null {
  let box: Box | null = null;
  for (const region of regions) {
    const b = ringBox(region.outer);
    box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
  }
  return box;
}

function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    sum += x0 * y1 - x1 * y0;
  }
  return sum / 2;
}

function inRing(p: Point, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToRing(p: Point, ring: Ring): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

/** How far inside a shape's wood a point has to be before it counts as inside, mm. */
const INSIDE = 0.01;

/** True when the point lies in the shape's area, clear of its edges. */
function inArea(p: Point, region: DesignRegion): boolean {
  if (!inRing(p, region.outer) || distanceToRing(p, region.outer) < INSIDE) return false;
  return !region.holes.some((h) => inRing(p, h) || distanceToRing(p, h) < INSIDE);
}

/** How closely a shape's outline must match a hole to count as filling it, mm. */
const MATCH = 1e-3;

/** True when `outer` is the outline of `hole`: the shape fills that hole. */
function fills(outer: Ring, hole: Ring): boolean {
  const a = ringBox(outer);
  const b = ringBox(hole);
  if (a.some((v, i) => Math.abs(v - b[i]) > MATCH)) return false;
  const area = Math.abs(signedArea(outer));
  return Math.abs(area - Math.abs(signedArea(hole))) <= MATCH * (1 + Math.sqrt(area));
}

interface Links {
  /** The shape around each shape, and which of its holes the shape fills. */
  parent: Map<number, { id: number; hole: number }>;
  children: Map<number, number[]>;
}

const linkCache = new WeakMap<Design, Links>();

function links(design: Design): Links {
  const cached = linkCache.get(design);
  if (cached) return cached;
  const parent = new Map<number, { id: number; hole: number }>();
  const children = new Map<number, number[]>();
  const boxes = design.regions.map((r) => ringBox(r.outer));
  design.regions.forEach((around, i) => {
    around.holes.forEach((hole, h) => {
      const hb = ringBox(hole);
      design.regions.forEach((inner, k) => {
        if (k === i || parent.has(inner.id)) return;
        if (Math.abs(boxes[k][0] - hb[0]) > MATCH || Math.abs(boxes[k][2] - hb[2]) > MATCH) return;
        if (!fills(inner.outer, hole)) return;
        parent.set(inner.id, { id: around.id, hole: h });
        children.set(around.id, [...(children.get(around.id) ?? []), inner.id]);
      });
    });
  });
  const out = { parent, children };
  linkCache.set(design, out);
  return out;
}

/** The shapes with everything that lies inside them, each once. Nothing is selected this way; it tells what fills what. */
export function withInside(design: Design, ids: number[]): number[] {
  const { children } = links(design);
  const known = new Set(design.regions.map((r) => r.id));
  const out = new Set<number>();
  const visit = (id: number) => {
    if (out.has(id) || !known.has(id)) return;
    out.add(id);
    for (const child of children.get(id) ?? []) visit(child);
  };
  ids.forEach(visit);
  return [...out];
}

/** The whole part a shape belongs to: the outermost outline around it and everything inside that. */
export function partOf(design: Design, id: number): number[] {
  const { parent } = links(design);
  let top = id;
  for (let guard = 0; guard < 1000 && parent.has(top); guard++) top = parent.get(top)!.id;
  return withInside(design, [top]);
}

/** Of a set of shapes, those whose surrounding shape is not in the set. */
function tops(design: Design, chosen: Set<number>): number[] {
  const { parent } = links(design);
  return [...chosen].filter((id) => !chosen.has(parent.get(id)?.id ?? -1));
}

/** The outlines an action is for: the ones named that are in the drawing, each once. */
function pick(design: Design, ids: number[]): Set<number> {
  const known = new Set(design.regions.map((r) => r.id));
  return new Set(ids.filter((id) => known.has(id)));
}

/**
 * Lets go of what lies inside the chosen shapes and is not chosen itself:
 * the holes those shapes fill are closed, and their ids returned as `left`.
 */
function release(design: Design, chosen: Set<number>): { design: Design; left: number[] } {
  const { parent } = links(design);
  const drop = new Map<number, Set<number>>();
  const left: number[] = [];
  for (const [inner, link] of parent) {
    if (!chosen.has(link.id) || chosen.has(inner)) continue;
    drop.set(link.id, (drop.get(link.id) ?? new Set()).add(link.hole));
    left.push(inner);
  }
  if (left.length === 0) return { design, left };
  return {
    design: { ...design, regions: design.regions.map((r) => (drop.has(r.id) ? { ...r, holes: r.holes.filter((_, h) => !drop.get(r.id)!.has(h)) } : r)) },
    left,
  };
}

/** Cuts the holes again for shapes that were let go of, into whatever each now lies wholly inside. */
function settle(design: Design, left: number[]): Design {
  return left.length > 0 ? openHoles(design, left, new Set(left)) : design;
}

/** Closes the holes that the outermost of the chosen shapes fill in the shapes around them. */
function closeHoles(design: Design, chosen: Set<number>): Design {
  const { parent } = links(design);
  const drop = new Map<number, Set<number>>();
  for (const id of tops(design, chosen)) {
    const link = parent.get(id);
    if (!link) continue;
    drop.set(link.id, (drop.get(link.id) ?? new Set()).add(link.hole));
  }
  if (drop.size === 0) return design;
  return {
    ...design,
    regions: design.regions.map((r) => (drop.has(r.id) ? { ...r, holes: r.holes.filter((_, h) => !drop.get(r.id)!.has(h)) } : r)),
  };
}

/**
 * Cuts a hole for each of the given shapes into the shape it now lies
 * wholly inside, if there is one. A shape that only partly covers another
 * is left as it is: shapes may lie on top of each other.
 */
function openHoles(design: Design, moved: number[], chosen: Set<number>): Design {
  let regions = design.regions;
  for (const id of moved) {
    const shape = regions.find((r) => r.id === id);
    if (!shape) continue;
    const box = ringBox(shape.outer);
    let best: DesignRegion | null = null;
    for (const around of regions) {
      if (chosen.has(around.id)) continue;
      const b = ringBox(around.outer);
      if (box[0] < b[0] || box[1] < b[1] || box[2] > b[2] || box[3] > b[3]) continue;
      // Every point of the outline in the other's wood, and none of the
      // other's holes swallowed.
      if (!shape.outer.every((p) => inArea(p, around))) continue;
      if (around.holes.some((h) => h.some((p) => inRing(p, shape.outer)))) continue;
      if (!best || Math.abs(signedArea(around.outer)) < Math.abs(signedArea(best.outer))) best = around;
    }
    if (!best) continue;
    const target = best.id;
    // Holes run clockwise, outlines counter-clockwise.
    const hole = [...shape.outer].reverse();
    regions = regions.map((r) => (r.id === target ? { ...r, holes: [...r.holes, hole] } : r));
  }
  return regions === design.regions ? design : { ...design, regions };
}

function chosenBox(design: Design, chosen: Set<number>): Box | null {
  return boxOf(design.regions.filter((r) => chosen.has(r.id)));
}

/**
 * Applies `f` to the chosen outlines. `flips` says that `f` mirrors. The
 * shapes may end up anywhere, on the stock or outside it.
 */
function transform(design: Design, ids: number[], f: (p: Point) => Point, flips: boolean): Design {
  const chosen = pick(design, ids);
  if (chosen.size === 0) return design;
  const freed = release(design, chosen);
  const moved = tops(freed.design, chosen);
  const closed = closeHoles(freed.design, chosen);

  const mapped = (g: (p: Point) => Point, rings: DesignRegion[]) =>
    rings.map((r) => {
      if (!chosen.has(r.id)) return r;
      const ring = (points: Ring): Ring => {
        const out = points.map((p) => g(p as Point));
        // A mirrored ring runs the other way round; put it back.
        return flips ? out.reverse() : out;
      };
      return { ...r, outer: ring(r.outer), holes: r.holes.map(ring) };
    });
  const regions = mapped(f, closed.regions);
  return settle(openHoles({ ...closed, regions }, moved, chosen), freed.left);
}

export function moveShapes(design: Design, ids: number[], dx: number, dy: number): Design {
  if ((dx === 0 && dy === 0) || ids.length === 0) return design;
  return transform(design, ids, ([x, y]) => [x + dx, y + dy], false);
}

/** Scales the shapes by `factor`, keeping the corner `anchor` of their box where it is. */
export function scaleShapes(design: Design, ids: number[], factor: number, anchor: "left" | "right"): Design {
  return stretchShapes(design, ids, factor, factor, [anchor === "left" ? 0 : 1, 0]);
}

/**
 * Stretches the shapes by `fx` across and `fy` up. `anchor` says which point
 * of their box stays where it is, as fractions of the box from its left and
 * bottom: [0, 0] the bottom-left corner, [0.5, 0.5] the middle, [1, 1] the
 * top-right corner.
 */
export function stretchShapes(design: Design, ids: number[], fx: number, fy: number, anchor: [number, number]): Design {
  const box = chosenBox(design, pick(design, ids));
  if (!box || !(fx > 0) || !(fy > 0) || !Number.isFinite(fx) || !Number.isFinite(fy) || (fx === 1 && fy === 1)) return design;
  const ax = box[0] + anchor[0] * (box[2] - box[0]);
  const ay = box[1] + anchor[1] * (box[3] - box[1]);
  return transform(design, ids, ([x, y]) => [ax + (x - ax) * fx, ay + (y - ay) * fy], false);
}

/** Mirrors the shapes in place: left to right ("x") or top to bottom ("y"). */
export function mirrorShapes(design: Design, ids: number[], axis: "x" | "y"): Design {
  const box = chosenBox(design, pick(design, ids));
  if (!box) return design;
  return transform(design, ids, ([x, y]) => (axis === "x" ? [box[0] + box[2] - x, y] : [x, box[1] + box[3] - y]), true);
}

/** Turns the shapes counter-clockwise by `degrees` about the middle of their box. */
export function rotateShapes(design: Design, ids: number[], degrees: number): Design {
  const box = chosenBox(design, pick(design, ids));
  if (!box || !Number.isFinite(degrees) || degrees % 360 === 0) return design;
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  // Quarter turns are exact, so that a square stays square to the last digit.
  const quarter = ((Math.round(degrees / 90) % 4) + 4) % 4;
  const exact = degrees % 90 === 0;
  const cos = exact ? [1, 0, -1, 0][quarter] : Math.cos((degrees * Math.PI) / 180);
  const sin = exact ? [0, 1, 0, -1][quarter] : Math.sin((degrees * Math.PI) / 180);
  return transform(design, ids, ([x, y]) => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos], false);
}

/** Puts the middle of the shapes on the middle of the board, across ("x") or up ("y"). */
export function centreShapes(design: Design, ids: number[], axis: "x" | "y"): Design {
  const box = chosenBox(design, pick(design, ids));
  if (!box) return design;
  const dx = axis === "x" ? design.width / 2 - (box[0] + box[2]) / 2 : 0;
  const dy = axis === "y" ? design.height / 2 - (box[1] + box[3]) / 2 : 0;
  return moveShapes(design, ids, dx, dy);
}

/** The project's inlays without the shapes that are gone; an inlay that loses all its shapes goes too. */
function withoutShapes(project: Project, gone: Set<number>): Project["steps"] {
  return project.steps.flatMap((step) => {
    if (!step.regionIds.some((id) => gone.has(id))) return [step];
    const regionIds = step.regionIds.filter((id) => !gone.has(id));
    return regionIds.length > 0 ? [{ ...step, regionIds }] : [];
  });
}

/**
 * Removes the shapes from the drawing and from the inlays that used them.
 * The holes they filled are closed. What was inside one stays, as a hole in
 * whatever is now around it. An inlay left without shapes is removed too.
 */
export function removeShapes(project: Project, ids: number[]): Project {
  if (!project.design) return project;
  const gone = pick(project.design, ids);
  if (gone.size === 0) return project;
  const { left } = release(project.design, gone);
  const closed = closeHoles(project.design, gone);
  return {
    ...project,
    design: settle({ ...closed, regions: closed.regions.filter((r) => !gone.has(r.id)) }, left),
    steps: withoutShapes(project, gone),
  };
}

/** The inlays that would lose all their shapes if these were removed. */
export function emptiedSteps(project: Project, ids: number[]): string[] {
  if (!project.design) return [];
  const gone = pick(project.design, ids);
  return project.steps.filter((j) => j.regionIds.length > 0 && j.regionIds.every((id) => gone.has(id))).map((j) => j.name);
}

/** Removes every shape but these, then fits the board to them. */
export function keepOnly(project: Project, ids: number[], margin: number): Project {
  if (!project.design) return project;
  const kept = pick(project.design, ids);
  if (kept.size === 0) return project;
  const others = project.design.regions.filter((r) => !kept.has(r.id)).map((r) => r.id);
  const gone = new Set(others);
  // A kept outline loses the holes of what was inside it and is not kept.
  const design = { ...project.design, regions: release(project.design, kept).design.regions.filter((r) => kept.has(r.id)) };
  return {
    ...project,
    design: trimBoard(design, margin),
    steps: withoutShapes(project, gone),
  };
}

/**
 * Copies the shapes and puts the copy `gap` to the right of the originals.
 * Returns the new design and the copies' ids. A copy has no holes for what
 * lies inside its original and was not copied with it.
 */
export function duplicateShapes(design: Design, ids: number[], gap: number): { design: Design; ids: number[] } {
  const chosen = pick(design, ids);
  const box = chosenBox(design, chosen);
  if (!box) return { design, ids: [] };
  let next = design.regions.reduce((max, r) => Math.max(max, r.id), -1) + 1;
  const dx = box[2] - box[0] + gap;
  const shift = (ring: Ring): Ring => ring.map(([x, y]) => [x + dx, y]);
  const copies = release(design, chosen).design.regions.filter((r) => chosen.has(r.id)).map((r) => ({ ...r, id: next++, outer: shift(r.outer), holes: r.holes.map(shift) }));
  const copied = new Set(copies.map((c) => c.id));
  const added = { ...design, regions: [...design.regions, ...copies] };
  return { design: openHoles(added, tops(added, copied), copied), ids: [...copied] };
}

/**
 * Adds an outline drawn in the app as a new shape, and returns its id.
 *
 * It joins the drawing as an outline does anywhere here: lying wholly inside
 * another shape it becomes a hole in that shape, and a part that lies wholly
 * inside it becomes a hole in it. An outline that only partly covers another
 * is left as it is: shapes may lie on top of each other.
 */
export function addShape(design: Design, outline: Ring): { design: Design; id: number } {
  const id = design.regions.reduce((max, r) => Math.max(max, r.id), -1) + 1;
  const outer = signedArea(outline) < 0 ? [...outline].reverse() : outline;
  const box = ringBox(outer);
  const { parent } = links(design);
  const holes = design.regions
    .filter((r) => {
      if (parent.has(r.id)) return false;
      const b = ringBox(r.outer);
      if (b[0] < box[0] || b[1] < box[1] || b[2] > box[2] || b[3] > box[3]) return false;
      return r.outer.every((p) => inRing(p as Point, outer) && distanceToRing(p as Point, outer) >= INSIDE);
    })
    .map((r) => [...r.outer].reverse());
  const chosen = new Set([id]);
  const added = { ...design, regions: [...design.regions, { id, outer, holes }] };
  return { design: openHoles(added, [id], chosen), id };
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

/** The shapes whose outlines lie wholly inside a box given in the design's millimetres. */
export function shapesInBox(design: Design, box: Box): number[] {
  return design.regions
    .filter((r) => {
      const b = ringBox(r.outer);
      return b[0] >= box[0] && b[1] >= box[1] && b[2] <= box[2] && b[3] <= box[3];
    })
    .map((r) => r.id);
}

export interface Placed {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The selection's box as it lies on the board: left, bottom, width, height, in board millimetres. */
export function placedBox(design: Design, ids: number[]): Placed | null {
  const box = chosenBox(design, pick(design, ids));
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

/** Stretches the shapes as seen on the board; `anchor` is counted from the left and bottom of their box there. */
export function stretchOnBoard(design: Design, ids: number[], fx: number, fy: number, anchor: [number, number]): Design {
  return stretchShapes(design, ids, fx, fy, [design.mirror ? 1 - anchor[0] : anchor[0], anchor[1]]);
}

/** Turns the shapes as seen on the board, counter-clockwise. */
export function rotateOnBoard(design: Design, ids: number[], degrees: number): Design {
  return rotateShapes(design, ids, design.mirror ? -degrees : degrees);
}

/** Mirrors the shapes as seen on the board. */
export const mirrorOnBoard = mirrorShapes;

/** Centres the shapes on the board. */
export const centreOnBoard = centreShapes;
