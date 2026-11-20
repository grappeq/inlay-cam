// The menu a right click on a line of the list of operations opens, and what
// its entries do.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { core } from "../core/client";
import type { Built, Step } from "../core/types";
import { duplicateStep, glueOf, glueStep, insertAfter, isByHand, isInlay, isSuppressed, sawOf, sawStep, standingPart, trimFacing, trimOf, withSuppressed, withoutStep } from "../state/model";
import { message, useApp, useDispatch, type Timeline } from "../state/store";
import { downloadText } from "../util/files";
import { focusSoon, useDismiss, walkMenu } from "./Layers";

/**
 * What is done with an inlay once it is cut, as the steps they are: the
 * glue-up, then for a plug that stands above the surface the sawing off of
 * its backer and the facing that trims it flush. Each is the step of the
 * list, when it is there, and can be added. `part` is null for anything that
 * has none of them: a plain operation, and an inlay without shapes.
 */
export function useAfterCut(step: Step) {
  const { project, tools, defaults } = useApp();
  const dispatch = useDispatch();
  const standing = standingPart(step);
  const part = standing && step.regionIds.length > 0 ? standing : null;

  const addGlue = () => {
    const added = glueStep(step, project.steps);
    if (!added) return;
    // Right after the inlay, whose place in the list is where its pocket is cut.
    dispatch({ type: "updateProject", update: (p) => ({ ...p, steps: insertAfter(p.steps, step.id, added) }) });
  };
  const addSaw = () => {
    const added = sawStep(step, project.steps);
    if (!added) return;
    dispatch({ type: "updateProject", update: (p) => ({ ...p, steps: insertAfter(p.steps, glueOf(step, p.steps)?.id ?? step.id, added) }) });
  };
  const addTrim = () => {
    const trim = trimFacing(step, project.steps, defaults);
    if (!trim || trim.task.type !== "facing") return;
    // Where the tool list leaves no choice of end mill, make it.
    const endMills = tools.filter((t) => t.kind === "flat_end");
    if (endMills.length === 1) trim.task.toolId = endMills[0].id;
    // After the glue-up, and the sawing, when the list has them: the facing cuts what they leave.
    dispatch({ type: "updateProject", update: (p) => ({ ...p, steps: insertAfter(p.steps, (sawOf(step, p.steps) ?? glueOf(step, p.steps))?.id, trim) }) });
    dispatch({ type: "setActiveStep", id: trim.id });
  };

  return {
    part,
    /** Whether there is a plug above the surface, to saw off and to trim. */
    trims: part !== null && part.what === "plug" && part.above > 0,
    glue: glueOf(step, project.steps),
    saw: sawOf(step, project.steps),
    trim: trimOf(step, project.steps),
    addGlue,
    addSaw,
    addTrim,
  };
}

/**
 * What takes the stock through the list for one line of it: showing the
 * stock as the line leaves it, and saving the line's G-code. `busy` says, in
 * words, what is being worked on meanwhile.
 */
export function useStepFiles() {
  const { project, timeline } = useApp();
  const dispatch = useDispatch();
  const [busy, setBusy] = useState<string | null>(null);

  /** The stock taken through the list as the project is now: what there is, or worked out. */
  const current = async (): Promise<Timeline> => {
    if (timeline?.result && timeline.project === project) return timeline;
    let made: Timeline;
    try {
      made = { project, result: await core.call("stockTimeline", project), errors: [] };
    } catch (e) {
      made = { project, result: null, errors: message(e).split("\n") };
    }
    dispatch({ type: "setTimeline", timeline: made });
    return made;
  };

  const showAfter = async (step: Step) => {
    setBusy("Cutting the stock, one step after the other…");
    try {
      await current();
      dispatch({ type: "setTimelineAt", at: project.steps.indexOf(step) + 1 });
      dispatch({ type: "setStage", stage: "timeline" });
    } finally {
      setBusy(null);
    }
  };

  /** Saves the file that cuts the step into the stock, and for an inlay that of its plug or inserts. Nothing is saved when either cannot be made or went wrong in the simulation. */
  const exportGcode = async (step: Step) => {
    setBusy(`Making the G-code of "${step.name}"…`);
    try {
      const { result, errors, project: made } = await current();
      const files: Built[] = [];
      const why: string[] = [...errors];
      const notes: string[] = [];
      const found = (count: number, what: string) => `The simulation found ${count} problem${count === 1 ? "" : "s"} in ${what}.`;
      const cut = result?.steps.find((s) => s.stepId === step.id);
      if (cut) {
        notes.push(...cut.warnings);
        if (cut.errors.length > 0) why.push(...cut.errors);
        else if (cut.problems.length > 0) why.push(found(cut.problems.length, isInlay(step.task) ? "the pocket" : "it"));
        else {
          try {
            files.push(await core.call("exportSteps", made, [step.id]));
          } catch (e) {
            why.push(...message(e).split("\n"));
          }
        }
      }
      const second = result?.parts.find((p) => p.stepId === step.id);
      if (second) {
        if (second.errors.length > 0) why.push(...second.errors);
        else if (second.problems.length > 0) why.push(found(second.problems.length, "the plug or inserts"));
        else if (second.built) files.push(second.built);
      }
      if (why.length > 0 || files.length === 0) {
        dispatch({ type: "notice", notice: { kind: "error", text: `The G-code of "${step.name}" was not saved. ${[...new Set(why)].join(" ")}`.trim() } });
        return;
      }
      for (const file of files) downloadText(file.fileName, file.gcode, "text/plain");
      dispatch({ type: "notice", notice: { kind: "info", text: [`Saved ${files.map((f) => f.fileName).join(" and ")}.`, ...notes].join(" ") } });
    } finally {
      setBusy(null);
    }
  };

  return { busy, showAfter, exportGcode };
}

