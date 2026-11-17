// One tool: drawn to scale, with what is known about it and every cutting
// row on one line. "Edit tool" turns the same sheet's values into fields, in
// place; nothing changes until it is saved. Logging a result, a lost cutter
// or a checked item needs no editing and is kept at once.

import { useEffect, useState, type ReactNode } from "react";
import { core } from "../core/client";
import type { Attention, CuttingSettings, Material, Tool, ToolKind, ToolLists } from "../core/types";
import { rowStatus, type CutValues, type Pick } from "../state/feedsView";
import { COATINGS, CUTTING_KINDS, TOOL_KIND_LABELS, allMaterials, displayName, fmt, goesTo, jobToolIds, makeraWarnings, materialLabel, rowLabel, today } from "../state/model";
import { message, useApp } from "../state/store";
import { LogList, LogResult, ResultMark, RowFacts, Ruler, StatusTag, SuggestionSlot, entryFor, percentOf, round6, rowKey, startPick, useEntry, valuesOf } from "./RowInsight";
import { Num, Text } from "./Cells";
import { ToolDrawing } from "./ToolDrawing";

type Inventory = NonNullable<Tool["inventory"]>;
type Source = NonNullable<Tool["source"]>;
type WearEntry = NonNullable<Inventory["log"]>[number];
type VerifyItem = NonNullable<Tool["verify"]>[number];

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
  const key = (row: CuttingSettings) => `${row.material}@${row.profile ?? ""}`;
  // The same rows in another order are a change too: the order is kept in files.
  if (saved.cutting.length === draft.cutting.length && saved.cutting.some((row, i) => key(row) !== key(draft.cutting[i]))) n++;
  for (const row of saved.cutting) if (!draft.cutting.some((other) => key(other) === key(row))) n++;
  for (const row of draft.cutting) {
    const before = saved.cutting.find((other) => key(other) === key(row)) as unknown as Record<string, unknown> | undefined;
    const now = row as unknown as Record<string, unknown>;
    if (!before) n++;
    else for (const field of new Set([...Object.keys(before), ...Object.keys(now)])) if (!same(before[field], now[field])) n++;
  }
  return n;
}

