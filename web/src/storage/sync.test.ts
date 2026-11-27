// Syncing two places: what is told apart, what is done by default, and what
// copying, deleting and keeping both leave in a browser's storage (an
// IndexedDB in memory) and in a folder (one in memory).

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openFolder } from "./fs";
import { MemDir } from "./memdir";
import { aim, apply, choices, chosen, clear, compare, effect, losses, mark, otherFolder, parts, snapshot, standing, tickedOf, tone, tree, turn, turned, turns, type Action, type Base, type Duplicate, type Row, type Side, type Snapshot, type Store } from "./sync";

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
    expect(JSON.parse(root.read("settings.json")!)).toEqual({ inlayDefaults: "{defaults}", lastProjectId: "b", machine: "{machine}", saved: { machine: expect.any(Number) } });
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

describe("what is ticked from the start, and which way it goes", () => {
  const both = (a: number | undefined, b: number | undefined) => {
    const base = settled(snap({ "project:a": side("1") }), snap({ "project:a": side("1") }));
    return compare(snap({ "project:a": { ...side("2"), modified: a } }), snap({ "project:a": { ...side("3"), modified: b } }), base).rows[0];
  };
  const gone = (text: string) => {
    const base = settled(snap({ "project:d": side("1") }), snap({ "project:d": side("1") }));
    return compare(snap({ "project:d": side(text) }), snap({}), base).rows[0];
  };

  it("ticks only what one side clearly has the newer version of", () => {
    const base = settled(snap({ "project:n": side("1") }), snap({ "project:n": side("1") }));
    const newer = compare(snap({ "project:n": side("2"), "project:o": side("1") }), snap({ "project:n": side("1") }), base).rows;
    expect(newer.map(clear)).toEqual([true, true]);
    expect(clear(both(1, 2))).toBe(false);
    expect(clear(gone("1"))).toBe(false);
  });

  it("sends one changed in both from the side changed last, and to B when that is not known", () => {
    expect(aim(both(5, 9))).toBe("toA");
    expect(aim(both(9, 5))).toBe("toB");
    expect(aim(both(undefined, undefined))).toBe("toB");
  });

  it("deletes a deleted one from the other side too, and puts it back when that side changed it since", () => {
    const plain = gone("1");
    expect(plain.state).toBe("deletedB");
    expect(effect(plain, aim(plain))).toBe("delete");
    const changed = gone("2");
    expect(changed.changed).toBe(true);
    expect(effect(changed, aim(changed))).toBe("copy");
  });

  it("turns a row through the ways it can go, and leaves one with a single way as it is", () => {
    const row = both(1, 2);
    expect(turns(row)).toEqual(["toB", "toA", "keepBoth"]);
    expect(turn(row, "toA")).toBe("keepBoth");
    expect(turn(row, "keepBoth")).toBe("toB");
    const setting = compare(snap({ machine: side("m") }), snap({}), {}).rows[0];
    expect(turns(setting)).toEqual(["toB"]);
    expect(turn(setting, "toB")).toBe("toB");
    // The one copy there is cannot be turned to a deletion.
    const only = compare(snap({}), snap({ "project:n": side("1") }), {}).rows[0];
    expect(turns(only).map((action) => effect(only, action))).toEqual(["copy"]);
    // Copying comes before deleting.
    const was = settled(snap({ "project:d": side("1") }), snap({ "project:d": side("1") }));
    const deleted = compare(snap({ "project:d": side("1") }), snap({}), was).rows[0];
    expect(turns(deleted).map((action) => effect(deleted, action))).toEqual(["copy", "delete"]);
  });

  it("does nothing to a row that is not ticked, whichever way it was turned", () => {
    const rows = [both(1, 2), compare(snap({ "project:n": side("1") }), snap({}), {}).rows[0]];
    expect(chosen(rows, {}, {}).map((c) => c.action)).toEqual(["skip", "toB"]);
    expect(chosen(rows, { "project:a": true, "project:n": false }, { "project:n": "toA" }).map((c) => c.action)).toEqual(["toA", "skip"]);
    expect(chosen(rows, { "project:a": true }, { "project:a": "keepBoth" }).map((c) => c.action)).toEqual(["keepBoth", "toB"]);
    expect(parts(chosen(rows, {}, {}))).toBe(1);
    expect(tickedOf(rows, {})).toBe("some");
    expect(tickedOf(rows, { "project:a": true })).toBe("all");
    expect(tickedOf(rows, { "project:n": false })).toBe("none");
    expect(tickedOf([], {})).toBe("none");
  });

  it("colours each side by how it stands", () => {
    const base = settled(snap({ "project:n": side("1") }), snap({ "project:n": side("1") }));
    const [newer, only] = compare(snap({ "project:n": side("2"), "project:o": side("1") }), snap({ "project:n": side("1") }), base).rows;
    expect([tone(newer, "a"), tone(newer, "b")]).toEqual(["new", "old"]);
    expect([tone(only, "a"), tone(only, "b")]).toEqual(["new", "none"]);
    expect([tone(both(1, 2), "a"), tone(both(1, 2), "b")]).toEqual(["clash", "clash"]);
    expect([tone(gone("1"), "a"), tone(gone("1"), "b")]).toEqual(["old", "gone"]);
    expect([tone(gone("2"), "a"), tone(gone("2"), "b")]).toEqual(["clash", "gone"]);
  });
});

