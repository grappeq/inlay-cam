// Pure helpers over the data model: no React, no storage.

import { freeName, layersOf } from "./layers";
import type { CutOverride, CutResult, CuttingSettings, Design, Layer, GlueStep, SawStep, Task, Step, StepType, Machine, Material, MaterialInfo, Profile, Project, Ring, Setup, Tool, ToolKind, ToolLists, TrueInlay } from "../core/types";

import coreValues from "../core/core-values.json";

export function newId(): string {
  return crypto.randomUUID();
}

/** Machines whose limits can be filled in with one click. The first is the one a new installation starts with. */
// Defaults and limits come from the core, by way of core-values.json: a test of the core holds that file to what the core says.

/** The machine a new installation starts with: the core's own. */
export const DEFAULT_MACHINE: Machine = { ...(coreValues.machine.defaults as Machine), toolChangeSeconds: 0 };
/** Machines whose limits can be filled in with one click. */
export const MACHINE_PRESETS: Machine[] = [DEFAULT_MACHINE, { ...DEFAULT_MACHINE, name: "Carvera", maxRpm: 15000, travel: [360, 240] }];
/** The most a tool change may be said to take, seconds. */
export const MAX_TOOL_CHANGE_SECONDS = coreValues.machine.maxToolChangeSeconds;

/** The app's own clearances and tabs: the values the core gives a project file that has none. */
export const DEFAULT_SETUP: Setup = coreValues.setup.defaults;

/** The range each clearance may take, as the core checks them. The plunge height is also capped by the travel height. */
export const SETUP_LIMITS = Object.fromEntries(
  (Object.keys(coreValues.setup.defaults) as (keyof Setup)[]).map((key) => [key, [coreValues.setup.lowest[key], coreValues.setup.highest[key]]]),
) as Record<keyof Setup, [number, number]>;

/** A V-carve inlay's finer points: the value each has unless the inlay says otherwise, and the range it may take. */
export const VCARVE_TUNING = coreValues.vcarve as Record<"floorRidge" | "reliefKeep" | "trimDepth", { default: number; range: [number, number] }>;

/** Reads the inlay defaults kept in browser storage; anything unusable in them falls back to the app's value. */
export function readSetup(text: string | undefined): Setup {
  let stored: Partial<Setup> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (parsed && typeof parsed === "object") stored = parsed as Partial<Setup>;
  } catch {
    // Not JSON: the app's values.
  }
  const out = { ...DEFAULT_SETUP };
  for (const key of Object.keys(SETUP_LIMITS) as (keyof Setup)[]) {
    const v = stored[key];
    const [low, high] = SETUP_LIMITS[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= low && v <= high) out[key] = v;
  }
  out.plungeClearance = Math.min(out.plungeClearance, out.safeHeight);
  return out;
}

export function sameSetup(a: Setup, b: Setup): boolean {
  return (Object.keys(SETUP_LIMITS) as (keyof Setup)[]).every((key) => a[key] === b[key]);
}

/** The clearances and tabs an inlay's files are cut with. */
export function stepSetup(step: Step, project: Project): Setup {
  return step.setup ?? project.setup;
}

/** Reads the machine kept in browser storage; anything unusable in it falls back to the usual value. */
export function readMachine(text: string | undefined): Machine {
  let stored: Partial<Machine> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (parsed && typeof parsed === "object") stored = parsed as Partial<Machine>;
  } catch {
    // Not JSON: the usual machine.
  }
  const positive = (v: unknown, usual: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : usual);
  const whole = (v: unknown, usual: number, most: number) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= most ? (v as number) : usual);
  const d = DEFAULT_MACHINE;
  const travel = Array.isArray(stored.travel) ? stored.travel : [];
  return {
    name: typeof stored.name === "string" && stored.name.trim() !== "" ? stored.name : d.name,
    minRpm: whole(stored.minRpm, d.minRpm, 1_000_000),
    maxRpm: whole(stored.maxRpm, d.maxRpm, 1_000_000),
    rapidRate: positive(stored.rapidRate, d.rapidRate),
    travel: [positive(travel[0], d.travel[0]), positive(travel[1], d.travel[1])],
    firstTool: whole(stored.firstTool, d.firstTool, 99),
    toolChangeSeconds:
      typeof stored.toolChangeSeconds === "number" && stored.toolChangeSeconds >= 0 && stored.toolChangeSeconds <= MAX_TOOL_CHANGE_SECONDS ? stored.toolChangeSeconds : 0,
  };
}

export function newProject(name = "Untitled inlay"): Project {
  return { id: newId(), name, design: null, steps: [], tools: [], base: { thickness: 18, material: "hardwood" }, machine: DEFAULT_MACHINE, setup: DEFAULT_SETUP };
}

