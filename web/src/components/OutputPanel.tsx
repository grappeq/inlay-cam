import { useState } from "react";
import { core } from "../core/client";
import type { FitCheck, Job, Part, PocketPreview } from "../core/types";
import { fmt } from "../state/model";
import { message, useApp, useDispatch } from "../state/store";
import { downloadText } from "../util/files";

/** Generates a job's G-code, reports what the simulation found, and offers the file. */
export function OutputPanel({ job }: { job: Job }) {
  const { project, output, fit } = useApp();
  const [checking, setChecking] = useState(false);
  const dispatch = useDispatch();
  const [busy, setBusy] = useState<Part | null>(null);

  const mine = output?.jobId === job.id ? output : null;
  // Any edit since generating may have changed the result.
  const stale = mine !== null && mine.project !== project;

  const generate = async (part: Part) => {
    setBusy(part);
    try {
      const preview = await core.call("previewPart", project, job.id, part);
      dispatch({ type: "setOutput", output: { jobId: job.id, part, project, preview, errors: [] } });
    } catch (e) {
      dispatch({ type: "setOutput", output: { jobId: job.id, part, project, preview: null, errors: message(e).split("\n") } });
    } finally {
      setBusy(null);
    }
  };
  const vcarve = job.inlay.type === "vcarve";
  const myFit = fit?.jobId === job.id ? fit : null;
  const checkFit = async () => {
    setChecking(true);
    try {
      const check = await core.call("checkFit", project, job.id);
      dispatch({ type: "setFit", fit: { jobId: job.id, project, check, errors: [] } });
    } catch (e) {
      dispatch({ type: "setFit", fit: { jobId: job.id, project, check: null, errors: message(e).split("\n") } });
    } finally {
      setChecking(false);
    }
  };
  // The second part is a plug for a V-carve inlay and an insert for a flat one.
  const nameOf = (part: Part) => (part === "pocket" ? "pocket" : vcarve ? "plug" : "insert");
  const button = (part: Part) => (
    <button className={part === "pocket" || mine?.part === part ? "primary" : undefined} disabled={busy !== null} onClick={() => generate(part)}>
      {busy === part ? "Generating…" : mine?.part === part ? `Generate ${nameOf(part)} again` : `Generate ${nameOf(part)}`}
    </button>
  );

  const preview = mine?.preview ?? null;
  return (
    <div className="output">
      <h3>Output</h3>
      <p className="hint">
        {vcarve
          ? "Each part is its own file, cut from its own board. Pocket: the end mill clears the flat floor, then the V-bit cuts the walls and corners. Plug: the same, mirrored, around the shapes."
          : "Each part is its own file, cut from its own board. Pocket: cleared flat to the pocket depth. Insert: the same shapes, smaller by the allowance, cut right out of the insert board the same way up."}
      </p>
      <div className="row">
        {button("pocket")}
        {button("plug")}
      </div>

      {mine && stale && <p className="hint warn">The inlay or project has changed since this was generated.</p>}

      {mine && mine.errors.length > 0 && (
        <ul className="problems" role="alert">
          {mine.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}

      {preview && (
        <>
          <h4>{nameOf(preview.built.part).replace(/^./, (c) => c.toUpperCase())}</h4>
          <dl className="stats">
            <dt>{preview.built.part === "pocket" ? "Base board" : vcarve ? "Plug blank" : "Insert board"}</dt>
            <dd>
              {fmt(Math.round(preview.built.stock.width * 100) / 100)} × {fmt(Math.round(preview.built.stock.height * 100) / 100)} mm,{" "}
              {fmt(preview.built.stock.thickness)} mm thick, work origin at its bottom-left corner
            </dd>
            <dt>{preview.built.stats.perTool.length === 1 ? "Tool" : "Tools, in order"}</dt>
            <dd>
              {preview.built.stats.perTool.length === 1 ? (
                `T${preview.built.stats.perTool[0].number} ${preview.built.stats.perTool[0].name}`
              ) : (
                <ol className="tool-times">
                  {preview.built.stats.perTool.map((t) => (
                    <li key={t.number}>
                      T{t.number} {t.name}: {formatMinutes(t.minutes)}
                    </li>
                  ))}
                </ol>
              )}
            </dd>
            <dt>Cutting time</dt>
            <dd>
              about {formatMinutes(preview.built.stats.minutes)}, plus{" "}
              {preview.built.stats.perTool.length === 1 ? "loading the tool" : `${preview.built.stats.perTool.length} tool changes`}
            </dd>
            <dt>Cutting length</dt>
            <dd>{fmt(Math.round(preview.built.stats.cuttingLength) / 1000)} m</dd>
            <dt>File</dt>
            <dd>
              {preview.built.fileName}, {preview.built.stats.lines} lines
            </dd>
          </dl>

          {preview.built.flatFit && <FlatFitNumbers fit={preview.built.flatFit} />}

          {preview.problems.length > 0 ? (
            <>
              <p className="form-error">The simulation found problems. Do not run this file.</p>
              <ul className="problems" role="alert">
                {preview.problems.map((p) => (
                  <li key={`${p.line}${p.message}`}>
                    Line {p.line}: {p.message}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="ok">The simulation found no problems: no rapid touches the stock and the depth suits the tool and board.</p>
          )}

          {preview.built.warnings.length > 0 && (
            <ul className="notes">
              {preview.built.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}

          <button disabled={stale} onClick={() => downloadText(preview.built.fileName, preview.built.gcode, "text/plain")}>
            Download {preview.built.fileName}
          </button>
          {stale && <p className="hint">Generate again to download a file that matches the current settings.</p>}
        </>
      )}
      {vcarve && (
        <div className="fit-report">
          <h3>Fit</h3>
          <p className="hint">Simulates both files, turns the plug over and lowers it into the pocket.</p>
          <button disabled={checking || busy !== null} onClick={checkFit}>
            {checking ? "Checking…" : myFit ? "Check fit again" : "Check fit"}
          </button>
          {myFit && myFit.project !== project && <p className="hint warn">The inlay or project has changed since the fit was checked.</p>}
          {myFit && myFit.errors.length > 0 && (
            <ul className="problems" role="alert">
              {myFit.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
          {myFit?.check && <FitNumbers check={myFit.check} />}
        </div>
      )}
    </div>
  );
}

/** A length to two decimals, without trailing zeros. */
function mm(v: number): string {
  return fmt(Math.round(v * 100) / 100);
}

function FitNumbers({ check }: { check: FitCheck }) {
  const r = check.report;
  const seat =
    Math.abs(r.proud) < 0.03
      ? "at the designed depth"
      : r.proud > 0
        ? `${mm(r.proud)} mm higher than designed`
        : `${mm(-r.proud)} mm lower than designed`;
  return (
    <>
      {check.problems > 0 && <p className="form-error">The simulation found problems in the files. Generate each part to see them.</p>}
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

function FlatFitNumbers({ fit }: { fit: NonNullable<PocketPreview["built"]["flatFit"]> }) {
  const even = Math.abs(fit.gapMax - fit.gapMin) < 0.02;
  return (
    <>
      <h4>Fit of insert in pocket</h4>
      <dl className="stats">
        <dt>Gap at the wall</dt>
        <dd>
          {fit.interferenceArea > 0.01
            ? `the insert overlaps the base board by ${mm(fit.interferenceArea)} mm²`
            : even
              ? `${mm(fit.gapMin)} mm all round`
              : `${mm(fit.gapMin)} to ${mm(fit.gapMax)} mm`}
        </dd>
        <dt>Insert stands</dt>
        <dd>{fit.proud < 0.005 ? "flush with the surface" : `${mm(fit.proud)} mm above the surface`}</dd>
        <dt>Against the drawing</dt>
        <dd>
          {fit.removedArea + fit.addedArea < 0.05
            ? "as drawn"
            : `${mm(fit.removedArea)} mm² left out, ${mm(fit.addedArea)} mm² added, where the tool cannot follow`}
        </dd>
      </dl>
    </>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes < 1) return "under a minute";
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  return `${Math.floor(whole / 60)} h ${whole % 60} min`;
}
