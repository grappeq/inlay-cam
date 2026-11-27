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
  /** When a setting was last changed there, where the place says. */
  settingSaved?(key: SyncSetting): Promise<number | undefined>;
  /** `at`: when it was changed where it is copied from, for a place that can date it as there. */
  putSetting(key: SyncSetting, value: string, at?: number): Promise<void>;
}

export type Kind = "project" | SyncSetting;

/** One thing as one place has it. */
export interface Side {
  text: string;
  /** Of a project: the folder it is filed in. */
  folder: string;
  name: string;
  /** When it was last changed there. Not known of a setting kept before its changes were dated. */
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
    if (text !== undefined) out.set(key, { text, folder: "", name: NAMES[key], modified: await store.settingSaved?.(key) });
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
export async function apply(rows: { row: Row; action: Action }[], a: Store, b: Store, base: Base, duplicate: Duplicate, progress?: (done: number, name: string | null) => void): Promise<Applied> {
  const out: Applied = { base: { ...base }, wroteA: false, wroteB: false, done: 0, failed: [] };
  const settled: string[] = [];
  for (const { row, action } of rows) {
    const what = effect(row, action);
    if (what === "none") continue;
    progress?.(out.done + out.failed.length, row.name);
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
        else await to.putSetting(row.kind, from!.text, from!.modified);
        settled.push(row.key);
      }
      out.done++;
    } catch (e) {
      out.failed.push({ name: row.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  progress?.(out.done + out.failed.length, null);
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

/** How many rows something is done to: the parts of a sync, for its bar. */
export function parts(rows: { row: Row; action: Action }[]): number {
  return rows.filter((c) => effect(c.row, c.action) !== "none").length;
}

/** Whether a row is ticked from the start: only where one side clearly has the newer version. */
export function clear(row: Row): boolean {
  return row.action !== "skip";
}

/**
 * The ways a row can go when it is ticked, the cautious one first. What only
 * one side has can only be copied: deleting the one copy there is, is not a
 * turn away.
 */
export function turns(row: Row): Action[] {
  const rank = (action: Action) => ["copy", "copies", "delete"].indexOf(effect(row, action));
  const only = row.state === "onlyA" || row.state === "onlyB";
  return choices(row)
    .filter((action) => action !== "skip" && !(only && effect(row, action) === "delete"))
    .sort((x, y) => rank(x) - rank(y));
}

/**
 * The way a row goes when it is ticked, until it is turned. One changed in
 * both goes from the side changed last, where both sides say when; one deleted is deleted from the
 * other side too, unless that side changed it since: then it is put back.
 */
export function aim(row: Row): Action {
  if (row.action !== "skip") return row.action;
  // The later of the two, where both say when: a side with no date is not known to be the older one.
  if (row.state === "both") return row.a?.modified !== undefined && row.b?.modified !== undefined && row.b.modified > row.a.modified ? "toA" : "toB";
  const back: Action = row.state === "deletedA" ? "toA" : "toB";
  const on: Action = back === "toA" ? "toB" : "toA";
  return row.changed || effect(row, on) === "none" ? back : on;
}

/** The next way a row can go after the one it goes now. */
export function turn(row: Row, now: Action): Action {
  const all = turns(row);
  return all[(all.indexOf(now) + 1) % all.length] ?? now;
}

/** What is done to each row: the way it goes when ticked, nothing when not. */
export function chosen(rows: Row[], ticked: Record<string, boolean>, ways: Record<string, Action>): { row: Row; action: Action }[] {
  return rows.map((row) => ({ row, action: (ticked[row.key] ?? clear(row)) ? (ways[row.key] ?? aim(row)) : "skip" }));
}

/** How a side of a row stands, for its colour: the newer one, the older, one of two that both changed, not there, or deleted there. */
export type Tone = "new" | "old" | "clash" | "none" | "gone";

export function tone(row: Row, side: "a" | "b"): Tone {
  const here = side === "a" ? "A" : "B";
  if (!row[side]) return row.state === `deleted${here}` ? "gone" : "none";
  if (row.state === "both") return "clash";
  if (row.state === "deletedA" || row.state === "deletedB") return row.changed ? "clash" : "old";
  return row.state === `newer${here}` || row.state === `only${here}` ? "new" : "old";
}

/** The projects that differ under the folder they are filed in, and the settings apart. */
export interface Tree {
  folders: { folder: string; rows: Row[] }[];
  settings: Row[];
}

/** The folder a row is shown under: where the side it is copied from by default has it. */
export function folderOf(row: Row): string {
  return (aim(row) === "toA" ? (row.b ?? row.a) : (row.a ?? row.b))?.folder ?? "";
}

export function tree(rows: Row[]): Tree {
  const folders = new Map<string, Row[]>();
  const settings: Row[] = [];
  // A folder is one whatever the case of its name, as where two sides are compared: it is called as it was first met.
  const called = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== "project") {
      settings.push(row);
      continue;
    }
    const lower = folderOf(row).toLowerCase();
    if (!called.has(lower)) called.set(lower, folderOf(row));
    const folder = called.get(lower)!;
    folders.set(folder, [...(folders.get(folder) ?? []), row]);
  }
  const byName = (x: Row, y: Row) => x.name.localeCompare(y.name) || (x.key < y.key ? -1 : 1);
  return {
    // Unfiled first, as on the projects' own page.
    folders: [...folders.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([folder, list]) => ({ folder, rows: list.sort(byName) })),
    settings: settings.sort((x, y) => SETTINGS.indexOf(x.kind as SyncSetting) - SETTINGS.indexOf(y.kind as SyncSetting)),
  };
}

/** Whether all, some or none of some rows are ticked. */
export function tickedOf(rows: Row[], ticked: Record<string, boolean>): "all" | "some" | "none" {
  const n = rows.filter((row) => ticked[row.key] ?? clear(row)).length;
  return n === 0 ? "none" : n === rows.length ? "all" : "some";
}

/** What a sync loses that cannot be seen again in either place: to be asked about by name before it is done. */
export function losses(rows: { row: Row; action: Action }[]): { deleted: string[]; overwritten: string[] } {
  const name = (c: { row: Row }) => c.row.name || "Untitled";
  return {
    deleted: rows.filter((c) => effect(c.row, c.action) === "delete").map(name),
    // A copy over a side that was itself changed: of one changed in both, or back over the newer one.
    overwritten: rows.filter((c) => effect(c.row, c.action) === "copy" && tone(c.row, c.action === "toB" ? "b" : "a") !== "old" && tone(c.row, c.action === "toB" ? "b" : "a") !== "none" && tone(c.row, c.action === "toB" ? "b" : "a") !== "gone").map(name),
  };
}

/** What stands for a side that has no date to show: a setting, or a project whose date is not known. */
export function standing(row: Row, side: "a" | "b"): string {
  const how = tone(row, side);
  if (how === "gone") return "Deleted";
  if (how === "none") return "Not there";
  if (row.state === "onlyA" || row.state === "onlyB") return "Only here";
  return how === "old" ? "As it was" : "Changed";
}

/** Of a project filed differently on the two sides: where the side it is not copied from has it. Null when they agree. */
export function otherFolder(row: Row, way: Action): string | null {
  if (!row.a || !row.b || row.a.folder.toLowerCase() === row.b.folder.toLowerCase()) return null;
  return (way === "toA" ? row.a : row.b).folder;
}
