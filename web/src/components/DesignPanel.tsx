import type { Design, ImportReport, Inlay, Job, Material, Tool, ToolKind } from "../core/types";
import { MATERIALS, describeTool, fmt, newJob, regionOwners, resolveTool, toolChoices } from "../state/model";
import { useFileActions } from "../state/files";
import { useApp, useDispatch } from "../state/store";
import { pickTextFile } from "../util/files";
import { jobColor } from "./DesignCanvas";
import { InlayDiagram } from "./InlayDiagram";
import { NumberField } from "./NumberField";
import { GenerateBar, Results, useOutput } from "./OutputPanel";

export function useImportSvg() {
  const { importSvg } = useFileActions();
  return async () => importSvg(await pickTextFile(".svg,image/svg+xml"));
}

/** The panel beside the drawing: the drawing and its inlays, or the one inlay being worked on. */
export function DesignPanel({ design }: { design: Design }) {
  const { project, importReport, activeJobId } = useApp();
  const importSvg = useImportSvg();
  const active = project.jobs.find((j) => j.id === activeJobId);

  if (active) return <JobEditor key={active.id} job={active} index={project.jobs.indexOf(active)} />;
  return (
    <aside className="panel" aria-label="Drawing and inlays">
      <div className="panel-scroll">
        <JobsSection design={design} />
        <DrawingSection design={design} report={importReport} onReplace={importSvg} />
      </div>
    </aside>
  );
}

