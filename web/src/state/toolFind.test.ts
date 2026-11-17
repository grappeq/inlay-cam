import { describe, expect, it } from "vitest";
import type { Tool } from "../core/types";
import { chipCounts, chipsMatch, chipsText, cleanChips, comparator, cycleChip, matchesQuery, noChips, noMatchText, parseQuery, searchWords, sizeOf, styleLayout, vBitKind } from "./toolFind";

const tool = (name: string, kind: Tool["kind"], diameter: number, more: Partial<Tool> = {}): Tool => ({ id: name, name, kind, diameter, shankDiameter: diameter, cutting: [], ...more });

const mill = tool("Ø3.175×22 1F Downcut", "flat_end", 3.175, { fluteLength: 22, flutes: 1, style: "Downcut", coating: "DLC", group: "End mills", recommendedFor: ["hardwood", "softwood"] });
const alu = tool("Ø6×18 3F Alu", "flat_end", 6, { fluteLength: 18, flutes: 3, style: "Alu", recommendedFor: ["aluminum"], source: { url: "https://shop.example.com/x" } });
const groove = tool("60° V-groove Ø12 S6", "v_bit", 12, { shankDiameter: 6, tipAngle: 60, tipDiameter: 0.1, flutes: 2 });
const chamfer = tool("90° Chamfer Ø6", "v_bit", 6, { tipAngle: 90, tipDiameter: 0 });
const engraver = tool("0.2×30° Engraver S3.175", "v_bit", 3.175, { tipAngle: 30, tipDiameter: 0.2 });
const rounder = tool("R1 Corner Round Ø4", "corner_round", 4, { tipDiameter: 2, cornerRadius: 1, flutes: 4 });
const thread = tool("M3×0.5 Thread Mill", "thread_mill", 2.42, { shankDiameter: 4, threadDiameter: 3, pitch: 0.5, flutes: 3 });
const drill = tool("Ø2.7 Drill", "drill", 2.7, { shankDiameter: 4, tipAngle: 118 });
const all = [mill, alu, groove, chamfer, engraver, rounder, thread, drill];
const found = (query: string) => all.filter((t) => matchesQuery(searchWords(t), parseQuery(query))).map((t) => t.name);

describe("the size a tool is picked by", () => {
  it("is told by its kind", () => {
    expect(sizeOf(mill).text).toBe("Ø3.175 × 22");
    expect(sizeOf(drill).text).toBe("Ø2.7");
    expect(sizeOf(groove).text).toBe("60° Ø12");
    expect(sizeOf(engraver)).toEqual({ text: "0.2 × 30°", main: 0.2 });
    expect(sizeOf(rounder).text).toBe("R1 Ø4");
    expect(sizeOf(thread)).toEqual({ text: "M3 × 0.5", main: 3 });
  });

  it("tells a V-groove from a chamfer by the shank, and an engraver by its angle or name", () => {
    expect(vBitKind(groove)).toBe("vgroove");
    expect(vBitKind(chamfer)).toBe("chamfer");
    expect(vBitKind(engraver)).toBe("engraver");
    expect(vBitKind({ ...chamfer, name: "0.1×60° Engraver" })).toBe("engraver");
    expect(vBitKind(rounder)).toBe("radius");
  });
});

