import { useEffect, useMemo, useRef, useState } from "react";
import { core } from "../core/client";
import type { Built, Step, PocketPreview, Project, StockTimeline, TimelineStep } from "../core/types";
import { fmt, isByHand, stepColor, stockColor } from "../state/model";
import { message, useApp, useDispatch, type Timeline } from "../state/store";
import { StepIcon } from "./icons";
import { Viewer3D, type KeptCamera } from "./Viewer3D";

/** Whether a step has something to say: it could not be done, went wrong, or wants a look. */
function troubled(step: TimelineStep): boolean {
  return step.errors.length > 0 || step.problems.length > 0 || step.warnings.length > 0;
}

/** Taking the stock through the list, which also makes the files: the work, and whether it is going on. */
export function useWorkOut() {
  const { project } = useApp();
  const dispatch = useDispatch();
  const [busy, setBusy] = useState(false);
  const workOut = async (at?: number) => {
    setBusy(true);
    try {
      const result = await core.call("stockTimeline", project);
      dispatch({ type: "setTimeline", timeline: { project, result, errors: [] } });
      dispatch({ type: "setTimelineAt", at: at ?? result.steps.length });
    } catch (e) {
      dispatch({ type: "setTimeline", timeline: { project, result: null, errors: message(e).split("\n") } });
    } finally {
      setBusy(false);
    }
  };
  return { busy, workOut };
}

/** What is wrong with a step, in a few words. */
function summary(step: TimelineStep): string {
  if (step.errors.length > 0) return "could not be done";
  const parts: string[] = [];
  if (step.problems.length > 0) parts.push(`${step.problems.length} problem${step.problems.length === 1 ? "" : "s"} while cutting`);
  if (step.warnings.length > 0) parts.push(step.byHand ? "does not sit as designed" : "a warning");
  return parts.join(", ");
}

/**
 * What the stage shows before the stock has been taken through the list:
 * it is worked out there and then, the first time it is asked for. `at` is
 * the point of the list to show once it is.
 */
