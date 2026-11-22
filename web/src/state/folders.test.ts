import { describe, expect, it } from "vitest";
import {
  allFolders,
  createFolderIn,
  deleteFolderIn,
  folderNameProblem,
  folderRows,
  isFolderPath,
  refileStarts,
  renameFolderIn,
  resolveFolder,
  scopeThatIs,
  shownProjects,
  startIn,
  startOf,
  started,
} from "./folders";

const project = (id: string, name: string, folder: string, modified: number) => ({ id, name, folder, modified });

describe("folder names", () => {
  it("takes names every file system takes", () => {
    for (const name of ["Gifts", "Test cuts", "Zlecenia 2026", "Żółw & co", "a.b", "x".repeat(60), "COM0", "COM10", "console"]) {
      expect(folderNameProblem(name), name).toBeNull();
    }
  });

  it("refuses the ones some file system does not, as the server does", () => {
    // The same list as store.rs's folder_names_are_ones_every_file_system_takes.
    const refused = ["", ".", "..", ".git", "a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b", " a", "a ", "a.", "a\tb", "CON", "con", "nul.txt", "COM1", "lpt9", "x".repeat(61), "CON .txt", "COM¹", "lpt²", "CLOCK$", "conin$", "a\u200bb", "a\u202eb", "\ufeffa"];
    for (const name of refused) expect(folderNameProblem(name), JSON.stringify(name)).not.toBeNull();
  });

  it("counts characters, not UTF-16 units", () => {
    expect(folderNameProblem("🪵".repeat(60))).toBeNull();
    expect(folderNameProblem("🪵".repeat(61))).not.toBeNull();
  });

  it("takes paths up to four deep", () => {
    expect(isFolderPath("a/b/c/d")).toBe(true);
    for (const path of ["", "a/b/c/d/e", "a//b", "/a", "a/", "a/../b"]) expect(isFolderPath(path), path).toBe(false);
  });
});

describe("the list of folders", () => {
  it("holds the folders listed, the ones projects are in, and the ones those are in", () => {
    expect(allFolders(["Orders"], [{ folder: "Gifts/Christmas" }, { folder: "" }, {}])).toEqual(["Gifts", "Gifts/Christmas", "Orders"]);
  });

  it("lists a folder before the ones in it, whatever their names sort as", () => {
    expect(allFolders(["a b", "a/z", "a", "B", "a-b"])).toEqual(["a", "a/z", "a b", "a-b", "B"]);
  });

  it("takes two spellings of a name for one folder, the first one met", () => {
    expect(allFolders(["Gifts", "gifts", "GIFTS/Christmas"])).toEqual(["Gifts", "Gifts/Christmas"]);
  });

  it("leaves out what cannot be a folder", () => {
    expect(allFolders(["../x", "a/b/c/d/e", "ok"], [{ folder: "CON" }])).toEqual(["ok"]);
  });

  it("spells a path as its folders are spelt already", () => {
    const folders = ["Gifts", "Gifts/Christmas"];
    expect(resolveFolder(folders, "gifts/christmas/New")).toBe("Gifts/Christmas/New");
    expect(resolveFolder(folders, "Orders/2026")).toBe("Orders/2026");
    expect(resolveFolder(folders, "")).toBe("");
    // An exact match wins over one that differs in case.
    expect(resolveFolder(["a", "A"], "A")).toBe("A");
  });
});

describe("making a folder", () => {
  it("adds it and the ones it is in", () => {
    expect(createFolderIn(["Orders"], "Gifts/Christmas")).toEqual({ folders: ["Gifts", "Gifts/Christmas", "Orders"], folder: "Gifts/Christmas" });
  });

  it("goes under a folder as that one is spelt", () => {
    expect(createFolderIn(["Gifts"], "gifts/Christmas").folder).toBe("Gifts/Christmas");
  });

  it("refuses one that is there, in whatever case, and one that cannot be", () => {
    expect(() => createFolderIn(["Gifts"], "Gifts")).toThrow(/already/);
    expect(() => createFolderIn(["Gifts"], "gifts")).toThrow(/already/);
    expect(() => createFolderIn([], "a/b/c/d/e")).toThrow(/four deep/);
    expect(() => createFolderIn([], "a:b")).toThrow(/cannot be a folder/);
    expect(() => createFolderIn([], "")).toThrow();
  });
});

