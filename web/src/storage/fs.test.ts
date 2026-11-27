// A folder on this computer as the place things are kept in, against a
// folder in memory: where files go, what is listed of a folder a hand has
// been in, and what filing, renaming and deleting do to the files.

import { describe, expect, it, vi } from "vitest";
import { openFolder, summaryOf, type Seen } from "./fs";
import { MemDir } from "./memdir";

const file = (name: string, steps = 2, design: unknown = { shapes: [] }) => JSON.stringify({ version: 3, project: { name, steps: Array(steps).fill({}), design } });
const stored = (id: string, folder?: string) => ({ id, name: `Project ${id}`, modified: 1, text: file(`Project ${id}`), folder });

describe("a project kept in a folder", () => {
  it("is a file named by its id, in the folder it is filed in, listed with what its file says", async () => {
    const root = new MemDir();
    const store = openFolder(root);
    await store.putProject(stored("a", "Gifts/Christmas"));
    await store.putProject(stored("b"));
    expect(root.paths()).toEqual(["projects/Gifts/Christmas/a.json", "projects/b.json"]);
    const shelf = await store.readShelf();
    expect(shelf.folders).toEqual(["Gifts", "Gifts/Christmas"]);
    expect(shelf.projects.map((p) => [p.id, p.name, p.folder, p.steps])).toEqual([
      ["b", "Project b", "", 2],
      ["a", "Project a", "Gifts/Christmas", 2],
    ]);
    expect((await store.getProject("a"))?.text).toBe(file("Project a"));
    expect((await store.getProject("a"))?.folder).toBe("Gifts/Christmas");
    expect(await store.getProject("none")).toBeUndefined();
  });

  it("stays in its folder when it is saved again, whatever folder the save names", async () => {
    const root = new MemDir();
    const store = openFolder(root);
    await store.putProject(stored("a", "Gifts"));
    await store.putProject({ ...stored("a", "Orders"), text: file("Renamed", 5) });
    expect(root.paths()).toEqual(["projects/Gifts/a.json"]);
    expect((await store.readShelf()).projects).toMatchObject([{ id: "a", name: "Renamed", folder: "Gifts", steps: 5 }]);
  });

  it("goes to the folder that is there when the one named differs only in case", async () => {
    const root = new MemDir("root", true);
    const store = openFolder(root);
    await store.createFolder("Gifts");
    await store.putProject(stored("a", "gifts"));
    expect(root.paths()).toEqual(["projects/Gifts/a.json"]);
  });

  it("is refused under an id that differs only in case from one that is kept, or that cannot name a file", async () => {
    const store = openFolder(new MemDir("root", true));
    await store.putProject(stored("a3", "Gifts"));
    await expect(store.putProject(stored("A3"))).rejects.toThrow(/a3\.json already/);
    await expect(store.putProject(stored("../x"))).rejects.toThrow(/cannot name/);
  });

  it("is found again after a hand moved its file", async () => {
    const root = new MemDir();
    const store = openFolder(root);
    await store.putProject(stored("a"));
    root.put("projects/Orders/a.json", root.read("projects/a.json")!);
    await (await root.getDirectoryHandle("projects")).removeEntry("a.json");
    expect((await store.getProject("a"))?.folder).toBe("Orders");
    await store.putProject({ ...stored("a"), text: file("Again") });
    expect(root.paths()).toEqual(["projects/Orders/a.json"]);
  });
});

