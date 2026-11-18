import { describe, expect, it } from "vitest";
import type { CuttingSettings, FeedEntry, FeedLimits, FeedSuggestion } from "../core/types";
import { comboKey, cutFlags, cutPlace, matchOf, parseCombo, placeAmong, placeText, rowFlags, rowHolds, rowStatus, suggestedValues, thinning, volPerRev, type Cut } from "./feedsView";

// The cases of the tooling library's own smoke test for its ruler, word for word.
describe("placeAmong", () => {
  const r = (stops: (number | null)[], v: number, def: number) => {
    const p = placeAmong(stops, v, def);
    return `${p.kind}:${p.index}:${Math.round(p.x * 1000) / 1000}:${p.lo}-${p.hi}`;
  };
  it("places a value as the workbench does", () => {
    expect({
      on: r([500, 700, 900, 1100, 1300], 900, 1),
      onDefaultWins: r([750, 1080, 1080, 1080, 1080], 1080, 1),
      onLowestOfPlateau: r([750, 1080, 1080, 1080, 1080], 1080, 0),
      onWithinRounding: r([5, 7, 9, 11, 13], 7 * (1 + 1e-9), 1),
      mid: r([500, 700, 900, 1100, 1300], 600, 1),
      nearUpper: r([500, 700, 900, 1100, 1300], 1050, 1),
      nonMonotonic: r([900, 1000, 850, 1100, 1200], 925, 1),
      above: r([500, 700, 900, 1100, 1300], 1301, 1),
      below: r([500, 700, 900, 1100, 1300], 499, 1),
      allEqual: r([800, 800, 800, 800, 800], 800, 1),
      twoStops: r([500, 700], 600, 0),
      none: r([500, null, 900, 1100, 1300], 700, 1),
      short: r([500], 600, 0),
      blank: r([500, 700, 900, 1100, 1300], NaN, 1),
      infinite: r([500, 700, 900, 1100, 1300], Infinity, 1),
    }).toEqual({
      on: "on:2:0.5:2-2",
      onDefaultWins: "on:1:0.25:1-1",
      onLowestOfPlateau: "on:1:0.25:1-1",
      onWithinRounding: "on:1:0.25:1-1",
      mid: "near:1:0.125:0-1",
      nearUpper: "near:3:0.688:2-3",
      nonMonotonic: "near:0:0.063:0-1",
      above: "above:4:1:-1--1",
      below: "below:0:0:-1--1",
      allEqual: "on:1:0.25:1-1",
      twoStops: "near:1:0.5:0-1",
      none: "none:-1:0:-1--1",
      short: "none:-1:0:-1--1",
      blank: "blank:-1:0:-1--1",
      infinite: "blank:-1:0:-1--1",
    });
  });
  // Not in the tooling library: stops that are all one cut have no end to be past.
  it("places a value off stops that are all the same as off every stop, not past an end", () => {
    const flat = [0.6923, 0.6923, 0.6923, 0.6923, 0.6923];
    expect(r(flat, 0.75, 1)).toBe("flat:1:0.25:-1--1");
    expect(r(flat, 0.5, 2)).toBe("flat:2:0.5:-1--1");
    expect(placeText(placeAmong(flat, 0.75, 1))).toBe("8% over every stop");
    expect(placeText(placeAmong(flat, 0.6, 1))).toBe("13% under every stop");
    expect(placeText(placeAmong(flat, 0.6925, 1))).toBe("≈ every stop");
    expect(placeText(placeAmong(flat, 0.6923, 1))).toBe("slot-safe");
  });
});

const hw: FeedLimits = { classLabel: "Hardwood", chipFloor: 0.02, chipMax: 0.1, energy: 0.1, slot: { width: 6, tan: 0, round: 0 }, powerCapW: 120, rpmMax: 12000 };
const cut = (o: Partial<Cut> = {}): Cut => ({ feed: 2700, plunge: 300, rpm: 12000, stepoverMm: 2.4, stepdown: 2, flutes: 2, diameter: 6, ...o });