export function ReportNotes({ report }: { report: ImportReport }) {
  const notes: string[] = [];
  if (report.openOutlines > 0) {
    const one = report.openOutlines === 1;
    notes.push(
      `${report.openOutlines} outline${one ? " does" : "s do"} not close and ${one ? "was" : "were"} left out. An inlay needs closed shapes: join the lines into closed paths in the drawing program.`,
    );
  }
  if (report.hasText) notes.push("The drawing contains text, which was left out. Convert it to outlines first.");
  if (report.images > 0) notes.push(`${report.images} embedded image${report.images === 1 ? " was" : "s were"} left out.`);
  if (report.specks > 0) notes.push(`${report.specks} speck${report.specks === 1 ? "" : "s"} smaller than 0.01 mm² ${report.specks === 1 ? "was" : "were"} left out.`);
  if (notes.length === 0) return null;
  return (
    <ul className="notes">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

function DrawingSection({ design, report, onReplace }: { design: Design; report: ImportReport | null; onReplace: () => void }) {
  const { project } = useApp();
  const dispatch = useDispatch();
  const setDesign = (change: Partial<Design>) =>
    dispatch({ type: "updateProject", update: (p) => (p.design ? { ...p, design: { ...p.design, ...change } } : p) });
  const scaled = Math.abs(design.scale - 1) > 1e-9;

  return (
    <section>
      <h2>Drawing and base board</h2>
      <p className="muted file-name">
        {design.sourceName}, {design.regions.length} shape{design.regions.length === 1 ? "" : "s"}
      </p>
      {report && <ReportNotes report={report} />}
      <div className="row">
        <NumberField
          label="Width"
          unit="mm"
          min={0.001}
          value={design.width * design.scale}
          onChange={(v) => v !== undefined && setDesign({ scale: v / design.width })}
        />
        <NumberField
          label="Height"
          unit="mm"
          min={0.001}
          value={design.height * design.scale}
          onChange={(v) => v !== undefined && setDesign({ scale: v / design.height })}
        />
        <NumberField
          label="Thickness"
          unit="mm"
          min={0.1}
          value={project.base.thickness}
          onChange={(v) => v !== undefined && dispatch({ type: "updateProject", update: (p) => ({ ...p, base: { thickness: v } }) })}
        />
      </div>
      <p className="hint">
        The drawing's page is the base board the pockets are cut into. Width and height scale the drawing together
        {scaled ? ` (drawn at ${fmt(design.width)} × ${fmt(design.height)} mm)` : ""}. The work origin is the board's bottom-left corner, on its top
        face.
      </p>
      <details className="more">
        <summary>More</summary>
        <label className="check">
          <input type="checkbox" checked={design.mirror} onChange={(e) => setDesign({ mirror: e.target.checked })} />
          Mirror left to right
        </label>
        <p className="hint">Only for a drawing that was made mirrored. Plugs are mirrored automatically.</p>
        <button
          onClick={() => {
            if (project.jobs.length === 0 || confirm("Replace the drawing? The inlays made from this one will be removed.")) onReplace();
          }}
        >
          Replace with another SVG…
        </button>
      </details>
    </section>
  );
}

function JobsSection({ design }: { design: Design }) {
  const { project, selection, tools } = useApp();
  const dispatch = useDispatch();
  const owners = regionOwners(project.jobs);
  const free = design.regions.filter((r) => !owners.has(r.id)).map((r) => r.id);

  const create = (type: Inlay["type"]) => {
    const job = newJob(type, selection, project.jobs);
    // Where the tool list leaves no choice, make it.
    const only = (kind: ToolKind) => {
      const ofKind = tools.filter((t) => t.kind === kind);
      return ofKind.length === 1 ? ofKind[0].id : null;
    };
    const endMill = only("flat_end");
    if (endMill) job.inlay.clearingToolIds = [endMill];
    if (job.inlay.type === "vcarve") job.inlay.vbitToolId = only("v_bit");
    dispatch({ type: "updateProject", update: (p) => ({ ...p, jobs: [...p.jobs, job] }) });
    dispatch({ type: "setActiveJob", id: job.id });
  };
  const count = `${selection.length} shape${selection.length === 1 ? "" : "s"}`;

  return (
    <section>
      <h2>Inlays</h2>
      {project.jobs.length > 0 && (
        <ul className="jobs">
          {project.jobs.map((job, index) => (
            <li key={job.id}>
              <button className="job" onClick={() => dispatch({ type: "setActiveJob", id: job.id })}>
                <span className="swatch" style={{ background: jobColor(index) }} />
                <span className="job-name">{job.name}</span>
                <span className="muted">
                  {job.inlay.type === "vcarve" ? "V-carve" : "Flat"}, {job.regionIds.length} shape{job.regionIds.length === 1 ? "" : "s"}
                </span>
                <span className="job-open" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="new-job">
        <h3>{project.jobs.length === 0 ? "Make the first inlay" : "Add an inlay"}</h3>
        {free.length === 0 ? (
          <p className="status-line">Every shape belongs to an inlay.</p>
        ) : (
          <>
            <p className="status-line" role="status">
              {selection.length === 0
                ? "Click the shapes in the drawing that will be cut from one wood. Then choose how to inlay them."
                : `${count} selected. Choose how to inlay ${selection.length === 1 ? "it" : "them"}:`}
            </p>
            <div className="choices">
              <button className="choice" disabled={selection.length === 0} onClick={() => create("vcarve")}>
                <strong>V-carve inlay</strong>
                <span>Sloped walls cut with a V-bit. Keeps sharp corners and fine detail. The plug is glued in and sawn off.</span>
              </button>
              <button className="choice" disabled={selection.length === 0} onClick={() => create("flat")}>
                <strong>Flat inlay</strong>
                <span>Upright walls cut with an end mill. Corners are rounded to the tool. The insert drops in.</span>
              </button>
            </div>
            <div className="row links">
              <button className="link" disabled={selection.length === free.length} onClick={() => dispatch({ type: "setSelection", ids: free })}>
                Select all {free.length} free shape{free.length === 1 ? "" : "s"}
              </button>
              {selection.length > 0 && (
                <button className="link" onClick={() => dispatch({ type: "setSelection", ids: [] })}>
                  Clear selection
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function JobEditor({ job, index }: { job: Job; index: number }) {
  const { project, tools } = useApp();
  const dispatch = useDispatch();
  const output = useOutput(job);
  const update = (change: Partial<Job>) => dispatch({ type: "updateJob", id: job.id, update: (j) => ({ ...j, ...change }) });
  const setInlay = (change: Partial<Inlay>) => update({ inlay: { ...job.inlay, ...change } as Inlay });
  const back = () => dispatch({ type: "setActiveJob", id: null });

  const remove = () => {
    if (!confirm(`Delete "${job.name}"? Its shapes become free again.`)) return;
    dispatch({ type: "updateProject", update: (p) => ({ ...p, jobs: p.jobs.filter((j) => j.id !== job.id) }) });
    dispatch({ type: "setActiveJob", id: null });
  };

  const inlay = job.inlay;
  const vbit = inlay.type === "vcarve" ? resolveTool(inlay.vbitToolId, tools, project) : undefined;
  const halfAngle = (((vbit?.tipAngle ?? 60) / 2) * Math.PI) / 180;
  const shapes = `${job.regionIds.length} shape${job.regionIds.length === 1 ? "" : "s"}`;

  return (
    <aside className="panel" aria-label={`Inlay ${job.name}`}>
      <div className="panel-scroll">
        <section>
          <div className="editor-head">
            <button className="link" onClick={back}>
              ‹ All inlays
            </button>
            <span className="tag">
              <span className="swatch" style={{ background: jobColor(index) }} />
              {inlay.type === "vcarve" ? "V-carve inlay" : "Flat inlay"}
            </span>
          </div>
          <label className="field">
            <span className="field-label">Name</span>
            <input type="text" value={job.name} onChange={(e) => update({ name: e.target.value })} />
          </label>
          <p className={`status-line${job.regionIds.length === 0 ? " warn" : ""}`}>
            {job.regionIds.length === 0 ? "No shapes yet." : `${shapes}.`} Click shapes in the drawing to add or remove them.
          </p>
        </section>

        <section>
          <h3>Depths and fit</h3>
          <InlayDiagram inlay={inlay} halfAngle={halfAngle} />
          {inlay.type === "vcarve" ? (
            <div className="row">
              <NumberField label="Engagement" unit="mm" min={0.01} value={inlay.engagementDepth} onChange={(v) => v !== undefined && setInlay({ engagementDepth: v })} />
              <NumberField label="Glue gap" unit="mm" value={inlay.glueGap} onChange={(v) => v !== undefined && setInlay({ glueGap: v })} />
              <NumberField label="Saw gap" unit="mm" min={0.01} value={inlay.sawGap} onChange={(v) => v !== undefined && setInlay({ sawGap: v })} />
            </div>
          ) : (
            <>
              <div className="row">
                <NumberField label="Pocket depth" unit="mm" min={0.01} value={inlay.pocketDepth} onChange={(v) => v !== undefined && setInlay({ pocketDepth: v })} />
                <NumberField label="Insert thickness" unit="mm" min={0.01} value={inlay.insertThickness} onChange={(v) => v !== undefined && setInlay({ insertThickness: v })} />
                <NumberField label="Fit allowance" unit="mm" value={inlay.allowance} onChange={(v) => v !== undefined && setInlay({ allowance: v })} />
              </div>
              <p className="hint">
                The allowance is the gap all round: half comes off the insert, half is added to the pocket. The insert is cut right through a board of
                the thickness given.
              </p>
            </>
          )}
          {inlay.type === "vcarve" && (
            <p className="hint">
              Engagement: how deep the plug goes in. Glue gap: space left under it. Saw gap: space above the surface for sawing the plug's backer
              off.
            </p>
          )}
        </section>

        <section>
          <h3>Wood and tools</h3>
          <label className="field">
            <span className="field-label">Wood</span>
            <select value={job.material} onChange={(e) => update({ material: e.target.value as Material })}>
              {MATERIALS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="hint">Picks which of each tool's cutting settings are used.</span>
          </label>
          {inlay.type === "vcarve" ? (
            <>
              <ToolPicker label="V-bit" kind="v_bit" value={inlay.vbitToolId} material={job.material} onChange={(id) => setInlay({ vbitToolId: id })} />
              <ClearingTools
                label="End mills for the flat floor"
                ids={inlay.clearingToolIds}
                material={job.material}
                onChange={(ids) => setInlay({ clearingToolIds: ids })}
                hint="Optional, but much quicker than the V-bit alone. Used in this order; each cuts only what those before it left."
              />
            </>
          ) : (
            <>
              <ClearingTools
                label="End mills"
                ids={inlay.clearingToolIds}
                material={job.material}
                onChange={(ids) => setInlay({ clearingToolIds: ids })}
                hint="One is enough. With several, they are used in this order and each cuts only what those before it left."
              />
              {(() => {
                const chosen = inlay.clearingToolIds.map((id) => resolveTool(id, tools, project)).filter((t): t is Tool => t !== undefined);
                if (chosen.length === 0) return null;
                const smallest = chosen.reduce((a, b) => (b.diameter < a.diameter ? b : a));
                return (
                  <p className="derived">
                    Corners are rounded to {fmt(smallest.diameter / 2)} mm, the radius of{" "}
                    {chosen.length > 1 ? `the smallest tool, "${smallest.name}", which also cuts the insert out` : "this tool"}.
                  </p>
                );
              })()}
            </>
          )}
        </section>

        <section>
          <details className="more">
            <summary>{inlay.type === "vcarve" ? "Plug blank" : "Insert board"}</summary>
            {inlay.type === "vcarve" ? (
              <div className="row">
                <NumberField label="Thickness" unit="mm" min={0.01} value={inlay.plugThickness} onChange={(v) => v !== undefined && setInlay({ plugThickness: v })} />
                <NumberField label="Margin" unit="mm" min={0.01} value={inlay.plugMargin} onChange={(v) => v !== undefined && setInlay({ plugMargin: v })} />
              </div>
            ) : (
              <>
                <NumberField label="Margin" unit="mm" min={0.01} value={inlay.insertMargin} onChange={(v) => v !== undefined && setInlay({ insertMargin: v })} />
                <label className="check">
                  <input type="checkbox" checked={inlay.tabs} onChange={(e) => setInlay({ tabs: e.target.checked })} />
                  Hold the insert with tabs
                </label>
                <p className="hint">Tabs keep the insert attached to its board until you cut it free. Without them, hold it down with tape.</p>
              </>
            )}
            <p className="hint">
              The {inlay.type === "vcarve" ? "plug blank" : "insert board"} is the shapes' outer size plus the margin on every side. Its exact size
              is given with the file.
            </p>
          </details>
        </section>

        <section>
          <Results job={job} state={output} />
          <div className="row end">
            <button className="danger" onClick={remove}>
              Delete inlay
            </button>
          </div>
        </section>
      </div>
      <GenerateBar job={job} state={output} />
    </aside>
  );
}

/** An ordered list of end mills: add, remove, and move up or down. */
function ClearingTools(props: { label: string; ids: string[]; material: Material; hint: string; onChange: (ids: string[]) => void }) {
  const { tools, project } = useApp();
  const dispatch = useDispatch();
  const { ids } = props;
  const choices = toolChoices("flat_end", tools, project);
  const free = choices.filter((t) => !ids.includes(t.id));
  const chosen = ids.map((id) => ({ id, tool: resolveTool(id, tools, project) }));
  const sizes = chosen.map((c) => c.tool?.diameter ?? 0);
  const largestFirst = sizes.every((d, i) => i === 0 || d <= sizes[i - 1]);
  const move = (from: number, to: number) => {
    const next = [...ids];
    next.splice(to, 0, ...next.splice(from, 1));
    props.onChange(next);
  };
  const sort = () =>
    props.onChange(
      [...chosen].sort((a, b) => (b.tool?.diameter ?? 0) - (a.tool?.diameter ?? 0)).map((c) => c.id),
    );

  return (
    <div className="field" role="group" aria-label={props.label}>
      <span className="field-label">{props.label}</span>
      {chosen.length > 0 && (
        <ol className="tool-order">
          {chosen.map(({ id, tool }, i) => (
            <li key={id}>
              <span className="tool-order-name">
                {tool ? tool.name : "Missing tool"}
                <span className="muted"> {tool ? `Ø${fmt(tool.diameter)} mm` : "no longer in the tool list or the project"}</span>
                {tool && !tool.cutting.some((c) => c.material === props.material) && (
                  <span className="hint warn">No cutting settings for {props.material}. Add them in the tool list.</span>
                )}
              </span>
              {chosen.length > 1 && (
                <>
                  <button type="button" className="small" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`Use ${tool?.name ?? "tool"} earlier`} title="Earlier">
                    ↑
                  </button>
                  <button
                    type="button"
                    className="small"
                    disabled={i === chosen.length - 1}
                    onClick={() => move(i, i + 1)}
                    aria-label={`Use ${tool?.name ?? "tool"} later`}
                    title="Later"
                  >
                    ↓
                  </button>
                </>
              )}
              <button type="button" className="small" onClick={() => props.onChange(ids.filter((other) => other !== id))} aria-label={`Remove ${tool?.name ?? "tool"}`} title="Remove">
                ×
              </button>
            </li>
          ))}
        </ol>
      )}
      {free.length > 0 && (
        <select
          value=""
          aria-label={chosen.length === 0 ? "Choose an end mill" : "Add another end mill"}
          onChange={(e) => e.target.value !== "" && props.onChange([...ids, e.target.value])}
        >
          <option value="">{chosen.length === 0 ? "Choose an end mill…" : "Add another end mill…"}</option>
          {free.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.name}
              {tools.some((t) => t.id === tool.id) ? "" : " (from this project)"}
            </option>
          ))}
        </select>
      )}
      {choices.length === 0 && (
        <span className="hint">
          No flat end mills in your tool list.{" "}
          <button type="button" className="link" onClick={() => dispatch({ type: "setView", view: "tools" })}>
            Add tools
          </button>
        </span>
      )}
      {!largestFirst && (
        <span className="hint warn">
          A smaller tool comes before a larger one, which leaves the larger one nothing to do.{" "}
          <button type="button" className="link" onClick={sort}>
            Put the largest first
          </button>
        </span>
      )}
      <span className="hint">{props.hint}</span>
    </div>
  );
}

function ToolPicker(props: { label: string; kind: ToolKind; value: string | null; material: Material; onChange: (id: string | null) => void }) {
  const { tools, project } = useApp();
  const dispatch = useDispatch();
  const choices = toolChoices(props.kind, tools, project);
  const chosen: Tool | undefined = resolveTool(props.value, tools, project);
  const inList = (tool: Tool) => tools.some((t) => t.id === tool.id);

  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <select value={chosen ? chosen.id : ""} onChange={(e) => props.onChange(e.target.value === "" ? null : e.target.value)}>
        <option value="">Choose…</option>
        {choices.map((tool) => (
          <option key={tool.id} value={tool.id}>
            {tool.name}
            {inList(tool) ? "" : " (from this project)"}
          </option>
        ))}
      </select>
      {choices.length === 0 && (
        <span className="hint">
          No {props.kind === "v_bit" ? "V-bits" : "flat end mills"} in your tool list.{" "}
          <button type="button" className="link" onClick={() => dispatch({ type: "setView", view: "tools" })}>
            Add tools
          </button>
        </span>
      )}
      {chosen && <span className="hint">{describeTool(chosen)}</span>}
      {chosen && !chosen.cutting.some((c) => c.material === props.material) && (
        <span className="hint warn">This tool has no cutting settings for {props.material}. Add them in the tool list.</span>
      )}
    </label>
  );
}
