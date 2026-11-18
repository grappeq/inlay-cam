// The tool list on a server. When the app is served by inlay-server, the
// tool list is one file there, shared by everyone who opens the page, in
// place of this browser's own storage. On a plain web host there is no
// server to find, and nothing here is used.
//
// The file's text is the text that export writes, as in browser storage.
// A write names the token of the file it changed (`If-Match`), and is
// refused when the file has changed since: see docs/api.md.

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
  const response = await fetch("api/library", { cache: "no-store", headers: have ? { "If-None-Match": `"${have}"` } : {} });
  if (response.status === 304) return null;
  if (!response.ok) throw await problem(response);
  return { text: await response.text(), token: tokenOf(response) };
}

/** Writes the tool list over the version `token` names. Gives the new token, or "conflict" when the server's list is no longer that version. */
export async function writeLibrary(text: string, token: string): Promise<string | "conflict"> {
  const response = await fetch("api/library", {
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

/** The projects kept on the server, last written first. */
export async function listProjects(): Promise<{ id: string; name: string; modified: number }[]> {
  const body = await (await answer(await fetch("api/projects", { cache: "no-store" }))).json();
  return body.projects;
}

export async function getProject(id: string): Promise<{ id: string; name: string; modified: number; text: string } | undefined> {
  const response = await fetch(`api/projects/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (response.status === 404) return undefined;
  await answer(response);
  // The name is in the text; nothing that asks for one project reads it from here.
  return { id, name: "", modified: Number(response.headers.get("X-Modified")) || 0, text: await response.text() };
}

export async function putProject(id: string, text: string): Promise<void> {
  await answer(await fetch(`api/projects/${encodeURIComponent(id)}`, { method: "PUT", headers: WRITE, body: text }));
}

export async function deleteProject(id: string): Promise<void> {
  const response = await fetch(`api/projects/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-Inlay": "1" } });
  if (response.status !== 404) await answer(response);
}

export async function getSetting(key: string): Promise<string | undefined> {
  const body = await (await answer(await fetch("api/settings", { cache: "no-store" }))).json();
  return typeof body[key] === "string" ? body[key] : undefined;
}

export async function putSetting(key: string, value: string): Promise<void> {
  await answer(await fetch(`api/settings/${encodeURIComponent(key)}`, { method: "PUT", headers: WRITE, body: JSON.stringify({ value }) }));
}
