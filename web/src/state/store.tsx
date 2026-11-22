// App state: the open project, the tool list, and what is selected.
// Changes are saved automatically: to browser storage, or to the server when
// the app is served by one (storage/home.ts).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
} from "react";
import { core } from "../core/client";
import type {
  Design,
  FitCheck,
  ImportReport,
  MakeraImportPlan,
  Step,
  Machine,
  Part,
  PocketPreview,
  Project,
  Setup,
  StockTimeline,
  Tool,
  ToolLists,
} from "../core/types";
import * as db from "../storage/home";
import { loadView } from "../storage/view";
import * as server from "../storage/server";
import { startOf, started } from "./folders";
import { pickable } from "./layers";
import {
  DEFAULT_DRAW_OPTIONS,
  type DrawOptions,
  type DrawTool,
} from "./shapes";
import { bindHost } from "../agent/host";
import { mergeLibraries } from "./merge";
import {
  DEFAULT_MACHINE,
  DEFAULT_SETUP,
  addDrawing,
  isByHand,
  isInlay,
  newProject,
  normaliseDesign,
  profileSnapshots,
  readMachine,
  readSetup,
  regionOwners,
  relinkTools,
  toolNumbers,
  toolSnapshots,
  withoutOrphans,
} from "./model";

/** What the page shows: the list of projects, the open one, or what all projects share. */
export type View = "projects" | "design" | "settings";
/** The pages of the settings view. */
export type SettingsPage =
  "tools" | "materials" | "profiles" | "machine" | "defaults" | "agent";
/** What the large area beside the panel shows. */
export type Stage = "drawing" | "pocket" | "plug" | "fit" | "timeline";
/** What the panel shows while no inlay or operation is open: the list to work on, its tools, or what of it to export. */
export type PanelPage = "list" | "tools" | "export";
export type Notice = { kind: "info" | "error"; text: string };
/** The open project as it was saved from somewhere else, over what this page last read or wrote. */
export interface ProjectConflict {
  id: string;
  /** The project file as it is kept now. */
  text: string;
  token?: string;
}

export interface AppState {
  /** False until stored data has been loaded. */
  ready: boolean;
  tools: Tool[];
  /** The materials, profiles and groups the tools refer to. Kept with the tools. */
  lists: ToolLists;
  /** Where everything is kept: in this browser, or on the server the app came from, shared by everyone who opens it. Never some of it in one and some in the other. */
  home: db.Home;
  /** The machine the files are for. Like the tools, it is copied into the open project. */
  machine: Machine;
  /** The clearances and tabs a new inlay starts with. */
  defaults: Setup;
  project: Project;
  projects: db.ProjectSummary[];
  /** The folders projects are filed in, each with `/` between nested ones, a folder before the ones in it. Empty ones too. */
  folders: string[];
  view: View;
  settingsPage: SettingsPage;
  /** Regions picked for a new inlay. */
  selection: number[];
  /** The inlay being edited; region clicks then add to or remove from it. */
  activeStepId: string | null;
  importReport: ImportReport | null;
  /** The file the drawing was last brought in from, when that set or replaced the drawing: to bring it in again with gaps joined. */
  importAgain: {
    file: { name: string; text: string; bytes?: Uint8Array };
    replace: boolean;
  } | null;
  /** A Makera export being taken values from, picked or dropped: the dialog shows while it is set. */
  makeraImport: { plan: MakeraImportPlan; fileName: string } | null;
  notice: Notice | null;
  saveError: string | null;
  /** The open project was saved from another window or browser while it was changed here too. Until it is settled, it is not saved. */
  projectConflict: ProjectConflict | null;
  /** Counts the times the server came back after it was out of reach, so that what waits is saved again. */
  reconnects: number;
  /** The last generated output. Not saved: it is rebuilt on demand. */
  output: Output | null;
  /** The stock as it was last taken through the list, step by step, with the files that cut it. Not saved. */
  timeline: Timeline | null;
  /** The point of the list the stock is shown at: 0 for the fresh stock, n for the stock after the nth entry. */
  timelineAt: number;
  stage: Stage;
  panelPage: PanelPage;
  /** The drawing is being edited (the screens' "Edit"): shapes are drawn, and clicks select shapes to move, resize or delete. */
  arranging: boolean;
  /** While arranging, the shape a drag on the stock draws. Without one, a drag selects and moves. */
  drawTool: DrawTool | null;
  /** What the drawing tools take besides the drag: corner radius, sides. */
  drawOptions: DrawOptions;
  /** The id of the layer that newly drawn shapes go on. Without one, or when it is gone, the top layer. */
  activeLayer: number | null;
  /** Projects as they were before each change to the drawing, oldest first. */
  undo: Project[];
  /** Projects as they were before each undo, oldest first. */
  redo: Project[];
  /** The kind and time of the last change to the drawing, to fold a run of small ones into one undo step. */
  lastEdit: { tag: string; at: number } | null;
}

