// The project's tools and the number each goes by: the machine is loaded
// once, and every file of the project calls for a tool by the same number.

import type { Project, Tool } from "../core/types";
import { MAX_TOOL_NUMBER, describeTool, forgetTool, renumberTool, stepToolIds } from "../state/model";
import { useApp, useDispatch } from "../state/store";
import { ToolShape } from "./ToolShape";

/** The project's numbered tools, lowest number first. */
export function numberedTools(project: Project): { tool: Tool; number: number }[] {
  const numbers = project.toolNumbers ?? {};
  return project.tools
    .filter((tool) => numbers[tool.id] !== undefined)
    .map((tool) => ({ tool, number: numbers[tool.id] }))
    .sort((a, b) => a.number - b.number);
}

/**
 * Tools side by side as they are loaded, each under its number. With
 * `only`, the tools of one file: the others are left out. `gaps` shows the
 * numbers between that no tool has, while there are few of them.
 */
export function ToolRack({ project, only, gaps = false, small = false }: { project: Project; only?: number[]; gaps?: boolean; small?: boolean }) {
  const all = numberedTools(project);
  const shown = only ? all.filter((t) => only.includes(t.number)) : all;
  if (shown.length === 0) return null;
  const slots: { number: number; tool?: Tool }[] = [];
  let next = Math.min(shown[0].number, project.machine.firstTool);
  for (const entry of shown) {
    // A long run of free numbers says nothing: it is left out.
    if (gaps && entry.number - next <= 4) for (; next < entry.number; next++) slots.push({ number: next });
    slots.push(entry);
    next = entry.number + 1;
  }
  return (
    <ul className={`rack${small ? " small" : ""}`} aria-label={only ? "The tools of this file, by number" : "The project's tools, by number"}>
      {slots.map(({ number, tool }) => (
        <li key={number} className={tool ? "slot" : "slot free"} title={tool ? `T${number}: ${tool.name}` : `T${number}: free`}>
          {tool ? <ToolShape tool={tool} size={small ? 28 : 38} /> : <span className="slot-gap" />}
          <span className="slot-number">T{number}</span>
        </li>
      ))}
    </ul>
  );
}

export function ProjectTools() {
  const { project } = useApp();
  const dispatch = useDispatch();
  const tools = numberedTools(project);
  const usedBy = (id: string) => project.steps.filter((step) => stepToolIds(step).includes(id));
  // Every number up to one past the highest, so that a tool can also move to the end.
  const highest = tools.reduce((most, t) => Math.max(most, t.number), project.machine.firstTool);
  const choices: number[] = [];
  for (let n = 1; n <= Math.min(MAX_TOOL_NUMBER, highest + 1); n++) choices.push(n);
  const holder = (number: number) => tools.find((t) => t.number === number)?.tool.name;

  if (tools.length === 0) {
    return (
      <section className="project-tools">
        <p className="hint">No tools yet. A tool gets a number here when an inlay or an operation first uses it, and every file of the project calls for it by that number.</p>
      </section>
    );
  }

  return (
    <section className="project-tools">
      <ToolRack project={project} gaps />
      <p className="hint">
        Load the machine like this once: every file of the project calls for a tool by its number here.
        {tools.length > 1 ? " Give a tool another tool's number and the two change places." : ""}
      </p>
      <ol className="tool-rows">
        {tools.map(({ tool, number }) => {
          const steps = usedBy(tool.id);
          return (
            <li key={tool.id} className={steps.length === 0 ? "tool-row unused" : "tool-row"}>
              <span className="tool-tile">
                <ToolShape tool={tool} />
              </span>
              <div className="tool-row-text">
                <div className="tool-row-head">
                  <select
                    className="tool-number"
                    aria-label={`Number of ${tool.name}`}
                    value={number}
                    onChange={(e) => dispatch({ type: "updateProject", update: (p) => renumberTool(p, tool.id, Number(e.target.value)) })}
                  >
                    {choices.map((n) => {
                      const other = n === number ? undefined : holder(n);
                      return (
                        <option key={n} value={n}>
                          T{n}
                          {other ? `, now ${other}` : ""}
                        </option>
                      );
                    })}
                  </select>
                  <strong>{tool.name}</strong>
                </div>
                <span className="hint">{describeTool(tool)}</span>
                {steps.length > 0 ? (
                  <div className="tool-steps">
                    {steps.map((step) => (
                      <button key={step.id} type="button" className="chip" title={`Open ${step.name}`} onClick={() => dispatch({ type: "setActiveStep", id: step.id })}>
                        {step.name}
                      </button>
                    ))}
                  </div>
                ) : (
                  <span className="hint">
                    Nothing uses it now. It keeps its number.{" "}
                    <button type="button" className="link" onClick={() => dispatch({ type: "updateProject", update: (p) => forgetTool(p, tool.id) })}>
                      Take it off the list
                    </button>
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
