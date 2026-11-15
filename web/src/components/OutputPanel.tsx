import { useEffect, useRef, useState } from "react";
import { core } from "../core/client";
import type { FitCheck, Job, Part, PocketPreview, Project } from "../core/types";
import { fmt } from "../state/model";
import { message, useApp, useDispatch, type Output, type Stage } from "../state/store";
import { downloadText } from "../util/files";

/** What the second part of an inlay is called: a plug for a V-carve inlay, an insert for a flat one. */
export function partName(part: Part, job: Job): string {
  return part === "pocket" ? "pocket" : job.inlay.type === "vcarve" || job.inlay.insertStyle === "backer" ? "plug" : "insert";
}

function capital(text: string): string {
  return text.replace(/^./, (c) => c.toUpperCase());
}

/**
 * Generating an inlay's files: both parts are built and simulated, and for a
 * V-carve inlay the plug is then fitted into the pocket.
 */
export function useOutput(job: Job) {
  const { project, output } = useApp();
  const dispatch = useDispatch();
  // What is being worked on right now, in words, or null when idle.
  const [busy, setBusy] = useState<string | null>(null);

  const mine = output?.jobId === job.id ? output : null;
  // Any edit since generating may have changed the result.
  const stale = mine !== null && mine.project !== project;
  // What has to be chosen before anything can be made.
  const missing =
    job.regionIds.length === 0
      ? "Click shapes in the drawing to add them to this inlay first."
      : job.inlay.type === "vcarve" && job.inlay.vbitToolId === null
        ? "Choose a V-bit first, under Wood and tools."
        : job.inlay.type === "flat" && job.inlay.clearingToolIds.length === 0
          ? "Choose an end mill first, under Wood and tools."
          : null;

  const generate = async () => {
    const out: Output = { jobId: job.id, project, parts: {}, errors: [], fit: null, fitErrors: [] };
    const publish = () => dispatch({ type: "setOutput", output: { ...out, parts: { ...out.parts }, errors: [...out.errors] } });
    const vcarve = job.inlay.type === "vcarve";
    const steps = vcarve ? 3 : 2;
    try {
      for (const [i, part] of (["pocket", "plug"] as Part[]).entries()) {
        setBusy(`Working out the ${partName(part, job)} (step ${i + 1} of ${steps})…`);
        try {
          out.parts[part] = await core.call("previewPart", project, job.id, part);
        } catch (e) {
          for (const line of message(e).split("\n")) if (!out.errors.includes(line)) out.errors.push(line);
        }
        publish();
      }
      if (vcarve && out.parts.pocket && out.parts.plug) {
        setBusy(`Fitting the plug into the pocket (step 3 of 3)…`);
        try {
          out.fit = await core.call("checkFit", project, job.id);
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
export function GenerateBar({ job, state }: { job: Job; state: OutputState }) {
  const { mine, stale, busy, missing, generate } = state;
  const second = partName("plug", job);
  const status = busy
    ? busy
    : missing
      ? missing
      : !mine
      ? `Makes the pocket file and the ${second} file${job.inlay.type === "vcarve" ? ", and checks how they fit" : ""}.`
      : stale
        ? "Settings have changed since the files were made."
        : mine.errors.length > 0
          ? "Not everything could be made. See why above."
          : "The files match the current settings.";
  return (
    <div className="generate-bar">
      <button className="primary" disabled={busy !== null || missing !== null} onClick={generate}>
        {busy ? "Working…" : mine ? "Generate again" : "Generate files"}
      </button>
      <p className={`bar-status${!busy && (missing || (mine && stale)) ? " warn" : ""}`} role="status">
        {status}
      </p>
    </div>
  );
}

/** What was generated: each file with its checks, and how the two parts fit. */
export function Results({ job, state }: { job: Job; state: OutputState }) {
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
      <h3>Files</h3>
      {stale && (
        <p className="callout warn">Settings have changed since these were made. Generate again before downloading.</p>
      )}
      {mine.errors.length > 0 && (
        <div className="callout error" role="alert">
          <p>{Object.keys(mine.parts).length === 0 ? "The files could not be made:" : "One file could not be made:"}</p>
          <ul>
            {mine.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
      {(["pocket", "plug"] as Part[]).map((part) => {
        const preview = mine.parts[part];
        return preview ? (
          <PartCard key={part} name={partName(part, job)} job={job} preview={preview} stale={stale} shown={stage === part} onShow={() => show(part)} />
        ) : null;
      })}

      {job.inlay.type === "vcarve" && (mine.fit || mine.fitErrors.length > 0) && (
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
          {mine.fit && <FitNumbers check={mine.fit} tipRise={tipRise(mine.project, job)} />}
        </section>
      )}
      {flatFit && (
        <section className="card">
          <header className="card-head">
            <h4>Fit</h4>
          </header>
          <FlatFitNumbers fit={flatFit} backer={job.inlay.type === "flat" && job.inlay.insertStyle === "backer"} />
        </section>
      )}
    </div>
  );
}

function PartCard(props: { name: string; job: Job; preview: PocketPreview; stale: boolean; shown: boolean; onShow: () => void }) {
  const { preview, name } = props;
  const { built } = preview;
  const tools = built.stats.perTool;
  const inlay = props.job.inlay;
  const board =
    built.part === "pocket" ? "Base board" : inlay.cutOut ? "Board, at least" : inlay.type === "vcarve" ? "Plug blank" : inlay.insertStyle === "backer" ? "Plug blank" : "Insert board";
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
          about {formatMinutes(built.stats.minutes)}, plus {built.stats.toolChanges === 1 ? "loading the tool" : `${built.stats.toolChanges} tool changes`}
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

/**
 * How high a V-bit's tip flat can hold a plug off at a sharp corner, mm: the
 * pocket's corner is rounded to the flat's radius while the plug's stays
 * sharp, and the plug has to rise by that radius over the wall's slope to
 * clear it. 0 for a pointed bit.
 */
function tipRise(project: Project, job: Job): number {
  const bit = job.inlay.type === "vcarve" ? project.tools.find((t) => t.id === (job.inlay as { vbitToolId: string | null }).vbitToolId) : undefined;
  if (!bit || !bit.tipDiameter || !bit.tipAngle) return 0;
  return bit.tipDiameter / 2 / Math.tan((bit.tipAngle * Math.PI) / 360);
}

function FitNumbers({ check, tipRise }: { check: FitCheck; tipRise: number }) {
  const r = check.report;
  const seat =
    Math.abs(r.proud) < 0.03
      ? "at the designed depth"
      : r.proud > 0
        ? `${mm(r.proud)} mm higher than designed`
        : `${mm(-r.proud)} mm lower than designed`;
  // A gap under a tenth of a millimetre is a hairline that glue and sanding dust fill.
  const seated = Math.abs(r.proud) < 0.03 && r.pressOverlap < 0.05 && check.problems === 0;
  // Held off by a little wood in a few places, as the bit's tip flat leaves in sharp corners.
  const pressesHome = check.problems === 0 && r.proud > 0 && r.pressOverlap < Math.max(0.2, tipRise + 0.05) && r.pressOverlapArea < 5;
  const good = seated && r.voidWidth < 0.1;
  const verdict = !seated
    ? pressesHome
      ? `The plug seats once pressed: up to ${mm(r.pressOverlap)} mm of wood has to give, over ${mm(r.pressOverlapArea)} mm² in all. Sharp corners do this when the V-bit's tip is not a true point: clamp the plug down firmly, or use a bit with a smaller tip flat.`
      : "The plug does not seat as designed. Check the numbers below."
    : r.voidArea < 0.005
      ? "The plug seats as designed, with no visible gaps."
      : good
        ? "The plug seats as designed. Gaps in the face are hairlines at most."
        : "The plug seats, but the finished face will show gaps.";
  return (
    <>
      <p className={good ? "ok" : "warn"}>{verdict}</p>
      <dl className="stats">
        <dt>Plug rests</dt>
        <dd>
          {seat}; first touches at X {mm(r.firstContact[0])}, Y {mm(r.firstContact[1])} mm
        </dd>
        <dt>Pressed home</dt>
        <dd>
          {r.pressOverlap < 0.01
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
          {r.voidArea < 0.005
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
        {fit.interferenceArea > 0.01
          ? `the insert overlaps the base board by ${mm(fit.interferenceArea)} mm²`
          : even
            ? `${mm(fit.gapMin)} mm all round`
            : `${mm(fit.gapMin)} to ${mm(fit.gapMax)} mm`}
      </dd>
      <dt>{backer ? "Backer sits" : "Insert stands"}</dt>
      <dd>{fit.proud < 0.005 ? (backer ? "on the surface" : "flush with the surface") : `${mm(fit.proud)} mm above the surface`}</dd>
      <dt>Against the drawing</dt>
      <dd>
        {fit.removedArea + fit.addedArea < 0.05
          ? "as drawn"
          : `${mm(fit.removedArea)} mm² left out, ${mm(fit.addedArea)} mm² added, where the tool cannot follow. The outline that is cut is dashed on the drawing.`}
      </dd>
    </dl>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes < 1) return "under a minute";
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  return `${Math.floor(whole / 60)} h ${whole % 60} min`;
}