/** The name a copy of a project gets: the first of "X copy", "X copy 2", … that no project in `taken` has. */
export function copyName(name: string, taken: string[]): string {
  const base = `${name.replace(/ copy( \d+)?$/, "") || "Untitled"} copy`;
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base} ${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** A copy of a project under an id of its own, to be kept beside the one it was made from. */
export function duplicateProject(project: Project, taken: string[]): Project {
  return { ...project, id: newId(), name: copyName(project.name, taken) };
}

export function defaultInlay(type: StepType): Task {
  switch (type) {
    case "vcarve":
      return { type, engagementDepth: 3, glueGap: 0.3, sawGap: 1.5, clearingToolIds: [], vbitToolId: null, plugMargin: 8, plugThickness: 10, cutOut: false, tabs: true, relief: true };
    case "flat":
      return { type, pocketDepth: 3, allowance: 0.1, tabs: false, clearingToolIds: [], insertThickness: 4, insertMargin: 8, insertStyle: "loose", sawGap: 1.5, cutOut: false };
    case "pocket":
      return { type, depth: 3, pattern: "offset", clearingToolIds: [] };
    case "facing":
      return { type, above: 0, depth: 0.5, margin: 0, pattern: "raster", toolId: null };
    case "contour":
      return { type, side: "outside", depth: null, tabs: true, toolId: null };
    case "chamfer":
      return { type, side: "outside", width: 1, toolId: null };
    case "glue":
      return { type, inlayId: "" };
    case "saw":
      return { type, inlayId: "", leave: 1.5 };
  }
}

/** How far a chamfering V-bit's tip is kept clear of the edge unless the chamfer says otherwise, mm, and the most it may be. */
export const DEFAULT_TIP_CLEARANCE = coreValues.chamfer.tipClearance.default;
export const MAX_TIP_CLEARANCE = coreValues.chamfer.tipClearance.max;

/** What each kind of step is called. */
export const STEP_LABELS: Record<StepType, string> = {
  vcarve: "V-carve inlay",
  flat: "Flat inlay",
  pocket: "Pocket",
  facing: "Facing",
  contour: "Contour",
  chamfer: "Chamfer",
  glue: "Glue-up",
  saw: "Sawing off",
};

/** True for an inlay, which has a second part; false for a plain operation on the stock. */
export function isInlay(inlay: Task): inlay is TrueInlay {
  return inlay.type === "vcarve" || inlay.type === "flat";
}

/** True for a step done by hand, which has no file and no tools. */
export function isByHand(inlay: Task): inlay is GlueStep | SawStep {
  return inlay.type === "glue" || inlay.type === "saw";
}

/** True for an inlay whose second part is one plug on a backer: a V-carve inlay, or a flat one made that way. */
export function hasBacker(inlay: Task): boolean {
  return inlay.type === "vcarve" || (inlay.type === "flat" && inlay.insertStyle === "backer");
}

/**
 * The step that saws the backer off an inlay's glued-in plug. What it leaves
 * standing starts at the saw gap: the saw runs somewhere in it, and at worst
 * right under the backer. Null for anything without a backer.
 */
export function sawStep(owner: Step, existing: Step[]): Step | null {
  if (!isInlay(owner.task) || !hasBacker(owner.task)) return null;
  let name = `Saw the backer off ${owner.name}`;
  for (let n = 2; existing.some((j) => j.name === name); n++) name = `Saw the backer off ${owner.name} ${n}`;
  return { id: newId(), name, material: owner.material, regionIds: [], task: { type: "saw", inlayId: owner.id, leave: owner.task.sawGap } };
}

/** The step that saws this inlay's backer off, if the list has one. */
export function sawOf(owner: Step, steps: Step[]): Step | undefined {
  return steps.find((j) => j.task.type === "saw" && j.task.inlayId === owner.id);
}

/**
 * The step that glues an inlay's plug or inserts into its pocket. From it
 * on, the stock has their wood on it for the steps below it in the list.
 * Null for a plain operation.
 */
export function glueStep(owner: Step, existing: Step[]): Step | null {
  if (!isInlay(owner.task)) return null;
  let name = `Glue in ${owner.name}`;
  for (let n = 2; existing.some((j) => j.name === name); n++) name = `Glue in ${owner.name} ${n}`;
  return { id: newId(), name, material: owner.material, regionIds: [], task: { type: "glue", inlayId: owner.id } };
}

/** The step that glues this inlay in, if the list has one. */
export function glueOf(owner: Step, steps: Step[]): Step | undefined {
  return steps.find((j) => j.task.type === "glue" && j.task.inlayId === owner.id);
}

/** The list without a step, and without the glue-up of an inlay that is gone. */
export function withoutStep(steps: Step[], id: string): Step[] {
  return withoutOrphans(steps.filter((j) => j.id !== id));
}

/** The list without the steps done by hand whose inlay is not in it, or has no backer left to saw off. The same list when there are none. */
export function withoutOrphans(steps: Step[]): Step[] {
  const kept = steps.filter((j) => {
    const task = j.task;
    if (!isByHand(task)) return true;
    const inlay = steps.find((other) => other.id === task.inlayId);
    return inlay !== undefined && isInlay(inlay.task) && (task.type !== "saw" || hasBacker(inlay.task));
  });
  return kept.length === steps.length ? steps : kept;
}

/**
 * Whether a step is left out of the list as it is cut: it is suppressed, or
 * it is done by hand for an inlay that is, which leaves nothing to glue in
 * or saw off. As the core has it.
 */
export function isSuppressed(step: Step, steps: Step[]): boolean {
  if (step.suppressed) return true;
  const task = step.task;
  return isByHand(task) && steps.some((j) => j.id === task.inlayId && j.suppressed === true);
}

/** The list with a step suppressed, or no longer. */
export function withSuppressed(steps: Step[], id: string, suppressed: boolean): Step[] {
  return steps.map((j) => {
    if (j.id !== id) return j;
    const { suppressed: _, ...rest } = j;
    return suppressed ? { ...rest, suppressed: true } : rest;
  });
}

/**
 * Which file for the stock each line of the list goes into, counted from 1:
 * the lines from one step done by hand to the next share a file. Null for a
 * step done by hand, and for one that is suppressed, which does not end a
 * file either. As the core numbers them.
 */
export function fileNumbers(steps: Step[]): (number | null)[] {
  let number = 0;
  let open = false;
  return steps.map((step) => {
    if (isSuppressed(step, steps)) return null;
    if (isByHand(step.task)) {
      open = false;
      return null;
    }
    if (!open) number++;
    open = true;
    return number;
  });
}

/** The list with a step put in right after another, or at the end when that one is not there. */
export function insertAfter(steps: Step[], afterId: string | undefined, step: Step): Step[] {
  const at = steps.findIndex((j) => j.id === afterId);
  return at < 0 ? [...steps, step] : [...steps.slice(0, at + 1), step, ...steps.slice(at + 1)];
}

/**
 * A copy of an inlay or operation, with every setting of the one it is made
 * from. A copied inlay has no shapes, since a shape can be in one inlay only.
 * Null for a step done by hand, of which an inlay has one.
 */
export function duplicateStep(step: Step, existing: Step[]): Step | null {
  if (isByHand(step.task)) return null;
  const copy = structuredClone(step);
  return { ...copy, id: newId(), name: copyName(step.name, existing.map((j) => j.name)), regionIds: isInlay(step.task) ? [] : copy.regionIds };
}

/** Woods to colour an inlay or the stock with, light to dark. */
export const WOODS: { name: string; color: string }[] = [
  { name: "Maple", color: "#e3cfa4" },
  { name: "Oak", color: "#c9a56b" },
  { name: "Cherry", color: "#b06a3c" },
  { name: "Padauk", color: "#a8432b" },
  { name: "Walnut", color: "#5d3d24" },
  { name: "Purpleheart", color: "#6d3a5c" },
  { name: "Wenge", color: "#3b2a20" },
  { name: "Ebony", color: "#26211e" },
];
/** The stock's colour when none is chosen. */
export const DEFAULT_STOCK_COLOR = "#dcbd8e";
/** Colours for inlays from before they had one of their own, by position in the list. */
const OLD_STEP_COLORS = ["#c2552d", "#2f7f6f", "#8a5fbf", "#b8892b", "#3f78b5", "#b04a7a"];
/** The woods new inlays are given in turn: ones that stand out from a light stock. */
const NEW_INLAY_WOODS = ["#5d3d24", "#b06a3c", "#a8432b", "#3b2a20", "#6d3a5c", "#c9a56b"];

/** The colour an inlay is drawn in. */
export function stepColor(step: Step, steps: Step[]): string {
  return step.color ?? OLD_STEP_COLORS[Math.max(0, steps.indexOf(step)) % OLD_STEP_COLORS.length];
}

export function stockColor(project: Project): string {
  return project.base.color ?? DEFAULT_STOCK_COLOR;
}

export function newStep(type: StepType, regionIds: number[], existing: Step[], setup: Setup): Step {
  const label = STEP_LABELS[type];
  let n = existing.filter((j) => j.task.type === type).length + 1;
  while (existing.some((j) => j.name === `${label} ${n}`)) n++;
  const step: Step = { id: newId(), name: `${label} ${n}`, material: "hardwood", regionIds, setup, task: defaultInlay(type) };
  if (isInlay(step.task)) {
    const taken = new Set(existing.map((j) => j.color));
    step.color = NEW_INLAY_WOODS.find((c) => !taken.has(c)) ?? NEW_INLAY_WOODS[existing.length % NEW_INLAY_WOODS.length];
  }
  return step;
}

/**
 * How far a glued-in part of an inlay stands above the stock, and how far
 * its blank reaches beyond its shapes. Null for a plain operation.
 */
export function standingPart(owner: Step): { above: number; margin: number; what: "plug" | "inserts" } | null {
  const inlay = owner.task;
  if (inlay.type === "vcarve") return { above: inlay.plugThickness - inlay.engagementDepth, margin: inlay.plugMargin, what: "plug" };
  if (inlay.type !== "flat") return null;
  const above = inlay.insertThickness - inlay.pocketDepth;
  return inlay.insertStyle === "backer" ? { above, margin: inlay.insertMargin, what: "plug" } : { above, margin: 1, what: "inserts" };
}

/**
 * A facing that trims an inlay's glued-in plug flush with the stock: over
 * the plug's blank, from the top of its backer down to the surface. In the
 * plug's wood, since that is what it cuts. Null for an inlay without a plug
 * on a backer (loose inserts, a plain operation) and for a plug that does
 * not stand above the surface.
 */
export function trimFacing(owner: Step, existing: Step[], setup: Setup): Step | null {
  const part = standingPart(owner);
  if (!part || part.what !== "plug" || !(part.above > 0) || owner.regionIds.length === 0) return null;
  const step = newStep("facing", [...owner.regionIds], existing, setup);
  let name = `Trim ${owner.name}`;
  for (let n = 2; existing.some((j) => j.name === name); n++) name = `Trim ${owner.name} ${n}`;
  return {
    ...step,
    name,
    // The height is taken from the list and the margin from the inlay, so that both follow it; the numbers are what is used by hand.
    task: { type: "facing", above: Math.round(part.above * 100) / 100, aboveAuto: true, depth: 0, margin: part.margin, marginAuto: true, pattern: "raster", toolId: null },
  };
}

/**
 * The margin a facing that takes it from the inlays is cut with: the widest
 * plug margin of the inlays its shapes belong to, as the core works it out.
 * Null when they belong to none with a plug on a backer.
 */
export function inlayMargin(step: Step, steps: Step[]): number | null {
  const margins = steps
    .filter((other) => other.regionIds.some((id) => step.regionIds.includes(id)))
    .map((other) => (other.task.type === "vcarve" ? other.task.plugMargin : other.task.type === "flat" && other.task.insertStyle === "backer" ? other.task.insertMargin : null))
    .filter((m): m is number => m !== null);
  return margins.length > 0 ? Math.max(...margins) : null;
}

/**
 * The facing that trims this inlay's plug, if the project has one: a facing
 * over exactly the inlay's shapes that starts above the surface, or takes
 * where it starts from the list.
 */
export function trimOf(owner: Step, steps: Step[]): Step | undefined {
  const shapes = new Set(owner.regionIds);
  return steps.find((j) => j.task.type === "facing" && (j.task.above > 0 || j.task.aboveAuto === true) && j.regionIds.length === shapes.size && j.regionIds.every((id) => shapes.has(id)));
}

export function stepToolIds(step: Step): string[] {
  const inlay = step.task;
  const ids: (string | null)[] =
    inlay.type === "vcarve"
      ? [...inlay.clearingToolIds, inlay.vbitToolId]
      : inlay.type === "flat" || inlay.type === "pocket"
        ? [...inlay.clearingToolIds]
        : inlay.type === "glue" || inlay.type === "saw"
          ? []
          : [inlay.toolId];
  if (step.cutOutToolId !== undefined && cutsPlugOut(inlay)) ids.push(step.cutOutToolId);
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

/** Whether the inlay's plug is cut out of a larger board as the last step of its file. */
export function cutsPlugOut(inlay: Task): boolean {
  return isInlay(inlay) && inlay.cutOut && (inlay.type === "vcarve" || inlay.insertStyle === "backer");
}

/** How deep the cut that frees a plug from its board goes. */
export function cutOutDepth(step: Step, project: Project): number {
  const board = step.task.type === "vcarve" ? step.task.plugThickness : step.task.type === "flat" ? step.task.insertThickness : 0;
  return board + stepSetup(step, project).throughCut;
}

/** What has to be chosen before a step's files can be made, or null when nothing is missing. */
export function missingFor(step: Step): string | null {
  const inlay = step.task;
  if (step.regionIds.length === 0 && inlay.type !== "facing" && !isByHand(inlay)) return `Click shapes in the drawing to add them to this ${isInlay(inlay) ? "inlay" : "operation"} first.`;
  switch (inlay.type) {
    case "vcarve":
      return inlay.vbitToolId === null ? "Choose a V-bit first, under Wood and tools." : null;
    case "chamfer":
      return inlay.toolId === null ? "Choose a V-bit or a corner-rounding bit first." : null;
    case "flat":
      return inlay.clearingToolIds.length === 0 ? "Choose an end mill first, under Wood and tools." : null;
    case "pocket":
      return inlay.clearingToolIds.length === 0 ? "Choose an end mill first." : null;
    case "facing":
      return inlay.toolId === null
        ? "Choose an end mill first."
        : !inlay.aboveAuto && inlay.above + inlay.depth <= 0
          ? "Give the wood above the surface, a depth below it, or both."
          : null;
    case "contour":
      return inlay.toolId === null ? "Choose an end mill first." : null;
    case "glue":
    case "saw":
      return null;
  }
}

/** The first of a step's tools that has no cutting settings for what the step cuts, as a sentence; null when all have. */
export function missingSettings(step: Step, tools: Tool[], lists: ToolLists, project: Project): string | null {
  for (const id of stepToolIds(step)) {
    const tool = tools.find((t) => t.id === id);
    for (const material of stepMaterials(step, project)) {
      if (tool && !tool.cutting.some((c) => c.material === material)) {
        return `"${tool.name}" has no cutting settings for ${materialLabel(material, lists).toLowerCase()}. Add them in the tool list, or choose another tool.`;
      }
    }
  }
  return null;
}

/**
 * What a step cuts, which chooses the cutting settings of its tools, as the
 * core works it out: the stock's material, except for the plug or insert of
 * an inlay, which is in the inlay's own wood, and for a facing that starts
 * above the surface over an inlay's shapes, which trims that inlay's plug.
 */
export function stepMaterial(step: Step, project: Project, part: "pocket" | "plug" = "pocket"): Material {
  if (isInlay(step.task)) return part === "plug" ? step.material : project.base.material;
  const owner = trimmedInlay(step, project);
  return owner ? owner.material : project.base.material;
}

/** The inlay whose glued-in plug a facing trims: the first one its shapes belong to, when it starts above the surface. */
export function trimmedInlay(step: Step, project: Project): Step | undefined {
  if (step.task.type !== "facing" || !(step.task.aboveAuto === true || step.task.above > 0)) return undefined;
  return project.steps.find((other) => isInlay(other.task) && other.regionIds.some((id) => step.regionIds.includes(id)));
}

/** Every material a step's tools cut: the stock's, and for an inlay in another wood, that of its plug. */
export function stepMaterials(step: Step, project: Project): Material[] {
  const stock = stepMaterial(step, project);
  return isInlay(step.task) && step.material !== stock ? [stock, step.material] : [stock];
}

/** The numbers of a cutting row a step can change, in the order they are shown. */
export const CUT_FIELDS: { key: keyof CutOverride; label: string; unit: string; short: string }[] = [
  { key: "rpm", label: "Speed", unit: "rpm", short: "rpm" },
  { key: "feed", label: "Feed", unit: "mm/min", short: "feed" },
  { key: "plunge", label: "Plunge", unit: "mm/min", short: "plunge" },
  { key: "stepover", label: "Stepover", unit: "mm", short: "over" },
  { key: "stepdown", label: "Stepdown", unit: "mm", short: "down" },
];

/** A tool's row for a material: its plain one, or the one for a profile. */
export function cutRow(tool: Tool, material: Material, profile: string | undefined): CuttingSettings | undefined {
  return tool.cutting.find((c) => c.material === material && (c.profile ?? undefined) === profile);
}

/** How many of a row's numbers a step changes. */
export function changedCount(change: CutOverride | undefined): number {
  return change ? CUT_FIELDS.filter((f) => change[f.key] !== undefined).length : 0;
}

/** What a tool is chosen for in a step, which says which of its profiles to start on. */
export type CutUse = "clearing" | "facing" | "contour" | "chamfer" | "vcarve";

/** Words in a profile's key or name that say what it is for. */
const USE_WORDS: Record<CutUse, RegExp> = {
  clearing: /clear|pocket|rough/,
  facing: /fac(e|ing)|surfac/,
  contour: /slot|contour|outline|cut.?out/,
  chamfer: /chamfer|bevel|edge|round/,
  vcarve: /carv|engrav|inlay/,
};

/**
 * The profile a tool starts on when it is chosen for a use: the first of the
 * tool list's profiles that is for that use and that the tool has a row on
 * for the material. A contour is a full-width cut, so a profile marked as
 * one is for it too. Undefined is the plain row, which is safe for any cut.
 * Never an adaptive profile: this app has no such toolpath.
 */
export function defaultProfile(use: CutUse, tool: Tool, material: Material, lists: ToolLists, project: Project): string | undefined {
  const keys = tool.cutting.filter((c) => c.material === material && c.profile !== undefined && c.profile !== null).map((c) => c.profile as string);
  const known = [...(lists.profiles ?? []), ...(project.profiles ?? [])].map((p) => p.key);
  const ordered = [...new Set([...known.filter((key) => keys.includes(key)), ...keys])];
  return ordered.find((key) => {
    const profile = findProfile(key, lists, project);
    if (isAdaptive(key, profile)) return false;
    if (use === "contour" && profile?.slot === true) return true;
    return USE_WORDS[use].test(`${key} ${profile?.label ?? ""}`.toLowerCase());
  });
}

/** The step with a tool just chosen for it started on the profile for its use, unless the step says already which row the tool runs. */
export function withDefaultProfile(step: Step, toolId: string, use: CutUse, tools: Tool[], lists: ToolLists, project: Project): Step {
  if (step.rowProfiles?.[toolId] !== undefined) return step;
  const tool = resolveTool(toolId, tools, project);
  const key = tool && defaultProfile(use, tool, stepMaterial(step, project), lists, project);
  return key === undefined ? step : { ...step, rowProfiles: { ...(step.rowProfiles ?? {}), [toolId]: key } };
}

/**
 * The drawing with its scale and mirroring worked into the shapes, so that
 * its width and height are the stock's own and a shape's numbers are where it
 * lies on the stock. Older projects scaled and mirrored the drawing as a whole.
 */
export function normaliseDesign(design: Design): Design {
  if (design.scale === 1 && !design.mirror) return design;
  const { scale, mirror, width } = design;
  const place = (ring: Ring): Ring => {
    const out = ring.map(([x, y]): [number, number] => [(mirror ? width - x : x) * scale, y * scale]);
    // A mirrored ring runs the other way round; put it back.
    return mirror ? out.reverse() : out;
  };
  return {
    ...design,
    width: design.width * scale,
    height: design.height * scale,
    scale: 1,
    mirror: false,
    regions: design.regions.map((r) => ({ ...r, outer: place(r.outer), holes: r.holes.map(place) })),
  };
}

/**
 * Puts the shapes of another drawing on the stock, beside what is there: in
 * the middle of the stock, which keeps its size. Returns the new shapes' ids.
 */
export function addDrawing(design: Design, incoming: Design): { design: Design; ids: number[] } {
  const added = normaliseDesign(incoming);
  let box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of added.regions) for (const [x, y] of r.outer) box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
  if (added.regions.length === 0) return { design, ids: [] };
  const [w, h] = [box[2] - box[0], box[3] - box[1]];
  // In the middle of the stock, which keeps its size: shapes too large for it reach over its edges.
  const dx = (design.width - w) / 2 - box[0];
  const dy = (design.height - h) / 2 - box[1];
  let next = design.regions.reduce((max, r) => Math.max(max, r.id), -1) + 1;
  const shift = (ring: Ring): Ring => ring.map(([x, y]) => [x + dx, y + dy]);
  const names = design.sourceName.split(", ").filter((n) => n !== "");
  if (!names.includes(added.sourceName)) names.push(added.sourceName);

  // The drawing keeps its layers, which go on top of those there are; one
  // without layers comes in on a layer of its own, named after its file. On
  // a stock with nothing drawn yet it comes in as it is.
  const blank = design.regions.length === 0 && !design.layers?.length;
  const there = blank ? [] : layersOf(design);
  let nextLayer = there.reduce((max, l) => Math.max(max, l.id), -1) + 1;
  const taken = there.map((l) => l.name);
  const stem = added.sourceName.replace(/\.[^.]+$/, "") || "Drawing";
  const theirs: Layer[] = added.layers?.length ? added.layers : blank ? [] : [{ id: 0, name: stem }];
  const layerIds = new Map<number, number>();
  const layers = theirs.map((layer) => {
    const id = blank ? layer.id : nextLayer++;
    layerIds.set(layer.id, id);
    const name = blank ? layer.name : freeName(layer.name, taken);
    taken.push(name);
    return { ...layer, id, name };
  });
  const regions = added.regions.map((r) => {
    const { layer: was, ...rest } = r;
    const layer = layerIds.get(was ?? 0) ?? 0;
    return { ...rest, id: next++, ...(layer !== 0 ? { layer } : {}), outer: shift(r.outer), holes: r.holes.map(shift) };
  });
  const all = [...layers, ...there];
  return {
    design: {
      ...design,
      sourceName: names.join(", "),
      regions: [...design.regions, ...regions],
      ...(all.length > 0 ? { layers: all } : {}),
    },
    ids: regions.map((r) => r.id),
  };
}

/** A stock with nothing drawn on it yet. */
export function emptyDesign(): Design {
  return { sourceName: "", width: 200, height: 150, scale: 1, mirror: false, regions: [] };
}

/**
 * The end mill that cuts the plug out when none is chosen for it: the largest
 * of the inlay's end mills whose cutting edges reach through the board, as
 * the core picks it.
 */
export function usualCutOutTool(step: Step, tools: Tool[], project: Project): Tool | undefined {
  const depth = cutOutDepth(step, project);
  if (!isInlay(step.task)) return undefined;
  return step.task.clearingToolIds
    .map((id) => resolveTool(id, tools, project))
    .filter((t): t is Tool => t !== undefined && t.kind === "flat_end")
    .sort((a, b) => b.diameter - a.diameter)
    .find((t) => t.fluteLength === undefined || t.fluteLength >= depth);
}

/** The tool a step refers to: the current one from the tool list, else the copy kept in the project. */
export function resolveTool(id: string | null, tools: Tool[], project: Project): Tool | undefined {
  if (id === null) return undefined;
  return tools.find((t) => t.id === id) ?? project.tools.find((t) => t.id === id);
}

/** The highest number a tool can go by: the core's own limit. */
export const MAX_TOOL_NUMBER = 999;

/**
 * The number each of the project's tools goes by in every file: those it
 * has already, and for each tool a step uses that has none the lowest free
 * one from `first`, in the order the steps use them. A tool keeps its number
 * while no step uses it, until it is taken off the list; the number of a
 * tool that is nowhere to be found any more is dropped. The same object when
 * nothing changes; undefined when there are none.
 */
export function toolNumbers(project: Project, tools: Tool[], first: number): Record<string, number> | undefined {
  const have = project.toolNumbers ?? {};
  const out: Record<string, number> = {};
  for (const [id, number] of Object.entries(have)) if (resolveTool(id, tools, project)) out[id] = number;
  const taken = new Set(Object.values(out));
  for (const id of project.steps.flatMap(stepToolIds)) {
    if (id in out || !resolveTool(id, tools, project)) continue;
    let number = Math.max(1, first);
    while (taken.has(number)) number++;
    out[id] = number;
    taken.add(number);
  }
  const same = Object.keys(out).length === Object.keys(have).length && Object.entries(out).every(([id, n]) => have[id] === n);
  if (same) return project.toolNumbers;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The project with a tool moved to a number. The tool that had the number takes the one this tool leaves. */
export function renumberTool(project: Project, id: string, number: number): Project {
  const have = project.toolNumbers ?? {};
  const from = have[id];
  if (from === undefined || from === number || !Number.isInteger(number) || number < 1 || number > MAX_TOOL_NUMBER) return project;
  const out = { ...have, [id]: number };
  const other = Object.keys(have).find((key) => key !== id && have[key] === number);
  if (other !== undefined) out[other] = from;
  return { ...project, toolNumbers: out };
}

/** The project without a tool's number. A tool that a step still uses is given one again. */
export function forgetTool(project: Project, id: string): Project {
  if (!project.toolNumbers || !(id in project.toolNumbers)) return project;
  const { [id]: _gone, ...rest } = project.toolNumbers;
  return { ...project, toolNumbers: Object.keys(rest).length > 0 ? rest : undefined };
}

/** A tool's name with the number it goes by in the project's files, where it has one. */
export function numberedName(tool: Tool, project: Project): string {
  const number = project.toolNumbers?.[tool.id];
  return number === undefined ? tool.name : `T${number} · ${tool.name}`;
}

/**
 * The copies of tools a project should carry: one per tool its steps use or
 * that keeps a number, refreshed from the tool list where the tool still
 * exists there.
 */
export function toolSnapshots(project: Project, tools: Tool[]): Tool[] {
  const ids = new Set([...project.steps.flatMap(stepToolIds), ...Object.keys(project.toolNumbers ?? {})]);
  const out: Tool[] = [];
  for (const id of ids) {
    const tool = resolveTool(id, tools, project);
    if (tool) out.push(tool);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Tools the project carries that are not in the tool list (opened from someone else's file). */
export function projectOnlyTools(project: Project, tools: Tool[]): Tool[] {
  return project.tools.filter((p) => !tools.some((t) => t.id === p.id));
}

/** What makes a tool the tool it is, whatever its id: its name, its kind and its measures. */
function toolDetails(tool: Tool): string {
  const { name, kind, diameter, tipDiameter, cornerRadius, tipAngle, fluteLength, shankDiameter, length, flutes, shoulderLength, threadDiameter, pitch, drillDiameter } = tool;
  return JSON.stringify([name, kind, diameter, tipDiameter, cornerRadius, tipAngle, fluteLength, shankDiameter, length, flutes, shoulderLength, threadDiameter, pitch, drillDiameter].map((v) => v ?? null));
}

/**
 * The project with its steps pointed at the tool list's own tools, where a
 * copy it carries under another id is one of them in all but the id: the
 * same name, kind and measures. Such a copy comes from a tool list that was
 * built again, which gives its tools new ids. A copy that matches no tool of
 * the list, or more than one, is left as it is.
 */
export function relinkTools(project: Project, tools: Tool[]): Project {
  const to = new Map<string, string>();
  // Only the copies a step still points at or that keep a number: the others go by themselves.
  const used = new Set([...project.steps.flatMap((step) => [...stepToolIds(step), ...Object.keys(step.rowProfiles ?? {}), ...Object.keys(step.cutOverrides ?? {})]), ...Object.keys(project.toolNumbers ?? {})]);
  for (const copy of projectOnlyTools(project, tools)) {
    if (!used.has(copy.id)) continue;
    const details = toolDetails(copy);
    const matches = tools.filter((t) => toolDetails(t) === details);
    if (matches.length === 1) to.set(copy.id, matches[0].id);
  }
  if (to.size === 0) return project;
  const one = (id: string) => to.get(id) ?? id;
  const many = (ids: string[]) => [...new Set(ids.map(one))];
  const steps = project.steps.map((step): Step => {
    const task = { ...step.task } as Task;
    if ("clearingToolIds" in task) task.clearingToolIds = many(task.clearingToolIds);
    if ("vbitToolId" in task && task.vbitToolId !== null) task.vbitToolId = one(task.vbitToolId);
    if ("toolId" in task && task.toolId !== null) task.toolId = one(task.toolId);
    const out: Step = { ...step, task };
    if (step.cutOutToolId !== undefined) out.cutOutToolId = one(step.cutOutToolId);
    if (step.rowProfiles) out.rowProfiles = Object.fromEntries(Object.entries(step.rowProfiles).map(([id, profile]) => [one(id), profile]));
    if (step.cutOverrides) out.cutOverrides = Object.fromEntries(Object.entries(step.cutOverrides).map(([id, change]) => [one(id), change]));
    return out;
  });
  // The number goes with the tool, unless the list's own has one already.
  let numbers = project.toolNumbers;
  if (numbers) {
    numbers = { ...numbers };
    for (const [from, id] of to) {
      if (!(from in numbers)) continue;
      if (!(id in numbers)) numbers[id] = numbers[from];
      delete numbers[from];
    }
  }
  return { ...project, steps, toolNumbers: numbers };
}

/** Tools offered for a slot: the tool list plus project-only copies, of one kind or of several, by kind and diameter. */
export function toolChoices(kind: ToolKind | ToolKind[], tools: Tool[], project: Project): Tool[] {
  const kinds = Array.isArray(kind) ? kind : [kind];
  return [...tools, ...projectOnlyTools(project, tools)]
    .filter((t) => kinds.includes(t.kind))
    .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.diameter - b.diameter || a.name.localeCompare(b.name));
}

/** Whether a tool is one the words typed ask for: each word is somewhere in its name, kind, group, measures or note. */
export function toolMatches(tool: Tool, name: string, query: string): boolean {
  const facts = [name, TOOL_KIND_LABELS[tool.kind], tool.group ?? "", fmt(tool.diameter), `ø${fmt(tool.diameter)}`, tool.tipAngle !== undefined ? `${fmt(tool.tipAngle)}°` : "", tool.note ?? ""];
  const hay = facts.join(" ").toLowerCase().replace(/,/g, ".");
  return query
    .toLowerCase()
    .replace(/,/g, ".")
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/**
 * Which inlay, if any, each region belongs to. A shape is one wood, so it
 * belongs to one inlay at most; plain operations use any shapes, also those
 * of an inlay or of each other, and own none.
 */
export function regionOwners(steps: Step[]): Map<number, Step> {
  const owners = new Map<number, Step>();
  for (const step of steps) if (isInlay(step.task)) for (const id of step.regionIds) owners.set(id, step);
  return owners;
}

export interface MergeResult {
  tools: Tool[];
  added: number;
  updated: number;
}

/**
 * Merges imported tools into the list. A tool with the same name as an
 * existing one replaces it and keeps its id, so steps keep pointing at it.
 */
export function mergeTools(current: Tool[], incoming: Tool[]): MergeResult {
  const tools = [...current];
  let added = 0;
  let updated = 0;
  for (const tool of incoming) {
    const index = tools.findIndex((t) => t.name === tool.name);
    if (index >= 0) {
      tools[index] = { ...tool, id: tools[index].id };
      updated++;
    } else {
      const taken = tool.id !== "" && tools.some((t) => t.id === tool.id);
      tools.push({ ...tool, id: tool.id === "" || taken ? newId() : tool.id });
      added++;
    }
  }
  return { tools, added, updated };
}

/** Said on every tool of the starter set, until its owner says otherwise. */
export const STARTER_NOTE = "From the starter set: its cutting settings are a starting point, untested here.";

/**
 * Adds the starter set to a tool list without touching what is there: a tool
 * is added only when the list has none of its name or id, and a material or
 * group only when the list has none of its key. Its profiles are left out:
 * no starter tool has a row on one.
 */
export function addStarter(current: Tool[], lists: ToolLists, starter: { tools: Tool[] } & ToolLists): { tools: Tool[]; lists: ToolLists; added: number } {
  const fresh = starter.tools.filter((tool) => !current.some((t) => t.id === tool.id || t.name === tool.name));
  const missing = <T,>(have: T[] = [], offered: T[] = [], key: (item: T) => string) => offered.filter((item) => !have.some((h) => key(h) === key(item)));
  return {
    tools: [...current, ...fresh.map((tool) => ({ ...tool, note: tool.note ?? STARTER_NOTE }))],
    lists: {
      ...lists,
      materials: [...(lists.materials ?? []), ...missing(lists.materials, starter.materials, (m) => m.key)],
      groups: [...(lists.groups ?? []), ...missing(lists.groups, starter.groups, (g) => g.path)],
    },
    added: fresh.length,
  };
}

export function blankTool(kind: ToolKind): Tool {
  const base = { id: newId(), name: "", kind, cutting: [] };
  switch (kind) {
    case "v_bit":
      return { ...base, diameter: 6, tipDiameter: 0.1, tipAngle: 60, shankDiameter: 6 };
    case "corner_round":
      return { ...base, diameter: 8, tipDiameter: 2, cornerRadius: 3, shankDiameter: 6 };
    case "drill":
      return { ...base, diameter: 3, tipAngle: 118, shankDiameter: 3 };
    case "thread_mill":
      return { ...base, diameter: 2.4, shankDiameter: 4 };
    default:
      return { ...base, diameter: 3.175, shankDiameter: 3.175 };
  }
}

/** A tool's size in a few characters, as its kind is told apart by: Ø6 × 18, 60° Ø12, R1 Ø4, M3×0.5. */
export function toolSize(tool: Tool): string {
  const d = `Ø${fmt(tool.diameter)}`;
  switch (tool.kind) {
    case "v_bit":
      return `${fmt(tool.tipAngle ?? 0)}° ${d}`;
    case "corner_round":
      return `R${fmt(tool.cornerRadius ?? 0)} ${d}`;
    case "ball_end":
      return `${d} ball`;
    case "thread_mill":
      return tool.threadDiameter !== undefined && tool.pitch !== undefined ? `M${fmt(tool.threadDiameter)}×${fmt(tool.pitch)}` : d;
    default:
      return tool.fluteLength !== undefined ? `${d} × ${fmt(tool.fluteLength)}` : d;
  }
}

/** What each kind of tool is called. */
export const TOOL_KIND_LABELS: Record<ToolKind, string> = {
  flat_end: "Flat end mill",
  v_bit: "V-bit",
  corner_round: "Corner-rounding bit",
  ball_end: "Ball end mill",
  drill: "Drill",
  thread_mill: "Thread mill",
};

/** The kinds of tool an operation of this app can cut with. The others are only kept. */
export const CUTTING_KINDS: ToolKind[] = ["flat_end", "v_bit", "corner_round"];

/**
 * Merges the materials, profiles and groups of an imported library into the
 * ones held: an entry with the same key (or path) is replaced in its place,
 * a new one goes to the end.
 */
export function mergeLists(current: ToolLists, incoming: ToolLists): ToolLists {
  const merge = <T,>(a: T[] = [], b: T[] = [], key: (item: T) => string): T[] => {
    const out = [...a];
    for (const item of b) {
      const index = out.findIndex((o) => key(o) === key(item));
      if (index >= 0) out[index] = item;
      else out.push(item);
    }
    return out;
  };
  return {
    materials: merge(current.materials, incoming.materials, (m) => m.key),
    profiles: merge(current.profiles, incoming.profiles, (p) => p.key),
    groups: merge(current.groups, incoming.groups, (g) => g.path),
  };
}

/** What a material is called: its name in the Makera apps when the library has one, else its key. */
export function materialLabel(material: Material, lists: ToolLists): string {
  const known = MATERIALS.find((m) => m.value === material);
  if (known) return known.label;
  const info = lists.materials?.find((m) => m.key === material);
  return info?.label ?? info?.cam?.name ?? info?.studio?.[0]?.name ?? material;
}

/** The materials the feeds model knows by their own key, for a material of yours to cut like. */
export const FEED_MATERIALS: { value: Material; label: string }[] = [
  { value: "softwood", label: "Softwood" },
  { value: "hardwood", label: "Hardwood" },
  { value: "plastic", label: "Plastic" },
  { value: "pcb", label: "Laminate (PCB, carbon fibre, Bakelite)" },
  { value: "synthetic_stone", label: "Synthetic stone" },
  { value: "aluminum", label: "Aluminium" },
  { value: "brass", label: "Brass" },
  { value: "copper", label: "Copper" },
  { value: "titanium", label: "Titanium" },
];

/** The key the feeds model is asked about for a material: the one it is said to cut like, else its own. */
export function feedMaterial(material: Material, lists: ToolLists): Material {
  return lists.materials?.find((m) => m.key === material)?.feedsAs ?? material;
}

/** Hardwood and softwood are always there and cannot be renamed or deleted. */
export function isBuiltInMaterial(material: Material): boolean {
  return MATERIALS.some((m) => m.value === material);
}

/** Every material there is to choose from: the two woods, then the tool library's own, in its order. */
export function allMaterials(lists: ToolLists): { value: Material; label: string }[] {
  const own = (lists.materials ?? []).filter((m) => !isBuiltInMaterial(m.key));
  return [...MATERIALS, ...own.map((m) => ({ value: m.key, label: materialLabel(m.key, lists) }))];
}

/** A key for a new material, made from its name: lowercase letters and digits joined by "_", and not one already taken. */
export function materialKey(label: string, taken: Material[]): Material {
  const base =
    label
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/ł/g, "l")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "material";
  let key = base;
  for (let n = 2; taken.includes(key); n++) key = `${base}_${n}`;
  return key;
}

/**
 * A key for a new profile, made from its name: lowercase letters and digits
 * joined by "_", at most 40 characters, and not one already taken. A key a
 * YAML reader would take for a number or a truth value gets "tp_" in front.
 */
export function profileKey(label: string, taken: string[]): string {
  let base = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ł/g, "l")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (base === "") base = "profile";
  if (/^[0-9_]+$/.test(base) || ["yes", "no", "on", "off", "y", "n", "true", "false", "null"].includes(base)) base = `tp_${base}`;
  base = base.slice(0, 36).replace(/_+$/, "");
  let key = base;
  for (let n = 2; taken.includes(key); n++) key = `${base}_${n}`;
  return key;
}

/** A profile by its key: the tool library's, else the copy the project carries. */
export function findProfile(key: string, lists: ToolLists, project: Project): Profile | undefined {
  return lists.profiles?.find((p) => p.key === key) ?? project.profiles?.find((p) => p.key === key);
}

/** Whether a profile's rows are for adaptive clearing, which this app has no toolpath for. */
export function isAdaptive(key: string, profile: Profile | undefined): boolean {
  return profile?.adaptive ?? key === "adaptive";
}

/** The copies of profiles a project should carry: one per profile its steps' row choices name. */
export function profileSnapshots(project: Project, lists: ToolLists): Profile[] {
  const keys = new Set(project.steps.flatMap((j) => Object.values(j.rowProfiles ?? {})));
  return [...keys]
    .sort()
    .map((key) => findProfile(key, lists, project))
    .filter((p): p is Profile => p !== undefined);
}

/** A cutting row's material, with its profile when it has one: "Aluminum · Adaptive". */
export function rowLabel(row: Pick<CuttingSettings, "material" | "profile">, lists: ToolLists): string {
  const material = materialLabel(row.material, lists);
  if (row.profile === undefined || row.profile === null) return material;
  return `${material} · ${lists.profiles?.find((p) => p.key === row.profile)?.label ?? row.profile}`;
}

export const MATERIALS: { value: Material; label: string }[] = [
  { value: "hardwood", label: "Hardwood" },
  { value: "softwood", label: "Softwood" },
];

export function describeTool(tool: Tool): string {
  if (tool.kind === "v_bit") {
    const tip = tool.tipDiameter ? `, ${fmt(tool.tipDiameter)} mm tip` : "";
    return `${fmt(tool.tipAngle ?? 0)}° V-bit, Ø${fmt(tool.diameter)} mm${tip}`;
  }
  if (tool.kind === "corner_round") return `Corner-rounding bit, radius ${fmt(tool.cornerRadius ?? 0)} mm, ${fmt(tool.tipDiameter ?? 0)} mm tip`;
  return `${TOOL_KIND_LABELS[tool.kind]}, Ø${fmt(tool.diameter)} mm`;
}

/** Up to 3 decimals, no trailing zeros. */
export function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * The result that counts for a cutting row: the newest log entry cut at the
 * row's present numbers (of one date, the one written last). Entries at other
 * numbers, or without numbers, say nothing about the row as it is now.
 */
export function currentResult(row: CuttingSettings): CutResult | undefined {
  let best: CutResult | undefined;
  for (const entry of row.log ?? []) {
    const at = entry.at;
    const same =
      at !== undefined &&
      at.rpm === row.rpm &&
      at.feed === row.feed &&
      at.plunge === row.plunge &&
      at.stepover === row.stepover &&
      (at.stepoverUnit ?? "mm") === (row.stepoverUnit ?? "mm") &&
      at.stepdown === row.stepdown &&
      at.passes === row.passes;
    if (same && (best === undefined || entry.date >= best.date)) best = entry;
  }
  return best;
}

/** How a result is shown: its mark, what it is called, and its tone. */
export const OUTCOMES: Record<NonNullable<CutResult["outcome"]>, { mark: string; text: string; tone: string }> = {
  ok: { mark: "✓", text: "ok", tone: "good" },
  provisional: { mark: "○", text: "worked, still to confirm", tone: "warn" },
  failed: { mark: "✕", text: "failed", tone: "danger" },
};

/** Today as YYYY-MM-DD, by the clock of this computer. */
export function today(): string {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** Coatings offered when one is typed; any other text is allowed. */
export const COATINGS = ["AlCrN", "AlTiN", "DLC", "nACo", "TiAlN", "TiB2", "TiCN", "TiN", "TiSiN", "ZrN", "uncoated"];

/** The name the Makera apps show: the name with its coating after it, unless there is none, it is "uncoated", or the name already ends with it. */
export function displayName(name: string, coating: string | undefined): string {
  if (!coating || coating === "uncoated") return name;
  const [n, c] = [name.toLowerCase(), coating.toLowerCase()];
  return n === c || n.endsWith(` ${c}`) ? name : `${name} ${coating}`;
}

type RowRef = { material: Material; profile?: string };
const APP_LABELS = { cam: "Makera CAM", studio: "Makera Studio" } as const;
const appsOf = (tool: Tool) => (["cam", "studio"] as const).filter((app) => (tool.apps ?? ["cam", "studio"]).includes(app));
const recordsIn = (info: MaterialInfo | undefined, app: "cam" | "studio") => (app === "cam" ? (info?.cam ? 1 : 0) : (info?.studio?.length ?? 0));
/** Whether any material is tied to a material of a Makera app: without that, nothing here says where a row lands. */
const mapped = (lists: ToolLists) => (lists.materials ?? []).some((m) => m.cam !== undefined || (m.studio?.length ?? 0) > 0);

/**
 * The row of each material that the Makera apps get, which keep one per
 * material: its plain row, else its first profile row.
 */
function effectiveRows(rows: RowRef[]): Map<Material, string | undefined> {
  const out = new Map<Material, string | undefined>();
  for (const row of rows) if (!out.has(row.material) || row.profile === undefined) out.set(row.material, row.profile);
  return out;
}

/**
 * Where a cutting row lands when the tool list is written for other programs,
 * as the tooling library does it: "CAM · Studio (4 materials)", "Studio
 * only", "Fusion 360 only". A profile row reaches the Makera apps only when
 * its material has no plain row. Null when no material is tied to a Makera
 * material, which a list gets by importing a tools.yaml.
 */
export function goesTo(tool: Tool, row: RowRef, lists: ToolLists): string | null {
  if (!mapped(lists)) return null;
  const info = lists.materials?.find((m) => m.key === row.material);
  const apps = appsOf(tool).filter((app) => recordsIn(info, app) > 0);
  if (row.profile !== undefined) {
    return effectiveRows(tool.cutting).get(row.material) === row.profile && apps.length > 0 ? `Fusion 360; ${apps.map((app) => APP_LABELS[app]).join(" and ")} as a fallback ▲` : "Fusion 360 only";
  }
  const n = info?.studio?.length ?? 0;
  const count = apps.includes("studio") && n > 1 ? ` (${n} materials)` : "";
  if (apps.length === 0) return "neither Makera app";
  if (apps.length === 1) return `${apps[0] === "cam" ? "CAM" : "Studio"} only${count}`;
  return `CAM · Studio${count}`;
}

/** What to know about where a tool's rows land in the Makera apps: a material an app does not have, and a profile row an app gets for want of a plain one. */
export function makeraWarnings(tool: Tool, lists: ToolLists): string[] {
  if (!mapped(lists)) return [];
  const out: string[] = [];
  const apps = appsOf(tool);
  for (const [material, profile] of effectiveRows(tool.cutting)) {
    const info = lists.materials?.find((m) => m.key === material);
    const label = materialLabel(material, lists);
    if (apps.length > 0 && apps.every((app) => recordsIn(info, app) === 0)) {
      out.push(`${label} goes to neither Makera library: they have no ${label.toLowerCase()} material.`);
      continue;
    }
    for (const app of apps) {
      if (recordsIn(info, app) > 0) {
        if (profile !== undefined) {
          const name = lists.profiles?.find((p) => p.key === profile)?.label ?? profile;
          out.push(`${APP_LABELS[app]} gets the ${name} row for ${label.toLowerCase()}, which has no plain row: it may be run as a full slot.`);
        }
        continue;
      }
      const other = apps.find((a) => a !== app && recordsIn(info, a) > 0);
      if (other) out.push(`${label} goes to ${APP_LABELS[other]} only: ${APP_LABELS[app]} has no ${label.toLowerCase()} material.`);
    }
  }
  return [...new Set(out)];
}