describe("search", () => {
  it("reads sizes however they are typed", () => {
    expect(found("1/8")).toEqual([mill.name, engraver.name]);
    expect(found("3,175 22")).toEqual([mill.name]);
    expect(found("6x18")).toEqual([alu.name]);
    expect(found("ø6")).toEqual([alu.name, chamfer.name]);
    expect(found("3 flute")).toEqual([alu.name, thread.name]);
    expect(found("m3")).toEqual([thread.name]);
    expect(found("r1")).toEqual([rounder.name]);
    expect(found("s6")).toEqual([alu.name, groove.name, chamfer.name]);
  });

  it("finds by kind, style, coating, material, group and vendor", () => {
    expect(found("vbit")).toEqual([groove.name, chamfer.name, engraver.name, rounder.name]);
    expect(found("fillet")).toEqual([rounder.name]);
    expect(found("down")).toEqual([mill.name]);
    expect(found("dlc")).toEqual([mill.name]);
    expect(found("alu")).toEqual([alu.name]);
    expect(found("aluminium")).toEqual([alu.name]);
    expect(found("example")).toEqual([alu.name]);
    expect(found("end mills hardwood")).toEqual([mill.name]);
  });

  it("needs every word, and a number whole", () => {
    expect(found("6 dlc")).toEqual([]);
    expect(found("1")).toEqual([mill.name === "x" ? "" : rounder.name].filter((n) => n === rounder.name));
    expect(found("")).toHaveLength(all.length);
  });
});

describe("sorting", () => {
  const index = (t: Tool) => all.indexOf(t);
  const order = (key: Parameters<typeof comparator>[0]) => [...all].sort(comparator(key, index)).map((t) => t.name);

  it("orders by size, by flute length with the unknown last, and by name with numbers as numbers", () => {
    expect(order("dia").slice(0, 3)).toEqual([engraver.name, drill.name, thread.name]);
    expect(order("flute").slice(0, 2)).toEqual([alu.name, mill.name]);
    expect(order("name")[0]).toBe(engraver.name);
    expect(order("name").indexOf(chamfer.name)).toBeGreaterThan(order("name").indexOf(groove.name));
  });
});

describe("filter chips", () => {
  it("step off, only, hide, off", () => {
    let chips = cycleChip(noChips(), "shank", "6");
    expect(chips.shank).toEqual({ only: ["6"], hide: [] });
    chips = cycleChip(chips, "shank", "6");
    expect(chips.shank).toEqual({ only: [], hide: ["6"] });
    expect(cycleChip(chips, "shank", "6").shank).toEqual({ only: [], hide: [] });
  });

  it("show any of a row's only options, and never a hidden one", () => {
    const chips = { ...noChips(), shank: { only: ["6", "4"], hide: [] }, style: { only: [], hide: ["alu"] } };
    expect(all.filter((t) => chipsMatch(t, chips)).map((t) => t.name)).toEqual([groove.name, chamfer.name, rounder.name, thread.name, drill.name]);
    expect(chipsText(chips)).toEqual(["Shank 6 or 4", "Style not alu"]);
    const material = { ...noChips(), material: { only: ["aluminum"], hide: [] } };
    expect(all.filter((t) => chipsMatch(t, material))).toEqual([alu]);
  });

  it("count an option by the other rows' choices, not its own row's", () => {
    const chips = { ...noChips(), shank: { only: ["6"], hide: [] }, flutes: { only: ["3+"], hide: [] } };
    const counts = chipCounts(all, chips, { style: ["alu", "downcut"], material: ["aluminum"] });
    expect(counts.shank).toEqual({ "3.175": 0, "4": 2, "6": 1 });
    expect(counts.flutes["2"]).toBe(1);
    expect(counts.style).toEqual({ alu: 1, downcut: 0 });
  });

  it("put the commonest styles first and the rest under More", () => {
    const layout = styleLayout(all);
    expect(layout.chips).toEqual(["alu", "downcut"]);
    expect(layout.more).toEqual([""]);
    expect(layout.labels.get("downcut")).toBe("Downcut");
  });

  it("come back from storage whole or not at all", () => {
    expect(cleanChips({ shank: { only: ["6", 7, "6"], hide: ["6", "4"] }, nonsense: 1 })).toEqual({ ...noChips(), shank: { only: ["6"], hide: ["4"] } });
    expect(cleanChips("junk")).toEqual(noChips());
  });

  it("say what matched nothing", () => {
    expect(noMatchText("1/8 alu", ["Shank 6"], null)).toBe("No tool matches “1/8 alu” with Shank 6.");
    expect(noMatchText("", [], "Failed rows")).toBe("No tool is in “Failed rows”.");
  });
});
