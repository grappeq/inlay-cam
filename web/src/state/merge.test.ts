import { describe, expect, it } from "vitest";
import type { Tool, ToolLibrary } from "../core/types";
import { mergeLibraries } from "./merge";

function tool(id: string, extra: Partial<Tool> = {}): Tool {
  return {
    id,
    name: `Tool ${id}`,
    kind: "flat_end",
    diameter: 3,
    shankDiameter: 3,
    cutting: [{ material: "hardwood", rpm: 10000, feed: 1000, plunge: 300, stepover: 1, stepdown: 1 }],
    ...extra,
  } as Tool;
}

const base: ToolLibrary = {
  materials: [{ key: "walnut", label: "Walnut" }] as ToolLibrary["materials"],
  tools: [tool("a"), tool("b"), tool("c")],
};

const edit = (library: ToolLibrary, id: string, change: (t: Tool) => Tool): ToolLibrary => ({
  ...library,
  tools: library.tools.map((t) => (t.id === id ? change(t) : t)),
});

describe("mergeLibraries", () => {
  it("keeps changes to two different tools", () => {
    const mine = edit(base, "a", (t) => ({ ...t, name: "Mine" }));
    const theirs = edit(base, "b", (t) => ({ ...t, name: "Theirs" }));
    const { library, lost } = mergeLibraries(base, mine, theirs);
    expect(lost).toEqual([]);
    expect(library.tools.map((t) => t.name)).toEqual(["Mine", "Theirs", "Tool c"]);
    expect(library.materials).toEqual(base.materials);
  });

  it("keeps changes to two fields, and two rows, of one tool", () => {
    const mine = edit(base, "a", (t) => ({ ...t, flutes: 2, cutting: [{ ...t.cutting[0], rpm: 12000 }] }));
    const theirs = edit(base, "a", (t) => ({ ...t, coating: "DLC", cutting: [...t.cutting, { material: "softwood", rpm: 9000, feed: 900, plunge: 200, stepover: 1, stepdown: 1 }] }));
    const { library, lost } = mergeLibraries(base, mine, theirs);
    expect(lost).toEqual([]);
    const a = library.tools[0];
    expect(a.flutes).toBe(2);
    expect(a.coating).toBe("DLC");
    expect(a.cutting.map((c) => [c.material, c.rpm])).toEqual([
      ["hardwood", 12000],
      ["softwood", 9000],
    ]);
  });

  it("keeps cuts logged on both sides", () => {
    const logged = (text: string) => (t: Tool) => ({ ...t, cutting: [{ ...t.cutting[0], log: [...(t.cutting[0].log ?? []), { date: "2026-11-21", text }] }] });
    const start = edit(base, "a", logged("first"));
    const { library, lost } = mergeLibraries(start, edit(start, "a", logged("mine")), edit(start, "a", logged("theirs")));
    expect(lost).toEqual([]);
    expect(library.tools[0].cutting[0].log?.map((e) => e.text)).toEqual(["first", "theirs", "mine"]);
  });

  it("keeps the server's value where both changed the same one, and names the tool", () => {
    const mine = edit(base, "a", (t) => ({ ...t, diameter: 4 }));
    const theirs = edit(base, "a", (t) => ({ ...t, diameter: 5 }));
    const { library, lost } = mergeLibraries(base, mine, theirs);
    expect(library.tools[0].diameter).toBe(5);
    expect(lost).toEqual(['the tool "Tool a"']);
  });

  it("names the tool when two changes to one row clash", () => {
    const mine = edit(base, "a", (t) => ({ ...t, cutting: [{ ...t.cutting[0], feed: 1 }] }));
    const theirs = edit(base, "a", (t) => ({ ...t, cutting: [{ ...t.cutting[0], feed: 2 }] }));
    expect(mergeLibraries(base, mine, theirs).lost).toEqual(['the tool "Tool a"']);
  });

  it("places a tool added here after the one it follows, among tools added there", () => {
    const mine = { ...base, tools: [base.tools[0], tool("new-here"), ...base.tools.slice(1)] };
    const theirs = { ...base, tools: [...base.tools, tool("new-there")] };
    const { library } = mergeLibraries(base, mine, theirs);
    expect(library.tools.map((t) => t.id)).toEqual(["a", "new-here", "b", "c", "new-there"]);
  });

  it("takes a deletion from either side, and a reorder made only here", () => {
    const mine = { ...base, tools: [base.tools[2], base.tools[0], base.tools[1]] };
    const theirs = { ...base, tools: base.tools.filter((t) => t.id !== "b") };
    const { library, lost } = mergeLibraries(base, mine, theirs);
    expect(lost).toEqual([]);
    expect(library.tools.map((t) => t.id)).toEqual(["c", "a"]);
  });

  it("does not take a key order for a change", () => {
    const mine = edit(base, "a", (t) => Object.fromEntries(Object.entries(t).reverse()) as unknown as Tool);
    const theirs = edit(base, "a", (t) => ({ ...t, name: "Theirs" }));
    const { library, lost } = mergeLibraries(base, mine, theirs);
    expect(lost).toEqual([]);
    expect(library.tools[0].name).toBe("Theirs");
  });

  it("merges materials by key", () => {
    const mine = { ...base, materials: [...base.materials!, { key: "oak" }] } as ToolLibrary;
    const theirs = { ...base, materials: [{ key: "walnut", label: "Black walnut" }] } as ToolLibrary;
    const { library, lost } = mergeLibraries(base, mine, theirs);
    expect(lost).toEqual([]);
    expect(library.materials).toEqual([{ key: "walnut", label: "Black walnut" }, { key: "oak" }]);
  });
});
