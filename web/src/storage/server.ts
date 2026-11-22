// The tool list on a server. When the app is served by inlay-server, the
// tool list is one file there, shared by everyone who opens the page, in
// place of this browser's own storage. On a plain web host there is no
// server to find, and nothing here is used.
//
// The file's text is the text that export writes, as in browser storage.
// A write names the token of the file it changed (`If-Match`), and is
// refused when the file has changed since: see docs/api.md.

// Whether the server can be reached, as the last request to it found. A
// request that gets no answer, or a proxy's answer that the server is down,
// says it is out of reach; any answer of the server's own says it is back.
// While it is out of reach it is asked again every few seconds, so that the
// page finds out, and saves what waits, without anything else being done.

import { allFolders } from "../state/folders";
import type { ProjectSummary, Shelf } from "./db";

type Reach = "reachable" | "unreachable";
let reach: Reach = "reachable";
const watchers = new Set<() => void>();
let probe: ReturnType<typeof setTimeout> | null = null;

/** Whether the server could be reached the last time it was asked. */
export function getReach(): Reach {
  return reach;
}

export function subscribeReach(watch: () => void): () => void {
  watchers.add(watch);
  return () => watchers.delete(watch);
}

function setReach(next: Reach) {
  if (next === "unreachable" && probe === null) scheduleProbe(2000);
  if (next === reach) return;
  reach = next;
  for (const watch of watchers) watch();
}

function scheduleProbe(delay: number) {
  probe = setTimeout(async () => {
    probe = null;
    if (reach === "reachable") return;
    await call("api/health", { cache: "no-store" }).catch(() => undefined);
    if (reach === "unreachable" && probe === null) scheduleProbe(Math.min(delay * 2, 30_000));
  }, delay);
}

/** A proxy's answer for a server behind it that does not answer. */
const DOWN = [502, 503, 504];

/** `fetch`, noting whether the server answered. */
async function call(input: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (e) {
    setReach("unreachable");
    throw new Error("the server is out of reach", { cause: e });
  }
  setReach(DOWN.includes(response.status) ? "unreachable" : "reachable");
  return response;
}

/** Marks the server as out of reach, as when the browser says it is offline, so that it is asked until it answers. */
export function lostReach() {
  setReach("unreachable");
}

/** Asks the server now, as when the browser says it is back online. */
export function checkReach() {
  call("api/health", { cache: "no-store" }).catch(() => undefined);
}

export interface ServerLibrary {
  /** Tool-library file text. */
  text: string;
  /** Names this version of the file. */
  token: string;
}

