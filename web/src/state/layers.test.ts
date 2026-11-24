import { describe, expect, it } from "vitest";
import type { Design, DesignRegion, Project, Ring } from "../core/types";
import { addShape, moveShapes, moveToLayer, removeShapes, withInside } from "./arrange";
import { EDGE_CONTRAST, LAYER_COLORS, activeLayerOf, addLayer, changeLayer, edgeOn, layerColor, layersOf, pickable, removeLayer, reorderLayers, shapesOn } from "./layers";
import { WOODS, addDrawing } from "./model";

const square = (x0: number, y0: number, x1: number, y1: number): Ring => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];
const hole = (x0: number, y0: number, x1: number, y1: number): Ring => [...square(x0, y0, x1, y1)].reverse();

/** A plate (0) with a disc (1) in it, on one layer; on a second layer a recess (2) around the disc, inside the plate. */
function design(): Design {
  return {
    sourceName: "test.dxf",
    width: 100,
    height: 80,
    scale: 1,
    mirror: false,
    layers: [
      { id: 1, name: "Recess" },
      { id: 0, name: "Plate" },
    ],
    regions: [
      { id: 0, outer: square(10, 10, 70, 50), holes: [hole(30, 20, 40, 30)] },
      { id: 1, outer: square(30, 20, 40, 30), holes: [] },
      { id: 2, layer: 1, outer: square(20, 15, 50, 40), holes: [] },
    ],
  };
}

const shape = (d: Design, id: number): DesignRegion => d.regions.find((r) => r.id === id)!;

function project(d = design()): Project {
  return {
    id: "p",
    name: "Test",
    design: d,
    tools: [],
    base: { thickness: 18, material: "hardwood" },
    machine: { name: "Carvera Air", minRpm: 5000, maxRpm: 13000, rapidRate: 2000, travel: [300, 200], firstTool: 1 },
    setup: { safeHeight: 5, plungeClearance: 1, throughCut: 0.2, tabWidth: 4, tabSpacing: 40, tabThickness: 1, cutOutBorder: 5, rampAngle: 5, finishAllowance: 0.1, insertFitExtra: 0.5 },
    steps: [
      { id: "a", name: "Recess", material: "hardwood", regionIds: [2], task: { type: "pocket" } as never },
      { id: "b", name: "Plate", material: "hardwood", regionIds: [0, 2], task: { type: "contour" } as never },
    ],
  };
}

describe("holes and layers", () => {
  it("links a shape to the one around it on its own layer only", () => {
    const d = design();
    expect(withInside(d, [0]).sort()).toEqual([0, 1]);
    expect(withInside(d, [2])).toEqual([2]);
  });

  it("cuts no hole for a shape moved inside one on another layer", () => {
    const d = { ...design(), regions: [...design().regions, { id: 3, layer: 1, outer: square(80, 60, 85, 65), holes: [] }] };
    // Onto the plate, clear of the recess: the plate is on another layer and stays whole.
    const onPlate = moveShapes(d, [3], -25, -15);
    expect(shape(onPlate, 0).holes).toHaveLength(1);
    // Into the recess, which is on its layer: the recess gets a hole.
    const inRecess = moveShapes(d, [3], -58, -42);
    expect(shape(inRecess, 2).holes).toHaveLength(1);
    expect(shape(inRecess, 0).holes).toHaveLength(1);
  });

  it("draws a shape on the layer it is given", () => {
    const d = design();
    // Inside the plate and the recess: on the recess's layer only the recess takes a hole.
    const onRecess = addShape(d, square(42, 32, 48, 38), 1);
    expect(shape(onRecess.design, onRecess.id).layer).toBe(1);
    expect(shape(onRecess.design, 2).holes).toHaveLength(1);
    expect(shape(onRecess.design, 0).holes).toHaveLength(1);
    // On the plate's layer it is a hole in the plate, and the recess stays whole.
    const onPlate = addShape(d, square(42, 32, 48, 38), 0);
    expect(shape(onPlate.design, onPlate.id).layer).toBeUndefined();
    expect(shape(onPlate.design, 0).holes).toHaveLength(2);
    expect(shape(onPlate.design, 2).holes).toHaveLength(0);
    // Drawn around the recess on its layer, it takes the recess as a hole and nothing of the plate's layer.
    const around = addShape(d, square(15, 12, 55, 45), 1);
    expect(shape(around.design, around.id).holes).toHaveLength(1);
    expect(withInside(around.design, [around.id]).sort()).toEqual([2, around.id]);
  });
});

