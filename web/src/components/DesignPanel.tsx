import { useEffect, useState } from "react";
import { core } from "../core/client";
import type { ChamferOp, ContourOp, Design, FacingOp, ImportReport, Inlay, Job, JobType, Material, PassDirection, Pattern, PocketOp, Setup, Side, Tool, ToolKind, TrueInlay, VcarveInlay } from "../core/types";
import { boxOf, trimBoard } from "../state/arrange";
import {
  DEFAULT_STOCK_COLOR,
  JOB_LABELS,
  allMaterials,
  findProfile,
  isAdaptive,
  materialLabel,
  SETUP_LIMITS,
  WOODS,
  cutOutDepth,
  DEFAULT_TIP_CLEARANCE,
  MAX_TIP_CLEARANCE,
  VCARVE_TUNING,
  describeTool,
  fileNumbers,
  fmt,
  glueOf,
  glueStep,
  insertAfter,
  isInlay,
  jobColor,
  jobSetup,
  newJob,
  regionOwners,
  resolveTool,
  sameSetup,
  standingPart,
  stockColor,
  toolChoices,
  trimFacing,
  trimOf,
  usualCutOutTool,
  withoutJob,
} from "../state/model";
import { useFileActions } from "../state/files";
import { useApp, useDispatch } from "../state/store";
import { pickTextFile, pickTextFiles } from "../util/files";
import { FilletIcon, JobIcon } from "./icons";
import { InlayDiagram } from "./InlayDiagram";
import { Grip, useSortable } from "./sortable";
import { ArrangePanel } from "./ArrangePanel";
import { NumberField } from "./NumberField";
import { CHAMFER_PICTURES, DIRECTION_PICTURES, PATTERN_PICTURES, PictureChoice } from "./PictureChoice";
import { GenerateBar, Results, useOutput } from "./OutputPanel";
import { CutOutFields, EntryFields, HeightFields, TabFields } from "./SetupFields";
import { FilesList } from "./Files";

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
  const { project, importReport, activeJobId, arranging, panelPage } = useApp();
  const dispatch = useDispatch();
  const active = project.jobs.find((j) => j.id === activeJobId);
  const files = panelPage === "files" && project.jobs.length > 0;
  const setPage = (page: "list" | "files") => dispatch({ type: "setPanelPage", page });

  if (arranging) return <ArrangePanel design={design} />;
  if (active?.inlay.type === "glue") return <GlueEditor key={active.id} job={active} />;
  if (active) return isInlay(active.inlay) ? <JobEditor key={active.id} job={active as InlayJob} /> : <OpEditor key={active.id} job={active} />;
  return (
    <aside className="panel" aria-label="Stock, inlays and operations">
      {project.jobs.length > 0 && (
        <nav className="tabs panel-tabs" aria-label="What the panel shows">
          <button aria-pressed={!files} onClick={() => setPage("list")}>
            Inlays and operations
          </button>
          <button aria-pressed={files} onClick={() => setPage("files")}>
            Files
          </button>
        </nav>
      )}
      <div className="panel-scroll">
        {files ? (
          <FilesList />
        ) : (
          <>
            <JobsSection design={design} />
            <StockSection design={design} report={importReport} />
          </>
        )}
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
      <p className="hint">
        "Add drawing", above the drawing, brings in the shapes of further SVG or DXF files. "Edit" draws rectangles, circles and polygons, and moves,
        resizes or deletes shapes.
      </p>
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
const OPERATION_HINTS: Record<JobType, string> = {
  vcarve: "Sloped walls cut with a V-bit. Keeps sharp corners and fine detail. The plug is glued in and sawn off.",
  flat: "Upright walls cut with an end mill. Corners are rounded to the tool. The insert drops in.",
  pocket: "Clears the shapes to a flat floor with an end mill.",
  contour: "Cuts along the outlines of the shapes: round them, inside them or on them, to a depth or right through.",
  chamfer: "Shapes the top edge along the outlines: bevelled with a V-bit, or rounded over with a corner-rounding (fillet) bit.",
  facing: "Mills an area flat: the whole stock, or the rectangle around the shapes, as when trimming a glued-in plug flush.",
  glue: "Done by hand, with no file: an inlay's plug or inserts are glued into the pocket. The steps below it in the list find the stock with that wood on it.",
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
      return `Chamfer or rounded edge, ${shapes}`;
    case "glue":
      return "By hand, no file";
  }
}

/** The colour of the wood a line of the list is about: an inlay's own, or that of the inlay a glue-up glues in. */
function woodOf(job: Job, jobs: Job[]): string | undefined {
  const inlay = job.inlay.type === "glue" ? jobs.find((j) => j.inlay.type !== "glue" && job.inlay.type === "glue" && j.id === job.inlay.inlayId) : job;
  return inlay && isInlay(inlay.inlay) ? jobColor(inlay, jobs) : undefined;
}

