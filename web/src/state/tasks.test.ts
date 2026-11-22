import { describe, expect, it } from "vitest";
import { SHOW_AFTER, countText, createTasks, elapsedText, fraction, headline, inTurn, pieces, spoken, type Task } from "./tasks";

/** A list with a clock and a timer that only move when told to. */
function setup() {
  let now = 1000;
  let waiting: { at: number; fn: () => void }[] = [];
  const list = createTasks({
    now: () => now,
    later: (fn, ms) => {
      const entry = { at: now + ms, fn };
      waiting.push(entry);
      return () => {
        waiting = waiting.filter((w) => w !== entry);
      };
    },
  });
  const pass = (ms: number) => {
    now += ms;
    const due = waiting.filter((w) => w.at <= now);
    waiting = waiting.filter((w) => w.at > now);
    for (const w of due) w.fn();
  };
  return { list, pass, clock: () => now, pending: () => waiting.length };
}

const task = (over: Partial<Task>): Task => ({
  id: 1,
  key: "k",
  label: "Cutting the stock",
  stage: null,
  done: 0,
  total: null,
  part: null,
  kept: 0,
  unit: null,
  started: 0,
  shown: true,
  by: "user",
  place: "inline",
  cover: false,
  heavy: false,
  stoppable: false,
  view: null,
  stopping: false,
  ...over,
});

