import { describe, expect, it } from "vitest";
import { object, problemWith } from "./schema";

const schema = object(
  {
    shape: { type: "string", enum: ["rectangle", "ellipse"] },
    width: { type: "number", exclusiveMinimum: 0 },
    ids: { type: "array", items: { type: "integer", minimum: 0 }, minItems: 1 },
    task: { type: "object" },
    tool: { type: "string", nullable: true },
  },
  ["shape"],
);

describe("problemWith", () => {
  it("lets through what fits", () => {
    expect(problemWith({ shape: "rectangle", width: 2.5, ids: [0, 3], task: { anything: 1 }, tool: null }, schema)).toBeNull();
  });

  it("names a key the command does not take", () => {
    expect(problemWith({ shape: "rectangle", wdth: 3 }, schema)).toMatch(/input\.wdth is not something this command takes\. It takes: shape, width/);
  });

  it("asks for what is needed", () => {
    expect(problemWith({}, schema)).toBe("input.shape is needed");
  });

  it("says where a value does not fit", () => {
    expect(problemWith({ shape: "star" }, schema)).toMatch(/input\.shape must be one of "rectangle", "ellipse"/);
    expect(problemWith({ shape: "ellipse", width: 0 }, schema)).toBe("input.width must be greater than 0");
    expect(problemWith({ shape: "ellipse", ids: [1, 1.5] }, schema)).toBe("input.ids[1] must be a whole number");
    expect(problemWith({ shape: "ellipse", ids: [] }, schema)).toBe("input.ids must have 1 or more entries");
    expect(problemWith({ shape: "ellipse", width: "3" }, schema)).toBe("input.width must be a number");
    expect(problemWith([], schema)).toBe("input must be an object");
  });
});