/** The tool as saving writes it: its name trimmed, and items to check that were left empty dropped. */
function tidy(draft: Tool): Tool {
  const verify = draft.verify?.map((v) => ({ ...v, field: v.field.trim() })).filter((v) => v.field !== "");
  return { ...draft, name: draft.name.trim(), verify: verify && verify.length > 0 ? verify : undefined };
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
  const [wearEdit, setWearEdit] = useState<number | null>(null);
  // While editing: the row the suggestion at the foot of the table is for.
  const [inspect, setInspect] = useState(0);
  // The combination the suggestion shows, kept while the same row is inspected.
  const [picked, setPicked] = useState<{ at: number; row: string; pick: Pick } | null>(null);
  const [saving, setSaving] = useState(false);
  const editing = draft !== null;
  const tool = draft ?? props.tool;
  const set = (change: Partial<Tool>) => {
    // What was wrong at the last save may no longer be.
    setError(null);
    setDraft((t) => (t ? { ...t, ...change } : t));
  };
  const materials = allMaterials(lists);
  const usedBy = project.jobs.filter((job) => jobToolIds(job).includes(tool.id));
  // The groups there are to file a tool under: the pinned ones, and every one a tool names.
  const groups = [...new Set([...(lists.groups ?? []).map((g) => g.path), ...props.taken.map((t) => t.group).filter((g): g is string => !!g)])];
  const cuts = CUTTING_KINDS.includes(tool.kind);
  const unsaved = draft ? changes(props.tool, tidy(draft)) + (props.isNew ? 1 : 0) : 0;
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
  const addRow = () => {
    if (!draft) return;
    const has = (material: Material, profile?: string) => draft.cutting.some((c) => c.material === material && c.profile === profile);
    let next: { material: Material; profile?: string } | undefined = materials.map((m) => ({ material: m.value })).find((r) => !has(r.material));
    for (const m of materials) next ??= (lists.profiles ?? []).map((p) => ({ material: m.value, profile: p.key })).find((r) => !has(r.material, r.profile));
    if (!next) return setError("Every material already has a row for every profile.");
    const stepover = draft.kind === "v_bit" ? 0.2 : draft.kind === "corner_round" ? 0.5 : Math.round(draft.diameter * 400) / 1000;
    set({ cutting: [...draft.cutting, { ...next, rpm: 12000, feed: 500, plunge: 150, stepover, stepdown: 0.5 }] });
    setInspect(draft.cutting.length);
  };

  const inspectAt = Math.min(inspect, tool.cutting.length - 1);
  const inspected: CuttingSettings | undefined = tool.cutting[inspectAt];
  const pick = inspected ? (picked?.at === inspectAt && picked.row === rowKey(inspected) ? picked.pick : startPick(inspected, lists)) : null;

  /** Starts editing, with the suggestion on the first plain row that holds none of the model's: the one most worth a look. */
  const startEdit = () => {
    setDraft(props.tool);
    setInspect(0);
    setPicked(null);
    const saved = props.tool;
    void Promise.all(saved.cutting.map((row) => (row.profile === undefined ? entryFor(saved, row, lists).catch(() => null) : null))).then((entries) => {
      const first = saved.cutting.findIndex((row, i) => entries[i] && rowStatus(row, entries[i], saved.diameter, false) === "differs");
      if (first > 0) setInspect((now) => (now === 0 ? first : now));
    });
  };

  const save = async () => {
    if (!draft || saving) return;
    const candidate = tidy(draft);
    const shown = displayName(candidate.name, candidate.coating);
    const clash = props.taken.find((t) => t.id !== candidate.id && [t.name, displayName(t.name, t.coating)].some((n) => n === candidate.name || n === shown));
    if (clash) return setError(`Another tool already has this name: ${displayName(clash.name, clash.coating)}.`);
    setSaving(true);
    try {
      const problem = await core.call("validateTool", candidate);
      if (problem) return setError(problem.charAt(0).toUpperCase() + problem.slice(1) + ".");
      props.onSave(candidate);
      setDraft(null);
      setError(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
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
  const passes = tool.kind === "thread_mill";
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
            : [tool.group?.split("/").join(" / "), TOOL_KIND_LABELS[tool.kind], tool.number !== undefined ? `tool no. ${tool.number}` : null].filter(Boolean).join(" / ")}
        </p>
        <div className="card-title">
          {editing ? (
            <>
              <input className="title-input" type="text" aria-label="Name" placeholder="Name, such as Ø6×18 3F" autoFocus={props.isNew} value={tool.name} onChange={(e) => set({ name: e.target.value })} />
              <input className="coating-input" type="text" list="tool-coatings" aria-label="Coating" placeholder="Coating" value={tool.coating ?? ""} onChange={(e) => set({ coating: e.target.value.trim() === "" ? undefined : e.target.value })} />
              <datalist id="tool-coatings">
                {COATINGS.map((coating) => (
                  <option key={coating} value={coating} />
                ))}
              </datalist>
            </>
          ) : (
            <>
              <h2>
                {tool.name}
                {tool.coating && !tool.name.endsWith(tool.coating) && <span className="coating"> {tool.coating}</span>}
              </h2>
              <button type="button" onClick={startEdit}>
                Edit tool
              </button>
            </>
          )}
        </div>
        {draft && <NameHint draft={draft} saved={props.tool} isNew={props.isNew} taken={props.taken} onUse={(name) => set({ name })} />}
        {!cuts && <p className="muted">Kept here and written for other programs. No operation of this app cuts with a {TOOL_KIND_LABELS[tool.kind].toLowerCase()}.</p>}
        {editing ? (
          <input className="note-input" type="text" aria-label="Note" placeholder="A line about the whole tool" value={tool.note ?? ""} onChange={(e) => set({ note: e.target.value.trim() === "" ? undefined : e.target.value })} />
        ) : (
          tool.note && <p className="card-note">{tool.note}</p>
        )}
        {editing ? (
          <textarea
            className="description-input"
            aria-label="Description"
            placeholder="Longer remarks, of any length. In a tools.yaml these are the comment lines above the tool."
            rows={Math.min(8, Math.max(2, (tool.description ?? "").split("\n").length))}
            value={tool.description ?? ""}
            onChange={(e) => set({ description: e.target.value.trim() === "" ? undefined : e.target.value })}
          />
        ) : (
          tool.description && (
            <details className="fold description">
              <summary>Remarks, {tool.description.split("\n").length} {tool.description.split("\n").length === 1 ? "line" : "lines"}</summary>
              <p>{tool.description}</p>
            </details>
          )
        )}
        {editing && <VerifyEdit items={tool.verify ?? []} onChange={(verify) => set({ verify: verify.length > 0 ? verify : undefined })} />}
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
            <table className={passes ? "cut-table with-passes" : "cut-table"}>
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
                  {passes && (
                    <th className="num" title="Radial passes to cut the thread">
                      Passes
                    </th>
                  )}
                  <th className="col-hard">How hard</th>
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
                    passes={passes}
                    inspected={editing && inspectAt === index}
                    pick={editing && inspectAt === index ? pick : null}
                    onInspect={() => setInspect(index)}
                    open={!editing && open === index}
                    onToggle={() => setOpen(open === index ? null : index)}
                    onChange={(next) => changeRow(index, next)}
                    onRemove={() => {
                      set({ cutting: tool.cutting.filter((_, i) => i !== index) });
                      setOpen(null);
                    }}
                  />
                ))}
              </tbody>
              {editing && inspected && pick && (
                <SuggestionSlot
                  key={rowKey(inspected)}
                  tool={tool}
                  row={inspected}
                  lists={lists}
                  passes={passes}
                  pick={pick}
                  onPick={(next) => setPicked({ at: inspectAt, row: rowKey(inspected), pick: next })}
                  onUse={(change: Partial<CutValues>) => changeRow(inspectAt, { ...inspected, ...change })}
                />
              )}
            </table>
          </div>
        )}
        {!editing &&
          makeraWarnings(tool, lists).map((warning) => (
            <p key={warning} className="block-line hint warn">
              ▲ {warning}
            </p>
          ))}
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
              <button type="button" onClick={startEdit}>
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
            {inventory.log?.map((entry, i) =>
              wearEdit === i && !editing ? (
                <li key={i} className="editing">
                  <LogWear
                    initial={entry}
                    materials={materials}
                    canTakeOne={false}
                    onCancel={() => setWearEdit(null)}
                    onAdd={(next) => {
                      props.onSave({ ...tool, inventory: { ...inventory, log: inventory.log?.map((e, j) => (j === i ? next : e)) } });
                      setWearEdit(null);
                    }}
                  />
                </li>
              ) : (
                <li key={i}>
                  <span className="num">{entry.date}</span>
                  <span className="mark danger">{entry.kind}</span>
                  <span>
                    {entry.material ? `In ${materialLabel(entry.material, lists).toLowerCase()}. ` : ""}
                    {entry.note}
                  </span>
                  {!editing && wearEdit === null && (
                    <span className="log-acts">
                      <button type="button" className="link" onClick={() => setWearEdit(i)}>
                        Correct
                      </button>
                      <button
                        type="button"
                        className="link"
                        onClick={() => {
                          if (!window.confirm(`Take the entry of ${entry.date} out of the log? The count on hand stays as it is.`)) return;
                          const log = inventory.log?.filter((_, j) => j !== i) ?? [];
                          const next = { ...inventory, log: log.length > 0 ? log : undefined };
                          props.onSave({ ...tool, inventory: Object.values(next).some((v) => v !== undefined) ? next : undefined });
                        }}
                      >
                        Remove
                      </button>
                    </span>
                  )}
                </li>
              ),
            )}
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

      <ToolSettings tool={tool} saved={props.tool} editing={editing} isNew={props.isNew} groups={groups} set={set} onDelete={props.onDelete} />

      {editing && (
        <footer className="save-bar">
          <span className={error ? "form-error" : "muted"} role={error ? "alert" : undefined}>
            {error ?? (unsaved === 0 ? "No unsaved changes" : `${unsaved} unsaved ${unsaved === 1 ? "change" : "changes"}`)}
          </span>
          <span className="spacer" />
          <button type="button" onClick={cancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={saving || (unsaved === 0 && !props.isNew)}>
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

/** The tool as the core reads it for a name: its rows and its own notes left out. */
const bare = (tool: Tool): Tool => ({ ...tool, id: tool.id || "new", name: tool.name || "Tool", cutting: [], verify: undefined, inventory: undefined, source: undefined });

/**
 * Under the name while a tool is edited: the standard name for a tool of its
 * kind and sizes, offered when the name is another. A V-bit is read by the
 * name it is saved under, so that the offer does not flip while one is typed.
 */
function NameHint(props: { draft: Tool; saved: Tool; isNew: boolean; taken: Tool[]; onUse: (name: string) => void }) {
  const { draft, isNew } = props;
  const [offer, setOffer] = useState<{ name: string; accepted: string[] } | null>(null);
  const named = isNew ? draft.name : props.saved.name;
  const shape = JSON.stringify({ ...bare(draft), name: "Tool", note: undefined, description: undefined });
  const taken = JSON.stringify(props.taken.filter((t) => t.id !== draft.id).flatMap((t) => [t.name, displayName(t.name, t.coating)]));
  useEffect(() => {
    let stale = false;
    // An offer worked out for other sizes is not to be taken.
    setOffer(null);
    const timer = setTimeout(() => {
      core.call("suggestName", JSON.parse(shape), named, JSON.parse(taken)).then(
        (next) => !stale && setOffer(next),
        // A shape the core cannot read yet, mid-edit.
        () => !stale && setOffer(null),
      );
    }, 150);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [shape, named, taken]);
  const name = draft.name.trim();
  const offered = offer !== null && !offer.accepted.includes(name);
  const needs = draft.kind === "ball_end" ? "" : draft.kind === "thread_mill" ? " (the thread, the pitch and the flute length)" : draft.kind === "v_bit" || draft.kind === "corner_round" ? " (the angle, or the tip under the rounding)" : " (the flute length too)";
  return (
    <p className="name-hint">
      {offered && (
        <>
          Suggested: <code>{offer.name}</code>{" "}
          <button type="button" className="small" aria-label={`Use the suggested name ${offer.name}`} onClick={() => props.onUse(offer.name)}>
            Use
          </button>
        </>
      )}
      {isNew && name === "" && <span className="muted">{offered ? " Or type your own." : `Fill in the sizes${needs} for a suggested name, or type your own.`}</span>}
    </p>
  );
}

/** What is still to check about a tool, while it is edited: a size not measured yet, a setting never tried. */
function VerifyEdit(props: { items: VerifyItem[]; onChange: (items: VerifyItem[]) => void }) {
  const { items } = props;
  const change = (at: number, next: Partial<VerifyItem>) => props.onChange(items.map((item, i) => (i === at ? { ...item, ...next } : item)));
  return (
    <div className="verify-edit">
      {items.map((item, i) => (
        <div key={i} className="verify-row">
          <span className="muted">To check</span>
          <input className="cell-in" type="text" aria-label="What is to check" placeholder="What, such as flute length" autoFocus={item.field === ""} value={item.field} onChange={(e) => change(i, { field: e.target.value })} />
          <input className="cell-in grow" type="text" aria-label={`Note on checking ${item.field || "it"}`} placeholder="Why, or how (optional)" value={item.note ?? ""} onChange={(e) => change(i, { note: e.target.value.trim() === "" ? undefined : e.target.value })} />
          <button type="button" className="row-x" aria-label={item.field ? `Take "${item.field}" off the list to check` : "Take this off the list to check"} title="Take it off the list" onClick={() => props.onChange(items.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className="link" disabled={items.some((item) => item.field.trim() === "")} onClick={() => props.onChange([...items, { field: "" }])}>
        Add something to check
      </button>
    </div>
  );
}

const KINDS: ToolKind[] = ["flat_end", "ball_end", "v_bit", "corner_round", "drill", "thread_mill"];

/**
 * Where a tool is filed and what it goes into: its group, kind and number,
 * and which programs' libraries it is written for. Folded at the foot of the
 * sheet, since it is seldom looked at; a new tool's is open.
 */
function ToolSettings(props: { tool: Tool; saved: Tool; editing: boolean; isNew: boolean; groups: string[]; set: (change: Partial<Tool>) => void; onDelete: () => void }) {
  const { tool, editing, set } = props;
  const apps = tool.apps ?? ["cam", "studio"];
  const appsText = apps.length === 2 ? "Makera CAM and Studio" : apps.length === 0 ? "neither Makera app" : apps[0] === "cam" ? "Makera CAM" : "Makera Studio";
  const fusion = tool.kind === "v_bit" || tool.kind === "corner_round";
  const fusionText = tool.fusionType ? tool.fusionType.replace("_", " ") : tool.kind === "corner_round" ? "radius mill" : "chamfer mill";
  const changed = (["group", "kind", "number", "apps", "fusionType"] as const).filter((k) => JSON.stringify(tool[k] ?? null) !== JSON.stringify(props.saved[k] ?? null)).length;
  const toggleApp = (app: "cam" | "studio") => {
    const next = (["cam", "studio"] as const).filter((a) => (a === app ? !apps.includes(a) : apps.includes(a)));
    set({ apps: next.length === 2 ? undefined : next });
  };
  // Changing the kind keeps what the new kind also has, and gives it what it must have.
  const setKind = (kind: ToolKind) => {
    const change: Partial<Tool> = { kind };
    if ((kind === "v_bit" || kind === "drill") && tool.tipAngle === undefined) change.tipAngle = kind === "drill" ? 118 : 60;
    if (kind === "corner_round" && tool.cornerRadius === undefined) change.cornerRadius = Math.max(0.1, Math.round((tool.diameter - (tool.tipDiameter ?? 0)) * 500) / 1000);
    if (kind !== "v_bit") change.fusionType = undefined;
    // What the new kind has no use for goes; back at the kind it was saved as, it has what it was saved with.
    if (kind !== "v_bit" && kind !== "drill" && kind !== "thread_mill") change.tipAngle = undefined;
    if (kind !== "corner_round") change.cornerRadius = undefined;
    if (kind === props.saved.kind) Object.assign(change, { tipAngle: props.saved.tipAngle, cornerRadius: props.saved.cornerRadius, fusionType: props.saved.fusionType });
    set(change);
  };
  return (
    <details className="block toolset" open={props.isNew || undefined}>
      <summary>
        <b>Tool settings</b>
        <span className="muted">
          {" "}
          {[tool.group?.split("/").join(" / "), TOOL_KIND_LABELS[tool.kind], tool.number !== undefined ? `no. ${tool.number}` : null, `goes to ${appsText}`, fusion ? `Fusion 360: ${fusionText}` : null].filter(Boolean).join(", ")}
        </span>
        {editing && !props.isNew && changed > 0 && <span className="mark warn"> {changed} changed</span>}
      </summary>
      <dl className="facts">
        <Fact
          label="Group"
          value={tool.group?.split("/").join(" / ") ?? <span className="muted">none: listed by its kind</span>}
          edit={
            editing && (
              <>
                <input className="cell-in" type="text" list="tool-groups" aria-label="Group" placeholder="Such as End mills" value={tool.group ?? ""} onChange={(e) => set({ group: e.target.value.trim() === "" ? undefined : e.target.value })} />
                <datalist id="tool-groups">
                  {props.groups.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </>
            )
          }
        />
        <Fact label="Number" value={tool.number ?? <span className="muted">none</span>} edit={editing && <Num label="Tool number" min={1} whole optional value={tool.number} onChange={(n) => set({ number: n })} />} />
        <Fact
          label="Kind"
          value={TOOL_KIND_LABELS[tool.kind]}
          edit={
            editing && (
              <select className="cell-in" aria-label="Kind" value={tool.kind} onChange={(e) => setKind(e.target.value as ToolKind)}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {TOOL_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            )
          }
        />
        <Fact
          label="Goes to"
          value={apps.length === 0 ? "Neither Makera app (built into them); Fusion 360 only" : appsText}
          edit={
            editing && (
              <span className="check-list">
                <label className="check">
                  <input type="checkbox" checked={apps.includes("cam")} onChange={() => toggleApp("cam")} />
                  Makera CAM
                </label>
                <label className="check">
                  <input type="checkbox" checked={apps.includes("studio")} onChange={() => toggleApp("studio")} />
                  Makera Studio
                </label>
              </span>
            )
          }
        />
        {tool.kind === "v_bit" && (
          <Fact
            label="Fusion 360 type"
            value={tool.fusionType ? fusionText : `auto (${fusionText})`}
            edit={
              editing && (
                <select className="cell-in" aria-label="Fusion 360 type" value={tool.fusionType ?? ""} onChange={(e) => set({ fusionType: e.target.value === "" ? undefined : (e.target.value as Tool["fusionType"]) })}>
                  <option value="">Auto</option>
                  <option value="chamfer_mill">Chamfer mill</option>
                  <option value="radius_mill">Radius mill</option>
                </select>
              )
            }
          />
        )}
      </dl>
      <p className="block-line muted">
        The number and "goes to" are for the libraries of other programs, which this app cannot write yet. They are kept, and written to a tools.yaml.
      </p>
      {!props.isNew && (
        <p className="block-line">
          <button type="button" className="danger small" onClick={props.onDelete}>
            Delete this tool…
          </button>{" "}
          <span className="muted">Removes it from your tools. A project that uses it keeps its own copy.</span>
        </p>
      )}
    </details>
  );
}

/** One cutting row on one line. Read: opened, its numbers, its log and a way to log a result. Edited: its cells are fields. */
function CutLine(props: {
  tool: Tool;
  row: CuttingSettings;
  lists: ToolLists;
  materials: { value: Material; label: string }[];
  editing: boolean;
  passes: boolean;
  /** While editing: this is the row the suggestion at the foot of the table is for. */
  inspected: boolean;
  /** The combination that suggestion is shown at, which this row's ruler then follows. */
  pick: Pick | null;
  onInspect: () => void;
  open: boolean;
  onToggle: () => void;
  onChange: (row: CuttingSettings) => void;
  onRemove: () => void;
}) {
  const { tool, row, lists, editing } = props;
  const set = (change: Partial<CuttingSettings>) => props.onChange({ ...row, ...change });
  const entry = useEntry(tool, row, lists);
  const profile = lists.profiles?.find((p) => p.key === row.profile);
  const percent = row.stepoverUnit === "percent";
  const rowTaken = (m: Material, p: string | undefined) => tool.cutting.some((c) => c !== row && c.material === m && c.profile === p);
  const hard = <Ruler tool={tool} row={row} entry={entry} pick={props.pick} />;
  const lands = goesTo(tool, row, lists);

  if (editing) {
    return (
      <tr className={props.inspected ? "cut-line insp" : "cut-line"} aria-current={props.inspected ? "true" : undefined} onFocus={props.onInspect} onClick={props.onInspect}>
        <th scope="row">
          <span className="for-in">
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
            <StatusTag tool={tool} row={row} entry={entry} lists={lists} />
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
            <button type="button" className="unit-toggle" aria-label={percent ? "Stepover in percent of the diameter: give it in mm" : "Stepover in mm: give it in percent of the diameter"} title={percent ? `${fmt(row.stepover)} mm. Click to give it in mm` : `${fmt(percentOf(row, tool.diameter))} %. Click to give it in percent`} onClick={() => set({ stepoverUnit: percent ? undefined : "percent" })}>
              {percent ? "%" : "mm"}
            </button>
          </span>
        </td>
        <td className="num">
          <Num label="Depth per pass, mm" min={0.001} value={row.stepdown} onChange={(n) => n !== undefined && set({ stepdown: n })} />
        </td>
        {props.passes && (
          <td className="num">
            <Num label="Radial passes" min={1} whole optional value={row.passes} onChange={(n) => set({ passes: n })} />
          </td>
        )}
        <td className="col-hard">{hard}</td>
        <td>
          <button type="button" className="row-x" aria-label={`Delete the ${rowLabel(row, lists)} row`} title="Delete this row" onClick={props.onRemove}>
            ×
          </button>
        </td>
      </tr>
    );
  }

  return (
    <>
      <tr className={props.open ? "cut-line open" : "cut-line"} onClick={props.onToggle}>
        <th scope="row">
          <button type="button" className="cut-toggle" aria-expanded={props.open} onClick={(e) => (e.stopPropagation(), props.onToggle())}>
            <span className="caret" aria-hidden="true" />
            {materialLabel(row.material, lists)}
          </button>
          {row.profile !== undefined && <span className="tag">{profile?.label ?? row.profile}</span>} <ResultMark row={row} short />
        </th>
        <td className="num">{row.rpm}</td>
        <td className="num">{fmt(row.feed)}</td>
        <td className="num">{fmt(row.plunge)}</td>
        <td className="num">
          {percent ? `${fmt(percentOf(row, tool.diameter))} %` : `${fmt(row.stepover)} mm`}
          <small> {percent ? `${fmt(row.stepover)} mm` : `${fmt(percentOf(row, tool.diameter))} %`}</small>
        </td>
        <td className="num">{fmt(row.stepdown)}</td>
        {props.passes && <td className="num">{row.passes ?? ""}</td>}
        <td className="col-hard">{hard}</td>
      </tr>
      {props.open && (
        <tr className="cut-detail">
          <td colSpan={props.passes ? 8 : 7}>
            <p className="readouts">
              <ResultMark row={row} />
              {lands && <span className="muted">Goes to: {lands}</span>}
            </p>
            <RowFacts tool={tool} row={row} lists={lists} entry={entry} />
            <LogList row={row} onChange={(log) => props.onChange({ ...row, log: log.length > 0 ? log : undefined })} />
            <LogResult saves="now" onAdd={(entry) => props.onChange({ ...row, log: [...(row.log ?? []), { ...entry, at: valuesOf(row) }] })} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Notes a cutter that broke or wore out, and takes it off the count. */
function LogWear(props: { materials: { value: Material; label: string }[]; canTakeOne: boolean; onAdd: (entry: WearEntry, takeOne: boolean) => void; initial?: WearEntry; onCancel?: () => void }) {
  const { initial } = props;
  const [open, setOpen] = useState(initial !== undefined);
  const [kind, setKind] = useState<WearEntry["kind"]>(initial?.kind ?? "broken");
  const [material, setMaterial] = useState(initial?.material ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [date, setDate] = useState(initial?.date ?? today());
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
          {initial ? "Keep the correction" : "Add"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            props.onCancel?.();
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
