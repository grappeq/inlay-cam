import { useEffect, useRef, useState } from "react";
import type { Design } from "../core/types";
import { centreOnBoard, mirrorOnBoard, moveOnBoard, placedBox, rotateOnBoard, stretchOnBoard } from "../state/arrange";
import { DRAW_LIMITS, type DrawTool } from "../state/shapes";
import { useApp, useDispatch } from "../state/store";
import { ToolIcon, type ToolIconName } from "./icons";
import { NumberField } from "./NumberField";
import { useImportSvg } from "./DesignPanel";
import { MoveToLayerButton } from "./Layers";
import { useShapeActions } from "./shapeActions";

const mm = (v: number) => Math.round(v * 100) / 100;

/**
 * The points of the selection's box that X and Y can be read at, and that
 * stay put while it is resized: counted from its left and bottom, as they lie
 * in a 3 by 3 grid read from the top left.
 */
const ANCHORS: { label: string; at: [number, number] }[] = [
  { label: "the top-left corner", at: [0, 1] },
  { label: "the middle of the top edge", at: [0.5, 1] },
  { label: "the top-right corner", at: [1, 1] },
  { label: "the middle of the left edge", at: [0, 0.5] },
  { label: "the middle", at: [0.5, 0.5] },
  { label: "the middle of the right edge", at: [1, 0.5] },
  { label: "the bottom-left corner", at: [0, 0] },
  { label: "the middle of the bottom edge", at: [0.5, 0] },
  { label: "the bottom-right corner", at: [1, 0] },
];

/** The drawing tools, in the order of their buttons, with how each is used, in few words: the line must not wrap. */
const DRAW_TOOLS: { tool: DrawTool; label: string; how: string }[] = [
  { tool: "rectangle", label: "Rectangle", how: "Drag on the stock. Shift: a square. Ctrl: from the middle." },
  { tool: "ellipse", label: "Ellipse or circle", how: "Drag on the stock. Shift: a circle. Ctrl: from the middle." },
  { tool: "polygon", label: "Polygon", how: "Drag from the middle to a corner. Shift: steps of 15°." },
];

/**
 * The bar above the drawing: what a click on the drawing does (pick shapes
 * for inlays and operations, or edit the drawing), and bringing in drawings.
 */
export function StageBar() {
  const { arranging } = useApp();
  const dispatch = useDispatch();
  const addDrawing = useImportSvg();
  return (
    <div className="stage-bar">
      <div className="tabs" role="group" aria-label="What a click on the drawing does">
        <button aria-pressed={!arranging} onClick={() => arranging && dispatch({ type: "setArranging", on: false })} title="Click shapes to make inlays and operations from them">
          <ToolIcon name="pick" />
          Pick shapes
        </button>
        <button aria-pressed={arranging} onClick={() => !arranging && dispatch({ type: "setArranging", on: true })} title="Draw shapes, and move, resize, turn, copy or delete them">
          <ToolIcon name="edit" />
          Edit
        </button>
      </div>
      <button onClick={addDrawing} title="Put the shapes of further SVG or DXF files on the stock. Files can also be dropped on the window.">
        <ToolIcon name="add" />
        Add drawing…
      </button>
    </div>
  );
}

/**
 * The tools for editing the drawing, above it: the shapes that can be
 * drawn, what can be done to the selected shapes, and their position and
 * size as numbers. Also the keys that work while editing.
 *
 * The bar is as tall with a selection as without one, and with a drawing
 * tool as without: the drawing under it must not move when a shape is
 * clicked.
 */
