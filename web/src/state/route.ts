// Where the page is, as an address: the part after the `#`, so that a reload,
// a bookmark or the Back button comes to the same view of the same project.
//
//   #/new                                   a project that is not kept yet
//   #/p/<project>                           the open project: its drawing and list
//   #/p/<project>/tools | /export           the panel's other pages
//   #/p/<project>/step/<step>               an inlay or operation
//   ...then /pocket | /plug | /fit          what the large area shows of it
//   ...or   /stock/<n>                      the stock after the nth entry
//   #/projects | /unfiled | /in/<folder>/<folder>
//   #/tools | #/tools/<tool>
//   #/settings/<page>
//
// It is after the `#` because the app is served as files from any folder
// (GitHub Pages, inlay-server, a disk): nothing but the page is ever asked for.
//
// Nothing here touches the window: state/address.ts reads and writes the
// address with what this file works out.

import { scopeThatIs, type Scope } from "./folders";
import type { PanelPage, SettingsPage, Stage, View } from "./store";

export type Route =
  | {
      view: "design";
      /** The project's id; null for one that is not kept yet. */
      project: string | null;
      /** The panel's page while no step is open. */
      panel: PanelPage;
      step: string | null;
      stage: Stage;
      /** The point of the list the stock is shown at, when the stage is the stock. */
      at: number;
    }
  | { view: "projects"; scope: Scope }
  | { view: "settings"; page: SettingsPage; tool: string | null };

/** A step's output to make again, to show what the address names: it is not kept from one visit to the next. */
export interface Restore {
  stepId: string;
  stage: Stage;
}

/** What of the app's state says where the page is. The state itself fits. */
export interface Place {
  view: View;
  settingsPage: SettingsPage;
  scope: Scope;
  toolId: string | null;
  activeStepId: string | null;
  stage: Stage;
  panelPage: PanelPage;
  timelineAt: number;
  /** The point of the list an address named before the stock was worked out: shown once it is. */
  stockAt: number | null;
  restore: Restore | null;
  project: { id: string; design: unknown; steps: { id: string }[] };
  projects: { id: string }[];
  folders: string[];
  tools: { id: string }[];
  output: { stepId: string; parts: { pocket?: unknown; plug?: unknown }; fit: unknown } | null;
  timeline: { result: { steps: unknown[] } | null } | null;
}

const SETTINGS_PAGES: SettingsPage[] = ["materials", "profiles", "machine", "defaults", "storage", "agent"];
const PARTS: Stage[] = ["pocket", "plug", "fit"];

/** A design route with nothing but the project said. */
function design(project: string | null): Extract<Route, { view: "design" }> {
  return { view: "design", project, panel: "list", step: null, stage: "drawing", at: 0 };
}

/** The open project's id as an address names it: null while it is blank and not kept, since a reload could not find it. */
export function projectInAddress(place: Pick<Place, "project" | "projects">): string | null {
  const { project, projects } = place;
  const kept = projects.some((p) => p.id === project.id);
  return kept || project.design !== null || project.steps.length > 0 ? project.id : null;
}

/** Whether a step's output holds what a stage shows. */
function made(output: Place["output"], stepId: string, stage: Stage): boolean {
  if (!output || output.stepId !== stepId) return false;
  return stage === "fit" ? Boolean(output.fit) : stage === "pocket" ? Boolean(output.parts.pocket) : stage === "plug" ? Boolean(output.parts.plug) : false;
}

/** Where the page is. */
export function routeOf(place: Place): Route {
  if (place.view === "projects") return { view: "projects", scope: scopeThatIs(place.scope, place.folders) };
  if (place.view === "settings") {
    if (place.settingsPage !== "tools") return { view: "settings", page: place.settingsPage, tool: null };
    const tool = place.tools.some((t) => t.id === place.toolId) ? place.toolId : null;
    return { view: "settings", page: "tools", tool };
  }
  const route = design(projectInAddress(place));
  const step = place.project.steps.find((s) => s.id === place.activeStepId);
  if (step) route.step = step.id;
  else route.panel = place.panelPage;
  // As the screen falls back to the drawing when what was asked for is not there.
  if (place.stage === "timeline" && place.project.steps.length > 0) {
    route.stage = "timeline";
    route.at = place.timelineAt;
  } else if (step && PARTS.includes(place.stage)) {
    const coming = place.restore?.stepId === step.id && place.restore.stage === place.stage;
    if (coming || made(place.output, step.id, place.stage)) route.stage = place.stage;
  }
  return route;
}

