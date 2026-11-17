// App state: the open project, the tool list, and what is selected.
// Changes are saved to browser storage automatically.

import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from "react";
import { core } from "../core/client";
import type { Design, FitCheck, ImportReport, Job, Machine, Part, PocketPreview, Project, Setup, StockTimeline, Tool, ToolLists } from "../core/types";
import * as db from "../storage/db";
import { DEFAULT_DRAW_OPTIONS, type DrawOptions, type DrawTool } from "./shapes";
import { DEFAULT_MACHINE, DEFAULT_SETUP, addDrawing, isInlay, newProject, normaliseDesign, profileSnapshots, readMachine, readSetup, regionOwners, toolSnapshots, withoutOrphans } from "./model";

export type View = "design" | "settings";
/** The pages of the settings view. */
export type SettingsPage = "tools" | "materials" | "profiles" | "machine" | "defaults";
/** What the large area beside the panel shows. */
export type Stage = "drawing" | "pocket" | "plug" | "fit" | "timeline";
export type Notice = { kind: "info" | "error"; text: string };

export interface AppState {
  /** False until stored data has been loaded. */
  ready: boolean;
  tools: Tool[];
  /** The materials, profiles and groups the tools refer to. Kept with the tools. */
  lists: ToolLists;
  /** The machine the files are for. Like the tools, it is kept in this browser and copied into the open project. */
  machine: Machine;
  /** The clearances and tabs a new inlay starts with. Kept in this browser. */
  defaults: Setup;
  project: Project;
  projects: db.ProjectSummary[];
  view: View;
  settingsPage: SettingsPage;
  /** Regions picked for a new inlay. */
  selection: number[];
  /** The inlay being edited; region clicks then add to or remove from it. */
  activeJobId: string | null;
  importReport: ImportReport | null;
  notice: Notice | null;
  saveError: string | null;
  /** The last generated output. Not saved: it is rebuilt on demand. */
  output: Output | null;
  /** The stock as it was last taken through the list, step by step, with the files that cut it. Not saved. */
  timeline: Timeline | null;
  /** The point of the list the stock is shown at: 0 for the fresh stock, n for the stock after the nth entry. */
  timelineAt: number;
  stage: Stage;
  /** The drawing is being edited (the screens' "Edit"): shapes are drawn, and clicks select shapes to move, resize or delete. */
  arranging: boolean;
  /** While arranging, the shape a drag on the stock draws. Without one, a drag selects and moves. */
  drawTool: DrawTool | null;
  /** What the drawing tools take besides the drag: corner radius, sides. */
  drawOptions: DrawOptions;
  /** Projects as they were before each change to the drawing, oldest first. */
  undo: Project[];
  /** Projects as they were before each undo, oldest first. */
  redo: Project[];
  /** The kind and time of the last change to the drawing, to fold a run of small ones into one undo step. */
  lastEdit: { tag: string; at: number } | null;
}

/** Everything generated for one inlay in one go: both files and their fit. */
export interface Output {
  jobId: string;
  /** The project exactly as it was when this was generated, to tell when it is out of date. */
  project: Project;
  /** The parts that could be built. */
  parts: Partial<Record<Part, PocketPreview>>;
  /** Reasons a part could not be built. */
  errors: string[];
  /** V-carve inlays: how the simulated plug sits in the simulated pocket. */
  fit: FitCheck | null;
  fitErrors: string[];
}

/** The stock taken through the whole list. */
export interface Timeline {
  /** The project exactly as it was when this was worked out. */
  project: Project;
  result: StockTimeline | null;
  errors: string[];
}