describe("what differs, as it is filed", () => {
  it("puts projects under their folders, unfiled first, by name, and the settings apart in their own order", () => {
    const a = snap({
      "project:z": side("1", "Gifts", "Zebra"),
      "project:y": side("1", "", "Yak"),
      "project:x": side("1", "Gifts", "Ant"),
      "project:w": side("1", "Coasters/Round", "Wren"),
      machine: side("m", "", "Machine"),
      tools: side("t", "", "Tool list"),
    });
    const made = tree(compare(a, snap({}), {}).rows);
    expect(made.folders.map((f) => [f.folder, f.rows.map((r) => r.name)])).toEqual([
      ["", ["Yak"]],
      ["Coasters/Round", ["Wren"]],
      ["Gifts", ["Ant", "Zebra"]],
    ]);
    expect(made.settings.map((r) => r.key)).toEqual(["tools", "machine"]);
  });

  it("lists projects of one name in one folder in the same order however they were found", () => {
    const keys = (a: Snapshot) => tree(compare(a, snap({}), {}).rows).folders[0].rows.map((r) => r.key);
    expect(keys(snap({ "project:e": side("1", "", "Twin"), "project:f": side("1", "", "Twin") }))).toEqual(["project:e", "project:f"]);
    expect(keys(snap({ "project:f": side("1", "", "Twin"), "project:e": side("1", "", "Twin") }))).toEqual(["project:e", "project:f"]);
  });

  it("shows one that was moved under the folder of the side it comes from", () => {
    const base = settled(snap({ "project:m": side("1", "Old") }), snap({ "project:m": side("1", "Old") }));
    const moved = compare(snap({ "project:m": side("1", "Old") }), snap({ "project:m": side("1", "New") }), base).rows;
    expect(moved[0].state).toBe("newerB");
    expect(tree(moved).folders.map((f) => f.folder)).toEqual(["New"]);
  });
});

describe("how far a sync is", () => {
  it("is told before each thing it does and when all are done, and of nothing for what is left alone", async () => {
    const a = openFolder(new MemDir());
    const b = openFolder(new MemDir());
    await a.putProject({ id: "p1", name: "One", modified: 1, text: file("One"), folder: "" });
    await a.putProject({ id: "p2", name: "Two", modified: 1, text: file("Two"), folder: "" });
    await a.putProject({ id: "p3", name: "Three", modified: 1, text: file("Three"), folder: "" });
    const found = compare(await snapshot(a), await snapshot(b), {});
    const said: [number, string | null][] = [];
    const what = chosen(found.rows, { "project:p2": false }, {});
    expect(parts(what)).toBe(2);
    await apply(what, a, b, found.base, duplicate, (done, name) => said.push([done, name]));
    expect(said).toEqual([
      [0, "One"],
      [1, "Three"],
      [2, null],
    ]);
  });
});

describe("what a sync would lose", () => {
  const base = settled(snap({ "project:c": side("1", "", "Clash"), "project:n": side("1", "", "Newer"), "project:d": side("1", "", "Gone") }), snap({ "project:c": side("1", "", "Clash"), "project:n": side("1", "", "Newer"), "project:d": side("1", "", "Gone") }));
  const { rows } = compare(snap({ "project:c": side("2", "", "Clash"), "project:n": side("2", "", "Newer"), "project:d": side("1", "", "Gone"), "project:o": side("1", "", "Only") }), snap({ "project:c": side("3", "", "Clash"), "project:n": side("1", "", "Newer") }), base);
  const all = Object.fromEntries(rows.map((row) => [row.key, true]));

  it("is nothing for what is ticked from the start", () => {
    expect(losses(chosen(rows, {}, {}))).toEqual({ deleted: [], overwritten: [] });
  });

  it("names what is deleted, and what is copied over a side that was changed", () => {
    expect(losses(chosen(rows, all, {}))).toEqual({ deleted: ["Gone"], overwritten: ["Clash"] });
    // The newer one turned back: the older copied over it.
    expect(losses(chosen(rows, {}, { "project:n": "toA" })).overwritten).toEqual(["Newer"]);
    // Kept twice: nothing of either is lost.
    expect(losses(chosen(rows, all, { "project:c": "keepBoth" })).overwritten).toEqual([]);
  });
});

