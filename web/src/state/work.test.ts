// The long work of the core as tasks: what the list of tasks says while each
// goes on, with a core that answers when the test lets it.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The calls the core was given, each waiting for the test to answer it. */
const calls: { method: string; args: unknown[]; tag?: string; resolve: (v: unknown) => void; reject: (e: Error) => void; say: (p: CoreProgress) => void }[] = [];
/** The tags the core was told to call off. */
const cancelled: string[] = [];

vi.mock("../core/client", () => ({
  core: {
    call: (method: string, ...args: unknown[]) => new Promise((resolve, reject) => calls.push({ method, args, resolve, reject, say: () => {} })),
    watch: (say: (p: CoreProgress) => void, method: string, ...args: unknown[]) => new Promise((resolve, reject) => calls.push({ method, args, resolve, reject, say })),
    work: (tag: string, say: (p: CoreProgress) => void, method: string, ...args: unknown[]) => new Promise((resolve, reject) => calls.push({ method, args, tag, resolve, reject, say })),
    // As the core does: every call of the work fails as cancelled.
    cancel: (tag: string) => {
      cancelled.push(tag);
      for (const call of calls) if (call.tag === tag) call.reject(new Cancelled());
    },
  },
}));

import { Cancelled } from "../core/calls";

import type { CoreProgress } from "../core/protocol";

import type { Built, Project } from "../core/types";
import { newProject, newStep } from "./model";
import type { Output } from "./store";
import { tasks } from "./tasks";
import { FILES, STOCK, createFileRuns, fileProgress, generateKey, isCancelled, makeOutput, remakeOutput, stockCalledOff, stockOf, stockProgress, stockRows } from "./work";

