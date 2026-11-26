// What an agent can do in the app: each command is one thing a person does
// on the screens, named and typed for something other than a mouse. A
// command changes the app through the same actions the screens dispatch, so
// what it does shows on the page, is saved as the user's own changes are,
// and a change to the drawing is one step of its undo history.
//
// A change to the project is checked by the core before it is made, as a
// project file is when it is written: a command never leaves the project in
// a state the app could not save.

import { core } from "../core/client";
import type {
  Built,
  BuildStats,
  CutResult,
  CutValues,
  CuttingSettings,
  DesignRegion,
  PocketPreview,
  Project,
  Ring,
  Step,
  StepType,
  StockTimeline,
  Task,
  Tool,
  ToolKind,
} from "../core/types";
import { isCancelled, remakeOutput, stockOf } from "../state/work";
import {
  addShape,
  duplicateShapes,
  emptiedSteps,
  mirrorOnBoard,
  moveOnBoard,
  removeShapes,
  rotateOnBoard,
  scaleOnBoard,
  trimBoard,
} from "../state/arrange";
import { activeLayerOf } from "../state/layers";
import {
  STEP_LABELS,
  TOOL_KIND_LABELS,
  allMaterials,
  currentResult,
  defaultInlay,
  feedMaterial,
  isAdaptive,
  materialLabel,
  today,
  displayName,
  emptyDesign,
  glueOf,
  glueStep,
  insertAfter,
  isByHand,
  isSuppressed,
  withSuppressed,
  isInlay,
  partName,
  partsOf,
  missingFor,
  missingSettings,
  newId,
  newProject,
  newStep,
  regionOwners,
  resolveTool,
  sawOf,
  sawStep,
  stepColor,
  stepToolIds,
  stockColor,
  trimFacing,
  withoutStep,
} from "../state/model";
import { ellipseRing, polygonRing, rectangleRing } from "../state/shapes";
import {
  loadStoredProject,
  message,
  type Action,
  type AppState,
  type Output,
  type Stage,
  type Timeline,
} from "../state/store";
import { hasUnsaved } from "../state/unsaved";
import * as db from "../storage/home";
import { isFolderPath } from "../state/folders";
import { fileStem } from "../util/files";
import type { Host } from "./host";
import { drawingSvg, reliefPng, svgToPng } from "./render";
import { object, problemWith, type Schema } from "./schema";

/**
 * Why a command did not do what it was asked: the code a caller branches on,
 * the message a person reads.
 *
 * - `unknown_command`: no command by that name
 * - `invalid_input`: the input does not fit, or would leave the project invalid
 * - `not_found`: a shape, step, tool or project named does not exist
 * - `invalid_state`: the app as it stands is in the way
 * - `busy`: the app is still loading
 * - `failed`: the work ran and did not succeed
 */
