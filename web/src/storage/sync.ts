// Syncing two places things are kept in: what differs between them is
// listed, the user says which way each goes, and that is done. Nothing is
// copied over or deleted that was not shown first.
//
// What is compared is each project, the tool list, the machine and the
// inlay defaults. To tell "changed here" from "changed in both" and
// "deleted there" from "new here", the two places' state after a sync is
// remembered (`Base`): a mark of each thing as it then was on either side.
// A side whose thing still has its mark has not changed since.

import type { Shelf, StoredProject, Thumb } from "./db";

/** What is synced besides the projects. */
export const SETTINGS = ["tools", "machine", "inlayDefaults"] as const;
export type SyncSetting = (typeof SETTINGS)[number];

/** A place, as far as syncing goes. */
export interface Store {
  readShelf(): Promise<Shelf>;
  getProject(id: string): Promise<{ text: string } | undefined>;
  /** Keeps a project whether it is there or not. One that is there stays in its folder. */
  putProject(project: StoredProject): Promise<unknown>;
  moveProject(id: string, folder: string): Promise<unknown>;
  deleteProject(id: string): Promise<void>;
  getSetting(key: SyncSetting): Promise<string | undefined>;
  putSetting(key: SyncSetting, value: string): Promise<void>;
}

export type Kind = "project" | SyncSetting;

/** One thing as one place has it. */
export interface Side {
  text: string;
  /** Of a project: the folder it is filed in. */
  folder: string;
  name: string;
  modified?: number;
  steps?: number;
  thumb?: Thumb | null;
}

export type Snapshot = Map<string, Side>;

/** The marks of each thing on either side when the two were last the same. */
export type Base = Record<string, { a: string; b: string }>;

export type State = "onlyA" | "onlyB" | "newerA" | "newerB" | "both" | "deletedA" | "deletedB";
/** Make B as A is, make A as B is, leave both, or (a project changed in both) keep A's as a copy beside B's. */
export type Action = "toB" | "toA" | "skip" | "keepBoth";

export interface Row {
  key: string;
  kind: Kind;
  name: string;
  state: State;
  /** What is done unless the user says otherwise: never a deletion, and never over a change. */
  action: Action;
  a?: Side;
  b?: Side;
  /** Of one deleted on a side: whether the other side changed it since the two were last the same. Deleting it there loses that change. */
  changed?: boolean;
}

const NAMES: Record<SyncSetting, string> = { tools: "Tool list", machine: "Machine", inlayDefaults: "New inlays" };

function kindOf(key: string): Kind {
  return key.startsWith("project:") ? "project" : (key as SyncSetting);
}

