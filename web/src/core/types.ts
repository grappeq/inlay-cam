// TypeScript mirror of the core's data model. The Rust definitions in
// crates/inlay-core (tools.rs, project.rs, import/) are the source of truth;
// keep these in step with them. Lengths are mm, angles degrees, feeds mm/min.

/** What is cut, as a key. Hardwood and softwood are always known; others come from the tool library's material list. */
export type Material = string;
/** Ball end mills, drills and thread mills are kept in the tool list; no operation cuts with them. */
export type ToolKind = "flat_end" | "v_bit" | "corner_round" | "ball_end" | "drill" | "thread_mill";

/** Ids a group, tool or cutting row has in the Makera apps. */
export interface AppIds {
  cam?: string;
  studio?: string;
}

/** The numbers of a cutting row, as they were for one cut. */
export interface CutValues {
  rpm: number;
  feed: number;
  plunge: number;
  /** mm, whatever the unit. */
  stepover: number;
  /** How the stepover was entered. Absent means mm. */
  stepoverUnit?: "mm" | "percent";
  stepdown: number;
  passes?: number;
}

export interface CutResult {
  /** YYYY-MM-DD. */
  date: string;
  outcome?: "ok" | "provisional" | "failed";
  at?: CutValues;
  text: string;
}

export interface CuttingSettings extends CutValues {
  material: Material;
  /** Key of the toolpath profile the row is tuned for. Absent for the plain row, which any toolpath may use. */
  profile?: string;
  log?: CutResult[];
  ids?: AppIds;
  camFlag?: number;
  camExtra?: string;
  modified?: string;
}

export interface Tool {
  id: string;
  name: string;
  kind: ToolKind;
  diameter: number;
  /** V-bit: diameter of the flat at the tip. Corner-rounding bit: diameter of the tip below the rounded edge. */
  tipDiameter?: number;
  /** Corner-rounding bit only: radius of the rounded edge it cuts. */
  cornerRadius?: number;
  /** V-bit only: included angle. */
  tipAngle?: number;
  fluteLength?: number;
  shankDiameter: number;
  length?: number;
  flutes?: number;
  shoulderLength?: number;
  threadDiameter?: number;
  pitch?: number;
  drillDiameter?: number;
  studioUnknown1?: number;
  /** Where the tool is filed, with "/" between nested groups. */
  group?: string;
  number?: number;
  coating?: string;
  style?: string;
  note?: string;
  /** Longer remarks, of any number of lines: in a tools.yaml, the comment lines above the tool. */
  description?: string;
  recommendedFor?: Material[];
  /** The Makera libraries the tool goes into. Absent means both. */
  apps?: ("cam" | "studio")[];
  fusionType?: "chamfer_mill" | "radius_mill";
  ids?: AppIds;
  source?: { url?: string; invoice?: string; sizeNote?: string };
  inventory?: {
    quantity?: number;
    price?: number;
    currency?: string;
    purchased?: string;
    log?: { date: string; kind: "broken" | "worn"; material?: Material; note?: string }[];
  };
  verify?: { field: string; note?: string }[];
  /** At most one row per material and profile. */
  cutting: CuttingSettings[];
}

export interface MaterialInfo {
  key: Material;
  /** What the material is called. Without one, its name in the Makera apps is shown, or its key. */
  label?: string;
  /** The material whose suggested feeds and speeds this one takes, when the feeds model does not know it by its own key. */
  feedsAs?: Material;
  cam?: { id: string; name: string };
  studio?: { id: string; categoryId: string; name: string; builtin?: boolean; modified?: string }[];
}

/** A kind of toolpath a tool can keep a second row per material for, such as adaptive clearing. */
export interface Profile {
  key: string;
  label: string;
  note?: string;
  level?: "gentle" | "slot_safe" | "standard" | "firm" | "aggressive";
  ramping?: boolean;
  adaptive?: boolean;
  lubricated?: boolean;
  slot?: boolean;
}

export interface Group {
  path: string;
  ids?: AppIds;
}