export type Action =
  | { type: "loaded"; tools: Tool[]; lists: ToolLists; machine: Machine; defaults: Setup; project: Project; projects: db.ProjectSummary[] }
  | { type: "openProject"; project: Project; importReport?: ImportReport | null }
  | { type: "updateProject"; update: (project: Project) => Project }
  | { type: "updateJob"; id: string; update: (job: Job) => Job }
  | { type: "setTools"; tools: Tool[]; lists?: ToolLists }
  | { type: "setMachine"; machine: Machine }
  | { type: "setDefaults"; defaults: Setup }
  | { type: "setProjects"; projects: db.ProjectSummary[] }
  | { type: "setView"; view: View; page?: SettingsPage }
  | { type: "clickRegion"; id: number; add?: boolean }
  | { type: "setSelection"; ids: number[] }
  | { type: "setActiveJob"; id: string | null }
  | { type: "setImportReport"; report: ImportReport | null }
  | { type: "notice"; notice: Notice | null }
  | { type: "saveResult"; error: string | null }
  | { type: "setOutput"; output: Output | null }
  | { type: "setStage"; stage: Stage }
  | { type: "setTimeline"; timeline: Timeline | null }
  | { type: "setTimelineAt"; at: number }
  /** Brings in a drawing: onto the stock beside what is there, or in place of it. */
  | { type: "addDrawing"; design: Design; replace: boolean }
  | { type: "setArranging"; on: boolean }
  | { type: "setDrawTool"; tool: DrawTool | null }
  | { type: "setDrawOptions"; options: DrawOptions }
  | { type: "editDrawing"; update: (project: Project) => Project; tag?: string; at?: number; select?: number[] }
  | { type: "undoDrawing" }
  | { type: "redoDrawing" };

const initial: AppState = {
  ready: false,
  tools: [],
  lists: {},
  machine: DEFAULT_MACHINE,
  defaults: DEFAULT_SETUP,
  project: newProject(),
  projects: [],
  view: "design",
  settingsPage: "tools",
  selection: [],
  activeJobId: null,
  importReport: null,
  notice: null,
  saveError: null,
  output: null,
  timeline: null,
  timelineAt: 0,
  stage: "drawing",
  arranging: false,
  drawTool: null,
  drawOptions: DEFAULT_DRAW_OPTIONS,
  undo: [],
  redo: [],
  lastEdit: null,
};

