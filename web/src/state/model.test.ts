import { describe, expect, it } from "vitest";
import type { Design, FlatInlay, Profile, Project, Step, Tool, VcarveInlay } from "../core/types";
import { copyName, duplicateProject, duplicateStep, newProject, DEFAULT_SETUP, STARTER_NOTE, addDrawing, addStarter, fileNumbers, flushTrim, aboveOrBelow, sawRoom, glueOf, glueStep, inlayMargin, insertAfter, sawOf, sawStep, isByHand, isInlay, isSuppressed, withSuppressed, stepToolIds, missingFor, newStep, normaliseDesign, regionOwners, relinkTools, renumberTool, forgetTool, toolNumbers, toolSnapshots, standingPart, trimFacing, trimOf, withoutStep, withoutOrphans, changedCount, defaultProfile, missingSettings, stepMaterial, stepMaterials, withDefaultProfile, radiusMismatch, backerOf, backerShort, tabThicknessOn } from "./model";

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

describe("duplicateProject", () => {
  it("names a copy after its project, with a number when that name is taken", () => {
    expect(copyName("Coaster", ["Coaster"])).toBe("Coaster copy");
    expect(copyName("Coaster", ["Coaster", "Coaster copy"])).toBe("Coaster copy 2");
    expect(copyName("Coaster copy", ["Coaster", "Coaster copy"])).toBe("Coaster copy 2");
    expect(copyName("Coaster copy 2", ["Coaster copy", "Coaster copy 2"])).toBe("Coaster copy 3");
    expect(copyName("", [])).toBe("Untitled copy");
  });

  it("gives the copy an id of its own and leaves the rest as it was", () => {
    const original = newProject("Coaster");
    const copy = duplicateProject(original, ["Coaster"]);
    expect(copy.id).not.toBe(original.id);
    expect(copy).toEqual({ ...original, id: copy.id, name: "Coaster copy" });
  });
});

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

  it("leaves the stock its size for shapes larger than it, and takes a scaled drawing at its true size", () => {
    const base = design([square(0, 10, 10, 20)]);
    const more = { ...design([square(0, 0, 0, 100)], 100, 100), scale: 1.5 };
    const { design: out } = addDrawing(base, more);
    expect([out.width, out.height]).toEqual([100, 80]);
    // 150 across, centred on the stock: it reaches 25 over the sides and 35 over the top and bottom.
    expect(out.regions[1].outer[0]).toEqual([-25, -35]);
    expect(out.sourceName).toBe("a.svg");
  });
});