/** Lets what waits on a settled promise run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function project(type: "vcarve" | "flat" | "pocket"): { project: Project; step: Project["steps"][number] } {
  const blank = newProject("Coaster");
  const step = newStep(type, [1], [], blank.setup);
  return { project: { ...blank, steps: [step] }, step };
}

beforeEach(() => {
  calls.length = 0;
  cancelled.length = 0;
  expect(tasks.get()).toHaveLength(0);
});

describe("taking the stock through the list", () => {
  it("is one task and one call for all who ask at once", async () => {
    const { project: p } = project("flat");
    const a = stockOf(p);
    const b = stockOf(p);
    expect(calls.map((c) => c.method)).toEqual(["stockTimeline"]);
    expect(tasks.get().filter((t) => t.key === STOCK)).toHaveLength(1);
    expect(tasks.find(STOCK)).toMatchObject({ label: "Cutting the stock", total: null, heavy: true });
    calls[0].resolve({ steps: [] });
    expect(await a).toEqual({ steps: [] });
    expect(await b).toEqual({ steps: [] });
    expect(tasks.get()).toHaveLength(0);
  });

  it("is done anew for a project that has changed", async () => {
    const { project: p } = project("flat");
    const first = stockOf(p);
    const second = stockOf({ ...p });
    expect(calls).toHaveLength(2);
    calls[0].resolve(1);
    calls[1].resolve(2);
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(tasks.get()).toHaveLength(0);
  });

  it("says which step it is at, and how far that step's cutting is", async () => {
    const blank = newProject("Coaster");
    const steps = ["Face", "Leaf", "Trim"].map((name) => ({ ...newStep("pocket", [1], [], blank.setup), name }));
    const p = { ...blank, steps };
    const run = stockOf(p);
    const now = () => tasks.find(STOCK);
    // Before the core says where it is, it is going on with no count.
    expect(now()).toMatchObject({ total: null, part: null, stage: "One step after the other" });
    // It goes on from the second step: the first is kept. The rows can be shown from here.
    calls[0].say({ stage: "list", done: 1, total: 3 });
    expect(now()).toMatchObject({ done: 1, total: 3, kept: 1, stage: "Leaf", part: null, unit: "step" });
    calls[0].say({ stage: "build", done: 1, total: 3 });
    expect(now()).toMatchObject({ done: 1, total: 3, stage: 'The paths of "Leaf"' });
    calls[0].say({ stage: "step", done: 1, total: 3 });
    expect(now()).toMatchObject({ done: 1, total: 3, kept: 1, stage: "Leaf", part: null });
    calls[0].say({ stage: "cut", done: 30, total: 120 });
    expect(now()).toMatchObject({ done: 1, part: 0.25 });
    calls[0].say({ stage: "step", done: 2, total: 3 });
    expect(now()).toMatchObject({ done: 2, kept: 1, stage: "Trim", part: null });
    calls[0].say({ stage: "list", done: 3, total: 3 });
    expect(now()).toMatchObject({ done: 3, total: 3, kept: 1, part: null });
    calls[0].resolve({ steps: [] });
    await run;
    expect(tasks.get()).toHaveLength(0);
  });

  it("can be called off: all who asked are told so, and its task ends", async () => {
    const { project: p } = project("flat");
    const a = stockOf(p);
    const b = stockOf(p);
    const task = tasks.find(STOCK)!;
    expect(task.cancellable).toBe(true);
    tasks.cancel(task.id);
    expect(cancelled).toEqual([calls[0].tag]);
    await expect(a).rejects.toSatisfy(isCancelled);
    await expect(b).rejects.toSatisfy(isCancelled);
    expect(tasks.get()).toHaveLength(0);
    // Asked for again, it is a run of its own, called off by another name.
    const again = stockOf(p);
    expect(calls).toHaveLength(2);
    expect(calls[1].tag).not.toBe(calls[0].tag);
    calls[1].resolve(1);
    await again;
  });

  it("called off, is known to be for that project, until it is asked for again", async () => {
    const { project: p } = project("flat");
    const other = { ...p };
    expect(stockCalledOff(p)).toBe(false);
    const run = stockOf(p);
    tasks.cancel(tasks.find(STOCK)!.id);
    // Known at once, before whoever asked has heard of it.
    expect(stockCalledOff(p)).toBe(true);
    expect(stockCalledOff(other)).toBe(false);
    await expect(run).rejects.toSatisfy(isCancelled);
    expect(stockCalledOff(p)).toBe(true);
    // Asked for again, it is under way, not called off.
    const again = stockOf(p);
    expect(stockCalledOff(p)).toBe(false);
    calls[1].resolve(1);
    await again;
    expect(stockCalledOff(p)).toBe(false);
  });

  it("is not said to be called off when it failed", async () => {
    const { project: p } = project("flat");
    const run = stockOf(p);
    calls[0].reject(new Error("The stock is too thin."));
    await expect(run).rejects.toThrow();
    expect(stockCalledOff(p)).toBe(false);
  });

  it("is the task of whoever asked for it", async () => {
    const { project: p } = project("flat");
    const run = stockOf(p, "agent");
    expect(tasks.find(STOCK)?.by).toBe("agent");
    calls[0].resolve(1);
    await run;
    const again = stockOf(p);
    expect(tasks.find(STOCK)?.by).toBe("user");
    calls[1].resolve(1);
    await again;
  });

  it("ends its task when it fails", async () => {
    const { project: p } = project("flat");
    const run = stockOf(p);
    calls[0].reject(new Error("The stock is too thin."));
    await expect(run).rejects.toThrow("The stock is too thin.");
    expect(tasks.get()).toHaveLength(0);
  });
});

describe("making a step's files", () => {
  it("counts pocket, plug and fit for a V-carve inlay", async () => {
    const { project: p, step } = project("vcarve");
    const seen: Output[] = [];
    const run = makeOutput(p, step, (out) => seen.push(out));
    const now = () => tasks.find(generateKey(step.id));
    expect(now()).toMatchObject({ label: "Working out the pocket", done: 0, total: 3 });
    expect(calls[0]).toMatchObject({ method: "previewPart", args: [p, step.id, "pocket"] });
    // The file's stages are said as they come, and how far the cutting is.
    calls[0].say({ stage: "paths", done: 0, total: 0 });
    expect(now()).toMatchObject({ stage: "Working out the paths", part: null });
    calls[0].say({ stage: "cut", done: 50, total: 200 });
    expect(now()).toMatchObject({ stage: "Cutting the board with it", part: 0.25, done: 0 });
    calls[0].resolve({ built: "pocket" });
    await settle();
    // The next part starts with nothing said of how far it is.
    expect(now()).toMatchObject({ label: "Working out the plug", done: 1, total: 3, stage: null, part: null });
    expect(seen).toHaveLength(1);
    calls[1].resolve({ built: "plug" });
    await settle();
    expect(now()).toMatchObject({ label: "Fitting the plug into the pocket", done: 2, total: 3 });
    expect(calls[2].method).toBe("checkFit");
    calls[2].resolve({ verdict: "good" });
    const out = await run;
    expect(out.fit).toEqual({ verdict: "good" });
    expect(Object.keys(out.parts)).toEqual(["pocket", "plug"]);
    expect(seen).toHaveLength(3);
    // What was published earlier is not changed by what came later.
    expect(Object.keys(seen[0].parts)).toEqual(["pocket"]);
    expect(tasks.get()).toHaveLength(0);
  });

  it("counts two parts for a flat inlay and one for a plain operation", async () => {
    const flat = project("flat");
    const a = makeOutput(flat.project, flat.step);
    expect(tasks.find(generateKey(flat.step.id))).toMatchObject({ total: 2, label: "Working out the pocket" });
    calls[0].resolve({});
    await settle();
    expect(tasks.find(generateKey(flat.step.id))).toMatchObject({ done: 1, label: "Working out the insert" });
    calls[1].resolve({});
    await a;
    expect(calls).toHaveLength(2);

    const plain = project("pocket");
    const b = makeOutput(plain.project, plain.step);
    expect(tasks.find(generateKey(plain.step.id))).toMatchObject({ total: 1, by: "user" });
    calls[2].resolve({});
    await b;
    expect(tasks.get()).toHaveLength(0);
  });

  it("called off while a part is made, fails as cancelled and makes nothing more", async () => {
    const { project: p, step } = project("vcarve");
    const seen: Output[] = [];
    const run = makeOutput(p, step, (out) => seen.push(out));
    calls[0].resolve({ built: "pocket" });
    await settle();
    expect(calls).toHaveLength(2);
    const task = tasks.find(generateKey(step.id))!;
    expect(task.cancellable).toBe(true);
    tasks.cancel(task.id);
    await expect(run).rejects.toSatisfy(isCancelled);
    // Every call of the run has the one name it is called off by.
    expect(cancelled).toEqual([calls[1].tag]);
    expect(calls[0].tag).toBe(calls[1].tag);
    // Neither the fit nor anything else was asked for, and the plug was not published as failed.
    expect(calls).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(tasks.get()).toHaveLength(0);
  });

  it("called off while the plug is fitted, fails as cancelled", async () => {
    const { project: p, step } = project("vcarve");
    const run = makeOutput(p, step);
    calls[0].resolve({});
    await settle();
    calls[1].resolve({});
    await settle();
    tasks.cancel(tasks.find(generateKey(step.id))!.id);
    await expect(run).rejects.toSatisfy(isCancelled);
    expect(tasks.get()).toHaveLength(0);
  });

  it("is called off by a name of its own, apart from another step's", async () => {
    const a = project("pocket");
    const b = project("pocket");
    const first = makeOutput(a.project, a.step);
    const second = makeOutput(b.project, b.step);
    tasks.cancel(tasks.find(generateKey(a.step.id))!.id);
    await expect(first).rejects.toSatisfy(isCancelled);
    expect(tasks.find(generateKey(b.step.id))).not.toBeNull();
    calls[1].resolve({});
    expect((await second).errors).toEqual([]);
  });

  it("says why a part could not be made, once, and does not fit what is not there", async () => {
    const { project: p, step } = project("vcarve");
    const run = makeOutput(p, step);
    calls[0].reject(new Error("No V-bit is chosen.\nNo end mill is chosen."));
    await settle();
    calls[1].reject(new Error("No V-bit is chosen."));
    const out = await run;
    expect(out.errors).toEqual(["No V-bit is chosen.", "No end mill is chosen."]);
    expect(out.parts).toEqual({});
    expect(calls).toHaveLength(2);
    expect(tasks.get()).toHaveLength(0);
  });

  it("keeps the parts when the fit fails", async () => {
    const { project: p, step } = project("vcarve");
    const run = makeOutput(p, step);
    calls[0].resolve({});
    await settle();
    calls[1].resolve({});
    await settle();
    calls[2].reject(new Error("The maps do not match."));
    const out = await run;
    expect(out.fit).toBeNull();
    expect(out.fitErrors).toEqual(["The maps do not match."]);
    expect(Object.keys(out.parts)).toHaveLength(2);
  });
});

describe("making a step's files for whoever asks", () => {
  /** What is shown, and every change of it. */
  function screen(start: Output | null) {
    let shown = start;
    const changes: (Output | null)[] = [];
    return {
      current: () => shown,
      show: (out: Output | null) => {
        shown = out;
        changes.push(out);
      },
      changes,
    };
  }
  const made = (stepId: string, p: Project): Output => ({ stepId, project: p, parts: { pocket: {} as never, plug: {} as never }, errors: [], fit: null, fitErrors: [] });

  it("shows each part as it comes when nothing was made before", async () => {
    const { project: p, step } = project("flat");
    const s = screen(null);
    const run = remakeOutput(p, step, s.current, s.show);
    expect(tasks.find(generateKey(step.id))?.again).toBe(false);
    calls[0].resolve({});
    await settle();
    expect(s.changes).toHaveLength(1);
    expect(Object.keys(s.current()!.parts)).toEqual(["pocket"]);
    calls[1].resolve({});
    const out = await run;
    expect(Object.keys(s.current()!.parts)).toEqual(["pocket", "plug"]);
    expect(out.stepId).toBe(step.id);
  });

  it("keeps what was made last until all of the new is there", async () => {
    const { project: p, step } = project("flat");
    const old = made(step.id, p);
    const s = screen(old);
    const run = remakeOutput({ ...p }, step, s.current, s.show);
    expect(tasks.find(generateKey(step.id))?.again).toBe(true);
    calls[0].resolve({});
    await settle();
    // Nothing half made takes its place.
    expect(s.current()).toBe(old);
    expect(s.changes).toHaveLength(0);
    calls[1].resolve({});
    const out = await run;
    expect(s.changes).toEqual([out]);
    expect(s.current()).not.toBe(old);
  });

  it("called off the first time, shows again what was shown before", async () => {
    const { project: p, step } = project("flat");
    const other = made("another step", p);
    const s = screen(other);
    const run = remakeOutput(p, step, s.current, s.show);
    calls[0].resolve({});
    await settle();
    expect(s.current()!.stepId).toBe(step.id);
    tasks.cancel(tasks.find(generateKey(step.id))!.id);
    await expect(run).rejects.toSatisfy(isCancelled);
    expect(s.current()).toBe(other);
  });

  it("called off before any part came, changes nothing of what is shown", async () => {
    const { project: p, step } = project("flat");
    const other = made("another step", p);
    const s = screen(other);
    const run = remakeOutput(p, step, s.current, s.show);
    tasks.cancel(tasks.find(generateKey(step.id))!.id);
    await expect(run).rejects.toSatisfy(isCancelled);
    expect(s.changes).toHaveLength(0);
    expect(s.current()).toBe(other);
  });

  it("called off while made again, leaves what was made last", async () => {
    const { project: p, step } = project("flat");
    const old = made(step.id, p);
    const s = screen(old);
    const run = remakeOutput(p, step, s.current, s.show);
    calls[0].resolve({});
    await settle();
    tasks.cancel(tasks.find(generateKey(step.id))!.id);
    await expect(run).rejects.toSatisfy(isCancelled);
    expect(s.changes).toHaveLength(0);
    expect(s.current()).toBe(old);
  });

  it("called off, does not take back what another step has shown since", async () => {
    const { project: p, step } = project("flat");
    const s = screen(null);
    const run = remakeOutput(p, step, s.current, s.show);
    calls[0].resolve({});
    await settle();
    const newer = made("another step", p);
    s.show(newer);
    tasks.cancel(tasks.find(generateKey(step.id))!.id);
    await expect(run).rejects.toSatisfy(isCancelled);
    expect(s.current()).toBe(newer);
  });

  it("is the agent's when the agent asks", async () => {
    const { project: p, step } = project("pocket");
    const s = screen(null);
    const run = remakeOutput(p, step, s.current, s.show, "agent");
    expect(tasks.find(generateKey(step.id))?.by).toBe("agent");
    calls[0].resolve({});
    await run;
  });
});

