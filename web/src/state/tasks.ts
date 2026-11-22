// The work the app is busy with, as one list: what is being done, how far it
// is, and who asked for it. Whatever takes time starts a task here and ends
// it; the page shows a task where its result will land, and names it in the
// header from every tab.
//
// Nothing here needs a window: the clock and the timer are handed in.

export type Actor = "user" | "agent";

export interface Task {
  id: number;
  /** What kind of work it is, to find it by: "stock", "generate:<step>", "projects". */
  key: string;
  /** What is being done, without a full stop: "Working out the pocket". */
  label: string;
  /** What of it is in hand, when there is more to say: the step, the file. */
  stage: string | null;
  /** How many of its parts are finished. */
  done: number;
  /** How many parts there are. Null when they cannot be counted. */
  total: number | null;
  /** What a part is called in the count: "step" gives "step 2 of 3". */
  unit: string | null;
  /** When it started, by the clock handed in. */
  started: number;
  /** False for the first moments: quick work shows nothing. */
  shown: boolean;
  by: Actor;
  /** Where it shows besides the header: where its result lands, or the bar under the header. */
  place: "inline" | "notice";
  /** Stands for whatever goes on inside it: left out of the header while another task is running. */
  cover: boolean;
  /** Keeps the core busy, so that quick calls to it wait. */
  heavy: boolean;
  /** Whether it can be asked to stop after the part in hand. */
  stoppable: boolean;
  /** The view its result lands in, for the header to lead there. */
  view: "projects" | "design" | null;
  /** It was asked to stop, and has not yet. */
  stopping: boolean;
}

export interface TaskStart {
  key: string;
  label: string;
  stage?: string | null;
  total?: number | null;
  unit?: string | null;
  place?: Task["place"];
  cover?: boolean;
  heavy?: boolean;
  stoppable?: boolean;
  view?: Task["view"];
  /** Who asked for it: the user, unless said. */
  by?: Actor;
}

export interface TaskHandle {
  readonly id: number;
  update(change: Partial<Pick<Task, "label" | "stage" | "done" | "total">>): void;
  /** Whether the user asked for it to stop. */
  stopped(): boolean;
  end(): void;
}

/** How long work goes on before anything is shown for it, ms. */
export const SHOW_AFTER = 400;
/** How long before the time it has taken is shown, ms. */
export const TIME_AFTER = 5000;
/** The most parts a bar is drawn in pieces for. */
export const MOST_PIECES = 6;

export interface TaskDeps {
  now(): number;
  /** Calls `fn` after `ms`; what it returns calls it off. */
  later(fn: () => void, ms: number): () => void;
}