/** Everything generated for one inlay in one go: both files and their fit. */
export interface Output {
  stepId: string;
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
  | {
      type: "loaded";
      tools: Tool[];
      lists: ToolLists;
      home: db.Home;
      machine: Machine;
      defaults: Setup;
      project: Project;
      projects: db.ProjectSummary[];
      folders: string[];
    }
  | {
      type: "openProject";
      project: Project;
      importReport?: ImportReport | null;
    }
  | { type: "updateProject"; update: (project: Project) => Project }
  | { type: "updateStep"; id: string; update: (step: Step) => Step }
  | { type: "setTools"; tools: Tool[]; lists?: ToolLists }
  | { type: "setMachine"; machine: Machine }
  | { type: "setDefaults"; defaults: Setup }
  | { type: "setProjects"; projects: db.ProjectSummary[]; folders: string[] }
  | { type: "setView"; view: View; page?: SettingsPage }
  | { type: "clickRegion"; id: number; add?: boolean }
  | { type: "setSelection"; ids: number[] }
  | { type: "setActiveStep"; id: string | null }
  | {
      type: "setImportReport";
      report: ImportReport | null;
      again?: AppState["importAgain"];
    }
  | { type: "setMakeraImport"; incoming: AppState["makeraImport"] }
  | { type: "notice"; notice: Notice | null }
  | { type: "saveResult"; error: string | null }
  | { type: "projectConflict"; conflict: ProjectConflict | null }
  | { type: "reconnected" }
  | { type: "setOutput"; output: Output | null }
  | { type: "setStage"; stage: Stage }
  | { type: "setTimeline"; timeline: Timeline | null }
  /** Shows the stock at a point of the list. With `open`, the panel turns to the entry it is shown after, or to the list for the fresh stock. */
  | { type: "setTimelineAt"; at: number; open?: boolean }
  | { type: "setPanelPage"; page: PanelPage }
  /** Brings in a drawing: onto the stock beside what is there, or in place of it. */
  | { type: "addDrawing"; design: Design; replace: boolean }
  | { type: "setArranging"; on: boolean }
  | { type: "setDrawTool"; tool: DrawTool | null }
  | { type: "setDrawOptions"; options: DrawOptions }
  /** Changes the drawing, as one step to undo. `select` are the shapes selected afterwards; `layer` becomes the active layer. */
  | {
      type: "editDrawing";
      update: (project: Project) => Project;
      tag?: string;
      at?: number;
      select?: number[];
      layer?: number;
    }
  | { type: "setActiveLayer"; id: number }
  | { type: "undoDrawing" }
  | { type: "redoDrawing" };

const initial: AppState = {
  ready: false,
  tools: [],
  lists: {},
  home: "browser",
  machine: DEFAULT_MACHINE,
  defaults: DEFAULT_SETUP,
  project: newProject(),
  projects: [],
  folders: [],
  view: "design",
  settingsPage: "tools",
  selection: [],
  activeStepId: null,
  importReport: null,
  importAgain: null,
  makeraImport: null,
  notice: null,
  saveError: null,
  projectConflict: null,
  reconnects: 0,
  output: null,
  timeline: null,
  timelineAt: 0,
  stage: "drawing",
  panelPage: "list",
  arranging: false,
  drawTool: null,
  drawOptions: DEFAULT_DRAW_OPTIONS,
  activeLayer: null,
  undo: [],
  redo: [],
  lastEdit: null,
};

/** Keeps the project's copies of the tools and the machine in step with its steps, the tool list and the machine. */
function withSnapshots(state: AppState): AppState {
  // A glue-up goes with its inlay, however the inlay went: deleted, or taken along by a shape or an undo.
  const steps = withoutOrphans(state.project.steps);
  if (steps !== state.project.steps)
    state = { ...state, project: { ...state.project, steps } };
  // Every tool a step uses has a number, and keeps it.
  const numbers = toolNumbers(
    state.project,
    state.tools,
    state.machine.firstTool,
  );
  const tools = toolSnapshots(
    { ...state.project, toolNumbers: numbers },
    state.tools,
  );
  const profiles = profileSnapshots(state.project, state.lists);
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  if (
    numbers === state.project.toolNumbers &&
    same(tools, state.project.tools) &&
    same(profiles, state.project.profiles ?? []) &&
    same(state.machine, state.project.machine)
  )
    return state;
  return {
    ...state,
    project: {
      ...state.project,
      tools,
      toolNumbers: numbers,
      profiles: profiles.length > 0 ? profiles : undefined,
      machine: state.machine,
    },
  };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "loaded":
      return withSnapshots({
        ...state,
        ready: true,
        tools: action.tools,
        lists: action.lists,
        home: action.home,
        machine: action.machine,
        defaults: action.defaults,
        project: relinkTools(normalised(action.project), action.tools),
        projects: action.projects,
        folders: action.folders,
      });
    case "openProject":
      return withSnapshots({
        ...state,
        project: relinkTools(normalised(action.project), state.tools),
        selection: [],
        activeStepId: null,
        importReport: action.importReport ?? null,
        importAgain: null,
        panelPage: "list",
        output: null,
        timeline: null,
        timelineAt: 0,
        stage: "drawing",
        view: "design",
        arranging: false,
        drawTool: null,
        activeLayer: null,
        undo: [],
        redo: [],
        lastEdit: null,
      });
    case "updateProject":
      return withSnapshots({ ...state, project: action.update(state.project) });
    case "updateStep":
      return withSnapshots({
        ...state,
        project: {
          ...state.project,
          steps: state.project.steps.map((j) =>
            j.id === action.id ? action.update(j) : j,
          ),
        },
      });
    case "setTools":
      // A tool that comes into the list may be one the project carries a copy of under another id.
      return withSnapshots({
        ...state,
        tools: action.tools,
        lists: action.lists ?? state.lists,
        project: relinkTools(state.project, action.tools),
      });
    case "setMachine":
      return withSnapshots({ ...state, machine: action.machine });
    case "setDefaults":
      return { ...state, defaults: action.defaults };
    case "setProjects":
      return { ...state, projects: action.projects, folders: action.folders };
    case "setView":
      return {
        ...state,
        view: action.view,
        settingsPage: action.page ?? state.settingsPage,
      };
    case "clickRegion":
      return clickRegion(state, action.id, action.add ?? false);
    case "setSelection": {
      // Shapes on a hidden layer are not picked, nor those on a locked one while the drawing is edited.
      const can = state.project.design
        ? pickable(state.project.design, state.arranging)
        : () => true;
      return { ...state, selection: action.ids.filter(can) };
    }
    case "setActiveLayer":
      return { ...state, activeLayer: action.id };
    case "setActiveStep":
      // Going back to the list from the stock step by step leaves the stock on the stage.
      return {
        ...state,
        activeStepId: action.id,
        selection: [],
        stage:
          action.id === null && state.stage === "timeline"
            ? "timeline"
            : "drawing",
      };
    case "setImportReport":
      return {
        ...state,
        importReport: action.report,
        importAgain: action.again ?? null,
      };
    case "setMakeraImport":
      return { ...state, makeraImport: action.incoming };
    case "notice":
      return { ...state, notice: action.notice };
    case "saveResult":
      return { ...state, saveError: action.error };
    case "projectConflict":
      return { ...state, projectConflict: action.conflict };
    case "reconnected":
      return { ...state, reconnects: state.reconnects + 1 };
    case "setOutput":
      return { ...state, output: action.output };
    case "setStage":
      return { ...state, stage: action.stage };
    case "setTimeline":
      return {
        ...state,
        timeline: action.timeline,
        timelineAt: Math.min(
          state.timelineAt,
          action.timeline?.result?.steps.length ?? 0,
        ),
      };
    case "setPanelPage":
      return { ...state, panelPage: action.page };
    case "setTimelineAt": {
      const at = Math.max(
        0,
        Math.min(action.at, state.timeline?.result?.steps.length ?? 0),
      );
      if (!action.open) return { ...state, timelineAt: at };
      // The entry as the project has it now; one that is gone since leaves the list.
      const id =
        at > 0 ? state.timeline?.result?.steps[at - 1]?.stepId : undefined;
      const step = state.project.steps.find((j) => j.id === id);
      return {
        ...state,
        timelineAt: at,
        activeStepId: step?.id ?? null,
        selection: [],
      };
    }
    case "addDrawing": {
      const current = state.project.design;
      if (!current || action.replace) {
        return withSnapshots({
          ...state,
          project: {
            ...state.project,
            design: normaliseDesign(action.design),
            steps: action.replace ? [] : state.project.steps,
          },
          selection: [],
          activeStepId: null,
          output: null,
          timeline: null,
          timelineAt: 0,
          stage: "drawing",
          view: "design",
          arranging: false,
          drawTool: null,
          activeLayer: null,
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
        activeStepId: null,
        stage: "drawing",
        view: "design",
        arranging: true,
        drawTool: null,
      });
    }
    case "setArranging":
      return {
        ...state,
        arranging: action.on,
        drawTool: null,
        selection: [],
        activeStepId: null,
        stage: "drawing",
        lastEdit: null,
      };
    case "setDrawTool":
      // A drawing tool starts with nothing selected: the selection's frame would be in its way.
      return {
        ...state,
        drawTool: action.tool,
        selection: action.tool ? [] : state.selection,
        lastEdit: null,
      };
    case "setDrawOptions":
      return { ...state, drawOptions: action.options };
    case "editDrawing": {
      const project = action.update(state.project);
      if (project === state.project) return state;
      const at = action.at ?? 0;
      // A run of the same small change, such as nudging with the arrow keys, is one step to undo.
      const folds =
        action.tag !== undefined &&
        state.lastEdit?.tag === action.tag &&
        at - state.lastEdit.at < 1000 &&
        state.undo.length > 0;
      const left = new Set(project.design?.regions.map((r) => r.id));
      // A layer that is hidden or locked lets go of its shapes.
      const can = project.design
        ? pickable(project.design, state.arranging)
        : () => true;
      return withSnapshots({
        ...state,
        project,
        undo: folds ? state.undo : [...state.undo.slice(-49), state.project],
        redo: [],
        lastEdit: action.tag !== undefined ? { tag: action.tag, at } : null,
        selection: (action.select ?? state.selection).filter(
          (id) => left.has(id) && can(id),
        ),
        activeLayer: action.layer ?? state.activeLayer,
      });
    }
    case "undoDrawing":
    case "redoDrawing": {
      const [from, to] =
        action.type === "undoDrawing"
          ? [state.undo, state.redo]
          : [state.redo, state.undo];
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
          steps: [
            ...other.steps.map((old) => {
              const now = state.project.steps.find((j) => j.id === old.id);
              return now ? { ...now, regionIds: old.regionIds } : old;
            }),
            ...state.project.steps.filter(
              (j) =>
                !other.steps.some((old) => old.id === j.id) &&
                j.regionIds.every((id) =>
                  other.design?.regions.some((r) => r.id === id),
                ),
            ),
          ],
        },
        undo: action.type === "undoDrawing" ? rest : kept,
        redo: action.type === "undoDrawing" ? kept : rest,
        lastEdit: null,
        activeStepId: state.activeStepId,
        selection: state.selection.filter(
          (id) =>
            other.design?.regions.some((r) => r.id === id) &&
            (!other.design || pickable(other.design, state.arranging)(id)),
        ),
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
    return {
      ...state,
      selection: state.selection.includes(id)
        ? state.selection.filter((r) => r !== id)
        : [...state.selection, id],
    };
  }
  const owner = regionOwners(state.project.steps).get(id);
  const active = state.project.steps.find((j) => j.id === state.activeStepId);

  // A step done by hand has no shapes of its own.
  if (active && isByHand(active.task)) return state;
  if (active) {
    // A shape is one wood, so one inlay; a plain operation takes any shape.
    if (isInlay(active.task) && owner && owner.id !== active.id) {
      return {
        ...state,
        notice: {
          kind: "info",
          text: `That shape already belongs to "${owner.name}".`,
        },
      };
    }
    const regionIds = active.regionIds.includes(id)
      ? active.regionIds.filter((r) => r !== id)
      : [...active.regionIds, id];
    return reducer(state, {
      type: "updateStep",
      id: active.id,
      update: (step) => ({ ...step, regionIds }),
    });
  }
  // A shape that already has an inlay opens that inlay; with Shift it is selected, for an operation.
  if (owner && !add)
    return {
      ...state,
      activeStepId: owner.id,
      selection: [],
      stage: "drawing",
    };
  const selection = state.selection.includes(id)
    ? state.selection.filter((r) => r !== id)
    : [...state.selection, id];
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

// Each project as this page last read or wrote it, by id: what a save is
// made over. When what is kept is neither that nor what this page has, the
// project was saved from somewhere else in the meantime.
const bases = new Map<string, { text: string; token?: string }>();

/** Loads a kept project, upgrading it if an older version of the app wrote it. */
export async function loadStoredProject(id: string): Promise<Project> {
  const stored = await db.getProject(id);
  if (!stored) throw new Error("That project is no longer kept.");
  bases.set(id, { text: stored.text, token: stored.token });
  return core.call("projectFromFile", stored.text);
}

/** After a conflict, the version saved elsewhere is what this page's next save is made over. */
export function settleConflict(conflict: ProjectConflict) {
  bases.set(conflict.id, { text: conflict.text, token: conflict.token });
}

/** A tool list read from the server: the token that names its version, and its text as this app writes it. */
interface SharedList {
  tools: Tool[];
  lists: ToolLists;
  token: string;
  text: string;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  // The state as last drawn, for work that finishes later than the render it began in.
  const live = useRef(state);

  // The tool list as the server has it: the token that names that version,
  // and its text as this app writes it, to tell a change from none. Without
  // a token the list was never read, and must not be written over.
  const shared = useRef<{ token: string | null; text: string | null }>({
    token: null,
    text: null,
  });
  /** Reads the server's tool list; null when it is still the version held. It is not held until `hold` is given it. */
  const readShared = useCallback(async (): Promise<SharedList | null> => {
    const read = await server.readLibrary(shared.current.token ?? undefined);
    if (!read) return null;
    const { tools, ...lists } = await core.call("libraryFromFile", read.text);
    return {
      tools,
      lists,
      token: read.token,
      text: await core.call("libraryToFile", { ...lists, tools }),
    };
  }, []);
  // Counts the lists taken from the server. A change waiting to be written
  // was made to the list before, and is let go when another has been taken.
  const taken = useRef(0);
  // What was read at start. Until it is changed here it is not written
  // back: what could not be read would go over what the server holds.
  const asLoaded = useRef<{
    tools?: Tool[];
    lists?: ToolLists;
    machine?: Machine;
    defaults?: Setup;
  }>({});
  /** Makes a list read from the server the one this page works on. */
  const hold = useCallback((read: SharedList) => {
    taken.current++;
    shared.current = { token: read.token, text: read.text };
    dispatch({ type: "setTools", tools: read.tools, lists: read.lists });
  }, []);
  // Counts the changes to the list waiting to be written, or on their way.
  const toolWritesWaiting = useRef(0);
  /** Takes the server's list when it changed there, unless a change made here waits: that one finds out by being refused. */
  const refreshShared = useCallback(async (): Promise<SharedList | null> => {
    if (live.current.home !== "server" || toolWritesWaiting.current > 0)
      return null;
    const had = shared.current.token;
    const read = await readShared();
    // Not when a change went out meanwhile: this list is older than it.
    if (!read || toolWritesWaiting.current > 0 || shared.current.token !== had)
      return null;
    hold(read);
    return read;
  }, [readShared, hold]);

  // Load stored tools and the last open project once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let tools: Tool[] = [];
      let lists: ToolLists = {};
      let project = newProject();
      let problem: string | null = null;
      const home = await db.findHome();
      await loadView();
      try {
        if (home === "server") {
          const read = await readShared();
          if (read) {
            ({ tools, lists } = read);
            shared.current = { token: read.token, text: read.text };
          }
        } else {
          const toolsText = await db.getSetting("tools");
          if (toolsText)
            ({ tools, ...lists } = await core.call(
              "libraryFromFile",
              toolsText,
            ));
        }
      } catch (e) {
        problem =
          home === "server"
            ? `The tool list could not be read from the server, and changes to it will not be kept: ${message(e)}`
            : `Your stored tool list could not be read: ${message(e)}`;
      }
      try {
        const last = await db.getSetting("lastProjectId");
        if (last) project = await loadStoredProject(last);
      } catch (e) {
        problem ??= `The last project could not be reopened: ${message(e)}`;
      }
      const { projects, folders } = await db
        .readShelf()
        .catch((): db.Shelf => ({ projects: [], folders: [] }));
      const machine = readMachine(
        await db.getSetting("machine").catch(() => undefined),
      );
      const defaults = readSetup(
        await db.getSetting("inlayDefaults").catch(() => undefined),
      );
      if (cancelled) return;
      asLoaded.current = { tools, lists, machine, defaults };
      dispatch({
        type: "loaded",
        tools,
        lists,
        home,
        machine,
        defaults,
        project,
        projects,
        folders,
      });
      if (problem)
        dispatch({ type: "notice", notice: { kind: "error", text: problem } });
    })();
    return () => {
      cancelled = true;
    };
  }, [readShared]);

  // Save the project shortly after every change. Saves run one at a time, in
  // order, so an older save can never overwrite a newer one.
  //
  // A project open in two places is not written over by the one that has
  // not seen the other's change: when what is kept is neither what this page
  // last read or wrote nor what it has now, saving stops until the user
  // chooses (projectConflict). On a server the write names the version it
  // was made over, so that two saves at the same moment are told apart too.
  const saving = useRef<Promise<void>>(Promise.resolve());
  const conflictId = state.projectConflict?.id;
  useEffect(() => {
    if (!state.ready || conflictId === state.project.id) return;
    const project = state.project;
    const timer = setTimeout(() => {
      saving.current = saving.current.then(async () => {
        try {
          const text = await core.call("projectToFile", project);
          const stored = await db.getProject(project.id);
          const base = bases.get(project.id);
          const conflict = (kept: { text: string; token?: string }) =>
            dispatch({
              type: "projectConflict",
              conflict: { id: project.id, text: kept.text, token: kept.token },
            });
          if (
            stored &&
            base &&
            stored.text !== base.text &&
            stored.text !== text
          )
            return conflict(stored);
          // A blank project that was never stored is not worth keeping, and
          // opening a project must not change its "last modified" time.
          const blank =
            !stored && project.design === null && project.steps.length === 0;
          if (!blank && stored?.text !== text) {
            const token = await db.putProject(
              {
                id: project.id,
                name: project.name,
                modified: Date.now(),
                text,
                steps: project.steps.length,
                // One that is not kept: the folder it was started in, or,
                // deleted somewhere else while open here, the one it was in.
                folder: stored
                  ? undefined
                  : (startOf(project.id) ??
                    live.current.projects.find((p) => p.id === project.id)
                      ?.folder),
              },
              stored?.token,
            );
            if (token !== "conflict") started(project.id);
            if (token === "conflict") {
              const kept = await db.getProject(project.id);
              if (kept) return conflict(kept);
            }
            bases.set(project.id, {
              text,
              token: token === "conflict" ? undefined : token,
            });
            dispatch({ type: "setProjects", ...(await db.readShelf()) });
          } else if (stored) {
            bases.set(project.id, { text: stored.text, token: stored.token });
          }
          if (!blank) await db.putSetting("lastProjectId", project.id);
          dispatch({ type: "saveResult", error: null });
        } catch (e) {
          dispatch({ type: "saveResult", error: message(e) });
        }
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [state.ready, state.project, conflictId, state.reconnects]);

  // The open project, saved from another window or browser: looked for when
  // the page is come back to, and once a minute while it is shown. When
  // nothing was changed here, the version saved there is shown; when both
  // changed it, the user chooses.
  useEffect(() => {
    if (!state.ready) return;
    let looking = false;
    const look = async () => {
      const now = live.current;
      const base = bases.get(now.project.id);
      if (
        looking ||
        !base ||
        now.projectConflict ||
        document.visibilityState !== "visible"
      )
        return;
      looking = true;
      try {
        const stored = await db.getProject(now.project.id);
        if (
          !stored ||
          stored.text === base.text ||
          live.current.project !== now.project
        )
          return;
        const text = await core.call("projectToFile", now.project);
        if (text === stored.text) {
          bases.set(now.project.id, { text: stored.text, token: stored.token });
        } else if (text === base.text) {
          bases.set(now.project.id, { text: stored.text, token: stored.token });
          const project = await core.call("projectFromFile", stored.text);
          if (live.current.project !== now.project) return;
          dispatch({ type: "openProject", project });
          dispatch({ type: "setView", view: now.view, page: now.settingsPage });
          dispatch({
            type: "notice",
            notice: {
              kind: "info",
              text: "This project was saved from another window or browser. It is shown as it was saved there.",
            },
          });
        } else {
          dispatch({
            type: "projectConflict",
            conflict: {
              id: now.project.id,
              text: stored.text,
              token: stored.token,
            },
          });
        }
      } catch {
        // Out of reach, or not readable: the next save says so.
      } finally {
        looking = false;
      }
    };
    const timer = setInterval(look, 60_000);
    window.addEventListener("focus", look);
    document.addEventListener("visibilitychange", look);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", look);
      document.removeEventListener("visibilitychange", look);
    };
  }, [state.ready]);

  // Save the tool list after every change. On a server, shortly after, one
  // write at a time: each names the version it changed, and a write over a
  // version that someone else has changed since is refused. The server's
  // list is then read again, and the change made here is given up.
  const toolWrites = useRef<Promise<void>>(Promise.resolve());

  // A write refused because the list changed on the server: the changes
  // made here since the version last held are made to the server's list,
  // and written. Where both changed the same thing, the server's is kept,
  // and said. A change made here while this was on its way is merged in the
  // same way after.
  const mergeShared = useCallback(async () => {
    const lost = (text: string) =>
      dispatch({ type: "notice", notice: { kind: "error", text } });
    const theirs = await readShared();
    if (!theirs)
      throw new Error(
        "the server refused the change, but has the version it was made to",
      );
    const before = live.current;
    const mine = { ...before.lists, tools: before.tools };
    const base = shared.current.text
      ? await core.call("libraryFromFile", shared.current.text)
      : null;
    if (!base) {
      hold(theirs);
      return lost(
        "The tool list was changed somewhere else in the meantime. It was read again from the server, and your last change to it was not kept.",
      );
    }
    const merged = mergeLibraries(base, mine, {
      ...theirs.lists,
      tools: theirs.tools,
    });
    let text: string;
    let token: string | "conflict";
    try {
      text = await core.call("libraryToFile", merged.library);
      token = await server.writeLibrary(text, theirs.token);
    } catch (e) {
      hold(theirs);
      return lost(
        `The tool list was changed somewhere else in the meantime, and your changes could not be put with that one (${message(e)}). It was read again from the server, and your last changes to it were not kept.`,
      );
    }
    if (token === "conflict") {
      const again = await readShared();
      if (again) hold(again);
      return lost(
        "The tool list was changed somewhere else twice in a row. It was read again from the server, and your last change to it was not kept.",
      );
    }
    const { tools, ...lists } = await core.call("libraryFromFile", text);
    hold({ tools, lists, token, text });
    // Changed here while the merge was on its way: made to the merged list.
    const after = live.current;
    if (after.tools !== before.tools || after.lists !== before.lists) {
      const again = mergeLibraries(
        mine,
        { ...after.lists, tools: after.tools },
        { ...lists, tools },
      );
      const { tools: againTools, ...againLists } = again.library;
      dispatch({ type: "setTools", tools: againTools, lists: againLists });
    }
    if (merged.lost.length > 0) {
      const one = merged.lost.length === 1;
      lost(
        `The tool list was changed somewhere else too. Both changes were kept, except that ${listed(merged.lost)} ${one ? "was" : "were"} changed in both places, and the change made there was kept. Make yours again if it is still wanted.`,
      );
    } else {
      dispatch({
        type: "notice",
        notice: {
          kind: "info",
          text: "The tool list was changed somewhere else too. Both changes were kept.",
        },
      });
    }
  }, [readShared, hold]);
  useEffect(() => {
    if (!state.ready) return;
    const library = { ...state.lists, tools: state.tools };
    const failed = (e: unknown) => {
      // Out of reach is said once, at the top, and the list is written when the server is back.
      if (state.home === "server" && server.getReach() === "unreachable")
        return;
      dispatch({
        type: "notice",
        notice: {
          kind: "error",
          text: `The tool list could not be saved: ${message(e)}`,
        },
      });
    };
    if (state.home === "browser") {
      (async () =>
        db.putSetting(
          "tools",
          await core.call("libraryToFile", library),
        ))().catch(failed);
      return;
    }
    if (
      state.tools === asLoaded.current.tools &&
      state.lists === asLoaded.current.lists
    )
      return;
    const base = taken.current;
    toolWritesWaiting.current++;
    let begun = false;
    const timer = setTimeout(() => {
      begun = true;
      toolWrites.current = toolWrites.current
        .then(async () => {
          // Another list was taken while this change waited, after a
          // refusal that has said so: written now, it would go over the
          // change someone else made.
          if (taken.current !== base) return;
          const text = await core.call("libraryToFile", library);
          if (text === shared.current.text) return;
          if (shared.current.token === null) {
            // Never read: read now, and the change made on nothing is given up.
            const read = await readShared();
            if (read) hold(read);
            throw new Error(
              "it had not been read from the server. It has been read now, and your last change to it was not kept.",
            );
          }
          const token = await server.writeLibrary(text, shared.current.token);
          if (token !== "conflict") {
            shared.current = { token, text };
            return;
          }
          await mergeShared();
        })
        .catch(failed)
        .finally(() => {
          toolWritesWaiting.current--;
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      if (!begun) toolWritesWaiting.current--;
    };
  }, [
    state.ready,
    state.home,
    state.tools,
    state.lists,
    state.reconnects,
    readShared,
    hold,
    mergeShared,
  ]);

  // A shared list changes without this page: look again when the page is
  // come back to, and once a minute while it is shown. Not while a change
  // made here is on its way, and a list that arrives after such a change
  // was made is let go: the change then finds out by being refused, and
  // says so, where taking the list would drop it without a word.
  useEffect(() => {
    if (!state.ready || state.home !== "server") return;
    let looking = false;
    const look = async () => {
      if (looking || document.visibilityState !== "visible") return;
      looking = true;
      try {
        await refreshShared();
      } catch {
        // Out of reach for now: the next look, or the next save, will say.
      } finally {
        looking = false;
      }
    };
    const timer = setInterval(look, 60_000);
    window.addEventListener("focus", look);
    document.addEventListener("visibilitychange", look);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", look);
      document.removeEventListener("visibilitychange", look);
    };
  }, [state.ready, state.home, refreshShared]);

  // The server out of reach: said at the top (Header), and what waits is
  // saved when it is back. The browser's own word that it is offline or
  // online is taken as a hint.
  const reach = useSyncExternalStore(server.subscribeReach, server.getReach);
  const wasOut = useRef(false);
  useEffect(() => {
    if (reach === "unreachable") wasOut.current = true;
    else if (wasOut.current) {
      wasOut.current = false;
      dispatch({ type: "reconnected" });
    }
  }, [reach]);
  useEffect(() => {
    if (!state.ready || state.home !== "server") return;
    const offline = () => server.lostReach();
    const online = () => server.checkReach();
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [state.ready, state.home]);
  const waiting = state.home === "server" && reach === "unreachable";
  useEffect(() => {
    if (!waiting) return;
    const ask = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [waiting]);

  useEffect(() => {
    if (!state.ready || state.machine === asLoaded.current.machine) return;
    db.putSetting("machine", JSON.stringify(state.machine)).catch((e) => {
      if (state.home === "server" && server.getReach() === "unreachable")
        return;
      dispatch({
        type: "notice",
        notice: {
          kind: "error",
          text: `The machine could not be saved: ${message(e)}`,
        },
      });
    });
  }, [state.ready, state.home, state.machine, state.reconnects]);

  useEffect(() => {
    if (!state.ready || state.defaults === asLoaded.current.defaults) return;
    db.putSetting("inlayDefaults", JSON.stringify(state.defaults)).catch(
      (e) => {
        if (state.home === "server" && server.getReach() === "unreachable")
          return;
        dispatch({
          type: "notice",
          notice: {
            kind: "error",
            text: `The inlay defaults could not be saved: ${message(e)}`,
          },
        });
      },
    );
  }, [state.ready, state.home, state.defaults, state.reconnects]);

  // For an agent's commands (agent/host.ts), which run outside the screens:
  // the state as last drawn, and a dispatch that answers once it is drawn.
  const drawn = useRef<(() => void)[]>([]);
  useEffect(() => {
    live.current = state;
    for (const done of drawn.current.splice(0)) done();
  }, [state]);
  useEffect(
    () =>
      bindHost({
        state: () => live.current,
        preview: (action) => reducer(live.current, action),
        apply: (action) =>
          reducer(live.current, action) === live.current
            ? Promise.resolve(live.current)
            : new Promise((resolve) => {
                drawn.current.push(() => resolve(live.current));
                dispatch(action);
              }),
        freshTools: async () => {
          const read = await refreshShared();
          // Drawn, so that state() has it.
          for (
            let waited = 0;
            read && live.current.tools !== read.tools && waited < 2000;
            waited += 10
          ) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        },
        toolsSaved: async () => {
          // A change is written 300 ms after it is made, one at a time.
          for (
            let waited = 0;
            toolWritesWaiting.current > 0 && waited < 30_000;
            waited += 50
          ) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await toolWrites.current;
        },
      }),
    [refreshShared],
  );

  const value = useMemo(() => state, [state]);
  return (
    <StateContext.Provider value={value}>
      <DispatchContext.Provider value={dispatch}>
        {children}
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

/** "a, b and c". */
function listed(items: string[]): string {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