describe("renaming and moving a folder", () => {
  const folders = ["Gifts", "Gifts/Christmas", "Orders"];

  it("takes what is in it along", () => {
    const renamed = renameFolderIn(folders, "Gifts", "Presents");
    expect(renamed.folders).toEqual(["Orders", "Presents", "Presents/Christmas"]);
    expect(renamed.folder).toBe("Presents");
    expect(renamed.move("Gifts")).toBe("Presents");
    expect(renamed.move("Gifts/Christmas")).toBe("Presents/Christmas");
    expect(renamed.move("Orders")).toBe("Orders");
    expect(renamed.move("")).toBe("");
    // Not a folder that only begins with its name.
    expect(renamed.move("Gifts 2")).toBe("Gifts 2");
  });

  it("moves it into another folder, spelt as that one is", () => {
    const moved = renameFolderIn(folders, "Gifts", "orders/Gifts");
    expect(moved.folder).toBe("Orders/Gifts");
    expect(moved.folders).toEqual(["Orders", "Orders/Gifts", "Orders/Gifts/Christmas"]);
    expect(moved.move("Gifts/Christmas")).toBe("Orders/Gifts/Christmas");
  });

  it("moves it out to the top", () => {
    const moved = renameFolderIn(folders, "Gifts/Christmas", "Christmas");
    expect(moved.folders).toEqual(["Christmas", "Gifts", "Orders"]);
  });

  it("changes only the case of its name", () => {
    const renamed = renameFolderIn(folders, "Gifts", "gifts");
    expect(renamed.folders).toEqual(["gifts", "gifts/Christmas", "Orders"]);
    expect(renamed.move("Gifts/Christmas")).toBe("gifts/Christmas");
  });

  it("leaves everything as it is when the name is the one it has", () => {
    expect(renameFolderIn(folders, "Gifts", "Gifts").folders).toBe(folders);
  });

  it("refuses what cannot be done", () => {
    expect(() => renameFolderIn(folders, "Nothing", "X")).toThrow(/no folder/);
    expect(() => renameFolderIn(folders, "Gifts", "Gifts/Inner")).toThrow(/into itself/);
    expect(() => renameFolderIn(folders, "Gifts", "gifts/Christmas/Gifts")).toThrow(/into itself/);
    expect(() => renameFolderIn(folders, "Gifts", "orders")).toThrow(/already/);
    expect(() => renameFolderIn(folders, "Gifts", "a?")).toThrow(/cannot be a folder/);
    // Gifts/Christmas under a/b/c would be five deep.
    expect(() => renameFolderIn([...folders, "a", "a/b", "a/b/c"], "Gifts", "a/b/c/Gifts")).toThrow(/four deep/);
    expect(renameFolderIn([...folders, "a", "a/b"], "Gifts", "a/b/Gifts").folder).toBe("a/b/Gifts");
  });
});

describe("taking a folder away", () => {
  it("takes the folders in it too, and says which projects it held", () => {
    const gone = deleteFolderIn(["Gifts", "Gifts/Christmas", "Gifts 2", "Orders"], "gifts");
    expect(gone.folders).toEqual(["Gifts 2", "Orders"]);
    expect(gone.held("Gifts")).toBe(true);
    expect(gone.held("Gifts/Christmas")).toBe(true);
    expect(gone.held("Gifts 2")).toBe(false);
    expect(gone.held("")).toBe(false);
  });

  it("refuses a folder that is not there", () => {
    expect(() => deleteFolderIn(["Gifts"], "Orders")).toThrow(/no folder/);
  });
});

