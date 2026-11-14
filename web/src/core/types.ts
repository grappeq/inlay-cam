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
