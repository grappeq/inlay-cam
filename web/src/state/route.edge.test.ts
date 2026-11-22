// Addresses at their edges, from an independent tester's pass: names with
// letters an address keeps for itself, and what is left behind when the
// page turns away from what an address asked for.

import { describe, expect, it, vi } from "vitest";

vi.mock("../core/client", () => ({ core: { call: () => Promise.reject(new Error("no core in a test")) } }));

import type { Project } from "../core/types";
import { newProject, newStep } from "./model";
import { formatRoute, moveFor, parseRoute, projectsToTry, routeOf, sameEntry, writeFor, type Route } from "./route";
import { initial as start, reducer, type Action, type AppState } from "./store";

const SQUARE = { id: 1, outer: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [] };
function project(): Project {
  const blank = newProject("Coaster");
  const design = { width: 100, height: 100, regions: [SQUARE, { ...SQUARE, id: 2 }] } as unknown as Project["design"];
  const first = newStep("flat", [1], [], blank.setup);
  const second = newStep("flat", [2], [first], blank.setup);
  return { ...blank, design, steps: [first, second] };
}
const run = (s: AppState, ...a: Action[]) => a.reduce(reducer, s);
function loaded(open: Project, route: Route | null, folders: string[] = []): AppState {
  return reducer(start, {
    type: "loaded",
    tools: [],
    lists: {},
    home: "browser",
    machine: start.machine,
    defaults: start.defaults,
    project: open,
    projects: [{ id: open.id, name: open.name, modified: 1, folder: "", steps: open.steps.length }],
    folders,
    route,
  });
}
const at = (open: Project, c: Partial<Extract<Route, { view: "design" }>> = {}): Route => ({ view: "design", project: open.id, panel: "list", step: null, stage: "drawing", at: 0, ...c });

const ODD = ["a/b", "100%", "%2F", "é", "日本", "..", ".", "step", "stock", "new", "p", " ", "?", "#", "&agent=1234:abcdefgh", "a b", "x%", "%", "😀", "tools", "export", "unfiled", "in"];

describe("odd names round trip", () => {
  for (const id of ODD) {
    it(`project/step ${JSON.stringify(id)}`, () => {
      const r: Route = { view: "design", project: id, panel: "list", step: id, stage: "pocket", at: 0 };
      expect(parseRoute(formatRoute(r))).toEqual(r);
      const t: Route = { view: "design", project: id, panel: "tools", step: null, stage: "timeline", at: 7 };
      expect(parseRoute(formatRoute(t))).toEqual(t);
      const s: Route = { view: "settings", page: "tools", tool: id };
      expect(parseRoute(formatRoute(s))).toEqual(s);
      const f: Route = { view: "projects", scope: { kind: "folder", path: `${id}/${id}` } };
      expect(parseRoute(formatRoute(f))).toEqual(f);
    });
  }
  it("a lone surrogate in an id does not throw while formatting (it would crash the render)", () => {
    expect(() => formatRoute({ view: "design", project: "a\uD800", panel: "list", step: null, stage: "drawing", at: 0 })).not.toThrow();
  });
});

describe("parse leniency", () => {
  it("garbage names no route", () => {
    for (const h of ["", "#", "#/", "#/garbage", "#/p", "#/p/", "#/p//step/a", "#/p/x/%E0%A4%A"]) expect(parseRoute(h), h).toBeNull();
  });
  it("timeline position forms", () => {
    expect(parseRoute("#/p/x/stock/9999999")).toMatchObject({ stage: "timeline", at: 0 });
    expect(parseRoute("#/p/x/stock/-1")).toMatchObject({ stage: "timeline", at: 0 });
    expect(parseRoute("#/p/x/step/s/stock/2")).toMatchObject({ step: "s", stage: "timeline", at: 2 });
    expect(parseRoute("#/p/x/pocket")).toMatchObject({ stage: "drawing" });
  });
});

