// The long work of the core as tasks: what the list of tasks says while each
// goes on, with a core that answers when the test lets it.

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The calls the core was given, each waiting for the test to answer it. */
const calls: { method: string; args: unknown[]; resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];

vi.mock("../core/client", () => ({
  core: {
    call: (method: string, ...args: unknown[]) => new Promise((resolve, reject) => calls.push({ method, args, resolve, reject })),
  },
}));

import type { Built, Project } from "../core/types";
import { newProject, newStep } from "./model";
import type { Output } from "./store";
import { tasks } from "./tasks";
import { FILES, STOCK, createFileRuns, generateKey, makeOutput, stockOf } from "./work";

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
    calls[0].resolve({ built: "pocket" });
    await settle();
    expect(now()).toMatchObject({ label: "Working out the plug", done: 1, total: 3 });
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
