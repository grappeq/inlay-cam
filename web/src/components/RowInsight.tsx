// What the feeds model makes of one cutting row: what its numbers come to,
// where it sits among the model's five stops, and what the model would start
// from. Shared by the tool's sheet and its editor.

import { useEffect, useState } from "react";
import { core } from "../core/client";
import type { CutResult, CuttingSettings, FeedLevel, FeedSuggestion, RowCheck, Tool, ToolLists } from "../core/types";
import { OUTCOMES, currentResult, feedMaterial, fmt, materialLabel, today } from "../state/model";

export const LEVELS: { key: FeedLevel; label: string }[] = [
  { key: "gentle", label: "Gentle" },
  { key: "slot_safe", label: "Slot-safe" },
  { key: "standard", label: "Standard" },
  { key: "firm", label: "Firm" },
  { key: "aggressive", label: "Aggressive" },
];

/** Six decimals: fine enough that a percentage kept as mm is the same percentage when turned back. */
export const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
export const percentOf = (row: CuttingSettings, diameter: number) => Math.round((row.stepover / diameter) * 100000) / 1000;

export interface Flags {
  ramping: boolean;
  lubricated: boolean;
}

export interface Insight {
  /** The row is for adaptive clearing. */
  adaptive: boolean;
  /** The suggestion at each stop, gentlest first; null until worked out, or when the tool's shape cannot be read. */
  stops: FeedSuggestion[] | null;
  check: RowCheck | null;
}

/** Where a profile's suggestions begin. */
export function profileFlags(row: CuttingSettings, lists: ToolLists): Flags & { level: FeedLevel } {
  const profile = lists.profiles?.find((p) => p.key === row.profile);
  return { level: profile?.level ?? "slot_safe", ramping: profile?.ramping ?? false, lubricated: profile?.lubricated ?? false };
}

export function useInsight(tool: Tool, row: CuttingSettings, lists: ToolLists, flags: Flags): Insight {
  const profile = lists.profiles?.find((p) => p.key === row.profile);
  const adaptive = row.profile !== undefined && (profile?.adaptive ?? row.profile === "adaptive");
  const [stops, setStops] = useState<FeedSuggestion[] | null>(null);
  const [check, setCheck] = useState<RowCheck | null>(null);

  // The model reads the tool's shape and name only: its rows are left out, so one being edited cannot trip it.
  const shape = JSON.stringify({ ...tool, id: tool.id || "new", name: tool.name || "Tool", cutting: [], verify: undefined, inventory: undefined, source: undefined });
  const material = feedMaterial(row.material, lists);
  const { ramping, lubricated } = flags;
  useEffect(() => {
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        const bare: Tool = JSON.parse(shape);
        const [nextStops, nextCheck] = await Promise.all([
          core.call("suggestStops", bare, material, { ramping, adaptive, lubricated }),
          core.call("checkRow", bare, material, { rpm: row.rpm, feed: row.feed, plunge: row.plunge, stepover: row.stepover, stepdown: row.stepdown, adaptive }),
        ]);
        if (!stale) {
          setStops(nextStops);
          setCheck(nextCheck);
        }
      } catch {
        // A shape the core cannot read yet, mid-edit: say nothing until it can.
        if (!stale) {
          setStops(null);
          setCheck(null);
        }
      }
    }, 120);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [shape, material, ramping, adaptive, lubricated, row.rpm, row.feed, row.plunge, row.stepover, row.stepdown]);

  return { adaptive, stops, check };
}

export interface Place {
  /** The stop whose values the row has exactly, or -1. */
  exact: number;
  /** Where the row sits on the scale of stops, 0 (Gentle) to 4 (Aggressive); beyond either end when it removes less or more. Null when there are no stops to compare with. */
  position: number | null;
  text: string | null;
}

