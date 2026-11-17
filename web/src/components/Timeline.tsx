import { useMemo, useRef, useState } from "react";
import { core } from "../core/client";
import type { Built, Job, PocketPreview, Project, StockTimeline, TimelineStep } from "../core/types";
import { fmt, jobColor, stockColor } from "../state/model";
import { message, useApp, useDispatch, type Timeline } from "../state/store";
import { JobIcon } from "./icons";
import { Viewer3D, type KeptCamera } from "./Viewer3D";

/** Whether a step has something to say: it could not be done, went wrong, or wants a look. */
function troubled(step: TimelineStep): boolean {
  return step.errors.length > 0 || step.problems.length > 0 || step.warnings.length > 0;
}

/** Taking the stock through the list: the work, and whether it is going on. */
function useWorkOut() {
  const { project } = useApp();
  const dispatch = useDispatch();
  const [busy, setBusy] = useState(false);
  const workOut = async (at?: number) => {
    setBusy(true);
    try {
      const result = await core.call("stockTimeline", project);
      dispatch({ type: "setTimeline", timeline: { project, result, errors: [] } });
      dispatch({ type: "setTimelineAt", at: at ?? result.steps.length });
      dispatch({ type: "setStage", stage: "timeline" });
    } catch (e) {
      dispatch({ type: "setTimeline", timeline: { project, result: null, errors: message(e).split("\n") } });
    } finally {
      setBusy(false);
    }
  };
  return { busy, workOut };
}

/**
 * In the panel, under the list: takes the stock through the list from top to
 * bottom and shows it in 3D at any point of it.
 */
