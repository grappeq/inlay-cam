// Choosing a tool for an operation: a button that shows the tool chosen and
// opens a list to search and filter. The tools the project already uses come
// first, each with a picture of the bit and its main measures.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { Material, Tool, ToolKind } from "../core/types";
import { TOOL_KIND_LABELS, fmt, materialLabel, numberedName, resolveTool, stepMaterials, stepToolIds, toolChoices, toolMatches } from "../state/model";
import { useApp, useDispatch } from "../state/store";
import { ToolShape } from "./ToolShape";

/** The measure that tells tools of a kind apart, after the diameter. */
function secondMeasure(tool: Tool): string {
  if (tool.kind === "v_bit") return `${fmt(tool.tipAngle ?? 0)}°`;
  if (tool.kind === "corner_round") return `R${fmt(tool.cornerRadius ?? 0)}`;
  return tool.fluteLength === undefined ? "–" : fmt(tool.fluteLength);
}

function secondHeading(kinds: ToolKind[]): { text: string; title: string } {
  if (kinds.every((k) => k === "v_bit")) return { text: "Angle", title: "Included angle" };
  if (kinds.every((k) => k === "corner_round")) return { text: "Radius", title: "Radius of the rounded edge, mm" };
  if (kinds.every((k) => k === "v_bit" || k === "corner_round")) return { text: "Angle / R", title: "Included angle, or radius of the rounded edge in mm" };
  return { text: "Flute", title: "Flute length, mm" };
}