describe("moveToLayer", () => {
  it("closes the hole a shape filled and leaves the step its shape", () => {
    const d = moveToLayer(design(), [1], 1);
    expect(shape(d, 1).layer).toBe(1);
    // The plate is whole again; on its new layer the disc is a hole in the recess.
    expect(shape(d, 0).holes).toHaveLength(0);
    expect(shape(d, 2).holes).toHaveLength(1);
    expect(withInside(d, [2]).sort()).toEqual([1, 2]);
  });

  it("opens holes both ways on the layer it comes to", () => {
    const base = design();
    // A plate without its disc: the recess that comes to its layer is a hole in it.
    const plate: Design = { ...base, regions: [{ ...shape(base, 0), holes: [] }, shape(base, 2)] };
    const inPlate = moveToLayer(plate, [2], 0);
    expect(shape(inPlate, 0).holes).toHaveLength(1);
    expect(withInside(inPlate, [0]).sort()).toEqual([0, 2]);
    // A disc without its plate: it is a hole in the recess that comes to its layer.
    const disc: Design = { ...base, regions: [shape(base, 1), shape(base, 2)] };
    const aroundDisc = moveToLayer(disc, [2], 0);
    expect(shape(aroundDisc, 2).holes).toHaveLength(1);
    expect(withInside(aroundDisc, [2]).sort()).toEqual([1, 2]);
  });

  it("leaves what was inside and is not moved, as a hole in what is around it there", () => {
    // The plate goes; its disc stays on layer 0 with nothing around it.
    const d = moveToLayer(design(), [0], 1);
    expect(shape(d, 0).holes).toHaveLength(1);
    expect(shape(d, 1).layer).toBeUndefined();
    // On layer 1 the recess lies inside the plate, and is the hole the plate has now.
    expect(withInside(d, [0]).sort()).toEqual([0, 2]);
  });

  it("nests shapes that come together from different layers", () => {
    // The plate, the recess in it and the disc in that, each on a layer of its own.
    const base = design();
    const d: Design = {
      ...base,
      layers: [{ id: 3, name: "Disc" }, { id: 2, name: "Top" }, ...base.layers!],
      regions: [{ ...shape(base, 0), holes: [] }, { ...shape(base, 1), layer: 3 }, shape(base, 2)],
    };
    expect(withInside(d, [0])).toEqual([0]);
    const moved = moveToLayer(d, [0, 1, 2], 2);
    expect(withInside(moved, [0]).sort()).toEqual([0, 1, 2]);
    expect(shape(moved, 0).holes).toHaveLength(1);
    expect(shape(moved, 2).holes).toHaveLength(1);
  });

  it("changes nothing for shapes that are there already", () => {
    const d = design();
    expect(moveToLayer(d, [0, 1], 0)).toBe(d);
  });
});

