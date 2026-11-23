// The app's reducer, as far as the Projects tab goes: a move shown at once,
// and what a notice said on one view not said on another.

import { describe, expect, it, vi } from "vitest";

vi.mock("../core/client", () => ({ core: { call: () => Promise.reject(new Error("no core in a test")) } }));

import { initial as start, reducer, type Action, type AppState } from "./store";

const run = (state: AppState, ...actions: Action[]) => actions.reduce(reducer, state);
const shelf: AppState = {
  ...start,
  view: "projects",
  projects: [
    { id: "a", name: "A", modified: 1, folder: "" },
    { id: "b", name: "B", modified: 2, folder: "Gifts" },
    { id: "c", name: "C", modified: 3, folder: "Gifts" },
  ],
  folders: ["Gifts", "Orders"],
};

describe("projects moved", () => {
  it("are shown in their new folder at once, the others where they are", () => {
    const after = run(shelf, { type: "refileProjects", ids: ["a", "b"], folder: "Orders" });
    expect(after.projects.map((p) => [p.id, p.folder])).toEqual([
      ["a", "Orders"],
      ["b", "Orders"],
      ["c", "Gifts"],
    ]);
    expect(after.folders).toBe(shelf.folders);
  });
});

describe("a notice", () => {
  const undo = { label: "Undo", run: () => undefined };

  it("that says what was done goes when another view is shown", () => {
    const said = run(shelf, { type: "notice", notice: { kind: "info", text: "Moved.", action: undo } });
    expect(said.notice?.action).toBe(undo);
    expect(run(said, { type: "setView", view: "design" }).notice).toBeNull();
    // The same view again is no other view.
    expect(run(said, { type: "setView", view: "projects" }).notice).toBe(said.notice);
  });

  it("goes however the view changes, as when a project is opened, but not when the change itself says something", () => {
    const said = run(shelf, { type: "notice", notice: { kind: "info", text: "Moved.", action: undo } });
    const opened = run(said, { type: "openProject", project: start.project });
    expect(opened.view).toBe("design");
    expect(opened.notice).toBeNull();
    // A notice set on the same view stays; one the action sets is its own.
    expect(run(said, { type: "setScope", scope: { kind: "unfiled" } }).notice).toBe(said.notice);
  });

  it("of an error stays until it is dismissed", () => {
    const said = run(shelf, { type: "notice", notice: { kind: "error", text: "Failed." } });
    expect(run(said, { type: "setView", view: "design" }).notice).toEqual({ kind: "error", text: "Failed." });
  });
});
