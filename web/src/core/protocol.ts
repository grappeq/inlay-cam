// Messages between the page and the core worker. Every core call is listed
// here once, so the worker and the client cannot drift apart.

import type { FitCheck, Part, PocketPreview, Project, SvgImport, Tool, ToolsYamlImport } from "./types";

export interface CoreApi {
  coreVersion(): string;
  importSvg(text: string, sourceName: string): SvgImport;
  importToolsYaml(text: string): ToolsYamlImport;
  /** Reads a project file of any supported format version. */
  projectFromFile(text: string): Project;
  /** Validates the project and returns the file text. */
  projectToFile(project: Project): string;
  toolsFromFile(text: string): Tool[];
  toolsToFile(tools: Tool[]): string;
  /** The problem with the tool as text, or null when it is valid. */
  validateTool(tool: Tool): string | null;
  /**
   * Builds the G-code for one part of a job and simulates it. Fails with
   * every reason the part cannot be built, one per line of the error message.
   */
  previewPart(project: Project, jobId: string, part: Part): PocketPreview;
  /** Builds and simulates both parts of a V-carve inlay and measures their fit. */
  checkFit(project: Project, jobId: string): FitCheck;
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