describe("a folder a hand has been in", () => {
  it("lists what the app could have made, and of two files with one id the first", async () => {
    const root = new MemDir();
    root.put("projects/twin.json", file("Outer"));
    root.put("projects/a/twin.json", file("Inner"));
    root.put("projects/a/not a project.json", "x");
    root.put("projects/a/notes.txt", "x");
    root.put("projects/.hidden/h.json", file("Hidden"));
    root.put("projects/a/b/c/d/e/deep.json", file("Deep"));
    root.put("projects/old.json", JSON.stringify({ project: { name: "Old", jobs: [1, 2, 3] } }));
    root.put("projects/odd.json", "not json");
    root.put("tools.json", "{}");
    const shelf = await openFolder(root).readShelf();
    expect(shelf.projects.map((p) => [p.id, p.name, p.steps]).sort()).toEqual([
      ["odd", "", 0],
      ["old", "Old", 3],
      ["twin", "Outer", 2],
    ]);
    expect(shelf.folders).toEqual(["a", "a/b", "a/b/c", "a/b/c/d"]);
  });

  it("is empty while it holds nothing, and nothing is made in it by looking", async () => {
    const root = new MemDir();
    expect(await openFolder(root).readShelf()).toEqual({ projects: [], folders: [] });
    expect(root.paths()).toEqual([]);
  });

  it("reads a file again only when it has changed, and remembers its picture until then", async () => {
    const root = new MemDir();
    const seen: { kept?: Record<string, Seen> } = {};
    const memo = { read: async () => seen.kept, write: async (all: Record<string, Seen>) => void (seen.kept = structuredClone(all)) };
    const a = root.put("projects/a.json", file("A"));
    const store = openFolder(root, memo);
    const first = (await store.readShelf()).projects[0];
    expect(first.thumb).toBeUndefined();
    await store.setThumb("a", { w: 1, h: 1, d: "M0 0" }, first.modified);
    // Not the picture of a drawing it no longer has.
    await store.setThumb("a", { w: 9, h: 9, d: "" }, first.modified - 1);
    const reads = a.reads;
    // Another visit: what was read is remembered by the browser.
    const again = openFolder(root, memo);
    expect((await again.readShelf()).projects[0].thumb).toEqual({ w: 1, h: 1, d: "M0 0" });
    expect(a.reads).toBe(reads);
    root.put("projects/a.json", file("A changed"));
    expect((await again.readShelf()).projects[0]).toMatchObject({ name: "A changed", thumb: undefined });
  });

  it("gives a project without a drawing no picture, and one that left the folder is forgotten", async () => {
    const root = new MemDir();
    const seen: { kept?: Record<string, Seen> } = {};
    const store = openFolder(root, { read: async () => seen.kept, write: async (all) => void (seen.kept = structuredClone(all)) });
    root.put("projects/blank.json", file("Blank", 0, null));
    root.put("projects/b.json", file("B"));
    expect((await store.readShelf()).projects.find((p) => p.id === "blank")?.thumb).toBeNull();
    await (await root.getDirectoryHandle("projects")).removeEntry("b.json");
    await store.readShelf();
    expect(Object.keys(seen.kept!)).toEqual(["blank"]);
  });
});

describe("filing and deleting in a folder", () => {
  it("moves a project's file, to the folder as it is spelt, and keeps its picture", async () => {
    const root = new MemDir();
    const store = openFolder(root);
    await store.putProject({ ...stored("a"), thumb: { w: 1, h: 1, d: "M0 0" } });
    await store.createFolder("Gifts");
    expect(await store.moveProject("a", "gifts/New")).toBe("Gifts/New");
    expect(root.paths()).toEqual(["projects/Gifts/New/a.json"]);
    expect((await store.readShelf()).projects[0]).toMatchObject({ folder: "Gifts/New", thumb: { w: 1, h: 1, d: "M0 0" } });
    expect(await store.moveProject("a", "")).toBe("");
    expect(root.paths()).toEqual(["projects/a.json"]);
    await expect(store.moveProject("gone", "Gifts")).rejects.toThrow(/no longer kept/);
    await expect(store.moveProject("a", "../x")).rejects.toThrow(/cannot be a folder/);
  });

  it("moves a deleted project's file to backups", async () => {
    const root = new MemDir();
    const store = openFolder(root);
    await store.putProject(stored("a", "Gifts"));
    await store.deleteProject("a");
    await store.deleteProject("a");
    expect(root.paths()).toHaveLength(1);
    expect(root.paths()[0]).toMatch(/^backups\/project-\d{8}-\d{6}-\d{3}-a\.json$/);
    expect(root.read(root.paths()[0])).toBe(file("Project a"));
    expect((await store.readShelf()).projects).toEqual([]);
  });

  it("renames a folder with what is in it, and moves it into another", async () => {
    const root = new MemDir();
    const store = openFolder(root);
    await store.putProject(stored("a", "Gifts"));
    await store.putProject(stored("b", "Gifts/Christmas"));
    await store.createFolder("Gifts/Empty");
    expect(await store.renameFolder("Gifts", "Presents")).toBe("Presents");
    expect(root.paths()).toEqual(["projects/Presents/Christmas/b.json", "projects/Presents/a.json"]);
    expect((await store.readShelf()).folders).toEqual(["Presents", "Presents/Christmas", "Presents/Empty"]);
    await store.createFolder("Orders");
    expect(await store.renameFolder("Presents", "Orders/Presents")).toBe("Orders/Presents");
    expect((await store.readShelf()).folders).toEqual(["Orders", "Orders/Presents", "Orders/Presents/Christmas", "Orders/Presents/Empty"]);
    await expect(store.renameFolder("Orders", "Orders/Inner")).rejects.toThrow(/into itself/);
  });

  it("does not rename a folder in case only, where the two names are one folder: its files would be taken away", async () => {
    const root = new MemDir("root", true);
    const store = openFolder(root);
    await store.putProject(stored("a", "Gifts"));
    await expect(store.renameFolder("Gifts", "gifts")).rejects.toThrow(/case/);
    expect(root.paths()).toEqual(["projects/Gifts/a.json"]);
  });

  it("leaves a renamed or deleted folder where it holds something the app did not put there", async () => {
    const root = new MemDir();
    const store = openFolder(root);
    await store.putProject(stored("a", "Gifts"));
    await store.putProject(stored("b", "Gifts/Christmas"));
    root.put("projects/Gifts/notes.txt", "mine");
    root.put("projects/Gifts/Christmas/Thumbs.db", "x");
    expect(await store.deleteFolder("Gifts")).toBe(2);
    expect(root.paths()).toEqual(["projects/Gifts/notes.txt", "projects/a.json", "projects/b.json"]);
    expect((await store.readShelf()).projects.map((p) => p.folder)).toEqual(["", ""]);
    await expect(store.deleteFolder("Nowhere")).rejects.toThrow(/no folder/);
  });
});

