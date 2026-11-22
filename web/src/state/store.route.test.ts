// The app's reducer, as far as addresses go: what a route does to the state
// when the page is loaded at it, and when the Back button comes to it.

import { describe, expect, it, vi } from "vitest";

vi.mock("../core/client", () => ({ core: { call: () => Promise.reject(new Error("no core in a test")) } }));

import type { Project } from "../core/types";
import { newProject, newStep } from "./model";
import { formatRoute, routeOf, type Route } from "./route";
import { initial as start, reducer, type Action, type AppState } from "./store";

const SQUARE = { id: 1, outer: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [] };

/** A kept project with a drawing and two inlays. */
function project(): Project {
  const blank = newProject("Coaster");
  const design = { width: 100, height: 100, regions: [SQUARE, { ...SQUARE, id: 2 }] } as unknown as Project["design"];
  const first = newStep("flat", [1], [], blank.setup);
  const second = newStep("flat", [2], [first], blank.setup);
  return { ...blank, design, steps: [first, second] };
}

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state);
}

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

const at = (open: Project, change: Partial<Extract<Route, { view: "design" }>> = {}): Route => ({ view: "design", project: open.id, panel: "list", step: null, stage: "drawing", at: 0, ...change });

describe("the page loaded at an address", () => {
  it("opens where the address says", () => {
    const open = project();
    const [, second] = open.steps;
    const state = loaded(open, at(open, { step: second.id }));
    expect(state).toMatchObject({ ready: true, view: "design", activeStepId: second.id });
    expect(formatRoute(routeOf(state))).toBe(`#/p/${open.id}/step/${second.id}`);
  });

  it("asks for the pocket the address names to be made again, and lets go of that when it is", () => {
    const open = project();
    const [first] = open.steps;
    const state = loaded(open, at(open, { step: first.id, stage: "pocket" }));
    expect(state.restore).toEqual({ stepId: first.id, stage: "pocket" });
    expect(formatRoute(routeOf(state))).toBe(`#/p/${open.id}/step/${first.id}/pocket`);
    // It could not be made: the address is the step's.
    const failed = run(state, { type: "restored" });
    expect(failed.restore).toBeNull();
    expect(formatRoute(routeOf(failed))).toBe(`#/p/${open.id}/step/${first.id}`);
  });

  it("shows the stock at the point the address names, once it is worked out", () => {
    const open = project();
    const state = loaded(open, at(open, { stage: "timeline", at: 1 }));
    expect(state).toMatchObject({ stage: "timeline", timelineAt: 1, stockAt: 1 });
    expect(formatRoute(routeOf(state))).toBe(`#/p/${open.id}/stock/1`);
    // The fresh stock is a point like any other.
    const fresh = loaded(open, at(open, { stage: "timeline", at: 0 }));
    expect(fresh).toMatchObject({ stage: "timeline", timelineAt: 0, stockAt: 0 });
    // Worked out: the point is no longer waited for.
    const result = { steps: [{}, {}] } as unknown as NonNullable<AppState["timeline"]>["result"];
    const worked = run(fresh, { type: "setTimeline", timeline: { project: fresh.project, result, errors: [] } }, { type: "setTimelineAt", at: 0 });
    expect(worked).toMatchObject({ stockAt: null, timelineAt: 0 });
    expect(formatRoute(routeOf(worked))).toBe(`#/p/${open.id}/stock/0`);
  });

  it("starts at the open project's list without one", () => {
    const open = project();
    expect(formatRoute(routeOf(loaded(open, null)))).toBe(`#/p/${open.id}`);
  });

  it("shows the folder the address names, and all projects when it is gone", () => {
    const open = project();
    const route: Route = { view: "projects", scope: { kind: "folder", path: "Gifts" } };
    expect(formatRoute(routeOf(loaded(open, route, ["Gifts"])))).toBe("#/projects/in/Gifts");
    expect(formatRoute(routeOf(loaded(open, route)))).toBe("#/projects");
  });
});

describe("going to an address while the page is open", () => {
  it("opens a step without making its pocket again, and ends the editing of the drawing", () => {
    const open = project();
    const [first] = open.steps;
    const editing = run(loaded(open, null), { type: "setArranging", on: true }, { type: "setSelection", ids: [1] });
    expect(editing).toMatchObject({ arranging: true, selection: [1] });
    const state = run(editing, { type: "goTo", route: at(open, { step: first.id, stage: "pocket" }) });
    expect(state).toMatchObject({ activeStepId: first.id, stage: "drawing", restore: null, arranging: false, selection: [] });
  });

  it("leaves the drawing as it is being edited when it goes to another view and back to the list", () => {
    const open = project();
    const editing = run(loaded(open, null), { type: "setArranging", on: true }, { type: "setSelection", ids: [1] });
    const there = run(editing, { type: "goTo", route: { view: "settings", page: "machine", tool: null } });
    expect(there).toMatchObject({ view: "settings", settingsPage: "machine", arranging: true, selection: [1] });
    const back = run(there, { type: "goTo", route: at(open) });
    expect(back).toMatchObject({ view: "design", arranging: true, selection: [1] });
  });

  it("follows the folder shown, and shows all projects when the folder goes", () => {
    const state = run(loaded(project(), null, ["Gifts"]), { type: "setScope", scope: { kind: "folder", path: "Gifts" } }, { type: "setView", view: "projects" });
    expect(formatRoute(routeOf(state))).toBe("#/projects/in/Gifts");
    // The folder is deleted somewhere else.
    const gone = run(state, { type: "setProjects", projects: state.projects, folders: [] });
    expect(gone.scope).toEqual({ kind: "all" });
    expect(formatRoute(routeOf(gone))).toBe("#/projects");
  });

  it("follows the tool shown", () => {
    const state = run(loaded(project(), null), { type: "showTool", id: "t1" }, { type: "setView", view: "settings", page: "tools" });
    // Not one of the tools: the address is the list's.
    expect(formatRoute(routeOf(state))).toBe("#/tools");
    expect(state.toolId).toBe("t1");
  });

  it("lets go of a pocket asked for when the list or another step is opened", () => {
    const open = project();
    const [first, second] = open.steps;
    const asked = loaded(open, at(open, { step: first.id, stage: "pocket" }));
    expect(run(asked, { type: "setActiveStep", id: null }).restore).toBeNull();
    expect(run(asked, { type: "setActiveStep", id: second.id }).restore).toBeNull();
  });

  it("lets go of a pocket asked for when another project is opened", () => {
    const open = project();
    const [first] = open.steps;
    const asked = loaded(open, at(open, { step: first.id, stage: "pocket" }));
    const other = run(asked, { type: "openProject", project: project() });
    expect(other).toMatchObject({ restore: null, activeStepId: null, stage: "drawing" });
  });
});
