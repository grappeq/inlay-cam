// TypeScript mirror of the core's data model. The Rust definitions in
// crates/inlay-core (tools.rs, project.rs, import/) are the source of truth;
// keep these in step with them. Lengths are mm, angles degrees, feeds mm/min.

export type Material = "hardwood" | "softwood";
export type ToolKind = "flat_end" | "v_bit";

export interface CuttingSettings {
  material: Material;
  rpm: number;
  feed: number;
  plunge: number;
  /** Sideways distance between passes, mm. */
  stepover: number;
  /** Depth per pass, mm. */
  stepdown: number;
}

export interface Tool {
  id: string;
  name: string;
  kind: ToolKind;
  diameter: number;
  /** V-bit only: diameter of the flat at the tip. */
  tipDiameter?: number;
  /** V-bit only: included angle. */
  tipAngle?: number;
  fluteLength?: number;
  shankDiameter: number;
  length?: number;
  flutes?: number;
  cutting: CuttingSettings[];
}

export type Point = [number, number];
export type Ring = Point[];

export interface DesignRegion {
  id: number;
  color?: string;
  outer: Ring;
  holes: Ring[];
}

export interface Design {
  sourceName: string;
  width: number;
  height: number;
  scale: number;
  mirror: boolean;
  regions: DesignRegion[];
}

export interface VcarveInlay {
  type: "vcarve";
  engagementDepth: number;
  glueGap: number;
  sawGap: number;
  clearingToolIds: string[];
  vbitToolId: string | null;
}

export interface FlatInlay {
  type: "flat";
  pocketDepth: number;
  allowance: number;
  tabs: boolean;
  toolId: string | null;
}

export type Inlay = VcarveInlay | FlatInlay;

export interface Job {
  id: string;
  name: string;
  material: Material;
  regionIds: number[];
  inlay: Inlay;
}

export interface Project {
  id: string;
  name: string;
  design: Design | null;
  jobs: Job[];
  /** Copies of the tools the jobs use. */
  tools: Tool[];
  /** The board the pockets are cut into. Its outline is the design's page. */
  base: { thickness: number };
}

export interface ImportReport {
  strokeOnlyPaths: number;
  hasText: boolean;
  images: number;
  specks: number;
}

export interface SvgImport {
  design: Design;
  report: ImportReport;
}

export interface ToolsYamlImport {
  /** Ids are empty; the caller assigns them. */
  tools: Tool[];
  skipped: { name: string; reason: string }[];
}

export interface BuildStats {
  lines: number;
  /** Total length of cutting moves, mm. */
  cuttingLength: number;
  /** Estimated running time without tool changes, minutes. */
  minutes: number;
  /** Tool names in the order they are loaded. */
  tools: string[];
}

export interface Built {
  fileName: string;
  gcode: string;
  stats: BuildStats;
  warnings: string[];
}

/** A built G-code file together with the simulation of that file. */
export interface PocketPreview {
  built: Built;
  /** Problems found while simulating, each with its G-code line. */
  problems: { line: number; message: string }[];
  /** Height-map cell size, mm. */
  cell: number;
  nx: number;
  ny: number;
  /** Stock height per cell (0 is the uncut top), row by row from Y = 0. */
  heights: Float32Array;
  /** Tool path: x0 y0 z0 x1 y1 z1 rapid, per straight piece. */
  path: Float32Array;
}