describe("a side with no date to show", () => {
  it("says how it stands", () => {
    const only = compare(snap({ machine: side("m") }), snap({}), {}).rows[0];
    expect([standing(only, "a"), standing(only, "b")]).toEqual(["Only here", "Not there"]);
    const base = settled(snap({ tools: side("t"), "project:d": side("1") }), snap({ tools: side("t"), "project:d": side("1") }));
    const [newer, gone] = compare(snap({ tools: side("t"), "project:d": side("1") }), snap({ tools: side("u") }), base).rows;
    expect([standing(newer, "a"), standing(newer, "b")]).toEqual(["As it was", "Changed"]);
    expect([standing(gone, "a"), standing(gone, "b")]).toEqual(["As it was", "Deleted"]);
  });
});

describe("folders that differ", () => {
  it("are one in the list whatever the case of their names", () => {
    const made = tree(compare(snap({ "project:a": side("1", "Gifts", "A"), "project:b": side("1", "gifts", "B") }), snap({}), {}).rows);
    expect(made.folders.map((f) => [f.folder, f.rows.length])).toEqual([["Gifts", 2]]);
  });

  it("are both said of a project that was moved, whichever way it goes", () => {
    const base = settled(snap({ "project:m": side("1", "Old") }), snap({ "project:m": side("1", "Old") }));
    const moved = compare(snap({ "project:m": side("1", "New") }), snap({ "project:m": side("1", "Old") }), base).rows[0];
    expect(otherFolder(moved, "toB")).toBe("Old");
    expect(otherFolder(moved, "toA")).toBe("New");
    const same = compare(snap({ "project:m": side("2", "Old") }), snap({ "project:m": side("1", "old") }), base).rows[0];
    expect(otherFolder(same, "toB")).toBeNull();
  });
});

describe("when a setting was last changed", () => {
  it("is read from each place that says, and the later of two that both changed goes over", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const browser = (await import("./db")) as unknown as Store;
      const folder = openFolder(new MemDir()) as unknown as Store;
      vi.setSystemTime(5000);
      await browser.putSetting("machine", "{mine}");
      vi.setSystemTime(9000);
      await folder.putSetting("machine", "{theirs}");
      const [a, b] = [await snapshot(browser), await snapshot(folder)];
      expect([a.get("machine")!.modified, b.get("machine")!.modified]).toEqual([5000, 9000]);
      const row = compare(a, b, {}).rows[0];
      // Still not ticked from the start: both changed.
      expect([row.state, clear(row), aim(row)]).toEqual(["both", false, "toA"]);
      expect(aim(compare(b, a, {}).rows[0])).toBe("toB");
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes with what is copied, so that the copy is not the later one of the two", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const browser = (await import("./db")) as unknown as Store;
      const root = new MemDir();
      const folder = openFolder(root) as unknown as Store;
      vi.setSystemTime(5000);
      await browser.putSetting("machine", "{m}");
      await browser.putSetting("inlayDefaults", "{d}");
      vi.setSystemTime(9000);
      const first = compare(await snapshot(browser), await snapshot(folder), {});
      const done = await apply(all(first.rows), browser, folder, first.base, duplicate);
      expect(JSON.parse(root.read("settings.json")!).saved).toEqual({ machine: 5000, inlayDefaults: 5000 });
      // And back the other way, into a browser.
      await folder.putSetting("machine", "{m2}");
      vi.setSystemTime(20000);
      const second = compare(await snapshot(browser), await snapshot(folder), done.base);
      await apply(all(second.rows), browser, folder, second.base, duplicate);
      expect(await browser.settingSaved!("machine")).toBe(9000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not make a side the older one for having no date", () => {
    const row = (a: number | undefined, b: number | undefined) => compare(snap({ machine: { ...side("1"), modified: a } }), snap({ machine: { ...side("2"), modified: b } }), {}).rows[0];
    expect([aim(row(undefined, 9000)), aim(row(9000, undefined)), aim(row(undefined, undefined))]).toEqual(["toB", "toB", "toB"]);
    expect([aim(row(5000, 9000)), aim(row(9000, 5000)), aim(row(5000, 5000))]).toEqual(["toA", "toB", "toB"]);
  });

  it("is not known where a place does not say", async () => {
    const kept = new Map<string, string>([["machine", "{m}"]]);
    const plain = { readShelf: async () => ({ projects: [], folders: [] }), getSetting: async (key: string) => kept.get(key) } as unknown as Store;
    expect((await snapshot(plain)).get("machine")!.modified).toBeUndefined();
  });
});
