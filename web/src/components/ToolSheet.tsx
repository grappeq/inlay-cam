// The editor of one tool: its shape, its cutting rows, what it is, and its
// stock and source. Nothing is kept until it is saved.

import { useState, type ReactNode } from "react";
import { core } from "../core/client";
import type { CuttingSettings, FeedLevel, Material, Tool, ToolLists } from "../core/types";
import { TOOL_KIND_LABELS, allMaterials, fmt, rowLabel, today } from "../state/model";
import { message, useApp } from "../state/store";
import { NumberField } from "./NumberField";
import { RowFacts, Ruler, Suggestions, percentOf, placeOf, profileFlags, round6, useInsight, type Flags } from "./RowInsight";

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
      // The first material, then the first profile, the tool has no row for yet.
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
      className="card editing"
      aria-label={props.isNew ? "Add tool" : "Edit tool"}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <header className="card-head">
        <p className="card-path">{props.isNew ? "A new tool" : "Editing"}</p>
        <div className="card-title">
          <h2>{tool.name.trim() === "" ? `New ${TOOL_KIND_LABELS[tool.kind].toLowerCase()}` : tool.name}</h2>
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
      </header>

      <Block title="Shape">
        <div className="form-body">
          <TextField label="Name" value={tool.name} onChange={(name) => set({ name: name ?? "" })} wide keepEmpty />
          <div className="grid">
            <NumberField
              label={tool.kind === "v_bit" || tool.kind === "corner_round" ? "Body diameter" : "Diameter"}
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
            <NumberField label="Shoulder length" unit="mm" min={0.001} optional value={tool.shoulderLength} onChange={(v) => set({ shoulderLength: v })} hint="Tip to where the body widens. Empty if it is the flute length." />
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
        </div>
      </Block>

      <Block title="Cutting settings">
        <div className="form-body">
          <p className="muted">
            One plain row per material, safe for any cut, a full-width slot included. A further row per material can be kept for one kind of toolpath, chosen under "For".
          </p>
          {tool.cutting.map((row, index) => (
            <RowEditor key={index} tool={tool} row={row} lists={lists} materials={materials} onChange={(next) => setRow(index, next)} onRemove={() => removeRow(index)} />
          ))}
          <div>
            <button type="button" onClick={addRow}>
              Add a row
            </button>
          </div>
        </div>
      </Block>

      <Block title="What it is">
        <div className="form-body">
          <div className="grid">
            <TextField label="Group" value={tool.group} onChange={(group) => set({ group })} hint='Where it is filed. "/" separates nested groups.' />
            <NumberField label="Tool number" min={1} whole optional value={tool.number} onChange={(v) => set({ number: v })} hint="As other CAM programs list it." />
            <TextField label="Coating" value={tool.coating} onChange={(coating) => set({ coating })} hint="Such as DLC, or uncoated." />
            <TextField label="Style" value={tool.style} onChange={(style) => set({ style })} hint="A word or two: Downcut, Alu." />
          </div>
          <TextField label="Note" value={tool.note} onChange={(note) => set({ note })} wide hint="One line about the whole tool." />
          <div className="field" role="group" aria-label="Suits">
            <span className="field-label">Suits</span>
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
        </div>
      </Block>

      <Block title="Stock and source">
        <div className="form-body">
          <p className="muted">Yours alone: a project file passed on leaves all of this out.</p>
          <div className="grid">
            <NumberField label="On hand" min={0} whole optional value={inventory.quantity} onChange={(v) => setInventory({ quantity: v })} />
            <NumberField label="Price each" min={0} optional value={inventory.price} onChange={(v) => setInventory({ price: v, currency: v === undefined ? undefined : (inventory.currency ?? "EUR") })} />
            <TextField label="Currency" value={inventory.currency} onChange={(currency) => setInventory({ currency: currency?.toUpperCase() })} hint="Three letters, such as EUR." />
            <label className="field">
              <span className="field-label">Last bought</span>
              <input type="date" value={inventory.purchased ?? ""} onChange={(e) => setInventory({ purchased: e.target.value === "" ? undefined : e.target.value })} />
            </label>
          </div>
          <TextField label="Product page" value={source.url} onChange={(url) => setSource({ url })} wide />
          <div className="grid">
            <TextField label="Invoice" value={source.invoice} onChange={(invoice) => setSource({ invoice })} />
            <TextField label="Size as the shop lists it" value={source.sizeNote} onChange={(sizeNote) => setSource({ sizeNote })} />
          </div>
        </div>
      </Block>

      <footer className="card-foot">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Save tool
        </button>
      </footer>
    </form>
  );
}

