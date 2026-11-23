// Browser storage, against an IndexedDB in memory: what is kept of a
// project's folder, and what filing, renaming and deleting do to it.

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A storage of its own for every test: the module holds its connection.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
});
const load = () => import("./db");

const stored = (id: string, folder?: string, modified = 100) => ({ id, name: `Project ${id}`, modified, text: `text of ${id}`, steps: 2, folder });

describe("a project kept in a browser", () => {
  it("goes to the folder named when it is new, and the folder is listed with the ones it is in", async () => {
    const db = await load();
    await db.putProject(stored("a", "Gifts/Christmas"));
    await db.putProject(stored("b"));
    const shelf = await db.readShelf();
    expect(shelf.folders).toEqual(["Gifts", "Gifts/Christmas"]);
    expect(shelf.projects.map((p) => [p.id, p.folder, p.steps])).toEqual([
      ["a", "Gifts/Christmas", 2],
      ["b", "", 2],
    ]);
  });

  it("stays in its folder when it is saved again, whatever folder the save names", async () => {
    const db = await load();
    await db.putProject(stored("a", "Gifts"));
    await db.putProject({ ...stored("a", "Orders", 200), text: "changed" });
    await db.putProject({ id: "a", name: "Renamed", modified: 300, text: "again" });
    const shelf = await db.readShelf();
    expect(shelf.folders).toEqual(["Gifts"]);
    expect(shelf.projects).toEqual([{ id: "a", name: "Renamed", modified: 300, folder: "Gifts", steps: 2 }]);
    expect((await db.getProject("a"))?.text).toBe("again");
  });

  it("is in no folder when the folder named could not be one, or was kept before folders were", async () => {
    const db = await load();
    await db.putProject(stored("a", "../x"));
    // As a version of the app from before folders wrote it: no folder, no steps.
    await db.putProject({ id: "old", name: "Old", modified: 50, text: "old" });
    const shelf = await db.readShelf();
    expect(shelf.folders).toEqual([]);
    expect(shelf.projects.map((p) => [p.id, p.folder, p.steps])).toEqual([
      ["a", "", 2],
      ["old", "", undefined],
    ]);
  });

  it("goes to a folder as that one is spelt already", async () => {
    const db = await load();
    await db.createFolder("Gifts");
    await db.putProject(stored("a", "gifts/Christmas"));
    expect((await db.readShelf()).projects[0].folder).toBe("Gifts/Christmas");
  });
});

describe("filing a project in a browser", () => {
  it("changes its folder and nothing else", async () => {
    const db = await load();
    await db.putProject(stored("a", "Gifts", 123));
    expect(await db.moveProject("a", "Orders/2026")).toBe("Orders/2026");
    expect(await db.getProject("a")).toEqual({ ...stored("a", "Orders/2026", 123) });
    // The folder it left stays, empty.
    expect((await db.readShelf()).folders).toEqual(["Gifts", "Orders", "Orders/2026"]);
    expect(await db.moveProject("a", "")).toBe("");
    expect((await db.readShelf()).projects[0].folder).toBe("");
    expect(await db.moveProject("a", "gifts")).toBe("Gifts");
  });

  it("refuses a project that is not kept and a folder that cannot be one", async () => {
    const db = await load();
    await db.putProject(stored("a"));
    await expect(db.moveProject("zz", "Gifts")).rejects.toThrow(/no longer kept/);
    await expect(db.moveProject("a", "a/../b")).rejects.toThrow(/cannot be a folder/);
    // Neither made a folder.
    expect((await db.readShelf()).folders).toEqual([]);
  });
});

