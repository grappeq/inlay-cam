// The places things can be kept in, and which one is in use: this browser,
// a folder on this computer, or the server the page came from. One is in
// use, chosen under Settings, Storage, and remembered by this browser; the
// others are there to sync with (sync.ts). Unless one was chosen, it is the
// server where there is one and the browser where there is not.
//
// A folder is reached through a handle the browser keeps, and gives back
// only after the user allows it again, on a click. Until then the page does
// not start on some other place by itself: it asks (`getGate`).

import * as db from "./db";
import { openFolder, type Dir, type FolderStore, type Memo, type Seen } from "./fs";
import * as keep from "./keep";
import * as server from "./server";
import { turned, type Base, type Store } from "./sync";

export type Home = "browser" | "server" | "folder";

type Permission = "granted" | "denied" | "prompt";
type Handle = Dir & {
  queryPermission(options: { mode: "readwrite" }): Promise<Permission>;
  requestPermission(options: { mode: "readwrite" }): Promise<Permission>;
  isSameEntry(other: unknown): Promise<boolean>;
};

/** The folder that was picked. `key` names it, for what is remembered about it: another folder is another key. */
interface KeptFolder {
  handle: Handle;
  name: string;
  key: string;
}

const CHOICE = "inlay.place";
const FOLDER = "folder";

let finding: Promise<Home> | null = null;
let found: Home = "browser";
let serverFound = false;
let kept: KeptFolder | null = null;
let granted = false;
let store: FolderStore | null = null;
let gate: { name: string; refused: boolean; other: Home; answer: (home: Home) => void } | null = null;
let startNote: string | null = null;

const watchers = new Set<() => void>();
let version = 0;
function changed() {
  version++;
  for (const watch of watchers) watch();
}
export function subscribePlaces(watch: () => void): () => void {
  watchers.add(watch);
  return () => watchers.delete(watch);
}
/** Changes whenever what `places` or `getGate` give does. */
export function placesVersion(): number {
  return version;
}

function chosen(): Home | null {
  try {
    const value = localStorage.getItem(CHOICE);
    return value === "browser" || value === "server" || value === "folder" ? value : null;
  } catch {
    return null;
  }
}

/** The place to start on. `folder` is whether the one picked may be used now, or has to be asked for. */
export function placeToStart(choice: Home | null, hasServer: boolean, folder: "granted" | "ask" | "none"): Home | "ask" {
  if (choice === "folder" && folder !== "none") return folder === "granted" ? "folder" : "ask";
  if (choice === "browser") return "browser";
  return hasServer ? "server" : "browser";
}