export function TimelineStart({ at }: { at?: number }) {
  const { timeline } = useApp();
  const { busy, workOut } = useWorkOut();
  const started = useRef(false);
  useEffect(() => {
    if (timeline !== null || started.current) return;
    started.current = true;
    void workOut(at);
    // Once, when the view is first shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="timeline-start" role="status">
      {timeline === null || busy ? (
        <p className="status-line">Cutting the stock, one step after the other…</p>
      ) : (
        <>
          <div className="callout error">
            <p>The stock could not be worked out:</p>
            <ul>
              {timeline.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
          <button onClick={() => workOut(at)}>Try again</button>
        </>
      )}
    </div>
  );
}

const NO_PATH = new Float32Array(0);

/** What the 3D view is told about a point of the list that has no file: the stock, and nothing cut. */
function noFile(project: Project, thickness: number): Built {
  return {
    part: "pocket",
    stock: { width: project.design?.width ?? 0, height: project.design?.height ?? 0, thickness, through: 0 },
    cuttable: [],
    flatFit: null,
    piece: null,
    cutWidth: null,
    shapes: null,
    narrow: [],
    fileName: "",
    gcode: "",
    stats: { lines: 0, cuttingLength: 0, minutes: 0, tools: [], toolChanges: 0, toolChangeMinutes: 0, perTool: [] },
    before: [],
    warnings: [],
  };
}

/** The stock in 3D at one point of the list, with the list to step through above it. */
export function TimelineView({ timeline, result }: { timeline: Timeline; result: StockTimeline }) {
  const { project, timelineAt, panelPage, activeStepId } = useApp();
  const dispatch = useDispatch();
  const { busy, workOut } = useWorkOut();
  // While the panel is on what to export, it stays there to be looked through.
  const stay = panelPage === "export" && activeStepId === null;
  // Names and colours are those of the project as it was when this was worked out.
  const made = timeline.project;
  const count = result.steps.length;
  const at = Math.min(timelineAt, count);
  const step = at > 0 ? result.steps[at - 1] : null;
  const stepOf = (id: string): Step | undefined => made.steps.find((j) => j.id === id);
  const camera = useRef<KeptCamera>({});

  // The wood of each glued-in inlay, by its number in the snapshots.
  const colors = useMemo(
    () => [
      stockColor(made),
      ...result.glued.map((id) => {
        const inlay = made.steps.find((j) => j.id === id);
        return inlay ? stepColor(inlay, made.steps) : stockColor(made);
      }),
    ],
    [result, made],
  );
  const preview = useMemo<PocketPreview>(() => {
    const shown = at > 0 ? result.steps[at - 1] : null;
    // The file a step is part of gives the tools' names and the lines' numbers.
    const file = shown && shown.file !== null ? result.files[shown.file] : undefined;
    return {
      built: file?.built ?? noFile(made, result.thickness),
      problems: shown?.problems ?? [],
      cell: result.cell,
      nx: result.nx,
      ny: result.ny,
      heights: result.snapshots[at].heights,
      path: shown?.path ?? NO_PATH,
    };
  }, [result, at, made]);

  // The panel follows to the entry shown, unless it stays.
  const go = (to: number) => dispatch({ type: "setTimelineAt", at: to, open: !stay });
  const stale = made !== project;
  const chip = (index: number) => {
    const s = result.steps[index];
    const j = stepOf(s.stepId);
    const glued = j && isByHand(j.task) ? stepOf(j.task.inlayId) : undefined;
    return (
      <button
        key={s.stepId}
        className={`step${s.byHand ? " by-hand" : ""}${s.suppressed ? " suppressed" : ""}`}
        title={s.suppressed ? "Suppressed: it leaves the stock as it was." : undefined}
        aria-pressed={at === index + 1}
        onClick={() => go(index + 1)}
      >
        <span className="job-icon" style={glued ? { color: stepColor(glued, made.steps) } : undefined}>
          {j && <StepIcon type={j.task.type} />}
        </span>
        {j?.name ?? "?"}
        {troubled(s) && (
          <span className={`step-mark${s.errors.length > 0 ? " error" : ""}`} aria-label={summary(s)} title={summary(s)}>
            !
          </span>
        )}
      </button>
    );
  };

  const label = (index: number) => (index === 0 ? "the fresh stock" : `after "${stepOf(result.steps[index - 1].stepId)?.name ?? "?"}"`);

  return (
    <div className="timeline-view">
      <div className="timeline">
        <div className="timeline-bar">
          <button className="arrow" aria-label="One step back" disabled={at === 0} onClick={() => go(at - 1)}>
            ‹
          </button>
          <input
            type="range"
            min={0}
            max={count}
            step={1}
            value={at}
            onChange={(e) => go(Number(e.target.value))}
            aria-label="The point of the list the stock is shown at"
            aria-valuetext={label(at)}
          />
          <button className="arrow" aria-label="One step on" disabled={at === count} onClick={() => go(at + 1)}>
            ›
          </button>
        </div>
        <div className="timeline-steps">
          <button className="step" aria-pressed={at === 0} onClick={() => go(0)}>
            Fresh stock
          </button>
          {result.steps.map((_, index) => chip(index))}
        </div>
        {stale && (
          <p className="callout warn">
            The project has changed since this was worked out.{" "}
            <button className="link" disabled={busy} onClick={() => workOut(at)}>
              {busy ? "Working…" : "Work it out again"}
            </button>
          </p>
        )}
        <StepNote step={step} at={at} result={result} made={made} />
      </div>
      <Viewer3D
        preview={preview}
        thickness={result.thickness}
        color={colors[0]}
        owners={result.snapshots[at].owners}
        below={result.snapshots[at]}
        colors={colors}
        keepCamera={camera.current}
        simulatedCell={result.simulatedCell}
      />
    </div>
  );
}

/** What happened at the point of the list that is shown. */
function StepNote({ step, at, result, made }: { step: TimelineStep | null; at: number; result: StockTimeline; made: Project }) {
  if (!step) {
    return (
      <p className="status-line" role="status">
        The stock before anything is done to it: {fmt(made.design?.width ?? 0)} × {fmt(made.design?.height ?? 0)} mm, {fmt(result.thickness)} mm thick.
      </p>
    );
  }
  const name = made.steps.find((j) => j.id === step.stepId)?.name ?? "?";
  if (step.suppressed) {
    return (
      <p className="status-line" role="status">
        Step {at} of {result.steps.length}: "{name}" is suppressed, so the stock is as the step before left it.
      </p>
    );
  }
  if (step.errors.length > 0) {
    return (
      <div className="callout error" role="status">
        <p>
          "{name}" could not be done, so the stock is as the step before left it:
        </p>
        <ul>
          {step.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      </div>
    );
  }
  const seat = step.seat;
  return (
    <>
      <p className="status-line" role="status">
        Step {at} of {result.steps.length}: the stock after "{name}".{" "}
        {seat
          ? `Glued in by hand, it stands ${fmt(Math.round(seat.above * 100) / 100)} mm above the surface${
              Math.abs(seat.proud) >= 0.02 ? `, ${fmt(Math.round(Math.abs(seat.proud) * 100) / 100)} mm ${seat.proud > 0 ? "higher" : "lower"} than designed` : ""
            }.`
          : step.byHand
            ? "Done by hand."
            : step.stats
            ? `${step.startsAbove !== null ? `Its first pass starts ${fmt(step.startsAbove)} mm above the surface, where the wood stands on the stock. ` : ""}Cut into the stock as the step before left it.`
            : ""}
      </p>
      {(step.problems.length > 0 || step.warnings.length > 0) && (
        <div className="callout warn">
          <ul>
            {step.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
            {step.problems.slice(0, 5).map((problem) => (
              <li key={`${problem.line} ${problem.message}`}>
                Line {problem.line}: {problem.message}
              </li>
            ))}
            {step.problems.length > 5 && <li>And {step.problems.length - 5} more.</li>}
          </ul>
        </div>
      )}
    </>
  );
}
