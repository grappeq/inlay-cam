import type { Design, ImportReport, Inlay, Job, Material, Tool, ToolKind } from "../core/types";
import { MATERIALS, describeTool, fmt, newJob, regionOwners, resolveTool, toolChoices } from "../state/model";
import { useFileActions } from "../state/files";
import { useApp, useDispatch } from "../state/store";
import { pickTextFile } from "../util/files";
import { jobColor } from "./DesignCanvas";
import { NumberField } from "./NumberField";
import { OutputPanel } from "./OutputPanel";

export function useImportSvg() {
  const { importSvg } = useFileActions();
  return async () => importSvg(await pickTextFile(".svg,image/svg+xml"));
}

export function DesignPanel() {
  const { project, importReport } = useApp();
  const importSvg = useImportSvg();
  const design = project.design;

  if (!design) {
    return (
      <aside className="panel">
        <section>
          <h2>Design</h2>
          <p className="muted">Import a drawing to start. Shapes must be filled, and text must be converted to outlines.</p>
          <button className="primary" onClick={importSvg}>
            Import SVG…
          </button>
          {importReport && <ReportNotes report={importReport} />}
        </section>
      </aside>
    );
  }

  return (
    <aside className="panel">
      <DesignSection design={design} report={importReport} onReplace={importSvg} />
      <JobsSection design={design} />
    </aside>
  );
}

