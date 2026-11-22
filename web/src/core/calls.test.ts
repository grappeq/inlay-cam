import { describe, expect, it } from "vitest";
import { createCalls, createPace } from "./calls";
import type { CoreProgress, CoreRequest } from "./protocol";

function setup() {
  const sent: CoreRequest[] = [];
  const calls = createCalls((request) => sent.push(request));
  return { sent, calls };
}

const cut = (done: number, total = 100): CoreProgress => ({ stage: "cut", done, total });

describe("calls to the core", () => {
  it("send a request and give its answer to who asked", async () => {
    const { sent, calls } = setup();
    const version = calls.call("coreVersion", []);
    expect(sent).toEqual([{ id: 1, method: "coreVersion", args: [] }]);
    calls.receive({ id: 1, ok: true, value: "0.1.0" });
    expect(await version).toBe("0.1.0");
    expect(calls.count()).toBe(0);
  });

  it("give each answer to its own call, whatever the order", async () => {
    const { calls } = setup();
    const a = calls.call("coreVersion", []);
    const b = calls.call("coreVersion", []);
    calls.receive({ id: 2, ok: true, value: "b" });
    calls.receive({ id: 1, ok: true, value: "a" });
    expect(await a).toBe("a");
    expect(await b).toBe("b");
  });

  it("fail with what the core said", async () => {
    const { calls } = setup();
    const made = calls.call("coreVersion", []);
    calls.receive({ id: 1, ok: false, error: "No V-bit is chosen.\nNo end mill is chosen." });
    await expect(made).rejects.toThrow("No V-bit is chosen.\nNo end mill is chosen.");
  });

  it("tell a call's watcher how far it is, and no other's", async () => {
    const { calls } = setup();
    const first: CoreProgress[] = [];
    const second: CoreProgress[] = [];
    const a = calls.call("coreVersion", [], (p) => first.push(p));
    const b = calls.call("coreVersion", [], (p) => second.push(p));
    calls.receive({ id: 1, progress: cut(10) });
    calls.receive({ id: 2, progress: cut(50) });
    calls.receive({ id: 1, progress: cut(20) });
    expect(first).toEqual([cut(10), cut(20)]);
    expect(second).toEqual([cut(50)]);
    // Progress does not end a call.
    expect(calls.count()).toBe(2);
    calls.receive({ id: 1, ok: true, value: "a" });
    calls.receive({ id: 2, ok: true, value: "b" });
    await a;
    await b;
  });

  it("take progress for a call nobody watches, and for one that is over", async () => {
    const { calls } = setup();
    const made = calls.call("coreVersion", []);
    calls.receive({ id: 1, progress: cut(10) });
    calls.receive({ id: 1, ok: true, value: "v" });
    calls.receive({ id: 1, progress: cut(20) });
    calls.receive({ id: 9, progress: cut(20) });
    calls.receive({ id: 9, ok: true, value: "late" });
    expect(await made).toBe("v");
  });

  it("go on when a watcher fails", async () => {
    const { calls } = setup();
    const made = calls.call("coreVersion", [], () => {
      throw new Error("the page went wrong");
    });
    calls.receive({ id: 1, progress: cut(10) });
    calls.receive({ id: 1, ok: true, value: "v" });
    expect(await made).toBe("v");
  });

  it("all fail when the core is gone", async () => {
    const { calls } = setup();
    const a = calls.call("coreVersion", []);
    const b = calls.call("coreVersion", []);
    calls.failAll(new Error("The core worker failed to load"));
    await expect(a).rejects.toThrow("failed to load");
    await expect(b).rejects.toThrow("failed to load");
    expect(calls.count()).toBe(0);
  });
});

describe("the pace of progress", () => {
  function paced(ms = 100) {
    let now = 0;
    const pass = createPace(() => now, ms);
    return { pass, wait: (by: number) => (now += by) };
  }

  it("lets the first word through, and then one each while", () => {
    const { pass, wait } = paced();
    expect(pass(cut(0))).toBe(true);
    expect(pass(cut(1))).toBe(false);
    wait(99);
    expect(pass(cut(2))).toBe(false);
    wait(1);
    expect(pass(cut(3))).toBe(true);
    expect(pass(cut(4))).toBe(false);
  });

  it("lets every change of stage through", () => {
    const { pass } = paced();
    expect(pass({ stage: "paths", done: 0, total: 0 })).toBe(true);
    expect(pass({ stage: "write", done: 0, total: 0 })).toBe(true);
    expect(pass(cut(5))).toBe(true);
    expect(pass({ stage: "step", done: 3, total: 6 })).toBe(true);
  });

  it("never holds back where the list is, however fast its steps follow", () => {
    const { pass } = paced();
    // Two steps done by hand, one right after the other.
    expect(pass({ stage: "step", done: 1, total: 4 })).toBe(true);
    expect(pass({ stage: "step", done: 2, total: 4 })).toBe(true);
    expect(pass({ stage: "plug", done: 0, total: 4 })).toBe(true);
    expect(pass({ stage: "plug", done: 3, total: 4 })).toBe(true);
    expect(pass({ stage: "build", done: 1, total: 4 })).toBe(true);
    expect(pass({ stage: "build", done: 2, total: 4 })).toBe(true);
    expect(pass({ stage: "list", done: 2, total: 4 })).toBe(true);
    expect(pass({ stage: "list", done: 4, total: 4 })).toBe(true);
  });

  it("lets the start of a new count of the same stage through", () => {
    const { pass } = paced();
    expect(pass(cut(0))).toBe(true);
    expect(pass(cut(50))).toBe(false);
    // The next file's cutting starts: its bar starts at nothing.
    expect(pass(cut(0, 40))).toBe(true);
  });

  it("starts anew for a new call", () => {
    const { pass } = paced();
    expect(pass(cut(10))).toBe(true);
    expect(pass(cut(11))).toBe(false);
    pass.reset();
    expect(pass(cut(12))).toBe(true);
  });
});
