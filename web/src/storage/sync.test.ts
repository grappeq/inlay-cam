// Syncing two places: what is told apart, what is done by default, and what
// copying, deleting and keeping both leave in a browser's storage (an
// IndexedDB in memory) and in a folder (one in memory).

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openFolder } from "./fs";
import { MemDir } from "./memdir";
import { apply, choices, compare, effect, mark, snapshot, turned, type Action, type Base, type Duplicate, type Row, type Side, type Snapshot, type Store } from "./sync";

const side = (text: string, folder = "", name = "P"): Side => ({ text, folder, name });
const snap = (items: Record<string, Side>): Snapshot => new Map(Object.entries(items));
const states = (rows: Row[]) => rows.map((r) => [r.key, r.state, r.action]);
/** The marks after `a` and `b` were found the same. */
const settled = (a: Snapshot, b: Snapshot): Base => compare(a, b, {}).base;

describe("what differs between two places", () => {
  it("is nothing where both have the same, and that is remembered", () => {
    const a = snap({ "project:1": side("x", "Gifts"), tools: side("t") });
    const b = snap({ "project:1": side("x", "gifts"), tools: side("t") });
    const { rows, base } = compare(a, b, {});
    expect(rows).toEqual([]);
    expect(Object.keys(base).sort()).toEqual(["project:1", "tools"]);
  });

  it("is copied over by default where one side has what the other never had", () => {
    const { rows } = compare(snap({ "project:1": side("x"), machine: side("m") }), snap({ "project:2": side("y") }), {});
    expect(states(rows)).toEqual([
      ["machine", "onlyA", "toB"],
      ["project:1", "onlyA", "toB"],
      ["project:2", "onlyB", "toA"],
    ]);
  });

  it("is left alone by default where the two differ and were never synced: which is newer is not known", () => {
    const { rows, base } = compare(snap({ "project:1": side("x") }), snap({ "project:1": side("y") }), {});
    expect(states(rows)).toEqual([["project:1", "both", "skip"]]);
    expect(base).toEqual({});
  });

  it("goes the way of the side that changed since the last sync", () => {
    const was = settled(snap({ "project:1": side("x"), "project:2": side("x") }), snap({ "project:1": side("x"), "project:2": side("x") }));
    const { rows, base } = compare(snap({ "project:1": side("x2"), "project:2": side("x") }), snap({ "project:1": side("x"), "project:2": side("x", "Gifts") }), was);
    expect(states(rows)).toEqual([
      ["project:1", "newerA", "toB"],
      ["project:2", "newerB", "toA"],
    ]);
    // Still marked as they were when last the same.
    expect(base).toEqual(was);
  });

  it("is left alone by default where both changed, and where one side deleted", () => {
    const one = snap({ "project:1": side("x"), "project:2": side("x"), "project:3": side("x") });
    const was = settled(one, one);
    const { rows } = compare(snap({ "project:1": side("mine"), "project:2": side("x") }), snap({ "project:1": side("theirs"), "project:3": side("changed") }), was);
    expect(states(rows)).toEqual([
      ["project:1", "both", "skip"],
      ["project:2", "deletedB", "skip"],
      ["project:3", "deletedA", "skip"],
    ]);
    expect(effect(rows[1], "toA")).toBe("delete");
    expect(effect(rows[1], "toB")).toBe("copy");
    expect(effect(rows[2], "toB")).toBe("delete");
  });

  it("forgets what is gone from both, and takes two changes that came to the same for no change", () => {
    const one = snap({ "project:1": side("x"), "project:2": side("x") });
    const { rows, base } = compare(snap({ "project:2": side("y") }), snap({ "project:2": side("y") }), settled(one, one));
    expect(rows).toEqual([]);
    expect(Object.keys(base)).toEqual(["project:2"]);
  });

  it("takes a setting that is on one side only for new, never for deleted", () => {
    const one = snap({ machine: side("m") });
    expect(states(compare(one, snap({}), settled(one, one)).rows)).toEqual([["machine", "onlyA", "toB"]]);
  });

  it("offers to keep both for a project changed in both, and not for a setting", () => {
    const [p, t] = compare(snap({ "project:1": side("x"), tools: side("t") }), snap({ "project:1": side("y"), tools: side("u") }), {}).rows.sort((x, y) => x.key.localeCompare(y.key));
    expect(choices(p)).toContain("keepBoth");
    expect(choices(t)).not.toContain("keepBoth");
    expect(effect(t, "keepBoth")).toBe("none");
    expect(effect(p, "skip")).toBe("none");
  });

  it("is the same seen from the other side", () => {
    const [a, b] = [snap({ "project:1": side("x") }), snap({ "project:1": side("x") })];
    const was = settled(a, b);
    const changed = snap({ "project:1": side("x2") });
    expect(states(compare(b, changed, turned(was)).rows)).toEqual([["project:1", "newerB", "toA"]]);
    expect(turned(turned(was))).toEqual(was);
  });
});

