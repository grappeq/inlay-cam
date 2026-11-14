// Pure helpers over the data model: no React, no storage.

import type { Inlay, Job, Material, Project, Tool, ToolKind } from "../core/types";

export function newId(): string {
  return crypto.randomUUID();
}

export function newProject(name = "Untitled inlay"): Project {
  return { id: newId(), name, design: null, jobs: [], tools: [], base: { thickness: 18 } };
}

export function defaultInlay(type: Inlay["type"]): Inlay {
  return type === "vcarve"
    ? { type, engagementDepth: 3, glueGap: 0.3, sawGap: 1.5, clearingToolIds: [], vbitToolId: null, plugMargin: 8, plugThickness: 10 }
    : { type, pocketDepth: 3, allowance: 0.1, tabs: false, toolId: null };
}

export function newJob(type: Inlay["type"], regionIds: number[], existing: Job[]): Job {
  const label = type === "vcarve" ? "V-carve inlay" : "Flat inlay";
  let n = existing.length + 1;
  while (existing.some((j) => j.name === `${label} ${n}`)) n++;
  return { id: newId(), name: `${label} ${n}`, material: "hardwood", regionIds, inlay: defaultInlay(type) };
}

export function jobToolIds(job: Job): string[] {
  const ids = job.inlay.type === "vcarve" ? [...job.inlay.clearingToolIds, job.inlay.vbitToolId] : [job.inlay.toolId];
  return ids.filter((id): id is string => id !== null);
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

/** Tools offered for a slot: the tool list plus project-only copies, of one kind, by diameter. */
export function toolChoices(kind: ToolKind, tools: Tool[], project: Project): Tool[] {
  return [...tools, ...projectOnlyTools(project, tools)]
    .filter((t) => t.kind === kind)
    .sort((a, b) => a.diameter - b.diameter || a.name.localeCompare(b.name));
}

/** Which job, if any, each region belongs to. */
export function regionOwners(jobs: Job[]): Map<number, Job> {
  const owners = new Map<number, Job>();
  for (const job of jobs) for (const id of job.regionIds) owners.set(id, job);
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
    : { id: newId(), name: "", kind, diameter: 3.175, shankDiameter: 3.175, cutting: [] };
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
  return `Flat end mill, Ø${fmt(tool.diameter)} mm`;
}

/** Up to 3 decimals, no trailing zeros. */
export function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