/** Where a row sits among the stops, by how much it removes: feed times depth. */
export function placeOf(row: CuttingSettings, stops: FeedSuggestion[] | null): Place {
  if (!stops || stops.some((s) => !s.values)) return { exact: -1, position: null, text: null };
  const exact = stops.findIndex((s) => s.values && s.values.rpm === row.rpm && s.values.feed === row.feed && s.values.plunge === row.plunge && s.values.stepdown === row.stepdown);
  if (exact >= 0) return { exact, position: exact, text: LEVELS[exact].label.toLowerCase() };
  const rate = row.feed * row.stepdown;
  const rates = stops.map((s) => (s.values ? s.values.feed * s.values.stepdown : 0));
  const below = rates.filter((r) => r < rate).length;
  if (below === 0) return { exact, position: -0.6, text: "below gentle" };
  if (below === LEVELS.length) return { exact, position: LEVELS.length - 0.4, text: "above aggressive" };
  const [low, high] = [rates[below - 1], rates[below]];
  const part = high > low ? Math.min(1, Math.max(0, (rate - low) / (high - low))) : 0.5;
  return { exact, position: below - 1 + part, text: `${LEVELS[below - 1].label.toLowerCase()} to ${LEVELS[below].label.toLowerCase()}` };
}

/** The five stops as ticks, with the row marked where it sits. */
export function Ruler({ place }: { place: Place }) {
  if (place.position === null) return <span className="muted">no model</span>;
  const step = 22;
  const at = (i: number) => 14 + i * step;
  const out = place.position < 0 || place.position > LEVELS.length - 1;
  return (
    <span className="ruler" title={`Removes about as much as: ${place.text}. The ticks are Gentle, Slot-safe, Standard, Firm and Aggressive.`}>
      <svg viewBox={`0 0 ${at(4) + 14} 18`} aria-hidden="true">
        <line className="ruler-line" x1={at(0)} y1={12} x2={at(4)} y2={12} />
        {LEVELS.map((l, i) => (
          <line key={l.key} className={i === 1 ? "ruler-tick safe" : "ruler-tick"} x1={at(i)} y1={i === 1 ? 6 : 8} x2={at(i)} y2={16} />
        ))}
        <path className={out ? "ruler-mark out" : "ruler-mark"} d={`M ${at(place.position)} 11 l -4 -8 h 8 Z`} />
      </svg>
      <span className={out ? "ruler-text warn" : "ruler-text"}>{place.text}</span>
    </span>
  );
}

/** The latest result of a row, as a mark. */
export function ResultMark({ row, short }: { row: CuttingSettings; short?: boolean }) {
  const outcome = currentResult(row)?.outcome;
  if (outcome) {
    return (
      <span className={`mark ${OUTCOMES[outcome].tone}`} title={OUTCOMES[outcome].text}>
        {OUTCOMES[outcome].mark}
        {short ? "" : ` ${OUTCOMES[outcome].text}`}
      </span>
    );
  }
  if (short) return null;
  return (row.log ?? []).length > 0 ? <span className="mark warn">▲ untested at these numbers</span> : <span className="muted">no result logged</span>;
}

/** What a row's numbers come to at the edge, and what the model has against them. */
export function RowFacts({ insight }: { insight: Insight }) {
  const { check, adaptive } = insight;
  if (!check) return null;
  return (
    <>
      {check.chipLoad != null && (
        <p className="readouts">
          <span>
            chip <b>{fmt(check.chipLoad)}</b> mm/tooth
            {check.chipFloor != null && check.chipMax != null ? ` (should be ${fmt(check.chipFloor)} to ${fmt(check.chipMax)})` : ""}
          </span>
          {check.surfaceSpeed != null && (
            <span>
              <b>{fmt(check.surfaceSpeed)}</b> m/min at the edge
            </span>
          )}
          {check.powerW != null && (
            <span>
              about <b>{fmt(check.powerW)}</b> W {adaptive ? "at this stepover" : "as a full slot"}
              {check.powerCapW != null ? ` (cap ${fmt(check.powerCapW)})` : ""}
            </span>
          )}
        </p>
      )}
      {check.warnings.map((warning) => (
        <p key={warning} className="hint warn">
          {warning}
        </p>
      ))}
    </>
  );
}

