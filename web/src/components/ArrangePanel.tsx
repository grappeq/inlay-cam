import { useEffect, useMemo, useRef, useState } from "react";
import type { Design, Project } from "../core/types";
import {
  centreOnBoard,
  countParts,
  duplicateShapes,
  emptiedJobs,
  keepOnly,
  mirrorOnBoard,
  moveOnBoard,
  overlapping,
  placedBox,
  removeShapes,
  rotateOnBoard,
  scaleOnBoard,
  trimBoard,
  withInside,
} from "../state/arrange";
import { fmt, regionOwners } from "../state/model";
import { useApp, useDispatch } from "../state/store";
import { NumberField } from "./NumberField";

const mm = (v: number) => Math.round(v * 100) / 100;

/** The panel shown while the drawing is arranged: move, resize, turn, mirror, copy or delete the selected shapes. */
export function ArrangePanel({ design }: { design: Design }) {
  const { project, selection, wholeParts, undo, redo } = useApp();
  const dispatch = useDispatch();
  const [margin, setMargin] = useState(5);
  const [angle, setAngle] = useState(45);
  const [percent, setPercent] = useState(50);

  const edit = (update: (d: Design) => Design, tag?: string) =>
    dispatch({ type: "editDrawing", tag, at: Date.now(), update: (p) => (p.design ? { ...p, design: update(p.design) } : p) });
  const editProject = (update: (p: Project) => Project, select?: number[]) => dispatch({ type: "editDrawing", update, select });

  const box = placedBox(design, selection);
  const none = selection.length === 0;
  const count = `${selection.length} shape${selection.length === 1 ? "" : "s"}`;
  const them = selection.length === 1 ? "it" : "them";
  const parts = countParts(design);
  const overlaps = useMemo(() => overlapping(design), [design]);
  const everything = withInside(design, selection).length === design.regions.length;

  const remove = () => {
    if (none) return;
    if (everything) {
      dispatch({ type: "notice", notice: { kind: "info", text: "A drawing needs at least one shape. To start over, replace the drawing." } });
      return;
    }
    const owners = regionOwners(project.jobs);
    const used = withInside(design, selection).filter((id) => owners.has(id)).length;
    const emptied = emptiedJobs(project, selection);
    const consequence =
      emptied.length > 0
        ? `${emptied.map((n) => `"${n}"`).join(" and ")} will have no shapes left and will be removed too.`
        : `${used === 1 ? "It" : "They"} will be taken out of ${used === 1 ? "it" : "their inlays"}.`;
    if (used > 0 && !confirm(`${used} of these shapes ${used === 1 ? "belongs" : "belong"} to an inlay. ${consequence} Delete?`)) return;
    editProject((p) => removeShapes(p, selection));
  };
  const duplicate = () => {
    if (none) return;
    const copy = duplicateShapes(design, selection, 5 / design.scale);
    editProject((p) => ({ ...p, design: copy.design }), copy.ids);
  };
  const keep = () => {
    if (none || everything) return;
    const others = design.regions.length - withInside(design, selection).length;
    const emptied = emptiedJobs(
      project,
      design.regions.map((r) => r.id).filter((id) => !withInside(design, selection).includes(id)),
    );
    const inlays = emptied.length > 0 ? ` ${emptied.map((n) => `"${n}"`).join(" and ")} will be removed with them.` : "";
    if (!confirm(`Delete the other ${others} shape${others === 1 ? "" : "s"} and fit the board to what is left?${inlays}`)) return;
    editProject((p) => keepOnly(p, selection, margin / design.scale));
  };

  // The keyboard works wherever the focus is, except while typing in a field.
  const actions = useRef({ remove, duplicate });
  actions.current = { remove, duplicate };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // A tick box or a button with the focus does not take the keys away.
      const typing =
        target !== null &&
        ((target.tagName === "INPUT" && (target as HTMLInputElement).type !== "checkbox") || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
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
      if (typing || document.querySelector("dialog[open]")) return;
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
        dispatch({ type: "setSelection", ids: [] });
      } else if (command && key === "a") {
        e.preventDefault();
        dispatch({ type: "setSelection", ids: designNow.current.regions.map((r) => r.id) });
      } else if (command && key === "d") {
        e.preventDefault();
        actions.current.duplicate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch]);
  const selectionNow = useRef(selection);
  selectionNow.current = selection;
  const designNow = useRef(design);
  designNow.current = design;

  return (
    <aside className="panel" aria-label="Arrange the drawing">
      <div className="panel-scroll">
        <section>
          <h2>Arrange the drawing</h2>
          <p className="status-line" role="status">
            {none
              ? `Click a part of the drawing to select it. The drawing has ${parts} part${parts === 1 ? "" : "s"}.`
              : `${count} selected. Drag ${them} in the drawing, or use the fields below.`}
          </p>
          <label className="check">
            <input type="checkbox" checked={wholeParts} onChange={(e) => dispatch({ type: "setWholeParts", on: e.target.checked })} />
            Select whole parts
          </label>
          <p className="hint">
            A part is an outer outline with everything inside it. Untick to pick an outline inside a part, such as a hole or a letter; what lies inside it
            comes along.
          </p>
          <div className="row links">
            <button className="link" disabled={everything} onClick={() => dispatch({ type: "setSelection", ids: design.regions.map((r) => r.id) })}>
              Select everything
            </button>
            {!none && (
              <button className="link" onClick={() => dispatch({ type: "setSelection", ids: [] })}>
                Clear selection
              </button>
            )}
          </div>
          <details className="more">
            <summary>Mouse and keys</summary>
            <ul className="keys">
              <li>Shift-click adds to the selection or takes away from it. Drag across empty board to select what the box encloses.</li>
              <li>Drag the selection to move it; hold Shift to keep it straight. Escape abandons the drag.</li>
              <li>Arrow keys move it by 1 mm, or by 0.1 mm with Shift.</li>
              <li>Delete removes it. Ctrl+D copies it. Ctrl+A selects everything. Escape clears the selection.</li>
              <li>Ctrl+Z undoes, Ctrl+Y redoes.</li>
              <li>The wheel zooms. Drag with the middle button to move the view; double-click empty board to see it whole.</li>
            </ul>
          </details>
        </section>

        {overlaps.length > 0 && (
          <section>
            <p className="status-line warn" role="status">
              {overlaps.length} shapes lie on top of each other. They are outlined in red. Move them apart, or wholly inside one another, before making inlays
              from them.
            </p>
          </section>
        )}

        {box && (
          <section>
            <h3>Position and size</h3>
            <div className="row">
              <NumberField deferred label="From left" unit="mm" value={mm(box.x)} onChange={(v) => v !== undefined && edit((d) => moveOnBoard(d, selection, v - box.x, 0))} />
              <NumberField deferred label="From bottom" unit="mm" value={mm(box.y)} onChange={(v) => v !== undefined && edit((d) => moveOnBoard(d, selection, 0, v - box.y))} />
            </div>
            <div className="row">
              <NumberField
                deferred
                label="Width"
                unit="mm"
                min={0.01}
                value={mm(box.width)}
                onChange={(v) => v !== undefined && box.width > 0 && edit((d) => scaleOnBoard(d, selection, v / box.width))}
              />
              <NumberField
                deferred
                label="Height"
                unit="mm"
                min={0.01}
                value={mm(box.height)}
                onChange={(v) => v !== undefined && box.height > 0 && edit((d) => scaleOnBoard(d, selection, v / box.height))}
              />
            </div>
            <p className="hint">
              Press Enter to apply a number. Distances are from the board's bottom-left corner to the selection's. Width and height change together: the shape
              keeps its proportions.
            </p>
            <div className="row tools">
              <NumberField label="Scale to" unit="%" min={0.1} value={percent} onChange={(v) => v !== undefined && setPercent(v)} />
              <button disabled={percent === 100} onClick={() => edit((d) => scaleOnBoard(d, selection, percent / 100))}>
                Scale
              </button>
            </div>

            <h3>Turn and mirror</h3>
            <div className="row">
              <button onClick={() => edit((d) => rotateOnBoard(d, selection, 90))}>Turn left 90°</button>
              <button onClick={() => edit((d) => rotateOnBoard(d, selection, -90))}>Turn right 90°</button>
            </div>
            <div className="row tools">
              <NumberField label="Turn left by" unit="°" min={-360} value={angle} onChange={(v) => v !== undefined && setAngle(v)} />
              <button disabled={angle % 360 === 0} onClick={() => edit((d) => rotateOnBoard(d, selection, angle))}>
                Turn
              </button>
            </div>
            <div className="row">
              <button onClick={() => edit((d) => mirrorOnBoard(d, selection, "x"))}>Mirror left to right</button>
              <button onClick={() => edit((d) => mirrorOnBoard(d, selection, "y"))}>Mirror top to bottom</button>
            </div>

            <h3>Place on the board</h3>
            <div className="row">
              <button onClick={() => edit((d) => centreOnBoard(d, selection, "x"))}>Centre across</button>
              <button onClick={() => edit((d) => centreOnBoard(d, selection, "y"))}>Centre up and down</button>
            </div>

            <h3>Copy and delete</h3>
            <div className="row">
              <button onClick={duplicate}>Copy beside</button>
              <button disabled={everything} onClick={keep}>
                Keep only {selection.length === 1 ? "this" : "these"}
              </button>
            </div>
            <p className="hint">"Keep only" deletes every other shape and fits the board to what is left, with the margin below.</p>
            <div className="row end">
              <button className="danger" disabled={everything} onClick={remove}>
                Delete {count}
              </button>
            </div>
          </section>
        )}

        <section>
          <h3>Base board</h3>
          <p className="status-line">
            {fmt(mm(design.width * design.scale))} × {fmt(mm(design.height * design.scale))} mm. It grows when shapes are moved past its right or top edge.
          </p>
          <div className="row tools">
            <NumberField label="Margin" unit="mm" value={margin} onChange={(v) => v !== undefined && setMargin(v)} />
            <button onClick={() => edit((d) => trimBoard(d, margin / d.scale))}>Fit board to shapes</button>
          </div>
          <p className="hint">Fitting leaves the margin between the outermost shapes and the board's edges.</p>
        </section>
      </div>
      <div className="generate-bar arrange-bar">
        <button disabled={undo.length === 0} onClick={() => dispatch({ type: "undoDrawing" })}>
          Undo
        </button>
        <button disabled={redo.length === 0} onClick={() => dispatch({ type: "redoDrawing" })}>
          Redo
        </button>
        <button className="primary" onClick={() => dispatch({ type: "setArranging", on: false })}>
          Done
        </button>
      </div>
    </aside>
  );
}
