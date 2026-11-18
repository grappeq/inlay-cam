import { useEffect, useRef } from "react";
import type { Built, Step, StockFile, StockTimeline, TimelineStep } from "../core/types";
import { fmt, isByHand, stepColor } from "../state/model";
import { useApp, useDispatch } from "../state/store";
import { downloadText } from "../util/files";
import { StepIcon } from "./icons";
import { FileNotes, formatMinutes, partName } from "./OutputPanel";
import { useWorkOut } from "./Timeline";

/** One line of the list: a file for the stock, an inlay's plug or insert file, or a step done by hand. */
type Row =
  | { kind: "stock"; file: StockFile; number: number; last: number }
  | { kind: "part"; part: StockTimeline["parts"][number] }
  | { kind: "hand"; step: TimelineStep; at: number };

/** Everything there is to do, in the order to do it: a part is cut before the glue-up that needs it. */
function rows(result: StockTimeline, steps: Step[]): Row[] {
  const out: Row[] = [];
  const shown = new Set<string>();
  const part = (inlayId: string) => {
    const found = result.parts.find((p) => p.stepId === inlayId);
    if (!found || shown.has(inlayId)) return;
    shown.add(inlayId);
    out.push({ kind: "part", part: found });
  };
  result.steps.forEach((step, index) => {
    if (step.byHand) {
      const listed = steps.find((j) => j.id === step.stepId);
      if (listed && isByHand(listed.task)) part(listed.task.inlayId);
      out.push({ kind: "hand", step, at: index + 1 });
      return;
    }
    const file = step.file === null ? undefined : result.files[step.file];
    // A file stands where its first line does.
    if (file && file.stepIds[0] === step.stepId) out.push({ kind: "stock", file, number: (step.file ?? 0) + 1, last: index + file.stepIds.length });
  });
  // Parts that no glue-up in the list asks for yet.
  for (const p of result.parts) part(p.stepId);
  return out;
}

/**
 * The files of the project, as a tab of the panel: each file for the stock,
 * each plug or insert file, and the steps done by hand between them, in the
 * order to do them, with a download for every file. They are made the first
 * time the tab is shown.
 */
