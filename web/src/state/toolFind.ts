// Finding a tool in the list: the Size column, the sort orders, the tokenised
// search and the filter chips. Pure functions over the tools, no DOM.
//
// This is the list logic of `cnc-tooling-library`'s workbench, kept as it was
// where the tool model allowed: the same sizes, the same orders, the same way
// a search is read, and chips that step off, "only", "hide".

import type { Material, Tool } from "../core/types";

/** A V-bit this sharp engraves rather than chamfers (as the feeds model has it). */
export const ENGRAVER_MAX_ANGLE = 45;

export type SortKey = "group" | "dia" | "flute" | "name";
export const SORTS: { key: SortKey; label: string }[] = [
  { key: "group", label: "Group" },
  { key: "dia", label: "Ø" },
  { key: "flute", label: "Flute length" },
  { key: "name", label: "Name" },
];

const num = (v: number) => String(Number(v.toPrecision(12)));
const mm = (v: number) => num(Number(v.toFixed(4)));
const known = (v: number | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/** A tool's name as it is shown: with its coating, unless the name already ends with it. */
export function shownName(t: Tool): string {
  return t.coating && t.coating !== "uncoated" && !t.name.endsWith(t.coating) ? `${t.name} ${t.coating}` : t.name;
}

export type VKind = "radius" | "engraver" | "vgroove" | "chamfer" | "plain";

/** What a V-bit is picked as: a radius mill, an engraver, a V-groove or a chamfer; "plain" without a tip angle. */
export function vBitKind(t: Tool): VKind {
  if (t.kind === "corner_round") return "radius";
  if (!known(t.tipAngle)) return "plain";
  // A tool its owner calls an engraver (its group or name) is read as one at any angle.
  if (t.tipAngle <= ENGRAVER_MAX_ANGLE || /\bengravers?\b/i.test(`${t.group ?? ""} ${shownName(t)}`)) return "engraver";
  return t.diameter > t.shankDiameter ? "vgroove" : "chamfer";
}

const pointed = (t: Tool) => t.kind === "v_bit" || t.kind === "corner_round";
const engraverTip = (t: Tool) => known(t.tipDiameter) && t.tipDiameter !== t.diameter;

/** The size a tool of its kind is picked by, and the number the Ø sort orders it by. */
export function sizeOf(t: Tool): { text: string; main: number } {
  const d = `Ø${mm(t.diameter)}`;
  const withFlute = { text: known(t.fluteLength) ? `${d} × ${mm(t.fluteLength)}` : d, main: t.diameter };
  if (t.kind === "flat_end" || t.kind === "drill") return withFlute;
  if (t.kind === "thread_mill") {
    if (!known(t.threadDiameter)) return withFlute;
    const m = `M${mm(t.threadDiameter)}`;
    return { text: known(t.pitch) ? `${m} × ${mm(t.pitch)}` : m, main: t.threadDiameter };
  }
  if (pointed(t)) {
    const kind = vBitKind(t);
    if (kind === "radius") return { text: `R${mm(t.cornerRadius ?? (t.diameter - (t.tipDiameter ?? 0)) / 2)} ${d}`, main: t.diameter };
    if (kind === "engraver" && engraverTip(t)) return { text: `${mm(t.tipDiameter ?? 0)} × ${num(t.tipAngle ?? 0)}°`, main: t.tipDiameter ?? 0 };
    if (kind === "plain") return { text: d, main: t.diameter };
    return { text: `${num(t.tipAngle ?? 0)}° ${d}`, main: t.diameter };
  }
  return { text: d, main: t.diameter };
}

// --- sorting ---------------------------------------------------------------

/** Ascending, a missing value after every known one. */
function byKnown(a: number | undefined, b: number | undefined): number {
  const [ka, kb] = [known(a), known(b)];
  if (ka && kb) return (a as number) - (b as number);
  return ka ? -1 : kb ? 1 : 0;
}

const sizeKeys = (t: Tool) => [sizeOf(t).main, t.fluteLength, t.flutes, t.shankDiameter];
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function chain(a: (number | undefined)[], b: (number | undefined)[]): number {
  for (let i = 0; i < a.length; i++) {
    const c = byKnown(a[i], b[i]);
    if (c) return c;
  }
  return 0;
}

/** A compare function by one of the sort keys. `index` gives a tool's place in the list, for ties. */
export function comparator(sortKey: SortKey, index: (t: Tool) => number): (a: Tool, b: Tool) => number {
  if (sortKey === "name") return (a, b) => collator.compare(shownName(a), shownName(b)) || index(a) - index(b);
  if (sortKey === "flute") {
    return (a, b) => {
      const [ma, fa, ...ra] = sizeKeys(a);
      const [mb, fb, ...rb] = sizeKeys(b);
      return chain([fa, ma, ...ra], [fb, mb, ...rb]) || index(a) - index(b);
    };
  }
  // "group" (within a group) and "dia" (flat) share the size order.
  return (a, b) => chain(sizeKeys(a), sizeKeys(b)) || index(a) - index(b);
}

// --- search ------------------------------------------------------------------

const canonNumber = (s: string) => String(Number(Number(s).toFixed(4)));

/**
 * Lower-case text with the spellings of one size made the same: Ø, ×, comma
 * decimals, 1/8" and 1/4", "2 flute", units.
 */
export function normalise(text: string): string {
  let s = String(text ?? "").toLowerCase();
  s = s.replace(/[⌀Ø]/g, "ø").replace(/(\d),(\d)/g, "$1.$2");
  s = s.replace(/(\d)\s*mm/g, "$1 ");
  // 6×20, 6*20, M3x0.5 become "6 20", "m3 0.5"; a trailing 6× (half-typed) becomes "6".
  s = s.replace(/×/g, "x").replace(/(\d)\s*\*/g, "$1x");
  s = s.replace(/(\d)\s*x\s*(?=[\d.]|(?![a-z]))/g, "$1 ");
  s = s.replace(/°/g, " ").replace(/(\d)\s*deg(rees?)?(?![a-z])/g, "$1 ");
  s = s.replace(/(^|[^\d./])1\/8"?(?![\d/])/g, "$13.175").replace(/(^|[^\d./])1\/4"?(?![\d/])/g, "$16.35");
  s = s.replace(/(\d)\s*(?:-\s*)?(flutes?|fl)(?![a-z])/g, "$1f");
  return s;
}

/** A field longer than this is cut, so typing never stalls the page. */
const MAX_TEXT = 300;
const WORDY = /[a-z0-9ø]/;

/** w without the characters at its ends that can't start or end a word. */
function trimWord(w: string): string {
  let i = 0;
  let j = w.length;
  while (i < j && !WORDY.test(w[i]) && !(w[i] === "." && /\d/.test(w[i + 1] || ""))) i++;
  while (j > i && !WORDY.test(w[j - 1])) j--;
  return w.slice(i, j);
}

const ALIASES: Record<string, string> = { aluminium: "aluminum", alu: "aluminum" };

/** The words of a text: normalised, split on whitespace, edge punctuation trimmed, numbers canonical (6.0 is 6). */
function words(text: string): string[] {
  const out: string[] = [];
  for (let w of normalise(String(text ?? "").slice(0, MAX_TEXT)).split(/\s+/)) {
    w = trimWord(w);
    if (!w) continue;
    out.push(w.replace(/\d*\.\d+|\d+/g, canonNumber));
  }
  return out;
}

export interface Token {
  text: string;
  /** "number" matches a size number exactly, "dia" (ø6) a diameter, "code" (s4, m3, 2f, r1) a whole word, "text" any part of a word. */
  kind: "number" | "dia" | "code" | "text";
}

/** The tokens of what was typed. A lone Ø or × (half-typed "Ø6", "6×") says nothing yet. */
export function parseQuery(text: string): Token[] {
  return words(text)
    .filter((w) => w !== "ø" && w !== "x")
    .map((w) => {
      const t = Object.hasOwn(ALIASES, w) ? ALIASES[w] : w;
      const kind = /^\d+(\.\d+)?$/.test(t) ? "number" : /^ø\d/.test(t) ? "dia" : /\d/.test(t) ? "code" : "text";
      return { text: t, kind };
    });
}

const KIND_WORDS: Record<string, string> = {
  flat_end: "flat end mill endmill",
  ball_end: "ball nose ballnose end mill",
  drill: "drill",
  thread_mill: "thread mill threadmill",
};
const V_BIT_WORDS: Record<VKind, string> = {
  radius: "corner round rounding radius fillet",
  engraver: "engraver engraving",
  vgroove: "v-groove vgroove",
  chamfer: "chamfer",
  plain: "",
};

/** The vendor from a product page's host: the label before the last one. */
function vendor(url: string): string {
  try {
    const labels = new URL(url).hostname.split(".");
    if (labels.length < 2 || labels.every((l) => /^\d+$/.test(l))) return "";
    return labels[labels.length - 2];
  } catch {
    return "";
  }
}

/** Everything a tool can be found by, as a set of words. */
export function searchWords(t: Tool, materialLabel: (key: Material) => string = (k) => k): Set<string> {
  const parts: (string | undefined)[] = [shownName(t), (t.group ?? "").split("/").join(" "), t.style, t.coating];
  if (pointed(t)) parts.push(`v-bit vbit ${V_BIT_WORDS[vBitKind(t)]}`);
  else parts.push(KIND_WORDS[t.kind] ?? t.kind);
  if (known(t.flutes)) parts.push(`${num(t.flutes)}f`);
  if (known(t.diameter)) parts.push(`ø${mm(t.diameter)} ${mm(t.diameter)}`);
  if (known(t.shankDiameter)) parts.push(`s${mm(t.shankDiameter)} ${mm(t.shankDiameter)}`);
  if (known(t.fluteLength)) parts.push(mm(t.fluteLength));
  if (pointed(t)) {
    const kind = vBitKind(t);
    if (kind === "engraver" && engraverTip(t)) parts.push(mm(t.tipDiameter ?? 0));
    if (kind !== "radius" && known(t.tipAngle)) parts.push(num(t.tipAngle));
    if (kind === "radius") {
      const r = mm(t.cornerRadius ?? (t.diameter - (t.tipDiameter ?? 0)) / 2);
      parts.push(`r${r} ${r}`);
    }
  }
  if (t.kind === "thread_mill") {
    if (known(t.threadDiameter)) parts.push(`m${mm(t.threadDiameter)} ${mm(t.threadDiameter)}`);
    if (known(t.pitch)) parts.push(mm(t.pitch));
  }
  for (const m of t.recommendedFor ?? []) parts.push(m.replace(/_/g, " "), materialLabel(m));
  if (t.source?.url) parts.push(vendor(t.source.url));
  return new Set(parts.filter((p): p is string => !!p).flatMap((p) => words(p)));
}

/** True when every token finds a word. No tokens: true. */
export function matchesQuery(wordSet: Set<string>, tokens: Token[]): boolean {
  return tokens.every((tok) => {
    if (tok.kind !== "text") return wordSet.has(tok.text);
    for (const w of wordSet) if (w.includes(tok.text)) return true;
    return false;
  });
}

// --- filter chips --------------------------------------------------------------

export const SHANKS = ["3.175", "4", "6"];
export const FLUTES = ["1", "2", "3+"];
export const ROWS = ["shank", "flutes", "style", "material"] as const;
export type Row = (typeof ROWS)[number];
/** Every option is off, "only" (a row's "only" options are OR'd) or "hide" (always drops). */
export type Chips = Record<Row, { only: string[]; hide: string[] }>;
/** The style key of a tool with none set. */
export const NO_STYLE = "";
/** How many of the most common styles are chips; the rest are under More. */
export const STYLE_CHIPS = 3;

export const noChips = (): Chips => ({ shank: { only: [], hide: [] }, flutes: { only: [], hide: [] }, style: { only: [], hide: [] }, material: { only: [], hide: [] } });

const styleText64 = (s: string) => s.trim().slice(0, 64).trim();
/** A tool's style as a key: trimmed, lower case. */
export const styleKey = (t: Tool) => (typeof t.style === "string" ? styleText64(t.style).toLowerCase() : NO_STYLE);

/** The styles of the tools, most common first, each with the spelling most used for it. */
export function styleOptions(tools: Tool[]): { key: string; label: string; count: number }[] {
  const by = new Map<string, { key: string; count: number; spell: Map<string, number> }>();
  for (const t of tools) {
    const k = styleKey(t);
    if (k === NO_STYLE) continue;
    const o = by.get(k) ?? { key: k, count: 0, spell: new Map() };
    by.set(k, o);
    o.count += 1;
    const s = styleText64(t.style ?? "");
    o.spell.set(s, (o.spell.get(s) || 0) + 1);
  }
  return [...by.values()]
    .map((o) => ({ key: o.key, count: o.count, label: [...o.spell].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]))[0][0] }))
    .sort((a, b) => b.count - a.count || collator.compare(a.label, b.label));
}

