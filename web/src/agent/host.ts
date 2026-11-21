// What an agent's commands reach the app through. The screens read the
// state and dispatch from React; a command runs outside them, and is handed
// the same two things here by the store once it is up.

import type { Action, AppState } from "../state/store";

export interface Host {
  /** The state as the screens last drew it. */
  state(): AppState;
  /** What the state would be after an action, without making it so. */
  preview(action: Action): AppState;
  /** Makes a change as a screen would, and answers with the state once the screens have drawn it. */
  apply(action: Action): Promise<AppState>;
  /** On a server, takes the tool list as it is there, unless a change made here is on its way. */
  freshTools?(): Promise<void>;
  /** Answers once every change to the tool list made so far is written, or given up. */
  toolsSaved?(): Promise<void>;
}

let bound: Host | null = null;

/** Called by the store. Returns what unbinds it again. */
export function bindHost(host: Host): () => void {
  bound = host;
  return () => {
    if (bound === host) bound = null;
  };
}

export function host(): Host | null {
  return bound;
}