describe("what the core says of the stock", () => {
  const names = ["Face", "Leaf", "Glue", "Trim"];

  it("counts the task in steps from where the list goes on", () => {
    const said = stockProgress(names);
    // The plugs come first: nothing is counted yet.
    expect(said({ stage: "plug", done: 1, total: 4 })).toEqual({ stage: 'The plug of "Leaf"', part: null });
    expect(said({ stage: "list", done: 0, total: 4 })).toEqual({ done: 0, total: 4, part: null, kept: 0, stage: "Face" });
    expect(said({ stage: "build", done: 0, total: 4 })).toEqual({ stage: 'The paths of "Face"', part: null });
    expect(said({ stage: "step", done: 0, total: 4 })).toEqual({ done: 0, total: 4, stage: "Face", part: null });
    expect(said({ stage: "step", done: 1, total: 4 })).toEqual({ done: 1, total: 4, stage: "Leaf", part: null });
    // The end: all done, and what was kept stays what it was.
    expect(said({ stage: "list", done: 4, total: 4 })).toEqual({ done: 4, total: 4, part: null });
  });

  it("takes the steps before where it goes on as kept", () => {
    const said = stockProgress(names);
    expect(said({ stage: "list", done: 2, total: 4 })).toMatchObject({ done: 2, kept: 2, stage: "Glue" });
    expect(said({ stage: "step", done: 3, total: 4 })).not.toHaveProperty("kept");
    // With nothing to do, all of it is kept.
    expect(stockProgress(names)({ stage: "list", done: 4, total: 4 })).toEqual({ done: 4, total: 4, part: null, kept: 4 });
  });

  it("moves the bar with the cutting of the stock at a step, and with no other", () => {
    const said = stockProgress(names);
    // Nothing said yet of what is cut.
    expect(said({ stage: "cut", done: 5, total: 10 })).toBeNull();
    // A plug on its own board: the bar would have to start anew for the stock.
    said({ stage: "plug", done: 1, total: 4 });
    expect(said({ stage: "cut", done: 5, total: 10 })).toBeNull();
    said({ stage: "list", done: 0, total: 4 });
    expect(said({ stage: "cut", done: 5, total: 10 })).toBeNull();
    said({ stage: "step", done: 0, total: 4 });
    expect(said({ stage: "cut", done: 1, total: 4 })).toEqual({ part: 0.25 });
    expect(said({ stage: "cut", done: 0, total: 0 })).toBeNull();
    // A kept file cut ahead on a copy, to measure the stock for a later facing: not the step in hand's.
    expect(said({ stage: "ahead", done: 1, total: 4 })).toEqual({ stage: 'Measuring the stock after "Leaf"', part: null });
    expect(said({ stage: "cut", done: 5, total: 10 })).toBeNull();
    said({ stage: "build", done: 2, total: 4 });
    expect(said({ stage: "cut", done: 5, total: 10 })).toBeNull();
    said({ stage: "step", done: 1, total: 4 });
    expect(said({ stage: "cut", done: 5, total: 10 })).toEqual({ part: 0.5 });
  });

  it("never lets the count or the bar run backwards through a whole list, as the core says it", () => {
    // Two plugs, then a stretch of two files built before either is cut, one cut ahead; a step by hand; a last stretch.
    const words: CoreProgress[] = [
      { stage: "plug", done: 1, total: 4 }, { stage: "paths", done: 0, total: 0 }, { stage: "cut", done: 0, total: 9 }, { stage: "cut", done: 8, total: 9 },
      { stage: "list", done: 0, total: 4 },
      { stage: "build", done: 0, total: 4 }, { stage: "paths", done: 0, total: 0 }, { stage: "write", done: 0, total: 0 },
      { stage: "ahead", done: 0, total: 4 }, { stage: "cut", done: 0, total: 5 }, { stage: "cut", done: 4, total: 5 },
      { stage: "build", done: 1, total: 4 },
      { stage: "step", done: 0, total: 4 }, { stage: "cut", done: 0, total: 5 }, { stage: "cut", done: 4, total: 5 },
      { stage: "step", done: 1, total: 4 }, { stage: "cut", done: 0, total: 7 }, { stage: "cut", done: 6, total: 7 },
      { stage: "step", done: 2, total: 4 },
      { stage: "build", done: 3, total: 4 },
      { stage: "step", done: 3, total: 4 }, { stage: "cut", done: 0, total: 3 }, { stage: "cut", done: 2, total: 3 },
      { stage: "list", done: 4, total: 4 },
    ];
    const said = stockProgress(names);
    const task = tasks.start({ key: "t", label: "Cutting the stock" });
    let before = -1;
    for (const word of words) {
      const change = said(word);
      if (change) task.update(change);
      const now = tasks.find("t")!;
      const far = now.total === null ? 0 : now.done + (now.part ?? 0);
      // A new step starts its own bar at nothing; what is finished never becomes less.
      expect(now.done).toBeGreaterThanOrEqual(Math.floor(Math.max(0, before)));
      expect(far).toBeGreaterThanOrEqual(Math.floor(Math.max(0, before)));
      if (now.part !== null) expect(far).toBeGreaterThanOrEqual(before);
      before = far;
    }
    expect(tasks.find("t")).toMatchObject({ done: 4, total: 4, kept: 0 });
    task.end();
  });

  it("leaves the stages of a file inside the list unsaid, and names a step it does not know", () => {
    const said = stockProgress(names);
    expect(said({ stage: "paths", done: 0, total: 0 })).toBeNull();
    expect(said({ stage: "write", done: 0, total: 0 })).toBeNull();
    expect(said({ stage: "fit", done: 0, total: 0 })).toBeNull();
    expect(said({ stage: "step", done: 9, total: 10 })).toMatchObject({ stage: "?" });
  });

  it("is shown step by step: kept, done, the one in hand, and those to come", () => {
    const base = { id: 1, key: STOCK, label: "", stage: null, unit: "step", started: 0, shown: true, by: "user", place: "inline", cover: false, heavy: true, stoppable: false, view: null, cancellable: false, again: false, stopping: false } as const;
    // Before it says where it is, all are to come.
    expect(stockRows(names, { ...base, done: 0, total: null, part: null, kept: 0 }).map((r) => r.state)).toEqual(["wait", "wait", "wait", "wait"]);
    // A list that is not this one any more: nothing is said of these steps.
    expect(stockRows(names, { ...base, done: 2, total: 6, part: null, kept: 0 }).map((r) => r.state)).toEqual(["wait", "wait", "wait", "wait"]);
    // All of it done.
    expect(stockRows(names, { ...base, done: 4, total: 4, part: null, kept: 2 }).map((r) => r.state)).toEqual(["kept", "kept", "done", "done"]);
    expect(stockRows(names, null).map((r) => r.state)).toEqual(["wait", "wait", "wait", "wait"]);
    const rows = stockRows(names, { ...base, done: 2, total: 4, part: 0.618, kept: 1 });
    expect(rows).toEqual([
      { name: "Face", state: "kept", percent: null },
      { name: "Leaf", state: "done", percent: null },
      { name: "Glue", state: "now", percent: 62 },
      { name: "Trim", state: "wait", percent: null },
    ]);
    // The one in hand with nothing known of how far it is.
    expect(stockRows(names, { ...base, done: 0, total: 4, part: null, kept: 0 })[0]).toEqual({ name: "Face", state: "now", percent: null });
  });
});