function tokenOf(response: Response): string {
  const etag = response.headers.get("ETag");
  if (!etag) throw new Error("the server gave no token for the tool list");
  return etag.replace(/^W\//, "").replace(/"/g, "");
}

async function problem(response: Response): Promise<Error> {
  try {
    const body = await response.json();
    if (typeof body?.error?.message === "string") return new Error(body.error.message);
  } catch {
    // Not one of the server's own answers: a proxy's, most likely.
  }
  return new Error(`the server answered ${response.status}`);
}

/** Whether the page was served by inlay-server. A static host answers the question with a 404 or with a page, not with the server's JSON. */
export async function findServer(): Promise<boolean> {
  try {
    const response = await fetch("api/health", { cache: "no-store" });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.app === "inlay-cam";
  } catch {
    return false;
  }
}

/** The tool list as the server has it; null when it is still the version `have` names. */
export async function readLibrary(have?: string): Promise<ServerLibrary | null> {
  const response = await call("api/library", { cache: "no-store", headers: have ? { "If-None-Match": `"${have}"` } : {} });
  if (response.status === 304) return null;
  if (!response.ok) throw await problem(response);
  return { text: await response.text(), token: tokenOf(response) };
}

/** Writes the tool list over the version `token` names. Gives the new token, or "conflict" when the server's list is no longer that version. */
export async function writeLibrary(text: string, token: string): Promise<string | "conflict"> {
  const response = await call("api/library", {
    method: "PUT",
    headers: { "Content-Type": "application/json", "If-Match": `"${token}"`, "X-Inlay": "1" },
    body: text,
  });
  if (response.status === 409) return "conflict";
  if (!response.ok) throw await problem(response);
  const body = await response.json();
  if (typeof body?.token !== "string") throw new Error("the server gave no token for the tool list");
  return body.token;
}

const WRITE = { "Content-Type": "application/json", "X-Inlay": "1" };

async function answer(response: Response): Promise<Response> {
  if (!response.ok) throw await problem(response);
  return response;
}

/** The projects kept on the server, last written first, and the folders they are filed in: folders of the server's own, under `projects/`. */
export async function readShelf(): Promise<Shelf> {
  const body = await (await answer(await call("api/projects", { cache: "no-store" }))).json();
  const projects: ProjectSummary[] = (body.projects as Partial<ProjectSummary>[]).map((p) => ({
    id: String(p.id),
    name: typeof p.name === "string" ? p.name : "",
    modified: Number(p.modified) || 0,
    folder: typeof p.folder === "string" ? p.folder : "",
    steps: typeof p.steps === "number" ? p.steps : undefined,
  }));
  // A server from before folders names none.
  return { projects, folders: allFolders(Array.isArray(body.folders) ? body.folders : [], projects) };
}

/** Files a project in another folder, or in none. Its file is renamed, not written. Gives the folder as the server spells it. */
export async function moveProject(id: string, folder: string): Promise<string> {
  const response = await call(`api/projects/${encodeURIComponent(id)}`, { method: "PATCH", headers: WRITE, body: JSON.stringify({ folder }) });
  if (response.status === 404) throw new Error("That project is no longer kept.");
  return (await (await answer(response)).json()).folder;
}

export async function createFolder(path: string): Promise<string> {
  const response = await call("api/folders", { method: "POST", headers: WRITE, body: JSON.stringify({ path }) });
  return (await (await answer(response)).json()).folder;
}

/** Renames a folder, or moves it into another: `to` is its whole new path. */
export async function renameFolder(from: string, to: string): Promise<string> {
  const response = await call(`api/folders/${encodeURIComponent(from)}`, { method: "PATCH", headers: WRITE, body: JSON.stringify({ path: to }) });
  return (await (await answer(response)).json()).folder;
}

/** Takes a folder away. Its projects stay, in no folder. Gives how many were moved out. */
export async function deleteFolder(path: string): Promise<number> {
  const response = await call(`api/folders/${encodeURIComponent(path)}`, { method: "DELETE", headers: { "X-Inlay": "1" } });
  return Number((await (await answer(response)).json()).moved) || 0;
}

export async function getProject(id: string): Promise<{ id: string; name: string; modified: number; text: string; token?: string } | undefined> {
  const response = await call(`api/projects/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (response.status === 404) return undefined;
  await answer(response);
  const etag = response.headers.get("ETag");
  // The name is in the text; nothing that asks for one project reads it from here.
  return { id, name: "", modified: Number(response.headers.get("X-Modified")) || 0, text: await response.text(), token: etag?.replace(/^W\//, "").replace(/"/g, "") };
}

/** Keeps a project. With `basedOn`, the token of the version this page read, it is refused when the project was saved from elsewhere since: "conflict". `folder` is where one that is not kept yet goes; a kept one stays where it is. Gives the token of the version kept. */
export async function putProject(id: string, text: string, basedOn?: string, folder?: string): Promise<string | undefined | "conflict"> {
  const headers: Record<string, string> = basedOn ? { ...WRITE, "If-Match": `"${basedOn}"` } : WRITE;
  const where = folder ? `?folder=${encodeURIComponent(folder)}` : "";
  const response = await call(`api/projects/${encodeURIComponent(id)}${where}`, { method: "PUT", headers, body: text });
  if (response.status === 409) return "conflict";
  const body = await (await answer(response)).json();
  return typeof body?.token === "string" ? body.token : undefined;
}

export async function deleteProject(id: string): Promise<void> {
  const response = await call(`api/projects/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-Inlay": "1" } });
  if (response.status !== 404) await answer(response);
}

export async function getSetting(key: string): Promise<string | undefined> {
  const body = await (await answer(await call("api/settings", { cache: "no-store" }))).json();
  return typeof body[key] === "string" ? body[key] : undefined;
}

export async function putSetting(key: string, value: string): Promise<void> {
  await answer(await call(`api/settings/${encodeURIComponent(key)}`, { method: "PUT", headers: WRITE, body: JSON.stringify({ value }) }));
}
