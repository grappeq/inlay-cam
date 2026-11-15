// Pure helpers over the data model: no React, no storage.

import type { Design, Inlay, Job, JobType, Machine, Material, Project, Ring, Setup, Tool, ToolKind, TrueInlay } from "../core/types";

export function newId(): string {
  return crypto.randomUUID();
}

/** Machines whose limits can be filled in with one click. The first is the one a new installation starts with. */
export const MACHINE_PRESETS: Machine[] = [
  { name: "Carvera Air", maxRpm: 13000, rapidRate: 2000, travel: [300, 200], firstTool: 1 },
  { name: "Carvera", maxRpm: 15000, rapidRate: 2000, travel: [360, 240], firstTool: 1 },
];
export const DEFAULT_MACHINE: Machine = MACHINE_PRESETS[0];

/** The app's own clearances and tabs: the same values the core gives a project file that has none. */
export const DEFAULT_SETUP: Setup = {
  safeHeight: 5,
  plungeClearance: 1,
  throughCut: 0.2,
  tabWidth: 4,
  tabSpacing: 40,
  tabThickness: 1,
  cutOutBorder: 5,
};

/** The range each clearance may take, as the core checks them. The plunge height is also capped by the travel height. */
export const SETUP_LIMITS: Record<keyof Setup, [number, number]> = {
  safeHeight: [1, 50],
  plungeClearance: [0.1, 50],
  throughCut: [0, 2],
  tabWidth: [0.5, 50],
  tabSpacing: [5, 1000],
  tabThickness: [0.1, 20],
  cutOutBorder: [0, 100],
};

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
export function jobSetup(job: Job, project: Project): Setup {
  return job.setup ?? project.setup;
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
    maxRpm: whole(stored.maxRpm, d.maxRpm, 1_000_000),
    rapidRate: positive(stored.rapidRate, d.rapidRate),
    travel: [positive(travel[0], d.travel[0]), positive(travel[1], d.travel[1])],
    firstTool: whole(stored.firstTool, d.firstTool, 99),
  };
}

export function newProject(name = "Untitled inlay"): Project {
  return { id: newId(), name, design: null, jobs: [], tools: [], base: { thickness: 18 }, machine: DEFAULT_MACHINE, setup: DEFAULT_SETUP };
}

export function defaultInlay(type: JobType): Inlay {
  switch (type) {
    case "vcarve":
      return { type, engagementDepth: 3, glueGap: 0.3, sawGap: 1.5, clearingToolIds: [], vbitToolId: null, plugMargin: 8, plugThickness: 10, cutOut: false, tabs: true };
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
  }
}

/** What each kind of job is called. */
export const JOB_LABELS: Record<JobType, string> = {
  vcarve: "V-carve inlay",
  flat: "Flat inlay",
  pocket: "Pocket",
  facing: "Facing",
  contour: "Contour",
  chamfer: "Chamfer",
};

