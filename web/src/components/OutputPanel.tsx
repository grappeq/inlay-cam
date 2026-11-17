import { useEffect, useRef, useState } from "react";
import { core } from "../core/client";
import type { FitCheck, Step, Part, PocketPreview } from "../core/types";
import { STEP_LABELS, fmt, isInlay, missingFor, missingSettings } from "../state/model";
import { message, useApp, useDispatch, type Output, type Stage } from "../state/store";
import { downloadText } from "../util/files";

/**
 * What a part of a step is called. An inlay has a pocket and a second part: a
 * plug for a V-carve inlay, an insert for a flat one. A plain operation has
 * one part, named after what it does.
 */
export function partName(part: Part, step: Step): string {
  const inlay = step.task;
  if (!isInlay(inlay)) return STEP_LABELS[inlay.type].toLowerCase();
  return part === "pocket" ? "pocket" : inlay.type === "vcarve" || inlay.insertStyle === "backer" ? "plug" : "insert";
}

/** The parts a step has a file for. */
export function partsOf(step: Step): Part[] {
  return isInlay(step.task) ? ["pocket", "plug"] : ["pocket"];
}

function capital(text: string): string {
  return text.replace(/^./, (c) => c.toUpperCase());
}

/**
 * Generating an inlay's files: both parts are built and simulated, and for a
 * V-carve inlay the plug is then fitted into the pocket.
 */
export function useOutput(step: Step) {
  const { project, output, tools, lists } = useApp();
  const dispatch = useDispatch();
  // What is being worked on right now, in words, or null when idle.
  const [busy, setBusy] = useState<string | null>(null);

  const mine = output?.stepId === step.id ? output : null;
  // Any edit since generating may have changed the result.
  const stale = mine !== null && mine.project !== project;
  // What has to be chosen before anything can be made.
  const missing = missingFor(step) ?? missingSettings(step, [...project.tools, ...tools.filter((t) => !project.tools.some((p) => p.id === t.id))], lists);

  const generate = async () => {
    const out: Output = { stepId: step.id, project, parts: {}, errors: [], fit: null, fitErrors: [] };
    const publish = () => dispatch({ type: "setOutput", output: { ...out, parts: { ...out.parts }, errors: [...out.errors] } });
    const vcarve = step.task.type === "vcarve";
    const parts = partsOf(step);
    const steps = parts.length + (vcarve ? 1 : 0);
    try {
      for (const [i, part] of parts.entries()) {
        setBusy(steps === 1 ? `Working out the ${partName(part, step)}…` : `Working out the ${partName(part, step)} (step ${i + 1} of ${steps})…`);
        try {
          out.parts[part] = await core.call("previewPart", project, step.id, part);
        } catch (e) {
          for (const line of message(e).split("\n")) if (!out.errors.includes(line)) out.errors.push(line);
        }
        publish();
      }
      if (vcarve && out.parts.pocket && out.parts.plug) {
        setBusy(`Fitting the plug into the pocket (step 3 of 3)…`);
        try {
          out.fit = await core.call("checkFit", project, step.id);
        } catch (e) {
          out.fitErrors = message(e).split("\n");
        }
        publish();
      }
      const stage: Stage = out.fit ? "fit" : out.parts.pocket ? "pocket" : out.parts.plug ? "plug" : "drawing";
      dispatch({ type: "setStage", stage });
    } finally {
      setBusy(null);
    }
  };

  return { mine, stale, busy, missing, generate };
}

type OutputState = ReturnType<typeof useOutput>;

/** The bar at the foot of the panel: the one button that makes the files, and where things stand. */
export function GenerateBar({ step, state }: { step: Step; state: OutputState }) {
  const { mine, stale, busy, missing, generate } = state;
  const second = partName("plug", step);
  const single = !isInlay(step.task);
  const status = busy
    ? busy
    : missing
      ? missing
      : !mine
      ? single
        ? "Makes the file for this operation and simulates it."
        : `Makes the pocket file and the ${second} file${step.task.type === "vcarve" ? ", and checks how they fit" : ""}.`
      : stale
        ? "Settings have changed since the files were made."
        : mine.errors.length > 0
          ? "Not everything could be made. See why above."
          : "The files match the current settings.";
  return (
    <div className="generate-bar">
      <button className="primary" disabled={busy !== null || missing !== null} onClick={generate}>
        {busy ? "Working…" : mine ? "Generate again" : single ? "Generate file" : "Generate files"}
      </button>
      <p className={`bar-status${!busy && (missing || (mine && stale)) ? " warn" : ""}`} role="status">
        {status}
      </p>
    </div>
  );
}

