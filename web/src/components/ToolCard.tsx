// One tool: drawn to scale, with what is known about it and every cutting
// row on one line. "Edit tool" turns the same sheet's values into fields, in
// place; nothing changes until it is saved. Logging a result, a lost cutter
// or a checked item needs no editing and is kept at once.

import { useEffect, useState, type ReactNode } from "react";
import { core } from "../core/client";
import type { Attention, CuttingSettings, FeedLevel, Material, Tool, ToolLists } from "../core/types";
import { CUTTING_KINDS, TOOL_KIND_LABELS, allMaterials, fmt, jobToolIds, materialLabel, rowLabel, today } from "../state/model";
import { message, useApp } from "../state/store";
import { LogList, LogResult, ResultMark, RowFacts, Ruler, Suggestions, percentOf, placeOf, profileFlags, round6, useInsight, valuesOf, type Flags } from "./RowInsight";
import { ToolDrawing } from "./ToolDrawing";

type Inventory = NonNullable<Tool["inventory"]>;
type Source = NonNullable<Tool["source"]>;
type WearEntry = NonNullable<Inventory["log"]>[number];

/** How many things differ between the tool as saved and as edited: fields, and cells of cutting rows. */
function changes(saved: Tool, draft: Tool): number {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  let n = 0;
  const keys = new Set([...Object.keys(saved), ...Object.keys(draft)]) as Set<keyof Tool>;
  for (const key of keys) {
    if (key === "cutting" || key === "inventory" || key === "source") continue;
    if (!same(saved[key], draft[key])) n++;
  }
  for (const part of ["inventory", "source"] as const) {
    const [a, b] = [(saved[part] ?? {}) as Record<string, unknown>, (draft[part] ?? {}) as Record<string, unknown>];
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!same(a[key], b[key])) n++;
  }
  const rows = Math.max(saved.cutting.length, draft.cutting.length);
  for (let i = 0; i < rows; i++) {
    const [a, b] = [saved.cutting[i] as unknown as Record<string, unknown> | undefined, draft.cutting[i] as unknown as Record<string, unknown> | undefined];
    if (!a || !b) n++;
    else for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!same(a[key], b[key])) n++;
  }
  return n;
}