describe("applyRoute edge cases", () => {
  it("timeline position past the end is clamped, also when the stock is not worked out", () => {
    const open = project();
    const s = loaded(open, at(open, { stage: "timeline", at: 99 }));
    expect(s.stage).toBe("timeline");
    expect(s.timelineAt).toBe(2);
  });
  it("a step deleted while open: the address falls to the panel", () => {
    const open = project();
    const s = loaded(open, at(open, { step: open.steps[0].id }));
    const gone = run(s, { type: "updateProject", update: (p: Project) => ({ ...p, steps: p.steps.slice(1) }) } as Action);
    expect(formatRoute(routeOf(gone))).toBe(`#/p/${open.id}`);
  });
  it("restore for a step is not left behind when another step is opened from the list", () => {
    const open = project();
    const [a, b] = open.steps;
    const s = loaded(open, at(open, { step: a.id, stage: "pocket" }));
    expect(s.restore).not.toBeNull();
    const t = run(s, { type: "setActiveStep", id: b.id });
    expect(t.restore).toBeNull();
  });
  it("restore is dropped when going to another view", () => {
    const open = project();
    const [a] = open.steps;
    const s = loaded(open, at(open, { step: a.id, stage: "pocket" }));
    const t = run(s, { type: "goTo", route: { view: "projects", scope: { kind: "all" } } });
    expect(t.restore).toBeNull();
  });
  it("a folder gone while shown gives way to all", () => {
    const open = project();
    const s = run(loaded(open, { view: "projects", scope: { kind: "folder", path: "a/b" } }, ["a", "a/b"]), { type: "setProjects", projects: [], folders: ["a"] });
    expect(formatRoute(routeOf(s))).toBe("#/projects");
  });
  it("an address naming a tool that does not exist shows the list, and does not keep the tool in mind", () => {
    const open = project();
    const s = loaded(open, parseRoute("#/tools/nonexistent"));
    expect(s.toolId).toBeNull();
    expect(formatRoute(routeOf(s))).toBe("#/tools");
  });
});

describe("decisions", () => {
  it("sameEntry ignores stage and at", () => {
    const a: Route = { view: "design", project: "x", panel: "list", step: "s", stage: "pocket", at: 0 };
    expect(sameEntry(a, { ...a, stage: "fit" })).toBe(true);
    expect(sameEntry({ ...a, stage: "timeline", at: 3 }, { ...a, stage: "timeline", at: 4 })).toBe(true);
  });
  it("new -> kept replaces; kept -> new pushes", () => {
    const n: Route = { view: "design", project: null, panel: "list", step: null, stage: "drawing", at: 0 };
    const k = { ...n, project: "x" };
    expect(writeFor(n, k)).toBe("replace");
    expect(writeFor(k, n)).toBe("push");
  });
  it("moveFor: a different project opens it", () => {
    const open = project();
    const s = loaded(open, null);
    expect(moveFor(s, "#/p/other", () => true)).toMatchObject({ kind: "go", open: "other" });
    expect(moveFor(s, "#/new", () => true)).toMatchObject({ kind: "go", open: null });
    expect(moveFor(s, `#/p/${open.id}`, () => true)).toMatchObject({ kind: "stay" });
  });
  it("moveFor: mayLeave refusing pushes the address back", () => {
    const open = project();
    const s = loaded(open, null);
    const m = moveFor(s, `#/p/${open.id}/step/${open.steps[0].id}/pocket`, () => false);
    expect(m).toEqual({ kind: "stay", how: "push" });
  });
  it("projectsToTry", () => {
    expect(projectsToTry(null, "a", "a")).toEqual({ blank: false, named: null, others: ["a"] });
    expect(projectsToTry({ view: "design", project: "a", panel: "list", step: null, stage: "drawing", at: 0 }, "a", "b")).toEqual({ blank: false, named: "a", others: ["b"] });
  });
});