/** True for an inlay, which has a second part; false for a plain operation on the stock. */
export function isInlay(inlay: Inlay): inlay is TrueInlay {
  return inlay.type === "vcarve" || inlay.type === "flat";
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
const OLD_JOB_COLORS = ["#c2552d", "#2f7f6f", "#8a5fbf", "#b8892b", "#3f78b5", "#b04a7a"];
/** The woods new inlays are given in turn: ones that stand out from a light stock. */
const NEW_INLAY_WOODS = ["#5d3d24", "#b06a3c", "#a8432b", "#3b2a20", "#6d3a5c", "#c9a56b"];

/** The colour an inlay is drawn in. */
export function jobColor(job: Job, jobs: Job[]): string {
  return job.color ?? OLD_JOB_COLORS[Math.max(0, jobs.indexOf(job)) % OLD_JOB_COLORS.length];
}

export function stockColor(project: Project): string {
  return project.base.color ?? DEFAULT_STOCK_COLOR;
}

export function newJob(type: JobType, regionIds: number[], existing: Job[], setup: Setup): Job {
  const label = JOB_LABELS[type];
  let n = existing.filter((j) => j.inlay.type === type).length + 1;
  while (existing.some((j) => j.name === `${label} ${n}`)) n++;
  const job: Job = { id: newId(), name: `${label} ${n}`, material: "hardwood", regionIds, setup, inlay: defaultInlay(type) };
  if (isInlay(job.inlay)) {
    const taken = new Set(existing.map((j) => j.color));
    job.color = NEW_INLAY_WOODS.find((c) => !taken.has(c)) ?? NEW_INLAY_WOODS[existing.length % NEW_INLAY_WOODS.length];
  }
  return job;
}

export function jobToolIds(job: Job): string[] {
  const inlay = job.inlay;
  const ids: (string | null)[] =
    inlay.type === "vcarve"
      ? [...inlay.clearingToolIds, inlay.vbitToolId]
      : inlay.type === "flat" || inlay.type === "pocket"
        ? [...inlay.clearingToolIds]
        : [inlay.toolId];
  if (job.cutOutToolId !== undefined && cutsPlugOut(inlay)) ids.push(job.cutOutToolId);
  return [...new Set(ids.filter((id): id is string => id !== null))];
}

/** Whether the inlay's plug is cut out of a larger board as the last step of its file. */
export function cutsPlugOut(inlay: Inlay): boolean {
  return isInlay(inlay) && inlay.cutOut && (inlay.type === "vcarve" || inlay.insertStyle === "backer");
}

/** How deep the cut that frees a plug from its board goes. */
export function cutOutDepth(job: Job, project: Project): number {
  const board = job.inlay.type === "vcarve" ? job.inlay.plugThickness : job.inlay.type === "flat" ? job.inlay.insertThickness : 0;
  return board + jobSetup(job, project).throughCut;
}

/** What has to be chosen before a job's files can be made, or null when nothing is missing. */
export function missingFor(job: Job): string | null {
  const inlay = job.inlay;
  if (job.regionIds.length === 0 && inlay.type !== "facing") return `Click shapes in the drawing to add them to this ${isInlay(inlay) ? "inlay" : "operation"} first.`;
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
      return inlay.toolId === null ? "Choose an end mill first." : inlay.above + inlay.depth <= 0 ? "Give the wood above the surface, a depth below it, or both." : null;
    case "contour":
      return inlay.toolId === null ? "Choose an end mill first." : null;
  }
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
 * the middle of the stock where they fit, else from its bottom-left corner,
 * with the stock grown to hold them. Returns the new shapes' ids.
 */
export function addDrawing(design: Design, incoming: Design): { design: Design; ids: number[] } {
  const added = normaliseDesign(incoming);
  let box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of added.regions) for (const [x, y] of r.outer) box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
  if (added.regions.length === 0) return { design, ids: [] };
  const [w, h] = [box[2] - box[0], box[3] - box[1]];
  const dx = Math.max(0, (design.width - w) / 2) - box[0];
  const dy = Math.max(0, (design.height - h) / 2) - box[1];
  let next = design.regions.reduce((max, r) => Math.max(max, r.id), -1) + 1;
  const shift = (ring: Ring): Ring => ring.map(([x, y]) => [x + dx, y + dy]);
  const regions = added.regions.map((r) => ({ ...r, id: next++, outer: shift(r.outer), holes: r.holes.map(shift) }));
  const names = design.sourceName.split(", ").filter((n) => n !== "");
  if (!names.includes(added.sourceName)) names.push(added.sourceName);
  return {
    design: {
      ...design,
      sourceName: names.join(", "),
      width: Math.max(design.width, w),
      height: Math.max(design.height, h),
      regions: [...design.regions, ...regions],
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
export function usualCutOutTool(job: Job, tools: Tool[], project: Project): Tool | undefined {
  const depth = cutOutDepth(job, project);
  if (!isInlay(job.inlay)) return undefined;
  return job.inlay.clearingToolIds
    .map((id) => resolveTool(id, tools, project))
    .filter((t): t is Tool => t !== undefined && t.kind === "flat_end")
    .sort((a, b) => b.diameter - a.diameter)
    .find((t) => t.fluteLength === undefined || t.fluteLength >= depth);
}

/** The tool a job refers to: the current one from the tool list, else the copy kept in the project. */
export function resolveTool(id: string | null, tools: Tool[], project: Project): Tool | undefined {
  if (id === null) return undefined;
  return tools.find((t) => t.id === id) ?? project.tools.find((t) => t.id === id);
}

/**
 * The copies of tools a project should carry: one per tool its jobs use,
 * refreshed from the tool list where the tool still exists there.
 */
export function toolSnapshots(project: Project, tools: Tool[]): Tool[] {
  const ids = new Set(project.jobs.flatMap(jobToolIds));
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

/** Tools offered for a slot: the tool list plus project-only copies, of one kind or of several, by kind and diameter. */
export function toolChoices(kind: ToolKind | ToolKind[], tools: Tool[], project: Project): Tool[] {
  const kinds = Array.isArray(kind) ? kind : [kind];
  return [...tools, ...projectOnlyTools(project, tools)]
    .filter((t) => kinds.includes(t.kind))
    .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.diameter - b.diameter || a.name.localeCompare(b.name));
}

/**
 * Which inlay, if any, each region belongs to. A shape is one wood, so it
 * belongs to one inlay at most; plain operations use any shapes, also those
 * of an inlay or of each other, and own none.
 */
export function regionOwners(jobs: Job[]): Map<number, Job> {
  const owners = new Map<number, Job>();
  for (const job of jobs) if (isInlay(job.inlay)) for (const id of job.regionIds) owners.set(id, job);
  return owners;
}

export interface MergeResult {
  tools: Tool[];
  added: number;
  updated: number;
}

/**
 * Merges imported tools into the list. A tool with the same name as an
 * existing one replaces it and keeps its id, so jobs keep pointing at it.
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

export function blankTool(kind: ToolKind): Tool {
  return kind === "v_bit"
    ? { id: newId(), name: "", kind, diameter: 6, tipDiameter: 0.1, tipAngle: 60, shankDiameter: 6, cutting: [] }
    : kind === "corner_round"
      ? { id: newId(), name: "", kind, diameter: 8, tipDiameter: 2, cornerRadius: 3, shankDiameter: 6, cutting: [] }
      : { id: newId(), name: "", kind, diameter: 3.175, shankDiameter: 3.175, cutting: [] };
}

/** What each kind of tool is called. */
export const TOOL_KIND_LABELS: Record<ToolKind, string> = { flat_end: "Flat end mill", v_bit: "V-bit", corner_round: "Corner-rounding bit" };

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
  return `Flat end mill, Ø${fmt(tool.diameter)} mm`;
}

/** Up to 3 decimals, no trailing zeros. */
export function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
