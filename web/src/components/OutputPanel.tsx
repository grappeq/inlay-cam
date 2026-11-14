import { useState } from "react";
import { core } from "../core/client";
import type { Job, Part } from "../core/types";
import { fmt } from "../state/model";
import { message, useApp, useDispatch } from "../state/store";
import { downloadText } from "../util/files";

/** Generates a job's G-code, reports what the simulation found, and offers the file. */
export function OutputPanel({ job }: { job: Job }) {
  const { project, output } = useApp();
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
  const button = (part: Part) => (
    <button className={part === "pocket" || mine?.part === part ? "primary" : undefined} disabled={busy !== null} onClick={() => generate(part)}>
      {busy === part ? "Generating…" : mine?.part === part ? `Generate ${part} again` : `Generate ${part}`}
    </button>
  );

  const preview = mine?.preview ?? null;
  return (
    <div className="output">
      <h3>Output</h3>
      <p className="hint">
        {vcarve
          ? "Each part is its own file, cut from its own board. Pocket: the end mill clears the flat floor, then the V-bit cuts the walls and corners. Plug: the same, mirrored, around the shapes."
          : "Pocket only for now, cut to the tool's reach. The insert and the fit allowance come in a later version."}
      </p>
      <div className="row">
        {button("pocket")}
        {vcarve && button("plug")}
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
          <h4>{preview.built.part === "plug" ? "Plug" : "Pocket"}</h4>
          <dl className="stats">
            <dt>{preview.built.part === "plug" ? "Plug blank" : "Base board"}</dt>
            <dd>
              {fmt(Math.round(preview.built.stock.width * 100) / 100)} × {fmt(Math.round(preview.built.stock.height * 100) / 100)} mm,{" "}
              {fmt(preview.built.stock.thickness)} mm thick, work origin at its bottom-left corner
            </dd>
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
