import { useEffect, useRef, useState } from "react";
import { core } from "../core/client";
import type { ChamferOp, ContourOp, Design, EdgePlan, FacingOp, ImportReport, Task, Step, StepType, Material, PassDirection, Pattern, PocketOp, Setup, Side, Tool, ToolKind, TrueInlay, VcarveInlay } from "../core/types";
import { boxOf, trimBoard } from "../state/arrange";
import {
  DEFAULT_STOCK_COLOR,
  STEP_LABELS,
  allMaterials,
  materialLabel,
  stepMaterial,
  trimmedInlay,
  withDefaultProfile,
  type CutUse,
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
  hasBacker,
  inlayMargin,
  insertAfter,
  isByHand,
  sawOf,
  sawStep,
  isInlay,
  stepColor,
  stepSetup,
  newStep,
  numberedName,
  regionOwners,
  resolveTool,
  sameSetup,
  standingPart,
  stockColor,
  toolChoices,
  trimFacing,
  trimOf,
  usualCutOutTool,
  withoutStep,
} from "../state/model";
import { useFileActions } from "../state/files";
import { useApp, useDispatch, type PanelPage } from "../state/store";
import { pickTextFile, pickTextFiles } from "../util/files";
import { FilletIcon, StepIcon } from "./icons";
import { InlayDiagram, type InlayHot } from "./InlayDiagram";
import { Grip, useSortable } from "./sortable";
import { ArrangePanel } from "./ArrangePanel";
import { NumberField } from "./NumberField";
import { BitCut } from "./BitCut";
import { HelpTip } from "./HelpTip";
import { ProjectTools } from "./ProjectTools";
import { ChamferDiagram, edgeCut, type ChamferHot } from "./ChamferDiagram";
import { FacingDiagram, type FacingHot } from "./FacingDiagram";
import { CHAMFER_PICTURES, CONTOUR_PICTURES, DIRECTION_PICTURES, PATTERN_PICTURES, PictureChoice } from "./PictureChoice";
import { GenerateBar, Results, useOutput } from "./OutputPanel";
import { CutOutFields, EntryFields, HeightFields, TabFields } from "./SetupFields";
import { FilesList } from "./Files";

/** A step that is an inlay proper, with a pocket and a plug or insert. */
type InlayStep = Step & { task: TrueInlay };

const DRAWINGS = ".svg,.dxf,image/svg+xml";

/** Picks one or more drawings and puts them on the stock. */
export function useImportSvg() {
  const { addDrawings } = useFileActions();
  return async () => addDrawings(await pickTextFiles(DRAWINGS));
}