export function ToolCard(props: {
  tool: Tool;
  /** The tool is not in the list yet: the sheet opens for editing, and Cancel discards it. */
  isNew: boolean;
  taken: Tool[];
  attention: Attention[];
  onSave: (tool: Tool) => void;
  /** Told whenever the sheet starts or stops holding changes that are not saved. */
  onDirty: (dirty: boolean) => void;
  onDiscard: () => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  const { lists, project } = useApp();
  const [draft, setDraft] = useState<Tool | null>(props.isNew ? props.tool : null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const editing = draft !== null;
  const tool = draft ?? props.tool;
  const set = (change: Partial<Tool>) => setDraft((t) => (t ? { ...t, ...change } : t));
  const materials = allMaterials(lists);
  const usedBy = project.jobs.filter((job) => jobToolIds(job).includes(tool.id));
  const cuts = CUTTING_KINDS.includes(tool.kind);
  const unsaved = draft ? changes(props.tool, draft) + (props.isNew ? 1 : 0) : 0;
  const { onDirty } = props;
  useEffect(() => {
    onDirty(unsaved > 0);
    return () => onDirty(false);
  }, [unsaved > 0, onDirty]);

  // A stepover given in percent follows the diameter.
  const setDiameter = (diameter: number) =>
    setDraft((t) => t && { ...t, diameter, cutting: t.cutting.map((c) => (c.stepoverUnit === "percent" ? { ...c, stepover: round6((c.stepover / t.diameter) * diameter) } : c)) });
  const inventory: Inventory = tool.inventory ?? {};
  const setInventory = (change: Partial<Inventory>) => {
    const next = { ...inventory, ...change };
    set({ inventory: Object.values(next).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0)) ? next : undefined });
  };
  const source: Source = tool.source ?? {};
  const setSource = (change: Partial<Source>) => {
    const next = { ...source, ...change };
    set({ source: Object.values(next).some((v) => v !== undefined) ? next : undefined });
  };
  const addRow = () =>
    setDraft((t) => {
      if (!t) return t;
      // The first material, then the first profile, the tool has no row for yet.
      const taken = (material: Material, profile?: string) => t.cutting.some((c) => c.material === material && c.profile === profile);
      const free = materials.find((m) => !taken(m.value));
      const material = free?.value ?? materials[0].value;
      const profile = free ? undefined : lists.profiles?.find((p) => !taken(material, p.key))?.key;
      if (!free && profile === undefined) return t;
      const stepover = t.kind === "v_bit" ? 0.2 : t.kind === "corner_round" ? 0.5 : Math.round(t.diameter * 400) / 1000;
      return { ...t, cutting: [...t.cutting, { material, profile, rpm: 12000, feed: 500, plunge: 150, stepover, stepdown: 0.5 }] };
    });

  const save = async () => {
    if (!draft) return;
    const candidate = { ...draft, name: draft.name.trim() };
    if (props.taken.some((t) => t.id !== candidate.id && t.name === candidate.name)) return setError("Another tool already has this name.");
    try {
      const problem = await core.call("validateTool", candidate);
      if (problem) return setError(problem.charAt(0).toUpperCase() + problem.slice(1) + ".");
      props.onSave(candidate);
      setDraft(null);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  };
  const cancel = () => {
    setError(null);
    if (props.isNew) props.onDiscard();
    else setDraft(null);
  };
  /** Changes a row: in the draft while editing, at once otherwise. */
  const changeRow = (index: number, row: CuttingSettings) => {
    const cutting = tool.cutting.map((c, i) => (i === index ? row : c));
    if (editing) set({ cutting });
    else props.onSave({ ...tool, cutting });
  };

  const unknown = <span className="warn">unknown</span>;
  const none = <span className="muted">unknown</span>;
  const mm = (value: number | undefined, missing: ReactNode = none) => (value !== undefined ? `${fmt(value)} mm` : missing);
  const kept = [
    tool.ids && "its ids in the Makera apps",
    tool.apps && "which Makera libraries it goes into",
    tool.fusionType && "its Fusion 360 type",
    tool.cutting.some((c) => c.ids || c.camFlag !== undefined || c.modified) && "what the Makera apps store with its rows",
  ].filter((item): item is string => typeof item === "string");
  const v = tool.kind === "v_bit";
  const rounder = tool.kind === "corner_round";

  return (
    <form
      className={editing ? "card editing" : "card"}
      aria-label={tool.name || "A new tool"}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <header className="card-head">
        <button type="button" className="link back" onClick={props.onBack}>
          All tools
        </button>
        <p className="card-path">
          {editing
            ? props.isNew
              ? `A new ${TOOL_KIND_LABELS[tool.kind].toLowerCase()}`
              : `Editing a ${TOOL_KIND_LABELS[tool.kind].toLowerCase()}`
            : [tool.group, TOOL_KIND_LABELS[tool.kind], tool.number !== undefined ? `tool no. ${tool.number}` : null].filter(Boolean).join(" / ")}
        </p>
        <div className="card-title">
          {editing ? (
            <>
              <input className="title-input" type="text" aria-label="Name" placeholder="Name, such as Ø6×18 3F" autoFocus={props.isNew} value={tool.name} onChange={(e) => set({ name: e.target.value })} />
              <input className="coating-input" type="text" aria-label="Coating" placeholder="Coating" value={tool.coating ?? ""} onChange={(e) => set({ coating: e.target.value.trim() === "" ? undefined : e.target.value })} />
            </>
          ) : (
            <>
              <h2>
                {tool.name}
                {tool.coating && !tool.name.endsWith(tool.coating) && <span className="coating"> {tool.coating}</span>}
              </h2>
              <button type="button" onClick={() => setDraft(props.tool)}>
                Edit tool
              </button>
              <button type="button" className="danger" onClick={props.onDelete}>
                Delete
              </button>
            </>
          )}
        </div>
        {!cuts && <p className="muted">Kept here and written for other programs. No operation of this app cuts with a {TOOL_KIND_LABELS[tool.kind].toLowerCase()}.</p>}
        {editing ? (
          <input className="note-input" type="text" aria-label="Note" placeholder="A line about the whole tool" value={tool.note ?? ""} onChange={(e) => set({ note: e.target.value.trim() === "" ? undefined : e.target.value })} />
        ) : (
          tool.note && <p className="card-note">{tool.note}</p>
        )}
        {!editing && props.attention.length > 0 && (
          <ul className="card-attention">
            {props.attention.map((a, i) => (
              <li key={i}>
                {a.kind === "failed" && a.material && `${rowLabel({ material: a.material, profile: a.profile ?? undefined }, lists)} failed on ${a.date}: ${a.text}`}
                {a.kind === "provisional" && a.material && `${rowLabel({ material: a.material, profile: a.profile ?? undefined }, lists)} worked on ${a.date} and is still to confirm: ${a.text}`}
                {a.kind === "verify" && (
                  <>
                    To check: {a.text}{" "}
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        // The list names the item as "field: note".
                        const left = tool.verify?.filter((item) => (item.note ? `${item.field}: ${item.note}` : item.field) !== a.text) ?? [];
                        props.onSave({ ...tool, verify: left.length > 0 ? left : undefined });
                      }}
                    >
                      Checked
                    </button>
                  </>
                )}
                {a.kind === "no_cutting" && "No cutting settings yet, so it cannot be used."}
                {a.kind === "flute_length" && "Flute length unknown, so no depth can be checked against it."}
              </li>
            ))}
          </ul>
        )}
      </header>

      <Block title="Shape">
        <ToolDrawing tool={tool} />
        <dl className="facts">
          <Fact label={v || rounder ? "Body diameter" : "Diameter"} value={mm(tool.diameter)} edit={editing && <Num label="Diameter" unit="mm" min={0.001} value={tool.diameter} onChange={(n) => n !== undefined && setDiameter(n)} />} />
          <Fact label="Overall length" value={mm(tool.length)} edit={editing && <Num label="Overall length" unit="mm" min={0.001} optional value={tool.length} onChange={(n) => set({ length: n })} />} />
          <Fact label="Flute length" value={mm(tool.fluteLength, unknown)} edit={editing && <Num label="Flute length" unit="mm" min={0.001} optional value={tool.fluteLength} onChange={(n) => set({ fluteLength: n })} />} />
          <Fact label="Flutes" value={tool.flutes ?? none} edit={editing && <Num label="Flutes" min={1} whole optional value={tool.flutes} onChange={(n) => set({ flutes: n })} />} />
          {(editing || tool.shoulderLength !== undefined) && (
            <Fact
              label="Shoulder"
              value={mm(tool.shoulderLength)}
              edit={editing && <Num label="Shoulder length" unit="mm" min={0.001} optional value={tool.shoulderLength} onChange={(n) => set({ shoulderLength: n })} hint="= flute length" />}
            />
          )}
          <Fact label="Shank" value={mm(tool.shankDiameter)} edit={editing && <Num label="Shank diameter" unit="mm" min={0.001} value={tool.shankDiameter} onChange={(n) => n !== undefined && set({ shankDiameter: n })} />} />
          {(v || tool.kind === "drill") && (
            <Fact
              label={tool.kind === "drill" ? "Point angle" : "Angle"}
              value={tool.tipAngle !== undefined ? `${fmt(tool.tipAngle)}°` : unknown}
              edit={editing && <Num label="Angle" unit="°" min={0.1} max={179.9} value={tool.tipAngle} onChange={(n) => n !== undefined && set({ tipAngle: n })} />}
            />
          )}
          {v && <Fact label="Tip flat" value={mm(tool.tipDiameter ?? 0)} edit={editing && <Num label="Tip flat diameter" unit="mm" value={tool.tipDiameter ?? 0} onChange={(n) => n !== undefined && set({ tipDiameter: n })} hint="0: a point" />} />}
          {rounder && (
            <>
              <Fact label="Corner radius" value={mm(tool.cornerRadius ?? 0)} edit={editing && <Num label="Corner radius" unit="mm" min={0.001} value={tool.cornerRadius} onChange={(n) => n !== undefined && set({ cornerRadius: n })} />} />
              <Fact label="Tip" value={mm(tool.tipDiameter ?? 0)} edit={editing && <Num label="Tip diameter" unit="mm" value={tool.tipDiameter ?? 0} onChange={(n) => n !== undefined && set({ tipDiameter: n })} />} />
            </>
          )}
          {tool.kind === "thread_mill" && (
            <>
              <Fact label="Thread" value={tool.threadDiameter !== undefined ? `M${fmt(tool.threadDiameter)}` : none} edit={editing && <Num label="Thread diameter" unit="mm" min={0.001} optional value={tool.threadDiameter} onChange={(n) => set({ threadDiameter: n })} />} />
              <Fact label="Pitch" value={mm(tool.pitch)} edit={editing && <Num label="Pitch" unit="mm" min={0.001} optional value={tool.pitch} onChange={(n) => set({ pitch: n })} />} />
              {(editing || tool.drillDiameter !== undefined) && (
                <Fact label="Drilled hole" value={mm(tool.drillDiameter)} edit={editing && <Num label="Drill diameter" unit="mm" min={0.001} optional value={tool.drillDiameter} onChange={(n) => set({ drillDiameter: n })} />} />
              )}
            </>
          )}
          {(editing || tool.style) && <Fact label="Style" value={tool.style} edit={editing && <Text label="Style" placeholder="Downcut, Alu" value={tool.style} onChange={(style) => set({ style })} />} />}
          {!editing && tool.coating && <Fact label="Coating" value={tool.coating} />}
          {editing && (
            <>
              <Fact label="Group" value={tool.group} edit={<Text label="Group" placeholder="End mills" value={tool.group} onChange={(group) => set({ group })} />} />
              <Fact label="Tool number" value={tool.number} edit={<Num label="Tool number" min={1} whole optional value={tool.number} onChange={(n) => set({ number: n })} />} />
            </>
          )}
        </dl>
        {(editing || (tool.recommendedFor?.length ?? 0) > 0) && (
          <p className="suits">
            <span className="muted">Suits</span>
            {materials.map((m) => {
              const on = tool.recommendedFor?.includes(m.value) ?? false;
              if (!editing) return <span key={m.value} className={on ? "chip on" : "chip"}>{m.label}</span>;
              const next = materials.map((x) => x.value).filter((key) => (key === m.value ? !on : (tool.recommendedFor?.includes(key) ?? false)));
              return (
                <button type="button" key={m.value} className="chip" aria-pressed={on} onClick={() => set({ recommendedFor: next.length > 0 ? next : undefined })}>
                  {m.label}
                </button>
              );
            })}
          </p>
        )}
      </Block>

      <Block title="Cutting settings" count={tool.cutting.length === 0 ? undefined : `${tool.cutting.length} ${tool.cutting.length === 1 ? "row" : "rows"}`}>
        {tool.cutting.length === 0 ? (
          <p className="block-empty">None yet. A tool cannot be used on a material it has no settings for.</p>
        ) : (
          <div className="cut-wrap">
            <table className="cut-table">
              <thead>
                <tr>
                  <th>For</th>
                  <th className="num">
                    Speed <small>rpm</small>
                  </th>
                  <th className="num">
                    Feed <small>mm/min</small>
                  </th>
                  <th className="num">
                    Plunge <small>mm/min</small>
                  </th>
                  <th className="num">Stepover</th>
                  <th className="num">
                    Depth <small>mm</small>
                  </th>
                  <th>How hard</th>
                  {editing && <th />}
                </tr>
              </thead>
              <tbody>
                {tool.cutting.map((row, index) => (
                  <CutLine
                    key={index}
                    tool={tool}
                    row={row}
                    lists={lists}
                    materials={materials}
                    editing={editing}
                    open={open === index}
                    onToggle={() => setOpen(open === index ? null : index)}
                    onChange={(next) => changeRow(index, next)}
                    onRemove={() => {
                      set({ cutting: tool.cutting.filter((_, i) => i !== index) });
                      setOpen(null);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {editing ? (
          <p className="block-line">
            <button type="button" onClick={addRow}>
              Add a row
            </button>{" "}
            <span className="hint">One plain row per material, safe for any cut. A further row per material can be kept for one profile.</span>
          </p>
        ) : (
          tool.cutting.length === 0 && (
            <p className="block-line">
              <button type="button" onClick={() => setDraft(props.tool)}>
                Edit tool to add them
              </button>
            </p>
          )
        )}
      </Block>

      {!editing && usedBy.length > 0 && (
        <Block title="In the open project">
          <p className="block-line">
            Used by {usedBy.map((job) => job.name).join(", ")} in {project.name || "the open project"}.
          </p>
        </Block>
      )}

      <Block title="Stock and source">
        <dl className="facts">
          <Fact
            label="On hand"
            value={inventory.quantity !== undefined ? <span className={inventory.quantity === 0 ? "warn" : ""}>{inventory.quantity}</span> : <span className="muted">not counted</span>}
            edit={editing && <Num label="On hand" min={0} whole optional value={inventory.quantity} onChange={(n) => setInventory({ quantity: n })} />}
          />
          <Fact
            label="Price each"
            value={inventory.price !== undefined ? `${fmt(inventory.price)} ${inventory.currency ?? ""}` : <span className="muted">not noted</span>}
            edit={
              editing && (
                <span className="pair">
                  <Num label="Price each" min={0} optional value={inventory.price} onChange={(n) => setInventory({ price: n, currency: n === undefined ? undefined : (inventory.currency ?? "EUR") })} />
                  <Text label="Currency" placeholder="EUR" value={inventory.currency} onChange={(currency) => setInventory({ currency: currency?.toUpperCase() })} />
                </span>
              )
            }
          />
          {(editing || inventory.purchased) && (
            <Fact
              label="Last bought"
              value={<span className="num">{inventory.purchased}</span>}
              edit={editing && <input className="cell-in" type="date" aria-label="Last bought" value={inventory.purchased ?? ""} onChange={(e) => setInventory({ purchased: e.target.value === "" ? undefined : e.target.value })} />}
            />
          )}
          {(editing || source.invoice) && <Fact label="Invoice" value={source.invoice} edit={editing && <Text label="Invoice" value={source.invoice} onChange={(invoice) => setSource({ invoice })} />} />}
          {(editing || source.sizeNote) && <Fact label="Size as sold" value={source.sizeNote} edit={editing && <Text label="Size as the shop lists it" value={source.sizeNote} onChange={(sizeNote) => setSource({ sizeNote })} />} />}
          {(editing || source.url) && (
            <Fact
              label="Product page"
              value={
                source.url && (
                  <a href={source.url} target="_blank" rel="noreferrer">
                    {source.url.replace(/^https?:\/\//, "").slice(0, 48)}
                  </a>
                )
              }
              edit={editing && <Text label="Product page" placeholder="https://" value={source.url} onChange={(url) => setSource({ url })} />}
            />
          )}
        </dl>
        {(inventory.log?.length ?? 0) > 0 && (
          <ul className="log-list">
            {inventory.log?.map((entry, i) => (
              <li key={i}>
                <span className="num">{entry.date}</span>
                <span className="mark danger">{entry.kind}</span>
                <span>
                  {entry.material ? `In ${materialLabel(entry.material, lists).toLowerCase()}. ` : ""}
                  {entry.note}
                </span>
              </li>
            ))}
          </ul>
        )}
        {!editing && (
          <div className="block-line">
            <LogWear
              materials={materials}
              canTakeOne={(inventory.quantity ?? 0) > 0}
              onAdd={(entry, takeOne) =>
                props.onSave({
                  ...tool,
                  inventory: { ...inventory, log: [...(inventory.log ?? []), entry], quantity: takeOne && inventory.quantity !== undefined ? Math.max(0, inventory.quantity - 1) : inventory.quantity },
                })
              }
            />
          </div>
        )}
        {editing && <p className="block-line muted">Yours alone: a project file passed on leaves all of this out.</p>}
        {kept.length > 0 && <p className="block-line muted">Also kept, for other programs: {kept.join("; ")}.</p>}
      </Block>

      {editing && (
        <footer className="save-bar">
          <span className={error ? "form-error" : "muted"} role={error ? "alert" : undefined}>
            {error ?? (unsaved === 0 ? "No unsaved changes" : `${unsaved} unsaved ${unsaved === 1 ? "change" : "changes"}`)}
          </span>
          <span className="spacer" />
          <button type="button" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={unsaved === 0 && !props.isNew}>
            Save changes
          </button>
        </footer>
      )}
    </form>
  );
}

function Block(props: { title: string; count?: string; children: ReactNode }) {
  return (
    <section className="block">
      <h3>
        {props.title}
        {props.count && <span className="muted"> {props.count}</span>}
      </h3>
      {props.children}
    </section>
  );
}

/** A label and its value; while the sheet is edited, the field that changes it. */
function Fact(props: { label: string; value: ReactNode; edit?: ReactNode }) {
  return (
    <div className="fact">
      <dt>{props.label}</dt>
      <dd>{props.edit || props.value}</dd>
    </div>
  );
}

/** A line of text in a cell; empty means none. */
function Text(p: { label: string; value: string | undefined; onChange: (value: string | undefined) => void; placeholder?: string }) {
  return <input className="cell-in" type="text" aria-label={p.label} placeholder={p.placeholder} value={p.value ?? ""} onChange={(e) => p.onChange(e.target.value.trim() === "" ? undefined : e.target.value)} />;
}

/**
 * A number in a cell. It reports only complete, in-range numbers; while the
 * text is not one, the field is marked and the last good value stays.
 */
function Num(p: { label: string; value: number | undefined; onChange: (value: number | undefined) => void; unit?: string; min?: number; max?: number; whole?: boolean; optional?: boolean; hint?: string }) {
  const [text, setText] = useState(p.value === undefined ? "" : String(round6(p.value)));
  const [bad, setBad] = useState(false);
  const parse = (t: string) => (t.trim() === "" ? undefined : Number(t.replace(",", ".")));
  // Follow changes from elsewhere (a suggestion taken, the diameter changed) unless the text already says the same.
  useEffect(() => {
    if (parse(text) !== p.value) {
      setText(p.value === undefined ? "" : String(round6(p.value)));
      setBad(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.value]);
  return (
    <span className="num-in">
      <input
        className="cell-in"
        type="text"
        inputMode="decimal"
        aria-label={p.label}
        aria-invalid={bad}
        placeholder={p.hint}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const n = parse(e.target.value);
          const usable = n === undefined ? p.optional === true : !Number.isNaN(n) && n >= (p.min ?? 0) && n <= (p.max ?? Infinity) && (!p.whole || Number.isInteger(n));
          setBad(!usable);
          if (usable) p.onChange(n);
        }}
      />
      {p.unit && <span className="unit">{p.unit}</span>}
    </span>
  );
}

/** One cutting row on one line; opened, what the model makes of it, its log, and a way to log a result. */
function CutLine(props: {
  tool: Tool;
  row: CuttingSettings;
  lists: ToolLists;
  materials: { value: Material; label: string }[];
  editing: boolean;
  open: boolean;
  onToggle: () => void;
  onChange: (row: CuttingSettings) => void;
  onRemove: () => void;
}) {
  const { tool, row, lists, editing } = props;
  const set = (change: Partial<CuttingSettings>) => props.onChange({ ...row, ...change });
  const start = profileFlags(row, lists);
  const [flags, setFlags] = useState<Flags>({ ramping: start.ramping, lubricated: start.lubricated });
  const [level, setLevel] = useState<FeedLevel>(start.level);
  const insight = useInsight(tool, row, lists, flags);
  const place = placeOf(row, insight.stops);
  const profile = lists.profiles?.find((p) => p.key === row.profile);
  const warned = (insight.check?.warnings.length ?? 0) > 0;
  const percent = row.stepoverUnit === "percent";
  const rowTaken = (m: Material, p: string | undefined) => tool.cutting.some((c) => c !== row && c.material === m && c.profile === p);
  const hard = insight.check && !insight.check.covered ? <span className="muted">no model</span> : <Ruler place={place} />;

  return (
    <>
      {editing ? (
        <tr className={props.open ? "cut-line open" : "cut-line"}>
          <th scope="row">
            <span className="for-in">
              <button type="button" className="cut-toggle" aria-expanded={props.open} aria-label="What the model makes of this row" onClick={props.onToggle}>
                <span className="caret" aria-hidden="true" />
              </button>
              <select aria-label="Material" value={row.material} onChange={(e) => set({ material: e.target.value })}>
                {props.materials.map((m) => (
                  <option key={m.value} value={m.value} disabled={rowTaken(m.value, row.profile)}>
                    {m.label}
                  </option>
                ))}
                {!props.materials.some((m) => m.value === row.material) && <option value={row.material}>{row.material}</option>}
              </select>
              <select aria-label="For" value={row.profile ?? ""} onChange={(e) => set({ profile: e.target.value === "" ? undefined : e.target.value })}>
                <option value="" disabled={rowTaken(row.material, undefined)}>
                  any cut
                </option>
                {lists.profiles?.map((p) => (
                  <option key={p.key} value={p.key} disabled={rowTaken(row.material, p.key)}>
                    {p.label}
                  </option>
                ))}
                {row.profile !== undefined && !profile && <option value={row.profile}>{row.profile}</option>}
              </select>
            </span>
          </th>
          <td className="num">
            <Num label="Speed, rpm" min={1} whole value={row.rpm} onChange={(n) => n !== undefined && set({ rpm: n })} />
          </td>
          <td className="num">
            <Num label="Feed, mm/min" min={0.001} value={row.feed} onChange={(n) => n !== undefined && set({ feed: n })} />
          </td>
          <td className="num">
            <Num label="Plunge, mm/min" min={0.001} value={row.plunge} onChange={(n) => n !== undefined && set({ plunge: n })} />
          </td>
          <td className="num">
            <span className="pair">
              <Num
                label={percent ? "Stepover, percent" : "Stepover, mm"}
                min={0.001}
                max={percent ? 100 : tool.diameter}
                value={percent ? percentOf(row, tool.diameter) : row.stepover}
                onChange={(n) => n !== undefined && set({ stepover: percent ? round6((n / 100) * tool.diameter) : n })}
              />
              <button type="button" className="unit-toggle" title={percent ? `${fmt(row.stepover)} mm. Click to give it in mm` : `${fmt(percentOf(row, tool.diameter))} %. Click to give it in percent`} onClick={() => set({ stepoverUnit: percent ? undefined : "percent" })}>
                {percent ? "%" : "mm"}
              </button>
            </span>
          </td>
          <td className="num">
            <Num label="Depth per pass, mm" min={0.001} value={row.stepdown} onChange={(n) => n !== undefined && set({ stepdown: n })} />
          </td>
          <td>{hard}</td>
          <td>
            <button type="button" className="row-x" aria-label={`Delete the ${rowLabel(row, lists)} row`} title="Delete this row" onClick={props.onRemove}>
              ×
            </button>
          </td>
        </tr>
      ) : (
        <tr className={props.open ? "cut-line open" : "cut-line"} onClick={props.onToggle}>
          <th scope="row">
            <button type="button" className="cut-toggle" aria-expanded={props.open} onClick={(e) => (e.stopPropagation(), props.onToggle())}>
              <span className="caret" aria-hidden="true" />
              {materialLabel(row.material, lists)}
            </button>
            {row.profile !== undefined && <span className="tag">{profile?.label ?? row.profile}</span>} <ResultMark row={row} short />
            {warned && (
              <span className="mark warn" title={insight.check?.warnings.join(" ")}>
                {" "}
                !
              </span>
            )}
          </th>
          <td className="num">{row.rpm}</td>
          <td className="num">{fmt(row.feed)}</td>
          <td className="num">{fmt(row.plunge)}</td>
          <td className="num">
            {percent ? `${fmt(percentOf(row, tool.diameter))} %` : `${fmt(row.stepover)} mm`}
            <small> {percent ? `${fmt(row.stepover)} mm` : `${fmt(percentOf(row, tool.diameter))} %`}</small>
          </td>
          <td className="num">{fmt(row.stepdown)}</td>
          <td>{hard}</td>
        </tr>
      )}
      {props.open && (
        <tr className="cut-detail">
          <td colSpan={editing ? 8 : 7}>
            <p className="readouts">
              <ResultMark row={row} />
            </p>
            <RowFacts insight={insight} />
            {editing && tool.kind === "thread_mill" && (
              <p className="readouts">
                Radial passes <Num label="Passes" min={1} whole optional value={row.passes} onChange={(n) => set({ passes: n })} />
              </p>
            )}
            <LogList row={row} />
            {editing ? (
              (row.log?.length ?? 0) > 0 && <p className="hint">Changing the numbers leaves the logged results behind: the row is untested again at the new ones.</p>
            ) : (
              <LogResult saves="now" onAdd={(entry) => props.onChange({ ...row, log: [...(row.log ?? []), { ...entry, at: valuesOf(row) }] })} />
            )}
            <details className="fold" open={editing || undefined}>
              <summary>What the feeds model would start from</summary>
              <Suggestions tool={tool} row={row} lists={lists} insight={insight} flags={flags} setFlags={setFlags} level={level} setLevel={setLevel} onUse={set} />
            </details>
          </td>
        </tr>
      )}
    </>
  );
}

/** Notes a cutter that broke or wore out, and takes it off the count. */
function LogWear(props: { materials: { value: Material; label: string }[]; canTakeOne: boolean; onAdd: (entry: WearEntry, takeOne: boolean) => void }) {
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
            // Enter adds the entry; it must not submit the sheet around it.
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
