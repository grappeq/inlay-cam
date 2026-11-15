import { useState } from "react";
import { core } from "../core/client";
import type { CuttingSettings, Material, Tool, ToolKind } from "../core/types";
import { useFileActions } from "../state/files";
import { MATERIALS, blankTool, fmt, jobToolIds, projectOnlyTools } from "../state/model";
import { message, useApp, useDispatch } from "../state/store";
import { downloadText, pickTextFile, useEscape } from "../util/files";
import { NumberField } from "./NumberField";

const KIND_LABEL: Record<ToolKind, string> = { flat_end: "Flat end mill", v_bit: "V-bit" };

export function ToolsView() {
  const { tools, project } = useApp();
  const dispatch = useDispatch();
  const actions = useFileActions();
  const [editing, setEditing] = useState<{ tool: Tool; isNew: boolean } | null>(null);
  const notify = (kind: "info" | "error", text: string) => dispatch({ type: "notice", notice: { kind, text } });
  const sorted = [...tools].sort((a, b) => a.kind.localeCompare(b.kind) || a.diameter - b.diameter || a.name.localeCompare(b.name));
  const extra = projectOnlyTools(project, tools);
  const usedIds = new Set(project.jobs.flatMap(jobToolIds));

  const importYaml = async () => actions.importToolsYaml(await pickTextFile(".yaml,.yml"));
  const importLibrary = async () => actions.importToolLibrary(await pickTextFile(".json,application/json"));

  const exportLibrary = async () => {
    try {
      downloadText("tools.inlay-tools.json", await core.call("toolsToFile", tools));
    } catch (e) {
      notify("error", message(e));
    }
  };

  const remove = (tool: Tool) => {
    const used = usedIds.has(tool.id) ? " The open project uses it and will keep its own copy." : "";
    if (!confirm(`Delete "${tool.name}" from your tool list?${used}`)) return;
    dispatch({ type: "setTools", tools: tools.filter((t) => t.id !== tool.id) });
  };

  const save = (tool: Tool) => {
    const exists = tools.some((t) => t.id === tool.id);
    dispatch({ type: "setTools", tools: exists ? tools.map((t) => (t.id === tool.id ? tool : t)) : [...tools, tool] });
    setEditing(null);
  };

  return (
    <main className="tools-view">
      <div className="toolbar">
        <h2>Your tools</h2>
        <button onClick={() => setEditing({ tool: blankTool("flat_end"), isNew: true })}>Add end mill</button>
        <button onClick={() => setEditing({ tool: blankTool("v_bit"), isNew: true })}>Add V-bit</button>
        <span className="spacer" />
        <button onClick={importYaml}>Import tools.yaml…</button>
        <button onClick={importLibrary}>Import tool file…</button>
        <button onClick={exportLibrary} disabled={tools.length === 0}>
          Export tool file
        </button>
      </div>

      {extra.length > 0 && (
        <p className="banner">
          The open project uses {extra.length} tool{extra.length === 1 ? "" : "s"} that {extra.length === 1 ? "is" : "are"} not in your list:{" "}
          {extra.map((t) => t.name).join(", ")}.{" "}
          <button className="link" onClick={() => dispatch({ type: "setTools", tools: [...tools, ...extra] })}>
            Add to my tools
          </button>
        </p>
      )}

      <p className="muted lead">
        Kept in this browser and shared by all your projects. A flat inlay needs an end mill; a V-carve inlay needs a V-bit, and an end mill saves it
        time. Each tool needs cutting settings for the wood you cut.
      </p>

      {tools.length === 0 ? (
        <div className="empty-card">
          <p>No tools yet.</p>
          <p className="muted">Add them by hand, or import the tools.yaml of your tooling library. Only end mills and V-bits are taken from it.</p>
          <div className="row center">
            <button className="primary" onClick={() => setEditing({ tool: blankTool("flat_end"), isNew: true })}>
              Add end mill
            </button>
            <button className="primary" onClick={() => setEditing({ tool: blankTool("v_bit"), isNew: true })}>
              Add V-bit
            </button>
            <button onClick={importYaml}>Import tools.yaml…</button>
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th className="num">Ø mm</th>
                <th className="num">Angle</th>
                <th className="num">Tip mm</th>
                <th className="num">Flute mm</th>
                <th>Cutting settings</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((tool) => (
                <tr key={tool.id}>
                  <td>{tool.name}</td>
                  <td>{KIND_LABEL[tool.kind]}</td>
                  <td className="num">{fmt(tool.diameter)}</td>
                  <td className="num">{tool.tipAngle !== undefined ? `${fmt(tool.tipAngle)}°` : ""}</td>
                  <td className="num">{tool.kind === "v_bit" ? fmt(tool.tipDiameter ?? 0) : ""}</td>
                  <td className="num">{tool.fluteLength !== undefined ? fmt(tool.fluteLength) : "unknown"}</td>
                  <td>{tool.cutting.length ? tool.cutting.map((c) => c.material).join(", ") : <span className="warn">none yet: edit to add</span>}</td>
                  <td className="row-actions">
                    <button onClick={() => setEditing({ tool, isNew: false })}>Edit</button>
                    <button className="danger" onClick={() => remove(tool)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && <ToolEditor initial={editing.tool} isNew={editing.isNew} taken={tools} onSave={save} onCancel={() => setEditing(null)} />}
    </main>
  );
}

function ToolEditor(props: { initial: Tool; isNew: boolean; taken: Tool[]; onSave: (tool: Tool) => void; onCancel: () => void }) {
  const [tool, setTool] = useState<Tool>(props.initial);
  useEscape(props.onCancel);
  const [error, setError] = useState<string | null>(null);
  const set = (change: Partial<Tool>) => setTool((t) => ({ ...t, ...change }));

  const setCutting = (material: Material, change: Partial<CuttingSettings> | null) =>
    setTool((t) => {
      const others = t.cutting.filter((c) => c.material !== material);
      if (change === null) return { ...t, cutting: others };
      const current = t.cutting.find((c) => c.material === material) ?? {
        material,
        rpm: 12000,
        feed: 500,
        plunge: 150,
        // A V-bit's stepover spaces its passes over a flat floor, where only the tip cuts.
        stepover: t.kind === "v_bit" ? 0.2 : Math.round(t.diameter * 400) / 1000,
        stepdown: 0.5,
      };
      return { ...t, cutting: [...others, { ...current, ...change }].sort((a, b) => a.material.localeCompare(b.material)) };
    });

  const submit = async () => {
    const candidate = { ...tool, name: tool.name.trim() };
    if (props.taken.some((t) => t.id !== candidate.id && t.name === candidate.name)) {
      return setError("Another tool already has this name.");
    }
    try {
      const problem = await core.call("validateTool", candidate);
      if (problem) return setError(problem.charAt(0).toUpperCase() + problem.slice(1) + ".");
      props.onSave(candidate);
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <div className="backdrop" onClick={props.onCancel}>
      <form
        className="dialog wide"
        role="dialog"
        aria-modal="true"
        aria-label={props.isNew ? "Add tool" : "Edit tool"}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>
          {props.isNew ? "Add" : "Edit"} {KIND_LABEL[tool.kind].toLowerCase()}
        </h2>
        <label className="field">
          <span className="field-label">Name</span>
          <input type="text" value={tool.name} autoFocus onChange={(e) => set({ name: e.target.value })} />
        </label>
        <div className="grid">
          <NumberField
            label={tool.kind === "v_bit" ? "Body diameter" : "Diameter"}
            unit="mm"
            min={0.001}
            value={tool.diameter}
            onChange={(v) => v !== undefined && set({ diameter: v })}
          />
          <NumberField label="Shank diameter" unit="mm" min={0.001} value={tool.shankDiameter} onChange={(v) => v !== undefined && set({ shankDiameter: v })} />
          {tool.kind === "v_bit" && (
            <>
              <NumberField
                label="Angle"
                unit="°"
                min={0.1}
                value={tool.tipAngle}
                onChange={(v) => v !== undefined && set({ tipAngle: v })}
                hint="Full angle between the two edges."
              />
              <NumberField
                label="Tip flat diameter"
                unit="mm"
                value={tool.tipDiameter ?? 0}
                onChange={(v) => v !== undefined && set({ tipDiameter: v })}
                hint="Measure it: 0 for a true point."
              />
            </>
          )}
          <NumberField label="Flute length" unit="mm" min={0.001} optional value={tool.fluteLength} onChange={(v) => set({ fluteLength: v })} hint="Deepest it can cut. Empty if unknown." />
          <NumberField label="Overall length" unit="mm" min={0.001} optional value={tool.length} onChange={(v) => set({ length: v })} />
          <NumberField label="Flutes" min={1} optional value={tool.flutes} onChange={(v) => set({ flutes: v === undefined ? undefined : Math.round(v) })} />
        </div>

        {MATERIALS.map(({ value: material, label }) => {
          const row = tool.cutting.find((c) => c.material === material);
          return (
            <fieldset key={material}>
              <legend>
                <label className="check">
                  <input type="checkbox" checked={row !== undefined} onChange={(e) => setCutting(material, e.target.checked ? {} : null)} />
                  Cutting settings for {label.toLowerCase()}
                </label>
              </legend>
              {row && (
                <div className="grid five">
                  <NumberField label="Speed" unit="rpm" min={1} value={row.rpm} onChange={(v) => v !== undefined && setCutting(material, { rpm: Math.round(v) })} />
                  <NumberField label="Feed" unit="mm/min" min={0.001} value={row.feed} onChange={(v) => v !== undefined && setCutting(material, { feed: v })} />
                  <NumberField label="Plunge" unit="mm/min" min={0.001} value={row.plunge} onChange={(v) => v !== undefined && setCutting(material, { plunge: v })} />
                  <NumberField label="Stepover" unit="mm" min={0.001} value={row.stepover} onChange={(v) => v !== undefined && setCutting(material, { stepover: v })} />
                  <NumberField label="Stepdown" unit="mm" min={0.001} value={row.stepdown} onChange={(v) => v !== undefined && setCutting(material, { stepdown: v })} />
                </div>
              )}
            </fieldset>
          );
        })}

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
    </div>
  );
}
