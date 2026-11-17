// Pure helpers over the data model: no React, no storage.

import type { CutResult, CuttingSettings, Design, GlueStep, Inlay, Job, JobType, Machine, Material, MaterialInfo, Profile, Project, Ring, Setup, Tool, ToolKind, ToolLists, TrueInlay } from "../core/types";

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
  return { id: newId(), name, design: null, jobs: [], tools: [], base: { thickness: 18 }, machine: DEFAULT_MACHINE, setup: DEFAULT_SETUP };
}

export function defaultInlay(type: JobType): Inlay {
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
  }
}

/** How far a chamfering V-bit's tip is kept clear of the edge unless the chamfer says otherwise, mm, and the most it may be. */
export const DEFAULT_TIP_CLEARANCE = coreValues.chamfer.tipClearance.default;
export const MAX_TIP_CLEARANCE = coreValues.chamfer.tipClearance.max;

/** What each kind of job is called. */
export const JOB_LABELS: Record<JobType, string> = {
  vcarve: "V-carve inlay",
  flat: "Flat inlay",
  pocket: "Pocket",
  facing: "Facing",
  contour: "Contour",
  chamfer: "Chamfer",
  glue: "Glue-up",
};

/** True for an inlay, which has a second part; false for a plain operation on the stock. */
export function isInlay(inlay: Inlay): inlay is TrueInlay {
  return inlay.type === "vcarve" || inlay.type === "flat";
}

/** True for a step done by hand, which has no file and no tools. */
export function isByHand(inlay: Inlay): inlay is GlueStep {
  return inlay.type === "glue";
}

/**
 * The step that glues an inlay's plug or inserts into its pocket. From it
 * on, the stock has their wood on it for the steps below it in the list.
 * Null for a plain operation.
 */
export function glueStep(owner: Job, existing: Job[]): Job | null {
  if (!isInlay(owner.inlay)) return null;
  let name = `Glue in ${owner.name}`;
  for (let n = 2; existing.some((j) => j.name === name); n++) name = `Glue in ${owner.name} ${n}`;
  return { id: newId(), name, material: owner.material, regionIds: [], inlay: { type: "glue", inlayId: owner.id } };
}

/** The step that glues this inlay in, if the list has one. */
export function glueOf(owner: Job, jobs: Job[]): Job | undefined {
  return jobs.find((j) => j.inlay.type === "glue" && j.inlay.inlayId === owner.id);
}

/** The list without a job, and without the glue-up of an inlay that is gone. */
export function withoutJob(jobs: Job[], id: string): Job[] {
  return withoutOrphans(jobs.filter((j) => j.id !== id));
}

/** The list without glue-ups whose inlay is not in it. The same list when there are none. */
export function withoutOrphans(jobs: Job[]): Job[] {
  const kept = jobs.filter((j) => j.inlay.type !== "glue" || jobs.some((other) => other.id === (j.inlay as GlueStep).inlayId && isInlay(other.inlay)));
  return kept.length === jobs.length ? jobs : kept;
}

/** The list with a job put in right after another, or at the end when that one is not there. */
export function insertAfter(jobs: Job[], afterId: string | undefined, job: Job): Job[] {
  const at = jobs.findIndex((j) => j.id === afterId);
  return at < 0 ? [...jobs, job] : [...jobs.slice(0, at + 1), job, ...jobs.slice(at + 1)];
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

/**
 * How far a glued-in part of an inlay stands above the stock, and how far
 * its blank reaches beyond its shapes. Null for a plain operation.
 */
export function standingPart(owner: Job): { above: number; margin: number; what: "plug" | "inserts" } | null {
  const inlay = owner.inlay;
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
export function trimFacing(owner: Job, existing: Job[], setup: Setup): Job | null {
  const part = standingPart(owner);
  if (!part || part.what !== "plug" || !(part.above > 0) || owner.regionIds.length === 0) return null;
  const job = newJob("facing", [...owner.regionIds], existing, setup);
  let name = `Trim ${owner.name}`;
  for (let n = 2; existing.some((j) => j.name === name); n++) name = `Trim ${owner.name} ${n}`;
  return {
    ...job,
    name,
    material: owner.material,
    inlay: { type: "facing", above: Math.round(part.above * 100) / 100, depth: 0, margin: part.margin, pattern: "raster", toolId: null },
  };
}

/**
 * The facing that trims this inlay's plug, if the project has one: a facing
 * over exactly the inlay's shapes that starts above the surface.
 */
export function trimOf(owner: Job, jobs: Job[]): Job | undefined {
  const shapes = new Set(owner.regionIds);
  return jobs.find((j) => j.inlay.type === "facing" && j.inlay.above > 0 && j.regionIds.length === shapes.size && j.regionIds.every((id) => shapes.has(id)));
}

export function jobToolIds(job: Job): string[] {
  const inlay = job.inlay;
  const ids: (string | null)[] =
    inlay.type === "vcarve"
      ? [...inlay.clearingToolIds, inlay.vbitToolId]
      : inlay.type === "flat" || inlay.type === "pocket"
        ? [...inlay.clearingToolIds]
        : inlay.type === "glue"
          ? []
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
  if (job.regionIds.length === 0 && inlay.type !== "facing" && inlay.type !== "glue") return `Click shapes in the drawing to add them to this ${isInlay(inlay) ? "inlay" : "operation"} first.`;
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
    case "glue":
      return null;
  }
}

/** The first of a job's tools that has no cutting settings for the job's material, as a sentence; null when all have. */
export function missingSettings(job: Job, tools: Tool[], lists: ToolLists): string | null {
  for (const id of jobToolIds(job)) {
    const tool = tools.find((t) => t.id === id);
    if (tool && !tool.cutting.some((c) => c.material === job.material)) {
      return `"${tool.name}" has no cutting settings for ${materialLabel(job.material, lists).toLowerCase()}. Add them in the tool list, or choose another tool.`;
    }
  }
  return null;
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

/** The copies of profiles a project should carry: one per profile its jobs' row choices name. */
export function profileSnapshots(project: Project, lists: ToolLists): Profile[] {
  const keys = new Set(project.jobs.flatMap((j) => Object.values(j.rowProfiles ?? {})));
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