function Block(props: { title: string; children: ReactNode }) {
  return (
    <section className="block">
      <h3>{props.title}</h3>
      {props.children}
    </section>
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

type WearEntry = NonNullable<NonNullable<Tool["inventory"]>["log"]>[number];

/** Notes a cutter that broke or wore out, and takes it off the count. */
export function LogWear(props: { materials: { value: Material; label: string }[]; canTakeOne: boolean; onAdd: (entry: WearEntry, takeOne: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<WearEntry["kind"]>("broken");
  const [material, setMaterial] = useState("");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(today());
  const [takeOne, setTakeOne] = useState(true);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        A cutter broke or wore out…
      </button>
    );
  }
  const add = () => {
    if (date === "") return;
    props.onAdd({ date, kind, material: material === "" ? undefined : material, note: note.trim() === "" ? undefined : note.trim() }, takeOne && props.canTakeOne);
    setNote("");
    setOpen(false);
  };
  return (
    <div className="log-form" role="group" aria-label="A cutter broke or wore out">
      <div className="row">
        <label className="field">
          <span className="field-label">It</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as WearEntry["kind"])}>
            <option value="broken">broke</option>
            <option value="worn">wore out</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Cutting</span>
          <select value={material} onChange={(e) => setMaterial(e.target.value)}>
            <option value="">Not noted</option>
            {props.materials.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <label className="field wide">
        <span className="field-label">Note</span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
      </label>
      <div className="row">
        {props.canTakeOne && (
          <label className="check">
            <input type="checkbox" checked={takeOne} onChange={(e) => setTakeOne(e.target.checked)} />
            Take one off the count on hand
          </label>
        )}
        <button type="button" className="primary" disabled={date === ""} onClick={add}>
          Add
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One cutting row being edited: what it is for, its numbers, and what the feeds model makes of them. */
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
  const start = profileFlags(row, lists);
  const [flags, setFlags] = useState<Flags>({ ramping: start.ramping, lubricated: start.lubricated });
  const [level, setLevel] = useState<FeedLevel>(start.level);
  const insight = useInsight(tool, row, lists, flags);
  const place = placeOf(row, insight.stops);
  const percent = row.stepoverUnit === "percent";
  const rowTaken = (m: Material, p: string | undefined) => tool.cutting.some((c) => c !== row && c.material === m && c.profile === p);

  return (
    <fieldset className="cut-row">
      <legend>{rowLabel(row, lists)}</legend>
      <div className="cut-row-for">
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
        </label>
        <span className="cut-row-place">
          <Ruler place={place} />
        </span>
        <button type="button" className="danger small" onClick={props.onRemove}>
          Delete row
        </button>
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
      <RowFacts insight={insight} />
      {(row.log?.length ?? 0) > 0 && <p className="hint">Changing these numbers leaves the row's logged results behind: it is untested again at the new ones.</p>}
      <details className="fold">
        <summary>What the feeds model would start from</summary>
        <Suggestions tool={tool} row={row} lists={lists} insight={insight} flags={flags} setFlags={setFlags} level={level} setLevel={setLevel} onUse={set} />
      </details>
    </fieldset>
  );
}