describe("the list of tasks", () => {
  it("shows nothing for work that is quick", () => {
    const { list, pass, pending } = setup();
    const quick = list.start({ key: "open", label: "Opening" });
    expect(list.get()).toHaveLength(1);
    expect(list.get()[0].shown).toBe(false);
    pass(SHOW_AFTER - 1);
    expect(list.get()[0].shown).toBe(false);
    quick.end();
    expect(list.get()).toHaveLength(0);
    // Its timer went with it.
    expect(pending()).toBe(0);
    pass(SHOW_AFTER);
    expect(list.get()).toHaveLength(0);
  });

  it("shows work that goes on", () => {
    const { list, pass } = setup();
    list.start({ key: "stock", label: "Cutting the stock" });
    pass(SHOW_AFTER);
    expect(list.get()[0].shown).toBe(true);
  });

  it("tells its listeners of every change, and not after they leave", () => {
    const { list } = setup();
    let told = 0;
    const leave = list.subscribe(() => told++);
    const t = list.start({ key: "a", label: "A", total: 3 });
    t.update({ done: 1 });
    t.end();
    expect(told).toBe(3);
    leave();
    list.start({ key: "b", label: "B" });
    expect(told).toBe(3);
  });

  it("gives a new list for every change, so that a snapshot stays what it was", () => {
    const { list } = setup();
    const t = list.start({ key: "a", label: "A", total: 2 });
    const before = list.get();
    t.update({ done: 1 });
    expect(before[0].done).toBe(0);
    expect(list.get()[0].done).toBe(1);
    expect(list.get()).not.toBe(before);
  });

  it("does not run backwards or past its end", () => {
    const { list } = setup();
    const t = list.start({ key: "a", label: "A", total: 3 });
    t.update({ done: 2 });
    t.update({ done: 1 });
    expect(list.get()[0].done).toBe(2);
    t.update({ done: 9 });
    expect(list.get()[0].done).toBe(3);
  });

  it("knows how far the part in hand is, until the next part starts", () => {
    const { list } = setup();
    const t = list.start({ key: "a", label: "A", total: 3 });
    expect(list.get()[0].part).toBeNull();
    t.update({ part: 0.4 });
    expect(list.get()[0].part).toBe(0.4);
    // Another word that says nothing of it leaves it.
    t.update({ stage: "Cutting" });
    expect(list.get()[0].part).toBe(0.4);
    // It can start anew within a part.
    t.update({ part: 0.1 });
    expect(list.get()[0].part).toBe(0.1);
    t.update({ done: 1 });
    expect(list.get()[0].part).toBeNull();
    t.update({ done: 2, part: 0.5 });
    expect(list.get()[0].part).toBe(0.5);
    t.update({ part: null });
    expect(list.get()[0].part).toBeNull();
  });

  it("keeps how far a part is between nothing and all of it", () => {
    const { list } = setup();
    const t = list.start({ key: "a", label: "A" });
    t.update({ part: 1.7 });
    expect(list.get()[0].part).toBe(1);
    t.update({ part: -2 });
    expect(list.get()[0].part).toBe(0);
    t.update({ part: Number.NaN });
    expect(list.get()[0].part).toBeNull();
  });

  it("counts what was kept from before among what is finished, and no more than that", () => {
    const { list } = setup();
    const t = list.start({ key: "a", label: "A", total: 6 });
    t.update({ done: 3, kept: 3 });
    expect(list.get()[0]).toMatchObject({ done: 3, kept: 3 });
    t.update({ done: 4 });
    expect(list.get()[0]).toMatchObject({ done: 4, kept: 3 });
    t.update({ kept: 9 });
    expect(list.get()[0].kept).toBe(4);
  });

  it("takes a total of nothing as no count", () => {
    const { list } = setup();
    const t = list.start({ key: "a", label: "A", total: 0 });
    expect(list.get()[0].total).toBeNull();
    t.update({ total: 4, done: 1 });
    expect(list.get()[0].total).toBe(4);
    t.update({ total: 0 });
    expect(list.get()[0].total).toBeNull();
  });

  it("keeps the stage until it is changed, and clears it when told to", () => {
    const { list } = setup();
    const t = list.start({ key: "a", label: "A", stage: "one" });
    t.update({ label: "B" });
    expect(list.get()[0]).toMatchObject({ label: "B", stage: "one" });
    t.update({ stage: null });
    expect(list.get()[0].stage).toBeNull();
  });

  it("leaves a task that has ended alone", () => {
    const { list } = setup();
    const t = list.start({ key: "a", label: "A" });
    t.end();
    t.update({ label: "B" });
    t.end();
    list.stop(t.id);
    expect(list.get()).toHaveLength(0);
    expect(t.stopped()).toBe(false);
  });

  it("asks only a task that can stop to stop", () => {
    const { list } = setup();
    const fixed = list.start({ key: "a", label: "A" });
    const loop = list.start({ key: "b", label: "B", stoppable: true });
    list.stop(fixed.id);
    list.stop(loop.id);
    expect(fixed.stopped()).toBe(false);
    expect(loop.stopped()).toBe(true);
    expect(list.find("b")?.stopping).toBe(true);
  });

  it("ends a task with its work, also when the work fails", async () => {
    const { list } = setup();
    expect(await list.run({ key: "a", label: "A" }, async () => 7)).toBe(7);
    expect(list.get()).toHaveLength(0);
    await expect(
      list.run({ key: "a", label: "A" }, async () => {
        expect(list.find("a")).not.toBeNull();
        throw new Error("no");
      }),
    ).rejects.toThrow("no");
    expect(list.get()).toHaveLength(0);
  });

  it("does the same work once for all who ask while it goes on", async () => {
    const { list } = setup();
    const project = {};
    let runs = 0;
    let finish: (v: string) => void = () => {};
    const work = () => {
      runs++;
      return new Promise<string>((resolve) => (finish = resolve));
    };
    const a = list.once("stock", project, work);
    const b = list.once("stock", project, work);
    expect(runs).toBe(1);
    finish("made");
    expect(await a).toBe("made");
    expect(await b).toBe("made");
    // Asked again once it is over, it is done again.
    void list.once("stock", project, work);
    expect(runs).toBe(2);
  });

  it("starts other work for another project, and keeps the newer one joinable", async () => {
    const { list } = setup();
    const ends: (() => void)[] = [];
    let runs = 0;
    const work = () => {
      runs++;
      return new Promise<void>((resolve) => ends.push(resolve));
    };
    const first = {};
    const second = {};
    const a = list.once("stock", first, work);
    void list.once("stock", second, work);
    expect(runs).toBe(2);
    // The first ending does not forget the second.
    ends[0]();
    await a;
    void list.once("stock", second, work);
    expect(runs).toBe(2);
  });

  it("lets a failure reach everyone who joined, and forgets it", async () => {
    const { list } = setup();
    const project = {};
    let runs = 0;
    const work = async () => {
      runs++;
      throw new Error("could not");
    };
    const a = list.once("stock", project, work);
    const b = list.once("stock", project, work);
    await expect(a).rejects.toThrow("could not");
    await expect(b).rejects.toThrow("could not");
    await expect(list.once("stock", project, work)).rejects.toThrow("could not");
    expect(runs).toBe(2);
  });

  it("keeps what the user starts the user's while an agent's command goes on", async () => {
    const { list } = setup();
    let finish: () => void = () => {};
    const command = list.run({ key: "agent", label: "Take the stock through the list", by: "agent", cover: true }, () => new Promise<void>((resolve) => (finish = resolve)));
    list.start({ key: "generate", label: "Working out the pocket" });
    list.start({ key: "stock", label: "Cutting the stock", by: "agent" });
    expect(list.find("agent")?.by).toBe("agent");
    expect(list.find("generate")?.by).toBe("user");
    expect(list.find("stock")?.by).toBe("agent");
    finish();
    await command;
    list.start({ key: "later", label: "Later" });
    expect(list.find("later")?.by).toBe("user");
  });
});

