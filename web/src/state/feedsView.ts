// What the screen makes of the feeds model's suggestions for a cutting row:
// which combination is shown, where the row's own cut sits among the five
// stops, what its numbers do outside anything the model allows, and whether
// the row holds a suggestion exactly. Ported from the tooling library's
// workbench (ruler.js, and the suggestion part of app.js), which the screen
// follows; the model itself is in the core.

import type { CuttingSettings, FeedEntry, FeedLevel, FeedLimits, FeedOptions, FeedSuggestion, Profile, Tool } from "../core/types";

export type Pick = FeedOptions;

/** The five stops, in slider order. */
export const LEVELS: FeedLevel[] = ["gentle", "slot_safe", "standard", "firm", "aggressive"];
export const LEVEL_LABELS: Record<FeedLevel, string> = { gentle: "gentle", slot_safe: "slot-safe", standard: "standard", firm: "firm", aggressive: "aggressive" };
export const PLAIN_PICK: Pick = { level: "slot_safe", ramping: false, adaptive: false, lubricated: false };

export const comboKey = (p: Pick) => p.level + (p.ramping ? "+ramp" : "") + (p.adaptive ? "+adaptive" : "") + (p.lubricated ? "+lube" : "");

export function parseCombo(key: string): Pick {
  const [level, ...flags] = String(key).split("+");
  return sanePick({ level: level as FeedLevel, ramping: flags.includes("ramp"), adaptive: flags.includes("adaptive"), lubricated: flags.includes("lube") });
}

/** A pick as stored or remembered, held to the stops the model has. */
export function sanePick(p: Partial<Pick> | null | undefined): Pick {
  return { level: p?.level && LEVELS.includes(p.level) ? p.level : "slot_safe", ramping: !!p?.ramping, adaptive: !!p?.adaptive, lubricated: !!p?.lubricated };
}

export const describePick = (p: Pick) => `${LEVEL_LABELS[p.level]}${p.adaptive ? " · Adaptive" : ""}${p.ramping ? " · ramped" : ""}${p.lubricated ? " · lubricated" : ""}`;

/** Where a profile's rows start: its own stop and ways of cutting. */
export function profilePick(profile: Profile | undefined, key: string | undefined): Pick {
  if (key === undefined) return PLAIN_PICK;
  return { level: profile?.level ?? "slot_safe", ramping: profile?.ramping ?? false, adaptive: profile?.adaptive ?? key === "adaptive", lubricated: profile?.lubricated ?? false };
}

/**
 * The key a pick has among an entry's combinations: where lubrication changes
 * nothing for the material, the combinations come without it only.
 */
const entryKey = (entry: FeedEntry, pick: Pick) => comboKey(entry.lubrication ? pick : { ...pick, lubricated: false });

export function sugCombo(entry: FeedEntry | null, pick: Pick): FeedSuggestion | null {
  if (!entry) return null;
  const key = entryKey(entry, pick);
  return Object.hasOwn(entry.combos, key) ? entry.combos[key] : null;
}

/** A row's cut as numbers; NaN where one is missing. */
export interface Cut {
  feed: number;
  plunge: number;
  rpm: number;
  stepoverMm: number;
  stepdown: number;
  flutes: number;
  diameter: number;
}

export function rowCut(row: CuttingSettings, tool: Tool): Cut {
  return { feed: row.feed, plunge: row.plunge, rpm: row.rpm, stepoverMm: row.stepover, stepdown: row.stepdown, flutes: tool.flutes ?? NaN, diameter: tool.diameter };
}

// ---- The ruler: where a cut sits among the stops ----

const SAME = 1e-6; // relative: a row typed to a stop's values lands on it despite rounding

/** Volume removed per spindle revolution, mm³; NaN when a value is missing or not positive. */
export function volPerRev(feed: number, rpm: number, stepoverMm: number, stepdown: number): number {
  const v = [feed, rpm, stepoverMm, stepdown].map(Number);
  return v.every((x) => Number.isFinite(x) && x > 0) ? (v[0] / v[1]) * v[2] * v[3] : NaN;
}

