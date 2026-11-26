// Where the app keeps things: the tool list, projects, the machine, the
// inlay defaults and what the screens remember. It is one place at a time,
// never a mix: this browser, a folder on this computer, or the server the
// page came from (places.ts says which, and how it is chosen). The other
// places are there to sync with, under Settings, Storage.
//
// The tool list on a server has its own two calls in server.ts, since its
// writes are checked against the version they changed. In a browser and in
// a folder it is the setting `tools`.

import * as db from "./db";
import { findHome, folderStore, home, type Home } from "./places";
import * as server from "./server";

export type { ProjectSummary, Shelf, StoredProject, Thumb } from "./db";
export type { Home } from "./places";
export { findHome, home };
/** What is kept besides tools and projects. `tools` is the tool list in a browser and in a folder; `view` what the screens remember on a server. */
export type SettingKey = db.SettingKey | "view";

/** The place in use, where it is not the server: the two keep things through the same calls. */
async function local(): Promise<typeof db | ReturnType<typeof folderStore> | null> {
  const at: Home = await findHome();
  return at === "server" ? null : at === "folder" ? folderStore() : db;
}

/** The projects kept, last changed first, and the folders they are filed in, empty ones too. */
export async function readShelf(): Promise<db.Shelf> {
  return (await local())?.readShelf() ?? server.readShelf();
}

export async function listProjects(): Promise<db.ProjectSummary[]> {
  return (await readShelf()).projects;
}

/** Files a project in another folder, or in none (the empty path). Neither its text nor the time it was changed is touched. Gives the folder as it is spelt. */
export async function moveProject(id: string, folder: string): Promise<string> {
  return (await local())?.moveProject(id, folder) ?? server.moveProject(id, folder);
}

/** Makes a folder, and the ones it is in. Gives its path as it is spelt. */
export async function createFolder(path: string): Promise<string> {
  return (await local())?.createFolder(path) ?? server.createFolder(path);
}

/** Renames a folder, or moves it into another: `to` is its whole new path. What is in it goes along. */
export async function renameFolder(from: string, to: string): Promise<string> {
  return (await local())?.renameFolder(from, to) ?? server.renameFolder(from, to);
}

/** Takes a folder away, and the folders in it. Their projects stay, in no folder. Gives how many were moved out. */
export async function deleteFolder(path: string): Promise<number> {
  return (await local())?.deleteFolder(path) ?? server.deleteFolder(path);
}

/** A kept project. On a server, `token` names the version read. */
export async function getProject(id: string): Promise<(db.StoredProject & { token?: string }) | undefined> {
  const at = await local();
  return at ? at.getProject(id) : server.getProject(id);
}

/**
 * Keeps a project. On a server, `basedOn` is the token of the version this
 * page read: the write is refused with "conflict" when the project was
 * saved from elsewhere since. Gives the token of the version kept, on a server.
 * `project.folder` is where a project that is not kept yet goes; one that
 * is kept stays in the folder it is in.
 */
export async function putProject(project: db.StoredProject, basedOn?: string): Promise<string | undefined | "conflict"> {
  const at = await local();
  if (!at) return server.putProject(project.id, project.text, basedOn, project.folder);
  await at.putProject(project);
  return undefined;
}

/** Gives a project kept in this browser or in a folder the picture it was kept without. A server makes its own. */
export async function fillThumb(id: string, thumb: db.Thumb | null, modified: number): Promise<void> {
  await (await local())?.setThumb(id, thumb, modified);
}

export async function deleteProject(id: string): Promise<void> {
  return (await local())?.deleteProject(id) ?? server.deleteProject(id);
}

export async function getSetting(key: SettingKey): Promise<string | undefined> {
  const at = await local();
  if (!at) return server.getSetting(key);
  return key === "view" ? undefined : at.getSetting(key);
}

export async function putSetting(key: SettingKey, value: string): Promise<void> {
  const at = await local();
  if (!at) return server.putSetting(key, value);
  if (key !== "view") return at.putSetting(key, value);
}