function JobsSection({ design }: { design: Design }) {
  const { project, selection, tools, defaults } = useApp();
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
    if (inlay.type === "vcarve") inlay.vbitToolId = only("v_bit");
    if (inlay.type === "chamfer") inlay.toolId = only("v_bit") ?? only("corner_round");
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
  // Which file for the stock each line goes into, shown once a step done by hand splits the list into several.
  const files = fileNumbers(project.jobs);
  const filed = files.some((n) => n !== null && n > 1);
  // The inlays a glue-up can be added for: those of the selected shapes, else every one that has none yet.
  const unglued = project.jobs.filter((j) => isInlay(j.inlay) && !glueOf(j, project.jobs));
  const pickedInlays = unglued.filter((j) => j.regionIds.some((id) => selection.includes(id)));
  const toGlue = pickedInlays.length > 0 ? pickedInlays : unglued;
  const addGlueUps = () =>
    dispatch({
      type: "updateProject",
      update: (p) => {
        let jobs = p.jobs;
        for (const inlay of toGlue) {
          const step = glueStep(inlay, jobs);
          // Right after the inlay, whose place in the list is where its pocket is cut.
          if (step) jobs = insertAfter(jobs, inlay.id, step);
        }
        return { ...p, jobs };
      },
    });
  const count = `${selection.length} shape${selection.length === 1 ? "" : "s"}`;
  const none = selection.length === 0;
  const several = project.jobs.length > 1;
  const sortable = useSortable(project.jobs.length, move);
  // What the kind under the pointer does, in place of a line under every button.
  const [about, setAbout] = useState<JobType | null>(null);
  const choice = (type: JobType, label: string, disabled: boolean) => (
    <button
      key={type}
      className="choice"
      disabled={disabled}
      title={OPERATION_HINTS[type]}
      onClick={() => create(type)}
      onPointerEnter={() => setAbout(type)}
      onPointerLeave={() => setAbout(null)}
      onFocus={() => setAbout(type)}
      onBlur={() => setAbout(null)}
    >
      <JobIcon type={type} />
      <strong>{label}</strong>
    </button>
  );

  return (
    <section>
      <h2>Inlays and operations</h2>
      {project.jobs.length > 0 && (
        <ul className="jobs">
          {project.jobs.map((job, index) => (
            <li
              key={job.id}
              className={`job-row${several ? " ordered" : ""}${filed ? " filed" : ""}${job.inlay.type === "glue" ? " by-hand" : ""}`}
              {...(several ? sortable.row(index) : {})}
            >
              {several && <Grip {...sortable.grip(index, job.name)} />}
              {filed && (
                <span className="file-number" title={files[index] === null ? "Done by hand: in no file" : `Cut by file ${files[index]} for the stock`}>
                  {files[index] === null ? "" : `file ${files[index]}`}
                </span>
              )}
              <button className="job" onClick={() => dispatch({ type: "setActiveJob", id: job.id })}>
                <span className="job-icon" style={woodOf(job, project.jobs) ? { color: woodOf(job, project.jobs) } : undefined}>
                  <JobSymbol job={job} />
                </span>
                <span className="job-name">{job.name}</span>
                <span className="muted">{describeJob(job)}</span>
                <span className="job-open" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="new-job">
        <h3>{project.jobs.length === 0 ? "Make the first one" : "Add another"}</h3>
        <p className="status-line" role="status">
          {design.regions.length === 0
            ? "The stock has no shapes yet. Add a drawing, draw shapes under Edit, or face the whole stock."
            : none
              ? "Click shapes in the drawing, then choose what to make from them. A shape that has an inlay opens it; Shift-click selects it instead, for an operation."
              : `${count} selected. Choose what to make from ${selection.length === 1 ? "it" : "them"}:`}
        </p>
        {design.regions.length > 0 && (
          <>
            <h4 className="choice-group">Inlays</h4>
            <div className="choices">
              {choice("vcarve", "V-carve inlay", none || owned > 0)}
              {choice("flat", "Flat inlay", none || owned > 0)}
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
          {(["pocket", "contour", "chamfer"] as const).map((type) => choice(type, JOB_LABELS[type], design.regions.length === 0))}
          {choice("facing", "Facing", false)}
        </div>
        {project.jobs.some((j) => isInlay(j.inlay)) && (
          <>
            <h4 className="choice-group">Steps done by hand</h4>
            <div className="choices">
              <button
                className="choice"
                disabled={toGlue.length === 0}
                title={toGlue.length === 0 ? "Every inlay has its glue-up in the list already." : OPERATION_HINTS.glue}
                onClick={addGlueUps}
                onPointerEnter={() => setAbout("glue")}
                onPointerLeave={() => setAbout(null)}
                onFocus={() => setAbout("glue")}
                onBlur={() => setAbout(null)}
              >
                <JobIcon type="glue" />
                <strong>{toGlue.length > 1 ? `Glue-up, for ${toGlue.length} inlays` : "Glue-up"}</strong>
              </button>
            </div>
          </>
        )}
        <p className="hint choice-about">
          {about
            ? OPERATION_HINTS[about]
            : none
              ? "Facing needs no shapes: without any it covers the whole stock. Point at a kind to read what it does."
              : "Point at a kind to read what it does."}
        </p>
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
  const { project, defaults, tools } = useApp();
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

  const remove = () => {
    if (!confirm(`Delete "${job.name}"?`)) return;
    dispatch({ type: "updateProject", update: (p) => ({ ...p, jobs: withoutJob(p.jobs, job.id) }) });
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
              <JobSymbol job={job} />
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
            <>
              <div className="row">
                <NumberField label="Depth" unit="mm" min={0.01} value={inlay.depth} onChange={(v) => v !== undefined && setInlay({ depth: v })} />
              </div>
              <PatternField
                value={inlay.pattern}
                walls
                onChange={(pattern) => setInlay({ pattern })}
                direction={inlay.direction}
                onDirection={(direction) => setInlay({ direction })}
              />
            </>
          )}
          {inlay.type === "facing" && (
            <>
              <FacingFields job={job} inlay={inlay} onChange={setInlay} />
              <PatternField value={inlay.pattern} onChange={(pattern) => setInlay({ pattern })} direction={inlay.direction} onDirection={(direction) => setInlay({ direction })} />
            </>
          )}
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
              <PictureChoice
                label="The edge to bevel"
                value={inlay.side}
                onChange={(side) => setInlay({ side })}
                options={[
                  { value: "outside", label: "Round the shapes", picture: CHAMFER_PICTURES.outside },
                  { value: "inside", label: "Inside the shapes", picture: CHAMFER_PICTURES.inside },
                ]}
                hint={inlay.side === "outside" ? "The shapes stand: the wood outside them has been cut away." : "The shapes are pockets or openings."}
              />
              {resolveTool(inlay.toolId, tools, project)?.kind !== "corner_round" && (
                <div className="row">
                  <NumberField label="Width" unit="mm" min={0.01} value={inlay.width} onChange={(v) => v !== undefined && setInlay({ width: v })} />
                  <NumberField
                    label="Tip clear of the edge"
                    unit="mm"
                    min={0}
                    max={MAX_TIP_CLEARANCE}
                    value={inlay.tipClearance ?? DEFAULT_TIP_CLEARANCE}
                    onChange={(v) => v !== undefined && setInlay({ tipClearance: v === DEFAULT_TIP_CLEARANCE ? undefined : v })}
                  />
                </div>
              )}
              <ChamferNote inlay={inlay} />
            </>
          )}
        </section>

        <section>
          <h3>Material and tool</h3>
          <label className="field">
            <span className="field-label">Material</span>
            <MaterialSelect value={job.material} onChange={(material) => update({ material })} />
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
            <ToolPicker
              label="V-bit or corner-rounding bit"
              kind={["v_bit", "corner_round"]}
              value={inlay.toolId}
              material={job.material}
              onChange={(id) => setInlay({ toolId: id })}
              hint="A V-bit bevels the edge. A corner-rounding (fillet) bit rounds it over to the bit's own radius."
            />
          )}
        </section>

        <section>
          <details className="more">
            <summary>
              {inlay.type === "contour" ? "Clearances and tabs" : "Clearances"}
              {!sameSetup(setup, defaults) ? " (changed)" : ""}
            </summary>
            <p className="hint">
              For the file of this operation. A new one starts with your defaults, which are set under{" "}
              <button type="button" className="link" onClick={() => dispatch({ type: "setView", view: "settings", page: "defaults" })}>
                Settings
              </button>
              .
            </p>
            <HeightFields setup={setup} onChange={setSetup} />
            {inlay.type !== "chamfer" && <EntryFields setup={setup} onChange={setSetup} finish={inlay.type !== "facing"} />}
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

/** The symbol of a job: that of its kind, or a rounded edge for a chamfer cut with a corner-rounding bit. */
function JobSymbol({ job }: { job: Job }) {
  const { project, tools } = useApp();
  const inlay = job.inlay;
  if (inlay.type === "chamfer" && resolveTool(inlay.toolId, tools, project)?.kind === "corner_round") return <FilletIcon />;
  return <JobIcon type={inlay.type} />;
}

/**
 * The shape of the path the tool clears the area along. `walls` when the area
 * has walls, which straight passes leave scalloped. With `onDirection`, the
 * way side-to-side passes run can be chosen as well.
 */
function PatternField(props: { value: Pattern; onChange: (pattern: Pattern) => void; walls?: boolean; direction?: PassDirection; onDirection?: (direction: PassDirection | undefined) => void }) {
  const { value, walls } = props;
  const direction = props.direction ?? "longer";
  const along = direction === "x" ? "left and right, along X" : direction === "y" ? "to and from the front, along Y" : "along the longer side";
  return (
    <>
      <PictureChoice
        label="The tool's path"
        value={value}
        onChange={props.onChange}
        options={[
          { value: "raster", label: "Side to side", picture: PATTERN_PICTURES.raster },
          { value: "offset", label: "In rings", picture: PATTERN_PICTURES.offset },
        ]}
        hint={
          value === "raster"
            ? `Straight passes ${along}, back and forth${walls ? ", then once round the walls at each depth to clean them" : ""}.`
            : "Rings from the middle outwards, the last one along the edge."
        }
      />
      {props.onDirection && value === "raster" && (
        <PictureChoice
          label="The passes run"
          value={direction}
          onChange={(next) => props.onDirection?.(next === "longer" ? undefined : next)}
          options={[
            { value: "longer", label: "Longer side", picture: DIRECTION_PICTURES.longer },
            { value: "x", label: "Along X", picture: DIRECTION_PICTURES.x },
            { value: "y", label: "Along Y", picture: DIRECTION_PICTURES.y },
          ]}
          hint={
            direction === "longer"
              ? walls
                ? "In each shape, along whichever of its sides is longer: the fewest turns. In wood, a floor comes out cleanest along the grain: pick X or Y if the grain runs across."
                : "Along whichever side of the area is longer: the fewest turns. In wood, a face comes out cleanest along the grain: pick X or Y if the grain runs across the longer side."
              : `${direction === "x" ? "Left and right" : "To and from the front"}. Cleanest when the grain runs ${direction === "x" ? "left to right" : "front to back"}.`
          }
        />
      )}
    </>
  );
}

/**
 * In an inlay's panel: what happens after the glue-up. Offers a facing that
 * trims the plug flush, as an operation of its own in the list, or leads to
 * the one there is. Nothing for loose inserts, which are not one plug.
 */
function TrimOffer({ job }: { job: Job }) {
  const { project, tools, defaults } = useApp();
  const dispatch = useDispatch();
  const part = standingPart(job);
  if (!part || job.regionIds.length === 0) return null;
  const trims = part.what === "plug" && part.above > 0;
  const made = trimOf(job, project.jobs);
  const glue = glueOf(job, project.jobs);

  const addGlue = () => {
    const step = glueStep(job, project.jobs);
    if (!step) return;
    // Right after the inlay, whose place in the list is where its pocket is cut.
    dispatch({ type: "updateProject", update: (p) => ({ ...p, jobs: insertAfter(p.jobs, job.id, step) }) });
  };

  const add = () => {
    const trim = trimFacing(job, project.jobs, defaults);
    if (!trim || trim.inlay.type !== "facing") return;
    // Where the tool list leaves no choice of end mill, make it.
    const endMills = tools.filter((t) => t.kind === "flat_end");
    if (endMills.length === 1) trim.inlay.toolId = endMills[0].id;
    // After the glue-up when the list has it: the facing cuts what the glue-up put there.
    dispatch({ type: "updateProject", update: (p) => ({ ...p, jobs: insertAfter(p.jobs, glueOf(job, p.jobs)?.id, trim) }) });
    dispatch({ type: "setActiveJob", id: trim.id });
  };

  return (
    <section>
      <h3>The glue-up, and after it</h3>
      <p className="hint">
        Gluing the {part.what} in is done by hand. As a step in the list, it tells the steps below it that the {part.what === "plug" ? "plug is" : "inserts are"}{" "}
        on the stock: "Stock, step by step" then shows {part.what === "plug" ? "it" : "them"} in {part.what === "plug" ? "its" : "their"} wood.
      </p>
      {glue ? (
        <p className="derived">
          "{glue.name}" is in the list.{" "}
          <button type="button" className="link" onClick={() => dispatch({ type: "setActiveJob", id: glue.id })}>
            Open it
          </button>
        </p>
      ) : (
        <button type="button" onClick={addGlue}>
          Add the glue-up as a step
        </button>
      )}
      {trims && <TrimPart job={job} above={part.above} made={made} add={add} />}
    </section>
  );
}

/** The facing that trims a glued-in plug flush: the offer to add it, or the way to the one there is. */
function TrimPart({ above, made, add }: { job: Job; above: number; made: Job | undefined; add: () => void }) {
  const dispatch = useDispatch();
  return (
    <>
      <p className="hint after-glue">
        Glued in, the plug stands {fmt(round2(above))} mm above the stock's surface. A facing mills it down flush, over the plug's blank. It is an operation
        of its own in the list, with a file of its own, to run once the glue has set.
      </p>
      {made ? (
        <p className="derived">
          "{made.name}" trims this plug.{" "}
          <button type="button" className="link" onClick={() => dispatch({ type: "setActiveJob", id: made.id })}>
            Open it
          </button>
        </p>
      ) : (
        <button type="button" onClick={add}>
          Add a facing to trim the plug flush
        </button>
      )}
    </>
  );
}

/** The panel of a glue-up: a step done by hand, which has a name and a place in the list, and nothing to set. */
function GlueEditor({ job }: { job: Job }) {
  const { project } = useApp();
  const dispatch = useDispatch();
  const inlay = job.inlay.type === "glue" ? project.jobs.find((j) => job.inlay.type === "glue" && j.id === job.inlay.inlayId) : undefined;
  const part = inlay ? standingPart(inlay) : null;
  const what = part?.what === "inserts" ? "inserts" : "plug";
  const back = () => dispatch({ type: "setActiveJob", id: null });
  const before = inlay !== undefined && project.jobs.indexOf(job) < project.jobs.indexOf(inlay);

  const remove = () => {
    dispatch({ type: "updateProject", update: (p) => ({ ...p, jobs: withoutJob(p.jobs, job.id) }) });
    back();
  };

  return (
    <aside className="panel" aria-label={`Glue-up ${job.name}`}>
      <div className="panel-scroll">
        <section>
          <div className="editor-head">
            <button className="link" onClick={back}>
              ‹ All inlays and operations
            </button>
            <span className="tag">
              <JobIcon type="glue" />
              Glue-up, by hand
            </span>
          </div>
          <label className="field">
            <span className="field-label">Name</span>
            <input type="text" value={job.name} onChange={(e) => dispatch({ type: "updateJob", id: job.id, update: (j) => ({ ...j, name: e.target.value }) })} />
          </label>
          {inlay && (
            <p className="derived">
              <span className="swatch" style={{ background: jobColor(inlay, project.jobs) }} /> Glues in the {what} of "{inlay.name}".{" "}
              <button type="button" className="link" onClick={() => dispatch({ type: "setActiveJob", id: inlay.id })}>
                Open the inlay
              </button>
            </p>
          )}
        </section>
        <section>
          <h3>What this step does</h3>
          <p className="hint">
            Nothing is cut and there is no file: the {what} {what === "plug" ? "is" : "are"} glued into the pocket by hand.
            {part && part.above > 0 ? ` As designed, ${what === "plug" ? "it stands" : "they stand"} ${fmt(round2(part.above))} mm above the stock's surface.` : ""}
          </p>
          <p className="hint">
            Its place in the list is what counts. The steps above it find the stock without the {what}; the steps below it find the {what} there, to face{" "}
            {what === "plug" ? "it" : "them"} off, to cut into {what === "plug" ? "it" : "them"}, or to run into {what === "plug" ? "it" : "them"}. Drag it in
            the list to move it. "Stock, step by step", above the drawing, shows the stock at every step.
          </p>
          {before && (
            <p className="status-line warn" role="status">
              This step is above "{inlay?.name}" in the list, so its pocket is not cut yet when the {what} {what === "plug" ? "is" : "are"} glued in. Move it
              below.
            </p>
          )}
          <div className="row end">
            <button className="danger" onClick={remove}>
              Delete step
            </button>
          </div>
        </section>
      </div>
    </aside>
  );
}

/** For a facing that takes its height from the list: that height, as the core works it out. Null until it is known. */
function useListedHeight(job: Job, on: boolean): number | null {
  const { project } = useApp();
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!on) return;
    let current = true;
    core
      .call("facingStart", project, job.id)
      .then((above) => current && setHeight(above))
      .catch(() => current && setHeight(null));
    return () => {
      current = false;
    };
  }, [project, job.id, on]);
  return on ? height : null;
}

function FacingFields({ job, inlay, onChange }: { job: Job; inlay: FacingOp; onChange: (change: Partial<FacingOp>) => void }) {
  const { project, tools } = useApp();
  const owners = regionOwners(project.jobs);
  // The inlays whose shapes this facing covers: it can be set to trim their plugs flush.
  const inlays = [...new Set(job.regionIds.map((id) => owners.get(id)).filter((j): j is Job => j !== undefined))];
  const whole = job.regionIds.length === 0;
  const tool = resolveTool(inlay.toolId, tools, project);
  const listed = inlay.aboveAuto === true;
  const height = useListedHeight(job, listed);
  // Where the cut starts: as the list gives it, or as typed.
  const above = listed ? (height ?? 0) : inlay.above;
  const total = above + inlay.depth;

  return (
    <>
      <label className="check">
        <input
          type="checkbox"
          checked={listed}
          // By hand, the field starts from what the list gave.
          onChange={(e) => onChange(e.target.checked ? { aboveAuto: true } : { aboveAuto: undefined, above: round2(height ?? inlay.above), depth: Math.max(inlay.depth, -(height ?? inlay.above)) })}
        />
        Take the wood above the surface from the list
      </label>
      <div className="row">
        {/* The cut cannot end above where it starts: less wood above takes a depth under 0 up with it. */}
        <NumberField
          label="Wood above the surface"
          unit="mm"
          value={listed ? round2(above) : inlay.above}
          disabled={listed}
          onChange={(v) => v !== undefined && onChange({ above: v, depth: Math.max(inlay.depth, -v) })}
        />
        <NumberField label="Depth below the surface" unit="mm" min={listed && height === null ? -Infinity : -above} value={inlay.depth} onChange={(v) => v !== undefined && onChange({ depth: v })} />
        {!whole && <NumberField label="Margin" unit="mm" value={inlay.margin} onChange={(v) => v !== undefined && onChange({ margin: v })} />}
      </div>
      {listed && height !== null && (
        <p className={`status-line${height > 0 ? "" : " warn"}`} role="status">
          {height > 0
            ? `By the glue-ups above this facing in the list, ${fmt(round2(height))} mm of wood stand above the surface where it cuts.`
            : "When the list gets to this facing, nothing glued in stands above the surface where it cuts. Put it below the glue-up, or untick the box and give the height."}
        </p>
      )}
      <p className="hint">
        {whole
          ? "To flatten the stock, give a depth below its surface. The tool runs out over every edge."
          : "The area is the rectangle around the shapes, plus the margin. To trim a glued-in plug flush, give how far it stands above the surface and 0 below, with the plug's own margin, so that the area is the plug's blank. With the backer sawn off, untick the box and give what is left standing."}{" "}
        The surface is where Z0 is set. A depth under 0 stops the cut that far above the surface, to leave the wood standing there a little proud.
      </p>
      {inlays.map((owner) => {
        const part = standingPart(owner);
        if (!part || part.above <= 0) return null;
        const set = (listed || Math.abs(inlay.above - part.above) < 1e-9) && inlay.depth === 0 && Math.abs(inlay.margin - part.margin) < 1e-9;
        return (
          <p className="derived" key={owner.id}>
            The {part.what} of "{owner.name}" {part.what === "inserts" ? "stand" : "stands"} {fmt(part.above)} mm above the surface once glued in.{" "}
            {set ? (
              "The fields are set to trim it flush."
            ) : (
              <button type="button" className="link" onClick={() => onChange({ ...(listed ? {} : { above: round2(part.above) }), depth: 0, margin: part.margin })}>
                Set the fields to trim {part.what === "inserts" ? "them" : "it"} flush
              </button>
            )}
          </p>
        );
      })}
      {total > 0 && tool && (
        <p className="derived">
          {fmt(round2(total))} mm in all{above > 0 ? `, from ${fmt(round2(above))} mm above the surface` : ""}
          {inlay.depth < 0 ? ` down to ${fmt(-inlay.depth)} mm above it` : ""}. The tool's centre goes to the edge of the
          area, so it cuts {fmt(tool.diameter / 2)} mm beyond it.
        </p>
      )}
      {above > 0 && (
        <p className="hint">
          The 3D view of this file alone shows the stock only: the wood above its surface is not drawn. "Stock, step by step" draws it, once the glue-up is a
          step of the list.
        </p>
      )}
    </>
  );
}

/** How deep the V-bit runs for the chamfer, and whether it can cut one that wide. */
function ChamferNote({ inlay }: { inlay: ChamferOp }) {
  const { project, tools } = useApp();
  const bit = resolveTool(inlay.toolId, tools, project);
  if (bit?.kind === "corner_round") {
    const radius = bit.cornerRadius ?? 0;
    return (
      <>
        <p className="derived">
          The edge is rounded over to the bit's radius of {fmt(radius)} mm. The bit's tip runs {fmt(round2((bit.tipDiameter ?? 0) / 2))} mm{" "}
          {inlay.side === "inside" ? "inside" : "outside"} the outline, {fmt(radius)} mm deep.
        </p>
        <p className="hint">
          Run it after the edge has been cut: the tip expects the wood beside the edge to be gone already, at least that deep. In uncut wood it cuts a
          groove as wide as the bit instead.
        </p>
      </>
    );
  }
  if (!bit || bit.kind !== "v_bit") return <p className="hint">Run it after the edge has been cut: the bit's tip runs beside the edge, where the wood is gone.</p>;
  // As the core works it out: the tip runs its clearance beyond its flat from the edge.
  const clear = inlay.tipClearance ?? DEFAULT_TIP_CLEARANCE;
  const aside = (bit.tipDiameter ?? 0) / 2 + clear;
  const depth = (inlay.width + clear) / Math.tan((((bit.tipAngle ?? 90) / 2) * Math.PI) / 180);
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

/** The numbers of a V-carve inlay that are seldom changed: closed until asked for, and marked when one is not the usual. */
function FinerPoints({ inlay, onChange }: { inlay: VcarveInlay; onChange: (change: Partial<VcarveInlay>) => void }) {
  const fields = [
    { key: "floorRidge", label: "Ridges on the floor, at most", hint: "Between the V-bit's passes on a flat floor. Lower is smoother and takes longer." },
    { key: "reliefKeep", label: "Relief stays below the face by", hint: "Lower relieves more of a narrow ridge, and may show after sanding." },
    { key: "trimDepth", label: "Fit check judges the face at", hint: "Below the surface: about what you sand off once the plug is in." },
  ] as const;
  const changed = fields.some((f) => inlay[f.key] !== undefined);
  return (
    <section>
      <details className="more">
        <summary>Finer points{changed ? " (changed)" : ""}</summary>
        {fields.map((f) => (
          <div className="row setup-row" key={f.key}>
            <NumberField
              label={f.label}
              unit="mm"
              min={VCARVE_TUNING[f.key].range[0]}
              max={VCARVE_TUNING[f.key].range[1]}
              value={inlay[f.key] ?? VCARVE_TUNING[f.key].default}
              onChange={(v) => v !== undefined && onChange({ [f.key]: v === VCARVE_TUNING[f.key].default ? undefined : v })}
              hint={f.hint}
            />
          </div>
        ))}
        <button disabled={!changed} onClick={() => onChange({ floorRidge: undefined, reliefKeep: undefined, trimDepth: undefined })}>
          Back to the usual
        </button>
      </details>
    </section>
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
    const glue = glueOf(job, project.jobs);
    if (!confirm(`Delete "${job.name}"? Its shapes become free again.${glue ? ` "${glue.name}" goes with it.` : ""}`)) return;
    dispatch({ type: "updateProject", update: (p) => ({ ...p, jobs: withoutJob(p.jobs, job.id) }) });
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
            <>
              <p className="hint">
                Engagement: how deep the plug goes in. Glue gap: space left under it. Saw gap: space above the surface for sawing the plug's backer
                off.
              </p>
              <label className="check">
                <input type="checkbox" checked={inlay.relief} onChange={(e) => setInlay({ relief: e.target.checked })} />
                Relieve the plug's narrow ridges and corner edges
              </label>
              <p className="hint">
                Where a shape is narrow, and along the edge into every corner, the plug comes to a point that fills the pocket to the bottom: no room
                for glue, and a bit with a tip flat leaves the pocket shallower still, so the point holds the plug up. With this the V-bit cuts those
                points back by the glue gap. The cut stays {fmt(inlay.reliefKeep ?? VCARVE_TUNING.reliefKeep.default)} mm below the finished face.
              </p>
            </>
          )}
        </section>

        <section>
          <h3>Material and tools</h3>
          <label className="field">
            <span className="field-label">Material</span>
            <MaterialSelect value={job.material} onChange={(material) => update({ material })} />
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

        {inlay.type === "vcarve" && <FinerPoints inlay={inlay} onChange={setInlay} />}

        <section>
          <details className="more">
            <summary>Clearances and tabs{ownSetup ? " (changed)" : ""}</summary>
            <p className="hint">
              For the files of this inlay. A new inlay starts with your defaults, which are set under{" "}
              <button type="button" className="link" onClick={() => dispatch({ type: "setView", view: "settings", page: "defaults" })}>
                Settings
              </button>
              .
            </p>
            <HeightFields setup={setup} onChange={setSetup} />
            <EntryFields setup={setup} onChange={setSetup} finish={inlay.type === "flat"} />
            <TabFields setup={setup} onChange={setSetup} />
            <CutOutFields setup={setup} onChange={setSetup} />
            <button disabled={!ownSetup} onClick={() => update({ setup: defaults })}>
              Back to your defaults
            </button>
          </details>
        </section>

        <TrimOffer job={job} />

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
  const { tools, lists, project } = useApp();
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
  const sortable = useSortable(ids.length, move);
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
            <li key={id} {...(chosen.length > 1 ? sortable.row(i) : {})}>
              {chosen.length > 1 && <Grip {...sortable.grip(i, tool?.name ?? "tool")} />}
              <span className="tool-order-name">
                {tool ? tool.name : "Missing tool"}
                <span className="muted"> {tool ? `Ø${fmt(tool.diameter)} mm` : "no longer in the tool list or the project"}</span>
                {tool && !tool.cutting.some((c) => c.material === props.material) && (
                  <span className="hint warn">No cutting settings for {materialLabel(props.material, lists).toLowerCase()}. Add them in the tool list.</span>
                )}
                {tool && <RowPicker tool={tool} material={props.material} />}
              </span>
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

function ToolPicker(props: { label: string; kind: ToolKind | ToolKind[]; value: string | null; material: Material; hint?: string; onChange: (id: string | null) => void }) {
  const { tools, lists, project } = useApp();
  const dispatch = useDispatch();
  const choices = toolChoices(props.kind, tools, project);
  const chosen: Tool | undefined = resolveTool(props.value, tools, project);
  const inList = (tool: Tool) => tools.some((t) => t.id === tool.id);

  return (
    <>
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
          No {Array.isArray(props.kind) ? "V-bits or corner-rounding bits" : props.kind === "v_bit" ? "V-bits" : "flat end mills"} in your tool list.{" "}
          <button type="button" className="link" onClick={() => dispatch({ type: "setView", view: "settings", page: "tools" })}>
            Add tools
          </button>
        </span>
      )}
      {chosen && <span className="hint">{describeTool(chosen)}</span>}
      {props.hint && <span className="hint">{props.hint}</span>}
      {chosen && !chosen.cutting.some((c) => c.material === props.material) && (
        <span className="hint warn">This tool has no cutting settings for {materialLabel(props.material, lists).toLowerCase()}. Add them in the tool list.</span>
      )}
    </label>
    {chosen && <RowPicker tool={chosen} material={props.material} />}
    </>
  );
}