/** A drill's bite per spindle revolution, mm; NaN when a value is missing or not positive. */
export function plungePerRev(plunge: number, rpm: number): number {
  const v = [plunge, rpm].map(Number);
  return v.every((x) => Number.isFinite(x) && x > 0) ? v[0] / v[1] : NaN;
}

export interface Place {
  /**
   * none: a stop without a value. blank: no row value. on: at a stop. near:
   * between two. flat: every stop is the same cut and the row is not it.
   */
  kind: "none" | "blank" | "on" | "near" | "below" | "above" | "flat";
  /** The nearest stop, or -1. */
  index: number;
  /** 0 to 1 along the stops. */
  x: number;
  lo: number;
  hi: number;
  /** flat: the row's value over the stops' one. */
  ratio?: number;
}

/**
 * Where a value sits among the stops' values (two or more, in stop order).
 * `defaultIndex` is the row's default stop, which wins a tie when several
 * stops share the value. The stops need not rise monotonically. When every
 * stop has the same value (a corner-rounding bit's, held to its radius and a
 * feed cap at every stop) there is no scale to be past the end of: a row a
 * little over it is not "above aggressive", only that much over every stop.
 */
export function placeAmong(stops: (number | null)[] | null, value: number, defaultIndex = 1): Place {
  const none: Place = { kind: "none", index: -1, x: 0, lo: -1, hi: -1 };
  if (!Array.isArray(stops) || stops.length < 2 || !stops.every((v) => Number.isFinite(v))) return none;
  const at = stops as number[];
  if (!Number.isFinite(value)) return { ...none, kind: "blank" };
  const n = at.length - 1;
  const same = (a: number) => Math.abs(a - value) <= SAME * Math.max(Math.abs(a), Math.abs(value));
  const hits = at.map((v, i) => (same(v) ? i : -1)).filter((i) => i >= 0);
  if (hits.length) {
    const i = hits.includes(defaultIndex) ? defaultIndex : hits[0];
    return { kind: "on", index: i, x: i / n, lo: i, hi: i };
  }
  if (at.every((v) => Math.abs(v - at[0]) <= SAME * Math.max(Math.abs(v), Math.abs(at[0])))) {
    const i = Math.min(Math.max(defaultIndex, 0), n);
    return { kind: "flat", index: i, x: i / n, lo: -1, hi: -1, ratio: value / at[0] };
  }
  if (value > Math.max(...at)) return { kind: "above", index: at.indexOf(Math.max(...at)), x: 1, lo: -1, hi: -1 };
  if (value < Math.min(...at)) return { kind: "below", index: at.indexOf(Math.min(...at)), x: 0, lo: -1, hi: -1 };
  for (let i = 0; i < n; i++) {
    const [a, b] = [at[i], at[i + 1]];
    if (Math.min(a, b) < value && value < Math.max(a, b)) {
      const f = (value - a) / (b - a);
      return { kind: "near", index: f < 0.5 ? i : i + 1, x: (i + f) / n, lo: i, hi: i + 1 };
    }
  }
  const nearest = at.reduce((best, v, i) => (Math.abs(v - value) < Math.abs(at[best] - value) ? i : best), 0);
  return { kind: "near", index: nearest, x: nearest / n, lo: nearest, hi: nearest };
}

/** How much thinner the chip is than the feed per tooth at this stepover (% of the diameter). */
export function thinning(stepoverPct: number): number {
  const ae = stepoverPct / 100;
  return ae >= 0.5 ? 1 : 1 / Math.sqrt(1 - (1 - 2 * ae) ** 2);
}

/** A number as stored: no padding, no invented precision. */
export function num(v: number): string {
  return Number.isFinite(v) ? String(Number(v.toPrecision(12))) : String(v);
}
const rounded = (v: number, places: number) => num(Number(v.toFixed(places)));