describe("what the core says of a file", () => {
  it("names its stages, and how far its board is cut", () => {
    const said = fileProgress();
    expect(said({ stage: "paths", done: 0, total: 0 })).toEqual({ stage: "Working out the paths", part: null });
    expect(said({ stage: "write", done: 0, total: 0 })).toEqual({ stage: "Writing the G-code", part: null });
    expect(said({ stage: "cut", done: 3, total: 4 })).toEqual({ stage: "Cutting the board with it", part: 0.75 });
    expect(said({ stage: "cut", done: 0, total: 0 })).toBeNull();
    expect(said({ stage: "fit", done: 0, total: 0 })).toEqual({ stage: "Holding the two together", part: null });
  });

  it("says one thing of the list taken through for it, and then goes on with the file itself", () => {
    const said = fileProgress();
    const list = { stage: "Taking the stock through the list", part: null };
    expect(said({ stage: "plug", done: 0, total: 3 })).toEqual(list);
    // The files made and cut inside the list are not this one.
    expect(said({ stage: "paths", done: 0, total: 0 })).toBeNull();
    expect(said({ stage: "cut", done: 3, total: 4 })).toBeNull();
    expect(said({ stage: "list", done: 1, total: 3 })).toEqual(list);
    expect(said({ stage: "build", done: 1, total: 3 })).toEqual(list);
    expect(said({ stage: "ahead", done: 1, total: 3 })).toEqual(list);
    expect(said({ stage: "step", done: 1, total: 3 })).toEqual(list);
    expect(said({ stage: "write", done: 0, total: 0 })).toBeNull();
    expect(said({ stage: "fit", done: 0, total: 0 })).toBeNull();
    // The list is through.
    expect(said({ stage: "list", done: 3, total: 3 })).toBeNull();
    expect(said({ stage: "paths", done: 0, total: 0 })).toEqual({ stage: "Working out the paths", part: null });
    expect(said({ stage: "cut", done: 1, total: 4 })).toEqual({ stage: "Cutting the board with it", part: 0.25 });
  });
});

