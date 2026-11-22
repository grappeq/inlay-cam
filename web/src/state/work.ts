// The long work of the core, each kind done in one place: whoever asks for it,
// a button, a tab, a right click or an agent, it is one task, shown as one,
// and the same work asked for twice while it goes on is done once.

import { core } from "../core/client";
import type { Built, Project, Step, StockTimeline } from "../core/types";
import { partName, partsOf } from "./model";
import type { Output } from "./store";
import { tasks, type Actor, type TaskHandle } from "./tasks";

/** The key of the task that takes the stock through the list. */
export const STOCK = "stock";
/** The key of the task that makes the files the ticks of the export tab come to. */
export const FILES = "files";
/** The key of the task that makes one step's G-code from its menu. */
export const GCODE = "gcode";
/** The key of the task that makes a step's parts and fits them. */
export const generateKey = (stepId: string) => `generate:${stepId}`;

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Takes the stock through the list of a project, which also makes its files.
 * Asked for again for the same project while it goes on, it is the same run,
 * and the task is whoever asked first's.
 */
export function stockOf(project: Project, by: Actor = "user"): Promise<StockTimeline> {
  return tasks.once(STOCK, project, () =>
    tasks.run({ key: STOCK, label: "Cutting the stock", stage: "One step after the other", heavy: true, view: "design", by }, () => core.call("stockTimeline", project)),
  );
}

/**
 * Makes a step's parts and simulates them, and for a V-carve inlay fits the
 * plug into the pocket. `publish` is given what there is after each of them.
 * What could not be made is said in what comes back, not thrown.
 */
export function makeOutput(project: Project, step: Step, publish?: (out: Output) => void, by: Actor = "user"): Promise<Output> {
  const out: Output = { stepId: step.id, project, parts: {}, errors: [], fit: null, fitErrors: [] };
  const tell = () => publish?.({ ...out, parts: { ...out.parts }, errors: [...out.errors] });
  const parts = partsOf(step);
  const vcarve = step.task.type === "vcarve";
  const label = (i: number) => `Working out the ${partName(parts[i], step)}`;
  return tasks.run({ key: generateKey(step.id), label: label(0), total: parts.length + (vcarve ? 1 : 0), heavy: true, view: "design", by }, async (task) => {
    for (const [i, part] of parts.entries()) {
      task.update({ label: label(i), done: i });
      try {
        out.parts[part] = await core.call("previewPart", project, step.id, part);
      } catch (e) {
        for (const line of text(e).split("\n")) if (!out.errors.includes(line)) out.errors.push(line);
      }
      tell();
    }
    if (vcarve && out.parts.pocket && out.parts.plug) {
      task.update({ label: "Fitting the plug into the pocket", done: parts.length });
      try {
        out.fit = await core.call("checkFit", project, step.id);
      } catch (e) {
        out.fitErrors = text(e).split("\n");
      }
      tell();
    }
    return out;
  });
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
