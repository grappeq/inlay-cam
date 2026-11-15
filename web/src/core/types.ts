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
  /** Cut the finished plug out of a larger board, as one piece. */
  cutOut: boolean;
  /** When cutting the plug out, hold it to the board with tabs. */
  tabs: boolean;
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
  /** End mills that cut the pocket, in the order they are used. The smallest cuts the insert out. */
  clearingToolIds: string[];
  /** Loose pieces cut right through the board, or one mirrored plug on a backer. */
  insertStyle: "loose" | "backer";
  /** Backer plugs: space between the surface and the backer, mm. */
  sawGap: number;
  /** Backer plugs: cut the finished plug out of a larger board. */
  cutOut: boolean;
  /** Thickness of the board the insert is cut from, mm. */
  insertThickness: number;
  /** Width of board left around the shapes on the insert board, mm. */
  insertMargin: number;
}

export type Inlay = VcarveInlay | FlatInlay;

export interface Job {
  id: string;
  name: string;
  material: Material;
  regionIds: number[];
  /** Clearances and tabs for this inlay's files. An inlay from an older file has none and uses the project's. */
  setup?: Setup;
  /** The end mill that cuts a plug out of its board. Without one, the largest of the inlay's end mills that reaches through. */
  cutOutToolId?: string;
  inlay: Inlay;
}

/** The machine the files are for: the limits they are checked against. */
export interface Machine {
  name: string;
  /** Top spindle speed, rpm. */
  maxRpm: number;
  /** Rapid speed, mm/min, for time estimates. */
  rapidRate: number;
  /** How far the tool can move in X and Y. */
  travel: [number, number];
  /** Number of the first tool in a file. */
  firstTool: number;
}

/** Clearances and tabs: how the files of an inlay are cut. */
export interface Setup {
  /** Height above the board at which the tool travels between cuts. */
  safeHeight: number;
  /** Height above already-cut wood at which the plunge feed takes over. */
  plungeClearance: number;
  /** How far past the bottom of its board a part is cut. */
  throughCut: number;
  tabWidth: number;
  tabSpacing: number;
  /** Never more than half the board. */
  tabThickness: number;
  /** Board left around a plug that is cut out of it, beyond the width of the cut. */
  cutOutBorder: number;
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
  /** A copy of the machine set under Tools and settings. */
  machine: Machine;
  /** For inlays without clearances and tabs of their own. */
  setup: Setup;
}

export interface ImportReport {
  /** Kinds of thing in the file that were not read, by the file's own names. */
  unsupported: string[];
  /** DXF: the unit the drawing was in, when it was not millimetres. */
  unitNote: string | null;
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
  /** How many times a tool is put in the spindle. */
  toolChanges: number;
  /** What each tool does, in the order they are loaded. */
  perTool: { number: number; name: string; cuttingLength: number; minutes: number }[];
}

/** The two halves of an inlay; each has its own board and file. */
export type Part = "pocket" | "plug";

export interface Built {
  part: Part;
  /** The board the part is cut from, mm. */
  stock: { width: number; height: number; thickness: number; through: number };
  /** Flat inlays: the outline both parts are cut to before the allowance, on the base board. */
  cuttable: [number, number][][];
  /** Flat inlays: how insert and pocket go together. Lengths in mm, areas in mm². */
  flatFit: {
    gapMin: number;
    gapMax: number;
    interferenceArea: number;
    proud: number;
    removedArea: number;
    addedArea: number;
  } | null;
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
  /** Tool path: x0 y0 z0 x1 y1 z1 rapid tool line, per straight piece, in the order they are cut. */
  path: Float32Array;
}
