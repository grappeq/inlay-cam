// Where the app keeps things: the tool list, projects, the machine, the
// inlay defaults and what the screens remember. It is one place or the
// other, never a mix. Served by inlay-server, everything is kept on the
// server, for every browser that opens it; on a plain web host, everything
// is kept in this browser.
//
// The tool list on a server has its own two calls in server.ts, since its
// writes are checked against the version they changed.

import * as db from "./db";
import * as server from "./server";

export type { ProjectSummary, Shelf, StoredProject } from "./db";
export type Home = "browser" | "server";
/** What is kept besides tools and projects. `tools` is the tool list in a browser; `view` what the screens remember on a server. */
export type SettingKey = db.SettingKey | "view";

let finding: Promise<Home> | null = null;
let found: Home = "browser";

/** Finds out, once, where things are kept. Everything else here waits for it. */
export function findHome(): Promise<Home> {
  finding ??= server.findServer().then((yes) => (found = yes ? "server" : "browser"));
  return finding;
}

/** Where things are kept, once `findHome` has answered. */
export function home(): Home {
  return found;
}

/** The projects kept, last changed first, and the folders they are filed in, empty ones too. */
export async function readShelf(): Promise<db.Shelf> {
  return (await findHome()) === "server" ? server.readShelf() : db.readShelf();
}

export async function listProjects(): Promise<db.ProjectSummary[]> {
  return (await readShelf()).projects;
}

/** Files a project in another folder, or in none (the empty path). Neither its text nor the time it was changed is touched. Gives the folder as it is spelt. */
export async function moveProject(id: string, folder: string): Promise<string> {
  return (await findHome()) === "server" ? server.moveProject(id, folder) : db.moveProject(id, folder);
}

/** Makes a folder, and the ones it is in. Gives its path as it is spelt. */
export async function createFolder(path: string): Promise<string> {
  return (await findHome()) === "server" ? server.createFolder(path) : db.createFolder(path);
}

/** Renames a folder, or moves it into another: `to` is its whole new path. What is in it goes along. */
export async function renameFolder(from: string, to: string): Promise<string> {
  return (await findHome()) === "server" ? server.renameFolder(from, to) : db.renameFolder(from, to);
}

/** Takes a folder away, and the folders in it. Their projects stay, in no folder. Gives how many were moved out. */
export async function deleteFolder(path: string): Promise<number> {
  return (await findHome()) === "server" ? server.deleteFolder(path) : db.deleteFolder(path);
}

/** A kept project. On a server, `token` names the version read. */
export async function getProject(id: string): Promise<(db.StoredProject & { token?: string }) | undefined> {
  return (await findHome()) === "server" ? server.getProject(id) : db.getProject(id);
}

/**
 * Keeps a project. On a server, `basedOn` is the token of the version this
 * page read: the write is refused with "conflict" when the project was
 * saved from elsewhere since. Gives the token of the version kept, on a server.
 * `project.folder` is where a project that is not kept yet goes; one that
 * is kept stays in the folder it is in.
 */
export async function putProject(project: db.StoredProject, basedOn?: string): Promise<string | undefined | "conflict"> {
  if ((await findHome()) === "server") return server.putProject(project.id, project.text, basedOn, project.folder);
  await db.putProject(project);
  return undefined;
}

export async function deleteProject(id: string): Promise<void> {
  return (await findHome()) === "server" ? server.deleteProject(id) : db.deleteProject(id);
}

export async function getSetting(key: SettingKey): Promise<string | undefined> {
  if ((await findHome()) === "server") return server.getSetting(key);
  return key === "view" ? undefined : db.getSetting(key);
}

export async function putSetting(key: SettingKey, value: string): Promise<void> {
  if ((await findHome()) === "server") return server.putSetting(key, value);
  if (key !== "view") return db.putSetting(key, value);
}
