import { describe, expect, it } from "vitest";
import { applyRoute, formatRoute, moveFor, parseRoute, projectAtStart, projectInAddress, projectsToTry, routeOf, sameEntry, stageMade, writeFor, type Place, type Route } from "./route";

const place = (change: Partial<Place> = {}): Place => ({
  view: "design",
  settingsPage: "tools",
  scope: { kind: "all" },
  toolId: null,
  activeStepId: null,
  stage: "drawing",
  panelPage: "list",
  timelineAt: 0,
  stockAt: null,
  restore: null,
  project: { id: "p1", design: {}, steps: [{ id: "s1" }, { id: "s2" }] },
  projects: [{ id: "p1" }],
  folders: ["Gifts", "Gifts/Christmas"],
  tools: [{ id: "t1" }],
  output: null,
  timeline: null,
  ...change,
});

const design = (change: Partial<Extract<Route, { view: "design" }>> = {}): Route => ({ view: "design", project: "p1", panel: "list", step: null, stage: "drawing", at: 0, ...change });

/** Every kind of place, with the address it has. */
const ADDRESSES: [string, Route][] = [
  ["#/new", design({ project: null })],
  ["#/p/p1", design()],
  ["#/p/p1/tools", design({ panel: "tools" })],
  ["#/p/p1/export", design({ panel: "export" })],
  ["#/p/p1/step/s1", design({ step: "s1" })],
  ["#/p/p1/step/s1/pocket", design({ step: "s1", stage: "pocket" })],
  ["#/p/p1/step/s1/plug", design({ step: "s1", stage: "plug" })],
  ["#/p/p1/step/s1/fit", design({ step: "s1", stage: "fit" })],
  ["#/p/p1/stock/0", design({ stage: "timeline", at: 0 })],
  ["#/p/p1/export/stock/2", design({ panel: "export", stage: "timeline", at: 2 })],
  ["#/p/p1/step/s2/stock/2", design({ step: "s2", stage: "timeline", at: 2 })],
  ["#/projects", { view: "projects", scope: { kind: "all" } }],
  ["#/projects/unfiled", { view: "projects", scope: { kind: "unfiled" } }],
  ["#/projects/in/Gifts/Christmas", { view: "projects", scope: { kind: "folder", path: "Gifts/Christmas" } }],
  ["#/tools", { view: "settings", page: "tools", tool: null }],
  ["#/tools/t1", { view: "settings", page: "tools", tool: "t1" }],
  ["#/settings/materials", { view: "settings", page: "materials", tool: null }],
  ["#/settings/profiles", { view: "settings", page: "profiles", tool: null }],
  ["#/settings/machine", { view: "settings", page: "machine", tool: null }],
  ["#/settings/defaults", { view: "settings", page: "defaults", tool: null }],
  ["#/settings/agent", { view: "settings", page: "agent", tool: null }],
];