/** How hard a suggested cut is: the feeds model's five stops. */
export type FeedLevel = "gentle" | "slot_safe" | "standard" | "firm" | "aggressive";

/** What shapes a suggestion besides its stop. */
export interface FeedFlags {
  /** The tool goes down along a ramp, not straight. */
  ramping: boolean;
  /** For adaptive clearing, which this app has no toolpath for. */
  adaptive: boolean;
  /** The cut gets light lubrication. */
  lubricated: boolean;
}

/** Which suggestion is asked of the feeds model. */
export interface FeedOptions extends FeedFlags {
  level: FeedLevel;
}

/** What a cutting row's own numbers come to, and what the feeds model has against them. */
export interface RowCheck {
  /** Whether the model knows the material at all. */
  covered: boolean;
  lubricationMatters: boolean;
  classLabel: string | null;
  /** mm per tooth. */
  chipLoad: number | null;
  /** m/min. */
  surfaceSpeed: number | null;
  /** W, were the row run as a full-width slot; for an adaptive row, at its own stepover. */
  powerW: number | null;
  chipFloor: number | null;
  chipMax: number | null;
  powerCapW: number | null;
  warnings: string[];
}

/** The feeds model's starting point for one tool and material. */
export interface FeedSuggestion {
  /** "none": no values, and `reason` says why. "caution": values, and `reason` says why to distrust them. */
  status: "ok" | "caution" | "none";
  reason: string | null;
  values: { rpm: number; feed: number; plunge: number; stepoverPct: number; stepoverMm: number; stepdown: number } | null;
  /** Which of the values the model stands behind: a drill's are only spindle and plunge. */
  fields: ("rpm" | "feed" | "plunge" | "stepover" | "stepdown")[];
  classLabel: string | null;
  /** mm per tooth. */
  chipLoad: number | null;
  /** m/min. */
  surfaceSpeed: number | null;
  powerW: number | null;
  powerLimitW: number | null;
  spindleW: number;
  notes: string[];
  untested: boolean;
  options: FeedOptions;
}

/** What a row's own values are checked against, outside any stop. */
export interface FeedLimits {
  classLabel: string;
  /** mm per tooth: the band a chip load should stay in at this tool's cutting diameter. */
  chipFloor: number;
  chipMax: number;
  /** The diameter the band is for: a V-bit's is halfway between its tip and its body. */
  cutDiameter?: number;
  energy: number;
  /** The cross-section of a full slot: depth × (width + depth × tan), or round × depth² for a corner rounder. */
  slot: { width: number; tan: number; round: number };
  /** The hardest stop's cap at `rpmMax`; proportionally less below it. */
  powerCapW: number;
  rpmMax: number;
}

/** Everything the feeds model has for one cutting row. */
export interface FeedEntry {
  /** Whether the model knows the material at all. */
  covered: boolean;
  /** The combination to start from, as a key of `combos`: the profile's, or the plain Slot-safe. */
  default: string;
  /** Every stop, with and without a ramped entry, adaptive clearing and (where it matters) lubrication, by keys such as `firm+ramp+adaptive+lube`. */
  combos: Record<string, FeedSuggestion>;
  limits: FeedLimits | null;
  /** Whether lubrication changes anything for this material. */
  lubrication: boolean;
}

/** One thing about one tool that wants looking at. */
export interface Attention {
  toolId: string;
  toolName: string;
  /** Worst first: a failed row, one still to confirm, something to check, no cutting settings, an unknown flute length. */
  kind: "failed" | "provisional" | "verify" | "no_cutting" | "flute_length";
  /** For a row's result: the row. */
  material: Material | null;
  profile: string | null;
  date: string | null;
  text: string | null;
}

/** What a tool library holds besides its tools. */
export interface ToolLists {
  materials?: MaterialInfo[];
  profiles?: Profile[];
  groups?: Group[];
}