export function ToolSelect(props: {
  /** What the tool is chosen for: the name of the control. */
  label: string;
  kind: ToolKind | ToolKind[];
  /** The tools offered, in the plural: "flat end mills". */
  noun: string;
  value: string | null;
  /** Shown on the button when no tool is chosen. */
  placeholder: string;
  /** A tool to picture beside the placeholder: the one used while none is chosen. */
  placeholderTool?: Tool;
  /** Tools left out of the list: those a list of tools has already. */
  exclude?: string[];
  /** The line that chooses no tool. Without it a tool, once chosen, can only be changed for another. */
  none?: string;
  /** How deep the tool has to cut, mm: offers to show only tools whose flutes reach. */
  depth?: number;
  onPick: (id: string | null) => void;
}) {
  const { tools, lists, project, activeStepId } = useApp();
  const dispatch = useDispatch();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [onlyKind, setOnlyKind] = useState<ToolKind | null>(null);
  const [withSettings, setWithSettings] = useState(false);
  const [reaching, setReaching] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const id = useId();

  const kinds = Array.isArray(props.kind) ? props.kind : [props.kind];
  const every = toolChoices(props.kind, tools, project);
  const offered = every.filter((t) => !props.exclude?.includes(t.id));
  const chosen = resolveTool(props.value, tools, project);
  const step = project.steps.find((s) => s.id === activeStepId);
  const materials: Material[] = step ? stepMaterials(step, project) : [];
  const hasSettings = (tool: Tool) => materials.every((m) => tool.cutting.some((c) => c.material === m));
  const reaches = (tool: Tool) => props.depth === undefined || tool.fluteLength === undefined || tool.fluteLength >= props.depth;
  const inProject = new Set([...project.steps.flatMap(stepToolIds), ...Object.keys(project.toolNumbers ?? {})]);
  const inList = (tool: Tool) => tools.some((t) => t.id === tool.id);

  const settingsChip = materials.length > 0 && offered.some((t) => !hasSettings(t));
  const reachChip = props.depth !== undefined && offered.some((t) => !reaches(t));
  const kindChips = kinds.filter((k) => offered.some((t) => t.kind === k));

  const found = offered.filter((t) => toolMatches(t, numberedName(t, project), query));
  const shown = found.filter((t) => (onlyKind === null || t.kind === onlyKind) && (!withSettings || !settingsChip || hasSettings(t)) && (!reaching || !reachChip || reaches(t)));
  const hidden = found.length - shown.length;
  const mine = shown.filter((t) => inProject.has(t.id));
  const rest = shown.filter((t) => !inProject.has(t.id));
  const noneLine = props.none !== undefined && query.trim() === "";
  /** The lines of the list from the top: null is the line that chooses no tool. */
  const lines: (Tool | null)[] = [...(noneLine ? [null] : []), ...mine, ...rest];
  const at = Math.min(active, lines.length - 1);
  const optionId = (index: number) => `${id}-option-${index}`;
  const heading = secondHeading(kindChips.length > 0 ? kindChips : kinds);

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (refocus) button.current?.focus();
  };
  const toggle = () => {
    if (open) return close(false);
    setActive(Math.max(0, lines.findIndex((line) => line !== null && line.id === props.value)));
    setOpen(true);
  };
  const pick = (line: Tool | null) => {
    props.onPick(line === null ? null : line.id);
    close(true);
  };

  // A press anywhere else closes the list.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  // The list opens in view, and the line the keys are on stays in view.
  useEffect(() => {
    if (open) pop.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(optionId(at))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, at]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (lines.length > 0) setActive((at + (e.key === "ArrowDown" ? 1 : lines.length - 1)) % lines.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (at >= 0) pick(lines[at]);
    }
  };

  if (every.length === 0)
    return (
      <span className="hint">
        No {props.noun} in your tool list.{" "}
        <button type="button" className="link" onClick={() => dispatch({ type: "setView", view: "settings", page: "tools" })}>
          Add tools
        </button>
      </span>
    );

  const pictured = chosen ?? props.placeholderTool;
  const option = (tool: Tool) => {
    const index = lines.indexOf(tool);
    const without = materials.length > 0 && !hasSettings(tool);
    return (
      <div
        key={tool.id}
        id={optionId(index)}
        role="option"
        aria-selected={tool.id === props.value}
        className={`tool-option${index === at ? " active" : ""}`}
        onPointerMove={() => index !== at && setActive(index)}
        onClick={() => pick(tool)}
      >
        <ToolShape tool={tool} size={30} />
        <span className="tool-option-name">
          {numberedName(tool, project)}
          {!inList(tool) && <span className="tool-option-sub">Not in your tool list</span>}
          {without && <span className="tool-option-sub warn">No {materials.length === 1 ? materialLabel(materials[0], lists).toLowerCase() : "matching"} settings</span>}
        </span>
        <span className="tool-option-num">{fmt(tool.diameter)}</span>
        <span className="tool-option-num">{secondMeasure(tool)}</span>
      </div>
    );
  };

  return (
    <div
      className="tool-select"
      ref={root}
      onBlur={(e) => {
        if (open && e.relatedTarget !== null && !e.currentTarget.contains(e.relatedTarget as Node)) close(false);
      }}
    >
      <button ref={button} type="button" className="tool-select-button" aria-haspopup="listbox" aria-expanded={open} aria-label={`${props.label}: ${chosen ? chosen.name : props.placeholder}`} onClick={toggle}>
        {pictured && <ToolShape tool={pictured} size={26} />}
        <span className={`tool-select-name${chosen ? "" : " muted"}`}>{chosen ? numberedName(chosen, project) : props.placeholder}</span>
        {chosen && <span className="tool-select-size">Ø{fmt(chosen.diameter)}</span>}
        <span className="tool-select-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="tool-select-pop" ref={pop}>
          <input
            type="text"
            role="combobox"
            autoFocus
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={at >= 0 ? optionId(at) : undefined}
            aria-label={`Find among the ${props.noun}`}
            placeholder="Name, diameter or number"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
          {(kindChips.length > 1 || settingsChip || reachChip) && (
            <div className="tool-select-filters" role="group" aria-label="Show only">
              {kindChips.length > 1 &&
                kindChips.map((k) => (
                  <button key={k} type="button" className="chip" aria-pressed={onlyKind === k} onClick={() => setOnlyKind(onlyKind === k ? null : k)}>
                    {TOOL_KIND_LABELS[k]}
                  </button>
                ))}
              {settingsChip && (
                <button type="button" className="chip" aria-pressed={withSettings} title="Only tools with cutting settings for what this step cuts" onClick={() => setWithSettings(!withSettings)}>
                  Has {materials.length === 1 ? `${materialLabel(materials[0], lists).toLowerCase()} ` : ""}settings
                </button>
              )}
              {reachChip && (
                <button type="button" className="chip" aria-pressed={reaching} title="Only tools whose flutes are as long as the cut is deep" onClick={() => setReaching(!reaching)}>
                  Reaches {fmt(props.depth ?? 0)} mm
                </button>
              )}
            </div>
          )}
          <div className="tool-select-list" role="listbox" id={`${id}-list`} aria-label={props.label}>
            {shown.length > 0 && (
              <div className="tool-select-head" aria-hidden="true">
                <span className="tool-option-num" title="Diameter, mm">
                  Ø mm
                </span>
                <span className="tool-option-num" title={heading.title}>
                  {heading.text}
                </span>
              </div>
            )}
            {noneLine && (
              <div id={optionId(0)} role="option" aria-selected={props.value === null} className={`tool-option none${at === 0 ? " active" : ""}`} onPointerMove={() => at !== 0 && setActive(0)} onClick={() => pick(null)}>
                {props.none}
              </div>
            )}
            {mine.length > 0 && (
              <div role="group" aria-label="In this project">
                <div className="tool-select-section" aria-hidden="true">
                  In this project
                </div>
                {mine.map(option)}
              </div>
            )}
            {rest.length > 0 && (
              <div role="group" aria-label={`Other ${props.noun}`}>
                {mine.length > 0 && (
                  <div className="tool-select-section" aria-hidden="true">
                    Other {props.noun}
                  </div>
                )}
                {rest.map(option)}
              </div>
            )}
            {shown.length === 0 && <div className="tool-select-empty">{found.length === 0 ? `None of the ${props.noun} match` : "The filters hide every match"}</div>}
          </div>
          {hidden > 0 && (
            <div className="tool-select-hidden">
              <span>{hidden} hidden by the filters</span>
              <button
                type="button"
                className="link"
                onClick={() => {
                  setOnlyKind(null);
                  setWithSettings(false);
                  setReaching(false);
                }}
              >
                Show
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
