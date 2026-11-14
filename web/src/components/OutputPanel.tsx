import { useState } from "react";
import { core } from "../core/client";
import type { Job } from "../core/types";
import { fmt } from "../state/model";
import { message, useApp, useDispatch } from "../state/store";
import { downloadText } from "../util/files";

/** Generates a job's G-code, reports what the simulation found, and offers the file. */
export function OutputPanel({ job }: { job: Job }) {
  const { project, output } = useApp();
  const dispatch = useDispatch();
  const [busy, setBusy] = useState(false);

  const mine = output?.jobId === job.id ? output : null;
  // Any edit since generating may have changed the result.
  const stale = mine !== null && mine.project !== project;

  const generate = async () => {
    setBusy(true);
    try {
      const preview = await core.call("previewPocket", project, job.id);
      dispatch({ type: "setOutput", output: { jobId: job.id, project, preview, errors: [] } });
    } catch (e) {
      dispatch({ type: "setOutput", output: { jobId: job.id, project, preview: null, errors: message(e).split("\n") } });
    } finally {
      setBusy(false);
    }
  };

  const preview = mine?.preview ?? null;
  return (
    <div className="output">
      <h3>Output</h3>
      <p className="hint">
        {job.inlay.type === "vcarve"
          ? "Pocket only for now: the end mill clears the flat floor, then the V-bit cuts the walls and corners. The plug comes in a later version."
          : "Pocket only for now, cut to the tool's reach. The insert and the fit allowance come in a later version."}
      </p>
      <button className="primary" disabled={busy} onClick={generate}>
        {busy ? "Generating…" : mine ? "Generate pocket again" : "Generate pocket"}
      </button>

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
          <dl className="stats">
            <dt>{preview.built.stats.tools.length === 1 ? "Tool" : "Tools, in order"}</dt>
            <dd>{preview.built.stats.tools.map((name, i) => `T${i + 1} ${name}`).join(", ")}</dd>
            <dt>Cutting time</dt>
            <dd>about {formatMinutes(preview.built.stats.minutes)}, plus tool changes</dd>
            <dt>Cutting length</dt>
            <dd>{fmt(Math.round(preview.built.stats.cuttingLength) / 1000)} m</dd>
            <dt>File</dt>
            <dd>
              {preview.built.fileName}, {preview.built.stats.lines} lines
            </dd>
          </dl>

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
    </div>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes < 1) return "under a minute";
  const whole = Math.round(minutes);
  if (whole < 60) return `${whole} min`;
  return `${Math.floor(whole / 60)} h ${whole % 60} min`;
}