/** The Style row's layout: the most common styles as chips, the rest (and "no style" when some tool has none) under More. */
export function styleLayout(tools: Tool[]): { chips: string[]; more: string[]; labels: Map<string, string> } {
  const opts = styleOptions(tools);
  const more = opts.slice(STYLE_CHIPS).map((o) => o.key);
  if (tools.some((t) => styleKey(t) === NO_STYLE)) more.push(NO_STYLE);
  return { chips: opts.slice(0, STYLE_CHIPS).map((o) => o.key), more, labels: new Map(opts.map((o) => [o.key, o.label])) };
}

const shankKey = (t: Tool) => (known(t.shankDiameter) ? (SHANKS.find((k) => Math.abs(Number(k) - t.shankDiameter) < 0.001) ?? null) : null);
const flutesKey = (t: Tool) => (!known(t.flutes) ? null : t.flutes >= 3 ? "3+" : t.flutes === 1 ? "1" : t.flutes === 2 ? "2" : null);

function hasOption(t: Tool, row: Row, key: string): boolean {
  if (row === "shank") return shankKey(t) === key;
  if (row === "flutes") return flutesKey(t) === key;
  if (row === "style") return styleKey(t) === key;
  return (t.recommendedFor ?? []).includes(key);
}

/**
 * True when, in every row, the tool has none of the hidden options and, if
 * the row has "only" options, one of them. `skip`: a row left out, for that
 * row's own counts.
 */