/** The model's five stops for a row, one of them shown in full, with a way to take its values. */
export function Suggestions(props: {
  tool: Tool;
  row: CuttingSettings;
  lists: ToolLists;
  insight: Insight;
  flags: Flags;
  setFlags: (flags: Flags) => void;
  level: FeedLevel;
  setLevel: (level: FeedLevel) => void;
  onUse: (change: Partial<CuttingSettings>) => void;
}) {
  const { tool, row, lists, insight, flags } = props;
  const { stops, check, adaptive } = insight;
  if (check && !check.covered) {
    return (
      <p className="hint">
        The feeds model does not know {materialLabel(row.material, lists).toLowerCase()}. Under Materials, say which material it cuts like to get suggestions.
      </p>
    );
  }
  if (!stops) return null;
  const place = placeOf(row, stops);
  const profile = lists.profiles?.find((p) => p.key === row.profile);
  const chosen = stops[LEVELS.findIndex((l) => l.key === props.level)];
  // A profile for full-width cuts takes the whole diameter as its stepover.
  const slot = profile?.slot === true && !adaptive && (tool.kind === "flat_end" || tool.kind === "ball_end");
  const suggested = chosen?.values ? (slot ? { ...chosen.values, stepoverPct: 100, stepoverMm: tool.diameter } : chosen.values) : null;

  const use = () => {
    if (!chosen || !suggested) return;
    const change: Partial<CuttingSettings> = {};
    if (chosen.fields.includes("rpm")) change.rpm = suggested.rpm;
    if (chosen.fields.includes("feed")) change.feed = suggested.feed;
    if (chosen.fields.includes("plunge")) change.plunge = suggested.plunge;
    if (chosen.fields.includes("stepdown")) change.stepdown = suggested.stepdown;
    if (chosen.fields.includes("stepover")) {
      change.stepover = round6((suggested.stepoverPct / 100) * tool.diameter);
      change.stepoverUnit = "percent";
    }
    props.onUse(change);
  };

  return (
    <div className="suggest">
      <div className="stops" role="radiogroup" aria-label="How hard a cut">
        {LEVELS.map((l, i) => (
          <button type="button" key={l.key} role="radio" aria-checked={props.level === l.key} className={place.exact === i ? "stop is-row" : "stop"} onClick={() => props.setLevel(l.key)}>
            <span>{l.label}</span>
            <span className="num">{stops[i].values ? `${stops[i].values?.feed} × ${fmt(stops[i].values?.stepdown ?? 0)}` : "none"}</span>
          </button>
        ))}
      </div>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={flags.ramping} onChange={(e) => props.setFlags({ ...flags, ramping: e.target.checked })} />
          Ramped entry
        </label>
        {check?.lubricationMatters && (
          <label className="check">
            <input type="checkbox" checked={flags.lubricated} onChange={(e) => props.setFlags({ ...flags, lubricated: e.target.checked })} />
            Lubricated
          </label>
        )}
        {adaptive && <span className="muted">Shaped for adaptive clearing.</span>}
      </div>
      {chosen && suggested ? (
        <>
          <p className="suggested">
            <span className="num">
              {suggested.rpm} rpm, feed {suggested.feed}, plunge {suggested.plunge}, stepover {fmt(suggested.stepoverPct)} % ({fmt(suggested.stepoverMm)} mm), {fmt(suggested.stepdown)} mm deep
            </span>
            <button type="button" onClick={use} disabled={place.exact === LEVELS.findIndex((l) => l.key === props.level)}>
              Use these values
            </button>
          </p>
          <p className="hint">
            Chip {fmt(chosen.chipLoad ?? 0)} mm/tooth, {fmt(chosen.surfaceSpeed ?? 0)} m/min, about {fmt(chosen.powerW ?? 0)} W of a {fmt(chosen.powerLimitW ?? 0)} W cap
            {chosen.classLabel ? `, as ${chosen.classLabel.toLowerCase()}` : ""}.
            {chosen.fields.length < 5 ? " Only the spindle speed and plunge are the model's; the rest stays as it is." : ""}
          </p>
          {chosen.reason && <p className="hint warn">{chosen.reason}</p>}
          {chosen.notes.map((note) => (
            <p key={note} className="hint">
              {note}
            </p>
          ))}
        </>
      ) : (
        <p className="hint warn">{chosen?.reason ?? "No suggestion."}</p>
      )}
    </div>
  );
}

