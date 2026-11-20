// The layers of the drawing: shapes that are named, shown, locked and
// coloured together. Pure functions over the design.
//
// A drawing without layers is one layer, with the id 0, and stays written
// without them until a layer is added or changed. The first layer of the list
// is the top one.

import type { Design, DesignRegion, Layer, Project } from "../core/types";
import { removeShapes } from "./arrange";

/** The colours layers take in turn for their shapes' lines. Not the blue of the selection, the red of the marks or the orange of the focus. */
export const LAYER_COLORS = ["#0f8a7a", "#8a3fc4", "#3f8f1f", "#c2317f", "#0b7fb0", "#8a7a00", "#4a5568"] as const;
/** What each of them is called. */
export const LAYER_COLOR_NAMES = ["Teal", "Purple", "Green", "Pink", "Blue", "Olive", "Slate"] as const;

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const hex = (c: Rgb): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
/** Relative luminance, as WCAG counts it. */
function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The contrast a layer's line is given against the wood it is drawn on, where its colour allows. */
export const EDGE_CONTRAST = 3.5;

/**
 * The colour a layer's lines are drawn in on a wood: the layer's colour,
 * darkened or lightened just as far as it takes to stand out from the wood,
 * so that it keeps as much of itself as it can. On a wood where neither
 * gets there, the one that stands out most.
 */
export function edgeOn(color: string, wood: string): string {
  const [from, on] = [rgb(color), rgb(wood)];
  let best: { c: Rgb; contrast: number } | null = null;
  for (let t = 0; t <= 0.85; t += 0.05) {
    for (const to of [0, 255]) {
      const c = from.map((v) => v + (to - v) * t) as Rgb;
      const k = contrast(c, on);
      if (k >= EDGE_CONTRAST) return hex(c);
      if (!best || k > best.contrast) best = { c, contrast: k };
    }
  }
  return hex(best!.c);
}

const ONLY: Layer = { id: 0, name: "Layer 1" };
const ONLY_LIST = [ONLY];

/** The drawing's layers, the top one first: at least one. */
export function layersOf(design: Design): Layer[] {
  return design.layers && design.layers.length > 0 ? design.layers : ONLY_LIST;
}

/** The layer that is drawn on: the one wanted while the drawing has it, else the topmost that can be drawn on, else the top one. */
export function activeLayerOf(design: Design, wanted: number | null): Layer {
  const layers = layersOf(design);
  return layers.find((l) => l.id === wanted) ?? layers.find((l) => !l.hidden && !l.locked) ?? layers[0];
}

/** The id of the layer a shape is on. */
export function layerOf(region: DesignRegion): number {
  return region.layer ?? 0;
}

/** The colour of a layer's lines: its own, or the one its id gives it. */
export function layerColor(layer: Layer): string {
  return layer.color ?? LAYER_COLORS[layer.id % LAYER_COLORS.length];
}

/** The ids of the shapes on a layer. */
export function shapesOn(design: Design, layer: number): number[] {
  return design.regions.filter((r) => layerOf(r) === layer).map((r) => r.id);
}

/**
 * Tells which shapes can be picked: none on a hidden layer, and while the
 * drawing is edited none on a locked one.
 */
export function pickable(design: Design, editing: boolean): (id: number) => boolean {
  const off = new Set(layersOf(design).filter((l) => l.hidden || (editing && l.locked)).map((l) => l.id));
  if (off.size === 0) return () => true;
  const out = new Set(design.regions.filter((r) => off.has(layerOf(r))).map((r) => r.id));
  return (id) => !out.has(id);
}

/** A name like `name` that none of `taken` has: the name itself, or with a number after it. */
export function freeName(name: string, taken: string[]): string {
  if (!taken.includes(name)) return name;
  for (let n = 2; ; n++) if (!taken.includes(`${name} ${n}`)) return `${name} ${n}`;
}

/** Adds an empty layer above the layer `above`, or on top, and returns its id. */
export function addLayer(design: Design, above?: number): { design: Design; id: number } {
  const layers = layersOf(design);
  const id = layers.reduce((max, l) => Math.max(max, l.id), -1) + 1;
  let name = "";
  for (let n = layers.length + 1; name === ""; n++) if (!layers.some((l) => l.name === `Layer ${n}`)) name = `Layer ${n}`;
  const at = Math.max(0, layers.findIndex((l) => l.id === above));
  return { design: { ...design, layers: [...layers.slice(0, at), { id, name }, ...layers.slice(at)] }, id };
}

/** Changes a layer's name, colour, or whether it is hidden or locked. A blank name is not taken, and a name another layer has gets a number after it. */
export function changeLayer(design: Design, id: number, change: Partial<Omit<Layer, "id">>): Design {
  const layers = layersOf(design);
  const layer = layers.find((l) => l.id === id);
  if (!layer) return design;
  const wanted = change.name?.trim() || layer.name;
  const others = layers.filter((l) => l.id !== id).map((l) => l.name);
  const next: Layer = { ...layer, ...change, name: wanted === layer.name ? wanted : freeName(wanted, others) };
  // What is off is left out, as the file leaves it out.
  if (!next.hidden) delete next.hidden;
  if (!next.locked) delete next.locked;
  if (!next.color) delete next.color;
  if (JSON.stringify(next) === JSON.stringify(layer)) return design;
  return { ...design, layers: layers.map((l) => (l.id === id ? next : l)) };
}

/** Moves the layer at place `from` of the list to place `to`. */
export function reorderLayers(design: Design, from: number, to: number): Design {
  const layers = [...layersOf(design)];
  if (from === to || from < 0 || to < 0 || from >= layers.length || to >= layers.length) return design;
  const [moved] = layers.splice(from, 1);
  layers.splice(to, 0, moved);
  return { ...design, layers };
}

/** Removes a layer with its shapes, as deleting the shapes does. The last layer stays. */
export function removeLayer(project: Project, id: number): Project {
  const design = project.design;
  if (!design) return project;
  const layers = layersOf(design);
  if (layers.length < 2 || !layers.some((l) => l.id === id)) return project;
  const without = removeShapes(project, shapesOn(design, id));
  return without.design ? { ...without, design: { ...without.design, layers: layers.filter((l) => l.id !== id) } } : without;
}