describe("a text's mark", () => {
  it("is the same for the same text, and another for another", () => {
    expect(mark("abc")).toBe(mark("abc"));
    expect(new Set([mark(""), mark("a"), mark("b"), mark("ab"), mark("ba")]).size).toBe(5);
  });
});

const file = (name: string, steps = 1) => JSON.stringify({ project: { name, steps: Array(steps).fill({}), design: {} } });
const duplicate: Duplicate = async (text, taken) => {
  const name = `${JSON.parse(text).project.name} copy`;
  if (taken.includes(name)) throw new Error("that name is taken");
  return { id: "copy-1", name, text: file(name) };
};
const all = (rows: Row[], to?: Record<string, Action>) => rows.map((row) => ({ row, action: to?.[row.key] ?? row.action }));

describe("syncing a browser's storage with a folder", () => {
  let browser: Store;
  let root: MemDir;
  let folder: Store;
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    browser = await import("./db");
    root = new MemDir();
    folder = openFolder(root);
  });
  const look = async (base: Base) => compare(await snapshot(browser), await snapshot(folder), base);

  it("copies each side's own to the other, folders and all, and finds nothing to do after", async () => {
    await browser.putProject({ id: "a", name: "A", modified: 5, text: file("A", 3), folder: "Gifts", steps: 3, thumb: { w: 1, h: 1, d: "M0 0" } });
    await browser.putSetting("tools", "{tools}");
    await browser.putSetting("machine", "{machine}");
    root.put("projects/Orders/b.json", file("B"));
    root.put("settings.json", JSON.stringify({ inlayDefaults: "{defaults}", lastProjectId: "b" }));

    const first = await look({});
    const done = await apply(all(first.rows), browser, folder, first.base, duplicate);
    expect(done).toMatchObject({ done: 5, failed: [], wroteA: true, wroteB: true });

    expect(root.read("projects/Gifts/a.json")).toBe(file("A", 3));
    expect(root.read("tools.json")).toBe("{tools}");
    expect(JSON.parse(root.read("settings.json")!)).toEqual({ inlayDefaults: "{defaults}", lastProjectId: "b", machine: "{machine}" });
    const shelf = await browser.readShelf();
    expect(shelf.projects.find((p) => p.id === "b")).toMatchObject({ name: "B", folder: "Orders", steps: 1 });
    expect(await browser.getSetting("inlayDefaults")).toBe("{defaults}");
    // The last project is each place's own.
    expect(await (browser as typeof import("./db")).getSetting("lastProjectId")).toBeUndefined();
    // The picture went along.
    expect((await folder.readShelf()).projects.find((p) => p.id === "a")?.thumb).toEqual({ w: 1, h: 1, d: "M0 0" });

    expect((await look(done.base)).rows).toEqual([]);
  });

  it("then takes a change the way it was made, and a refiling with it", async () => {
    await browser.putProject({ id: "a", name: "A", modified: 5, text: file("A") });
    const first = await look({});
    let base = (await apply(all(first.rows), browser, folder, first.base, duplicate)).base;

    root.put("projects/a.json", file("A edited", 4));
    await folder.moveProject("a", "Gifts");
    const second = await look(base);
    expect(states(second.rows)).toEqual([["project:a", "newerB", "toA"]]);
    const done = await apply(all(second.rows), browser, folder, second.base, duplicate);
    expect(done).toMatchObject({ done: 1, wroteA: true, wroteB: false });
    base = done.base;
    expect((await browser.getProject("a"))?.text).toBe(file("A edited", 4));
    expect((await browser.readShelf()).projects[0]).toMatchObject({ name: "A edited", folder: "Gifts", steps: 4 });
    expect((await look(base)).rows).toEqual([]);
  });

  it("deletes on the other side only when told to, and copies back when told that", async () => {
    await browser.putProject({ id: "a", name: "A", modified: 5, text: file("A") });
    await browser.putProject({ id: "b", name: "B", modified: 6, text: file("B") });
    const first = await look({});
    const base = (await apply(all(first.rows), browser, folder, first.base, duplicate)).base;
    await browser.deleteProject("a");
    await folder.deleteProject("b");

    const second = await look(base);
    expect(states(second.rows)).toEqual([
      ["project:a", "deletedA", "skip"],
      ["project:b", "deletedB", "skip"],
    ]);
    // Left alone, both stay as they are, and are asked about again.
    const left = await apply(all(second.rows), browser, folder, second.base, duplicate);
    expect(left).toMatchObject({ done: 0, wroteA: false, wroteB: false });
    expect(states((await look(left.base)).rows)).toEqual(states(second.rows));

    const done = await apply(all(second.rows, { "project:a": "toB", "project:b": "toB" }), browser, folder, second.base, duplicate);
    expect(done.done).toBe(2);
    expect(await folder.getProject("a")).toBeUndefined();
    expect((await folder.getProject("b"))?.text).toBe(file("B"));
    expect((await look(done.base)).rows).toEqual([]);
    expect(done.base["project:a"]).toBeUndefined();
  });

  it("keeps both versions of a project changed in both: one side's as a copy, in both places", async () => {
    await browser.putProject({ id: "a", name: "A", modified: 5, text: file("Mine"), folder: "Gifts" });
    root.put("projects/a.json", file("Theirs"));
    const first = await look({});
    expect(states(first.rows)).toEqual([["project:a", "both", "skip"]]);
    const done = await apply(all(first.rows, { "project:a": "keepBoth" }), browser, folder, first.base, duplicate);
    expect(done).toMatchObject({ done: 1, failed: [], wroteA: true, wroteB: true });
    expect((await browser.getProject("a"))?.text).toBe(file("Theirs"));
    expect((await browser.getProject("copy-1"))?.text).toBe(file("Mine copy"));
    expect(root.read("projects/a.json")).toBe(file("Theirs"));
    expect(root.read("projects/Gifts/copy-1.json")).toBe(file("Mine copy"));
    expect((await look(done.base)).rows).toEqual([]);
  });

  it("goes on after a line that failed, says which, and asks about it again", async () => {
    await browser.putProject({ id: "a", name: "A", modified: 5, text: file("A") });
    await browser.putProject({ id: "b", name: "B", modified: 6, text: file("B") });
    const first = await look({});
    const real = folder.putProject;
    const failing: Store = { ...folder, putProject: async (p) => (p.id === "a" ? Promise.reject(new Error("the disk is full")) : real(p)) };
    const done = await apply(all(first.rows), browser, failing, first.base, duplicate);
    expect(done).toMatchObject({ done: 1, failed: [{ name: "A", error: "the disk is full" }] });
    expect(states((await look(done.base)).rows)).toEqual([["project:a", "onlyA", "toB"]]);
  });

  it("takes a place that keeps a text in its own way for unchanged", async () => {
    // As a server might: what it gives back is not letter for letter what it was given.
    const kept = new Map<string, string>();
    const server: Store = {
      readShelf: async () => ({ projects: [], folders: [] }),
      getProject: async () => undefined,
      putProject: async () => undefined,
      moveProject: async () => undefined,
      deleteProject: async () => undefined,
      getSetting: async (key) => kept.get(key),
      putSetting: async (key, value) => void kept.set(key, `${value}\n`),
    };
    await browser.putSetting("tools", "{tools}");
    const first = compare(await snapshot(browser), await snapshot(server), {});
    const done = await apply(all(first.rows), browser, server, first.base, duplicate);
    expect(compare(await snapshot(browser), await snapshot(server), done.base).rows).toEqual([]);
    await browser.putSetting("tools", "{tools changed}");
    expect(states(compare(await snapshot(browser), await snapshot(server), done.base).rows)).toEqual([["tools", "newerA", "toB"]]);
  });
});