describe("the files of the export tab", () => {
  const built = (name: string) => ({ fileName: name }) as Built;

  it("are one task, counted as they come, that ends with the last", async () => {
    const waits: ((b: Built) => void)[] = [];
    const join = createFileRuns(() => new Promise<Built>((resolve) => waits.push(resolve)));
    const { project: p } = project("flat");
    const a = join(p, ["1"]);
    const b = join(p, ["2"]);
    const c = join(p, ["3"]);
    expect(tasks.get().filter((t) => t.key === FILES)).toHaveLength(1);
    expect(tasks.find(FILES)).toMatchObject({ label: "Making the files", total: 3, done: 0, unit: "file" });
    waits[0](built("a"));
    expect((await a).fileName).toBe("a");
    expect(tasks.find(FILES)).toMatchObject({ total: 3, done: 1 });
    waits[1](built("b"));
    await b;
    expect(tasks.find(FILES)).toMatchObject({ done: 2 });
    waits[2](built("c"));
    await c;
    expect(tasks.find(FILES)).toBeNull();
  });

  it("end their task when a join throws before it has begun", async () => {
    const join = createFileRuns(() => {
      throw new Error("No such step.");
    });
    const { project: p } = project("flat");
    await expect(join(p, ["1"])).rejects.toThrow("No such step.");
    expect(tasks.find(FILES)).toBeNull();
  });

  it("start a new count after the last one ended, and count a file that failed", async () => {
    const ends: { resolve: (b: Built) => void; reject: (e: Error) => void }[] = [];
    const join = createFileRuns(() => new Promise<Built>((resolve, reject) => ends.push({ resolve, reject })));
    const { project: p } = project("flat");
    const a = join(p, ["1"]);
    const b = join(p, ["2"]);
    ends[0].reject(new Error("Cannot be joined."));
    await expect(a).rejects.toThrow("Cannot be joined.");
    expect(tasks.find(FILES)).toMatchObject({ total: 2, done: 1 });
    ends[1].resolve(built("b"));
    await b;
    expect(tasks.find(FILES)).toBeNull();

    const c = join(p, ["3"]);
    expect(tasks.find(FILES)).toMatchObject({ total: 1, done: 0 });
    ends[2].resolve(built("c"));
    await c;
    expect(tasks.find(FILES)).toBeNull();
  });
});
