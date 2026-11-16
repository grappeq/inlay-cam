// One tool, whole: its shape, what it is and where it came from, and every
// cutting row with what the feeds model makes of it.

import { useEffect, useState, type ReactNode } from "react";
import { core } from "../core/client";
import type { CutResult, CuttingSettings, FeedFlags, FeedLevel, FeedSuggestion, Material, RowCheck, Tool, ToolLists } from "../core/types";
import { TOOL_KIND_LABELS, allMaterials, feedMaterial, fmt, materialLabel, rowLabel } from "../state/model";
import { message, useApp } from "../state/store";
import { NumberField } from "./NumberField";

const LEVELS: { key: FeedLevel; label: string }[] = [
  { key: "gentle", label: "Gentle" },
  { key: "slot_safe", label: "Slot-safe" },
  { key: "standard", label: "Standard" },
  { key: "firm", label: "Firm" },
  { key: "aggressive", label: "Aggressive" },
];

const OUTCOMES: Record<NonNullable<CutResult["outcome"]>, { mark: string; text: string; tone: string }> = {
  ok: { mark: "✓", text: "ok", tone: "ok" },
  provisional: { mark: "○", text: "worked, still to confirm", tone: "warn" },
  failed: { mark: "✕", text: "failed", tone: "danger" },
};

/** Six decimals: fine enough that a percentage kept as mm is the same percentage when turned back. */
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
const percentOf = (row: CuttingSettings, diameter: number) => Math.round((row.stepover / diameter) * 100000) / 1000;

/** The newest log entry cut at the row's present numbers; of one date, the one written last. */
function currentResult(row: CuttingSettings): CutResult | undefined {
  let best: CutResult | undefined;
  for (const entry of row.log ?? []) {
    const at = entry.at;
    const same =
      at !== undefined &&
      at.rpm === row.rpm &&
      at.feed === row.feed &&
      at.plunge === row.plunge &&
      at.stepover === row.stepover &&
      (at.stepoverUnit ?? "mm") === (row.stepoverUnit ?? "mm") &&
      at.stepdown === row.stepdown &&
      at.passes === row.passes;
    if (same && (best === undefined || entry.date >= best.date)) best = entry;
  }
  return best;
}

