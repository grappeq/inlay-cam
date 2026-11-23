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
  /** The projects in it, not those of the folders in it: what it shows when it is opened. */
  count: number;
  /** How many folders are right in it. */
  folders: number;
}

/** The folders as they are listed, each with how many projects and folders are right in it. */
export function folderRows(folders: string[], projects: { folder: string }[]): FolderRow[] {
  return folders.map((path) => ({
    path,
    name: nameOf(path),
    depth: depthOf(path) - 1,
    count: projects.filter((p) => p.folder === path).length,
    folders: folders.filter((other) => parentOf(other) === path).length,
  }));
}

/** The rows of the list of folders that are seen: none in a folder that is folded up, or in one in it. */
export function unfoldedRows(rows: FolderRow[], folded: string[]): FolderRow[] {
  return rows.filter((row) => !folded.some((path) => path !== row.path && within(row.path, path)));
}

/** The row that stands for the folder `path` on the left: its own, or, folded away, the one it is folded into. */
export function rowShowing(seen: FolderRow[], path: string): string | undefined {
  return seen.filter((row) => within(path, row.path)).sort((a, b) => b.depth - a.depth)[0]?.path;
}

/** The folded folders with every one that `path` is in unfolded, so that it is seen. */
export function unfoldTo(folded: string[], path: string): string[] {
  const next = folded.filter((other) => !(other !== path && within(path, other)));
  return next.length === folded.length ? folded : next;
}

/** Which projects a list shows: all of them, the ones in no folder, or the ones in a folder. */
export type Scope = { kind: "all" } | { kind: "unfiled" } | { kind: "folder"; path: string };
export type ProjectSort = "modified" | "name";

const wordsOf = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * The projects of a scope whose names hold every word of `query`, in the
 * order asked for. A folder shows the projects right in it; searched, it
 * shows those of the folders in it too.
 */
export function shownProjects(projects: ProjectSummary[], scope: Scope, query: string, sort: ProjectSort): ProjectSummary[] {
  const words = wordsOf(query);
  const inScope = (folder: string) =>
    scope.kind === "all" || (scope.kind === "unfiled" ? folder === "" : words.length > 0 ? within(folder, scope.path) : folder === scope.path);
  const shown = projects.filter((p) => inScope(p.folder) && words.every((word) => (p.name || "Untitled").toLowerCase().includes(word)));
  return shown.sort((a, b) =>
    sort === "name" ? (a.name || "Untitled").localeCompare(b.name || "Untitled", undefined, { sensitivity: "base", numeric: true }) || b.modified - a.modified : b.modified - a.modified,
  );
}

/**
 * The folders a list shows above its projects: those right in the folder
 * shown, by name. Searched, the folders whose names hold every word, in the
 * folder shown or anywhere for all projects.
 */
export function shownFolders(folders: string[], scope: Scope, query: string): string[] {
  const words = wordsOf(query);
  const shown =
    words.length === 0
      ? scope.kind === "folder"
        ? folders.filter((path) => parentOf(path) === scope.path)
        : []
      : scope.kind === "unfiled"
        ? []
        : folders.filter(
            (path) => (scope.kind === "all" || (path !== scope.path && within(path, scope.path))) && words.every((word) => nameOf(path).toLowerCase().includes(word)),
          );
  return shown.sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base", numeric: true }) || a.localeCompare(b));
}

/** What deleting a folder takes away, so that it can be put back: the folders, a folder before the ones in it, and where each project in them was. */
export function heldBy(folders: string[], projects: { id: string; folder: string }[], path: string): { folders: string[]; projects: { id: string; folder: string }[] } {
  return {
    folders: folders.filter((other) => within(other, path)),
    projects: projects.filter((p) => p.folder !== "" && within(p.folder, path)).map(({ id, folder }) => ({ id, folder })),
  };
}

/**
 * What an Undo of a move puts back: each project where it was, unless it is
 * no longer kept or was moved again since, from `to` where the move took it.
 * `now` is where the projects are now. Gives those to put back, and how many
 * are left where they are.
 */
export function undoMove(from: { id: string; folder: string }[], to: string, now: { id: string; folder: string }[]): { back: { id: string; folder: string }[]; left: number } {
  const back = from.filter((place) => now.find((p) => p.id === place.id)?.folder === to);
  return { back, left: from.length - back.length };
}

/** Projects by the folder each goes to, in the order they come. */
export function byFolder(places: { id: string; folder: string }[]): [string, string[]][] {
  const out = new Map<string, string[]>();
  for (const { id, folder } of places) out.set(folder, [...(out.get(folder) ?? []), id]);
  return [...out];
}

/** The folders of `wanted` that are not among `folders`, in their order: what is to be made again. Case does not tell folders apart. */
export function missingFolders(folders: string[], wanted: string[]): string[] {
  const there = new Set(folders.map((path) => path.toLowerCase()));
  return wanted.filter((path) => !there.has(path.toLowerCase()));
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