type StepFiles = ReturnType<typeof useStepFiles>;

/** What is asked before a step is deleted: it names the steps done by hand that go with an inlay. */
export function deleteQuestion(step: Step, steps: Step[]): string {
  if (!isInlay(step.task)) return `Delete "${step.name}"?`;
  const left = withoutStep(steps, step.id);
  const gone = steps.filter((j) => j.id !== step.id && !left.includes(j)).map((j) => `"${j.name}"`);
  return `Delete "${step.name}"? Its shapes become free again.${gone.length > 0 ? ` ${gone.join(" and ")} ${gone.length === 1 ? "goes" : "go"} with it.` : ""}`;
}

/** The line of a step in the list of operations: what is clicked to open it. */
const lineOf = (id: string) => document.querySelector<HTMLElement>(`.jobs [data-step="${id}"] .job`);

/** The menu of the line of `step` in the list of operations, at `x`, `y` of the window. */
export function StepMenu({ step, x, y, files, close }: { step: Step; x: number; y: number; files: StepFiles; close: () => void }) {
  const { project } = useApp();
  const dispatch = useDispatch();
  const after = useAfterCut(step);
  const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ x, y });
  // Closed by a key or by choosing, the focus goes to the line the menu was opened on.
  const done = () => {
    close();
    // Not from a menu that was opened meanwhile.
    focusSoon(() => (document.querySelector(".context-menu") ? null : lineOf(step.id)));
  };
  useDismiss(menu, true, (byKey) => (byKey ? done() : close()));
  // The menu stays where it was opened, so it goes when its line is scrolled away from it.
  const closeNow = useRef(close);
  closeNow.current = close;
  useEffect(() => {
    const away = () => closeNow.current();
    window.addEventListener("scroll", away, true);
    return () => window.removeEventListener("scroll", away, true);
  }, []);

  // Kept inside the window, and the keyboard starts on its first entry.
  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (!box) return;
    setAt({ x: Math.max(4, Math.min(x, window.innerWidth - box.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - box.height - 4)) });
    menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  const then = (act: () => void) => () => {
    done();
    act();
  };
  const byHand = isByHand(step.task);
  const working = files.busy !== null;
  const suppressed = isSuppressed(step, project.steps);
  // A step done by hand is left out with its inlay, and comes back with it.
  const inlay = byHand && !step.suppressed && suppressed ? project.steps.find((j) => isByHand(step.task) && j.id === step.task.inlayId) : undefined;

  const duplicate = () => {
    const copy = duplicateStep(step, project.steps);
    if (!copy) return;
    // Below what is done with an inlay once it is cut, when that follows it: its steps stay together.
    const at = project.steps.indexOf(step);
    const last = [after.glue, after.saw, after.trim].reduce((most, j) => Math.max(most, j ? project.steps.indexOf(j) : -1), at);
    dispatch({ type: "updateProject", update: (p) => ({ ...p, steps: insertAfter(p.steps, project.steps[last].id, copy) }) });
    focusSoon(() => lineOf(copy.id));
  };
  const suppress = () => {
    dispatch({ type: "updateProject", update: (p) => ({ ...p, steps: withSuppressed(p.steps, step.id, !step.suppressed) }) });
  };
  const remove = () => {
    if (!byHand && !confirm(deleteQuestion(step, project.steps))) return;
    dispatch({ type: "updateProject", update: (p) => ({ ...p, steps: withoutStep(p.steps, step.id) }) });
  };

  const adds = after.part !== null && (!after.glue || (after.trims && (!after.saw || !after.trim)));
  return (
    <div ref={menu} className="menu-items context-menu layer-menu" role="menu" aria-label={step.name} style={{ left: at.x, top: at.y }} onKeyDown={(e) => (e.key === "Tab" ? (e.preventDefault(), done()) : walkMenu(e))} onContextMenu={(e) => e.preventDefault()}>
      <button type="button" role="menuitem" onClick={then(() => dispatch({ type: "setActiveStep", id: step.id }))}>
        Open
      </button>
      <button type="button" role="menuitem" disabled={working} onClick={then(() => void files.showAfter(step))}>
        Show the stock after it
      </button>
      {adds && <hr />}
      {after.part && !after.glue && (
        <button type="button" role="menuitem" onClick={then(after.addGlue)}>
          Add its glue-up
        </button>
      )}
      {after.trims && !after.saw && (
        <button type="button" role="menuitem" disabled={!after.glue} title={after.glue ? undefined : "After the glue-up, once that is in the list."} onClick={then(after.addSaw)}>
          Saw off its backer
        </button>
      )}
      {after.trims && !after.trim && (
        <button type="button" role="menuitem" onClick={then(after.addTrim)}>
          Trim its plug flush
        </button>
      )}
      {!byHand && (
        <>
          <hr />
          <button type="button" role="menuitem" onClick={then(duplicate)}>
            Duplicate
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={working || suppressed}
            title={suppressed ? "It is suppressed: there is no file for it." : undefined}
            onClick={then(() => void files.exportGcode(step))}
          >
            Export its G-code
          </button>
        </>
      )}
      <hr />
      <button
        type="button"
        role="menuitem"
        disabled={inlay !== undefined}
        title={inlay ? `Left out with "${inlay.name}": it comes back with it.` : step.suppressed ? undefined : "Left out of the files and of the stock, it keeps its place and its settings."}
        onClick={then(suppress)}
      >
        {suppressed ? "Unsuppress" : "Suppress"}
      </button>
      <button type="button" role="menuitem" className="danger" onClick={then(remove)}>
        Delete
      </button>
    </div>
  );
}