function ReportNotes({ report }: { report: ImportReport }) {
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

function DesignSection({ design, report, onReplace }: { design: Design; report: ImportReport | null; onReplace: () => void }) {
  const dispatch = useDispatch();
  const setDesign = (change: Partial<Design>) =>
    dispatch({ type: "updateProject", update: (p) => (p.design ? { ...p, design: { ...p.design, ...change } } : p) });

  return (
    <section>
      <h2>Design</h2>
      <p className="muted file-name">{design.sourceName}</p>
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
      </div>
      <p className="hint">
        Imported at {fmt(design.width)} × {fmt(design.height)} mm. Width and height scale together.
      </p>
      <label className="check">
        <input type="checkbox" checked={design.mirror} onChange={(e) => setDesign({ mirror: e.target.checked })} />
        Mirror left to right
      </label>
      <p className="hint">Only for a drawing that was made mirrored. Plugs are mirrored automatically.</p>
      <BaseThickness />
      {report && <ReportNotes report={report} />}
      <button onClick={onReplace}>Replace with another SVG…</button>
    </section>
  );
}

function BaseThickness() {
  const { project } = useApp();
  const dispatch = useDispatch();
  return (
    <NumberField
      label="Base board thickness"
      unit="mm"
      min={0.1}
      value={project.base.thickness}
      onChange={(v) => v !== undefined && dispatch({ type: "updateProject", update: (p) => ({ ...p, base: { thickness: v } }) })}
      hint="The board the pockets are cut into. Its outline is the design's page, with the work origin at the bottom-left corner and Z0 on its top face."
    />
  );
}

function JobsSection({ design }: { design: Design }) {
  const { project, selection, activeJobId } = useApp();
  const dispatch = useDispatch();
  const owners = regionOwners(project.jobs);
  const free = design.regions.filter((r) => !owners.has(r.id)).map((r) => r.id);
  const active = project.jobs.find((j) => j.id === activeJobId);

  const create = (type: Inlay["type"]) => {
    const job = newJob(type, selection, project.jobs);
    dispatch({ type: "updateProject", update: (p) => ({ ...p, jobs: [...p.jobs, job] }) });
    dispatch({ type: "setActiveJob", id: job.id });
  };

  return (
    <section>
      <h2>Inlays</h2>
      {project.jobs.length === 0 && <p className="muted">No inlays yet. Select the shapes for one inlay, then choose its type.</p>}
      <ul className="jobs">
        {project.jobs.map((job, index) => (
          <li key={job.id}>
            <button
              className={`job${job.id === activeJobId ? " current" : ""}`}
              aria-pressed={job.id === activeJobId}
              onClick={() => dispatch({ type: "setActiveJob", id: job.id === activeJobId ? null : job.id })}
            >
              <span className="swatch" style={{ background: jobColor(index) }} />
              <span className="job-name">{job.name}</span>
              <span className="muted">
                {job.inlay.type === "vcarve" ? "V-carve" : "Flat"} · {job.regionIds.length} shape{job.regionIds.length === 1 ? "" : "s"}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {active ? (
        <JobEditor job={active} />
      ) : (
        <div className="new-job">
          <p className="status-line">
            {selection.length === 0
              ? free.length === 0
                ? "Every shape belongs to an inlay."
                : "Click shapes in the drawing to select them."
              : `${selection.length} shape${selection.length === 1 ? "" : "s"} selected.`}
          </p>
          <div className="row">
            <button disabled={free.length === 0} onClick={() => dispatch({ type: "setSelection", ids: free })}>
              Select all free
            </button>
            <button disabled={selection.length === 0} onClick={() => dispatch({ type: "setSelection", ids: [] })}>
              Clear
            </button>
          </div>
          <div className="row">
            <button className="primary" disabled={selection.length === 0} onClick={() => create("vcarve")}>
              New V-carve inlay
            </button>
            <button className="primary" disabled={selection.length === 0} onClick={() => create("flat")}>
              New flat inlay
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function JobEditor({ job }: { job: Job }) {
  const { project, tools } = useApp();
  const dispatch = useDispatch();
  const update = (change: Partial<Job>) => dispatch({ type: "updateJob", id: job.id, update: (j) => ({ ...j, ...change }) });
  const setInlay = (change: Partial<Inlay>) => update({ inlay: { ...job.inlay, ...change } as Inlay });

  const remove = () => {
    if (!confirm(`Delete "${job.name}"? Its shapes become free again.`)) return;
    dispatch({ type: "updateProject", update: (p) => ({ ...p, jobs: p.jobs.filter((j) => j.id !== job.id) }) });
    dispatch({ type: "setActiveJob", id: null });
  };

  const inlay = job.inlay;
  return (
    <div className="editor">
      <p className="status-line">Editing this inlay. Click shapes in the drawing to add or remove them.</p>
      <label className="field">
        <span className="field-label">Name</span>
        <input type="text" value={job.name} onChange={(e) => update({ name: e.target.value })} />
      </label>
      <label className="field">
        <span className="field-label">Wood</span>
        <select value={job.material} onChange={(e) => update({ material: e.target.value as Material })}>
          {MATERIALS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="hint">Chooses which of each tool's cutting settings are used.</span>
      </label>

      {inlay.type === "vcarve" ? (
        <>
          <NumberField
            label="Engagement depth"
            unit="mm"
            min={0.01}
            value={inlay.engagementDepth}
            onChange={(v) => v !== undefined && setInlay({ engagementDepth: v })}
            hint="How deep the plug sits in the pocket."
          />
          <NumberField
            label="Glue gap"
            unit="mm"
            value={inlay.glueGap}
            onChange={(v) => v !== undefined && setInlay({ glueGap: v })}
            hint="Space left under the plug."
          />
          <NumberField
            label="Saw gap"
            unit="mm"
            min={0.01}
            value={inlay.sawGap}
            onChange={(v) => v !== undefined && setInlay({ sawGap: v })}
            hint="Space between the surface and the plug's backer, for cutting it off."
          />
          <p className="derived">
            Pocket depth {fmt(inlay.engagementDepth + inlay.glueGap)} mm. Plug cut depth {fmt(inlay.engagementDepth + inlay.sawGap)} mm.
          </p>
          <NumberField
            label="Plug margin"
            unit="mm"
            min={0.01}
            value={inlay.plugMargin}
            onChange={(v) => v !== undefined && setInlay({ plugMargin: v })}
            hint="Blank left around the shapes on the plug. The plug blank is the shapes' outer size plus this on every side."
          />
          <NumberField
            label="Plug blank thickness"
            unit="mm"
            min={0.01}
            value={inlay.plugThickness}
            onChange={(v) => v !== undefined && setInlay({ plugThickness: v })}
          />
          <ToolPicker
            label="V-bit"
            kind="v_bit"
            value={inlay.vbitToolId}
            material={job.material}
            onChange={(id) => setInlay({ vbitToolId: id })}
          />
          <ClearingTools
            label="Clearing end mills"
            ids={inlay.clearingToolIds}
            material={job.material}
            onChange={(ids) => setInlay({ clearingToolIds: ids })}
            hint="They clear the flat floor before the V-bit, in this order. Each cuts only what those before it left. With none, the V-bit clears the floor on its own."
          />
        </>
      ) : (
        <>
          <NumberField
            label="Pocket depth"
            unit="mm"
            min={0.01}
            value={inlay.pocketDepth}
            onChange={(v) => v !== undefined && setInlay({ pocketDepth: v })}
          />
          <NumberField
            label="Fit allowance"
            unit="mm"
            value={inlay.allowance}
            onChange={(v) => v !== undefined && setInlay({ allowance: v })}
            hint="Gap between insert and pocket wall all round. Half comes off the insert, half is added to the pocket."
          />
          <NumberField
            label="Insert board thickness"
            unit="mm"
            min={0.01}
            value={inlay.insertThickness}
            onChange={(v) => v !== undefined && setInlay({ insertThickness: v })}
            hint="The insert is cut right through this board. Thicker than the pocket is deep, it stands proud to be sanded flush."
          />
          <NumberField
            label="Insert margin"
            unit="mm"
            min={0.01}
            value={inlay.insertMargin}
            onChange={(v) => v !== undefined && setInlay({ insertMargin: v })}
            hint="Board left around the shapes. The insert board is the shapes' outer size plus this on every side."
          />
          <label className="check">
            <input type="checkbox" checked={inlay.tabs} onChange={(e) => setInlay({ tabs: e.target.checked })} />
            Hold the insert with tabs
          </label>
          <ClearingTools
            label="End mills"
            ids={inlay.clearingToolIds}
            material={job.material}
            onChange={(ids) => setInlay({ clearingToolIds: ids })}
            hint="They cut the pocket in this order. Each cuts only what those before it left. One is enough; a large one first saves time."
          />
          {(() => {
            const chosen = inlay.clearingToolIds.map((id) => resolveTool(id, tools, project)).filter((t): t is Tool => t !== undefined);
            if (chosen.length === 0) return null;
            const smallest = chosen.reduce((a, b) => (b.diameter < a.diameter ? b : a));
            return (
              <p className="derived">
                Corners cannot be sharper than the radius of {chosen.length > 1 ? `the smallest, "${smallest.name}"` : "this tool"}:{" "}
                {fmt(smallest.diameter / 2)} mm.{chosen.length > 1 ? " It also cuts the insert out." : ""}
              </p>
            );
          })()}
        </>
      )}

      <OutputPanel job={job} />

      <div className="row">
        <button onClick={() => dispatch({ type: "setActiveJob", id: null })}>Done</button>
        <button className="danger" onClick={remove}>
          Delete inlay
        </button>
      </div>
    </div>
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
              <button type="button" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label={`Move ${tool?.name ?? "tool"} earlier`} title="Earlier">
                ↑
              </button>
              <button
                type="button"
                disabled={i === chosen.length - 1}
                onClick={() => move(i, i + 1)}
                aria-label={`Move ${tool?.name ?? "tool"} later`}
                title="Later"
              >
                ↓
              </button>
              <button type="button" onClick={() => props.onChange(ids.filter((other) => other !== id))} aria-label={`Remove ${tool?.name ?? "tool"}`} title="Remove">
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
        <option value="">Not chosen</option>
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