/** What was generated: each file with its checks, and how the two parts fit. */
export function Results({ step, state }: { step: Step; state: OutputState }) {
  const { stage } = useApp();
  const dispatch = useDispatch();
  const { mine, stale, busy } = state;
  const top = useRef<HTMLDivElement>(null);
  // Bring fresh results into view: they appear below everything else in the panel.
  const finished = mine !== null && busy === null;
  const made = mine?.project;
  useEffect(() => {
    if (finished) top.current?.scrollIntoView({ block: "start" });
  }, [finished, made]);
  if (!mine) return null;
  const show = (to: Stage) => dispatch({ type: "setStage", stage: to });
  const flatFit = mine.parts.pocket?.built.flatFit ?? mine.parts.plug?.built.flatFit ?? null;

  return (
    <div className="results" ref={top}>
      <h3>{isInlay(step.task) ? "Files" : "File"}</h3>
      {stale && (
        <p className="callout warn">Settings have changed since these were made. Generate again before downloading.</p>
      )}
      {mine.errors.length > 0 && (
        <div className="callout error" role="alert">
          <p>
            {!isInlay(step.task) ? "The file could not be made:" : Object.keys(mine.parts).length === 0 ? "The files could not be made:" : "One file could not be made:"}
          </p>
          <ul>
            {mine.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
      {partsOf(step).map((part) => {
        const preview = mine.parts[part];
        return preview ? (
          <PartCard key={part} name={partName(part, step)} board={boardName(part, step)} preview={preview} stale={stale} shown={stage === part} onShow={() => show(part)} />
        ) : null;
      })}

      {step.task.type === "vcarve" && (mine.fit || mine.fitErrors.length > 0) && (
        <section className="card">
          <header className="card-head">
            <h4>Fit</h4>
            {mine.fit && (
              <button className="small" aria-pressed={stage === "fit"} onClick={() => show("fit")}>
                Show fit
              </button>
            )}
          </header>
          {mine.fitErrors.length > 0 && (
            <ul className="problems" role="alert">
              {mine.fitErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
          {mine.fit && <FitNumbers check={mine.fit} />}
        </section>
      )}
      {flatFit && (
        <section className="card">
          <header className="card-head">
            <h4>Fit</h4>
          </header>
          <FlatFitNumbers fit={flatFit} backer={step.task.type === "flat" && step.task.insertStyle === "backer"} />
        </section>
      )}
    </div>
  );
}

/** What the board a part is cut from is called. */
function boardName(part: Part, step: Step): string {
  const inlay = step.task;
  if (part === "pocket" || !isInlay(inlay)) return "Stock";
  return inlay.cutOut && (inlay.type === "vcarve" || inlay.insertStyle === "backer")
    ? "Board, at least"
    : inlay.type === "vcarve" || inlay.insertStyle === "backer"
      ? "Plug blank"
      : "Insert board";
}

/** One file as it came out: its checks, its numbers and its download. */
function PartCard(props: { name: string; board: string; preview: PocketPreview; stale: boolean; shown: boolean; onShow: () => void }) {
  const { preview, name, board } = props;
  const { built } = preview;
  const tools = built.stats.perTool;
  return (
    <section className="card">
      <header className="card-head">
        <h4>{capital(name)}</h4>
        <button className="small" aria-pressed={props.shown} onClick={props.onShow}>
          Show in 3D
        </button>
      </header>

      {preview.problems.length > 0 ? (
        <div className="callout error" role="alert">
          <p>The simulation found problems. Do not run this file.</p>
          <ul>
            {preview.problems.map((p) => (
              <li key={`${p.line}${p.message}`}>
                Line {p.line}: {p.message}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="ok">Simulated without problems.</p>
      )}

      <dl className="stats">
        <dt>{board}</dt>
        <dd>
          {mm(built.stock.width)} × {mm(built.stock.height)} × {fmt(built.stock.thickness)} mm
        </dd>
        <dt>Time</dt>
        <dd>
          {built.stats.toolChangeMinutes > 0
            ? `about ${formatMinutes(built.stats.minutes + built.stats.toolChangeMinutes)}, with ${built.stats.toolChanges === 1 ? "loading the tool" : `${built.stats.toolChanges} tool changes`}`
            : `about ${formatMinutes(built.stats.minutes)}, plus ${built.stats.toolChanges === 1 ? "loading the tool" : `${built.stats.toolChanges} tool changes`}`}
          {built.stock.through > 0 ? `; cuts ${fmt(built.stock.through)} mm past the bottom` : ""}
        </dd>
        <dt>{tools.length === 1 ? "Tool" : "Tools"}</dt>
        <dd>
          <ol className="tool-times">
            {tools.map((t) => (
              <li key={t.number}>
                T{t.number} {t.name}
                {tools.length > 1 && <span className="muted">, {formatMinutes(t.minutes)}</span>}
              </li>
            ))}
          </ol>
        </dd>
      </dl>

      {built.warnings.length > 0 && (
        <details className="more" open>
          <summary>
            {built.warnings.length} thing{built.warnings.length === 1 ? "" : "s"} to know before cutting
          </summary>
          <ul className="notes">
            {built.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </details>
      )}

      <button className="download" disabled={props.stale} onClick={() => downloadText(built.fileName, built.gcode, "text/plain")}>
        Download {name} file
      </button>
      <p className="hint file-name">
        {built.fileName}, {built.stats.lines} lines, {fmt(Math.round(built.stats.cuttingLength) / 1000)} m of cutting. The work origin is the
        board's bottom-left corner, on its top face. Run a new file above the board first: the app comes with no warranty.
      </p>
    </section>
  );
}

/** A length to two decimals, without trailing zeros. */
function mm(v: number): string {
  return fmt(Math.round(v * 100) / 100);
}

function FitNumbers({ check }: { check: FitCheck }) {
  const r = check.report;
  // The core judges the numbers; here they are only put into words.
  const { seat, gaps, atDepth, clear, good } = check.verdict;
  const rests = atDepth ? "at the designed depth" : r.proud > 0 ? `${mm(r.proud)} mm higher than designed` : `${mm(-r.proud)} mm lower than designed`;
  const verdict =
    seat === "pressed"
      ? `The plug seats once pressed: up to ${mm(r.pressOverlap)} mm of wood has to give, over ${mm(r.pressOverlapArea)} mm² in all. Sharp corners do this when the V-bit's tip is not a true point: clamp the plug down firmly, or use a bit with a smaller tip flat.`
      : seat === "no"
        ? "The plug does not seat as designed. Check the numbers below."
        : gaps === "none"
          ? "The plug seats as designed, with no visible gaps."
          : gaps === "hairlines"
            ? "The plug seats as designed. Gaps in the face are hairlines at most."
            : "The plug seats, but the finished face will show gaps.";
  return (
    <>
      <p className={good ? "ok" : "warn"}>{verdict}</p>
      <dl className="stats">
        <dt>Plug rests</dt>
        <dd>
          {rests}; first touches at X {mm(r.firstContact[0])}, Y {mm(r.firstContact[1])} mm
        </dd>
        <dt>Pressed home</dt>
        <dd>
          {clear
            ? "nothing in the way"
            : `wood must crush by up to ${mm(r.pressOverlap)} mm over ${mm(r.pressOverlapArea)} mm²`}
        </dd>
        <dt>Wall contact</dt>
        <dd>
          {Math.round(r.wallContact * 100)}% of the wall touches; largest gap {mm(r.wallGapMax)} mm, measured straight up
        </dd>
        <dt>Glue gap</dt>
        <dd>{r.glueGapMean === null ? "the pocket has no flat floor" : `${mm(r.glueGapMean)} mm on average, ${mm(r.glueGapMin ?? 0)} mm at least`}</dd>
        <dt>Finished face</dt>
        <dd>
          {gaps === "none"
            ? "no visible gaps"
            : `gaps of ${mm(r.voidArea)} mm² in total, up to ${mm(r.voidWidth)} mm wide`}
          , judged {mm(r.trimDepth)} mm below the surface
        </dd>
      </dl>
    </>
  );
}

function FlatFitNumbers({ fit, backer }: { fit: NonNullable<PocketPreview["built"]["flatFit"]>; backer: boolean }) {
  const even = Math.abs(fit.gapMax - fit.gapMin) < 0.02;
  return (
    <dl className="stats">
      <dt>Gap at the wall</dt>
      <dd>
        {fit.interferes
          ? `the insert overlaps the base board by ${mm(fit.interferenceArea)} mm²`
          : even
            ? `${mm(fit.gapMin)} mm all round`
            : `${mm(fit.gapMin)} to ${mm(fit.gapMax)} mm`}
      </dd>
      <dt>{backer ? "Backer sits" : "Insert stands"}</dt>
      <dd>{fit.proud < 0.005 ? (backer ? "on the surface" : "flush with the surface") : `${mm(fit.proud)} mm above the surface`}</dd>
      <dt>Against the drawing</dt>
      <dd>
        {fit.asDrawn
          ? "as drawn"
          : `${mm(fit.removedArea)} mm² left out, ${mm(fit.addedArea)} mm² added, where the tool cannot follow. The outline that is cut is dashed on the drawing.`}
      </dd>
    </dl>
  );
}

export function formatMinutes(minutes: number): string {
  if (minutes < 1) return "under a minute";
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  return `${Math.floor(whole / 60)} h ${whole % 60} min`;
}
