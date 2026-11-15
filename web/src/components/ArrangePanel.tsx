import { useState } from "react";
import type { Design } from "../core/types";
import { countParts, mirrorShapes, moveOnBoard, placedBox, removeShapes, scaleOnBoard, trimBoard } from "../state/arrange";
import { fmt, regionOwners } from "../state/model";
import { useApp, useDispatch } from "../state/store";
import { NumberField } from "./NumberField";

/** The panel shown while the drawing is arranged: move, resize, mirror or delete the selected shapes. */
export function ArrangePanel({ design }: { design: Design }) {
  const { project, selection, wholeParts, undo } = useApp();
  const dispatch = useDispatch();
  const [margin, setMargin] = useState(5);

  const edit = (update: (d: Design) => Design) =>
    dispatch({ type: "editDrawing", update: (p) => (p.design ? { ...p, design: update(p.design) } : p) });
  const box = placedBox(design, selection);
  const none = selection.length === 0;
  const count = `${selection.length} shape${selection.length === 1 ? "" : "s"}`;
  const parts = countParts(design);

  const remove = () => {
    const owners = regionOwners(project.jobs);
    const used = selection.filter((id) => owners.has(id)).length;
    const all = selection.length === design.regions.length;
    if (all) {
      dispatch({ type: "notice", notice: { kind: "info", text: "A drawing needs at least one shape. To start over, replace the drawing." } });
      return;
    }
    if (used > 0 && !confirm(`${used} of these shapes ${used === 1 ? "belongs" : "belong"} to an inlay and will be taken out of it. Delete?`)) return;
    dispatch({ type: "editDrawing", update: (p) => removeShapes(p, selection) });
  };

  return (
    <aside className="panel" aria-label="Arrange the drawing">
      <div className="panel-scroll">
        <section>
          <div className="editor-head">
            <button className="link" onClick={() => dispatch({ type: "setArranging", on: false })}>
              ‹ All inlays
            </button>
          </div>
          <h2>Arrange the drawing</h2>
          <p className="status-line" role="status">
            {none
              ? `Click a part of the drawing to select it. The drawing has ${design.regions.length} shape${design.regions.length === 1 ? "" : "s"} in ${parts} part${parts === 1 ? "" : "s"}.`
              : `${count} selected. Drag them in the drawing, or use the fields below.`}
          </p>
          <label className="check">
            <input type="checkbox" checked={wholeParts} onChange={(e) => dispatch({ type: "setWholeParts", on: e.target.checked })} />
            Select whole parts
          </label>
          <p className="hint">A part is an outer outline with everything inside it. Untick to pick single shapes.</p>
          <div className="row links">
            <button
              className="link"
              disabled={selection.length === design.regions.length}
              onClick={() => dispatch({ type: "setSelection", ids: design.regions.map((r) => r.id) })}
            >
              Select everything
            </button>
            {!none && (
              <button className="link" onClick={() => dispatch({ type: "setSelection", ids: [] })}>
                Clear selection
              </button>
            )}
          </div>
        </section>

        {box && (
          <section>
            <h3>Position and size</h3>
            <div className="row">
              <NumberField label="From left" unit="mm" min={-1e6} value={box.x} onChange={(v) => v !== undefined && edit((d) => moveOnBoard(d, selection, v - box.x, 0))} />
              <NumberField label="From bottom" unit="mm" min={-1e6} value={box.y} onChange={(v) => v !== undefined && edit((d) => moveOnBoard(d, selection, 0, v - box.y))} />
            </div>
            <div className="row">
              <NumberField
                label="Width"
                unit="mm"
                min={0.01}
                value={box.width}
                onChange={(v) => v !== undefined && box.width > 0 && edit((d) => scaleOnBoard(d, selection, v / box.width))}
              />
              <NumberField
                label="Height"
                unit="mm"
                min={0.01}
                value={box.height}
                onChange={(v) => v !== undefined && box.height > 0 && edit((d) => scaleOnBoard(d, selection, v / box.height))}
              />
            </div>
            <p className="hint">
              Measured on the base board, from its bottom-left corner to the selection's. Width and height change together. With the drawing in focus, the
              arrow keys move the selection by 1 mm, or by 0.1 mm with Shift.
            </p>
            <div className="row">
              <button onClick={() => edit((d) => mirrorShapes(d, selection, "x"))}>Mirror left to right</button>
              <button onClick={() => edit((d) => mirrorShapes(d, selection, "y"))}>Mirror top to bottom</button>
            </div>
            <div className="row end">
              <button className="danger" onClick={remove}>
                Delete {count}
              </button>
            </div>
          </section>
        )}

        <section>
          <h3>Base board</h3>
          <p className="status-line">
            {fmt(Math.round(design.width * design.scale * 100) / 100)} × {fmt(Math.round(design.height * design.scale * 100) / 100)} mm. It grows when
            shapes are moved past its edge.
          </p>
          <div className="row">
            <NumberField label="Margin" unit="mm" value={margin} onChange={(v) => v !== undefined && setMargin(v)} />
            <button onClick={() => edit((d) => trimBoard(d, margin / d.scale))}>Trim the board to the shapes</button>
          </div>
          <p className="hint">Trimming leaves the margin between the outermost shapes and the board's edges.</p>
        </section>
      </div>
      <div className="generate-bar arrange-bar">
        <button disabled={undo.length === 0} onClick={() => dispatch({ type: "undoDrawing" })}>
          Undo
        </button>
        <button className="primary" onClick={() => dispatch({ type: "setArranging", on: false })}>
          Done
        </button>
      </div>
    </aside>
  );
}