export function ToolSheet(props: { initial: Tool; isNew: boolean; taken: Tool[]; onSave: (tool: Tool) => void; onCancel: () => void }) {
  const { lists } = useApp();
  const [tool, setTool] = useState<Tool>(props.initial);
  const [error, setError] = useState<string | null>(null);
  const set = (change: Partial<Tool>) => setTool((t) => ({ ...t, ...change }));
  const materials = allMaterials(lists);

  // A stepover given in percent follows the diameter.
  const setDiameter = (diameter: number) =>
    setTool((t) => ({
      ...t,
      diameter,
      cutting: t.cutting.map((c) => (c.stepoverUnit === "percent" ? { ...c, stepover: round6((c.stepover / t.diameter) * diameter) } : c)),
    }));

  const setRow = (index: number, row: CuttingSettings) => setTool((t) => ({ ...t, cutting: t.cutting.map((c, i) => (i === index ? row : c)) }));
  const removeRow = (index: number) => setTool((t) => ({ ...t, cutting: t.cutting.filter((_, i) => i !== index) }));
  const addRow = () =>
    setTool((t) => {
      // The first material and profile the tool has no row for yet.
      const taken = (material: Material, profile?: string) => t.cutting.some((c) => c.material === material && c.profile === profile);
      const free = materials.find((m) => !taken(m.value));
      const material = free?.value ?? materials[0].value;
      const profile = free ? undefined : lists.profiles?.find((p) => !taken(material, p.key))?.key;
      if (!free && profile === undefined) return t;
      const stepover = t.kind === "v_bit" ? 0.2 : t.kind === "corner_round" ? 0.5 : Math.round(t.diameter * 400) / 1000;
      return { ...t, cutting: [...t.cutting, { material, profile, rpm: 12000, feed: 500, plunge: 150, stepover, stepdown: 0.5 }] };
    });

  const submit = async () => {
    const candidate = { ...tool, name: tool.name.trim() };
    if (props.taken.some((t) => t.id !== candidate.id && t.name === candidate.name)) return setError("Another tool already has this name.");
    try {
      const problem = await core.call("validateTool", candidate);
      if (problem) return setError(problem.charAt(0).toUpperCase() + problem.slice(1) + ".");
      props.onSave(candidate);
    } catch (e) {
      setError(message(e));
    }
  };

  const kept = [
    tool.ids && "its ids in the Makera apps",
    tool.apps && "which Makera libraries it goes into",
    tool.fusionType && "its Fusion 360 type",
    tool.studioUnknown1 !== undefined && "a value Makera Studio stores",
    tool.cutting.some((c) => c.ids || c.camFlag !== undefined || c.camExtra !== undefined || c.modified) && "what the Makera apps store with its rows",
  ].filter((item): item is string => typeof item === "string");
  const inventory = tool.inventory ?? {};
  const setInventory = (change: Partial<NonNullable<Tool["inventory"]>>) => {
    const next = { ...inventory, ...change };
    set({ inventory: Object.values(next).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0)) ? next : undefined });
  };
  const source = tool.source ?? {};
  const setSource = (change: Partial<NonNullable<Tool["source"]>>) => {
    const next = { ...source, ...change };
    set({ source: Object.values(next).some((v) => v !== undefined) ? next : undefined });
  };

  return (
    <form
      className="sheet"
      aria-label={props.isNew ? "Add tool" : "Edit tool"}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="toolbar">
        <button type="button" onClick={props.onCancel}>
          ← All tools
        </button>
        <h2>{tool.name.trim() === "" ? `New ${TOOL_KIND_LABELS[tool.kind].toLowerCase()}` : tool.name}</h2>
        <span className="muted">{TOOL_KIND_LABELS[tool.kind]}</span>
        <span className="spacer" />
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Save tool
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <Section title="Shape">
        <TextField label="Name" value={tool.name} onChange={(name) => set({ name: name ?? "" })} wide keepEmpty />
        <div className="grid">
          <NumberField
            label={tool.kind === "flat_end" || tool.kind === "ball_end" || tool.kind === "drill" ? "Diameter" : "Body diameter"}
            unit="mm"
            min={0.001}
            value={tool.diameter}
            onChange={(v) => v !== undefined && setDiameter(v)}
          />
          <NumberField label="Shank diameter" unit="mm" min={0.001} value={tool.shankDiameter} onChange={(v) => v !== undefined && set({ shankDiameter: v })} />
          {(tool.kind === "v_bit" || tool.kind === "drill") && (
            <NumberField
              label={tool.kind === "drill" ? "Point angle" : "Angle"}
              unit="°"
              min={0.1}
              value={tool.tipAngle}
              onChange={(v) => v !== undefined && set({ tipAngle: v })}
              hint="Full angle between the two edges."
            />
          )}
          {tool.kind === "v_bit" && (
            <NumberField label="Tip flat diameter" unit="mm" value={tool.tipDiameter ?? 0} onChange={(v) => v !== undefined && set({ tipDiameter: v })} hint="Measure it: 0 for a true point." />
          )}
          {tool.kind === "corner_round" && (
            <>
              <NumberField label="Corner radius" unit="mm" min={0.001} value={tool.cornerRadius} onChange={(v) => v !== undefined && set({ cornerRadius: v })} hint="Radius of the rounded edge it cuts." />
              <NumberField
                label="Tip diameter"
                unit="mm"
                value={tool.tipDiameter ?? 0}
                onChange={(v) => v !== undefined && set({ tipDiameter: v })}
                hint="Across the tip, below the rounded edge. The body is at least this plus twice the radius."
              />
            </>
          )}
          <NumberField label="Flute length" unit="mm" min={0.001} optional value={tool.fluteLength} onChange={(v) => set({ fluteLength: v })} hint="Deepest it can cut. Empty if unknown." />
          <NumberField
            label="Shoulder length"
            unit="mm"
            min={0.001}
            optional
            value={tool.shoulderLength}
            onChange={(v) => set({ shoulderLength: v })}
            hint="From the tip to where the body widens to the shank. Empty if it is the flute length."
          />
          <NumberField label="Overall length" unit="mm" min={0.001} optional value={tool.length} onChange={(v) => set({ length: v })} />
          <NumberField label="Flutes" min={1} whole optional value={tool.flutes} onChange={(v) => set({ flutes: v })} hint="Needed for suggested feeds." />
          {tool.kind === "thread_mill" && (
            <>
              <NumberField label="Thread diameter" unit="mm" min={0.001} optional value={tool.threadDiameter} onChange={(v) => set({ threadDiameter: v })} hint="Such as 3 for M3." />
              <NumberField label="Pitch" unit="mm" min={0.001} optional value={tool.pitch} onChange={(v) => set({ pitch: v })} />
              <NumberField label="Drill diameter" unit="mm" min={0.001} optional value={tool.drillDiameter} onChange={(v) => set({ drillDiameter: v })} hint="The hole drilled before threading." />
            </>
          )}
        </div>
      </Section>

      <Section
        title="Cutting settings"
        note="One plain row per material, safe for any cut, a full-width slot included. A further row per material can be kept for one kind of toolpath. Under each row is what the feeds model would start from: a rough starting point, never applied unless you choose it."
      >
        {tool.cutting.length === 0 && <p className="warn">No cutting settings yet. A tool cannot be used on a material it has none for.</p>}
        {tool.cutting.map((row, index) => (
          <RowEditor key={index} tool={tool} row={row} lists={lists} materials={materials} onChange={(next) => setRow(index, next)} onRemove={() => removeRow(index)} />
        ))}
        <div className="row">
          <button type="button" onClick={addRow}>
            Add cutting settings
          </button>
        </div>
      </Section>

      <Section title="What it is" note="For finding the tool and telling it from its neighbours. None of this changes a file.">
        <div className="grid">
          <TextField label="Group" value={tool.group} onChange={(group) => set({ group })} hint='Where it is filed. "/" separates nested groups.' />
          <NumberField label="Tool number" min={1} whole optional value={tool.number} onChange={(v) => set({ number: v })} hint="As other CAM programs list it." />
          <TextField label="Coating" value={tool.coating} onChange={(coating) => set({ coating })} hint="Such as DLC, or uncoated." />
          <TextField label="Style" value={tool.style} onChange={(style) => set({ style })} hint="A word or two: Downcut, Alu." />
        </div>
        <TextField label="Note" value={tool.note} onChange={(note) => set({ note })} wide hint="One line about the whole tool." />
        <div className="field" role="group" aria-label="Recommended for">
          <span className="field-label">Recommended for</span>
          <div className="check-list">
            {materials.map((m) => {
              const on = tool.recommendedFor?.includes(m.value) ?? false;
              const next = materials.map((x) => x.value).filter((key) => (key === m.value ? !on : (tool.recommendedFor?.includes(key) ?? false)));
              return (
                <label key={m.value} className="check">
                  <input type="checkbox" checked={on} onChange={() => set({ recommendedFor: next.length > 0 ? next : undefined })} />
                  {m.label}
                </label>
              );
            })}
          </div>
        </div>
        {(tool.verify?.length ?? 0) > 0 && (
          <div className="field" role="group" aria-label="Still to check">
            <span className="field-label">Still to check</span>
            <ul className="plain-list">
              {tool.verify?.map((item) => (
                <li key={item.field}>
                  <strong>{item.field}</strong>
                  {item.note ? `: ${item.note}` : ""}{" "}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      const left = tool.verify?.filter((v) => v.field !== item.field) ?? [];
                      set({ verify: left.length > 0 ? left : undefined });
                    }}
                  >
                    Checked
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title="Stock and source" note="Yours alone: a project file passed on leaves all of this out.">
        <div className="grid">
          <NumberField label="On hand" min={0} whole optional value={inventory.quantity} onChange={(v) => setInventory({ quantity: v })} />
          <NumberField label="Price each" min={0} optional value={inventory.price} onChange={(v) => setInventory({ price: v, currency: v === undefined ? undefined : (inventory.currency ?? "EUR") })} />
          <TextField
            label="Currency"
            value={inventory.currency}
            onChange={(currency) => setInventory({ currency: currency?.toUpperCase() })}
            hint="Three letters, such as EUR. Goes with a price."
          />
          <TextField label="Last bought" value={inventory.purchased} onChange={(purchased) => setInventory({ purchased })} hint="A date: 2026-01-31." />
        </div>
        <TextField label="Product page" value={source.url} onChange={(url) => setSource({ url })} wide />
        <div className="grid">
          <TextField label="Invoice" value={source.invoice} onChange={(invoice) => setSource({ invoice })} />
          <TextField label="Size as the shop lists it" value={source.sizeNote} onChange={(sizeNote) => setSource({ sizeNote })} />
        </div>
        {(inventory.log?.length ?? 0) > 0 && (
          <div className="field" role="group" aria-label="Broken and worn">
            <span className="field-label">Broken and worn</span>
            <ul className="plain-list">
              {inventory.log?.map((entry, i) => (
                <li key={i}>
                  <span className="mono">{entry.date}</span> {entry.kind}
                  {entry.material ? ` in ${materialLabel(entry.material, lists).toLowerCase()}` : ""}
                  {entry.note ? `: ${entry.note}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      {kept.length > 0 && <p className="muted">Also kept with this tool, for other programs, and not shown here: {kept.join("; ")}.</p>}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row end">
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Save tool
        </button>
      </div>
    </form>
  );
}

/** A line of text that may be left empty. */
function TextField(p: { label: string; value: string | undefined; onChange: (value: string | undefined) => void; hint?: string; wide?: boolean; keepEmpty?: boolean }) {
  return (
    <label className={p.wide ? "field wide" : "field"}>
      <span className="field-label">{p.label}</span>
      <input type="text" value={p.value ?? ""} onChange={(e) => p.onChange(p.keepEmpty || e.target.value.trim() !== "" ? e.target.value : undefined)} />
      {p.hint && <span className="hint">{p.hint}</span>}
    </label>
  );
}

function Section(props: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="sheet-section">
      <h3>{props.title}</h3>
      {props.note && <p className="muted">{props.note}</p>}
      {props.children}
    </section>
  );
}

/** One cutting row: its numbers, what they come to, and what the feeds model would start from. */
function RowEditor(props: {
  tool: Tool;
  row: CuttingSettings;
  lists: ToolLists;
  materials: { value: Material; label: string }[];
  onChange: (row: CuttingSettings) => void;
  onRemove: () => void;
}) {
  const { tool, row, lists } = props;
  const set = (change: Partial<CuttingSettings>) => props.onChange({ ...row, ...change });
  const profile = lists.profiles?.find((p) => p.key === row.profile);
  const adaptive = row.profile !== undefined && (profile?.adaptive ?? row.profile === "adaptive");
  const [level, setLevel] = useState<FeedLevel>(profile?.level ?? "slot_safe");
  const [ramping, setRamping] = useState(profile?.ramping ?? false);
  const [lubricated, setLubricated] = useState(profile?.lubricated ?? false);
  const [stops, setStops] = useState<FeedSuggestion[] | null>(null);
  const [check, setCheck] = useState<RowCheck | null>(null);
  const [open, setOpen] = useState(false);

  // The model reads the tool's shape and name only: its rows are left out, so one being edited cannot trip it.
  const shape = JSON.stringify({ ...tool, id: tool.id || "new", name: tool.name || "Tool", cutting: [], verify: undefined, inventory: undefined, source: undefined });
  const material = feedMaterial(row.material, lists);
  useEffect(() => {
    let stale = false;
    const timer = setTimeout(async () => {
      try {
        const bare: Tool = JSON.parse(shape);
        const flags: FeedFlags = { ramping, adaptive, lubricated };
        const [nextStops, nextCheck] = await Promise.all([
          core.call("suggestStops", bare, material, flags),
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
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [shape, material, ramping, adaptive, lubricated, row.rpm, row.feed, row.plunge, row.stepover, row.stepdown]);

  const percent = row.stepoverUnit === "percent";
  const current = currentResult(row);
  const logged = row.log ?? [];
  const chosen = stops?.[LEVELS.findIndex((l) => l.key === level)];
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
    set(change);
  };

  // Where the row sits among the stops, by how much it removes: feed times depth.
  const rate = row.feed * row.stepdown;
  const rates = stops?.map((s) => (s.values ? s.values.feed * s.values.stepdown : null)) ?? [];
  const exact = stops?.findIndex((s) => s.values && s.values.rpm === row.rpm && s.values.feed === row.feed && s.values.plunge === row.plunge && s.values.stepdown === row.stepdown) ?? -1;
  const above = rates.filter((r): r is number => r !== null && r < rate).length;
  const place =
    !stops || rates.some((r) => r === null)
      ? null
      : exact >= 0
        ? `These are the ${LEVELS[exact].label} values.`
        : above === 0
          ? "Removes less than the Gentle stop."
          : above === LEVELS.length
            ? "Removes more than the Aggressive stop."
            : `Removes about as much as between ${LEVELS[above - 1].label} and ${LEVELS[above].label}.`;

  const rowTaken = (m: Material, p: string | undefined) => tool.cutting.some((c) => c !== row && c.material === m && c.profile === p);

  return (
    <fieldset className="cut-row">
      <legend>{rowLabel(row, lists)}</legend>
      <div className="grid">
        <label className="field">
          <span className="field-label">Material</span>
          <select value={row.material} onChange={(e) => set({ material: e.target.value })}>
            {props.materials.map((m) => (
              <option key={m.value} value={m.value} disabled={rowTaken(m.value, row.profile)}>
                {m.label}
              </option>
            ))}
            {!props.materials.some((m) => m.value === row.material) && <option value={row.material}>{row.material} (not in your material list)</option>}
          </select>
        </label>
        <label className="field">
          <span className="field-label">For</span>
          <select value={row.profile ?? ""} onChange={(e) => set({ profile: e.target.value === "" ? undefined : e.target.value })}>
            <option value="" disabled={rowTaken(row.material, undefined)}>
              Any cut (the plain row)
            </option>
            {lists.profiles?.map((p) => (
              <option key={p.key} value={p.key} disabled={rowTaken(row.material, p.key)}>
                {p.label}
              </option>
            ))}
            {row.profile !== undefined && !profile && <option value={row.profile}>{row.profile} (not in your profiles)</option>}
          </select>
          {profile?.note && <span className="hint">{profile.note}</span>}
        </label>
      </div>
      <div className="grid five">
        <NumberField label="Speed" unit="rpm" min={1} whole value={row.rpm} onChange={(v) => v !== undefined && set({ rpm: v })} />
        <NumberField label="Feed" unit="mm/min" min={0.001} value={row.feed} onChange={(v) => v !== undefined && set({ feed: v })} />
        <NumberField label="Plunge" unit="mm/min" min={0.001} value={row.plunge} onChange={(v) => v !== undefined && set({ plunge: v })} />
        <div className="field">
          <NumberField
            label="Stepover"
            unit={percent ? "%" : "mm"}
            min={0.001}
            max={percent ? 100 : tool.diameter}
            value={percent ? percentOf(row, tool.diameter) : row.stepover}
            onChange={(v) => v !== undefined && set({ stepover: percent ? round6((v / 100) * tool.diameter) : v })}
          />
          <button type="button" className="link" onClick={() => set({ stepoverUnit: percent ? undefined : "percent" })}>
            {percent ? `${fmt(row.stepover)} mm. Give it in mm` : `${fmt(percentOf(row, tool.diameter))} %. Give it in %`}
          </button>
        </div>
        <NumberField label="Stepdown" unit="mm" min={0.001} value={row.stepdown} onChange={(v) => v !== undefined && set({ stepdown: v })} />
        {tool.kind === "thread_mill" && <NumberField label="Passes" min={1} whole optional value={row.passes} onChange={(v) => set({ passes: v })} />}
      </div>

      <p className="readouts">
        {current?.outcome ? (
          <span className={`mark ${OUTCOMES[current.outcome].tone}`}>
            {OUTCOMES[current.outcome].mark} {OUTCOMES[current.outcome].text}
          </span>
        ) : logged.length > 0 ? (
          <span className="mark warn">▲ untested at these numbers</span>
        ) : (
          <span className="mark muted">No result logged</span>
        )}
        {check?.chipLoad != null && (
          <span>
            chip <b>{fmt(check.chipLoad)}</b> mm/tooth
            {check.chipFloor != null && check.chipMax != null ? ` (${fmt(check.chipFloor)} to ${fmt(check.chipMax)})` : ""}
          </span>
        )}
        {check?.surfaceSpeed != null && (
          <span>
            <b>{fmt(check.surfaceSpeed)}</b> m/min at the edge
          </span>
        )}
        {check?.powerW != null && (
          <span>
            about <b>{fmt(check.powerW)}</b> W {adaptive ? "at this stepover" : "as a full slot"}{check.powerCapW != null ? ` (cap ${fmt(check.powerCapW)})` : ""}
          </span>
        )}
      </p>
      {check?.warnings.map((warning) => (
        <p key={warning} className="hint warn">
          {warning}
        </p>
      ))}

      {check && !check.covered ? (
        <p className="hint">
          The feeds model does not know {materialLabel(row.material, lists).toLowerCase()}. On the Materials page, say which material it cuts like to get suggestions.
        </p>
      ) : (
        stops && (
          <details className="suggest" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
            <summary>
              Suggested starting values{place ? `. ${place}` : ""}
            </summary>
            <div className="stops" role="radiogroup" aria-label="How hard a cut">
              {LEVELS.map((l, i) => (
                <button type="button" key={l.key} role="radio" aria-checked={level === l.key} className={exact === i ? "stop is-row" : "stop"} onClick={() => setLevel(l.key)}>
                  <span>{l.label}</span>
                  <span className="mono">{stops[i].values ? `${stops[i].values?.feed} × ${fmt(stops[i].values?.stepdown ?? 0)}` : "none"}</span>
                </button>
              ))}
            </div>
            <div className="row">
              <label className="check">
                <input type="checkbox" checked={ramping} onChange={(e) => setRamping(e.target.checked)} />
                Ramped entry
              </label>
              {check?.lubricationMatters && (
                <label className="check">
                  <input type="checkbox" checked={lubricated} onChange={(e) => setLubricated(e.target.checked)} />
                  Lubricated
                </label>
              )}
              {adaptive && <span className="muted">Shaped for adaptive clearing.</span>}
            </div>
            {chosen && suggested ? (
              <>
                <p className="suggested">
                  <span className="mono">
                    {suggested.rpm} rpm · feed {suggested.feed} · plunge {suggested.plunge} · stepover {fmt(suggested.stepoverPct)} % ({fmt(suggested.stepoverMm)} mm) ·{" "}
                    {fmt(suggested.stepdown)} mm deep
                  </span>{" "}
                  <button type="button" onClick={use}>
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
          </details>
        )
      )}

      {logged.length > 0 && (
        <details className="suggest">
          <summary>
            Field log: {logged.length} {logged.length === 1 ? "entry" : "entries"}
          </summary>
          <ul className="plain-list">
            {[...logged]
              .sort((a, b) => b.date.localeCompare(a.date))
              .map((entry, i) => (
                <li key={i}>
                  <span className="mono">{entry.date}</span>{" "}
                  {entry.outcome && (
                    <span className={`mark ${OUTCOMES[entry.outcome].tone}`}>
                      {OUTCOMES[entry.outcome].mark} {OUTCOMES[entry.outcome].text}
                    </span>
                  )}{" "}
                  {entry.text}
                  <span className="hint">
                    {entry.at
                      ? entry === current || (current && JSON.stringify(entry.at) === JSON.stringify(current.at))
                        ? "At the row's present numbers."
                        : `At ${entry.at.rpm} rpm, feed ${fmt(entry.at.feed)}, plunge ${fmt(entry.at.plunge)}, ${fmt(entry.at.stepdown)} mm deep: not the row's present numbers.`
                      : "Numbers not recorded."}
                  </span>
                </li>
              ))}
          </ul>
        </details>
      )}

      <div className="row end">
        <button type="button" className="danger" onClick={props.onRemove}>
          Delete this row
        </button>
      </div>
    </fieldset>
  );
}