/** A short mark of a text (cyrb53, and its length): equal texts have equal marks, and others almost never do. */
export function mark(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}.${text.length.toString(36)}`;
}

/** The mark of a thing as a place has it: its text and, of a project, where it is filed. */
function markOf(side: Side): string {
  return `${mark(side.text)}|${side.folder.toLowerCase()}`;
}

function alike(a: Side, b: Side): boolean {
  return a.text === b.text && a.folder.toLowerCase() === b.folder.toLowerCase();
}

/** Everything a place has that is synced. */
export async function snapshot(store: Store): Promise<Snapshot> {
  const out: Snapshot = new Map();
  for (const p of (await store.readShelf()).projects) {
    const kept = await store.getProject(p.id);
    if (kept) out.set(`project:${p.id}`, { text: kept.text, folder: p.folder, name: p.name, modified: p.modified, steps: p.steps, thumb: p.thumb });
  }
  for (const key of SETTINGS) {
    const text = await store.getSetting(key);
    if (text !== undefined) out.set(key, { text, folder: "", name: NAMES[key] });
  }
  return out;
}

/**
 * What differs between two places, and the marks to remember: those of
 * what is the same now, and those remembered of what still differs.
 */
export function compare(a: Snapshot, b: Snapshot, base: Base): { rows: Row[]; base: Base } {
  const rows: Row[] = [];
  const next: Base = {};
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const [x, y] = [a.get(key), b.get(key)];
    const kind = kindOf(key);
    const was = base[key];
    const row = (state: State, action: Action, changed?: boolean) => rows.push({ key, kind, name: (x ?? y)!.name, state, action, a: x, b: y, ...(changed ? { changed } : {}) });
    if (x && y) {
      const [changedA, changedB] = was ? [was.a !== markOf(x), was.b !== markOf(y)] : [true, true];
      if (alike(x, y) || (!changedA && !changedB)) {
        // The same, or as they were when one was copied to the other: a place may keep a text in its own way.
        next[key] = alike(x, y) ? { a: markOf(x), b: markOf(y) } : was!;
        continue;
      }
      if (was) next[key] = was;
      if (changedA && !changedB) row("newerA", "toB");
      else if (changedB && !changedA) row("newerB", "toA");
      else row("both", "skip");
    } else if (x) {
      // It was on both sides once: gone from B since. A setting cannot be deleted, only never kept.
      if (was && kind === "project") {
        next[key] = was;
        row("deletedB", "skip", was.a !== markOf(x));
      } else row("onlyA", "toB");
    } else if (y) {
      if (was && kind === "project") {
        next[key] = was;
        row("deletedA", "skip", was.b !== markOf(y));
      } else row("onlyB", "toA");
    }
  }
  const order = (r: Row) => (r.kind === "project" ? 1 : 0);
  rows.sort((p, q) => order(p) - order(q) || p.name.localeCompare(q.name));
  return { rows, base: next };
}

/** What an action does to a row: copies it over, deletes it where it still is, or nothing. */
export function effect(row: Row, action: Action): "copy" | "delete" | "copies" | "none" {
  if (action === "skip") return "none";
  // Two versions to keep: not where the two differ only in where they are filed.
  if (action === "keepBoth") return row.kind === "project" && row.a && row.b && row.a.text !== row.b.text ? "copies" : "none";
  if (action === "toB" ? row.a : row.b) return "copy";
  // Only a project can be deleted: a setting the one side lacks is not there to be taken from the other.
  return row.kind === "project" ? "delete" : "none";
}

/** The actions a row can take, the one it starts with among them. */
export function choices(row: Row): Action[] {
  const all: Action[] = ["toB", "toA", "keepBoth", "skip"];
  return all.filter((action) => action === "skip" || (effect(row, action) !== "none" && (action !== "keepBoth" || row.state === "both")));
}

/** A copy of a project's file under an id and a name of its own, for "keep both". */
export type Duplicate = (text: string, taken: string[]) => Promise<{ id: string; name: string; text: string }>;

/** Throws when a thing is no longer as it was when the two places were compared: what is there now was not shown. */
async function unchanged(store: Store, row: Row, was: Side | undefined): Promise<void> {
  const now = row.kind === "project" ? (await store.getProject(row.key.slice("project:".length)))?.text : await store.getSetting(row.kind);
  if (now !== was?.text) throw new Error("changed since the two were compared: compare again");
}

async function put(to: Store, id: string, from: Side, there: Side | undefined): Promise<void> {
  await to.putProject({ id, name: from.name, modified: from.modified ?? Date.now(), text: from.text, folder: from.folder, steps: from.steps, thumb: from.thumb });
  if (there && there.folder.toLowerCase() !== from.folder.toLowerCase()) await to.moveProject(id, from.folder);
}

export interface Applied {
  base: Base;
  /** Whether anything was written to either place. */
  wroteA: boolean;
  wroteB: boolean;
  done: number;
  failed: { name: string; error: string }[];
}

/**
 * Does what was chosen for each row, one after the other; a row that fails
 * does not stop the rest. Gives the marks to remember: the two places are
 * read again, and what was done is marked as it is now on either side.
 */
export async function apply(rows: { row: Row; action: Action }[], a: Store, b: Store, base: Base, duplicate: Duplicate): Promise<Applied> {
  const out: Applied = { base: { ...base }, wroteA: false, wroteB: false, done: 0, failed: [] };
  const settled: string[] = [];
  for (const { row, action } of rows) {
    const what = effect(row, action);
    if (what === "none") continue;
    const id = row.key.slice("project:".length);
    try {
      if (what === "copies") {
        await unchanged(a, row, row.a);
        await unchanged(b, row, row.b);
        const taken = [...(await a.readShelf()).projects, ...(await b.readShelf()).projects].map((p) => p.name);
        const copy = await duplicate(row.a!.text, taken);
        const mine: Side = { ...row.a!, text: copy.text, name: copy.name, thumb: row.a!.thumb };
        out.wroteA = out.wroteB = true;
        await put(a, copy.id, mine, undefined);
        await put(b, copy.id, mine, undefined);
        await put(a, id, row.b!, row.a);
        settled.push(row.key, `project:${copy.id}`);
      } else {
        const [from, to, there] = action === "toB" ? [row.a, b, row.b] : [row.b, a, row.a];
        await unchanged(to, row, there);
        if (action === "toB") out.wroteB = true;
        else out.wroteA = true;
        if (what === "delete") await to.deleteProject(id);
        else if (row.kind === "project") await put(to, id, from!, there);
        else await to.putSetting(row.kind, from!.text);
        settled.push(row.key);
      }
      out.done++;
    } catch (e) {
      out.failed.push({ name: row.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (settled.length > 0) {
    const [x, y] = [await snapshot(a), await snapshot(b)];
    for (const key of settled) {
      const [p, q] = [x.get(key), y.get(key)];
      if (p && q) out.base[key] = { a: markOf(p), b: markOf(q) };
      else delete out.base[key];
    }
  }
  return out;
}

/** The marks seen from the other side, for a pair that is remembered the other way round. */
export function turned(base: Base): Base {
  return Object.fromEntries(Object.entries(base).map(([key, { a, b }]) => [key, { a: b, b: a }]));
}
