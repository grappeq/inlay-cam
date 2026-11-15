import type { ChamferOp, ContourOp, Design, FacingOp, ImportReport, Inlay, Job, JobType, Material, PocketOp, Setup, Side, Tool, ToolKind, TrueInlay } from "../core/types";
import { boxOf, trimBoard } from "../state/arrange";
import {
  DEFAULT_STOCK_COLOR,
  JOB_LABELS,
  MATERIALS,
  SETUP_LIMITS,
  WOODS,
  cutOutDepth,
  describeTool,
  fmt,
  isInlay,
  jobColor,
  jobSetup,
  newJob,
  regionOwners,
  resolveTool,
  sameSetup,
  stockColor,
  toolChoices,
  usualCutOutTool,
} from "../state/model";
import { useFileActions } from "../state/files";
import { useApp, useDispatch } from "../state/store";
import { pickTextFile, pickTextFiles } from "../util/files";
import { InlayDiagram } from "./InlayDiagram";
import { ArrangePanel } from "./ArrangePanel";
import { NumberField } from "./NumberField";
import { GenerateBar, Results, StockFile, useOutput } from "./OutputPanel";
import { CutOutFields, HeightFields, TabFields } from "./SetupFields";

/** A job that is an inlay proper, with a pocket and a plug or insert. */
type InlayJob = Job & { inlay: TrueInlay };

const DRAWINGS = ".svg,.dxf,image/svg+xml";

/** Picks one or more drawings and puts them on the stock. */
export function useImportSvg() {
  const { addDrawings } = useFileActions();
  return async () => addDrawings(await pickTextFiles(DRAWINGS));
}

/** The panel beside the drawing: the stock with its inlays and operations, or the one being worked on. */
export function DesignPanel({ design }: { design: Design }) {
  const { project, importReport, activeJobId, arranging } = useApp();
  const active = project.jobs.find((j) => j.id === activeJobId);

  if (arranging) return <ArrangePanel design={design} />;
  if (active) return isInlay(active.inlay) ? <JobEditor key={active.id} job={active as InlayJob} /> : <OpEditor key={active.id} job={active} />;
  return (
    <aside className="panel" aria-label="Stock, inlays and operations">
      <div className="panel-scroll">
        <JobsSection design={design} />
        <StockFile />
        <StockSection design={design} report={importReport} />
      </div>
    </aside>
  );
}