describe("an address", () => {
  it("is written for every kind of place, and read back as the same place", () => {
    for (const [hash, route] of ADDRESSES) {
      expect(formatRoute(route), hash).toBe(hash);
      expect(parseRoute(hash), hash).toEqual(route);
    }
  });

  it("carries names with letters an address keeps for itself, and reads them back", () => {
    const path = "Żółw & co/50% off #1/a b?c";
    const hash = formatRoute({ view: "projects", scope: { kind: "folder", path } });
    expect(hash).toBe("#/projects/in/%C5%BB%C3%B3%C5%82w%20%26%20co/50%25%20off%20%231/a%20b%3Fc");
    expect(parseRoute(hash)).toEqual({ view: "projects", scope: { kind: "folder", path } });
    const tool = "em 1/8\" #2";
    expect(parseRoute(formatRoute({ view: "settings", page: "tools", tool }))).toEqual({ view: "settings", page: "tools", tool });
    // Only letters a browser leaves as they are, so that what is written is what is read.
    expect(hash).toMatch(/^#[A-Za-z0-9\-_.!~*'()%/]+$/);
  });

  it("names no place when it is empty, an agent's pairing link, or not this app's", () => {
    for (const hash of ["", "#", "#/", "#agent=4000:abcdefgh1234", "#/nowhere", "#/p", "#/p/", "#projects", "#/tools/%E0%A4%A"]) {
      expect(parseRoute(hash), hash).toBeNull();
    }
  });

  it("leads as far as it is understood", () => {
    expect(parseRoute("#/p/p1/")).toEqual(design());
    expect(parseRoute("#/p/p1/nonsense/more")).toEqual(design());
    expect(parseRoute("#/p/p1/step")).toEqual(design());
    expect(parseRoute("#/p/p1/step/s1/nonsense")).toEqual(design({ step: "s1" }));
    // A pocket is a step's: without one there is only the drawing.
    expect(parseRoute("#/p/p1/pocket")).toEqual(design());
    expect(parseRoute("#/p/p1/stock")).toEqual(design({ stage: "timeline", at: 0 }));
    expect(parseRoute("#/p/p1/stock/-1")).toEqual(design({ stage: "timeline", at: 0 }));
    expect(parseRoute("#/p/p1/stock/1e3")).toEqual(design({ stage: "timeline", at: 0 }));
    expect(parseRoute("#/projects/in")).toEqual({ view: "projects", scope: { kind: "all" } });
    expect(parseRoute("#/projects/in/a//b")).toEqual({ view: "projects", scope: { kind: "all" } });
    expect(parseRoute("#/projects/elsewhere")).toEqual({ view: "projects", scope: { kind: "all" } });
    expect(parseRoute("#/settings")).toEqual({ view: "settings", page: "materials", tool: null });
    expect(parseRoute("#/settings/nonsense")).toEqual({ view: "settings", page: "materials", tool: null });
    // The tools are a settings page, with an address of their own.
    expect(parseRoute("#/settings/tools")).toEqual({ view: "settings", page: "tools", tool: null });
  });

  it("is written for a name no address can carry, half a pair of UTF-16 units, without failing", () => {
    const hash = formatRoute({ view: "settings", page: "tools", tool: "a\uD800b" });
    expect(hash).toBe("#/tools/a%EF%BF%BDb");
    expect(formatRoute(design({ project: "\uDC00", step: "x\uD83D" }))).toBe("#/p/%EF%BF%BD/step/x%EF%BF%BD");
    // A whole pair is a letter like any other.
    expect(parseRoute(formatRoute({ view: "settings", page: "tools", tool: "\uD83D\uDE00" }))).toEqual({ view: "settings", page: "tools", tool: "\uD83D\uDE00" });
  });
});

describe("where the page is", () => {
  it("is the open project's list, panel page or step", () => {
    expect(routeOf(place())).toEqual(design());
    expect(routeOf(place({ panelPage: "export" }))).toEqual(design({ panel: "export" }));
    expect(routeOf(place({ activeStepId: "s2" }))).toEqual(design({ step: "s2" }));
    // An open step has the panel: the page it was on before is not said.
    expect(routeOf(place({ activeStepId: "s2", panelPage: "tools" }))).toEqual(design({ step: "s2" }));
    // A step that is gone is not named.
    expect(routeOf(place({ activeStepId: "gone", panelPage: "tools" }))).toEqual(design({ panel: "tools" }));
  });

  it("names a blank project that is not kept as new, and any other by its id", () => {
    const blank = { id: "p9", design: null, steps: [] };
    expect(projectInAddress({ project: blank, projects: [{ id: "p1" }] })).toBeNull();
    expect(formatRoute(routeOf(place({ project: blank })))).toBe("#/new");
    // Kept, though blank; and with a drawing, though its first save is still on its way.
    expect(projectInAddress({ project: blank, projects: [{ id: "p9" }] })).toBe("p9");
    expect(projectInAddress({ project: { ...blank, design: {} }, projects: [] })).toBe("p9");
    expect(projectInAddress({ project: { ...blank, steps: [{ id: "s" }] }, projects: [] })).toBe("p9");
  });

  it("names a step's pocket, plug or fit only when it is there to show, or being made again", () => {
    const at = place({ activeStepId: "s1", stage: "pocket" });
    expect(routeOf(at)).toEqual(design({ step: "s1" }));
    expect(routeOf({ ...at, output: { stepId: "s2", parts: { pocket: {} }, fit: null } })).toEqual(design({ step: "s1" }));
    expect(routeOf({ ...at, output: { stepId: "s1", parts: { plug: {} }, fit: null } })).toEqual(design({ step: "s1" }));
    expect(routeOf({ ...at, output: { stepId: "s1", parts: { pocket: {} }, fit: null } })).toEqual(design({ step: "s1", stage: "pocket" }));
    expect(routeOf({ ...at, stage: "fit", output: { stepId: "s1", parts: {}, fit: {} } })).toEqual(design({ step: "s1", stage: "fit" }));
    expect(routeOf({ ...at, restore: { stepId: "s1", stage: "pocket" } })).toEqual(design({ step: "s1", stage: "pocket" }));
    expect(routeOf({ ...at, restore: { stepId: "s1", stage: "plug" } })).toEqual(design({ step: "s1" }));
    // Without a step there is no pocket to show.
    expect(routeOf(place({ stage: "pocket", output: { stepId: "s1", parts: { pocket: {} }, fit: null } }))).toEqual(design());
  });

  it("names the stock and the point of the list it is shown at, while there is a list", () => {
    expect(routeOf(place({ stage: "timeline", timelineAt: 2 }))).toEqual(design({ stage: "timeline", at: 2 }));
    expect(routeOf(place({ stage: "timeline", timelineAt: 1, activeStepId: "s1" }))).toEqual(design({ step: "s1", stage: "timeline", at: 1 }));
    expect(routeOf(place({ stage: "timeline", timelineAt: 2, project: { id: "p1", design: {}, steps: [] } }))).toEqual(design());
  });

  it("is the folder shown, the tool shown, or a settings page", () => {
    expect(routeOf(place({ view: "projects", scope: { kind: "folder", path: "Gifts" } }))).toEqual({ view: "projects", scope: { kind: "folder", path: "Gifts" } });
    expect(routeOf(place({ view: "projects", scope: { kind: "folder", path: "Gone" } }))).toEqual({ view: "projects", scope: { kind: "all" } });
    expect(routeOf(place({ view: "settings", toolId: "t1" }))).toEqual({ view: "settings", page: "tools", tool: "t1" });
    expect(routeOf(place({ view: "settings", toolId: "gone" }))).toEqual({ view: "settings", page: "tools", tool: null });
    expect(routeOf(place({ view: "settings", settingsPage: "machine", toolId: "t1" }))).toEqual({ view: "settings", page: "machine", tool: null });
  });
});

describe("going to a route", () => {
  it("comes back to every place it was written for", () => {
    const places = [
      place(),
      place({ panelPage: "tools" }),
      place({ activeStepId: "s2" }),
      place({ activeStepId: "s1", stage: "fit", output: { stepId: "s1", parts: { pocket: {}, plug: {} }, fit: {} } }),
      place({ stage: "timeline", timelineAt: 1 }),
      place({ stage: "timeline", timelineAt: 2, activeStepId: "s2" }),
      place({ view: "projects", scope: { kind: "unfiled" } }),
      place({ view: "projects", scope: { kind: "folder", path: "Gifts/Christmas" } }),
      place({ view: "settings", toolId: "t1" }),
      place({ view: "settings", settingsPage: "defaults" }),
      place({ project: { id: "p9", design: null, steps: [] } }),
    ];
    for (const from of places) {
      const hash = formatRoute(routeOf(from));
      // From somewhere else altogether, with the same project open and what was made of it.
      const start = place({ view: "settings", settingsPage: "agent", project: from.project, output: from.output });
      const back = applyRoute(start, parseRoute(hash)!);
      expect(formatRoute(routeOf(back)), hash).toBe(hash);
    }
  });

  it("opens a step, and the list when the step is gone", () => {
    // Behind the step the panel keeps its page, to come back to when the step is closed.
    const open = applyRoute(place({ panelPage: "export", stage: "timeline" }), design({ step: "s2" }));
    expect(open).toMatchObject({ view: "design", activeStepId: "s2", panelPage: "export", stage: "drawing" });
    const gone = applyRoute(place({ activeStepId: "s1" }), design({ step: "gone", stage: "pocket" }));
    expect(gone).toMatchObject({ activeStepId: null, panelPage: "list", stage: "drawing", restore: null });
  });

  it("shows a pocket that is there, asks for one that is not when the page is loaded, and shows the drawing otherwise", () => {
    const route = design({ step: "s1", stage: "pocket" });
    const there = place({ output: { stepId: "s1", parts: { pocket: {} }, fit: null } });
    expect(applyRoute(there, route)).toMatchObject({ stage: "pocket", restore: null });
    expect(applyRoute(there, route, true)).toMatchObject({ stage: "pocket", restore: null });
    expect(applyRoute(place(), route)).toMatchObject({ activeStepId: "s1", stage: "drawing", restore: null });
    expect(applyRoute(place(), route, true)).toMatchObject({ activeStepId: "s1", stage: "pocket", restore: { stepId: "s1", stage: "pocket" } });
    // Another step's output is not this one's.
    expect(applyRoute(there, design({ step: "s2", stage: "pocket" }))).toMatchObject({ activeStepId: "s2", stage: "drawing" });
    // Going elsewhere lets go of what was asked for.
    const asked = applyRoute(place(), route, true);
    expect(applyRoute(asked, design({ step: "s2" }))).toMatchObject({ restore: null, stage: "drawing" });
  });

  it("shows the stock at the point named, no further than the list goes", () => {
    expect(applyRoute(place(), design({ stage: "timeline", at: 1 }))).toMatchObject({ stage: "timeline", timelineAt: 1 });
    expect(applyRoute(place(), design({ stage: "timeline", at: 99 }))).toMatchObject({ stage: "timeline", timelineAt: 2 });
    const worked = place({ timeline: { result: { steps: [{}] } } });
    expect(applyRoute(worked, design({ stage: "timeline", at: 99 }))).toMatchObject({ stage: "timeline", timelineAt: 1 });
    const empty = place({ project: { id: "p1", design: {}, steps: [] } });
    expect(applyRoute(empty, design({ stage: "timeline", at: 1 }))).toMatchObject({ stage: "drawing", timelineAt: 0 });
  });

  it("keeps the point named in mind until the stock is worked out, the fresh stock too", () => {
    // Not worked out yet: working it out would otherwise show the end of the list.
    expect(applyRoute(place(), design({ stage: "timeline", at: 0 }))).toMatchObject({ stage: "timeline", timelineAt: 0, stockAt: 0 });
    expect(applyRoute(place(), design({ stage: "timeline", at: 1 }))).toMatchObject({ timelineAt: 1, stockAt: 1 });
    // Worked out: the point is shown at once.
    const worked = place({ timeline: { result: { steps: [{}, {}] } } });
    expect(applyRoute(worked, design({ stage: "timeline", at: 0 }))).toMatchObject({ timelineAt: 0, stockAt: null });
    // Going anywhere else lets go of it, and of a pocket asked for.
    const asked = { ...applyRoute(place(), design({ stage: "timeline", at: 0 })), restore: { stepId: "s1", stage: "pocket" as const } };
    for (const to of [design(), design({ step: "s1" }), { view: "projects", scope: { kind: "all" } }, { view: "settings", page: "machine", tool: null }, design({ project: "other" })] as Route[]) {
      expect(applyRoute(asked, to), formatRoute(to)).toMatchObject({ stockAt: null, restore: null });
    }
  });

  it("only turns to the design view when the route's project is not the open one", () => {
    const from = place({ view: "projects", activeStepId: "s1", panelPage: "list" });
    const to = applyRoute(from, design({ project: "other", step: "s2", stage: "timeline", at: 1 }));
    expect(to).toMatchObject({ view: "design", activeStepId: "s1", stage: "drawing", timelineAt: 0 });
    expect(applyRoute(from, design({ project: null })).activeStepId).toBe("s1");
  });

  it("shows a folder that is there, all projects for one that is not, and leaves the project as it is", () => {
    const from = place({ activeStepId: "s1" });
    expect(applyRoute(from, { view: "projects", scope: { kind: "folder", path: "Gifts" } })).toMatchObject({ view: "projects", scope: { kind: "folder", path: "Gifts" }, activeStepId: "s1" });
    expect(applyRoute(from, { view: "projects", scope: { kind: "folder", path: "Gone" } })).toMatchObject({ view: "projects", scope: { kind: "all" } });
  });

  it("shows the list for a tool that is not there, and forgets it", () => {
    expect(applyRoute(place({ toolId: "t1" }), { view: "settings", page: "tools", tool: "gone" })).toMatchObject({ settingsPage: "tools", toolId: null });
  });

  it("shows a tool, the list without one, and keeps the tool shown while on another settings page", () => {
    expect(applyRoute(place(), { view: "settings", page: "tools", tool: "t1" })).toMatchObject({ view: "settings", settingsPage: "tools", toolId: "t1" });
    expect(applyRoute(place({ toolId: "t1" }), { view: "settings", page: "tools", tool: null })).toMatchObject({ settingsPage: "tools", toolId: null });
    expect(applyRoute(place({ toolId: "t1" }), { view: "settings", page: "machine", tool: null })).toMatchObject({ settingsPage: "machine", toolId: "t1" });
  });
});

describe("the browser's history", () => {
  it("gets an entry for another view, project, step, panel page, folder or tool", () => {
    const pairs: [Route, Route][] = [
      [design(), { view: "projects", scope: { kind: "all" } }],
      [design(), design({ project: "p2" })],
      [design(), design({ step: "s1" })],
      [design({ step: "s1" }), design({ step: "s2" })],
      [design(), design({ panel: "tools" })],
      [{ view: "projects", scope: { kind: "all" } }, { view: "projects", scope: { kind: "unfiled" } }],
      [{ view: "settings", page: "tools", tool: null }, { view: "settings", page: "tools", tool: "t1" }],
      [{ view: "settings", page: "tools", tool: null }, { view: "settings", page: "machine", tool: null }],
      // From a kept project to a new one.
      [design(), design({ project: null })],
    ];
    for (const [a, b] of pairs) expect(sameEntry(a, b), `${formatRoute(a)} → ${formatRoute(b)}`).toBe(false);
  });

  it("keeps one entry through the looks at a step and the points of the stock's list, and for a new project that gets kept", () => {
    const pairs: [Route, Route][] = [
      [design(), design()],
      [design({ step: "s1" }), design({ step: "s1", stage: "pocket" })],
      [design({ step: "s1", stage: "pocket" }), design({ step: "s1", stage: "fit" })],
      [design({ stage: "timeline", at: 1 }), design({ stage: "timeline", at: 2 })],
      [design({ step: "s1", stage: "timeline", at: 1 }), design({ step: "s1" })],
      [design({ project: null }), design({ project: "p1" })],
    ];
    for (const [a, b] of pairs) expect(sameEntry(a, b), `${formatRoute(a)} → ${formatRoute(b)}`).toBe(true);
  });
});

describe("the address written as the page turns", () => {
  it("is over the one shown at first and within an entry, and a new entry otherwise", () => {
    expect(writeFor(null, design())).toBe("replace");
    expect(writeFor(design({ step: "s1" }), design({ step: "s1", stage: "pocket" }))).toBe("replace");
    expect(writeFor(design(), design({ step: "s1" }))).toBe("push");
  });
});

describe("the browser moved to another address", () => {
  const yes = () => true;
  const never = () => {
    throw new Error("not to be asked");
  };

  it("goes to a place of the open project without opening anything", () => {
    expect(moveFor(place(), "#/p/p1/step/s2", yes)).toEqual({ kind: "go", route: design({ step: "s2" }) });
    expect(moveFor(place(), "#/tools/t1", yes)).toEqual({ kind: "go", route: { view: "settings", page: "tools", tool: "t1" } });
    expect(moveFor(place({ view: "projects" }), "#/p/p1", yes)).toEqual({ kind: "go", route: design() });
  });

  it("opens the project an address names when it is another, and a new one for #/new", () => {
    expect(moveFor(place(), "#/p/p2/step/x", yes)).toEqual({ kind: "go", route: design({ project: "p2", step: "x" }), open: "p2" });
    expect(moveFor(place({ view: "settings" }), "#/new", yes)).toEqual({ kind: "go", route: design({ project: null }), open: null });
    // A blank one is open already: it is the new one.
    const blank = place({ view: "settings", project: { id: "p9", design: null, steps: [] } });
    expect(moveFor(blank, "#/new", yes)).toEqual({ kind: "go", route: design({ project: null }) });
  });

  it("stays, and writes its own address over, for one that names no place or the place it is at", () => {
    for (const hash of ["", "#agent=4000:abcdefgh1234", "#/nowhere", "#/p/p1", "#/p/p1/", "#/p/p1/nonsense"]) {
      expect(moveFor(place(), hash, never), hash).toEqual({ kind: "stay", how: "replace" });
    }
  });

  it("stays, with its address as a new entry, when the user will not leave changes that are not saved", () => {
    expect(moveFor(place({ view: "settings", toolId: "t1" }), "#/p/p1", () => false)).toEqual({ kind: "stay", how: "push" });
  });
});

describe("the stage shown when a step's output is made", () => {
  const all = { stepId: "s1", parts: { pocket: {}, plug: {} }, fit: {} };

  it("is the one asked for when it was made", () => {
    expect(stageMade(all, "pocket")).toBe("pocket");
    expect(stageMade(all, "plug")).toBe("plug");
    expect(stageMade(all, "fit")).toBe("fit");
  });

  it("is the one that says most otherwise", () => {
    expect(stageMade(all)).toBe("fit");
    expect(stageMade({ ...all, fit: null })).toBe("pocket");
    expect(stageMade({ stepId: "s1", parts: { plug: {} }, fit: null })).toBe("plug");
    expect(stageMade({ stepId: "s1", parts: { plug: {} }, fit: null }, "pocket")).toBe("plug");
    expect(stageMade({ stepId: "s1", parts: {}, fit: null }, "fit")).toBe("drawing");
    expect(stageMade(all, "timeline")).toBe("fit");
  });
});

describe("opening a project as the page starts", () => {
  const kept = (...ids: string[]) => async (id: string) => {
    if (!ids.includes(id)) throw new Error("That project is no longer kept.");
    return `project ${id}`;
  };
  const last = (id: string | null) => async () => id;
  const tools: Route = { view: "settings", page: "tools", tool: null };
  const projects: Route = { view: "projects", scope: { kind: "all" } };

  it("opens the one the address names, where the address says", async () => {
    const route = design({ project: "a", step: "s1" });
    expect(await projectAtStart(route, "b", last("c"), kept("a", "b", "c"))).toEqual({ project: "project a", route, problem: null });
  });

  it("shows the Projects tab, with the tab's or the last project open, when the one named is gone, and says so", async () => {
    const problem = "The project this address leads to could not be opened: That project is no longer kept.";
    expect(await projectAtStart(design({ project: "a" }), "b", last("c"), kept("b", "c"))).toEqual({ project: "project b", route: projects, problem });
    expect(await projectAtStart(design({ project: "a" }), null, last("c"), kept("c"))).toEqual({ project: "project c", route: projects, problem });
    // Nothing else to open: a blank one, and one thing said.
    expect(await projectAtStart(design({ project: "a" }), "b", last("c"), kept())).toEqual({ project: null, route: projects, problem });
  });

  it("opens the tab's own project in a view that names none, before the one last saved", async () => {
    expect(await projectAtStart(tools, "b", last("c"), kept("b", "c"))).toEqual({ project: "project b", route: tools, problem: null });
  });

  it("opens the last one without a word when the tab's is gone", async () => {
    expect(await projectAtStart(tools, "b", last("c"), kept("c"))).toEqual({ project: "project c", route: tools, problem: null });
  });

  it("says that the last one could not be reopened when it is gone, and starts blank", async () => {
    const problem = "The last project could not be reopened: That project is no longer kept.";
    expect(await projectAtStart(null, null, last("c"), kept())).toEqual({ project: null, route: null, problem });
    expect(await projectAtStart(tools, "b", last("c"), kept())).toEqual({ project: null, route: tools, problem });
  });

  it("starts blank and says nothing when there is nothing to reopen", async () => {
    expect(await projectAtStart(null, null, last(null), kept())).toEqual({ project: null, route: null, problem: null });
    expect(await projectAtStart(null, null, async () => undefined, kept())).toEqual({ project: null, route: null, problem: null });
  });

  it("starts a new one when the address asks for it, without opening any", async () => {
    const never = async () => {
      throw new Error("not to be opened");
    };
    expect(await projectAtStart(design({ project: null }), "b", last("c"), never)).toEqual({ project: null, route: design({ project: null }), problem: null });
  });

  it("says so when what was last open cannot be read and nothing else opens, and not when something does", async () => {
    const unread = async () => {
      throw new Error("storage is out of reach");
    };
    expect(await projectAtStart(null, null, unread, kept("a"))).toEqual({ project: null, route: null, problem: "The last project could not be reopened: storage is out of reach" });
    expect(await projectAtStart(design({ project: "a" }), null, unread, kept("a"))).toEqual({ project: "project a", route: design({ project: "a" }), problem: null });
    expect(await projectAtStart(tools, "b", unread, kept("b"))).toEqual({ project: "project b", route: tools, problem: null });
  });
});

describe("the project to open when the page starts", () => {
  const tools: Route = { view: "settings", page: "tools", tool: null };

  it("is the one the address names, then the tab's, then the last one saved", () => {
    expect(projectsToTry(design({ project: "a" }), "b", "c")).toEqual({ blank: false, named: "a", others: ["b", "c"] });
    expect(projectsToTry(tools, "b", "c")).toEqual({ blank: false, named: null, others: ["b", "c"] });
    expect(projectsToTry(null, null, "c")).toEqual({ blank: false, named: null, others: ["c"] });
    expect(projectsToTry(null, null, null)).toEqual({ blank: false, named: null, others: [] });
  });

  it("tries each one once", () => {
    expect(projectsToTry(design({ project: "a" }), "a", "a")).toEqual({ blank: false, named: "a", others: [] });
    expect(projectsToTry(tools, "b", "b")).toEqual({ blank: false, named: null, others: ["b"] });
  });

  it("is a new one when the address asks for that, whatever was open before", () => {
    expect(projectsToTry(design({ project: null }), "b", "c")).toEqual({ blank: true, named: null, others: [] });
  });
});