/** Keeps the project's copies of the tools and the machine in step with its jobs, the tool list and the machine. */
function withSnapshots(state: AppState): AppState {
  // A glue-up goes with its inlay, however the inlay went: deleted, or taken along by a shape or an undo.
  const jobs = withoutOrphans(state.project.jobs);
  if (jobs !== state.project.jobs) state = { ...state, project: { ...state.project, jobs } };
  const tools = toolSnapshots(state.project, state.tools);
  const profiles = profileSnapshots(state.project, state.lists);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (same(tools, state.project.tools) && same(profiles, state.project.profiles ?? []) && same(state.machine, state.project.machine)) return state;
  return { ...state, project: { ...state.project, tools, profiles: profiles.length > 0 ? profiles : undefined, machine: state.machine } };
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "loaded":
      return withSnapshots({
        ...state,
        ready: true,
        tools: action.tools,
        lists: action.lists,
        machine: action.machine,
        defaults: action.defaults,
        project: normalised(action.project),
        projects: action.projects,
      });
    case "openProject":
      return withSnapshots({
        ...state,
        project: normalised(action.project),
        selection: [],
        activeJobId: null,
        importReport: action.importReport ?? null,
        output: null,
        timeline: null,
        timelineAt: 0,
        stage: "drawing",
        view: "design",
        arranging: false,
        drawTool: null,
        undo: [],
        redo: [],
        lastEdit: null,
      });
    case "updateProject":
      return withSnapshots({ ...state, project: action.update(state.project) });
    case "updateJob":
      return withSnapshots({
        ...state,
        project: { ...state.project, jobs: state.project.jobs.map((j) => (j.id === action.id ? action.update(j) : j)) },
      });
    case "setTools":
      return withSnapshots({ ...state, tools: action.tools, lists: action.lists ?? state.lists });
    case "setMachine":
      return withSnapshots({ ...state, machine: action.machine });
    case "setDefaults":
      return { ...state, defaults: action.defaults };
    case "setProjects":
      return { ...state, projects: action.projects };
    case "setView":
      return { ...state, view: action.view, settingsPage: action.page ?? state.settingsPage };
    case "clickRegion":
      return clickRegion(state, action.id, action.add ?? false);
    case "setSelection":
      return { ...state, selection: action.ids };
    case "setActiveJob":
      return { ...state, activeJobId: action.id, selection: [], stage: "drawing" };
    case "setImportReport":
      return { ...state, importReport: action.report };
    case "notice":
      return { ...state, notice: action.notice };
    case "saveResult":
      return { ...state, saveError: action.error };
    case "setOutput":
      return { ...state, output: action.output };
    case "setStage":
      return { ...state, stage: action.stage };
    case "setTimeline":
      return { ...state, timeline: action.timeline, timelineAt: Math.min(state.timelineAt, action.timeline?.result?.steps.length ?? 0) };
    case "setTimelineAt":
      return { ...state, timelineAt: Math.max(0, Math.min(action.at, state.timeline?.result?.steps.length ?? 0)) };
    case "addDrawing": {
      const current = state.project.design;
      if (!current || action.replace) {
        return withSnapshots({
          ...state,
          project: { ...state.project, design: normaliseDesign(action.design), jobs: action.replace ? [] : state.project.jobs },
          selection: [],
          activeJobId: null,
          output: null,
          timeline: null,
          timelineAt: 0,
          stage: "drawing",
          view: "design",
          arranging: false,
          drawTool: null,
          undo: [],
          redo: [],
          lastEdit: null,
        });
      }
      // The new shapes come in selected, ready to be moved to their place.
      const { design, ids } = addDrawing(current, action.design);
      return withSnapshots({
        ...state,
        project: { ...state.project, design },
        undo: [...state.undo.slice(-49), state.project],
        redo: [],
        lastEdit: null,
        selection: ids,
        activeJobId: null,
        stage: "drawing",
        view: "design",
        arranging: true,
        drawTool: null,
      });
    }
    case "setArranging":
      return { ...state, arranging: action.on, drawTool: null, selection: [], activeJobId: null, stage: "drawing", lastEdit: null };
    case "setDrawTool":
      // A drawing tool starts with nothing selected: the selection's frame would be in its way.
      return { ...state, drawTool: action.tool, selection: action.tool ? [] : state.selection, lastEdit: null };
    case "setDrawOptions":
      return { ...state, drawOptions: action.options };
    case "editDrawing": {
      const project = action.update(state.project);
      if (project === state.project) return state;
      const at = action.at ?? 0;
      // A run of the same small change, such as nudging with the arrow keys, is one step to undo.
      const folds =
        action.tag !== undefined && state.lastEdit?.tag === action.tag && at - state.lastEdit.at < 1000 && state.undo.length > 0;
      const left = new Set(project.design?.regions.map((r) => r.id));
      return withSnapshots({
        ...state,
        project,
        undo: folds ? state.undo : [...state.undo.slice(-49), state.project],
        redo: [],
        lastEdit: action.tag !== undefined ? { tag: action.tag, at } : null,
        selection: (action.select ?? state.selection).filter((id) => left.has(id)),
      });
    }
    case "undoDrawing":
    case "redoDrawing": {
      const [from, to] = action.type === "undoDrawing" ? [state.undo, state.redo] : [state.redo, state.undo];
      const other = from[from.length - 1];
      if (!other) return state;
      const rest = from.slice(0, -1);
      const kept = [...to, state.project];
      return withSnapshots({
        ...state,
        // The drawing goes back, and with it the inlays a deleted shape took along. What was done to inlays since stays:
        // an inlay keeps its present settings, and one made since is kept where its shapes are still in the drawing.
        project: {
          ...state.project,
          design: other.design,
          jobs: [
            ...other.jobs.map((old) => {
              const now = state.project.jobs.find((j) => j.id === old.id);
              return now ? { ...now, regionIds: old.regionIds } : old;
            }),
            ...state.project.jobs.filter((j) => !other.jobs.some((old) => old.id === j.id) && j.regionIds.every((id) => other.design?.regions.some((r) => r.id === id))),
          ],
        },
        undo: action.type === "undoDrawing" ? rest : kept,
        redo: action.type === "undoDrawing" ? kept : rest,
        lastEdit: null,
        activeJobId: state.activeJobId,
        selection: state.selection.filter((id) => other.design?.regions.some((r) => r.id === id)),
      });
    }
  }
}

/** The project with the drawing's scale and mirroring worked into its shapes. */
function normalised(project: Project): Project {
  if (!project.design) return project;
  const design = normaliseDesign(project.design);
  return design === project.design ? project : { ...project, design };
}