/** A name as one part of an address. Half a pair of UTF-16 units, which no address can carry, goes as the mark for a letter that could not be read. */
function enc(part: string): string {
  try {
    return encodeURIComponent(part);
  } catch {
    return encodeURIComponent(part.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD"));
  }
}

/** A route as the address's fragment, `#` and all. */
export function formatRoute(route: Route): string {
  if (route.view === "projects") {
    const { scope } = route;
    if (scope.kind === "all") return "#/projects";
    if (scope.kind === "unfiled") return "#/projects/unfiled";
    return `#/projects/in/${scope.path.split("/").map(enc).join("/")}`;
  }
  if (route.view === "settings") {
    if (route.page !== "tools") return `#/settings/${route.page}`;
    return route.tool === null ? "#/tools" : `#/tools/${enc(route.tool)}`;
  }
  let text = route.project === null ? "#/new" : `#/p/${enc(route.project)}`;
  if (route.step !== null) text += `/step/${enc(route.step)}`;
  else if (route.panel !== "list") text += `/${route.panel}`;
  if (route.stage === "timeline") text += `/stock/${route.at}`;
  else if (route.stage !== "drawing") text += `/${route.stage}`;
  return text;
}

/**
 * The route an address's fragment names; null when it names none: an empty
 * one, another kind of fragment (an agent's pairing link), or one this app
 * did not write. What follows a part that is understood and is not itself
 * understood is left out, so that an address cut short still leads somewhere.
 */
export function parseRoute(hash: string): Route | null {
  if (!hash.startsWith("#/")) return null;
  let parts: string[];
  try {
    parts = hash.slice(2).split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
  // A slash at the end names the same place.
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  const [head, ...rest] = parts;
  if (head === "projects") {
    if (rest[0] === "unfiled") return { view: "projects", scope: { kind: "unfiled" } };
    const path = rest.slice(1);
    if (rest[0] === "in" && path.length > 0 && path.every(Boolean)) return { view: "projects", scope: { kind: "folder", path: path.join("/") } };
    return { view: "projects", scope: { kind: "all" } };
  }
  if (head === "tools") return { view: "settings", page: "tools", tool: rest[0] || null };
  if (head === "settings") {
    // The tools are a settings page with an address of its own.
    if (rest[0] === "tools") return { view: "settings", page: "tools", tool: null };
    const page = SETTINGS_PAGES.find((p) => p === rest[0]);
    return { view: "settings", page: page ?? "materials", tool: null };
  }
  if (head !== "new" && !(head === "p" && rest[0])) return null;
  const route = design(head === "new" ? null : rest[0]);
  let next = rest.slice(head === "new" ? 0 : 1);
  if (next[0] === "step" && next[1]) {
    route.step = next[1];
    next = next.slice(2);
  } else if (next[0] === "tools" || next[0] === "export") {
    route.panel = next[0];
    next = next.slice(1);
  }
  if (next[0] === "stock") {
    route.stage = "timeline";
    route.at = /^\d{1,6}$/.test(next[1] ?? "") ? Number(next[1]) : 0;
  } else if (route.step !== null && PARTS.includes(next[0] as Stage)) {
    route.stage = next[0] as Stage;
  }
  return route;
}

/**
 * Whether two routes are one entry of the browser's history: the Back button
 * goes from view to view, project to project and step to step, not through
 * every look at a step's pocket or every point of the stock's list. A project
 * that has just been kept stays the entry it was while it was new.
 */
export function sameEntry(a: Route, b: Route): boolean {
  const flat = (route: Route): Route => (route.view === "design" ? { ...route, stage: "drawing", at: 0 } : route);
  if (a.view === "design" && b.view === "design" && a.project === null) a = { ...a, project: b.project };
  return formatRoute(flat(a)) === formatRoute(flat(b));
}

/**
 * What going to a route changes of the state. The route's project is open
 * already, or it is a route to another view; a design route to some other
 * project only turns to the design view.
 *
 * `rebuild`: a step's pocket, plug or fit that is not there is asked to be
 * made again (`restore`), as when the page is reloaded. Without it the
 * drawing is shown, as when the Back button comes to a step.
 */
export function applyRoute<S extends Place>(state: S, route: Route, rebuild = false): S {
  // Wherever it goes, what an earlier address asked to be made is let go.
  state = { ...state, restore: null, stockAt: null };
  if (route.view === "projects") return { ...state, view: "projects", scope: scopeThatIs(route.scope, state.folders) };
  if (route.view === "settings") {
    if (route.page !== "tools") return { ...state, view: "settings", settingsPage: route.page };
    // A tool that is not in the list is not kept in mind: one made later with its id would show by itself.
    const tool = state.tools.some((t) => t.id === route.tool) ? route.tool : null;
    return { ...state, view: "settings", settingsPage: "tools", toolId: tool };
  }
  if (route.project !== projectInAddress(state)) return { ...state, view: "design" };
  const step = state.project.steps.find((s) => s.id === route.step) ?? null;
  const next = {
    ...state,
    view: "design",
    activeStepId: step?.id ?? null,
    // Behind an open step the panel keeps the page it was on, to come back to.
    panelPage: step ? state.panelPage : route.panel,
    stage: "drawing",
  } as S;
  const worked = state.timeline?.result ?? null;
  const count = worked ? worked.steps.length : state.project.steps.length;
  if (route.stage === "timeline" && state.project.steps.length > 0) {
    next.stage = "timeline";
    next.timelineAt = Math.min(route.at, count);
    if (!worked) next.stockAt = next.timelineAt;
  } else if (step && PARTS.includes(route.stage)) {
    if (made(state.output, step.id, route.stage)) next.stage = route.stage;
    else if (rebuild) {
      next.stage = route.stage;
      next.restore = { stepId: step.id, stage: route.stage };
    }
  }
  return next;
}

/** What to do when the browser has moved to another address: by Back or Forward, or one typed or pasted. */
export type Move =
  /** Nowhere: the address of where the page is is written again, over the one moved to or as a new entry. */
  | { kind: "stay"; how: "push" | "replace" }
  /** To a route. `open`: the project to open first, null for a new one; left out when the open one is the route's. */
  | { kind: "go"; route: Route; open?: string | null };

/**
 * `mayLeave` is asked only when the page would turn: it asks the user about
 * changes that are not saved. The browser has moved already when they say
 * no, so the address is put back as a new entry.
 */
export function moveFor(place: Place, hash: string, mayLeave: () => boolean): Move {
  const route = parseRoute(hash);
  if (!route || formatRoute(route) === formatRoute(routeOf(place))) return { kind: "stay", how: "replace" };
  if (!mayLeave()) return { kind: "stay", how: "push" };
  if (route.view === "design" && route.project !== projectInAddress(place)) return { kind: "go", route, open: route.project };
  return { kind: "go", route };
}

/** How the address is written when the page has turned by itself: as a new entry, or over the one shown. `shown` is the route it was last written for. */
export function writeFor(shown: Route | null, route: Route): "push" | "replace" {
  return shown && !sameEntry(shown, route) ? "push" : "replace";
}

/** The stage to show when a step's output has been made: the one asked for when it is there, else the one that says most. */
export function stageMade(output: NonNullable<Place["output"]>, want?: Stage): Stage {
  if (want && made(output, output.stepId, want)) return want;
  return output.fit ? "fit" : output.parts.pocket ? "pocket" : output.parts.plug ? "plug" : "drawing";
}

/**
 * Opens the project the page starts with (see projectsToTry). `route` is
 * where the address leads, `last` reads the id of the project last saved
 * from anywhere, `load` opens a kept project and throws when it is gone.
 *
 * Gives the project, null for a blank one; the route to go to, which is the
 * Projects tab when the project the address named could not be opened; and
 * what to tell the user, if anything went wrong that they should know of.
 * The tab's own project being gone is not said when the last one opens.
 */
export async function projectAtStart<P>(
  route: Route | null,
  tab: string | null,
  last: () => Promise<string | null | undefined>,
  load: (id: string) => Promise<P>,
): Promise<{ project: P | null; route: Route | null; problem: string | null }> {
  const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let lastId: string | null = null;
  let unread: string | null = null;
  try {
    lastId = (await last()) ?? null;
  } catch (e) {
    unread = `The last project could not be reopened: ${said(e)}`;
  }
  const { blank, named, others } = projectsToTry(route, tab, lastId);
  if (blank) return { project: null, route, problem: null };
  let problem: string | null = null;
  if (named !== null) {
    try {
      return { project: await load(named), route, problem: null };
    } catch (e) {
      problem = `The project this address leads to could not be opened: ${said(e)}`;
      route = { view: "projects", scope: { kind: "all" } };
    }
  }
  for (const [i, id] of others.entries()) {
    try {
      return { project: await load(id), route, problem };
    } catch (e) {
      if (i === others.length - 1) problem ??= `The last project could not be reopened: ${said(e)}`;
    }
  }
  return { project: null, route, problem: problem ?? unread };
}

/**
 * The projects to try to open when the page starts, in order: the one the
 * address names, then the one this tab had open, then the one last saved
 * from anywhere. `blank` when the address asks for a new one instead.
 */
export function projectsToTry(route: Route | null, tab: string | null, last: string | null): { blank: boolean; named: string | null; others: string[] } {
  if (route?.view === "design" && route.project === null) return { blank: true, named: null, others: [] };
  const named = route?.view === "design" ? route.project : null;
  const others = [tab, last].filter((id): id is string => Boolean(id) && id !== named);
  return { blank: false, named, others: [...new Set(others)] };
}