export function ReportNotes({ report }: { report: ImportReport }) {
  const notes: string[] = [];
  if (report.openOutlines > 0) {
    const one = report.openOutlines === 1;
    notes.push(
      `${report.openOutlines} outline${one ? " does" : "s do"} not close and ${one ? "was" : "were"} left out. Lines are joined where their ends meet within 0.01 mm; close the gaps in the drawing program.`,
    );
  }
  if (report.unitNote) notes.push(`The drawing's unit: ${report.unitNote}. Check the size below.`);
  if (report.unsupported.length > 0) {
    notes.push(`Left out, because the app does not read ${report.unsupported.length === 1 ? "it" : "them"}: ${report.unsupported.join(", ")}.`);
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

/** A colour for a wood: a row of common woods, and any other colour. */
function ColorField({ label, value, onChange, hint }: { label: string; value: string; onChange: (color: string) => void; hint?: string }) {
  const current = value.toLowerCase();
  const wood = WOODS.find((w) => w.color === current);
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="field-label">
        {label}
        {wood ? <span className="muted"> {wood.name}</span> : null}
      </span>
      <div className="woods">
        {WOODS.map((w) => (
          <button
            key={w.color}
            type="button"
            className="wood"
            style={{ background: w.color }}
            aria-pressed={w.color === current}
            aria-label={w.name}
            title={w.name}
            onClick={() => onChange(w.color)}
          />
        ))}
        <input type="color" className="wood-other" value={current} aria-label={`${label}: another colour`} title="Another colour" onChange={(e) => onChange(e.target.value)} />
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** The stock: its size and wood, and the drawings whose shapes lie on it. */
function StockSection({ design, report }: { design: Design; report: ImportReport | null }) {
  const { project } = useApp();
  const dispatch = useDispatch();
  const addDrawing = useImportSvg();
  const { replaceDrawing } = useFileActions();
  const setDesign = (change: Partial<Design>) =>
    dispatch({ type: "editDrawing", update: (p) => (p.design ? { ...p, design: { ...p.design, ...change } } : p) });
  const setBase = (change: Partial<typeof project.base>) => dispatch({ type: "updateProject", update: (p) => ({ ...p, base: { ...p.base, ...change } }) });
  const count = design.regions.length;
  const box = boxOf(design.regions);
  const outside = box !== null && (box[0] < -1e-6 || box[1] < -1e-6 || box[2] > design.width + 1e-6 || box[3] > design.height + 1e-6);
  const machine = project.machine;
  const tooLarge = design.width > machine.travel[0] || design.height > machine.travel[1];

  return (
    <section>
      <h2>Stock and drawings</h2>
      <div className="row">
        <NumberField deferred label="Width (X)" unit="mm" min={1} value={round2(design.width)} onChange={(v) => v !== undefined && setDesign({ width: v })} />
        <NumberField deferred label="Height (Y)" unit="mm" min={1} value={round2(design.height)} onChange={(v) => v !== undefined && setDesign({ height: v })} />
        <NumberField label="Thickness" unit="mm" min={0.1} value={project.base.thickness} onChange={(v) => v !== undefined && setBase({ thickness: v })} />
      </div>
      <p className="hint">
        The stock is the board the pockets and the other operations are cut into. The work origin is its bottom-left corner, on its top face.
        Changing its size leaves the shapes as they are.
      </p>
      {outside && (
        <p className="status-line warn" role="status">
          Some shapes lie outside the stock. Move them, or{" "}
          <button type="button" className="link" onClick={() => box && setDesign({ width: Math.max(design.width, Math.ceil(box[2])), height: Math.max(design.height, Math.ceil(box[3])) })}>
            make the stock large enough
          </button>
          .
        </p>
      )}
      {tooLarge && (
        <p className="status-line warn" role="status">
          The stock is larger than the {machine.name} can travel ({fmt(machine.travel[0])} × {fmt(machine.travel[1])} mm). Files are refused only when their
          cuts span more than that.
        </p>
      )}
      <ColorField label="Wood" value={stockColor(project)} onChange={(color) => setBase({ color: color === DEFAULT_STOCK_COLOR ? undefined : color })} />

      <p className="muted file-name">
        {count === 0 ? "No shapes yet." : `${count} shape${count === 1 ? "" : "s"}${design.sourceName ? ` from ${design.sourceName}` : ""}.`}
      </p>
      {report && <ReportNotes report={report} />}
      <div className="row">
        <button onClick={addDrawing}>Add a drawing…</button>
        <button disabled={count === 0} onClick={() => dispatch({ type: "setArranging", on: true })}>
          Move, resize or delete shapes…
        </button>
      </div>
      <p className="hint">Shapes from several SVG or DXF files can lie on one stock. A drawing that is added comes in selected, to be put in its place.</p>
      <details className="more">
        <summary>More</summary>
        <div className="row">
          <button disabled={count === 0} onClick={() => dispatch({ type: "editDrawing", update: (p) => (p.design ? { ...p, design: trimBoard(p.design, 5) } : p) })}>
            Fit the stock to the shapes
          </button>
          <button
            onClick={async () => {
              const made = project.jobs.length;
              if (made === 0 || confirm("Replace the drawing? The inlays and operations made from this one will be removed.")) replaceDrawing(await pickTextFile(DRAWINGS));
            }}
          >
            Replace the drawing…
          </button>
        </div>
        <p className="hint">Fitting moves the shapes to 5 mm from the stock's left and bottom edges and trims it to 5 mm beyond them.</p>
      </details>
    </section>
  );
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** What a plain operation does, in a line. */
const OPERATION_HINTS: Record<"pocket" | "contour" | "chamfer" | "facing", string> = {
  pocket: "Clears the shapes to a flat floor with an end mill.",
  contour: "Cuts along the outlines of the shapes: round them, inside them or on them, to a depth or right through.",
  chamfer: "Bevels the top edge along the outlines with a V-bit.",
  facing: "Mills an area flat: the whole stock, or the rectangle around the shapes, as when trimming a glued-in plug flush.",
};

function describeJob(job: Job): string {
  const shapes = `${job.regionIds.length} shape${job.regionIds.length === 1 ? "" : "s"}`;
  const inlay = job.inlay;
  switch (inlay.type) {
    case "vcarve":
      return `V-carve inlay, ${shapes}`;
    case "flat":
      return `Flat inlay, ${shapes}`;
    case "pocket":
      return `Pocket ${fmt(inlay.depth)} mm deep, ${shapes}`;
    case "facing":
      return job.regionIds.length === 0 ? "Facing, the whole stock" : `Facing, over ${shapes}`;
    case "contour":
      return `Contour ${inlay.side === "on" ? "on the line" : inlay.side}, ${inlay.depth === null ? "through" : `${fmt(inlay.depth)} mm deep`}, ${shapes}`;
    case "chamfer":
      return `Chamfer ${fmt(inlay.width)} mm, ${shapes}`;
  }
}

function JobsSection({ design }: { design: Design }) {
  const { project, selection, tools, defaults, combine } = useApp();
  const dispatch = useDispatch();
  const owners = regionOwners(project.jobs);
  const free = design.regions.filter((r) => !owners.has(r.id)).map((r) => r.id);
  const owned = selection.filter((id) => owners.has(id)).length;

  const create = (type: JobType) => {
    const job = newJob(type, selection, project.jobs, defaults);
    // Where the tool list leaves no choice, make it.
    const only = (kind: ToolKind) => {
      const ofKind = tools.filter((t) => t.kind === kind);
      return ofKind.length === 1 ? ofKind[0].id : null;
    };
    const endMill = only("flat_end");
    const inlay = job.inlay;
    if (inlay.type === "vcarve" || inlay.type === "flat" || inlay.type === "pocket") inlay.clearingToolIds = endMill ? [endMill] : [];
    if (inlay.type === "facing" || inlay.type === "contour") inlay.toolId = endMill;
    if (inlay.type === "vcarve" || inlay.type === "chamfer") inlay.vbitToolId = only("v_bit");
    dispatch({ type: "updateProject", update: (p) => ({ ...p, jobs: [...p.jobs, job] }) });
    dispatch({ type: "setActiveJob", id: job.id });
  };
  const move = (from: number, to: number) =>
    dispatch({
      type: "updateProject",
      update: (p) => {
        const jobs = [...p.jobs];
        jobs.splice(to, 0, ...jobs.splice(from, 1));
        return { ...p, jobs };
      },
    });
  const tick = (id: string, on: boolean) => dispatch({ type: "setCombine", ids: on ? [...combine, id] : combine.filter((other) => other !== id) });
  const count = `${selection.length} shape${selection.length === 1 ? "" : "s"}`;
  const none = selection.length === 0;
  const several = project.jobs.length > 1;

  return (
    <section>
      <h2>Inlays and operations</h2>
      {project.jobs.length > 0 && (
        <ul className="jobs">
          {project.jobs.map((job, index) => (
            <li key={job.id} className={several ? "job-row ordered" : "job-row"}>
              {several && (
                <input
                  type="checkbox"
                  checked={combine.includes(job.id)}
                  onChange={(e) => tick(job.id, e.target.checked)}
                  aria-label={`Put ${job.name} into the one file for the stock`}
                  title="Put into the one file for the stock"
                />
              )}
              <button className="job" onClick={() => dispatch({ type: "setActiveJob", id: job.id })}>
                {isInlay(job.inlay) ? (
                  <span className="swatch" style={{ background: jobColor(job, project.jobs) }} />
                ) : (
                  <span className={`swatch op ${job.inlay.type}`} aria-hidden="true" />
                )}
                <span className="job-name">{job.name}</span>
                <span className="muted">{describeJob(job)}</span>
                <span className="job-open" aria-hidden="true">
                  ›
                </span>
              </button>
              {several && (
                <span className="job-order">
                  <button type="button" className="small" disabled={index === 0} onClick={() => move(index, index - 1)} aria-label={`Cut ${job.name} earlier`} title="Earlier">
                    ↑
                  </button>
                  <button
                    type="button"
                    className="small"
                    disabled={index === project.jobs.length - 1}
                    onClick={() => move(index, index + 1)}
                    aria-label={`Cut ${job.name} later`}
                    title="Later"
                  >
                    ↓
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="new-job">
        <h3>{project.jobs.length === 0 ? "Make the first one" : "Add another"}</h3>
        <p className="status-line" role="status">
          {design.regions.length === 0
            ? "The stock has no shapes yet. Add a drawing below, or face the whole stock."
            : none
              ? "Click shapes in the drawing, then choose what to make from them. A shape that has an inlay opens it; Shift-click selects it instead, for an operation."
              : `${count} selected. Choose what to make from ${selection.length === 1 ? "it" : "them"}:`}
        </p>
        {design.regions.length > 0 && (
          <>
            <h4 className="choice-group">Inlays</h4>
            <div className="choices">
              <button className="choice" disabled={none || owned > 0} onClick={() => create("vcarve")}>
                <strong>V-carve inlay</strong>
                <span>Sloped walls cut with a V-bit. Keeps sharp corners and fine detail. The plug is glued in and sawn off.</span>
              </button>
              <button className="choice" disabled={none || owned > 0} onClick={() => create("flat")}>
                <strong>Flat inlay</strong>
                <span>Upright walls cut with an end mill. Corners are rounded to the tool. The insert drops in.</span>
              </button>
            </div>
            {owned > 0 && (
              <p className="hint">
                {owned === 1 ? "One of the selected shapes belongs" : `${owned} of the selected shapes belong`} to an inlay already. A shape is one wood, so
                it can be in one inlay only; the operations below take any shapes, and shapes can also be added once an operation is open.
              </p>
            )}
          </>
        )}
        <h4 className="choice-group">Other operations on the stock</h4>
        <div className="choices">
          {(["pocket", "contour", "chamfer"] as const).map((type) => (
            <button key={type} className="choice" disabled={design.regions.length === 0} onClick={() => create(type)}>
              <strong>{JOB_LABELS[type]}</strong>
              <span>{OPERATION_HINTS[type]}</span>
            </button>
          ))}
          <button className="choice" onClick={() => create("facing")}>
            <strong>Facing{none ? " of the whole stock" : " over the selected shapes"}</strong>
            <span>{OPERATION_HINTS.facing}</span>
          </button>
        </div>
        {design.regions.length > 0 && (
          <div className="row links">
            <button className="link" disabled={free.length === 0 || free.every((id) => selection.includes(id))} onClick={() => dispatch({ type: "setSelection", ids: free })}>
              Select all {free.length} shape{free.length === 1 ? "" : "s"} without an inlay
            </button>
            {!none && (
              <button className="link" onClick={() => dispatch({ type: "setSelection", ids: [] })}>
                Clear selection
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** The wood and the clearances of a plain operation, and its result: the parts every operation's panel shares. */
function OpEditor({ job }: { job: Job }) {
  const { project, defaults } = useApp();
  const dispatch = useDispatch();
  const output = useOutput(job);
  const setup = jobSetup(job, project);
  const setSetup = (change: Partial<Setup>) => dispatch({ type: "updateJob", id: job.id, update: (j) => ({ ...j, setup: { ...jobSetup(j, project), ...change } }) });
  const update = (change: Partial<Job>) => dispatch({ type: "updateJob", id: job.id, update: (j) => ({ ...j, ...change }) });
  const setInlay = (change: Partial<PocketOp> | Partial<FacingOp> | Partial<ContourOp> | Partial<ChamferOp>) => update({ inlay: { ...job.inlay, ...change } as Inlay });
  const inlay = job.inlay;
  if (isInlay(inlay)) return null;
  const label = JOB_LABELS[inlay.type];
  const shapes = `${job.regionIds.length} shape${job.regionIds.length === 1 ? "" : "s"}`;
  const through = inlay.type === "contour" && inlay.depth === null;
  const ownHeights = setup.safeHeight !== defaults.safeHeight || setup.plungeClearance !== defaults.plungeClearance;

  const remove = () => {
    if (!confirm(`Delete "${job.name}"?`)) return;
    dispatch({ type: "updateProject", update: (p) => ({ ...p, jobs: p.jobs.filter((j) => j.id !== job.id) }) });
    dispatch({ type: "setActiveJob", id: null });
  };

  return (
    <aside className="panel" aria-label={`${label} ${job.name}`}>
      <div className="panel-scroll">
        <section>
          <div className="editor-head">
            <button className="link" onClick={() => dispatch({ type: "setActiveJob", id: null })}>
              ‹ All inlays and operations
            </button>
            <span className="tag">
              <span className={`swatch op ${inlay.type}`} aria-hidden="true" />
              {label}
            </span>
          </div>
          <label className="field">
            <span className="field-label">Name</span>
            <input type="text" value={job.name} onChange={(e) => update({ name: e.target.value })} />
          </label>
          <p className={`status-line${job.regionIds.length === 0 && inlay.type !== "facing" ? " warn" : ""}`}>
            {inlay.type === "facing" && job.regionIds.length === 0
              ? "No shapes: the whole stock is faced. Click shapes in the drawing to face over them only."
              : `${job.regionIds.length === 0 ? "No shapes yet." : `${shapes}.`} Click shapes in the drawing to add or remove them.`}
          </p>
          <p className="hint">{OPERATION_HINTS[inlay.type]} It may use shapes that belong to an inlay or to other operations.</p>
        </section>

        <section>
          <h3>The cut</h3>
          {inlay.type === "pocket" && (
            <div className="row">
              <NumberField label="Depth" unit="mm" min={0.01} value={inlay.depth} onChange={(v) => v !== undefined && setInlay({ depth: v })} />
            </div>
          )}
          {inlay.type === "facing" && <FacingFields job={job} inlay={inlay} onChange={setInlay} />}
          {inlay.type === "contour" && (
            <>
              <label className="field">
                <span className="field-label">The tool runs</span>
                <select value={inlay.side} onChange={(e) => setInlay({ side: e.target.value as Side })}>
                  <option value="outside">Outside the shapes: the shapes are what is kept</option>
                  <option value="inside">Inside the shapes: the shapes are cut away</option>
                  <option value="on">On the line: the tool's centre follows the outline</option>
                </select>
                <span className="hint">
                  {inlay.side === "outside"
                    ? "A shape's holes are cut too, from inside them. To cut round the outside of a part only, add everything inside it to the operation as well."
                    : inlay.side === "inside"
                      ? "The opening comes out the size of the shapes, with inside corners rounded to the tool."
                      : "The cut is as wide as the tool, half on each side of the line."}
                </span>
              </label>
              <label className="check">
                <input type="checkbox" checked={through} onChange={(e) => setInlay({ depth: e.target.checked ? null : Math.min(3, project.base.thickness / 2) })} />
                Cut right through the stock
              </label>
              {inlay.depth !== null ? (
                <div className="row">
                  <NumberField label="Depth" unit="mm" min={0.01} value={inlay.depth} onChange={(v) => v !== undefined && setInlay({ depth: v })} />
                </div>
              ) : (
                <p className="derived">
                  {fmt(project.base.thickness + setup.throughCut)} mm deep: the stock's {fmt(project.base.thickness)} mm and {fmt(setup.throughCut)} mm past its
                  bottom. Put a spoilboard under it.
                </p>
              )}
              <label className="check">
                <input type="checkbox" checked={inlay.tabs} onChange={(e) => setInlay({ tabs: e.target.checked })} />
                Leave tabs across the cut
              </label>
              <p className="hint">
                {inlay.tabs
                  ? "Tabs keep what the cut frees attached until you cut them."
                  : through
                    ? "Without tabs, what the cut frees comes loose on the last pass: hold it down with tape."
                    : "Tabs matter when the cut goes through."}
              </p>
            </>
          )}
          {inlay.type === "chamfer" && (
            <>
              <label className="field">
                <span className="field-label">The edge to bevel</span>
                <select value={inlay.side} onChange={(e) => setInlay({ side: e.target.value as "outside" | "inside" })}>
                  <option value="outside">Round the shapes: the wood outside them has been cut away</option>
                  <option value="inside">Inside the shapes: they are pockets or openings</option>
                </select>
              </label>
              <div className="row">
                <NumberField label="Width" unit="mm" min={0.01} value={inlay.width} onChange={(v) => v !== undefined && setInlay({ width: v })} />
              </div>
              <ChamferNote inlay={inlay} />
            </>
          )}
        </section>

        <section>
          <h3>Wood and tool</h3>
          <label className="field">
            <span className="field-label">Wood</span>
            <select value={job.material} onChange={(e) => update({ material: e.target.value as Material })}>
              {MATERIALS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="hint">Picks which of the tool's cutting settings are used.</span>
          </label>
          {inlay.type === "pocket" && (
            <ClearingTools
              label="End mills"
              ids={inlay.clearingToolIds}
              material={job.material}
              onChange={(ids) => setInlay({ clearingToolIds: ids })}
              hint="One is enough. With several, they are used in this order and each cuts only what those before it left. Inside corners are rounded to the smallest."
            />
          )}
          {(inlay.type === "facing" || inlay.type === "contour") && (
            <ToolPicker label="End mill" kind="flat_end" value={inlay.toolId} material={job.material} onChange={(id) => setInlay({ toolId: id })} />
          )}
          {inlay.type === "chamfer" && (
            <ToolPicker label="V-bit" kind="v_bit" value={inlay.vbitToolId} material={job.material} onChange={(id) => setInlay({ vbitToolId: id })} />
          )}
        </section>

        <section>
          <details className="more">
            <summary>
              {inlay.type === "contour" ? "Clearances and tabs" : "Clearances"}
              {(inlay.type === "contour" ? !sameSetup(setup, defaults) : ownHeights) ? " (changed)" : ""}
            </summary>
            <p className="hint">
              For the file of this operation. A new one starts with your defaults, which are set under{" "}
              <button type="button" className="link" onClick={() => dispatch({ type: "setView", view: "settings", page: "defaults" })}>
                Tools and settings
              </button>
              .
            </p>
            <HeightFields setup={setup} onChange={setSetup} />
            {inlay.type === "contour" && (
              <>
                <TabFields setup={setup} onChange={setSetup} />
                <div className="row setup-row">
                  <NumberField
                    label="Cut past the bottom"
                    unit="mm"
                    min={SETUP_LIMITS.throughCut[0]}
                    max={SETUP_LIMITS.throughCut[1]}
                    value={setup.throughCut}
                    onChange={(v) => v !== undefined && setSetup({ throughCut: v })}
                    hint="When the cut goes right through, into the spoilboard."
                  />
                </div>
              </>
            )}
            <button disabled={sameSetup(setup, defaults)} onClick={() => update({ setup: defaults })}>
              Back to your defaults
            </button>
          </details>
        </section>

        <section>
          <Results job={job} state={output} />
          <div className="row end">
            <button className="danger" onClick={remove}>
              Delete operation
            </button>
          </div>
        </section>
      </div>
      <GenerateBar job={job} state={output} />
    </aside>
  );
}

/** How far a glued-in part of an inlay stands above the stock, and how far its blank reaches beyond its shapes. */
function standingPart(owner: Job): { above: number; margin: number; what: string } | null {
  const inlay = owner.inlay;
  if (inlay.type === "vcarve") return { above: inlay.plugThickness - inlay.engagementDepth, margin: inlay.plugMargin, what: "plug" };
  if (inlay.type !== "flat") return null;
  const above = inlay.insertThickness - inlay.pocketDepth;
  return inlay.insertStyle === "backer" ? { above, margin: inlay.insertMargin, what: "plug" } : { above, margin: 1, what: "inserts" };
}

function FacingFields({ job, inlay, onChange }: { job: Job; inlay: FacingOp; onChange: (change: Partial<FacingOp>) => void }) {
  const { project, tools } = useApp();
  const owners = regionOwners(project.jobs);
  // The inlays whose shapes this facing covers: it can be set to trim their plugs flush.
  const inlays = [...new Set(job.regionIds.map((id) => owners.get(id)).filter((j): j is Job => j !== undefined))];
  const whole = job.regionIds.length === 0;
  const tool = resolveTool(inlay.toolId, tools, project);
  const total = inlay.above + inlay.depth;

  return (
    <>
      <div className="row">
        <NumberField label="Wood above the surface" unit="mm" value={inlay.above} onChange={(v) => v !== undefined && onChange({ above: v })} />
        <NumberField label="Depth below the surface" unit="mm" value={inlay.depth} onChange={(v) => v !== undefined && onChange({ depth: v })} />
        {!whole && <NumberField label="Margin" unit="mm" value={inlay.margin} onChange={(v) => v !== undefined && onChange({ margin: v })} />}
      </div>
      <p className="hint">
        {whole
          ? "To flatten the stock, give a depth below its surface. The tool runs out over every edge."
          : "The area is the rectangle around the shapes, plus the margin. To trim a glued-in plug flush, give how far it stands above the surface and 0 below, with the plug's own margin, so that the area is the plug's blank."}{" "}
        The surface is where Z0 is set.
      </p>
      {inlays.map((owner) => {
        const part = standingPart(owner);
        if (!part || part.above <= 0) return null;
        const set = Math.abs(inlay.above - part.above) < 1e-9 && inlay.depth === 0 && Math.abs(inlay.margin - part.margin) < 1e-9;
        return (
          <p className="derived" key={owner.id}>
            The {part.what} of "{owner.name}" {part.what === "inserts" ? "stand" : "stands"} {fmt(part.above)} mm above the surface once glued in.{" "}
            {set ? (
              "The fields are set to trim it flush."
            ) : (
              <button type="button" className="link" onClick={() => onChange({ above: round2(part.above), depth: 0, margin: part.margin })}>
                Set the fields to trim {part.what === "inserts" ? "them" : "it"} flush
              </button>
            )}
          </p>
        );
      })}
      {total > 0 && tool && (
        <p className="derived">
          {fmt(round2(total))} mm in all{inlay.above > 0 ? `, from ${fmt(inlay.above)} mm above the surface` : ""}. The tool's centre goes to the edge of the
          area, so it cuts {fmt(tool.diameter / 2)} mm beyond it.
        </p>
      )}
      {inlay.above > 0 && <p className="hint">The 3D view shows the stock only: the wood above its surface is not drawn.</p>}
    </>
  );
}

/** How deep the V-bit runs for the chamfer, and whether it can cut one that wide. */
function ChamferNote({ inlay }: { inlay: ChamferOp }) {
  const { project, tools } = useApp();
  const bit = resolveTool(inlay.vbitToolId, tools, project);
  if (!bit || bit.kind !== "v_bit") return <p className="hint">Run it after the edge has been cut: the bit's tip runs beside the edge, where the wood is gone.</p>;
  // As the core works it out: the tip runs 0.2 mm beyond its flat from the edge.
  const aside = (bit.tipDiameter ?? 0) / 2 + 0.2;
  const depth = (inlay.width + 0.2) / Math.tan((((bit.tipAngle ?? 90) / 2) * Math.PI) / 180);
  const widest = bit.diameter / 2 - aside;
  return (
    <>
      {inlay.width > widest + 1e-9 ? (
        <p className="hint warn">
          "{bit.name}" can cut a chamfer of {fmt(Math.floor(widest * 100) / 100)} mm at most.
        </p>
      ) : (
        <p className="derived">
          The bit's tip runs {fmt(round2(aside))} mm {inlay.side === "inside" ? "inside" : "outside"} the outline, {fmt(round2(depth))} mm deep.
        </p>
      )}
      <p className="hint">
        Run it after the edge has been cut: the tip expects the wood beside the edge to be gone already, at least that deep. In uncut wood it leaves a
        V-groove instead.
      </p>
    </>
  );
}

function JobEditor({ job }: { job: InlayJob }) {
  const { project, tools, defaults } = useApp();
  const dispatch = useDispatch();
  const output = useOutput(job);
  const setup = jobSetup(job, project);
  const setSetup = (change: Partial<Setup>) => dispatch({ type: "updateJob", id: job.id, update: (j) => ({ ...j, setup: { ...jobSetup(j, project), ...change } }) });
  const ownSetup = !sameSetup(setup, defaults);
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
              ‹ All inlays and operations
            </button>
            <span className="tag">
              <span className="swatch" style={{ background: jobColor(job, project.jobs) }} />
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
                <NumberField label={inlay.insertStyle === "backer" ? "Plug board" : "Insert thickness"} unit="mm" min={0.01} value={inlay.insertThickness} onChange={(v) => v !== undefined && setInlay({ insertThickness: v })} />
                <NumberField label="Fit allowance" unit="mm" value={inlay.allowance} onChange={(v) => v !== undefined && setInlay({ allowance: v })} />
              </div>
              <p className="hint">
                The allowance is the gap all round: half comes off the insert, half is added to the pocket.{" "}
                {inlay.insertStyle === "backer"
                  ? "The plug board must be thicker than the pocket depth plus the saw gap, so that a backer is left."
                  : "The insert is cut right through a board of the thickness given."}
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
          <ColorField
            label="Colour of the inlay's wood"
            value={jobColor(job, project.jobs)}
            onChange={(color) => update({ color })}
            hint="For the drawing, the 3D view of the plug and the fit view. It changes nothing in the files."
          />
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
            <summary>{inlay.type === "vcarve" ? "Plug blank and cut-out" : "Insert: pieces or plug, board, cut-out"}</summary>
            {inlay.type === "vcarve" ? (
              <div className="row">
                <NumberField label="Thickness" unit="mm" min={0.01} value={inlay.plugThickness} onChange={(v) => v !== undefined && setInlay({ plugThickness: v })} />
                <NumberField label="Margin" unit="mm" min={0.01} value={inlay.plugMargin} onChange={(v) => v !== undefined && setInlay({ plugMargin: v })} />
              </div>
            ) : (
              <>
                <label className="field">
                  <span className="field-label">The insert is made as</span>
                  <select value={inlay.insertStyle} onChange={(e) => {
                      const insertStyle = e.target.value as "loose" | "backer";
                      // A plug needs board left over as its backer: make sure there is some.
                      const needed = Math.ceil(inlay.pocketDepth + inlay.sawGap + 3);
                      setInlay(insertStyle === "backer" && inlay.insertThickness < needed ? { insertStyle, insertThickness: needed } : { insertStyle });
                    }}
                  >
                    <option value="loose">Loose pieces, cut right through the board</option>
                    <option value="backer">One plug: the shapes on a shared backer</option>
                  </select>
                  <span className="hint">
                    {inlay.insertStyle === "loose"
                      ? "Each shape becomes its own piece, the same way up as it goes in."
                      : "The shapes stay together on a backer, mirrored. Glue the plug in face down, then saw or plane the backer off."}
                  </span>
                </label>
                <div className="row">
                  <NumberField label="Margin" unit="mm" min={0.01} value={inlay.insertMargin} onChange={(v) => v !== undefined && setInlay({ insertMargin: v })} />
                  {inlay.insertStyle === "backer" && (
                    <NumberField label="Saw gap" unit="mm" value={inlay.sawGap} onChange={(v) => v !== undefined && setInlay({ sawGap: v })} />
                  )}
                </div>
              </>
            )}
            {(() => {
              const plug = inlay.type === "vcarve" || inlay.insertStyle === "backer";
              const piece = plug ? "plug" : "inserts";
              return (
                <>
                  {plug && (
                    <label className="check">
                      <input type="checkbox" checked={inlay.cutOut} onChange={(e) => setInlay({ cutOut: e.target.checked })} />
                      Cut the plug out of a larger board
                    </label>
                  )}
                  {plug && inlay.cutOut && <CutOutTool job={job} onChange={(id) => update({ cutOutToolId: id })} />}
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={inlay.tabs}
                      disabled={plug && !inlay.cutOut}
                      onChange={(e) => setInlay({ tabs: e.target.checked })}
                    />
                    Hold the {piece} with tabs while cutting {plug ? "it" : "them"} out
                  </label>
                  <p className="hint">
                    {plug
                      ? inlay.cutOut
                        ? "The whole plug is cut out as one piece, round the edge of its blank, after it is carved."
                        : "The file carves the plug into a blank cut to size beforehand: the shapes' outer size plus the margin on every side."
                      : "The insert board is the shapes' outer size plus the margin on every side."}{" "}
                    {inlay.tabs && (!plug || inlay.cutOut)
                      ? "Tabs keep the wood attached until you cut it free."
                      : !plug || inlay.cutOut
                        ? "Without tabs it comes loose on the last pass: hold it down with tape."
                        : ""}{" "}
                    The exact board size is given with the file.
                  </p>
                </>
              );
            })()}
          </details>
        </section>

        <section>
          <details className="more">
            <summary>Clearances and tabs{ownSetup ? " (changed)" : ""}</summary>
            <p className="hint">
              For the files of this inlay. A new inlay starts with your defaults, which are set under{" "}
              <button type="button" className="link" onClick={() => dispatch({ type: "setView", view: "settings", page: "defaults" })}>
                Tools and settings
              </button>
              .
            </p>
            <HeightFields setup={setup} onChange={setSetup} />
            <TabFields setup={setup} onChange={setSetup} />
            <CutOutFields setup={setup} onChange={setSetup} />
            <button disabled={!ownSetup} onClick={() => update({ setup: defaults })}>
              Back to your defaults
            </button>
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

/**
 * The end mill that cuts a plug out of its board: the one the inlay's other
 * end mills would give, unless another is chosen. Says whether its cutting
 * edges reach through the board.
 */
function CutOutTool({ job, onChange }: { job: InlayJob; onChange: (id: string | undefined) => void }) {
  const { tools, project } = useApp();
  const dispatch = useDispatch();
  const choices = toolChoices("flat_end", tools, project);
  const usual = usualCutOutTool(job, tools, project);
  const depth = cutOutDepth(job, project);
  const picked = job.cutOutToolId;
  const chosen = picked !== undefined ? resolveTool(picked, tools, project) : usual;
  const hasEndMills = job.inlay.clearingToolIds.length > 0;

  return (
    <label className="field cut-out-tool">
      <span className="field-label">End mill for the cut-out</span>
      <select value={picked ?? ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}>
        <option value="">
          {usual ? `The inlay's own: ${usual.name}` : hasEndMills ? "None of the inlay's end mills is long enough" : "Choose an end mill…"}
        </option>
        {picked !== undefined && !chosen && <option value={picked}>Missing tool</option>}
        {choices.map((tool) => (
          <option key={tool.id} value={tool.id}>
            {tool.name}
            {tools.some((t) => t.id === tool.id) ? "" : " (from this project)"}
          </option>
        ))}
      </select>
      {choices.length === 0 && (
        <span className="hint">
          No flat end mills in your tool list.{" "}
          <button type="button" className="link" onClick={() => dispatch({ type: "setView", view: "settings", page: "tools" })}>
            Add tools
          </button>
        </span>
      )}
      {picked !== undefined && !chosen && <span className="hint warn">This tool is no longer in the tool list or the project. Choose another.</span>}
      {!chosen && picked === undefined && choices.length > 0 && (
        <span className="hint warn">
          {hasEndMills
            ? `The cut is ${fmt(depth)} mm deep, more than the cutting edges of the inlay's end mills. Choose a longer one.`
            : "The plug cannot be cut out without an end mill. Choose one."}
        </span>
      )}
      {chosen &&
        (chosen.fluteLength === undefined ? (
          <span className="hint warn">
            The cut is {fmt(depth)} mm deep. The flute length of this tool is unknown, so check that it reaches.
          </span>
        ) : chosen.fluteLength < depth ? (
          <span className="hint warn">
            The cut is {fmt(depth)} mm deep, but the cutting edges of this tool are only {fmt(chosen.fluteLength)} mm long. Choose a longer one.
          </span>
        ) : (
          <span className="hint">
            {describeTool(chosen)}. Its cutting edges are {fmt(chosen.fluteLength)} mm long; the cut is {fmt(depth)} mm deep.
          </span>
        ))}
      {chosen && !chosen.cutting.some((c) => c.material === job.material) && (
        <span className="hint warn">This tool has no cutting settings for {job.material}. Add them in the tool list.</span>
      )}
    </label>
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
          <button type="button" className="link" onClick={() => dispatch({ type: "setView", view: "settings", page: "tools" })}>
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
          <button type="button" className="link" onClick={() => dispatch({ type: "setView", view: "settings", page: "tools" })}>
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
