// A folder on this computer as the place things are kept in, through the
// browser's File System Access API. It is laid out as inlay-server's data
// folder is (store.rs), and follows its rules, so that one folder can be
// read by both: `tools.json`, `settings.json` with one text per key,
// `projects/` with one file per project, named by its id, in the folders
// the user files them in, and `backups/` for what was deleted.
//
// What is here works on the few calls of a directory handle that it needs
// (`Dir`), so that it is tested against folders in memory.

import { allFolders, createFolderIn, deleteFolderIn, isFolderPath, folderNameProblem, joinFolder, parentOf, renameFolderIn, resolveFolder, within } from "../state/folders";
import type { ProjectSummary, Shelf, StoredProject, Thumb } from "./db";

export interface FileNode {
  kind: "file";
  name: string;
  getFile(): Promise<{ text(): Promise<string>; lastModified: number; size: number }>;
  createWritable(): Promise<{ write(text: string): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }>;
}

export interface Dir {
  kind: "directory";
  name: string;
  entries(): AsyncIterable<[string, FileNode | Dir]>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<Dir>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileNode>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

/** What was read of a project's file, so that the list of projects does not read every file every time. */
export interface Seen {
  modified: number;
  size: number;
  name: string;
  steps: number;
  /** Missing until it is drawn. */
  thumb?: Thumb | null;
}

/** Where what was read is remembered from one visit to the next. */
export interface Memo {
  read(): Promise<Record<string, Seen> | undefined>;
  write(seen: Record<string, Seen>): Promise<void>;
}

const TOOLS = "tools.json";
const SETTINGS = "settings.json";
const PROJECTS = "projects";
const BACKUPS = "backups";
const MAX_DEPTH = 4;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Whether an id can name a project's file, as the server has it. */
export function isProjectId(id: string): boolean {
  return ID.test(id);
}

/** A file a system leaves in a folder by itself: nothing a folder has to be kept for. */
function isLitter(name: string): boolean {
  return [".ds_store", "thumbs.db", "desktop.ini"].includes(name.toLowerCase()) || name.endsWith(".json.writing") || name.endsWith(".crswap");
}

function named(e: unknown, ...names: string[]): boolean {
  return typeof e === "object" && e !== null && names.includes((e as { name?: string }).name ?? "");
}

/** The name and the steps of a project, read from its file as plain JSON, so that one of an older format is listed without being upgraded. */
export function summaryOf(text: string): { name: string; steps: number; blank: boolean } {
  try {
    const project = JSON.parse(text)?.project;
    const steps = project?.steps ?? project?.jobs;
    return {
      name: typeof project?.name === "string" ? project.name : "",
      steps: Array.isArray(steps) ? steps.length : 0,
      blank: project !== undefined && project !== null && project.design === null,
    };
  } catch {
    return { name: "", steps: 0, blank: false };
  }
}

/** `20261118-091203-007`, UTC, as the server stamps what it sets aside. */
function stamp(at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${at.getUTCFullYear()}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}-${two(at.getUTCHours())}${two(at.getUTCMinutes())}${two(at.getUTCSeconds())}-${String(at.getUTCMilliseconds()).padStart(3, "0")}`;
}

interface Found {
  folder: string;
  id: string;
  file: FileNode;
}

export type FolderStore = ReturnType<typeof openFolder>;

/** The folder `root` as a place things are kept in. */
/** The settings of settings.json whose last change is dated under `saved` there: the ones synced between places. */
const DATED = ["machine", "inlayDefaults"];
const SAVED = "saved";

function datesOf(all: Record<string, unknown>): Record<string, unknown> {
  const saved = all[SAVED];
  return saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
}

export function openFolder(root: Dir, memo?: Memo) {
  let seen: Record<string, Seen> | null = null;
  // Where each project was when the folder was last gone through.
  let where = new Map<string, string>();
  // One thing at a time, as the server does behind its lock: a save and a move of one project, or two
  // changes of settings.json, do not cross.
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn =
    <A extends unknown[], T>(work: (...args: A) => Promise<T>) =>
    (...args: A): Promise<T> => {
      const done = turn.catch(() => undefined).then(() => work(...args));
      turn = done;
      return done;
    };

  async function remembered(): Promise<Record<string, Seen>> {
    seen ??= (await memo?.read().catch(() => undefined)) ?? {};
    return seen;
  }
  async function remember(): Promise<void> {
    if (seen) await memo?.write(seen).catch(() => undefined);
  }

  /** The folder a path names; null when it is not there. With `create`, it is made, and the ones it is in. */
  async function dirOf(path: string, create = false): Promise<Dir | null> {
    let dir = root;
    for (const name of [PROJECTS, ...path.split("/").filter(Boolean)]) {
      try {
        dir = await dir.getDirectoryHandle(name, { create });
      } catch (e) {
        if (!create && named(e, "NotFoundError", "TypeMismatchError")) return null;
        throw e;
      }
    }
    return dir;
  }

  /**
   * What is under `projects/`: the folders, and the project files. A folder
   * before the ones in it, both in the order of their names, and of two
   * files with one id the first. What the app could not have made is
   * passed over.
   */
  async function walk(): Promise<{ folders: string[]; files: Found[] }> {
    const folders: string[] = [];
    const files: Found[] = [];
    const into = async (dir: Dir, folder: string, depth: number): Promise<void> => {
      const inner: [string, Dir][] = [];
      const own: Found[] = [];
      try {
        for await (const [name, node] of dir.entries()) {
          if (node.kind === "directory") {
            if (depth < MAX_DEPTH && folderNameProblem(name) === null) inner.push([name, node]);
          } else if (name.endsWith(".json") && isProjectId(name.slice(0, -5))) {
            own.push({ folder, id: name.slice(0, -5), file: node });
          }
        }
      } catch (e) {
        // One folder that cannot be read does not hide the rest.
        if (depth === 0) throw e;
        return;
      }
      const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      files.push(...own.sort((a, b) => order(a.id, b.id)));
      for (const [name, node] of inner.sort((a, b) => order(a[0], b[0]))) {
        const path = joinFolder(folder, name);
        folders.push(path);
        await into(node, path, depth + 1);
      }
    };
    const top = await dirOf("");
    if (top) await into(top, "", 0);
    const ids = new Set<string>();
    const first = files.filter((f) => !ids.has(f.id) && ids.add(f.id));
    where = new Map(first.map((f) => [f.id, f.folder]));
    return { folders: allFolders(folders), files: first };
  }

  async function fileAt(folder: string, id: string): Promise<FileNode | null> {
    const dir = await dirOf(folder);
    if (!dir) return null;
    try {
      return await dir.getFileHandle(`${id}.json`);
    } catch (e) {
      if (named(e, "NotFoundError", "TypeMismatchError")) return null;
      throw e;
    }
  }

  /** A project's file: where it was last seen, else wherever it is now. */
  async function locate(id: string): Promise<Found | null> {
    if (!isProjectId(id)) return null;
    const last = where.get(id);
    if (last !== undefined) {
      const file = await fileAt(last, id);
      if (file) return { folder: last, id, file };
    }
    return (await walk()).files.find((f) => f.id === id) ?? null;
  }

  async function write(dir: Dir, name: string, text: string): Promise<FileNode> {
    const file = await dir.getFileHandle(name, { create: true });
    const out = await file.createWritable();
    try {
      await out.write(text);
      await out.close();
    } catch (e) {
      // Let go of, so that the file is not left locked for the next write.
      await out.abort?.().catch(() => undefined);
      throw e;
    }
    return file;
  }

  /** Notes a project's file as it is now. */
  async function note(id: string, file: FileNode, text: string, given: { steps?: number; thumb?: Thumb | null }): Promise<void> {
    const all = await remembered();
    const { lastModified, size } = await file.getFile();
    const summary = summaryOf(text);
    all[id] = { modified: lastModified, size, name: summary.name, steps: given.steps ?? summary.steps, thumb: given.thumb !== undefined ? given.thumb : summary.blank ? null : undefined };
  }

  async function readShelf(): Promise<Shelf> {
    const { folders, files } = await walk();
    const all = await remembered();
    let changed = false;
    const projects: ProjectSummary[] = [];
    for (const { id, folder, file } of files) {
      try {
        const at = await file.getFile();
        let had = all[id];
        if (!had || had.modified !== at.lastModified || had.size !== at.size) {
          const summary = summaryOf(await at.text());
          had = all[id] = { modified: at.lastModified, size: at.size, name: summary.name, steps: summary.steps, thumb: summary.blank ? null : undefined };
          changed = true;
        }
        projects.push({ id, name: had.name, modified: had.modified, folder, steps: had.steps, thumb: had.thumb });
      } catch {
        // Gone, or not readable, since the folder was gone through: not listed.
      }
    }
    for (const id of Object.keys(all)) {
      if (!where.has(id)) {
        delete all[id];
        changed = true;
      }
    }
    if (changed) await remember();
    return { projects: projects.sort((a, b) => b.modified - a.modified), folders };
  }

  async function getProject(id: string): Promise<StoredProject | undefined> {
    const found = await locate(id);
    if (!found) return undefined;
    const at = await found.file.getFile();
    const text = await at.text();
    return { id, name: summaryOf(text).name, modified: at.lastModified, text, folder: found.folder };
  }

  /** Keeps a project. One that is kept already stays in the folder it is in, whatever `folder` says: that is where a new one goes. */
  async function putProject(project: StoredProject): Promise<void> {
    if (!isProjectId(project.id)) throw new Error(`"${project.id}" cannot name a project's file.`);
    let found = await locate(project.id);
    if (!found) {
      const { folders, files } = await walk();
      // On some disks a3.json and A3.json are one file.
      const twin = files.find((f) => f.id.toLowerCase() === project.id.toLowerCase());
      if (twin) throw new Error(`A project is kept as ${twin.id}.json already: on some disks that is the same file.`);
      const asked = project.folder && isFolderPath(project.folder) ? project.folder : "";
      const folder = resolveFolder(folders, asked);
      const file = await write((await dirOf(folder, true))!, `${project.id}.json`, project.text);
      found = { folder, id: project.id, file };
    } else {
      await write((await dirOf(found.folder, true))!, `${project.id}.json`, project.text);
    }
    where.set(project.id, found.folder);
    await note(project.id, found.file, project.text, project);
    await remember();
  }

  /** Gives a kept project its picture, unless it was changed since `modified`. */
  async function setThumb(id: string, thumb: Thumb | null, modified: number): Promise<void> {
    const all = await remembered();
    if (all[id]?.modified !== modified) return;
    all[id] = { ...all[id], thumb };
    await remember();
  }

  /** Puts a project's file in another folder: written there, then taken away here. */
  async function refile(from: Found, to: string): Promise<void> {
    const at = await from.file.getFile();
    const text = await at.text();
    const target = (await dirOf(to, true))!;
    const file = await write(target, `${from.id}.json`, text);
    const source = await dirOf(from.folder);
    await source?.removeEntry(`${from.id}.json`);
    where.set(from.id, to);
    // Its picture goes along, unless the file was changed since it was drawn.
    const had = (await remembered())[from.id];
    const fresh = had && had.modified === at.lastModified && had.size === at.size;
    await note(from.id, file, text, fresh ? { steps: had.steps, thumb: had.thumb } : {});
  }

  /** Files a project in another folder, or in none. Gives the folder as it is spelt. */
  async function moveProject(id: string, folder: string): Promise<string> {
    if (folder && !isFolderPath(folder)) throw new Error(`"${folder}" cannot be a folder.`);
    const found = await locate(id);
    if (!found) throw new Error("That project is no longer kept.");
    const to = resolveFolder((await walk()).folders, folder);
    if (to.toLowerCase() === found.folder.toLowerCase()) return found.folder;
    if (await fileAt(to, id)) throw new Error(`A file named ${id}.json is in that folder already.`);
    await refile(found, to);
    await remember();
    return to;
  }

  /** Takes a project off the list: its file goes to `backups/`. */
  async function deleteProject(id: string): Promise<void> {
    const found = await locate(id);
    if (!found) return;
    const text = await (await found.file.getFile()).text();
    await write(await root.getDirectoryHandle(BACKUPS, { create: true }), `project-${stamp(new Date())}-${id}.json`, text);
    await (await dirOf(found.folder))?.removeEntry(`${id}.json`);
    where.delete(id);
    delete (await remembered())[id];
    await remember();
  }

  async function createFolder(path: string): Promise<string> {
    const made = createFolderIn((await walk()).folders, path);
    await dirOf(made.folder, true);
    return made.folder;
  }

  /** Takes folders away, the ones in others first, each only when nothing but litter is left in it. */
  async function clear(paths: string[]): Promise<void> {
    for (const path of [...paths].sort((a, b) => b.length - a.length)) {
      const dir = await dirOf(path);
      const parent = await dirOf(parentOf(path));
      if (!dir || !parent) continue;
      try {
        const names: string[] = [];
        for await (const [name] of dir.entries()) names.push(name);
        if (!names.every(isLitter)) continue;
        for (const name of names) await dir.removeEntry(name);
        await parent.removeEntry(path.slice(path.lastIndexOf("/") + 1));
      } catch {
        // It holds something the app did not put there, or cannot be changed: it stays.
      }
    }
  }

  /** Renames a folder, or moves it into another: `to` is its whole new path. What is in it goes along. */
  async function renameFolder(from: string, to: string): Promise<string> {
    const { folders, files } = await walk();
    const renamed = renameFolderIn(folders, from, to);
    const source = resolveFolder(folders, from);
    if (renamed.folder === source) return source;
    // A folder cannot be renamed through the browser, only made again: where the two names are one folder, there is nothing to make.
    if (renamed.folder.toLowerCase() === source.toLowerCase()) throw new Error("A folder kept on this computer cannot be renamed to the same name in other letters' case.");
    const old = folders.filter((path) => within(path, source));
    for (const path of old) await dirOf(renamed.move(path), true);
    for (const found of files.filter((f) => within(f.folder, source))) await refile(found, renamed.move(found.folder));
    await clear(old);
    await remember();
    return renamed.folder;
  }

  /** Takes a folder away, and the folders in it. Their projects stay, in no folder. Gives how many were moved out. */
  async function deleteFolder(path: string): Promise<number> {
    const { folders, files } = await walk();
    const gone = deleteFolderIn(folders, path);
    const inside = files.filter((f) => f.folder && gone.held(f.folder));
    for (const found of inside) await refile(found, "");
    await clear(folders.filter(gone.held));
    await remember();
    return inside.length;
  }

  async function textOf(name: string): Promise<string | undefined> {
    try {
      return await (await (await root.getFileHandle(name)).getFile()).text();
    } catch (e) {
      if (named(e, "NotFoundError", "TypeMismatchError")) return undefined;
      throw e;
    }
  }

  /** settings.json as it is; `spoilt` when it is there and is not what the app writes. */
  async function settings(): Promise<{ all: Record<string, unknown>; spoilt: string | null }> {
    const text = await textOf(SETTINGS);
    if (text === undefined) return { all: {}, spoilt: null };
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) return { all: value, spoilt: null };
    } catch {
      // Not JSON.
    }
    return { all: {}, spoilt: text };
  }

  /** `tools` is the tool list, a file of its own; the rest are the texts of settings.json. */
  async function getSetting(key: string): Promise<string | undefined> {
    if (key === "tools") return textOf(TOOLS);
    const value = (await settings()).all[key];
    return typeof value === "string" ? value : undefined;
  }

  /**
   * When a synced setting was last changed: of the tool list the date of its file, of the others what
   * `saved` in settings.json says, as inlay-server writes it.
   */
  async function settingSaved(key: string): Promise<number | undefined> {
    if (key === "tools") {
      try {
        return (await (await root.getFileHandle(TOOLS)).getFile()).lastModified;
      } catch (e) {
        if (named(e, "NotFoundError", "TypeMismatchError")) return undefined;
        throw e;
      }
    }
    const at = datesOf((await settings()).all)[key];
    return typeof at === "number" ? at : undefined;
  }

  /** `at`: when it was changed where it is copied from. The tool list is dated by its file, whenever it is written. */
  async function putSetting(key: string, value: string, at?: number): Promise<void> {
    if (key === "tools") {
      // Kept again as it is, it is not written: the date of its file is when it last changed.
      if ((await textOf(TOOLS)) !== value) await write(root, TOOLS, value);
      return;
    }
    const { all, spoilt } = await settings();
    if (DATED.includes(key) && all[key] !== value) all[SAVED] = { ...datesOf(all), [key]: at ?? Date.now() };
    // One that cannot be read is set aside, so that settings can be kept again.
    if (spoilt !== null) await write(await root.getDirectoryHandle(BACKUPS, { create: true }), `settings-${stamp(new Date())}.json`, spoilt);
    await write(root, SETTINGS, JSON.stringify({ ...all, [key]: value }));
  }

  /** Keeps the tool list as it is in `backups/`, before something other than the app's own saving writes over it. */
  async function setToolsAside(): Promise<void> {
    const text = await textOf(TOOLS);
    if (text !== undefined) await write(await root.getDirectoryHandle(BACKUPS, { create: true }), `tools-${stamp(new Date())}.json`, text);
  }

  return {
    setToolsAside: inTurn(setToolsAside),
    readShelf: inTurn(readShelf),
    getProject: inTurn(getProject),
    putProject: inTurn(putProject),
    setThumb: inTurn(setThumb),
    moveProject: inTurn(moveProject),
    deleteProject: inTurn(deleteProject),
    createFolder: inTurn(createFolder),
    renameFolder: inTurn(renameFolder),
    deleteFolder: inTurn(deleteFolder),
    getSetting: inTurn(getSetting),
    settingSaved: inTurn(settingSaved),
    putSetting: inTurn(putSetting),
  };
}
