// Which place the page starts on, and how a browser's storage and the
// record of a sync are used as places.

import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
});
const load = () => import("./places");

describe("the place the page starts on", () => {
  it("is the server where there is one and the browser where there is not, unless one was chosen", async () => {
    const { placeToStart } = await load();
    expect(placeToStart(null, true, "none")).toBe("server");
    expect(placeToStart(null, false, "none")).toBe("browser");
    expect(placeToStart("browser", true, "granted")).toBe("browser");
    expect(placeToStart("server", true, "granted")).toBe("server");
  });

  it("is the folder that was chosen, asked for first when the browser wants that", async () => {
    const { placeToStart } = await load();
    expect(placeToStart("folder", true, "granted")).toBe("folder");
    expect(placeToStart("folder", true, "ask")).toBe("ask");
  });

  it("is not a place that is gone: a server that does not answer, a folder that was never picked here", async () => {
    const { placeToStart } = await load();
    expect(placeToStart("server", false, "none")).toBe("browser");
    expect(placeToStart("folder", false, "none")).toBe("browser");
    expect(placeToStart("folder", true, "none")).toBe("server");
  });
});

describe("a browser's storage as a place to sync with", () => {
  it("does not keep the picture of a drawing a project no longer has", async () => {
    const { storeOf } = await load();
    const db = await import("./db");
    const browser = storeOf("browser");
    await db.putProject({ id: "a", name: "A", modified: 1, text: "old", folder: "Gifts", thumb: { w: 1, h: 1, d: "M0 0" } });
    await browser.putProject({ id: "a", name: "A", modified: 2, text: "new", folder: "Elsewhere" });
    const kept = (await db.readShelf()).projects[0];
    expect(kept.thumb).toBeUndefined();
    // Still where it was filed: a kept project stays in its folder.
    expect(kept.folder).toBe("Gifts");
    expect((await db.getProject("a"))?.text).toBe("new");
    await browser.putProject({ id: "a", name: "A", modified: 3, text: "newer", thumb: null });
    expect((await db.readShelf()).projects[0].thumb).toBeNull();
  });

  it("refuses to be a folder while none was chosen", async () => {
    const { storeOf } = await load();
    expect(() => storeOf("folder")).toThrow(/No folder/);
  });
});

describe("how two places stood when last synced", () => {
  it("is remembered for the pair, whichever is named first", async () => {
    const { readBase, writeBase } = await load();
    await writeBase("server", "browser", { tools: { a: "s", b: "b" } });
    expect(await readBase("server", "browser")).toEqual({ tools: { a: "s", b: "b" } });
    expect(await readBase("browser", "server")).toEqual({ tools: { a: "b", b: "s" } });
    expect(await readBase("browser", "folder")).toEqual({});
  });
});