describe("cutFlags", () => {
  const f = (c: Cut, chips: { chip: number; stepoverPct?: number }[] = [], adaptive = false, lim: FeedLimits | null = hw) => cutFlags(lim, c, chips, adaptive).map((x) => `${x.key}|${x.word}|${x.sentence}`);
  const thick = ["chip-thick|chip thick|This row's chip load 0.113 mm/tooth is over the Hardwood maximum of 0.10."];
  it("measures a cut by what it removes per revolution", () => {
    expect(Math.round(volPerRev(2700, 12000, 2.4, 2) * 1e6) / 1e6).toBe(1.08);
    expect(volPerRev(2700, NaN, 2.4, 2)).toBeNaN();
    expect(volPerRev(2700, 0, 2.4, 2)).toBeNaN();
    expect([Math.round(thinning(12) * 1000) / 1000, thinning(50), thinning(80)]).toEqual([1.539, 1, 1]);
  });
  it("flags a chip outside the band", () => {
    expect(f(cut())).toEqual(thick);
    expect(f(cut({ feed: 2400 }))).toEqual([]);
    expect(f(cut({ stepdown: NaN }))).toEqual(thick);
    expect(cutFlags(null, cut())).toEqual([]);
    expect(f(cut({ feed: 360 }))).toEqual(["chip-thin|chip thin|This row's chip load 0.015 mm/tooth is under the Hardwood floor of 0.02 at 6 mm: the edge rubs."]);
    // A row no thinner than the model's own suggestion is not flagged.
    expect(f(cut({ feed: 360 }), [{ chip: 0.012 }, { chip: 0.02 }])).toEqual([]);
    expect(f(cut({ flutes: 2.5 }))).toEqual(thick);
    expect(f(cut({ feed: 48 }), [], false, { ...hw, chipFloor: 0.004 })).toEqual(["chip-thin|chip thin|This row's chip load 0.002 mm/tooth is under the Hardwood floor of 0.004 at 6 mm: the edge rubs."]);
  });
  it("thins an adaptive row's chip, and takes its power at its own width", () => {
    expect(f(cut({ feed: 600, stepoverMm: 0.72 }), [{ chip: 0.025, stepoverPct: 12 }], true)).toEqual([]);
    expect(f(cut({ feed: 500, stepoverMm: 0.72 }), [{ chip: 0.025, stepoverPct: 12 }], true)).toEqual([
      "chip-thin|chip thin|This row's thinned chip load 0.0135 mm/tooth is under the Hardwood floor of 0.02 at 6 mm: the edge rubs.",
    ]);
    expect(f(cut({ stepoverMm: 1e-300 }), [], true)).toEqual([]);
    expect(f(cut({ feed: 3800, stepoverMm: 0.72, stepdown: 12 }), [], true)).toEqual(["chip-thick|chip thick|This row's thinned chip load 0.103 mm/tooth is over the Hardwood maximum of 0.10."]);
    expect(f(cut({ feed: 3800, stepoverMm: NaN }), [], true)).toEqual([]);
  });
  it("flags more power than the hardest stop allows", () => {
    expect(f(cut({ feed: 2400, stepdown: 12 }))).toEqual(["power-high|power high|This row needs about 288 W, over the 120 W Aggressive cap at 12000 rpm."]);
    expect(f(cut({ rpm: 6000, feed: 1200, stepdown: 7 }))).toEqual(["power-high|power high|This row needs about 84 W, over the 60 W Aggressive cap at 6000 rpm."]);
  });
});

// A made-up entry: five stops whose feed rises, plain and ramped, and an adaptive set.
function suggestion(level: string, feed: number, o: Partial<FeedSuggestion> & { adaptive?: boolean; ramping?: boolean } = {}): FeedSuggestion {
  const adaptive = o.adaptive ?? false;
  return {
    status: "ok",
    reason: null,
    values: { rpm: 12000, feed, plunge: o.ramping ? 300 : 150, stepoverPct: adaptive ? 12 : 40, stepoverMm: adaptive ? 0.72 : 2.4, stepdown: adaptive ? 6 : 1 },
    fields: ["rpm", "feed", "plunge", "stepover", "stepdown"],
    classLabel: "Hardwood",
    chipLoad: feed / 24000,
    surfaceSpeed: 226,
    powerW: 20,
    powerLimitW: 80,
    spindleW: 200,
    notes: [],
    untested: false,
    options: { level: level as FeedSuggestion["options"]["level"], ramping: o.ramping ?? false, adaptive, lubricated: false },
    ...o,
  };
}
const FEEDS = { gentle: 600, slot_safe: 800, standard: 1200, firm: 1400, aggressive: 1600 };
function entry(def = "slot_safe"): FeedEntry {
  const combos: Record<string, FeedSuggestion> = {};
  for (const [level, feed] of Object.entries(FEEDS)) {
    for (const ramping of [false, true]) {
      for (const adaptive of [false, true]) {
        combos[comboKey({ level: level as keyof typeof FEEDS, ramping, adaptive, lubricated: false })] = suggestion(level, adaptive ? feed * 2 : feed, { ramping, adaptive });
      }
    }
  }
  return { covered: true, default: def, combos, limits: hw, lubrication: false };
}
const row = (o: Partial<CuttingSettings> = {}): CuttingSettings => ({ material: "hardwood", rpm: 12000, feed: 800, plunge: 150, stepover: 2.4, stepdown: 1, ...o });
const asCut = (r: CuttingSettings): Cut => ({ feed: r.feed, plunge: r.plunge, rpm: r.rpm, stepoverMm: r.stepover, stepdown: r.stepdown, flutes: 2, diameter: 6 });