describe("layers", () => {
  it("takes a drawing without layers as one layer, and keeps it written without them", () => {
    const plain: Design = { ...design(), layers: undefined, regions: design().regions.map(({ layer: _, ...r }) => r) };
    expect(layersOf(plain)).toEqual([{ id: 0, name: "Layer 1" }]);
    expect(shapesOn(plain, 0)).toEqual([0, 1, 2]);
    expect(activeLayerOf(plain, 7).id).toBe(0);
  });

  it("adds a layer above another with a free name and id", () => {
    const top = addLayer(design());
    expect(top.id).toBe(2);
    expect(layersOf(top.design).map((l) => l.name)).toEqual(["Layer 3", "Recess", "Plate"]);
    const above = addLayer(design(), 0);
    expect(layersOf(above.design).map((l) => l.id)).toEqual([1, 2, 0]);
    // The first layer added to a plain drawing makes its one layer real.
    const plain = addLayer({ ...design(), layers: undefined });
    expect(layersOf(plain.design).map((l) => l.name)).toEqual(["Layer 2", "Layer 1"]);
  });

  it("names, colours, hides and locks a layer, leaving out what is off", () => {
    let d = changeLayer(design(), 1, { name: "  Pocket ", hidden: true, color: "#c2317f" });
    expect(layersOf(d)[0]).toEqual({ id: 1, name: "Pocket", hidden: true, color: "#c2317f" });
    d = changeLayer(d, 1, { hidden: false, name: " " });
    expect(layersOf(d)[0]).toEqual({ id: 1, name: "Pocket", color: "#c2317f" });
    expect(changeLayer(d, 1, { locked: false })).toBe(d);
    expect(layerColor(layersOf(d)[0])).toBe("#c2317f");
    expect(layerColor(layersOf(d)[1])).toBe(LAYER_COLORS[0]);
  });

  it("tells a renamed layer from one that has the name already", () => {
    const d = changeLayer(design(), 1, { name: "Plate" });
    expect(layersOf(d).map((l) => l.name)).toEqual(["Plate 2", "Plate"]);
  });

  it("puts layers in another order", () => {
    expect(layersOf(reorderLayers(design(), 0, 1)).map((l) => l.id)).toEqual([0, 1]);
    const d = design();
    expect(reorderLayers(d, 0, 5)).toBe(d);
  });

  it("removes a layer with its shapes, and the steps left without any", () => {
    const out = removeLayer(project(), 1);
    expect(layersOf(out.design!).map((l) => l.id)).toEqual([0]);
    expect(out.design!.regions.map((r) => r.id)).toEqual([0, 1]);
    expect(out.steps.map((s) => [s.id, s.regionIds])).toEqual([["b", [0]]]);
    // The last layer stays.
    expect(removeLayer(out, 0)).toBe(out);
  });

  it("lets nothing on a hidden layer be picked, nor on a locked one while editing", () => {
    const d = changeLayer(changeLayer(design(), 1, { hidden: true }), 0, { locked: true });
    expect([0, 1, 2].filter(pickable(d, false))).toEqual([0, 1]);
    expect([0, 1, 2].filter(pickable(d, true))).toEqual([]);
    expect([0, 1, 2].filter(pickable(design(), true))).toEqual([0, 1, 2]);
  });

  it("deleting a shape closes its hole on its own layer only", () => {
    const out = removeShapes(project(), [1]);
    expect(shape(out.design!, 0).holes).toHaveLength(0);
    expect(shape(out.design!, 2).holes).toHaveLength(0);
  });
});

describe("addDrawing with layers", () => {
  const incoming = (layers?: Design["layers"]): Design => ({
    sourceName: "leaf.svg",
    width: 20,
    height: 20,
    scale: 1,
    mirror: false,
    layers,
    regions: [
      { id: 0, outer: square(0, 0, 10, 10), holes: [] },
      { id: 1, ...(layers ? { layer: 5 } : {}), outer: square(12, 0, 20, 10), holes: [] },
    ],
  });

  it("puts a drawing without layers on a new top layer named after its file", () => {
    const { design: out, ids } = addDrawing(design(), incoming());
    expect(layersOf(out).map((l) => [l.id, l.name])).toEqual([
      [2, "leaf"],
      [1, "Recess"],
      [0, "Plate"],
    ]);
    expect(ids.map((id) => shape(out, id).layer)).toEqual([2, 2]);
  });

  it("keeps a drawing's own layers, under new ids and free names", () => {
    const { design: out, ids } = addDrawing(
      design(),
      incoming([
        { id: 5, name: "Plate", locked: true },
        { id: 0, name: "Veins" },
      ]),
    );
    expect(layersOf(out).map((l) => [l.id, l.name])).toEqual([
      [2, "Plate 2"],
      [3, "Veins"],
      [1, "Recess"],
      [0, "Plate"],
    ]);
    expect(layersOf(out)[0].locked).toBe(true);
    expect(ids.map((id) => shape(out, id).layer)).toEqual([3, 2]);
  });

  it("takes a drawing as it is on a stock with nothing drawn", () => {
    const empty: Design = { sourceName: "", width: 200, height: 150, scale: 1, mirror: false, regions: [] };
    expect(addDrawing(empty, incoming()).design.layers).toBeUndefined();
    const layered = addDrawing(empty, incoming([{ id: 5, name: "Top" }, { id: 0, name: "Base" }]));
    expect(layersOf(layered.design).map((l) => l.id)).toEqual([5, 0]);
    expect(layered.ids.map((id) => shape(layered.design, id).layer)).toEqual([undefined, 5]);
  });
});

describe("edgeOn", () => {
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

  it("gives every layer colour a line that stands out on every wood", () => {
    for (const wood of WOODS) for (const color of LAYER_COLORS) expect(contrast(edgeOn(color, wood.color), wood.color), `${color} on ${wood.name}`).toBeGreaterThanOrEqual(EDGE_CONTRAST);
  });

  it("leaves a colour as it is where it stands out already", () => {
    expect(edgeOn("#0f8a7a", "#26211e")).toBe("#0f8a7a");
  });
});