export function chipsMatch(t: Tool, chips: Chips, skip: Row | null = null): boolean {
  return ROWS.every((row) => {
    if (row === skip) return true;
    const { only, hide } = chips[row];
    if (hide.some((k) => hasOption(t, row, k))) return false;
    return !only.length || only.some((k) => hasOption(t, row, k));
  });
}

export const anyChips = (chips: Chips) => ROWS.some((row) => chips[row].only.length > 0 || chips[row].hide.length > 0);

export function chipState(chips: Chips, row: Row, key: string): "only" | "hide" | null {
  return chips[row].only.includes(key) ? "only" : chips[row].hide.includes(key) ? "hide" : null;
}

/** The chips with one option moved a step along off, only, hide, off. */
export function cycleChip(chips: Chips, row: Row, key: string): Chips {
  const state = chipState(chips, row, key);
  const { only, hide } = chips[row];
  const next = state === null ? { only: [...only, key], hide } : state === "only" ? { only: only.filter((k) => k !== key), hide: [...hide, key] } : { only, hide: hide.filter((k) => k !== key) };
  return { ...chips, [row]: next };
}

/** Per row and option, how many of the tools have that option once the other rows' choices apply. */
export function chipCounts(tools: Tool[], chips: Chips, keys: { style: string[]; material: string[] }): Record<Row, Record<string, number>> {
  const opts: Record<Row, string[]> = { shank: SHANKS, flutes: FLUTES, style: keys.style, material: keys.material };
  return Object.fromEntries(
    ROWS.map((row) => {
      const pool = tools.filter((t) => chipsMatch(t, chips, row));
      return [row, Object.fromEntries(opts[row].map((k) => [k, pool.filter((t) => hasOption(t, row, k)).length]))];
    }),
  ) as Record<Row, Record<string, number>>;
}

