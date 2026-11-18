// What the feeds model makes of one cutting row: where it sits among the
// model's five stops, what its numbers do outside anything the model allows,
// and what the model would start from. The screen follows the tooling
// library's workbench; the reasoning is in state/feedsView.ts.

import { useEffect, useId, useState } from "react";
import { core } from "../core/client";
import { useApp } from "../state/store";
import type { CutResult, CuttingSettings, FeedEntry, Machine, RowCheck, Tool, ToolLists } from "../core/types";
import {
  CUT_FIELDS,
  LEVELS,
  LEVEL_LABELS,
  PLAIN_PICK,
  byPlunge,
  cutPlace,
  matchOf,
  modelValues,
  num,
  parseCombo,
  placeText,
  powerText,
  profilePick,
  rowCut,
  rowFlags,
  rowStatus,
  sameValue,
  sanePick,
  sugCombo,
  suggestedValues,
  type CutField,
  type CutValues,
  type Pick,
} from "../state/feedsView";
import { OUTCOMES, currentResult, feedMaterial, fmt, materialLabel, today } from "../state/model";
import { recall, remember } from "../storage/view";

export { round6 } from "../state/feedsView";
export const percentOf = (row: CuttingSettings, diameter: number) => Math.round((row.stepover / diameter) * 100000) / 1000;

/** The key of a cutting row among a tool's rows. */
export const rowKey = (row: { material: string; profile?: string }) => (row.profile === undefined ? row.material : `${row.material}@${row.profile}`);

const PICK_KEY = "tools.sugPick";

/**
 * Where the suggestion for a row starts: a profile row at its profile's
 * defaults, a plain row where the last plain row was left. A remembered pick
 * never carries Adaptive: a plain row does not take it.
 */
export function startPick(row: CuttingSettings, lists: ToolLists): Pick {
  if (row.profile !== undefined) return profilePick(lists.profiles?.find((p) => p.key === row.profile), row.profile);
  return { ...sanePick(recall(PICK_KEY, PLAIN_PICK)), adaptive: false };
}

export function rememberPick(pick: Pick) {
  remember(PICK_KEY, { level: pick.level, ramping: pick.ramping, lubricated: pick.lubricated });
}

/** The tool as the model reads it: its shape and name. Its rows are left out, so one being edited cannot trip it. */
const shapeOf = (tool: Tool) => JSON.stringify({ ...tool, id: tool.id || "new", name: tool.name || "Tool", cutting: [], verify: undefined, inventory: undefined, source: undefined, description: undefined, note: undefined });

const entries = new Map<string, FeedEntry>();

/** Everything the model has for a row, asked for once per shape, material and profile. */
export async function entryFor(tool: Tool, row: CuttingSettings, lists: ToolLists, machine: Machine): Promise<FeedEntry> {
  const shape = shapeOf(tool);
  const material = feedMaterial(row.material, lists);
  const profile = row.profile === undefined ? null : (lists.profiles?.find((p) => p.key === row.profile) ?? { key: row.profile, label: row.profile });
  const key = `${shape}|${material}|${JSON.stringify(profile)}|${machine.minRpm}-${machine.maxRpm}`;
  const known = entries.get(key);
  if (known) return known;
  const entry = await core.call("suggestEntry", JSON.parse(shape), material, profile, machine);
  if (entries.size > 400) entries.clear();
  entries.set(key, entry);
  return entry;
}