export function ArrangeBar({ design }: { design: Design }) {
  const { selection, undo, redo, drawTool, drawOptions } = useApp();
  const dispatch = useDispatch();
  const [angle, setAngle] = useState(45);
  const [percent, setPercent] = useState(50);
  const [anchor, setAnchor] = useState(6);
  const [proportional, setProportional] = useState(true);
  // Where the bar is narrow, turning by an angle and scaling by a percentage wait behind a button.
  const [more, setMore] = useState(false);

  const edit = (update: (d: Design) => Design, tag?: string) =>
    dispatch({ type: "editDrawing", tag, at: Date.now(), update: (p) => (p.design ? { ...p, design: update(p.design) } : p) });

  const box = placedBox(design, selection);
  const at = ANCHORS[anchor].at;
  /** Resizes the selection about the chosen point. */
  const resize = (fx: number, fy: number) => {
    if (box) edit((d) => stretchOnBoard(d, selection, fx, fy, at));
  };
  const { none, count, everything, remove, duplicate, keep } = useShapeActions(design);

  // The keyboard works wherever the focus is, except while typing in a field.
  const actions = useRef({ remove, duplicate });
  actions.current = { remove, duplicate };
  const drawing = useRef(drawTool);
  drawing.current = drawTool;
  const selectionNow = useRef(selection);
  selectionNow.current = selection;
  const designNow = useRef(design);
  designNow.current = design;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // A tick box or a button with the focus does not take the keys away; the grip of a list does.
      const typing =
        target !== null &&
        ((target.tagName === "INPUT" && (target as HTMLInputElement).type !== "checkbox") ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.classList.contains("grip"));
      const command = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (command && key === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redoDrawing" : "undoDrawing" });
        return;
      }
      if (command && key === "y") {
        e.preventDefault();
        dispatch({ type: "redoDrawing" });
        return;
      }
      // A menu that is open takes the arrows and the other keys for itself.
      if (typing || document.querySelector("dialog[open]") || target?.closest('[role="menu"]')) return;
      const step = e.shiftKey ? 0.1 : 1;
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[e.key]) {
        e.preventDefault();
        const [dx, dy] = moves[e.key];
        dispatch({
          type: "editDrawing",
          tag: "nudge",
          at: Date.now(),
          update: (p) => (p.design ? { ...p, design: moveOnBoard(p.design, selectionNow.current, dx, dy) } : p),
        });
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        actions.current.remove();
      } else if (e.key === "Escape") {
        // Escape puts a drawing tool away; without one it clears the selection.
        if (drawing.current) dispatch({ type: "setDrawTool", tool: null });
        else dispatch({ type: "setSelection", ids: [] });
      } else if (command && key === "a") {
        e.preventDefault();
        // Those that can be picked: the store leaves out hidden and locked layers.
        dispatch({ type: "setSelection", ids: designNow.current.regions.map((r) => r.id) });
      } else if (command && key === "d") {
        e.preventDefault();
        actions.current.duplicate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);

  const tool = (icon: ToolIconName, label: string, onClick: () => void, off = none, extra = "") => (
    <button type="button" className={`tool${extra}`} disabled={off} onClick={onClick} aria-label={label} title={label}>
      <ToolIcon name={icon} />
    </button>
  );

  const active = DRAW_TOOLS.find((t) => t.tool === drawTool);
  const option = (change: Partial<typeof drawOptions>) => dispatch({ type: "setDrawOptions", options: { ...drawOptions, ...change } });

  return (
    <div className={`arrange-tools${more ? " more" : ""}`} role="toolbar" aria-label="Draw shapes and change the selected ones">
      <div className="tool-row">
        <span className="tool-group">
          {tool("undo", "Undo (Ctrl+Z)", () => dispatch({ type: "undoDrawing" }), undo.length === 0)}
          {tool("redo", "Redo (Ctrl+Y)", () => dispatch({ type: "redoDrawing" }), redo.length === 0)}
        </span>
        <span className="tool-group" role="group" aria-label="Draw">
          {DRAW_TOOLS.map(({ tool: name, label }) => (
            <button
              key={name}
              type="button"
              className="tool"
              aria-pressed={drawTool === name}
              aria-label={`Draw: ${label}`}
              title={`Draw: ${label}`}
              onClick={() => dispatch({ type: "setDrawTool", tool: drawTool === name ? null : name })}
            >
              <ToolIcon name={name} />
            </button>
          ))}
        </span>
        <span className="tool-group" aria-label="Turn">
          {tool("turnLeft", "Turn left by 90°", () => edit((d) => rotateOnBoard(d, selection, 90)))}
          {tool("turnRight", "Turn right by 90°", () => edit((d) => rotateOnBoard(d, selection, -90)))}
          <span className="tool-number">
            <NumberField label="Turn left by" unit="°" min={-360} max={360} value={angle} onChange={(v) => v !== undefined && setAngle(v)} />
            <button type="button" disabled={none || angle % 360 === 0} onClick={() => edit((d) => rotateOnBoard(d, selection, angle))}>
              Turn
            </button>
          </span>
        </span>
        <span className="tool-group" aria-label="Mirror">
          {tool("mirrorX", "Mirror left to right", () => edit((d) => mirrorOnBoard(d, selection, "x")))}
          {tool("mirrorY", "Mirror top to bottom", () => edit((d) => mirrorOnBoard(d, selection, "y")))}
        </span>
        <span className="tool-group" aria-label="Centre on the stock">
          {tool("centreX", "Centre across the stock", () => edit((d) => centreOnBoard(d, selection, "x")))}
          {tool("centreY", "Centre up and down the stock", () => edit((d) => centreOnBoard(d, selection, "y")))}
        </span>
        <span className="tool-group">
          <MoveToLayerButton design={design} />
          {tool("copy", "Copy beside (Ctrl+D)", duplicate)}
          {tool("keep", `Keep only ${selection.length === 1 ? "this" : "these"}: delete every other shape and fit the stock to what is left`, keep, none || everything)}
          {tool("remove", `Delete ${count} (Delete)`, remove, none || everything, " danger")}
        </span>
        <button type="button" className="tool more-toggle" aria-pressed={more} aria-label="More: turn by an angle, scale by a percentage" title="More: turn by an angle, scale by a percentage" onClick={() => setMore(!more)}>
          <ToolIcon name="more" />
        </button>
      </div>

      <div className="tool-stack">
        {active && (
          <div className="tool-row numbers draw-options">
            {active.tool === "rectangle" && (
              <NumberField label="Corner radius" unit="mm" value={drawOptions.corner} onChange={(v) => v !== undefined && option({ corner: v })} />
            )}
            {active.tool === "polygon" && (
              <NumberField label="Sides" whole min={DRAW_LIMITS.sides[0]} max={DRAW_LIMITS.sides[1]} value={drawOptions.sides} onChange={(v) => v !== undefined && option({ sides: v })} />
            )}
            <span className="muted" role="status">
              {active.how} Esc: done.
            </span>
          </div>
        )}
        {/* Always there, so that the bar keeps its height: empty without a selection, and out of sight under a drawing tool's options. */}
        <div className={`tool-row numbers${active ? " unseen" : ""}`} inert={active !== undefined} title={box ? undefined : "Select a shape to see and type its place and size"}>
          <span className="anchor" role="radiogroup" aria-label="Reference point" title="The point of the selection that X and Y are of, and that stays put when it is resized">
            {ANCHORS.map((point, i) => (
              <button key={i} type="button" role="radio" aria-checked={anchor === i} aria-label={`Measure and resize from ${point.label}`} title={`X and Y are of ${point.label}; resizing keeps it in place`} onClick={() => setAnchor(i)} />
            ))}
          </span>
          <span className="number-pair" title={box ? `Where ${ANCHORS[anchor].label} of the selection is, from the stock's bottom-left corner` : undefined}>
            <NumberField
              deferred
              disabled={!box}
              label="X"
              unit="mm"
              min={-Infinity}
              value={box ? mm(box.x + at[0] * box.width) : undefined}
              onChange={(v) => v !== undefined && box && edit((d) => moveOnBoard(d, selection, v - (box.x + at[0] * box.width), 0))}
            />
            <NumberField
              deferred
              disabled={!box}
              label="Y"
              unit="mm"
              min={-Infinity}
              value={box ? mm(box.y + at[1] * box.height) : undefined}
              onChange={(v) => v !== undefined && box && edit((d) => moveOnBoard(d, selection, 0, v - (box.y + at[1] * box.height)))}
            />
          </span>
          <span className="number-pair">
            <NumberField
              deferred
              disabled={!box}
              label="W"
              unit="mm"
              min={0.01}
              value={box ? mm(box.width) : undefined}
              onChange={(v) => v !== undefined && box && box.width > 0 && resize(v / box.width, proportional ? v / box.width : 1)}
            />
            <NumberField
              deferred
              disabled={!box}
              label="H"
              unit="mm"
              min={0.01}
              value={box ? mm(box.height) : undefined}
              onChange={(v) => v !== undefined && box && box.height > 0 && resize(proportional ? v / box.height : 1, v / box.height)}
            />
            <button type="button" className="ratio" aria-pressed={proportional} title="Keep proportions: when the width or the height is typed, the other follows" onClick={() => setProportional(!proportional)}>
              {proportional ? "W:H kept" : "W:H free"}
            </button>
          </span>
          <span className="tool-number">
            <NumberField label="Scale by" unit="%" min={0.1} value={percent} onChange={(v) => v !== undefined && setPercent(v)} />
            <button type="button" disabled={!box || percent === 100} onClick={() => resize(percent / 100, percent / 100)}>
              Scale
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
