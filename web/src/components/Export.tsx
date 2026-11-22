import { useEffect, useMemo, useRef, useState } from "react";
import type { BuildStats, Built, Step, StepType, StockTimeline } from "../core/types";
import { aboveOrBelow, isByHand, isInlay, stepColor } from "../state/model";
import { message, useApp, useDispatch, type Timeline } from "../state/store";
import { downloadText } from "../util/files";
import { StepIcon } from "./icons";
import { BeforeCut } from "./BeforeCut";
import { FILES, joinedFile, stockCalledOff } from "../state/work";
import { formatMinutes, partName } from "./OutputPanel";
import { ProgressLine, Spinner, useTask } from "./Progress";
import { useWorkOut } from "./Timeline";

/** Something a file can cut: an entry of the list on the stock, or an inlay's plug or inserts on a board of their own. */
interface Cut {
  kind: "cut";
  /** What it is ticked by. */
  key: string;
  stepId: string;
  /** The stretch of the list it is in, from one step done by hand to the next: what is ticked there shares a file. Null on a board of its own. */
  run: number | null;
  name: string;
  type: StepType;
  /** Its time and tools. Null when it cannot be made. */
  stats: BuildStats | null;
  errors: string[];
  warnings: string[];
  /** How many problems the simulation found in it. */
  problems: number;
  /** The point of the list the stock is shown at after it. */
  at?: number;
}

/** One line of the list: something to cut, or a step done by hand. */
type Row = Cut | { kind: "hand"; key: string; name: string; type: StepType; color?: string; seat: string; notes: string[]; at: number };

/** Everything there is to cut and to do, in the order to do it: a part is cut before the glue-up that needs it. */
function rowsOf(result: StockTimeline, steps: Step[]): Row[] {
  const out: Row[] = [];
  const shown = new Set<string>();
  const part = (inlayId: string) => {
    const found = result.parts.find((p) => p.stepId === inlayId);
    const inlay = steps.find((j) => j.id === inlayId);
    if (!found || !inlay || shown.has(inlayId)) return;
    shown.add(inlayId);
    const what = partName("plug", inlay) === "insert" ? "inserts" : "plug";
    out.push({
      kind: "cut",
      key: `part ${inlayId}`,
      stepId: inlayId,
      run: null,
      name: `${inlay.name}, ${what}`,
      type: inlay.task.type,
      stats: found.built?.stats ?? null,
      errors: found.errors,
      warnings: [],
      problems: found.problems.length,
    });
  };
  result.steps.forEach((step, index) => {
    const listed = steps.find((j) => j.id === step.stepId);
    // Left out: there is nothing to cut or to do.
    if (!listed || step.suppressed) return;
    if (step.byHand) {
      const inlay = isByHand(listed.task) ? steps.find((j) => j.id === (listed.task as { inlayId: string }).inlayId) : undefined;
      if (inlay) part(inlay.id);
      out.push({
        kind: "hand",
        key: `hand ${step.stepId}`,
        name: listed.name,
        type: listed.task.type,
        color: inlay ? stepColor(inlay, steps) : undefined,
        seat: step.seat ? `Its top is ${aboveOrBelow(step.seat.above)} the surface.` : "",
        notes: step.errors,
        at: index + 1,
      });
      return;
    }
    out.push({
      kind: "cut",
      key: `stock ${step.stepId}`,
      stepId: step.stepId,
      run: step.file,
      name: isInlay(listed.task) ? `${listed.name}, pocket` : listed.name,
      type: listed.task.type,
      stats: step.stats,
      errors: step.errors,
      warnings: step.warnings,
      problems: step.problems.length,
      at: index + 1,
    });
  });
  // Parts that no glue-up in the list asks for yet.
  for (const p of result.parts) part(p.stepId);
  return out;
}

/** A file that the ticks come to. */
interface Out {
  key: string;
  cuts: Cut[];
  /** The file, once it is there. */
  built: Built | null;
  /** Why it cannot be made. */
  errors: string[];
}

/** Files joined from some of the entries between two steps done by hand, by the ids of those entries, for one working out of the list. */
interface Joined {
  of: Timeline | null;
  files: Record<string, Built | string[]>;
}

const short = (minutes: number) => (minutes < 1 ? "< 1 min" : formatMinutes(minutes));

/**
 * What of the project to export, as a tab of the panel: everything there is
 * to cut, in the order to do it, each with a tick; the steps done by hand
 * stand between. What is ticked on one board, between two steps done by
 * hand, comes to one file. The list is worked out the first time the tab is
 * shown.
 */