export function StockSteps() {
  const { project, timeline, stage } = useApp();
  const dispatch = useDispatch();
  const { busy, workOut } = useWorkOut();
  if (project.jobs.length === 0) return null;
  const stale = timeline !== null && timeline.project !== project;
  const result = timeline?.result ?? null;
  const name = (id: string) => timeline?.project.jobs.find((j) => j.id === id)?.name ?? "?";
  const noted = result?.steps.map((step, index) => ({ step, index })).filter(({ step }) => troubled(step)) ?? [];

  return (
    <section>
      <h2>The stock, step by step</h2>
      <p className="hint">
        Takes the stock through the list from top to bottom: each file cuts it as the one before left it, and a glue-up puts the plug on it. Then any
        point of the list can be looked at in 3D.
      </p>
      <div className="row tools">
        <button disabled={busy} onClick={() => workOut()}>
          {busy ? "Working…" : result ? "Work out again" : "Show the stock in 3D"}
        </button>
        {result && stage !== "timeline" && (
          <button className="link" onClick={() => dispatch({ type: "setStage", stage: "timeline" })}>
            Show it
          </button>
        )}
      </div>
      {busy && (
        <p className="status-line" role="status">
          Cutting the stock, one step after the other…
        </p>
      )}
      {timeline && !busy && (
        <div className="results">
          {stale && <p className="callout warn">The project has changed since this was worked out.</p>}
          {timeline.errors.length > 0 && (
            <div className="callout error" role="alert">
              <p>The stock could not be worked out:</p>
              <ul>
                {timeline.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          )}
          {result && noted.length === 0 && <p className="status-line">Every step went through without a problem.</p>}
          {noted.length > 0 && (
            <div className="callout warn">
              <p>Worth a look:</p>
              <ul>
                {noted.map(({ step, index }) => (
                  <li key={step.jobId}>
                    <button
                      className="link"
                      onClick={() => {
                        dispatch({ type: "setTimelineAt", at: index + 1 });
                        dispatch({ type: "setStage", stage: "timeline" });
                      }}
                    >
                      {name(step.jobId)}
                    </button>
                    : {summary(step)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** What is wrong with a step, in a few words. */
function summary(step: TimelineStep): string {
  if (step.errors.length > 0) return "could not be done";
  const parts: string[] = [];
  if (step.problems.length > 0) parts.push(`${step.problems.length} problem${step.problems.length === 1 ? "" : "s"} while cutting`);
  if (step.warnings.length > 0) parts.push(step.byHand ? "does not sit as designed" : "a warning");
  return parts.join(", ");
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
    warnings: [],
  };
}

/** The stock in 3D at one point of the list, with the list to step through above it. */
export function TimelineView({ timeline, result }: { timeline: Timeline; result: StockTimeline }) {
  const { project, timelineAt } = useApp();
  const dispatch = useDispatch();
  const { busy, workOut } = useWorkOut();
  // Names and colours are those of the project as it was when this was worked out.
  const made = timeline.project;
  const count = result.steps.length;
  const at = Math.min(timelineAt, count);
  const step = at > 0 ? result.steps[at - 1] : null;
  const job = (id: string): Job | undefined => made.jobs.find((j) => j.id === id);
  const camera = useRef<KeptCamera>({});

  // The wood of each glued-in inlay, by its number in the snapshots.
  const colors = useMemo(
    () => [
      stockColor(made),
      ...result.glued.map((id) => {
        const inlay = made.jobs.find((j) => j.id === id);
        return inlay ? jobColor(inlay, made.jobs) : stockColor(made);
      }),
    ],
    [result, made],
  );
  const preview = useMemo<PocketPreview>(() => {
    const shown = at > 0 ? result.steps[at - 1] : null;
    return {
      built: shown?.built ?? noFile(made, result.thickness),
      problems: shown?.problems ?? [],
      cell: result.cell,
      nx: result.nx,
      ny: result.ny,
      heights: result.snapshots[at].heights,
      path: shown?.path ?? NO_PATH,
    };
  }, [result, at, made]);

  const go = (to: number) => dispatch({ type: "setTimelineAt", at: to });
  const label = (index: number) => (index === 0 ? "the fresh stock" : `after "${job(result.steps[index - 1].jobId)?.name ?? "?"}"`);

  return (
    <div className="timeline-view">
      <div className="timeline">
        <div className="timeline-bar">
          <button aria-label="One step back" disabled={at === 0} onClick={() => go(at - 1)}>
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
          <button aria-label="One step on" disabled={at === count} onClick={() => go(at + 1)}>
            ›
          </button>
        </div>
        <ol className="timeline-steps">
          <li>
            <button aria-pressed={at === 0} onClick={() => go(0)}>
              Fresh stock
            </button>
          </li>
          {result.steps.map((s, index) => {
            const j = job(s.jobId);
            const glued = j?.inlay.type === "glue" ? job(j.inlay.inlayId) : undefined;
            return (
              <li key={s.jobId}>
                <button className={s.byHand ? "by-hand" : undefined} aria-pressed={at === index + 1} onClick={() => go(index + 1)}>
                  <span className="job-icon" style={glued ? { color: jobColor(glued, made.jobs) } : undefined}>
                    {j && <JobIcon type={j.inlay.type} />}
                  </span>
                  {j?.name ?? "?"}
                  {troubled(s) && (
                    <span className={`step-mark${s.errors.length > 0 ? " error" : ""}`} aria-label={summary(s)} title={summary(s)}>
                      !
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
        <StepNote step={step} at={at} result={result} made={made} />
        {made !== project && (
          <p className="callout warn">
            The project has changed since this was worked out.{" "}
            <button className="link" disabled={busy} onClick={() => workOut(at)}>
              {busy ? "Working…" : "Work it out again"}
            </button>
          </p>
        )}
      </div>
      <Viewer3D
        preview={preview}
        thickness={result.thickness}
        color={colors[0]}
        owners={result.snapshots[at].owners}
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
  const name = made.jobs.find((j) => j.id === step.jobId)?.name ?? "?";
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
          : step.built
            ? `${step.built.fileName}, cut into the stock as the step before left it.`
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