describe("steps", () => {
  const step = (type: Parameters<typeof newStep>[0], regionIds: number[], existing: Step[] = []) => newStep(type, regionIds, existing, DEFAULT_SETUP);

  it("only inlays own shapes and have a colour", () => {
    const inlay = step("vcarve", [1, 2]);
    const contour = step("contour", [2, 3], [inlay]);
    expect(isInlay(inlay.task) && !isInlay(contour.task)).toBe(true);
    expect(inlay.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(contour.color).toBeUndefined();
    const owners = regionOwners([inlay, contour]);
    expect([...owners.keys()]).toEqual([1, 2]);
    expect(contour.name).toBe("Contour 1");
  });

  it("gives new inlays different woods", () => {
    const a = step("vcarve", [1]);
    const b = step("flat", [2], [a]);
    expect(b.color).not.toBe(a.color);
  });

  it("says what an operation still needs", () => {
    const facing = step("facing", []);
    expect(missingFor(facing)).toMatch(/end mill/);
    if (facing.task.type === "facing") facing.task.toolId = "t";
    expect(missingFor(facing)).toBeNull();
    expect(stepToolIds(facing)).toEqual(["t"]);
    const chamfer = step("chamfer", []);
    expect(missingFor(chamfer)).toMatch(/shapes/);
    chamfer.regionIds = [1];
    expect(missingFor(chamfer)).toMatch(/corner-rounding/);
    // Facing goes side to side unless asked otherwise; a pocket follows its outline.
    expect(facing.task.type === "facing" && facing.task.pattern).toBe("raster");
    const pocket = step("pocket", [1]);
    expect(pocket.task.type === "pocket" && pocket.task.pattern).toBe("offset");
  });

  it("makes a facing that trims a glued-in plug flush", () => {
    const inlay = { ...step("vcarve", [1, 2]), name: "Walnut star", material: "softwood" };
    // 10 mm of plug, 3 mm of it in the pocket.
    expect(standingPart(inlay)).toEqual({ above: 7, margin: 8, floor: 0, what: "plug" });
    const trim = trimFacing(inlay, [inlay], DEFAULT_SETUP)!;
    expect(trim.name).toBe("Trim Walnut star");
    // It cuts the plug, so it is in the plug's wood, whatever the stock is; a facing of the stock itself is in the stock's.
    const cut = { base: { thickness: 18, material: "maple" }, steps: [inlay, trim], tools: [] } as unknown as Project;
    expect(stepMaterial(trim, cut)).toBe("softwood");
    expect(stepMaterial({ ...trim, task: { ...trim.task, above: 0, aboveAuto: false } as Step["task"] }, cut)).toBe("maple");
    expect(trim.regionIds).toEqual([1, 2]);
    expect(trim.task).toEqual({ type: "facing", above: 7, aboveAuto: true, depth: 0, margin: 8, marginAuto: true, pattern: "raster", toolId: null });
    // Its margin is the inlay's, whatever that is changed to; of shapes that belong to no plug there is none to take.
    expect(inlayMargin(trim, [inlay, trim])).toBe(8);
    expect(inlayMargin(trim, [{ ...inlay, task: { ...inlay.task, plugMargin: 11 } as Step["task"] }, trim])).toBe(11);
    expect(inlayMargin({ ...trim, regionIds: [9] }, [inlay, trim])).toBeNull();
    // Its height comes from the list, so it has nothing left to choose but its tool.
    expect(missingFor({ ...trim, task: { ...trim.task, above: 0, toolId: "t" } as Step["task"] })).toBeNull();
    expect(trim.color).toBeUndefined();
    // It is found again as the inlay's trim, also with a lower start, until its shapes or its start say otherwise.
    expect(trimOf(inlay, [inlay, trim])).toBe(trim);
    const lower: Step = { ...trim, task: { ...trim.task, above: 1.5 } as Step["task"] };
    expect(trimOf(inlay, [inlay, lower])).toBe(lower);
    expect(trimOf(inlay, [inlay, { ...trim, regionIds: [1] }])).toBeUndefined();
    expect(trimOf(inlay, [inlay, { ...trim, task: { ...trim.task, above: 0, aboveAuto: false } as Step["task"] }])).toBeUndefined();
    expect(trimOf(inlay, [inlay, step("facing", [1, 2])])).toBeUndefined();
    // A second one gets a name of its own.
    expect(trimFacing(inlay, [inlay, trim], DEFAULT_SETUP)!.name).toBe("Trim Walnut star 2");
  });

  it("copies an inlay without its shapes, an operation with them, and no step done by hand", () => {
    const inlay = { ...step("vcarve", [1, 2]), name: "Walnut star" };
    const copy = duplicateStep(inlay, [inlay])!;
    expect(copy).toEqual({ ...inlay, id: copy.id, name: "Walnut star copy", regionIds: [] });
    expect(copy.id).not.toBe(inlay.id);
    // Nothing of the copy is the original's own.
    expect(copy.task).not.toBe(inlay.task);
    expect(duplicateStep(inlay, [inlay, copy])!.name).toBe("Walnut star copy 2");
    const pocket = step("pocket", [3]);
    expect(duplicateStep(pocket, [pocket])!.regionIds).toEqual([3]);
    expect(duplicateStep(glueStep(inlay, [inlay])!, [inlay])).toBeNull();
  });

  it("trims a plug set into a lower surface down to that surface", () => {
    const inlay = { ...step("vcarve", [1, 2]), name: "Walnut star" };
    // 10 mm of plug, 3 mm in, in a pocket cut 4 mm down: 3 mm stand above the stock's surface.
    Object.assign(inlay.task, { startDepth: 4 });
    expect(standingPart(inlay)).toEqual({ above: 3, margin: 8, floor: 4, what: "plug" });
    const trim = trimFacing(inlay, [inlay], DEFAULT_SETUP)!;
    expect(trim.task).toMatchObject({ type: "facing", above: 3, aboveAuto: true, depth: 4 });
    expect(trimOf(inlay, [inlay, trim])).toBe(trim);
    // 8 mm down, its top is 1 mm below the stock's surface: the facing starts there, and nothing is taken from the list.
    Object.assign(inlay.task, { startDepth: 8 });
    expect(flushTrim(standingPart(inlay)!)).toEqual({ above: 0, startDepth: 1, depth: 8 });
    const low = trimFacing(inlay, [inlay], DEFAULT_SETUP)!;
    expect(low.task).toMatchObject({ type: "facing", above: 0, startDepth: 1, depth: 8 });
    expect(low.task.type === "facing" && low.task.aboveAuto).toBeFalsy();
    expect(trimOf(inlay, [inlay, low])).toBe(low);
    // Wholly below the surface it is set in: nothing to trim.
    Object.assign(inlay.task, { startDepth: 0, plugThickness: 3 });
    expect(trimFacing(inlay, [inlay], DEFAULT_SETUP)).toBeNull();
  });

  it("saws and trims a plug set into a lower surface by what stands of it", () => {
    const inlay = { ...step("vcarve", [1, 2]), name: "Walnut star" };
    // A 1.5 mm saw gap, 1 mm down: half a millimetre for the saw.
    Object.assign(inlay.task, { sawGap: 1.5, startDepth: 1 });
    expect(sawRoom(inlay.task)).toBe(0.5);
    expect(sawStep(inlay, [inlay])!.task).toMatchObject({ type: "saw", leave: 0.5 });
    // 2 mm down the backer lies below the stock's surface: no room.
    Object.assign(inlay.task, { startDepth: 2 });
    expect(sawRoom(inlay.task)).toBe(-0.5);
    expect(aboveOrBelow(-0.97)).toBe("0.97 mm below");
    expect(aboveOrBelow(2)).toBe("2 mm above");
    // A facing over the inlay's shapes that starts below the surface is its trim only below it in the list:
    // above it, it may be what lowered the surface the pocket is cut into.
    const facing = { ...step("facing", [1, 2]), task: { ...step("facing", [1, 2]).task, startDepth: 1, depth: 2 } as Step["task"] };
    expect(trimOf(inlay, [facing, inlay])).toBeUndefined();
    expect(trimOf(inlay, [inlay, facing])).toBe(facing);
  });

  it("offers the trim for a plug on a backer only", () => {
    const flat = step("flat", [3]);
    // Loose inserts are not one plug.
    expect(trimFacing(flat, [flat], DEFAULT_SETUP)).toBeNull();
    if (flat.task.type === "flat") Object.assign(flat.task, { insertStyle: "backer", insertThickness: 8, insertMargin: 6 });
    const trim = trimFacing(flat, [flat], DEFAULT_SETUP)!;
    expect(trim.task.type === "facing" && [trim.task.above, trim.task.margin]).toEqual([5, 6]);
    // No plug above the surface, no shapes, or no inlay: nothing to trim.
    if (flat.task.type === "flat") flat.task.insertThickness = 3;
    expect(trimFacing(flat, [flat], DEFAULT_SETUP)).toBeNull();
    expect(trimFacing(step("vcarve", []), [], DEFAULT_SETUP)).toBeNull();
    expect(trimFacing(step("pocket", [1]), [], DEFAULT_SETUP)).toBeNull();
  });

  it("makes a glue-up for an inlay, which goes when the inlay goes", () => {
    const inlay = { ...step("vcarve", [1]), name: "Walnut star" };
    const pocket = step("pocket", [2], [inlay]);
    expect(glueStep(pocket, [inlay, pocket])).toBeNull();
    const glue = glueStep(inlay, [inlay, pocket])!;
    expect(glue.name).toBe("Glue in Walnut star");
    expect(glue.task).toEqual({ type: "glue", inlayId: inlay.id });
    expect(isByHand(glue.task) && !isInlay(glue.task)).toBe(true);
    // Done by hand: no shapes, no tools, nothing to choose.
    expect([glue.regionIds, stepToolIds(glue), missingFor(glue)]).toEqual([[], [], null]);
    expect(regionOwners([inlay, glue]).size).toBe(1);

    // It goes in right after its inlay, and the trim after it.
    const list = insertAfter([inlay, pocket], inlay.id, glue);
    expect(list).toEqual([inlay, glue, pocket]);
    expect(glueOf(inlay, list)).toBe(glue);
    expect(insertAfter(list, undefined, pocket).length).toBe(4);

    expect(withoutStep(list, pocket.id)).toEqual([inlay, glue]);
    expect(withoutStep(list, glue.id)).toEqual([inlay, pocket]);
    expect(withoutStep(list, inlay.id)).toEqual([pocket]);
    // Sawing the backer off: after the glue-up, leaving the saw gap at most; it goes when the backer does.
    const saw = sawStep(inlay, list)!;
    expect(saw.task).toEqual({ type: "saw", inlayId: inlay.id, leave: 1.5 });
    expect([isByHand(saw.task), missingFor(saw), stepToolIds(saw)]).toEqual([true, null, []]);
    const sawn = insertAfter(list, glue.id, saw);
    expect(sawOf(inlay, sawn)).toBe(saw);
    expect(fileNumbers(sawn)).toEqual([1, null, null, 2]);
    expect(withoutStep(sawn, inlay.id)).toEqual([pocket]);
    const flat = step("flat", [3]);
    expect(sawStep(flat, [flat])).toBeNull();
    const loose = { ...saw, task: { ...saw.task, inlayId: flat.id } as Step["task"] };
    expect(withoutOrphans([flat, loose])).toEqual([flat]);

    // A list with nothing orphaned comes back as it is.
    expect(withoutOrphans(list)).toBe(list);

    // The lines from one glue-up to the next share a file; the glue-up is in none.
    const trim = trimFacing(inlay, list, DEFAULT_SETUP)!;
    expect(fileNumbers(list)).toEqual([1, null, 2]);
    expect(fileNumbers([inlay, pocket, glue, trim, pocket])).toEqual([1, 1, null, 2, 2]);
    expect(fileNumbers([glue, glue, inlay])).toEqual([null, null, 1]);
    expect(fileNumbers([inlay, pocket])).toEqual([1, 1]);
    // A trim that takes its height from the list is still found as the inlay's.
    expect(trimOf(inlay, [inlay, { ...trim, task: { ...trim.task, above: 0 } as Step["task"] }])).toBeDefined();
  });

  it("leaves a suppressed step out of the files, and an inlay's glue-up and sawing with it", () => {
    const inlay = step("vcarve", [1]);
    const pocket = step("pocket", [2]);
    const glue = glueStep(inlay, [inlay])!;
    const saw = sawStep(inlay, [inlay])!;
    const trim = trimFacing(inlay, [inlay], DEFAULT_SETUP)!;
    const list = [inlay, pocket, glue, saw, trim];
    expect(list.some((j) => isSuppressed(j, list))).toBe(false);

    const off = withSuppressed(list, pocket.id, true);
    expect(off[1]).toEqual({ ...pocket, suppressed: true });
    expect(off[0]).toBe(inlay);
    expect(fileNumbers(off)).toEqual([1, null, null, null, 2]);
    // Back again, nothing of it is left over.
    expect(withSuppressed(off, pocket.id, false)[1]).toEqual(pocket);
    expect("suppressed" in withSuppressed(off, pocket.id, false)[1]).toBe(false);

    // Without its inlay there is nothing to glue in or to saw off: the pocket and the trim share a file.
    const noInlay = withSuppressed(list, inlay.id, true);
    expect(noInlay.map((j) => isSuppressed(j, noInlay))).toEqual([true, false, true, true, false]);
    expect(fileNumbers(noInlay)).toEqual([null, 1, null, null, 1]);
  });
});

describe("the starter set", () => {
  const tool = (id: string, name: string) => ({ id, name, kind: "flat_end" as const, diameter: 3, shankDiameter: 3, cutting: [] });
  const starter = {
    tools: [tool("s1", "Ø3 one"), tool("s2", "Ø3 two"), { ...tool("s3", "Ø3 three"), note: "its own" }],
    materials: [{ key: "brass" }, { key: "oak" }],
    groups: [{ path: "End mills" }],
    profiles: [{ key: "clearing", label: "Clearing" }],
  };

  it("adds what the list lacks and changes nothing that is there", () => {
    const mine = { ...tool("mine", "Ø3 one"), diameter: 9 };
    const taken = tool("s2", "Renamed");
    const result = addStarter([mine, taken], { materials: [{ key: "oak", label: "My oak" }] }, starter);
    expect(result.added).toBe(1);
    expect(result.tools.slice(0, 2)).toEqual([mine, taken]);
    expect(result.tools[2]).toMatchObject({ id: "s3", note: "its own" });
    expect(result.lists.materials).toEqual([{ key: "oak", label: "My oak" }, { key: "brass" }]);
    expect(result.lists.groups).toEqual([{ path: "End mills" }]);
    // No starter tool has a row on a profile, so none comes with it.
    expect(result.lists.profiles).toBeUndefined();
  });

  it("marks its tools, and adds nothing a second time", () => {
    const first = addStarter([], {}, starter);
    expect(first.added).toBe(3);
    expect(first.tools[0].note).toBe(STARTER_NOTE);
    expect(addStarter(first.tools, first.lists, starter).added).toBe(0);
  });
});

describe("relinkTools", () => {
  const mill = (id: string, extra: Partial<Tool> = {}): Tool => ({ id, name: "Ø6×18 3F", kind: "flat_end", diameter: 6, fluteLength: 18, shankDiameter: 6, cutting: [], ...extra });
  const project = (tools: Tool[]): Project =>
    ({
      id: "p",
      name: "P",
      design: null,
      tools,
      steps: [
        { id: "a", name: "Pocket", material: "hardwood", regionIds: [0], rowProfiles: { old: "adaptive" }, task: { type: "pocket", depth: 3, pattern: "offset", clearingToolIds: ["old", "kept"] } },
        { id: "b", name: "Outline", material: "hardwood", regionIds: [0], task: { type: "contour", side: "outside", tabs: false, toolId: "old" } },
      ],
    }) as unknown as Project;

  it("points the steps at the list's tool where a copy differs from it only by its id", () => {
    // The list's tool has other feeds and another note: it is the same tool still.
    const list = [mill("new", { note: "mine", cutting: [{ material: "hardwood" } as Tool["cutting"][number]] }), mill("kept", { name: "Ø4×12 3F", diameter: 4 })];
    const p = project([mill("old"), list[1]]);
    const linked = relinkTools(p, list);
    expect(linked.steps.map(stepToolIds)).toEqual([["new", "kept"], ["new"]]);
    expect(linked.steps[0].rowProfiles).toEqual({ new: "adaptive" });
    // Nothing to do the second time.
    expect(relinkTools(linked, list)).toBe(linked);
  });

  it("leaves a copy alone that differs in a measure, or that two tools of the list match", () => {
    const p = project([mill("old")]);
    expect(relinkTools(p, [mill("new", { fluteLength: 22 })])).toBe(p);
    expect(relinkTools(p, [mill("one"), mill("two")])).toBe(p);
    expect(relinkTools(p, [])).toBe(p);
  });
});

describe("toolNumbers", () => {
  const mill = (id: string, diameter = 6): Tool => ({ id, name: `Mill ${id}`, kind: "flat_end", diameter, shankDiameter: 6, cutting: [] });
  const pocket = (id: string, toolIds: string[]) => ({ id, name: id, material: "hardwood", regionIds: [0], task: { type: "pocket", depth: 3, pattern: "offset", clearingToolIds: toolIds } });
  const project = (steps: unknown[], toolNumbers?: Record<string, number>): Project => ({ id: "p", name: "P", design: null, tools: [], steps, toolNumbers }) as unknown as Project;
  const list = [mill("a"), mill("b"), mill("c")];

  it("numbers the tools in the order the steps use them, from the machine's first", () => {
    expect(toolNumbers(project([pocket("x", ["b"]), pocket("y", ["a", "b"])]), list, 1)).toEqual({ b: 1, a: 2 });
    expect(toolNumbers(project([pocket("x", ["b"])]), list, 3)).toEqual({ b: 3 });
    expect(toolNumbers(project([]), list, 1)).toBeUndefined();
  });

  it("keeps a number once given: a new tool takes the lowest that is free, and one no step uses stays", () => {
    const p = project([pocket("x", ["c", "a"])], { a: 2, b: 1 });
    const numbers = toolNumbers(p, list, 1);
    expect(numbers).toEqual({ a: 2, b: 1, c: 3 });
    // The tool that keeps its number stays in the project's copies.
    expect(toolSnapshots({ ...p, toolNumbers: numbers }, list).map((t) => t.id)).toEqual(["a", "b", "c"]);
    // Nothing to do the second time, and a tool that is nowhere any more loses its number.
    const settled = { ...p, toolNumbers: numbers };
    expect(toolNumbers(settled, list, 1)).toBe(numbers);
    expect(toolNumbers(settled, [mill("a"), mill("c")], 1)).toEqual({ a: 2, c: 3 });
  });

  it("moves a tool to another number, changing places with the tool that had it", () => {
    const p = project([], { a: 1, b: 2, c: 5 });
    expect(renumberTool(p, "a", 2).toolNumbers).toEqual({ a: 2, b: 1, c: 5 });
    expect(renumberTool(p, "a", 9).toolNumbers).toEqual({ a: 9, b: 2, c: 5 });
    expect(renumberTool(p, "a", 0)).toBe(p);
    expect(renumberTool(p, "x", 3)).toBe(p);
    expect(forgetTool(p, "c").toolNumbers).toEqual({ a: 1, b: 2 });
    expect(forgetTool(project([], { a: 1 }), "a").toolNumbers).toBeUndefined();
  });

  it("takes the number along when a copy is matched to the list's own tool", () => {
    const copy = { ...mill("a"), id: "old" };
    const p = { ...project([pocket("x", ["old"])], { old: 4 }), tools: [copy] } as Project;
    const linked = relinkTools(p, list);
    expect(linked.toolNumbers).toEqual({ a: 4 });
  });
});

describe("what a step is cut in, and with which numbers", () => {
  const row = (material: string, profile?: string) => ({ material, profile, rpm: 10000, feed: 600, plunge: 200, stepover: 2, stepdown: 1 });
  const mill = (profiles: string[], material = "hardwood"): Tool => ({ id: "m", name: "Ø6", kind: "flat_end", diameter: 6, shankDiameter: 6, cutting: [row(material), ...profiles.map((p) => row(material, p))] });
  const profiles: Profile[] = [
    { key: "adaptive", label: "Adaptive" },
    { key: "clearing", label: "Clearing" },
    { key: "face_finish", label: "Face finish" },
    { key: "slotting", label: "Full width", slot: true },
    { key: "bevel", label: "Chamfer" },
    { key: "vcarve", label: "V-carve" },
  ];
  const lists = { profiles };
  const step = (type: Parameters<typeof newStep>[0]) => newStep(type, [0], [], DEFAULT_SETUP);
  const project = (steps: Step[], material = "hardwood"): Project => ({ id: "p", name: "P", design: null, tools: [], steps, base: { thickness: 18, material } }) as unknown as Project;

  it("cuts an operation and an inlay's pocket in the stock's material, and a plug in the inlay's wood", () => {
    const inlay = { ...step("flat"), material: "softwood" };
    const pocket = { ...step("pocket"), material: "softwood" };
    const p = project([inlay, pocket], "maple");
    expect(stepMaterial(pocket, p)).toBe("maple");
    expect([stepMaterial(inlay, p), stepMaterial(inlay, p, "plug")]).toEqual(["maple", "softwood"]);
    expect(stepMaterials(inlay, p)).toEqual(["maple", "softwood"]);
    expect(stepMaterials({ ...inlay, material: "maple" }, p)).toEqual(["maple"]);
    // A tool needs settings for each of them.
    const tool = mill([], "maple");
    const uses = { ...inlay, task: { ...inlay.task, clearingToolIds: ["m"] } as Step["task"] };
    expect(missingSettings(uses, [tool], {}, p)).toContain("no cutting settings for softwood");
    expect(missingSettings({ ...uses, material: "maple" }, [tool], {}, p)).toBeNull();
  });

  it("starts a tool on the profile for what it is chosen for", () => {
    const tool = mill(profiles.map((p) => p.key));
    const p = project([]);
    expect(defaultProfile("facing", tool, "hardwood", lists, p)).toBe("face_finish");
    expect(defaultProfile("clearing", tool, "hardwood", lists, p)).toBe("clearing");
    expect(defaultProfile("contour", tool, "hardwood", lists, p)).toBe("slotting");
    expect(defaultProfile("chamfer", tool, "hardwood", lists, p)).toBe("bevel");
    expect(defaultProfile("vcarve", tool, "hardwood", lists, p)).toBe("vcarve");
    // Only a row the tool has for the material, never an adaptive one; else the plain row.
    expect(defaultProfile("facing", tool, "softwood", lists, p)).toBeUndefined();
    expect(defaultProfile("facing", mill(["clearing"]), "hardwood", lists, p)).toBeUndefined();
    expect(defaultProfile("clearing", mill(["adaptive"]), "hardwood", { profiles: [{ key: "adaptive", label: "Adaptive clearing" }] }, p)).toBeUndefined();
  });

  it("leaves a row the step has chosen already alone", () => {
    const tool = mill(["face_finish"]);
    const facing = step("facing");
    const p = project([facing]);
    expect(withDefaultProfile(facing, "m", "facing", [tool], lists, p).rowProfiles).toEqual({ m: "face_finish" });
    const chosen = { ...facing, rowProfiles: { m: "clearing" } };
    expect(withDefaultProfile(chosen, "m", "facing", [tool], lists, p)).toBe(chosen);
    expect(withDefaultProfile(facing, "m", "contour", [tool], lists, p)).toBe(facing);
    expect(withDefaultProfile(facing, "gone", "facing", [tool], lists, p)).toBe(facing);
  });

  it("counts the numbers a step changes, and takes them along when a tool's copy is linked to the list", () => {
    expect(changedCount(undefined)).toBe(0);
    expect(changedCount({ feed: 900, stepdown: 0.5 })).toBe(2);
    const copy: Tool = { ...mill([]), id: "old" };
    const pocket = { ...step("pocket"), cutOverrides: { old: { feed: 900 } }, task: { type: "pocket", depth: 3, pattern: "offset", clearingToolIds: ["old"] } as Step["task"] };
    const linked = relinkTools({ ...project([pocket]), tools: [copy] }, [mill([])]);
    expect(linked.steps[0].cutOverrides).toEqual({ m: { feed: 900 } });
  });
});

describe("radiusMismatch", () => {
  const rounder = (diameter: number, tipDiameter: number, cornerRadius: number) =>
    ({ id: "r", name: "R", kind: "corner_round", diameter, tipDiameter, cornerRadius, shankDiameter: 6, cutting: [] }) as unknown as Tool;
  it("says nothing when the diameters give the radius", () => {
    expect(radiusMismatch(rounder(10, 4, 3))).toBeNull();
    expect(radiusMismatch({ ...rounder(10, 4, 1), kind: "flat_end" })).toBeNull();
  });
  it("says what the radius would come back as through a tools.yaml", () => {
    expect(radiusMismatch(rounder(10, 4, 2))).toContain("would be 3 mm");
  });
});

describe("a plug's backer", () => {
  const flat = (over: Partial<FlatInlay>): FlatInlay => ({ ...(newStep("flat", [0], [], DEFAULT_SETUP).task as FlatInlay), insertStyle: "backer", ...over });
  const vcarve = (over: Partial<VcarveInlay>): VcarveInlay => ({ ...(newStep("vcarve", [0], [], DEFAULT_SETUP).task as VcarveInlay), ...over });
  const setup = { ...DEFAULT_SETUP, tabThickness: 1 };

  it("is what the board has left above the floor round the shapes", () => {
    expect(backerOf(flat({ insertThickness: 4.63, pocketDepth: 3, sawGap: 1.5 }))).toBe(0.13);
    expect(backerOf(vcarve({ plugThickness: 10, engagementDepth: 3, sawGap: 1.5 }))).toBe(5.5);
    expect(backerOf(flat({ insertThickness: 4, pocketDepth: 3, sawGap: 1.5 }))).toBe(-0.5);
    // Loose inserts are cut right through: no backer to speak of.
    expect(backerOf(flat({ insertStyle: "loose" }))).toBeNull();
  });

  it("asks tabs no thicker than half the board", () => {
    expect(tabThicknessOn(setup, 4.63)).toBe(1);
    expect(tabThicknessOn(setup, 1.5)).toBe(0.75);
  });

  it("falls short where tabs are asked thicker than it, with the numbers that mend it", () => {
    const thin = flat({ insertThickness: 4.63, pocketDepth: 3, sawGap: 1.5, cutOut: true, tabs: true });
    const short = backerShort(thin, setup);
    expect(short).toEqual({ backer: 0.13, tabs: 1, sawGap: 0.63, board: 5.5 });
    // Either number, taken, leaves nothing to say.
    expect(backerShort({ ...thin, sawGap: short!.sawGap! }, setup)).toBeNull();
    expect(backerShort({ ...thin, insertThickness: short!.board }, setup)).toBeNull();
    // Numbers that do not round to a hundredth are rounded the safe way.
    const odd = backerShort({ ...thin, insertThickness: 4.637, pocketDepth: 3.001 }, setup)!;
    expect(backerShort({ ...thin, insertThickness: 4.637, pocketDepth: 3.001, sawGap: odd.sawGap! }, setup)).toBeNull();
    expect(backerShort({ ...thin, pocketDepth: 3.001, insertThickness: odd.board }, setup)).toBeNull();
    // Half a board in thousandths is asked of the tabs: the saw gap offered still leaves that much.
    const capped = { ...thin, insertThickness: 2.384, pocketDepth: 1, sawGap: 1.36 };
    const thick = { ...setup, tabThickness: 3 };
    expect(backerShort(capped, thick)).toMatchObject({ tabs: 1.192, sawGap: 0.19 });
    expect(backerShort({ ...capped, sawGap: 0.19 }, thick)).toBeNull();
  });

  it("is measured as the core measures it, not to the nearest hundredth", () => {
    // Three thousandths of backer is a backer: the core cuts it.
    const hair = flat({ insertThickness: 4.003, pocketDepth: 3, sawGap: 1 });
    expect(backerOf(hair)).toBe(0.003);
    expect(backerShort(hair, setup)).toBeNull();
    // And four thousandths short of the tabs is short.
    expect(backerShort(flat({ insertThickness: 4.996, pocketDepth: 3, sawGap: 1, cutOut: true, tabs: true }), setup)).toMatchObject({ backer: 0.996, tabs: 1 });
    // For every board, pocket and gap in thousandths, what is offered mends it.
    for (let i = 0; i < 4000; i++) {
      const n = (k: number, span: number) => Math.round((((i * k) % 997) / 997) * span * 1000) / 1000;
      const thin = flat({ insertThickness: 0.5 + n(31, 12), pocketDepth: 0.2 + n(17, 6), sawGap: n(7, 3), cutOut: true, tabs: true });
      const tabs = { ...setup, tabThickness: 0.1 + n(13, 4) };
      const short = backerShort(thin, tabs);
      if (!short) continue;
      expect(short.board).toBeGreaterThan(0);
      expect(backerShort({ ...thin, insertThickness: short.board }, tabs)).toBeNull();
      if (short.sawGap !== null) {
        expect(short.sawGap).toBeGreaterThanOrEqual(0);
        expect(backerShort({ ...thin, sawGap: short.sawGap }, tabs)).toBeNull();
      }
    }
  });

  it("is enough where no tabs hang on it", () => {
    const thin = flat({ insertThickness: 4.63, pocketDepth: 3, sawGap: 1.5 });
    expect(backerShort({ ...thin, cutOut: false, tabs: true }, setup)).toBeNull();
    expect(backerShort({ ...thin, cutOut: true, tabs: false }, setup)).toBeNull();
    // As thick as the tabs, to the hundredth.
    expect(backerShort(flat({ insertThickness: 5.5, pocketDepth: 3, sawGap: 1.5, cutOut: true, tabs: true }), setup)).toBeNull();
    expect(backerShort(flat({ insertStyle: "loose", cutOut: true, tabs: true }), setup)).toBeNull();
  });

  it("is said to be missing when the board is too thin for the plug", () => {
    expect(backerShort(flat({ insertThickness: 4, pocketDepth: 3, sawGap: 1.5 }), setup)).toEqual({ backer: -0.5, tabs: null, sawGap: 0, board: 5.5 });
    // A board no thicker than the pocket is deep: no saw gap mends that.
    expect(backerShort(flat({ insertThickness: 3.5, pocketDepth: 3, sawGap: 1.5 }), setup)).toEqual({ backer: -1, tabs: null, sawGap: null, board: 5.5 });
    // A V-carve plug needs some gap to be sawn off in.
    expect(backerShort(vcarve({ plugThickness: 4, engagementDepth: 3, sawGap: 1.5 }), setup)).toEqual({ backer: -0.5, tabs: null, sawGap: null, board: 5.5 });
    expect(backerShort(vcarve({ plugThickness: 10, engagementDepth: 3, sawGap: 1.5, cutOut: true, tabs: true }), setup)).toBeNull();
  });

  it("offers a board whose tabs are as thick as set, not half a thin board", () => {
    // Half of a 1.9 mm board is less than the millimetre set.
    const thin = flat({ insertThickness: 1.9, pocketDepth: 1, sawGap: 0.5, cutOut: true, tabs: true });
    const short = backerShort(thin, setup)!;
    expect(short).toEqual({ backer: 0.4, tabs: 0.95, sawGap: null, board: 2.5 });
    expect(backerShort({ ...thin, insertThickness: short.board }, setup)).toBeNull();
  });
});
