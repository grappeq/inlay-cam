// The browser's address, kept in step with where the page is (state/route.ts
// says what an address means). Moving about the app writes the address; the
// Back and Forward buttons, and an address typed or pasted, move the app.
//
// The project is in the address only in the design view. In the other views
// the tab remembers its own (session storage), so that two tabs with two
// projects each come back to theirs.

import { useEffect, useRef, useState, type Dispatch } from "react";
import { readPairing } from "../agent/link";
import type { Project } from "../core/types";
import { newProject } from "./model";
import { formatRoute, moveFor, parseRoute, routeOf, writeFor, type Route } from "./route";
import type { Action, AppState } from "./store";
import { tasks } from "./tasks";
import { mayLeave } from "./unsaved";

const TAB_PROJECT = "inlay.tabProject";

/** The project this tab last had open and kept. */
export function tabProject(): string | null {
  try {
    return sessionStorage.getItem(TAB_PROJECT);
  } catch {
    return null;
  }
}

export function keepTabProject(id: string): void {
  try {
    sessionStorage.setItem(TAB_PROJECT, id);
  } catch {
    // Without storage the tab comes back to the project last saved from anywhere.
  }
}

/** The route the address names now; null when it names none. */
export function readAddress(): Route | null {
  return parseRoute(location.hash);
}

/** Writes the address, as a new entry of the history or over the one shown. False when the browser would not. */
function write(hash: string, how: "push" | "replace"): boolean {
  try {
    const url = location.pathname + location.search + hash;
    if (how === "push") history.pushState(null, "", url);
    else history.replaceState(null, "", url);
    return true;
  } catch {
    // A page that may not change its address (some embedded ones) works without.
    return false;
  }
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useAddress(state: AppState, dispatch: Dispatch<Action>, load: (id: string) => Promise<Project>): void {
  const live = useRef(state);
  live.current = state;
  // Counts the times the address is to be looked at again though the route did not change.
  const [again, setAgain] = useState(0);
  // How the next write is made, when it is not for the routes to say.
  const forced = useRef<"push" | "replace" | null>(null);
  // The route the address was last written for.
  const shown = useRef<Route | null>(null);

  const hash = state.ready ? formatRoute(routeOf(state)) : null;
  useEffect(() => {
    if (hash === null) return;
    // An agent's pairing link is taken out of the address by agent/link.ts first.
    if (readPairing(location.hash)) {
      const timer = setTimeout(() => setAgain((n) => n + 1), 50);
      return () => clearTimeout(timer);
    }
    const route = routeOf(live.current);
    const how = forced.current ?? writeFor(shown.current, route);
    forced.current = null;
    if (location.hash !== hash) write(hash, how);
    shown.current = route;
  }, [hash, again]);

  useEffect(() => {
    if (!state.ready) return;
    // The last move asked for: a project that arrives after a later move is let go.
    let latest = 0;
    /** Writes the address of where the page is, over the one that could not be gone to. */
    const stay = (how: "push" | "replace") => {
      forced.current = how;
      setAgain((n) => n + 1);
    };
    const onMove = async () => {
      const turn = ++latest;
      if (readPairing(location.hash)) return stay("replace");
      const move = moveFor(live.current, location.hash, mayLeave);
      if (move.kind === "stay") return stay(move.how);
      if (move.open !== undefined) {
        try {
          const id = move.open;
          const project = id === null ? newProject() : await tasks.run({ key: "open", label: "Opening the project", place: "notice" }, () => load(id));
          if (turn !== latest) return;
          dispatch({ type: "openProject", project });
        } catch (e) {
          if (turn !== latest) return;
          dispatch({ type: "notice", notice: { kind: "error", text: `The project this address leads to could not be opened: ${text(e)}` } });
          return stay("replace");
        }
      }
      dispatch({ type: "goTo", route: move.route });
      stay("replace");
    };
    const listener = () => void onMove();
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, [state.ready, dispatch, load]);
}