/** The active chips in words: ["Shank 4 or 6", "Style not Corn", "Material Titanium"]. */
export function chipsText(chips: Chips, label: (row: Row, key: string) => string = (_, k) => k): string[] {
  const name: Record<Row, string> = { shank: "Shank", flutes: "Flutes", style: "Style", material: "Material" };
  const out: string[] = [];
  for (const row of ROWS) {
    const { only, hide } = chips[row];
    if (only.length) out.push(`${name[row]} ${only.map((k) => label(row, k)).join(" or ")}`);
    if (hide.length) out.push(`${name[row]} not ${hide.map((k) => label(row, k)).join(", ")}`);
  }
  return out;
}

/** Chips read back from storage: only well-formed rows and text survive, an option in one state at most. */
export function cleanChips(raw: unknown): Chips {
  const ok = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const part = (row: Row, state: "only" | "hide"): string[] => {
    const r = ok[row] as Record<string, unknown> | undefined;
    const list = r && typeof r === "object" && Array.isArray(r[state]) ? (r[state] as unknown[]) : [];
    return [...new Set(list.filter((k): k is string => typeof k === "string" && k.length <= 64).slice(0, 100))];
  };
  return Object.fromEntries(
    ROWS.map((row) => {
      const only = part(row, "only");
      return [row, { only, hide: part(row, "hide").filter((k) => !only.includes(k)) }];
    }),
  ) as Chips;
}

/** The note for a list nothing is left in: "No tool matches “1/8 alu” with Shank 6." */
export function noMatchText(query: string, chips: string[], category: string | null): string {
  const q = query ? `“${query}”` : "";
  const c = chips.join(", ");
  if (category) return q ? `No tool in “${category}” matches ${q}.` : `No tool is in “${category}”.`;
  if (q && c) return `No tool matches ${q} with ${c}.`;
  return q || c ? `No tool matches ${q || c}.` : "Nothing to show.";
}