export function createTasks(deps: TaskDeps) {
  let list: readonly Task[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const timers = new Map<number, () => void>();
  const joined = new Map<string, { token: unknown; promise: Promise<unknown> }>();

  const set = (next: readonly Task[]) => {
    list = next;
    for (const listener of [...listeners]) listener();
  };
  const change = (id: number, with_: Partial<Task>) => {
    if (!list.some((t) => t.id === id)) return;
    set(list.map((t) => (t.id === id ? { ...t, ...with_ } : t)));
  };

  function start(init: TaskStart): TaskHandle {
    const id = nextId++;
    const total = init.total ?? null;
    const task: Task = {
      id,
      key: init.key,
      label: init.label,
      stage: init.stage ?? null,
      done: 0,
      total: total !== null && total > 0 ? total : null,
      unit: init.unit ?? null,
      started: deps.now(),
      shown: false,
      by: init.by ?? "user",
      place: init.place ?? "inline",
      cover: init.cover ?? false,
      heavy: init.heavy ?? false,
      stoppable: init.stoppable ?? false,
      view: init.view ?? null,
      stopping: false,
    };
    set([...list, task]);
    timers.set(
      id,
      deps.later(() => {
        timers.delete(id);
        change(id, { shown: true });
      }, SHOW_AFTER),
    );
    return {
      id,
      update(next) {
        const now = list.find((t) => t.id === id);
        if (!now) return;
        const total = next.total === undefined ? now.total : next.total !== null && next.total > 0 ? next.total : null;
        // Progress does not run backwards, nor past its end.
        const done = Math.max(now.done, Math.min(next.done ?? now.done, total ?? Infinity));
        change(id, { label: next.label ?? now.label, stage: next.stage === undefined ? now.stage : next.stage, total, done });
      },
      stopped: () => list.find((t) => t.id === id)?.stopping ?? false,
      end() {
        timers.get(id)?.();
        timers.delete(id);
        if (list.some((t) => t.id === id)) set(list.filter((t) => t.id !== id));
      },
    };
  }

  return {
    get: () => list,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    /** The task of a kind that is running, the first of them. */
    find: (key: string): Task | null => list.find((t) => t.key === key) ?? null,
    /** Asks a task to stop after the part it has in hand. */
    stop(id: number) {
      const task = list.find((t) => t.id === id);
      if (task && task.stoppable && !task.stopping) change(id, { stopping: true });
    },
    /** Does `work` as a task, which ends with it however it ends. */
    async run<T>(init: TaskStart, work: (task: TaskHandle) => Promise<T>): Promise<T> {
      const task = start(init);
      try {
        return await work(task);
      } finally {
        task.end();
      }
    },
    /**
     * Does `work` once for everyone who asks for the same thing while it is
     * going on: a second asking with the same `key` and `token` joins the
     * first. Another token means other work, and starts it.
     */
    once<T>(key: string, token: unknown, work: () => Promise<T>): Promise<T> {
      const going = joined.get(key);
      if (going && going.token === token) return going.promise as Promise<T>;
      const promise = work().finally(() => {
        if (joined.get(key)?.promise === promise) joined.delete(key);
      });
      joined.set(key, { token, promise });
      return promise;
    },
  };
}

export type Tasks = ReturnType<typeof createTasks>;

/**
 * Does `work` for each of `items` in turn as the parts of a task, saying
 * which one is in hand, until all are done, the task is asked to stop, or
 * one fails. Gives how many were done, and what failed if anything did: the
 * ones before it stay done.
 */
export async function inTurn<T>(task: TaskHandle, items: readonly T[], name: (item: T) => string | null, work: (item: T) => Promise<unknown>): Promise<{ done: number; error?: unknown }> {
  let done = 0;
  for (const item of items) {
    if (task.stopped()) break;
    task.update({ done, stage: name(item) });
    try {
      await work(item);
    } catch (error) {
      return { done, error };
    }
    done++;
  }
  task.update({ done });
  return { done };
}

/** The app's own list. */
export const tasks = createTasks({
  now: () => Date.now(),
  later: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
});

/** Where a task is, in words: "step 2 of 3", "4 of 12". Empty when its parts cannot be counted. */
export function countText(task: Task): string {
  // One part is not worth counting.
  if (task.total === null || task.total < 2) return "";
  return `${task.unit ? `${task.unit} ` : ""}${Math.min(task.done + 1, task.total)} of ${task.total}`;
}

/** How much of it is finished, 0 to 1. Null when its parts cannot be counted. */
export function fraction(task: Task): number | null {
  return task.total === null ? null : Math.min(1, task.done / task.total);
}

/**
 * The bar in pieces, one for each part, when there are few of them: the part
 * in hand has no count of its own, so it is drawn as going on. Null when the
 * bar is one piece. A task of one part is one piece that goes on.
 */
export function pieces(task: Task): ("done" | "now" | "todo")[] | null {
  if (task.total === null || task.total > MOST_PIECES) return null;
  return Array.from({ length: task.total }, (_, i) => (i < task.done ? "done" : i === task.done ? "now" : "todo"));
}

/** How long it has been going on, once that is worth saying: "12 s", "1 min 5 s". */
export function elapsedText(task: Task, now: number): string {
  const ms = now - task.started;
  if (ms < TIME_AFTER) return "";
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** The tasks the header speaks of: those that are shown, without the ones that only stand for another. */
export function spoken(list: readonly Task[]): Task[] {
  const shown = list.filter((t) => t.shown);
  const own = shown.filter((t) => !t.cover);
  return own.length > 0 ? own : shown;
}

/** What the header says is going on: one task by its name and count, several by their number. Null when nothing is. */
export function headline(list: readonly Task[]): { text: string; task: Task | null } | null {
  const said = spoken(list);
  if (said.length === 0) return null;
  const agent = said.every((t) => t.by === "agent") ? "Agent · " : "";
  if (said.length > 1) return { text: `${agent}${said.length} tasks`, task: null };
  const [task] = said;
  const count = countText(task);
  return { text: `${agent}${task.label}${count ? ` · ${count}` : ""}`, task };
}