export function FilesList() {
  const { project, timeline } = useApp();
  const dispatch = useDispatch();
  const { busy, workOut } = useWorkOut();
  const result = timeline?.result ?? null;
  const started = useRef(false);
  useEffect(() => {
    if (timeline !== null || started.current) return;
    started.current = true;
    // Nothing made yet: make it now, without changing what the stage shows.
    void workOut();
    // Once, when the tab is first shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Names and colours are those of the project as it was when the files were made.
  const made = timeline?.project ?? project;
  const stale = timeline !== null && made !== project;
  const name = (id: string) => made.steps.find((j) => j.id === id)?.name ?? "?";
  const several = (result?.files.length ?? 0) > 1;
  const show = (at: number) => {
    dispatch({ type: "setTimelineAt", at });
    dispatch({ type: "setStage", stage: "timeline" });
  };

  return (
    <section className="files-list">
      <p className="hint">
        Everything to cut and to do, in order; a file for the stock cuts the lines from one glue-up to the next.
      </p>
      {
        <>
          {(busy || timeline === null) && (
            <p className="status-line" role="status">
              Making the files and cutting the stock with them…
            </p>
          )}
          {!busy && timeline && timeline.errors.length > 0 && (
            <div className="callout error" role="alert">
              <p>The files could not be made:</p>
              <ul>
                {timeline.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          )}
          {!busy && stale && <p className="callout warn">The project has changed since these were made. Generate again before downloading.</p>}
          {!busy && result && (
            <ol className="file-rows">
              {rows(result, made.steps).map((row, index) => {
                const n = index + 1;
                if (row.kind === "hand") {
                  const { step } = row;
                  const listed = made.steps.find((j) => j.id === step.stepId);
                  const by = listed?.task;
                  const inlay = by && isByHand(by) ? made.steps.find((j) => j.id === by.inlayId) : undefined;
                  return (
                    <li className="file-row by-hand" key={`hand ${step.stepId}`}>
                      <span className="file-row-n">{n}</span>
                      <div className="file-row-main">
                        <button className="link" onClick={() => show(row.at)} title="Show the stock after this step in 3D">
                          <span className="job-icon" style={inlay ? { color: stepColor(inlay, made.steps) } : undefined}>
                            <StepIcon type={by?.type === "saw" ? "saw" : "glue"} />
                          </span>
                          {name(step.stepId)}
                        </button>
                        <span className="muted">
                          By hand, no file.
                          {step.seat ? ` It stands ${fmt(Math.round(step.seat.above * 100) / 100)} mm above the surface.` : ""}
                        </span>
                        {[...step.errors, ...step.warnings].map((text) => (
                          <span className="warn" key={text}>
                            {text}
                          </span>
                        ))}
                      </div>
                    </li>
                  );
                }
                if (row.kind === "part") {
                  const inlay = made.steps.find((j) => j.id === row.part.stepId);
                  if (!inlay) return null;
                  const what = partName("plug", inlay);
                  return (
                    <FileRow
                      key={`part ${row.part.stepId}`}
                      n={n}
                      title={`${what === "insert" ? "Inserts" : "Plug"} of "${inlay.name}"`}
                      note="Cut from a board of its own."
                      built={row.part.built}
                      problems={row.part.problems.length}
                      errors={row.part.errors}
                      stale={stale}
                    />
                  );
                }
                const { file } = row;
                const missing = result.steps
                  .filter((s) => file.stepIds.includes(s.stepId) && s.errors.length > 0)
                  .flatMap((s) => s.errors.map((e) => `${name(s.stepId)}: ${e}`));
                return (
                  <FileRow
                    key={`stock ${row.number}`}
                    n={n}
                    title={`Stock${several ? `, file ${row.number}` : ""}`}
                    note={`Cuts ${file.stepIds.map((id) => `"${name(id)}"`).join(", then ")}.`}
                    built={file.complete ? file.built : null}
                    problems={file.problems.length}
                    errors={[...file.errors, ...missing]}
                    stale={stale}
                    onShow={() => show(row.last)}
                  />
                );
              })}
            </ol>
          )}
          {!busy && timeline && (
            <div className="files-foot">
              <span className="muted">The work origin of every file is its board's bottom-left corner, on its top face.</span>
              <button onClick={() => workOut()}>Generate again</button>
            </div>
          )}
        </>
      }
    </section>
  );
}

/** One file in the list: what it is, how long it takes, whether it came out clean, and its download. */
function FileRow(props: { n: number; title: string; note: string; built: Built | null; problems: number; errors: string[]; stale: boolean; onShow?: () => void }) {
  const { built } = props;
  const stats = built?.stats;
  const changes = stats ? (stats.toolChanges === 1 ? "loading the tool" : `${stats.toolChanges} tool changes`) : "";
  return (
    <li className="file-row">
      <span className="file-row-n">{props.n}</span>
      <div className="file-row-main">
        {props.onShow ? (
          <button className="link" onClick={props.onShow} title="Show the stock after this file in 3D">
            {props.title}
          </button>
        ) : (
          <strong>{props.title}</strong>
        )}
        <span className="muted">{props.note}</span>
        {built && stats && (
          <span className="muted">
            {stats.toolChangeMinutes > 0
              ? `About ${formatMinutes(stats.minutes + stats.toolChangeMinutes)}, with ${changes}.`
              : `About ${formatMinutes(stats.minutes)}, plus ${changes}.`}{" "}
            {props.problems === 0 && <span className="ok">Simulated without problems.</span>}
          </span>
        )}
        {built && props.problems > 0 && (
          <span className="warn">
            The simulation found {props.problems} problem{props.problems === 1 ? "" : "s"}. Do not run this file.
          </span>
        )}
        {!built && (
          <span className="warn">
            Not made: {props.errors.join(" ")}
          </span>
        )}
        {built && <FileNotes built={built} compact />}
      </div>
      {built && (
        <button className="small" disabled={props.stale} title={`${built.fileName}, ${built.stats.lines} lines`} onClick={() => downloadText(built.fileName, built.gcode, "text/plain")}>
          Download
        </button>
      )}
    </li>
  );
}