describe("folders in a browser", () => {
  it("are kept when they are empty, and not made twice", async () => {
    const db = await load();
    expect(await db.createFolder("Gifts/Christmas")).toBe("Gifts/Christmas");
    await expect(db.createFolder("gifts")).rejects.toThrow(/already/);
    await expect(db.createFolder("a:b")).rejects.toThrow(/cannot be a folder/);
    expect((await db.readShelf()).folders).toEqual(["Gifts", "Gifts/Christmas"]);
    // Read again as by another visit to the page.
    vi.resetModules();
    expect((await (await load()).readShelf()).folders).toEqual(["Gifts", "Gifts/Christmas"]);
  });

  it("take their projects along when they are renamed or moved", async () => {
    const db = await load();
    await db.putProject(stored("a", "Gifts", 1));
    await db.putProject(stored("b", "Gifts/Christmas", 2));
    await db.putProject(stored("c", "Gifts 2", 3));
    await db.createFolder("Orders");
    expect(await db.renameFolder("Gifts", "orders/Presents")).toBe("Orders/Presents");
    const shelf = await db.readShelf();
    expect(shelf.folders).toEqual(["Gifts 2", "Orders", "Orders/Presents", "Orders/Presents/Christmas"]);
    expect(Object.fromEntries(shelf.projects.map((p) => [p.id, p.folder]))).toEqual({ a: "Orders/Presents", b: "Orders/Presents/Christmas", c: "Gifts 2" });
    // Their text and the time they were changed are as they were.
    expect(await db.getProject("b")).toEqual(stored("b", "Orders/Presents/Christmas", 2));
    await expect(db.renameFolder("Orders", "Orders/Presents/Orders")).rejects.toThrow(/into itself/);
    await expect(db.renameFolder("Nothing", "X")).rejects.toThrow(/no folder/);
  });

  it("leave their projects in no folder when they are taken away", async () => {
    const db = await load();
    await db.putProject(stored("a", "Gifts", 1));
    await db.putProject(stored("b", "Gifts/Christmas", 2));
    await db.putProject(stored("c", "Orders", 3));
    expect(await db.deleteFolder("gifts")).toBe(2);
    const shelf = await db.readShelf();
    expect(shelf.folders).toEqual(["Orders"]);
    expect(Object.fromEntries(shelf.projects.map((p) => [p.id, p.folder]))).toEqual({ a: "", b: "", c: "Orders" });
    expect((await db.getProject("b"))?.text).toBe("text of b");
    await expect(db.deleteFolder("Gifts")).rejects.toThrow(/no folder/);
  });

  it("are not brought back by a list that is not one", async () => {
    const db = await load();
    await db.putSetting("projectFolders", "{not json");
    await db.putProject(stored("a", "Gifts"));
    expect((await db.readShelf()).folders).toEqual(["Gifts"]);
    await db.putSetting("projectFolders", JSON.stringify(["Orders", 7, "../x"]));
    expect((await db.readShelf()).folders).toEqual(["Gifts", "Orders"]);
  });
});

describe("the picture of a project kept in a browser", () => {
  const thumb = { w: 100, h: 50, d: "M0 0L10 0L10 10Z" };

  it("is listed, and kept by a save that brings none, as a rename", async () => {
    const db = await load();
    await db.putProject({ ...stored("a"), thumb });
    await db.putProject({ id: "a", name: "Renamed", modified: 300, text: "again" });
    expect((await db.listProjects())[0].thumb).toEqual(thumb);
    // A drawing taken away takes it away.
    await db.putProject({ id: "a", name: "Renamed", modified: 400, text: "blank", thumb: null });
    expect((await db.listProjects())[0].thumb).toBeNull();
  });

  it("is given to one kept without, unless it was changed since it was read", async () => {
    const db = await load();
    await db.putProject(stored("a", "", 100));
    expect((await db.listProjects())[0].thumb).toBeUndefined();
    await db.setThumb("a", thumb, 99);
    expect((await db.listProjects())[0].thumb).toBeUndefined();
    await db.setThumb("a", thumb, 100);
    expect((await db.listProjects())[0].thumb).toEqual(thumb);
    // Its folder and the rest stay as they were; a project that is gone is not made again.
    expect((await db.getProject("a"))?.text).toBe("text of a");
    await db.setThumb("gone", thumb, 100);
    expect(await db.getProject("gone")).toBeUndefined();
  });
});