export class CommandError extends Error {
  constructor(
    readonly code:
      | "unknown_command"
      | "invalid_input"
      | "not_found"
      | "invalid_state"
      | "busy"
      | "failed",
    text: string,
  ) {
    super(text);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Input = Record<string, any>;

export interface Command {
  /** Lower case, words joined by underscores: the thing first, then what is done to it. */
  name: string;
  /** A few words, as a menu would say it. */
  title: string;
  /** For the agent: what it does, what it answers, and what to know before calling it. */
  description: string;
  inputSchema: Schema;
  /** Changes nothing. */
  readOnly?: boolean;
  /** Takes a file: the relay reads it from a `path` and hands it over as `file: { name, text }`. */
  takesFile?: boolean;
  /** Answers `files: [{ name, text }]`, which the relay writes to disk. */
  givesFiles?: boolean;
  run(input: Input, host: Host): Promise<unknown>;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const ids = (description: string): Schema => ({
  type: "array",
  items: { type: "integer", minimum: 0 },
  minItems: 1,
  description,
});
const STEP_TYPES = Object.keys(STEP_LABELS) as StepType[];

function designOf(state: AppState) {
  const design = state.project.design;
  if (!design)
    throw new CommandError(
      "invalid_state",
      "The project has no stock yet. Call stock_set to make one, or drawing_import to bring a drawing in.",
    );
  return design;
}

function shapesOf(state: AppState, wanted: number[]): number[] {
  const have = new Set(designOf(state).regions.map((r) => r.id));
  const missing = wanted.filter((id) => !have.has(id));
  if (missing.length > 0)
    throw new CommandError(
      "not_found",
      `The drawing has no shape ${missing.join(", ")}. project_get lists the shapes.`,
    );
  return [...new Set(wanted)];
}

function stepOf(state: AppState, id: string): Step {
  const step = state.project.steps.find((j) => j.id === id);
  if (!step)
    throw new CommandError(
      "not_found",
      `The project has no step "${id}". project_get lists the steps.`,
    );
  return step;
}

function boxOf(ring: Ring): [number, number, number, number] {
  const box: [number, number, number, number] = [
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
  ];
  for (const [x, y] of ring) {
    box[0] = Math.min(box[0], x);
    box[1] = Math.min(box[1], y);
    box[2] = Math.max(box[2], x);
    box[3] = Math.max(box[3], y);
  }
  return box;
}

function describeShape(r: DesignRegion, owners: Map<number, Step>) {
  const [x0, y0, x1, y1] = boxOf(r.outer);
  return {
    id: r.id,
    x: r3(x0),
    y: r3(y0),
    width: r3(x1 - x0),
    height: r3(y1 - y0),
    holes: r.holes.length,
    inlay: owners.get(r.id)?.id ?? null,
  };
}

/** Every tool a step may name: the tool list's, and the copies the project carries of tools that are no longer in it. */
function everyTool(state: AppState): Tool[] {
  return [
    ...state.tools,
    ...state.project.tools.filter(
      (t) => !state.tools.some((own) => own.id === t.id),
    ),
  ];
}

/** The numbers of a cutting row, as a command takes them. */
const CUT_VALUES: Record<string, Schema> = {
  rpm: { type: "integer", minimum: 1, maximum: 1_000_000 },
  feed: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000 },
  plunge: { type: "number", exclusiveMinimum: 0, maximum: 1_000_000 },
  stepover: {
    type: "number",
    exclusiveMinimum: 0,
    maximum: 1000,
    description: "mm, whatever stepoverUnit says",
  },
  stepoverUnit: { type: "string", enum: ["mm", "percent"] },
  stepdown: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
  passes: { type: "integer", minimum: 1, maximum: 1000 },
};

/** A row's numbers, as a log entry records them. */
function rowValues(row: CuttingSettings): CutValues {
  const values: CutValues = {
    rpm: row.rpm,
    feed: row.feed,
    plunge: row.plunge,
    stepover: row.stepover,
    stepdown: row.stepdown,
  };
  if (row.stepoverUnit !== undefined) values.stepoverUnit = row.stepoverUnit;
  if (row.passes !== undefined) values.passes = row.passes;
  return values;
}

/** A row as a command answers it: its numbers, and the result that counts for it now. */
function rowAnswer(row: CuttingSettings) {
  return {
    row: row.profile ? `${row.material}@${row.profile}` : row.material,
    ...rowValues(row),
    result: currentResult(row) ?? null,
    logEntries: row.log?.length ?? 0,
  };
}

/** A tool of the user's own list, and the place of one of its rows. A copy that only a project carries is not changed here. */
function ownRow(state: AppState, toolId: string, key: string): [Tool, number] {
  const tool = state.tools.find((t) => t.id === toolId);
  if (!tool) {
    const inProject = state.project.tools.some((t) => t.id === toolId);
    throw new CommandError(
      "not_found",
      inProject
        ? `"${toolId}" is only in this project, not in the tool list: it cannot be changed here.`
        : `There is no tool "${toolId}". tools_list gives the tools and their ids.`,
    );
  }
  const [material, profile, ...more] = key.split("@");
  if (!material || profile === "" || more.length > 0)
    throw new CommandError(
      "invalid_input",
      `"${key}" is not a row: name it as a material key, or material@profile.`,
    );
  const index = tool.cutting.findIndex(
    (c) =>
      c.material === material &&
      (c.profile ?? undefined) === (profile || undefined),
  );
  if (index < 0) {
    const rows =
      tool.cutting
        .map((c) => (c.profile ? `${c.material}@${c.profile}` : c.material))
        .join(", ") || "none";
    throw new CommandError(
      "not_found",
      `"${shown(tool)}" has no cutting row "${key}". Its rows: ${rows}.`,
    );
  }
  return [tool, index];
}

/** The row the key names in the list as it is now, or undefined. */
function rowNow(
  state: AppState,
  toolId: string,
  key: string,
): CuttingSettings | undefined {
  const [material, profile] = key.split("@");
  return state.tools
    .find((t) => t.id === toolId)
    ?.cutting.find(
      (c) =>
        c.material === material &&
        (c.profile ?? undefined) === (profile || undefined),
    );
}

/** Checks a changed tool, and the list with it, as the tool sheet and a saved tool file are checked. */
async function checkedTools(state: AppState, changed: Tool): Promise<void> {
  const problem = await core.call("validateTool", changed);
  if (problem) throw new CommandError("invalid_input", problem);
  try {
    await core.call("libraryToFile", {
      ...state.lists,
      tools: state.tools.map((t) => (t.id === changed.id ? changed : t)),
    });
  } catch (e) {
    throw new CommandError("invalid_input", message(e));
  }
}

/** A tool's name as the tool list shows it, with its coating. */
const shown = (tool: Tool | undefined) =>
  tool ? displayName(tool.name, tool.coating) : null;

function describeStep(step: Step, state: AppState) {
  const { project } = state;
  const task = step.task;
  return {
    id: step.id,
    name: step.name,
    type: task.type,
    kind: isInlay(task) ? "inlay" : isByHand(task) ? "by hand" : "operation",
    shapeIds: step.regionIds,
    ...(isInlay(task)
      ? { material: step.material, color: stepColor(step, project.steps) }
      : {}),
    task,
    ...(step.rowProfiles ? { rowProfiles: step.rowProfiles } : {}),
    ...(step.cutOverrides ? { cutOverrides: step.cutOverrides } : {}),
    ...(step.cutOutToolId ? { cutOutToolId: step.cutOutToolId } : {}),
    /** Left out of the files and of the stock: it is, or it is done by hand for an inlay that is. */
    ...(isSuppressed(step, project.steps)
      ? {
          suppressed: true,
          ...(step.suppressed ? {} : { suppressedWithInlay: true }),
        }
      : {}),
    tools: stepToolIds(step).map((id) => ({
      id,
      name: shown(resolveTool(id, state.tools, project)),
      numberInFiles: project.toolNumbers?.[id] ?? null,
    })),
    /** What has to be chosen before its files can be made, or null. */
    missing:
      missingFor(step) ??
      missingSettings(step, everyTool(state), state.lists, project),
  };
}

const SHAPES_MOST = 400;

function describeProject(state: AppState) {
  const { project } = state;
  const design = project.design;
  const owners = regionOwners(project.steps);
  return {
    project: { id: project.id, name: project.name },
    stock: design
      ? {
          width: r3(design.width),
          height: r3(design.height),
          thickness: project.base.thickness,
          material: project.base.material,
          color: stockColor(project),
        }
      : null,
    shapeCount: design?.regions.length ?? 0,
    shapes: design
      ? design.regions
          .slice(0, SHAPES_MOST)
          .map((r) => describeShape(r, owners))
      : [],
    ...(design && design.regions.length > SHAPES_MOST
      ? { shapesNote: `Only the first ${SHAPES_MOST} shapes are listed.` }
      : {}),
    steps: project.steps.map((step) => describeStep(step, state)),
    undo: { steps: state.undo.length, redoSteps: state.redo.length },
    screen: {
      view: state.view,
      stage: state.stage,
      openStepId: state.activeStepId,
      editingDrawing: state.arranging,
    },
    kept: state.saveError
      ? `not saved: ${state.saveError}`
      : state.home === "server"
        ? "on the server the page came from"
        : state.home === "folder"
          ? "in a folder on the user's computer"
          : "in this browser",
  };
}

/** Refuses a change the core would not write to a project file. A project that is invalid already is let through: the change is not what broke it. */
async function checked(host: Host, action: Action): Promise<void> {
  const next = host.preview(action).project;
  try {
    await core.call("projectToFile", next);
  } catch (e) {
    const wasValid = await core
      .call("projectToFile", host.state().project)
      .then(
        () => true,
        () => false,
      );
    if (wasValid) throw new CommandError("invalid_input", message(e));
  }
}

/** Makes a change to the project, once the core has no objection to it. */
async function change(host: Host, action: Action): Promise<AppState> {
  await checked(host, action);
  return host.apply(action);
}

const editDrawing = (update: (project: Project) => Project): Action => ({
  type: "editDrawing",
  update,
});

function leaveGuard() {
  if (hasUnsaved())
    throw new CommandError(
      "invalid_state",
      "A tool's sheet is open in the app with changes that are not saved. Ask the user to save or discard them first.",
    );
}

/** The keys of a step's settings that a default does not have, and may be set or taken away (null). */
const OPTIONAL_KEYS: Record<StepType, string[]> = {
  vcarve: ["startDepth", "floorRidge", "reliefKeep", "trimDepth"],
  flat: ["startDepth"],
  pocket: ["startDepth", "direction"],
  facing: ["startDepth", "aboveAuto", "marginAuto", "direction"],
  contour: ["startDepth"],
  chamfer: ["startDepth", "tipClearance"],
  glue: [],
  saw: [],
};

/** What each setting of a step means, for step_settings. From the data model (core/types.ts). */
const SETTING_NOTES: Record<string, string> = {
  engagementDepth: "How deep the plug's walls engage the pocket's.",
  glueGap: "Space left under the plug for glue.",
  sawGap:
    "Space between the stock's surface and the plug's backer, where the saw runs.",
  clearingToolIds:
    "Flat end mills that clear the area, in the order they are used. A list of tool ids.",
  vbitToolId: "The V-bit that cuts the walls. A tool id.",
  toolId:
    "The tool that cuts. A tool id: a flat end mill, or for a chamfer a V-bit or corner-rounding bit.",
  cutOut: "Cut the finished plug out of a larger board.",
  tabs: "Hold the part to its board with tabs across the cut, to be cut by hand afterwards. Meant for a cut right through; set false for a groove.",
  plugMargin: "Width of blank left around the shapes on the plug.",
  plugThickness: "Thickness of the plug's blank.",
  relief:
    "Cut back the tips of the plug's narrow ridges by the glue gap, so they cannot hold it up.",
  floorRidge:
    "Highest ridge the V-bit may leave between passes on a flat floor. Default 0.1.",
  reliefKeep:
    "How far below the finished face a relief cut stays. Default 0.5.",
  trimDepth:
    "How far below the surface the fit check judges the finished face. Default 0.1.",
  pocketDepth: "Depth of the pocket.",
  allowance: "Clearance between insert and pocket, per side.",
  insertStyle:
    '"loose": pieces cut right through their board; mirrored, to go in face down, where an end mill wider than the smallest has to cut them out. "backer": one mirrored plug on a backer.',
  insertThickness: "Thickness of the board the insert is cut from.",
  insertMargin: "Width of board left around the shapes on the insert's board.",
  depth:
    "How deep the cut goes below the surface. Contour: null cuts right through the stock. Facing: how far below the surface the area ends up.",
  startDepth:
    "How deep the cut starts, where the wood above is gone already. Absent: at the surface. Inlay: the surface its pocket is cut into, such as an earlier pocket's floor; the plug is cut as before. Facing: not with wood above the surface.",
  pattern:
    '"offset": rings that follow the outline. "raster": straight passes side to side.',
  direction: 'Which way raster passes run: "longer" (default), "x" or "y".',
  side: 'Which side of the outline the tool runs on: "outside", "inside", or for a contour "on". For a chamfer: the side the wood has been cut away on.',
  above: "Facing: wood standing above the surface that is milled away first.",
  aboveAuto: "Facing: take `above` from what was glued in before it.",
  margin: "Facing: how far beyond the box around its shapes the area reaches.",
  marginAuto: "Facing: take the margin from the inlays its shapes belong to.",
  width:
    "Chamfer: width of the bevel seen from above. A corner-rounding bit cuts its own radius.",
  tipClearance:
    "Chamfer: how far a V-bit's tip is kept beyond the edge. Default 0.2.",
  inlayId: "The inlay this step is done for. Set by forInlay.",
  leave: "How far above the surface the saw leaves the plug standing.",
};

/** A step's settings with a patch made to them: a key named is set, an optional one given as null is taken away. */
function patchTask(task: Task, patch: Input): Task {
  const type = task.type;
  const fixed = Object.keys(defaultInlay(type)).filter(
    (key) => key !== "type" && key !== "inlayId",
  );
  const optional = OPTIONAL_KEYS[type];
  const out: Input = { ...task };
  for (const [key, value] of Object.entries(patch)) {
    if (!fixed.includes(key) && !optional.includes(key)) {
      throw new CommandError(
        "invalid_input",
        `task.${key} is not a setting of a ${STEP_LABELS[type].toLowerCase()}. It has: ${[...fixed, ...optional].join(", ")}.`,
      );
    }
    if (value === null && optional.includes(key)) delete out[key];
    else out[key] = value;
  }
  return out as Task;
}

/** Checks that the tools a step names exist and are of the kind their place takes. */
function checkTools(step: Step, state: AppState): void {
  const task = step.task;
  const need = (id: string | null, kinds: ToolKind[], what: string) => {
    if (id === null) return;
    if (typeof id !== "string")
      throw new CommandError(
        "invalid_input",
        `${what} must be a tool's id, or null.`,
      );
    const tool = resolveTool(id, state.tools, state.project);
    if (!tool)
      throw new CommandError(
        "not_found",
        `There is no tool "${id}". tools_list gives the tools and their ids.`,
      );
    if (!kinds.includes(tool.kind)) {
      throw new CommandError(
        "invalid_input",
        `${what} takes ${kinds.map((k) => TOOL_KIND_LABELS[k].toLowerCase()).join(" or ")}, and "${tool.name}" is ${TOOL_KIND_LABELS[tool.kind].toLowerCase()}.`,
      );
    }
  };
  const list = (value: unknown, what: string) => {
    if (!Array.isArray(value))
      throw new CommandError(
        "invalid_input",
        `${what} must be a list of tool ids.`,
      );
    for (const id of value) need(id, ["flat_end"], what);
  };
  if (task.type === "vcarve") {
    list(task.clearingToolIds, "task.clearingToolIds");
    need(task.vbitToolId, ["v_bit"], "task.vbitToolId");
  } else if (task.type === "flat" || task.type === "pocket")
    list(task.clearingToolIds, "task.clearingToolIds");
  else if (task.type === "facing" || task.type === "contour")
    need(task.toolId, ["flat_end"], "task.toolId");
  else if (task.type === "chamfer")
    need(task.toolId, ["v_bit", "corner_round"], "task.toolId");
  if (step.cutOutToolId !== undefined)
    need(step.cutOutToolId, ["flat_end"], "cutOutToolId");
}

/** An inlay's shapes are its own: one wood per shape. */
function checkOwners(step: Step, state: AppState): void {
  if (!isInlay(step.task)) return;
  const owners = regionOwners(
    state.project.steps.filter((j) => j.id !== step.id),
  );
  const taken = step.regionIds.filter((id) => owners.has(id));
  if (taken.length > 0) {
    throw new CommandError(
      "invalid_input",
      `Shape ${taken.join(", ")} already belongs to "${owners.get(taken[0])!.name}". A shape is one wood, so it belongs to one inlay.`,
    );
  }
}

function describeStats(stats: BuildStats) {
  return {
    lines: stats.lines,
    cuttingLength: r3(stats.cuttingLength),
    minutes: r3(stats.minutes + stats.toolChangeMinutes),
    toolChanges: stats.toolChanges,
    tools: stats.perTool.map((t) => ({
      number: t.number,
      name: t.name,
      minutes: r3(t.minutes),
    })),
  };
}

const PROBLEMS_MOST = 20;
const firstProblems = (problems: { line: number; message: string }[]) => ({
  problemCount: problems.length,
  ...(problems.length > 0
    ? { problems: problems.slice(0, PROBLEMS_MOST) }
    : {}),
});

function describeBuilt(built: Built) {
  return {
    fileName: built.fileName,
    board: built.stock,
    ...describeStats(built.stats),
    /** What to do before the file is run. */
    before: built.before,
    warnings: built.warnings,
    ...(built.flatFit ? { fit: built.flatFit } : {}),
    ...(built.narrow.length > 0
      ? { narrowStretches: built.narrow.length }
      : {}),
  };
}

/** What a command answers when the user ended its work on the page. */
const CALLED_OFF =
  "The user cancelled this on the page before it was done. Nothing was made. Ask them before trying again.";

/** Takes the stock through the list, shows it on the page, and answers with the result. */
async function workOut(
  host: Host,
): Promise<{ timeline: Timeline; result: StockTimeline }> {
  const project = host.state().project;
  if (!project.design)
    throw new CommandError("invalid_state", "The project has no stock yet.");
  let result: StockTimeline;
  try {
    result = await stockOf(project, "agent");
  } catch (e) {
    // Called off on the page: what there was of the stock is left as it is.
    if (isCancelled(e)) throw new CommandError("failed", CALLED_OFF);
    const timeline = { project, result: null, errors: message(e).split("\n") };
    await host.apply({ type: "setTimeline", timeline });
    throw new CommandError("failed", message(e));
  }
  const timeline = { project, result, errors: [] };
  await host.apply({ type: "setTimeline", timeline });
  return { timeline, result };
}

/** The stock's list as it was last worked out, if the project has not changed since; else worked out now. */
async function freshTimeline(
  host: Host,
): Promise<{ timeline: Timeline; result: StockTimeline }> {
  const { timeline, project } = host.state();
  if (timeline && timeline.result && timeline.project === project)
    return { timeline, result: timeline.result };
  return workOut(host);
}

function describeTimeline(result: StockTimeline, project: Project) {
  const name = (id: string) =>
    project.steps.find((j) => j.id === id)?.name ?? id;
  return {
    steps: result.steps.map((step, index) => ({
      at: index + 1,
      stepId: step.stepId,
      name: name(step.stepId),
      byHand: step.byHand,
      ...(step.suppressed ? { suppressed: true } : {}),
      file: step.file === null ? null : step.file + 1,
      errors: step.errors,
      warnings: step.warnings,
      ...firstProblems(step.problems),
      ...(step.seat
        ? {
            seat: {
              height: r3(step.seat.height),
              proud: r3(step.seat.proud),
              above: r3(step.seat.above),
            },
          }
        : {}),
      ...(step.stats
        ? { minutes: r3(step.stats.minutes + step.stats.toolChangeMinutes) }
        : {}),
    })),
    /** The files for the stock, in the order they are run: the steps from one done by hand to the next share a file. */
    files: result.files.map((file, index) => ({
      file: index + 1,
      steps: file.stepIds.map(name),
      complete: file.complete,
      errors: file.errors,
      ...firstProblems(file.problems),
      ...(file.built ? describeBuilt(file.built) : {}),
    })),
    /** The plug or insert file of each inlay, cut from a board of its own. */
    parts: result.parts.map((part) => ({
      stepId: part.stepId,
      name: name(part.stepId),
      errors: part.errors,
      ...firstProblems(part.problems),
      ...(part.built ? describeBuilt(part.built) : {}),
    })),
  };
}

const widthSchema: Schema = {
  type: "integer",
  minimum: 300,
  maximum: 2000,
  description: "Width of the picture in pixels. Default 1000.",
};

export const COMMANDS: Command[] = [
  {
    name: "project_get",
    title: "Read the project",
    description:
      "The open project: its stock (width, height along Y, thickness, material), every shape of the drawing with its id and its box on the stock (x, y of its lower left corner; mm; origin at the stock's lower left, Y up), and the steps in the order they are done, each with its settings (task), its tools and `missing`: what must still be chosen before its files can be made. Read this before changing anything.",
    inputSchema: object({}),
    readOnly: true,
    run: async (_input, host) => describeProject(host.state()),
  },
  {
    name: "projects_list",
    title: "List the kept projects",
    description:
      "The projects kept in this browser (or on the server the page came from), last changed first, which one is open, and the folders they are filed in. A folder is its path, with / between nested ones (Gifts/Christmas); a project's folder is empty when it is in none.",
    inputSchema: object({}),
    readOnly: true,
    run: async (_input, host) => {
      const shelf = await db.readShelf();
      return {
        open: host.state().project.id,
        folders: shelf.folders,
        projects: shelf.projects.map((p) => ({
          id: p.id,
          name: p.name,
          folder: p.folder,
          modified: new Date(p.modified).toISOString(),
        })),
      };
    },
  },
  {
    name: "project_move",
    title: "File a project in a folder",
    description:
      "Files a kept project (the open one unless an id from projects_list is given) in a folder, which is made when it is not there, or in none with an empty folder. The project itself is not changed. A folder is up to four names with / between them.",
    inputSchema: object(
      {
        id: { type: "string", description: "Default: the open project." },
        folder: {
          type: "string",
          description: "Such as Gifts/Christmas. Empty for no folder.",
        },
      },
      ["folder"],
    ),
    run: async (input, host) => {
      const id = input.id ?? host.state().project.id;
      if (input.folder !== "" && !isFolderPath(input.folder))
        throw new CommandError(
          "invalid_input",
          `"${input.folder}" cannot be a folder: up to four names with / between them, each up to 60 characters, none of / \\ : * ? " < > | in a name, and no dot or space at either end of one.`,
        );
      if (!(await db.listProjects()).some((p) => p.id === id))
        throw new CommandError(
          "not_found",
          id === host.state().project.id
            ? "The open project is not kept yet: it is once it has a drawing."
            : `No project "${id}" is kept. projects_list lists them.`,
        );
      let folder: string;
      try {
        folder = await db.moveProject(id, input.folder);
      } catch (e) {
        throw new CommandError("failed", message(e));
      }
      const shelf = await db.readShelf();
      await host.apply({ type: "setProjects", ...shelf });
      return { project: { id, folder }, folders: shelf.folders };
    },
  },
  {
    name: "project_open",
    title: "Open a kept project",
    description:
      "Opens one of the kept projects by its id (from projects_list) in place of the open one, which stays kept.",
    inputSchema: object({ id: { type: "string" } }, ["id"]),
    run: async (input, host) => {
      leaveGuard();
      let project: Project;
      try {
        project = await loadStoredProject(input.id);
      } catch (e) {
        throw new CommandError("not_found", message(e));
      }
      return describeProject(
        await host.apply({ type: "openProject", project }),
      );
    },
  },
  {
    name: "project_new",
    title: "Start a new project",
    description:
      "Starts an empty project and shows it on the page in place of the open one, which stays kept and can be opened again. It has no stock yet: call stock_set or drawing_import next.",
    inputSchema: object({
      name: { type: "string", description: "Default: Untitled inlay." },
    }),
    run: async (input, host) => {
      leaveGuard();
      return describeProject(
        await host.apply({
          type: "openProject",
          project: newProject(input.name || undefined),
        }),
      );
    },
  },
  {
    name: "project_rename",
    title: "Rename the project",
    description: "Gives the open project another name.",
    inputSchema: object({ name: { type: "string" } }, ["name"]),
    run: async (input, host) => {
      const state = await change(host, {
        type: "updateProject",
        update: (p) => ({ ...p, name: input.name }),
      });
      return { project: { id: state.project.id, name: state.project.name } };
    },
  },
  {
    name: "project_save",
    title: "Save the project to a file",
    description:
      "Writes the open project as a project file (.task.json), which the app opens again on any computer.",
    inputSchema: object({}),
    givesFiles: true,
    run: async (_input, host) => {
      const project = host.state().project;
      try {
        return {
          files: [
            {
              name: `${fileStem(project.name)}.task.json`,
              text: await core.call("projectToFile", project),
            },
          ],
        };
      } catch (e) {
        throw new CommandError("failed", message(e));
      }
    },
  },
  {
    name: "project_load",
    title: "Open a project file",
    description:
      "Opens a project file (.task.json) from disk in place of the open project, which stays kept. A file whose project is kept here already under the same id opens as a copy.",
    inputSchema: object(
      {
        file: object({ name: { type: "string" }, text: { type: "string" } }, [
          "name",
          "text",
        ]),
      },
      ["file"],
    ),
    takesFile: true,
    run: async (input, host) => {
      leaveGuard();
      let project: Project;
      try {
        project = await core.call("projectFromFile", input.file.text);
      } catch (e) {
        throw new CommandError(
          "invalid_input",
          `${input.file.name}: ${message(e)}`,
        );
      }
      const clash =
        project.id !== host.state().project.id &&
        (await db.listProjects()).some((p) => p.id === project.id);
      const state = await host.apply({
        type: "openProject",
        project: clash ? { ...project, id: newId() } : project,
      });
      return { openedAsCopy: clash, ...describeProject(state) };
    },
  },
  {
    name: "stock_set",
    title: "Set the stock",
    description:
      "Sets the size, thickness, material or colour of the stock: the board everything is cut into. Only what is named changes. On a project without a stock it makes one (200 × 150 mm unless given). Shapes stay where they are; the stock never grows by itself, and shapes may lie outside it.",
    inputSchema: object({
      width: {
        type: "number",
        exclusiveMinimum: 0,
        description: "Along X, mm.",
      },
      height: {
        type: "number",
        exclusiveMinimum: 0,
        description: "Along Y, mm.",
      },
      thickness: { type: "number", exclusiveMinimum: 0, description: "mm." },
      material: {
        type: "string",
        description:
          "A material key from tools_list's `materials`, such as hardwood.",
      },
      color: {
        type: "string",
        description: "The wood's colour in the app's pictures, as #rrggbb.",
      },
      fitToShapes: {
        type: "number",
        minimum: 0,
        description:
          "Instead of width and height: make the stock the extent of the shapes plus this margin on every side, mm.",
      },
    }),
    run: async (input, host) => {
      if (
        input.material !== undefined &&
        !allMaterials(host.state().lists).some(
          (m) => m.value === input.material,
        )
      ) {
        throw new CommandError(
          "not_found",
          `There is no material "${input.material}". There are: ${allMaterials(
            host.state().lists,
          )
            .map((m) => m.value)
            .join(", ")}.`,
        );
      }
      if (input.color !== undefined && !/^#[0-9a-f]{6}$/i.test(input.color))
        throw new CommandError("invalid_input", "color must be #rrggbb.");
      if (!host.state().project.design)
        await host.apply({
          type: "addDrawing",
          design: emptyDesign(),
          replace: false,
        });
      const size = {
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
      };
      if (Object.keys(size).length > 0)
        await change(
          host,
          editDrawing((p) =>
            p.design ? { ...p, design: { ...p.design, ...size } } : p,
          ),
        );
      if (input.fitToShapes !== undefined) {
        if (designOf(host.state()).regions.length === 0)
          throw new CommandError(
            "invalid_state",
            "There are no shapes to fit the stock to.",
          );
        await change(
          host,
          editDrawing((p) =>
            p.design
              ? { ...p, design: trimBoard(p.design, input.fitToShapes) }
              : p,
          ),
        );
      }
      const base = {
        ...(input.thickness !== undefined
          ? { thickness: input.thickness }
          : {}),
        ...(input.material !== undefined ? { material: input.material } : {}),
        ...(input.color !== undefined ? { color: input.color } : {}),
      };
      if (Object.keys(base).length > 0)
        await change(host, {
          type: "updateProject",
          update: (p) => ({ ...p, base: { ...p.base, ...base } }),
        });
      return { stock: describeProject(host.state()).stock };
    },
  },
  {
    name: "drawing_import",
    title: "Bring in a drawing",
    description:
      "Reads an SVG or DXF drawing (text or binary DXF) from disk and puts its closed shapes on the stock. The first drawing of a project sets the stock to its page; a later one is added in the middle of the stock, beside what is there, and shapes_move then puts it in place. With replace, it takes the place of the whole drawing, and every step made from the old one goes. Answers the new shapes and what of the file was not read. Ends of lines are joined where they meet within 0.01 mm; when outlines were left open, notRead.joinable names a larger gap that would close them: call again with joinGap and replace to bring the drawing in that way, after telling the user.",
    inputSchema: object(
      {
        file: object(
          {
            name: { type: "string" },
            text: { type: "string" },
            base64: {
              type: "string",
              description: "The file's bytes, for a binary DXF.",
            },
          },
          ["name"],
        ),
        replace: { type: "boolean" },
        joinGap: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 2,
          description: "Join ends of open outlines across gaps up to this, mm.",
        },
      },
      ["file"],
    ),
    takesFile: true,
    run: async (input, host) => {
      const before = host.state();
      if (
        typeof input.file.text !== "string" &&
        typeof input.file.base64 !== "string"
      )
        throw new CommandError(
          "invalid_input",
          "file needs its text, or its bytes as base64.",
        );
      const bytes = (): Uint8Array =>
        typeof input.file.base64 === "string"
          ? Uint8Array.from(atob(input.file.base64), (c) => c.charCodeAt(0))
          : new TextEncoder().encode(input.file.text);
      // By its name, or else by how it starts: a binary DXF, or a text one's first section.
      const head = new TextDecoder("latin1")
        .decode(bytes().slice(0, 64))
        .replace(/^\uFEFF|^\u00EF\u00BB\u00BF/, "");
      const dxf =
        input.file.name.toLowerCase().endsWith(".dxf") ||
        head.startsWith("AutoCAD Binary DXF") ||
        /^\s*0\s*\r?\n\s*(SECTION|EOF)\b/.test(head);
      let read;
      try {
        read = dxf
          ? await core.call(
              "importDxf",
              bytes(),
              input.file.name,
              input.joinGap,
            )
          : await core.call(
              "importSvg",
              input.file.text ?? new TextDecoder().decode(bytes()),
              input.file.name,
              input.joinGap,
            );
      } catch (e) {
        throw new CommandError(
          "invalid_input",
          `${input.file.name}: ${message(e)}`,
        );
      }
      if (read.design.regions.length === 0) {
        const joinable = read.report.joinable;
        const hint = joinable
          ? ` ${read.report.openOutlines} outline${read.report.openOutlines === 1 ? " does" : "s do"} not close; joinGap ${joinable.gap} would close ${joinable.closes}.`
          : read.report.openOutlines > 0
            ? ` ${read.report.openOutlines} outline${read.report.openOutlines === 1 ? " does" : "s do"} not close, also with gaps up to 2 mm joined.`
            : "";
        throw new CommandError(
          "invalid_input",
          `No closed shapes were found in ${input.file.name}. The app needs filled shapes, or lines that join into closed outlines.${hint}`,
        );
      }
      const had = new Set(before.project.design?.regions.map((r) => r.id));
      const replace = input.replace === true;
      let state = await host.apply({
        type: "addDrawing",
        design: read.design,
        replace,
      });
      await host.apply({ type: "setImportReport", report: read.report });
      // Adding to a drawing leaves the page editing it, with the new shapes picked. An agent places them by number.
      if (state.arranging && !before.arranging)
        state = await host.apply({ type: "setArranging", on: false });
      const design = designOf(state);
      const owners = regionOwners(state.project.steps);
      const added =
        replace || had.size === 0
          ? design.regions
          : design.regions.filter((r) => !had.has(r.id));
      return {
        added: added.length,
        shapes: added
          .slice(0, SHAPES_MOST)
          .map((r) => describeShape(r, owners)),
        ...(added.length > SHAPES_MOST
          ? {
              shapesNote: `Only the first ${SHAPES_MOST} of the ${added.length} shapes added are listed.`,
            }
          : {}),
        stock: describeProject(state).stock,
        notRead: read.report,
      };
    },
  },
  {
    name: "shape_add",
    title: "Draw a shape",
    description:
      "Adds one closed shape to the drawing and answers its id. circle: cx, cy of its middle and diameter. rectangle and ellipse: x, y of the lower left corner of its box, width, height (corner rounds a rectangle's corners). polygon: cx, cy of its middle, radius to its corners, sides, and angle of the first corner in degrees counter-clockwise from +X (default 90: a corner at the top). outline: points, a list of [x, y] around it. A shape wholly inside another becomes a hole in it, as in the app. One undo step.",
    inputSchema: object(
      {
        shape: {
          type: "string",
          enum: ["circle", "rectangle", "ellipse", "polygon", "outline"],
        },
        x: {
          type: "number",
          description: "rectangle, ellipse: left of its box.",
        },
        y: {
          type: "number",
          description: "rectangle, ellipse: bottom of its box.",
        },
        diameter: {
          type: "number",
          exclusiveMinimum: 0,
          description: "circle.",
        },
        width: { type: "number", exclusiveMinimum: 0 },
        height: { type: "number", exclusiveMinimum: 0 },
        corner: { type: "number", minimum: 0 },
        cx: { type: "number", description: "circle, polygon: its middle." },
        cy: { type: "number", description: "circle, polygon: its middle." },
        radius: { type: "number", exclusiveMinimum: 0 },
        sides: { type: "integer", minimum: 3, maximum: 100 },
        angle: { type: "number" },
        points: {
          type: "array",
          minItems: 3,
          items: {
            type: "array",
            minItems: 2,
            maxItems: 2,
            items: { type: "number" },
          },
        },
      },
      ["shape"],
    ),
    run: async (input, host) => {
      designOf(host.state());
      const need = (...keys: string[]) => {
        const lacking = keys.filter((key) => input[key] === undefined);
        if (lacking.length > 0)
          throw new CommandError(
            "invalid_input",
            `A ${input.shape} needs ${lacking.join(", ")}.`,
          );
      };
      let ring: Ring;
      if (input.shape === "circle") {
        need("cx", "cy", "diameter");
        const r = input.diameter / 2;
        ring = ellipseRing(
          input.cx - r,
          input.cy - r,
          input.cx + r,
          input.cy + r,
        );
      } else if (input.shape === "rectangle") {
        need("x", "y", "width", "height");
        ring = rectangleRing(
          input.x,
          input.y,
          input.x + input.width,
          input.y + input.height,
          input.corner ?? 0,
        );
      } else if (input.shape === "ellipse") {
        need("x", "y", "width", "height");
        ring = ellipseRing(
          input.x,
          input.y,
          input.x + input.width,
          input.y + input.height,
        );
      } else if (input.shape === "polygon") {
        need("cx", "cy", "radius", "sides");
        ring = polygonRing(
          input.cx,
          input.cy,
          input.radius,
          input.sides,
          ((input.angle ?? 90) * Math.PI) / 180,
        );
      } else {
        need("points");
        ring = input.points as Ring;
      }
      let id = -1;
      const state = await change(
        host,
        editDrawing((p) => {
          if (!p.design) return p;
          const added = addShape(
            p.design,
            ring,
            activeLayerOf(p.design, null).id,
          );
          id = added.id;
          return { ...p, design: added.design };
        }),
      );
      const shape = designOf(state).regions.find((r) => r.id === id);
      if (!shape)
        throw new CommandError("failed", "The shape could not be added.");
      return { shape: describeShape(shape, regionOwners(state.project.steps)) };
    },
  },
  {
    name: "shapes_move",
    title: "Move shapes",
    description: "Moves shapes by dx and dy, mm (Y up). One undo step.",
    inputSchema: object(
      {
        ids: ids("The shapes' ids."),
        dx: { type: "number" },
        dy: { type: "number" },
      },
      ["ids", "dx", "dy"],
    ),
    run: (input, host) =>
      transformShapes(host, input.ids, (design, picked) =>
        moveOnBoard(design, picked, input.dx, input.dy),
      ),
  },
  {
    name: "shapes_rotate",
    title: "Turn shapes",
    description:
      "Turns shapes together about the middle of their box, counter-clockwise, in degrees. One undo step.",
    inputSchema: object(
      { ids: ids("The shapes' ids."), degrees: { type: "number" } },
      ["ids", "degrees"],
    ),
    run: (input, host) =>
      transformShapes(host, input.ids, (design, picked) =>
        rotateOnBoard(design, picked, input.degrees),
      ),
  },
  {
    name: "shapes_scale",
    title: "Scale shapes",
    description:
      "Scales shapes together by a factor (2 doubles them), keeping the lower left corner of their box where it is. One undo step.",
    inputSchema: object(
      {
        ids: ids("The shapes' ids."),
        factor: { type: "number", exclusiveMinimum: 0 },
      },
      ["ids", "factor"],
    ),
    run: (input, host) =>
      transformShapes(host, input.ids, (design, picked) =>
        scaleOnBoard(design, picked, input.factor),
      ),
  },
  {
    name: "shapes_mirror",
    title: "Mirror shapes",
    description:
      'Mirrors shapes together within their box: axis "x" swaps left and right, "y" swaps top and bottom. One undo step.',
    inputSchema: object(
      {
        ids: ids("The shapes' ids."),
        axis: { type: "string", enum: ["x", "y"] },
      },
      ["ids", "axis"],
    ),
    run: (input, host) =>
      transformShapes(host, input.ids, (design, picked) =>
        mirrorOnBoard(design, picked, input.axis),
      ),
  },
  {
    name: "shapes_duplicate",
    title: "Copy shapes",
    description:
      "Copies shapes and puts the copy to the right of the originals, `gap` mm away (default 5). Answers the copies, which belong to no inlay. One undo step.",
    inputSchema: object(
      { ids: ids("The shapes' ids."), gap: { type: "number", minimum: 0 } },
      ["ids"],
    ),
    run: async (input, host) => {
      const picked = shapesOf(host.state(), input.ids);
      let made: number[] = [];
      const state = await change(
        host,
        editDrawing((p) => {
          if (!p.design) return p;
          const copy = duplicateShapes(p.design, picked, input.gap ?? 5);
          made = copy.ids;
          return { ...p, design: copy.design };
        }),
      );
      const owners = regionOwners(state.project.steps);
      return {
        shapes: designOf(state)
          .regions.filter((r) => made.includes(r.id))
          .map((r) => describeShape(r, owners)),
      };
    },
  },
  {
    name: "shapes_remove",
    title: "Delete shapes",
    description:
      "Deletes shapes from the drawing and from the steps that used them. A step left without shapes is removed too: the answer names them. Deleting every shape is refused; replace the drawing instead. One undo step, which also brings those steps back.",
    inputSchema: object({ ids: ids("The shapes' ids.") }, ["ids"]),
    run: async (input, host) => {
      const before = host.state();
      const picked = shapesOf(before, input.ids);
      if (picked.length === designOf(before).regions.length) {
        throw new CommandError(
          "invalid_input",
          "This would leave the stock without shapes. To start over, bring in another drawing with replace.",
        );
      }
      const removedSteps = emptiedSteps(before.project, picked);
      const state = await change(
        host,
        editDrawing((p) => removeShapes(p, picked)),
      );
      return {
        removed: picked,
        removedSteps,
        shapeCount: designOf(state).regions.length,
      };
    },
  },
  {
    name: "history_undo",
    title: "Undo",
    description:
      "Takes back the last change to the drawing (shapes and stock size), as the app's Undo does. Settings of steps are not part of this history.",
    inputSchema: object({}),
    run: async (_input, host) => {
      if (host.state().undo.length === 0)
        throw new CommandError("invalid_state", "There is nothing to undo.");
      const state = await host.apply({ type: "undoDrawing" });
      return {
        undo: { steps: state.undo.length, redoSteps: state.redo.length },
        shapeCount: state.project.design?.regions.length ?? 0,
      };
    },
  },
  {
    name: "history_redo",
    title: "Redo",
    description:
      "Makes the change to the drawing again that the last undo took back.",
    inputSchema: object({}),
    run: async (_input, host) => {
      if (host.state().redo.length === 0)
        throw new CommandError("invalid_state", "There is nothing to redo.");
      const state = await host.apply({ type: "redoDrawing" });
      return {
        undo: { steps: state.undo.length, redoSteps: state.redo.length },
        shapeCount: state.project.design?.regions.length ?? 0,
      };
    },
  },
  {
    name: "tools_list",
    title: "List the tools",
    description:
      "The user's tools, each with its id, kind, sizes (mm) and `rows`: the materials it has cutting settings for (material, or material@profile). A step can only cut with a tool that has a row for what it cuts. Also answers the material keys. `query` words must all appear in a tool's name, kind, group or coating.",
    inputSchema: object({
      query: { type: "string" },
      kind: { type: "string", enum: Object.keys(TOOL_KIND_LABELS) },
    }),
    readOnly: true,
    run: async (input, host) => {
      const state = host.state();
      const words = String(input.query ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      const tools = everyTool(state).filter((t) => {
        if (input.kind && t.kind !== input.kind) return false;
        const hay =
          `${t.name} ${displayName(t.name, t.coating)} ${TOOL_KIND_LABELS[t.kind]} ${t.group ?? ""} ${t.coating ?? ""}`.toLowerCase();
        return words.every((word) => hay.includes(word));
      });
      return {
        count: tools.length,
        materials: allMaterials(state.lists).map((m) => m.value),
        profiles: (state.lists.profiles ?? []).map((p) => p.key),
        tools: tools.map((t) => ({
          id: t.id,
          name: shown(t),
          kind: t.kind,
          diameter: t.diameter,
          ...(t.tipAngle !== undefined ? { tipAngle: t.tipAngle } : {}),
          ...(t.tipDiameter !== undefined
            ? { tipDiameter: t.tipDiameter }
            : {}),
          ...(t.cornerRadius !== undefined
            ? { cornerRadius: t.cornerRadius }
            : {}),
          ...(t.fluteLength !== undefined
            ? { fluteLength: t.fluteLength }
            : {}),
          ...(t.flutes !== undefined ? { flutes: t.flutes } : {}),
          ...(t.group ? { group: t.group } : {}),
          rows: t.cutting.map((c) =>
            c.profile ? `${c.material}@${c.profile}` : c.material,
          ),
          ...(state.project.toolNumbers?.[t.id] !== undefined
            ? { numberInProject: state.project.toolNumbers[t.id] }
            : {}),
          ...(state.tools.some((own) => own.id === t.id)
            ? {}
            : { onlyInProject: true }),
        })),
      };
    },
  },
  {
    name: "tool_get",
    title: "Read one tool",
    description:
      "One tool in full, by its id, as the tool list holds it: its sizes and its cutting rows (rpm; feed and plunge in mm/min; stepdown in mm; stepover in mm whatever stepoverUnit says, which is only how it was typed) with their logs of real cuts. These are the numbers the user runs: quote them, and change them only with tool_row_set when the user asks for it. `number` is the tool's own in the list; the T number in a project's files is numberInFiles of a step's tools. Keys such as ids, apps, camFlag and camExtra are for other programs.",
    inputSchema: object({ id: { type: "string" } }, ["id"]),
    readOnly: true,
    run: async (input, host) => {
      const tool = everyTool(host.state()).find((t) => t.id === input.id);
      if (!tool)
        throw new CommandError(
          "not_found",
          `There is no tool "${input.id}". tools_list gives the tools and their ids.`,
        );
      return { tool };
    },
  },
  {
    name: "tool_log_cut",
    title: "Log a cut with a tool",
    description:
      "Adds one entry to a cutting row's log, as the tool sheet's \"Log a cut\" does: what came of a real cut with that row. `row` is a material key, or material@profile, as tools_list gives a tool's rows. `outcome` is ok, provisional (it worked, still to confirm) or failed; leave it out for a plain remark. `at` holds the numbers the cut was made at, and is the row's present numbers when left out, which is right for a cut made with the row as it is. Log only what the user tells you came of a cut. With dryRun, answers the entry as it would be kept and changes nothing.",
    inputSchema: object(
      {
        toolId: { type: "string" },
        row: { type: "string", description: "material, or material@profile" },
        text: {
          type: "string",
          description: "What happened, in the user's words.",
        },
        outcome: { type: "string", enum: ["ok", "provisional", "failed"] },
        date: { type: "string", description: "YYYY-MM-DD. Default: today." },
        at: object(CUT_VALUES, [
          "rpm",
          "feed",
          "plunge",
          "stepover",
          "stepdown",
        ]),
        dryRun: { type: "boolean" },
      },
      ["toolId", "row", "text"],
    ),
    run: async (input, host) => {
      await host.freshTools?.();
      const state = host.state();
      const [tool, index] = ownRow(state, input.toolId, input.row);
      if (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date))
        throw new CommandError(
          "invalid_input",
          `"${input.date}" is not a date written as YYYY-MM-DD.`,
        );
      if (String(input.text).trim() === "")
        throw new CommandError(
          "invalid_input",
          "text is needed: what came of the cut.",
        );
      const row = tool.cutting[index];
      const entry: CutResult = {
        date: input.date ?? today(),
        ...(input.outcome ? { outcome: input.outcome } : {}),
        at: input.at ?? rowValues(row),
        text: String(input.text).trim(),
      };
      const logged = (t: Tool): Tool => ({
        ...t,
        cutting: t.cutting.map((c, i) =>
          i === index ? { ...c, log: [...(c.log ?? []), entry] } : c,
        ),
      });
      const changed = logged(tool);
      await checkedTools(state, changed);
      if (input.dryRun)
        return {
          dryRun: true,
          logged: entry,
          row: rowAnswer(changed.cutting[index]),
        };
      await host.apply({
        type: "setTools",
        tools: host
          .state()
          .tools.map((t) => (t.id === tool.id ? logged(t) : t)),
      });
      await host.toolsSaved?.();
      // Written, or merged with a change made elsewhere at the same moment: what the list holds now.
      const now = rowNow(host.state(), tool.id, input.row);
      const same = (e: CutResult) =>
        e.date === entry.date &&
        e.text === entry.text &&
        (e.outcome ?? null) === (entry.outcome ?? null);
      if (!now?.log?.some(same)) {
        throw new CommandError(
          "failed",
          "The cut was not logged: the tool list was changed somewhere else at the same moment, and the change made there was kept. Read the tool again with tool_get, then log the cut again.",
        );
      }
      return {
        logged: entry,
        tool: shown(host.state().tools.find((t) => t.id === tool.id)),
        row: rowAnswer(now),
      };
    },
  },
  {
    name: "tool_row_set",
    title: "Change a cutting row's numbers",
    description:
      "Changes the numbers of one cutting row of a tool: rpm, feed and plunge (mm/min), stepover (mm), stepoverUnit (how it is shown: mm or percent), stepdown (mm) and passes. Only what is given changes. These are the numbers the user runs, so the page asks the user to allow the change before it is made, showing it, and the answer says when they did not. Call it only when the user asks for the change. The row's log stays: its entries keep the numbers they were cut at, so a result logged at the old numbers no longer counts for the row. The answer holds the feeds model's check of the new numbers (chip load, power, warnings), as the tool sheet shows it. With dryRun, answers the row as it would be, and its check, without asking or changing anything.",
    inputSchema: object(
      {
        toolId: { type: "string" },
        row: { type: "string", description: "material, or material@profile" },
        values: {
          ...object(CUT_VALUES),
          description: "The numbers to change.",
        },
        dryRun: { type: "boolean" },
      },
      ["toolId", "row", "values"],
    ),
    run: async (input, host) => {
      await host.freshTools?.();
      const state = host.state();
      const [tool, index] = ownRow(state, input.toolId, input.row);
      const row = tool.cutting[index];
      const values = input.values as Partial<CutValues>;
      if (Object.keys(values).length === 0)
        throw new CommandError(
          "invalid_input",
          "values names nothing to change.",
        );
      if (values.rpm !== undefined && values.rpm > state.machine.maxRpm) {
        throw new CommandError(
          "invalid_input",
          `${values.rpm} rpm is over the machine's top speed, ${state.machine.maxRpm} rpm.`,
        );
      }
      for (const key of ["feed", "plunge"] as const) {
        const value = values[key];
        if (value !== undefined && value > state.machine.rapidRate) {
          throw new CommandError(
            "invalid_input",
            `A ${key} of ${value} mm/min is over the machine's rapid speed, ${state.machine.rapidRate} mm/min, the fastest it moves.`,
          );
        }
      }
      const unit = values.stepoverUnit ?? row.stepoverUnit;
      if (
        values.stepover !== undefined &&
        unit !== "percent" &&
        values.stepover > tool.diameter
      ) {
        throw new CommandError(
          "invalid_input",
          `A stepover of ${values.stepover} mm is wider than the tool, ${tool.diameter} mm.`,
        );
      }
      if (
        values.stepdown !== undefined &&
        tool.fluteLength !== undefined &&
        values.stepdown > tool.fluteLength
      ) {
        throw new CommandError(
          "invalid_input",
          `A stepdown of ${values.stepdown} mm is deeper than the tool's flutes, ${tool.fluteLength} mm.`,
        );
      }
      const next = { ...row, ...values };
      const changed: Tool = {
        ...tool,
        cutting: tool.cutting.map((c, i) => (i === index ? next : c)),
      };
      await checkedTools(state, changed);
      const profile = row.profile
        ? state.lists.profiles?.find((p) => p.key === row.profile)
        : undefined;
      const check = await core
        .call(
          "checkRow",
          changed,
          feedMaterial(row.material, state.lists),
          {
            rpm: next.rpm,
            feed: next.feed,
            plunge: next.plunge,
            stepover: next.stepover,
            stepdown: next.stepdown,
            adaptive:
              row.profile !== undefined && isAdaptive(row.profile, profile),
          },
          state.machine,
        )
        .catch(() => null);
      const before = rowValues(row);
      const differs = (Object.keys(values) as (keyof CutValues)[]).filter(
        (key) => before[key] !== next[key],
      );
      if (differs.length === 0)
        return { unchanged: true, row: rowAnswer(row), check };
      if (input.dryRun)
        return { dryRun: true, before, row: rowAnswer(next), check };
      const label = `${materialLabel(row.material, state.lists)}${profile ? ` (${profile.label})` : ""}`;
      const change = differs
        .map((key) => `${key} ${before[key] ?? "none"} → ${next[key]}`)
        .join(", ");
      const warned = check?.warnings.length
        ? `\n\nThe feeds model says: ${check.warnings.join(" ")}`
        : "";
      if (
        !confirm(
          `An AI agent asks to change the ${label} row of "${shown(tool)}":\n\n${change}${warned}\n\nAllow it?`,
        )
      ) {
        throw new CommandError(
          "failed",
          "The user did not allow the change. Nothing was changed.",
        );
      }
      // The row may have been changed elsewhere while the user was asked: what they allowed was a change from `before`.
      await host.freshTools?.();
      const asked = rowNow(host.state(), tool.id, input.row);
      if (
        !asked ||
        JSON.stringify(rowValues(asked)) !== JSON.stringify(before)
      ) {
        throw new CommandError(
          "failed",
          `Nothing was changed: the row was changed somewhere else while the user was asked.${asked ? ` Its numbers now: ${JSON.stringify(rowValues(asked))}.` : ""} Read the tool again with tool_get.`,
        );
      }
      const set = (c: CuttingSettings) =>
        c === asked ? { ...c, ...values } : c;
      await host.apply({
        type: "setTools",
        tools: host
          .state()
          .tools.map((t) =>
            t.id === tool.id ? { ...t, cutting: t.cutting.map(set) } : t,
          ),
      });
      await host.toolsSaved?.();
      const kept = rowNow(host.state(), tool.id, input.row);
      const wanted = rowValues({ ...asked, ...values });
      if (!kept || JSON.stringify(rowValues(kept)) !== JSON.stringify(wanted)) {
        throw new CommandError(
          "failed",
          `The change was not kept: the row was changed somewhere else at the same moment, and the change made there was kept.${kept ? ` Its numbers now: ${JSON.stringify(rowValues(kept))}.` : ""} Read the tool again with tool_get.`,
        );
      }
      return {
        tool: shown(host.state().tools.find((t) => t.id === tool.id)),
        before,
        row: rowAnswer(kept),
        check,
      };
    },
  },
  {
    name: "step_settings",
    title: "The settings of each type of step",
    description:
      "For each type of step, or for one: what it is, its settings with their defaults (what `task` takes in step_add and step_update), the optional ones, and what each means. Changes nothing.",
    inputSchema: object({ type: { type: "string", enum: STEP_TYPES } }),
    readOnly: true,
    run: async (input) => ({
      types: (input.type ? [input.type as StepType] : STEP_TYPES).map(
        (type) => ({
          type,
          what: STEP_LABELS[type],
          defaults: defaultInlay(type),
          optional: OPTIONAL_KEYS[type],
          settings: Object.fromEntries(
            [...Object.keys(defaultInlay(type)), ...OPTIONAL_KEYS[type]]
              .filter((key) => key !== "type" && SETTING_NOTES[key])
              .map((key) => [key, SETTING_NOTES[key]]),
          ),
        }),
      ),
      note: "Lengths are mm. Tools are named by id from tools_list; a step can be added without them and is then `missing` them.",
    }),
  },
  {
    name: "step_add",
    title: "Add an inlay or operation",
    description:
      "Adds a step to the list and opens it on the page. Read step_settings first: it names each type's settings and their defaults. Types: vcarve and flat are inlays (a pocket in the stock and a plug or insert of another wood; each shape belongs to one inlay); pocket, facing, contour and chamfer are plain operations on the stock (a facing without shapes mills the whole stock); glue and saw are done by hand and take forInlay, the inlay's step id, in place of shapes. A facing with forInlay is the trim that mills a glued-in plug flush. `task` sets any of the type's settings over its defaults; a step's tools are among them. Only where the tool list has a single tool of the kind a step needs is that one chosen: otherwise name it. The answer's `missing` says what is still to choose.",
    inputSchema: object(
      {
        type: { type: "string", enum: STEP_TYPES },
        shapeIds: {
          type: "array",
          items: { type: "integer", minimum: 0 },
          description: "The shapes it works on.",
        },
        forInlay: {
          type: "string",
          description:
            "For glue, saw and a trimming facing: the inlay's step id.",
        },
        name: { type: "string" },
        material: {
          type: "string",
          description:
            "Inlays: the wood of the plug or insert, a material key.",
        },
        color: {
          type: "string",
          description: "Inlays: that wood's colour in the pictures, #rrggbb.",
        },
        task: {
          type: "object",
          description: "Settings to set over the defaults.",
        },
        after: {
          type: "string",
          description:
            "The step id to put it after. Default: at the end, or for forInlay where it belongs.",
        },
      },
      ["type"],
    ),
    run: async (input, host) => {
      const state = host.state();
      const { project } = state;
      const type = input.type as StepType;
      let step: Step;
      let after: string | undefined = input.after;
      if (after !== undefined) stepOf(state, after);
      if (input.forInlay !== undefined) {
        const owner = stepOf(state, input.forInlay);
        if (!isInlay(owner.task))
          throw new CommandError(
            "invalid_input",
            `"${owner.name}" is not an inlay.`,
          );
        if (type === "glue") {
          if (glueOf(owner, project.steps))
            throw new CommandError(
              "invalid_state",
              `"${owner.name}" has a glue-up already.`,
            );
          step = glueStep(owner, project.steps)!;
          after ??= owner.id;
        } else if (type === "saw") {
          if (sawOf(owner, project.steps))
            throw new CommandError(
              "invalid_state",
              `The backer of "${owner.name}" is sawn off already.`,
            );
          const made = sawStep(owner, project.steps);
          if (!made)
            throw new CommandError(
              "invalid_input",
              `"${owner.name}" has no backer to saw off.`,
            );
          step = made;
          after ??= glueOf(owner, project.steps)?.id ?? owner.id;
        } else if (type === "facing") {
          const made = trimFacing(owner, project.steps, state.defaults);
          if (!made)
            throw new CommandError(
              "invalid_input",
              `"${owner.name}" has no plug standing above the surface to trim.`,
            );
          step = made;
          after ??= (
            sawOf(owner, project.steps) ?? glueOf(owner, project.steps)
          )?.id;
        } else
          throw new CommandError(
            "invalid_input",
            "forInlay goes with glue, saw or facing.",
          );
      } else {
        if (type === "glue" || type === "saw")
          throw new CommandError(
            "invalid_input",
            `A ${type} step needs forInlay: the inlay's step id.`,
          );
        const shapeIds = input.shapeIds?.length
          ? shapesOf(state, input.shapeIds)
          : [];
        step = newStep(type, shapeIds, project.steps, state.defaults);
      }
      // Where the tool list leaves no choice, make it, as the app does.
      const only = (kind: ToolKind) => {
        const ofKind = state.tools.filter((t) => t.kind === kind);
        return ofKind.length === 1 ? ofKind[0].id : null;
      };
      const task = step.task;
      const endMill = only("flat_end");
      if (
        (task.type === "vcarve" ||
          task.type === "flat" ||
          task.type === "pocket") &&
        endMill
      )
        task.clearingToolIds = [endMill];
      if (task.type === "facing" || task.type === "contour")
        task.toolId = endMill;
      if (task.type === "vcarve") task.vbitToolId = only("v_bit");
      if (task.type === "chamfer")
        task.toolId = only("v_bit") ?? only("corner_round");
      step = applyStepInput(step, input, state);
      const added = step;
      const next = await change(host, {
        type: "updateProject",
        update: (p) => ({
          ...p,
          steps:
            after === undefined
              ? [...p.steps, added]
              : insertAfter(p.steps, after, added),
        }),
      });
      await host.apply({ type: "setActiveStep", id: added.id });
      return { step: describeStep(stepOf(next, added.id), next) };
    },
  },
  {
    name: "step_update",
    title: "Change an inlay or operation",
    description:
      "Changes a step: only what is named changes. `task` sets settings of its type (an optional one given as null is taken away); tools are named by id (clearingToolIds, vbitToolId, toolId). rowProfiles names, by tool id, the toolpath profile whose cutting row the tool runs here; cutOverrides changes, by tool id, numbers of that row for this step only (rpm, feed, plunge, stepover, stepdown). Give either as null to clear it. `suppressed` true leaves the step out of the files and of the stock while it keeps its place and settings; an inlay's plug, glue-up and sawing are left out with it. A step's type cannot change. The files made before are out of date after this: build again.",
    inputSchema: object(
      {
        id: { type: "string" },
        name: { type: "string" },
        shapeIds: { type: "array", items: { type: "integer", minimum: 0 } },
        material: { type: "string" },
        color: { type: "string" },
        task: { type: "object" },
        rowProfiles: { type: "object", nullable: true },
        cutOverrides: { type: "object", nullable: true },
        cutOutToolId: {
          type: "string",
          nullable: true,
          description:
            "The end mill that cuts a plug out of its board; null for the usual one.",
        },
        suppressed: {
          type: "boolean",
          description: "Left out of the files and of the stock, or back in.",
        },
      },
      ["id"],
    ),
    run: async (input, host) => {
      const state = host.state();
      const updated = applyStepInput(stepOf(state, input.id), input, state);
      const next = await change(host, {
        type: "updateStep",
        id: input.id,
        update: () => updated,
      });
      await host.apply({ type: "setActiveStep", id: input.id });
      return { step: describeStep(stepOf(next, input.id), next) };
    },
  },
  {
    name: "step_move",
    title: "Reorder the list",
    description:
      "Moves a step to another place in the list: `index` counts from 0. The order is the order things are cut and done in, and the steps between two done by hand share a file.",
    inputSchema: object(
      { id: { type: "string" }, index: { type: "integer", minimum: 0 } },
      ["id", "index"],
    ),
    run: async (input, host) => {
      const from = host
        .state()
        .project.steps.indexOf(stepOf(host.state(), input.id));
      const next = await change(host, {
        type: "updateProject",
        update: (p) => {
          const steps = [...p.steps];
          steps.splice(
            Math.min(input.index, steps.length - 1),
            0,
            ...steps.splice(from, 1),
          );
          return { ...p, steps };
        },
      });
      return {
        steps: next.project.steps.map((j) => ({ id: j.id, name: j.name })),
      };
    },
  },
  {
    name: "step_remove",
    title: "Delete an inlay or operation",
    description:
      "Removes a step from the list. The steps done by hand for an inlay (its glue-up, sawing off) go with it. Its shapes stay in the drawing. This is not undone by history_undo.",
    inputSchema: object({ id: { type: "string" } }, ["id"]),
    run: async (input, host) => {
      const step = stepOf(host.state(), input.id);
      const before = host.state().project.steps;
      const next = await change(host, {
        type: "updateProject",
        update: (p) => ({ ...p, steps: withoutStep(p.steps, step.id) }),
      });
      const left = new Set(next.project.steps.map((j) => j.id));
      return {
        removed: before
          .filter((j) => !left.has(j.id))
          .map((j) => ({ id: j.id, name: j.name })),
      };
    },
  },
  {
    name: "step_build",
    title: "Make and simulate one step's files",
    description:
      "Makes the G-code of one step, cut on its own, and simulates it, without writing anything to disk; for an inlay both parts (pocket, and plug or insert), and for a V-carve inlay the plug is then fitted into the pocket. Shows the result on the page. Answers, per part: the file's name, running time, tools, what to do before running it (`before`), warnings, and `problems` the simulation found (a file with problems must not be run); `errors` say why a part could not be made; `fit` how the plug sits. Takes seconds to a minute. For the files as they are run, in the order of the list, use timeline_build and gcode_export.",
    inputSchema: object({ id: { type: "string" } }, ["id"]),
    run: async (input, host) => {
      const state = host.state();
      const step = stepOf(state, input.id);
      if (isByHand(step.task))
        throw new CommandError(
          "invalid_input",
          `"${step.name}" is done by hand: it has no file.`,
        );
      const missing =
        missingFor(step) ??
        missingSettings(step, everyTool(state), state.lists, state.project);
      if (missing) throw new CommandError("invalid_state", missing);
      const project = state.project;
      // The step is opened first, so that its panel shows the files being made.
      await host.apply({ type: "setActiveStep", id: step.id });
      // As from the step's own button: what was made last stays until the new is there, and comes back when the user calls this off.
      const out: Output = await remakeOutput(
        project,
        step,
        () => host.state().output,
        (output) => void host.apply({ type: "setOutput", output }),
        "agent",
      ).catch((e) => {
        throw isCancelled(e) ? new CommandError("failed", CALLED_OFF) : e;
      });
      await host.apply({ type: "setOutput", output: out });
      const stage: Stage = out.fit
        ? "fit"
        : out.parts.pocket
          ? "pocket"
          : out.parts.plug
            ? "plug"
            : "drawing";
      await host.apply({ type: "setStage", stage });
      const part = (preview: PocketPreview | undefined) =>
        preview
          ? {
              ...describeBuilt(preview.built),
              ...firstProblems(preview.problems),
            }
          : undefined;
      return {
        step: { id: step.id, name: step.name },
        parts: Object.fromEntries(
          partsOf(step).flatMap((p) =>
            out.parts[p] ? [[partName(p, step), part(out.parts[p])]] : [],
          ),
        ),
        errors: out.errors,
        ...(out.fit
          ? {
              fit: {
                verdict: out.fit.verdict,
                report: out.fit.report,
                simulationProblems: out.fit.problems,
              },
            }
          : {}),
        ...(out.fitErrors.length > 0 ? { fitErrors: out.fitErrors } : {}),
      };
    },
  },
  {
    name: "timeline_build",
    title: "Take the stock through the list",
    description:
      "Cuts the stock, in simulation, through every step in the order of the list, and makes the files as they are run: one file for each stretch of steps between two done by hand, and one for each inlay's plug or insert. Shows the stock step by step on the page. Answers every step with its errors, warnings and simulation problems, and each file with its name, time, tools and what to do before it is run. Report all of them to the user. Takes seconds to minutes.",
    inputSchema: object({}),
    run: async (_input, host) => {
      const { result, timeline } = await workOut(host);
      await host.apply({ type: "setTimelineAt", at: result.steps.length });
      await host.apply({ type: "setStage", stage: "timeline" });
      return describeTimeline(result, timeline.project);
    },
  },
  {
    name: "gcode_export",
    title: "Write the G-code files",
    description:
      "Writes the G-code files to disk: the files for the stock and, unless parts is false, each inlay's plug or insert file. With stepIds, only those steps: the picked steps of one stretch come to one file. The list is worked out first if the project changed since timeline_build. A file whose simulation found problems is withheld and named in `withheld` unless withProblems is true: such a file must not be run, and the user decides. Answers `made` (each file with what to do before it is run), `saved` (where each was written) and `notSaved` (a file of that name is there already: pass overwrite), `notMade` and why. After a change to the project, export again with overwrite.",
    inputSchema: object({
      stepIds: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        description: "Default: every step.",
      },
      parts: {
        type: "boolean",
        description:
          "Also the plug or insert files of the inlays. Default true.",
      },
      withProblems: {
        type: "boolean",
        description:
          "Also write files the simulation found problems in. Default false.",
      },
    }),
    givesFiles: true,
    run: async (input, host) => {
      const { result, timeline } = await freshTimeline(host);
      const project = timeline.project;
      const wanted: Set<string> | null = input.stepIds
        ? new Set(input.stepIds as string[])
        : null;
      for (const id of wanted ?? []) stepOf(host.state(), id);
      const name = (id: string) =>
        project.steps.find((j) => j.id === id)?.name ?? id;
      const files: { name: string; text: string }[] = [];
      const made: unknown[] = [];
      const notMade: unknown[] = [];
      const withheld: unknown[] = [];
      const put = (
        built: Built,
        steps: string[],
        problems: { line: number; message: string }[],
      ) => {
        if (problems.length > 0 && input.withProblems !== true) {
          withheld.push({
            fileName: built.fileName,
            steps,
            ...firstProblems(problems),
          });
          return;
        }
        files.push({ name: built.fileName, text: built.gcode });
        made.push({
          steps,
          ...describeBuilt(built),
          ...firstProblems(problems),
        });
      };
      // Left out of the list: there is no file to give.
      for (const s of result.steps)
        if (s.suppressed && wanted?.has(s.stepId))
          notMade.push({
            step: name(s.stepId),
            errors: ["It is suppressed: there is no file for it."],
          });
      for (const file of result.files) {
        const entries = file.stepIds
          .map((id) => result.steps.find((s) => s.stepId === id))
          .filter((s) => s !== undefined);
        const asked = entries.filter((s) => !wanted || wanted.has(s.stepId));
        for (const s of asked)
          if (s.stats === null)
            notMade.push({ step: name(s.stepId), errors: s.errors });
        const picked = asked.filter((s) => s.stats !== null);
        if (picked.length === 0) continue;
        const names = picked.map((s) => name(s.stepId));
        if (
          picked.length === file.stepIds.length &&
          file.complete &&
          file.built
        ) {
          put(file.built, names, file.problems);
          continue;
        }
        // Less than the whole stretch: its picked steps are joined into a file of their own.
        try {
          put(
            await core.call(
              "exportSteps",
              project,
              picked.map((s) => s.stepId),
            ),
            names,
            picked.flatMap((s) => s.problems),
          );
        } catch (e) {
          notMade.push({ steps: names, errors: message(e).split("\n") });
        }
      }
      if (input.parts !== false) {
        for (const part of result.parts) {
          if (wanted && !wanted.has(part.stepId)) continue;
          const inlay = project.steps.find((j) => j.id === part.stepId);
          const what = `${name(part.stepId)}, ${inlay ? partName("plug", inlay) : "plug"}`;
          if (part.built) put(part.built, [what], part.problems);
          else notMade.push({ step: what, errors: part.errors });
        }
      }
      return { files, made, notMade, withheld };
    },
  },
  {
    name: "drawing_render",
    title: "Picture of the drawing",
    description:
      "A picture of the drawing from above: the stock in its wood, every shape with its id on it, shapes of an inlay in that inlay's wood. Look at it to see where shapes lie and which is which.",
    inputSchema: object({ width: widthSchema }),
    readOnly: true,
    run: async (input, host) => {
      const state = host.state();
      const design = designOf(state);
      const picture = drawingSvg(state.project, input.width ?? 1000);
      return {
        stock: { width: r3(design.width), height: r3(design.height) },
        shapeCount: design.regions.length,
        images: [
          {
            mimeType: "image/png",
            data: await svgToPng(picture.svg, picture.width, picture.height),
            label: "The drawing. Numbers are shape ids.",
          },
        ],
      };
    },
  },
  {
    name: "stock_render",
    title: "Picture of the cut wood",
    description:
      "A picture from above of wood as the simulation leaves it, darker the deeper it is cut, each inlay's wood in its colour, and clear where it is cut right through (`cutThrough` says so; `deepest` leaves that out). Without input: the stock after the whole list (worked out first if need be). `at`: the stock after that many steps of the list (0 is the fresh stock). `stepId` with `part`: that part of a step as step_build last made it, on its own board. part is pocket (default; for a plain operation, its one cut) or plug (an inlay's plug or insert).",
    inputSchema: object({
      at: { type: "integer", minimum: 0 },
      stepId: { type: "string" },
      part: { type: "string", enum: ["pocket", "plug"] },
      width: widthSchema,
    }),
    readOnly: true,
    run: async (input, host) => {
      const state = host.state();
      const width = input.width ?? 1000;
      if (input.stepId !== undefined) {
        const step = stepOf(state, input.stepId);
        const part = (input.part ?? "pocket") as "pocket" | "plug";
        const preview =
          state.output?.stepId === step.id
            ? state.output.parts[part]
            : undefined;
        if (!preview)
          throw new CommandError(
            "invalid_state",
            `There is no ${partName(part, step)} of "${step.name}" to show. Call step_build for it first.`,
          );
        const color =
          part === "plug" && isInlay(step.task)
            ? stepColor(step, state.project.steps)
            : stockColor(state.project);
        const picture = reliefPng(
          {
            nx: preview.nx,
            ny: preview.ny,
            cell: preview.cell,
            heights: preview.heights,
            colors: [color],
            thickness: preview.built.stock.thickness,
          },
          width,
        );
        return {
          what: `${partName(part, step)} of "${step.name}"`,
          upToDate: state.output?.project === state.project,
          board: preview.built.stock,
          deepest: r3(-picture.lowest),
          ...(picture.through ? { cutThrough: true } : {}),
          images: [
            {
              mimeType: "image/png",
              data: picture.data,
              label: `The ${partName(part, step)} from above, as simulated.`,
            },
          ],
        };
      }
      const { result, timeline } = await freshTimeline(host);
      const at = Math.min(
        input.at ?? result.steps.length,
        result.snapshots.length - 1,
      );
      const snapshot = result.snapshots[at];
      const colors = [
        stockColor(timeline.project),
        ...result.glued.map((id) => {
          const inlay = timeline.project.steps.find((j) => j.id === id);
          return inlay ? stepColor(inlay, timeline.project.steps) : "#888888";
        }),
      ];
      const picture = reliefPng(
        {
          nx: result.nx,
          ny: result.ny,
          cell: result.cell,
          heights: snapshot.heights,
          owners: snapshot.owners,
          colors,
          thickness: result.thickness,
        },
        width,
      );
      const done =
        at === 0
          ? "the fresh stock"
          : `the stock after "${timeline.project.steps.find((j) => j.id === result.steps[at - 1].stepId)?.name ?? at}"`;
      return {
        what: done,
        at,
        of: result.steps.length,
        deepest: r3(-picture.lowest),
        ...(picture.through ? { cutThrough: true } : {}),
        standsAbove: r3(Math.max(0, picture.highest)),
        images: [
          {
            mimeType: "image/png",
            data: picture.data,
            label: `From above: ${done}, as simulated.`,
          },
        ],
      };
    },
  },
  {
    name: "view_show",
    title: "Show something on the page",
    description:
      "Turns the page to what the user should look at: a view (projects, design, tools, settings), a step's panel (stepId; null for the list), or what the large area shows (drawing, pocket, plug, fit, timeline). Changes nothing in the project.",
    inputSchema: object({
      view: {
        type: "string",
        enum: ["projects", "design", "tools", "settings"],
      },
      stepId: { type: "string", nullable: true },
      stage: {
        type: "string",
        enum: ["drawing", "pocket", "plug", "fit", "timeline"],
      },
    }),
    run: async (input, host) => {
      if (input.view !== undefined) {
        leaveGuard();
        await host.apply(
          input.view === "design" || input.view === "projects"
            ? { type: "setView", view: input.view }
            : {
                type: "setView",
                view: "settings",
                page: input.view === "tools" ? "tools" : "materials",
              },
        );
      }
      if (input.stepId !== undefined) {
        if (input.stepId !== null) stepOf(host.state(), input.stepId);
        await host.apply({ type: "setActiveStep", id: input.stepId });
      }
      if (input.stage !== undefined)
        await host.apply({ type: "setStage", stage: input.stage });
      return { screen: describeProject(host.state()).screen };
    },
  },
];

/** Moves, turns, scales or mirrors shapes as one undo step, and answers where they lie now. */
async function transformShapes(
  host: Host,
  wanted: number[],
  update: (
    design: NonNullable<Project["design"]>,
    picked: number[],
  ) => NonNullable<Project["design"]>,
) {
  const picked = shapesOf(host.state(), wanted);
  const state = await change(
    host,
    editDrawing((p) =>
      p.design ? { ...p, design: update(p.design, picked) } : p,
    ),
  );
  const owners = regionOwners(state.project.steps);
  return {
    shapes: designOf(state)
      .regions.filter((r) => picked.includes(r.id))
      .map((r) => describeShape(r, owners)),
  };
}

/** A step with what a step_add or step_update names made to it, checked as far as the page can. */
function applyStepInput(step: Step, input: Input, state: AppState): Step {
  let out: Step = { ...step };
  if (input.name !== undefined) {
    if (input.name.trim() === "")
      throw new CommandError("invalid_input", "name must not be empty.");
    out.name = input.name;
  }
  if (input.shapeIds !== undefined && input.forInlay === undefined) {
    if (isByHand(out.task))
      throw new CommandError(
        "invalid_input",
        "A step done by hand has no shapes.",
      );
    out.regionIds =
      input.shapeIds.length > 0 ? shapesOf(state, input.shapeIds) : [];
  }
  if (input.material !== undefined) {
    if (!allMaterials(state.lists).some((m) => m.value === input.material)) {
      throw new CommandError(
        "not_found",
        `There is no material "${input.material}". There are: ${allMaterials(
          state.lists,
        )
          .map((m) => m.value)
          .join(", ")}.`,
      );
    }
    out.material = input.material;
  }
  if (input.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(input.color))
      throw new CommandError("invalid_input", "color must be #rrggbb.");
    out.color = input.color;
  }
  if (input.task !== undefined) out.task = patchTask(out.task, input.task);
  for (const key of ["rowProfiles", "cutOverrides", "cutOutToolId"] as const) {
    if (input[key] === undefined) continue;
    if (input[key] === null) {
      const { [key]: _gone, ...rest } = out;
      out = rest as Step;
    } else out = { ...out, [key]: input[key] };
  }
  for (const id of Object.keys({ ...out.rowProfiles, ...out.cutOverrides })) {
    if (!resolveTool(id, state.tools, state.project))
      throw new CommandError(
        "not_found",
        `There is no tool "${id}". tools_list gives the tools and their ids.`,
      );
  }
  if (input.suppressed !== undefined)
    out = withSuppressed([out], out.id, input.suppressed === true)[0];
  checkTools(out, state);
  checkOwners(out, state);
  return out;
}

/** What the page tells the relay about each command: everything but how it is run. */
export function listCommands() {
  return COMMANDS.map(({ run: _run, ...described }) => described);
}

/** Runs a command by name. Throws a CommandError for whatever is in the way. */
export async function runCommand(
  name: string,
  input: unknown,
  host: Host | null,
): Promise<unknown> {
  const command = COMMANDS.find((c) => c.name === name);
  if (!command)
    throw new CommandError("unknown_command", `There is no command "${name}".`);
  if (!host || !host.state().ready)
    throw new CommandError(
      "busy",
      "The app is still loading. Try again in a moment.",
    );
  const given = input ?? {};
  const problem = problemWith(given, command.inputSchema);
  if (problem) throw new CommandError("invalid_input", problem);
  try {
    return await command.run(given as Input, host);
  } catch (e) {
    if (e instanceof CommandError) throw e;
    throw new CommandError("failed", message(e));
  }
}