describe("settings kept in a folder", () => {
  it("are one file with a text per key, and the tool list a file of its own", async () => {
    const root = new MemDir();
    const store = openFolder(root);
    expect(await store.getSetting("machine")).toBeUndefined();
    expect(await store.getSetting("tools")).toBeUndefined();
    // At the same moment, as the app writes them: none is lost.
    await Promise.all([store.putSetting("machine", "m"), store.putSetting("inlayDefaults", "d"), store.putSetting("lastProjectId", "a"), store.putSetting("tools", "{tools}")]);
    expect(JSON.parse(root.read("settings.json")!)).toEqual({ machine: "m", inlayDefaults: "d", lastProjectId: "a", saved: { machine: expect.any(Number), inlayDefaults: expect.any(Number) } });
    expect(root.read("tools.json")).toBe("{tools}");
    expect(await store.getSetting("machine")).toBe("m");
    expect(await store.getSetting("tools")).toBe("{tools}");
  });

  it("sets a settings file that cannot be read aside before writing a new one", async () => {
    const root = new MemDir();
    root.put("settings.json", "[spoilt");
    const store = openFolder(root);
    expect(await store.getSetting("machine")).toBeUndefined();
    await store.putSetting("machine", "m");
    expect(JSON.parse(root.read("settings.json")!)).toEqual({ machine: "m", saved: { machine: expect.any(Number) } });
    const aside = root.paths().find((p) => p.startsWith("backups/settings-"))!;
    expect(root.read(aside)).toBe("[spoilt");
  });

  it("goes on after a write that failed", async () => {
    const root = new MemDir();
    const store = openFolder(root);
    const real = root.getFileHandle.bind(root);
    let fail = true;
    root.getFileHandle = async (name, options) => {
      if (fail && options?.create) throw new Error("the disk is full");
      return real(name, options);
    };
    await expect(store.putSetting("machine", "m")).rejects.toThrow(/disk is full/);
    fail = false;
    await store.putSetting("machine", "m2");
    expect(await store.getSetting("machine")).toBe("m2");
  });
});

