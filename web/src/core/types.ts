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
  /** Width of blank left around the shapes on the plug, mm. */
  plugMargin: number;
  /** Thickness of the plug blank, mm. */
  plugThickness: number;
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
  openOutlines: number;
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

/** The two halves of an inlay; each has its own board and file. */
export type Part = "pocket" | "plug";

export interface Built {
  part: Part;
  /** The board the part is cut from, mm. */
  stock: { width: number; height: number; thickness: number };
  /** Stretches of the design, as placed on the base board, too narrow for the plug to seat. */
  narrow: [[number, number], [number, number]][];
  fileName: string;
  gcode: string;
  stats: BuildStats;
  warnings: string[];
}

/** How a simulated plug sits in its simulated pocket. Lengths in mm. */
export interface FitReport {
  /** Height of the plug blank's face relative to the base board's surface at rest. */
  restingSeat: number;
  intendedSeat: number;
  /** How much higher than designed the plug rests. */
  proud: number;
  firstContact: [number, number];
  /** Pressed to the designed height: deepest overlap and its area in mm². */
  pressOverlap: number;
  pressOverlapArea: number;
  glueGapMin: number | null;
  glueGapMean: number | null;
  /** Share of the bearing wall the plug touches, 0 to 1. */
  wallContact: number;
  wallGapMax: number;
  /** Visible gaps in the finished face: area in mm² and widest in mm. */
  voidArea: number;
  voidWidth: number;
  trimDepth: number;
}

/** Both parts of a V-carve inlay simulated and fitted, over the base board's grid. */
export interface FitCheck {
  report: FitReport;
  cell: number;
  nx: number;
  ny: number;
  /** Simulation problems found in the two files. */
  problems: number;
  /** Space between pocket and plug per cell; NaN where no plug lies over the board. */
  gap: Float32Array;
  /** Underside of the resting plug per cell, in the base board's Z; NaN where none. */
  plugUnder: Float32Array;
  /** Finished face per cell: 0 base board, 1 plug, 2 gap. */
  face: Uint8Array;
  /** The simulated base board per cell. */
  base: Float32Array;
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
