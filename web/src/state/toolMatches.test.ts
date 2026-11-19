import { describe, expect, it } from "vitest";
import type { Tool } from "../core/types";
import { toolMatches } from "./model";

const mill = { id: "a", name: "1/8 2F upcut", kind: "flat_end", diameter: 3.175, shankDiameter: 3.175, group: "Makera kit", cutting: [] } as unknown as Tool;
const vbit = { id: "b", name: "Engraving bit", kind: "v_bit", diameter: 6, tipAngle: 30, shankDiameter: 6, cutting: [] } as unknown as Tool;

describe("toolMatches", () => {
  it("matches everything when nothing is typed", () => {
    expect(toolMatches(mill, mill.name, "  ")).toBe(true);
  });
  it("wants every word, in any order and case", () => {
    expect(toolMatches(mill, mill.name, "UPCUT 1/8")).toBe(true);
    expect(toolMatches(mill, mill.name, "upcut 6")).toBe(false);
  });
  it("finds a tool by its diameter, with a comma or a point", () => {
    expect(toolMatches(mill, mill.name, "3,175")).toBe(true);
    expect(toolMatches(mill, mill.name, "ø3.175")).toBe(true);
  });
  it("finds a tool by its kind, group, angle and project number", () => {
    expect(toolMatches(vbit, vbit.name, "v-bit 30°")).toBe(true);
    expect(toolMatches(mill, mill.name, "makera")).toBe(true);
    expect(toolMatches(mill, `T3 · ${mill.name}`, "t3")).toBe(true);
  });
});