describe("a setting only one place has", () => {
  it("can be copied or left, and is never taken for something to delete: a project is not deleted in its stead", async () => {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    const browser: Store = await import("./db");
    const root = new MemDir();
    const folder = openFolder(root);
    // The tail of "inlayDefaults" after as many letters as "project:" has.
    await browser.putProject({ id: "aults", name: "U", modified: 1, text: file("U") });
    await folder.putProject({ id: "aults", name: "U", modified: 1, text: file("U") });
    await browser.putSetting("inlayDefaults", "{d}");
    const found = compare(await snapshot(browser), await snapshot(folder), {});
    const row = found.rows.find((r) => r.key === "inlayDefaults")!;
    expect(choices(row)).toEqual(["toB", "skip"]);
    expect(effect(row, "toA")).toBe("none");
    const done = await apply([{ row, action: "toA" }], browser, folder, found.base, duplicate);
    expect(done).toMatchObject({ done: 0, wroteA: false, wroteB: false });
    expect((await browser.getProject("aults"))?.text).toBe(file("U"));
    expect(await browser.getSetting("inlayDefaults")).toBe("{d}");
  });
});

describe("what was compared a while ago", () => {
  let browser: Store;
  let folder: Store;
  let root: MemDir;
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory();
    vi.resetModules();
    browser = await import("./db");
    root = new MemDir();
    folder = openFolder(root);
  });

  it("is not written over a change made since: the line fails, and says to compare again", async () => {
    await browser.putProject({ id: "a", name: "A", modified: 1, text: file("Mine") });
    await browser.putSetting("machine", "{mine}");
    root.put("projects/a.json", file("Theirs"));
    root.put("settings.json", JSON.stringify({ machine: "{theirs}" }));
    const found = compare(await snapshot(browser), await snapshot(folder), {});
    // Saved again in the folder after the two were compared.
    root.put("projects/a.json", file("Theirs, newer"));
    await folder.putSetting("machine", "{theirs, newer}");
    const done = await apply(all(found.rows, { "project:a": "toB", machine: "toB" }), browser, folder, found.base, duplicate);
    expect(done.done).toBe(0);
    expect(done.failed.map((f) => f.error)).toEqual(["changed since the two were compared: compare again", "changed since the two were compared: compare again"]);
    expect(root.read("projects/a.json")).toBe(file("Theirs, newer"));
    expect(await folder.getSetting("machine")).toBe("{theirs, newer}");
  });

  it("is not deleted, or put where it has come to be since", async () => {
    await browser.putProject({ id: "a", name: "A", modified: 1, text: file("A") });
    await browser.putProject({ id: "b", name: "B", modified: 1, text: file("B") });
    const first = compare(await snapshot(browser), await snapshot(folder), {});
    const base = (await apply(all(first.rows), browser, folder, first.base, duplicate)).base;
    await browser.deleteProject("a");
    await folder.deleteProject("b");
    const found = compare(await snapshot(browser), await snapshot(folder), base);
    root.put("projects/a.json", file("A, changed after"));
    root.put("projects/b.json", file("B, back"));
    const done = await apply(all(found.rows, { "project:a": "toB", "project:b": "toB" }), browser, folder, found.base, duplicate);
    expect(done.done).toBe(0);
    expect(done.failed).toHaveLength(2);
    expect(root.read("projects/a.json")).toBe(file("A, changed after"));
    expect(root.read("projects/b.json")).toBe(file("B, back"));
  });
});

describe("a project deleted on one side", () => {
  it("says when the other side changed it since: deleting it there loses that change", () => {
    const one = snap({ "project:1": side("x"), "project:2": side("x") });
    const { rows } = compare(snap({ "project:1": side("changed"), "project:2": side("x") }), snap({}), settled(one, one));
    expect(rows.map((r) => [r.key, r.state, r.changed ?? false, r.action])).toEqual([
      ["project:1", "deletedB", true, "skip"],
      ["project:2", "deletedB", false, "skip"],
    ]);
  });
});

describe("a project that differs only in where it is filed", () => {
  it("is not offered to be kept twice", () => {
    const [row] = compare(snap({ "project:1": side("x", "Gifts") }), snap({ "project:1": side("x", "Orders") }), {}).rows;
    expect(row.state).toBe("both");
    expect(choices(row)).toEqual(["toB", "toA", "skip"]);
  });
});