export function ExportList() {
  const { project, timeline } = useApp();
  const dispatch = useDispatch();
  const { busy, task, calledOff, workOut } = useWorkOut();
  const joining = useTask(FILES);
  const result = timeline?.result ?? null;
  const started = useRef(false);
  useEffect(() => {
    // Not what was called off: that is started again by asking for it.
    if (timeline !== null || started.current || stockCalledOff(project)) return;
    started.current = true;
    // Nothing made yet: make it now, without changing what the stage shows.
    void workOut();
    // Once, when the tab is first shown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Names and colours are those of the project as it was when the list was worked out.
  const made = timeline?.project ?? project;
  const stale = timeline !== null && made !== project;
  const rows = useMemo(() => (result ? rowsOf(result, made.steps) : []), [result, made]);
  // Everything is ticked until it is unticked.
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const cuts = rows.filter((row): row is Cut => row.kind === "cut");
  const can = (cut: Cut) => cut.stats !== null;
  const picked = cuts.filter((cut) => can(cut) && !off.has(cut.key));
  const tick = (key: string, on: boolean) =>
    setOff((was) => {
      const next = new Set(was);
      if (on) next.delete(key);
      else next.add(key);
      return next;
    });

  // The files the ticks come to, in the order of the list.
  const [joined, setJoined] = useState<Joined>({ of: null, files: {} });
  const have = joined.of === timeline ? joined.files : {};
  const outs: Out[] = [];
  const wanted: string[] = [];
  for (const cut of picked) {
    if (cut.run === null) {
      outs.push({ key: cut.key, cuts: [cut], built: result?.parts.find((p) => p.stepId === cut.stepId)?.built ?? null, errors: [] });
      continue;
    }
    if (outs.some((o) => o.cuts[0].run === cut.run)) continue;
    const mine = picked.filter((c) => c.run === cut.run);
    const file = result?.files[cut.run];
    // The whole stretch is the file there is already; less of it is joined when asked for.
    if (file && file.complete && file.built && mine.length === file.stepIds.length) {
      outs.push({ key: `run ${cut.run}`, cuts: mine, built: file.built, errors: [] });
      continue;
    }
    const ids = mine.map((c) => c.stepId).join("\n");
    const got = have[ids];
    outs.push({ key: `run ${cut.run}`, cuts: mine, built: got && !Array.isArray(got) ? got : null, errors: Array.isArray(got) ? got : [] });
    if (!got) wanted.push(ids);
  }

  const asked = useRef<{ of: Timeline | null; ids: Set<string> }>({ of: null, ids: new Set() });
  const wantedKey = wanted.join("\n\n");
  useEffect(() => {
    if (!timeline || stale || wanted.length === 0) return;
    if (asked.current.of !== timeline) asked.current = { of: timeline, ids: new Set() };
    for (const ids of wanted) {
      if (asked.current.ids.has(ids)) continue;
      asked.current.ids.add(ids);
      const put = (value: Built | string[]) => setJoined((was) => ({ of: timeline, files: { ...(was.of === timeline ? was.files : {}), [ids]: value } }));
      joinedFile(timeline.project, ids.split("\n")).then(put, (e) => put(message(e).split("\n")));
    }
    // `wanted` is what `wantedKey` says.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, timeline, stale]);

  const show = (at: number) => {
    dispatch({ type: "setTimelineAt", at });
    dispatch({ type: "setStage", stage: "timeline" });
  };
  const ready = outs.filter((o) => o.built !== null);
  const waiting = outs.some((o) => o.built === null && o.errors.length === 0);
  const minutes = ready.reduce((sum, o) => sum + (o.built ? o.built.stats.minutes + o.built.stats.toolChangeMinutes : 0), 0);
  const numbers = [...new Set(ready.flatMap((o) => o.built?.stats.perTool.map((t) => t.number) ?? []))].sort((a, b) => a - b);
  const download = () => {
    for (const o of ready) if (o.built) downloadText(o.built.fileName, o.built.gcode, "text/plain");
  };

  // The stock's lines as they come to files: the lines from one step done by hand to the next together, and the steps done by hand between them.
  type Hand = Exclude<Row, Cut>;
  const stock: ({ cuts: Cut[] } | Hand)[] = [];
  for (const row of rows) {
    if (row.kind === "hand") {
      stock.push(row);
      continue;
    }
    if (row.run === null) continue;
    const last = stock[stock.length - 1];
    if (last && "cuts" in last) last.cuts.push(row);
    else stock.push({ cuts: [row] });
  }
  const plugs = cuts.filter((cut) => cut.run === null);

  const line = (row: Cut) => {
    const on = can(row) && !off.has(row.key);
    const at = row.at;
    return (
      <li className="export-row" key={row.key}>
        <label>
          <input type="checkbox" checked={on} disabled={!can(row)} onChange={(e) => tick(row.key, e.target.checked)} />
          <span className="job-icon">
            <StepIcon type={row.type} />
          </span>
          <span className="export-name">{row.name}</span>
        </label>
        {row.stats && (
          <span className="export-tools" title={row.stats.perTool.map((t) => `T${t.number}: ${t.name}`).join(", ")}>
            {row.stats.perTool.map((t) => `T${t.number}`).join(" ")}
          </span>
        )}
        <span className="export-time">{row.stats ? short(row.stats.minutes) : ""}</span>
        {at !== undefined && (
          <button className="link export-show" onClick={() => show(at)} title="Show the stock after this step in 3D" aria-label={`Show the stock after "${row.name}" in 3D`}>
            3D
          </button>
        )}
        {(row.errors.length > 0 || row.problems > 0 || row.warnings.length > 0) && (
          <span className="export-notes">
            {row.errors.length > 0 && <span>Cannot be made: {row.errors.join(" ")}</span>}
            {row.problems > 0 && (
              <span>
                The simulation found {row.problems} problem{row.problems === 1 ? "" : "s"}. Do not run this.
              </span>
            )}
            {row.warnings.map((text) => (
              <span key={text}>{text}</span>
            ))}
          </span>
        )}
      </li>
    );
  };
  /** What comes to one file, in a frame: its lines, and under them the file the ticked ones make. */
  const card = (key: string, lines: Cut[], out: Out | undefined) => (
    <li className="export-card" key={key}>
      <ul>{lines.map(line)}</ul>
      <div className="export-file">
        {!out ? (
          <span className="muted">No file: nothing is ticked here.</span>
        ) : (
          <>
            <span className="export-file-name">{out.built ? out.built.fileName : out.errors.length > 0 ? "No file" : "Making the file…"}</span>
            <span className="export-time">{out.built ? short(out.built.stats.minutes + out.built.stats.toolChangeMinutes) : ""}</span>
            {out.errors.length > 0 && <span className="export-notes">{out.errors.join(" ")}</span>}
            {out.built && <BeforeCut texts={out.built.before} />}
            {!out.built && out.errors.length === 0 && joining?.shown && (
              <div className="progress-bar" aria-hidden="true">
                <span className="now" />
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );

  return (
    <section className="export">
      {timeline === null && !busy && calledOff ? (
        <p className="callout" role="status">
          Cancelled: the files are not made.{" "}
          <button className="link" onClick={() => workOut()}>
            Make them
          </button>
        </p>
      ) : (
        (busy || timeline === null) &&
        (task?.shown ? (
          <ProgressLine task={task} />
        ) : (
          <p className="status-line" role="status">
            Making the files and cutting the stock with them…
          </p>
        ))
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
      {!busy && stale && (
        <p className="callout warn">
          The project has changed since this was worked out.{" "}
          <button className="link" onClick={() => workOut()}>
            Work it out again
          </button>{" "}
          before downloading.
        </p>
      )}
      {!busy && result && (
        <>
          <div className="export-head">
            <span className="muted">Tick what to cut now.</span>
            <button className="link" onClick={() => setOff(new Set())}>
              All
            </button>
            <button className="link" onClick={() => setOff(new Set(cuts.map((c) => c.key)))}>
              None
            </button>
          </div>
          <h3 className="export-board">The stock</h3>
          <ul className="export-rows">
            {stock.map((group) =>
              "cuts" in group ? (
                card(`run ${group.cuts[0].run}`, group.cuts, outs.find((o) => o.cuts[0].run === group.cuts[0].run))
              ) : (
                <li className="export-hand" key={group.key}>
                  <span className="job-icon" style={group.color ? { color: group.color } : undefined}>
                    <StepIcon type={group.type} />
                  </span>
                  <button className="link" onClick={() => show(group.at)} title={`${group.seat} Show the stock after this step in 3D`.trim()}>
                    {group.name}
                  </button>
                  <span className="muted">by hand</span>
                  {group.notes.length > 0 && <span className="export-notes">{group.notes.join(" ")}</span>}
                </li>
              ),
            )}
          </ul>
          {plugs.length > 0 && (
            <>
              <h3 className="export-board">
                Plugs and inserts <span className="muted">each on a board of its own</span>
              </h3>
              <ul className="export-rows">{plugs.map((cut) => card(cut.key, [cut], outs.find((o) => o.key === cut.key)))}</ul>
            </>
          )}
          <p className="muted export-origin">The work origin of every file is its board's bottom-left corner, on its top face.</p>
          <div className="export-foot">
            <button className="primary" disabled={stale || waiting || ready.length === 0} onClick={download}>
              {waiting ? (
                <>
                  <Spinner /> {ready.length} of {outs.length} files ready
                </>
              ) : ready.length > 1 ? (
                `Download ${ready.length} files`
              ) : (
                "Download file"
              )}
            </button>
            <span className="muted">
              {outs.length === 0
                ? "Nothing is ticked."
                : waiting
                  ? "Making the files…"
                  : `About ${formatMinutes(minutes)} of cutting. Tools: ${numbers.map((n) => `T${n}`).join(", ")}.`}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
