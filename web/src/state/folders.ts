// The folders projects are filed in. A folder is its path: names with `/`
// between them, "Gifts/Christmas". The empty path is no folder.
//
// On a server a folder of the app is a folder on its disk, under
// `projects/`, and the server does what is here on that (store.rs, which
// has the same rules). In a browser the folders are a list beside the
// projects, each project says which one it is in, and what is here is all
// there is to them.

import type { ProjectSummary } from "../storage/db";

/** How deep folders go: `a/b/c/d` is the deepest. */
export const MAX_FOLDER_DEPTH = 4;
/** Characters in one folder's name. */
export const MAX_FOLDER_NAME = 60;

const FORBIDDEN = /[/\\:*?"<>|]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Names Windows keeps for devices, whatever follows a dot, and spaces before the dot left out. */
const DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|(com|lpt)[1-9\u00b9\u00b2\u00b3])$/i;
/** Characters that are not seen, or that turn the text around: with them two folders would look like one. */
const UNSEEN = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

/** Why a text cannot be one folder's name, in a few words; null when it can. The rule is that every file system takes it. */
export function folderNameProblem(name: string): string | null {
  if (name.length === 0) return "Give it a name";
  if ([...name].length > MAX_FOLDER_NAME) return `At most ${MAX_FOLDER_NAME} characters`;
  if (name.trim() !== name) return "No space at either end";
  if (FORBIDDEN.test(name) || CONTROL.test(name)) return 'Without / \\ : * ? " < > |';
  if (name.startsWith(".") || name.endsWith(".")) return "No dot at either end";
  if (UNSEEN.test(name)) return "Without characters that are not seen";
  if (DEVICE.test(name.split(".")[0].trimEnd())) return "Windows keeps that name for itself";
  return null;
}

/** Whether a path can name a folder: one to four names, each one `folderNameProblem` passes. */
export function isFolderPath(path: string): boolean {
  const names = path.split("/");
  return names.length <= MAX_FOLDER_DEPTH && names.every((name) => folderNameProblem(name) === null);
}

/** The folder a folder is in; empty for one at the top. */
export function parentOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/** A folder's own name. */
export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinFolder(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** How many names a path has; 0 for no folder. */
export function depthOf(path: string): number {
  return path ? path.split("/").length : 0;
}

/** Whether `path` is `folder` or a folder in it. */
export function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** Two names that differ only in case are one folder: on some disks they are, and elsewhere they would look alike. */
function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Every folder there is: the ones listed, the ones projects are in, and the ones those are in. A folder comes before the ones in it, and folders in the order of their names. */
export function allFolders(listed: string[], projects: { folder?: string }[] = []): string[] {
  const out: string[] = [];
  const add = (path: string) => {
    if (!path || !isFolderPath(path) || out.some((other) => same(other, path))) return;
    add(parentOf(path));
    // Under the folder as it is spelt already, where its parent differs in case.
    const parent = out.find((other) => same(other, parentOf(path))) ?? "";
    out.push(joinFolder(parent, nameOf(path)));
  };
  for (const path of listed) add(path);
  for (const project of projects) add(project.folder ?? "");
  const key = (path: string) => path.split("/").map((name) => name.toLowerCase());
  return out.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return x.length - y.length;
  });
}

/** A path as its folders are spelt already: a folder that is there under a name that differs only in case is the one meant. Names that are not there stay as given. */
export function resolveFolder(folders: string[], path: string): string {
  let out = "";
  for (const name of path.split("/").filter(Boolean)) {
    const wanted = joinFolder(out, name);
    out = folders.find((other) => other === wanted) ?? folders.find((other) => same(other, wanted)) ?? wanted;
  }
  return out;
}

/** The folders with one more, and the ones it is in. Throws when it is there already or cannot be a folder. */
export function createFolderIn(folders: string[], path: string): { folders: string[]; folder: string } {
  if (!isFolderPath(path)) throw new Error(pathProblem(path));
  const folder = resolveFolder(folders, path);
  if (folders.includes(folder)) throw new Error(`There is a folder "${folder}" already.`);
  return { folders: allFolders([...folders, folder]), folder };
}

/**
 * A folder renamed, or moved into another: `to` is its whole new path.
 * Gives the folders afterwards, the folder's path as it is then, and `move`:
 * where a project that was in `folder` is now. Throws for a folder that is
 * not there, a path that is taken, a move into itself, and one that would
 * nest folders deeper than they go.
 */