/** A row's field log, newest first, each entry with whether it still counts. */
export function LogList({ row }: { row: CuttingSettings }) {
  const logged = row.log ?? [];
  const current = currentResult(row);
  if (logged.length === 0) return null;
  return (
    <ul className="log-list">
      {[...logged]
        .sort((a, b) => b.date.localeCompare(a.date))
        .map((entry, i) => {
          const counts = current !== undefined && entry.at !== undefined && JSON.stringify(entry.at) === JSON.stringify(current.at);
          return (
            <li key={i} className={counts ? "" : "past"}>
              <span className="num">{entry.date}</span>
              {entry.outcome ? (
                <span className={`mark ${OUTCOMES[entry.outcome].tone}`}>
                  {OUTCOMES[entry.outcome].mark} {OUTCOMES[entry.outcome].text}
                </span>
              ) : (
                <span className="muted">noted</span>
              )}
              <span>
                {entry.text}
                {!counts && (
                  <span className="hint">
                    {entry.at ? `At feed ${fmt(entry.at.feed)}, ${fmt(entry.at.stepdown)} mm deep, ${entry.at.rpm} rpm: not the row's present numbers.` : "Numbers not recorded."}
                  </span>
                )}
              </span>
            </li>
          );
        })}
    </ul>
  );
}

/** Adds what happened on a cut to a row's log, at the numbers the row has now. */
export function LogResult(props: { onAdd: (entry: CutResult) => void; saves: "now" | "with the tool" }) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<NonNullable<CutResult["outcome"]>>("ok");
  const [text, setText] = useState("");
  const [date, setDate] = useState(today());
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Log a result…
      </button>
    );
  }
  const add = () => {
    if (text.trim() === "" || date === "") return;
    props.onAdd({ date, outcome, text: text.trim() });
    setText("");
    setOpen(false);
  };
  return (
    <div className="log-form" role="group" aria-label="Log a result">
      <div className="row">
        {(Object.keys(OUTCOMES) as (keyof typeof OUTCOMES)[]).map((key) => (
          <label key={key} className="check">
            <input type="radio" checked={outcome === key} onChange={() => setOutcome(key)} />
            <span className={`mark ${OUTCOMES[key].tone}`}>
              {OUTCOMES[key].mark} {OUTCOMES[key].text}
            </span>
          </label>
        ))}
      </div>
      <div className="row">
        <label className="field wide grow">
          <span className="field-label">What happened</span>
          <input
            type="text"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter adds the entry; it must not submit a form around it.
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
        </label>
        <label className="field">
          <span className="field-label">Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <button type="button" className="primary" disabled={text.trim() === "" || date === ""} onClick={add}>
          Add to the log
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <span className="hint">Recorded at the numbers the row has now{props.saves === "now" ? "." : ", and kept when you save the tool."}</span>
      </div>
    </div>
  );
}

/** The row's numbers as a log entry records them. */
export function valuesOf(row: CuttingSettings): NonNullable<CutResult["at"]> {
  return { rpm: row.rpm, feed: row.feed, plunge: row.plunge, stepover: row.stepover, stepoverUnit: row.stepoverUnit, stepdown: row.stepdown, passes: row.passes };
}