describe("what a list of projects shows", () => {
  const projects = [
    project("1", "Walnut coaster", "Gifts", 400),
    project("2", "Star ornament", "Gifts/Christmas", 300),
    project("3", "Feed test", "", 200),
    project("4", "", "Gifts 2", 100),
    project("5", "coaster 10", "", 50),
    project("6", "Coaster 9", "", 60),
  ];
  const ids = (scope: Parameters<typeof shownProjects>[1], query = "", sort: "modified" | "name" = "modified") =>
    shownProjects(projects, scope, query, sort).map((p) => p.id);

  it("shows a folder with the folders in it, and nothing that only begins with its name", () => {
    expect(ids({ kind: "folder", path: "Gifts" })).toEqual(["1", "2"]);
    expect(ids({ kind: "folder", path: "Gifts/Christmas" })).toEqual(["2"]);
    expect(ids({ kind: "unfiled" })).toEqual(["3", "6", "5"]);
    expect(ids({ kind: "all" })).toEqual(["1", "2", "3", "4", "6", "5"]);
  });

  it("finds by every word, in any case, and a project without a name as Untitled", () => {
    expect(ids({ kind: "all" }, "COASTER")).toEqual(["1", "6", "5"]);
    expect(ids({ kind: "all" }, "coaster wal")).toEqual(["1"]);
    expect(ids({ kind: "all" }, "untitled")).toEqual(["4"]);
    expect(ids({ kind: "unfiled" }, "walnut")).toEqual([]);
  });

  it("sorts by name with numbers in their order", () => {
    expect(ids({ kind: "unfiled" }, "", "name")).toEqual(["6", "5", "3"]);
  });

  it("does not change the list it is given", () => {
    const before = projects.map((p) => p.id);
    shownProjects(projects, { kind: "all" }, "", "name");
    expect(projects.map((p) => p.id)).toEqual(before);
  });

  it("counts a folder's projects with those of the folders in it", () => {
    expect(folderRows(["Gifts", "Gifts/Christmas", "Gifts 2"], projects)).toEqual([
      { path: "Gifts", name: "Gifts", depth: 0, count: 2 },
      { path: "Gifts/Christmas", name: "Christmas", depth: 1, count: 1 },
      { path: "Gifts 2", name: "Gifts 2", depth: 0, count: 1 },
    ]);
  });

  it("falls back to all projects when the folder shown is gone", () => {
    expect(scopeThatIs({ kind: "folder", path: "Gifts" }, ["Orders"])).toEqual({ kind: "all" });
    expect(scopeThatIs({ kind: "folder", path: "Gifts" }, ["Gifts"])).toEqual({ kind: "folder", path: "Gifts" });
    expect(scopeThatIs({ kind: "unfiled" }, [])).toEqual({ kind: "unfiled" });
  });
});

describe("where a project that is not kept yet starts", () => {
  it("is the folder said for it, until it is kept", () => {
    startIn("new-1", "Gifts");
    expect(startOf("new-1")).toBe("Gifts");
    expect(startOf("other")).toBeUndefined();
    started("new-1");
    expect(startOf("new-1")).toBeUndefined();
    startIn("new-1", "");
    expect(startOf("new-1")).toBeUndefined();
  });

  it("follows its folder when that is renamed or moved, as the folder's projects do", () => {
    startIn("new-2", "Gifts/Christmas");
    startIn("new-3", "Orders");
    refileStarts(renameFolderIn(["Gifts", "Gifts/Christmas", "Orders"], "Gifts", "Presents").move);
    expect(startOf("new-2")).toBe("Presents/Christmas");
    expect(startOf("new-3")).toBe("Orders");
    started("new-2");
    started("new-3");
  });

  it("is no folder once its folder is taken away, so that the first save does not make it again", () => {
    startIn("new-4", "Gifts/Christmas");
    startIn("new-5", "Gifts 2");
    const gone = deleteFolderIn(["Gifts", "Gifts/Christmas", "Gifts 2"], "Gifts");
    refileStarts((folder) => (gone.held(folder) ? "" : folder));
    expect(startOf("new-4")).toBeUndefined();
    expect(startOf("new-5")).toBe("Gifts 2");
    started("new-5");
  });
});