/**
 * Which of a tool's cutting rows the open part runs it with: the plain row,
 * or one made for a kind of toolpath. Shown only when the tool has such rows
 * for the material.
 */
function RowPicker(props: { tool: Tool; material: Material }) {
  const { lists, project, activeJobId } = useApp();
  const dispatch = useDispatch();
  const job = project.jobs.find((j) => j.id === activeJobId);
  if (!job) return null;
  const { tool } = props;
  const value = job.rowProfiles?.[tool.id] ?? "";
  const rows = tool.cutting.filter((c) => c.material === props.material && c.profile !== undefined);
  if (rows.length === 0 && value === "") return null;
  const label = (key: string) => findProfile(key, lists, project)?.label ?? key;
  const adaptive = (key: string) => isAdaptive(key, findProfile(key, lists, project));
  const row = tool.cutting.find((c) => c.material === props.material && (c.profile ?? "") === value);
  const set = (key: string) =>
    dispatch({
      type: "updateJob",
      id: job.id,
      update: (j) => {
        const next = { ...(j.rowProfiles ?? {}) };
        if (key === "") delete next[tool.id];
        else next[tool.id] = key;
        return { ...j, rowProfiles: Object.keys(next).length > 0 ? next : undefined };
      },
    });

  return (
    <label className="field">
      <span className="field-label">Cutting row of {tool.name}</span>
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Plain row: safe for any cut</option>
        {rows.map((c) => (
          <option key={c.profile} value={c.profile} disabled={adaptive(c.profile ?? "")}>
            {label(c.profile ?? "")}
            {adaptive(c.profile ?? "") ? " (adaptive clearing: this app has no such toolpath)" : ""}
          </option>
        ))}
        {value !== "" && !rows.some((c) => c.profile === value) && <option value={value}>{label(value)} (the tool has no such row for this material)</option>}
      </select>
      {row && (
        <span className="hint">
          {row.rpm} rpm, feed {fmt(row.feed)}, plunge {fmt(row.plunge)} mm/min, stepover {fmt(row.stepover)} mm, {fmt(row.stepdown)} mm per pass.
          {value !== "" && findProfile(value, lists, project)?.note ? ` ${findProfile(value, lists, project)?.note}` : ""}
        </span>
      )}
      {value !== "" && (job.inlay.type === "vcarve" || job.inlay.type === "flat") && <span className="hint">Cutting the plug or insert out of its board always uses the plain row.</span>}
    </label>
  );
}

/** The material a part is cut in: any the tool list knows. */
function MaterialSelect(props: { value: Material; onChange: (material: Material) => void }) {
  const { lists } = useApp();
  const choices = allMaterials(lists);
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      {choices.map((m) => (
        <option key={m.value} value={m.value}>
          {m.label}
        </option>
      ))}
      {!choices.some((m) => m.value === props.value) && <option value={props.value}>{props.value} (not in your material list)</option>}
    </select>
  );
}