export interface Flag {
  key: "chip-thick" | "chip-thin" | "power-high";
  word: string;
  sentence: string;
}

/**
 * What a row's own values do outside anything the model allows, apart from
 * where it sits. `stops` are the stops the row is compared against: the power
 * cap can hold a stop under the class floor, and a row no thinner than the
 * model's own suggestion is not flagged for it. `adaptive`: the chip is
 * thinned by the narrow stepover, and the power is that of the engaged width.
 */
export function cutFlags(limits: FeedLimits | null, cut: Cut | Omit<Cut, "plunge">, stops: ({ chip: number | null; stepoverPct?: number } | null)[] = [], adaptive = false): Flag[] {
  if (!limits) return [];
  const { feed, rpm, stepoverMm, stepdown, diameter } = cut;
  const ok = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
  const flutes = ok(cut.flutes) ? Math.max(1, Math.trunc(cut.flutes)) : NaN;
  const flags: Flag[] = [];
  // A class limit beside a three-decimal chip: at least two decimals (0.10, 0.02, 0.004).
  const lim = (x: number) => (/\.\d{2,}$/.test(num(x)) ? num(x) : Number(x).toFixed(2));
  const thin = adaptive && ok(stepoverMm) && ok(diameter) ? thinning((stepoverMm / diameter) * 100) : 1;
  if (ok(feed) && ok(rpm) && ok(flutes) && (!adaptive || (ok(stepoverMm) && ok(diameter))) && Number.isFinite(thin)) {
    const chip = feed / (rpm * flutes) / thin;
    const shown = Number(chip.toFixed(4));
    const what = adaptive ? "thinned chip load" : "chip load";
    const stopChips = stops.filter((x): x is { chip: number; stepoverPct?: number } => !!x && ok(x.chip) && (!adaptive || ok(x.stepoverPct))).map((x) => Number((x.chip / (adaptive ? thinning(x.stepoverPct as number) : 1)).toFixed(4)));
    const floor = Math.min(limits.chipFloor, ...stopChips);
    if (shown > limits.chipMax) {
      flags.push({ key: "chip-thick", word: "chip thick", sentence: `This row's ${what} ${rounded(chip, 3)} mm/tooth is over the ${limits.classLabel} maximum of ${lim(limits.chipMax)}.` });
    } else if (shown < floor) {
      flags.push({ key: "chip-thin", word: "chip thin", sentence: `This row's ${what} ${rounded(chip, 4)} mm/tooth is under the ${limits.classLabel} floor of ${lim(limits.chipFloor)} at ${num(limits.cutDiameter ?? diameter)} mm: the edge rubs.` });
    }
  }
  if (ok(feed) && ok(rpm) && ok(stepdown) && (!adaptive || ok(stepoverMm))) {
    const sl = limits.slot;
    const area = adaptive ? stepoverMm * stepdown : sl.round ? sl.round * stepdown * stepdown : stepdown * (sl.width + stepdown * sl.tan);
    const power = (limits.energy * area * feed) / 60;
    const cap = limits.powerCapW * Math.min(1, rpm / limits.rpmMax);
    if (Number(power.toFixed(1)) > Number(cap.toFixed(1))) {
      flags.push({ key: "power-high", word: "power high", sentence: `This row needs about ${Math.round(power)} W, over the ${rounded(cap, 1)} W Aggressive cap at ${num(rpm)} rpm.` });
    }
  }
  return flags;
}

// ---- A row against its entry ----

/** A drill's suggestion: only spindle and plunge, so it is measured by plunge per revolution. */
const plungeOnly = (s: FeedSuggestion) => s.fields.includes("plunge") && !s.fields.includes("feed");

