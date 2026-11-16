import { useState } from "react";
import { core } from "../core/client";
import type { Tool, ToolKind } from "../core/types";
import { useFileActions } from "../state/files";
import { CUTTING_KINDS, TOOL_KIND_LABELS, blankTool, fmt, jobToolIds, projectOnlyTools, rowLabel } from "../state/model";
import { message, useApp, useDispatch } from "../state/store";
import { downloadText, pickTextFile } from "../util/files";
import { ToolSheet } from "./ToolSheet";

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

  if (editing) return <ToolSheet initial={editing.tool} isNew={editing.isNew} taken={tools} onSave={save} onCancel={() => setEditing(null)} />;

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

    </>
  );
}
