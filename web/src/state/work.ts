// The long work of the core, each kind done in one place: whoever asks for it,
// a button, a tab, a right click or an agent, it is one task, shown as one,
// and the same work asked for twice while it goes on is done once.

import { isCancelled } from "../core/calls";
import { core } from "../core/client";
import type { CoreProgress } from "../core/protocol";
import type { Built, Project, Step, StockTimeline } from "../core/types";
import { partName, partsOf } from "./model";
import type { Output } from "./store";
import { tasks, type Actor, type Task, type TaskHandle } from "./tasks";

/** The key of the task that takes the stock through the list. */
export const STOCK = "stock";
/** The key of the task that makes the files the ticks of the export tab come to. */
export const FILES = "files";
/** The key of the task that makes one step's G-code from its menu. */
export const GCODE = "gcode";
/** The key of the task that makes a step's parts and fits them. */
export const generateKey = (stepId: string) => `generate:${stepId}`;

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

export { isCancelled };

/** The project whose stock was last called off, until its stock is asked for again. */
let calledOff: Project | null = null;

/**
 * Whether the taking of this project's stock through its list was called
 * off, and not asked for again since. Whoever shows the stock says so, and
 * does not start it again unasked, whichever of them had asked for it.
 */
export const stockCalledOff = (project: Project): boolean => calledOff === project;

let runs = 0;
/** A name for one run of some work, to call its calls to the core off by. */
const runTag = (kind: string) => `${kind} ${++runs}`;

type Change = Parameters<TaskHandle["update"]>[0];

/**
 * What the core's words say of the stock being taken through a list of
 * steps called `names`, as changes to its task. The task is counted in the
 * steps of the list from where the core says it goes on: the steps before
 * are kept from the last time. Only the cutting of the stock at a step moves
 * the bar: a plug cut on its own board, and a file cut ahead on a copy to
 * measure the stock for a later step, do not.
 */
export function stockProgress(names: string[]) {
  /** Whether the cutting that is going on is of the stock, at the step in hand. */
  let ofStock = false;
  let begun = false;
  const name = (at: number) => names[at] ?? "?";
  return (p: CoreProgress): Change | null => {
    switch (p.stage) {
      case "list": {
        ofStock = false;
        // Where it goes on from says what was kept; at the end, all is done.
        const kept = begun ? {} : { kept: p.done };
        begun = true;
        return { done: p.done, total: p.total, part: null, ...kept, ...(p.done < p.total ? { stage: name(p.done) } : {}) };
      }
      case "plug":
        ofStock = false;
        return { stage: `The plug of "${name(p.done)}"`, part: null };
      case "build":
        ofStock = false;
        return { stage: `The paths of "${name(p.done)}"`, part: null };
      case "ahead":
        ofStock = false;
        return { stage: `Measuring the stock after "${name(p.done)}"`, part: null };
      case "step":
        ofStock = true;
        return { done: p.done, total: p.total, stage: name(p.done), part: null };
      case "cut":
        return ofStock && p.total > 0 ? { part: p.done / p.total } : null;
      default:
        return null;
    }
  };
}

/**
 * What the core's words say of one file being made and its board cut with
 * it, as changes to the task of the part it is for. For a facing that starts
 * where the wood stands on the stock, the stock is first taken through the
 * list: that is said as one thing, whatever files are made and cut in it.
 */
export function fileProgress() {
  let inList = false;
  return (p: CoreProgress): Change | null => {
    switch (p.stage) {
      case "list":
      case "plug":
      case "build":
      case "ahead":
      case "step":
        // The end of the list: what follows is the file itself.
        inList = !(p.stage === "list" && p.done >= p.total);
        return inList ? { stage: "Taking the stock through the list", part: null } : null;
      case "paths":
        return inList ? null : { stage: "Working out the paths", part: null };
      case "write":
        return inList ? null : { stage: "Writing the G-code", part: null };
      case "cut":
        return inList || p.total <= 0 ? null : { stage: "Cutting the board with it", part: p.done / p.total };
      case "fit":
        return inList ? null : { stage: "Holding the two together", part: null };
    }
  };
}

/** A step of the list as the stock is taken through it: kept from the last time, done now, the one in hand, or still to come. */
export interface StockRow {
  name: string;
  state: "kept" | "done" | "now" | "wait";
  /** Of the one in hand: how far its cutting is, in percent, when that is known. */
  percent: number | null;
}

/**
 * The steps called `names` as the task that takes the stock through them has
 * them. All still to come before it says where it is, and when the list it
 * counts is not this one: the project has changed since it started.
 */
export function stockRows(names: string[], task: Task | null): StockRow[] {
  const counted = task !== null && task.total === names.length;
  return names.map((name, at) => {
    const state = !counted || at > task.done ? "wait" : at === task.done ? "now" : at < task.kept ? "kept" : "done";
    return { name, state, percent: state === "now" && task && task.part !== null ? Math.round(task.part * 100) : null };
  });
}

/**
 * Takes the stock through the list of a project, which also makes its files.
 * Asked for again for the same project while it goes on, it is the same run,
 * and the task is whoever asked first's. It can be called off: everyone who
 * asked then gets a failure that `isCancelled` knows.
 */