/** The five stops' suggestions at a pick; null where the model has no cut with a feed or, for a drill, a plunge. */
export function stopsAt(entry: FeedEntry | null, pick: Pick): (FeedSuggestion | null)[] {
  return LEVELS.map((level) => {
    const s = sugCombo(entry, { ...pick, level });
    return s && s.status !== "none" && s.values && (s.fields.includes("feed") || plungeOnly(s)) ? s : null;
  });
}

const stopVol = (s: FeedSuggestion | null) => (!s || !s.values ? null : plungeOnly(s) ? plungePerRev(s.values.plunge, s.values.rpm) : volPerRev(s.values.feed, s.values.rpm, s.values.stepoverMm, s.values.stepdown));

/** Whether this entry's stops at this pick measure a cut by plunge per revolution (a drill). */
export const byPlunge = (entry: FeedEntry | null, pick: Pick) => stopsAt(entry, pick).some((s) => s && plungeOnly(s));

/** Where the row's cut sits among the stops at this pick. */
export function cutPlace(entry: FeedEntry | null, pick: Pick, cut: Cut, defaultIndex: number): Place {
  const own = byPlunge(entry, pick) ? plungePerRev(cut.plunge, cut.rpm) : volPerRev(cut.feed, cut.rpm, cut.stepoverMm, cut.stepdown);
  return placeAmong(entry ? stopsAt(entry, pick).map(stopVol) : null, own, defaultIndex);
}

/** The row's chip-load and power flags, judged at its own default pick, not the one on show. */
export function rowFlags(entry: FeedEntry | null, cut: Cut): Flag[] {
  if (!entry || !entry.limits) return [];
  const def = parseCombo(entry.default);
  return cutFlags(
    entry.limits,
    cut,
    stopsAt(entry, def).map((s) => s && { chip: s.chipLoad, stepoverPct: s.values?.stepoverPct }),
    def.adaptive,
  );
}

/** How far a row is off stops that are all the same cut: "8% over every stop". */
function flatText(ratio: number | undefined): string {
  const r = ratio ?? NaN;
  if (!Number.isFinite(r) || r <= 0) return "differs from every stop";
  const pct = Math.round(Math.abs(r - 1) * 100);
  return pct < 1 ? "≈ every stop" : `${pct}% ${r > 1 ? "over" : "under"} every stop`;
}

/** What the ruler's words are for a place. */
export function placeText(place: Place): string {
  const stop = place.index >= 0 ? LEVEL_LABELS[LEVELS[place.index]] : "";
  return { none: "—", blank: "—", on: stop, near: `≈ ${stop}`, below: `below ${LEVEL_LABELS.gentle}`, above: `above ${LEVEL_LABELS.aggressive}`, flat: flatText(place.ratio) }[place.kind];
}

export const CUT_FIELDS = ["rpm", "feed", "plunge", "stepover", "stepdown"] as const;
export type CutField = (typeof CUT_FIELDS)[number];
export type CutValues = Record<CutField, number>;

/** Six decimals: fine enough that a percentage kept as mm is the same percentage when turned back. */
export const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** The model's own value for each field, the stepover in mm as the row would keep it in its unit. */
export function modelValues(row: CuttingSettings, s: FeedSuggestion, diameter: number): CutValues | null {
  const v = s.values;
  if (!v) return null;
  const stepover = row.stepoverUnit === "percent" ? round6((v.stepoverPct / 100) * diameter) : v.stepoverMm;
  return { rpm: v.rpm, feed: v.feed, plunge: v.plunge, stepover, stepdown: v.stepdown };
}

/**
 * The values "Use suggestion" would leave in the row: the suggested ones.
 * What the model does not stand behind for this kind of tool (a drill's feed,
 * stepover and depth) stays the row's own.
 */
export function suggestedValues(row: CuttingSettings, s: FeedSuggestion, diameter: number): CutValues | null {
  const model = modelValues(row, s, diameter);
  if (!model) return null;
  const out = { ...model };
  for (const f of CUT_FIELDS) if (!s.fields.includes(f)) out[f] = row[f];
  return out;
}