/** The panel beside the drawing: the stock with its inlays and operations, or the one being worked on. */
export function DesignPanel({ design }: { design: Design }) {
  const { project, importReport, activeStepId, arranging, panelPage } = useApp();
  const dispatch = useDispatch();
  const active = project.steps.find((j) => j.id === activeStepId);
  const page: PanelPage = project.steps.length > 0 ? panelPage : "list";
  const setPage = (to: PanelPage) => dispatch({ type: "setPanelPage", page: to });

  if (arranging) return <ArrangePanel design={design} />;
  if (active && isByHand(active.task)) return <HandEditor key={active.id} step={active} />;
  if (active) return isInlay(active.task) ? <StepEditor key={active.id} step={active as InlayStep} /> : <OpEditor key={active.id} step={active} />;
  return (
    <aside className="panel" aria-label="Stock and operations">
      {project.steps.length > 0 && (
        <nav className="tabs panel-tabs" aria-label="What the panel shows">
          <button aria-pressed={page === "list"} onClick={() => setPage("list")}>
            Operations
          </button>
          <button aria-pressed={page === "tools"} onClick={() => setPage("tools")}>
            Tools
          </button>
          <button aria-pressed={page === "files"} onClick={() => setPage("files")}>
            Files
          </button>
        </nav>
      )}
      <div className="panel-scroll">
        {page === "files" ? (
          <FilesList />
        ) : page === "tools" ? (
          <ProjectTools />
        ) : (
          <>
            <StepsSection design={design} />
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
      <p className="hint">The work origin is its bottom-left corner, on its top face.</p>
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
      <label className="field">
        <span className="field-label">Material</span>
        <MaterialSelect value={project.base.material} onChange={(material) => setBase({ material })} />
      </label>
      <ColorField label="Wood" value={stockColor(project)} onChange={(color) => setBase({ color: color === DEFAULT_STOCK_COLOR ? undefined : color })} />

      <p className="muted file-name">
        {count === 0 ? "No shapes yet." : `${count} shape${count === 1 ? "" : "s"}${design.sourceName ? ` from ${design.sourceName}` : ""}.`}
      </p>
      {report && <ReportNotes report={report} />}
      <details className="more">
        <summary>More</summary>
        <div className="row">
          <button disabled={count === 0} onClick={() => dispatch({ type: "editDrawing", update: (p) => (p.design ? { ...p, design: trimBoard(p.design, 5) } : p) })}>
            Fit the stock to the shapes
          </button>
          <button
            onClick={async () => {
              const made = project.steps.length;
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
const OPERATION_HINTS: Record<StepType, string> = {
  vcarve: "Sloped walls cut with a V-bit. Keeps sharp corners and fine detail. The plug is glued in and sawn off.",
  flat: "Upright walls cut with an end mill. Corners are rounded to the tool. The insert drops in.",
  pocket: "Clears the shapes to a flat floor with an end mill.",
  contour: "Cuts along the outlines of the shapes: round them, inside them or on them, to a depth or right through.",
  chamfer: "Shapes the top edge along the outlines: bevelled with a V-bit, or rounded over with a corner-rounding (fillet) bit.",
  facing: "Mills an area flat: the whole stock, or the rectangle around the shapes, as when trimming a glued-in plug flush.",
  saw: "Done by hand, with no file: the backer of a glued-in plug is sawn off, a little above the stock. The facing after it finds only what the saw left standing.",
  glue: "Done by hand, with no file: an inlay's plug or inserts are glued into the pocket. The steps below it in the list find the stock with that wood on it.",
};

function describeStep(step: Step): string {
  const shapes = `${step.regionIds.length} shape${step.regionIds.length === 1 ? "" : "s"}`;
  const inlay = step.task;
  switch (inlay.type) {
    case "vcarve":
      return `V-carve inlay, ${shapes}`;
    case "flat":
      return `Flat inlay, ${shapes}`;
    case "pocket":
      return `Pocket ${fmt(inlay.depth)} mm deep, ${shapes}`;
    case "facing":
      return step.regionIds.length === 0 ? "Facing, the whole stock" : `Facing, over ${shapes}`;
    case "contour":
      return `Contour ${inlay.side === "on" ? "on the line" : inlay.side}, ${inlay.depth === null ? "through" : `${fmt(inlay.depth)} mm deep`}${inlay.startDepth ? ` from ${fmt(inlay.startDepth)} mm` : ""}, ${shapes}`;
    case "chamfer":
      return `Chamfer or rounded edge, ${shapes}`;
    case "glue":
    case "saw":
      return "By hand, no file";
  }
}

/** The colour of the wood a line of the list is about: an inlay's own, or that of the inlay a step done by hand is about. */
function woodOf(step: Step, steps: Step[]): string | undefined {
  const task = step.task;
  const inlay = isByHand(task) ? steps.find((j) => j.id === task.inlayId) : step;
  return inlay && isInlay(inlay.task) ? stepColor(inlay, steps) : undefined;
}

function StepsSection({ design }: { design: Design }) {
  const { project, selection, tools, defaults } = useApp();
  const dispatch = useDispatch();
  const owners = regionOwners(project.steps);
  const free = design.regions.filter((r) => !owners.has(r.id)).map((r) => r.id);
  const owned = selection.filter((id) => owners.has(id)).length;

  const create = (type: StepType) => {
    const step = newStep(type, selection, project.steps, defaults);
    // Where the tool list leaves no choice, make it.
    const only = (kind: ToolKind) => {
      const ofKind = tools.filter((t) => t.kind === kind);
      return ofKind.length === 1 ? ofKind[0].id : null;
    };
    const endMill = only("flat_end");
    const inlay = step.task;
    if (inlay.type === "vcarve" || inlay.type === "flat" || inlay.type === "pocket") inlay.clearingToolIds = endMill ? [endMill] : [];
    if (inlay.type === "facing" || inlay.type === "contour") inlay.toolId = endMill;
    if (inlay.type === "vcarve") inlay.vbitToolId = only("v_bit");
    if (inlay.type === "chamfer") inlay.toolId = only("v_bit") ?? only("corner_round");
    dispatch({ type: "updateProject", update: (p) => ({ ...p, steps: [...p.steps, step] }) });
    dispatch({ type: "setActiveStep", id: step.id });
  };
  const move = (from: number, to: number) =>
    dispatch({
      type: "updateProject",
      update: (p) => {
        const steps = [...p.steps];
        steps.splice(to, 0, ...steps.splice(from, 1));
        return { ...p, steps };
      },
    });
  // Which file for the stock each line goes into, shown once a step done by hand splits the list into several.
  const files = fileNumbers(project.steps);
  const filed = files.some((n) => n !== null && n > 1);
  // The inlays a glue-up can be added for: those of the selected shapes, else every one that has none yet.
  const unglued = project.steps.filter((j) => isInlay(j.task) && !glueOf(j, project.steps));
  const pickedInlays = unglued.filter((j) => j.regionIds.some((id) => selection.includes(id)));
  const toGlue = pickedInlays.length > 0 ? pickedInlays : unglued;
  const addGlueUps = (inlays: Step[]) =>
    dispatch({
      type: "updateProject",
      update: (p) => {
        let steps = p.steps;
        for (const inlay of inlays) {
          const step = glueStep(inlay, steps);
          // Right after the inlay, whose place in the list is where its pocket is cut.
          if (step) steps = insertAfter(steps, inlay.id, step);
        }
        return { ...p, steps };
      },
    });
  // The backers that can be sawn off: of plugs that are glued in, and not sawn off yet.
  const unsawn = project.steps.filter((j) => hasBacker(j.task) && glueOf(j, project.steps) && !sawOf(j, project.steps));
  const pickedSawn = unsawn.filter((j) => j.regionIds.some((id) => selection.includes(id)));
  const toSaw = pickedSawn.length > 0 ? pickedSawn : unsawn;
  const addSaws = (inlays: Step[]) =>
    dispatch({
      type: "updateProject",
      update: (p) => {
        let steps = p.steps;
        for (const inlay of inlays) {
          const added = sawStep(inlay, steps);
          // Right after the glue-up: the trim, if there is one, comes after it.
          if (added) steps = insertAfter(steps, glueOf(inlay, steps)?.id ?? inlay.id, added);
        }
        return { ...p, steps };
      },
    });
  const count = `${selection.length} shape${selection.length === 1 ? "" : "s"}`;
  const none = selection.length === 0;
  const several = project.steps.length > 1;
  const sortable = useSortable(project.steps.length, move);
  // The step done by hand that is being added, while there are several inlays it could be for and one is still to be picked.
  const [picking, setPicking] = useState<"glue" | "saw" | null>(null);
  const byHand = (kind: "glue" | "saw") => {
    const [inlays, add] = kind === "glue" ? ([toGlue, addGlueUps] as const) : ([toSaw, addSaws] as const);
    // One it can be for: that one. Several: ask which.
    if (inlays.length === 1) add(inlays);
    else setPicking(picking === kind ? null : kind);
  };
  const candidates = picking === "glue" ? toGlue : picking === "saw" ? toSaw : [];
  // What the kind under the pointer does, in place of a line under every button.
  const [about, setAbout] = useState<StepType | null>(null);
  const choice = (type: StepType, label: string, disabled: boolean) => (
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
      <StepIcon type={type} />
      <strong>{label}</strong>
    </button>
  );

  return (
    <section>
      <h2>Operations</h2>
      {project.steps.length > 0 && (
        <ul className="jobs">
          {project.steps.map((step, index) => (
            <li
              key={step.id}
              className={`job-row${several ? " ordered" : ""}${filed ? " filed" : ""}${isByHand(step.task) ? " by-hand" : ""}`}
              {...(several ? sortable.row(index) : {})}
            >
              {several && <Grip {...sortable.grip(index, step.name)} />}
              {filed && (
                <span className="file-number" title={files[index] === null ? "Done by hand: in no file" : `Cut by file ${files[index]} for the stock`}>
                  {files[index] === null ? "" : `file ${files[index]}`}
                </span>
              )}
              <button className="job" onClick={() => dispatch({ type: "setActiveStep", id: step.id })}>
                <span className="job-icon" style={woodOf(step, project.steps) ? { color: woodOf(step, project.steps) } : undefined}>
                  <StepSymbol step={step} />
                </span>
                <span className="job-name">{step.name}</span>
                <span className="muted">{describeStep(step)}</span>
                <span className="job-open" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="new-job">
        <h3>{project.steps.length === 0 ? "Make the first one" : "Add another"}</h3>
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
                {owned === 1 ? "One of the selected shapes belongs" : `${owned} of the selected shapes belong`} to an inlay already, and a shape can be in one
                inlay only.
              </p>
            )}
          </>
        )}
        <h4 className="choice-group">Other operations on the stock</h4>
        <div className="choices">
          {(["pocket", "contour", "chamfer"] as const).map((type) => choice(type, STEP_LABELS[type], design.regions.length === 0))}
          {choice("facing", "Facing", false)}
        </div>
        {project.steps.some((j) => isInlay(j.task)) && (
          <>
            <h4 className="choice-group">Steps done by hand</h4>
            <div className="choices">
              <button
                className="choice"
                disabled={toGlue.length === 0}
                aria-expanded={toGlue.length > 1 ? picking === "glue" : undefined}
                title={toGlue.length === 0 ? "Every inlay has its glue-up in the list already." : OPERATION_HINTS.glue}
                onClick={() => byHand("glue")}
                onPointerEnter={() => setAbout("glue")}
                onPointerLeave={() => setAbout(null)}
                onFocus={() => setAbout("glue")}
                onBlur={() => setAbout(null)}
              >
                <StepIcon type="glue" />
                <strong>Glue-up{toGlue.length > 1 ? "…" : ""}</strong>
              </button>
              <button
                className="choice"
                disabled={toSaw.length === 0}
                aria-expanded={toSaw.length > 1 ? picking === "saw" : undefined}
                title={toSaw.length === 0 ? "For a plug on a backer that has its glue-up in the list, and is not sawn off yet." : OPERATION_HINTS.saw}
                onClick={() => byHand("saw")}
                onPointerEnter={() => setAbout("saw")}
                onPointerLeave={() => setAbout(null)}
                onFocus={() => setAbout("saw")}
                onBlur={() => setAbout(null)}
              >
                <StepIcon type="saw" />
                <strong>Saw off the backer{toSaw.length > 1 ? "…" : ""}</strong>
              </button>
            </div>
            {picking && candidates.length > 1 && (
              <div className="pick-inlay" role="group" aria-label={picking === "glue" ? "Which inlay to glue in" : "Which inlay's backer to saw off"}>
                <span className="muted">{picking === "glue" ? "Glue in which inlay?" : "Saw the backer off which inlay?"}</span>
                {candidates.map((inlay) => (
                  <button
                    key={inlay.id}
                    onClick={() => {
                      (picking === "glue" ? addGlueUps : addSaws)([inlay]);
                      // The last but one picked leaves one, which needs no asking.
                      if (candidates.length <= 2) setPicking(null);
                    }}
                  >
                    <span className="swatch" style={{ background: stepColor(inlay, project.steps) }} />
                    {inlay.name}
                  </button>
                ))}
                <button
                  className="link"
                  onClick={() => {
                    (picking === "glue" ? addGlueUps : addSaws)(candidates);
                    setPicking(null);
                  }}
                >
                  All {candidates.length}
                </button>
              </div>
            )}
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
function OpEditor({ step }: { step: Step }) {
  const { project, defaults } = useApp();
  const dispatch = useDispatch();
  const output = useOutput(step);
  const setup = stepSetup(step, project);
  const setSetup = (change: Partial<Setup>) => dispatch({ type: "updateStep", id: step.id, update: (j) => ({ ...j, setup: { ...stepSetup(j, project), ...change } }) });
  const update = (change: Partial<Step>) => dispatch({ type: "updateStep", id: step.id, update: (j) => ({ ...j, ...change }) });
  const setInlay = (change: Partial<PocketOp> | Partial<FacingOp> | Partial<ContourOp> | Partial<ChamferOp>) => update({ task: { ...step.task, ...change } as Task });
  const inlay = step.task;
  if (isInlay(inlay)) return null;
  const label = STEP_LABELS[inlay.type];
  const shapes = `${step.regionIds.length} shape${step.regionIds.length === 1 ? "" : "s"}`;
  const through = inlay.type === "contour" && inlay.depth === null;

  const remove = () => {
    if (!confirm(`Delete "${step.name}"?`)) return;
    dispatch({ type: "updateProject", update: (p) => ({ ...p, steps: withoutStep(p.steps, step.id) }) });
    dispatch({ type: "setActiveStep", id: null });
  };

  return (
    <aside className="panel" aria-label={`${label} ${step.name}`}>
      <div className="panel-scroll">
        <section>
          <div className="editor-head">
            <button className="link" onClick={() => dispatch({ type: "setActiveStep", id: null })}>
              ‹ All operations
            </button>
            <span className="tag">
              <StepSymbol step={step} />
              {label}
            </span>
          </div>
          <label className="field">
            <span className="field-label">Name</span>
            <input type="text" value={step.name} onChange={(e) => update({ name: e.target.value })} />
          </label>
          <p className={`status-line${step.regionIds.length === 0 && inlay.type !== "facing" ? " warn" : ""}`}>
            {inlay.type === "facing" && step.regionIds.length === 0
              ? "No shapes: the whole stock is faced. Click shapes in the drawing to face over them only."
              : `${step.regionIds.length === 0 ? "No shapes yet." : `${shapes}.`} Click shapes in the drawing to add or remove them.`}
          </p>
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
              <FacingFields step={step} inlay={inlay} onChange={setInlay} />
              <PatternField value={inlay.pattern} onChange={(pattern) => setInlay({ pattern })} direction={inlay.direction} onDirection={(direction) => setInlay({ direction })} />
            </>
          )}
          {inlay.type === "contour" && (
            <>
              <PictureChoice
                label="The tool runs"
                value={inlay.side}
                onChange={(side: Side) => setInlay({ side })}
                options={[
                  { value: "outside", label: "Outside the shapes", picture: CONTOUR_PICTURES.outside },
                  { value: "inside", label: "Inside the shapes", picture: CONTOUR_PICTURES.inside },
                  { value: "on", label: "On the line", picture: CONTOUR_PICTURES.on },
                ]}
                hint={
                  inlay.side === "outside"
                    ? "The shapes are what is kept. A shape's holes are cut too, from inside them. To cut round the outside of a part only, add everything inside it to the operation as well."
                    : inlay.side === "inside"
                      ? "The shapes are cut away: the opening comes out their size, with inside corners rounded to the tool."
                      : "The tool's centre follows the outline: the cut is as wide as the tool, half on each side of the line."
                }
              />
              <div className="check-row">
                <label className="check">
                  <input type="checkbox" checked={through} onChange={(e) => setInlay({ depth: e.target.checked ? null : Math.min(3, project.base.thickness / 2) })} />
                  Cut right through the stock
                </label>
                <HelpTip topic="throughCut" />
              </div>
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
              <div className="row">
                <NumberField
                  label="Start depth"
                  unit="mm"
                  min={0}
                  value={inlay.startDepth ?? 0}
                  onChange={(v) => v !== undefined && setInlay({ startDepth: v > 0 ? v : undefined })}
                  help="contourStart"
                />
              </div>
              {(inlay.startDepth ?? 0) > 0 &&
                ((inlay.startDepth ?? 0) >= (inlay.depth ?? project.base.thickness) ? (
                  <p className="hint warn">The cut has to start above where it ends: {fmt(inlay.depth ?? project.base.thickness)} mm.</p>
                ) : (
                  <p className="hint">
                    Run it after the wood above is gone, as on the floor of a pocket: the tool comes down fast to {fmt(inlay.startDepth ?? 0)} mm where it runs.
                  </p>
                ))}
              <div className="check-row">
                <label className="check">
                  <input type="checkbox" checked={inlay.tabs} onChange={(e) => setInlay({ tabs: e.target.checked })} />
                  Leave tabs across the cut
                </label>
                <HelpTip topic="tabs" />
              </div>
              {through && !inlay.tabs && <p className="hint">Without tabs, what the cut frees comes loose on the last pass: hold it down with tape.</p>}
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
              <ChamferFields step={step} inlay={inlay} onChange={setInlay} />
            </>
          )}
        </section>

        <section>
          <h3>{inlay.type === "pocket" ? "Tools" : "Tool"}</h3>
          <CutIn step={step} />
          {inlay.type === "pocket" && <ClearingTools label="End mills" ids={inlay.clearingToolIds} use="clearing" onChange={(ids) => setInlay({ clearingToolIds: ids })} />}
          {(inlay.type === "facing" || inlay.type === "contour") && (
            <ToolPicker label="End mill" kind="flat_end" value={inlay.toolId} use={inlay.type} onChange={(id) => setInlay({ toolId: id })} />
          )}
          {inlay.type === "chamfer" && (
            <ToolPicker label="V-bit or corner-rounding bit" kind={["v_bit", "corner_round"]} value={inlay.toolId} use="chamfer" onChange={(id) => setInlay({ toolId: id })} />
          )}
        </section>

        <section>
          <details className="more">
            <summary>
              {inlay.type === "contour" ? "Clearances and tabs" : "Clearances"}
              {!sameSetup(setup, defaults) ? " (changed)" : ""}
            </summary>
            <p className="hint">
              A new operation starts with your defaults, set under{" "}
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
          <Results step={step} state={output} />
          <div className="row end">
            <button className="danger" onClick={remove}>
              Delete operation
            </button>
          </div>
        </section>
      </div>
      <GenerateBar step={step} state={output} />
    </aside>
  );
}

/** The symbol of a step: that of its kind, or a rounded edge for a chamfer cut with a corner-rounding bit. */
function StepSymbol({ step }: { step: Step }) {
  const { project, tools } = useApp();
  const inlay = step.task;
  if (inlay.type === "chamfer" && resolveTool(inlay.toolId, tools, project)?.kind === "corner_round") return <FilletIcon />;
  return <StepIcon type={inlay.type} />;
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
                ? "Along each shape's longer side, for the fewest turns; pick X or Y to follow the grain."
                : "Along the area's longer side, for the fewest turns; pick X or Y to follow the grain."
              : `${direction === "x" ? "Left and right" : "To and from the front"}. Cleanest when the grain runs ${direction === "x" ? "left to right" : "front to back"}.`
          }
        />
      )}
    </>
  );
}

/**
 * In an inlay's panel: what is done with it once it is cut, as the steps they
 * are. Each says whether it is in the list, and is added or opened from here:
 * the glue-up, then for a plug that stands above the surface the sawing off
 * of its backer and the facing that trims it flush.
 */
function TrimOffer({ step }: { step: Step }) {
  const { project, tools, defaults } = useApp();
  const dispatch = useDispatch();
  const part = standingPart(step);
  if (!part || step.regionIds.length === 0) return null;
  const trims = part.what === "plug" && part.above > 0;
  const made = trimOf(step, project.steps);
  const glue = glueOf(step, project.steps);
  const saw = sawOf(step, project.steps);
  const addSaw = () => {
    const added = sawStep(step, project.steps);
    if (!added) return;
    dispatch({ type: "updateProject", update: (p) => ({ ...p, steps: insertAfter(p.steps, glueOf(step, p.steps)?.id ?? step.id, added) }) });
  };

  const addGlue = () => {
    const added = glueStep(step, project.steps);
    if (!added) return;
    // Right after the inlay, whose place in the list is where its pocket is cut.
    dispatch({ type: "updateProject", update: (p) => ({ ...p, steps: insertAfter(p.steps, step.id, added) }) });
  };

  const add = () => {
    const trim = trimFacing(step, project.steps, defaults);
    if (!trim || trim.task.type !== "facing") return;
    // Where the tool list leaves no choice of end mill, make it.
    const endMills = tools.filter((t) => t.kind === "flat_end");
    if (endMills.length === 1) trim.task.toolId = endMills[0].id;
    // After the glue-up, and the sawing, when the list has them: the facing cuts what they leave.
    dispatch({ type: "updateProject", update: (p) => ({ ...p, steps: insertAfter(p.steps, (sawOf(step, p.steps) ?? glueOf(step, p.steps))?.id, trim) }) });
    dispatch({ type: "setActiveStep", id: trim.id });
  };

  const open = (id: string) => dispatch({ type: "setActiveStep", id });
  const height = (mm: number) => `${fmt(round2(mm))} mm`;
  // What the facing has to take off: what the saw leaves, or all that stands.
  const standing = saw && saw.task.type === "saw" ? saw.task.leave : part.above;

  return (
    <section>
      <h3>After the cut</h3>
      <ul className="life">
        <LifeRow title={`Glue the ${part.what} in`} note={part.above > 0 ? `by hand · ${part.what === "plug" ? "stands" : "stand"} ${height(part.above)} above the surface` : "by hand"} step={glue} onAdd={addGlue} onOpen={open} />
        {trims && (
          <LifeRow
            title="Saw the backer off"
            note={saw && saw.task.type === "saw" ? `by hand · leaves ${height(saw.task.leave)} standing` : "by hand · optional"}
            step={saw}
            onAdd={glue ? addSaw : undefined}
            needs="After the glue-up, once that is in the list."
            onOpen={open}
          />
        )}
        {trims && <LifeRow title="Trim the plug flush" note={`a facing · takes off ${height(standing)}`} step={made} onAdd={add} onOpen={open} />}
      </ul>
    </section>
  );
}

/** One step of what comes after an inlay is cut: in the list, with its name and the way to it, or offered. */
function LifeRow(props: { title: string; note: string; step: Step | undefined; onAdd?: () => void; needs?: string; onOpen: (id: string) => void }) {
  const { step } = props;
  return (
    <li className={step ? "listed" : undefined}>
      <span className="life-dot" aria-hidden="true" />
      <span>
        {props.title}
        <small>{step ? `${step.name} · ${props.note}` : props.note}</small>
      </span>
      {step ? (
        <button type="button" className="link" onClick={() => props.onOpen(step.id)}>
          Open
        </button>
      ) : (
        <button type="button" className="small" disabled={!props.onAdd} title={props.onAdd ? undefined : props.needs} onClick={props.onAdd} aria-label={`Add to the list: ${props.title}`}>
          Add
        </button>
      )}
    </li>
  );
}

/** The panel of a step done by hand: a glue-up, or the sawing off of a backer. It has a name and a place in the list, and little to set. */
function HandEditor({ step }: { step: Step }) {
  const { project } = useApp();
  const dispatch = useDispatch();
  const task = step.task;
  const inlay = isByHand(task) ? project.steps.find((j) => j.id === task.inlayId) : undefined;
  const part = inlay ? standingPart(inlay) : null;
  const what = part?.what === "inserts" ? "inserts" : "plug";
  const sawing = task.type === "saw";
  const back = () => dispatch({ type: "setActiveStep", id: null });
  const at = project.steps.indexOf(step);
  // A glue-up belongs below its inlay; a sawing below the glue-up.
  const glue = inlay ? glueOf(inlay, project.steps) : undefined;
  const before = inlay !== undefined && at < project.steps.indexOf(sawing ? (glue ?? inlay) : inlay);

  const remove = () => {
    dispatch({ type: "updateProject", update: (p) => ({ ...p, steps: withoutStep(p.steps, step.id) }) });
    back();
  };

  return (
    <aside className="panel" aria-label={`${sawing ? "Sawing off" : "Glue-up"} ${step.name}`}>
      <div className="panel-scroll">
        <section>
          <div className="editor-head">
            <button className="link" onClick={back}>
              ‹ All operations
            </button>
            <span className="tag">
              <StepIcon type={sawing ? "saw" : "glue"} />
              {sawing ? "Sawing off, by hand" : "Glue-up, by hand"}
            </span>
          </div>
          <label className="field">
            <span className="field-label">Name</span>
            <input type="text" value={step.name} onChange={(e) => dispatch({ type: "updateStep", id: step.id, update: (j) => ({ ...j, name: e.target.value }) })} />
          </label>
          {inlay && (
            <p className="derived">
              <span className="swatch" style={{ background: stepColor(inlay, project.steps) }} /> {sawing ? `Saws the backer off the plug of` : `Glues in the ${what} of`} "
              {inlay.name}".{" "}
              <button type="button" className="link" onClick={() => dispatch({ type: "setActiveStep", id: inlay.id })}>
                Open the inlay
              </button>
            </p>
          )}
        </section>
        <section>
          <p className="status-line">
            By hand, with no file.
            {!sawing && part && part.above > 0 ? ` As designed, ${what === "plug" ? "it stands" : "they stand"} ${fmt(round2(part.above))} mm above the stock's surface.` : ""}{" "}
            <HelpTip topic="byHand" />
          </p>
          {task.type === "saw" && (
            <>
              <div className="row">
                <NumberField
                  label="Left standing above the surface"
                  unit="mm"
                  value={task.leave}
                  onChange={(v) => v !== undefined && dispatch({ type: "updateStep", id: step.id, update: (j) => ({ ...j, task: { ...task, leave: v } }) })}
                  hint="At most what the saw can leave: the inlay's saw gap."
                />
              </div>
            </>
          )}
          {before && (
            <p className="status-line warn" role="status">
              {sawing
                ? `This step is above the glue-up of "${inlay?.name}" in the list, so there is no backer to saw off yet. Move it below.`
                : `This step is above "${inlay?.name}" in the list, so its pocket is not cut yet when the ${what} ${what === "plug" ? "is" : "are"} glued in. Move it below.`}
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
function useListedHeight(step: Step, on: boolean): number | null {
  const { project } = useApp();
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!on) return;
    let current = true;
    core
      .call("facingStart", project, step.id)
      .then((above) => current && setHeight(above))
      .catch(() => current && setHeight(null));
    return () => {
      current = false;
    };
  }, [project, step.id, on]);
  return on ? height : null;
}

function FacingFields({ step, inlay, onChange }: { step: Step; inlay: FacingOp; onChange: (change: Partial<FacingOp>) => void }) {
  const { project, tools } = useApp();
  const owners = regionOwners(project.steps);
  // The inlays whose shapes this facing covers: it can be set to trim their plugs flush.
  const inlays = [...new Set(step.regionIds.map((id) => owners.get(id)).filter((j): j is Step => j !== undefined))];
  const whole = step.regionIds.length === 0;
  const tool = resolveTool(inlay.toolId, tools, project);
  const listed = inlay.aboveAuto === true;
  const height = useListedHeight(step, listed);
  // Where the cut starts: as the list gives it, or as typed.
  const above = listed ? (height ?? 0) : inlay.above;
  // How far it reaches: as the inlays of its shapes give it, or as typed.
  const fromInlay = inlayMargin(step, project.steps);
  const follows = inlay.marginAuto === true && fromInlay !== null;
  const margin = follows ? fromInlay : inlay.margin;
  // The field being typed in, whose number the drawing marks out.
  const [hot, setHot] = useState<FacingHot>(null);
  const mark = (which: FacingHot) => (focused: boolean) => setHot(focused ? which : null);

  return (
    <>
      <FacingDiagram above={above} depth={inlay.depth} margin={whole ? null : margin} beyond={tool ? tool.diameter / 2 : null} hot={hot} />
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
          onFocusChange={mark("above")}
        />
        <NumberField label="Depth below the surface" unit="mm" min={listed && height === null ? -Infinity : -above} value={inlay.depth} onChange={(v) => v !== undefined && onChange({ depth: v })} help="facingDepth" onFocusChange={mark("depth")} />
        {!whole && <NumberField label="Margin" unit="mm" value={margin} disabled={follows} onChange={(v) => v !== undefined && onChange({ margin: v })} onFocusChange={mark("margin")} />}
      </div>
      {!whole && fromInlay !== null && (
        <label className="check">
          <input
            type="checkbox"
            checked={follows}
            // By hand, the field starts from what the inlay gave.
            onChange={(e) => onChange(e.target.checked ? { marginAuto: true } : { marginAuto: undefined, margin: fromInlay })}
          />
          Take the margin from the inlay's plug
        </label>
      )}
      {listed && height !== null && (
        <p className={`status-line${height > 0 ? "" : " warn"}`} role="status">
          {height > 0
            ? `By the glue-ups above this facing in the list, ${fmt(round2(height))} mm of wood stand above the surface where it cuts. Its files start where the wood stands on the stock itself, which is worked out when they are made.`
            : "When the list gets to this facing, nothing glued in stands above the surface where it cuts. Put it below the glue-up, or untick the box and give the height."}
        </p>
      )}

      {inlays.map((owner) => {
        const part = standingPart(owner);
        if (!part || part.above <= 0) return null;
        const set = (listed || Math.abs(inlay.above - part.above) < 1e-9) && inlay.depth === 0 && Math.abs(margin - part.margin) < 1e-9;
        return (
          <p className="derived" key={owner.id}>
            The {part.what} of "{owner.name}" {part.what === "inserts" ? "stand" : "stands"} {fmt(part.above)} mm above the surface once glued in.{" "}
            {set ? (
              "The fields are set to trim it flush."
            ) : (
              <button type="button" className="link" onClick={() => onChange({ ...(listed ? {} : { above: round2(part.above) }), depth: 0, ...(follows ? {} : { margin: part.margin }) })}>
                Set the fields to trim {part.what === "inserts" ? "them" : "it"} flush
              </button>
            )}
          </p>
        );
      })}

      {above > 0 && (
        <p className="hint">The 3D view of this file alone does not draw the wood above the surface.</p>
      )}
    </>
  );
}

/** Said once, whichever bit cuts the chamfer. */
const AFTER_THE_EDGE = "Run it after the edge has been cut: the bit's tip runs beside the edge, where the wood must be gone that deep.";

type Planned = { plan: EdgePlan } | { problem: string };

/**
 * For a chamfer: its passes as the core plans them, or why it cannot. Null
 * until known. Planned again only when what the plan depends on changes:
 * the step's task, wood and rows, and its bit.
 */
function useChamferPlan(step: Step): Planned | null {
  const { project } = useApp();
  const task = step.task;
  const bit = task.type === "chamfer" ? project.tools.find((t) => t.id === task.toolId) : undefined;
  const key = JSON.stringify([task, project.base.material, step.rowProfiles, step.cutOverrides, bit]);
  const [planned, setPlanned] = useState<{ key: string; result: Planned | null } | null>(null);
  const latest = useRef(project);
  latest.current = project;
  useEffect(() => {
    let current = true;
    core
      .call("chamferPlan", latest.current, step.id)
      .then((result) => current && setPlanned({ key, result }))
      .catch(() => current && setPlanned({ key, result: null }));
    return () => {
      current = false;
    };
  }, [key, step.id]);
  // A plan for other numbers is not shown while the new one is worked out.
  return planned?.key === key ? planned.result : null;
}

/** A chamfer's numbers, under a drawing of the bit against the edge as they place it. */
function ChamferFields({ step, inlay, onChange }: { step: Step; inlay: ChamferOp; onChange: (change: Partial<ChamferOp>) => void }) {
  const { project, tools } = useApp();
  // The field being typed in, whose numbers the drawing marks out.
  const [hot, setHot] = useState<ChamferHot>(null);
  const bit = resolveTool(inlay.toolId, tools, project);
  const clearance = inlay.tipClearance ?? DEFAULT_TIP_CLEARANCE;
  const cut = bit ? edgeCut(bit, inlay.width, clearance) : null;
  const planned = useChamferPlan(step);
  const plan = planned && "plan" in planned ? planned.plan : null;
  const problem = bit && planned && "problem" in planned ? planned.problem : null;
  const mark = (which: ChamferHot) => (focused: boolean) => setHot(focused ? which : null);
  return (
    <>
      {bit && cut && <ChamferDiagram bit={bit} width={inlay.width} clearance={clearance} side={inlay.side} hot={hot} plan={plan} blocked={problem !== null} />}
      {bit?.kind !== "corner_round" && (
        <div className="row">
          <NumberField label="Width" unit="mm" min={0.01} value={inlay.width} onChange={(v) => v !== undefined && onChange({ width: v })} onFocusChange={mark("width")} />
          <NumberField
            label="Tip clear of the edge"
            unit="mm"
            min={0}
            max={MAX_TIP_CLEARANCE}
            value={clearance}
            onChange={(v) => v !== undefined && onChange({ tipClearance: v === DEFAULT_TIP_CLEARANCE ? undefined : v })}
            onFocusChange={mark("clearance")}
          />
        </div>
      )}
      {problem && <p className="hint warn">{problem}</p>}
      <p className="hint">{AFTER_THE_EDGE}</p>
    </>
  );
}

/** The numbers of a V-carve inlay that are seldom changed: closed until asked for, and marked when one is not the usual. */
function FinerPoints({ inlay, onChange }: { inlay: VcarveInlay; onChange: (change: Partial<VcarveInlay>) => void }) {
  const fields = [
    { key: "floorRidge", label: "Ridges on the floor, at most" },
    { key: "reliefKeep", label: "Relief stays below the face by" },
    { key: "trimDepth", label: "Fit check judges the face at" },
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
              help={f.key}
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

function StepEditor({ step }: { step: InlayStep }) {
  const { project, tools, defaults } = useApp();
  const dispatch = useDispatch();
  const output = useOutput(step);
  const setup = stepSetup(step, project);
  const setSetup = (change: Partial<Setup>) => dispatch({ type: "updateStep", id: step.id, update: (j) => ({ ...j, setup: { ...stepSetup(j, project), ...change } }) });
  const ownSetup = !sameSetup(setup, defaults);
  // The depth being typed in, which the cross-section marks out.
  const [hot, setHot] = useState<InlayHot>(null);
  const mark = (which: InlayHot) => (focused: boolean) => setHot(focused ? which : null);
  const update = (change: Partial<Step>) => dispatch({ type: "updateStep", id: step.id, update: (j) => ({ ...j, ...change }) });
  const setInlay = (change: Partial<Task>) => update({ task: { ...step.task, ...change } as Task });
  const back = () => dispatch({ type: "setActiveStep", id: null });

  const remove = () => {
    const glue = glueOf(step, project.steps);
    if (!confirm(`Delete "${step.name}"? Its shapes become free again.${glue ? ` "${glue.name}" goes with it.` : ""}`)) return;
    dispatch({ type: "updateProject", update: (p) => ({ ...p, steps: withoutStep(p.steps, step.id) }) });
    dispatch({ type: "setActiveStep", id: null });
  };

  const inlay = step.task;
  const vbit = inlay.type === "vcarve" ? resolveTool(inlay.vbitToolId, tools, project) : undefined;
  const halfAngle = (((vbit?.tipAngle ?? 60) / 2) * Math.PI) / 180;
  const shapes = `${step.regionIds.length} shape${step.regionIds.length === 1 ? "" : "s"}`;

  return (
    <aside className="panel" aria-label={`Inlay ${step.name}`}>
      <div className="panel-scroll">
        <section>
          <div className="editor-head">
            <button className="link" onClick={back}>
              ‹ All operations
            </button>
            <span className="tag">
              <span className="swatch" style={{ background: stepColor(step, project.steps) }} />
              {inlay.type === "vcarve" ? "V-carve inlay" : "Flat inlay"}
            </span>
          </div>
          <label className="field">
            <span className="field-label">Name</span>
            <input type="text" value={step.name} onChange={(e) => update({ name: e.target.value })} />
          </label>
          <p className={`status-line${step.regionIds.length === 0 ? " warn" : ""}`}>
            {step.regionIds.length === 0 ? "No shapes yet." : `${shapes}.`} Click shapes in the drawing to add or remove them.
          </p>
        </section>

        <section>
          <h3>Depths and fit</h3>
          <InlayDiagram inlay={inlay} halfAngle={halfAngle} hot={hot} />
          {inlay.type === "vcarve" ? (
            <div className="row">
              <NumberField label="Engagement" unit="mm" min={0.01} value={inlay.engagementDepth} onChange={(v) => v !== undefined && setInlay({ engagementDepth: v })} onFocusChange={mark("engagement")} />
              <NumberField label="Glue gap" unit="mm" value={inlay.glueGap} onChange={(v) => v !== undefined && setInlay({ glueGap: v })} onFocusChange={mark("glue")} />
              <NumberField label="Saw gap" unit="mm" min={0.01} value={inlay.sawGap} onChange={(v) => v !== undefined && setInlay({ sawGap: v })} onFocusChange={mark("saw")} />
            </div>
          ) : (
            <>
              <div className="row">
                <NumberField label="Pocket depth" unit="mm" min={0.01} value={inlay.pocketDepth} onChange={(v) => v !== undefined && setInlay({ pocketDepth: v })} onFocusChange={mark("pocket")} />
                <NumberField label={inlay.insertStyle === "backer" ? "Plug board" : "Insert thickness"} unit="mm" min={0.01} value={inlay.insertThickness} onChange={(v) => v !== undefined && setInlay({ insertThickness: v })} onFocusChange={mark("insert")} />
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
              <div className="check-row">
                <label className="check">
                  <input type="checkbox" checked={inlay.relief} onChange={(e) => setInlay({ relief: e.target.checked })} />
                  Relieve the plug's narrow ridges and corner edges
                </label>
                <HelpTip topic="relief" />
              </div>
            </>
          )}
        </section>

        <section>
          <h3>Wood and tools</h3>
          <label className="field">
            <span className="field-label">Wood of the inlay</span>
            <MaterialSelect value={step.material} onChange={(material) => update({ material })} />
          </label>
          <ColorField
            label="Colour of the inlay's wood"
            value={stepColor(step, project.steps)}
            onChange={(color) => update({ color })}

          />
          {inlay.type === "vcarve" ? (
            <>
              <ToolPicker label="V-bit" kind="v_bit" value={inlay.vbitToolId} use="vcarve" onChange={(id) => setInlay({ vbitToolId: id })} />
              <ClearingTools label="End mills for the flat floor" ids={inlay.clearingToolIds} use="clearing" onChange={(ids) => setInlay({ clearingToolIds: ids })} />
            </>
          ) : (
            <>
              <ClearingTools label="End mills" ids={inlay.clearingToolIds} use="clearing" onChange={(ids) => setInlay({ clearingToolIds: ids })} />
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
                    <NumberField label="Saw gap" unit="mm" value={inlay.sawGap} onChange={(v) => v !== undefined && setInlay({ sawGap: v })} onFocusChange={mark("saw")} />
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
                  {plug && inlay.cutOut && <CutOutTool step={step} onChange={(id) => update({ cutOutToolId: id })} />}
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
                    {!inlay.tabs && (!plug || inlay.cutOut) ? "Without tabs it comes loose on the last pass: hold it down with tape." : ""}
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
              A new inlay starts with your defaults, set under{" "}
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

        <TrimOffer step={step} />

        <section>
          <Results step={step} state={output} />
          <div className="row end">
            <button className="danger" onClick={remove}>
              Delete inlay
            </button>
          </div>
        </section>
      </div>
      <GenerateBar step={step} state={output} />
    </aside>
  );
}

/**
 * The end mill that cuts a plug out of its board: the one the inlay's other
 * end mills would give, unless another is chosen. Says whether its cutting
 * edges reach through the board.
 */
function CutOutTool({ step, onChange }: { step: InlayStep; onChange: (id: string | undefined) => void }) {
  const { tools, project } = useApp();
  const dispatch = useDispatch();
  const choices = toolChoices("flat_end", tools, project);
  const usual = usualCutOutTool(step, tools, project);
  const depth = cutOutDepth(step, project);
  const picked = step.cutOutToolId;
  const chosen = picked !== undefined ? resolveTool(picked, tools, project) : usual;
  const hasEndMills = step.task.clearingToolIds.length > 0;

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
            {numberedName(tool, project)}
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
      {chosen && !chosen.cutting.some((c) => c.material === step.material) && (
        <span className="hint warn">This tool has no cutting settings for {step.material}. Add them in the tool list.</span>
      )}
    </label>
  );
}

/** An ordered list of end mills: add, remove, and move up or down. */
function ClearingTools(props: { label: string; ids: string[]; use: CutUse; onChange: (ids: string[]) => void }) {
  const { tools, lists, project, activeStepId } = useApp();
  const dispatch = useDispatch();
  const { ids } = props;
  /** Adds an end mill, started on the profile for what it is chosen for. */
  const add = (id: string) => {
    props.onChange([...ids, id]);
    if (activeStepId !== null) dispatch({ type: "updateStep", id: activeStepId, update: (j) => withDefaultProfile(j, id, props.use, tools, lists, project) });
  };
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
                {tool && <BitCut tool={tool} />}
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
          onChange={(e) => e.target.value !== "" && add(e.target.value)}
        >
          <option value="">{chosen.length === 0 ? "Choose an end mill…" : "Add another end mill…"}</option>
          {free.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {numberedName(tool, project)}
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
      </div>
  );
}

function ToolPicker(props: { label: string; kind: ToolKind | ToolKind[]; value: string | null; use: CutUse; hint?: string; onChange: (id: string | null) => void }) {
  const { tools, lists, project, activeStepId } = useApp();
  const dispatch = useDispatch();
  /** Chooses the tool, started on the profile for what it is chosen for. */
  const pick = (id: string | null) => {
    props.onChange(id);
    if (id !== null && activeStepId !== null) dispatch({ type: "updateStep", id: activeStepId, update: (j) => withDefaultProfile(j, id, props.use, tools, lists, project) });
  };
  const choices = toolChoices(props.kind, tools, project);
  const chosen: Tool | undefined = resolveTool(props.value, tools, project);
  const inList = (tool: Tool) => tools.some((t) => t.id === tool.id);

  return (
    <>
    <label className="field">
      <span className="field-label">{props.label}</span>
      <select value={chosen ? chosen.id : ""} onChange={(e) => pick(e.target.value === "" ? null : e.target.value)}>
        <option value="">Choose…</option>
        {choices.map((tool) => (
          <option key={tool.id} value={tool.id}>
            {numberedName(tool, project)}
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
    </label>
    {chosen && <BitCut tool={chosen} />}
    </>
  );
}

/** What an operation is cut in, which is not its own to choose: the stock's material, or the wood of the plug it trims. */
function CutIn({ step }: { step: Step }) {
  const { lists, project } = useApp();
  const owner = trimmedInlay(step, project);
  return (
    <p className="muted cut-in">
      {materialLabel(stepMaterial(step, project), lists)}, {owner ? `the wood of ${owner.name}` : "from the stock"}
    </p>
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
