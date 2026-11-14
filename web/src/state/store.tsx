// App state: the open project, the tool list, and what is selected.
// Changes are saved to browser storage automatically.

import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from "react";
import { core } from "../core/client";
import type { ImportReport, Job, PocketPreview, Project, Tool } from "../core/types";
import * as db from "../storage/db";
import { newProject, regionOwners, toolSnapshots } from "./model";

export type View = "design" | "tools";
export type Notice = { kind: "info" | "error"; text: string };

export interface AppState {
  /** False until stored data has been loaded. */
  ready: boolean;
  tools: Tool[];
  project: Project;
  projects: db.ProjectSummary[];
  view: View;
  /** Regions picked for a new inlay. */
  selection: number[];
  /** The inlay being edited; region clicks then add to or remove from it. */
  activeJobId: string | null;
  importReport: ImportReport | null;
  notice: Notice | null;
  saveError: string | null;
  /** The last generated output. Not saved: it is rebuilt on demand. */
  output: Output | null;
}

export interface Output {
  jobId: string;
  /** The project exactly as it was when this was generated, to tell when it is out of date. */
  project: Project;
  /** Set when generation succeeded. */
  preview: PocketPreview | null;
  /** Reasons generation failed. */
  errors: string[];
}

export type Action =
  | { type: "loaded"; tools: Tool[]; project: Project; projects: db.ProjectSummary[] }
  | { type: "openProject"; project: Project; importReport?: ImportReport | null }
  | { type: "updateProject"; update: (project: Project) => Project }
  | { type: "updateJob"; id: string; update: (job: Job) => Job }
  | { type: "setTools"; tools: Tool[] }
  | { type: "setProjects"; projects: db.ProjectSummary[] }
  | { type: "setView"; view: View }
  | { type: "clickRegion"; id: number }
  | { type: "setSelection"; ids: number[] }
  | { type: "setActiveJob"; id: string | null }
  | { type: "setImportReport"; report: ImportReport | null }
  | { type: "notice"; notice: Notice | null }
  | { type: "saveResult"; error: string | null }
  | { type: "setOutput"; output: Output | null };

const initial: AppState = {
  ready: false,
  tools: [],
  project: newProject(),
  projects: [],
  view: "design",
  selection: [],
  activeJobId: null,
  importReport: null,
  notice: null,
  saveError: null,
  output: null,
};

/** Keeps the project's tool copies in step with its jobs and the tool list. */
function withSnapshots(state: AppState): AppState {
  const tools = toolSnapshots(state.project, state.tools);
  if (JSON.stringify(tools) === JSON.stringify(state.project.tools)) return state;
  return { ...state, project: { ...state.project, tools } };
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "loaded":
      return withSnapshots({ ...state, ready: true, tools: action.tools, project: action.project, projects: action.projects });
    case "openProject":
      return withSnapshots({
        ...state,
        project: action.project,
        selection: [],
        activeJobId: null,
        importReport: action.importReport ?? null,
        output: null,
        view: "design",
      });
    case "updateProject":
      return withSnapshots({ ...state, project: action.update(state.project) });
    case "updateJob":
      return withSnapshots({
        ...state,
        project: { ...state.project, jobs: state.project.jobs.map((j) => (j.id === action.id ? action.update(j) : j)) },
      });
    case "setTools":
      return withSnapshots({ ...state, tools: action.tools });
    case "setProjects":
      return { ...state, projects: action.projects };
    case "setView":
      return { ...state, view: action.view };
    case "clickRegion":
      return clickRegion(state, action.id);
    case "setSelection":
      return { ...state, selection: action.ids };
    case "setActiveJob":
      return { ...state, activeJobId: action.id, selection: [] };
    case "setImportReport":
      return { ...state, importReport: action.report };
    case "notice":
      return { ...state, notice: action.notice };
    case "saveResult":
      return { ...state, saveError: action.error };
    case "setOutput":
      return { ...state, output: action.output };
  }
}

function clickRegion(state: AppState, id: number): AppState {
  const owner = regionOwners(state.project.jobs).get(id);
  const active = state.project.jobs.find((j) => j.id === state.activeJobId);

  if (active) {
    if (owner && owner.id !== active.id) {
      return { ...state, notice: { kind: "info", text: `That shape already belongs to "${owner.name}".` } };
    }
    const regionIds = active.regionIds.includes(id) ? active.regionIds.filter((r) => r !== id) : [...active.regionIds, id];
    return reducer(state, { type: "updateJob", id: active.id, update: (job) => ({ ...job, regionIds }) });
  }
  // A shape that already has an inlay opens that inlay.
  if (owner) return { ...state, activeJobId: owner.id, selection: [] };
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
      let project = newProject();
      let problem: string | null = null;
      try {
        const toolsText = await db.getSetting("tools");
        if (toolsText) tools = await core.call("toolsFromFile", toolsText);
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
      if (cancelled) return;
      dispatch({ type: "loaded", tools, project, projects });
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
    const tools = state.tools;
    (async () => {
      try {
        await db.putSetting("tools", await core.call("toolsToFile", tools));
      } catch (e) {
        dispatch({ type: "notice", notice: { kind: "error", text: `The tool list could not be saved: ${message(e)}` } });
      }
    })();
  }, [state.ready, state.tools]);

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