/** The same to a tenth of a micron: a suggested stepover is rounded to four decimals of a mm, one kept in percent to six. */
export const sameValue = (a: number, b: number) => Math.abs(a - b) <= 1e-4;

/** Does the row hold exactly this suggestion? */
export function rowHolds(row: CuttingSettings, s: FeedSuggestion | null, diameter: number): boolean {
  if (!s || s.status === "none") return false;
  const out = suggestedValues(row, s, diameter);
  return out !== null && CUT_FIELDS.every((f) => sameValue(out[f], row[f]));
}

export interface Match {
  kind: "default" | "match" | "between" | "none";
  text: string;
}

/**
 * Where the row stands against every combination. An exact match names its
 * combination, the profile's default first; otherwise the row's cut is placed
 * among the stops at the pick, exactly as its ruler places it.
 * `ownDefaults`: the row's profile has a stop of its own.
 */
export function matchOf(row: CuttingSettings, entry: FeedEntry, pick: Pick | null, cut: Cut | null, diameter: number, ownDefaults: boolean): Match {
  const combos = entry.combos;
  const def = parseCombo(entry.default);
  if (ownDefaults && rowHolds(row, sugCombo(entry, def), diameter)) return { kind: "default", text: `✓ matches the profile's default (${describePick(def)})` };
  // A plain row never takes an Adaptive suggestion, so it is never said to match one.
  // In stop order, the plainest way of cutting first: where two stops give the same values the gentler is named.
  const hits = Object.keys(combos)
    .filter((k) => (row.profile !== undefined || !parseCombo(k).adaptive) && rowHolds(row, combos[k], diameter))
    .sort((a, b) => LEVELS.indexOf(parseCombo(a).level) - LEVELS.indexOf(parseCombo(b).level) || a.length - b.length);
  if (hits.length) {
    // A drill's or thread mill's values are the same at every stop: say so rather than naming the first.
    const first = parseCombo(hits[0]);
    const every = LEVELS.every((level) => hits.includes(comboKey({ ...first, level })));
    return { kind: "match", text: every ? `✓ matches every stop${describePick(first).replace(/^[a-z-]+/, "")}` : `✓ matches ${describePick(first)}` };
  }
  const p = pick ?? def;
  const place: Place | { kind: "none"; index: number; lo: number; hi: number } = cut ? cutPlace(entry, p, cut, LEVELS.indexOf(def.level)) : { kind: "none", index: -1, lo: -1, hi: -1 };
  const name = (i: number) => LEVEL_LABELS[LEVELS[i]];
  const text: Partial<Record<Place["kind"], string>> = {
    on: `level with ${name(place.index)}`,
    near: place.lo === place.hi ? `≈ ${name(place.index)}` : `between ${name(place.lo)} and ${name(place.hi)}`,
    below: `below ${LEVEL_LABELS.gentle}`,
    above: `above ${LEVEL_LABELS.aggressive}`,
    flat: place.kind === "flat" ? flatText(place.ratio) : undefined,
  };
  const words = text[place.kind];
  if (words) return { kind: "between", text: words };
  return { kind: "none", text: Object.values(combos).some((s) => s && s.status !== "none") ? "differs from every stop" : "" };
}

/** One word for a row: no suggestion, or whether it holds one. */
export function rowStatus(row: CuttingSettings, entry: FeedEntry | null, diameter: number, ownDefaults: boolean): "no suggestion" | "matches" | "differs" {
  const d = entry ? sugCombo(entry, parseCombo(entry.default)) : null;
  if (!entry || !d || d.status === "none") return "no suggestion";
  return ["default", "match"].includes(matchOf(row, entry, null, null, diameter, ownDefaults).kind) ? "matches" : "differs";
}

export function powerText(w: number): string {
  return w < 1 ? "<1 W" : `≈${Math.round(w)} W`;
}