async function permitted(handle: Handle): Promise<boolean> {
  try {
    return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

/** Finds out, once, where things are kept. With a folder that has to be allowed again, not before the user has answered. */
export function findHome(): Promise<Home> {
  finding ??= (async () => {
    serverFound = await server.findServer();
    kept = (await keep.recall<KeptFolder>(FOLDER).catch(() => undefined)) ?? null;
    if (kept) granted = await permitted(kept.handle);
    // Not started somewhere else without a word: what was kept is not gone, only not shown.
    else if (chosen() === "folder") startNote = `The folder everything was kept in is no longer known to this browser. This is what is kept ${serverFound ? "on the server" : "in this browser"}: choose the folder again under Settings, Storage.`;
    const start = placeToStart(chosen(), serverFound, !kept ? "none" : granted ? "granted" : "ask");
    found =
      start !== "ask"
        ? start
        : await new Promise<Home>((answer) => {
            gate = { name: kept!.name, refused: false, other: serverFound ? "server" : "browser", answer };
            changed();
          });
    gate = null;
    changed();
    return found;
  })();
  return finding;
}

/** Where things are kept, once `findHome` has answered. */
export function home(): Home {
  return found;
}

/** What to say once the page has started, when it could not start on the place chosen; null for nothing. */
export function startProblem(): string | null {
  return startNote;
}

/** The folder the page waits to be allowed to use again; null when it does not wait. */
export function getGate(): { name: string; refused: boolean; other: Home } | null {
  return gate;
}

/** Answers the wait, from a click: the folder is asked for, or another place is started on for this visit. */
export async function answerGate(to: "folder" | "other"): Promise<void> {
  if (!gate || !kept) return;
  if (to === "other") return gate.answer(gate.other);
  granted = await request(kept.handle);
  if (granted) return gate.answer("folder");
  gate = { ...gate, refused: true };
  changed();
}

async function request(handle: Handle): Promise<boolean> {
  try {
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

function memo(key: string): Memo {
  return { read: () => keep.recall<Record<string, Seen>>(`seen:${key}`), write: (seen) => keep.keep(`seen:${key}`, seen) };
}

/** The folder that was picked, as a place. Throws while there is none, or it may not be used. */
export function folderStore(): FolderStore {
  if (!kept) throw new Error("No folder has been chosen.");
  if (!granted) throw new Error(`The folder "${kept.name}" has to be reconnected, under Settings, Storage.`);
  store ??= openFolder(kept.handle, memo(kept.key));
  return store;
}

/** Whether this browser can keep things in a folder: Chrome and Edge on a computer can. */
export function folderSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

export interface PlaceInfo {
  id: Home;
  /** "This browser", "Folder on this PC", "Server". */
  label: string;
  /** The folder's name. */
  name?: string;
  /** `ready`: can be used and synced with. `reconnect`: a folder to be allowed again. `none`: no folder chosen. `absent`: not there. */
  state: "inUse" | "ready" | "reconnect" | "none" | "absent";
}

export function places(): PlaceInfo[] {
  const state = (id: Home, there: boolean): PlaceInfo["state"] => (found === id ? "inUse" : there ? "ready" : "absent");
  return [
    { id: "browser", label: "This browser", state: state("browser", true) },
    { id: "folder", label: "Folder on this PC", name: kept?.name, state: !kept ? (folderSupported() ? "none" : "absent") : !granted ? "reconnect" : state("folder", true) },
    { id: "server", label: "Server", state: state("server", serverFound) },
  ];
}

/** A place in a few words: "this browser", "the folder Inlays", "the server". */
export function placeName(id: Home): string {
  return id === "browser" ? "this browser" : id === "server" ? "the server" : kept ? `the folder ${kept.name}` : "a folder";
}

/** Where everything is kept, for the foot of a list. */
export function keptText(id: Home): string {
  return id === "server" ? "Kept on this server, for everyone who opens it." : id === "folder" ? `Kept in ${placeName(id)}, on this computer.` : "Kept in this browser, for all your projects.";
}

/** Asks for a folder, from a click. Gives false when none was picked. The page starts again when the folder in use is another one now. */
export async function pickFolder(): Promise<boolean> {
  let handle: Handle;
  try {
    handle = await (window as unknown as { showDirectoryPicker(options: object): Promise<Handle> }).showDirectoryPicker({ mode: "readwrite", id: "inlay-cam" });
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") return false;
    throw e;
  }
  // The same folder picked again is the same place: what is remembered of it, and of its syncs, stays.
  const same = kept ? await kept.handle.isSameEntry(handle).catch(() => false) : false;
  const next: KeptFolder = { handle, name: handle.name, key: same ? kept!.key : crypto.randomUUID() };
  await keep.keep(FOLDER, next);
  if (found === "folder") {
    // What is open was read from the other folder: nothing more is written from this page.
    restart();
    return true;
  }
  kept = next;
  granted = await permitted(handle);
  store = null;
  changed();
  return true;
}

/** Asks to use the folder again, from a click. */
export async function reconnectFolder(): Promise<boolean> {
  if (!kept) return false;
  granted = await request(kept.handle);
  changed();
  return granted;
}

/** Looks again whether the folder may be used: the browser can take that back. */
export async function refreshPlaces(): Promise<void> {
  if (!kept || found === "folder") return;
  const now = await permitted(kept.handle);
  if (now !== granted) {
    granted = now;
    changed();
  }
}

function restart() {
  try {
    // The project this tab had open is one of the place left (address.ts).
    sessionStorage.removeItem("inlay.tabProject");
  } catch {
    // Without storage there is none to forget.
  }
  location.hash = "#/settings/storage";
  location.reload();
}

/** Makes a place the one in use, and starts the page again on it. */
export function switchPlace(id: Home): void {
  try {
    localStorage.setItem(CHOICE, id);
  } catch {
    throw new Error("This browser keeps no choices, so the place cannot be changed.");
  }
  restart();
}

/** Starts the page again, as after a sync that wrote to the place in use. */
export function reloadPage(): void {
  location.reload();
}

/** A place as syncing uses it. */
export function storeOf(id: Home): Store {
  if (id === "folder") {
    const folder = folderStore();
    return {
      ...folder,
      putSetting: async (key, value, at) => {
        // A tool list written over by a sync is kept, as the server keeps the one it replaces.
        if (key === "tools" && (await folder.getSetting(key)) !== value) await folder.setToolsAside();
        await folder.putSetting(key, value, at);
      },
    };
  }
  if (id === "browser")
    return {
      ...db,
      putProject: async (project) => {
        await db.putProject(project);
        // Kept without a picture, it keeps the one of the drawing it had: that one goes, and it is drawn again.
        if (project.thumb === undefined) await db.clearThumb(project.id);
      },
    };
  return {
    readShelf: server.readShelf,
    getProject: server.getProject,
    putProject: (project) => server.putProject(project.id, project.text, undefined, project.folder),
    moveProject: server.moveProject,
    deleteProject: server.deleteProject,
    getSetting: async (key) => (key === "tools" ? (await server.readLibrary())?.text : server.getSetting(key)),
    settingSaved: async (key) => (key === "tools" ? (await server.readLibrary())?.savedAt : server.settingSaved(key)),
    putSetting: async (key, value, at) => {
      if (key !== "tools") return server.putSetting(key, value, at);
      const now = await server.readLibrary();
      if (!now) throw new Error("the server gave no tool list to write over");
      if ((await server.writeLibrary(value, now.token)) === "conflict") throw new Error("the tool list was changed on the server at the same moment: compare again");
    },
  };
}

function syncName(id: Home): string {
  return id === "folder" ? `folder:${kept?.key}` : id;
}

/** How two places stood when they were last synced, `a` first. */
export async function readBase(a: Home, b: Home): Promise<Base> {
  const [x, y] = [syncName(a), syncName(b)];
  const base = (await keep.recall<Base>(`sync:${[x, y].sort().join("|")}`)) ?? {};
  return x <= y ? base : turned(base);
}

export async function writeBase(a: Home, b: Home, base: Base): Promise<void> {
  const [x, y] = [syncName(a), syncName(b)];
  await keep.keep(`sync:${[x, y].sort().join("|")}`, x <= y ? base : turned(base));
}