describe("when a setting kept in a folder was last changed", () => {
  it("is the day it changed, not the day it was kept again as it was", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const root = new MemDir();
      const store = openFolder(root);
      expect(await store.settingSaved("machine")).toBeUndefined();
      expect(await store.settingSaved("tools")).toBeUndefined();
      vi.setSystemTime(5000);
      await store.putSetting("machine", "m");
      await store.putSetting("inlayDefaults", "d");
      await store.putSetting("tools", "{tools}");
      const tools = await store.settingSaved("tools");
      expect(tools).toBeGreaterThan(0);
      vi.setSystemTime(9000);
      await store.putSetting("machine", "m");
      await store.putSetting("inlayDefaults", "d2");
      await store.putSetting("tools", "{tools}");
      // What is not synced is not dated.
      await store.putSetting("lastProjectId", "a");
      expect(await store.settingSaved("machine")).toBe(5000);
      expect(await store.settingSaved("inlayDefaults")).toBe(9000);
      expect(await store.settingSaved("tools")).toBe(tools);
      expect(JSON.parse(root.read("settings.json")!).saved).toEqual({ machine: 5000, inlayDefaults: 9000 });
      await store.putSetting("tools", "{tools 2}");
      expect(await store.settingSaved("tools")).toBeGreaterThan(tools!);
      // Copied from another place, it is dated as it is there.
      await store.putSetting("machine", "m3", 7000);
      expect(await store.settingSaved("machine")).toBe(7000);
      await store.putSetting("machine", "m");
      // The dates are not a setting to be read as one.
      expect(await store.getSetting("saved")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not known of settings written before they were dated, or with dates that are none", async () => {
    const root = new MemDir();
    root.put("settings.json", JSON.stringify({ machine: "m", inlayDefaults: "d", saved: "x" }));
    const store = openFolder(root);
    expect(await store.settingSaved("machine")).toBeUndefined();
    await store.putSetting("machine", "m2");
    expect(JSON.parse(root.read("settings.json")!)).toEqual({ machine: "m2", inlayDefaults: "d", saved: { machine: expect.any(Number) } });
    expect(await store.settingSaved("inlayDefaults")).toBeUndefined();
  });
});

describe("what a project's file says of it", () => {
  it("is its name, its steps (once its jobs) and whether it has a drawing", () => {
    expect(summaryOf(file("A", 3))).toEqual({ name: "A", steps: 3, blank: false });
    expect(summaryOf(file("A", 0, null))).toEqual({ name: "A", steps: 0, blank: true });
    expect(summaryOf('{"project":{"jobs":[1]}}')).toEqual({ name: "", steps: 1, blank: false });
    expect(summaryOf("nonsense")).toEqual({ name: "", steps: 0, blank: false });
    expect(summaryOf("null")).toEqual({ name: "", steps: 0, blank: false });
  });
});


describe("a project's file changed by hand and then filed", () => {
  it("is listed with what the file says now, not with what was read of it before", async () => {
    const root = new MemDir();
    const store = openFolder(root);
    await store.putProject({ ...stored("a"), steps: 2, thumb: { w: 1, h: 1, d: "M0 0" } });
    root.put("projects/a.json", file("Edited", 4));
    await store.moveProject("a", "Gifts");
    expect((await store.readShelf()).projects[0]).toMatchObject({ name: "Edited", steps: 4, folder: "Gifts", thumb: undefined });
  });
});

describe("the tool list set aside", () => {
  it("is kept in backups as it was, and nothing is kept while there is none", async () => {
    const root = new MemDir();
    const store = openFolder(root);
    await store.setToolsAside();
    expect(root.paths()).toEqual([]);
    await store.putSetting("tools", "{mine}");
    await store.setToolsAside();
    await store.putSetting("tools", "{theirs}");
    const aside = root.paths().find((p) => /^backups\/tools-\d{8}-\d{6}-\d{3}\.json$/.test(p))!;
    expect(root.read(aside)).toBe("{mine}");
    expect(root.read("tools.json")).toBe("{theirs}");
  });
});

describe("writes to a folder at the same moment", () => {
  it("go one after the other: a browser lets one writer at a file, and the last is what is kept", async () => {
    const root = new MemDir();
    const store = openFolder(root);
    await Promise.all([store.putSetting("tools", "{one}"), store.putSetting("tools", "{two}"), store.putSetting("tools", "{three}")]);
    expect(root.read("tools.json")).toBe("{three}");
  });

  it("do not leave a file locked after one that failed", async () => {
    const root = new MemDir();
    const store = openFolder(root);
    await store.putSetting("tools", "{one}");
    (await root.getFileHandle("tools.json")).failing = new Error("the disk is full");
    await expect(store.putSetting("tools", "{two}")).rejects.toThrow(/disk is full/);
    await store.putSetting("tools", "{three}");
    expect(root.read("tools.json")).toBe("{three}");
  });

  it("do not bring a project's file back to the folder it is moved out of", async () => {
    const root = new MemDir();
    const store = openFolder(root);
    await store.putProject(stored("a", "Gifts"));
    // A save and a move, begun together.
    await Promise.all([store.putProject({ ...stored("a"), text: file("Saved") }), store.moveProject("a", "Orders"), store.putProject({ ...stored("a"), text: file("Saved again") })]);
    expect(root.paths()).toEqual(["projects/Orders/a.json"]);
    expect(root.read("projects/Orders/a.json")).toBe(file("Saved again"));
  });
});