export function renameFolderIn(folders: string[], from: string, to: string): { folders: string[]; folder: string; move: (folder: string) => string } {
  if (!isFolderPath(to)) throw new Error(pathProblem(to));
  const source = resolveFolder(folders, from);
  if (!folders.includes(source)) throw new Error(`There is no folder "${from}".`);
  if (to.toLowerCase().startsWith(`${source.toLowerCase()}/`)) throw new Error("A folder cannot be moved into itself.");
  // Its own new name is kept as given, so that a rename can change its case.
  const target = joinFolder(resolveFolder(folders, parentOf(to)), nameOf(to));
  const move = (folder: string) => (within(folder, source) ? target + folder.slice(source.length) : folder);
  if (target === source) return { folders, folder: target, move };
  const below = Math.max(0, ...folders.filter((path) => path !== source && within(path, source)).map((path) => depthOf(path) - depthOf(source)));
  if (depthOf(target) + below > MAX_FOLDER_DEPTH) throw new Error("Folders go four deep: this one holds folders that would end up deeper.");
  if (!same(source, target) && folders.some((path) => same(path, target))) throw new Error(`There is a folder "${target}" already.`);
  return { folders: allFolders(folders.map(move)), folder: target, move };
}

/** The folders without one and the ones in it. `held` says whether a folder was among them: its projects go to no folder. */
export function deleteFolderIn(folders: string[], path: string): { folders: string[]; held: (folder: string) => boolean } {
  const folder = resolveFolder(folders, path);
  if (!folders.includes(folder)) throw new Error(`There is no folder "${path}".`);
  const held = (other: string) => within(other, folder);
  return { folders: folders.filter((other) => !held(other)), held };
}

function pathProblem(path: string): string {
  const names = path.split("/");
  if (names.length > MAX_FOLDER_DEPTH) return "Folders go four deep.";
  const problem = names.map(folderNameProblem).find((p) => p !== null);
  return `"${path}" cannot be a folder: ${(problem ?? "it is not a name").toLowerCase()}.`;
}

/** One line of the list of folders. */
export interface FolderRow {
  path: string;
  name: string;
  /** 0 for a folder at the top. */
  depth: number;
  /** The projects in it and in the folders in it. */
  count: number;
}

/** The folders as they are listed, each with how many projects it holds. */
export function folderRows(folders: string[], projects: { folder: string }[]): FolderRow[] {
  return folders.map((path) => ({
    path,
    name: nameOf(path),
    depth: depthOf(path) - 1,
    count: projects.filter((p) => within(p.folder, path)).length,
  }));
}

/** Which projects a list shows: all of them, the ones in no folder, or the ones in a folder and the folders in it. */
export type Scope = { kind: "all" } | { kind: "unfiled" } | { kind: "folder"; path: string };
export type ProjectSort = "modified" | "name";

/** The projects of a scope whose names hold every word of `query`, in the order asked for. */
export function shownProjects(projects: ProjectSummary[], scope: Scope, query: string, sort: ProjectSort): ProjectSummary[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = projects.filter(
    (p) =>
      (scope.kind === "all" || (scope.kind === "unfiled" ? p.folder === "" : within(p.folder, scope.path))) &&
      words.every((word) => (p.name || "Untitled").toLowerCase().includes(word)),
  );
  return shown.sort((a, b) =>
    sort === "name" ? (a.name || "Untitled").localeCompare(b.name || "Untitled", undefined, { sensitivity: "base", numeric: true }) || b.modified - a.modified : b.modified - a.modified,
  );
}

/** The scope to show when the one shown is gone: a folder that was renamed, moved or deleted from somewhere else. */
export function scopeThatIs(scope: Scope, folders: string[]): Scope {
  return scope.kind !== "folder" || folders.includes(scope.path) ? scope : { kind: "all" };
}

// Where a project that is not kept yet goes when it first is: the folder
// that was shown when it was started. Held by the project's id, and kept in
// step with the folders, so that a folder renamed or deleted before the
// project's first save is not made again by that save.
const starts = new Map<string, string>();

/** Says which folder a project that is not kept yet is filed in when it first is. */
export function startIn(id: string, folder: string): void {
  if (folder) starts.set(id, folder);
  else starts.delete(id);
}

/** The folder a project that is not kept yet starts in; undefined when none was said. */
export function startOf(id: string): string | undefined {
  return starts.get(id);
}

/** Forgets where a project starts: it is kept now. */
export function started(id: string): void {
  starts.delete(id);
}

/** Folders were renamed, moved or taken away: `to` gives where what was in a folder is now, the empty path for nowhere. */
export function refileStarts(to: (folder: string) => string): void {
  for (const [id, folder] of starts) startIn(id, to(folder));
}