describe("a row against its suggestions", () => {
  it("reads a combination's key both ways", () => {
    expect(comboKey(parseCombo("firm+ramp+adaptive+lube"))).toBe("firm+ramp+adaptive+lube");
    expect(parseCombo("nonsense").level).toBe("slot_safe");
  });
  it("holds a suggestion only when every value is the same", () => {
    const e = entry();
    expect(rowHolds(row(), e.combos.slot_safe, 6)).toBe(true);
    expect(rowHolds(row({ stepover: 2.5 }), e.combos.slot_safe, 6)).toBe(false);
    // A stepover turned between mm and percent is still the same stepover.
    expect(rowHolds(row({ stepover: 2.40005 }), e.combos.slot_safe, 6)).toBe(true);
    expect(rowStatus(row(), e, 6, false)).toBe("matches");
    expect(rowStatus(row({ feed: 801 }), e, 6, false)).toBe("differs");
    expect(rowStatus(row(), null, 6, false)).toBe("no suggestion");
  });
  it("names the combination a row matches, and never an adaptive one for a plain row", () => {
    const e = entry();
    expect(matchOf(row({ plunge: 300 }), e, null, null, 6, false).text).toBe("✓ matches slot-safe · ramped");
    const adaptive = row({ feed: 1600, stepover: 0.72, stepdown: 6 });
    expect(matchOf(adaptive, e, null, asCut(adaptive), 6, false).kind).toBe("between");
    expect(matchOf({ ...adaptive, profile: "adaptive" }, e, null, null, 6, false).text).toBe("✓ matches slot-safe · Adaptive");
    const own = entry("firm+ramp");
    expect(matchOf(row({ feed: 1400, plunge: 300, profile: "contour" }), own, null, null, 6, true).text).toBe("✓ matches the profile's default (firm · ramped)");
  });
  it("places a row that matches nothing as its ruler does", () => {
    const e = entry();
    const between = row({ feed: 1000 });
    expect(matchOf(between, e, null, asCut(between), 6, false).text).toBe("between slot-safe and standard");
    expect(cutPlace(e, parseCombo("slot_safe"), asCut(between), 1).kind).toBe("near");
    const over = row({ feed: 2000 });
    expect(matchOf(over, e, null, asCut(over), 6, false).text).toBe("above aggressive");
    // The same feed at half the depth removes half as much: placed by volume, not by feed.
    const shallow = row({ feed: 1600, stepdown: 0.5 });
    expect(matchOf(shallow, e, null, asCut(shallow), 6, false).text).toBe("level with slot-safe");
  });
  it("says how far a row is off stops that are all the same cut", () => {
    // A corner-rounding bit: its radius deep and the feed cap at every stop, at the machine's 13000 rpm.
    const same = entry();
    for (const k of Object.keys(same.combos)) {
      const s = same.combos[k];
      same.combos[k] = { ...s, values: { ...s.values!, rpm: 13000, feed: 1200, stepdown: 2.5 } };
    }
    const slower = row({ rpm: 12000, feed: 1200, stepdown: 2.5 });
    expect(matchOf(slower, same, null, asCut(slower), 6, false).text).toBe("8% over every stop");
  });
  it("leaves what the model does not stand behind as the row has it", () => {
    const drill = suggestion("slot_safe", 100, { fields: ["rpm", "plunge"] });
    const mine = row({ rpm: 9000, feed: 55, plunge: 40, stepover: 1, stepdown: 0.3 });
    expect(suggestedValues(mine, drill, 6)).toEqual({ rpm: 12000, feed: 55, plunge: 150, stepover: 1, stepdown: 0.3 });
    // A stepover kept in percent takes the suggested percentage, one in mm the suggested mm.
    const mill = suggestion("slot_safe", 800, { values: { rpm: 12000, feed: 800, plunge: 150, stepoverPct: 33.333, stepoverMm: 2, stepdown: 1 } });
    expect(suggestedValues(row({ stepoverUnit: "percent" }), mill, 6)?.stepover).toBe(1.99998);
    expect(suggestedValues(row(), mill, 6)?.stepover).toBe(2);
  });
  it("judges a row's flags at its own default", () => {
    expect(rowFlags(entry(), asCut(row({ feed: 2700 }))).map((f) => f.key)).toEqual(["chip-thick"]);
    expect(rowFlags({ ...entry(), limits: null }, asCut(row({ feed: 2700 })))).toEqual([]);
  });
});