export function stockOf(project: Project, by: Actor = "user"): Promise<StockTimeline> {
  return tasks.once(STOCK, project, () => {
    const tag = runTag(STOCK);
    calledOff = null;
    const cancel = () => {
      // Known before the task ends, so that what shows the stock then finds it.
      calledOff = project;
      core.cancel(tag);
    };
    return tasks.run({ key: STOCK, label: "Cutting the stock", stage: "One step after the other", unit: "step", heavy: true, view: "design", by, onCancel: cancel }, (task) => {
      const said = stockProgress(project.steps.map((s) => s.name));
      return core.work(
        tag,
        (p) => {
          const change = said(p);
          if (change) task.update(change);
        },
        "stockTimeline",
        project,
      );
    });
  });
}

/**
 * Makes a step's parts and simulates them, and for a V-carve inlay fits the
 * plug into the pocket. `publish` is given what there is after each of them.
 * What could not be made is said in what comes back, not thrown. It can be
 * called off: it then fails with what `isCancelled` knows, whatever of it
 * was made. `again`: there is a result already, which stays meanwhile.
 */
export function makeOutput(project: Project, step: Step, publish?: (out: Output) => void, by: Actor = "user", again = false): Promise<Output> {
  const out: Output = { stepId: step.id, project, parts: {}, errors: [], fit: null, fitErrors: [] };
  const tell = () => publish?.({ ...out, parts: { ...out.parts }, errors: [...out.errors] });
  const parts = partsOf(step);
  const vcarve = step.task.type === "vcarve";
  const label = (i: number) => `Working out the ${partName(parts[i], step)}`;
  const tag = runTag("generate");
  return tasks.run({ key: generateKey(step.id), label: label(0), total: parts.length + (vcarve ? 1 : 0), heavy: true, view: "design", by, again, onCancel: () => core.cancel(tag) }, async (task) => {
    /** Follows one call to the core: each starts with nothing said of a list. */
    const watch = () => {
      const said = fileProgress();
      return (p: CoreProgress) => {
        const change = said(p);
        if (change) task.update(change);
      };
    };
    for (const [i, part] of parts.entries()) {
      task.update({ label: label(i), done: i, stage: null, part: null });
      try {
        out.parts[part] = await core.work(tag, watch(), "previewPart", project, step.id, part);
      } catch (e) {
        if (isCancelled(e)) throw e;
        for (const line of text(e).split("\n")) if (!out.errors.includes(line)) out.errors.push(line);
      }
      tell();
    }
    if (vcarve && out.parts.pocket && out.parts.plug) {
      task.update({ label: "Fitting the plug into the pocket", done: parts.length, stage: null, part: null });
      try {
        out.fit = await core.work(tag, watch(), "checkFit", project, step.id);
      } catch (e) {
        if (isCancelled(e)) throw e;
        out.fitErrors = text(e).split("\n");
      }
      tell();
    }
    return out;
  });
}

/**
 * Makes a step's files and shows them, for whoever asks: a button or an
 * agent. `current` gives the output that is shown, `show` shows one.
 *
 * Made for the first time, each part is shown as it comes. Made again, what
 * was made last stays shown until all of the new is there: nothing half
 * made takes its place. Called off, what was shown before is shown again,
 * unless something else has been shown since; it then fails with what
 * `isCancelled` knows.
 */
export async function remakeOutput(project: Project, step: Step, current: () => Output | null, show: (out: Output | null) => void, by: Actor = "user"): Promise<Output> {
  const before = current();
  const again = before !== null && before.stepId === step.id;
  try {
    const out = await makeOutput(project, step, again ? undefined : show, by, again);
    if (again) show(out);
    return out;
  } catch (e) {
    // Only parts of this run are taken back: not what another step showed meanwhile.
    if (isCancelled(e) && !again && current()?.stepId === step.id) show(before);
    throw e;
  }
}

/**
 * The files joined from some of the entries of the list, for the export tab:
 * one task for all that are being made, counted as they come. It starts with
 * the first file asked for and ends with the last one made.
 */
export function createFileRuns(join: (project: Project, ids: string[]) => Promise<Built>) {
  let task: TaskHandle | null = null;
  let asked = 0;
  let made = 0;
  return (project: Project, ids: string[]): Promise<Built> => {
    asked++;
    if (!task) task = tasks.start({ key: FILES, label: "Making the files", total: asked, unit: "file", heavy: true, view: "design" });
    else task.update({ total: asked });
    // A join that throws before it has begun is counted as one that failed.
    let run: Promise<Built>;
    try {
      run = join(project, ids);
    } catch (e) {
      run = Promise.reject(e);
    }
    return run.finally(() => {
      made++;
      if (made < asked) return task?.update({ done: made });
      task?.end();
      task = null;
      asked = made = 0;
    });
  };
}

/** The file that cuts some of the entries of the list, as one of the export tab's files. */
export const joinedFile = createFileRuns((project, ids) => core.call("exportSteps", project, ids));
