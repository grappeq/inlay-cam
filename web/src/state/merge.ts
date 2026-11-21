// Two changes to the shared tool list, made in two places from the same
// version, put together. When a write to the server is refused because the
// list changed there in the meantime, the change made here and the one made
// there are merged, where they are to different things, and written as one.
//
// A three-way merge: what each side changed since the version both started
// from is kept. Tools, materials, profiles and groups are told apart by
// their ids and keys, and so are a tool's cutting rows, so that two people
// may change two rows of one tool. A log that both sides added entries to
// keeps both. Where both changed the same value differently, the server's is
// kept, and the thing it belongs to is named, so the change made here can be
// made again.

import type { ToolLibrary } from "../core/types";

export interface Merged {
  library: ToolLibrary;
  /** What both sides changed differently, named for a person: the server's change was kept for each. */
  lost: string[];
}

type Json = unknown;

/** How the items of a list are told apart, by the list's place in the file. */
const IDENTITY: Record<string, (item: Record<string, Json>) => string> = {
  tools: (t) => String(t.id),
  materials: (m) => String(m.key),
  profiles: (p) => String(p.key),
  groups: (g) => String(g.path),
  "tools.cutting": (c) => `${c.material}@${c.profile ?? ""}`,
};

/** How an item is named in a message. */
const LABEL: Record<string, (item: Record<string, Json>) => string> = {
  tools: (t) => `the tool "${t.name}"`,
  materials: (m) => `the material "${m.label ?? m.key}"`,
  profiles: (p) => `the profile "${p.label ?? p.key}"`,
  groups: (g) => `the group "${g.path}"`,
};

/** A text that is the same for equal values, whatever order their keys were set in. */
function canon(value: Json): string {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, v[k]]))
      : v,
  );
}

function same(a: Json, b: Json): boolean {
  return canon(a) === canon(b);
}

function isObject(value: Json): value is Record<string, Json> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

interface Context {
  /** Where in the file, such as `tools.cutting`: chooses how a list's items are told apart. */
  path: string;
  /** Called with the place of each value both sides changed differently. */
  clash: () => void;
  /** Names of the items whose changes clashed. */
  lost: string[];
}

function merge3(base: Json, mine: Json, theirs: Json, at: Context): Json {
  if (same(mine, base)) return theirs;
  if (same(theirs, base) || same(mine, theirs)) return mine;
  if (isObject(base) && isObject(mine) && isObject(theirs)) {
    const out: Record<string, Json> = {};
    for (const key of union(Object.keys(theirs), Object.keys(mine))) {
      const value = merge3(base[key], mine[key], theirs[key], { ...at, path: `${at.path}.${key}` });
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(mine) && Array.isArray(theirs)) {
    const identity = IDENTITY[at.path];
    if (identity && [...base, ...mine, ...theirs].every(isObject)) {
      return mergeKeyed(base as Record<string, Json>[], mine as Record<string, Json>[], theirs as Record<string, Json>[], identity, at);
    }
    // Entries added at the end on both sides, as a log is added to: both kept.
    if (startsWith(mine, base) && startsWith(theirs, base)) return [...theirs, ...mine.slice(base.length)];
  }
  at.clash();
  return theirs;
}

function startsWith(list: Json[], start: Json[]): boolean {
  return list.length >= start.length && start.every((item, i) => same(item, list[i]));
}

function union(first: string[], second: string[]): string[] {
  return [...first, ...second.filter((k) => !first.includes(k))];
}

/**
 * A list whose items have ids: each item merged by its id, and in the
 * server's order unless only this side reordered. An item added on one
 * side goes after the item it follows there.
 */
function mergeKeyed(
  base: Record<string, Json>[],
  mine: Record<string, Json>[],
  theirs: Record<string, Json>[],
  identity: (item: Record<string, Json>) => string,
  at: Context,
): Record<string, Json>[] {
  const index = (list: Record<string, Json>[]) => new Map(list.map((item) => [identity(item), item]));
  const [b, m, t] = [index(base), index(mine), index(theirs)];
  const label = LABEL[at.path];
  const merged = new Map<string, Json>();
  for (const id of union([...t.keys()], [...m.keys()])) {
    let clashed = false;
    const value = merge3(b.get(id), m.get(id), t.get(id), { ...at, clash: () => (clashed = true) });
    if (clashed) {
      if (label) {
        const named = (t.get(id) ?? m.get(id) ?? b.get(id)) as Record<string, Json>;
        at.lost.push(label(named));
      } else {
        at.clash();
      }
    }
    if (value !== undefined) merged.set(id, value);
  }
  // Order among the items all three have, so that an item added or taken out is not a reorder.
  const order = (list: Record<string, Json>[]) => list.map(identity).filter((id) => b.has(id) && m.has(id) && t.has(id));
  const reorderedHere = !same(order(mine), order(base)) && same(order(theirs), order(base));
  const [lead, other] = reorderedHere ? [mine, theirs] : [theirs, mine];
  const ids = lead.map(identity).filter((id) => merged.has(id));
  for (const [i, item] of other.entries()) {
    const id = identity(item);
    if (!merged.has(id) || ids.includes(id)) continue;
    const before = other.slice(0, i).map(identity).reverse().find((prior) => ids.includes(prior));
    ids.splice(before === undefined ? 0 : ids.indexOf(before) + 1, 0, id);
  }
  return ids.map((id) => merged.get(id) as Record<string, Json>);
}

/**
 * The change made here since `base`, made to `theirs`, the list as the
 * server now has it. Both are kept wherever they are to different things.
 */
export function mergeLibraries(base: ToolLibrary, mine: ToolLibrary, theirs: ToolLibrary): Merged {
  const lost: string[] = [];
  const library: Record<string, Json> = {};
  const lists = ["materials", "profiles", "groups", "tools"] as const;
  for (const key of lists) {
    const value = merge3(base[key] ?? [], mine[key] ?? [], theirs[key] ?? [], {
      path: key,
      lost,
      clash: () => lost.push(`the ${key}`),
    });
    if (key === "tools" || (Array.isArray(value) && value.length > 0)) library[key] = value;
  }
  return { library: library as unknown as ToolLibrary, lost: [...new Set(lost)] };
}
