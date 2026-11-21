// Messages between the page and the core worker. Every core call is listed
// here once, so the worker and the client cannot drift apart.

import type { Attention, Built, EdgePlan, FusionExport, MakeraExport, Machine, MakeraImportPlan, FeedEntry, Profile, FeedFlags, FeedOptions, FeedSuggestion, RowCheck, FitCheck, Part, PocketPreview, Project, StockTimeline, SvgImport, Tool, ToolLibrary, ToolsYamlImport } from "./types";

export interface CoreApi {
  coreVersion(): string;
  /** `gap`: the ends of open outlines are joined across gaps up to this, mm, when it is more than the usual 0.01 mm. */
  importSvg(text: string, sourceName: string, gap?: number): SvgImport;
  /** Reads a DXF drawing, text or binary, from its bytes. `gap` as for an SVG. */
  importDxf(bytes: Uint8Array, sourceName: string, gap?: number): SvgImport;
  importToolsYaml(text: string): ToolsYamlImport;
  /** Reads a project file of any supported format version. */
  projectFromFile(text: string): Project;
  /** Validates the project and returns the file text. */
  projectToFile(project: Project): string;
  /** The tools, materials and profiles the app can start a tool list with. */
  starterLibrary(): ToolLibrary;
  /** Reads a tool-library file of any supported format version. */
  libraryFromFile(text: string): ToolLibrary;
  /** Validates the tools and what they refer to, and returns the file text. */
  libraryToFile(library: ToolLibrary): string;
  /** Validates the library and returns it as a tooling-library tools.yaml. */
  libraryToToolsYaml(library: ToolLibrary): string;
  /** A starting point for a tool's cutting settings in a material. Its status says whether there are values, and whether to trust them. */
  suggestFeeds(tool: Tool, material: string, options: FeedOptions): FeedSuggestion;
  /** The suggestion at each of the five stops, gentlest first. */
  suggestStops(tool: Tool, material: string, flags: FeedFlags): FeedSuggestion[];
  /** The standard name to offer for a tool, or null. `named`: the name a V-bit is read by; `taken`: every other tool's name and shown name. */
  suggestName(tool: Tool, named: string, taken: string[]): { name: string; accepted: string[] } | null;
  /** A tool list as a Makera CAM or Makera Studio library. `now`: ISO-8601 UTC. */
  exportMakera(library: ToolLibrary, app: "cam" | "studio", now: string): MakeraExport;
  exportFusion(library: ToolLibrary): FusionExport;
  /** Holds an export of Makera CAM or Makera Studio against the tool list. */
  planMakeraImport(library: ToolLibrary, data: Uint8Array): MakeraImportPlan;
  /** The tool list with the ticked changes of a plan made to it. */
  applyMakeraImport(library: ToolLibrary, plan: MakeraImportPlan, selected: string[]): ToolLibrary;
  /** Everything the feeds model has for one cutting row; `profile` is null for a plain row. */
  suggestEntry(tool: Tool, material: string, profile: Profile | null, machine: Machine): FeedEntry;
  /** Holds a cutting row's numbers against the feeds model. */
  checkRow(tool: Tool, material: string, values: { rpm: number; feed: number; plunge: number; stepover: number; stepdown: number; adaptive: boolean }, machine: Machine): RowCheck;
  /** What wants looking at in a tool list, worst first. */
  needsAttention(tools: Tool[]): Attention[];
  /** The problem with the tool as text, or null when it is valid. */
  validateTool(tool: Tool): string | null;
  /** Why Makera CAM could not read the tool's shown name, or null when it can or the tool does not go there. */
  camNameProblem(tool: Tool): string | null;
  /**
   * Builds the G-code for one part of a step and simulates it. Fails with
   * every reason the part cannot be built, one per line of the error message.
   */
  previewPart(project: Project, stepId: string, part: Part): PocketPreview;
  /** For a facing: how far above the surface its first pass begins, as given or as the list gives it. Null for any other step. */
  facingStart(project: Project, stepId: string): number | null;
  /** For a chamfer: how its edge would be cut, pass by pass, or why it cannot be. Null for any other step. */
  chamferPlan(project: Project, stepId: string): { plan: EdgePlan } | { problem: string } | null;
  /** Takes the stock through every inlay and operation of the project, in the order of the list, and makes the files for the stock. Fails only for a project without a drawing. */
  stockTimeline(project: Project): StockTimeline;
  /** One file for the picked entries of the list, which have to stand between the same two steps done by hand. Fails with every reason it cannot be made, one per line of the error message. */
  exportSteps(project: Project, stepIds: string[]): Built;
  /** Builds and simulates both parts of a V-carve inlay and measures their fit. */
  checkFit(project: Project, stepId: string): FitCheck;
}

export type CoreMethod = keyof CoreApi;

export interface CoreRequest<M extends CoreMethod = CoreMethod> {
  id: number;
  method: M;
  args: Parameters<CoreApi[M]>;
}

export type CoreResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