describe("doing something to several things in turn", () => {
  it("does each, saying which is in hand and how many are done", async () => {
    const { list } = setup();
    const t = list.start({ key: "projects", label: "Moving", total: 3 });
    const seen: string[] = [];
    const result = await inTurn(t, ["a", "b", "c"], (x) => x.toUpperCase(), async (x) => {
      seen.push(`${x}:${list.get()[0].done}:${list.get()[0].stage}`);
    });
    expect(result).toEqual({ done: 3 });
    expect(seen).toEqual(["a:0:A", "b:1:B", "c:2:C"]);
    expect(list.get()[0].done).toBe(3);
  });

  it("stops after the one in hand when asked to", async () => {
    const { list } = setup();
    const t = list.start({ key: "projects", label: "Moving", total: 3, stoppable: true });
    const done: string[] = [];
    const result = await inTurn(t, ["a", "b", "c"], () => null, async (x) => {
      done.push(x);
      if (x === "b") list.stop(t.id);
    });
    expect(done).toEqual(["a", "b"]);
    expect(result).toEqual({ done: 2 });
  });

  it("does nothing once it was asked to stop before it began", async () => {
    const { list } = setup();
    const t = list.start({ key: "projects", label: "Moving", total: 2, stoppable: true });
    list.stop(t.id);
    let ran = 0;
    expect(await inTurn(t, [1, 2], () => null, async () => void ran++)).toEqual({ done: 0 });
    expect(ran).toBe(0);
  });

  it("gives what failed and how many were done before it, and goes no further", async () => {
    const { list } = setup();
    const t = list.start({ key: "projects", label: "Deleting", total: 3 });
    const tried: number[] = [];
    const result = await inTurn(t, [1, 2, 3], () => null, async (x) => {
      tried.push(x);
      if (x === 2) throw new Error("The server said no.");
    });
    expect(tried).toEqual([1, 2]);
    expect(result.done).toBe(1);
    expect((result.error as Error).message).toBe("The server said no.");
  });

  it("is done at once with nothing to do", async () => {
    const { list } = setup();
    const t = list.start({ key: "projects", label: "Moving" });
    expect(await inTurn(t, [], () => null, async () => {})).toEqual({ done: 0 });
  });
});

describe("what is said of a task", () => {
  it("counts the part in hand, and stops at the last", () => {
    expect(countText(task({ total: null }))).toBe("");
    expect(countText(task({ total: 3, done: 0 }))).toBe("1 of 3");
    expect(countText(task({ total: 3, done: 2, unit: "step" }))).toBe("step 3 of 3");
    expect(countText(task({ total: 3, done: 3 }))).toBe("3 of 3");
    // One part is not counted.
    expect(countText(task({ total: 1 }))).toBe("");
  });

  it("gives how much is finished", () => {
    expect(fraction(task({ total: null }))).toBeNull();
    expect(fraction(task({ total: 4, done: 1 }))).toBe(0.25);
    expect(fraction(task({ total: 4, done: 4 }))).toBe(1);
    // With how far the part in hand is.
    expect(fraction(task({ total: 4, done: 1, part: 0.5 }))).toBe(0.375);
    expect(fraction(task({ total: 4, done: 4, part: 0.5 }))).toBe(1);
    // Of work with no count of parts, what is known of the one there is.
    expect(fraction(task({ total: null, part: 0.3 }))).toBe(0.3);
  });

  it("draws a few parts as pieces, and many or one as one bar", () => {
    expect(pieces(task({ total: 3, done: 1 }))).toEqual(["done", "now", "todo"]);
    expect(pieces(task({ total: 3, done: 3 }))).toEqual(["done", "done", "done"]);
    // One part goes on until it is done: never an empty bar that does not move.
    expect(pieces(task({ total: 1 }))).toEqual(["now"]);
    expect(pieces(task({ total: 12 }))).toBeNull();
    expect(pieces(task({ total: null }))).toBeNull();
  });

  it("says the time once it is worth saying", () => {
    const t = task({ started: 1000 });
    expect(elapsedText(t, 1000 + 4999)).toBe("");
    expect(elapsedText(t, 1000 + 5000)).toBe("5 s");
    expect(elapsedText(t, 1000 + 59_900)).toBe("59 s");
    expect(elapsedText(t, 1000 + 65_000)).toBe("1 min 5 s");
  });
});

describe("the header", () => {
  it("says nothing when nothing is shown", () => {
    expect(headline([])).toBeNull();
    expect(headline([task({ shown: false })])).toBeNull();
  });

  it("names one task, with its count", () => {
    expect(headline([task({ label: "Moving to Coasters", total: 12, done: 4 })])?.text).toBe("Moving to Coasters · 5 of 12");
    expect(headline([task({})])?.text).toBe("Cutting the stock");
    expect(headline([task({ label: "Working out the pocket", total: 1 })])?.text).toBe("Working out the pocket");
  });

  it("counts several", () => {
    const said = headline([task({ id: 1 }), task({ id: 2 })]);
    expect(said?.text).toBe("2 tasks");
    expect(said?.task).toBeNull();
  });

  it("says when the work is an agent's", () => {
    expect(headline([task({ by: "agent" })])?.text).toBe("Agent · Cutting the stock");
    expect(headline([task({ id: 1, by: "agent" }), task({ id: 2, by: "user" })])?.text).toBe("2 tasks");
  });

  it("leaves out a task that only stands for the one inside it", () => {
    const cover = task({ id: 1, cover: true, label: "Take the stock through the list", by: "agent" });
    const inner = task({ id: 2, by: "agent" });
    expect(spoken([cover, inner])).toEqual([inner]);
    expect(headline([cover, inner])?.text).toBe("Agent · Cutting the stock");
    // Alone, it is what there is to say.
    expect(headline([cover])?.text).toBe("Agent · Take the stock through the list");
    // One that is not shown yet does not hide it.
    expect(headline([cover, { ...inner, shown: false }])?.text).toBe("Agent · Take the stock through the list");
  });
});