function clickRegion(state: AppState, id: number, add: boolean): AppState {
  if (state.arranging && state.project.design) {
    // One outline is picked, without what lies inside it.
    if (!add) return { ...state, selection: [id] };
    return { ...state, selection: state.selection.includes(id) ? state.selection.filter((r) => r !== id) : [...state.selection, id] };
  }
  const owner = regionOwners(state.project.jobs).get(id);
  const active = state.project.jobs.find((j) => j.id === state.activeJobId);

  // A step done by hand has no shapes of its own.
  if (active?.inlay.type === "glue") return state;
  if (active) {
    // A shape is one wood, so one inlay; a plain operation takes any shape.
    if (isInlay(active.inlay) && owner && owner.id !== active.id) {
      return { ...state, notice: { kind: "info", text: `That shape already belongs to "${owner.name}".` } };
    }
    const regionIds = active.regionIds.includes(id) ? active.regionIds.filter((r) => r !== id) : [...active.regionIds, id];
    return reducer(state, { type: "updateJob", id: active.id, update: (job) => ({ ...job, regionIds }) });
  }
  // A shape that already has an inlay opens that inlay; with Shift it is selected, for an operation.
  if (owner && !add) return { ...state, activeJobId: owner.id, selection: [], stage: "drawing" };
  const selection = state.selection.includes(id) ? state.selection.filter((r) => r !== id) : [...state.selection, id];
  return { ...state, selection };
}

const StateContext = createContext<AppState>(initial);
const DispatchContext = createContext<Dispatch<Action>>(() => {});

export function useApp(): AppState {
  return useContext(StateContext);
}

export function useDispatch(): Dispatch<Action> {
  return useContext(DispatchContext);
}

/** Loads a project from browser storage, upgrading it if an older version of the app wrote it. */
export async function loadStoredProject(id: string): Promise<Project> {
  const stored = await db.getProject(id);
  if (!stored) throw new Error("That project is no longer in browser storage.");
  return core.call("projectFromFile", stored.text);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);

  // Load stored tools and the last open project once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let tools: Tool[] = [];
      let lists: ToolLists = {};
      let project = newProject();
      let problem: string | null = null;
      try {
        const toolsText = await db.getSetting("tools");
        if (toolsText) ({ tools, ...lists } = await core.call("libraryFromFile", toolsText));
      } catch (e) {
        problem = `Your stored tool list could not be read: ${message(e)}`;
      }
      try {
        const last = await db.getSetting("lastProjectId");
        if (last) project = await loadStoredProject(last);
      } catch (e) {
        problem ??= `The last project could not be reopened: ${message(e)}`;
      }
      const projects = await db.listProjects().catch(() => []);
      const machine = readMachine(await db.getSetting("machine").catch(() => undefined));
      const defaults = readSetup(await db.getSetting("inlayDefaults").catch(() => undefined));
      if (cancelled) return;
      dispatch({ type: "loaded", tools, lists, machine, defaults, project, projects });
      if (problem) dispatch({ type: "notice", notice: { kind: "error", text: problem } });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Save the project shortly after every change. Saves run one at a time, in
  // order, so an older save can never overwrite a newer one.
  const saving = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!state.ready) return;
    const project = state.project;
    const timer = setTimeout(() => {
      saving.current = saving.current.then(async () => {
        try {
          const text = await core.call("projectToFile", project);
          const stored = await db.getProject(project.id);
          // A blank project that was never stored is not worth keeping, and
          // opening a project must not change its "last modified" time.
          const blank = !stored && project.design === null && project.jobs.length === 0;
          if (!blank && stored?.text !== text) {
            await db.putProject({ id: project.id, name: project.name, modified: Date.now(), text });
            dispatch({ type: "setProjects", projects: await db.listProjects() });
          }
          if (!blank) await db.putSetting("lastProjectId", project.id);
          dispatch({ type: "saveResult", error: null });
        } catch (e) {
          dispatch({ type: "saveResult", error: message(e) });
        }
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [state.ready, state.project]);

  useEffect(() => {
    if (!state.ready) return;
    const library = { ...state.lists, tools: state.tools };
    (async () => {
      try {
        await db.putSetting("tools", await core.call("libraryToFile", library));
      } catch (e) {
        dispatch({ type: "notice", notice: { kind: "error", text: `The tool list could not be saved: ${message(e)}` } });
      }
    })();
  }, [state.ready, state.tools, state.lists]);

  useEffect(() => {
    if (!state.ready) return;
    db.putSetting("machine", JSON.stringify(state.machine)).catch((e) =>
      dispatch({ type: "notice", notice: { kind: "error", text: `The machine could not be saved: ${message(e)}` } }),
    );
  }, [state.ready, state.machine]);

  useEffect(() => {
    if (!state.ready) return;
    db.putSetting("inlayDefaults", JSON.stringify(state.defaults)).catch((e) =>
      dispatch({ type: "notice", notice: { kind: "error", text: `The inlay defaults could not be saved: ${message(e)}` } }),
    );
  }, [state.ready, state.defaults]);

  const value = useMemo(() => state, [state]);
  return (
    <StateContext.Provider value={value}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
