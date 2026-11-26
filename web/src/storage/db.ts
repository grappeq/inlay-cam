// Browser storage (IndexedDB). Projects and the tool list are stored as the
// same file text that export writes, so data kept in the browser goes through
// the same version migration as an imported file when it is loaded.

import { allFolders, createFolderIn, deleteFolderIn, isFolderPath, renameFolderIn, resolveFolder } from "../state/folders";

const DB_NAME = "wooden-inlays";
const DB_VERSION = 1;
const PROJECTS = "projects";
const SETTINGS = "settings";

/** A small picture of a project's drawing: the stock is `w` by `h`, the shapes on it the SVG path `d`, Y down. */
export interface Thumb {
  w: number;
  h: number;
  d: string;
}

export interface StoredProject {
  id: string;
  name: string;
  /** Milliseconds since 1970. */
  modified: number;
  /** Project file text. */
  text: string;
  /** The folder it is filed in, with `/` between nested ones. Missing or empty: none. It is beside the text, not in it: filing a project does not change it. */
  folder?: string;
  /** How many steps it has, for the list of projects. Missing on one kept before folders were. */
  steps?: number;
  /** A picture of its drawing, for the list of projects: null for none. Missing on one kept before there were pictures, and on one put without it, which keeps the one it had. */
  thumb?: Thumb | null;
}

export type ProjectSummary = Omit<StoredProject, "text" | "folder"> & { folder: string };

/** The projects kept, last changed first, and the folders they are filed in. */
export interface Shelf {
  projects: ProjectSummary[];
  folders: string[];
}

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Browser storage is not available"));
  });
  return opening;
}

async function run<T>(store: string, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = work(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error ?? new Error("Browser storage failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Browser storage failed"));
  });
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const all = await run<StoredProject[]>(PROJECTS, "readonly", (s) => s.getAll());
  return all.map(({ id, name, modified, folder, steps, thumb }) => ({ id, name, modified, folder: folder ?? "", steps, thumb })).sort((a, b) => b.modified - a.modified);
}

/** The folders as they were last written: the empty ones are only here. */
async function listedFolders(): Promise<string[]> {
  try {
    const value = JSON.parse((await getSetting("projectFolders")) ?? "[]");
    return Array.isArray(value) ? value.filter((path) => typeof path === "string") : [];
  } catch {
    return [];
  }
}

export async function readShelf(): Promise<Shelf> {
  const projects = await listProjects();
  return { projects, folders: allFolders(await listedFolders(), projects) };
}

export function getProject(id: string): Promise<StoredProject | undefined> {
  return run<StoredProject | undefined>(PROJECTS, "readonly", (s) => s.get(id));
}

/** Keeps a project. One that is kept already stays in the folder it is in, whatever `folder` says: that is where a new one goes. */
export async function putProject(project: StoredProject): Promise<void> {
  // A folder that could not be one is no folder: the project is kept all the same.
  const asked = project.folder && isFolderPath(project.folder) ? project.folder : "";
  const folders = asked ? await folderList() : [];
  await change(PROJECTS, (store) => {
    const read = store.get(project.id);
    read.onsuccess = () => {
      const kept = read.result as StoredProject | undefined;
      const folder = kept ? (kept.folder ?? "") : resolveFolder(folders, asked);
      store.put({ ...project, folder, steps: project.steps ?? kept?.steps, thumb: project.thumb !== undefined ? project.thumb : kept?.thumb });
    };
  });
  // A folder first named by a project is listed, so that it stays when the project leaves it.
  if (asked) await keepFolders(await folderList());
}

/** Gives a kept project its picture, unless it was changed since `modified`: the picture would be of a drawing it no longer has. */
export async function setThumb(id: string, thumb: Thumb | null, modified: number): Promise<void> {
  await change(PROJECTS, (store) => {
    const read = store.get(id);
    read.onsuccess = () => {
      const kept = read.result as StoredProject | undefined;
      if (kept && kept.modified === modified) store.put({ ...kept, thumb });
    };
  });
}

/** Takes a kept project's picture away, so that it is drawn again: the one it has is of a drawing it no longer has. */
export async function clearThumb(id: string): Promise<void> {
  await change(PROJECTS, (store) => {
    const read = store.get(id);
    read.onsuccess = () => {
      const kept = read.result as StoredProject | undefined;
      if (!kept || kept.thumb === undefined) return;
      const { thumb: _gone, ...rest } = kept;
      store.put(rest);
    };
  });
}

export async function deleteProject(id: string): Promise<void> {
  await run(PROJECTS, "readwrite", (s) => s.delete(id));
}

/** One transaction over a store, in which `work` may read and then write. */
async function change(store: string, work: (s: IDBObjectStore) => void): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Browser storage failed"));
    tx.onabort = () => reject(tx.error ?? new Error("Browser storage failed"));
    work(tx.objectStore(store));
  });
}

/** Sets the folder of every project `to` gives another one for. */
async function refile(to: (folder: string) => string): Promise<number> {
  let moved = 0;
  await change(PROJECTS, (store) => {
    const walk = store.openCursor();
    walk.onsuccess = () => {
      const at = walk.result;
      if (!at) return;
      const kept = at.value as StoredProject;
      const folder = to(kept.folder ?? "");
      if (folder !== (kept.folder ?? "")) {
        at.update({ ...kept, folder });
        moved++;
      }
      at.continue();
    };
  });
  return moved;
}

async function folderList(): Promise<string[]> {
  return (await readShelf()).folders;
}

async function keepFolders(folders: string[]): Promise<void> {
  await putSetting("projectFolders", JSON.stringify(folders));
}

/** Files a project in another folder, or in none. Its text and the time it was changed stay. Gives the folder as it is spelt. */
export async function moveProject(id: string, folder: string): Promise<string> {
  if (folder && !isFolderPath(folder)) throw new Error(`"${folder}" cannot be a folder.`);
  const folders = await folderList();
  const to = resolveFolder(folders, folder);
  let found = false;
  await change(PROJECTS, (store) => {
    const read = store.get(id);
    read.onsuccess = () => {
      const kept = read.result as StoredProject | undefined;
      if (!kept) return;
      found = true;
      if ((kept.folder ?? "") !== to) store.put({ ...kept, folder: to });
    };
  });
  if (!found) throw new Error("That project is no longer kept.");
  await keepFolders(allFolders([...folders, to]));
  return to;
}

export async function createFolder(path: string): Promise<string> {
  const made = createFolderIn(await folderList(), path);
  await keepFolders(made.folders);
  return made.folder;
}

/** Renames a folder, or moves it into another: `to` is its whole new path. The projects in it go along. */
export async function renameFolder(from: string, to: string): Promise<string> {
  const renamed = renameFolderIn(await folderList(), from, to);
  await refile(renamed.move);
  await keepFolders(renamed.folders);
  return renamed.folder;
}

/** Takes a folder away, and the folders in it. Their projects stay, in no folder. Gives how many were moved out. */
export async function deleteFolder(path: string): Promise<number> {
  const gone = deleteFolderIn(await folderList(), path);
  const moved = await refile((folder) => (folder && gone.held(folder) ? "" : folder));
  await keepFolders(gone.folders);
  return moved;
}

export type SettingKey = "tools" | "lastProjectId" | "machine" | "inlayDefaults" | "projectFolders";

export function getSetting(key: SettingKey): Promise<string | undefined> {
  return run<string | undefined>(SETTINGS, "readonly", (s) => s.get(key));
}

export async function putSetting(key: SettingKey, value: string): Promise<void> {
  await run(SETTINGS, "readwrite", (s) => s.put(value, key));
}