/** Everything a tool-library file holds. */
export interface ToolLibrary extends ToolLists {
  tools: Tool[];
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
  /** Cut back the tips of the plug's narrow ridges and corner edges by the glue gap, so that they cannot hold the plug up. */
  relief: boolean;
  /** The highest ridge the V-bit may leave between passes on a flat floor, mm. Absent: 0.1. */
  floorRidge?: number;
  /** How far below the finished face a relief cut stays, mm. Absent: 0.5. */
  reliefKeep?: number;
  /** How far below the surface the fit check judges the finished face, mm. Absent: 0.1. */
  trimDepth?: number;
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

/** Which side of the shapes' outlines a tool runs on. */
export type Side = "outside" | "inside" | "on";

/** The shapes cleared to a flat floor. */
/** The shape of the path a tool clears an area along: rings that follow its outline, or straight passes side to side. */
export type Pattern = "offset" | "raster";
/** Which way side-to-side passes run: along the longer side of the area, along X (left and right) or along Y (to and from the front). */
export type PassDirection = "longer" | "x" | "y";

export interface PocketOp {
  type: "pocket";
  depth: number;
  pattern: Pattern;
  /** Which way side-to-side passes run, in each shape. Absent: along its longer side. */
  direction?: PassDirection;
  /** End mills, in the order they are used. */
  clearingToolIds: string[];
}

/** An area milled flat: the whole stock when the job has no shapes, else the rectangle around the shapes grown by the margin. */
export interface FacingOp {
  type: "facing";
  /** Wood standing above the stock's surface that is milled away first, such as a plug's backer. */
  above: number;
  /** How far below the stock's surface the area ends up. */
  depth: number;
  /** How far beyond the rectangle around the chosen shapes the area reaches. */
  margin: number;
  pattern: Pattern;
  /** Which way side-to-side passes run. Absent: along the longer side of the area. */
  direction?: PassDirection;
  toolId: string | null;
}

/** A cut along the outlines of the shapes. */
export interface ContourOp {
  type: "contour";
  side: Side;
  /** How deep the cut goes; null for right through the stock. */
  depth: number | null;
  tabs: boolean;
  toolId: string | null;
}

/** The top edge along the outlines of the shapes, bevelled with a V-bit or rounded over with a corner-rounding bit. */
export interface ChamferOp {
  type: "chamfer";
  /** Where the wood has been cut away. */
  side: "outside" | "inside";
  /** Width of the bevel, seen from above. A corner-rounding bit cuts its own radius instead. */
  width: number;
  /** How far beyond its tip flat a V-bit's axis is kept from the edge, so that the tip runs in the air. Absent: 0.2 mm. Not used with a corner-rounding bit. */
  tipClearance?: number;
  /** The V-bit or corner-rounding bit. */
  toolId: string | null;
}

/** An inlay proper: a pocket in the stock and the plug or insert that fills it. */
export type TrueInlay = VcarveInlay | FlatInlay;
/** A plain operation on the stock: one file, no second part. */
export type Operation = PocketOp | FacingOp | ContourOp | ChamferOp;
/** What a job cuts. The name is from when the app made inlays only. */
export type Inlay = TrueInlay | Operation;
export type JobType = Inlay["type"];

export interface Job {
  id: string;
  name: string;
  material: Material;
  regionIds: number[];
  /** The colour of the inlay's wood in the app's pictures, as #rrggbb. */
  color?: string;
  /** Clearances and tabs for this inlay's files. An inlay from an older file has none and uses the project's. */
  setup?: Setup;
  /** The end mill that cuts a plug out of its board. Without one, the largest of the inlay's end mills that reaches through. */
  cutOutToolId?: string;
  /** By tool id: the toolpath profile whose cutting row the tool runs in this job. A tool without an entry runs its plain row. */
  rowProfiles?: Record<string, string>;
  inlay: Inlay;
}

/** The machine the files are for: the limits they are checked against. */
export interface Machine {
  name: string;
  /** Lowest spindle speed the feeds model suggests, rpm. */
  minRpm: number;
  /** Top spindle speed, rpm. The feeds model runs woods and plastics at it. */
  maxRpm: number;
  /** Rapid speed, mm/min, for time estimates. */
  rapidRate: number;
  /** How far the tool can move in X and Y. */
  travel: [number, number];
  /** Number of the first tool in a file. */
  firstTool: number;
  /** Time one tool change takes, seconds, for the time estimates. 0 or absent leaves tool changes out of them. */
  toolChangeSeconds?: number;
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
  /** How steeply an end mill goes down into wood along its path, in degrees from level. 0 plunges straight down. */
  rampAngle: number;
  /** Wood left on walls while clearing or cutting out, and taken off in one light pass at the end. 0 leaves none. */
  finishAllowance: number;
}

export interface Project {
  id: string;
  name: string;
  design: Design | null;
  jobs: Job[];
  /** Copies of the tools the jobs use. */
  tools: Tool[];
  /** Copies of the toolpath profiles the jobs' row choices name. */
  profiles?: Profile[];
  /** The stock: the board the pockets and other operations are cut into. Its outline is the design's page. */
  base: { thickness: number; color?: string };
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

/** A whole tools.yaml. The tools' ids are empty; the caller assigns them. */
export interface ToolsYamlImport extends ToolLibrary {
  /** Tools the app cannot hold as written, and why. */
  skipped: { name: string; reason: string }[];
  /** Comment lines that were directly above a tool and are now in its note. */
  commentsMoved: number;
  /** Comment lines that were not kept. */
  commentsDropped: number;
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
  /** What the tool changes add, minutes, by the machine's time for one. 0 when it gives none. */
  toolChangeMinutes: number;
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
    /** The parts follow the drawing: what is left out and added is too little to say. */
    asDrawn: boolean;
    /** The insert overlaps the base board: it will not go in. */
    interferes: boolean;
  } | null;
  /** A plug cut out of a larger board: the plug on that board, as x0 y0 x1 y1. */
  piece: [number, number, number, number] | null;
  /** Width of the cut that frees that plug. */
  cutWidth: number | null;
  /** The extent of the shapes on the part's board, as x0 y0 x1 y1. */
  shapes: [number, number, number, number] | null;
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
  /** What the report's numbers come to, as the core judges them. */
  verdict: {
    seat: "seated" | "pressed" | "no";
    gaps: "none" | "hairlines" | "visible";
    /** The plug rests at its designed depth. */
    atDepth: boolean;
    /** Nothing is in the way of pressing the plug to its designed depth. */
    clear: boolean;
    /** Seated, with hairlines at most. */
    good: boolean;
  };
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

/** A tool list written for Makera CAM or Makera Studio. */
export interface MakeraExport {
  /** The file, byte by byte. */
  bytes: number[];
  warnings: string[];
  tools: number;
  settings: number;
  materials: number;
}

/** A tool list written for Fusion 360: one library with every tool, and the same as one per top-level group. */
export interface FusionExport {
  library: string;
  sections: { name: string; text: string }[];
  warnings: string[];
  tools: number;
  presets: number;
}

/** One difference between an app's export and the tool list, to be taken or left. */
export interface MakeraImportChange {
  id: string;
  /** A size of the tool, a value of a cutting row it has, or a row for a material it has none for. */
  kind: "geometry" | "cutting" | "new";
  key: string | null;
  material: string | null;
  materialLabel: string | null;
  label: string;
  unit: string | null;
  from: number | null;
  to: number | null;
  /** For a new row: its values in words. */
  values: string | null;
  /** Ticked to begin with. */
  selected: boolean;
  note: string | null;
  patch: unknown;
}

/** An export of Makera CAM or Makera Studio held against the tool list. */
export interface MakeraImportPlan {
  format: "cam" | "studio";
  label: string;
  exportTools: number;
  matched: number;
  matchedByName: number;
  tools: { toolId: string; name: string; group: string; byName: boolean; notes: string[]; kept: string[]; changes: MakeraImportChange[] }[];
  unchanged: { name: string; group: string; kept: string[] }[];
  notImported: { record: string; reason: string }[];
  notImportedMore: number;
}