/** The model's entry for a row; null until worked out, or while the tool's shape cannot be read. */
export function useEntry(tool: Tool, row: CuttingSettings, lists: ToolLists): FeedEntry | null {
  const [entry, setEntry] = useState<FeedEntry | null>(null);
  const shape = shapeOf(tool);
  const material = feedMaterial(row.material, lists);
  const profile = JSON.stringify(lists.profiles?.find((p) => p.key === row.profile) ?? null);
  const { machine } = useApp();
  useEffect(() => {
    let stale = false;
    entryFor(tool, row, lists, machine).then(
      (next) => !stale && setEntry(next),
      // A shape the core cannot read yet, mid-edit: say nothing until it can.
      () => !stale && setEntry(null),
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, material, row.profile, profile, machine.minRpm, machine.maxRpm]);
  return entry;
}

const TICKS = [2, 20, 38, 56, 74];

/**
 * The cell beside a cutting row: a track with a tick per stop, the row's
 * default stop taller, and a marker where the row's own cut sits, measured by
 * what it removes per spindle revolution. Under it, where the row's chip load
 * or power is outside anything the model allows.
 */
export function Ruler(props: { tool: Tool; row: CuttingSettings; entry: FeedEntry | null; pick?: Pick | null }) {
  const { entry } = props;
  if (!entry) return <span className="ruler none" />;
  if (!entry.covered) return <span className="muted">no model</span>;
  const def = parseCombo(entry.default);
  const pick = props.pick ?? def;
  const defIdx = LEVELS.indexOf(def.level);
  const cut = rowCut(props.row, props.tool);
  const place = cutPlace(entry, pick, cut, defIdx);
  const text = placeText(place);
  const flags = place.kind === "none" ? [] : rowFlags(entry, cut);
  const plunge = byPlunge(entry, pick);
  const label =
    place.kind === "none"
      ? "How hard: no suggestion to compare with"
      : [
          place.kind === "blank"
            ? `How hard: needs ${plunge ? "speed and plunge" : "speed, feed, stepover and depth"}`
            : `How hard, by ${plunge ? "plunge" : "volume"} per revolution: ${text}${pick.adaptive ? " (adaptive stops)" : ""}. The tall tick is the default, ${LEVEL_LABELS[def.level]}`,
          ...flags.map((f) => f.sentence.replace(/\.$/, "")),
        ].join(". ");
  const x = TICKS[0] + place.x * (TICKS[4] - TICKS[0]);
  return (
    <span className="ruler" data-kind={place.kind} title={label}>
      <svg viewBox="0 0 76 14" role="img" aria-label={label}>
        <line className="tr" x1={TICKS[0]} y1={9} x2={TICKS[4]} y2={9} strokeDasharray={place.kind === "none" ? "2 2" : undefined} />
        {place.kind !== "none" && TICKS.map((tx, i) => (i === defIdx ? <line key={i} className="tk df" x1={tx} y1={4} x2={tx} y2={14} /> : <line key={i} className="tk" x1={tx} y1={5} x2={tx} y2={13} />))}
        {place.kind !== "none" && place.kind !== "blank" && <path className={place.kind === "above" ? "mk out" : "mk"} d={`M${x.toFixed(1)},1 L${(x + 4).toFixed(1)},7 H${(x - 4).toFixed(1)} Z`} />}
      </svg>
      <span className={place.kind === "above" ? "ruler-text out" : "ruler-text"}>{text}</span>
      {flags.length > 0 && (
        <span className="flags">
          {flags.map((f) => (
            <span key={f.key} className="flag" title={f.sentence}>
              {f.word}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** A row's status while it is edited: nothing when it holds a suggestion. */
export function StatusTag(props: { tool: Tool; row: CuttingSettings; entry: FeedEntry | null; lists: ToolLists }) {
  if (!props.entry || !props.entry.covered) return null;
  const own = !!props.lists.profiles?.find((p) => p.key === props.row.profile)?.level;
  const status = rowStatus(props.row, props.entry, props.tool.diameter, own);
  return status === "matches" ? null : <span className="tag plain">{status}</span>;
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

/** What a row's numbers come to at the edge, and where they are outside what the model allows. */
export function RowFacts(props: { tool: Tool; row: CuttingSettings; lists: ToolLists; entry: FeedEntry | null }) {
  const { tool, row, lists, entry } = props;
  const [check, setCheck] = useState<RowCheck | null>(null);
  const adaptive = entry ? parseCombo(entry.default).adaptive : false;
  const shape = shapeOf(tool);
  const material = feedMaterial(row.material, lists);
  const { machine } = useApp();
  useEffect(() => {
    let stale = false;
    core.call("checkRow", JSON.parse(shape), material, { rpm: row.rpm, feed: row.feed, plunge: row.plunge, stepover: row.stepover, stepdown: row.stepdown, adaptive }, machine).then(
      (next) => !stale && setCheck(next),
      () => !stale && setCheck(null),
    );
    return () => {
      stale = true;
    };
  }, [shape, material, adaptive, row.rpm, row.feed, row.plunge, row.stepover, row.stepdown, machine.minRpm, machine.maxRpm]);
  const flags = entry ? rowFlags(entry, rowCut(row, tool)) : [];
  if (entry && !entry.covered) {
    return <p className="hint">The feeds model does not know {materialLabel(row.material, lists).toLowerCase()}. Under Settings, Materials, say which material it cuts like to have this row placed and checked.</p>;
  }
  return (
    <>
      {check?.chipLoad != null && (
        <p className="readouts">
          <span>
            chip <b>{fmt(check.chipLoad)}</b> mm/tooth
            {entry?.limits ? ` (${entry.limits.classLabel.toLowerCase()}: ${num(entry.limits.chipFloor)} to ${num(entry.limits.chipMax)})` : ""}
          </span>
          {check.surfaceSpeed != null && (
            <span>
              <b>{fmt(check.surfaceSpeed)}</b> m/min at the edge
            </span>
          )}
          {check.powerW != null && (
            <span>
              about <b>{fmt(check.powerW)}</b> W {adaptive ? "at this stepover" : "as a full slot"}
            </span>
          )}
        </p>
      )}
      {flags.map((f) => (
        <p key={f.key} className="hint warn">
          ▲ {f.sentence}
        </p>
      ))}
    </>
  );
}

const FIELD_NAMES: Record<CutField, string> = { rpm: "speed", feed: "feed", plunge: "plunge", stepover: "stepover", stepdown: "depth" };

/**
 * The foot of a cutting table while it is edited: what the feeds model would
 * start from for the row being worked on, with the suggested values under
 * the columns they belong to. As the tooling library's workbench has it: a
 * slider of five stops with the ways of cutting beside it, the row's own
 * values and the suggested ones one above the other, where the suggestion
 * comes from, whether the row holds it, and what to know about it.
 */
export function SuggestionSlot(props: { tool: Tool; row: CuttingSettings; lists: ToolLists; passes: boolean; pick: Pick; onPick: (pick: Pick) => void; onUse: (change: Partial<CutValues>) => void }) {
  const { tool, row, lists, pick } = props;
  const entry = useEntry(tool, row, lists);
  const profile = lists.profiles?.find((p) => p.key === row.profile);
  const material = materialLabel(row.material, lists);
  const label = profile ? `${material}, ${profile.label}` : row.profile ? `${material}, ${row.profile}` : material;
  const cols = props.passes ? 9 : 8;
  const index = LEVELS.indexOf(pick.level);
  const s = sugCombo(entry, pick);
  const percent = row.stepoverUnit === "percent";
  const shown = (f: CutField, v: CutValues) => (f === "stepover" ? (percent ? `${fmt(Math.round((v.stepover / tool.diameter) * 100000) / 1000)} %` : `${fmt(v.stepover)} mm`) : fmt(v[f]));
  const own: CutValues = { rpm: row.rpm, feed: row.feed, plunge: row.plunge, stepover: row.stepover, stepdown: row.stepdown };
  const setPick = (change: Partial<Pick>) => {
    const next = { ...pick, ...change };
    // Adaptive is not remembered: a plain row never takes it.
    if (row.profile === undefined) rememberPick(next);
    props.onPick(next);
  };

  const head = (
    <tr className="hd">
      <td colSpan={cols}>
        <div className="sug-hd">
          <span>Suggestion · {label}</span>
          <span className="spacer" />
          {s && s.status !== "none" && (s.untested ? <span className="tag warn">▲ untested</span> : <span className="tag plain">{pick.level === "slot_safe" ? "reviewed" : "rough starting point"}</span>)}
        </div>
      </td>
    </tr>
  );
  if (!entry) return null;
  if (!entry.covered) {
    return (
      <tfoot className="sug" aria-label={`Suggestion for ${label}`}>
        {head}
        <tr>
          <td colSpan={cols} className="why">
            The feeds model does not know {material.toLowerCase()}. Under Settings, Materials, say which material it cuts like to get suggestions.
          </td>
        </tr>
      </tfoot>
    );
  }

  // Adaptive is greyed when the model has no adaptive rule for this kind of tool but does cut it otherwise.
  const plain = sugCombo(entry, { ...pick, adaptive: false });
  const withAdaptive = sugCombo(entry, { ...pick, adaptive: true });
  const noAdaptive = !!plain && plain.status !== "none" && !!withAdaptive && withAdaptive.status === "none";
  const noLube = !entry.lubrication;
  // An adaptive row is never to be run as a full slot, which a plain row may be.
  const blocked = pick.adaptive && row.profile === undefined;

  const has = s !== null && s.status !== "none";
  const out = has ? suggestedValues(row, s, tool.diameter) : null;
  const model = has ? modelValues(row, s, tool.diameter) : null;
  const differs = (f: CutField) => out !== null && !sameValue(out[f], row[f]);
  const changed = CUT_FIELDS.filter(differs);
  const use = () => {
    if (!out) return;
    const change: Partial<CutValues> = {};
    for (const f of changed) change[f] = out[f];
    props.onUse(change);
  };
  const cut = rowCut(row, tool);
  const match = has && !blocked ? matchOf(row, entry, pick, cut, tool.diameter, !!profile?.level) : null;
  const provenance = has
    ? [
        `${LEVEL_LABELS[pick.level]}${s.options.adaptive ? " · Adaptive" : ""}`,
        s.classLabel ? `${s.classLabel} class` : null,
        "carbide",
        entry.lubrication ? (s.options.lubricated ? "lubricated" : "dry") : null,
        `${num(s.chipLoad ?? 0)} mm/tooth`,
        `${num(s.surfaceSpeed ?? 0)} m/min`,
        `${powerText(s.powerW ?? 0)} of ${num(s.powerLimitW ?? 0)} W cap`,
        s.fields.includes("feed") ? (s.options.ramping ? "ramped entry (at most 3°: set ramping in the operation)" : "straight-plunge entry") : null,
      ].filter((part): part is string => !!part)
    : [];
  const notes: { warn: boolean; text: string }[] = has
    ? [
        ...(blocked ? [{ warn: true, text: `An adaptive row belongs on a profile: a plain row is used for any cut, a full slot included. Keep these numbers in a row for ${material.toLowerCase()} on a profile instead.` }] : []),
        ...rowFlags(entry, cut).map((f) => ({ warn: true, text: f.sentence })),
        ...(s.status === "caution" && s.reason ? [{ warn: false, text: s.reason }] : []),
        ...s.notes.map((n) => ({ warn: false, text: n })),
      ]
    : [];

  return (
    <tfoot className="sug" aria-label={`Suggestion for ${label}`}>
      {head}
      <tr className="ctl">
        <td colSpan={cols}>
          <div className="ctl-row">
            <div className="axis">
              <span className="axis-name">How hard</span>
              <input type="range" className="detent" min={0} max={4} step={1} value={index} aria-label="How hard a cut" aria-valuetext={LEVEL_LABELS[pick.level]} onChange={(e) => setPick({ level: LEVELS[Number(e.target.value)] ?? "slot_safe" })} />
              <div className="stops">
                {LEVELS.map((k, i) => (
                  <button type="button" key={k} className={i === index ? "on" : undefined} aria-pressed={i === index} onClick={() => setPick({ level: k })}>
                    {LEVEL_LABELS[k]}
                  </button>
                ))}
              </div>
              {profile?.level && (
                <div className="defm">
                  {LEVELS.map((k) => (
                    <span key={k}>{k === profile.level ? "▲ profile default" : ""}</span>
                  ))}
                </div>
              )}
            </div>
            <div className="ticks">
              <label className="check">
                <input type="checkbox" checked={pick.ramping} onChange={(e) => setPick({ ramping: e.target.checked })} />
                Ramped entry
              </label>
              {/* A ticked box is never locked: it can always be unticked. */}
              <label className={noAdaptive && !pick.adaptive ? "check dis" : "check"}>
                <input type="checkbox" checked={pick.adaptive} disabled={noAdaptive && !pick.adaptive} onChange={(e) => setPick({ adaptive: e.target.checked })} />
                Adaptive
                {noAdaptive && <span className="muted"> (flat and ball end mills only)</span>}
              </label>
              <label className={noLube && !pick.lubricated ? "check dis" : "check"} title="Light lubrication, such as WD-40 brushed on">
                <input type="checkbox" checked={pick.lubricated} disabled={noLube && !pick.lubricated} onChange={(e) => setPick({ lubricated: e.target.checked })} />
                Lubricated
                {noLube && <span className="muted"> (no effect in {material.toLowerCase()})</span>}
              </label>
            </div>
          </div>
        </td>
      </tr>
      <tr className="vals">
        <td className="k">This row</td>
        {CUT_FIELDS.map((f) => (
          <td key={f} className="num">
            {shown(f, own)}
          </td>
        ))}
        {props.passes && <td className="num">{row.passes ?? "—"}</td>}
        <td colSpan={2} />
      </tr>
      {has && out && model ? (
        <tr className="vals">
          <td className="k">Suggested</td>
          {CUT_FIELDS.map((f) =>
            s.fields.includes(f) ? (
              <td key={f} className={differs(f) ? "num d" : "num"}>
                {shown(f, out)}
              </td>
            ) : (
              // The model's own value, which it does not stand behind for this kind of tool.
              <td key={f} className="num fill" title={`Not the model's to set for this kind of tool: the row keeps its own. The model would use ${shown(f, model)}.`}>
                kept
              </td>
            ),
          )}
          {props.passes && <td />}
          <td colSpan={2} />
        </tr>
      ) : (
        <tr className="vals">
          <td className="k">Suggested</td>
          <td colSpan={cols - 1} className="why">
            {s?.reason ?? "No suggestion."}
          </td>
        </tr>
      )}
      {has && (
        <tr className="pv">
          <td colSpan={cols}>
            <div className="pv-in">
              <span className="pv-t">
                {provenance.map((part, i) => (
                  <span key={i} className="nw">
                    {i > 0 ? " · " : ""}
                    {part}
                  </span>
                ))}
              </span>
              {match?.text && <span className={match.kind === "default" || match.kind === "match" ? "sug-ok" : "sug-ok plain"}>{match.text}</span>}
              {changed.length > 0 && (
                <button type="button" className="small" disabled={blocked} onClick={use} title={blocked ? "An adaptive row belongs on a profile" : `Changes ${changed.map((f) => `${FIELD_NAMES[f]} ${shown(f, own)} to ${shown(f, out as CutValues)}`).join(", ")}.`}>
                  Use suggestion
                </button>
              )}
            </div>
          </td>
        </tr>
      )}
      {notes.length > 0 && (
        <tr className="nt">
          <td colSpan={cols}>
            {notes.map((n) => (
              <div key={n.text} className={n.warn ? "warn" : undefined}>
                {n.warn ? "▲ " : ""}
                {n.text}
              </div>
            ))}
          </td>
        </tr>
      )}
    </tfoot>
  );
}

/**
 * A row's field log, newest first, each entry with whether it still counts.
 * With `onChange`, an entry can be corrected or taken out.
 */
export function LogList({ row, onChange }: { row: CuttingSettings; onChange?: (log: CutResult[]) => void }) {
  const logged = row.log ?? [];
  const current = currentResult(row);
  const [editing, setEditing] = useState<number | null>(null);
  if (logged.length === 0) return null;
  return (
    <ul className="log-list">
      {logged
        .map((entry, at) => ({ entry, at }))
        .sort((a, b) => b.entry.date.localeCompare(a.entry.date) || b.at - a.at)
        .map(({ entry, at }) => {
          const counts = current !== undefined && entry.at !== undefined && JSON.stringify(entry.at) === JSON.stringify(current.at);
          if (editing === at && onChange) {
            return (
              <li key={at} className="editing">
                <LogResult
                  initial={entry}
                  saves="now"
                  onCancel={() => setEditing(null)}
                  onAdd={(next) => {
                    onChange(logged.map((e, i) => (i === at ? { ...e, ...next, outcome: next.outcome } : e)));
                    setEditing(null);
                  }}
                />
              </li>
            );
          }
          return (
            <li key={at} className={counts ? "" : "past"}>
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
                {!counts && <span className="hint">{entry.at ? `At feed ${fmt(entry.at.feed)}, ${fmt(entry.at.stepdown)} mm deep, ${entry.at.rpm} rpm: not the row's present numbers.` : "Numbers not recorded."}</span>}
              </span>
              {onChange && editing === null && (
                <span className="log-acts">
                  <button type="button" className="link" onClick={() => setEditing(at)}>
                    Correct
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      if (window.confirm(`Take the entry of ${entry.date} out of the log?`)) onChange(logged.filter((_, i) => i !== at));
                    }}
                  >
                    Remove
                  </button>
                </span>
              )}
            </li>
          );
        })}
    </ul>
  );
}

/** Adds what happened on a cut to a row's log, at the numbers the row has now; with `initial`, corrects an entry. */
export function LogResult(props: { onAdd: (entry: CutResult) => void; saves: "now" | "with the tool"; initial?: CutResult; onCancel?: () => void }) {
  const { initial } = props;
  const [open, setOpen] = useState(initial !== undefined);
  // A note without a result stays one unless a result is picked for it.
  const [outcome, setOutcome] = useState<CutResult["outcome"]>(initial ? initial.outcome : "ok");
  const group = useId();
  const [text, setText] = useState(initial?.text ?? "");
  const [date, setDate] = useState(initial?.date ?? today());
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Log a result…
      </button>
    );
  }
  const close = () => {
    setOpen(false);
    props.onCancel?.();
  };
  const add = () => {
    if (text.trim() === "" || date === "") return;
    props.onAdd({ date, outcome, text: text.trim() });
    setText("");
    setOpen(false);
  };
  return (
    <div className="log-form" role="group" aria-label={initial ? "Correct a logged result" : "Log a result"}>
      <div className="row" role="radiogroup" aria-label="How it went">
        {(Object.keys(OUTCOMES) as (keyof typeof OUTCOMES)[]).map((key) => (
          <label key={key} className="check">
            <input type="radio" name={group} checked={outcome === key} onChange={() => setOutcome(key)} />
            <span className={`mark ${OUTCOMES[key].tone}`}>
              {OUTCOMES[key].mark} {OUTCOMES[key].text}
            </span>
          </label>
        ))}
        {initial && initial.outcome === undefined && (
          <label className="check">
            <input type="radio" name={group} checked={outcome === undefined} onChange={() => setOutcome(undefined)} />
            <span className="muted">only a note</span>
          </label>
        )}
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
          {initial ? "Keep the correction" : "Add to the log"}
        </button>
        <button type="button" onClick={close}>
          Cancel
        </button>
        <span className="hint">{initial ? "The numbers it was recorded at stay as they were." : `Recorded at the numbers the row has now${props.saves === "now" ? "." : ", and kept when you save the tool."}`}</span>
      </div>
    </div>
  );
}

/** The row's numbers as a log entry records them. */
export function valuesOf(row: CuttingSettings): NonNullable<CutResult["at"]> {
  return { rpm: row.rpm, feed: row.feed, plunge: row.plunge, stepover: row.stepover, stepoverUnit: row.stepoverUnit, stepdown: row.stepdown, passes: row.passes };
}
