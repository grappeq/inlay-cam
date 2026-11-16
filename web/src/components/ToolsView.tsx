import { useState } from "react";
import { core } from "../core/client";
import type { CuttingSettings, Material, Tool, ToolKind } from "../core/types";
import { useFileActions } from "../state/files";
import { CUTTING_KINDS, TOOL_KIND_LABELS, allMaterials, blankTool, fmt, jobToolIds, projectOnlyTools, rowLabel } from "../state/model";
import { message, useApp, useDispatch } from "../state/store";
import { downloadText, pickTextFile, useEscape } from "../util/files";
import { NumberField } from "./NumberField";

const KIND_LABEL: Record<ToolKind, string> = TOOL_KIND_LABELS;

/** The tool list: the first page of the settings view. */
export function ToolsPage() {
  const { tools, lists, project } = useApp();
  const dispatch = useDispatch();
  const actions = useFileActions();
  const [editing, setEditing] = useState<{ tool: Tool; isNew: boolean } | null>(null);
  const notify = (kind: "info" | "error", text: string) => dispatch({ type: "notice", notice: { kind, text } });
  const kindOrder = Object.keys(KIND_LABEL);
  const sorted = [...tools].sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || a.diameter - b.diameter || a.name.localeCompare(b.name));
  const kept = tools.filter((t) => !CUTTING_KINDS.includes(t.kind)).length;
  const extra = projectOnlyTools(project, tools);
  const usedIds = new Set(project.jobs.flatMap(jobToolIds));

  const importYaml = async () => actions.importToolsYaml(await pickTextFile(".yaml,.yml"));
  const importLibrary = async () => actions.importToolLibrary(await pickTextFile(".json,application/json"));

  const exportLibrary = async () => {
    try {
      downloadText("tools.inlay-tools.json", await core.call("libraryToFile", { ...lists, tools }));
    } catch (e) {
      notify("error", message(e));
    }
  };

  const exportYaml = async () => {
    try {
      downloadText("tools.yaml", await core.call("libraryToToolsYaml", { ...lists, tools }), "text/yaml");
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
    <>
      <div className="toolbar">
        <h2>Your tools</h2>
        <button onClick={() => setEditing({ tool: blankTool("flat_end"), isNew: true })}>Add end mill</button>
        <button onClick={() => setEditing({ tool: blankTool("v_bit"), isNew: true })}>Add V-bit</button>
        <button onClick={() => setEditing({ tool: blankTool("corner_round"), isNew: true })}>Add corner-rounding bit</button>
        <span className="spacer" />
        <button onClick={importYaml}>Import tools.yaml…</button>
        <button onClick={importLibrary}>Import tool file…</button>
        <button onClick={exportLibrary} disabled={tools.length === 0}>
          Export tool file
        </button>
        <button onClick={exportYaml} disabled={tools.length === 0} title="For the tooling library. It has no comments.">
          Export tools.yaml
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
        A flat inlay needs an end mill; a V-carve inlay needs a V-bit, and an end mill saves it time. Pockets, contours and facing use end mills; a
        chamfer uses a V-bit, or a corner-rounding (fillet) bit to round the edge over. Each tool needs cutting settings for the material you cut.
        {kept > 0 && ` ${kept} of your tools ${kept === 1 ? "is a ball end mill, drill or thread mill" : "are ball end mills, drills or thread mills"}: kept here, not used by any operation yet.`}
      </p>

      {tools.length === 0 ? (
        <div className="empty-card">
          <p>No tools yet.</p>
          <p className="muted">Add them by hand, or import the tools.yaml of your tooling library.</p>
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
                <th className="num">Angle / radius</th>
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
                  <td className="num">
                    {tool.kind === "corner_round"
                      ? `R ${fmt(tool.cornerRadius ?? 0)}`
                      : (tool.kind === "v_bit" || tool.kind === "drill") && tool.tipAngle !== undefined
                        ? `${fmt(tool.tipAngle)}°`
                        : ""}
                  </td>
                  <td className="num">{tool.kind === "v_bit" || tool.kind === "corner_round" ? fmt(tool.tipDiameter ?? 0) : ""}</td>
                  <td className="num">{tool.fluteLength !== undefined ? fmt(tool.fluteLength) : "unknown"}</td>
                  <td>{tool.cutting.length ? tool.cutting.map((c) => rowLabel(c, lists)).join(", ") : <span className="warn">none yet: edit to add</span>}</td>
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
    </>
  );
}

function ToolEditor(props: { initial: Tool; isNew: boolean; taken: Tool[]; onSave: (tool: Tool) => void; onCancel: () => void }) {
  const [tool, setTool] = useState<Tool>(props.initial);
  const { lists } = useApp();
  // Rows the fields below do not show: those for a toolpath profile.
  const others = tool.cutting.filter((c) => c.profile !== undefined);
  useEscape(props.onCancel);
  const [error, setError] = useState<string | null>(null);
  const set = (change: Partial<Tool>) => setTool((t) => ({ ...t, ...change }));

  const setCutting = (material: Material, change: Partial<CuttingSettings> | null) =>
    setTool((t) => {
      // Only the plain row of the material is edited here; rows for a toolpath profile stay as they are, in their place.
      const plain = (c: CuttingSettings) => c.material === material && c.profile === undefined;
      if (change === null) return { ...t, cutting: t.cutting.filter((c) => !plain(c)) };
      const current = t.cutting.find(plain) ?? {
        material,
        rpm: 12000,
        feed: 500,
        plunge: 150,
        // A V-bit's stepover spaces its passes over a flat floor, where only the tip cuts. A corner-rounding bit never steps over.
        stepover: t.kind === "v_bit" ? 0.2 : t.kind === "corner_round" ? 0.5 : Math.round(t.diameter * 400) / 1000,
        stepdown: 0.5,
      };
      const row = { ...current, ...change };
      return { ...t, cutting: t.cutting.some(plain) ? t.cutting.map((c) => (plain(c) ? row : c)) : [...t.cutting, row] };
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
            label={tool.kind === "flat_end" ? "Diameter" : "Body diameter"}
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
          {tool.kind === "corner_round" && (
            <>
              <NumberField
                label="Corner radius"
                unit="mm"
                min={0.001}
                value={tool.cornerRadius}
                onChange={(v) => v !== undefined && set({ cornerRadius: v })}
                hint="Radius of the rounded edge it cuts."
              />
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
          <NumberField label="Overall length" unit="mm" min={0.001} optional value={tool.length} onChange={(v) => set({ length: v })} />
          <NumberField label="Flutes" min={1} optional value={tool.flutes} onChange={(v) => set({ flutes: v === undefined ? undefined : Math.round(v) })} />
        </div>

        {allMaterials(lists).map(({ value: material, label }) => {
          const row = tool.cutting.find((c) => c.material === material && c.profile === undefined);
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

        {others.length > 0 && (
          <p className="muted">
            Also kept, as imported: {others.map((c) => rowLabel(c, lists)).join(", ")}. These rows are not edited here yet.
          </p>
        )}

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
